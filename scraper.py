"""
Scraper for Equip-Bid auction lists. No browser needed — just requests + bs4.

Public functions:
    fetch_auction_list_url(closing_date, zip, radius, affiliate) -> URL
    crawl_all(session) -> generator of Item dicts
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta, timezone
from typing import Iterator
from urllib.parse import urljoin, urlencode, urlparse

import requests
from bs4 import BeautifulSoup, Tag

import config

try:
    from zoneinfo import ZoneInfo
    _CENTRAL_TZ = ZoneInfo("America/Chicago")
except Exception:
    _CENTRAL_TZ = None  # graceful fallback for ancient Pythons

BASE_URL = "https://www.equip-bid.com"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


# ────────────────────────────── data class ──────────────────────────────────

@dataclass
class Item:
    lot_id: str = ""
    auction_id: str = ""
    title: str = ""
    current_bid: str = ""
    current_bid_value: float = 0.0  # parsed numeric
    next_required_bid: str = ""
    image_url: str = ""
    item_url: str = ""
    closing_time_raw: str = ""
    closing_time_iso: str = ""  # ISO UTC, parsed from closing_time_raw; empty on parse failure
    time_remaining: str = ""
    category: str = ""
    description: str = ""
    additional_detail: str = ""
    title_retail_claim: str = ""  # the "Retail: $X" the seller put in the title
    location: str = ""  # "City, ST" — pulled from the auction-list page panel
    # AI enrichment fields (filled later)
    ai_retail_estimate: str = ""
    ai_resale_pct: str = ""
    ai_estimated_resale: str = ""
    ai_confidence: str = ""
    ai_condition_severity: str = ""  # pristine/good/flawed/broken_or_unsellable
    ai_repairability: str = ""        # easy_cheap_fix/hard_expensive_fix/not_applicable
    ai_repair_cost_usd: str = ""      # model's $ estimate to make item sellable (aftermarket/used parts OK)
    ai_sales_velocity: str = ""       # hot/normal/slow/very_slow/unknown
    value_overridden: str = ""        # "yes" if we forced resale to $0
    ai_notes: str = ""
    flip_score: str = ""  # (estimated_resale - purchase_price - hassle) / purchase_price
    gross_profit: str = ""  # estimated_resale - purchase_price - hassle (in dollars)
    scraped_at: str = ""
    enriched_at: str = ""

    def key(self) -> str:
        return f"{self.auction_id}:{self.lot_id}"


# ────────────────────────────── HTTP session ────────────────────────────────

class Session:
    """Polite HTTP session with throttling + retries."""

    def __init__(self, delay: float = 1.0):
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.delay = delay
        self.last_request = 0.0

    def get(self, url: str, retries: int = 3) -> str:
        elapsed = time.time() - self.last_request
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)

        last_err: Exception | None = None
        for attempt in range(retries):
            try:
                r = self.session.get(url, timeout=30)
                self.last_request = time.time()
                if r.status_code == 200:
                    return r.text
                if r.status_code in (429, 503):
                    wait = (attempt + 1) * 5
                    print(f"  [{r.status_code}] backing off {wait}s...")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
            except requests.RequestException as e:
                last_err = e
                wait = (attempt + 1) * 3
                print(f"  request error ({e}); retry in {wait}s")
                time.sleep(wait)

        raise RuntimeError(f"GET {url} failed after {retries} retries: {last_err}")


# ────────────────────────────── URL building ────────────────────────────────

def build_auction_list_url() -> str:
    """Build the auction-list URL from config."""
    params = {
        "sort_field": "end",
        "affiliate": config.AFFILIATE,
        "distance_radius": config.DISTANCE_RADIUS,
        "distance_zip": config.DISTANCE_ZIP,
    }
    if config.CLOSING_DATE:
        params["closing"] = config.CLOSING_DATE
        # the site also wants closing_mask for the visible date input
        try:
            d = datetime.strptime(config.CLOSING_DATE, "%Y-%m-%d")
            params["closing_mask"] = d.strftime("%m/%d/%Y")
        except ValueError:
            pass
    return f"{BASE_URL}/auction/list?{urlencode(params)}"


# ────────────────────────────── parsing ─────────────────────────────────────

_CLOSING_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})\s*(am|pm)", re.IGNORECASE)
_CLOSING_DATE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")
_WEEKDAY_NAMES = ("monday", "tuesday", "wednesday", "thursday",
                  "friday", "saturday", "sunday")


def _parse_closing_time(raw: str) -> str:
    """Convert Equip-Bid's closing-time string to ISO UTC.

    Equip-Bid is a Kansas City auction site; every closing time is Central.
    We interpret the wall clock in America/Chicago (which handles CST/CDT
    automatically) and convert to UTC. The trailing 'CDT' / 'CST' label in
    the source string is ignored — `zoneinfo` knows which is in effect on
    the target date better than the site's own label does.

    Handles every shape we've seen in the wild:
        'Today 04:01 pm CDT'
        'Tomorrow 04:01 pm CDT'
        'Tuesday Today 04:01 pm CDT'           (day-name prefix)
        'Begins Closing 11/15/2026 04:01 pm CDT'
        'Begins Closing 12/15/2026 04:01 pm CST'

    Returns the ISO UTC string on success, '' on ANY failure. Never raises.
    """
    if not raw or not isinstance(raw, str):
        return ""
    try:
        text = raw.strip()
        time_m = _CLOSING_TIME_RE.search(text)
        if not time_m:
            return ""
        hour = int(time_m.group(1))
        minute = int(time_m.group(2))
        ampm = time_m.group(3).lower()
        if ampm == "pm" and hour != 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return ""

        # Pick the target date.
        if _CENTRAL_TZ is not None:
            now_ct = datetime.now(_CENTRAL_TZ)
        else:
            now_ct = datetime.now(timezone(timedelta(hours=-5)))  # rough CDT fallback
        lowered = text.lower()
        date_m = _CLOSING_DATE_RE.search(text)

        if date_m:
            mm, dd, yyyy = (int(g) for g in date_m.groups())
        elif "tomorrow" in lowered:
            tmw = now_ct + timedelta(days=1)
            mm, dd, yyyy = tmw.month, tmw.day, tmw.year
        elif "today" in lowered:
            mm, dd, yyyy = now_ct.month, now_ct.day, now_ct.year
        else:
            # Standalone day-name (no today/tomorrow, no explicit date):
            # resolve to the next occurrence of that weekday.
            picked = None
            for i, name in enumerate(_WEEKDAY_NAMES):
                if name in lowered:
                    picked = i
                    break
            if picked is None:
                return ""
            delta = (picked - now_ct.weekday()) % 7
            tgt = now_ct + timedelta(days=delta)
            mm, dd, yyyy = tgt.month, tgt.day, tgt.year

        if _CENTRAL_TZ is not None:
            local_dt = datetime(yyyy, mm, dd, hour, minute, tzinfo=_CENTRAL_TZ)
        else:
            local_dt = datetime(yyyy, mm, dd, hour, minute,
                                tzinfo=timezone(timedelta(hours=-5)))
        return local_dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return ""


RETAIL_IN_TITLE_RE = re.compile(r"Retail\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d+)?)", re.IGNORECASE)
LOT_FROM_URL_RE = re.compile(r"/auction/(\d+)/item/(\d+)")
AUCTION_ID_RE = re.compile(r"/auction/(\d+)(?:[/?]|$)")
PRICE_RE = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")


def _to_float(price_text: str) -> float:
    m = PRICE_RE.search(price_text or "")
    if not m:
        return 0.0
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return 0.0


def parse_auction_houses(html: str) -> list[str]:
    """From the auction-list page, return absolute URLs of each auction house."""
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    seen: set[str] = set()
    # The original webscraper config used `.auction-title a` (an anchor inside
    # an element with class auction-title). On some pages the anchor itself
    # carries the class. Match both, plus h2/h3 wrappers.
    selectors = [
        ".auction-title a",
        "a.auction-title",
        "h2.auction-title a",
        "h3.auction-title a",
    ]
    for sel in selectors:
        for a in soup.select(sel):
            href = a.get("href", "")
            if not href:
                continue
            full = urljoin(BASE_URL, href)
            path = urlparse(full).path
            if AUCTION_ID_RE.search(path) and "/item/" not in path:
                if full not in seen:
                    seen.add(full)
                    urls.append(full)
    return urls


def parse_max_page(html: str) -> int:
    """Find the highest page number in the pagination block."""
    soup = BeautifulSoup(html, "html.parser")
    max_page = 1
    for a in soup.select("a[href*='page=']"):
        href = a.get("href", "")
        m = re.search(r"[?&]page=(\d+)", href)
        if m:
            max_page = max(max_page, int(m.group(1)))
    return max_page


ITEM_TITLE_ID_RE = re.compile(r"itemTitle(\d+)")


def _row_ancestor(tag: Tag) -> Tag | None:
    """Walk up to the nearest ancestor `<div class="row">` containing this tag.

    Item titles on Equip-Bid live inside `<div class="col-xs-10">` inside a
    `<div class="row">`. We need that row as the anchor for our segment walk.
    """
    cur = tag
    for _ in range(6):
        cur = cur.parent
        if cur is None:
            return None
        if cur.name == "div":
            classes = cur.get("class") or []
            if "row" in classes:
                return cur
    return None


def _is_divider(tag) -> bool:
    """Return True if a tag marks the boundary between item cards.

    Equip-Bid uses two divider patterns between items:
      * `<div class="lot-divider ...">`  (mobile)
      * `<div style="border-top: 1px solid #e2e2e2; ...">` (desktop)
    """
    if not isinstance(tag, Tag) or tag.name != "div":
        return False
    classes = tag.get("class") or []
    if any("lot-divider" in c for c in classes):
        return True
    style = tag.get("style") or ""
    if "border-top" in style and "#e2e2e2" in style:
        return True
    return False


def _collect_item_segment(title_tag: Tag) -> list[Tag]:
    """Collect every sibling row that belongs to this item.

    Starts at the row containing the title h4 and walks forward through
    next-siblings, gathering rows until we hit either a divider, the next
    item title, or the end of siblings.

    Returns a list of Tags. The selectors used downstream (`select_one`)
    only run on Tag instances, so we wrap the list in a small helper that
    BeautifulSoup-style `select` can run against.
    """
    start_row = _row_ancestor(title_tag)
    if start_row is None:
        # Fall back: just return the immediate parent's siblings of title_tag
        return [title_tag]

    segment: list[Tag] = [start_row]
    cur = start_row.next_sibling
    while cur is not None:
        if isinstance(cur, Tag):
            # Stop at dividers
            if _is_divider(cur):
                break
            # Stop if we encountered the next item's title row
            if cur.find("h4", id=ITEM_TITLE_ID_RE):
                break
            segment.append(cur)
        cur = cur.next_sibling
    return segment


class _Segment:
    """Lightweight wrapper that mimics the slice of CSS-selector methods
    used by parse_items_on_page. We don't need a full Tag — just the
    ability to run select_one / select / find / get_text across a list
    of sibling Tags as if they were one combined node.
    """
    __slots__ = ("tags",)

    def __init__(self, tags: list[Tag]):
        self.tags = tags

    def select_one(self, css: str):
        for t in self.tags:
            hit = t.select_one(css)
            if hit is not None:
                return hit
        return None

    def select(self, css: str) -> list[Tag]:
        out: list[Tag] = []
        for t in self.tags:
            out.extend(t.select(css))
        return out

    def find(self, *args, **kwargs):
        for t in self.tags:
            hit = t.find(*args, **kwargs)
            if hit is not None:
                return hit
        return None

    def get_text(self, sep: str = "", strip: bool = False) -> str:
        return sep.join(t.get_text(sep, strip=strip) for t in self.tags)


def parse_items_on_page(html: str) -> list[Item]:
    """Extract every lot card from a single auction-house page."""
    soup = BeautifulSoup(html, "html.parser")
    items: list[Item] = []
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for title_tag in soup.select("h4[id^='itemTitle']"):
        item = Item(scraped_at=now_iso)

        # Title + URL
        a = title_tag.find("a")
        if a:
            item.title = a.get_text(" ", strip=True)
            href = a.get("href", "")
            item.item_url = urljoin(BASE_URL, href)
            m = LOT_FROM_URL_RE.search(href)
            if m:
                item.auction_id = m.group(1)
                item.lot_id = m.group(2)

        # Retail claim from title
        rm = RETAIL_IN_TITLE_RE.search(item.title)
        if rm:
            item.title_retail_claim = rm.group(1).replace(",", "")

        # Item cards on Equip-Bid are NOT a single nested container — the
        # title row, image/bid/timer row, and description row are flat
        # siblings under the listing wrapper, separated by dividers. So we
        # collect the slice of sibling rows that belongs to THIS title and
        # scope all subsequent selectors to that slice.
        card = _Segment(_collect_item_segment(title_tag))

        # Image
        img = card.select_one("img.auction-img, img[src*='cf2.rackcdn']")
        if img:
            item.image_url = img.get("src") or img.get("data-src") or ""

        # Current bid
        cb = card.select_one("span.lot-current-bid")
        if cb:
            item.current_bid = cb.get_text(" ", strip=True)
            item.current_bid_value = _to_float(item.current_bid)

        # Next required bid
        nrb = card.select_one("span[id^='lot_next_required_bid']")
        if nrb:
            item.next_required_bid = nrb.get_text(" ", strip=True)

        # Closing time — capture the readable text ("Today 04:01 pm CDT").
        # The <div title="..."> tooltip just holds the timezone, which isn't
        # useful on its own. We want the text content.
        timer_div = card.select_one("div.auction-listing-timer div[title]")
        if timer_div:
            item.closing_time_raw = timer_div.get_text(" ", strip=True)
        if not item.closing_time_raw:
            tnode = card.find(string=re.compile(r"Begins Closing", re.I))
            if tnode and tnode.parent:
                container = tnode.parent
                txt = container.get_text(" ", strip=True)
                txt = re.sub(r"\s+", " ", txt)
                item.closing_time_raw = txt
        # Parse to ISO UTC. Empty string on any failure — never raises.
        item.closing_time_iso = _parse_closing_time(item.closing_time_raw)

        # Time remaining
        tr = card.select_one("h3.lot-timer[id^='lot_timer_'], .lot-timer")
        if tr:
            item.time_remaining = tr.get_text(" ", strip=True)

        # Category breadcrumb (e.g., "Household & Estate > Electronics")
        cat = card.select_one("a[href*='category_ids=']")
        if cat:
            item.category = cat.get_text(" ", strip=True)

        # Description / Additional Detail.
        # On the auction-house listing pages, the lot cards usually do NOT
        # have a "Description:" label — that lives on the per-item page.
        # So we extract description in priority order:
        #   1. Explicit "Description:" label (rare on list pages, common on
        #      item detail pages — useful if we ever crawl those)
        #   2. Image `title=` attribute (this is RICH data: includes brand,
        #      model, color, size, condition notes — way more than the title)
        #   3. Image `alt=` attribute as a last resort
        text_blob = card.get_text("\n", strip=True)
        dm = re.search(
            r"Description:\s*(.+?)(?:\n\s*Additional Detail:|\n\s*\n|$)",
            text_blob,
            re.S,
        )
        if dm:
            item.description = re.sub(r"\s+", " ", dm.group(1)).strip()
        elif img:
            # Try image title= first (e.g. "Current Bid $1.00 - Adidas Cleats - Retail: $50")
            img_title = img.get("title", "") or img.get("alt", "")
            if img_title:
                # Strip the "Current Bid $X.XX - " prefix that the site puts in front
                cleaned = re.sub(r"^Current Bid \$[\d.]+\s*-\s*", "", img_title)
                # If the cleaned version is meaningfully different from the
                # h4 title (longer, more detail), use it as description.
                if len(cleaned) > len(item.title) + 10:
                    item.description = cleaned

        am = re.search(r"Additional Detail:\s*(.+?)(?:\n|$)", text_blob)
        if am:
            item.additional_detail = re.sub(r"\s+", " ", am.group(1)).strip()

        items.append(item)

    return items


# ────────────────────────────── crawl driver ────────────────────────────────

# "City, ST" or "City, ST 64081" — anywhere on an auction-house page header.
# Equip-Bid puts the location near the auction title; the exact element
# varies (sometimes a <p> under the <h1>, sometimes a <span> with no class).
# We bias toward strings that look like real US city/state pairs and pick
# the first one on the page.
#
# City/state lives on the auction LIST page (the page we already fetch in
# crawl_all), inside each auction's panel. Format is dependable:
#
#   <div class="panel panel-default">
#       ...
#       <a href="/auction/45988">…title…</a>
#       <div><i class="bi-globe-americas kb-icon"…></i>STREET, CITY, ST ZIP</div>
#       ...
#   </div>
#
# So instead of fetching each house page separately and regex-scanning prose,
# we walk the panels on the list page once, build a {house_url -> "City, ST"}
# map, and pass it down. One parse, perfectly structured input.

# "ST ZIP" or "ST ZIP-EXT" — the state-and-zip suffix on the address line.
# Anchored to end of string so we don't accidentally match "MO" inside the
# street name (e.g. "Mound City").
_STATE_ZIP_RE = re.compile(r"\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$")

# Just "ST" at end of string — fallback when the ZIP is missing.
_STATE_ONLY_RE = re.compile(r",\s*([A-Z]{2})\s*$")


def _parse_address_line(text: str) -> str:
    """Pull 'City, ST' out of one Equip-Bid address string.

    Inputs we've seen in the wild (from the auction list page):
      '1120 SW 28TH Street, Blue Springs, MO 64015'
      '4545 Emanuel Cleaver II Blvd, Kansas City, MO 64130'
      'Washington and Kellogg, Wichita, KS 67211'
      'Overland Park, KS 66213'                   (no street)
      "Lee's Summit, MO"                          (no zip)

    Strategy: find the trailing 'ST ZIP' (or just 'ST') to anchor the state,
    then take the comma-separated chunk immediately before it as the city.
    Returns '' if we can't identify a state — better to skip than to guess.
    """
    if not text:
        return ""
    text = text.strip()

    # Find the state. Prefer the ST-ZIP form; fall back to bare ST.
    state = ""
    text_for_split = text
    m = _STATE_ZIP_RE.search(text)
    if m:
        state = m.group(1)
        # Strip the ST-ZIP off so the remaining text ends at the city.
        text_for_split = text[:m.start()].rstrip(", ").rstrip()
    else:
        m = _STATE_ONLY_RE.search(text)
        if m:
            state = m.group(1)
            text_for_split = text[:m.start()].rstrip(", ").rstrip()

    if not state:
        return ""

    # The city is the last comma-separated chunk in what remains.
    parts = [p.strip() for p in text_for_split.split(",") if p.strip()]
    if not parts:
        return ""
    city = parts[-1]
    if len(city) < 2:
        return ""
    return f"{city}, {state}"


def parse_house_locations(list_html: str) -> dict[str, str]:
    """From the auction-list page, build {house_url -> 'City, ST'}.

    Walks each `<div class="panel panel-default">` (one per auction), finds
    the auction URL inside it (any `/auction/N` link, ignoring `/item/`
    sub-links), and finds the location line — the parent of the
    `<i class="bi-globe-americas">` icon.
    """
    soup = BeautifulSoup(list_html, "html.parser")
    out: dict[str, str] = {}

    for panel in soup.select("div.panel.panel-default"):
        # Find the auction URL. The same href appears in several places
        # inside the panel (View Auction button, title link, item-count
        # link). Take the first /auction/N link that isn't a deep-link
        # to /item/.
        house_url = ""
        for a in panel.select("a[href]"):
            href = a.get("href", "")
            m = AUCTION_ID_RE.search(urlparse(urljoin(BASE_URL, href)).path)
            if m and "/item/" not in href:
                house_url = urljoin(BASE_URL, f"/auction/{m.group(1)}")
                break
        if not house_url:
            continue

        # Find the location line via the globe icon. Its parent <div>
        # contains the icon + the raw address text node.
        loc_text = ""
        icon = panel.select_one("i.bi-globe-americas")
        if icon and icon.parent:
            loc_text = icon.parent.get_text(" ", strip=True)

        location = _parse_address_line(loc_text)
        if location:
            out[house_url] = location

    return out


def crawl_auction_house(
    session: Session, house_url: str, location: str = ""
) -> Iterator[Item]:
    """Yield every item from every page of one auction house.

    `location` is the pre-extracted 'City, ST' for this house (passed in
    from crawl_all so we don't have to re-parse it on every house page).
    Empty string is fine — items from a house with no resolved location
    just don't get a location stamped on them.
    """
    print(f"\n→ {house_url}" + (f"  ({location})" if location else ""))
    try:
        html = session.get(house_url)
    except Exception as e:
        print(f"  ! could not load auction house: {e}")
        return

    max_page = parse_max_page(html)
    items = parse_items_on_page(html)
    print(f"  page 1/{max_page}: {len(items)} items")
    for it in items:
        if location:
            it.location = location
        yield it

    for page in range(2, max_page + 1):
        sep = "&" if "?" in house_url else "?"
        page_url = f"{house_url}{sep}page={page}"
        try:
            page_html = session.get(page_url)
        except Exception as e:
            print(f"  ! page {page} failed: {e}")
            continue
        items = parse_items_on_page(page_html)
        print(f"  page {page}/{max_page}: {len(items)} items")
        for it in items:
            if location:
                it.location = location
            yield it


def crawl_all(session: Session | None = None) -> Iterator[Item]:
    """Top-level: visit auction list, walk every house, yield every item."""
    session = session or Session(delay=config.SCRAPE_DELAY_SECONDS)

    list_url = build_auction_list_url()
    print(f"Auction list: {list_url}")
    list_html = session.get(list_url)
    houses = parse_auction_houses(list_html)
    locations = parse_house_locations(list_html)
    resolved = sum(1 for h in houses if h in locations)
    print(f"Found {len(houses)} auction houses ({resolved} with location)")

    for h in houses:
        yield from crawl_auction_house(session, h, location=locations.get(h, ""))
