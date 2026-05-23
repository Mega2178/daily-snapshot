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
import threading
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
    condition: str = Field(description="One of: new, open_box, damaged_easy_fix, damaged_hard_fix. DEFAULT to 'open_box' unless damage is explicitly stated in the listing — see system instructions for the full rules.")
    notes: str = Field(description="Brief caveat or reasoning (1-2 sentences max). Mention any damage / missing parts that drove the condition assessment.")


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

   Adjust DOWN one tier if condition is "damaged_easy_fix". Adjust DOWN two
   tiers if condition is "damaged_hard_fix". Seasonal items (Christmas decor
   in May, AC units in November) should be one tier slower.

4. CONFIDENCE — be honest:
     • "high"   = you know exactly what this product is and its real price
     • "medium" = you can identify the category and estimate within ±25%
     • "low"    = you have a rough guess but real value could be 2x off
     • "unknown" = you genuinely cannot identify the product or value it
   Use "unknown" liberally rather than fabricating. We'd rather have a missing
   row than a wrong row.

5. CONDITION — what is the physical state of THIS specific item, judged
   from the title + description + condition note. Pick exactly one:

     • "new"               = explicitly described as new, sealed, unopened,
                             "in original packaging", "factory sealed",
                             "brand new", or similar.

     • "open_box"          = THE DEFAULT. Use this whenever the listing
                             does NOT explicitly describe damage, missing
                             parts, or non-functioning state. This includes:
                               - listings that say "open box", "appears new",
                                 "lightly used", "tested working"
                               - listings that say nothing about condition
                               - listings that say condition is "unknown",
                                 "untested", or "as-is" without further detail
                             Auctioneers leave most lots untested; assume
                             they work unless the listing says otherwise.

     • "damaged_easy_fix"  = listing EXPLICITLY mentions cosmetic damage,
                             a missing standard part, or a simple problem
                             that a handyman can handle for under ~$30 in
                             cheap aftermarket / used / hardware-store parts.
                             The buyer has a competent handyman who can do
                             basic mechanical work, basic cosmetic work
                             (replacing dented body panels, swapping
                             headlight assemblies, replacing broken glass),
                             and basic non-risky electrical work (replacing
                             fuses, wiring outlets, swapping switches).
                             Examples that BELONG here:
                               - missing standard cable (USB-C, HDMI, AC)
                               - missing universal power adapter
                               - missing screws, knobs, hardware-store parts
                               - missing generic remote
                               - missing manual (PDF online)
                               - dented car body panel, cracked headlight
                                 (junkyard replacement)
                               - cracked glass on furniture, picture frames
                               - worn cord on a lamp or appliance
                               - replacing a fuse, switch, or outlet
                               - re-attaching trim, hinges, cosmetic pieces
                               - light cosmetic wear, scratches, dings
                                 (still functional)

     • "damaged_hard_fix"  = listing EXPLICITLY indicates the item is
                             broken, non-functional, or unsellable AND
                             the fix requires specialist work or expensive
                             proprietary parts. Examples:
                               - missing PROPRIETARY battery for an e-bike,
                                 drone, or modern power tool (no cheap used
                                 / aftermarket option)
                               - cracked LCD/OLED screen on phones, tablets,
                                 laptops
                               - internal electronics failure on a sealed
                                 unit (motherboard, logic board)
                               - engine, transmission, or drivetrain failure
                               - refrigerant / sealed-system appliance work
                               - soldering or board-level repair required
                               - missing keys for proprietary locks, safes,
                                 or vehicles requiring locksmith / dealer
                               - custom-fit or VIN-specific parts not
                                 available used
                               - "send to manufacturer for $X service"
                             ALSO use this for items that are fundamentally
                             unsellable on the resale market regardless of
                             repair: used hygiene/personal-care items,
                             expired food, prescription items,
                             custom-engraved items worthless to others.

   CRITICAL DEFAULTING RULE: When in doubt, choose "open_box". Do NOT
   guess that an item is damaged. Do NOT mark "damaged_*" just because
   the listing is vague or says "unknown" / "as-is" / "untested". Only
   downgrade from "open_box" when the listing has explicit damage,
   missing-part, or non-functional language. If your confidence on the
   condition assessment specifically is low, default to "open_box".

6. NOTES — 1–2 short sentences: identify what you think the item is,
   mention any damage / missing parts that drove the condition
   assessment, or why you're uncertain.

CONSISTENCY CHECK: The notes must agree with the structured fields. Do not
write "this is broken" in notes while marking it open_box, and do not
write "appears new" while marking it damaged_hard_fix. The structured
fields are what get used by downstream code."""


# ────────────────────────────── enricher ────────────────────────────────────

class _Worker:
    """One API key + its own client + its own throttle clock.

    Each key has independent per-minute and per-day quotas (when the keys
    belong to different Google Cloud projects), so each worker tracks its
    own last_call time and own exhausted flag. Multiple workers can run
    concurrently; they share nothing but the model name.
    """
    def __init__(self, api_key: str, name: str):
        self.api_key = api_key
        self.name = name
        self.client = genai.Client(api_key=api_key)
        self.model = config.GEMINI_MODEL
        self.last_call = 0.0
        self._lock = threading.Lock()  # serializes the per-key throttle clock
        self.exhausted = False

    def _throttle(self):
        # Called inside the lock — at most one in-flight call per key.
        elapsed = time.time() - self.last_call
        if elapsed < config.GEMINI_DELAY_SECONDS:
            time.sleep(config.GEMINI_DELAY_SECONDS - elapsed)

    def enrich_batch(self, batch: list[dict]) -> list[ItemValuation]:
        """Send one batch through this key. Honors per-key rate limit.

        Returns [] on transient failure, raises QuotaExhausted on daily wall.
        The lock guarantees that the per-minute throttle is respected even
        when multiple threads share this worker (they shouldn't in our
        current design — one worker per thread — but it's cheap insurance).
        """
        if not batch:
            return []
        if self.exhausted:
            raise QuotaExhausted(f"{self.name} already marked exhausted")

        prompt = _build_prompt(batch)

        for attempt in range(config.GEMINI_MAX_RETRIES + 1):
            # `caught` survives the except block (Python deletes the `except
            # ... as e` target when the block exits, so we can't reference it
            # in the error-classification code below, which runs outside the
            # lock). We stash the exception here to use with `raise ... from`.
            caught: Exception | None = None
            with self._lock:
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
                    caught = e
                    err_str = str(e)
                    code = _extract_status_code(err_str)
                    retry_delay = _extract_retry_delay(err_str)

            # ── handle errors OUTSIDE the lock so the other worker
            # ── isn't blocked while we sleep during retry backoff
            if code == 429:
                if retry_delay is None:
                    retry_delay = 30
                if retry_delay > config.GEMINI_GIVEUP_AFTER_SECONDS:
                    # Daily wall on this key. Mark it dead.
                    self.exhausted = True
                    raise QuotaExhausted(
                        f"{self.name}: daily quota wall "
                        f"(retry in {retry_delay}s)"
                    ) from caught
                if attempt < config.GEMINI_MAX_RETRIES:
                    wait = retry_delay + 1
                    print(f"  [{self.name}][429] throttle, waiting {wait}s "
                          f"(attempt {attempt + 1}/{config.GEMINI_MAX_RETRIES})")
                    time.sleep(wait)
                    continue
                print(f"  [{self.name}][429] giving up on batch after "
                      f"{config.GEMINI_MAX_RETRIES} retries")
                return []

            if code == 503:
                if attempt < config.GEMINI_MAX_RETRIES:
                    wait = (attempt + 1) * 5
                    print(f"  [{self.name}][503] overloaded, retry in {wait}s "
                          f"(attempt {attempt + 1}/{config.GEMINI_MAX_RETRIES})")
                    time.sleep(wait)
                    continue
                print(f"  [{self.name}][503] giving up on this batch")
                return []

            # ── Permanent, non-retryable errors ─────────────────────────
            # 401 = bad/expired key, 403 = key valid but the Google Cloud
            # project is suspended / denied access / API not enabled, 400 =
            # malformed key. Retrying or routing more batches to this key is
            # pointless — it will fail identically every time. Mark the
            # worker dead so enrich_batches_concurrent stops dispatching to
            # it and reroutes everything to the remaining live key(s).
            # Without this, a single banned key silently eats ~half of all
            # batches for the entire run (this was the cause of the wall of
            # "403 PERMISSION_DENIED ... batch N/M: no valuations" spam).
            if code in (400, 401, 403) or _is_permanent_auth_error(err_str):
                self.exhausted = True
                raise QuotaExhausted(
                    f"{self.name}: permanent error "
                    f"(HTTP {code if code else '4xx'}) — key/project rejected. "
                    f"Marking this key dead and routing to other key(s). "
                    f"Detail: {err_str[:160]}"
                ) from caught

            # Anything else: log and skip
            print(f"  ! [{self.name}] Gemini call failed: {err_str[:200]}")
            return []

        return []


class Enricher:
    """Coordinator over one or two API key workers.

    Usage:
        e = Enricher()
        # Single-batch (sequential, used by tests and legacy paths):
        valuations = e.enrich_batch(batch)
        # Many batches (concurrent across keys if multiple are configured):
        for batch_idx, valuations in e.enrich_batches_concurrent(all_batches):
            ...

    With two keys, batches are dispatched round-robin across worker threads;
    each thread blocks on its own per-key throttle clock so the two keys run
    in genuine parallel against Google's API. Throughput scales linearly with
    the number of keys (modulo Google-side overload).

    Quota walls are handled per worker: when one key gets a long-retry 429,
    that worker is marked exhausted and the remaining batches reroute to the
    other worker(s). When ALL workers are exhausted, the iterator stops and
    the orchestrator persists already-enriched items.
    """
    def __init__(self):
        if not config.GEMINI_API_KEY or config.GEMINI_API_KEY == "PASTE_YOUR_KEY_HERE":
            raise SystemExit(
                "GEMINI_API_KEY is not set in config.py.\n"
                "Get a free key at https://aistudio.google.com/apikey"
            )
        # Build the worker list. Each worker = one key + one client.
        self._workers: list[_Worker] = [
            _Worker(config.GEMINI_API_KEY, "key1")
        ]
        if (config.GEMINI_API_KEY_2
                and config.GEMINI_API_KEY_2 != config.GEMINI_API_KEY):
            self._workers.append(_Worker(config.GEMINI_API_KEY_2, "key2"))
        self.model = config.GEMINI_MODEL

        # Legacy: single-batch callers always use worker[0] unless it's
        # exhausted, then fall through to whichever remains.
        if len(self._workers) > 1:
            print(f"  enricher: {len(self._workers)} API keys → concurrent dispatch")

    @property
    def worker_count(self) -> int:
        return len(self._workers)

    def _live_workers(self) -> list[_Worker]:
        return [w for w in self._workers if not w.exhausted]

    def enrich_batch(self, batch: list[dict]) -> list[ItemValuation]:
        """Backwards-compatible single-batch sender.

        Tries the first live worker; on QuotaExhausted, rotates. Raises
        QuotaExhausted only when ALL workers are dead. Used by callers
        that don't want concurrency (e.g. the --test path).
        """
        last_err = None
        for w in self._live_workers():
            try:
                return w.enrich_batch(batch)
            except QuotaExhausted as e:
                print(f"  → {w.name} exhausted, trying next worker")
                last_err = e
                continue
        raise QuotaExhausted(
            f"all {len(self._workers)} configured key(s) are exhausted. "
            f"Stopping; already-enriched items are saved. "
            f"Re-run `python scrape.py --enrich` after midnight Pacific."
        ) from last_err

    def enrich_batches_concurrent(self, batches: list[list[dict]]):
        """Dispatch many batches across all live workers concurrently.

        Yields (index, valuations) tuples in COMPLETION order (not input
        order), so the caller must use the index to map results back to
        items. Implementation note: we use ThreadPoolExecutor with one
        worker thread per API key, and submit batches round-robin. Each
        thread blocks on its own _Worker._lock (the throttle clock), so
        cross-key parallelism is real.

        If a worker raises QuotaExhausted, its in-flight batch result is
        ([] failed), and remaining batches reroute to live workers. If ALL
        workers go exhausted, the iterator stops yielding — remaining
        batches stay unenriched in the dataset and pick up on the next run.
        """
        if not batches:
            return

        live = self._live_workers()
        if not live:
            raise QuotaExhausted("no live API keys to dispatch with")

        # Single-worker path: just iterate. Avoids thread-pool overhead and
        # makes test runs deterministic.
        if len(live) == 1:
            w = live[0]
            for idx, batch in enumerate(batches):
                try:
                    yield idx, w.enrich_batch(batch)
                except QuotaExhausted:
                    raise
            return

        # Multi-worker concurrent dispatch.
        # We use a simple "submit one batch per worker, await any, submit
        # next" loop. ThreadPoolExecutor.submit is fine because each worker
        # already serializes its own calls via its lock.
        import concurrent.futures as _f

        # Map future -> (batch_idx, batch, worker_assigned). Workers are
        # bound at submit time; if a worker exhausts mid-run we don't
        # reassign the already-submitted future — but we DO push its batch
        # onto `requeue` so a live worker picks it up (no batch is lost just
        # because it happened to land on the key that died).
        pending: dict = {}
        requeue: list = []  # [(idx, batch), ...] batches to re-dispatch
        executor = _f.ThreadPoolExecutor(max_workers=len(self._workers))
        try:
            batch_iter = iter(enumerate(batches))

            def _submit_next() -> bool:
                """Submit the next batch (preferring any requeued batch) to
                the worker with the least in-flight work. Returns False
                when there's nothing left to submit or no workers remain
                alive."""
                live_now = self._live_workers()
                if not live_now:
                    return False
                # Drain the requeue first so a batch orphaned by a dead key
                # gets retried before we pull brand-new work.
                if requeue:
                    idx, batch = requeue.pop(0)
                else:
                    try:
                        idx, batch = next(batch_iter)
                    except StopIteration:
                        return False
                # Pick the worker with the fewest currently-pending futures.
                load = {w: 0 for w in live_now}
                for (_idx, _batch, w) in pending.values():
                    if w in load:
                        load[w] += 1
                chosen = min(live_now, key=lambda w: load[w])
                fut = executor.submit(chosen.enrich_batch, batch)
                pending[fut] = (idx, batch, chosen)
                return True

            # Prime: submit up to one batch per worker.
            for _ in range(len(live)):
                if not _submit_next():
                    break

            while pending:
                done, _ = _f.wait(
                    pending.keys(), return_when=_f.FIRST_COMPLETED
                )
                for fut in done:
                    idx, batch, worker = pending.pop(fut)
                    try:
                        result = fut.result()
                    except QuotaExhausted:
                        # This worker is dead (quota wall or permanent auth
                        # error). Its batch wasn't processed — push it back so
                        # a live worker retries it. If no workers remain, the
                        # post-loop check below surfaces the stop cleanly.
                        if not getattr(worker, "_death_announced", False):
                            worker._death_announced = True
                            live_names = [w.name for w in self._live_workers()]
                            print(f"  → {worker.name} is dead; rerouting all "
                                  f"remaining batches to: "
                                  f"{', '.join(live_names) or '(none left)'}")
                        if self._live_workers():
                            requeue.append((idx, batch))
                        result = None  # don't yield an empty result for it
                    except Exception as e:
                        print(f"  ! [{worker.name}] worker exception: {e}")
                        result = []
                    if result is not None:
                        yield idx, result
                    # Top up: keep up to len(live) in flight.
                    _submit_next()
        finally:
            executor.shutdown(wait=True)

        # If we exited because all workers exhausted but batches remain,
        # surface that to the caller so it can stop cleanly.
        leftover = bool(requeue) or any(True for _ in batch_iter)
        if self._live_workers() == [] and leftover:
            raise QuotaExhausted(
                f"all {len(self._workers)} configured key(s) exhausted "
                f"during concurrent dispatch. Already-enriched items "
                f"are saved. Re-run after midnight Pacific."
            )


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

# Phrases Google returns for permanently-broken keys/projects. These mean
# "this key will NEVER work again on its own" — as opposed to 429 (wait and
# retry) or 503 (overloaded, retry soon). Used as a fallback when the numeric
# status code isn't cleanly parseable from the wrapped SDK error string.
_PERMANENT_AUTH_PHRASES = (
    "permission_denied",
    "denied access",
    "api key not valid",
    "api_key_invalid",
    "unauthenticated",
    "permission denied",
    "consumer_suspended",
    "has been suspended",
    "is not enabled",
    "billing",
)


def _is_permanent_auth_error(err_str: str) -> bool:
    """True if the error text indicates a permanently-dead key/project.

    A 403 PERMISSION_DENIED (suspended project), 401 UNAUTHENTICATED
    (bad/expired key), or "API not enabled" will fail identically on every
    future call, so the caller should mark the worker exhausted rather than
    retrying or routing more batches to it.
    """
    low = (err_str or "").lower()
    return any(p in low for p in _PERMANENT_AUTH_PHRASES)


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
