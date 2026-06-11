#!/usr/bin/env python3
"""
db/update_recent_prices.py
Updates prices_history for tickers that appeared in filings from the last 3 days.
Used by GitHub Actions nightly ingest — runs in ~15 min vs 7+ hours for full enrich.
"""
import os, sys, time, requests
from datetime import date, timedelta
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

DATABASE_URL    = os.environ.get("DATABASE_URL", "")
POLYGON_API_KEY = os.environ.get("POLYGON_API_KEY", "")

if not DATABASE_URL or not POLYGON_API_KEY:
    print("ERROR: DATABASE_URL and POLYGON_API_KEY required")
    sys.exit(1)

try:
    import psycopg
    conn = psycopg.connect(DATABASE_URL)
except ImportError:
    import psycopg2
    conn = psycopg2.connect(DATABASE_URL)

cutoff = (date.today() - timedelta(days=3)).isoformat()
with conn.cursor() as cur:
    cur.execute("""
        SELECT DISTINCT ticker FROM public.filings
        WHERE ticker IS NOT NULL AND ticker != ''
          AND COALESCE(filing_date, transaction_date) >= %s
        ORDER BY ticker
    """, (cutoff,))
    tickers = [r[0] for r in cur.fetchall()]

print(f"Updating prices for {len(tickers)} tickers from last 3 days")

written = 0; skipped = 0
for i, ticker in enumerate(tickers, 1):
    time.sleep(12.5)
    try:
        r = requests.get(
            f"https://api.polygon.io/v2/aggs/ticker/{ticker}/prev",
            params={"apiKey": POLYGON_API_KEY}, timeout=15
        )
        if not r.ok:
            skipped += 1; continue
        results = r.json().get("results", [])
        if not results:
            skipped += 1; continue
        bar   = results[0]
        close = bar.get("c")
        ts    = bar.get("t")
        if not close or not ts:
            skipped += 1; continue
        bar_date = date.fromtimestamp(ts / 1000)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO public.prices_history (ticker, date, close)
                VALUES (%s, %s, %s)
                ON CONFLICT (ticker, date) DO UPDATE SET close = EXCLUDED.close
            """, (ticker, bar_date, round(float(close), 4)))
        conn.commit()
        written += 1
        print(f"  [{i}/{len(tickers)}] {ticker}: ${close} ({bar_date})")
    except Exception as e:
        print(f"  [{i}/{len(tickers)}] {ticker}: skip — {e}")
        skipped += 1

conn.close()
print(f"\nDone. Written: {written}  Skipped: {skipped}")
