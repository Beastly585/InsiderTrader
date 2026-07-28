#!/usr/bin/env python3
"""
db/import_benchmark_csv.py
Loads a manually-downloaded historical price CSV into public.benchmark_prices.

Built specifically for Nasdaq.com's own "Download Historical Data" export
format (Date,Close/Last,Volume,Open,High,Low, with Date as MM/DD/YYYY) —
a real, free, no-login source that neither the Polygon nor Alpha Vantage
free tiers could actually deliver full history through. This is a genuine
one-time-download-then-import approach, not an automated scrape of
anything — you download the CSV yourself through Nasdaq's own UI, this
script just loads the file you already have on disk.

Usage:
  python3 import_benchmark_csv.py --file HistoricalData_XXXX.csv --dry-run
  python3 import_benchmark_csv.py --file HistoricalData_XXXX.csv
  python3 import_benchmark_csv.py --file other.csv --symbol QQQ
"""
from __future__ import annotations
import os, sys, csv, argparse, logging
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    log.error("DATABASE_URL required"); sys.exit(1)


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


def parse_nasdaq_csv(path: str) -> list[tuple[str, float]]:
    """Returns a list of (iso_date, close) tuples. Nasdaq's own export
    format specifically: Date is MM/DD/YYYY, Close/Last is the column name
    (not just 'Close') — both handled explicitly here rather than assumed
    to match some other provider's column naming."""
    rows = []
    skipped = 0
    with open(path, newline='') as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or 'Date' not in reader.fieldnames or 'Close/Last' not in reader.fieldnames:
            log.error(f"Unexpected CSV columns: {reader.fieldnames} — expected Date and Close/Last (Nasdaq's export format)")
            sys.exit(1)
        for r in reader:
            date_str = (r.get('Date') or '').strip()
            close_str = (r.get('Close/Last') or '').strip()
            if not date_str or not close_str:
                skipped += 1
                continue
            try:
                iso_date = datetime.strptime(date_str, "%m/%d/%Y").date().isoformat()
                close = float(close_str)
            except ValueError:
                log.warning(f"Skipping unparseable row: {r}")
                skipped += 1
                continue
            rows.append((iso_date, close))
    if skipped:
        log.info(f"Skipped {skipped} row(s) with missing/unparseable data")
    return rows


def main():
    ap = argparse.ArgumentParser(description="Import a manually-downloaded historical price CSV into public.benchmark_prices")
    ap.add_argument("--file", required=True, help="Path to the downloaded CSV")
    ap.add_argument("--symbol", default="SPY", help="Symbol this data represents (default: SPY)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not Path(args.file).exists():
        log.error(f"File not found: {args.file}"); sys.exit(1)

    log.info(f"Parsing {args.file} for symbol {args.symbol}...")
    rows = parse_nasdaq_csv(args.file)

    if not rows:
        log.error("No usable rows parsed — nothing to write."); sys.exit(1)

    rows.sort(key=lambda r: r[0])
    log.info(f"Parsed {len(rows)} rows, covering {rows[0][0]} to {rows[-1][0]}")

    if args.dry_run:
        log.info("[DRY RUN] Would write the following sample:")
        for d, c in rows[:3] + rows[-3:]:
            log.info(f"  {d}  close={c}")
        return

    conn = get_connection()
    written = 0
    # Commit every 250 rows, not once at the very end — with 2,500+ rows
    # and no progress output, a single all-or-nothing commit means an
    # interruption or a failure partway through loses everything already
    # written, and gives no visible sign the script is still working in the
    # meantime. Neither is necessary here.
    COMMIT_EVERY = 250
    with conn.cursor() as cur:
        for iso_date, close in rows:
            cur.execute("""
                INSERT INTO public.benchmark_prices (symbol, date, close)
                VALUES (%s, %s, %s)
                ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
            """, (args.symbol, iso_date, round(close, 4)))
            written += 1
            if written % COMMIT_EVERY == 0:
                conn.commit()
                log.info(f"  ...{written}/{len(rows)} rows written and committed")
    conn.commit()  # final commit for whatever's left since the last checkpoint
    conn.close()
    log.info(f"Done. Wrote {written} row(s) for {args.symbol} into public.benchmark_prices.")


if __name__ == "__main__":
    main()
