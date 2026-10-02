// worker/lib/intel.js
// JS port of db/email_kit.py (formatting) + db/insider_intel.py (clusters,
// status, sentences). The app's stock/insider/home pages use these so the
// site and the emails describe the same filing with the same words.
// If you change wording in one, change it in the other.

// ── Formatting (email_kit.py) ────────────────────────────────────────────────
export function money(v) {
  if (v == null || Number.isNaN(Number(v))) return 'n/a';
  let n = Number(v);
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  for (const [div, suf] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= div * 0.9995) {
      const x = n / div;
      const s = x >= 99.95 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1).replace(/\.0$/, '');
      return `${sign}$${s}${suf}`;
    }
  }
  return `${sign}$${Math.round(n).toLocaleString('en-US')}`;
}

const CONGRESS_RANGES = [[1e3, 15e3], [15e3, 50e3], [50e3, 100e3], [100e3, 250e3], [250e3, 500e3],
  [500e3, 1e6], [1e6, 5e6], [5e6, 25e6], [25e6, 50e6]];
export function congressRange(v) {
  if (v == null) return 'an undisclosed amount';
  for (const [lo, hi] of CONGRESS_RANGES) if (Number(v) <= hi) return `${money(lo)} to ${money(hi)}`;
  return 'over $50M';
}

export function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

export function asDate(d) {
  if (!d) return null;
  const s = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
export function todayStr() { return new Date().toISOString().slice(0, 10); }

export function ago(d, today = todayStr()) {
  d = asDate(d);
  if (!d) return '';
  const days = daysBetween(d, today);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

const ENTITY_RE = /\b(INC|LLC|L\.?P\.?|LTD|CORP|CO|FUND|TRUST|CAPITAL|PARTNERS|HOLDINGS|MANAGEMENT|ADVISORS|ADVISERS|GROUP|INVESTMENTS?|VENTURES|FOUNDATION|BANK|PLC|SA|AG|NV|GP|MASTER)\b/i;
// Companies, funds and trusts that file as 'insiders' (e.g. 10% owners).
export const isEntityName = name => ENTITY_RE.test(name || '');
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'MD', 'PHD']);
const SMALL = new Set(['of', 'and', 'the', 'for', '&']);
const KEEP_UPPER = new Set(['LLC', 'LP', 'GP', 'PLC', 'USA', 'US', 'NV', 'SA', 'AG', 'REIT', 'ETF', 'II', 'III', 'IV', 'AT&T']);
const cap = w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
function titleWord(w) {
  if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
  if (w.includes('&') && w.length <= 5) return w.toUpperCase();
  if (w.includes('-')) return w.split('-').map(titleWord).join('-');
  if (w.toUpperCase().startsWith('MC') && w.length > 3) return 'Mc' + cap(w.slice(2));
  // O'REILLY -> O'Reilly, but DICK'S -> Dick's (a lone letter after ' is a suffix, not a name)
  if (w.includes("'")) return w.split("'").map((p, i) => (i > 0 && p.length <= 1 ? p.toLowerCase() : cap(p))).join("'");
  return cap(w);
}
const BRAND_CASE = {
  RENAISSANCERE: 'RenaissanceRe', PAYPAL: 'PayPal', EBAY: 'eBay', IROBOT: 'iRobot', JPMORGAN: 'JPMorgan',
  ABBVIE: 'AbbVie', BLACKROCK: 'BlackRock', FEDEX: 'FedEx', GODADDY: 'GoDaddy', HUBSPOT: 'HubSpot',
  CROWDSTRIKE: 'CrowdStrike', DOORDASH: 'DoorDash', LINKEDIN: 'LinkedIn', MONGODB: 'MongoDB', NETAPP: 'NetApp',
  PEPSICO: 'PepsiCo', SERVICENOW: 'ServiceNow', AUTOZONE: 'AutoZone', CARMAX: 'CarMax', DEXCOM: 'DexCom',
  HEALTHCARE: 'HealthCare', JETBLUE: 'JetBlue', SOLAREDGE: 'SolarEdge', DRAFTKINGS: 'DraftKings', NVIDIA: 'NVIDIA',
  YOUTUBE: 'YouTube', EXXONMOBIL: 'ExxonMobil', GLAXOSMITHKLINE: 'GlaxoSmithKline', ASTRAZENECA: 'AstraZeneca',
  BIONTECH: 'BioNTech', ZOOMINFO: 'ZoomInfo', MCKESSON: 'McKesson',
};
const SUFFIX_CASE = {
  INC: 'Inc', 'INC.': 'Inc', CORP: 'Corp', 'CORP.': 'Corp', CO: 'Co', 'CO.': 'Co', LTD: 'Ltd', 'LTD.': 'Ltd',
  PLC: 'plc', LLC: 'LLC', LP: 'LP', 'L.P.': 'LP', 'N.V.': 'NV', NV: 'NV', 'S.A.': 'SA', SA: 'SA', AG: 'AG', SE: 'SE',
  CORPORATION: 'Corporation', HOLDINGS: 'Holdings', GROUP: 'Group', COMPANY: 'Company', INCORPORATED: 'Incorporated',
};

export function prettyCompany(name) {
  if (!name) return '';
  const s = String(name).split(/\s+/).filter(Boolean).join(' ');
  const allCaps = s === s.toUpperCase();
  return s.split(' ').map((w, i) => {
    const comma = w.endsWith(',') ? ',' : '';
    const core = comma ? w.slice(0, -1) : w;
    const up = core.toUpperCase();
    let word;
    if (i && SUFFIX_CASE[up]) word = SUFFIX_CASE[up];
    else if (BRAND_CASE[up]) word = BRAND_CASE[up];
    else if (!allCaps) word = core;
    else if (i && SMALL.has(core.toLowerCase())) word = core.toLowerCase();
    else if (core.replace(/\./g, '').length <= 3) word = core;
    else word = titleWord(core);
    return word + comma;
  }).join(' ');
}

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'st', 'st.', 'bin', 'al', 'el', 'ten', 'ter']);
const HONORIFICS = new Set(['dr', 'hon', 'honorable', 'mr', 'mrs', 'ms']);
export function prettyPerson(name, isCongress = false) {
  if (!name) return '';
  const s = String(name).replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  const allCaps = s === s.toUpperCase();
  const words = s.split(' ');
  const fix = allCaps ? titleWord : (w => w);
  // House names arrive with honorifics mixed in ("Richard Dean Dr McCormick").
  if (isCongress) return words.filter(w => !HONORIFICS.has(w.replace(/\./g, '').toLowerCase())).map(fix).join(' ');
  if (ENTITY_RE.test(s) || words.length < 2 || words.length > 6) return words.map(fix).join(' ');
  const strip = w => w.replace(/\./g, '').toUpperCase();
  const suffix = words.filter(w => SUFFIXES.has(strip(w)));
  let core = words.filter(w => !SUFFIXES.has(strip(w)));
  if (core.length >= 2) {
    let n = 0;
    while (n < core.length - 1 && PARTICLES.has(core[n].toLowerCase())) n++;
    if (core.slice(n + 1).length) core = [...core.slice(n + 1), ...core.slice(0, n + 1)];
  }
  return [...core, ...suffix].map(fix).join(' ');
}

const ROLE_PATTERNS = [
  [/\bceo\b|chief executive/i, 'CEO'], [/\bcfo\b|chief financial/i, 'CFO'], [/\bcoo\b|chief operating/i, 'COO'],
  [/\bcto\b|chief tech/i, 'CTO'], [/chief\s+\w+\s+officer|\bc[a-z]o\b/i, 'C-suite exec'], [/\bpresident\b/i, 'President'],
  [/chair/i, 'Chair'], [/\bevp\b|\bsvp\b|vice pres|\bvp\b/i, 'VP'], [/general counsel/i, 'General Counsel'],
  [/10%|ten percent/i, '10% owner'], [/director/i, 'Director'],
];
export function shortRole(title, relationship) {
  if (relationship === 'congress') return 'Congress';
  const t = title || '';
  for (const [rx, label] of ROLE_PATTERNS) if (rx.test(t)) return label;
  return relationship === 'strong' || relationship === 'medium' ? 'Officer' : 'Insider';
}
export const CSUITE_ROLES = new Set(['CEO', 'CFO', 'COO', 'CTO', 'President', 'C-suite exec']);

export function isCongress(r) {
  return r.relationship === 'congress' || String(r.transaction_code || '').toUpperCase().startsWith('CONGRESS');
}

const CORP_SUFFIX = /[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group|incorporated|n\.?v\.?|s\.?a\.?)\.?$/i;
export function shortCompany(name) {
  let s = name || '';
  for (let i = 0; i < 2; i++) s = s.replace(CORP_SUFFIX, '').trim();
  return s || name;
}

function roleBit(role) {
  if (role === 'Congress') return 'a member of Congress';
  if (role === '10% owner') return 'a 10% owner';
  if (CSUITE_ROLES.has(role) || role === 'Chair' || role === 'General Counsel') return `the ${role}`;
  return `a ${role.toLowerCase()}`;
}

// ── Clusters (insider_intel.build_clusters) ──────────────────────────────────
function stakeLabel(pct, ownedBefore) {
  if (pct == null) return ownedBefore != null && ownedBefore <= 0 ? 'New position' : null;
  if (pct < 5) return null;
  if (pct < 100) return `+${Math.round(pct)}% stake`;
  const mult = 1 + pct / 100;
  return mult >= 10 ? `Stake ${Math.round(mult)}x` : `Stake ${mult.toFixed(1).replace(/\.0$/, '')}x`;
}

function rankScore(c) {
  const n = c.n_insiders;
  let s = ({ 1: 0, 2: 18, 3: 28 })[n] ?? 32;
  if (c.csuite.length) s += 20;
  else if (c.buyers.some(b => ['Chair', 'VP', 'General Counsel', 'Officer'].includes(b.role))) s += 8;
  if (c.congress) s += 6;
  if (c.nonroutine) s += 10;
  s += Math.max(0, Math.min(21, 7 * Math.log10(Math.max(c.total, 1) / 25000)));
  const mp = c.max_pct || 0;
  s += mp >= 50 ? 14 : mp >= 25 ? 10 : mp >= 10 ? 6 : 0;
  if (c.first_buy.length) s += 8;
  if (n === 1 && c.buyers[0].role === '10% owner') s -= 12;
  return Math.max(0, Math.min(100, s));
}

// Closed-end funds and similar vehicles file Form 4s too, but a fund
// director topping up an income fund isn't what people come here for.
// Only used for the market-wide lists; stock pages still show everything.
const FUND_RE = /\bFUNDS?\b|\b(INCOME|MUNICIPAL|MUNI|CREDIT|BOND|OPPORTUNITIES|DIVIDEND|STRATEGIES|STRATEGIC)\s+(TRUST|SECURITIES|PORTFOLIO)\b|\bINVESTORS\s+CO\b/i;
export const isFundName = name => FUND_RE.test(name || '');

export function buildClusters(buys, { includeCorporate = true, includeCongress = true } = {}) {
  const byTicker = new Map();
  for (const r of buys) {
    if (isFundName(r.company_name)) continue;
    const cg = isCongress(r);
    if ((cg && !includeCongress) || (!cg && !includeCorporate)) continue;
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  const clusters = [];
  for (const [ticker, rows] of byTicker) {
    const buyers = new Map();
    for (const r of rows) {
      const cg = isCongress(r);
      if (!buyers.has(r.insider_name)) buyers.set(r.insider_name, {
        raw: r.insider_name, name: prettyPerson(r.insider_name, cg), title: r.insider_title || '',
        role: shortRole(r.insider_title, cg ? 'congress' : r.relationship), value: 0, pct: null,
        owned_before: r.owned_before, last_trade: null, prior_buy_date: asDate(r.prior_buy_date),
        nonroutine: false, congress: cg,
      });
      const b = buyers.get(r.insider_name);
      b.value += Number(r.value) || 0;
      if (r.pct != null) b.pct = Math.max(b.pct || 0, Number(r.pct));
      const td = asDate(r.trade_date);
      if (td && (!b.last_trade || td > b.last_trade)) b.last_trade = td;
      if (r.is_routine === false) b.nonroutine = true;
      const pb = asDate(r.prior_buy_date);
      if (pb && (!b.prior_buy_date || pb > b.prior_buy_date)) b.prior_buy_date = pb;
    }
    const blist = [...buyers.values()].sort((a, b) => b.value - a.value);
    for (const b of blist) {
      const gap = b.prior_buy_date && b.last_trade ? daysBetween(b.prior_buy_date, b.last_trade) / 365.25 : null;
      b.gap_years = gap;
      b.first_buy = !b.prior_buy_date || (gap != null && gap >= 2);
      b.stake = stakeLabel(b.pct, b.owned_before);
    }
    const c = {
      ticker, company: prettyCompany(rows[0].company_name) || ticker, buyers: blist,
      n_insiders: blist.length, total: blist.reduce((s, b) => s + b.value, 0),
      csuite: blist.filter(b => CSUITE_ROLES.has(b.role)),
      congress: blist.some(b => b.congress), nonroutine: blist.some(b => b.nonroutine),
      max_pct: Math.max(0, ...blist.map(b => b.pct || 0)),
      first_buy: blist.filter(b => b.first_buy && b.role !== '10% owner'),
      last_trade: blist.map(b => b.last_trade).filter(Boolean).sort().pop() || null,
    };
    c.score = rankScore(c);
    c.facts = clusterFacts(c);
    clusters.push(c);
  }
  clusters.sort((a, b) => (b.score - a.score) || (b.total - a.total));
  return clusters;
}

function rolesPhrase(bs) {
  const roles = [];
  for (const b of bs) if (!roles.includes(b.role)) roles.push(b.role);
  return roles.slice(0, 2).join(' + ');
}

export function clusterFacts(c) {
  const f = [];
  if (c.n_insiders >= 2) f.push([`${c.n_insiders} insiders buying`, 'buy']);
  if (c.csuite.length) f.push([`${rolesPhrase(c.csuite)} buying`, 'buy']);
  else if (c.congress) f.push(['Member of Congress', 'accent']);
  if (c.first_buy.length) {
    const g = c.first_buy[0].gap_years;
    f.push([g ? `First buy in ${Math.round(g)} yrs` : 'First buy on record', 'accent']);
  }
  // Same person the lead sentence is about, so the chip and the sentence agree.
  // If the top buyer has no stake figure, name whose stake it is.
  const top = c.buyers[0];
  const stakes = c.buyers.filter(b => b.stake);
  if (top.stake) f.push([top.stake, 'neutral']);
  else if (stakes.length) { const s = stakes.reduce((a, b) => ((b.pct || 0) > (a.pct || 0) ? b : a)); f.push([`${s.stake} (${s.role})`, 'neutral']); }
  if (c.nonroutine) f.push(['Non-routine', 'neutral']);
  return f.slice(0, 5);
}

export function leadSentence(c, period = 'this week') {
  const top = c.buyers[0];
  let s;
  if (c.n_insiders >= 2) {
    s = `${c.n_insiders} insiders at ${c.company} bought ${money(c.total)} of stock ${period}. The biggest check came from ${top.name}, ${roleBit(top.role)}, at ${money(top.value)}`;
  } else {
    s = `${top.name}, ${roleBit(top.role)} at ${c.company}, bought ${money(top.value)} of stock on the open market`;
  }
  if (top.pct != null && top.pct >= 5) {
    s += top.pct < 100 ? `, growing their stake by ${Math.round(top.pct)}%`
      : `, growing their stake ${(1 + top.pct / 100).toFixed(1).replace(/\.0$/, '')}x`;
  }
  s += '.';
  const fb = c.first_buy.filter(b => b.gap_years);
  if (fb.length) s += ` It's ${fb[0].name}'s first open-market buy of ${c.ticker} in ${Math.round(fb[0].gap_years)} years.`;
  else if (c.first_buy.length && c.first_buy[0] === top) s += ` It's the first open-market buy of ${c.ticker} on record for ${top.name}.`;
  return s;
}

export function filingContext(c) {
  const fb = c.first_buy.filter(b => b.gap_years);
  if (c.n_insiders >= 3) return 'When several insiders at one company file open-market buys within a few weeks, it\'s called a cluster. Clusters show up less often than single buys, which is why Seli points them out.';
  if (fb.length) return `${fb[0].name} hadn't filed an open-market buy of ${c.ticker} in ${Math.round(fb[0].gap_years)} years. Seli flags it when an insider's filings break from their usual pattern.`;
  if (c.csuite.length) return 'Most executive stock comes from grants and option exercises. An open-market buy means the executive paid market price with their own money, which happens less often.';
  if ((c.max_pct || 0) >= 25) return 'Stake change compares the shares bought to what the insider already held, so the dollar amount can be read against the size of their existing position.';
  if (c.congress) return 'Congressional trades are disclosed under the STOCK Act, often weeks after the trade date.';
  return 'Open-market buys are trades an insider chose to make at market price, as opposed to grants, option exercises or pre-scheduled plan trades.';
}

// Serializable cluster for the client (drops internal-only fields).
export function clusterOut(c, period) {
  return {
    ticker: c.ticker, company: c.company, total: c.total, n_insiders: c.n_insiders,
    facts: c.facts.map(([label, tone]) => ({ label, tone })),
    buyers: c.buyers.slice(0, 6).map(b => ({ raw: b.raw, name: b.name, role: b.role, value: b.value, stake: b.stake, congress: b.congress })),
    more_buyers: Math.max(0, c.buyers.length - 6),
    lead: leadSentence(c, period), context: filingContext(c), last_trade: c.last_trade, congress: c.congress,
  };
}

// ── Ticker status (insider_intel.ticker_status) ──────────────────────────────
function agg(rows) {
  const per = new Map();
  for (const r of rows) {
    const cg = isCongress(r);
    if (!per.has(r.insider_name)) per.set(r.insider_name, {
      raw: r.insider_name, name: prettyPerson(r.insider_name, cg),
      role: shortRole(r.insider_title, cg ? 'congress' : r.relationship), value: 0, pct: null, last: null,
    });
    const p = per.get(r.insider_name);
    p.value += Number(r.value) || 0;
    if (r.pct != null) p.pct = Math.max(p.pct || 0, Number(r.pct));
    const td = asDate(r.trade_date);
    if (td && (!p.last || td > p.last)) p.last = td;
  }
  const people = [...per.values()].sort((a, b) => b.value - a.value);
  return { n: new Set(rows.map(r => r.accession_number)).size, v: rows.reduce((s, r) => s + (Number(r.value) || 0), 0), insiders: people.length, people };
}

const totalsOf = x => ({ n: Number(x?.n) || 0, v: Number(x?.v) || 0, insiders: 0, people: [] });

function congressView(rs) {
  rs = [...rs].sort((a, b) => (asDate(b.trade_date) || '').localeCompare(asDate(a.trade_date) || ''));
  return { n: rs.length, latest: rs.length ? { raw: rs[0].insider_name, name: prettyPerson(rs[0].insider_name, true), type: rs[0].transaction_type, value: rs[0].value, date: asDate(rs[0].trade_date) } : null };
}

// rows: open-market buy/sell rows for these tickers in the last ~380 days.
// lastBuys: {ticker: row} most recent corporate open-market buy ever.
// names: {ticker: company_name}
// yearTotals (optional): {ticker: {buy: {n, v}, sell: {n, v}}} precomputed in
// SQL. When given, rows only need the recent window (plus Congress for the
// year), which keeps big watchlists from pulling a year of rows per ticker.
export function tickerStatus(tickers, rows, lastBuys, names, windowDays, today = todayStr(), yearTotals = null) {
  const byT = new Map();
  for (const r of rows) { if (!byT.has(r.ticker)) byT.set(r.ticker, []); byT.get(r.ticker).push(r); }
  const out = {};
  for (const t of tickers) {
    const rs = byT.get(t) || [];
    const corp = rs.filter(r => !isCongress(r));
    const cong = rs.filter(r => isCongress(r));
    const isRecent = r => asDate(r.filing_date) && daysBetween(asDate(r.filing_date), today) < windowDays;
    const inYear = r => asDate(r.trade_date) && daysBetween(asDate(r.trade_date), today) <= 365;
    const lb = lastBuys[t];
    const s = {
      ticker: t,
      company: prettyCompany(names[t] || lb?.company_name) || t,
      known: !!names[t],
      recent_buys: agg(corp.filter(r => isRecent(r) && r.transaction_type === 'buy')),
      recent_sells: agg(corp.filter(r => isRecent(r) && r.transaction_type === 'sell')),
      yr_buys: yearTotals ? totalsOf(yearTotals[t]?.buy) : agg(corp.filter(r => inYear(r) && r.transaction_type === 'buy')),
      yr_sells: yearTotals ? totalsOf(yearTotals[t]?.sell) : agg(corp.filter(r => inYear(r) && r.transaction_type === 'sell')),
      last_buy: lb ? { raw: lb.insider_name, name: prettyPerson(lb.insider_name, false), role: shortRole(lb.insider_title, lb.relationship), value: lb.value, date: asDate(lb.trade_date) } : null,
      recent_congress: congressView(cong.filter(isRecent)),
      yr_congress: congressView(cong.filter(inYear)),
    };
    s.lines = statusLines(s, windowDays, today);
    s.active = !!(s.recent_buys.n || s.recent_sells.n || s.recent_congress.n);
    out[t] = s;
  }
  return out;
}

function summarizePeople(people) {
  if (!people.length) return '';
  const head = `${people[0].name} (${people[0].role})`;
  return people.length > 1 ? `${head} and ${plural(people.length - 1, 'other')}` : head;
}

// Plain-English lines for one ticker. First line is the headline.
// Mirrors send_welcome.follow_row (long view) + send_digests.status_row (recent view).
export function statusLines(s, windowDays, today = todayStr()) {
  const { recent_buys: rb, recent_sells: rs, yr_buys: yb, yr_sells: ys, last_buy: lb, yr_congress: yc, recent_congress: rc } = s;
  const period = windowDays <= 1 ? 'today' : windowDays <= 7 ? 'this week' : `in the last ${windowDays} days`;
  const lines = [];
  if (!s.known) return ['No insider filings on record yet.'];
  if (rb.n) {
    let l = `${summarizePeople(rb.people)} bought ${money(rb.v)} ${period}.`;
    const top = rb.people[0];
    if (top.pct && top.pct >= 5) l = l.slice(0, -1) + (top.pct < 100 ? `, growing their stake ${Math.round(top.pct)}%.` : ', more than doubling their stake.');
    lines.push(l);
  }
  if (rs.n) lines.push(`${summarizePeople(rs.people)} sold ${money(rs.v)} ${period}.`);
  if (!rb.n && !rs.n) {
    if (yb.n && yb.v >= 100000) lines.push(`Insiders bought ${money(yb.v)} over the last 12 months (${plural(yb.n, 'buy')}).`);
    if (ys.n) lines.push(`Insiders sold ${money(ys.v)} over the last 12 months (${plural(ys.n, 'sale')}).${yb.n ? '' : ' No open-market buys.'}`);
    if (!lines.length) lines.push('No open-market insider trades in the last 12 months.');
  }
  if (lb && !rb.n) lines.push(`Last insider buy: ${lb.name} (${lb.role}), ${money(lb.value)}, ${ago(lb.date, today)}.`);
  else if (!lb) lines.push('No open-market insider buys on record.');
  const c = rc.n ? rc.latest : yc.n ? yc.latest : null;
  if (c) lines.push(`Congress: ${c.name} ${c.type === 'buy' ? 'bought' : 'sold'} ${congressRange(c.value)}, ${ago(c.date, today)}.`);
  return lines;
}
