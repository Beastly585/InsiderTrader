#!/usr/bin/env python3
"""
db/backfill_historical.py
─────────────────────────────────────────────────────────────────────────────
Historical Form 4 backfill using EDGAR quarterly full-index files.

Usage:
    python backfill_historical.py --start 2025-Q3 --end 2025-Q4 --workers 2
    python backfill_historical.py --years 4 --workers 2
    python backfill_historical.py --start 2025-Q3 --end 2025-Q4 --workers 2 --resume
    python backfill_historical.py --start 2024-Q1 --end 2024-Q1 --dry-run
─────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import os, re, sys, time, json, logging, argparse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import date
from typing import Optional
from pathlib import Path

import requests
from dotenv import load_dotenv

try:
    from lxml import etree as lxml_etree
    HAS_LXML = True
except ImportError:
    HAS_LXML = False

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DATABASE_URL        = os.environ.get("DATABASE_URL", "")
USER_AGENT_EMAIL    = os.environ.get("USER_AGENT_EMAIL", "your@email.com")
MAX_WORKERS         = int(os.environ.get("MAX_WORKERS", "2"))
DRY_RUN             = os.environ.get("DRY_RUN", "0") == "1"
INTER_REQUEST_SLEEP = 0.4   # conservative — 2 workers × 2.5 req/s = 5 req/s

EDGAR_BASE = "https://www.sec.gov"
SUBM_BASE  = "https://data.sec.gov/submissions"
HEADERS    = {
    "User-Agent":      f"insider-tracker/5.0 ({USER_AGENT_EMAIL})",
    "Accept-Encoding": "gzip, deflate",
    "Accept":          "application/json, text/html, */*",
}

# ── Retry-aware HTTP ───────────────────────────────────────────────────────────

def sec_get(url: str, timeout: int = 25, retries: int = 6) -> Optional[requests.Response]:
    for attempt in range(retries):
        time.sleep(INTER_REQUEST_SLEEP)
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
        except requests.exceptions.Timeout:
            time.sleep(5*(attempt+1)); continue
        except Exception as e:
            log.debug(f"req error: {e}"); time.sleep(5); continue
        if r.status_code == 200:  return r
        if r.status_code == 404:  return None
        if r.status_code == 429:
            wait = 65*(attempt+1)
            log.warning(f"429 — waiting {wait}s"); time.sleep(wait); continue
        if r.status_code in (500,502,503,504):
            time.sleep(10*(attempt+1)); continue
        return None
    return None

# ── Lookup tables ──────────────────────────────────────────────────────────────

SECTOR_MAP: dict[str, list[str]] = {
    "Technology":             ["AAPL","MSFT","GOOGL","GOOG","META","NVDA","AMZN","TSLA","INTC","AMD","ORCL","CRM","ADBE","QCOM","TXN","AVGO","NOW","SNOW","PLTR","IBM","CSCO","INTU","DDOG","PANW","CRWD","NET","MDB","OKTA","TWLO","ZS"],
    "Finance":                ["JPM","BAC","WFC","GS","MS","C","BLK","AXP","V","MA","SCHW","USB","PNC","TFC","COF","SPGI","MCO","ICE","CME","CBOE","AFL","MET","PRU","ALL","TRV","HIG","WRB","AIG","BX","KKR","APO","CG"],
    "Healthcare":             ["JNJ","PFE","UNH","ABBV","MRK","LLY","BMY","AMGN","GILD","CVS","MDT","ABT","TMO","DHR","ISRG","REGN","VRTX","BIIB","BSX","EW","IQV","A","BIO","ZBH","SYK","BAX","DXCM","ILMN","IDXX","MTD"],
    "Energy":                 ["XOM","CVX","COP","SLB","PSX","EOG","MPC","VLO","PXD","OXY","HES","DVN","FANG","MRO","APA","HAL","BKR","NOV","WMB","KMI","ET","EPD","LNG","CQP","TRGP","AM","CTRA","SM","PR","MTDR"],
    "Consumer Staples":       ["WMT","PG","KO","PEP","COST","PM","MO","CL","GIS","KHC","HSY","MKC","SJM","CAG","CPB","K","HRL","TSN","ADM","BG"],
    "Consumer Discretionary": ["AMZN","HD","MCD","NKE","SBUX","LOW","TGT","TJX","EBAY","ETSY","ROST","BKNG","ABNB","MAR","HLT","YUM","CMG","DPZ","DKNG","WYNN","LVS","MGM","RCL","CCL","NCLH","PHM","DHI","LEN","TOL","NVR"],
    "Industrials":            ["HON","UNP","BA","CAT","GE","MMM","DE","EMR","ETN","ITW","LMT","RTX","NOC","GD","HII","TDG","FDX","UPS","DAL","UAL","AAL","NSC","CSX","WAB","PCAR","CMI","PH","ROK","DOV","XYL"],
    "Real Estate":            ["AMT","PLD","EQIX","CCI","SPG","O","WELL","DLR","PSA","EXR","ARE","VTR","BXP","SLG","KIM","REG","FRT","EQR","AVB","ESS"],
    "Utilities":              ["NEE","DUK","SO","AEP","EXC","SRE","PCG","ED","FE","EIX","XEL","WEC","ES","ETR","PPL","CNP","NI","AES","AWK","CMS"],
    "Communication Services": ["META","GOOGL","NFLX","DIS","VZ","T","CMCSA","TMUS","EA","TTWO","MTCH","IAC","WBD","PARA","FOXA","NYT","SNAP","PINS","RDDT","SPOT"],
    "Materials":              ["LIN","APD","ECL","SHW","FCX","NEM","NUE","VMC","MLM","DD","DOW","PPG","RPM","ALB","CF","MOS","FMC","CE","EMN","IFF"],
}
TICKER_SECTOR: dict[str, str] = {t: s for s, ts in SECTOR_MAP.items() for t in ts}

TX_CODE_MAP: dict[str, str] = {
    "P":"Open Market Purchase","S":"Open Market Sale","A":"Grant / Award",
    "D":"Return to Issuer","F":"Tax Withholding","G":"Gift",
    "M":"Exercise of Derivative","X":"Exercise (In-the-Money)",
    "C":"Conversion","E":"Expiration (Short)","H":"Expiration (Long)",
    "I":"Discretionary","J":"Other","K":"Equity Swap",
    "L":"Small Acquisition","U":"Tender","W":"Inheritance","Z":"Deposit/Withdrawal",
}
OPEN_MARKET_CODES = {"P","S"}

def get_sector(t):
    return TICKER_SECTOR.get((t or "").upper().strip(), "Other")

def get_rel(title, is_off, is_dir, is_ten):
    t = (title or "").lower()
    if is_off or re.search(r"chief|ceo|cfo|coo|cto|president|exec[\s.]?v", t): return "strong"
    if re.search(r"\bsvp\b|\bevp\b|senior v|managing dir|general counsel|treasurer|secretary", t): return "medium"
    return "weak"

def safe_float(v):
    if v is None: return None
    try: return float(str(v).replace(",","").strip())
    except: return None

def safe_date(v) -> Optional[str]:
    """
    Strip timezone offsets and extra chars from date strings.
    '2025-12-11-05:00' → '2025-12-11'
    '2025-12-11T00:00:00' → '2025-12-11'
    """
    if not v: return None
    m = re.match(r'(\d{4}-\d{2}-\d{2})', str(v).strip())
    return m.group(1) if m else None

def xtxt(el, *tags):
    cur = el
    for tag in tags:
        if cur is None: return None
        cur = cur.find(tag)
    return cur.text.strip() if cur is not None and cur.text else None

def compute_ownership_change(shares, owned_after, tx_type):
    if owned_after is None or shares is None or shares <= 0: return None, None
    sb = owned_after - shares if tx_type == "buy" else owned_after + shares
    if sb <= 0: return round(sb,4), None
    pct = round((shares / sb) * 100, 2)
    return round(sb,4), min(pct, 99999.99)

# ── Data model ─────────────────────────────────────────────────────────────────

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
class Transaction:
    accession_number: str;        cik: str
    company_name: Optional[str]=None;    ticker: Optional[str]=None
    cik_issuer: Optional[str]=None;      insider_name: Optional[str]=None
    insider_cik: Optional[str]=None;     insider_title: Optional[str]=None
    is_director: bool=False;             is_officer: bool=False
    is_ten_pct_owner: bool=False;        filing_date: Optional[str]=None
    transaction_date: Optional[str]=None; transaction_type: Optional[str]=None
    transaction_code: Optional[str]=None; transaction_code_label: Optional[str]=None
    is_open_market: bool=False;          is_derivative: bool=False
    security_title: Optional[str]=None;  shares: Optional[float]=None
    price_per_share: Optional[float]=None; value: Optional[float]=None
    shares_owned_after: Optional[float]=None; shares_owned_before: Optional[float]=None
    pct_owned_change: Optional[float]=None;   direct_ownership: bool=True
    relationship: Optional[str]=None;   sector: Optional[str]=None
    footnotes: Optional[str]=None

    def to_tuple(self):
        d = asdict(self)
        for k in ("shares","price_per_share","value",
                  "shares_owned_after","shares_owned_before","pct_owned_change"):
            if d[k] is not None: d[k] = round(d[k], 4)
        return tuple(d[c] for c in COLUMNS)

# ── Quarter helpers ────────────────────────────────────────────────────────────

def quarter_of(d): return d.year, (d.month-1)//3+1

def quarters_between(sy, sq, ey, eq):
    result=[]; y,q=sy,sq
    while (y,q)<=(ey,eq):
        result.append((y,q)); q+=1
        if q>4: q=1; y+=1
    return result

def parse_qarg(s):
    m = re.match(r'(\d{4})[- ]?Q?(\d)', s, re.I)
    if not m: raise ValueError(f"Bad quarter format: {s!r}  (use 2022-Q1)")
    return int(m.group(1)), int(m.group(2))

# ── Step 1: Parse form.idx ─────────────────────────────────────────────────────

def fetch_quarter_ciks(year: int, quarter: int) -> dict[str, list[dict]]:
    """
    Download form.idx for a quarter.
    Returns {cik_str: [filing_meta, ...]} grouped by CIK.

    IMPORTANT: CIK is extracted from the file PATH (edgar/data/CIK/...),
    NOT from the accession number prefix — they can differ and path CIK
    is what EDGAR actually uses in URLs.
    """
    url  = f"{EDGAR_BASE}/Archives/edgar/full-index/{year}/QTR{quarter}/form.idx"
    resp = sec_get(url, timeout=90)
    if resp is None:
        log.error(f"Could not fetch index for {year}-Q{quarter}")
        return {}

    by_cik: dict[str, list[dict]] = {}
    lines  = resp.text.splitlines()
    start  = next((i+1 for i,l in enumerate(lines) if l.startswith("---")), 0)

    for line in lines[start:]:
        if not line.strip(): continue
        parts = re.split(r'\s{2,}', line.strip())
        if len(parts) < 5: continue
        if parts[0].strip() not in ("4","4/A"): continue
        try:
            company  = parts[1].strip()
            cik_raw  = parts[2].strip()
            filed    = parts[3].strip()
            filename = parts[4].strip()
        except IndexError:
            continue

        acc_m = re.search(r'(\d{10}-\d{2}-\d{6})', filename)
        if not acc_m: continue
        accession = acc_m.group(1)

        # Extract CIK from file path: edgar/data/CIK/accession.txt
        path_parts = filename.replace("\\","/").split("/")
        if len(path_parts) >= 3 and path_parts[0] == "edgar":
            path_cik = path_parts[2]   # authoritative CIK from URL path
        else:
            path_cik = cik_raw.lstrip("0") or "0"

        cik_str    = cik_raw.lstrip("0") or "0"
        cik_padded = path_cik.zfill(10)   # zero-padded for URL construction

        by_cik.setdefault(cik_str, []).append({
            "accession":  accession,
            "cik":        cik_str,
            "cik_padded": cik_padded,
            "path_cik":   path_cik,
            "nodash":     accession.replace("-",""),
            "file_date":  filed,
            "company":    company,
        })
    return by_cik

# ── Step 2: Get exact XML filenames from submissions API ──────────────────────

def get_docs_for_cik(cik_str: str) -> dict[str, str]:
    """
    Returns {accession_nodash: xml_filename} for all Form 4 filings.
    Strips XSL prefix: 'xslF345X06/rdgdoc.xml' → 'rdgdoc.xml'
    """
    cik_padded = cik_str.zfill(10)
    resp = sec_get(f"{SUBM_BASE}/CIK{cik_padded}.json", timeout=20)
    if resp is None: return {}
    try: data = resp.json()
    except Exception: return {}

    result: dict[str, str] = {}

    def extract(section: dict):
        for acc, doc, form in zip(
            section.get("accessionNumber", []),
            section.get("primaryDocument", []),
            section.get("form", []),
        ):
            if form in ("4","4/A") and doc:
                clean = doc.split("/")[-1] if "/" in doc else doc
                result[acc.replace("-","")] = clean

    extract(data.get("filings",{}).get("recent",{}))
    for batch_ref in data.get("filings",{}).get("files",[]):
        br = sec_get(f"{SUBM_BASE}/{batch_ref['name']}", timeout=20)
        if br:
            try: extract(br.json())
            except Exception: pass

    return result

# ── Step 3: Fallback filename guesser ─────────────────────────────────────────

COMMON_XML = [
    "ownership.xml","form4.xml","primary_doc.xml","primarydocument.xml",
    "primary_01.xml","doc4.xml","edgardoc.xml","edgar.xml",
]

def guess_xml_url(cik_padded: str, nodash: str) -> Optional[str]:
    base = f"{EDGAR_BASE}/Archives/edgar/data/{cik_padded}/{nodash}"
    for name in COMMON_XML:
        r = sec_get(f"{base}/{name}", timeout=8)
        if r is not None: return f"{base}/{name}"
    return None

# ── XML parser ─────────────────────────────────────────────────────────────────

def _sanitize(text: str) -> str:
    return re.sub(r'&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)', '&amp;', text)

def parse_form4_xml(xml_text: str, accession: str, cik: str,
                    fallback_date=None, fallback_company=None) -> list[Transaction]:
    xml_text = xml_text.strip().lstrip("\ufeff")

    # Reject HTML error pages immediately
    t = xml_text[:200].lower()
    if "<!doctype html" in t or "<html" in t:
        log.debug(f"HTML error page for {accession}")
        return []

    if not xml_text.startswith("<"):
        s = xml_text.find("<")
        if s == -1: return []
        xml_text = xml_text[s:]

    root = None
    if HAS_LXML:
        try:
            p  = lxml_etree.XMLParser(recover=True, resolve_entities=False)
            lr = lxml_etree.fromstring(xml_text.encode("utf-8", errors="replace"), p)
            root = ET.fromstring(lxml_etree.tostring(lr, encoding="unicode"))
        except Exception: root = None
    if root is None:
        try: root = ET.fromstring(_sanitize(xml_text))
        except ET.ParseError: root = None
    if root is None:
        try: root = ET.fromstring(xml_text)
        except ET.ParseError: return []

    footnotes: dict[str, str] = {}
    fn_sec = root.find("footnotes")
    if fn_sec is not None:
        for fn in fn_sec.findall("footnote"):
            fid = fn.get("id","")
            if fid and fn.text: footnotes[fid] = fn.text.strip()

    def rfn(el):
        if el is None: return None
        ids   = [c.text.strip() for c in el.findall("footnoteId") if c.text]
        texts = [footnotes[i] for i in ids if i in footnotes]
        return "; ".join(texts) if texts else None

    ie         = root.find("issuer")
    company    = xtxt(ie,"issuerName") or fallback_company
    tr         = xtxt(ie,"issuerTradingSymbol")
    ticker     = tr.upper().strip() if tr else None
    cik_issuer = xtxt(ie,"issuerCik")

    owners = root.findall("reportingOwner") or root.findall(".//reportingOwner")
    po = []
    for ow in owners:
        ide  = ow.find("reportingOwnerId");  re2 = ow.find("reportingOwnerRelationship")
        name = xtxt(ide,"rptOwnerName");     ocik = xtxt(ide,"rptOwnerCik")
        isd  = (xtxt(re2,"isDirector")        or "0")=="1"
        iso  = (xtxt(re2,"isOfficer")         or "0")=="1"
        ist  = (xtxt(re2,"isTenPercentOwner") or "0")=="1"
        tr2  = xtxt(re2,"officerTitle") or ""
        if not tr2:
            pts = []
            if isd: pts.append("Director")
            if iso: pts.append("Officer")
            if ist: pts.append("10% Owner")
            tr2 = ", ".join(pts) or "Unknown"
        po.append({"name":name,"cik":ocik,"title":tr2,"isd":isd,"iso":iso,"ist":ist})

    pri      = next((o for o in po if o["iso"]), po[0] if po else {})
    in_name  = pri.get("name");    in_cik  = pri.get("cik")
    in_title = pri.get("title","Unknown")
    isd_v    = pri.get("isd",False); iso_v=pri.get("iso",False); ist_v=pri.get("ist",False)
    period   = safe_date(xtxt(root,"periodOfReport") or xtxt(root,"period_of_report") or fallback_date)
    rel      = get_rel(in_title, iso_v, isd_v, ist_v)

    def base() -> dict:
        return dict(
            accession_number=accession, cik=cik, company_name=company, ticker=ticker,
            cik_issuer=cik_issuer, insider_name=in_name, insider_cik=in_cik,
            insider_title=in_title, is_director=isd_v, is_officer=iso_v,
            is_ten_pct_owner=ist_v, filing_date=period,
            relationship=rel, sector=get_sector(ticker),
        )

    txns: list[Transaction] = []

    nd = root.find("nonDerivativeTable")
    if nd is not None:
        for tx in nd.findall("nonDerivativeTransaction"):
            sec = xtxt(tx,"securityTitle","value")
            txd = safe_date(xtxt(tx,"transactionDate","value"))   # ← safe_date strips timezone
            ce  = tx.find("transactionCoding")
            tc  = xtxt(ce,"transactionCode") if ce is not None else None
            ad  = xtxt(tx,"transactionAmounts","transactionAcquiredDisposedCode","value")
            sh  = safe_float(xtxt(tx,"transactionAmounts","transactionShares","value"))
            pr  = safe_float(xtxt(tx,"transactionAmounts","transactionPricePerShare","value"))
            oa  = safe_float(xtxt(tx,"postTransactionAmounts","sharesOwnedFollowingTransaction","value"))
            di  = xtxt(tx,"ownershipNature","directOrIndirectOwnership","value")
            fn  = rfn(tx)
            if tc=="P":   tt="buy"
            elif tc=="S": tt="sell"
            elif ad=="A": tt="buy"
            elif ad=="D": tt="sell"
            else:         tt="other"
            v = round(sh*pr, 2) if sh and pr else None
            sb, pct = compute_ownership_change(sh, oa, tt)
            txns.append(Transaction(**base(),
                transaction_date=txd, transaction_type=tt,
                transaction_code=tc, transaction_code_label=TX_CODE_MAP.get(tc or "","Other"),
                is_open_market=tc in OPEN_MARKET_CODES, is_derivative=False,
                security_title=sec, shares=sh, price_per_share=pr, value=v,
                shares_owned_after=oa, shares_owned_before=sb, pct_owned_change=pct,
                direct_ownership=(di or "D")=="D", footnotes=fn))

    dt = root.find("derivativeTable")
    if dt is not None:
        for tx in dt.findall("derivativeTransaction"):
            sec = xtxt(tx,"securityTitle","value")
            txd = safe_date(xtxt(tx,"transactionDate","value"))   # ← safe_date strips timezone
            ce  = tx.find("transactionCoding")
            tc  = xtxt(ce,"transactionCode") if ce is not None else None
            ad  = xtxt(tx,"transactionAmounts","transactionAcquiredDisposedCode","value")
            sh  = safe_float(xtxt(tx,"transactionAmounts","transactionShares","value") or
                             xtxt(tx,"underlyingSecurity","underlyingSecurityShares","value"))
            pr  = safe_float(xtxt(tx,"transactionAmounts","transactionPricePerShare","value"))
            ep  = safe_float(xtxt(tx,"conversionOrExercisePrice","value"))
            oa  = safe_float(xtxt(tx,"postTransactionAmounts","sharesOwnedFollowingTransaction","value"))
            di  = xtxt(tx,"ownershipNature","directOrIndirectOwnership","value")
            fn  = rfn(tx)
            if tc in ("P","X","M","C"):       tt="buy"
            elif tc in ("S","D","F","H","E"): tt="sell"
            elif ad=="A": tt="buy"
            elif ad=="D": tt="sell"
            else:         tt="other"
            ep2 = pr if pr is not None else ep
            v   = round(sh*ep2, 2) if sh and ep2 else None
            sb, pct = compute_ownership_change(sh, oa, tt)
            txns.append(Transaction(**base(),
                transaction_date=txd, transaction_type=tt,
                transaction_code=tc, transaction_code_label=TX_CODE_MAP.get(tc or "","Other"),
                is_open_market=tc in OPEN_MARKET_CODES, is_derivative=True,
                security_title=sec, shares=sh, price_per_share=ep2, value=v,
                shares_owned_after=oa, shares_owned_before=sb, pct_owned_change=pct,
                direct_ownership=(di or "D")=="D", footnotes=fn))

    return txns

# ── Worker: process one CIK ────────────────────────────────────────────────────

def process_cik(cik_str: str, filings: list[dict]) -> list[Transaction]:
    doc_map  = get_docs_for_cik(cik_str)
    all_txns = []

    for meta in filings:
        nodash     = meta["nodash"]
        cik_padded = meta["cik_padded"]   # from URL path — authoritative
        accession  = meta["accession"]
        base_path  = f"{EDGAR_BASE}/Archives/edgar/data/{cik_padded}/{nodash}"

        doc_name = doc_map.get(nodash)
        url = None

        if not doc_name:
            url = guess_xml_url(cik_padded, nodash)
        elif not doc_name.lower().endswith(".xml"):
            # Old SGML .txt — fetch index page to find embedded XML link
            idx = sec_get(f"{base_path}/{accession}-index.htm", timeout=15)
            if idx:
                for link in re.findall(r'href="(/Archives/edgar/data/[^"]+\.xml)"',
                                       idx.text, re.I):
                    fname = link.rsplit("/",1)[-1].lower()
                    if "xsl" not in fname and "schema" not in fname:
                        url = EDGAR_BASE + link; break
        else:
            url = f"{base_path}/{doc_name}"

        if not url:
            continue

        xml_resp = sec_get(url, timeout=25)
        if xml_resp is None:
            # Try alternate CIK (path_cik vs cik_padded may differ for some filers)
            alt = meta.get("path_cik","").zfill(10)
            if alt and alt != cik_padded and doc_name:
                alt_url = f"{EDGAR_BASE}/Archives/edgar/data/{alt}/{nodash}/{doc_name}"
                xml_resp = sec_get(alt_url, timeout=25)
            if xml_resp is None:
                continue

        txns = parse_form4_xml(
            xml_resp.text, accession, cik_str,
            fallback_date    = meta.get("file_date"),
            fallback_company = meta.get("company"),
        )
        all_txns.extend(txns)

    return all_txns

# ── DB ──────────────────────────────────────────────────────────────────────────

UPSERT_SQL = f"""
INSERT INTO public.filings ({", ".join(COLUMNS)})
VALUES ({", ".join(["%s"]*len(COLUMNS))})
ON CONFLICT (accession_number, transaction_date, shares, transaction_code)
DO UPDATE SET
    company_name=EXCLUDED.company_name, ticker=EXCLUDED.ticker,
    insider_name=EXCLUDED.insider_name, insider_title=EXCLUDED.insider_title,
    transaction_type=EXCLUDED.transaction_type,
    transaction_code_label=EXCLUDED.transaction_code_label,
    is_open_market=EXCLUDED.is_open_market,
    price_per_share=EXCLUDED.price_per_share, value=EXCLUDED.value,
    shares_owned_after=EXCLUDED.shares_owned_after,
    shares_owned_before=EXCLUDED.shares_owned_before,
    pct_owned_change=EXCLUDED.pct_owned_change,
    sector=EXCLUDED.sector, relationship=EXCLUDED.relationship,
    footnotes=EXCLUDED.footnotes, updated_at=now()
"""

def get_conn():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

def write_batch(txns: list[Transaction]) -> int:
    """
    Open a FRESH connection, write one batch, commit, close.
    Never holds a connection open across the long parse step —
    prevents SSL timeout errors from Neon dropping idle connections.
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.executemany(UPSERT_SQL, [t.to_tuple() for t in txns])
        conn.commit()
        return len(txns)
    finally:
        conn.close()

def get_existing() -> set[str]:
    """Load all accession numbers already in Neon for --resume."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT accession_number FROM public.filings")
            return {r[0] for r in cur.fetchall()}
    finally:
        conn.close()

# ── Quarter processor ──────────────────────────────────────────────────────────

def process_quarter(year: int, quarter: int, existing: set[str]) -> tuple[int,int]:
    log.info(f"  Fetching index {year}-Q{quarter}…")
    by_cik = fetch_quarter_ciks(year, quarter)
    if not by_cik: return 0, 0

    total = sum(len(v) for v in by_cik.values())
    log.info(f"  {total:,} Form 4s across {len(by_cik):,} unique CIKs")

    if existing:
        by_cik = {k:[m for m in v if m["accession"] not in existing]
                  for k,v in by_cik.items()}
        by_cik = {k:v for k,v in by_cik.items() if v}
        remaining = sum(len(v) for v in by_cik.values())
        log.info(f"  {total-remaining:,} already in DB — {remaining:,} new")

    if not by_cik: return total, 0

    all_txns: list[Transaction] = []
    done = 0; nciks = len(by_cik)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(process_cik, cik, metas): cik
                   for cik, metas in by_cik.items()}
        for fut in as_completed(futures):
            try: all_txns.extend(fut.result())
            except Exception as e: log.debug(f"CIK error: {e}")
            done += 1
            if done % 100 == 0 or done == nciks:
                log.info(f"    {done}/{nciks} CIKs — {len(all_txns):,} transactions")

    log.info(f"  Parsed {len(all_txns):,} transactions")
    if not all_txns: return total, 0

    if DRY_RUN:
        log.info(f"  DRY RUN — sample:")
        log.info(json.dumps(asdict(all_txns[0]), default=str, indent=2))
        return total, 0

    # Write in 500-row batches — fresh connection each time
    log.info(f"  Writing {len(all_txns):,} rows to Neon…")
    written = 0
    for i in range(0, len(all_txns), 500):
        batch   = all_txns[i:i+500]
        written += write_batch(batch)
        log.info(f"    Batch {i//500+1}: {len(batch)} rows ({written:,} total)")

    log.info(f"  ✓ {written:,} rows written")
    return total, written

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global DRY_RUN, MAX_WORKERS

    ap = argparse.ArgumentParser(description="Backfill historical Form 4 data")
    ap.add_argument("--years",   type=int,  help="Years back from today e.g. 4")
    ap.add_argument("--start",   type=str,  help="Start quarter: 2022-Q1")
    ap.add_argument("--end",     type=str,  help="End quarter: 2024-Q4")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--resume",  action="store_true",
                    help="Skip accessions already in Neon — safe to re-run after interruption")
    ap.add_argument("--workers", type=int,  help="Parallel workers (default 2, max 4)")
    args = ap.parse_args()

    if args.dry_run: DRY_RUN = True
    if args.workers: MAX_WORKERS = min(args.workers, 4)

    today = date.today()
    cy, cq = quarter_of(today)

    if args.years:
        sy, sq, ey, eq = today.year-args.years, cq, cy, cq
    elif args.start:
        sy, sq = parse_qarg(args.start)
        ey, eq = parse_qarg(args.end) if args.end else (cy, cq)
    else:
        ap.print_help(); sys.exit(1)

    qs = quarters_between(sy, sq, ey, eq)

    if not DRY_RUN and not DATABASE_URL:
        log.error("DATABASE_URL not set — check db/.env"); sys.exit(1)

    existing: set[str] = set()
    if args.resume:
        log.info("Loading existing accessions for resume…")
        existing = get_existing()
        log.info(f"  {len(existing):,} already in DB")

    log.info("═"*64)
    log.info(f"  Historical Backfill  {sy}-Q{sq} → {ey}-Q{eq}  ({len(qs)} quarters)")
    log.info(f"  Workers: {MAX_WORKERS}  Sleep: {INTER_REQUEST_SLEEP}s/req  Dry: {DRY_RUN}")
    log.info("═"*64)

    tf = tw = 0
    for i, (y, q) in enumerate(qs, 1):
        log.info(f"\n[{i}/{len(qs)}]  {y}-Q{q}")
        try:
            f, w = process_quarter(y, q, existing)
            tf += f; tw += w
        except KeyboardInterrupt:
            log.info("Interrupted — re-run with --resume to continue")
            break
        except Exception as e:
            log.error(f"Quarter {y}-Q{q} failed: {e}")
        time.sleep(2)

    log.info(f"\n{'═'*64}")
    log.info(f"  Done.  Filings: {tf:,}   Transactions written: {tw:,}")
    log.info("═"*64)


if __name__ == "__main__":
    main()
