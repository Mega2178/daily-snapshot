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
  const STATE_VERSION = 3;               // bump if state schema changes

  // ─── Smart-score weights (request #5) ───────────────────────────
  // Smart score = w_roi*ROI_norm + w_profit*profit_norm + w_velocity*velocity_norm
  // Tweak weights here if you want a different emphasis. Defaults bias toward
  // ROI but give profit a real say — a high-ROI $5 item often loses to a
  // moderate-ROI $200 item.
  const SMART_WEIGHTS = {
    roi: 0.40,
    profit: 0.35,
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

  // Purchase-price multiplier mirrors config.PURCHASE_PRICE_MULTIPLIER (request #6).
  // The cost to acquire ≈ next_required_bid * 1.3 after fees + tax + premium.
  const PURCHASE_PRICE_MULT = 1.3;
  const HASSLE = 5.0;

  // ---- DOM refs ---------------------------------------------------
  const grid           = document.getElementById("grid");
  const sortSel        = document.getElementById("sort");
  const velocitySel    = document.getElementById("velocity");
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

  // Estimated $ to make this item sellable. Mirrors _repair_cost() in scrape.py.
  // Returns the model's number when present, 0 otherwise. Items enriched
  // before we asked the model for a $ figure show repair=$0 — their flip
  // scores remain unchanged from the day they were enriched, which is fine
  // because we don't re-enrich.
  function repairCostOf(item) {
    if (item._rc !== undefined) return item._rc;
    const direct = num(item.ai_repair_cost_usd);
    item._rc = (!isNaN(direct) && direct >= 0) ? direct : 0;
    return item._rc;
  }

  // Total acquisition cost: what you actually put in to flip the item.
  // Folding repair into cost (instead of subtracting from resale) makes
  // ROI a true "return per dollar invested" — a $10 bid + $50 repair
  // correctly looks tighter than a $10 bid + $0 repair for the same resale.
  function totalCostOf(item) {
    if (item._tc !== undefined) return item._tc;
    const purchase = purchasePriceNum(item);
    if (isNaN(purchase)) { item._tc = NaN; return NaN; }
    item._tc = purchase + repairCostOf(item);
    return item._tc;
  }

  // Recompute flip score (ROI) from raw fields. Stays in sync with
  // compute_flip_score() in scrape.py — same purchase-price model and
  // same repair-as-cost treatment.
  function computeFlipScore(item) {
    const resale = num(item.ai_estimated_resale);
    const total  = totalCostOf(item);
    if (isNaN(resale) || isNaN(total) || resale <= 0) return NaN;
    const denom = Math.max(total, 1.0);
    return (resale - total - HASSLE) / denom;
  }
  function flipScoreOf(item) {
    if (item._fs === undefined) item._fs = computeFlipScore(item);
    return item._fs;
  }

  // Gross profit in dollars: resale - total_cost - hassle.
  // Same numerator as flip_score; differs only in normalization.
  function computeGrossProfit(item) {
    const resale = num(item.ai_estimated_resale);
    const total  = totalCostOf(item);
    if (isNaN(resale) || isNaN(total) || resale <= 0) return NaN;
    return resale - total - HASSLE;
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
  // "leaf blower" finds items mentioning both, in any order). Each term must
  // appear at a WORD BOUNDARY in the haystack. That's the fix for the bug
  // where searching "hat" returned every item whose AI notes contained
  // "that" or "what".
  //
  // We use \b<term> (word-start), not \b<term>\b (whole-word), so that
  // typing "hammer" still matches "hammers" / "hammered". The tradeoff:
  // "saw" no longer matches inside "chainsaw" — typically what people want.
  //
  // Special chars in the query are escaped so a query like "3.5mm" doesn't
  // get parsed as regex syntax.
  function buildSearchTerms(query) {
    if (!query) return null;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    return terms.map((t) => ({
      raw: t,
      // Word-start regex: matches "hammer" inside "hammers" but not inside
      // "sledgehammer". This is the same pattern that was here before.
      re: new RegExp("\\b" + escapeRegex(t)),
    }));
  }
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Filter test: does this item pass the search? We require EVERY term to
  // appear SOMEWHERE — title or body — at a word boundary. The relevance
  // score (below) decides where it ranks among the survivors.
  function matchesSearch(item, terms) {
    if (!terms) return true;
    const titleHay = titleHayOf(item);
    const bodyHay = bodyHayOf(item);
    for (let i = 0; i < terms.length; i++) {
      if (!terms[i].re.test(titleHay) && !terms[i].re.test(bodyHay)) return false;
    }
    return true;
  }

  // Relevance score for ranking search hits. Higher = better.
  // The score is constructed so that ALL items matching in title rank above
  // ANY item matching only in body, regardless of how many body hits the
  // body-only item has. That's the user's #3: "if the title has the searched
  // word, it goes up; the random bs goes near the bottom."
  //
  // Per-term contribution:
  //   • title startsWith term:    1000 (exact prefix — "car" matches "Car Stereo...")
  //   • title contains term word: 500  ("car" in "...New Car Battery...")
  //   • title contains term substr: 200 ("car" in "Carpet Cleaner")
  //   • body word match:          10
  //   • body substring match:     1
  //   • no match for this term:   we'd already be filtered out
  //
  // Multi-term queries sum each term's score. So "car battery" giving 1000+500
  // (title prefix on "car", title word on "battery") beats 200+10 from a body match.
  function searchRelevance(item, terms) {
    if (!terms) return 0;
    let score = 0;
    const titleHay = titleHayOf(item);
    const bodyHay = bodyHayOf(item);
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      if (titleHay.startsWith(t.raw)) {
        score += 1000;
      } else if (t.re.test(titleHay)) {
        score += 500;
      } else if (titleHay.indexOf(t.raw) !== -1) {
        score += 200;
      } else if (t.re.test(bodyHay)) {
        score += 10;
      } else if (bodyHay.indexOf(t.raw) !== -1) {
        score += 1;
      }
    }
    return score;
  }
  function relevanceOf(item, terms) {
    // Cache only when terms object hasn't changed — terms is rebuilt on every
    // render() call so we tag it with a render-scoped marker.
    if (item._relTerms !== terms) {
      item._rel = searchRelevance(item, terms);
      item._relTerms = terms;
    }
    return item._rel;
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

  // ---- Render -----------------------------------------------------
  function render() {
    const minFlip      = parseFloat(minFlipInput.value);
    const sortBy       = sortSel.value;
    const velocityMode = velocitySel.value;
    const terms        = buildSearchTerms(searchQueryNorm);

    filteredItems = allItems.filter((it) => {
      // Closed items are NEVER shown — they're not actionable. The "Show
      // closed" toggle was removed; if a user really wants to see closed
      // lots they can browse the source site directly.
      if (isClosed(it)) return false;
      if (!passesVelocityFilter(it, velocityMode)) return false;
      if (!matchesSearch(it, terms)) return false;
      const f = flipScoreOf(it);
      if (isNaN(f)) return minFlip === 0;
      return f >= minFlip;
    });

    // When a search is active, rank by relevance FIRST, then by the user's
    // chosen sort as a tiebreaker. This way "car" surfaces title-matching
    // items before body-matching ones, but within each relevance tier we
    // still order by smart score / ROI / closing time / etc.
    const baseCmp = COMPARATORS[sortBy] || COMPARATORS.smart;
    if (terms) {
      filteredItems.sort((a, b) => {
        const ra = relevanceOf(a, terms);
        const rb = relevanceOf(b, terms);
        if (rb !== ra) return rb - ra;   // higher relevance first
        return baseCmp(a, b);
      });
    } else {
      filteredItems.sort(baseCmp);
    }

    // The total used in the "X of Y items" display is the count of OPEN
    // items, not the raw allItems length. Closed lots aren't actionable —
    // showing them in the denominator just inflates the number visually
    // ("155 of 10,383" → most of those 10,383 are already over).
    const openTotal = countOpenItems();
    resultCount.textContent =
      `${filteredItems.length} of ${openTotal} item${openTotal === 1 ? "" : "s"}`;

    // Reset paging and clear the grid
    renderedCount = 0;
    grid.replaceChildren();

    if (filteredItems.length === 0) {
      grid.classList.add("grid--empty");
      const reasons = [];
      if (searchQueryNorm) reasons.push("clear the search");
      if (minFlip > 0) reasons.push("lower the min flip score");
      if (velocityMode !== "any") reasons.push("change Velocity to Any");
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
        `(resale − total cost − $${HASSLE.toFixed(0)} hassle) ÷ total cost. ` +
        `Total cost = (next bid × ${PURCHASE_PRICE_MULT.toFixed(1)}) + repair cost.`;
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

    // Title
    node.querySelector('[data-role="title"]').textContent = item.title || "(untitled)";

    // Stats: bid, purchase cost (×1.3), repair, resale, retail
    node.querySelector('[data-role="bid"]').textContent = item.current_bid || "—";
    const costEl = node.querySelector('[data-role="purchase-price"]');
    if (costEl) {
      const cost = purchasePriceNum(item);
      costEl.textContent = isNaN(cost) ? "—" : "$" + cost.toFixed(2);
      costEl.title = "Realistic out-of-pocket: next required bid × 1.3 (fees + tax)";
    }
    const repairEl = node.querySelector('[data-role="repair"]');
    if (repairEl) {
      const r = repairCostOf(item);
      // Show "—" for zero so the stat visually fades out for items with no
      // condition issue. Anything > 0 shows the dollar amount the model
      // estimated for parts (handyman labor assumed free).
      if (r > 0) {
        repairEl.textContent = "$" + r.toFixed(2);
        repairEl.title =
          "Estimated parts cost to make this sellable. Aftermarket / used / " +
          "junkyard sources assumed; handyman labor assumed free.";
      } else {
        repairEl.textContent = "—";
        repairEl.title = "No repair needed";
      }
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
