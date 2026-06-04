// src/edgar.js — SEC Form 4 data layer
(function (global) {

  // ── Sector map ─────────────────────────────────────────────────────────────
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

  const REL_LABELS = { strong: 'C-Suite', medium: 'Officer', weak: 'Director' };

  // High-signal transaction codes — open market only
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
    // Signal score: open-market + C-suite + large value = higher score
    let signal = 0;
    if (OPEN_MARKET.has(raw.transactionCode)) signal += 2;
    if (rel === 'strong') signal += 3;
    if (rel === 'medium') signal += 1;
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
      isOpenMarket: OPEN_MARKET.has(raw.transactionCode),
    };
  }

  // ── Neon HTTP SQL API ──────────────────────────────────────────────────────
  async function fetchFromNeon(cfg) {
    if (!cfg.NEON_PROXY_URL) {
      throw new Error('NEON_PROXY_URL not set in config.js');
    }

    const sql = `
      SELECT
        f.accession_number,
        f.filing_date            AS date,
        f.transaction_date,
        f.company_name           AS company,
        f.ticker,
        f.insider_name,
        f.insider_title          AS title,
        f.is_officer,
        f.is_director,
        f.is_ten_pct_owner       AS is_ten_pct,
        f.transaction_type,
        f.transaction_code,
        f.transaction_code_label,
        f.is_open_market,
        f.shares::float,
        f.price_per_share::float              AS price,
        f.value::float,
        f.shares_owned_after::float,
        f.shares_owned_before::float,
        f.pct_owned_change::float,
        f.is_derivative,
        f.sector,
        f.relationship,
        f.footnotes,
        p.price_current::float                AS current_price,
        p.day_change_pct::float               AS day_change_pct,
        p.week_52_high::float                 AS high_52w,
        p.week_52_low::float                  AS low_52w,
        CASE
          WHEN f.price_per_share IS NOT NULL
               AND f.price_per_share > 0
               AND p.price_current IS NOT NULL
          THEN ROUND(
            ((p.price_current - f.price_per_share) / f.price_per_share * 100)::numeric, 1
          )
          ELSE NULL
        END                                   AS return_pct
      FROM public.filings f
      LEFT JOIN public.prices p ON p.ticker = f.ticker
      WHERE COALESCE(f.transaction_date, f.filing_date) >= '2024-01-01'
        AND f.is_open_market = true
      ORDER BY COALESCE(f.transaction_date, f.filing_date) DESC,
               f.value DESC NULLS LAST
      LIMIT 5000
    `;

    const res = await fetch(cfg.NEON_PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: sql }),
    });

    if (!res.ok) throw new Error(`Proxy ${res.status}: ${await res.text().catch(()=>'')}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

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
      currentPrice:         r.current_price,
      dayChangePct:         r.day_change_pct,
      high52w:              r.high_52w,
      low52w:               r.low_52w,
      returnPct:            r.return_pct,
    }));
  }

  // ── Proxy ──────────────────────────────────────────────────────────────────
  async function fetchFromProxy(cfg) {
    const days  = cfg.DEFAULT_DAYS_BACK || 30;
    const end   = new Date();
    const start = new Date(); start.setDate(end.getDate() - days);
    const fmt   = d => d.toISOString().split('T')[0];
    const res   = await fetch(`${cfg.PROXY_URL}?startdt=${fmt(start)}&enddt=${fmt(end)}&forms=4&hits=200`);
    if (!res.ok) throw new Error(`Proxy ${res.status}`);
    const data  = await res.json();
    return (data.filings || []).map(enrich);
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
      {name:'Sarah Chen',title:'Senior Vice President, Finance',isOfficer:true},
      {name:'Robert Martinez',title:'Chief Financial Officer',isOfficer:true},
      {name:'Lisa Thompson',title:'Executive Vice President',isOfficer:true},
      {name:'James Wilson',title:'Chief Operating Officer',isOfficer:true},
      {name:'Emily Rodriguez',title:'Director',isOfficer:false},
      {name:'Michael Zhang',title:'10% Owner',isOfficer:false},
      {name:'Patricia Lee',title:'SVP, General Counsel',isOfficer:true},
      {name:'David Kim',title:'EVP, Operations',isOfficer:true},
      {name:'Nancy White',title:'Chief Technology Officer',isOfficer:true},
      {name:'Karen Nguyen',title:'Independent Director',isOfficer:false},
    ];
    const txTypes = [
      {code:'P',label:'Open Market Purchase',type:'buy'},
      {code:'S',label:'Open Market Sale',type:'sell'},
      {code:'M',label:'Exercise of Derivative',type:'buy'},
      {code:'F',label:'Tax Withholding (Sale)',type:'sell'},
      {code:'A',label:'Grant / Award',type:'buy'},
    ];
    const result = [];
    const now  = new Date();
    const days = cfg.DEFAULT_DAYS_BACK || 30;
    for (let i = 0; i < 200; i++) {
      const co  = cos[Math.floor(Math.random() * cos.length)];
      const inn = ins[Math.floor(Math.random() * ins.length)];
      const tx  = txTypes[Math.floor(Math.random() * txTypes.length)];
      const d   = new Date(now); d.setDate(d.getDate() - Math.floor(Math.random() * days));
      const fd  = new Date(d);  fd.setDate(fd.getDate() + Math.floor(Math.random() * 4) + 1);
      const shares = Math.floor(Math.random() * 400000 + 500);
      const price  = parseFloat((Math.random() * 500 + 10).toFixed(2));
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
        shares,
        price,
        value:                Math.round(shares * price),
        isDerivative:         tx.code === 'M',
      }));
    }
    return result.sort((a,b) => (b.transactionDate||b.date).localeCompare(a.transactionDate||a.date));
  }

  // ── Signal aggregation (for Signals tab) ──────────────────────────────────
  // Returns per-ticker signal summaries useful for trading decisions
  function computeSignals(filings) {
    const map = {};
    for (const f of filings) {
      if (!f.ticker) continue;
      if (!map[f.ticker]) {
        map[f.ticker] = {
          ticker:      f.ticker,
          company:     f.company,
          sector:      f.sector,
          buys:        0,
          sells:       0,
          buyValue:    0,
          sellValue:   0,
          cSuiteBuys:  0,   // open-market buys by C-suite only
          insiders:    new Set(),
          lastTradeDate: '',
          trades:      [],
        };
      }
      const s = map[f.ticker];
      s.insiders.add(f.insiderName);
      if ((f.transactionDate || f.date) > s.lastTradeDate) s.lastTradeDate = f.transactionDate || f.date;
      s.trades.push(f);
      if (f.transactionType === 'buy') {
        s.buys++;
        s.buyValue += f.value || 0;
        if (f.isOpenMarket && f.relationship === 'strong') s.cSuiteBuys++;
      } else if (f.transactionType === 'sell') {
        s.sells++;
        s.sellValue += f.value || 0;
      }
    }
    return Object.values(map).map(s => ({
      ...s,
      insiderCount:  s.insiders.size,
      netValue:      s.buyValue - s.sellValue,
      // Conviction score: higher = more bullish signal
      // Weights: C-suite open-market buys > value > count > recency
      conviction: (s.cSuiteBuys * 5) + (s.buys - s.sells) + Math.min(Math.log10(s.buyValue + 1), 5),
      avgReturn: (() => {
        const withReturn = s.trades.filter(t => t.returnPct != null);
        if (!withReturn.length) return null;
        return +(withReturn.reduce((sum, t) => sum + t.returnPct, 0) / withReturn.length).toFixed(1);
      })(),
    })).sort((a,b) => b.conviction - a.conviction);
  }

  async function loadFilings() {
    const cfg = window.APP_CONFIG;
    switch (cfg.DATA_SOURCE) {
      case 'neon':   return fetchFromNeon(cfg);
      case 'proxy':  return fetchFromProxy(cfg);
      default:       return generateDemo(cfg);
    }
  }

  global.EdgarData = { loadFilings, computeSignals, getSector, REL_LABELS };

})(window);
