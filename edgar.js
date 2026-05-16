// ─────────────────────────────────────────────────────────────────────────────
// edgar.js  — fetch, parse, and enrich Form 4 filings
// ─────────────────────────────────────────────────────────────────────────────

(function (global) {

  // ── Static lookup tables ──────────────────────────────────────────────────

  const SECTOR_MAP = {
    Technology:              ['AAPL','MSFT','GOOGL','META','NVDA','AMZN','TSLA','INTC','AMD','ORCL','CRM','ADBE','QCOM','TXN','AVGO','NOW','SNOW','PLTR','IBM','CSCO','ACN','SAP','INTU','SHOP','UBER','LYFT','RBLX','COIN','DDOG','ZS','PANW','CRWD'],
    Finance:                 ['JPM','BAC','WFC','GS','MS','C','BLK','AXP','V','MA','SCHW','USB','PNC','TFC','COF','SPGI','MCO','ICE','CME','CBOE','AFL','MET','PRU','ALL','TRV','HIG','WRB','AIG','BX','KKR','APO'],
    Healthcare:              ['JNJ','PFE','UNH','ABBV','MRK','LLY','BMY','AMGN','GILD','CVS','MDT','ABT','TMO','DHR','ISRG','REGN','VRTX','BIIB','BSX','EW','IQV','A','BIO','ZBH','SYK','BAX','DXCM'],
    Energy:                  ['XOM','CVX','COP','SLB','PSX','EOG','MPC','VLO','PXD','OXY','HES','DVN','FANG','MRO','APA','HAL','BKR','NOV','WMB','KMI','ET','EPD','LNG','CQP'],
    'Consumer Staples':      ['WMT','PG','KO','PEP','COST','PM','MO','CL','GIS','KHC','HSY','MKC','SJM','CAG','CPB','K','HRL','TSN','ADM','BG'],
    'Consumer Discretionary':['HD','MCD','NKE','SBUX','LOW','TGT','TJX','EBAY','ETSY','ROST','BKNG','ABNB','MAR','HLT','YUM','CMG','DPZ','DKNG','WYNN','LVS','MGM'],
    Industrials:             ['HON','UNP','BA','CAT','GE','MMM','DE','EMR','ETN','ITW','LMT','RTX','NOC','GD','HII','TDG','FDX','UPS','DAL','UAL','AAL','NSC','CSX','WAB','PCAR','CMI','PH','ROK','DOV','XYL'],
    'Real Estate':           ['AMT','PLD','EQIX','CCI','SPG','O','WELL','DLR','PSA','EXR','ARE','VTR','BXP','SLG','KIM','REG','FRT','AIV','EQR','AVB','ESS','UDR','CPT'],
    Utilities:               ['NEE','DUK','SO','AEP','EXC','SRE','PCG','ED','FE','EIX','XEL','WEC','ES','ETR','PPL','CNP','NI','AES','AWK','CMS'],
    'Communication Services':['META','GOOGL','NFLX','DIS','VZ','T','CMCSA','TMUS','ATVI','EA','TTWO','MTCH','IAC','WBD','PARA','FOXA','NYT','SNAP','PINS','RDDT'],
    Materials:               ['LIN','APD','ECL','SHW','FCX','NEM','NUE','VMC','MLM','DD','DOW','PPG','RPM','ALB','CF','MOS','FMC','CE','EMN','IFF'],
  };

  const TICKER_REVERSE = {};
  for (const [sector, tickers] of Object.entries(SECTOR_MAP)) {
    for (const t of tickers) TICKER_REVERSE[t] = sector;
  }

  function getSector(ticker) {
    return TICKER_REVERSE[(ticker || '').toUpperCase()] || 'Other';
  }

  function getRelationship(title) {
    const t = (title || '').toLowerCase();
    if (/chief|ceo|cfo|coo|cto|ciso|president|exec\. v\.?p|executive v/i.test(t)) return 'strong';
    if (/officer|svp|evp|senior v|managing dir|general counsel|treasurer|secretary/i.test(t)) return 'medium';
    return 'weak';
  }

  const REL_LABELS = { strong: 'Insider', medium: 'Officer', weak: 'Director/10%' };

  // ── Enrich a raw filing object ─────────────────────────────────────────────

  function enrich(raw) {
    const rel = getRelationship(raw.title);
    return {
      ...raw,
      sector:       raw.sector       || getSector(raw.ticker),
      relationship: raw.relationship || rel,
      relLabel:     REL_LABELS[rel],
      value:        raw.shares && raw.price
                      ? Math.round(raw.shares * parseFloat(raw.price))
                      : null,
    };
  }

  // ── EDGAR EFTS search (runs through proxy to avoid CORS) ──────────────────

  async function fetchFromProxy(cfg) {
    const days  = cfg.DEFAULT_DAYS_BACK || 14;
    const end   = new Date();
    const start = new Date(); start.setDate(end.getDate() - days);
    const fmt   = d => d.toISOString().split('T')[0];

    const url = `${cfg.PROXY_URL}?startdt=${fmt(start)}&enddt=${fmt(end)}&forms=4&hits=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Proxy error ${res.status}`);
    const data = await res.json();
    return (data.filings || []).map(enrich);
  }

  // ── Supabase REST ──────────────────────────────────────────────────────────

  async function fetchFromSupabase(cfg) {
    const days  = cfg.DEFAULT_DAYS_BACK || 14;
    const since = new Date(); since.setDate(since.getDate() - days);
    const iso   = since.toISOString().split('T')[0];

    const url = `${cfg.SUPABASE_URL}/rest/v1/filings`
      + `?select=*&filing_date=gte.${iso}&order=filing_date.desc&limit=500`;
    const res = await fetch(url, {
      headers: {
        apikey:        cfg.SUPABASE_ANON,
        Authorization: `Bearer ${cfg.SUPABASE_ANON}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase error ${res.status}`);
    const rows = await res.json();
    return rows.map(r => enrich({
      date:     r.filing_date,
      company:  r.company_name,
      ticker:   r.ticker,
      insiderName: r.insider_name,
      title:    r.insider_title,
      transactionType: r.transaction_type,
      shares:   r.shares,
      price:    r.price_per_share,
      sector:   r.sector,
    }));
  }

  // ── Demo data (no network) ─────────────────────────────────────────────────

  function generateDemo(cfg) {
    const companies = [
      {name:'Apple Inc',ticker:'AAPL'},{name:'Microsoft Corp',ticker:'MSFT'},
      {name:'NVIDIA Corp',ticker:'NVDA'},{name:'Amazon.com Inc',ticker:'AMZN'},
      {name:'Alphabet Inc',ticker:'GOOGL'},{name:'Meta Platforms',ticker:'META'},
      {name:'JPMorgan Chase',ticker:'JPM'},{name:'Goldman Sachs',ticker:'GS'},
      {name:'Pfizer Inc',ticker:'PFE'},{name:'ExxonMobil Corp',ticker:'XOM'},
      {name:'Walmart Inc',ticker:'WMT'},{name:'Tesla Inc',ticker:'TSLA'},
      {name:'Johnson & Johnson',ticker:'JNJ'},{name:'Chevron Corp',ticker:'CVX'},
      {name:'UnitedHealth Group',ticker:'UNH'},{name:'Home Depot Inc',ticker:'HD'},
      {name:'Visa Inc',ticker:'V'},{name:'Mastercard Inc',ticker:'MA'},
      {name:'Procter & Gamble',ticker:'PG'},{name:'Eli Lilly & Co',ticker:'LLY'},
      {name:'Berkshire Hathaway',ticker:'BRK'},{name:'Broadcom Inc',ticker:'AVGO'},
      {name:'AbbVie Inc',ticker:'ABBV'},{name:'Costco Wholesale',ticker:'COST'},
      {name:'Merck & Co',ticker:'MRK'},{name:'Netflix Inc',ticker:'NFLX'},
    ];
    const insiders = [
      {name:'Timothy D. Cook',title:'Chief Executive Officer'},
      {name:'Satya Nadella',title:'President and CEO'},
      {name:'Jensen Huang',title:'Chief Executive Officer'},
      {name:'Andy Jassy',title:'Chief Executive Officer'},
      {name:'Sundar Pichai',title:'Chief Executive Officer'},
      {name:'Mark Zuckerberg',title:'Chairman and CEO'},
      {name:'Jamie Dimon',title:'Chief Executive Officer'},
      {name:'David Solomon',title:'Chairman and CEO'},
      {name:'Albert Bourla',title:'Chief Executive Officer'},
      {name:'Darren Woods',title:'Chairman and CEO'},
      {name:'Sarah Chen',title:'Senior Vice President, Finance'},
      {name:'Robert Martinez',title:'Executive Vice President'},
      {name:'Lisa Thompson',title:'Chief Financial Officer'},
      {name:'James Wilson',title:'Chief Operating Officer'},
      {name:'Emily Rodriguez',title:'Director'},
      {name:'Michael Zhang',title:'10% Owner'},
      {name:'Patricia Lee',title:'SVP, General Counsel'},
      {name:'David Kim',title:'EVP, Operations'},
      {name:'Nancy White',title:'Chief Technology Officer'},
      {name:'Thomas Brown',title:'Managing Director'},
      {name:'Karen Nguyen',title:'Independent Director'},
      {name:'William Foster',title:'Board Director'},
      {name:'Sandra Patel',title:'Treasurer'},
      {name:'Chris Okafor',title:'Secretary'},
    ];
    const result = [];
    const now = new Date(2025, 4, 15);
    const days = cfg.DEFAULT_DAYS_BACK || 14;
    for (let i = 0; i < 120; i++) {
      const co  = companies[Math.floor(Math.random() * companies.length)];
      const ins = insiders[Math.floor(Math.random() * insiders.length)];
      const d   = new Date(now);
      d.setDate(d.getDate() - Math.floor(Math.random() * days));
      const isBuy = Math.random() > 0.43;
      const shares = Math.floor(Math.random() * 600000 + 200);
      const price  = (Math.random() * 450 + 8).toFixed(2);
      result.push(enrich({
        date:    d.toISOString().split('T')[0],
        company: co.name,
        ticker:  co.ticker,
        insiderName: ins.name,
        title:   ins.title,
        transactionType: isBuy ? 'buy' : 'sell',
        shares, price,
      }));
    }
    return result.sort((a, b) => b.date.localeCompare(a.date));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function loadFilings() {
    const cfg = window.APP_CONFIG;
    switch (cfg.DATA_SOURCE) {
      case 'proxy':    return fetchFromProxy(cfg);
      case 'supabase': return fetchFromSupabase(cfg);
      default:         return generateDemo(cfg);
    }
  }

  global.EdgarData = { loadFilings, getSector, getRelationship, REL_LABELS };

})(window);
