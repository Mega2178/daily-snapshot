# daily-snapshot

A small Python pipeline that fetches public listing data from a single public
source on a daily schedule, enriches each record with an LLM-based valuation
estimate, and renders the result as a static dashboard.

GitHub Actions runs the pipeline once a day. The output is a JSON file consumed
by a static frontend in `web/`.

## Components

- `scrape.py` — orchestrator. Loads cached data, refreshes, optionally enriches,
  writes outputs.
- `scraper.py` — fetches the source pages and parses listings.
- `enricher.py` — sends batched records to the Gemini API for valuation
  estimates with structured-output JSON.
- `config.py` — filters, batch size, model selection, rate-limit settings.
- `web/` — static HTML/CSS/JS dashboard. No build step. Reads
  `web/data/items.json`.

## Outputs

- `raw_items.json` — persistent cache of every record ever seen, with cached
  enrichment results so we don't re-spend quota on items we've already valued.
- `items.csv` — flat tabular export sorted by score.
- `web/data/items.json` — what the frontend reads.

## Local development

Requires Python 3.9 or newer.
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

Create a `.env` file at the project root containing your Gemini API key:
GEMINI_API_KEY=your_key_here

Get a free key at https://aistudio.google.com/apikey.

### Running
python scrape.py              # full run (fetch + enrich)
python scrape.py --no-enrich  # fetch only, skip the LLM call
python scrape.py --enrich     # enrich only (no re-fetch)
python scrape.py --test       # process only the first N items (see config.py)

## Scheduled runs

`.github/workflows/scrape.yml` runs the full pipeline daily at 10:00 UTC and
commits the output back to `main`. It can also be triggered manually via the
Actions tab.

The workflow needs a repo secret named `GEMINI_API_KEY`.

## Free-tier limits

Gemini 3.1 Flash-Lite Preview has a 500 RPD / 15 RPM / 250 TPM free quota
(per project, resets midnight Pacific). With `BATCH_SIZE = 25` that's a
theoretical max of 12,500 records enriched per day. The orchestrator
preserves cached enrichment across runs so we only spend quota on
genuinely new records.

If a daily quota wall is hit mid-run, already-enriched records are saved
and the run exits cleanly. Re-running with `--enrich` after the quota
resets picks up the rest.

## Troubleshooting

**Module not found: `google.genai`** — the venv isn't active. Run
`source venv/bin/activate` first.

**`GEMINI_API_KEY is not set`** — create a `.env` file with the key, or
in CI confirm the repo secret is named `GEMINI_API_KEY` exactly.

**Gemini returns empty responses** — lower `BATCH_SIZE` to 15 in
`config.py`. Long titles can occasionally truncate the response.

**Source page HTML changed** — selectors live in `parse_items_on_page()`
and `parse_auction_houses()` in `scraper.py`.
