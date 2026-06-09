#!/usr/bin/env python3
"""
db/fetch_political_trades.py
─────────────────────────────────────────────────────────────────────────────
Scrapes congressional stock trades from official government sources:

  House:  disclosures-clerk.house.gov  (XML index → PDF text parsing)
  Senate: efdsearch.senate.gov         (CSRF session → DataTables → HTML PTRs)

No API key required. Writes to public.filings alongside SEC Form 4 data.
transaction_code = 'CONGRESS_P' (buy) or 'CONGRESS_S' (sell) — never
conflicts with SEC codes (P, S, A, M, F, G, D...).

Usage:
    python fetch_political_trades.py              # both chambers, last 90 days
    python fetch_political_trades.py --house      # House only
    python fetch_political_trades.py --senate     # Senate only
    python fetch_political_trades.py --days 365   # last year
    python fetch_political_trades.py --dry-run    # parse, don't write

Requirements:
    pip install beautifulsoup4 pdfplumber --break-system-packages
─────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import os, re, sys, time, json, io, logging, argparse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from typing import Optional
from pathlib import Path

import requests
from dotenv import load_dotenv

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

try:
    import pdfplumber
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "")
DRY_RUN      = os.environ.get("DRY_RUN", "0") == "1"
HOUSE_SLEEP  = 1.0    # seconds between PDF downloads
SENATE_SLEEP = 1.5    # seconds between PTR HTML fetches

UA           = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
HOUSE_BASE   = "https://disclosures-clerk.house.gov"
SENATE_BASE  = "https://efdsearch.senate.gov"

# ── Sector lookup ──────────────────────────────────────────────────────────────
SECTOR_MAP = {
    "Technology":             ["AAPL","MSFT","GOOGL","GOOG","META","NVDA","AMZN","TSLA","INTC","AMD","ORCL","CRM","ADBE","QCOM","TXN","AVGO","NOW","SNOW","PLTR","IBM","CSCO","INTU","DDOG","PANW","CRWD","NET","MDB","OKTA"],
    "Finance":                ["JPM","BAC","WFC","GS","MS","C","BLK","AXP","V","MA","SCHW","USB","PNC","TFC","COF","SPGI","MCO","ICE","CME","BX","KKR","APO"],
    "Healthcare":             ["JNJ","PFE","UNH","ABBV","MRK","LLY","BMY","AMGN","GILD","CVS","MDT","ABT","TMO","DHR","ISRG","REGN","VRTX","BIIB","BSX","SYK"],
    "Energy":                 ["XOM","CVX","COP","SLB","PSX","EOG","MPC","VLO","OXY","HES","DVN","HAL","BKR","WMB","KMI","ET","EPD","LNG"],
    "Consumer Staples":       ["WMT","PG","KO","PEP","COST","PM","MO","CL","GIS","KHC","HSY","MKC","TSN"],
    "Consumer Discretionary": ["AMZN","HD","MCD","NKE","SBUX","LOW","TGT","TJX","EBAY","ROST","BKNG","ABNB","MAR","HLT","CMG"],
    "Industrials":            ["HON","UNP","BA","CAT","GE","MMM","DE","EMR","ETN","ITW","LMT","RTX","NOC","GD","FDX","UPS","DAL"],
    "Real Estate":            ["AMT","PLD","EQIX","CCI","SPG","O","WELL","DLR","PSA","EXR"],
    "Utilities":              ["NEE","DUK","SO","AEP","EXC","SRE","PCG","ED","FE","XEL","WEC"],
    "Communication Services": ["META","GOOGL","NFLX","DIS","VZ","T","CMCSA","TMUS","SNAP","RDDT"],
    "Materials":              ["LIN","APD","SHW","FCX","NEM","NUE","VMC","DOW","PPG"],
}
TICKER_SECTOR = {t: s for s, ts in SECTOR_MAP.items() for t in ts}
def get_sector(t): return TICKER_SECTOR.get((t or "").upper().strip(), "Other")

# ── Shared helpers ─────────────────────────────────────────────────────────────

def safe_date(v: Optional[str]) -> Optional[str]:
    if not v: return None
    v = str(v).strip()
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', v)
    if m: return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', v)
    if m: return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{2})$', v)
    if m:
        yr = int(m.group(3))
        return f"{2000+yr if yr < 50 else 1900+yr}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    return None

def parse_amount(s: Optional[str]) -> Optional[float]:
    if not s: return None
    nums = [float(n.replace(",","")) for n in re.findall(r'[\d,]+', str(s))]
    return round(sum(nums)/len(nums), 2) if nums else None

def member_slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]', '-', name.lower().strip())[:40].strip('-')

def classify_tx(tx_raw: str) -> tuple[str, str, str]:
    t = (tx_raw or "").lower()
    if re.match(r'p\b|purchase', t):
        return "buy",  "CONGRESS_P", "Congressional Purchase"
    if re.match(r's\b|sale|sold|sell|exchange', t):
        return "sell", "CONGRESS_S", "Congressional Sale"
    return "other", "CONGRESS_O", "Congressional Transaction"

# ── Data model — exact match to public.filings ─────────────────────────────────
COLUMNS = [
    "accession_number","cik","company_name","ticker","cik_issuer",
    "insider_name","insider_cik","insider_title","is_director","is_officer",
    "is_ten_pct_owner","filing_date","transaction_date","transaction_type",
    "transaction_code","transaction_code_label","is_open_market","is_derivative",
    "security_title","shares","price_per_share","value",
    "shares_owned_after","shares_owned_before","pct_owned_change",
    "direct_ownership","relationship","sector","footnotes",
]

@dataclass
class CongressTrade:
    accession_number: str;      cik: str
    company_name: Optional[str]  = None
    ticker: Optional[str]        = None
    cik_issuer: Optional[str]    = None
    insider_name: Optional[str]  = None
    insider_cik: Optional[str]   = None
    insider_title: Optional[str] = None
    is_director: bool            = False
    is_officer: bool             = False
    is_ten_pct_owner: bool       = False
    filing_date: Optional[str]   = None
    transaction_date: Optional[str] = None
    transaction_type: Optional[str] = None
    transaction_code: Optional[str] = None
    transaction_code_label: Optional[str] = None
    is_open_market: bool         = True
    is_derivative: bool          = False
    security_title: Optional[str] = None
    shares: Optional[float]      = None   # not disclosed in PTRs — always None
    price_per_share: Optional[float] = None
    value: Optional[float]       = None   # midpoint of disclosed range
    shares_owned_after: Optional[float]  = None
    shares_owned_before: Optional[float] = None
    pct_owned_change: Optional[float]    = None
    direct_ownership: bool       = True
    relationship: str            = "strong"
    sector: Optional[str]        = None
    footnotes: Optional[str]     = None

    def to_tuple(self):
        d = asdict(self)
        for k in ("shares","price_per_share","value",
                  "shares_owned_after","shares_owned_before","pct_owned_change"):
            if d[k] is not None: d[k] = round(float(d[k]), 4)
        return tuple(d[c] for c in COLUMNS)

# ── DB ──────────────────────────────────────────────────────────────────────────
UPSERT_SQL = f"""
INSERT INTO public.filings ({", ".join(COLUMNS)})
VALUES ({", ".join(["%s"]*len(COLUMNS))})
ON CONFLICT (accession_number, transaction_date, shares, transaction_code)
DO UPDATE SET
    company_name           = EXCLUDED.company_name,
    ticker                 = EXCLUDED.ticker,
    insider_name           = EXCLUDED.insider_name,
    insider_title          = EXCLUDED.insider_title,
    transaction_type       = EXCLUDED.transaction_type,
    transaction_code_label = EXCLUDED.transaction_code_label,
    is_open_market         = EXCLUDED.is_open_market,
    value                  = EXCLUDED.value,
    sector                 = EXCLUDED.sector,
    relationship           = EXCLUDED.relationship,
    footnotes              = EXCLUDED.footnotes,
    updated_at             = now()
"""

def get_conn():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

def write_batch(trades: list[CongressTrade]) -> int:
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.executemany(UPSERT_SQL, [t.to_tuple() for t in trades])
        conn.commit()
        return len(trades)
    finally:
        conn.close()

def get_existing_accessions() -> set[str]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT accession_number FROM public.filings
                WHERE transaction_code IN ('CONGRESS_P','CONGRESS_S','CONGRESS_O')
            """)
            return {r[0] for r in cur.fetchall()}
    finally:
        conn.close()

# ══════════════════════════════════════════════════════════════════════════════
# HOUSE — XML index + PDF text parsing
# ══════════════════════════════════════════════════════════════════════════════

# Regex matching a transaction line in a House PTR PDF:
# "Apple Inc. - Common Stock (AAPL) [ST]   S (partial)   03/16/2026   03/16/2026   $1,001 - $15,000"
TX_RE = re.compile(
    r'^(.+?)\s+'
    r'((?:Purchase|Sale|P|S)(?:\s*\((?:partial|full|Partial|Full)\))?)'
    r'\s+(\d{2}/\d{2}/\d{4})'      # transaction date
    r'\s+(\d{2}/\d{2}/\d{4})'      # notification date
    r'\s+(\$[\d,]+(?:\s*-\s*\$[\d,]+|\+)?)',  # amount
    re.IGNORECASE
)
TICKER_RE = re.compile(r'\(([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\)')
NOISE_RE  = re.compile(
    r'^(ID\s+Owner|S\s+O:|D:|F\s+S:|L:|Filing ID|Clerk of|Name:|Status:|State/|'
    r'ID\s+|Amendment|Page\s+\d|PTR\s*$|\s*$)',
    re.IGNORECASE
)

def parse_house_pdf_text(pdf_bytes: bytes, meta: dict) -> list[CongressTrade]:
    """
    Parse a House PTR PDF using text extraction.
    Strategy: scan every line for the transaction pattern (TX_RE).
    When a match has no ticker, check the NEXT line for a continuation
    like '(AMZN) [ST]' — this handles wrapped asset names.
    """
    if not HAS_PDF:
        return []

    trades  = []
    member  = meta.get("name", "Unknown")
    filed   = meta.get("filed")
    doc_id  = meta.get("doc_id", "")

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            # Collect all lines across all pages
            all_lines = []
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    all_lines.extend(text.splitlines())
    except Exception as e:
        log.debug(f"  pdfplumber error {doc_id}: {e}")
        return []

    i = 0
    while i < len(all_lines):
        line = all_lines[i].strip()
        # Clean null bytes that pdfplumber sometimes produces
        line = line.replace('\x00', '')
        i += 1

        if NOISE_RE.match(line):
            continue

        m = TX_RE.match(line)
        if not m:
            continue

        asset_raw = m.group(1).strip()
        tx_type   = m.group(2).strip()
        tx_date   = safe_date(m.group(3))
        # m.group(4) is notification date — not stored
        amount    = m.group(5).strip()
        value     = parse_amount(amount)

        if not tx_date:
            continue

        # Extract ticker from asset text
        ticker_m = TICKER_RE.search(asset_raw)
        ticker   = ticker_m.group(1) if ticker_m else None

        # If no ticker, peek at next line — handles wrapped asset names:
        # "PayPal Holdings, Inc. - Common   S (partial)   03/16/2026  ..."
        # "Stock (PYPL) [ST]"
        if not ticker and i < len(all_lines):
            next_line = all_lines[i].strip().replace('\x00','')
            ticker_m2 = TICKER_RE.match(next_line)
            if ticker_m2:
                ticker = ticker_m2.group(1)
                # Append the continuation to asset name
                asset_raw = asset_raw + " " + next_line
                i += 1  # consume the continuation line

        # Clean up asset name
        asset = re.sub(r'\s*\([A-Z./]{1,7}\)\s*', ' ', asset_raw).strip()
        asset = re.sub(r'\s*\[(ST|OT|OP|DC)\]\s*$', '', asset).strip()
        asset = re.sub(r'\s+', ' ', asset).strip()

        # Skip ETFs and non-stock assets if no ticker
        # (keep if we have a ticker — could be an ETF we want to track)
        if not ticker:
            al = asset.lower()
            if any(w in al for w in ["etf","fund","index","bond","treasury",
                                      "municipal","note","reit trust"]):
                continue

        # Validate ticker
        if ticker and not re.match(r'^[A-Z]{1,5}(?:\.[A-Z])?$', ticker):
            ticker = None

        tt, tc, tc_label = classify_tx(tx_type)
        tc_label += " (House)"
        ticker_safe = re.sub(r'[^A-Z0-9]', '', ticker or '')[:6] or f"t{len(trades)}"
        accession   = f"house-{doc_id}-{ticker_safe}-{tx_date}-{tc}"

        fn_parts = [f"Amount: {amount}"]
        trades.append(CongressTrade(
            accession_number  = accession,
            cik               = f"house-{member_slug(member)}",
            company_name      = asset[:200] or ticker,
            ticker            = ticker,
            insider_name      = member,
            insider_title     = "House",
            filing_date       = filed or tx_date,
            transaction_date  = tx_date,
            transaction_type  = tt,
            transaction_code  = tc,
            transaction_code_label = tc_label,
            is_open_market    = True,
            is_derivative     = False,
            security_title    = "Stock",
            shares            = None,
            value             = value,
            relationship      = "strong",
            sector            = get_sector(ticker),
            footnotes         = " | ".join(fn_parts),
        ))

    return trades

def fetch_house_index(year: int) -> list[dict]:
    url = f"{HOUSE_BASE}/public_disc/financial-pdfs/{year}FD.xml"
    log.info(f"  Downloading House {year} index…")
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=60)
        r.raise_for_status()
    except Exception as e:
        log.error(f"  House index error: {e}"); return []

    try:
        root = ET.fromstring(r.content)
    except ET.ParseError as e:
        log.error(f"  House XML parse error: {e}"); return []

    filings = []
    for f in root.findall("Member"):
        ft = (f.findtext("FilingType") or "").strip()
        if ft not in ("P", "X"):
            continue
        doc_id = (f.findtext("DocID") or "").strip()
        if not doc_id:
            continue
        first  = (f.findtext("First") or "").strip()
        last   = (f.findtext("Last")  or "").strip()
        filed  = safe_date(f.findtext("FilingDate") or "")

        # P = standard PTR → ptr-pdfs/
        # X = amendment PTR → also ptr-pdfs/ (confirmed by testing)
        pdf_url = f"{HOUSE_BASE}/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"

        filings.append({
            "doc_id":  doc_id,
            "name":    f"{first} {last}".strip(),
            "filed":   filed,
            "pdf_url": pdf_url,
            "year":    year,
        })

    log.info(f"  House {year}: {len(filings)} PTR filings in index")
    return filings

def fetch_house(from_date: date, to_date: date,
                existing: set[str]) -> list[CongressTrade]:
    if not HAS_PDF:
        log.warning("  pdfplumber not installed — install with:")
        log.warning("  pip install pdfplumber --break-system-packages")
        return []

    years = sorted(set(range(from_date.year, to_date.year+1)))
    all_index = []
    for yr in years:
        all_index.extend(fetch_house_index(yr))

    from_iso = from_date.isoformat()
    to_iso   = to_date.isoformat()
    relevant = [
        f for f in all_index
        if f.get("filed") and from_iso <= f["filed"] <= to_iso
        and f"house-{f['doc_id']}" not in {a[:len(f'house-{f["doc_id"]}')] for a in existing}
    ]
    log.info(f"  House: {len(relevant)}/{len(all_index)} PTRs in date range")

    all_trades: list[CongressTrade] = []
    for i, meta in enumerate(relevant, 1):
        if i % 20 == 0 or i == len(relevant):
            log.info(f"    House PDF {i}/{len(relevant)} — {len(all_trades)} trades")
        time.sleep(HOUSE_SLEEP)
        try:
            r = requests.get(meta["pdf_url"], headers={"User-Agent": UA}, timeout=30)
            if r.status_code == 404:
                log.debug(f"  404: {meta['pdf_url']}")
                continue
            r.raise_for_status()
            trades = parse_house_pdf_text(r.content, meta)
            # Dedup against existing
            new = [t for t in trades if t.accession_number not in existing]
            all_trades.extend(new)
        except Exception as e:
            log.debug(f"  House error {meta['doc_id']}: {e}")

    log.info(f"  House total: {len(all_trades)} new trades")
    return all_trades

# ══════════════════════════════════════════════════════════════════════════════
# SENATE — CSRF session + DataTables API + HTML PTR parsing
# ══════════════════════════════════════════════════════════════════════════════

def get_senate_session() -> tuple[Optional[requests.Session], Optional[str]]:
    if not HAS_BS4:
        log.error("  beautifulsoup4 not installed"); return None, None

    s = requests.Session()
    s.headers.update({"User-Agent": UA})

    try:
        r = s.get(f"{SENATE_BASE}/search/home/", timeout=20)
        r.raise_for_status()
    except Exception as e:
        log.error(f"  Senate GET failed: {e}"); return None, None

    soup  = BeautifulSoup(r.text, "html.parser")
    tok   = soup.find("input", {"name": "csrfmiddlewaretoken"})
    if not tok:
        log.error("  No CSRF token found"); return None, None
    token = tok["value"]
    log.info(f"  Senate: CSRF token obtained")

    try:
        r2 = s.post(f"{SENATE_BASE}/search/home/",
            data={"csrfmiddlewaretoken": token, "prohibition_agreement": "1"},
            headers={"Referer": f"{SENATE_BASE}/search/home/",
                     "Origin":  SENATE_BASE},
            allow_redirects=True, timeout=20)
        log.info(f"  Senate: agreement accepted ({r2.status_code})")
    except Exception as e:
        log.error(f"  Senate agreement failed: {e}"); return None, None

    return s, token

def fetch_senate_index(s: requests.Session, token: str,
                       from_date: date, to_date: date) -> list[dict]:
    endpoint  = f"{SENATE_BASE}/search/report/data/"
    from_str  = from_date.strftime("%m/%d/%Y")
    to_str    = to_date.strftime("%m/%d/%Y")
    page_size = 100
    start     = 0
    rows      = []

    while True:
        time.sleep(1.0)
        try:
            r = s.post(endpoint,
                data={
                    "csrfmiddlewaretoken":  token,
                    "report_types[]":       "11",
                    "filer_type":           "1",
                    "submitted_start_date": from_str,
                    "submitted_end_date":   to_str,
                    "start":  str(start),
                    "length": str(page_size),
                },
                headers={
                    "Referer":           f"{SENATE_BASE}/search/",
                    "Origin":            SENATE_BASE,
                    "X-CSRFToken":       token,
                    "X-Requested-With":  "XMLHttpRequest",
                    "Content-Type":      "application/x-www-form-urlencoded; charset=UTF-8",
                },
                timeout=30)
        except Exception as e:
            log.error(f"  Senate DataTables error: {e}"); break

        if r.status_code == 503:
            log.warning("  Senate 503 — site may be in maintenance"); break
        if r.status_code != 200:
            log.error(f"  Senate status {r.status_code}"); break

        try:
            data = r.json()
        except Exception:
            log.error("  Senate response not JSON — session expired?")
            log.debug(f"  Response: {r.text[:200]}"); break

        batch = data.get("data", [])
        if not batch: break

        for row in batch:
            if len(row) < 5: continue
            first = str(row[0]).strip()
            last  = str(row[1]).strip()
            filed = safe_date(str(row[4]).strip())
            url_m = re.search(r'href="([^"]+)"', str(row[5]) if len(row) > 5 else "")
            ptr   = url_m.group(1) if url_m else None
            if ptr and not ptr.startswith("http"):
                ptr = SENATE_BASE + ptr
            rows.append({
                "name":    f"{first} {last}".strip(),
                "filed":   filed,
                "ptr_url": ptr,
            })

        total = data.get("recordsTotal", 0)
        start += page_size
        log.info(f"    Senate index: {min(start,total)}/{total}")
        if start >= total: break

    log.info(f"  Senate: {len(rows)} PTR filings found")
    return rows

def parse_senate_html(html: str, meta: dict) -> list[CongressTrade]:
    """
    Parse a Senate electronic PTR HTML page.
    Table columns: Notification Date | Transaction Date | Owner | Ticker |
                   Asset Name | Asset Type | Type | Amount | Comment
    """
    if not HAS_BS4: return []

    trades  = []
    member  = meta.get("name", "Unknown")
    filed   = meta.get("filed")
    ptr_url = meta.get("ptr_url", "")

    url_id_m = re.search(r'/ptr/([a-f0-9\-]{10,})/?$', ptr_url)
    url_id   = url_id_m.group(1).replace("-","")[:20] if url_id_m else member_slug(member)

    soup   = BeautifulSoup(html, "html.parser")

    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) < 2: continue

        hdrs = [th.get_text(" ", strip=True).lower()
                for th in rows[0].find_all(["th","td"])]
        if not any("asset" in h or "ticker" in h for h in hdrs):
            continue

        def col(*kws):
            for kw in kws:
                for j,h in enumerate(hdrs):
                    if kw in h: return j
            return None

        ci_txdate  = col("transaction date", "transaction\ndate")
        ci_notify  = col("notification date")
        ci_owner   = col("owner")
        ci_ticker  = col("ticker")
        ci_asset   = col("asset name", "asset description", "asset")
        ci_atype   = col("asset type", "type of asset")
        ci_txtype  = col("transaction type", "type")
        ci_amount  = col("amount")
        ci_comment = col("comment")

        for row in rows[1:]:
            cells = row.find_all(["td","th"])
            if not cells: continue

            def cell(idx):
                if idx is None or idx >= len(cells): return ""
                return cells[idx].get_text(" ", strip=True)

            tx_date    = safe_date(cell(ci_txdate))
            owner      = cell(ci_owner)
            ticker     = cell(ci_ticker).upper().strip()
            asset      = cell(ci_asset)
            asset_type = cell(ci_atype)
            tx_type    = cell(ci_txtype)
            amount     = cell(ci_amount)
            comment    = cell(ci_comment)

            if not tx_date or not tx_type: continue
            at_lower = asset_type.lower()
            if any(w in at_lower for w in ["bond","treasury","municipal","note"]):
                continue

            tt, tc, tc_label = classify_tx(tx_type)
            tc_label += " (Senate)"

            clean_ticker = re.sub(r'[^A-Z.]', '', ticker)[:6]
            if clean_ticker in ("--","NA","N/A",""): clean_ticker = None
            if clean_ticker and not re.match(r'^[A-Z]{1,5}(?:\.[A-Z])?$', clean_ticker):
                clean_ticker = None

            ticker_safe = re.sub(r'[^A-Z0-9]', '', clean_ticker or '')[:6] or f"t{len(trades)}"
            accession   = f"senate-{url_id}-{ticker_safe}-{tx_date}-{tc}"

            fn_parts = []
            if amount:  fn_parts.append(f"Amount: {amount}")
            if owner:   fn_parts.append(f"Owner: {owner}")
            if comment: fn_parts.append(comment)

            trades.append(CongressTrade(
                accession_number  = accession,
                cik               = f"senate-{member_slug(member)}",
                company_name      = (asset or clean_ticker or "Unknown")[:200],
                ticker            = clean_ticker,
                insider_name      = member,
                insider_title     = "Senate",
                filing_date       = filed or tx_date,
                transaction_date  = tx_date,
                transaction_type  = tt,
                transaction_code  = tc,
                transaction_code_label = tc_label,
                is_open_market    = True,
                is_derivative     = "option" in at_lower,
                security_title    = asset_type or "Stock",
                shares            = None,
                value             = parse_amount(amount),
                relationship      = "strong",
                sector            = get_sector(clean_ticker),
                footnotes         = " | ".join(fn_parts) or None,
            ))

    return trades

def fetch_senate(from_date: date, to_date: date,
                 existing: set[str]) -> list[CongressTrade]:
    if not HAS_BS4:
        log.warning("  beautifulsoup4 not installed"); return []

    log.info("  Establishing Senate EFD session…")
    s, token = get_senate_session()
    if not s: return []

    filing_list = fetch_senate_index(s, token, from_date, to_date)
    if not filing_list: return []

    new_filings = [f for f in filing_list if f.get("ptr_url")]
    log.info(f"  Senate: fetching {len(new_filings)} PTR HTML pages…")

    all_trades: list[CongressTrade] = []
    for i, meta in enumerate(new_filings, 1):
        if i % 20 == 0 or i == len(new_filings):
            log.info(f"    Senate PTR {i}/{len(new_filings)} — {len(all_trades)} trades")
        time.sleep(SENATE_SLEEP)
        try:
            r = s.get(meta["ptr_url"],
                      headers={"Referer": f"{SENATE_BASE}/search/"},
                      timeout=25)
            if r.status_code != 200:
                log.debug(f"  PTR {r.status_code}: {meta['ptr_url']}"); continue
            trades = parse_senate_html(r.text, meta)
            new    = [t for t in trades if t.accession_number not in existing]
            all_trades.extend(new)
        except Exception as e:
            log.debug(f"  Senate PTR error: {e}")

    log.info(f"  Senate total: {len(all_trades)} new trades")
    return all_trades

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global DRY_RUN

    ap = argparse.ArgumentParser(description="Fetch congressional trades")
    ap.add_argument("--days",    type=int, default=90)
    ap.add_argument("--house",   action="store_true")
    ap.add_argument("--senate",  action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.dry_run: DRY_RUN = True
    if not DRY_RUN and not DATABASE_URL:
        log.error("DATABASE_URL not set in db/.env"); sys.exit(1)

    do_house  = args.house  or (not args.house and not args.senate)
    do_senate = args.senate or (not args.house and not args.senate)

    today     = date.today()
    from_date = today - timedelta(days=args.days)

    log.info("═"*64)
    log.info("  Congressional Trades Scraper")
    log.info(f"  Range: {from_date} → {today}  ({args.days} days)")
    log.info(f"  House: {'yes' if do_house else 'no'}  "
             f"Senate: {'yes' if do_senate else 'no'}  "
             f"Dry run: {DRY_RUN}")
    log.info("═"*64)

    existing: set[str] = set()
    if not DRY_RUN:
        log.info("Loading existing congressional accessions…")
        existing = get_existing_accessions()
        log.info(f"  {len(existing):,} already in DB")

    all_trades: list[CongressTrade] = []

    if do_house:
        log.info("\n── House of Representatives ──")
        all_trades.extend(fetch_house(from_date, today, existing))

    if do_senate:
        log.info("\n── Senate ──")
        all_trades.extend(fetch_senate(from_date, today, existing))

    # Dedup within this run
    seen:    set[str] = set()
    deduped: list[CongressTrade] = []
    for t in all_trades:
        if t.accession_number not in seen:
            seen.add(t.accession_number)
            deduped.append(t)

    buys  = [t for t in deduped if t.transaction_type == "buy"]
    sells = [t for t in deduped if t.transaction_type == "sell"]
    log.info(f"\nTotal: {len(deduped)} trades  ({len(buys)} buys, {len(sells)} sells)")

    if buys:
        log.info("\nTop buys by value:")
        for t in sorted(buys, key=lambda x: x.value or 0, reverse=True)[:8]:
            val = f"~${t.value:>10,.0f}" if t.value else "  (undisclosed)"
            log.info(f"  {t.insider_name:<30} ({t.insider_title:<6}) "
                     f"{(t.ticker or '—'):<6}  {val}  {t.transaction_date}")

    if not deduped:
        log.info("No new trades found."); return

    if DRY_RUN:
        log.info(f"\nDRY RUN — {len(deduped)} trades would be written"); return

    written = 0
    for i in range(0, len(deduped), 200):
        batch    = deduped[i:i+200]
        written += write_batch(batch)
        log.info(f"  Wrote batch {i//200+1}: {len(batch)} rows ({written} total)")

    log.info(f"\n✓ {written} congressional trades written to Neon")
    log.info("  Filter: WHERE transaction_code LIKE 'CONGRESS%'")
    log.info("═"*64)

if __name__ == "__main__":
    main()
