"""
Rebuild year CSVs from Neon and upload to R2.

Run locally:
  python rebuild_csvs.py

Then rebuild the ZIP:
  cd /tmp/seli-export && rm -f full-export.zip
  zip full-export.zip *.csv
  wrangler r2 object put database/csv-export/full-export.zip --file full-export.zip --content-type application/zip --remote

Requires: pip install psycopg[binary]
          NEON database URL in DATABASE_URL env var or .env file
"""

import os, sys, json, csv, io
from datetime import datetime
from pathlib import Path
from collections import defaultdict

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "")
OUTPUT_DIR = Path("/tmp/seli-export")
COLUMNS = [
    "transaction_date", "filing_date", "ticker", "company_name",
    "insider_name", "insider_title", "relationship",
    "transaction_type", "transaction_code", "is_open_market",
    "shares", "price_per_share", "value",
    "shares_owned_after", "pct_owned_change", "sector",
    "accession_number", "cik_issuer"
]

def get_connection():
    try:
        import psycopg
        return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2
        return psycopg2.connect(DATABASE_URL)


def main():
    if not DATABASE_URL:
        print("DATABASE_URL not set"); sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    cur = conn.cursor()

    print("Querying Neon for all filings...")
    cur.execute(f"""
        SELECT {', '.join(COLUMNS)}
        FROM public.filings
        ORDER BY COALESCE(transaction_date, filing_date) DESC
    """)

    rows = cur.fetchall()
    print(f"  {len(rows):,} total rows")

    # Group by year
    by_year = defaultdict(list)
    for row in rows:
        tx_date = row[0]  # transaction_date
        filing_date = row[1]  # filing_date
        effective = tx_date or filing_date
        if effective:
            year = str(effective.year) if hasattr(effective, 'year') else str(effective)[:4]
        else:
            year = "unknown"
        by_year[year].append(row)

    years_written = []
    total_written = 0

    for year in sorted(by_year.keys()):
        year_rows = by_year[year]
        filepath = OUTPUT_DIR / f"seli_insider_trades_{year}.csv"

        with open(filepath, 'w', newline='') as f:
            header = [
                "Transaction Date", "Filing Date", "Ticker", "Company Name",
                "Insider Name", "Insider Title", "Relationship",
                "Transaction Type", "Transaction Code", "Is Open Market",
                "Shares", "Price Per Share", "Value",
                "Shares Owned After", "Pct Owned Change", "Sector",
                "Accession Number", "CIK Issuer"
            ]
            writer = csv.writer(f)
            writer.writerow(header)
            for row in year_rows:
                writer.writerow([
                    str(v) if v is not None else '' for v in row
                ])

        size_mb = filepath.stat().st_size / 1_048_576
        print(f"  {year}: {len(year_rows):,} rows → {filepath.name} ({size_mb:.1f} MB)")
        if year != "unknown":
            years_written.append({"year": year, "totalRows": len(year_rows)})
        total_written += len(year_rows)

    # Write manifest
    manifest = {
        "builtThrough": datetime.utcnow().strftime("%Y-%m-%d"),
        "totalRows": total_written,
        "years": sorted(years_written, key=lambda y: y["year"]),
        "undatedRows": len(by_year.get("unknown", [])),
        "updatedAt": datetime.utcnow().isoformat() + "Z",
    }
    manifest_path = OUTPUT_DIR / "manifest.json"
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f)
    print(f"\n  Manifest: {total_written:,} rows across {len(years_written)} years")

    conn.close()

    print(f"\nFiles written to {OUTPUT_DIR}")
    print(f"\nNext steps:")
    print(f"  1. Upload CSVs to R2:")
    print(f"     for f in {OUTPUT_DIR}/seli_insider_trades_*.csv; do")
    print(f'       year=$(echo "$f" | grep -oP "\\d{{4}}"); ')
    print(f'       wrangler r2 object put "database/csv-export/${{year}}.csv" --file "$f" --content-type text/csv --remote')
    print(f"     done")
    print(f"  2. Upload manifest:")
    print(f"     wrangler r2 object put database/csv-export/manifest.json --file {manifest_path} --content-type application/json --remote")
    print(f"  3. Rebuild ZIP:")
    print(f"     cd {OUTPUT_DIR} && zip full-export.zip seli_insider_trades_*.csv")
    print(f"     wrangler r2 object put database/csv-export/full-export.zip --file {OUTPUT_DIR}/full-export.zip --content-type application/zip --remote")


if __name__ == "__main__":
    main()
