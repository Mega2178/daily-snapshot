// Daily Snapshot — vanilla JS, no framework, no build step.
// Reads data/items.json, renders cards with sort/filter controls.
// In-memory state only (no localStorage / cookies).

(function () {
  "use strict";

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

  // ---- State ------------------------------------------------------
  let allItems    = [];          // items as parsed from JSON
  let generatedAt = null;        // Date or null
  let nowMs       = Date.now();  // captured once at load; refreshed on tick

  // ---- Boot -------------------------------------------------------
  loadData();
  bindControls();

  // re-tick "now" every minute so closed-state and freshness update
  // without a reload (cheap; nothing else changes)
  setInterval(() => {
    nowMs = Date.now();
    renderFreshness();
    render();
  }, 60_000);

  // ---- Data loading ----------------------------------------------
  async function loadData() {
    try {
      const res = await fetch("data/items.json", { cache: "no-store" });
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
  // flip_score / ai_retail_estimate / ai_resale_pct / ai_estimated_resale
  // are stringified numbers in the JSON. Empty string = unknown.
  function num(s) {
    if (s === "" || s === null || s === undefined) return NaN;
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }
  function bidNum(item) {
    if (typeof item.current_bid_value === "number") return item.current_bid_value;
    return num((item.current_bid || "").replace(/[^0-9.]/g, ""));
  }
  function closingMs(item) {
    if (!item.closing_time_iso) return NaN;
    const t = Date.parse(item.closing_time_iso);
    return isNaN(t) ? NaN : t;
  }
  function isClosed(item) {
    const t = closingMs(item);
    if (isNaN(t)) return false;     // unknown closing time → don't hide
    return t < nowMs;
  }

  // ---- Sort comparators ------------------------------------------
  // Mirror the Python sort_key: numeric values first (in their natural
  // direction), unknowns sink to the bottom.
  const COMPARATORS = {
    flip_score: (a, b) => {
      const av = num(a.flip_score), bv = num(b.flip_score);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return bv - av; // desc
    },
    current_bid: (a, b) => {
      const av = bidNum(a), bv = bidNum(b);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return av - bv; // asc — cheapest first
    },
    closing_time: (a, b) => {
      const av = closingMs(a), bv = closingMs(b);
      const ag = isNaN(av) ? 1 : 0,  bg = isNaN(bv) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      if (ag === 1) return 0;
      return av - bv; // asc — soonest first
    },
    title: (a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }),
  };

  // ---- Render -----------------------------------------------------
  function render() {
    const minFlip   = parseFloat(minFlipInput.value);
    const showClosed = showClosedCb.checked;
    const sortBy    = sortSel.value;

    // Filter
    let items = allItems.filter((it) => {
      if (!showClosed && isClosed(it)) return false;
      const f = num(it.flip_score);
      // unknown flip_score: keep only when slider is at 0
      if (isNaN(f)) return minFlip === 0;
      return f >= minFlip;
    });

    // Sort
    items = items.slice().sort(COMPARATORS[sortBy] || COMPARATORS.flip_score);

    // Counter
    resultCount.textContent =
      `${items.length} of ${allItems.length} item${allItems.length === 1 ? "" : "s"}`;

    // Empty state
    if (items.length === 0) {
      grid.classList.add("grid--empty");
      const reasons = [];
      if (!showClosed) reasons.push('toggle "Show closed"');
      if (minFlip > 0) reasons.push("lower the min flip score");
      const hint = reasons.length
        ? `Try ${reasons.join(" or ")} to see more.`
        : "There are no items in the data file.";
      grid.innerHTML = `<p>No items match the current filters.<br><small>${hint}</small></p>`;
      return;
    }

    // Render cards (rebuild — 50–10k cards is fine for browser DOM)
    grid.classList.remove("grid--empty");
    const frag = document.createDocumentFragment();
    for (const it of items) {
      frag.appendChild(buildCard(it));
    }
    grid.replaceChildren(frag);
  }

  // ---- Card builder ----------------------------------------------
  function buildCard(item) {
    const node = cardTpl.content.firstElementChild.cloneNode(true);

    // Image — hot-link to rackcdn URL, swap to placeholder on error.
    const img = node.querySelector("img");
    if (item.image_url) {
      img.src = item.image_url;
      img.alt = item.title || "auction item";
      img.addEventListener("error", () => img.classList.add("broken"), { once: true });
    } else {
      img.classList.add("broken");
      img.alt = "";
    }

    // Flip score badge
    const scoreEl = node.querySelector('[data-role="flip-score"]');
    const f = num(item.flip_score);
    if (isNaN(f)) {
      scoreEl.textContent = "—";
      scoreEl.classList.add("empty");
      scoreEl.title = "No flip score (AI confidence: unknown)";
    } else {
      scoreEl.textContent = f.toFixed(2) + "×";
      scoreEl.title = `Flip score: ${f.toFixed(2)} (resale est. - bid - $5 hassle, divided by bid)`;
    }

    // Confidence badge
    const confEl = node.querySelector('[data-role="confidence"]');
    if (item.ai_confidence && item.ai_confidence !== "unknown") {
      confEl.textContent = item.ai_confidence;
    }

    // Title
    node.querySelector('[data-role="title"]').textContent = item.title || "(untitled)";

    // Stats
    node.querySelector('[data-role="bid"]').textContent  = item.current_bid || "—";
    const resale = num(item.ai_estimated_resale);
    node.querySelector('[data-role="resale"]').textContent =
      isNaN(resale) ? "—" : "$" + resale.toFixed(2);
    const retail = num(item.ai_retail_estimate);
    node.querySelector('[data-role="retail"]').textContent =
      isNaN(retail) ? "—" : "$" + retail.toFixed(2);

    // Footer: closing time + category
    const closingEl  = node.querySelector('[data-role="closing"]');
    const categoryEl = node.querySelector('[data-role="category"]');
    closingEl.textContent = formatClosing(item);
    if (isClosed(item)) closingEl.classList.add("closed");
    categoryEl.textContent = shortCategory(item.category);

    // Click anywhere on the card → open item in new tab.
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
    const t = closingMs(item);
    if (isNaN(t)) {
      return item.time_remaining || item.closing_time_raw || "no closing time";
    }
    const diffMs = t - nowMs;
    if (diffMs <= 0) return "Closed";

    const minutes = Math.round(diffMs / 60_000);
    if (minutes < 60)  return `Closes in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24)    return `Closes in ${hours}h`;
    const days = Math.round(hours / 24);
    return `Closes in ${days}d`;
  }

  // "Retail Goods > Toy" → "Toy"
  function shortCategory(cat) {
    if (!cat) return "";
    const parts = cat.split(">").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "";
  }
})();
