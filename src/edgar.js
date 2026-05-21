// src/edgar.js — SEC Form 4 data layer
(function (global) {

  const SECTOR_MAP = {
    Technology:               ['AAPL','MSFT','GOOGL','GOOG','META','NVDA','AMZN','TSLA','INTC','AMD','ORCL','CRM','ADBE','QCOM','TXN','AVGO','NOW','SNOW','PLTR','IBM','CSCO','INTU','DDOG','PANW','CRWD','NET','ZS','MDB','OKTA'],
    Finance:                  ['JPM','BAC','WFC','GS','MS','C','BLK','AXP','V','MA','SCHW','USB','PNC','TFC','COF','SPGI','MCO','ICE','CME','BX','KKR','APO','CG'],
    Healthcare:               ['JNJ','PFE','UNH','ABBV','MRK','LLY','BMY','AMGN','GILD','CVS','MDT','ABT','TMO','DHR','ISRG','REGN','VRTX','BIIB','BSX','SYK','BAX','ILMN'],
    Energy:                   ['XOM','CVX','COP','SLB','PSX','EOG','MPC','VLO','OXY','HES','DVN','HAL','BKR','WMB','KMI','ET','EPD','LNG'],
    'Consumer Staples':       ['WMT','PG','KO','PEP','COST','PM','MO','CL','GIS','KHC','HSY','MKC','TSN','ADM'],
    'Consumer Discretionary': ['AMZN','HD','MCD','NKE','SBUX','LOW','TGT','TJX','EBAY','ROST','BKNG','ABNB','MAR','HLT','CMG'],
    Industrials:              ['HON','UNP','BA','CAT','GE','MMM','DE','EMR','ETN','ITW','LMT','RTX','NOC','GD','FDX','UPS','DAL'],
    'Real Estate':            ['AMT','PLD','EQIX','CCI','SPG','O','WELL','DLR','PSA','EXR'],
    Utilities:                ['NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','FE','XEL','WEC'],
    'Communication Services': ['META','GOOGL','NFLX','DIS','VZ','T','CMCSA','TMUS','SNAP','PINS','RDDT'],
    Materials:                ['LIN','APD','SHW','FCX','NEM','NUE','VMC','DOW','PPG','ALB'],
  };

  const TICKER_SECTOR = {};
  for (const [s, ts] of Object.entries(SECTOR_MAP)) for (const t of ts) TICKER_SECTOR[t] = s;
  const REL_LABELS = { strong: 'C-Suite', medium: 'Officer', weak: 'Director' };
  const OPEN_MARKET = new Set(['P', 'S']);

  function getSector(t)  { return TICKER_SECTOR[(t||'').toUpperCase()] || 'Other'; }
  function getRel(title, isOfficer, isDir, isTen) {
    const t = (title||'').toLowerCase();
    if (isOfficer || /chief|ceo|cfo|coo|cto|president/.test(t)) return 'strong';
    if (/\bsvp\b|\bevp\b|senior v|managing|general counsel/.test(t)) return 'medium';
    return 'weak';
  }

  function enrich(raw) {
    const rel = raw.relationship || getRel(raw.title, raw.isOfficer, raw.isDirector, raw.isTenPct);
    const value = raw.value != null ? parseFloat(raw.value)
                : (raw.shares && raw.price ? Math.round(raw.shares * parseFloat(raw.price)) : null);
    const isOM = raw.isOpenMarket || OPEN_MARKET.has(raw.transactionCode);

    // Conviction score — used to rank signals
    // Open-market + C-suite + large value + big % position change = high score
    let conviction = 0;
    if (isOM) conviction += 2;
    if (rel === 'strong') conviction += 3;
    if (rel === 'medium') conviction += 1;
    if (value >= 1_000_000) conviction += 3;
    else if (value >= 500_000) conviction += 2;
    else if (value >= 100_000) conviction += 1;
    if (raw.transactionType === 'buy') conviction += 1;
    // pct_owned_change: the single most important signal quality metric
    const pct = raw.pctOwnedChange ? parseFloat(raw.pctOwnedChange) : null;
    if (pct >= 50) conviction += 4;
    else if (pct >= 20) conviction += 2;
    else if (pct >= 5)  conviction += 1;

    return {
      ...raw,
      sector:          raw.sector || getSector(raw.ticker),
      relationship:    rel,
      relLabel:        REL_LABELS[rel] || 'Director',
      value,
      conviction,
      isOpenMarket:    isOM,
      pctOwnedChange:  pct,
    };
  }

  // ── Neon HTTP SQL API ──────────────────────────────────────────────────────
  async function fetchFromNeon(cfg) {
    const days  = cfg.DEFAULT_DAYS_BACK || 30;
    const since = new Date(); since.setDate(since.getDate() - days);
    const iso   = since.toISOString().split('T')[0];

    const sql = `
      SELECT
        accession_number,
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
        footnotes
      FROM public.filings
      WHERE COALESCE(transaction_date, filing_date) >= '${iso}'
      ORDER BY COALESCE(transaction_date, filing_date) DESC, value DESC NULLS LAST
      LIMIT 2000
    `;

    const res = await fetch(`${cfg.NEON_API_URL}/sql`, {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'Authorization':          `Bearer ${cfg.NEON_API_KEY}`,
        'Neon-Connection-String': `postgresql://${cfg.NEON_ROLE}@${cfg.NEON_API_URL.replace('https://','')}/${cfg.NEON_DATABASE}`,
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!res.ok) throw new Error(`Neon ${res.status}: ${await res.text().catch(()=>'')}`);
    const data = await res.json();

    return (data.rows || []).map(r => enrich({
      accessionNumber:      r.accession_number,
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
      footnotes:            r.footnotes,
    }));
  }

  // ── Demo data ──────────────────────────────────────────────────────────────
  function generateDemo(cfg) {
    const cos = [
      {name:'Apple Inc',t:'AAPL'},{name:'NVIDIA Corp',t:'NVDA'},{name:'Microsoft Corp',t:'MSFT'},
      {name:'Amazon.com',t:'AMZN'},{name:'Meta Platforms',t:'META'},{name:'Alphabet Inc',t:'GOOGL'},
      {name:'JPMorgan Chase',t:'JPM'},{name:'Goldman Sachs',t:'GS'},{name:'Pfizer Inc',t:'PFE'},
      {name:'Eli Lilly',t:'LLY'},{name:'ExxonMobil',t:'XOM'},{name:'Tesla Inc',t:'TSLA'},
      {name:'Visa Inc',t:'V'},{name:'UnitedHealth',t:'UNH'},{name:'Chevron Corp',t:'CVX'},
      {name:'Home Depot',t:'HD'},{name:'Broadcom Inc',t:'AVGO'},{name:'AbbVie Inc',t:'ABBV'},
      {name:'Costco Wholesale',t:'COST'},{name:'Netflix Inc',t:'NFLX'},
    ];
    const ins = [
      {name:'Timothy D. Cook',title:'Chief Executive Officer',isOfficer:true},
      {name:'Jensen Huang',title:'President and CEO',isOfficer:true},
      {name:'Satya Nadella',title:'Chief Executive Officer',isOfficer:true},
      {name:'Andy Jassy',title:'Chief Executive Officer',isOfficer:true},
      {name:'Mark Zuckerberg',title:'Chairman and CEO',isOfficer:true},
      {name:'Lisa Su',title:'Chief Executive Officer',isOfficer:true},
      {name:'Sarah Chen',title:'Senior Vice President',isOfficer:true},
      {name:'Robert Martinez',title:'Chief Financial Officer',isOfficer:true},
      {name:'Lisa Thompson',title:'Executive Vice President',isOfficer:true},
      {name:'James Wilson',title:'Chief Operating Officer',isOfficer:true},
      {name:'Emily Rodriguez',title:'Director',isOfficer:false},
      {name:'Michael Zhang',title:'10% Owner',isOfficer:false},
    ];
    const txTypes = [
      {code:'P',label:'Open Market Purchase',type:'buy',om:true},
      {code:'S',label:'Open Market Sale',type:'sell',om:true},
      {code:'M',label:'Exercise of Derivative',type:'buy',om:false},
      {code:'F',label:'Tax Withholding (Sale)',type:'sell',om:false},
      {code:'A',label:'Grant / Award',type:'buy',om:false},
    ];
    const result = [];
    const now = new Date();
    const days = cfg.DEFAULT_DAYS_BACK || 30;
    for (let i = 0; i < 200; i++) {
      const co  = cos[Math.floor(Math.random() * cos.length)];
      const inn = ins[Math.floor(Math.random() * ins.length)];
      const tx  = txTypes[Math.floor(Math.random() * txTypes.length)];
      const d   = new Date(now); d.setDate(d.getDate() - Math.floor(Math.random() * days));
      const fd  = new Date(d);  fd.setDate(fd.getDate() + Math.floor(Math.random() * 4) + 1);
      const shares = Math.floor(Math.random() * 400000 + 500);
      const price  = parseFloat((Math.random() * 500 + 10).toFixed(2));
      const sharesAfter = Math.floor(Math.random() * 2000000 + shares);
      const sharesBefore = tx.type === 'buy' ? sharesAfter - shares : sharesAfter + shares;
      const pctChange = sharesBefore > 0 ? parseFloat(((shares / sharesBefore) * 100).toFixed(2)) : null;
      result.push(enrich({
        accessionNumber:      `demo-${i}`,
        date:                 fd.toISOString().split('T')[0],
        transactionDate:      d.toISOString().split('T')[0],
        company:              co.name,
        ticker:               co.t,
        insiderName:          inn.name,
        title:                inn.title,
        isOfficer:            inn.isOfficer,
        isDirector:           !inn.isOfficer,
        isTenPct:             false,
        transactionType:      tx.type,
        transactionCode:      tx.code,
        transactionCodeLabel: tx.label,
        isOpenMarket:         tx.om,
        shares,
        price,
        value:                Math.round(shares * price),
        sharesOwnedAfter:     sharesAfter,
        sharesOwnedBefore:    sharesBefore,
        pctOwnedChange:       pctChange,
        isDerivative:         tx.code === 'M',
      }));
    }
    return result.sort((a,b) => (b.transactionDate||b.date).localeCompare(a.transactionDate||a.date));
  }

  // ── Signal aggregation ──────────────────────────────────────────────────────
  function computeSignals(filings) {
    const map = {};
    for (const f of filings) {
      if (!f.ticker) continue;
      if (!map[f.ticker]) {
        map[f.ticker] = {
          ticker: f.ticker, company: f.company, sector: f.sector,
          buys: 0, sells: 0, buyValue: 0, sellValue: 0,
          openMarketBuys: 0, cSuiteBuys: 0,
          maxPctChange: null, insiders: new Set(),
          lastTradeDate: '', trades: [],
        };
      }
      const s = map[f.ticker];
      s.insiders.add(f.insiderName);
      const txDate = f.transactionDate || f.date;
      if (txDate > s.lastTradeDate) s.lastTradeDate = txDate;
      s.trades.push(f);
      if (f.transactionType === 'buy') {
        s.buys++;
        s.buyValue += f.value || 0;
        if (f.isOpenMarket) s.openMarketBuys++;
        if (f.isOpenMarket && f.relationship === 'strong') s.cSuiteBuys++;
        if (f.pctOwnedChange != null && (s.maxPctChange == null || f.pctOwnedChange > s.maxPctChange))
          s.maxPctChange = f.pctOwnedChange;
      } else if (f.transactionType === 'sell') {
        s.sells++;
        s.sellValue += f.value || 0;
      }
    }
    return Object.values(map).map(s => {
      const ic = s.insiders.size;
      const conv = (s.cSuiteBuys * 5) +
                   (s.openMarketBuys * 2) +
                   (s.buys - s.sells) +
                   Math.min(Math.log10(s.buyValue + 1), 5) +
                   (s.maxPctChange >= 50 ? 4 : s.maxPctChange >= 20 ? 2 : s.maxPctChange >= 5 ? 1 : 0) +
                   (ic >= 3 ? 3 : ic >= 2 ? 1 : 0);
      return {
        ...s,
        insiderCount: ic,
        netValue: s.buyValue - s.sellValue,
        conviction: conv,
      };
    }).sort((a,b) => b.conviction - a.conviction);
  }

  // ── Alert signals: high-conviction recent events ────────────────────────────
  // Returns filings that meet strict criteria for immediate attention
  function getAlerts(filings) {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const cutoff = threeDaysAgo.toISOString().split('T')[0];

    return filings.filter(f => {
      const txDate = f.transactionDate || f.date;
      if (!txDate || txDate < cutoff) return false;            // only last 3 days
      if (!f.isOpenMarket) return false;                       // open market only
      if (f.transactionType !== 'buy') return false;           // buys only for alerts
      if (f.relationship !== 'strong') return false;           // C-suite only
      if (!f.value || f.value < 100_000) return false;         // $100k+ minimum
      return true;
    }).sort((a,b) => (b.value||0) - (a.value||0));
  }

  async function loadFilings() {
    const cfg = window.APP_CONFIG;
    switch (cfg.DATA_SOURCE) {
      case 'neon':  return fetchFromNeon(cfg);
      default:      return generateDemo(cfg);
    }
  }

  global.EdgarData = { loadFilings, computeSignals, getAlerts, getSector, REL_LABELS };

})(window);
