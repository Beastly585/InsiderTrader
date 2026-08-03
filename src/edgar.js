// src/edgar.js — SEC Form 4 data layer (ES module for Vite)
// No window.APP_CONFIG, no window.EdgarData, no XHR hacks.
// Normal fetch works fine since Babel is gone.
import cfg from './config.js';

// ── Sector map ────────────────────────────────────────────────────────────────
const SECTOR_MAP = {
  Technology:               ['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMZN','TSLA','INTC','AMD','ORCL','CRM','ADBE','QCOM','TXN','AVGO','NOW','SNOW','PLTR','IBM','CSCO','INTU','DDOG','PANW','CRWD','NET','ZS','MDB','OKTA'],
  Finance:                  ['JPM','BAC','WFC','GS','MS','C','BLK','AXP','V','MA','SCHW','USB','PNC','TFC','COF','SPGI','MCO','ICE','CME','BX','KKR','APO','CG'],
  Healthcare:               ['JNJ','PFE','UNH','ABBV','MRK','LLY','BMY','AMGN','GILD','CVS','MDT','ABT','TMO','DHR','ISRG','REGN','VRTX','BIIB','BSX','SYK','BAX','ILMN'],
  Energy:                   ['XOM','CVX','COP','SLB','PSX','EOG','MPC','VLO','OXY','HES','DVN','HAL','BKR','WMB','KMI','ET','EPD','LNG'],
  'Consumer Staples':       ['WMT','PG','KO','PEP','COST','PM','MO','CL','GIS','KHC','HSY','MKC','TSN','ADM'],
  'Consumer Discretionary': ['AMZN','HD','MCD','NKE','SBUX','LOW','TGT','TJX','EBAY','ROST','BKNG','ABNB','MAR','HLT','CMG','DPZ','DKNG'],
  Industrials:              ['HON','UNP','BA','CAT','GE','MMM','DE','EMR','ETN','ITW','LMT','RTX','NOC','GD','FDX','UPS','DAL','UAL','NSC','CSX'],
  'Real Estate':            ['AMT','PLD','EQIX','CCI','SPG','O','WELL','DLR','PSA','EXR','ARE','VTR'],
  Utilities:                ['NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','FE','XEL','WEC'],
  'Communication Services': ['META','GOOGL','NFLX','DIS','VZ','T','CMCSA','TMUS','SNAP','PINS','RDDT'],
  Materials:                ['LIN','APD','SHW','FCX','NEM','NUE','VMC','DOW','PPG','ALB'],
};

const TICKER_SECTOR = {};
for (const [s, ts] of Object.entries(SECTOR_MAP)) for (const t of ts) TICKER_SECTOR[t] = s;

export const REL_LABELS = { strong: 'C-Suite', medium: 'Officer', weak: 'Director' };
const OPEN_MARKET = new Set(['P', 'S']);

export function getSector(t) { return TICKER_SECTOR[(t||'').toUpperCase()] || 'Other'; }

// Build a direct link to the SEC EDGAR filing viewer.
// accession format from DB: "0001234567-26-012345"
// URL needs: CIK (no leading zeros) and accession with dashes.
export function secFilingUrl(accessionNumber, cikIssuer) {
  if (!accessionNumber) return null;
  // Some filings (congressional) don't have a CIK — no SEC link possible
  if (!cikIssuer) return null;
  const cik = String(cikIssuer).replace(/^0+/, '');
  const accDashed = accessionNumber; // already has dashes from DB
  const accNoDash = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accDashed}-index.htm`;
}

function getRel(title, isOfficer) {
  const t = (title||'').toLowerCase();
  if (isOfficer || /chief|ceo|cfo|coo|cto|president/.test(t)) return 'strong';
  if (/\bsvp\b|\bevp\b|senior v|managing|general counsel/.test(t)) return 'medium';
  return 'weak';
}

export function enrich(raw) {
  const rel = raw.relationship || getRel(raw.title, raw.isOfficer);
  const value = raw.value != null ? parseFloat(raw.value)
              : (raw.shares && raw.price ? Math.round(raw.shares * parseFloat(raw.price)) : null);
  let signal = 0;
  if (OPEN_MARKET.has(raw.transactionCode)) signal += 2;
  if (rel === 'strong') signal += 2;
  if (rel === 'congress') signal += 2;
  if (rel === 'medium') signal += 1;
  // Cohen et al. (2012): opportunistic trades contain ALL the predictive
  // power in insider trading. Routine trades yield ~0% abnormal returns.
  if (raw.isRoutine === false) signal += 3;
  if (value && value >= 1_000_000) signal += 3;
  else if (value && value >= 100_000) signal += 1;
  if (raw.transactionType === 'buy') signal += 1;

  return {
    ...raw,
    sector:       raw.sector || getSector(raw.ticker),
    relationship: rel,
    relLabel:     REL_LABELS[rel] || 'Director',
    value,
    signal,
    // Trust the database's own is_open_market value when present — it's
    // computed correctly at ingestion for every source (confirmed for both
    // SEC Form 4 codes and congressional CONGRESS_P/CONGRESS_S codes).
    // Previously this unconditionally overwrote that correct value with a
    // client-side recomputation checking membership in OPEN_MARKET, a set
    // containing only the bare SEC codes ('P', 'S') — which silently
    // evaluated to false for every congressional trade regardless of what
    // the database actually said, since their codes are 'CONGRESS_P' /
    // 'CONGRESS_S', not bare 'P'/'S'. This was the actual root cause of
    // congressional signals never appearing: buildSignals' very first
    // guard (`if (!f.isOpenMarket) continue`) discarded every congressional
    // filing before any downstream scoring logic ever ran, regardless of
    // how correct that logic was. Only recompute as a fallback when the
    // database value is genuinely missing, not to override a real one.
    isOpenMarket: raw.isOpenMarket ?? OPEN_MARKET.has(raw.transactionCode),
  };
}

// ── Auth header helper ────────────────────────────────────────────────────────
// Phase 1: API key from config
// Phase 2: Clerk JWT — set window.__clerkGetToken from app.jsx once Clerk loads
// Everything in this file calls getAuthHeaders() — nothing else needs to change
async function getAuthHeaders() {
  // Same race-condition fix as app.jsx's own getAuthHeaders — this file has
  // its own separate copy of this function. On a fresh page load,
  // fetchFromNeon (the function that loads filings, which everything
  // signal-related is built from) can fire before App's own effect has
  // registered window.__clerkGetToken, so this waits briefly for it rather
  // than sending an empty/wrong auth header and 401ing with nothing to
  // ever retry.
  if (!window.__clerkGetToken) {
    for (let i = 0; i < 40 && !window.__clerkGetToken; i++) {
      await new Promise(r => setTimeout(r, 50)); // up to ~2s total, matching app.jsx's own version exactly
    }
  }
  // Clerk JWT is the only auth path now — no static-key fallback. A
  // request with no valid token should fail with a real 401, not silently
  // succeed via a key that would otherwise sit in the public bundle
  // forever, used or not, the moment anyone set VITE_WORKER_API_KEY.
  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) return { 'Authorization': `Bearer ${token}` };
    } catch {}
  }
  return {};
}

// ── Main data fetch ───────────────────────────────────────────────────────────
async function fetchFromNeon(daysBack = 90) {
  // daysBack=null means "as wide as this user's plan allows" — the server
  // already clamps free users to 1 year (see neon-proxy.js's handleQuery),
  // so the client doesn't need to know the plan; it just asks for what the
  // UI wants and the server enforces the real ceiling. The historical floor
  // below (2021-01-01) is the absolute earliest data in the DB, not a plan
  // limit — that's enforced server-side regardless of what's requested here.
  let floorDate = '2021-01-01';
  if (daysBack != null) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    floorDate = d.toISOString().split('T')[0];
  }

  const sql = `
    SELECT
      accession_number,
      cik_issuer,
      filing_date            AS date,
      transaction_date,
      company_name           AS company,
      ticker,
      insider_name,
      insider_title          AS title,
      is_officer,
      is_director,
      is_ten_pct_owner       AS is_ten_pct,
      transaction_type,
      transaction_code,
      transaction_code_label,
      is_open_market,
      shares::float,
      price_per_share::float AS price,
      value::float,
      shares_owned_after::float,
      shares_owned_before::float,
      pct_owned_change::float,
      is_derivative,
      sector,
      relationship,
      is_routine,
      footnotes
    FROM public.filings
    WHERE COALESCE(transaction_date, filing_date) >= '${floorDate}'
      AND COALESCE(transaction_date, filing_date) <= CURRENT_DATE
      AND is_open_market = true
    ORDER BY COALESCE(transaction_date, filing_date) DESC,
             value DESC NULLS LAST
    LIMIT 50000
  `;

  // Normal fetch — no XHR needed since Babel is gone
  const res = await fetch(cfg.NEON_PROXY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body:    JSON.stringify({ query: sql }),
  });

  if (!res.ok) throw new Error(`Worker ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  return (data.rows || []).map(r => enrich({
    accessionNumber:      r.accession_number,
    cikIssuer:            r.cik_issuer,
    date:                 r.date,
    transactionDate:      r.transaction_date,
    company:              r.company,
    ticker:               r.ticker,
    insiderName:          r.insider_name,
    title:                r.title,
    isOfficer:            r.is_officer,
    isDirector:           r.is_director,
    isTenPct:             r.is_ten_pct,
    transactionType:      r.transaction_type,
    transactionCode:      r.transaction_code,
    transactionCodeLabel: r.transaction_code_label,
    isOpenMarket:         r.is_open_market,
    shares:               r.shares,
    price:                r.price,
    value:                r.value,
    sharesOwnedAfter:     r.shares_owned_after,
    sharesOwnedBefore:    r.shares_owned_before,
    pctOwnedChange:       r.pct_owned_change,
    isDerivative:         r.is_derivative,
    sector:               r.sector,
    relationship:         r.relationship,
    isRoutine:            r.is_routine,
    footnotes:            r.footnotes,
    currentPrice:         null,
    dayChangePct:         null,
    high52w:              null,
    low52w:               null,
    returnPct:            null,
  }));
}

export function computeSignals(filings) {
  const map = {};
  for (const f of filings) {
    if (!f.ticker) continue;
    if (!map[f.ticker]) {
      map[f.ticker] = {
        ticker: f.ticker, company: f.company, sector: f.sector,
        buys: 0, sells: 0, buyValue: 0, sellValue: 0, cSuiteBuys: 0,
        insiders: new Set(), lastTradeDate: '', trades: [],
      };
    }
    const s = map[f.ticker];
    s.insiders.add(f.insiderName);
    if ((f.transactionDate||f.date) > s.lastTradeDate) s.lastTradeDate = f.transactionDate||f.date;
    s.trades.push(f);
    if (f.transactionType === 'buy') {
      s.buys++; s.buyValue += f.value||0;
      if (f.isOpenMarket && f.relationship === 'strong') s.cSuiteBuys++;
    } else if (f.transactionType === 'sell') {
      s.sells++; s.sellValue += f.value||0;
    }
  }
  return Object.values(map).map(s => ({
    ...s,
    insiderCount: s.insiders.size,
    netValue:     s.buyValue - s.sellValue,
    conviction:   (s.cSuiteBuys * 5) + (s.buys - s.sells) + Math.min(Math.log10(s.buyValue + 1), 5),
    avgReturn:    null, // prices table not yet available
  })).sort((a,b) => b.conviction - a.conviction);
}

export async function loadFilings(daysBack = 90) {
  switch (cfg.DATA_SOURCE) {
    case 'neon':
    case 'proxy': return fetchFromNeon(daysBack);
    default:      return [];
  }
}
