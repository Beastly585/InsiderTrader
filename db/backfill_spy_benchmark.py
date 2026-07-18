#!/usr/bin/env python3
"""
db/backfill_spy_benchmark.py
One-time (or occasionally re-run) backfill of SPY's full daily close history
into public.benchmark_prices — the missing piece for a real, market-adjusted
hit-rate calculation.

Uses Alpha Vantage's TIME_SERIES_DAILY endpoint with outputsize=full, NOT
Polygon. Polygon's free/Basic tier was tested directly and confirmed to
silently truncate historical requests to roughly the trailing 2 years —
requesting 2012-01-01 onward returned only ~501 bars starting mid-2024, with
no error, just quietly less data than asked for. Alpha Vantage's free tier
genuinely returns 20+ years of daily history in a single call for a single
symbol — confirmed directly in their own API documentation, not assumed.
This is a one-time backfill script specifically because of that: Alpha
Vantage's free tier is real but tight (as low as 25 requests/day depending
on when you're reading this — Alpha Vantage's own limits have changed over
time, so don't assume the number in this comment is still current), which
is fine for a single one-off pull of one ticker's full history, but not
something to run daily or across many tickers. Ongoing daily updates to
this same table should use Polygon instead (same source already powering
update_recent_prices.py) — this script is deliberately NOT the thing that
keeps this table fresh going forward, only what fills in the deep history
Polygon's free tier can't reach.

Stooq was considered and deliberately NOT used — its own robots.txt
disallows automated access, and scraping it programmatically would go
directly against that, free or not.

Requires a free Alpha Vantage API key: https://www.alphavantage.co/support/#api-key

Usage:
  python3 backfill_spy_benchmark.py --dry-run
  python3 backfill_spy_benchmark.py --start 2012-01-01
"""
from __future__ import annotations
import os, sys, time, argparse, logging, requests
from datetime import date, datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL         = os.environ.get("DATABASE_URL", "")
ALPHA_VANTAGE_API_KEY = os.environ.get("ALPHA_VANTAGE_API_KEY", "")
SYMBOL               = os.environ.get("BENCHMARK_SYMBOL", "SPY")

if not DATABASE_URL:
    log.error("DATABASE_URL required"); sys.exit(1)
if not ALPHA_VANTAGE_API_KEY:
    log.error("ALPHA_VANTAGE_API_KEY required — get a free key at https://www.alphavantage.co/support/#api-key")
    sys.exit(1)


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


def fetch_full_daily_history(symbol: str) -> dict:
    """One call, outputsize=full — returns every daily bar Alpha Vantage has
    for this symbol (20+ years for a ticker like SPY), not a date-range
    request. Alpha Vantage's daily endpoint doesn't take a start/end
    parameter at all; filtering to a specific range happens client-side
    after the full history comes back."""
    url = "https://www.alphavantage.co/query"
    params = {
        "function": "TIME_SERIES_DAILY",
        "symbol": symbol,
        "outputsize": "full",
        "apikey": ALPHA_VANTAGE_API_KEY,
    }
    r = requests.get(url, params=params, timeout=30)
    if not r.ok:
        log.error(f"HTTP {r.status_code}: {r.text[:300]}")
        return {}

    data = r.json()

    # Alpha Vantage returns 200 OK even for rate-limit/error responses — the
    # actual error shows up as a "Note", "Information", or "Error Message"
    # key instead of the expected "Time Series (Daily)" key, so check for
    # those explicitly rather than assume a 200 means real data came back.
    if "Note" in data:
        log.error(f"Alpha Vantage rate limit hit: {data['Note']}")
        return {}
    if "Information" in data:
        log.error(f"Alpha Vantage returned an Information message instead of data (often means an invalid/missing API key or a plan limit): {data['Information']}")
        return {}
    if "Error Message" in data:
        log.error(f"Alpha Vantage error: {data['Error Message']}")
        return {}

    series = data.get("Time Series (Daily)")
    if not series:
        log.error(f"No 'Time Series (Daily)' key in response. Raw keys: {list(data.keys())}")
        return {}

    return series


def main():
    ap = argparse.ArgumentParser(description="Backfill SPY (or another benchmark) daily closes via Alpha Vantage")
    ap.add_argument("--start", default="2012-01-01", help="Start date, YYYY-MM-DD (default: 2012-01-01, the STOCK Act's effective date) — filters client-side after the full history is fetched")
    ap.add_argument("--end", default=date.today().isoformat(), help="End date, YYYY-MM-DD (default: today)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        datetime.strptime(args.start, "%Y-%m-%d")
        datetime.strptime(args.end, "%Y-%m-%d")
    except ValueError:
        log.error("--start/--end must be YYYY-MM-DD"); sys.exit(1)

    log.info(f"Fetching {SYMBOL}'s full daily history from Alpha Vantage (one call, outputsize=full)...")
    series = fetch_full_daily_history(SYMBOL)

    if not series:
        log.error("No data returned — nothing was written. See the error above for why.")
        sys.exit(1)

    log.info(f"Received {len(series)} total daily bars for {SYMBOL} (full available history)")

    # Filter to the requested range client-side.
    filtered = {d: v for d, v in series.items() if args.start <= d <= args.end}
    log.info(f"{len(filtered)} bars fall within {args.start} to {args.end}")

    if not filtered:
        log.error("No bars in the requested date range — nothing to write.")
        sys.exit(1)

    sorted_dates = sorted(filtered.keys())
    log.info(f"Range actually covered: {sorted_dates[0]} to {sorted_dates[-1]}")

    if args.dry_run:
        log.info(f"[DRY RUN] Would write {len(filtered)} rows for {SYMBOL}. Sample:")
        for d in sorted_dates[:3] + sorted_dates[-3:]:
            close = filtered[d]["4. close"]
            log.info(f"  {d}  close={close}")
        return

    conn = get_connection()
    written = 0
    with conn.cursor() as cur:
        for d, bar in filtered.items():
            close = bar.get("4. close")
            if not close:
                continue
            cur.execute("""
                INSERT INTO public.benchmark_prices (symbol, date, close)
                VALUES (%s, %s, %s)
                ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
            """, (SYMBOL, d, round(float(close), 4)))
            written += 1
    conn.commit()
    conn.close()
    log.info(f"Done. Wrote {written} row(s) for {SYMBOL} into public.benchmark_prices.")


if __name__ == "__main__":
    main()
