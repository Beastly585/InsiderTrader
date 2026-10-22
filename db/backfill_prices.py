#!/usr/bin/env python3
"""
db/backfill_prices.py
Fills prices_history with a daily close for every tracked ticker, for every
trading day in the last N days. One-time job (safe to stop and re-run).

Why: the nightly job only saves the latest close, so most stocks only have
prices for the days someone happened to trade them, plus the last couple of
weeks. Stock-page charts look sparse, and 1Y / 3Y show the same short line as
3M because there's no older data to draw.

Uses Polygon's grouped-daily endpoint: one request = the whole market for one
day. Free tier: 5 requests/minute and about 2 years of history, so 2 years is
~500 trading days, ~1.7 hours. Days that are already filled in are skipped,
so you can stop it (Ctrl-C) and start it again any time.

    cd db
    python backfill_prices.py              # last 730 days (free-tier limit)
    python backfill_prices.py --days 90    # quick test
"""
import argparse, os, sys, time
from datetime import date, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")
DATABASE_URL    = os.environ.get("DATABASE_URL", "")
POLYGON_API_KEY = os.environ.get("POLYGON_API_KEY", "")
SLEEP           = float(os.environ.get("POLYGON_SLEEP", "12.5"))  # 5/min on the free tier

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=int, default=730)
args = ap.parse_args()

if not DATABASE_URL or not POLYGON_API_KEY:
    sys.exit("DATABASE_URL and POLYGON_API_KEY are required (db/.env).")

try:
    import psycopg
    conn = psycopg.connect(DATABASE_URL)
except ImportError:
    import psycopg2
    conn = psycopg2.connect(DATABASE_URL)

with conn.cursor() as cur:
    try:
        cur.execute("SELECT key FROM public.search_entities WHERE kind = 'stock'")
        tickers = {r[0] for r in cur.fetchall()}
    except Exception:
        conn.rollback()
        cur.execute("SELECT DISTINCT ticker FROM public.filings WHERE ticker IS NOT NULL AND ticker <> ''")
        tickers = {r[0] for r in cur.fetchall()}
    # Days that already have most tickers filled in get skipped.
    cur.execute("""SELECT date, COUNT(*) FROM public.prices_history
                    WHERE date >= CURRENT_DATE - %s GROUP BY date""", (args.days,))
    have = {d: n for d, n in cur.fetchall()}
print(f"Tracking {len(tickers):,} tickers")

full = max(50, int(len(tickers) * 0.5))
days = [date.today() - timedelta(days=k) for k in range(1, args.days + 1)]
todo = [d for d in days if d.weekday() < 5 and have.get(d, 0) < full]
print(f"{len(todo)} weekdays to fetch (of {sum(1 for d in days if d.weekday() < 5)}); "
      f"about {len(todo) * SLEEP / 60:.0f} minutes at {60 / SLEEP:.0f} requests/minute\n")

written = 0
for n, d in enumerate(todo, 1):
    while True:
        try:
            r = requests.get(f"https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{d.isoformat()}",
                             params={"apiKey": POLYGON_API_KEY, "adjusted": "true"}, timeout=30)
        except requests.exceptions.RequestException as e:
            print(f"  {d}: network error ({e}), retrying in 30s"); time.sleep(30); continue
        if r.status_code == 429:
            print(f"  {d}: rate limited, waiting 60s"); time.sleep(60); continue
        break

    if r.status_code in (401, 403):
        print(f"\n{d}: HTTP {r.status_code}. Your Polygon plan doesn't reach this far back. "
              f"Stopping here; everything newer is saved.")
        break
    if not r.ok:
        print(f"  {d}: HTTP {r.status_code}, skipping"); time.sleep(SLEEP); continue

    bars = r.json().get("results") or []
    rows_t, rows_c = [], []
    for b in bars:
        t, c = b.get("T"), b.get("c")
        if t in tickers and c:
            rows_t.append(t); rows_c.append(round(float(c), 4))
    if rows_t:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO public.prices_history (ticker, date, close)
                SELECT t, %s::date, c FROM unnest(%s::text[], %s::numeric[]) AS x(t, c)
                ON CONFLICT (ticker, date) DO UPDATE SET close = EXCLUDED.close
            """, (d, rows_t, rows_c))
        conn.commit()
        written += len(rows_t)
    print(f"  [{n}/{len(todo)}] {d}: {len(rows_t):,} closes{'' if bars else ' (market closed)'}")
    time.sleep(SLEEP)

conn.close()
print(f"\nDone. {written:,} closes written. Charts pick them up right away.")
