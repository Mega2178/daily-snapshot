"""
Configuration. Edit these values, then run scrape.py.

The only thing you MUST set is GEMINI_API_KEY.
Everything else has reasonable defaults.
"""
from datetime import datetime


# ─── REQUIRED ────────────────────────────────────────────────────────────────
# Get a free key from https://aistudio.google.com/apikey
# (login with your Google account, "Create API key", copy/paste)
#
# The key is read from the GEMINI_API_KEY environment variable, NOT hardcoded
# here. Two ways it gets set:
#   - Locally: put it in a .env file next to this one (gitignored).
#              python-dotenv loads it automatically below.
#   - In CI:   the GitHub Actions workflow injects it from repo Secrets.
# Either way, this file is safe to commit because the real key never lives in it.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv only needed locally; in CI the env var comes from Actions
import os
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")


# ─── SEARCH FILTERS ──────────────────────────────────────────────────────────
# Closing date filter, format: YYYY-MM-DD. Use None to skip the filter.
CLOSING_DATE = datetime.now().strftime("%Y-%m-%d")


# ZIP for distance calculation. Equip-Bid wants a ZIP even if you don't filter.
DISTANCE_ZIP = "64081"

# Distance radius in miles. -1 means "any distance".
# Common values: -1, 10, 25, 50, 75, 100, 150, 250
DISTANCE_RADIUS = -1

# Affiliate filter (auction-house company). 0 = all affiliates.
AFFILIATE = 0


# ─── BEHAVIOR ────────────────────────────────────────────────────────────────
# Seconds between HTTP requests to Equip-Bid. Be polite.
SCRAPE_DELAY_SECONDS = 1.0

# Items per Gemini batch call. 25-30 is a sweet spot — bigger = fewer requests
# but more tokens per call. If you see truncated responses, lower this.
BATCH_SIZE = 25

# Which Gemini model to use for enrichment.
# Check your actual quotas at https://ai.dev/rate-limit (they vary by account!).
# Common defaults as of May 2026:
#   gemini-3.1-flash-lite-preview  → 500 RPD, 15 RPM, fast and cheap (RECOMMENDED)
#   gemini-3-flash-preview         → 20 RPD, 5 RPM, smarter but tiny daily quota
#   gemini-2.5-flash-lite          → 20 RPD on most accounts (deprecated soon)
#   gemini-2.5-flash               → 20 RPD on most accounts
GEMINI_MODEL = "gemini-3.1-flash-lite-preview"

# Sleep between Gemini calls (seconds) to stay under RPM limit.
# 4.5s = safely under 15 RPM. 6s = safely under 10 RPM.
GEMINI_DELAY_SECONDS = 4.5

# How many times to retry a single batch when Gemini returns 429/503.
# Each retry honors the server's suggested retryDelay before trying again.
GEMINI_MAX_RETRIES = 3

# If the server says "retry in N seconds" and N is bigger than this, we treat
# it as a daily-quota wall and stop the run (your already-enriched items are
# saved; pick up tomorrow with `python scrape.py --enrich`). 90s is a good
# threshold — short backoffs are normal, longer means you're out for the day.
GEMINI_GIVEUP_AFTER_SECONDS = 90

# Pickup hassle fudge factor (dollars subtracted when computing flip score)
PICKUP_HASSLE_DOLLARS = 5.0

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
