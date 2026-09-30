// src/lib/text.js — display formatting shared by the research pages.
// Wording and number formats match the emails (db/email_kit.py) and the
// Worker's worker/lib/intel.js, so a stock reads the same everywhere.

export function money(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
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
// STOCK Act amounts are ranges; the DB stores the midpoint. Show the range.
export function congressRange(v) {
  if (v == null) return 'undisclosed';
  for (const [lo, hi] of CONGRESS_RANGES) if (Number(v) <= hi) return `${money(lo)}–${money(hi)}`;
  return 'over $50M';
}
export const amount = (v, congress) => (congress ? congressRange(v) : money(v));

export function price(v) {
  if (v == null || !(Number(v) > 0)) return '—';
  const n = Number(v);
  return `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
}

export function shares(v) {
  if (v == null) return '—';
  const n = Math.abs(Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function pct(v, digits = 0) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Dates arrive as 'YYYY-MM-DD'. Never run them through new Date(str) (that
// parses as UTC midnight and shows the previous day in US time zones).
export function shortDate(d, { year = 'auto' } = {}) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m) return '';
  const thisYear = new Date().getFullYear();
  const showYear = year === true || (year === 'auto' && y !== thisYear);
  return `${MONTHS[m - 1]} ${day}${showYear ? `, ${y}` : ''}`;
}

export function daysAgo(d) {
  if (!d) return null;
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  const then = Date.UTC(y, m - 1, day);
  const now = new Date();
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
}

export function ago(d) {
  const days = daysAgo(d);
  if (days == null) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export const TX_CODES = {
  P: 'Open-market purchase', S: 'Open-market sale', A: 'Grant or award', M: 'Option exercise',
  F: 'Shares withheld for taxes', G: 'Gift', D: 'Returned to company', C: 'Conversion', X: 'Option exercise',
  J: 'Other', W: 'Inheritance', I: 'Discretionary',
};
export function codeLabel(code) {
  if (!code) return '';
  if (String(code).toUpperCase().startsWith('CONGRESS')) return 'STOCK Act disclosure';
  return TX_CODES[code] || `Code ${code}`;
}

export const edgarCompanyUrl = cik => (cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(cik).replace(/^0+/, '')}&type=4&owner=include` : null);

// One score, one scale, one set of labels, everywhere (app, onboarding, help).
export const SCORE_TIERS = [
  { min: 60, label: 'High', tone: 'buy', blurb: 'Several strong markers at once: senior insiders, open-market, non-routine, meaningful size, often more than one insider.' },
  { min: 35, label: 'Medium', tone: 'accent', blurb: 'Clears a few markers. Worth a look, especially on stocks you already follow.' },
  { min: 1, label: 'Low', tone: 'neutral', blurb: 'Some signal, but small, routine-looking or from further down the org chart.' },
];
export function scoreTier(score) {
  const s = Number(score) || 0;
  return SCORE_TIERS.find(t => s >= t.min) || { label: 'Not scored', tone: 'neutral' };
}

// Name formatting, same as the emails: 'HUANG JEN HSUN' -> 'Jen Hsun Huang'.
const ENTITY_RE = /\b(INC|LLC|L\.?P\.?|LTD|CORP|CO|FUND|TRUST|CAPITAL|PARTNERS|HOLDINGS|MANAGEMENT|ADVISORS|ADVISERS|GROUP|INVESTMENTS?|VENTURES|FOUNDATION|BANK|PLC|SA|AG|NV|GP|MASTER)\b/i;
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
export function prettyPerson(name, isCongress = false) {
  if (!name) return '';
  const s = String(name).replace(/,/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  const allCaps = s === s.toUpperCase();
  const words = s.split(' ');
  const fix = allCaps ? titleWord : (w => w);
  if (isCongress || ENTITY_RE.test(s) || words.length < 2 || words.length > 6) return words.map(fix).join(' ');
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


// Companies, funds and trusts that file as 'insiders' (e.g. 10% owners).
export const isEntityName = name => ENTITY_RE.test(name || '');
