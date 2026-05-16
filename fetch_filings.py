#!/usr/bin/env python3
"""
supabase/fetch_filings.py
─────────────────────────────────────────────────────────────────────────────
Fetches recent SEC Form 4 filings from EDGAR, parses the XML for real
transaction data (shares, price, buy/sell), and upserts into Supabase.

Run manually:   python fetch_filings.py
Run as cron:    0 18 * * 1-5 /usr/bin/python3 /path/to/fetch_filings.py
                (weekdays at 6 PM ET, after markets close)

Requirements:   pip install requests supabase python-dateutil

Environment variables (set in .env or your CI/CD secrets):
  SUPABASE_URL       https://your-project.supabase.co
  SUPABASE_SERVICE   your-service-role-key   (NOT the anon key — needs write access)
  DAYS_BACK          how many days to fetch (default: 3)
"""

import os
import re
import time
import logging
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from typing import Optional

import requests
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SUPABASE_URL     = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE = os.environ["SUPABASE_SERVICE"]
DAYS_BACK        = int(os.environ.get("DAYS_BACK", "3"))

EDGAR_SEARCH     = "https://efts.sec.gov/LATEST/search-index"
EDGAR_FILING_BASE= "https://www.sec.gov/Archives/edgar/full-index"
EDGAR_DOC_BASE   = "https://www.sec.gov"
USER_AGENT       = "insider-tracker/1.0 (your@email.com)"   # SEC requires this

HEADERS = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"}

# ── Sector lookup (same as frontend) ─────────────────────────────────────────

SECTOR_MAP = {
    "Technology":               ["AAPL","MSFT","GOOGL","META","NVDA","AMZN","TSLA","INTC","AMD","ORCL","CRM","ADBE","QCOM","TXN","AVGO","NOW","SNOW","PLTR"],
    "Finance":                  ["JPM","BAC","WFC","GS","MS","C","BLK","AXP","V","MA","SCHW","USB","PNC","TFC","COF"],
    "Healthcare":               ["JNJ","PFE","UNH","ABBV","MRK","LLY","BMY","AMGN","GILD","CVS","MDT","ABT","TMO","DHR"],
    "Energy":                   ["XOM","CVX","COP","SLB","PSX","EOG","MPC","VLO","PXD","OXY","HES"],
    "Consumer Staples":         ["WMT","PG","KO","PEP","COST","PM","MO","CL","GIS","KHC"],
    "Consumer Discretionary":   ["HD","MCD","NKE","SBUX","LOW","TGT","TJX","EBAY"],
    "Industrials":               ["HON","UNP","BA","CAT","GE","MMM","DE","EMR","ETN","ITW","LMT","RTX"],
    "Real Estate":               ["AMT","PLD","EQIX","CCI","SPG","O","WELL","DLR"],
    "Utilities":                 ["NEE","DUK","SO","AEP","EXC","SRE"],
    "Communication Services":    ["META","GOOGL","NFLX","DIS","VZ","T","CMCSA","TMUS"],
    "Materials":                 ["LIN","APD","ECL","SHW","FCX","NEM"],
}

TICKER_SECTOR = {t: s for s, ts in SECTOR_MAP.items() for t in ts}

def get_sector(ticker: str) -> str:
    return TICKER_SECTOR.get((ticker or "").upper(), "Other")

def get_relationship(title: str) -> str:
    t = (title or "").lower()
    if re.search(r"chief|ceo|cfo|coo|cto|president", t):
        return "strong"
    if re.search(r"officer|svp|evp|senior v|managing", t):
        return "medium"
    return "weak"

# ── EDGAR helpers ─────────────────────────────────────────────────────────────

def edgar_search(start_date: str, end_date: str, start: int = 0, size: int = 40) -> list[dict]:
    """Return raw hits from EDGAR full-text search."""
    params = {
        "forms": "4",
        "dateRange": "custom",
        "startdt": start_date,
        "enddt": end_date,
        "from": start,
        "hits.hits.total.value": "true",
    }
    resp = requests.get(EDGAR_SEARCH, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json().get("hits", {}).get("hits", [])


def fetch_filing_xml(accession_raw: str, cik: str) -> Optional[str]:
    """
    Given a raw accession number like 0001234567-24-001234 and CIK,
    download the primary Form 4 XML document.
    Returns the XML string or None on failure.
    """
    accession = accession_raw.replace("-", "")
    index_url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=4&dateb=&owner=include&count=1&search_text="
    # Faster: directly construct the filing index URL
    idx_url = f"{EDGAR_DOC_BASE}/Archives/edgar/data/{cik}/{accession}/{accession_raw}-index.htm"
    try:
        r = requests.get(idx_url, headers=HEADERS, timeout=20)
        # Find the .xml link in the index page
        match = re.search(r'href="(/Archives/edgar/data/[^"]+\.xml)"', r.text)
        if not match:
            return None
        xml_url = EDGAR_DOC_BASE + match.group(1)
        time.sleep(0.15)   # be polite to SEC servers
        xr = requests.get(xml_url, headers=HEADERS, timeout=20)
        xr.raise_for_status()
        return xr.text
    except Exception as e:
        log.warning(f"XML fetch failed for {accession_raw}: {e}")
        return None


def parse_form4_xml(xml_text: str) -> list[dict]:
    """
    Parse a Form 4 XML and return a list of transaction dicts.
    Handles both nonDerivativeTransaction and derivativeTransaction tables.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.warning(f"XML parse error: {e}")
        return []

    ns = ""  # Form 4 XML has no namespace

    def text(el, tag) -> Optional[str]:
        node = el.find(tag)
        return node.text.strip() if node is not None and node.text else None

    # Issuer info
    issuer_el = root.find("issuer")
    company    = text(issuer_el, "issuerName")       if issuer_el else None
    ticker     = text(issuer_el, "issuerTradingSymbol") if issuer_el else None

    # Reporting owner
    owner_el   = root.find(".//reportingOwner")
    insider    = text(owner_el, ".//rptOwnerName")   if owner_el else None
    title      = text(owner_el, ".//officerTitle")   if owner_el else None
    is_officer = text(owner_el, ".//isOfficer")      if owner_el else "0"
    is_dir     = text(owner_el, ".//isDirector")     if owner_el else "0"
    is_ten     = text(owner_el, ".//isTenPercentOwner") if owner_el else "0"

    if not title:
        if is_officer == "1": title = "Officer"
        elif is_dir   == "1": title = "Director"
        elif is_ten   == "1": title = "10% Owner"
        else:                  title = "Unknown"

    transactions = []

    for tbl_tag in ("nonDerivativeTable", "derivativeTable"):
        tbl = root.find(tbl_tag)
        if tbl is None:
            continue
        for tx_tag in ("nonDerivativeTransaction", "derivativeTransaction"):
            for tx in tbl.findall(tx_tag):
                # Transaction date
                tx_date = text(tx, ".//transactionDate/value")
                # Acquired (A) or Disposed (D)
                acq_disp = text(tx, ".//transactionAcquiredDisposedCode/value")
                # Shares
                shares_el = tx.find(".//transactionShares/value")
                shares_str = shares_el.text.strip() if shares_el is not None and shares_el.text else None
                # Price
                price_el = tx.find(".//transactionPricePerShare/value")
                price_str = price_el.text.strip() if price_el is not None and price_el.text else None
                # Security name (for derivatives)
                security = text(tx, "securityTitle/value") or text(tx, "derivativeSecurityTitle/value")

                try:
                    shares = float(shares_str) if shares_str else None
                    price  = float(price_str)  if price_str  else None
                except ValueError:
                    shares = price = None

                tx_type = "buy" if acq_disp == "A" else "sell" if acq_disp == "D" else "other"

                transactions.append({
                    "company_name":      company,
                    "ticker":            ticker,
                    "insider_name":      insider,
                    "insider_title":     title,
                    "transaction_type":  tx_type,
                    "shares":            shares,
                    "price_per_share":   price,
                    "filing_date":       tx_date,
                    "security_title":    security,
                    "relationship":      get_relationship(title),
                    "sector":            get_sector(ticker or ""),
                })

    return transactions

# ── Main ingestion loop ───────────────────────────────────────────────────────

def run():
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE)

    end_date   = date.today().isoformat()
    start_date = (date.today() - timedelta(days=DAYS_BACK)).isoformat()

    log.info(f"Fetching Form 4 filings from {start_date} to {end_date}")

    all_filings = []
    start       = 0
    page_size   = 40

    while True:
        hits = edgar_search(start_date, end_date, start=start, size=page_size)
        if not hits:
            break
        log.info(f"  Got {len(hits)} hits (offset {start})")
        all_filings.extend(hits)
        if len(hits) < page_size:
            break
        start += page_size
        time.sleep(0.5)  # rate-limit courtesy

    log.info(f"Total hits: {len(all_filings)}")

    rows = []
    for hit in all_filings:
        s          = hit.get("_source", {})
        accession  = hit.get("_id", "")
        cik        = accession.split("-")[0] if accession else ""

        # Option A: just upsert the index-level data (no XML parse — fast)
        # Uncomment if you want full transaction data, then use Option B below.
        display_names = s.get("display_names", [])
        insider = (display_names[0] or "").replace(r"\s*\(.*\)\s*$", "").strip()
        title_m = re.search(r"\(([^)]+)\)", display_names[0] or "")
        title   = title_m.group(1) if title_m else ""

        rows.append({
            "accession_number": accession,
            "filing_date":      s.get("period_of_report") or s.get("file_date"),
            "company_name":     s.get("entity_name", "Unknown"),
            "ticker":           None,   # needs XML parse for full accuracy
            "insider_name":     insider,
            "insider_title":    title,
            "transaction_type": None,   # needs XML parse
            "shares":           None,   # needs XML parse
            "price_per_share":  None,   # needs XML parse
            "relationship":     get_relationship(title),
            "sector":           "Other",
        })

    # Option B: full XML parse (slower, more accurate — uncomment to enable)
    # rows = []
    # for hit in all_filings:
    #     accession = hit.get("_id", "")
    #     cik = accession.split("-")[0]
    #     xml = fetch_filing_xml(accession, cik)
    #     if xml:
    #         txns = parse_form4_xml(xml)
    #         for t in txns:
    #             t["accession_number"] = accession
    #             rows.append(t)
    #         time.sleep(0.2)

    if not rows:
        log.info("No rows to upsert.")
        return

    # Upsert in batches of 100
    batch_size = 100
    inserted   = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        result = (
            supabase.table("filings")
            .upsert(batch, on_conflict="accession_number")
            .execute()
        )
        inserted += len(batch)
        log.info(f"  Upserted batch {i//batch_size + 1} ({len(batch)} rows)")

    log.info(f"Done. {inserted} rows upserted to Supabase.")


if __name__ == "__main__":
    run()
