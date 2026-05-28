// Daily Snapshot — vanilla JS, no framework, no build step.
// Reads data/items.json, renders cards with sort/filter/search controls.
//
// Pagination:    only render PAGE_SIZE cards at a time so 6k items don't choke
//                the browser.
// State persist: filter/sort/search/scroll/renderedCount survive a page reload
//                via sessionStorage, so "Load more" + scroll position aren't lost.
// Refresh:       there is intentionally no auto-refresh banner. To get a fresh
//                snapshot, hard-reload the page (Ctrl+Shift+R).
// Service Worker (sw.js) caches the static files + items.json so repeat
// visits are instant; a fresh copy is fetched in the background.

(function () {
  "use strict";

  const PAGE_SIZE = 60;                  // cards rendered per "page"
  const STATE_KEY = "daily-snapshot:ui-state";
  const STATE_VERSION = 4;               // bumped: added showClosed

  // ─── Smart-score weights ────────────────────────────────────────
  // Smart score = w_roi*ROI_norm + w_profit*profit_norm + w_velocity*velocity_norm
  // Tweak weights here if you want a different emphasis.
  //
  // Tuned toward absolute profit dollars (45%) over ROI (30%): a $300
  // gross-profit item that's 5× ROI is more useful than a $20-profit
  // item that's 50× ROI, because real-world flip economics care about
  // dollars per pickup-trip, not ratios.
  const SMART_WEIGHTS = {
    roi: 0.30,
    profit: 0.45,
    velocity: 0.25,
  };
  // Log-scale normalization: we DO NOT cap ROI or profit. Capping would shove
  // legitimate $0-bid jackpots (which routinely hit 100×+ ROI) down to the
  // same rank as merely-good 5× finds. Instead, log compresses the range
  // gracefully:
  //     ROI  1×  → 0.30      Profit  $20  → 0.30
  //     ROI  3×  → 0.58      Profit  $50  → 0.49
  //     ROI  10× → 0.85      Profit $200  → 0.71
  //     ROI  50× → 1.34      Profit $1000 → 1.00 (full weight)
  //     ROI 154× → 1.66      Profit $5000 → 1.34
  // The log denominator sets where "1.0" lands; values above that still
  // contribute proportionally more, so a 154× item with $400 profit really
  // does dominate a 3× item with $30 profit even after blending velocity in.
  const LOG_ROI_DENOM = log10p(50);      // ROI of 50 maps to 1.0
  const LOG_PROFIT_DENOM = log10p(1000); // Profit of $1000 maps to 1.0
  function log10p(x) { return Math.log10(1 + Math.max(0, x)); }

  // Sales-velocity tier → numeric score. Mirrors SALES_VELOCITY_SCORES in config.py.
  const VELOCITY_SCORES = {
    hot: 1.0,
    normal: 0.65,
    slow: 0.35,
    very_slow: 0.10,
    unknown: 0.0,
    "": 0.0,
  };

  // Purchase-price multiplier mirrors config.PURCHASE_PRICE_MULTIPLIER.
  // The cost to acquire ≈ next_required_bid * 1.3 after fees + tax + premium.
  const PURCHASE_PRICE_MULT = 1.3;
  const HASSLE = 5.0;

  // ─── Condition tiers ────────────────────────────────────────────
  // Mirrors _condition_resale_factor() in scrape.py. The factor multiplies
  // estimated_resale: 1.0 for new / open_box (default — no penalty when
  // condition is unknown or AI confidence is low), 0.85 for damaged_easy_fix
  // (small "dad can fix it" haircut), 0.0 for damaged_hard_fix (unsellable).
  const CONDITION_FACTORS = {
    new:               1.00,
    open_box:          1.00,
    damaged_easy_fix:  0.85,
    damaged_hard_fix:  0.00,
  };
  // Display labels for the condition badge on each card.
  const CONDITION_LABELS = {
    new:               "new",
    open_box:          "open box",
    damaged_easy_fix:  "easy fix",
    damaged_hard_fix:  "hard fix",
  };

  // ---- DOM refs ---------------------------------------------------
  const grid           = document.getElementById("grid");
  const sortSel        = document.getElementById("sort");
  const velocitySel    = document.getElementById("velocity");
  const conditionSel   = document.getElementById("condition");
  const showClosedInput = document.getElementById("show-closed");
  const minFlipInput   = document.getElementById("min-flip");
  const minFlipValue   = document.getElementById("min-flip-value");
  const searchInput    = document.getElementById("search");
  const searchClear    = document.getElementById("search-clear");
  const freshnessEl    = document.getElementById("freshness");
  const freshnessText  = document.getElementById("freshness-text");
  const resultCount    = document.getElementById("result-count");
  const cardTpl        = document.getElementById("card-template");
  const loadMoreWrap   = document.getElementById("load-more-wrap");
  const loadMoreBtn    = document.getElementById("load-more");
  const loadMoreInfo   = document.getElementById("load-more-info");

  // ---- State ------------------------------------------------------
  let allItems        = [];
  let filteredItems   = [];   // current filtered+sorted view
  let renderedCount   = 0;    // how many of filteredItems are drawn
  let generatedAt     = null;
  let nowMs           = Date.now();
  let pendingRestore  = null; // { renderedCount, scrollY } from sessionStorage
  let saveStateTimer  = null;
  let searchDebounce  = null;
  let searchQueryNorm = "";   // lowercased + trimmed; used by filter

  // ---- Boot -------------------------------------------------------
  pendingRestore = restoreUiState();   // read saved state BEFORE first render
  registerServiceWorker();
  loadData();
  bindControls();
  bindUnloadSave();

  // Re-tick "now" each minute — only relabels closing times in already-
  // rendered cards. We deliberately don't re-render or re-paginate so the
  // user doesn't lose their scroll position.
  setInterval(() => {
    nowMs = Date.now();
    renderFreshness();
    rerenderClosingTimes();
  }, 60_000);

  // ---- Service Worker registration -------------------------------
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Register after page load so it doesn't compete with first-paint resources.
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("service worker registration failed:", err);
      });
    });
  }

  // ---- Data loading ----------------------------------------------
  async function loadData() {
    try {
      // No {cache:"no-store"} — we WANT the browser/SW to be allowed to serve
      // a cached copy. The SW uses network-first for items.json so a fresh
      // copy lands in cache; a cached items.json is the offline fallback.
      const res = await fetch("data/items.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      allItems    = Array.isArray(data.items) ? data.items : [];
      generatedAt = data.generated_at ? new Date(data.generated_at) : null;
      grid.removeAttribute("aria-busy");
      renderFreshness();
      render();
      // Restore scroll AFTER the first render, in a microtask, so the DOM
      // has actually grown to the saved height. We do it inside applyPendingRestore.
      applyPendingRestore();
    } catch (err) {
      grid.classList.add("grid--empty");
      grid.removeAttribute("aria-busy");
      grid.textContent =
        "Could not load data/items.json. If you're running locally, " +
        "make sure web/data/items.json exists and that you started the " +
        "server from the web/ directory.";
      freshnessEl.className = "freshness freshness--ancient";
      freshnessText.textContent = "no data";
      console.error(err);
    }
  }

  // ---- Controls ---------------------------------------------------
  function bindControls() {
    // Restore values from saved state before we wire change handlers (so we
    // don't fire a render mid-restore). Falls back to defaults from HTML.
    if (pendingRestore) {
      if (typeof pendingRestore.sort === "string") {
        const opt = sortSel.querySelector(`option[value="${pendingRestore.sort}"]`);
        if (opt) sortSel.value = pendingRestore.sort;
      }
      if (typeof pendingRestore.velocity === "string") {
        const opt = velocitySel.querySelector(`option[value="${pendingRestore.velocity}"]`);
        if (opt) velocitySel.value = pendingRestore.velocity;
      }
      if (typeof pendingRestore.condition === "string") {
        const opt = conditionSel.querySelector(`option[value="${pendingRestore.condition}"]`);
        if (opt) conditionSel.value = pendingRestore.condition;
      }
      if (typeof pendingRestore.showClosed === "boolean") {
        showClosedInput.checked = pendingRestore.showClosed;
      }
      if (typeof pendingRestore.minFlip === "number") {
        minFlipInput.value = String(pendingRestore.minFlip);
      }
      if (typeof pendingRestore.search === "string") {
        searchInput.value = pendingRestore.search;
        searchQueryNorm = pendingRestore.search.trim().toLowerCase();
        searchClear.hidden = !pendingRestore.search;
      }
    }

    sortSel.addEventListener("change", () => { render(); saveStateSoon(); });
    velocitySel.addEventListener("change", () => { render(); saveStateSoon(); });
    conditionSel.addEventListener("change", () => { render(); saveStateSoon(); });
    showClosedInput.addEventListener("change", () => { render(); saveStateSoon(); });
    minFlipInput.addEventListener("input", () => {
      minFlipValue.textContent = parseFloat(minFlipInput.value).toFixed(1);
      render();
      saveStateSoon();
    });
    minFlipValue.textContent = parseFloat(minFlipInput.value).toFixed(1);

    // Search: debounce so we don't re-render on every keystroke when the
    // dataset is large.
    searchInput.addEventListener("input", () => {
      searchClear.hidden = !searchInput.value;
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchQueryNorm = searchInput.value.trim().toLowerCase();
        render();
        saveStateSoon();
      }, 150);
    });
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchQueryNorm = "";
      searchClear.hidden = true;
      render();
      saveStateSoon();
      searchInput.focus();
    });

    loadMoreBtn.addEventListener("click", () => { renderMore(); saveStateSoon(); });

    // Save scroll position as the user scrolls, debounced.
    window.addEventListener("scroll", () => { saveStateSoon(); }, { passive: true });
  }

  // ---- State persistence -----------------------------------------
  function saveStateSoon() {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(saveUiStateNow, 250);
  }

  function saveUiStateNow() {
    try {
      const payload = {
        v: STATE_VERSION,
        sort: sortSel.value,
        velocity: velocitySel.value,
        condition: conditionSel.value,
        showClosed: showClosedInput.checked,
        minFlip: parseFloat(minFlipInput.value),
        search: searchInput.value,
        renderedCount: renderedCount,
        scrollY: window.scrollY || window.pageYOffset || 0,
      };
      sessionStorage.setItem(STATE_KEY, JSON.stringify(payload));
    } catch (err) {
      // sessionStorage can throw in private browsing or when full. Non-fatal.
    }
  }

  function restoreUiState() {
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== STATE_VERSION) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function bindUnloadSave() {
    // Last-chance save on unload (covers refresh, navigation, tab close).
    // pagehide fires more reliably on mobile than beforeunload.
    window.addEventListener("pagehide", saveUiStateNow);
    window.addEventListener("beforeunload", saveUiStateNow);
  }

  function applyPendingRestore() {
    if (!pendingRestore) return;
    const target = pendingRestore.renderedCount || 0;
    // We may need to render multiple "pages" worth of items to hit the saved
    // count. Filtered set may have shrunk since last visit, in which case we
    // simply render whatever's available.
    while (renderedCount < target && renderedCount < filteredItems.length) {
      renderMore();
    }
    const scrollY = pendingRestore.scrollY || 0;
    if (scrollY > 0) {
      // requestAnimationFrame (twice) to wait for layout after the burst of
      // appends, otherwise scrollTo can land short.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
      }));
    }
    pendingRestore = null;
  }

  // ---- Freshness banner ------------------------------------------
  function renderFreshness() {
    if (!generatedAt || isNaN(generatedAt.getTime())) {
      freshnessEl.className = "freshness freshness--unknown";
      freshnessText.textContent = "freshness unknown";
      return;
    }
    const ageMs = nowMs - generatedAt.getTime();
    const ageH  = ageMs / 3_600_000;

    let tier, label;
    if (ageH < 12)      { tier = "fresh";   }
    else if (ageH < 24) { tier = "stale";   }
    else                { tier = "ancient"; }

    if (ageH < 1) {
      const m = Math.max(0, Math.round(ageMs / 60_000));
      label = m <= 1 ? "Refreshed just now" : `Refreshed ${m} minutes ago`;
    } else if (ageH < 48) {
      const h = Math.round(ageH);
      label = `Refreshed ${h} hour${h === 1 ? "" : "s"} ago`;
    } else {
      const d = Math.round(ageH / 24);
      label = `Refreshed ${d} days ago`;
    }
    freshnessEl.className = "freshness freshness--" + tier;
    freshnessText.textContent = label;
  }

  // ---- Number / field helpers ------------------------------------
  function num(s) {
    if (s === "" || s === null || s === undefined) return NaN;
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }
  function dollarsToNum(s) {
    if (s === "" || s === null || s === undefined) return NaN;
    return num(String(s).replace(/[^0-9.]/g, ""));
  }
  function bidNum(item) {
    if (typeof item.current_bid_value === "number") return item.current_bid_value;
    return dollarsToNum(item.current_bid);
  }
  // The next required bid (raw, before fees/tax). Falls back to current_bid + 1.
  function nextBidNum(item) {
    const n = dollarsToNum(item.next_required_bid);
    if (!isNaN(n)) return n;
    const cb = bidNum(item);
    return isNaN(cb) ? NaN : cb + 1;
  }
  // Realistic out-of-pocket cost: next required bid * 1.3 (buyer's premium + tax + fees).
  function purchasePriceNum(item) {
    const n = nextBidNum(item);
    return isNaN(n) ? NaN : n * PURCHASE_PRICE_MULT;
  }

  // ─── Condition helpers ──────────────────────────────────────────
  // Normalize the AI's condition tag. Defaults to "open_box" — that mirrors
  // the prompt's instruction to default there when the listing is vague,
  // and means low-confidence / legacy items are NOT penalized at scoring
  // time. (Old items in raw_items.json predate this field and will fall
  // through to the default.)
  function conditionOf(item) {
    if (item._cond === undefined) {
      const c = (item.ai_condition || "").trim().toLowerCase();
      item._cond = (c in CONDITION_FACTORS) ? c : "open_box";
    }
    return item._cond;
  }
  function conditionFactorOf(item) {
    return CONDITION_FACTORS[conditionOf(item)];
  }

  // Recompute flip score (ROI) from raw fields. Stays in sync with
  // compute_flip_score() in scrape.py — same purchase-price model and
  // same condition-as-resale-multiplier treatment.
  function computeFlipScore(item) {
    const resale = num(item.ai_estimated_resale);
    const purchase = purchasePriceNum(item);
    if (isNaN(resale) || isNaN(purchase) || resale <= 0) return NaN;
    const effectiveResale = resale * conditionFactorOf(item);
    const denom = Math.max(purchase, 1.0);
    return (effectiveResale - purchase - HASSLE) / denom;
  }
  function flipScoreOf(item) {
    if (item._fs === undefined) item._fs = computeFlipScore(item);
    return item._fs;
  }

  // Gross profit in dollars: effective_resale - purchase - hassle.
  // Same numerator as flip_score; differs only in normalization.
  function computeGrossProfit(item) {
    const resale = num(item.ai_estimated_resale);
    const purchase = purchasePriceNum(item);
    if (isNaN(resale) || isNaN(purchase) || resale <= 0) return NaN;
    const effectiveResale = resale * conditionFactorOf(item);
    return effectiveResale - purchase - HASSLE;
  }
  function grossProfitOf(item) {
    if (item._gp === undefined) item._gp = computeGrossProfit(item);
    return item._gp;
  }

  // Sales velocity score: numeric value derived from ai_sales_velocity tier.
  function velocityScoreOf(item) {
    if (item._vs === undefined) {
      const v = (item.ai_sales_velocity || "").toLowerCase();
      item._vs = VELOCITY_SCORES[v] !== undefined ? VELOCITY_SCORES[v] : 0;
    }
    return item._vs;
  }

  // Smart score blends ROI, gross profit, and sales velocity into one rank.
  // See SMART_WEIGHTS for the mix. Returns NaN if we can't compute ROI/profit
  // (i.e. AI confidence was unknown), so unknowns sink to bottom of any sort.
  //
  // We use log normalization rather than capping so a 154× ROI item still
  // outranks a 5× ROI item, just not 30× harder. Negative ROI / profit
  // contribute 0 (those items are losing money — don't reward them).
  function smartScoreOf(item) {
    if (item._ss === undefined) {
      const roi    = flipScoreOf(item);
      const profit = grossProfitOf(item);
      if (isNaN(roi) || isNaN(profit)) {
        item._ss = NaN;
      } else {
        const roiNorm    = log10p(roi)    / LOG_ROI_DENOM;
        const profitNorm = log10p(profit) / LOG_PROFIT_DENOM;
        const velNorm    = velocityScoreOf(item);
        item._ss = SMART_WEIGHTS.roi    * roiNorm
                 + SMART_WEIGHTS.profit * profitNorm
                 + SMART_WEIGHTS.velocity * velNorm;
      }
    }
    return item._ss;
  }

  function closingMs(item) {
    if (!item.closing_time_iso) return NaN;
    const t = Date.parse(item.closing_time_iso);
    return isNaN(t) ? NaN : t;
  }
  function isClosed(item) {
    const t = closingMs(item);
    if (isNaN(t)) return false;
    return t < nowMs;
  }

  // Count how many items in allItems aren't closed yet. Cached per-minute
  // so we don't walk the whole array on every render. The cache is keyed
  // by (allItems length, current minute) — both have to match for a hit,
  // which means the count refreshes when new data loads OR a minute ticks.
  let _openCountCache = { len: -1, minute: -1, value: 0 };
  function countOpenItems() {
    const minute = Math.floor(nowMs / 60_000);
    if (_openCountCache.len === allItems.length && _openCountCache.minute === minute) {
      return _openCountCache.value;
    }
    let n = 0;
    for (let i = 0; i < allItems.length; i++) {
      if (!isClosed(allItems[i])) n++;
    }
    _openCountCache = { len: allItems.length, minute: minute, value: n };
    return n;
  }

  // Denominator for the result count, given the current "Show closed" toggle.
  // When OFF: same as countOpenItems(). When ON: open items + items closed
  // since local midnight today, so "X of Y" still makes sense (filteredItems
  // won't ever exceed Y). Uncached on the closed branch — a full walk over a
  // few thousand items is sub-millisecond, and the toggle is a rare action.
  function countShownPool(showClosed) {
    if (!showClosed) return countOpenItems();
    const cutoff = new Date().setHours(0, 0, 0, 0);
    let n = 0;
    for (let i = 0; i < allItems.length; i++) {
      const it = allItems[i];
      if (!isClosed(it)) { n++; continue; }
      const t = closingMs(it);
      if (!isNaN(t) && t >= cutoff) n++;
    }
    return n;
  }

  // Split haystacks: we score title hits higher than body hits so a search
  // for "car" surfaces "Car Stereo" before a dog ramp whose AI notes happen
  // to contain "carpet". Built lazily and cached on the item.
  function titleHayOf(item) {
    if (item._titleHay === undefined) {
      item._titleHay = (item.title || "").toLowerCase();
    }
    return item._titleHay;
  }
  function bodyHayOf(item) {
    if (item._bodyHay === undefined) {
      const parts = [
        item.ai_notes,
        item.category,
        item.description,
        item.location,
      ].filter(Boolean);
      item._bodyHay = parts.join(" \n ").toLowerCase();
    }
    return item._bodyHay;
  }

  // Build search-term regexes from the user's query.
  //
  // We split on whitespace and require ALL terms to match (AND semantics, so
  // "leaf blower" finds items mentioning both, in any order). For each term
  // we precompile TWO regexes:
  //   - reWord:   \bTERM\b — whole-word match (the gold-standard hit:
  //               "car" matches "Car Battery" but not "Carpet")
  //   - rePrefix: \bTERM   — word-start match ("car" matches "Carpet" too,
  //               and "hammer" matches "hammers" — useful for plurals)
  //
  // An item passes the filter if every term hits at least at the prefix
  // level, somewhere (title or body). The ranking tier (below) decides
  // WHERE in the results that item lands.
  //
  // Special chars are escaped so a query like "3.5mm" doesn't get parsed
  // as regex syntax.
  function buildSearchTerms(query) {
    if (!query) return null;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    return terms.map((t) => {
      const esc = escapeRegex(t);
      return {
        raw: t,
        reWord:   new RegExp("\\b" + esc + "\\b"),
        rePrefix: new RegExp("\\b" + esc),
      };
    });
  }
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Filter test: does this item pass the search?
  // Every term must match SOMEWHERE — title or body — at least at the
  // prefix level. The relevance tier (below) decides ranking among the
  // survivors.
  function matchesSearch(item, terms) {
    if (!terms) return true;
    const titleHay = titleHayOf(item);
    const bodyHay = bodyHayOf(item);
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      if (!t.rePrefix.test(titleHay) && !t.rePrefix.test(bodyHay)) return false;
    }
    return true;
  }

  // Per-term tier (lower number = better match). Tiers are deliberately
  // discrete so ranking GROUPS items into bands rather than mixing them:
  //   1: title whole-word     ("car" in "Car Battery")
  //   2: title prefix only    ("car" in "Carpet Cleaner" — also "Cars")
  //   3: body whole-word      ("car" as a standalone word in notes)
  //   4: body prefix only     ("car" inside "Carpet" appears in body)
  //   99: no match            (filtered out before we score)
  function termTier(term, titleHay, bodyHay) {
    if (term.reWord.test(titleHay))   return 1;
    if (term.rePrefix.test(titleHay)) return 2;
    if (term.reWord.test(bodyHay))    return 3;
    if (term.rePrefix.test(bodyHay))  return 4;
    return 99;
  }

  // Item-level tier across all search terms = the WORST per-term tier
  // ("weakest link" rule). Searching "car battery":
  //   • both terms title-whole-word → item tier 1 (best)
  //   • "car" title-WW, "battery" title-prefix → item tier 2
  //   • "car" title-WW, "battery" body-WW → item tier 3
  // This gives clean groups: ALL tier-1 items rank above ALL tier-2 items,
  // regardless of how many terms hit. Within a tier, the user's chosen
  // sort (smart score, ROI, etc.) breaks the tie.
  //
  // Cached per render-pass via the terms object identity (terms is rebuilt
  // every render() call, so a stale cache can't survive across renders).
  function searchTierOf(item, terms) {
    if (item._tierTerms === terms) return item._tier;
    const titleHay = titleHayOf(item);
    const bodyHay = bodyHayOf(item);
    let worst = 0;
    for (let i = 0; i < terms.length; i++) {
      const t = termTier(terms[i], titleHay, bodyHay);
      if (t > worst) worst = t;
    }
    item._tier = worst;
    item._tierTerms = terms;
    return worst;
  }

  // ---- Sort comparators ------------------------------------------
  // Each comparator pushes NaN/missing values to the bottom regardless of
  // sort direction.
  function descBy(getter) {
    return (a, b) => {
      const av = getter(a), bv = getter(b);
      const ag = isNaN(av) ? 1 : 0, bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return bv - av;
    };
  }
  function ascBy(getter) {
    return (a, b) => {
      const av = getter(a), bv = getter(b);
      const ag = isNaN(av) ? 1 : 0, bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return av - bv;
    };
  }
  const COMPARATORS = {
    smart:        descBy(smartScoreOf),
    flip_score:   descBy(flipScoreOf),
    gross_profit: descBy(grossProfitOf),
    current_bid:  ascBy(nextBidNum),
    closing_time: ascBy(closingMs),
    title: (a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }),
  };

  // ---- Velocity filter -------------------------------------------
  function passesVelocityFilter(item, mode) {
    if (mode === "any") return true;
    const v = (item.ai_sales_velocity || "").toLowerCase();
    if (mode === "hot")              return v === "hot";
    if (mode === "hot_or_normal")    return v === "hot" || v === "normal";
    if (mode === "exclude_very_slow") return v !== "very_slow";
    return true;
  }

  // ---- Condition filter ------------------------------------------
  // Symmetric with the velocity filter. Uses conditionOf() — which defaults
  // empty/unknown to "open_box" — so legacy items without ai_condition land
  // in the "open box" bucket and are NOT filtered out by "New or open box"
  // or "Exclude hard fix". They WILL be filtered out by "New only", which
  // matches user intent (if they ask for sealed-only, legacy unknowns
  // shouldn't slip through).
  function passesConditionFilter(item, mode) {
    if (mode === "any") return true;
    const c = conditionOf(item);
    if (mode === "new")              return c === "new";
    if (mode === "new_or_open_box")  return c === "new" || c === "open_box";
    if (mode === "exclude_hard_fix") return c !== "damaged_hard_fix";
    return true;
  }

  // ---- Render -----------------------------------------------------
  function render() {
    const minFlip       = parseFloat(minFlipInput.value);
    const sortBy        = sortSel.value;
    const velocityMode  = velocitySel.value;
    const conditionMode = conditionSel.value;
    const showClosed    = showClosedInput.checked;
    const closedCutoff  = new Date().setHours(0, 0, 0, 0);  // local midnight today
    const terms         = buildSearchTerms(searchQueryNorm);

    filteredItems = allItems.filter((it) => {
      // Closed items are hidden by default. When "Show today's closed" is on,
      // include items that closed since local midnight today so the user can
      // spot big-ROI lots they missed today. Items closed yesterday or earlier
      // stay hidden either way — they're stale noise. Recomputed every render,
      // so the cutoff naturally rolls over the moment the clock hits midnight.
      if (isClosed(it)) {
        if (!showClosed) return false;
        const t = closingMs(it);
        if (isNaN(t) || t < closedCutoff) return false;
      }
      if (!passesVelocityFilter(it, velocityMode)) return false;
      if (!passesConditionFilter(it, conditionMode)) return false;
      if (!matchesSearch(it, terms)) return false;
      const f = flipScoreOf(it);
      if (isNaN(f)) return minFlip === 0;
      return f >= minFlip;
    });

    // When a search is active, GROUP results by relevance tier first, then
    // apply the user's chosen sort within each group. So "car" surfaces all
    // title-whole-word matches first (sorted by smart score / ROI / etc.),
    // then all title-prefix matches, then body matches — clean bands rather
    // than a continuous gradient. Within each band, filters and sort behave
    // exactly like the no-search case.
    const baseCmp = COMPARATORS[sortBy] || COMPARATORS.smart;
    if (terms) {
      filteredItems.sort((a, b) => {
        const ta = searchTierOf(a, terms);
        const tb = searchTierOf(b, terms);
        if (ta !== tb) return ta - tb;   // lower tier number = better match, comes first
        return baseCmp(a, b);
      });
    } else {
      filteredItems.sort(baseCmp);
    }

    // The total used in the "X of Y items" display reflects the same pool
    // the filter pulls from. When Show Closed is off, that's open items
    // only (same as before). When on, it's open + recently-closed items, so
    // filteredItems.length never exceeds the denominator.
    const totalPool = countShownPool(showClosed);
    resultCount.textContent =
      `${filteredItems.length} of ${totalPool} item${totalPool === 1 ? "" : "s"}`;

    // Reset paging and clear the grid
    renderedCount = 0;
    grid.replaceChildren();

    if (filteredItems.length === 0) {
      grid.classList.add("grid--empty");
      const reasons = [];
      if (searchQueryNorm) reasons.push("clear the search");
      if (minFlip > 0) reasons.push("lower the min flip score");
      if (velocityMode !== "any") reasons.push("change Velocity to Any");
      if (conditionMode !== "any") reasons.push("change Condition to Any");
      if (!showClosed) reasons.push("enable Show today's closed");
      const hint = reasons.length
        ? `Try ${reasons.join(" or ")} to see more.`
        : "There are no open items in the data file.";
      grid.innerHTML = `<p>No items match the current filters.<br><small>${hint}</small></p>`;
      loadMoreWrap.hidden = true;
      return;
    }

    grid.classList.remove("grid--empty");
    renderMore();
  }

  // Append the next PAGE_SIZE cards.
  function renderMore() {
    const end = Math.min(renderedCount + PAGE_SIZE, filteredItems.length);
    const frag = document.createDocumentFragment();
    for (let i = renderedCount; i < end; i++) {
      frag.appendChild(buildCard(filteredItems[i]));
    }
    grid.appendChild(frag);
    renderedCount = end;

    if (renderedCount >= filteredItems.length) {
      loadMoreWrap.hidden = true;
    } else {
      loadMoreWrap.hidden = false;
      const remaining = filteredItems.length - renderedCount;
      loadMoreInfo.textContent =
        `Showing ${renderedCount} of ${filteredItems.length} — ${remaining} more`;
    }
  }

  // Update closing-time labels on already-rendered cards (no rebuild).
  function rerenderClosingTimes() {
    const cards = grid.querySelectorAll(".card[data-iso]");
    cards.forEach((card) => {
      const closingEl = card.querySelector('[data-role="closing"]');
      if (!closingEl) return;
      const iso      = card.getAttribute("data-iso");
      const fallback = card.getAttribute("data-closing-fallback") || "";
      closingEl.textContent = formatClosingFromIso(iso, fallback);
      const t = Date.parse(iso);
      if (!isNaN(t) && t < nowMs) closingEl.classList.add("closed");
      else closingEl.classList.remove("closed");
    });
  }

  // ---- Card builder ----------------------------------------------
  function buildCard(item) {
    const node = cardTpl.content.firstElementChild.cloneNode(true);

    // Stash closing time so the minute-tick can update it cheaply.
    if (item.closing_time_iso) node.setAttribute("data-iso", item.closing_time_iso);
    node.setAttribute(
      "data-closing-fallback",
      item.time_remaining || item.closing_time_raw || ""
    );

    // Image
    const img = node.querySelector("img");
    if (item.image_url) {
      img.src = item.image_url;
      img.alt = item.title || "auction item";
      img.addEventListener("error", () => img.classList.add("broken"), { once: true });
    } else {
      img.classList.add("broken");
      img.alt = "";
    }

    // Flip score (ROI) badge
    const scoreEl = node.querySelector('[data-role="flip-score"]');
    const f = flipScoreOf(item);
    if (isNaN(f)) {
      scoreEl.textContent = "—";
      scoreEl.classList.add("empty");
      scoreEl.title = "No flip score (AI confidence: unknown)";
    } else {
      scoreEl.textContent = f.toFixed(2) + "×";
      scoreEl.title =
        `ROI: ${f.toFixed(2)}× — ` +
        `(effective resale − cost − $${HASSLE.toFixed(0)} hassle) ÷ cost. ` +
        `Cost = next bid × ${PURCHASE_PRICE_MULT.toFixed(1)}. ` +
        `Effective resale = est. resale × condition factor.`;
    }

    // Gross profit badge ($)
    const profitEl = node.querySelector('[data-role="gross-profit"]');
    if (profitEl) {
      const gp = grossProfitOf(item);
      if (isNaN(gp)) {
        profitEl.textContent = "";
      } else {
        profitEl.textContent = "$" + Math.round(gp);
        profitEl.title = `Estimated gross profit: $${gp.toFixed(2)}`;
      }
    }

    // Sales velocity badge
    const velEl = node.querySelector('[data-role="velocity"]');
    if (velEl) {
      const v = (item.ai_sales_velocity || "").toLowerCase();
      if (v && v !== "unknown") {
        velEl.textContent = v.replace("_", " ");
        velEl.setAttribute("data-velocity", v);
        velEl.title = `Estimated FB Marketplace velocity: ${v.replace("_", " ")}`;
      } else {
        velEl.textContent = "";
      }
    }

    // Confidence badge
    const confEl = node.querySelector('[data-role="confidence"]');
    if (item.ai_confidence && item.ai_confidence !== "unknown") {
      confEl.textContent = item.ai_confidence;
    }

    // Condition badge — renders only when the AI tagged the item with a
    // recognized condition. Empty/unknown leaves the badge collapsed via
    // the :empty CSS rule, so legacy items without ai_condition show no
    // condition badge at all (rather than a misleading "open box" label
    // we never actually computed).
    const condEl = node.querySelector('[data-role="condition"]');
    if (condEl) {
      const rawCond = (item.ai_condition || "").trim().toLowerCase();
      if (rawCond && rawCond in CONDITION_LABELS) {
        condEl.textContent = CONDITION_LABELS[rawCond];
        condEl.setAttribute("data-condition", rawCond);
        condEl.title = `AI-assessed condition: ${CONDITION_LABELS[rawCond]}`;
      } else {
        condEl.textContent = "";
      }
    }

    // Title
    node.querySelector('[data-role="title"]').textContent = item.title || "(untitled)";

    // Stats: bid, purchase cost (×1.3), resale, retail
    node.querySelector('[data-role="bid"]').textContent = item.current_bid || "—";
    const costEl = node.querySelector('[data-role="purchase-price"]');
    if (costEl) {
      const cost = purchasePriceNum(item);
      costEl.textContent = isNaN(cost) ? "—" : "$" + cost.toFixed(2);
      costEl.title = "Realistic out-of-pocket: next required bid × 1.3 (fees + tax)";
    }
    const resale = num(item.ai_estimated_resale);
    node.querySelector('[data-role="resale"]').textContent =
      isNaN(resale) ? "—" : "$" + resale.toFixed(2);
    const retail = num(item.ai_retail_estimate);
    node.querySelector('[data-role="retail"]').textContent =
      isNaN(retail) ? "—" : "$" + retail.toFixed(2);

    // Footer
    const closingEl  = node.querySelector('[data-role="closing"]');
    const categoryEl = node.querySelector('[data-role="category"]');
    closingEl.textContent = formatClosing(item);
    if (isClosed(item)) closingEl.classList.add("closed");
    categoryEl.textContent = shortCategory(item.category);

    // Location ("City, ST"). Empty-string content keeps the :empty CSS rule
    // hiding the row when we don't have a location for this item.
    const locationEl = node.querySelector('[data-role="location"]');
    if (locationEl) {
      locationEl.textContent = item.location || "";
    }

    // Click anywhere → open in new tab
    if (item.item_url) {
      node.addEventListener("click", () => {
        // Save state synchronously before we navigate, so coming back via
        // the back button restores cleanly. (The browser may bfcache this
        // page anyway, in which case our pagehide handler also fires.)
        saveUiStateNow();
        window.open(item.item_url, "_blank", "noopener");
      });
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          saveUiStateNow();
          window.open(item.item_url, "_blank", "noopener");
        }
      });
      node.setAttribute("aria-label", `Open ${item.title || "item"} on Equip-Bid`);
    }

    return node;
  }

  // ---- Display formatters ----------------------------------------
  function formatClosing(item) {
    return formatClosingFromIso(
      item.closing_time_iso,
      item.time_remaining || item.closing_time_raw || ""
    );
  }
  function formatClosingFromIso(iso, fallback) {
    if (!iso) return fallback || "no closing time";
    const t = Date.parse(iso);
    if (isNaN(t)) return fallback || "no closing time";
    const diffMs = t - nowMs;
    if (diffMs <= 0) return "Closed";
    const minutes = Math.round(diffMs / 60_000);
    if (minutes < 60)  return `Closes in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)    return `Closes in ${hours}h`;
    const days = Math.round(hours / 24);
    return `Closes in ${days}d`;
  }
  function shortCategory(cat) {
    if (!cat) return "";
    const parts = cat.split(">").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "";
  }
})();
