#!/usr/bin/env python3
"""
db/diagnose_house.py
Shows exactly what fetch_political_trades.py sees in House filings that
produce no trades, so we can tell a parser problem from a missing-data one.
Read-only: it never writes to the database.

    python diagnose_house.py                 # 5 filings from 2025 not in the DB
    python diagnose_house.py --year 2024 --n 3
    python diagnose_house.py --doc 20026535 --year 2025   # one specific filing
"""
import argparse, io, os, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fetch_political_trades as F  # same parser, same regexes

ap = argparse.ArgumentParser()
ap.add_argument("--year", type=int, default=2025)
ap.add_argument("--n", type=int, default=5)
ap.add_argument("--doc", help="a specific DocID")
args = ap.parse_args()

# 1. How existing Congress rows are labelled (old imports may use another format).
try:
    conn = F.get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT split_part(accession_number, '-', 1) AS prefix, COUNT(*),
                   MIN(COALESCE(transaction_date, filing_date)), MAX(COALESCE(transaction_date, filing_date))
              FROM public.filings WHERE transaction_code LIKE 'CONGRESS%%'
             GROUP BY 1 ORDER BY 2 DESC LIMIT 8""")
        print("Congress rows in the DB by ID prefix:")
        for p, n, lo, hi in cur.fetchall():
            print(f"  {p!r:12} {n:>7,} rows   {lo} -> {hi}")
        cur.execute("""
            SELECT EXTRACT(YEAR FROM COALESCE(transaction_date, filing_date))::int AS yr,
                   COUNT(*) FILTER (WHERE insider_title = 'House'), COUNT(*) FILTER (WHERE insider_title = 'Senate'), COUNT(*)
              FROM public.filings WHERE transaction_code LIKE 'CONGRESS%%'
             GROUP BY 1 ORDER BY 1""")
        print("\nCongress trades by year (House / Senate / all):")
        for yr, h, s_, n in cur.fetchall():
            print(f"  {yr}  {h:>6,}  {s_:>6,}  {n:>7,}")
        cur.execute("SELECT accession_number FROM public.filings WHERE transaction_code LIKE 'CONGRESS%%' ORDER BY random() LIMIT 3")
        print("\nSample IDs:", [r[0] for r in cur.fetchall()])
    existing = F.get_existing_accessions()
except Exception as e:
    print(f"(DB check skipped: {e})")
    existing = set()

# 2. Pick filings the backfill would fetch.
index = F.fetch_house_index(args.year)
done = {a.split("-")[1] for a in existing if a.startswith("house-")}
if args.doc:
    picks = [m for m in index if m["doc_id"] == args.doc] or [{"doc_id": args.doc, "name": "?", "filed": None, "year": args.year,
             "pdf_url": f"{F.HOUSE_BASE}/public_disc/ptr-pdfs/{args.year}/{args.doc}.pdf"}]
else:
    picks = [m for m in index if m["doc_id"] not in done][:args.n]
print(f"\n{len(index)} PTRs in the {args.year} index, {len([m for m in index if m['doc_id'] not in done])} not in the DB. Checking {len(picks)}:\n")

# 3. For each: download, extract text, try the trade-row pattern.
for m in picks:
    print("=" * 78)
    print(f"DocID {m['doc_id']}  {m['name']}  filed {m['filed']}\n{m['pdf_url']}")
    r = F.requests.get(m["pdf_url"], headers={"User-Agent": F.UA}, timeout=30)
    print(f"HTTP {r.status_code}  {r.headers.get('content-type')}  {len(r.content):,} bytes")
    if r.status_code != 200:
        continue
    import pdfplumber
    with pdfplumber.open(io.BytesIO(r.content)) as pdf:
        lines = [l for p in pdf.pages for l in (p.extract_text() or "").splitlines()]
        print(f"{len(pdf.pages)} page(s), {len(lines)} text line(s)")
    if not lines:
        print("-> No text: a scanned paper filing. Nothing a text parser can read.")
        continue
    matched = [l for l in lines if F.TX_RE.match(l.strip())]
    print(f"-> {len(matched)} line(s) match the trade-row pattern; parser returns {len(F.parse_house_pdf_text(r.content, m))} trade(s)")
    print("First 25 lines of text:")
    for l in lines[:25]:
        print("   |", l)
print("=" * 78)
