#!/usr/bin/env python3
"""
db/mark_planned.py
One-time job: marks past open-market buys and sales that were made under a
10b5-1 trading plan (filings.planned = true), from their saved footnotes.
New filings are marked by the ingest itself, so this only covers history.

Use this instead of STEP 2 of db/migrations/2026-10-22_ingest_runs_and_planned.sql:
one big UPDATE over years of trades times out in Neon's SQL editor. This finds
the planned trades in one read, then marks them a few thousand at a time and
saves after each batch, so there's no time limit and stopping it (Ctrl-C) loses
nothing. Run it again any time; trades already marked are skipped.

Only planned trades are written. Everything else is left as it is (NULL), which
the site and emails read as "not planned".

    cd db
    python mark_planned.py

Needs DATABASE_URL in db/.env and STEP 1 of the migration already run.
"""
import os
import sys
import time
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "")
BATCH = int(os.environ.get("BATCH", "5000"))

# Same rule as plan_mentioned() in fetch_filings_neon.py: the footnote mentions
# a 10b5-1 plan, and doesn't say the trade was NOT under one.
RULE = """transaction_code IN ('P', 'S')
          AND footnotes ~* '10b5-?1'
          AND footnotes !~* '\\mnot\\M[^.;]{0,40}10b5-?1'
          AND planned IS DISTINCT FROM true"""


def connect():
    try:
        import psycopg
        return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2
        return psycopg2.connect(DATABASE_URL)


def main():
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is required (db/.env).")
    conn = connect()
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")
    cur.execute("""SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'filings' AND column_name = 'planned'""")
    if not cur.fetchone():
        sys.exit("filings.planned doesn't exist yet. Run STEP 1 of db/migrations/2026-10-22_ingest_runs_and_planned.sql first.")

    t0 = time.time()
    print("Finding planned trades (one pass over the table, can take a few minutes)...", flush=True)
    cur.execute(f"SELECT ctid::text FROM public.filings WHERE {RULE}")
    ids = [r[0] for r in cur.fetchall()]
    conn.commit()
    print(f"  {len(ids):,} to mark ({time.time() - t0:.0f}s)", flush=True)

    done = 0
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        # The rule is checked again on each row, so a row that changed since
        # the read (the ingest re-saving it) can't be marked by mistake.
        cur.execute(f"UPDATE public.filings SET planned = true WHERE ctid = ANY(%s::tid[]) AND {RULE}", (chunk,))
        done += cur.rowcount
        conn.commit()
        print(f"  {min(i + BATCH, len(ids)):,}/{len(ids):,} checked, {done:,} marked", flush=True)

    cur.execute("""SELECT count(*) FILTER (WHERE transaction_code = 'S'), count(*) FILTER (WHERE transaction_code = 'P')
                     FROM public.filings WHERE planned""")
    s, p = cur.fetchone()
    conn.close()
    print(f"Done in {time.time() - t0:.0f}s. Planned trades on record: {s:,} sales, {p:,} buys.")


if __name__ == "__main__":
    main()
