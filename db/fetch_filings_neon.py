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
CHUNK               = int(os.environ.get("CHUNK", "500"))  # filings fetched per save
INTER_REQUEST_SLEEP = 0.5   # 4 workers × 1 req/0.15s ≈ 6.7 req/sec (limit is 10)

HEADERS = {
    "User-Agent":      f"insider-tracker/5.0 ({USER_AGENT_EMAIL})",
    "Accept-Encoding": "gzip, deflate",
    "Accept":          "application/json, text/html, application/xml",
}

# ── Retry-aware GET ────────────────────────────────────────────────────────────

import threading
_last = threading.local()   # last HTTP status per worker thread, for error messages

def last_status() -> str:
    return getattr(_last, "status", "no response")

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
            _last.status = f"HTTP {r.status_code}"
        except requests.exceptions.Timeout:
            _last.status = "timeout"
            time.sleep(min(5 * (attempt + 1), MAX_BACKOFF)); continue
        except Exception as e:
            _last.status = f"{type(e).__name__}"
            log.debug(f"Request error: {e}"); time.sleep(5); continue

        if r.status_code == 200:   return r
        if r.status_code == 404:   return None
        # SEC usually answers too many requests with 403 ("Request Rate
        # Threshold Exceeded"), not 429. Both get the same backoff.
        if r.status_code in (403, 429):
            wait = min(65 * (attempt + 1), MAX_BACKOFF)
            log.warning(f"{r.status_code} from SEC, waiting {wait}s"); time.sleep(wait); continue
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
    if not m: return None
    # A typo'd year (0205, 2205) can't be a real trade date. None makes the
    # site fall back to the filing date.
    if not (1990 <= int(m.group(1)[:4]) <= date.today().year + 1): return None
    return m.group(1)

# Filers type the trading symbol by hand, so it arrives as "BRK-B", "BF/B",
# "NASDAQ: AAPL", "GOOGL, GOOG", "$TSLA", "aapl " ... The old check rejected
# anything but plain letters, and those trades lost their ticker (gone from
# stock pages and alerts). Class shares are stored with a dot (BRK.B), the
# form the rest of the site already uses.
_EXCHANGE_PREFIX = re.compile(r'^(?:NYSE(?:\s*(?:AMERICAN|ARCA|MKT))?|NASDAQ(?:GS|GM|CM)?|AMEX|OTC(?:QX|QB|MKTS)?|CBOE|TSX|NYSEAMERICAN)\s*[:\-]\s*')
_NOT_A_TICKER = {'NONE', 'NULL', 'NA', 'N/A', 'TBD', 'NOTICKER', 'UNKNOWN', 'N.A'}

def normalize_ticker(raw) -> Optional[str]:
    if not raw: return None
    t = str(raw).upper().strip().strip('"\'$')
    if t in _NOT_A_TICKER: return None
    t = _EXCHANGE_PREFIX.sub('', t)
    t = re.split(r'[,;]|\s+AND\s+|\s{2,}', t)[0].strip()     # "GOOGL, GOOG" -> GOOGL
    t = re.sub(r'\s*[-/ ]\s*(?=[A-Z]{1,2}$)', '.', t)         # BRK-B, BF/B, BRK B -> BRK.B
    if t in _NOT_A_TICKER: return None
    return t if re.match(r'^[A-Z]{1,6}(\.[A-Z]{1,2})?$', t) else None

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
    planned: Optional[bool]=None   # 10b5-1 plan (open-market trades only); see mark_planned()

    def to_tuple(self, columns=None):
        d = asdict(self)
        for k in ("shares","price_per_share","value",
                  "shares_owned_after","shares_owned_before","pct_owned_change"):
            if d[k] is not None: d[k] = round(d[k], 4)
        return tuple(d[c] for c in (columns or COLUMNS))

# ── EDGAR EFTS: list filings ───────────────────────────────────────────────────

# EFTS stops paging at 10,000 results per query. One day of Form 4s is well
# under that; several days in a busy week can get close. So ask one day at a
# time, and report whether every day came back in full.
EFTS_MAX_RESULTS = 10_000

def edgar_get_accessions(start_date: str, end_date: str) -> tuple[list[dict], list[str]]:
    """Returns (filings, problems). problems is empty when the list is complete."""
    hits_all: list[dict] = []
    seen: set[str] = set()
    problems: list[str] = []
    d, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    while d <= end:
        if d.weekday() < 5:  # EDGAR doesn't accept filings on weekends
            hits, problem = _efts_one_range(d.isoformat(), d.isoformat(), seen)
            hits_all.extend(hits)
            if problem: problems.append(problem)
        d += timedelta(days=1)
    return hits_all, problems

def _efts_one_range(start_date: str, end_date: str, seen_ids: set[str]) -> tuple[list[dict], Optional[str]]:
    all_hits: list[dict] = []
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
            log.error(f"EDGAR EFTS failed for {start_date} at offset {offset}")
            return all_hits, f"EFTS stopped answering for {start_date} after {offset} results"
        try:
            data = r.json()
        except Exception as e:
            log.error(f"EFTS JSON parse error: {e}")
            return all_hits, f"EFTS sent unreadable data for {start_date} at offset {offset}"

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
            # The accession prefix is whoever submitted the filing. For most
            # Form 4s that's a filing agent (Workiva, Broadridge, Donnelley,
            # EdgarAgents...), and SEC only serves the files under the CIKs of
            # the companies/people in the filing, so the prefix URL 404s.
            # Try the filing's own CIKs (from EFTS) first, the prefix last.
            folder_ciks = []
            for c in (src.get("ciks") or []) + [cik_padded]:
                c = re.sub(r"^0+", "", str(c))
                if c and c not in folder_ciks: folder_ciks.append(c)
            xml_urls   = [f"{EDGAR_BASE_URL}/Archives/edgar/data/{c}/{nodash}/{xml_filename}"
                          for c in folder_ciks] if xml_filename else []
            xml_url    = xml_urls[0] if xml_urls else None
            all_hits.append({
                "accession":        accession,
                "cik":              cik,
                "file_date":        src.get("file_date"),           # real EDGAR acceptance date
                "period_of_report": src.get("period_of_report"),    # period covered by the report
                "entity_name":      src.get("entity_name",""),
                "xml_url":          xml_url,
                "xml_urls":         xml_urls,
            })

        total = data.get("hits",{}).get("total",{})
        if isinstance(total, dict): total = total.get("value", 0)
        log.info(f"  EFTS {start_date} offset={offset}: {len(hits)} hits, {new_this_page} new (total: {total})")

        offset += page_size
        if len(hits) < page_size: break
        if offset >= EFTS_MAX_RESULTS:
            return all_hits, f"{start_date} has more than {EFTS_MAX_RESULTS:,} results; EFTS won't page further"

    return all_hits, None

# ── XML parser ─────────────────────────────────────────────────────────────────

def _sanitize(text):
    return re.sub(r'&(?!amp;|lt;|gt;|apos;|quot;|#\d+;|#x[0-9a-fA-F]+;)', '&amp;', text)

# ── 10b5-1 plans ───────────────────────────────────────────────────────────────
# A trade made under a 10b5-1 plan was scheduled months earlier, so it says
# little about what the insider thinks of the stock today. Filings say so in
# a footnote ("effected pursuant to a Rule 10b5-1 trading plan adopted on
# ...") and, on forms filed since April 2023, a checkbox (aff10b5One). Same
# footnote rule as public.mark_planned_trades() in
# db/migrations/2026-10-22_ingest_runs_and_planned.sql, which marks old rows.
_PLAN_RE     = re.compile(r"10b5-?1", re.I)
_NOT_PLAN_RE = re.compile(r"\bnot\b[^.;]{0,40}10b5-?1", re.I)

def plan_mentioned(text: Optional[str]) -> bool:
    return bool(text and _PLAN_RE.search(text) and not _NOT_PLAN_RE.search(text))

def mark_planned(txns: list, checkbox: bool, remarks: Optional[str]) -> None:
    """Open-market buys/sales only. If any of them has a 10b5-1 footnote, those
    are the planned ones (a filing can mix plan and non-plan trades). If none
    do but the checkbox is ticked or the remarks mention a plan, they all are."""
    om = [t for t in txns if t.transaction_code in ("P", "S")]
    by_note = {id(t) for t in om if plan_mentioned(t.footnotes)}
    whole = checkbox or plan_mentioned(remarks)
    for t in om:
        t.planned = (id(t) in by_note) if by_note else whole

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
        # Footnote refs look like <footnoteId id="F1"/> and usually sit inside
        # a field (price, shares, date), not directly on the transaction, so
        # search the whole transaction and read the id attribute.
        if el is None: return None
        ids = []
        for c in el.iter("footnoteId"):
            i = (c.get("id") or c.text or "").strip()
            if i and i not in ids: ids.append(i)
        texts = [footnotes[i] for i in ids if i in footnotes]
        return "; ".join(texts) if texts else None

    ie         = root.find("issuer")
    company    = xtxt(ie,"issuerName") or fallback_company
    tr         = xtxt(ie,"issuerTradingSymbol")
    # Some filers (private companies, trusts, entities with no public ticker)
    # literally put "N/A", "NONE", "NA", etc. in this field — take it
    # verbatim only if it actually looks like a ticker (letters, optional
    # single dot for share classes like BRK.A), otherwise there's genuinely
    # no ticker for this filing and it should be null, not a placeholder
    # word stored as if it were a real symbol.
    ticker = normalize_ticker(tr)
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

    checkbox = (xtxt(root, "aff10b5One") or "").strip().lower() in ("1", "true")
    mark_planned(txns, checkbox, xtxt(root, "remarks"))
    return txns

# ── Worker ─────────────────────────────────────────────────────────────────────

class FetchFailed(Exception):
    """The filing's XML couldn't be downloaded (as opposed to having no rows)."""

def process_one(meta: dict) -> tuple[str, list[Transaction]]:
    accession = meta["accession"]
    cik       = meta["cik"]
    urls      = meta.get("xml_urls") or ([meta["xml_url"]] if meta.get("xml_url") else [])
    if not urls:
        return accession, []
    r = None
    for u in urls:
        # One quick try per folder when the answer is a plain 404, so a wrong
        # folder doesn't cost the full retry budget.
        r = sec_get(u, timeout=25, max_retries=3)
        if r is not None or last_status() != "HTTP 404": break
    if r is None: raise FetchFailed(f"{last_status()} {urls[-1] if len(urls) == 1 else urls[0]}")
    txns = parse_form4_xml(r.text, accession, cik,
                           fallback_filing_date    = meta.get("file_date"),
                           fallback_period         = meta.get("period_of_report"),
                           fallback_company        = meta.get("entity_name"))
    return accession, txns

# ── DB ──────────────────────────────────────────────────────────────────────────

def build_upsert(columns: list[str]) -> str:
    return f"""
INSERT INTO public.filings ({", ".join(columns)})
VALUES ({", ".join(["%s"]*len(columns))})
ON CONFLICT (accession_number, COALESCE(transaction_date, '1900-01-01'::date), COALESCE(shares, -1), transaction_code,
             COALESCE(is_derivative, false), COALESCE(price_per_share, -1), COALESCE(shares_owned_after, -1))
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
    footnotes=EXCLUDED.footnotes,{" planned=EXCLUDED.planned," if "planned" in columns else ""} updated_at=now()
"""

# filings.planned comes from db/migrations/2026-10-22_ingest_runs_and_planned.sql.
# Until that has been run, the column isn't written (see db_columns()).
UPSERT_SQL = build_upsert(COLUMNS)
# The key is filings_dedup_v2_idx (db/migrations/2026-10-09_dedup_key_v2.sql).
# is_derivative, price and shares-owned-after keep split lots of one sale
# (same day, same share count) and the two halves of an option exercise from
# overwriting each other.
# Originally fixed via db/migrations/006_filings_dedup_fix.sql — the ON CONFLICT target
# above now matches an expression-based unique index that COALESCEs both
# transaction_date and shares to sentinel values, since NULL in either column
# previously made Postgres' conflict matching silently never fire (NULL != NULL
# in a unique index). shares is always NULL for congressional trades from
# fetch_political_trades.py, so that script needed this fix even more than
# this one does — but all three writers to public.filings must stay in sync
# on this exact ON CONFLICT target, or inserts fail outright with "no unique
# or exclusion constraint matching the ON CONFLICT specification".


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)

# What run() found in the database: columns to write, and whether the
# ingest_runs table exists. Defaults are the pre-2026-10-22 schema.
WRITE_COLUMNS = list(COLUMNS)
HAS_RUN_LOG = False

def check_schema() -> None:
    """Write filings.planned and log the run only once
    db/migrations/2026-10-22_ingest_runs_and_planned.sql has been run, so
    deploying this before the migration can't break the ingest."""
    global WRITE_COLUMNS, UPSERT_SQL, HAS_RUN_LOG
    try:
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("""SELECT table_name, column_name FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND ((table_name = 'filings' AND column_name = 'planned') OR table_name = 'ingest_runs')""")
            found = cur.fetchall()
        finally:
            conn.close()
    except Exception as e:
        log.warning(f"  Schema check failed ({e}); writing the basic columns only"); return
    if any(t == 'filings' for t, _ in found):
        WRITE_COLUMNS = list(COLUMNS) + ["planned"]
        UPSERT_SQL = build_upsert(WRITE_COLUMNS)
    else:
        log.info("  filings.planned not there yet (db/migrations/2026-10-22_ingest_runs_and_planned.sql); skipping it")
    HAS_RUN_LOG = any(t == 'ingest_runs' for t, _ in found)

def record_run(stats: dict, problems: list[str]) -> None:
    """One row in ingest_runs per finished run. Feeds the site's "checked SEC
    N min ago" line and the weekly numbers email. Never fails the run."""
    if DRY_RUN or not DATABASE_URL or not HAS_RUN_LOG or not stats:
        return
    try:
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("""INSERT INTO public.ingest_runs
                             (start_date, end_date, filings_found, new_filings, rows_written, ok, problems)
                           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                        (stats.get("start"), stats.get("end"), stats.get("found", 0), stats.get("new", 0),
                         stats.get("written", 0), not problems, "; ".join(problems) or None))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        log.warning(f"  Couldn't log the run to ingest_runs: {e}")

def upsert_to_neon(transactions: list[Transaction], batch_size: int = 500) -> int:
    conn = get_connection()
    written = 0
    try:
        cur = conn.cursor()
        for i in range(0, len(transactions), batch_size):
            batch = transactions[i:i+batch_size]
            cur.executemany(UPSERT_SQL, [t.to_tuple(WRITE_COLUMNS) for t in batch])
            written += len(batch)
        # One commit for the whole chunk, so a filing's rows are saved together
        # or not at all (run() saves in chunks, so this stays small).
        conn.commit()
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

    if not DRY_RUN and DATABASE_URL:
        check_schema()

    log.info("Step 1/3  Querying EDGAR EFTS…")
    meta_list, problems = edgar_get_accessions(start_date, end_date)
    log.info(f"          {len(meta_list)} filings")
    stats = {"start": start_date, "end": end_date, "found": len(meta_list), "new": len(meta_list), "written": 0}
    if not meta_list:
        log.info("Nothing to do."); finish(problems, stats); return

    # ── Dedup: skip filings already in Neon ──────────────────────────────
    # SEC Form 4 XML is immutable once published — re-fetching a filing we
    # already ingested produces the same transactions and the UPSERT is a
    # no-op. Skipping them saves an HTTP request + 0.5s rate-limit budget
    # per filing, which is the difference between finishing in 3 minutes
    # vs timing out at 15 on GitHub Actions when a previous run partially
    # succeeded. Filings whose XML fetch failed or whose parse returned
    # zero transactions have NO rows in the DB, so they get retried.
    if not DRY_RUN and DATABASE_URL:
        try:
            conn = get_connection()
            cur = conn.cursor()
            # Batch the lookup to avoid oversized IN clauses
            all_accessions = [m["accession"] for m in meta_list]
            existing = set()
            for i in range(0, len(all_accessions), 500):
                batch = all_accessions[i:i+500]
                placeholders = ",".join(["%s"] * len(batch))
                cur.execute(f"SELECT DISTINCT accession_number FROM public.filings WHERE accession_number IN ({placeholders})", batch)
                existing.update(row[0] for row in cur.fetchall())
            conn.close()
            before = len(meta_list)
            meta_list = [m for m in meta_list if m["accession"] not in existing]
            stats["new"] = len(meta_list)
            skipped = before - len(meta_list)
            if skipped:
                log.info(f"          {skipped} already in DB, {len(meta_list)} new to fetch")
        except Exception as e:
            log.warning(f"  Dedup check failed ({e}) — fetching all {len(meta_list)}")

    if not meta_list:
        log.info("All filings already ingested."); finish(problems, stats); return

    # Fetch and save in chunks. A backfill over months is tens of thousands of
    # filings: saving as it goes means a crash or Ctrl-C loses at most one
    # chunk, and a re-run skips everything already saved. Each chunk is saved
    # in one transaction, so a filing is never left half-written (a filing
    # with any rows counts as done and is skipped next time).
    log.info(f"Step 2/3  Fetching and saving ({MAX_WORKERS} workers, {CHUNK} filings per save)…")
    failed = 0        # downloaded but couldn't be parsed
    fetch_failed = 0  # couldn't be downloaded (SEC throttling, timeouts)
    parsed = written = 0
    sample = None
    n = len(meta_list)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for c0 in range(0, n, CHUNK):
            chunk = meta_list[c0:c0 + CHUNK]
            txns_chunk: list[Transaction] = []
            futures = {pool.submit(process_one, m): m for m in chunk}
            for fut in as_completed(futures):
                try:
                    _, txns = fut.result()
                    txns_chunk.extend(txns)
                except FetchFailed as e:
                    fetch_failed += 1; log.warning(f"  {futures[fut]['accession']}: download failed ({e})")
                except Exception as e:
                    failed += 1; log.warning(f"  {futures[fut]['accession']}: {type(e).__name__}: {e}")
            parsed += len(txns_chunk)
            if txns_chunk and sample is None: sample = txns_chunk[0]
            if txns_chunk and not DRY_RUN:
                written += upsert_to_neon(txns_chunk)
            log.info(f"  {min(c0 + CHUNK, n)}/{n} filings — {parsed} transactions"
                     + ("" if DRY_RUN else f", {written} saved"))

    log.info(f"          {parsed} parsed, {fetch_failed} downloads failed, {failed} unparseable")
    # A handful of failures is normal noise and gets retried next run (failed
    # filings have no rows, so they aren't skipped). More than that means SEC
    # is throttling us or something is broken.
    if fetch_failed > max(5, n * 0.10):
        problems.append(f"{fetch_failed} of {n} filings couldn't be downloaded")
    if failed > max(5, n * 0.05):
        problems.append(f"{failed} of {n} filings couldn't be parsed")

    if DRY_RUN:
        if sample: log.info("Step 3/3  DRY RUN — sample:\n" + json.dumps(asdict(sample), indent=4, default=str))
    elif written:
        log.info(f"Step 3/3  {written} rows written ✓")
        # Cover the whole range on a backfill, not just the last 10 days.
        flag_suspect_trades(min(start_date, (date.today() - timedelta(days=10)).isoformat()))

    stats["written"] = written
    finish(problems, stats)

def finish(problems: list[str], stats: Optional[dict] = None) -> None:
    """Everything that could be fetched has been written by now. If the run
    was incomplete, say so loudly. On GitHub this sets an output that a last
    step turns into a red run (so the alert and price steps still run first);
    anywhere else it exits 1."""
    log.info("═"*62)
    record_run(stats, problems)
    if not problems:
        log.info("Done."); return
    for p in problems:
        log.error(f"INCOMPLETE: {p}")
    gh_out, gh_sum = os.environ.get("GITHUB_OUTPUT"), os.environ.get("GITHUB_STEP_SUMMARY")
    if gh_sum:
        with open(gh_sum, "a") as f:
            f.write("### Form 4 ingest was incomplete\n" + "".join(f"- {p}\n" for p in problems)
                    + "\nEverything that could be fetched was saved. Missing filings are retried on the next run.\n")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write("incomplete=true\n")
    else:
        sys.exit(1)

def flag_suspect_trades(since: str) -> None:
    """Before alerts go out, take two kinds of rows out of the open-market
    counts (nothing is deleted; the rules live in the database):
      * duplicate copies of one trade filed separately by related owners
        (db/migrations/2026-10-12_duplicates_and_bad_prices.sql)
      * obviously wrong amounts, like a typo'd price or share count
        (db/migrations/2026-10-06_suspect_trades.sql and later)
    Never fails the run."""
    # mark_reversals runs last: it only counts trades that are still open-market.
    for fn, what in (("flag_duplicate_trades", "duplicate copies of the same trade set aside (see filings.duplicate_of)"),
                     ("flag_suspect_trades", "trade(s) with implausible amounts set aside (see public.suspect_trades)"),
                     ("mark_reversals", "trade(s) marked or unmarked as reversals (see filings.reversal)")):
        try:
            conn = get_connection()
            try:
                cur = conn.cursor()
                cur.execute(f"SELECT public.{fn}(%s::date)", (since,))
                n = cur.fetchone()[0]
                conn.commit()
            finally:
                conn.close()
            if n:
                (log.info if fn == "mark_reversals" else log.warning)(f"          {n} {what}")
        except Exception as e:
            log.warning(f"  {fn} skipped: {e}")

if __name__ == "__main__":
    run()
