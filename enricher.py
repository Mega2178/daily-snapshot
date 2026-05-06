"""
AI enrichment via Gemini Flash-Lite.

Strategy:
- Batch ~25 items per API call.
- Use structured output (response_schema) so we get reliable JSON back.
- For each item, the model estimates current retail value, resale %, sales
  velocity, and confidence. Items with confidence=unknown sink to bottom of CSV.
- The model is told to IGNORE the seller-claimed "Retail: $X" string in the
  title because those numbers are routinely wrong by orders of magnitude.

Error handling:
- 429 (quota): parse the server's retryDelay; if short, sleep and retry; if
  long (> GEMINI_GIVEUP_AFTER_SECONDS), raise QuotaExhausted so the
  orchestrator stops cleanly. Already-enriched items are already saved.
- 503 (overloaded): exponential backoff retry.
"""
from __future__ import annotations

import json
import re
import time
from typing import Iterable

from pydantic import BaseModel, Field

import config


class QuotaExhausted(Exception):
    """Raised when we've clearly hit the daily quota wall and should stop."""


# google-genai is the current official SDK (replaces deprecated google-generativeai)
try:
    from google import genai
    from google.genai import types as genai_types
    from google.genai import errors as genai_errors
except ImportError as e:
    raise SystemExit(
        "Missing dependency: install with `pip install google-genai`\n"
        f"(import error: {e})"
    )


# ────────────────────────────── schema ──────────────────────────────────────

class ItemValuation(BaseModel):
    """One row of Gemini's batch response."""
    item_id: str = Field(description="The item_id we sent in the request, echo it back exactly")
    product_identified: str = Field(description="Brief identification of what this product actually is, e.g. 'Sony WH-CH520 wireless headphones'")
    current_retail_usd: float = Field(description="Realistic CURRENT retail price NEW in USD (Amazon/Walmart 2026). 0 if unknown.")
    resale_pct: float = Field(description="Estimated resale value as % of retail in the Kansas City secondhand market (Facebook Marketplace / OfferUp). E.g. 0.55 means used items typically sell for 55% of retail. Use 0 if unknown.")
    sales_velocity: str = Field(description="Estimated speed of selling on Facebook Marketplace in Kansas City metro. One of: hot, normal, slow, very_slow, unknown. See system instructions for criteria.")
    confidence: str = Field(description="One of: high, medium, low, unknown")
    condition_severity: str = Field(description="One of: pristine, good, flawed, broken_or_unsellable. Use 'broken_or_unsellable' for items where condition makes them worthless on resale market (missing critical parts, hygiene items, expired food, etc). DO NOT mark as broken_or_unsellable if the listing only says condition is unknown — assume it works unless damage is explicitly stated.")
    repairability: str = Field(description="If condition_severity is 'flawed' or 'broken_or_unsellable', one of: easy_cheap_fix (e.g. missing power cord, missing screws — under $20 to make sellable, considering aftermarket/used/junkyard parts), hard_expensive_fix (e.g. missing proprietary battery, cracked screen), not_applicable (item has no fix issue). The cost benchmark: would the fix cost more than 30% of the resale value? If yes, hard_expensive_fix.")
    repair_cost_usd: float = Field(description="Realistic $ to make this item sellable — using AFTERMARKET / used / generic / junkyard parts when applicable, NOT OEM list price. Examples: missing power cable → 10. Missing car bumper → 60 (junkyard). Cracked phone screen on $200 used phone → 80. Missing proprietary drone battery → 120. Use 0 if no repair is needed (pristine/good) OR if you set condition_severity=broken_or_unsellable and repairability=hard_expensive_fix (since we'll force resale to $0 in that case).")
    notes: str = Field(description="Brief caveat or reasoning (1-2 sentences max). Mention the specific fix needed and its rough cost if relevant.")


class BatchResponse(BaseModel):
    valuations: list[ItemValuation]


# ────────────────────────────── prompt ──────────────────────────────────────

SYSTEM_PROMPT = """You are an expert resale-value estimator for a person flipping
items from estate-auction sites onto Facebook Marketplace in the Kansas City metro.

For each item, fill in ALL fields:

1. CURRENT_RETAIL_USD — what this product sells for NEW today on Amazon, Walmart,
   Target, or the manufacturer's site. CRITICAL: IGNORE any "Retail: $X" number
   that appears in the item title. Sellers routinely put inflated, outdated, or
   completely fabricated numbers there. Use your own knowledge of real current
   prices.

2. RESALE_PCT — what fraction of that retail price a used/open-box copy of this
   category typically fetches on Facebook Marketplace in a midwest metro.
   Rough guidance (use your judgment, not these exactly):
     • Major-brand consumer electronics (Nintendo, Sony, Apple, Bose): 0.50–0.70
     • Small kitchen appliances, name-brand: 0.40–0.55
     • Generic/no-name Amazon junk: 0.20–0.35
     • Power tools, name-brand (DeWalt, Milwaukee): 0.55–0.75
     • Generic clothing/beauty: 0.15–0.30
     • Furniture: 0.25–0.45
     • Specialty/hobby (musical instruments, exercise equipment): 0.30–0.50

3. SALES_VELOCITY — how quickly this item is likely to sell on Facebook
   Marketplace in the Kansas City metro at a fair price. This is NOT a precise
   prediction, just a rank. Pick exactly one:
     • "hot"       = high demand, name recognition, broadly useful. Sells in
                     under a week. Examples: name-brand power tools (DeWalt,
                     Milwaukee, Ryobi), gaming consoles, Apple/Sony
                     electronics, baby gear, popular sneakers, ammo/firearms
                     accessories, generators, snow blowers in season.
     • "normal"    = steady demand. Sells in 1-3 weeks. Examples: most
                     name-brand kitchen appliances, mid-tier electronics,
                     bicycles, sporting goods, common furniture.
     • "slow"      = niche, specialty, or commodity. Sells in 1-2 months.
                     Examples: decor items, lamps, generic small appliances,
                     office furniture, exercise equipment (large/heavy),
                     unusual collectibles, kids' toys (non-trending).
     • "very_slow" = generic, unbranded, or oversupplied. Often sits 2+ months
                     or never sells. Examples: generic Amazon-brand junk,
                     used-clothing single items, dated fashion, novelty items,
                     niche hobby gear without a clear buyer, complicated
                     items requiring assembly knowledge.
     • "unknown"   = you genuinely cannot tell what category this is.

   Adjust DOWN one tier if condition_severity is "flawed". Adjust DOWN two
   tiers if condition_severity is "broken_or_unsellable". Seasonal items
   (Christmas decor in May, AC units in November) should be one tier slower.

4. CONFIDENCE — be honest:
     • "high"   = you know exactly what this product is and its real price
     • "medium" = you can identify the category and estimate within ±25%
     • "low"    = you have a rough guess but real value could be 2x off
     • "unknown" = you genuinely cannot identify the product or value it
   Use "unknown" liberally rather than fabricating. We'd rather have a missing
   row than a wrong row.

5. CONDITION_SEVERITY — what's the physical state of THIS specific item
   (read the title and description carefully for damage notes):
     • "pristine"               = sealed, new, unopened
     • "good"                   = open box, lightly used, fully functional
     • "flawed"                 = visible cosmetic damage, scratches, dings,
                                  but functional
     • "broken_or_unsellable"   = item won't function as intended on the
                                  resale market. Examples: hygiene/personal
                                  care items (used or open), expired food,
                                  cracked/non-functional electronics,
                                  prescription items, missing essential parts
                                  the buyer can't get, custom-engraved
                                  worthless-to-others items.

   IMPORTANT: if the listing only says the condition is "unknown" or
   "untested" or just doesn't mention the working state at all, ASSUME the
   item is "good" (functional). Do NOT default to broken_or_unsellable
   without explicit damage language. Auctioneers leave most items
   un-tested but the items still usually work fine.

6. REPAIRABILITY — only matters if condition_severity is "flawed" or
   "broken_or_unsellable". The buyer of these items has the help of a
   competent handyman who can do basic mechanical work, basic cosmetic work
   (replacing dented body panels, swapping headlight assemblies, replacing
   broken glass), and basic non-risky electrical work (replacing fuses,
   wiring outlets, swapping switches). They have a normal toolkit and can
   source parts from a hardware store, AutoZone, junkyard, eBay, Amazon,
   or Facebook Marketplace. Assume aftermarket / used / generic / junkyard
   sources when costing the fix — most flippers don't pay OEM list price.

   What COUNTS as easy_cheap_fix (handyman + cheap parts can handle it):
     • Missing standard cable (USB-C, HDMI, AC) — under $15
     • Missing universal power adapter — under $20
     • Missing screws, knobs, or hardware-store parts
     • Needs cleaning or replacement gaskets
     • Missing generic remote control
     • Missing manual (PDF available online — $0)
     • Dented car body panel (junkyard replacement: $40–150)
     • Cracked headlight or fender from a car (junkyard: $30–100)
     • Cracked glass on furniture, picture frames, cabinet doors
     • Replacing a worn cord on a lamp or appliance
     • Replacing a fuse, switch, or outlet
     • Re-attaching trim, hinges, or cosmetic pieces
     • Light cleaning of upholstery, sanding/refinishing wood furniture

   What counts as hard_expensive_fix (specialist required, or proprietary
   parts that can't be sourced cheaply):
     • Missing PROPRIETARY battery for a specific brand of e-bike, drone,
       or modern power tool, where even a used aftermarket replacement
       costs more than 30% of the item's resale value
     • Cracked LCD/OLED screens on phones, tablets, laptops (requires
       specialty tools and risk of further damage during the swap)
     • Internal electronics failure on a sealed unit (motherboard, logic
       board) where diagnosis is uncertain
     • Engine, transmission, or drivetrain failure on a vehicle
     • Refrigerant or sealed-system work on appliances (requires EPA cert)
     • Soldering or board-level repair
     • Anything where replacement parts cost > 30% of resale value AND
       can't be sourced from a junkyard / aftermarket / used market
     • Missing keys for proprietary locks, safes, or vehicles where a
       locksmith / dealer is required
     • Custom-fit or VIN-specific parts not available used
     • Items whose only fix is "send it in to manufacturer for $X service"

   What is "not_applicable":
     • Item has no condition issue worth fixing (pristine or good)

   IMPORTANT: items with condition_severity="broken_or_unsellable" AND
   repairability="hard_expensive_fix" will have their estimated value
   automatically set to $0. So be honest — flag truly worthless items.

   But ALSO be honest in the other direction: if the only problem is
   "missing the manual" or "no original box," that is NOT broken_or_unsellable.
   Cosmetic-only issues are "flawed" + "easy_cheap_fix" or "not_applicable".

7. REPAIR_COST_USD — concrete dollar estimate for PARTS ONLY (assume free
   handyman labor from the buyer's network), using AFTERMARKET / used /
   generic / junkyard sources where applicable. This number is folded into
   the total acquisition cost when computing the deal score, so accuracy
   matters more than tier labels. Calibration:
     • Missing standard cable (USB-C, HDMI, AC):     8–12
     • Missing generic remote:                       12–15
     • Missing screws/hardware:                      5
     • Missing universal wall adapter:               10–15
     • Missing manual:                               0 (PDF online)
     • Junkyard car bumper / fender / quarter panel: 40–100
     • Junkyard headlight assembly:                  30–80
     • Replacement glass for cabinet/picture frame:  10–40
     • Used proprietary tool battery (DeWalt 20V):   60–120
     • Used phone screen (mid-tier, DIY kit):        50–90
     • Drone proprietary battery:                    80–200
     • Generator carb rebuild kit:                   25–60
     • Replacement lamp/appliance cord:              5–10
   Use 0 if condition is pristine/good (no repair needed). Use 0 if you've
   set condition_severity=broken_or_unsellable AND repairability=
   hard_expensive_fix (the item gets zeroed out anyway, so the repair
   cost is moot).

8. NOTES — 1–2 short sentences: identify what you think the item is, mention
   any specific fix needed and rough cost, or why you're uncertain.

CONSISTENCY CHECK: The notes must agree with the structured fields. Do not
write "this is unsellable" in notes while assigning a positive resale_pct.
The structured fields are what get used by downstream code."""


# ────────────────────────────── enricher ────────────────────────────────────

class Enricher:
    def __init__(self):
        if not config.GEMINI_API_KEY or config.GEMINI_API_KEY == "PASTE_YOUR_KEY_HERE":
            raise SystemExit(
                "GEMINI_API_KEY is not set in config.py.\n"
                "Get a free key at https://aistudio.google.com/apikey"
            )
        self.client = genai.Client(api_key=config.GEMINI_API_KEY)
        self.model = config.GEMINI_MODEL
        self.last_call = 0.0

    def _throttle(self):
        elapsed = time.time() - self.last_call
        if elapsed < config.GEMINI_DELAY_SECONDS:
            time.sleep(config.GEMINI_DELAY_SECONDS - elapsed)

    def enrich_batch(self, batch: list[dict]) -> list[ItemValuation]:
        """Send ~25 items in one Gemini call. Retries on 429/503.

        Raises QuotaExhausted if Google tells us the wait is longer than
        GEMINI_GIVEUP_AFTER_SECONDS — the daily-quota wall.
        """
        if not batch:
            return []

        prompt = _build_prompt(batch)

        for attempt in range(config.GEMINI_MAX_RETRIES + 1):
            self._throttle()
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=prompt,
                    config=genai_types.GenerateContentConfig(
                        system_instruction=SYSTEM_PROMPT,
                        response_mime_type="application/json",
                        response_schema=BatchResponse,
                        temperature=0.2,
                    ),
                )
                self.last_call = time.time()
                return _parse_response(response)

            except Exception as e:
                self.last_call = time.time()
                err_str = str(e)
                code = _extract_status_code(err_str)
                retry_delay = _extract_retry_delay(err_str)

                # 429 = quota. If the wait is huge, we've hit the daily wall.
                if code == 429:
                    if retry_delay is None:
                        retry_delay = 30  # default if we can't parse
                    if retry_delay > config.GEMINI_GIVEUP_AFTER_SECONDS:
                        raise QuotaExhausted(
                            f"daily quota wall hit (Google asks to wait "
                            f"{retry_delay}s). Stopping; already-enriched "
                            f"items are saved. Re-run `python scrape.py "
                            f"--enrich` after midnight Pacific."
                        ) from e
                    if attempt < config.GEMINI_MAX_RETRIES:
                        wait = retry_delay + 1  # +1 sec safety margin
                        print(f"  [429] quota throttle, waiting {wait}s "
                              f"(attempt {attempt + 1}/{config.GEMINI_MAX_RETRIES})")
                        time.sleep(wait)
                        continue
                    else:
                        print(f"  [429] giving up on this batch after "
                              f"{config.GEMINI_MAX_RETRIES} retries")
                        return []

                # 503 = transient overload. Exponential backoff.
                if code == 503:
                    if attempt < config.GEMINI_MAX_RETRIES:
                        wait = (attempt + 1) * 5
                        print(f"  [503] overloaded, retry in {wait}s "
                              f"(attempt {attempt + 1}/{config.GEMINI_MAX_RETRIES})")
                        time.sleep(wait)
                        continue
                    print(f"  [503] giving up on this batch")
                    return []

                # Anything else: log and skip
                print(f"  ! Gemini call failed: {err_str[:200]}")
                return []

        return []


def chunked(seq: list, n: int) -> Iterable[list]:
    """Yield successive n-sized chunks of a list."""
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ────────────────────────────── helpers ─────────────────────────────────────

def _build_prompt(batch: list[dict]) -> str:
    """Build the user prompt for one batch."""
    lines = [
        "Estimate values for each item. Return one valuation per item, echoing item_id.",
        "Do NOT use the current bid as a price anchor — bids start at $1.",
        "",
    ]
    for entry in batch:
        lines.append(f"item_id: {entry['item_id']}")
        lines.append(f"  title: {entry['title']}")
        if entry.get("category"):
            lines.append(f"  category: {entry['category']}")
        if entry.get("description") and entry["description"] != entry["title"]:
            lines.append(f"  description: {entry['description']}")
        if entry.get("additional_detail"):
            lines.append(f"  condition_note: {entry['additional_detail']}")
        lines.append("")
    return "\n".join(lines)


def _parse_response(response) -> list[ItemValuation]:
    """Extract valuations from a Gemini response object."""
    try:
        parsed: BatchResponse | None = getattr(response, "parsed", None)
        if parsed is None:
            text = response.text or ""
            data = json.loads(text)
            parsed = BatchResponse(**data)
        return parsed.valuations
    except Exception as e:
        text_preview = (getattr(response, "text", "") or "")[:300]
        print(f"  ! could not parse Gemini response: {e}")
        print(f"    raw: {text_preview}")
        return []


_STATUS_RE = re.compile(r"\b(\d{3})\s+[A-Z_]+", re.MULTILINE)
_RETRY_DELAY_RE = re.compile(r"['\"]?retryDelay['\"]?\s*:\s*['\"]?(\d+(?:\.\d+)?)\s*s['\"]?")
_RETRY_PHRASE_RE = re.compile(r"retry in (\d+(?:\.\d+)?)\s*s", re.IGNORECASE)


def _extract_status_code(err_str: str) -> int | None:
    """Pull the HTTP status code out of a Gemini error string.

    Examples we need to handle:
        '429 RESOURCE_EXHAUSTED. {...}'
        '503 UNAVAILABLE. {...}'
    """
    m = _STATUS_RE.search(err_str)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None


def _extract_retry_delay(err_str: str) -> float | None:
    """Pull the suggested retry delay (in seconds) from a 429 error.

    Google sends: {"retryDelay": "26s"} OR "Please retry in 26.21s"
    Returns None if we can't find one.
    """
    m = _RETRY_DELAY_RE.search(err_str)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    m = _RETRY_PHRASE_RE.search(err_str)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None
