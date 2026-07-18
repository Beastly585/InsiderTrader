#!/usr/bin/env python3
"""
db/update_recent_prices.py
Updates prices_history for tickers that appeared in filings from the last N days.

Uses Polygon's grouped-daily endpoint — ONE request returns the whole market's
closing prices for a session, instead of one request per ticker. The old version
called /v2/aggs/ticker/{ticker}/prev per ticker with a 12.5s sleep between calls
(Polygon free tier: 5 calls/min), so runtime scaled linearly with ticker count —
150 tickers meant ~31 minutes by design. This version makes one call (or a
handful, if it has to walk backward over a weekend/holiday to find the last
trading session), so runtime no longer depends on how many tickers you track.
"""
import os, sys, time, requests
from datetime import date, timedelta
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

DATABASE_URL      = os.environ.get("DATABASE_URL", "")
POLYGON_API_KEY   = os.environ.get("POLYGON_API_KEY", "")
LOOKBACK_DAYS     = int(os.environ.get("PRICE_LOOKBACK_DAYS", "3"))
BENCHMARK_SYMBOL  = os.environ.get("BENCHMARK_SYMBOL", "SPY")

if not DATABASE_URL or not POLYGON_API_KEY:
    print("ERROR: DATABASE_URL and POLYGON_API_KEY required")
    sys.exit(1)

try:
    import psycopg
    conn = psycopg.connect(DATABASE_URL)
except ImportError:
    import psycopg2
    conn = psycopg2.connect(DATABASE_URL)

cutoff = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
with conn.cursor() as cur:
    cur.execute("""
        SELECT DISTINCT ticker FROM public.filings
        WHERE ticker IS NOT NULL AND ticker != ''
          AND COALESCE(filing_date, transaction_date) >= %s
    """, (cutoff,))
    tickers = {r[0] for r in cur.fetchall()}

print(f"Tracking {len(tickers)} tickers from the last {LOOKBACK_DAYS} days")


def fetch_grouped_bars(start: date, max_lookback: int = 10):
    """Walk backward from `start` until we hit a session with real trading
    data — this naturally skips weekends/holidays. One request per day
    checked, NOT per ticker, so this stays far under any rate limit no
    matter how many tickers we're tracking. A 429 pauses and retries the
    same date rather than burning a lookback step."""
    d = start
    checked = 0
    while checked < max_lookback:
        url = f"https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{d.isoformat()}"
        try:
            r = requests.get(url, params={"apiKey": POLYGON_API_KEY, "adjusted": "true"}, timeout=30)
        except requests.exceptions.RequestException as e:
            print(f"  Request error for {d}: {e}"); d -= timedelta(days=1); checked += 1; continue

        if r.status_code == 429:
            print(f"  429 on grouped bars for {d} — waiting 60s and retrying")
            time.sleep(60)
            continue  # retry same date — don't count this as a lookback step

        if r.ok:
            data = r.json().get("results", [])
            if data:
                return d, data
            print(f"  No data for {d} (market closed) — trying previous day")
        else:
            print(f"  HTTP {r.status_code} for {d} — trying previous day")

        d -= timedelta(days=1)
        checked += 1

    return None, []


session_date, bars = fetch_grouped_bars(date.today())
if not bars:
    print("No trading session found in lookback window — nothing to update.")
    conn.close()
    sys.exit(0)

print(f"Using session {session_date} — {len(bars)} tickers reported market-wide")

bar_by_ticker = {b["T"]: b for b in bars if "T" in b}

written = 0; skipped = 0
with conn.cursor() as cur:
    for ticker in sorted(tickers):
        bar = bar_by_ticker.get(ticker)
        if not bar:
            skipped += 1; continue
        close, ts = bar.get("c"), bar.get("t")
        if not close or not ts:
            skipped += 1; continue
        bar_date = date.fromtimestamp(ts / 1000)
        cur.execute("""
            INSERT INTO public.prices_history (ticker, date, close)
            VALUES (%s, %s, %s)
            ON CONFLICT (ticker, date) DO UPDATE SET close = EXCLUDED.close
        """, (ticker, bar_date, round(float(close), 4)))
        written += 1

conn.commit()

# Refresh the benchmark table too, from the SAME grouped-daily response
# already fetched above — not a second API call. This is what keeps
# benchmark_prices current going forward after the one-time deep backfill
# (Nasdaq.com's manual CSV export, since neither Polygon's nor Alpha
# Vantage's free tiers could deliver full history — see
# import_benchmark_csv.py for that story). Polygon's free tier is exactly
# the right fit for THIS part: one recent day, not years of history.
benchmark_bar = bar_by_ticker.get(BENCHMARK_SYMBOL)
if benchmark_bar:
    close, ts = benchmark_bar.get("c"), benchmark_bar.get("t")
    if close and ts:
        bar_date = date.fromtimestamp(ts / 1000)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO public.benchmark_prices (symbol, date, close)
                VALUES (%s, %s, %s)
                ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
            """, (BENCHMARK_SYMBOL, bar_date, round(float(close), 4)))
        conn.commit()
        print(f"Also refreshed benchmark_prices for {BENCHMARK_SYMBOL} ({bar_date}, close={close})")
    else:
        print(f"{BENCHMARK_SYMBOL} was in the session data but missing close/timestamp — benchmark not refreshed this run")
else:
    print(f"{BENCHMARK_SYMBOL} not found in this session's grouped-daily data — benchmark not refreshed this run")

conn.close()
print(f"\nDone. Written: {written}  Skipped (not in session data): {skipped}")
