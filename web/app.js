// Daily Snapshot — vanilla JS, no framework, no build step.
// Reads data/items.json, renders cards with sort/filter/search controls.
//
// Pagination:    only render PAGE_SIZE cards at a time so 6k items don't choke
//                the browser.
// State persist: filter/sort/search/scroll/renderedCount survive a page reload
//                via sessionStorage, so "Load more" + scroll position aren't lost.
// Auto-refresh:  polls items.json every 5 minutes; when generated_at changes,
//                shows a banner the user can click to reload (we don't yank
//                them out of mid-scroll automatically).
// Service Worker (sw.js) caches the static files + items.json so repeat
// visits are instant; a fresh copy is fetched in the background.

(function () {
  "use strict";

  const PAGE_SIZE = 60;                  // cards rendered per "page"
  const POLL_INTERVAL_MS = 5 * 60_000;   // check for new data every 5 min
  const STATE_KEY = "daily-snapshot:ui-state";
  const STATE_VERSION = 2;               // bump if state schema changes

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
  const showClosedCb   = document.getElementById("show-closed");
  const searchInput    = document.getElementById("search");
  const searchClear    = document.getElementById("search-clear");
  const freshnessEl    = document.getElementById("freshness");
  const freshnessText  = document.getElementById("freshness-text");
  const resultCount    = document.getElementById("result-count");
  const cardTpl        = document.getElementById("card-template");
  const loadMoreWrap   = document.getElementById("load-more-wrap");
  const loadMoreBtn    = document.getElementById("load-more");
  const loadMoreInfo   = document.getElementById("load-more-info");
  const refreshBanner  = document.getElementById("refresh-banner");

  // ---- State ------------------------------------------------------
  let allItems        = [];
  let filteredItems   = [];   // current filtered+sorted view
  let renderedCount   = 0;    // how many of filteredItems are drawn
  let generatedAt     = null;
  let nowMs           = Date.now();
  let pendingRestore  = null; // { renderedCount, scrollY } from sessionStorage
  let saveStateTimer  = null;
  let pollTimer       = null;
  let searchDebounce  = null;
  let searchQueryNorm = "";   // lowercased + trimmed; used by filter

  // ---- Boot -------------------------------------------------------
  pendingRestore = restoreUiState();   // read saved state BEFORE first render
  registerServiceWorker();
  loadData();
  bindControls();
  startPolling();
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

  // ---- Background polling for new snapshots ----------------------
  function startPolling() {
    pollTimer = setInterval(checkForNewSnapshot, POLL_INTERVAL_MS);
    // Also check when the tab becomes visible — common case is "leave laptop
    // open overnight, come back in the morning". A 5-min poll has probably
    // already fired but this catches the case where it hasn't.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkForNewSnapshot();
    });
  }

  async function checkForNewSnapshot() {
    if (refreshBanner && !refreshBanner.hidden) return; // banner already up
    // If the initial loadData() hasn't finished yet, generatedAt is null and
    // we have nothing to compare against. Bail — we'll re-check on the next
    // interval / visibilitychange after data is loaded.
    if (!generatedAt) return;
    try {
      // Use {cache:"no-store"} here so we explicitly bypass HTTP caches —
      // we want to know if the server has a NEWER copy than what we loaded.
      // The SW also forwards this to the network in network-first mode.
      const res = await fetch("data/items.json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const fresh = data.generated_at ? new Date(data.generated_at) : null;
      if (!fresh || isNaN(fresh.getTime())) return;
      // Strictly newer — equal timestamps mean same snapshot, no banner.
      if (fresh.getTime() > generatedAt.getTime()) {
        showRefreshBanner();
      }
    } catch (err) {
      // Network blip — quietly retry on next interval.
    }
  }

  function showRefreshBanner() {
    if (!refreshBanner) return;
    refreshBanner.hidden = false;
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
      if (typeof pendingRestore.showClosed === "boolean") {
        showClosedCb.checked = pendingRestore.showClosed;
      }
      if (typeof pendingRestore.search === "string") {
        searchInput.value = pendingRestore.search;
        searchQueryNorm = pendingRestore.search.trim().toLowerCase();
        searchClear.hidden = !pendingRestore.search;
      }
    }

    sortSel.addEventListener("change", () => { render(); saveStateSoon(); });
    velocitySel.addEventListener("change", () => { render(); saveStateSoon(); });
    showClosedCb.addEventListener("change", () => { render(); saveStateSoon(); });
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

    if (refreshBanner) {
      refreshBanner.addEventListener("click", async () => {
        // Save state synchronously before reload so the user lands back where
        // they were (with the new data layered in).
        saveUiStateNow();
        // Reload safely w.r.t. the service worker.
        // The fetch we just did to detect the new snapshot also triggered the
        // SW to update its data cache. But there's a related risk: if a new
        // VERSION of the SW itself is waiting to activate (because we shipped
        // new app.js / index.html / style.css), a plain location.reload()
        // might still hit the OLD SW and get OLD cached assets. To avoid this:
        //   1. Ask the SW registration to update.
        //   2. If a new worker is found, send it skipWaiting and wait for it
        //      to take control, then reload.
        //   3. Otherwise, just reload.
        // Worst case we fall through to the simple reload, which is still
        // correct — just might serve cached items.json on a brief network hiccup.
        try {
          if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) {
              await reg.update();   // pull latest sw.js from network
              const waiting = reg.waiting;
              if (waiting) {
                // A new SW is waiting — promote it and reload AFTER it takes over.
                let reloaded = false;
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                  if (reloaded) return;
                  reloaded = true;
                  location.reload();
                });
                waiting.postMessage({ type: "SKIP_WAITING" });
                // Safety net: if controllerchange doesn't fire within 2s
                // (some browsers / edge cases), just reload anyway.
                setTimeout(() => { if (!reloaded) location.reload(); }, 2000);
                return;
              }
            }
          }
        } catch (err) {
          // Fall through to simple reload.
        }
        location.reload();
      });
    }

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
        showClosed: showClosedCb.checked,
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

  // Recompute flip score (ROI) from raw fields. This stays in sync with
  // compute_flip_score() in scrape.py — uses the SAME purchase-price model.
  function computeFlipScore(item) {
    const resale = num(item.ai_estimated_resale);
    const cost   = purchasePriceNum(item);
    if (isNaN(resale) || isNaN(cost) || resale <= 0) return NaN;
    const denom = Math.max(cost, 1.0);
    return (resale - cost - HASSLE) / denom;
  }
  function flipScoreOf(item) {
    if (item._fs === undefined) item._fs = computeFlipScore(item);
    return item._fs;
  }

  // Gross profit in dollars: resale - cost - hassle.
  function computeGrossProfit(item) {
    const resale = num(item.ai_estimated_resale);
    const cost   = purchasePriceNum(item);
    if (isNaN(resale) || isNaN(cost) || resale <= 0) return NaN;
    return resale - cost - HASSLE;
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

  // Search haystack: title + AI notes + category. Built lazily and cached.
  function haystackOf(item) {
    if (item._hay === undefined) {
      const parts = [
        item.title,
        item.ai_notes,
        item.category,
        item.description,
      ].filter(Boolean);
      item._hay = parts.join(" \n ").toLowerCase();
    }
    return item._hay;
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
    const showClosed   = showClosedCb.checked;
    const sortBy       = sortSel.value;
    const velocityMode = velocitySel.value;
    const query        = searchQueryNorm;

    filteredItems = allItems.filter((it) => {
      if (!showClosed && isClosed(it)) return false;
      if (!passesVelocityFilter(it, velocityMode)) return false;
      if (query) {
        if (haystackOf(it).indexOf(query) === -1) return false;
      }
      const f = flipScoreOf(it);
      if (isNaN(f)) return minFlip === 0;
      return f >= minFlip;
    });

    filteredItems.sort(COMPARATORS[sortBy] || COMPARATORS.smart);

    resultCount.textContent =
      `${filteredItems.length} of ${allItems.length} item${allItems.length === 1 ? "" : "s"}`;

    // Reset paging and clear the grid
    renderedCount = 0;
    grid.replaceChildren();

    if (filteredItems.length === 0) {
      grid.classList.add("grid--empty");
      const reasons = [];
      if (query) reasons.push("clear the search");
      if (!showClosed) reasons.push('toggle "Show closed"');
      if (minFlip > 0) reasons.push("lower the min flip score");
      if (velocityMode !== "any") reasons.push("change Velocity to Any");
      const hint = reasons.length
        ? `Try ${reasons.join(" or ")} to see more.`
        : "There are no items in the data file.";
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
        `(resale est. − purchase cost − $${HASSLE.toFixed(0)} hassle) ÷ purchase cost. ` +
        `Purchase cost = next bid × ${PURCHASE_PRICE_MULT.toFixed(1)} (fees + tax).`;
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
