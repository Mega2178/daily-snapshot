"""
Configuration. Edit these values, then run scrape.py.

The only thing you MUST set is GEMINI_API_KEY.
Everything else has reasonable defaults.
"""
import sys
from datetime import datetime, timedelta, timezone


# ─── TIMEZONE ────────────────────────────────────────────────────────────────
# Equip-Bid is a Kansas City auction site and every closing time it publishes
# is Central. The owner is in America/Chicago. Define the app timezone ONCE
# here so every "what day is it / what time is it locally" decision (the
# closing-date filter, close-time parsing, the email's date) resolves to the
# same zone regardless of where the process runs.
#
# WHY THIS MATTERS: GitHub Actions runners are UTC. A naive datetime.now()
# there returns the UTC date, which rolls to *tomorrow* at 7 PM Central — so
# evening cron runs used to query tomorrow's lots and never refresh tonight's
# still-open ones. Anchoring to Central fixes that.
APP_TIMEZONE = "America/Chicago"


def now_local() -> datetime:
    """Timezone-aware 'now' in APP_TIMEZONE.

    Requires the IANA tz database. On Linux/macOS it's in the OS; on Windows
    it comes from the `tzdata` package (pinned in requirements.txt). If it's
    somehow unavailable we fall back to a FIXED UTC-6 offset and warn loudly —
    that fallback is wrong by an hour half the year (it ignores CST/CDT), so a
    silent fallback would be a real bug. The warning tells you to install
    tzdata; it should never fire in CI or a properly-provisioned venv.
    """
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(APP_TIMEZONE))
    except Exception as e:  # pragma: no cover - only hit when tzdata is missing
        print(
            f"WARNING: could not load timezone {APP_TIMEZONE!r} ({e}); falling "
            f"back to a FIXED UTC-6 offset. Install the 'tzdata' package "
            f"(it is in requirements.txt). Dates near midnight and winter (CST) "
            f"close times may be off by up to an hour until you do.",
            file=sys.stderr,
        )
        return datetime.now(timezone(timedelta(hours=-6)))


# ─── REQUIRED ────────────────────────────────────────────────────────────────
# Get a free key from https://aistudio.google.com/apikey
# (login with your Google account, "Create API key", copy/paste)
#
# Keys are read from env vars, NOT hardcoded here.
#   - Locally: put them in a .env file next to this one (gitignored).
#     python-dotenv loads it automatically below.
#   - In CI:   the GitHub Actions workflow injects them from repo Secrets.
#
# FALLBACK KEY: GEMINI_API_KEY_2 is optional. If set, the enricher will
# dispatch batches concurrently across both keys, roughly DOUBLING
# throughput.
#
# CRITICAL: the two keys must come from DIFFERENT Google Cloud projects
# (i.e. different Google accounts, or at minimum a second project under
# the same account with its own quota allocation). Google enforces
# rate-limit quotas at the project level, not the key level — two keys
# inside the same project share one 500 RPD / 15 RPM bucket and the
# fallback gains you nothing. Two keys in separate projects = 1000 RPD
# combined and 30 RPM combined.
#
# Leave GEMINI_API_KEY_2 unset (empty) to operate single-key.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv only needed locally; in CI the env var comes from Actions
import os
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_API_KEY_2 = os.getenv("GEMINI_API_KEY_2", "")  # optional fallback


# ─── SEARCH FILTERS ──────────────────────────────────────────────────────────
# Closing date filter, format: YYYY-MM-DD. Use None to skip the filter.
# Computed in Central (see now_local above), NOT naive/UTC — otherwise CI's
# UTC runner queries tomorrow's lots from 7 PM Central onward.
CLOSING_DATE = now_local().strftime("%Y-%m-%d")


# ZIP for distance calculation. Equip-Bid wants a ZIP even if you don't filter.
DISTANCE_ZIP = "64081"

# Distance radius in miles. -1 means "any distance".
# Common values: -1, 10, 25, 50, 75, 100, 150, 250
DISTANCE_RADIUS = 75

# Affiliate filter (auction-house company). 0 = all affiliates.
AFFILIATE = 0


# ─── BEHAVIOR ────────────────────────────────────────────────────────────────
# Seconds between HTTP requests to Equip-Bid. Be polite.
SCRAPE_DELAY_SECONDS = 1.0

# Fetch the per-item detail page for newly-discovered lots, so the AI can
# read the real "Description:" and "Additional Detail:" fields (which include
# the actual condition notes — torn box, missing remote, won't power on, etc.).
# Without this, the AI defaults virtually every item to "open_box" because the
# auction-list cards don't carry that text. Trade-off: ~1 extra HTTP request
# per *new* lot. Already-cached items aren't re-fetched.
SCRAPE_ITEM_DETAIL_PAGES = True

# Max seconds to spend fetching detail pages in one run. Once exceeded, the
# scraper stops detail-page fetches and lets the rest enrich on title-only
# data. Prevents a 12,000-new-item day from blowing past the GitHub Actions
# timeout. The leftover lots will be detail-fetched on a subsequent run
# because they're cached without a detail flag.
#
# Math at default settings (SCRAPE_DELAY_SECONDS=1.0, single-threaded):
#   1800s budget = up to ~1,800 detail pages
#   5400s budget = up to ~5,400 detail pages (covers a busy 5k-item day
#                                              with margin, fits comfortably
#                                              in the 4hr workflow timeout)
# If you drop SCRAPE_DELAY_SECONDS to 0.5, double those numbers.
SCRAPE_DETAIL_PAGE_TIME_BUDGET_SECONDS = 5400  # 90 min

# Items per Gemini batch call. 25-30 is a sweet spot — bigger = fewer requests
# but more tokens per call. If you see truncated responses, lower this.
BATCH_SIZE = 25

# Which Gemini model to use for enrichment.
# Check your actual quotas at https://ai.dev/rate-limit (they vary by account!).
# Current free-tier defaults observed in production (May 2026):
#   gemini-3.1-flash-lite-preview  → 500 RPD, 15 RPM (RECOMMENDED)
#   gemini-3-flash-preview         → smaller daily quota, smarter
#   gemini-2.5-flash-lite          → 1000 RPD on some accounts
#   gemini-2.5-flash               → 250 RPD on most accounts
GEMINI_MODEL = "gemini-3.1-flash-lite"

# Sleep between Gemini calls (seconds) PER KEY to stay under RPM limit.
# 4.5s = ~13 RPM, safely under the 15 RPM Flash-Lite ceiling.
# 5s gives a little extra safety margin for clock drift / network jitter.
# This applies to each worker independently — with two keys, the actual
# request rate is 2× this (still well-spaced per Google's per-key books).
GEMINI_DELAY_SECONDS = 4.5

# How many times to retry a single batch when Gemini returns 429/503.
# Each retry honors the server's suggested retryDelay before trying again.
GEMINI_MAX_RETRIES = 3

# If the server says "retry in N seconds" and N is bigger than this, we treat
# it as a daily-quota wall and either swap to the fallback key or stop.
GEMINI_GIVEUP_AFTER_SECONDS = 90

# Pickup hassle fudge factor (dollars subtracted when computing flip score)
PICKUP_HASSLE_DOLLARS = 5.0


# ─── DATA RETENTION ──────────────────────────────────────────────────────────
# How many days AFTER an auction closes to keep its items in raw_items.json.
# 0 = purge on the next run after the auction closes.
# 2 = keep for two days after close (good buffer for "what did this finally
#     sell for" curiosity and lets you re-score / re-enrich any item with bugs).
# Setting this too high explodes the repo size — GitHub's hard limit is 100 MB
# per file and at ~3,000 items/day the JSON output passes 100 MB in ~3-4 weeks
# of accumulation.
CLOSED_ITEM_RETENTION_DAYS = 2

# Pretty-print web/data/items.json? False = single-line JSON (~30% smaller).
# Set True for human-readable file in git diffs at the cost of size.
PRETTY_PRINT_JSON = False


# ─── PURCHASE PRICE MODEL ────────────────────────────────────────────────────
# The auction-site "next required bid" is NOT the actual cost to acquire an
# item. After buyer's premium, sales tax, and miscellaneous fees, the real
# out-of-pocket cost is consistently ~30% higher than the winning bid. We
# multiply next_required_bid by this factor everywhere we compute purchase
# cost (flip_score, gross profit, ROI). Tune this if your local fees differ.
PURCHASE_PRICE_MULTIPLIER = 1.3

# ─── SALES VELOCITY MODEL ────────────────────────────────────────────────────
# Gemini also estimates how quickly an item will sell on Facebook Marketplace
# in the Kansas City metro. Tiers map to a numeric score so we can blend it
# into a weighted "smart score" alongside ROI and gross profit.
#
# Don't read these as "days to sell" — Gemini doesn't actually know FB Marketplace
# velocity data. Treat them as a rank: hot brand-name electronics rank high,
# generic Amazon junk ranks low. Useful as ONE input among several, not as a
# precise prediction.
SALES_VELOCITY_SCORES = {
    "hot": 1.0,        # name-brand electronics, tools, popular toys
    "normal": 0.65,    # most household goods, name-brand kitchen items
    "slow": 0.35,      # niche/specialty items, generic clothing, decor
    "very_slow": 0.10, # generic Amazon-brand items, dated fashion, oddities
    "unknown": 0.0,
}

# How many items to process when --test is passed. With BATCH_SIZE=25 the
# default of 50 = exactly 2 Gemini batches, which is the smallest run that
# still exercises the batch loop, checkpointing, and inter-batch pacing.
TEST_MODE_ITEM_LIMIT = 50


# ─── DAILY EMAIL DIGEST ──────────────────────────────────────────────────────
# email_digest.py reads web/data/items.json, keeps only OPEN auction lots that
# clear ALL of the thresholds below, takes the top EMAIL_TOP_N by flip_score,
# and emails them once a day. If nothing clears the bar, no email is sent.
#
# THRESHOLDS — edit these freely. They map 1:1 to "I want items that..."
#
#   EMAIL_MIN_FLIP_SCORE = the minimum ROI (flip_score) as a decimal.
#       flip_score = (effective_resale - cost - hassle) / cost, where
#       cost = next_required_bid * PURCHASE_PRICE_MULTIPLIER (1.3). This is the
#       SAME number shown as "ROI" on your dashboard (e.g. "6.00x").
#       "6x ROI or better" -> 6.0 (matches the flip_score column directly).
EMAIL_MIN_FLIP_SCORE = 2.0
#
#   EMAIL_MIN_PROFIT = minimum absolute gross profit in dollars.
#       gross_profit = effective_resale - cost - hassle, with cost =
#       next_required_bid * 1.3 (same basis as ROI above).
#       IMPORTANT: cost tracks the CURRENT next-bid, which is low early in the
#       day and climbs toward close. A $300 floor will rarely match in the
#       morning; it's a deliberately high bar so only big flips trigger email.
#       If you want these to surface when bids are realistic, move the email
#       workflow's cron to the evening. See EMAIL_SETUP.md.
EMAIL_MIN_PROFIT = 100.0
#
#   EMAIL_MIN_CONDITION = worst condition you'll accept ("at least ___").
#       Best -> worst: new, open_box, damaged_easy_fix, damaged_hard_fix.
#       "at least easy simple fix" -> "damaged_easy_fix" (lets new/open_box through too).
EMAIL_MIN_CONDITION = "damaged_easy_fix"
#
#   EMAIL_MIN_VELOCITY = slowest sales speed you'll accept ("at least ___").
#       Best -> worst: hot, normal, slow, very_slow, unknown.
#       "at least normal sales speed" -> "normal" (lets hot through too).
EMAIL_MIN_VELOCITY = "normal"
#
#   EMAIL_TOP_N = how many items to include (the best N by flip_score).
EMAIL_TOP_N = 5

# Subject line. {n} = item count, {plural} = "" or "s", {date} = "May 23".
EMAIL_SUBJECT = "Today's top {n} flip{plural} \u2014 {date}"

# SMTP defaults. Override per-run with env vars SMTP_HOST / SMTP_PORT.
# Gmail: smtp.gmail.com / 587 (STARTTLS) — needs an App Password, see
# email_digest.py's docstring. Username/password/recipient come from env
# vars / repo secrets, NEVER hardcoded here.
EMAIL_SMTP_HOST = "smtp.gmail.com"
EMAIL_SMTP_PORT = 587
