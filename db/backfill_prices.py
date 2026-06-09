#!/usr/bin/env python3
"""
db/backfill_prices.py
─────────────────────────────────────────────────────────────────────────────
Backfills daily closing prices for all tickers in public.filings into a
lean prices_history table: (ticker, date, close) — ~30 MB for 2 years.

This enables accurate 30/60/90-day return calculations per trade, which
powers insider trader profiles and hit-rate scoring.

Polygon free tier: 5 req/min — one call per ticker fetches ALL dates at once.
Runtime: ~2 min per 10 tickers = ~100 min for 500 tickers. Run once.
Subsequent runs only fetch missing dates (incremental).

Usage:
    python backfill_prices.py                  # all tickers, from earliest trade
    python backfill_prices.py --from 2024-01-01  # override start date
    python backfill_prices.py --tickers AAPL,NVDA,MSFT  # specific tickers
    python backfill_prices.py --dry-run        # show what would be fetched

Environment (db/.env):
    DATABASE_URL       postgresql://...
    POLYGON_API_KEY    your_key_here
─────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import os, time, sys, logging, argparse
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL    = os.environ.get("DATABASE_URL", "")
POLYGON_API_KEY = os.environ.get("POLYGON_API_KEY", "")
SLEEP           = 12.5   # 5 req/min free tier — 1 req per 12.5s to be safe

# ── DB ─────────────────────────────────────────────────────────────────────────

def get_conn():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

def ensure_table():
    """
    Create prices_history if it doesn't exist.
    Separate from public.prices (current prices) — this stores daily history.
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.prices_history (
                    ticker  text    NOT NULL,
                    date    date    NOT NULL,
                    close   numeric(16,4) NOT NULL,
                    PRIMARY KEY (ticker, date)
                );
                CREATE INDEX IF NOT EXISTS idx_ph_ticker_date
                    ON public.prices_history (ticker, date);
            """)
        conn.commit()
        log.info("prices_history table ready")
    finally:
        conn.close()

def get_ticker_coverage() -> dict[str, Optional[date]]:
    """
    Returns {ticker: max_date_in_prices_history} for all tickers that
    already have some history. Used to skip re-fetching covered dates.
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT ticker, MAX(date)
                FROM public.prices_history
                GROUP BY ticker
            """)
            return {r[0]: r[1] for r in cur.fetchall()}
    finally:
        conn.close()

def get_tickers_and_starts() -> list[tuple[str, date]]:
    """
    For each ticker in filings, find the earliest open-market buy date.
    That's the furthest back we need price history for return calculations.
    Returns [(ticker, earliest_transaction_date), ...] sorted by ticker.
    """
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    ticker,
                    MIN(transaction_date)::date AS earliest
                FROM public.filings
                WHERE ticker IS NOT NULL
                  AND ticker != ''
                  AND is_open_market = true
                  AND transaction_date IS NOT NULL
                  AND transaction_date >= '2000-01-01'
                GROUP BY ticker
                ORDER BY ticker
            """)
            return [(r[0], r[1]) for r in cur.fetchall()]
    finally:
        conn.close()

def write_bars(ticker: str, bars: list[tuple[date, float]]) -> int:
    """
    Bulk upsert (ticker, date, close) rows. Fresh connection per ticker
    to avoid SSL timeout on long runs.
    """
    if not bars:
        return 0
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO public.prices_history (ticker, date, close)
                VALUES (%s, %s, %s)
                ON CONFLICT (ticker, date) DO UPDATE
                    SET close = EXCLUDED.close
                """,
                [(ticker, d, c) for d, c in bars]
            )
        conn.commit()
        return len(bars)
    finally:
        conn.close()

# ── Polygon.io ─────────────────────────────────────────────────────────────────

def fetch_daily_bars(ticker: str, from_date: date, to_date: date,
                     retries: int = 4) -> list[tuple[date, float]]:
    """
    Fetch all daily closing prices for a ticker between from_date and to_date.
    One API call returns the full range — very efficient vs per-day calls.

    Polygon endpoint: GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}
    Free tier supports this endpoint with full history.
    Returns [(date, close), ...] sorted ascending.
    """
    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{ticker}/range/1/day"
        f"/{from_date.isoformat()}/{to_date.isoformat()}"
    )
    params = {
        "adjusted": "true",
        "sort":     "asc",
        "limit":    "50000",   # max bars per call — covers 200 years at daily
        "apiKey":   POLYGON_API_KEY,
    }

    for attempt in range(retries):
        time.sleep(SLEEP)
        try:
            r = requests.get(url, params=params, timeout=30)
        except Exception as e:
            log.debug(f"{ticker}: request error — {e}")
            time.sleep(10); continue

        if r.status_code == 429:
            wait = 65 * (attempt + 1)
            log.warning(f"{ticker}: rate limited — waiting {wait}s")
            time.sleep(wait); continue
        if r.status_code == 403:
            log.error("Polygon API key invalid")
            return []
        if r.status_code == 404:
            log.debug(f"{ticker}: not found on Polygon")
            return []
        if not r.ok:
            log.debug(f"{ticker}: HTTP {r.status_code}")
            return []

        try:
            data = r.json()
        except Exception:
            log.debug(f"{ticker}: bad JSON response")
            return []

        results = data.get("results", [])
        if not results:
            # Polygon returns empty results for tickers with no data in range
            return []

        bars = []
        for bar in results:
            ts = bar.get("t")   # Unix ms timestamp
            c  = bar.get("c")   # closing price
            if ts is None or c is None:
                continue
            bar_date = date.fromtimestamp(ts / 1000)
            bars.append((bar_date, round(float(c), 4)))

        return bars

    return []

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Backfill daily price history from Polygon")
    ap.add_argument("--from",     dest="date_from", type=str,
                    help="Override start date (YYYY-MM-DD). Default: earliest trade per ticker.")
    ap.add_argument("--tickers",  type=str,
                    help="Comma-separated list of specific tickers, e.g. AAPL,NVDA")
    ap.add_argument("--dry-run",  action="store_true",
                    help="Print what would be fetched without hitting Polygon")
    args = ap.parse_args()

    if not DATABASE_URL:
        log.error("DATABASE_URL not set in db/.env"); sys.exit(1)
    if not POLYGON_API_KEY and not args.dry_run:
        log.error("POLYGON_API_KEY not set in db/.env"); sys.exit(1)

    today = date.today()

    # Setup
    ensure_table()

    # Get coverage already in DB
    coverage = get_ticker_coverage()
    log.info(f"  {len(coverage)} tickers already have some price history")

    # Get tickers + their earliest trade date
    if args.tickers:
        ticker_list = [t.strip().upper() for t in args.tickers.split(",")]
        # Use 2024-01-01 as default start for manual tickers
        tickers_starts = [(t, date(2024, 1, 1)) for t in ticker_list]
    else:
        tickers_starts = get_tickers_and_starts()

    log.info(f"  {len(tickers_starts)} tickers to process")

    # Apply --from override
    global_from = None
    if args.date_from:
        try:
            global_from = date.fromisoformat(args.date_from)
        except ValueError:
            log.error(f"Invalid --from date: {args.date_from}"); sys.exit(1)

    log.info("═"*60)
    log.info(f"  Price History Backfill")
    log.info(f"  Tickers: {len(tickers_starts)}")
    log.info(f"  Dry run: {args.dry_run}")
    log.info(f"  Rate:    1 req/{SLEEP}s (Polygon free tier)")
    log.info(f"  ETA:     ~{int(len(tickers_starts)*SLEEP/60)} minutes")
    log.info("═"*60)

    total_rows = 0
    skipped    = 0
    errors     = 0

    for i, (ticker, earliest_trade) in enumerate(tickers_starts, 1):

        # Determine fetch range
        fetch_from = global_from or earliest_trade

        # If we already have history for this ticker, only fetch missing tail
        if ticker in coverage:
            existing_max = coverage[ticker]
            if isinstance(existing_max, str):
                existing_max = date.fromisoformat(str(existing_max))
            if existing_max >= today - timedelta(days=1):
                # Already up to date
                skipped += 1
                log.debug(f"  [{i}/{len(tickers_starts)}] {ticker}: up to date (max {existing_max})")
                continue
            # Only fetch the gap
            fetch_from = existing_max + timedelta(days=1)

        # Nothing to fetch if fetch_from is in the future
        if fetch_from > today:
            skipped += 1
            continue

        log.info(f"  [{i}/{len(tickers_starts)}] {ticker}: {fetch_from} → {today}")

        if args.dry_run:
            days_span = (today - fetch_from).days
            log.info(f"    DRY RUN: would fetch ~{days_span} calendar days")
            continue

        bars = fetch_daily_bars(ticker, fetch_from, today)

        if bars:
            written = write_bars(ticker, bars)
            total_rows += written
            log.info(f"    ✓ {written} bars written (${bars[-1][1]:.2f} latest close)")
        else:
            log.debug(f"    {ticker}: no data returned")
            errors += 1

    log.info(f"\n{'═'*60}")
    log.info(f"  Done.")
    log.info(f"  Rows written: {total_rows:,}")
    log.info(f"  Skipped (up to date): {skipped}")
    log.info(f"  No data / errors:     {errors}")
    log.info("═"*60)

    if not args.dry_run and total_rows > 0:
        # Show DB size
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        COUNT(DISTINCT ticker)  AS tickers,
                        COUNT(*)                AS total_rows,
                        pg_size_pretty(pg_relation_size('public.prices_history')) AS table_size,
                        MIN(date)               AS earliest,
                        MAX(date)               AS latest
                    FROM public.prices_history
                """)
                r = cur.fetchone()
                log.info(f"\n  prices_history: {r[0]} tickers · {r[1]:,} rows · {r[2]}")
                log.info(f"  Date range: {r[3]} → {r[4]}")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
