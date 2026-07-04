#!/usr/bin/env python3
"""
db/fetch_filings_neon.py
─────────────────────────────────────────────────────────────────────────────
Daily Form 4 ingestion: EDGAR EFTS → parse XML → write to Neon Postgres.

Run:
    python fetch_filings_neon.py                    # last 3 days
    DRY_RUN=1 python fetch_filings_neon.py          # parse only, no DB write
    START_DATE=2025-05-01 python fetch_filings_neon.py

Cron (weekdays 7 PM ET):
    0 23 * * 1-5 cd /path/to/db && python fetch_filings_neon.py >> fetch.log 2>&1

Requirements:
    pip install "psycopg[binary]" requests python-dotenv lxml
─────────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import os, re, sys, time, json, logging
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import date, timedelta
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
DAYS_BACK           = int(os.environ.get("DAYS_BACK", "3"))
MAX_WORKERS         = int(os.environ.get("MAX_WORKERS", "2"))
DRY_RUN             = os.environ.get("DRY_RUN", "0") == "1"
START_DATE_OVERRIDE = os.environ.get("START_DATE")
END_DATE_OVERRIDE   = os.environ.get("END_DATE")

EDGAR_EFTS_URL  = "https://efts.sec.gov/LATEST/search-index"
EDGAR_BASE_URL  = "https://www.sec.gov"
INTER_REQUEST_SLEEP = 0.5   # 4 workers × 1 req/0.15s ≈ 6.7 req/sec (limit is 10)

HEADERS = {
    "User-Agent":      f"insider-tracker/5.0 ({USER_AGENT_EMAIL})",
    "Accept-Encoding": "gzip, deflate",
    "Accept":          "application/json, text/html, application/xml",
}

# ── Retry-aware GET ────────────────────────────────────────────────────────────

def sec_get(url: str, params: dict = None, timeout: int = 25,
            max_retries: int = 3) -> Optional[requests.Response]:
    # Worst case per URL now: min(65,90)+min(130,90)+min(195,90) = 270s (4.5min)
    # instead of the old 65+130+195+260+325 = 975s (16.25min). GitHub-hosted
    # runners share IP pools with many other jobs hitting sec.gov, so 429s
    # here are more likely than on a personal machine — capping the backoff
    # means a bad run fails fast and cheap instead of burning the full job
    # timeout with nothing committed to the DB.
    MAX_BACKOFF = 90
    for attempt in range(max_retries):
        time.sleep(INTER_REQUEST_SLEEP)
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
        except requests.exceptions.Timeout:
            time.sleep(min(5 * (attempt + 1), MAX_BACKOFF)); continue
        except Exception as e:
            log.debug(f"Request error: {e}"); time.sleep(5); continue

        if r.status_code == 200:   return r
        if r.status_code == 404:   return None
        if r.status_code == 429:
            wait = min(65 * (attempt + 1), MAX_BACKOFF)
            log.warning(f"429 — waiting {wait}s"); time.sleep(wait); continue
        if r.status_code in (500, 502, 503, 504):
            time.sleep(min(10 * (attempt + 1), MAX_BACKOFF)); continue
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
    "P":"Open Market Purchase", "S":"Open Market Sale",
    "A":"Grant / Award",        "D":"Return to Issuer",
    "F":"Tax Withholding",      "G":"Gift",
    "M":"Exercise of Derivative","X":"Exercise (In-the-Money)",
    "C":"Conversion",           "E":"Expiration (Short)",
    "H":"Expiration (Long)",    "I":"Discretionary",
    "J":"Other",                "K":"Equity Swap",
    "L":"Small Acquisition",    "U":"Tender",
    "W":"Inheritance",          "Z":"Deposit/Withdrawal",
}

OPEN_MARKET_CODES = {"P", "S"}

def get_sector(ticker):
    return TICKER_SECTOR.get((ticker or "").upper().strip(), "Other")

def get_relationship(title, is_officer, is_director, is_ten):
    t = (title or "").lower()
    if is_officer or re.search(r"chief|ceo|cfo|coo|cto|ciso|president|exec[\s.]?v", t):
        return "strong"
    if re.search(r"\bsvp\b|\bevp\b|senior v|managing dir|general counsel|treasurer|secretary", t):
        return "medium"
    return "weak"

def safe_float(v):
    if v is None: return None
    try: return float(str(v).replace(",","").strip())
    except: return None

def safe_date(v) -> Optional[str]:
    """
    Strip timezone offsets and extra chars from date strings.
    EDGAR EFTS returns dates like '2025-06-15-04:00' or '2025-06-15T00:00:00'.
    Postgres DATE type rejects these — extract just YYYY-MM-DD.
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
    if owned_after is None or shares is None or shares <= 0:
        return None, None
    sb = owned_after - shares if tx_type == "buy" else owned_after + shares
    if sb <= 0: return round(sb, 4), None
    pct = round((shares / sb) * 100, 2)
    pct = min(pct, 99999.99)  # cap at 99,999% to prevent overflow
    return round(sb, 4), pct

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
    company_name: Optional[str]=None;   ticker: Optional[str]=None
    cik_issuer: Optional[str]=None;     insider_name: Optional[str]=None
    insider_cik: Optional[str]=None;    insider_title: Optional[str]=None
    is_director: bool=False;            is_officer: bool=False
    is_ten_pct_owner: bool=False;       filing_date: Optional[str]=None
    transaction_date: Optional[str]=None; transaction_type: Optional[str]=None
    transaction_code: Optional[str]=None; transaction_code_label: Optional[str]=None
    is_open_market: bool=False;         is_derivative: bool=False
    security_title: Optional[str]=None; shares: Optional[float]=None
    price_per_share: Optional[float]=None; value: Optional[float]=None
    shares_owned_after: Optional[float]=None; shares_owned_before: Optional[float]=None
    pct_owned_change: Optional[float]=None;   direct_ownership: bool=True
    relationship: Optional[str]=None;  sector: Optional[str]=None
    footnotes: Optional[str]=None

    def to_tuple(self):
        d = asdict(self)
        for k in ("shares","price_per_share","value",
                  "shares_owned_after","shares_owned_before","pct_owned_change"):
            if d[k] is not None: d[k] = round(d[k], 4)
        return tuple(d[c] for c in COLUMNS)

# ── EDGAR EFTS: list filings ───────────────────────────────────────────────────

def edgar_get_accessions(start_date: str, end_date: str) -> list[dict]:
    all_hits: list[dict] = []
    seen_ids: set[str] = set()
    offset, page_size = 0, 100  # EDGAR EFTS returns 100/page regardless of what
                                  # we assume — this was previously 40, causing
                                  # each request to overlap the last one by 60
                                  # results and collect the same filings 2-3x over.

    while True:
        params = {"forms":"4","dateRange":"custom",
                  "startdt":start_date,"enddt":end_date,"from":offset,
                  "size":page_size}  # explicit — don't rely on EDGAR's default
        r = sec_get(EDGAR_EFTS_URL, params=params, timeout=30)
        if r is None:
            log.error(f"EDGAR EFTS failed at offset {offset}")
            break
        try:
            data = r.json()
        except Exception as e:
            log.error(f"EFTS JSON parse error: {e}"); break

        hits = data.get("hits", {}).get("hits", [])
        if not hits: break

        new_this_page = 0
        for h in hits:
            raw_id = h.get("_id", "")
            if raw_id in seen_ids:
                continue  # defensive dedupe — belt-and-suspenders against any
                          # remaining pagination overlap regardless of cause
            seen_ids.add(raw_id)
            new_this_page += 1

            src    = h.get("_source", {})
            if ":" in raw_id:
                accession, xml_filename = raw_id.split(":", 1)
            else:
                accession, xml_filename = raw_id, None
            cik_padded = accession.split("-")[0]
            cik        = re.sub(r"^0+", "", cik_padded)
            nodash     = accession.replace("-", "")
            xml_url    = (f"{EDGAR_BASE_URL}/Archives/edgar/data/"
                          f"{cik_padded}/{nodash}/{xml_filename}") if xml_filename else None
            all_hits.append({
                "accession":        accession,
                "cik":              cik,
                "file_date":        src.get("file_date"),           # real EDGAR acceptance date
                "period_of_report": src.get("period_of_report"),    # period covered by the report
                "entity_name":      src.get("entity_name",""),
                "xml_url":          xml_url,
            })

        total = data.get("hits",{}).get("total",{})
        if isinstance(total, dict): total = total.get("value", 0)
        log.info(f"  EFTS offset={offset}: {len(hits)} hits, {new_this_page} new (total: {total})")

        offset += page_size
        if len(hits) < page_size: break

    return all_hits

# ── XML parser ─────────────────────────────────────────────────────────────────

def _sanitize(text):
    return re.sub(r'&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)', '&amp;', text)

def parse_form4_xml(xml_text, accession, cik, fallback_filing_date=None, fallback_period=None, fallback_company=None):
    # fallback_filing_date: the real EDGAR file acceptance date from EFTS metadata
    # fallback_period:      the period_of_report from EFTS metadata (close to transaction date)
    # These are kept separate because filing_date and transaction_date are different concepts:
    #   filing_date    = when EDGAR accepted the form (should be the real acceptance datetime)
    #   transaction_date = when the actual trade happened (from <transactionDate> in the XML,
    #                      falling back to <periodOfReport> since that's the period covered,
    #                      but NEVER silently falling back to today's date)
    xml_text = xml_text.strip().lstrip("\ufeff")
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

    footnotes = {}
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
        ide  = ow.find("reportingOwnerId"); re2 = ow.find("reportingOwnerRelationship")
        name = xtxt(ide,"rptOwnerName");   ocik = xtxt(ide,"rptOwnerCik")
        isd  = (xtxt(re2,"isDirector")         or "0")=="1"
        iso  = (xtxt(re2,"isOfficer")          or "0")=="1"
        ist  = (xtxt(re2,"isTenPercentOwner")  or "0")=="1"
        tr2  = xtxt(re2,"officerTitle") or ""
        if not tr2:
            parts=[]
            if isd: parts.append("Director")
            if iso: parts.append("Officer")
            if ist: parts.append("10% Owner")
            tr2=", ".join(parts) or "Unknown"
        po.append({"name":name,"cik":ocik,"title":tr2,"isd":isd,"iso":iso,"ist":ist})

    pri      = next((o for o in po if o["iso"]), po[0] if po else {})
    in_name  = pri.get("name"); in_cik = pri.get("cik")
    in_title = pri.get("title","Unknown")
    isd_v    = pri.get("isd",False); iso_v=pri.get("iso",False); ist_v=pri.get("ist",False)
    period   = safe_date(xtxt(root,"periodOfReport") or xtxt(root,"period_of_report") or fallback_period)
    # filing_date should be the real EDGAR acceptance date, not periodOfReport.
    # periodOfReport is the period *covered* by the filing — for a normal Form 4 this
    # equals the transaction date, but for late/amended filings it can be historical.
    # Using it as filing_date caused both dates to appear as "today" when filings
    # with NULL transaction_date fell through to today's ingest date.
    real_filing_date = safe_date(fallback_filing_date)  # EDGAR acceptance date from EFTS
    rel      = get_relationship(in_title, iso_v, isd_v, ist_v)

    def base():
        return dict(
            accession_number=accession, cik=cik, company_name=company, ticker=ticker,
            cik_issuer=cik_issuer, insider_name=in_name, insider_cik=in_cik,
            insider_title=in_title, is_director=isd_v, is_officer=iso_v,
            is_ten_pct_owner=ist_v, filing_date=real_filing_date,
            relationship=rel, sector=get_sector(ticker),
        )

    txns = []

    nd = root.find("nonDerivativeTable")
    if nd is not None:
        for tx in nd.findall("nonDerivativeTransaction"):
            sec=xtxt(tx,"securityTitle","value")
            txd=safe_date(xtxt(tx,"transactionDate","value") or period)  # strip tz, fall back to periodOfReport
            ce=tx.find("transactionCoding"); tc=xtxt(ce,"transactionCode") if ce is not None else None
            ad=xtxt(tx,"transactionAmounts","transactionAcquiredDisposedCode","value")
            sh=safe_float(xtxt(tx,"transactionAmounts","transactionShares","value"))
            pr=safe_float(xtxt(tx,"transactionAmounts","transactionPricePerShare","value"))
            oa=safe_float(xtxt(tx,"postTransactionAmounts","sharesOwnedFollowingTransaction","value"))
            di=xtxt(tx,"ownershipNature","directOrIndirectOwnership","value"); fn=rfn(tx)
            if tc=="P":    tt="buy"
            elif tc=="S":  tt="sell"
            elif ad=="A":  tt="buy"
            elif ad=="D":  tt="sell"
            else:          tt="other"
            v=round(sh*pr,2) if sh and pr else None
            sb,pct=compute_ownership_change(sh,oa,tt)
            txns.append(Transaction(**base(),transaction_date=txd,transaction_type=tt,
                transaction_code=tc,transaction_code_label=TX_CODE_MAP.get(tc or "","Other"),
                is_open_market=tc in OPEN_MARKET_CODES,is_derivative=False,
                security_title=sec,shares=sh,price_per_share=pr,value=v,
                shares_owned_after=oa,shares_owned_before=sb,pct_owned_change=pct,
                direct_ownership=(di or "D")=="D",footnotes=fn))

    dt = root.find("derivativeTable")
    if dt is not None:
        for tx in dt.findall("derivativeTransaction"):
            sec=xtxt(tx,"securityTitle","value")
            txd=safe_date(xtxt(tx,"transactionDate","value") or period)  # strip tz, fall back to periodOfReport
            ce=tx.find("transactionCoding"); tc=xtxt(ce,"transactionCode") if ce is not None else None
            ad=xtxt(tx,"transactionAmounts","transactionAcquiredDisposedCode","value")
            sh=safe_float(xtxt(tx,"transactionAmounts","transactionShares","value") or
                          xtxt(tx,"underlyingSecurity","underlyingSecurityShares","value"))
            pr=safe_float(xtxt(tx,"transactionAmounts","transactionPricePerShare","value"))
            ep=safe_float(xtxt(tx,"conversionOrExercisePrice","value"))
            oa=safe_float(xtxt(tx,"postTransactionAmounts","sharesOwnedFollowingTransaction","value"))
            di=xtxt(tx,"ownershipNature","directOrIndirectOwnership","value"); fn=rfn(tx)
            if tc in ("P","X","M","C"):       tt="buy"
            elif tc in ("S","D","F","H","E"): tt="sell"
            elif ad=="A": tt="buy"
            elif ad=="D": tt="sell"
            else:         tt="other"
            ep2=pr if pr is not None else ep
            v=round(sh*ep2,2) if sh and ep2 else None
            sb,pct=compute_ownership_change(sh,oa,tt)
            txns.append(Transaction(**base(),transaction_date=txd,transaction_type=tt,
                transaction_code=tc,transaction_code_label=TX_CODE_MAP.get(tc or "","Other"),
                is_open_market=tc in OPEN_MARKET_CODES,is_derivative=True,
                security_title=sec,shares=sh,price_per_share=ep2,value=v,
                shares_owned_after=oa,shares_owned_before=sb,pct_owned_change=pct,
                direct_ownership=(di or "D")=="D",footnotes=fn))

    return txns

# ── Worker ─────────────────────────────────────────────────────────────────────

def process_one(meta: dict) -> tuple[str, list[Transaction]]:
    accession = meta["accession"]
    cik       = meta["cik"]
    xml_url   = meta.get("xml_url")
    if not xml_url:
        return accession, []
    r = sec_get(xml_url, timeout=25)
    if r is None: return accession, []
    txns = parse_form4_xml(r.text, accession, cik,
                           fallback_filing_date    = meta.get("file_date"),
                           fallback_period         = meta.get("period_of_report"),
                           fallback_company        = meta.get("entity_name"))
    return accession, txns

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
    filing_date=EXCLUDED.filing_date,
    transaction_date=COALESCE(EXCLUDED.transaction_date, public.filings.transaction_date),
    price_per_share=EXCLUDED.price_per_share, value=EXCLUDED.value,
    shares_owned_after=EXCLUDED.shares_owned_after,
    shares_owned_before=EXCLUDED.shares_owned_before,
    pct_owned_change=EXCLUDED.pct_owned_change,
    sector=EXCLUDED.sector, relationship=EXCLUDED.relationship,
    footnotes=EXCLUDED.footnotes, updated_at=now()
"""
# NOTE: The ON CONFLICT target (accession_number, transaction_date, shares, transaction_code)
# requires a matching unique index in Postgres. If transaction_date can be NULL (it can),
# Postgres treats NULLs as distinct and the conflict will never fire for NULL-dated rows.
# To fix this properly in the DB, run this migration once:
#
#   CREATE UNIQUE INDEX IF NOT EXISTS filings_dedup_idx
#   ON public.filings (accession_number, COALESCE(transaction_date, '1900-01-01'), shares, transaction_code);
#
#   DROP INDEX IF EXISTS <old_unique_index_name>;  -- drop whatever enforces the current constraint
#
# This coerces NULLs to a sentinel date so conflicts fire correctly for NULL-dated rows.


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

def upsert_to_neon(transactions: list[Transaction], batch_size: int = 500) -> int:
    conn = get_connection()
    written = 0
    try:
        cur = conn.cursor()
        for i in range(0, len(transactions), batch_size):
            batch = transactions[i:i+batch_size]
            cur.executemany(UPSERT_SQL, [t.to_tuple() for t in batch])
            conn.commit()  # commit per-batch — if the job gets killed later,
                            # everything committed so far is still safe in the DB
            written += len(batch)
            log.info(f"  Batch {i//batch_size+1}: {len(batch)} rows ({written} total)")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return written

# ── Main ──────────────────────────────────────────────────────────────────────

def run() -> None:
    if not DRY_RUN and not DATABASE_URL:
        log.error("DATABASE_URL not set. Check db/.env"); sys.exit(1)

    end_date   = END_DATE_OVERRIDE   or date.today().isoformat()
    start_date = START_DATE_OVERRIDE or (date.today()-timedelta(days=DAYS_BACK)).isoformat()

    log.info("═"*62)
    log.info("  SEC Form 4 → Neon  (~6 req/sec, 429 backoff)")
    log.info(f"  Range: {start_date} → {end_date}  Workers: {MAX_WORKERS}  Dry: {DRY_RUN}")
    log.info("═"*62)

    log.info("Step 1/3  Querying EDGAR EFTS…")
    meta_list = edgar_get_accessions(start_date, end_date)
    log.info(f"          {len(meta_list)} filings")
    if not meta_list: log.info("Nothing to do."); return

    log.info(f"Step 2/3  Parsing XML ({MAX_WORKERS} workers)…")
    all_txns: list[Transaction] = []
    failed = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(process_one, m): m for m in meta_list}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                _, txns = fut.result()
                all_txns.extend(txns)
            except Exception as e:
                failed += 1; log.debug(f"  {futures[fut]['accession']}: {e}")
            if i % 100 == 0 or i == len(meta_list):
                log.info(f"  {i}/{len(meta_list)} filings — {len(all_txns)} transactions")

    log.info(f"          {len(all_txns)} parsed, {failed} failed")
    if not all_txns: log.info("Nothing to write."); return

    if DRY_RUN:
        log.info("Step 3/3  DRY RUN — sample:")
        log.info(json.dumps(asdict(all_txns[0]), indent=4, default=str))
    else:
        log.info("Step 3/3  Writing to Neon…")
        total = upsert_to_neon(all_txns)
        log.info(f"          {total} rows written ✓")

    log.info("═"*62); log.info("Done.")

if __name__ == "__main__":
    run()
