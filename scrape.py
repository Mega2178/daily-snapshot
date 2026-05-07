"""
Main entry point.

Run from PyCharm or terminal:
    python scrape.py            # scrape + enrich new items + write CSV
    python scrape.py --scrape   # only scrape (refresh bids), don't call AI
    python scrape.py --enrich   # only enrich items missing AI data
    python scrape.py --no-enrich  # scrape but skip AI step

Output:
    items.csv        - sorted by flip_score, best deals on top
    raw_items.json   - raw scraped data (for debugging / re-enrichment)
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import config
from scraper import Item, Session, crawl_all

SCRIPT_DIR = Path(__file__).parent.resolve()
CSV_PATH = SCRIPT_DIR / "items.csv"
RAW_PATH = SCRIPT_DIR / "raw_items.json"
JSON_PATH = SCRIPT_DIR / "web" / "data" / "items.json"

# When --test is passed, we redirect persistence to separate files so test
# runs can't contaminate the production dataset. _set_test_paths() flips
# CSV_PATH / RAW_PATH / JSON_PATH to their test-mode variants. We mutate the
# module globals (not pass paths around) because save_raw / load_existing /
# write_csv / write_json already read these as module-level constants and
# Python resolves them at call time.
CSV_PATH_TEST = SCRIPT_DIR / "items_test.csv"
RAW_PATH_TEST = SCRIPT_DIR / "raw_items_test.json"
JSON_PATH_TEST = SCRIPT_DIR / "web" / "data" / "items_test.json"


def _set_test_paths() -> None:
    """Swap the module-level paths to their test-mode variants."""
    global CSV_PATH, RAW_PATH, JSON_PATH
    CSV_PATH = CSV_PATH_TEST
    RAW_PATH = RAW_PATH_TEST
    JSON_PATH = JSON_PATH_TEST

CSV_FIELDS = [
    "flip_score",            # ROI: most important — sorted by this
    "gross_profit",          # absolute $ profit
    "current_bid",
    "ai_estimated_resale",
    "ai_retail_estimate",
    "ai_resale_pct",
    "ai_confidence",
    "ai_sales_velocity",     # hot / normal / slow / very_slow / unknown
    "ai_condition",          # new / open_box / damaged_easy_fix / damaged_hard_fix
    "value_overridden",      # "yes" if we forced resale to $0 (damaged_hard_fix)
    "title",
    "location",              # "City, ST" of the auction house
    "ai_notes",
    "category",
    "next_required_bid",
    "time_remaining",
    "closing_time_raw",
    "closing_time_iso",
    "title_retail_claim",
    "description",
    "additional_detail",
    "image_url",
    "item_url",
    "lot_id",
    "auction_id",
    "current_bid_value",
    "scraped_at",
    "enriched_at",
]


# ────────────────────────────── persistence ─────────────────────────────────

def load_existing() -> dict[str, Item]:
    """Load previously-saved items keyed by '<auction_id>:<lot_id>'."""
    if not RAW_PATH.exists():
        return {}
    try:
        with RAW_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        items = {}
        for d in data:
            it = Item(**{k: v for k, v in d.items() if k in Item.__dataclass_fields__})
            items[it.key()] = it
        return items
    except Exception as e:
        print(f"warning: could not load existing data ({e}); starting fresh")
        return {}


def save_raw(items: dict[str, Item]) -> None:
    with RAW_PATH.open("w", encoding="utf-8") as f:
        json.dump([asdict(it) for it in items.values()], f, indent=2)


def _iso_to_cst_12h(iso_str: str) -> str:
    """Convert an ISO UTC timestamp to '2026-05-04 02:50 PM CDT' format.

    CST is UTC-6 in winter, CDT is UTC-5 in summer. Equip-Bid's audience is
    in Central Time, so we convert to whichever DST flavor is active.
    """
    if not iso_str:
        return ""
    try:
        dt_utc = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return iso_str  # leave as-is if unparseable

    # Use zoneinfo to handle CST/CDT switchover automatically. Fall back to
    # naive UTC-5 (CDT) if zoneinfo isn't available.
    try:
        from zoneinfo import ZoneInfo
        dt_local = dt_utc.astimezone(ZoneInfo("America/Chicago"))
        tz_label = dt_local.tzname()  # 'CST' or 'CDT' depending on DST
    except Exception:
        from datetime import timedelta
        dt_local = dt_utc + timedelta(hours=-5)  # rough CDT fallback
        tz_label = "CDT"

    return dt_local.strftime(f"%Y-%m-%d %I:%M %p {tz_label}")


def write_csv(items: dict[str, Item]) -> None:
    """Sort by flip_score desc (unknowns at bottom), write CSV."""
    rows = list(items.values())

    def sort_key(it: Item):
        # items with a numeric flip_score sort first (descending)
        try:
            score = float(it.flip_score)
            return (0, -score)
        except (ValueError, TypeError):
            return (1, 0)  # unknowns at bottom

    rows.sort(key=sort_key)

    with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for it in rows:
            row = asdict(it)
            # Display timestamps in Central Time, 12-hour format
            row["scraped_at"] = _iso_to_cst_12h(row.get("scraped_at", ""))
            row["enriched_at"] = _iso_to_cst_12h(row.get("enriched_at", ""))
            writer.writerow(row)


def write_json(items: dict[str, Item]) -> None:
    """Write items to JSON for the web frontend to consume.

    Format:
        {
          "generated_at": "<ISO UTC timestamp>",
          "items": [ ...same fields and sort order as CSV... ]
        }

    The frontend reads this file (committed daily by the GitHub Actions
    workflow) to render cards. closing_time_iso lets the frontend compute
    "is this lot closed right now" client-side, even when the snapshot
    is hours stale.

    Timestamps are kept in raw ISO UTC here (not the human-readable
    Central-Time format that the CSV uses) because the frontend should
    do its own locale-aware formatting.
    """
    rows = list(items.values())

    # Same sort key as write_csv — keep the two outputs in lockstep.
    def sort_key(it: Item):
        try:
            score = float(it.flip_score)
            return (0, -score)
        except (ValueError, TypeError):
            return (1, 0)

    rows.sort(key=sort_key)

    payload_items = []
    for it in rows:
        row = asdict(it)
        payload_items.append({k: row.get(k, "") for k in CSV_FIELDS})

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": payload_items,
    }

    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    with JSON_PATH.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


# ────────────────────────────── pipeline steps ──────────────────────────────

def do_scrape(existing: dict[str, Item], limit: int | None = None) -> dict[str, Item]:
    """Scrape current site and merge into existing dict.

    Bids on previously-seen items are refreshed; AI fields are preserved.

    If `limit` is not None, stop after processing that many items from the
    crawl (counting both new and refreshed). Used by --test mode to keep
    runs short. The cap is on items *yielded by crawl_all*, not on new
    items only — that way the test mode is predictable whether the cache
    is empty or already populated.
    """
    print("\n=== SCRAPE ===")
    if limit is not None:
        print(f"  (test mode: capped at {limit} items)")
    session = Session(delay=config.SCRAPE_DELAY_SECONDS)
    new_count = 0
    refresh_count = 0
    processed = 0

    for fresh in crawl_all(session):
        key = fresh.key()
        if not key or key == ":":
            continue  # malformed

        if key in existing:
            old = existing[key]
            # refresh dynamic fields
            old.current_bid = fresh.current_bid
            old.current_bid_value = fresh.current_bid_value
            old.next_required_bid = fresh.next_required_bid
            old.time_remaining = fresh.time_remaining
            old.closing_time_raw = fresh.closing_time_raw
            old.scraped_at = fresh.scraped_at
            # Backfill location for items cached before we started scraping it.
            # Don't overwrite if we already have one — keeps things stable
            # if a single re-scrape misses the auction-house header for any reason.
            if fresh.location and not old.location:
                old.location = fresh.location
            refresh_count += 1
        else:
            existing[key] = fresh
            new_count += 1

        processed += 1
        if processed % 100 == 0:
            # Cheap insurance for long production scrapes (2hr+): if the
            # process dies mid-run, we won't lose everything we'd already
            # collected. Test mode caps at 50 items so this never fires
            # under --test, which is fine.
            save_raw(existing)
            print(f"  …checkpoint at {processed} items processed")
        if limit is not None and processed >= limit:
            print(f"  reached test-mode cap ({limit}); stopping crawl early")
            break

    print(f"\n→ {new_count} new items, {refresh_count} refreshed, "
          f"{len(existing)} total in dataset")
    return existing


def _is_closed(it: Item) -> bool:
    """True if this item's auction has already ended.

    Uses closing_time_iso (parsed UTC) when present. If the timestamp can't
    be parsed, we play it safe and return False — better to spend a Gemini
    call on a possibly-still-open item than skip a real one.
    """
    if not it.closing_time_iso:
        return False
    try:
        close = datetime.fromisoformat(it.closing_time_iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    return close <= datetime.now(timezone.utc)


def do_enrich(items: dict[str, Item], limit: int | None = None) -> dict[str, Item]:
    """Call Gemini in batches for items that don't yet have an AI estimate.

    Skips items whose auction has already closed — there's no point spending
    quota on lots we can't bid on anymore.

    If `limit` is not None, only enrich up to that many of the pending items
    (used by --test mode to cap quota burn). The cap applies to the pending
    list, so an --enrich --test run against an empty test cache is a no-op.
    """
    from enricher import Enricher, chunked, QuotaExhausted  # lazy import

    pending: list[Item] = [
        it for it in items.values()
        if not it.ai_confidence  # never enriched before
        and not _is_closed(it)   # auction still open
    ]
    skipped_closed = sum(
        1 for it in items.values()
        if not it.ai_confidence and _is_closed(it)
    )
    print(f"\n=== ENRICH ===")
    if skipped_closed:
        print(f"  skipping {skipped_closed} unenriched items whose auctions have already closed")
    if limit is not None and len(pending) > limit:
        print(f"  (test mode: capping enrichment at {limit} of {len(pending)} pending)")
        pending = pending[:limit]
    print(f"{len(pending)} items need AI enrichment")
    if not pending:
        return items

    enricher = Enricher()
    batches = list(chunked(pending, config.BATCH_SIZE))
    print(f"sending {len(batches)} batches of up to {config.BATCH_SIZE} items "
          f"to {config.GEMINI_MODEL}")
    print(f"(pacing: {config.GEMINI_DELAY_SECONDS}s between calls)\n")

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    quota_hit = False

    for i, batch in enumerate(batches, 1):
        print(f"batch {i}/{len(batches)} ({len(batch)} items)...", flush=True)
        payload = [
            {
                "item_id": it.key(),
                "title": it.title,
                "category": it.category,
                "description": it.description,
                "additional_detail": it.additional_detail,
                "current_bid_value": it.current_bid_value,
            }
            for it in batch
        ]

        try:
            valuations = enricher.enrich_batch(payload)
        except QuotaExhausted as e:
            print(f"\n⛔ {e}")
            quota_hit = True
            break

        if not valuations:
            print(f"  no valuations returned, skipping batch")
            save_raw(items)  # checkpoint anyway
            continue

        # match valuations back to items by item_id
        by_id = {v.item_id: v for v in valuations}
        for it in batch:
            v = by_id.get(it.key())
            if not v:
                continue
            it.ai_retail_estimate = f"{v.current_retail_usd:.2f}"
            it.ai_resale_pct = f"{v.resale_pct:.2f}"
            estimated_resale = v.current_retail_usd * v.resale_pct
            it.ai_confidence = v.confidence
            it.ai_condition = v.condition
            it.ai_sales_velocity = v.sales_velocity

            # ── Deterministic override for unsellable items ──
            # Force resale to $0 ONLY when the model says "damaged_hard_fix"
            # — that tier covers both "broken and impossible to fix
            # affordably" and "fundamentally unsellable" (used hygiene,
            # expired food, etc). Items with cheap-and-easy fixes
            # (damaged_easy_fix) are NOT zeroed out — they get a small
            # haircut at scoring time instead, which preserves the
            # missing-power-cable projector case.
            if v.condition == "damaged_hard_fix":
                estimated_resale = 0.0
                it.value_overridden = "yes"
            else:
                it.value_overridden = ""

            it.ai_estimated_resale = f"{estimated_resale:.2f}"
            it.ai_notes = f"[{v.product_identified}] {v.notes}".strip()
            it.enriched_at = now_iso
            # compute flip_score (ROI) and gross_profit ($)
            it.flip_score = compute_flip_score(it)
            it.gross_profit = compute_gross_profit(it)

        # checkpoint after each batch
        save_raw(items)
        print(f"  ✓ batch {i} done, {len(valuations)} valuations")

    if quota_hit:
        remaining = sum(1 for it in items.values() if not it.ai_confidence)
        print(f"\n{remaining} items still need enrichment.")
        print(f"Re-run after midnight Pacific (or with --enrich) to continue.")

    return items


def _purchase_price(it: Item) -> float | None:
    """The realistic out-of-pocket cost to acquire this item.

    next_required_bid * PURCHASE_PRICE_MULTIPLIER, where the multiplier
    accounts for buyer's premium, sales tax, and assorted fees on top of
    the winning bid. Returns None if we can't parse a bid.
    """
    next_bid_str = (it.next_required_bid or "").replace("$", "").replace(",", "").strip()
    try:
        bid = float(next_bid_str)
    except ValueError:
        try:
            bid = float(it.current_bid_value or 0) + 1.0
        except (ValueError, TypeError):
            return None
    if bid <= 0:
        return None
    return bid * config.PURCHASE_PRICE_MULTIPLIER


def _condition_resale_factor(it: Item) -> float:
    """Multiplier applied to estimated_resale based on AI-assessed condition.

    Replaces the old "fold repair cost into total cost" approach. The
    condition field is a tier label (new / open_box / damaged_easy_fix /
    damaged_hard_fix), not a dollar amount, so we scale resale instead of
    adding to cost:

      • new              → 1.00  (no haircut)
      • open_box         → 1.00  (no haircut — this is the default)
      • damaged_easy_fix → 0.85  (small haircut: dad can fix it cheap, but
                                   buyer will still discount slightly)
      • damaged_hard_fix → 0.00  (already zeroed at enrichment time via
                                   value_overridden, but we belt-and-
                                   suspenders here for legacy items)
      • anything else / empty → 1.00 (default — never penalize for missing
                                       data; matches "don't guess if
                                       confidence is low")

    Low-confidence enrichments naturally land on "open_box" (the prompt
    tells the model to default there when it can't tell), so this factor
    only ever moves the score for items the model felt good about.
    """
    cond = (it.ai_condition or "").strip().lower()
    if cond == "damaged_hard_fix":
        return 0.0
    if cond == "damaged_easy_fix":
        return 0.85
    # new, open_box, empty/unknown all keep full resale
    return 1.0


def compute_flip_score(it: Item) -> str:
    """flip_score (ROI) =
        (effective_resale - purchase_price - hassle) / purchase_price

    purchase_price = next_required_bid * PURCHASE_PRICE_MULTIPLIER, which models
    buyer's premium + tax + fees. The bid alone underestimates real cost by
    roughly 30%.

    effective_resale = estimated_resale * condition_resale_factor. The
    factor is 1.0 for new / open_box (default), 0.85 for damaged_easy_fix
    (small handyman-fix haircut), and 0.0 for damaged_hard_fix (already
    zeroed at enrichment, this is just defense-in-depth).

    Returns a string. Empty if unknown / can't compute.
    """
    try:
        if it.ai_confidence in ("", "unknown"):
            return ""
        estimated_resale = float(it.ai_estimated_resale or 0)
        if estimated_resale <= 0:
            return ""
        purchase_price = _purchase_price(it)
        if purchase_price is None:
            return ""
        effective_resale = estimated_resale * _condition_resale_factor(it)
        cost_floor = max(purchase_price, 1.0)
        score = (effective_resale - purchase_price - config.PICKUP_HASSLE_DOLLARS) / cost_floor
        return f"{score:.2f}"
    except (ValueError, TypeError):
        return ""


def compute_gross_profit(it: Item) -> str:
    """Absolute dollar profit:
        effective_resale - purchase_price - hassle.

    Same numerator as flip_score; differs only in normalization.

    Returns a string. Empty if unknown / can't compute.
    """
    try:
        if it.ai_confidence in ("", "unknown"):
            return ""
        estimated_resale = float(it.ai_estimated_resale or 0)
        if estimated_resale <= 0:
            return ""
        purchase_price = _purchase_price(it)
        if purchase_price is None:
            return ""
        effective_resale = estimated_resale * _condition_resale_factor(it)
        profit = (effective_resale
                  - purchase_price
                  - config.PICKUP_HASSLE_DOLLARS)
        return f"{profit:.2f}"
    except (ValueError, TypeError):
        return ""


def recompute_all_flip_scores(items: dict[str, Item]) -> None:
    """Recompute flip_score AND gross_profit for every item — useful when
    bids changed but AI data didn't.
    """
    for it in items.values():
        if it.ai_confidence and it.ai_confidence != "unknown":
            it.flip_score = compute_flip_score(it)
            it.gross_profit = compute_gross_profit(it)


# ────────────────────────────── main ────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scrape", action="store_true",
                        help="only scrape, don't call AI")
    parser.add_argument("--enrich", action="store_true",
                        help="only enrich items already in the dataset")
    parser.add_argument("--no-enrich", action="store_true",
                        help="scrape but skip AI step")
    parser.add_argument("--test", action="store_true",
                        help=f"test mode: cap work at {config.TEST_MODE_ITEM_LIMIT} "
                             f"items, write to items_test.csv / raw_items_test.json")
    args = parser.parse_args()

    only_scrape = args.scrape or args.no_enrich
    only_enrich = args.enrich
    test_mode = args.test
    limit = config.TEST_MODE_ITEM_LIMIT if test_mode else None

    if test_mode:
        _set_test_paths()
        print("=" * 60)
        print(f"  TEST MODE — capped at {limit} items")
        print(f"  reading/writing {RAW_PATH.name} + {CSV_PATH.name}")
        print(f"  (production data in raw_items.json / items.csv is untouched)")
        print("=" * 60)

    items = load_existing()
    print(f"loaded {len(items)} existing items from {RAW_PATH.name}")

    if not only_enrich:
        items = do_scrape(items, limit=limit)
        save_raw(items)

    if not only_scrape:
        items = do_enrich(items, limit=limit)
        save_raw(items)

    # always recompute flip scores at end (bids may have refreshed)
    recompute_all_flip_scores(items)
    save_raw(items)
    write_csv(items)
    write_json(items)

    # summary
    enriched = sum(1 for it in items.values() if it.ai_confidence)
    high_conf = sum(1 for it in items.values() if it.ai_confidence == "high")
    print(f"\n=== DONE ===")
    if test_mode:
        print(f"** TEST MODE — results are not your production CSV **")
    print(f"total items:    {len(items)}")
    print(f"enriched:       {enriched}")
    print(f"high-conf:      {high_conf}")
    print(f"\nwrote {CSV_PATH}")
    print(f"wrote {JSON_PATH}")
    print(f"open it in Excel/PyCharm — top rows are best flips")


if __name__ == "__main__":
    main()
