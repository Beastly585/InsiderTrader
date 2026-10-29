#!/usr/bin/env python3
"""
db/mark_offerings.py
One-time job: marks past purchases made in a stock offering (filings.offering,
taken out of the open-market counts), using public.mark_offering_trades() from
db/migrations/2026-10-28_offerings.sql. The ingest checks new filings itself,
so this only covers history.

Month by month, saving after each; stop and re-run any time.

    cd db
    python mark_offerings.py
    python mark_reversals.py      # then refresh reversals (they count open-market trades only)

Needs DATABASE_URL in db/.env and STEPS 1-2 of the migration already run.
"""
from mark_reversals import run

if __name__ == "__main__":
    run("mark_offering_trades", "2026-10-28_offerings.sql",
        "SELECT COUNT(*) FROM public.filings WHERE offering",
        lambda rows: f"Offering purchases on record: {rows[0][0]:,}.")
