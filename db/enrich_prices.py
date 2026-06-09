#!/usr/bin/env python3
"""
db/enrich_prices.py
─────────────────────────────────────────────────────────────────────────────
Fetches yesterday's closing price for every ticker in public.filings and
upserts a single row into public.prices_history (ticker, date, close).

This is the daily complement to backfill_prices.py:
  - backfill_prices.py  — fetches full history from earliest trade to today
  - enrich_prices.py    — runs nightly, adds today's close for all tickers

Both write to the same (ticker, date, close) schema. No separate prices table.
The frontend computes current price and return_pct on the fly via LATERAL JOIN.

Free tier: 5 req/min — 12.5s sleep between calls.
Runtime:   ~2200 tickers × 12.5s = ~7.5 hours (run overnight or in background)

For a faster daily update, backfill_prices.py --from yesterday is preferred
since it fetches all tickers in one shot with the same rate limit.

Usage:
    python enrich_prices.py          # update all tickers
    python enrich_prices.py --resume # skip tickers already updated today

Environment (db/.env):
    DATABASE_URL       postgresql://...
    POLYGON_API_KEY    your_key_here
─────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import os, sys, time, logging, argparse
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
SLEEP           = 12.5   # 5 req/min free tier

# ── DB ─────────────────────────────────────────────────────────────────────────

def get_conn():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

def get_tickers(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ticker FROM public.filings
            WHERE ticker IS NOT NULL AND ticker != ''
              AND is_open_market = true
              AND transaction_type = 'buy'
            ORDER BY ticker
        """)
        return [r[0] for r in cur.fetchall()]

def get_already_updated_today(conn) -> set[str]:
    """Tickers that already have a row for today — used by --resume."""
    today = date.today()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ticker FROM public.prices_history
            WHERE date = %s
        """, (today,))
        return {r[0] for r in cur.fetchall()}

def upsert_bar(conn, ticker: str, bar_date: date, close: float):
    """Write a single (ticker, date, close) row into prices_history."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO public.prices_history (ticker, date, close)
            VALUES (%s, %s, %s)
            ON CONFLICT (ticker, date) DO UPDATE
                SET close = EXCLUDED.close
        """, (ticker, bar_date, round(close, 4)))
    conn.commit()

# ── Polygon ────────────────────────────────────────────────────────────────────

def fetch_prev_close(ticker: str) -> Optional[tuple[date, float]]:
    """
    Fetch the previous trading day's close from Polygon /v2/aggs/ticker/{t}/prev.
    Returns (bar_date, close) or None.
    """
    url = f"https://api.polygon.io/v2/aggs/ticker/{ticker}/prev"
    for attempt in range(4):
        time.sleep(SLEEP)
        try:
            r = requests.get(url, params={"apiKey": POLYGON_API_KEY}, timeout=15)
        except Exception as e:
            log.debug(f"{ticker}: request error — {e}"); continue

        if r.status_code == 429:
            wait = 65 * (attempt + 1)
            log.warning(f"Rate limited — waiting {wait}s"); time.sleep(wait); continue
        if r.status_code == 403:
            log.error("Polygon API key invalid"); return None
        if r.status_code == 404:
            return None
        if not r.ok:
            log.debug(f"{ticker}: HTTP {r.status_code}"); return None

        try:
            data = r.json()
        except Exception:
            return None

        results = data.get("results", [])
        if not results:
            return None

        bar = results[0]
        close = bar.get("c")
        ts    = bar.get("t")   # Unix ms
        if not close or not ts:
            return None

        bar_date = date.fromtimestamp(ts / 1000)
        return bar_date, round(float(close), 4)

    return None

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Enrich prices_history with latest close")
    ap.add_argument("--resume", action="store_true",
                    help="Skip tickers already updated today")
    args = ap.parse_args()

    if not DATABASE_URL:
        log.error("DATABASE_URL not set in db/.env"); sys.exit(1)
    if not POLYGON_API_KEY:
        log.error("POLYGON_API_KEY not set in db/.env"); sys.exit(1)

    conn = get_conn()
    tickers = get_tickers(conn)
    log.info(f"Found {len(tickers)} tickers to enrich")

    already_done: set[str] = set()
    if args.resume:
        already_done = get_already_updated_today(conn)
        log.info(f"  --resume: {len(already_done)} already updated today, skipping")

    ok = 0; skipped = 0; errors = 0

    for i, ticker in enumerate(tickers, 1):
        if ticker in already_done:
            skipped += 1
            continue

        result = fetch_prev_close(ticker)
        if result:
            bar_date, close = result
            upsert_bar(conn, ticker, bar_date, close)
            ok += 1
            log.info(f"  [{i}/{len(tickers)}] {ticker}: ${close}  ({bar_date})")
        else:
            errors += 1
            log.debug(f"  [{i}/{len(tickers)}] {ticker}: no data")

    conn.close()
    log.info(f"\nDone. Updated: {ok}  Skipped: {skipped}  No data: {errors}")
    log.info("Current prices are now queryable via:")
    log.info("  SELECT ticker, close FROM prices_history")
    log.info("  WHERE date = (SELECT MAX(date) FROM prices_history ph2 WHERE ph2.ticker = prices_history.ticker)")

if __name__ == "__main__":
    main()
