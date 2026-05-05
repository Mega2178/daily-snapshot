// Daily Snapshot — vanilla JS, no framework, no build step.
// Reads data/items.json, renders cards with sort/filter controls.
// Pagination: only render PAGE_SIZE cards at a time so 6k items don't choke
// the browser. Service Worker (sw.js) caches the static files + items.json
// so repeat visits are instant; a fresh copy is fetched in the background.

(function () {
  "use strict";

  const PAGE_SIZE = 60; // cards rendered per "page"

  // ---- DOM refs ---------------------------------------------------
  const grid          = document.getElementById("grid");
  const sortSel       = document.getElementById("sort");
  const minFlipInput  = document.getElementById("min-flip");
  const minFlipValue  = document.getElementById("min-flip-value");
  const showClosedCb  = document.getElementById("show-closed");
  const freshnessEl   = document.getElementById("freshness");
  const freshnessText = document.getElementById("freshness-text");
  const resultCount   = document.getElementById("result-count");
  const cardTpl       = document.getElementById("card-template");
  const loadMoreWrap  = document.getElementById("load-more-wrap");
  const loadMoreBtn   = document.getElementById("load-more");
  const loadMoreInfo  = document.getElementById("load-more-info");

  // ---- State ------------------------------------------------------
  let allItems      = [];
  let filteredItems = [];   // current filtered+sorted view
  let renderedCount = 0;    // how many of filteredItems are drawn
  let generatedAt   = null;
  let nowMs         = Date.now();

  // ---- Boot -------------------------------------------------------
  registerServiceWorker();
  loadData();
  bindControls();

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
      // a cached copy. The SW uses stale-while-revalidate, so a cached items.json
      // shows up immediately and a fresh copy is fetched in the background.
      const res = await fetch("data/items.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      allItems    = Array.isArray(data.items) ? data.items : [];
      generatedAt = data.generated_at ? new Date(data.generated_at) : null;
      grid.removeAttribute("aria-busy");
      renderFreshness();
      render();
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
    sortSel.addEventListener("change", render);
    showClosedCb.addEventListener("change", render);
    minFlipInput.addEventListener("input", () => {
      minFlipValue.textContent = parseFloat(minFlipInput.value).toFixed(1);
      render();
    });
    minFlipValue.textContent = parseFloat(minFlipInput.value).toFixed(1);
    loadMoreBtn.addEventListener("click", renderMore);
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

  // ---- Helpers ----------------------------------------------------
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
  // The price you'd actually pay if you placed the next valid bid right now.
  function nextBidNum(item) {
    const n = dollarsToNum(item.next_required_bid);
    if (!isNaN(n)) return n;
    // Fallback: if next_required_bid is missing, use current_bid + $1.
    const cb = bidNum(item);
    return isNaN(cb) ? NaN : cb + 1;
  }

  // Recompute flip score using next_required_bid (what you'd actually pay).
  // Mirrors compute_flip_score() in scrape.py but with the corrected anchor.
  // resale - bid - $5 hassle, divided by max(bid, $1) so a $0 bid doesn't NaN.
  const HASSLE = 5.0;
  function computeFlipScore(item) {
    const resale = num(item.ai_estimated_resale);
    const bid    = nextBidNum(item);
    if (isNaN(resale) || isNaN(bid)) return NaN;
    const denom = Math.max(bid, 1.0);
    return (resale - bid - HASSLE) / denom;
  }
  function flipScoreOf(item) {
    // Cache the score on the item so we don't recompute it every sort/filter.
    if (item._fs === undefined) item._fs = computeFlipScore(item);
    return item._fs;
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

  // ---- Sort comparators ------------------------------------------
  const COMPARATORS = {
    flip_score: (a, b) => {
      const av = flipScoreOf(a), bv = flipScoreOf(b);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return bv - av;
    },
    current_bid: (a, b) => {
      const av = nextBidNum(a), bv = nextBidNum(b);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return av - bv;
    },
    closing_time: (a, b) => {
      const av = closingMs(a), bv = closingMs(b);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return av - bv;
    },
    title: (a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }),
  };

  // ---- Render -----------------------------------------------------
  function render() {
    const minFlip    = parseFloat(minFlipInput.value);
    const showClosed = showClosedCb.checked;
    const sortBy     = sortSel.value;

    filteredItems = allItems.filter((it) => {
      if (!showClosed && isClosed(it)) return false;
      const f = flipScoreOf(it);
      if (isNaN(f)) return minFlip === 0;
      return f >= minFlip;
    });

    filteredItems.sort(COMPARATORS[sortBy] || COMPARATORS.flip_score);

    resultCount.textContent =
      `${filteredItems.length} of ${allItems.length} item${allItems.length === 1 ? "" : "s"}`;

    // Reset paging and clear the grid
    renderedCount = 0;
    grid.replaceChildren();

    if (filteredItems.length === 0) {
      grid.classList.add("grid--empty");
      const reasons = [];
      if (!showClosed) reasons.push('toggle "Show closed"');
      if (minFlip > 0) reasons.push("lower the min flip score");
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

    // Flip score badge — recomputed from next_required_bid
    const scoreEl = node.querySelector('[data-role="flip-score"]');
    const f = flipScoreOf(item);
    if (isNaN(f)) {
      scoreEl.textContent = "—";
      scoreEl.classList.add("empty");
      scoreEl.title = "No flip score (AI confidence: unknown)";
    } else {
      scoreEl.textContent = f.toFixed(2) + "×";
      scoreEl.title =
        `Flip score: ${f.toFixed(2)} — ` +
        `(resale est. − next required bid − $${HASSLE.toFixed(0)} hassle) ÷ next required bid`;
    }

    // Confidence badge
    const confEl = node.querySelector('[data-role="confidence"]');
    if (item.ai_confidence && item.ai_confidence !== "unknown") {
      confEl.textContent = item.ai_confidence;
    }

    // Title
    node.querySelector('[data-role="title"]').textContent = item.title || "(untitled)";

    // Stats: current bid, NEXT required bid (new), resale, retail
    node.querySelector('[data-role="bid"]').textContent = item.current_bid || "—";
    const nextEl = node.querySelector('[data-role="next-bid"]');
    if (nextEl) {
      const nb = nextBidNum(item);
      nextEl.textContent = isNaN(nb) ? "—" : "$" + nb.toFixed(2);
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
        window.open(item.item_url, "_blank", "noopener");
      });
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
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
