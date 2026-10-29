#!/usr/bin/env python3
"""
db/mark_reversals.py
One-time job: marks reversals (filings.reversal = 'buy' / 'sell') across all
history, using public.mark_reversals() from
db/migrations/2026-10-24_reversals.sql. The ingest marks new filings itself
after every run, so this only covers the past.

Works one month at a time and saves after each, so there's no time limit and
stopping it (Ctrl-C) loses nothing. Run it again any time; months that are
already right change nothing. A dropped connection reconnects and retries.

    cd db
    python mark_reversals.py              # everything since 2013
    python mark_reversals.py --since 2024-01-01

Needs DATABASE_URL in db/.env and STEPS 1-2 of the migration already run.
"""
import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def connect():
    try:
        import psycopg
        conn = psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2
        conn = psycopg2.connect(DATABASE_URL)
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
    conn.commit()
    return conn


def months(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        first = date(y, m, 1)
        y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
        last = date.fromordinal(date(y2, m2, 1).toordinal() - 1)
        yield max(first, start), min(last, end)
        y, m = y2, m2


def run(fn: str, migration: str, summary_sql: str, summary):
    """Calls public.<fn>(month_start, month_end) for every month since --since."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2013-01-01")
    args = ap.parse_args()
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is required (db/.env).")

    conn = connect()
    with conn.cursor() as cur:
        cur.execute(f"SELECT to_regproc('public.{fn}')")
        if cur.fetchone()[0] is None:
            sys.exit(f"public.{fn}() doesn't exist yet. Run the first steps of db/migrations/{migration} first.")
    conn.commit()

    t0, total = time.time(), 0
    for a, b in months(date.fromisoformat(args.since), date.today()):
        for attempt in range(1, 6):
            try:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT public.{fn}(%s::date, %s::date)", (a, b))
                    n = cur.fetchone()[0]
                conn.commit()
                break
            except Exception as e:
                if attempt == 5:
                    raise
                wait = 15 * attempt
                print(f"  {a:%Y-%m}: {str(e).splitlines()[0][:80]}; reconnecting in {wait}s", flush=True)
                try:
                    conn.close()
                except Exception:
                    pass
                time.sleep(wait)
                conn = connect()
        total += n
        print(f"  {a:%Y-%m}: {n:,} marked", flush=True)

    with conn.cursor() as cur:
        cur.execute(summary_sql)
        rows = cur.fetchall()
    conn.close()
    print(f"Done in {time.time() - t0:.0f}s. {total:,} rows changed. {summary(rows)}")


if __name__ == "__main__":
    run("mark_reversals", "2026-10-24_reversals.sql",
        "SELECT reversal, COUNT(*) FROM public.filings WHERE reversal IS NOT NULL GROUP BY 1 ORDER BY 1",
        lambda rows: (lambda c: f"Reversals on record: {c.get('buy', 0):,} buys, {c.get('sell', 0):,} sales.")(dict(rows)))
