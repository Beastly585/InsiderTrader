// src/app.jsx — InsiderDesk — sidebar nav, 4 pages, Alpaca portfolio
const { useState, useEffect, useMemo, useCallback, useRef } = React;
const cfg = window.APP_CONFIG;

// ─── Utilities ────────────────────────────────────────────────────────────────
const fmt = {
  number:    n => n == null ? '—' : Number(n).toLocaleString(),
  money:     n => {
    if (n == null) return '—';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return `${s}$${(a/1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${s}$${(a/1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${s}$${(a/1e3).toFixed(0)}K`;
    return `${s}$${a.toFixed(0)}`;
  },
  price:     n => n == null ? '—' : `$${parseFloat(n).toFixed(2)}`,
  pct:       n => n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`,
  date:      d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—',
  dateShort: d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : '—',
  ago:       d => {
    if (!d) return '—';
    const days = Math.floor((Date.now()-new Date(d+'T00:00:00'))/86400000);
    if (days===0) return 'today'; if (days===1) return 'yesterday';
    if (days<30) return `${days}d ago`;
    if (days<365) return `${Math.floor(days/30)}mo ago`;
    return `${Math.floor(days/365)}y ago`;
  },
};

// ─── Theme ────────────────────────────────────────────────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('theme'); if (s) return s==='dark'; } catch(_){}
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark?'dark':'light');
    try { localStorage.setItem('theme', dark?'dark':'light'); } catch(_){}
  }, [dark]);
  return [dark, setDark];
}

// ─── Atoms ────────────────────────────────────────────────────────────────────
function Badge({ type, children }) {
  return <span className={`badge badge--${type}`}>{children}</span>;
}
function Spinner({ size=22 }) {
  return <div className="spinner" style={{width:size,height:size}}/>;
}
function StatCard({ label, value, sub, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color?{color}:{}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
const TX_CODE_TOOLTIPS = {
  P:'Open market purchase',  S:'Open market sale',
  A:'Grant / award',         M:'Option exercise',
  J:'Other / transfer',      G:'Gift',
  F:'Tax withholding',       C:'Conversion of derivative',
  D:'Sale to issuer',        E:'Expiration of derivative',
};

function SortTh({ label, colKey, sortCol, sortDir, onSort, right, title:ttl }) {
  const active = sortCol===colKey;
  return (
    <th onClick={()=>onSort(colKey)}
        className={`th-sort${active?' th--active':''}${right?' th--right':''}`}
        title={ttl}>
      {label}{active?(sortDir>0?' ↑':' ↓'):''}
    </th>
  );
}
function ConvictionBar({ score, max=15 }) {
  const pct = Math.min((score/max)*100, 100);
  const color = pct>60?'var(--green-600)':pct>30?'var(--amber-600)':'var(--text-3)';
  return (
    <div className="conv-bar-wrap" title={`Conviction: ${score.toFixed(1)}`}>
      <div className="conv-bar" style={{width:`${pct}%`,background:color}}/>
    </div>
  );
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────
const NAV = [
  {id:'dashboard', icon:'◈', label:'Dashboard'},
  {id:'signals',   icon:'⬆', label:'Insights'},
  {id:'data',      icon:'≡', label:'All Data'},
  {id:'portfolio', icon:'◎', label:'Portfolio'},
];
function Sidebar({ page, setPage, dark, setDark }) {
  return (
    <nav className="sidebar sidebar--compact">
      <div className="sidebar__logo" title="InsiderDesk — Trading Intelligence">
        <div className="logo-mark">IT</div>
      </div>
      <div className="sidebar__nav">
        {NAV.map(n => (
          <button key={n.id}
            className={`nav-item nav-item--icon-only${page===n.id?' nav-item--active':''}`}
            onClick={()=>setPage(n.id)}
            title={n.label}>
            <span className="nav-icon">{n.icon}</span>
          </button>
        ))}
      </div>
      <div className="sidebar__footer">
        <button className="nav-item nav-item--icon-only nav-item--sm" onClick={()=>setDark(d=>!d)} title={dark?'Switch to light mode':'Switch to dark mode'}>
          <span className="nav-icon">{dark?'☀':'☾'}</span>
        </button>
      </div>
    </nav>
  );
}

// ─── Signal aggregation ───────────────────────────────────────────────────────
function buildSignals(filings) {
  const map = {};
  for (const f of filings) {
    if (!f.ticker) continue;
    const isPol = !!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
    if (!map[f.ticker]) map[f.ticker] = {
      ticker:f.ticker, company:f.company, sector:f.sector, isPolitical:isPol,
      buys:0, sells:0, buyValue:0, sellValue:0, cSuiteBuys:0,
      insiders:new Set(), lastTradeDate:'', trades:[],
    };
    const s = map[f.ticker];
    s.insiders.add(f.insiderName);
    const tx = f.transactionDate||f.date||'';
    if (tx>s.lastTradeDate) s.lastTradeDate=tx;
    s.trades.push(f);
    if (f.transactionType==='buy') {
      s.buys++; s.buyValue+=f.value||0;
      if (f.isOpenMarket&&f.relationship==='strong') s.cSuiteBuys++;
    } else if (f.transactionType==='sell') {
      s.sells++; s.sellValue+=f.value||0;
    }
  }
  return Object.values(map).map(s => ({
    ...s, insiderCount:s.insiders.size,
    netValue: s.buyValue-s.sellValue,
    conviction: (s.cSuiteBuys*5)+(s.buys-s.sells)+Math.min(Math.log10(s.buyValue+1),5),
  }));
}

// ─── Detail panel ─── signal / trader / ticker / transaction ─────────────────
async function queryNeon(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({query:sql}),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.rows||[];
}

// Bundle consecutive same-direction trades by the same insider+ticker within
// a window (default 5 trading days) into a single combined row. Pure display
// aggregation — does not touch underlying data.
function clusterTrades(rows, windowDays = 5) {
  if (!rows || !rows.length) return [];
  // Sort ascending by date so we can walk forward and group
  const sorted = [...rows].sort((a,b)=>{
    const ad = a.transaction_date||a.filing_date||'';
    const bd = b.transaction_date||b.filing_date||'';
    return ad.localeCompare(bd);
  });

  const clusters = [];
  let current = null;

  for (const r of sorted) {
    const tt = r.transaction_type;
    const dt = r.transaction_date||r.filing_date;
    if (!dt) { clusters.push({...r, _isCluster:false, _count:1}); continue; }
    const dtMs = new Date(dt+'T00:00:00').getTime();

    const sameGroup = current
      && current.transaction_type === tt
      && current._ticker === (r.ticker||'')
      && current._insider === (r.insider_name||'')
      && (dtMs - current._lastMs) <= windowDays*86400000;

    if (sameGroup) {
      current._trades.push(r);
      current._lastMs = dtMs;
      current.shares = (current.shares||0) + (r.shares||0);
      current.value  = (current.value||0)  + (r.value||0);
      current._count++;
      // weighted avg price
      const totalShares = current._trades.reduce((s,t)=>s+(t.shares||0),0);
      current.price_per_share = totalShares>0
        ? current._trades.reduce((s,t)=>s+((t.price||t.price_per_share||0)*(t.shares||0)),0)/totalShares
        : current.price_per_share;
      current.price = current.price_per_share;
      current.transaction_date = current._trades[0].transaction_date||current._trades[0].filing_date; // earliest
      current._lastDate = dt; // most recent
    } else {
      if (current) clusters.push(current);
      current = {
        ...r, _isCluster:true, _count:1, _trades:[r],
        _ticker: r.ticker||'', _insider: r.insider_name||'',
        _lastMs: dtMs, _lastDate: dt,
      };
    }
  }
  if (current) clusters.push(current);

  // Mark single-trade "clusters" as non-clusters for display purposes
  for (const c of clusters) if (c._count===1) c._isCluster=false;

  // Return newest-first to match existing sort convention
  return clusters.sort((a,b)=>{
    const ad = a._lastDate||a.transaction_date||a.filing_date||'';
    const bd = b._lastDate||b.transaction_date||b.filing_date||'';
    return bd.localeCompare(ad);
  });
}

// Trust score now factors BOTH buy-side appreciation (unrealized) AND sell-side
// realized gains (did they sell at a profit vs their own historical buys),
// not just "did the stock go up since they bought." A net seller with bad
// realized P&L will no longer score well just because their few buys are green.
function trustScore(st) {
  if (!st||(st.omBuys+st.omSells)<2) return null;
  let s=0;
  // Combined hit rate (buys priced correctly + profitable sells), weighted more
  if (st.combinedHitRate!=null){if(st.combinedHitRate>=70)s+=2;else if(st.combinedHitRate>=50)s+=1;}else s+=0.5;
  if (st.avgRealizedReturn!=null){if(st.avgRealizedReturn>=20)s+=1.5;else if(st.avgRealizedReturn>=5)s+=1;else if(st.avgRealizedReturn>=0)s+=0.5;else s-=0.5;}
  if (st.omBuys+st.omSells>=10)s+=1;else if(st.omBuys+st.omSells>=5)s+=0.5;
  if (st.totalBuys>0&&st.omBuys/st.totalBuys>=0.7)s+=0.5;
  return Math.max(0,Math.min(Math.round(s*10)/10,5));
}

function TrustStars({score}) {
  if (score===null) return <span className="td-muted" style={{fontSize:11}}>Insufficient data</span>;
  // Round to nearest 0.5 for clean half-star rendering (e.g. 2.3->2.5, 2.7->2.5... no: round to nearest half)
  const rounded = Math.round(score*2)/2;
  const stars = [0,1,2,3,4].map(i=>{
    const fillAmount = Math.max(0, Math.min(1, rounded-i)); // 0, 0.5, or 1
    return fillAmount;
  });
  return (
    <span className="trust-stars" title={`${score}/5`}>
      <span className="trust-stars__row">
        {stars.map((fill,i)=>(
          <span key={i} className="trust-star">
            <span className="trust-star__bg">★</span>
            <span className="trust-star__fg" style={{width:`${fill*100}%`}}>★</span>
          </span>
        ))}
      </span>
      <span className="trust-stars__num">{score}/5</span>
    </span>
  );
}

function DetailPanel({ detail, filings, onClose, onNavigate, onBack, canGoBack }) {
  if (!detail) return null;
  const d = detail;

  const [traderRows, setTraderRows] = useState(null);
  const [tickerRows, setTickerRows] = useState(null);
  const [busy,       setBusy]       = useState(false);
  const [bundleOn,   setBundleOn]   = useState(true);
  const [expanded,   setExpanded]   = useState(false);
  const [omOnly,     setOmOnly]     = useState(false);
  const nav = (type,data) => onNavigate&&onNavigate({type,...data});

  useEffect(()=>{
    if (d.type!=='trader') return;
    setTraderRows(null); setBusy(true);
    queryNeon(`
      SELECT f.transaction_date,f.filing_date,f.ticker,f.company_name,
             f.transaction_type,f.transaction_code,f.is_open_market,f.is_derivative,
             f.shares::float,f.price_per_share::float AS price,
             f.value::float,f.pct_owned_change::float,
             f.relationship,f.insider_title AS title,f.sector,f.is_entity_owner,
             f.filing_lag_days,f.shares_owned_after::float,
             ph.close::float AS current_price
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph ON true
      WHERE f.insider_name='${d.name.replace(/'/g,"''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r=>{setTraderRows(r);setBusy(false);}).catch(()=>setBusy(false));
  },[d.type,d.name]);

  useEffect(()=>{
    if (d.type!=='ticker') return;
    setTickerRows(null); setBusy(true);
    queryNeon(`
      SELECT f.transaction_date,f.filing_date,f.insider_name,
             f.insider_title AS title,f.relationship,
             f.transaction_type,f.transaction_code,f.is_open_market,
             f.shares::float,f.price_per_share::float AS price,
             f.value::float,f.pct_owned_change::float,f.sector,
             ph.close::float AS current_price,
             CASE WHEN f.price_per_share>0 AND ph.close IS NOT NULL
               AND ABS((ph.close-f.price_per_share)/f.price_per_share)>=3.0
               THEN true ELSE false END AS is_foreign_price
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph ON true
      WHERE f.ticker='${(d.ticker||'').replace(/'/g,"''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r=>{setTickerRows(r);setBusy(false);}).catch(()=>setBusy(false));
  },[d.type,d.ticker]);

  const [relatedInsiders, setRelatedInsiders] = useState(null);

  useEffect(()=>{
    if (d.type!=='trader' || !traderRows?.length) { setRelatedInsiders(null); return; }
    const sectors = [...new Set(traderRows.map(r=>r.sector).filter(Boolean))];
    if (!sectors.length) { setRelatedInsiders([]); return; }
    const sectorList = sectors.map(s=>`'${s.replace(/'/g,"''")}'`).join(',');
    const selfName = d.name.replace(/'/g,"''");

    // Pull other insiders active in the same sector(s). Simplified query —
    // no LATERAL join (kept timing out / erroring on Neon's HTTP SQL endpoint
    // at this table size) and bounded to the last 2 years to keep it fast.
    // Hit-rate here is a rough proxy (buy volume + OM discipline), not the
    // full trustScore calculation — good enough for ranking "related" people.
    queryNeon(`
      SELECT f.insider_name, f.insider_title, f.relationship,
             COUNT(*) FILTER (WHERE f.transaction_type='buy' AND f.is_open_market) AS om_buys,
             COUNT(*) FILTER (WHERE f.transaction_type='sell' AND f.is_open_market) AS om_sells,
             ARRAY_AGG(DISTINCT f.ticker) FILTER (WHERE f.ticker IS NOT NULL) AS tickers
      FROM public.filings f
      WHERE f.sector IN (${sectorList})
        AND f.insider_name IS NOT NULL
        AND f.insider_name != '${selfName}'
        AND COALESCE(f.transaction_date, f.filing_date) >= (CURRENT_DATE - INTERVAL '2 years')
      GROUP BY f.insider_name, f.insider_title, f.relationship
      HAVING COUNT(*) FILTER (WHERE f.transaction_type='buy' AND f.is_open_market) >= 2
      ORDER BY om_buys DESC
      LIMIT 8
    `).then(rows=>{
      const withRate = rows.map(r=>({
        ...r,
        // Rough proxy: OM discipline ratio (buys+sells via real cash vs total activity)
        hitRate: (r.om_buys+r.om_sells)>0 ? Math.round((r.om_buys/(r.om_buys+r.om_sells))*100) : null,
        sharedTickers: (r.tickers||[]).filter(t=>traderRows.some(tr=>tr.ticker===t)),
      })).sort((a,b)=>{
        // Prioritize insiders who share an actual ticker, then by OM buy count
        if (a.sharedTickers.length!==b.sharedTickers.length) return b.sharedTickers.length-a.sharedTickers.length;
        return (b.om_buys||0)-(a.om_buys||0);
      });
      setRelatedInsiders(withRate.slice(0,5));
    }).catch(()=>setRelatedInsiders([]));
  },[d.type,d.name,traderRows]);

  const traderStats = useMemo(()=>{
    if (!traderRows?.length) return null;
    const buys=traderRows.filter(r=>r.transaction_type==='buy');
    const sells=traderRows.filter(r=>r.transaction_type==='sell');
    const omBuys=buys.filter(r=>r.is_open_market);
    const omSells=sells.filter(r=>r.is_open_market);

    // Only P/S coded trades have a real, economically meaningful price.
    // Grants (A), exercises (M), and "other" (J) often carry $0 or a strike
    // price that isn't comparable to market price — exclude these from
    // return calculations entirely rather than silently treating $0 as a loss.
    const pricedBuys  = omBuys.filter(r=>r.price>0&&r.current_price!=null&&Math.abs((r.current_price-r.price)/r.price)<3);
    const pricedSells = omSells.filter(r=>r.price>0);

    // Unrealized: buys where stock is still above/below entry today
    const buyWinners = pricedBuys.filter(r=>r.current_price>=r.price);
    const avgUnrealizedReturn = pricedBuys.length
      ? +(pricedBuys.reduce((s,r)=>s+((r.current_price-r.price)/r.price*100),0)/pricedBuys.length).toFixed(1)
      : null;

    // Realized: did sells happen at a profit relative to that insider's own
    // average buy price on the same ticker? This is the actual "did they make
    // money" question, not just "did the stock go up since any buy."
    const buyPriceByTicker = {};
    for (const r of pricedBuys) {
      if (!buyPriceByTicker[r.ticker]) buyPriceByTicker[r.ticker] = {totalCost:0,totalShares:0};
      buyPriceByTicker[r.ticker].totalCost += r.price*(r.shares||0);
      buyPriceByTicker[r.ticker].totalShares += (r.shares||0);
    }
    const realizedTrades = pricedSells.map(r=>{
      const bp = buyPriceByTicker[r.ticker];
      const avgCost = bp && bp.totalShares>0 ? bp.totalCost/bp.totalShares : null;
      const realizedReturn = avgCost ? ((r.price-avgCost)/avgCost*100) : null;
      return {...r, avgCost, realizedReturn};
    }).filter(r=>r.realizedReturn!=null);

    const sellWinners = realizedTrades.filter(r=>r.realizedReturn>=0);
    const avgRealizedReturn = realizedTrades.length
      ? +(realizedTrades.reduce((s,r)=>s+r.realizedReturn,0)/realizedTrades.length).toFixed(1)
      : null;

    // Combined hit rate across BOTH sides — this is the honest profitability number
    const allOutcomes = [...pricedBuys.map(()=>null), ...realizedTrades]; // placeholder structure
    const winCount = buyWinners.length + sellWinners.length;
    const totalEvaluated = pricedBuys.length + realizedTrades.length;
    const combinedHitRate = totalEvaluated>0 ? Math.round((winCount/totalEvaluated)*100) : null;

    // Best performers by ticker (unrealized buy-side, for "what's working" context)
    const byTk={};
    for (const r of pricedBuys){if(!byTk[r.ticker])byTk[r.ticker]={ticker:r.ticker,ret:0,count:0};byTk[r.ticker].ret+=((r.current_price-r.price)/r.price)*100;byTk[r.ticker].count++;}
    const bestTickers=Object.values(byTk).map(t=>({...t,avgRet:t.ret/t.count})).sort((a,b)=>b.avgRet-a.avgRet).slice(0,3);

    // Current holding status per ticker: sum all OM buy shares minus OM sell
    // shares, most recent transaction first — tells you if they likely still
    // hold a position based on net share flow.
    const holdingByTicker = {};
    for (const r of traderRows) {
      if (!r.ticker || !r.is_open_market) continue;
      if (!holdingByTicker[r.ticker]) holdingByTicker[r.ticker] = {netShares:0,lastDate:null};
      const sh = r.shares||0;
      holdingByTicker[r.ticker].netShares += (r.transaction_type==='buy'?sh:-sh);
      const dt = r.transaction_date||r.filing_date;
      if (!holdingByTicker[r.ticker].lastDate || dt>holdingByTicker[r.ticker].lastDate) holdingByTicker[r.ticker].lastDate = dt;
    }
    const holdings = Object.entries(holdingByTicker).map(([ticker,h])=>({ticker,...h,stillHolding:h.netShares>0}));

    const dates=traderRows.map(r=>r.transaction_date||r.filing_date).filter(Boolean).sort();
    return {
      totalBuys:buys.length, sells:sells.length, omBuys:omBuys.length, omSells:omSells.length,
      avgReturn:avgUnrealizedReturn, avgRealizedReturn, hitRate:combinedHitRate, combinedHitRate,
      withReturn:totalEvaluated,
      totalBuyVal:omBuys.reduce((s,r)=>s+(r.value||0),0),
      totalSellVal:omSells.reduce((s,r)=>s+(r.value||0),0),
      companies:[...new Set(traderRows.map(r=>r.ticker).filter(Boolean))],
      sectors:[...new Set(traderRows.map(r=>r.sector).filter(Boolean))],
      role:traderRows[0]?.relationship||'weak', title:traderRows[0]?.title||'',
      bestTickers, holdings,
      firstTrade:dates[dates.length-1], lastTrade:dates[0],
    };
  },[traderRows]);

  // Per-stock breakdown: for each ticker this insider has traded, compute
  // hold duration pattern (avg days between matched buy->sell pairs), avg
  // filing lag, current estimated position + live value, and a reversal-
  // paired transaction list (FIFO-matched buys/sells with realized P&L and
  // hold time per closed round-trip).
  const perStockBreakdown = useMemo(()=>{
    if (!traderRows?.length) return [];
    // In OM-only mode, only consider rows that are open-market P/S transactions
    // for ALL calculations (position, hold time, P&L). In all-data mode, every
    // row counts toward the position calc but P&L/hold-time still only uses
    // priced (OM) trades since grants/exercises don't have a comparable cost basis.
    const sourceRows = omOnly ? traderRows.filter(r=>r.is_open_market) : traderRows;
    const byTicker = {};
    for (const r of sourceRows) {
      if (!r.ticker) continue;
      if (!byTicker[r.ticker]) byTicker[r.ticker] = [];
      byTicker[r.ticker].push(r);
    }

    return Object.entries(byTicker).map(([ticker, rows])=>{
      const sorted = [...rows].sort((a,b)=>{
        const ad=a.transaction_date||a.filing_date||'', bd=b.transaction_date||b.filing_date||'';
        return ad.localeCompare(bd); // oldest first for FIFO matching
      });

      // FIFO match: walk chronologically, maintain an open-lot queue of buys,
      // match each sell against the oldest open buy(s) to compute hold time
      // and realized P&L per round-trip.
      const lots = []; // {date, shares remaining, price}
      const roundTrips = [];
      for (const r of sorted) {
        if (!r.is_open_market) continue; // only OM trades for hold-time/P&L purposes
        const dt = r.transaction_date||r.filing_date;
        if (r.transaction_type==='buy' && r.price>0) {
          lots.push({date:dt, shares:r.shares||0, price:r.price});
        } else if (r.transaction_type==='sell' && r.price>0) {
          let sellSharesRemaining = r.shares||0;
          while (sellSharesRemaining>0 && lots.length>0) {
            const lot = lots[0];
            const matched = Math.min(lot.shares, sellSharesRemaining);
            if (matched>0) {
              const buyDt = new Date(lot.date+'T00:00:00');
              const sellDt = new Date(dt+'T00:00:00');
              const holdDays = Math.round((sellDt-buyDt)/86400000);
              roundTrips.push({
                ticker, buyDate:lot.date, sellDate:dt, shares:matched,
                buyPrice:lot.price, sellPrice:r.price,
                pnl: (r.price-lot.price)*matched,
                pnlPct: ((r.price-lot.price)/lot.price)*100,
                holdDays,
              });
            }
            lot.shares -= matched;
            sellSharesRemaining -= matched;
            if (lot.shares<=0.001) lots.shift();
          }
        }
      }

      // Avg hold time across closed round-trips
      const avgHoldDays = roundTrips.length
        ? Math.round(roundTrips.reduce((s,rt)=>s+rt.holdDays,0)/roundTrips.length)
        : null;

      // Avg filing lag for this ticker
      const lagRows = rows.filter(r=>r.filing_lag_days!=null);
      const avgFilingLag = lagRows.length
        ? Math.round(lagRows.reduce((s,r)=>s+r.filing_lag_days,0)/lagRows.length)
        : null;

      // Current position: primary source is shares_owned_after, the figure the
      // insider themselves disclosed to the SEC as their total post-transaction
      // holding on their MOST RECENT filing for this ticker. This is the most
      // honest "what do they actually own" number since it's self-reported
      // ground truth, not something we're inferring from buy/sell flow — and
      // it naturally includes grants, exercises, gifts, everything.
      //
      // CRITICAL: only look at NON-derivative rows for this. Derivative Form 4
      // table II rows (options, RSUs, warrants) report shares_owned_after in
      // units of the DERIVATIVE security, not common stock — mixing those in
      // produces nonsense share counts (seen: one director showing 674M shares
      // of a stock with ~1.2B shares outstanding total, from a mis-scoped
      // derivative row). Direct-table (non-derivative) rows are the only ones
      // whose shares_owned_after is comparable to actual common stock held.
      const directRows = sorted.filter(r=>!r.is_derivative);
      const reportedShares = [...directRows].reverse().find(r=>r.shares_owned_after!=null)?.shares_owned_after;
      const fifoRemainingShares = lots.reduce((s,l)=>s+l.shares,0);

      // Sanity bound: SEC-reported figure shouldn't be wildly disproportionate
      // to the actual transaction sizes we've observed for this insider+ticker.
      // If shares_owned_after is more than 200x the largest single transaction
      // we've seen, treat it as suspect (likely a filer typo or scope error)
      // and fall back to the FIFO estimate instead of showing a clearly wrong number.
      const maxTxnShares = Math.max(0, ...sorted.map(r=>r.shares||0));
      const reportedIsPlausible = reportedShares==null || maxTxnShares===0
        || reportedShares <= maxTxnShares*200;

      const remainingShares = omOnly
        ? fifoRemainingShares
        : (reportedShares!=null && reportedIsPlausible ? reportedShares : fifoRemainingShares);

      const currentPrice = sorted[sorted.length-1]?.current_price;
      const currentValue = (remainingShares>0 && currentPrice) ? remainingShares*currentPrice : null;

      const totalRealizedPnl = roundTrips.reduce((s,rt)=>s+rt.pnl,0);
      const company = rows[0]?.company_name;

      return {
        ticker, company, rows: sorted, roundTrips: roundTrips.reverse(), // newest first for display
        avgHoldDays, avgFilingLag, remainingShares, currentPrice, currentValue,
        reportedShares, fifoRemainingShares, totalRealizedPnl,
        positionSource: omOnly ? 'om-fifo' : (reportedShares!=null && reportedIsPlausible ? 'sec-reported' : 'om-fifo'),
        positionFlagged: reportedShares!=null && !reportedIsPlausible,
        stillHolding: remainingShares>0.001,
        tradeCount: rows.length,
      };
    }).sort((a,b)=>{
      // Most recently active ticker first
      const aLast = a.rows[a.rows.length-1]?.transaction_date||'';
      const bLast = b.rows[b.rows.length-1]?.transaction_date||'';
      return bLast.localeCompare(aLast);
    });
  },[traderRows,omOnly]);

  // Aggregate hero metrics across all stocks — the "headline number" for the profile
  const heroStats = useMemo(()=>{
    if (!perStockBreakdown.length) return null;
    const totalRealized = perStockBreakdown.reduce((s,p)=>s+(p.totalRealizedPnl||0),0);
    const totalCurrentValue = perStockBreakdown.reduce((s,p)=>s+(p.currentValue||0),0);
    const holdingCount = perStockBreakdown.filter(p=>p.stillHolding).length;
    const closedCount = perStockBreakdown.filter(p=>!p.stillHolding && p.roundTrips.length>0).length;
    const hasRealizedData = perStockBreakdown.some(p=>p.roundTrips.length>0);
    return { totalRealized, totalCurrentValue, holdingCount, closedCount, hasRealizedData };
  },[perStockBreakdown]);

  const tickerStats = useMemo(()=>{
    if (!tickerRows?.length) return null;
    const buys=tickerRows.filter(r=>r.transaction_type==='buy');
    const sells=tickerRows.filter(r=>r.transaction_type==='sell');
    const names=[...new Set(tickerRows.map(r=>r.insider_name).filter(Boolean))];
    return {buys:buys.length,sells:sells.length,cSuite:buys.filter(r=>r.relationship==='strong'&&r.is_open_market).length,insiders:names.length,insiderNames:names.slice(0,5),net:buys.reduce((s,r)=>s+(r.value||0),0)-sells.reduce((s,r)=>s+(r.value||0),0)};
  },[tickerRows]);

  const tickerRowsDisplay = useMemo(()=>{
    if (!tickerRows) return [];
    return bundleOn ? clusterTrades(tickerRows) : tickerRows;
  },[tickerRows,bundleOn]);

  const byInsider = useMemo(()=>{
    if (d.type!=='signal') return [];
    const map={};
    const trades=d.trades||[];
    for (const t of trades){const k=t.insiderName||'Unknown';if(!map[k])map[k]={name:k,title:t.title,rel:t.relationship,trades:[]};map[k].trades.push(t);}
    for (const v of Object.values(map))v.trades.sort((a,b)=>(b.transactionDate||b.date||'').localeCompare(a.transactionDate||a.date||''));
    return Object.values(map).sort((a,b)=>{const ra=a.rel==='strong'?0:a.rel==='medium'?1:2,rb=b.rel==='strong'?0:b.rel==='medium'?1:2;if(ra!==rb)return ra-rb;return b.trades.reduce((s,t)=>s+(t.value||0),0)-a.trades.reduce((s,t)=>s+(t.value||0),0);});
  },[d]);

  const score=traderStats?trustScore(traderStats):null;
  const RelBadge=({rel})=><Badge type={`rel-${rel}`}>{rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Director'}</Badge>;

  const TRow=({r,showTicker,showInsider})=>{
    const tt=r.transaction_type||r.transactionType;
    const code=r.transaction_code||r.transactionCode;
    const isOM=r.is_open_market||r.isOpenMarket;
    const pr=r.price||r.price_per_share;
    const cur=r.current_price||r.currentPrice;
    // Only P/S codes carry a real market price. A/M/J/etc often show $0 or a
    // strike price that isn't comparable — don't compute a misleading return.
    const hasRealPrice = isOM && pr>0;
    const isForeign=r.is_foreign_price||r.isForeignPrice||(hasRealPrice&&cur&&Math.abs((cur-pr)/pr)>=3);
    const ret=(hasRealPrice&&cur&&!isForeign)?((cur-pr)/pr*100):null;
    const dt=r.transaction_date||r.transactionDate||r.date;
    const codeLabel = TX_CODE_TOOLTIPS[code]||code;
    const dateLabel = r._isCluster ? `${fmt.dateShort(r.transaction_date)}–${fmt.dateShort(r._lastDate)}` : fmt.dateShort(dt);
    return (
      <div className={`dp-trade dp-trade--${tt}`}>
        <div className="dp-trade-row1">
          <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆'}</Badge>
          <span className="dp-trade-shares">{r.shares?`${fmt.number(r.shares)} sh`:'—'}</span>
          <span className="dp-trade-val">{r.value?fmt.money(r.value):<span className="td-muted">—</span>}</span>
          <span className="dp-trade-date">{dateLabel}</span>
        </div>
        <div className="dp-trade-row2">
          {r._isCluster&&<span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
          {showTicker&&r.ticker&&<span className="ticker dp-clickable" onClick={()=>nav('ticker',{ticker:r.ticker,company:r.company_name})}>{r.ticker}</span>}
          {showInsider&&r.insider_name&&<span className="dp-clickable dp-trade-row2__name" onClick={()=>nav('trader',{name:r.insider_name,title:r.title})}>{r.insider_name}</span>}
          {hasRealPrice ? (
            <span className="dp-trade-row2__price">
              <span className="dp-trade-row2__mono">@{fmt.price(pr)}</span>
              {ret!=null&&<span className={ret>=0?'val-buy':'val-sell'}> →{fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)</span>}
              {isForeign&&<span style={{color:'var(--amber-600)'}}> ⚠</span>}
            </span>
          ) : (
            <span className="dp-trade-row2__noprice">{codeLabel}</span>
          )}
          {(r.pct_owned_change||r.pctOwnedChange)!=null&&<span className="val-buy">+{(r.pct_owned_change||r.pctOwnedChange).toFixed(0)}%pos</span>}
          <span className="code-pill" title={codeLabel}>{code}</span>
          {isOM&&<span className="om-dot" title="Open market transaction">●</span>}
        </div>
      </div>
    );
  };

  const header=()=>{
    if(d.type==='trader')return<div><div style={{fontWeight:600,fontSize:15,display:'flex',alignItems:'center',gap:6}}>{d.name}{traderRows?.[0]?.is_entity_owner&&<span className="entity-badge" title="This may be an entity (Trust/LLC) rather than an individual">⚠ entity</span>}</div>{traderStats?.title&&<div className="td-muted" style={{fontSize:11}}>{traderStats.title}</div>}</div>;
    if(d.type==='ticker')return<div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:17}}>{d.ticker}</span><span style={{fontSize:13,color:'var(--text-2)'}}>{d.company}</span></div>;
    if(d.type==='signal')return<div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:17}}>{d.ticker}</span><span style={{fontSize:13,color:'var(--text-2)'}}>{d.company}</span></div>;
    if(d.type==='transaction')return<div><div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:15}}>{d.trade?.ticker}</span><span style={{fontSize:12,color:'var(--text-2)'}}>{d.trade?.company_name||d.trade?.company}</span></div><div className="td-muted" style={{fontSize:11}}>Transaction</div></div>;
  };

  return (
    <div className={expanded?'detail-modal-overlay':undefined} onClick={expanded?(e)=>{if(e.target===e.currentTarget)setExpanded(false);}:undefined}>
    <div className={expanded?'detail-panel detail-panel--modal':'detail-panel'}>
      <div className="detail-panel__header">
        {canGoBack&&<button className="btn btn--ghost btn--icon" onClick={onBack} title="Back">←</button>}
        <div style={{minWidth:0,flex:1}}>{header()}</div>
        <button className="btn btn--ghost btn--icon" onClick={()=>setExpanded(e=>!e)} title={expanded?'Collapse':'Expand'}>{expanded?'⤢':'⤡'}</button>
        <button className="btn btn--ghost btn--icon" onClick={onClose}>✕</button>
      </div>
      <div className="detail-panel__body">

        {d.type==='trader'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!traderStats?<div className="state-box" style={{padding:'2rem'}}><p>No trades found.</p></div>:(<>

          {/* HERO: the one number that matters most, banking-app style */}
          {heroStats&&(
            <div className="trader-hero">
              <div className="trader-hero__top">
                <div>
                  <div className="trader-hero__label">
                    {heroStats.hasRealizedData?'Realized P&L':'Est. Position Value'}
                  </div>
                  <div className={`trader-hero__value ${heroStats.hasRealizedData?(heroStats.totalRealized>=0?'val-buy':'val-sell'):''}`}>
                    {heroStats.hasRealizedData
                      ? `${heroStats.totalRealized>=0?'+':''}${fmt.money(heroStats.totalRealized)}`
                      : fmt.money(heroStats.totalCurrentValue)}
                  </div>
                </div>
                <TrustStars score={score}/>
              </div>
              <div className="trader-hero__chips">
                <span className="hero-chip">{heroStats.holdingCount} holding{heroStats.holdingCount!==1?'s':''}</span>
                <span className="hero-chip">{heroStats.closedCount} closed</span>
                {traderStats.combinedHitRate!=null&&
                  <span className={`hero-chip ${traderStats.combinedHitRate>=60?'hero-chip--good':traderStats.combinedHitRate<40?'hero-chip--bad':''}`}>
                    {traderStats.combinedHitRate}% hit rate
                  </span>}
                {heroStats.totalCurrentValue>0&&heroStats.hasRealizedData&&
                  <span className="hero-chip">{fmt.money(heroStats.totalCurrentValue)} held now</span>}
              </div>
            </div>
          )}

          <div className="trader-quickfacts">
            <span><RelBadge rel={traderStats.role}/></span>
            <span className="td-muted">{traderStats.title}</span>
            {traderStats.firstTrade&&<span className="td-muted">Active {fmt.dateShort(traderStats.firstTrade)} – {fmt.dateShort(traderStats.lastTrade)}</span>}
          </div>

          <details className="trader-details-toggle">
            <summary>Full stats breakdown</summary>
            <div className="dp-summary" style={{marginTop:8}}>
              <div className="dp-sum-item"><span className="dp-sum-label">OM Buys</span><span className="val-buy dp-sum-val">{traderStats.omBuys}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">OM Sells</span><span className="val-sell dp-sum-val">{traderStats.omSells}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Bought $</span><span className="dp-sum-val">{fmt.money(traderStats.totalBuyVal)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Sold $</span><span className="dp-sum-val">{fmt.money(traderStats.totalSellVal)}</span></div>
              {traderStats.combinedHitRate!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Hit Rate <span className="trust-explain" title="% of priced buy+sell events that were profitable. Buys: stock up since purchase. Sells: sold above their own avg cost basis.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.combinedHitRate>=60?'val-buy':traderStats.combinedHitRate<40?'val-sell':''}`}>{traderStats.combinedHitRate}% <span style={{fontSize:9,opacity:.7}}>({traderStats.withReturn} events)</span></span></div>}
              {traderStats.avgRealizedReturn!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Realized Avg <span className="trust-explain" title="Average % gain/loss on actual sells, vs their own historical average buy price on that ticker.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.avgRealizedReturn>=0?'val-buy':'val-sell'}`}>{traderStats.avgRealizedReturn>=0?'+':''}{traderStats.avgRealizedReturn}%</span></div>}
              {traderStats.avgReturn!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Unrealized Avg <span className="trust-explain" title="Average % the stock has moved since their open-market buys, vs current price.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.avgReturn>=0?'val-buy':'val-sell'}`}>{traderStats.avgReturn>=0?'+':''}{traderStats.avgReturn}%</span></div>}
            </div>
            {traderStats.companies.length>0&&<div className="trader-meta-row"><span>Companies</span><span style={{textAlign:'right'}}>{traderStats.companies.slice(0,6).map((tk,i)=><span key={tk} className="ticker dp-clickable" style={{fontSize:11,marginLeft:i>0?4:0}} onClick={()=>nav('ticker',{ticker:tk,company:''})}>{tk}</span>)}{traderStats.companies.length>6&&<span className="td-muted"> +{traderStats.companies.length-6}</span>}</span></div>}
            {traderStats.sectors.length>0&&<div className="trader-meta-row"><span>Sectors</span><span style={{fontSize:11,textAlign:'right'}}>{traderStats.sectors.slice(0,3).join(' · ')}</span></div>}
          </details>

          {perStockBreakdown.length>0&&(<>
            <div className="dp-section-label" style={{marginTop:14,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span>Positions</span>
              <div style={{display:'flex',gap:10}}>
                <label className="bundle-toggle" title="Bundle consecutive same-direction trades by this insider within a few days into one row.">
                  <input type="checkbox" checked={bundleOn} onChange={e=>setBundleOn(e.target.checked)}/>
                  Bundle nearby
                </label>
                <label className="bundle-toggle" title="When on, every number on this page — position, hold-time, P&L, and the transactions listed below — uses ONLY open-market (real cash) buys and sells. Grants, exercises, and gifts are excluded entirely. When off, current position uses the insider's own SEC-reported total holdings, but hold-time/P&L still only ever use priced trades.">
                  <input type="checkbox" checked={omOnly} onChange={e=>setOmOnly(e.target.checked)}/>
                  Own-money purchases only
                </label>
              </div>
            </div>
            {perStockBreakdown.map((s,i)=>{
              const displayRows = bundleOn ? clusterTrades(s.rows) : s.rows;
              return (
              <div key={i} className="position-card">
                <div className="position-card__top">
                  <div className="position-card__id">
                    <span className="ticker dp-clickable" style={{fontSize:14}} onClick={()=>nav('ticker',{ticker:s.ticker,company:s.company})}>{s.ticker}</span>
                    <span className={`holding-status ${s.stillHolding?'holding-status--yes':'holding-status--no'}`}>
                      {s.stillHolding?'● Holding':'○ Closed'}
                    </span>
                  </div>
                  <span className="td-muted" style={{fontSize:10}}>{s.tradeCount} txn{s.tradeCount!==1?'s':''}</span>
                </div>

                <div className="position-card__value-row">
                  <div className="position-card__value-block">
                    <span className="position-card__value-label">
                      {s.stillHolding?'Current Position':'Realized P&L'}
                      <span className="trust-explain" title={s.stillHolding?(s.positionFlagged?"The SEC-reported share count for this ticker looked implausible relative to actual transaction sizes (likely a derivative-security mix-up or filer error), so we fell back to an open-market-only estimate instead.":s.positionSource==='sec-reported'?"From the insider's own most recent SEC-reported total holdings (includes grants, exercises, gifts, everything).":"From open-market buy/sell flow only (FIFO). May understate true holdings if they also received grants or exercised options."):"Sum of all closed FIFO-matched round-trips, open-market trades only."}>ⓘ</span>
                    </span>
                    {s.stillHolding ? (
                      <span className="position-card__value">
                        {fmt.number(s.remainingShares)} sh
                        {s.currentValue&&<span className="position-card__value-sub"> · {fmt.money(s.currentValue)}</span>}
                      </span>
                    ) : (
                      <span className={`position-card__value ${s.totalRealizedPnl>=0?'val-buy':'val-sell'}`}>
                        {s.roundTrips.length?`${s.totalRealizedPnl>=0?'+':''}${fmt.money(s.totalRealizedPnl)}`:'—'}
                      </span>
                    )}
                  </div>
                  {s.stillHolding && s.roundTrips.length>0 && (
                    <div className="position-card__value-block position-card__value-block--secondary">
                      <span className="position-card__value-label">Realized so far</span>
                      <span className={`position-card__value position-card__value--small ${s.totalRealizedPnl>=0?'val-buy':'val-sell'}`}>
                        {s.totalRealizedPnl>=0?'+':''}{fmt.money(s.totalRealizedPnl)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="position-card__meta">
                  <span title="Average days held across closed round-trips">⏱ {s.avgHoldDays!=null?`${s.avgHoldDays}d avg hold`:'hold time n/a'}</span>
                  <span title="Average days between trade date and SEC filing acceptance">📋 {s.avgFilingLag!=null?`${s.avgFilingLag}d filing lag`:'lag n/a'}</span>
                  <span className="position-card__source">
                    {s.positionFlagged&&<span className="position-flagged-badge" title="SEC-reported figure looked implausible, fell back to estimate">⚠ flagged</span>}
                    {!s.positionFlagged&&s.stillHolding?(s.positionSource==='sec-reported'?'SEC-reported':'OM est.'):''}
                  </span>
                </div>

                {s.roundTrips.length>0&&(
                  <details className="position-card__roundtrips">
                    <summary>{s.roundTrips.length} closed round-trip{s.roundTrips.length!==1?'s':''} (FIFO, open-market)</summary>
                    {s.roundTrips.slice(0,8).map((rt,j)=>(
                      <div key={j} className="roundtrip-row">
                        <span className="td-muted" style={{fontSize:10}}>{fmt.dateShort(rt.buyDate)} → {fmt.dateShort(rt.sellDate)}</span>
                        <span className="td-muted" style={{fontSize:10}}>{rt.holdDays}d held</span>
                        <span style={{fontSize:10,fontFamily:'var(--font-mono)'}}>@{fmt.price(rt.buyPrice)}→{fmt.price(rt.sellPrice)}</span>
                        <span className={`roundtrip-pnl ${rt.pnl>=0?'val-buy':'val-sell'}`}>
                          {rt.pnl>=0?'+':''}{fmt.money(rt.pnl)} ({rt.pnlPct>=0?'+':''}{rt.pnlPct.toFixed(1)}%)
                        </span>
                      </div>
                    ))}
                    {s.roundTrips.length>8&&<div className="td-muted" style={{fontSize:10,padding:'4px 0'}}>+{s.roundTrips.length-8} more</div>}
                  </details>
                )}

                <details className="position-card__txns" open={perStockBreakdown.length===1}>
                  <summary>{displayRows.length} transaction{displayRows.length!==1?'s':''} for {s.ticker}{omOnly?' (open market only)':''}</summary>
                  <div className="position-card__txn-list">
                    {displayRows.map((r,j)=><TRow key={j} r={r} showTicker={false} showInsider={false}/>)}
                  </div>
                </details>
              </div>
            );})}
          </>)}

          {relatedInsiders!==null&&relatedInsiders.length>0&&(<>
            <div className="dp-section-label" style={{marginTop:14}}>Related Insiders <span className="trust-explain" title="Other insiders active in the same sector(s), ranked by shared tickers and approximate hit rate.">ⓘ</span></div>
            {relatedInsiders.map((ri,i)=>(
              <div key={i} className="related-insider-row" onClick={()=>nav('trader',{name:ri.insider_name,title:ri.insider_title})}>
                <span className="dp-clickable" style={{fontWeight:500,fontSize:12}}>{ri.insider_name}</span>
                <span className="td-muted" style={{fontSize:10,flex:1}}>{ri.insider_title}</span>
                {ri.sharedTickers?.length>0&&<span className="shared-ticker-badge">{ri.sharedTickers.length} shared</span>}
                {ri.hitRate!=null&&<span className={`td-mono ${ri.hitRate>=60?'val-buy':ri.hitRate<40?'val-sell':''}`} style={{fontSize:11}}>{ri.hitRate}%</span>}
              </div>
            ))}
          </>)}
        </>))}


        {d.type==='ticker'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!tickerStats?<div className="state-box" style={{padding:'2rem'}}><p>No data.</p></div>:(<>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{tickerStats.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{tickerStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${tickerStats.net>=0?'val-buy':'val-sell'}`}>{tickerStats.net>=0?'+':''}{fmt.money(tickerStats.net)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Exec</span><span className="dp-sum-val">{tickerStats.cSuite}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{tickerStats.insiders}</span></div>
          </div>
          {tickerStats.insiderNames.length>0&&<div className="trader-meta-row"><span>Insiders</span><span style={{textAlign:'right'}}>{tickerStats.insiderNames.map((n,i)=><span key={n} className="dp-clickable" style={{fontSize:11,marginLeft:i>0?6:0}} onClick={()=>nav('trader',{name:n,title:''})}>{n.split(' ').pop()}</span>)}</span></div>}
          <div className="dp-section-label" style={{marginTop:12,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <span>All Insider Activity ({bundleOn?tickerRowsDisplay.length:tickerRows.length})</span>
            <label className="bundle-toggle">
              <input type="checkbox" checked={bundleOn} onChange={e=>setBundleOn(e.target.checked)}/>
              Bundle nearby trades
            </label>
          </div>
          {tickerRowsDisplay.map((r,i)=><TRow key={i} r={r} showTicker={false} showInsider={true}/>)}
        </>))}

        {d.type==='signal'&&(<>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{d.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{d.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${d.netValue>=0?'val-buy':'val-sell'}`}>{d.netValue>=0?'+':''}{fmt.money(d.netValue)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Exec</span><span className="dp-sum-val">{d.cSuiteBuys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{d.insiderCount}</span></div>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,marginTop:14}}>
            <div className="dp-section-label" style={{margin:0}}>Trades by Insider</div>
            <button className="dp-nav-link" onClick={()=>nav('ticker',{ticker:d.ticker,company:d.company})}>Full history →</button>
          </div>
          {byInsider.map((ins,i)=>(
            <div key={i} className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={ins.rel}/>
                <span className="dp-clickable" style={{fontWeight:500,fontSize:12.5}} onClick={()=>nav('trader',{name:ins.name,title:ins.title})}>{ins.name}</span>
                <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{ins.title}</span>
              </div>
              {ins.trades.map((t,j)=><TRow key={j} r={{...t,transaction_type:t.transactionType,transaction_code:t.transactionCode,is_open_market:t.isOpenMarket,price:t.price,current_price:t.currentPrice,pct_owned_change:t.pctOwnedChange,transaction_date:t.transactionDate,is_foreign_price:t.isForeignPrice}} showTicker={false} showInsider={false}/>)}
            </div>
          ))}
        </>)}

        {d.type==='transaction'&&d.trade&&(()=>{
          const t=d.trade;
          const tt=t.transactionType||t.transaction_type;
          const pr=t.price||t.price_per_share;
          const cur=t.currentPrice||t.current_price;
          const isForeign=t.isForeignPrice||t.is_foreign_price||(pr&&cur&&pr>0&&Math.abs((cur-pr)/pr)>=3);
          const ret=(pr&&cur&&pr>0&&!isForeign)?((cur-pr)/pr*100):null;
          return(<>
            <div className="dp-summary">
              <div className="dp-sum-item"><span className="dp-sum-label">Type</span><Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆'}</Badge></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Value</span><span className="dp-sum-val">{fmt.money(t.value)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Shares</span><span className="dp-sum-val">{fmt.number(t.shares)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">@ Price</span><span className="dp-sum-val">{fmt.price(pr)}{isForeign&&<span style={{color:'var(--amber-600)',fontSize:10}}> ⚠ verify (3x+ move)</span>}</span></div>
              {ret!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Now</span><span className={`dp-sum-val ${ret>=0?'val-buy':'val-sell'}`}>{fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)</span></div>}
              {(t.pctOwnedChange||t.pct_owned_change)!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Pos Δ</span><span className="dp-sum-val val-buy">+{(t.pctOwnedChange||t.pct_owned_change).toFixed(1)}%</span></div>}
            </div>
            <div className="dp-section-label" style={{marginTop:12}}>Insider</div>
            <div className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={t.relationship||'weak'}/>
                <span className="dp-clickable" style={{fontWeight:500,fontSize:12.5}} onClick={()=>nav('trader',{name:t.insiderName||t.insider_name,title:t.title||t.insider_title})}>{t.insiderName||t.insider_name}</span>
                <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{t.title||t.insider_title}</span>
              </div>
            </div>
            <div className="dp-section-label" style={{marginTop:12}}>Details</div>
            <div className="dp-detail-list">
              {[['Trade date',fmt.date(t.transactionDate||t.transaction_date)],['Filed',fmt.date(t.date||t.filing_date)],['Code',t.transactionCode||t.transaction_code],['Open market',(t.isOpenMarket||t.is_open_market)?'✓ Yes':'No'],['Sector',t.sector]].filter(([,v])=>v&&v!=='—').map(([k,v],i)=>(<div key={i} className="dp-detail-row"><span>{k}</span><span>{v}</span></div>))}
            </div>
            <div style={{marginTop:12,display:'flex',gap:12}}>
              <button className="dp-nav-link" onClick={()=>nav('trader',{name:t.insiderName||t.insider_name,title:t.title})}>Trader profile →</button>
              <button className="dp-nav-link" onClick={()=>nav('ticker',{ticker:t.ticker,company:t.company_name||t.company})}>All {t.ticker} trades →</button>
            </div>
          </>);
        })()}

        <div className="dp-section-label" style={{marginTop:16}}>Market Context</div>
        <div className="dp-placeholder"><span>📈</span><p>Price chart and news coming soon</p></div>
      </div>
    </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
const DASH_SORT_OPTS = [
  {key:'conviction',    label:'Conviction'},
  {key:'netValue',      label:'Net $'},
  {key:'cSuiteBuys',    label:'Exec'},
  {key:'lastTradeDate', label:'Recent'},
];
const DASH_DATE_OPTS = [{label:'1d',days:1},{label:'3d',days:3},{label:'7d',days:7},{label:'30d',days:30}];

function DashSigTable({ signals, loading, title, subtitle, onRowClick, onOpenDetail }) {
  const [sortKey, setSortKey] = useState('conviction');
  const [sortDir, setSortDir] = useState(-1);
  const sorted = useMemo(()=>[...signals].sort((a,b)=>{
    const av=a[sortKey],bv=b[sortKey];
    if(typeof av==='number'){if(av<bv)return sortDir;if(av>bv)return -sortDir;}
    return 0;
  }),[signals,sortKey,sortDir]);
  function tog(k){if(sortKey===k)setSortDir(d=>-d);else{setSortKey(k);setSortDir(-1);}}
  return (
    <div className="dash-sig-table">
      <div className="dash-sig-table__hdr">
        <div className="dash-sig-table__title">{title}<span className="dash-sig-table__sub">{subtitle}</span></div>
        <div className="dash-sig-sort">
          {DASH_SORT_OPTS.map(o=>(
            <button key={o.key} className={`dash-sort-btn${sortKey===o.key?' dash-sort-btn--active':''}`} onClick={()=>tog(o.key)}>
              {o.label}{sortKey===o.key&&<span>{sortDir<0?'↓':'↑'}</span>}
            </button>
          ))}
        </div>
      </div>
      {loading ? <div style={{padding:'1.5rem',display:'flex',justifyContent:'center'}}><Spinner/></div>
      : sorted.length===0 ? <div className="dash-sig-empty">No signals in this date range</div>
      : <table className="dash-sig-tbl"><tbody>
          {sorted.map(s=>(
            <tr key={s.ticker} className="dash-sig-row" onClick={()=>onRowClick(s)}>
              <td className="dst-ticker">
                <span className="ticker" onClick={e=>{e.stopPropagation();onOpenDetail&&onOpenDetail({type:'ticker',ticker:s.ticker,company:s.company});}}>{s.ticker}</span>
              </td>
              <td className="dst-company">
                <div className="td-overflow" style={{fontSize:12}}>{s.company}</div>
                <div style={{fontSize:10,color:'var(--text-3)'}}>{s.sector!=='Other'?s.sector:''}</div>
              </td>
              <td className="dst-meta">
                {s.cSuiteBuys>0&&<span className="csuite-badge">{s.cSuiteBuys}×exec</span>}
                <span className="td-muted" style={{fontSize:10}}>{s.insiderCount} insider{s.insiderCount!==1?'s':''}</span>
                <span className="td-muted" style={{fontSize:10}}>{fmt.ago(s.lastTradeDate)}</span>
              </td>
              <td className="dst-val">
                <span className={`dst-net ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
                <div style={{marginTop:2}}><ConvictionBar score={s.conviction}/></div>
              </td>
            </tr>
          ))}
        </tbody></table>}
    </div>
  );
}

function DashPortfolio({ filings }) {
  const [port, setPort] = useState(null);
  const [err,  setErr]  = useState(false);
  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    fetch(`${cfg.NEON_PROXY_URL}/portfolio`)
      .then(r=>r.json()).then(d=>{if(!d.error)setPort(d);else setErr(true);}).catch(()=>setErr(true));
  },[]);
  if (err) return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">◎ Portfolio</div>
      <div className="dp-placeholder" style={{padding:'1rem'}}><span style={{fontSize:18}}>⚠</span><p style={{fontSize:11}}>Could not load Alpaca — check Worker secrets and redeploy.</p></div>
    </div>
  );
  if (!port) return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">◎ Portfolio</div>
      <div style={{padding:'1rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
    </div>
  );
  const acct=port.account||{}, pos=port.positions||[];
  const eq=parseFloat(acct.equity||0), leq=parseFloat(acct.last_equity||0);
  const dpl=eq-leq, dpct=leq>0?(dpl/leq)*100:0;
  const cut=new Date(); cut.setDate(cut.getDate()-7);
  const iso=cut.toISOString().split('T')[0];
  const sigTickers=new Set(filings.filter(f=>f.isOpenMarket&&f.transactionType==='buy'&&(f.transactionDate||f.date||'')>=iso).map(f=>f.ticker));
  return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">◎ Portfolio <span style={{fontSize:11,fontWeight:400,color:'var(--text-3)'}}>{cfg.ALPACA_LIVE?'Live':'Paper'}</span></div>
      <div className="dash-port-eq">
        <span className="dash-port-val">{fmt.money(eq)}</span>
        <span className={`dash-port-chg ${dpl>=0?'val-buy':'val-sell'}`}>{dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)}) today</span>
      </div>
      {pos.length===0 ? <div style={{padding:'8px 14px',fontSize:12,color:'var(--text-3)'}}>No open positions</div>
      : <div className="dash-port-positions">
          {[...pos].sort((a,b)=>Math.abs(parseFloat(b.market_value||0))-Math.abs(parseFloat(a.market_value||0))).map((p,i)=>{
            const tpl=parseFloat(p.unrealized_intraday_pl||0);
            const pct=parseFloat(p.unrealized_plpc||0)*100;
            const hasSig=sigTickers.has(p.symbol);
            return (
              <div key={i} className={`dash-pos-row${hasSig?' dash-pos-row--signal':''}`}>
                <span className="ticker" style={{fontSize:11}}>{p.symbol}{hasSig&&<span className="dash-pos-signal-dot" title="Active insider signal"> ⬆</span>}</span>
                <span className="td-muted" style={{fontSize:11}}>{fmt.money(parseFloat(p.market_value||0))}</span>
                <span className={`dash-pos-pnl ${tpl>=0?'val-buy':'val-sell'}`}>{tpl>=0?'+':''}{fmt.money(tpl)} <span style={{fontSize:10,opacity:.7}}>({pct>=0?'+':''}{pct.toFixed(1)}%)</span></span>
              </div>
            );
          })}
        </div>}
    </div>
  );
}

function DashNews({ filings }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(false);
  const topTickers = useMemo(()=>{
    const cut=new Date(); cut.setDate(cut.getDate()-7);
    const iso=cut.toISOString().split('T')[0];
    return buildSignals(filings.filter(f=>f.isOpenMarket&&f.transactionType==='buy'&&(f.transactionDate||f.date||'')>=iso))
      .sort((a,b)=>b.conviction-a.conviction).slice(0,3).map(s=>s.ticker);
  },[filings]);
  useEffect(()=>{
    const key=cfg.FINNHUB_API_KEY;
    if (!key||!topTickers.length) return;
    setLoading(true);
    const today=new Date().toISOString().split('T')[0];
    const from=new Date(); from.setDate(from.getDate()-3);
    const fromStr=from.toISOString().split('T')[0];
    Promise.all(topTickers.map(tk=>
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${tk}&from=${fromStr}&to=${today}&token=${key}`)
        .then(r=>r.json()).then(a=>(a||[]).slice(0,3).map(n=>({...n,_ticker:tk}))).catch(()=>[])
    )).then(res=>{
      setNews(res.flat().filter(n=>n.headline&&n.url).sort((a,b)=>b.datetime-a.datetime).slice(0,6));
      setLoading(false);
    });
  },[topTickers.join(',')]);
  const hasKey=!!cfg.FINNHUB_API_KEY;
  return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">📰 News</div>
      {!hasKey ? <div className="dp-placeholder" style={{padding:'1rem'}}><span style={{fontSize:18}}>📡</span><p style={{fontSize:11}}>Add <code>FINNHUB_API_KEY</code> to config.js for live headlines.</p></div>
      : loading ? <div style={{padding:'1rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
      : news.length===0 ? <div style={{padding:'1rem',fontSize:12,color:'var(--text-3)'}}>No recent news for active tickers</div>
      : <div className="dash-news-list">
          {news.map((n,i)=>(
            <a key={i} className="dash-news-item" href={n.url} target="_blank" rel="noreferrer">
              <div className="dash-news-item__meta">
                <span className="ticker" style={{fontSize:10}}>{n._ticker}</span>
                <span className="td-muted" style={{fontSize:10}}>{n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}</span>
              </div>
              <div className="dash-news-item__headline">{n.headline}</div>
            </a>
          ))}
        </div>}
    </div>
  );
}

function DashboardPage({ filings, loading, onDrillSignal, onOpenDetail }) {
  const [days, setDays] = useState(3);
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);

  const corp = useMemo(()=>buildSignals(filings.filter(f=>
    !(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'))
    &&f.isOpenMarket&&f.transactionType==='buy'&&f.relationship==='strong'
    &&(f.transactionDate||f.date||'')>=cutoff
  )).filter(s=>s.netValue>=250_000||s.cSuiteBuys>=1),[filings,cutoff]);

  const pol = useMemo(()=>buildSignals(filings.filter(f=>
    (f.transactionCode&&f.transactionCode.startsWith('CONGRESS'))
    &&f.transactionType==='buy'&&(f.transactionDate||f.date||'')>=cutoff
  )),[filings,cutoff]);

  return (
    <div className="page-content">
      <div className="dash-header-row">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p className="page-sub">{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
        </div>
        <div className="dash-date-filter">
          <span style={{fontSize:11,color:'var(--text-3)'}}>Last</span>
          <div className="date-pills">
            {DASH_DATE_OPTS.map(o=>(
              <button key={o.label} className={`pill${days===o.days?' pill--active':''}`} onClick={()=>setDays(o.days)}>{o.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="dash-main-layout">
        <div className="dash-left">
          <DashSigTable signals={corp} loading={loading} title="🏢 Corporate" subtitle="C-suite · open market" onRowClick={onDrillSignal} onOpenDetail={onOpenDetail}/>
          <DashSigTable signals={pol}  loading={loading} title="⚑ Congressional" subtitle="STOCK Act" onRowClick={onDrillSignal} onOpenDetail={onOpenDetail}/>
        </div>
        <div className="dash-right">
          <DashPortfolio filings={filings}/>
          <DashNews filings={filings}/>
        </div>
      </div>
    </div>
  );
}

// ─── SIGNALS ──────────────────────────────────────────────────────────────────
const DATE_PRESETS=[{label:'3d',days:3},{label:'7d',days:7},{label:'14d',days:14},{label:'30d',days:30},{label:'All',days:null}];

// ─── INSIGHTS — multi-environment: Snapshot / Signals / Leaderboard / Sector Flow ──
const INSIGHTS_ENVS = [
  {id:'snapshot',    label:'Snapshot'},
  {id:'signals',     label:'Signals'},
  {id:'leaderboard', label:'Insider Leaderboard'},
  {id:'sectorflow',  label:'Sector Money Flow'},
];

// Detects insiders who reversed direction on a ticker within the last 12mo
// (bought then sold, or sold then bought), with the most recent leg inside
// the last 30 days. Exit signals (sell-after-buy) are surfaced first since
// they're the stronger "this insider changed their mind" signal.
function detectReversals(filings) {
  const cutoffRecent = new Date(); cutoffRecent.setDate(cutoffRecent.getDate()-30);
  const cutoffWindow = new Date(); cutoffWindow.setMonth(cutoffWindow.getMonth()-12);
  const recentISO = cutoffRecent.toISOString().split('T')[0];
  const windowISO = cutoffWindow.toISOString().split('T')[0];

  const byPair = {};
  for (const f of filings) {
    if (!f.isOpenMarket || !f.ticker || !f.insiderName) continue;
    const dt = f.transactionDate||f.date;
    if (!dt || dt<windowISO) continue;
    const key = `${f.insiderName}::${f.ticker}`;
    if (!byPair[key]) byPair[key] = [];
    byPair[key].push(f);
  }

  const reversals = [];
  for (const [key, trades] of Object.entries(byPair)) {
    const sorted = [...trades].sort((a,b)=>(a.transactionDate||a.date||'').localeCompare(b.transactionDate||b.date||''));
    const types = [...new Set(sorted.map(t=>t.transactionType))];
    if (types.length<2) continue; // needs both a buy and a sell to be a reversal
    const last = sorted[sorted.length-1];
    const lastDt = last.transactionDate||last.date;
    if (!lastDt || lastDt<recentISO) continue; // most recent leg must be within 30d
    const prior = [...sorted].reverse().find(t=>t.transactionType!==last.transactionType);
    if (!prior) continue;
    reversals.push({
      insiderName: last.insiderName, title: last.title,
      ticker: last.ticker, company: last.company,
      priorType: prior.transactionType, priorDate: prior.transactionDate||prior.date,
      recentType: last.transactionType, recentDate: lastDt,
      recentValue: last.value, isExit: last.transactionType==='sell',
    });
  }
  return reversals.sort((a,b)=>{
    if (a.isExit!==b.isExit) return a.isExit?-1:1; // exits first
    return (b.recentDate||'').localeCompare(a.recentDate||'');
  });
}

function InsightsPage({ filings, loading, highlightTicker, setHighlightTicker, onSelectSignal, selectedSignal, onOpenDetail }) {
  const [env, setEnv] = useState('snapshot');
  return (
    <div className="page-content">
      <div className="page-header">
        <h2 className="page-title">Insights</h2>
        <p className="page-sub">Snapshot across signals, top insiders, and sector flow — or deep-dive one</p>
      </div>
      <div className="env-tabs">
        {INSIGHTS_ENVS.map(e=>(
          <button key={e.id} className={`env-tab${env===e.id?' env-tab--active':''}`} onClick={()=>setEnv(e.id)}>
            {e.label}
          </button>
        ))}
      </div>

      {env==='snapshot'&&<InsightsSnapshot filings={filings} loading={loading} onOpenDetail={onOpenDetail} onGoTo={setEnv}/>}
      {env==='signals'&&<SignalsEnvironment filings={filings} loading={loading}
        highlightTicker={highlightTicker} setHighlightTicker={setHighlightTicker}
        onSelectSignal={onSelectSignal} selectedSignal={selectedSignal} onOpenDetail={onOpenDetail}/>}
      {env==='leaderboard'&&<LeaderboardEnvironment onOpenDetail={onOpenDetail}/>}
      {env==='sectorflow'&&<SectorFlowEnvironment onOpenDetail={onOpenDetail}/>}
    </div>
  );
}

// ─── SNAPSHOT — overview cards, one per environment ────────────────────────────
function InsightsSnapshot({ filings, loading, onOpenDetail, onGoTo }) {
  const cutoff7 = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString().split('T')[0];},[]);

  const topSignals = useMemo(()=>{
    const base = filings.filter(f=>f.isOpenMarket&&f.transactionType==='buy'&&(f.transactionDate||f.date||'')>=cutoff7);
    return buildSignals(base).filter(s=>s.cSuiteBuys>=1||s.insiderCount>=2||s.netValue>=100_000)
      .sort((a,b)=>b.conviction-a.conviction).slice(0,4);
  },[filings,cutoff7]);

  const reversals = useMemo(()=>detectReversals(filings).slice(0,3),[filings]);

  const [leaderPreview, setLeaderPreview] = useState(null);
  const [sectorPreview, setSectorPreview] = useState(null);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    queryNeon(LEADERBOARD_QUERY(5)).then(setLeaderPreview).catch(()=>setLeaderPreview([]));
    queryNeon(SECTOR_FLOW_QUERY(30)).then(r=>setSectorPreview(r.slice(0,4))).catch(()=>setSectorPreview([]));
  },[]);

  return (
    <div className="snapshot-grid">
      <div className="snapshot-card">
        <div className="snapshot-card__hdr">
          <span className="snapshot-card__title">Top Signals <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· last 7d</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('signals')}>Deep dive →</button>
        </div>
        {loading?<div style={{padding:'1rem'}}><Spinner size={16}/></div>
        :topSignals.length===0?<div className="snapshot-empty">No qualifying signals this week</div>
        :<div className="snapshot-list">
          {topSignals.map(s=>(
            <div key={s.ticker} className="snapshot-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:s.ticker,company:s.company})}>
              <span className="ticker" style={{fontSize:12}}>{s.ticker}</span>
              <span className="td-muted snapshot-row__sub">{s.insiderCount} insider{s.insiderCount!==1?'s':''}</span>
              <span className={`td-mono ${s.netValue>=0?'val-buy':'val-sell'}`} style={{fontSize:11,marginLeft:'auto'}}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
            </div>
          ))}
        </div>}
        {reversals.length>0&&(
          <div className="snapshot-subsection">
            <div className="snapshot-subsection__label">⟲ {reversals.length} reversal{reversals.length!==1?'s':''} this month</div>
            {reversals.map((r,i)=>(
              <div key={i} className="snapshot-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:r.insiderName,title:r.title})}>
                <span className="ticker" style={{fontSize:11}}>{r.ticker}</span>
                <span className="td-muted snapshot-row__sub">{r.priorType}→{r.recentType}</span>
                <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{fmt.dateShort(r.recentDate)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="snapshot-card">
        <div className="snapshot-card__hdr">
          <span className="snapshot-card__title">Top Insiders <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· by trust score</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('leaderboard')}>Deep dive →</button>
        </div>
        {leaderPreview===null?<div style={{padding:'1rem'}}><Spinner size={16}/></div>
        :leaderPreview.length===0?<div className="snapshot-empty">Not enough data yet</div>
        :<div className="snapshot-list">
          {leaderPreview.map((l,i)=>(
            <div key={i} className="snapshot-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:l.insider_name,title:l.insider_title})}>
              <span className="snapshot-rank">{i+1}</span>
              <span className="dp-clickable snapshot-row__name">{l.insider_name}</span>
              <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{l.hit_rate}% hit</span>
            </div>
          ))}
        </div>}
      </div>

      <div className="snapshot-card">
        <div className="snapshot-card__hdr">
          <span className="snapshot-card__title">Sector Flow <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· last 30d</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('sectorflow')}>Deep dive →</button>
        </div>
        {sectorPreview===null?<div style={{padding:'1rem'}}><Spinner size={16}/></div>
        :sectorPreview.length===0?<div className="snapshot-empty">Not enough data yet</div>
        :<div className="snapshot-list">
          {sectorPreview.map((s,i)=>(
            <div key={i} className="snapshot-row">
              <span style={{fontSize:12}}>{s.sector}</span>
              <span className={`td-mono ${s.net_value>=0?'val-buy':'val-sell'}`} style={{fontSize:11,marginLeft:'auto'}}>{s.net_value>=0?'+':''}{fmt.money(s.net_value)}</span>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

// ─── SIGNALS environment (existing table logic, now scoped as a sub-view) ─────
function SignalsEnvironment({ filings, loading, highlightTicker, setHighlightTicker, onSelectSignal, selectedSignal, onOpenDetail }) {
  const [preset,  setPreset]  = useState(3);
  const [from,    setFrom]    = useState('');
  const [to,      setTo]      = useState('');
  const [sectorF, setSectorF] = useState('');
  const [sourceF, setSourceF] = useState('');
  const [minNet,  setMinNet]  = useState(500_000);
  const [sSort,   setSSort]   = useState('conviction');
  const [sDir,    setSDir]    = useState(-1);
  const hlRef = useRef(null);

  const sectors = useMemo(()=>[...new Set(filings.map(f=>f.sector).filter(Boolean))].sort(),[filings]);

  const effFrom = useMemo(()=>{
    if (from) return from;
    if (preset===null) return '';
    const d=new Date(); d.setDate(d.getDate()-preset);
    return d.toISOString().split('T')[0];
  },[from,preset]);

  const signals = useMemo(()=>{
    const base=filings.filter(f=>{
      const tx=f.transactionDate||f.date||'';
      if (effFrom&&tx<effFrom) return false;
      if (to&&tx>to) return false;
      if (sectorF&&f.sector!==sectorF) return false;
      const isPol=!!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
      if (sourceF==='corporate'&&isPol) return false;
      if (sourceF==='political'&&!isPol) return false;
      return true;
    });
    return buildSignals(base)
      .filter(s=>{
        if (minNet>0 && s.netValue<minNet) return false;
        return s.cSuiteBuys>=1 || s.insiderCount>=2 || s.netValue>=100_000;
      })
      .sort((a,b)=>{
        let av=a[sSort],bv=b[sSort];
        if (typeof av==='number'){if(av<bv)return sDir;if(av>bv)return -sDir;}
        else{const r=String(av||'').localeCompare(String(bv||''));return sDir>0?r:-r;}
        return 0;
      });
  },[filings,effFrom,to,sectorF,sourceF,minNet,sSort,sDir]);

  const reversals = useMemo(()=>detectReversals(filings),[filings]);

  useEffect(()=>{
    if (highlightTicker&&hlRef.current)
      hlRef.current.scrollIntoView({behavior:'smooth',block:'center'});
  },[highlightTicker,signals]);

  function onSort(col){if(sSort===col)setSDir(d=>-d);else{setSSort(col);setSDir(-1);}}
  function doPreset(days){setPreset(days);setFrom('');setTo('');}
  const shp={sortCol:sSort,sortDir:sDir,onSort};

  return (
    <div>
      {reversals.length>0&&(
        <div className="reversal-section">
          <div className="reversal-header">
            ⟲ Reversal Signals <span className="reversal-sub">insiders who changed direction in the last 30 days</span>
          </div>
          {reversals.slice(0,8).map((r,i)=>(
            <div key={i} className="reversal-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:r.insiderName,title:r.title})}>
              <span className="ticker" style={{fontSize:12}}>{r.ticker}</span>
              <span className="dp-clickable" style={{fontSize:12,flex:1}}>{r.insiderName}</span>
              <span className="reversal-dir">
                <Badge type={r.priorType==='buy'?'buy':'sell'}>{r.priorType}</Badge>
                <span className="td-muted">→</span>
                <Badge type={r.recentType==='buy'?'buy':'sell'}>{r.recentType}</Badge>
              </span>
              <span className={r.isExit?'val-sell':'val-buy'} style={{fontSize:11,fontWeight:600}}>
                {r.isExit?'exit signal':'re-entry'}
              </span>
              <span className="td-muted" style={{fontSize:10}}>{fmt.dateShort(r.recentDate)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="filter-bar filter-bar--wrap">
        <div className="date-pills">
          {DATE_PRESETS.map(p=>(
            <button key={p.label} className={`pill${preset===p.days&&!from?' pill--active':''}`}
              onClick={()=>doPreset(p.days)}>{p.label}</button>
          ))}
        </div>
        <div className="filter-sep"/>
        <select value={sectorF} onChange={e=>setSectorF(e.target.value)}>
          <option value="">All sectors</option>
          {sectors.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sourceF} onChange={e=>setSourceF(e.target.value)}>
          <option value="">All sources</option>
          <option value="corporate">Corporate</option>
          <option value="political">Political</option>
        </select>
        <div className="filter-sep"/>
        <span style={{fontSize:12,color:'var(--text-3)'}}>Min net $</span>
        <select value={minNet} onChange={e=>setMinNet(Number(e.target.value))}>
          <option value={0}>Any</option>
          <option value={500_000}>$500K+</option>
          <option value={1_000_000}>$1M+</option>
          <option value={2_000_000}>$2M+</option>
          <option value={5_000_000}>$5M+</option>
        </select>
      </div>

      {loading ? <div className="state-box"><Spinner/><p>Computing signals…</p></div>
      : signals.length===0 ? <div className="state-box"><div>◎</div><p>No signals meet threshold.</p></div>
      : <div className="table-wrap">
          <table>
            <thead><tr>
              <th>#</th>
              <SortTh label="Ticker"     colKey="ticker"       {...shp}/>
              <SortTh label="Company"    colKey="company"      {...shp}/>
              <th>Src</th>
              <th>B/S</th>
              <SortTh label="Net $"      colKey="netValue"     {...shp} right/>
              <SortTh label="Exec"       colKey="cSuiteBuys"   {...shp}/>
              <SortTh label="Insiders"   colKey="insiderCount" {...shp}/>
              <SortTh label="Last Trade" colKey="lastTradeDate"{...shp}/>
              <SortTh label="Conviction" colKey="conviction"   {...shp}/>
            </tr></thead>
            <tbody>
              {signals.map((s,i)=>{
                const isHL=s.ticker===highlightTicker;
                const isSel=s.ticker===selectedSignal?.ticker;
                return (
                  <tr key={s.ticker}
                    ref={isHL?hlRef:null}
                    className={`signal-row${isSel?' signal-row--selected':''}${isHL&&!isSel?' signal-row--highlighted':''}`}
                    onClick={()=>{setHighlightTicker(s.ticker);onSelectSignal(s);onOpenDetail&&onOpenDetail({type:'signal',...s});}}>
                    <td className="td-rank">{i+1}</td>
                    <td><span className="ticker">{s.ticker}</span></td>
                    <td className="td-company">
                      <div className="td-overflow">{s.company}</div>
                      <div className="td-sector-inline">{s.sector!=='Other'?s.sector:''}</div>
                    </td>
                    <td>{s.isPolitical?<span className="badge badge--src-congress">⚑</span>:<span className="badge badge--src-sec">SEC</span>}</td>
                    <td className="td-center">
                      <span className="sig-count buy-count">{s.buys}</span>
                      <span className="sig-sep"> / </span>
                      <span className="sig-count sell-count">{s.sells}</span>
                    </td>
                    <td className="td-right td-mono">
                      <span className={s.netValue>=0?'val-buy':'val-sell'}>
                        {s.netValue>=0?'+':''}{fmt.money(s.netValue)}
                      </span>
                    </td>
                    <td className="td-center">{s.cSuiteBuys>0?<span className="csuite-badge">{s.cSuiteBuys}×</span>:'—'}</td>
                    <td className="td-center">{s.insiderCount}</td>
                    <td className="td-date-main">{fmt.dateShort(s.lastTradeDate)}</td>
                    <td style={{width:90}}><ConvictionBar score={s.conviction}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>}
    </div>
  );
}

// ─── INSIDER LEADERBOARD environment ───────────────────────────────────────────
// Aggregate query: ranks insiders by a simplified, query-computable proxy for
// trust score (priced-trade hit rate + OM discipline + volume), since running
// the full per-insider trustScore() pipeline for every insider in the DB isn't
// practical in one query. This is consistent with the same approximation used
// for "Related Insiders" on the trader profile.
function LEADERBOARD_QUERY(limit=50, sectorFilter=null, minTrades=5) {
  const sectorClause = sectorFilter ? `AND f.sector = '${sectorFilter.replace(/'/g,"''")}'` : '';
  return `
    SELECT f.insider_name,
           -- Pick the most frequently-filed title for this name, not just
           -- whatever GROUP BY happened to land on — avoids one person
           -- splitting into multiple rows because their title varied
           -- across filings (e.g. "President" vs "President and CEO").
           MODE() WITHIN GROUP (ORDER BY f.insider_title) AS insider_title,
           MODE() WITHIN GROUP (ORDER BY f.relationship)  AS relationship,
           COUNT(*) FILTER (WHERE f.transaction_type='buy' AND f.is_open_market) AS om_buys,
           COUNT(*) FILTER (WHERE f.transaction_type='sell' AND f.is_open_market) AS om_sells,
           COUNT(*) FILTER (WHERE f.transaction_type='buy') AS total_buys,
           -- Sanity-bound the dollar sums: exclude any single transaction's
           -- value if it's wildly disproportionate (>$50B on one Form 4 line
           -- is essentially always a data/unit error, not a real trade) so
           -- one bad row can't blow up an insider's aggregate to nonsense.
           SUM(f.value) FILTER (WHERE f.transaction_type='buy'  AND f.is_open_market AND f.value < 50000000000) AS bought_value,
           SUM(f.value) FILTER (WHERE f.transaction_type='sell' AND f.is_open_market AND f.value < 50000000000) AS sold_value,
           ARRAY_AGG(DISTINCT f.ticker) FILTER (WHERE f.ticker IS NOT NULL) AS tickers,
           ARRAY_AGG(DISTINCT f.sector) FILTER (WHERE f.sector IS NOT NULL AND f.sector != 'Other') AS sectors,
           COUNT(*) FILTER (
             WHERE f.transaction_type='buy' AND f.is_open_market
               AND f.price_per_share>0 AND ph_buy.close IS NOT NULL
               AND ph_buy.close>=f.price_per_share
               AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
           ) AS wins,
           COUNT(*) FILTER (
             WHERE f.transaction_type='buy' AND f.is_open_market
               AND f.price_per_share>0 AND ph_buy.close IS NOT NULL
               AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
           ) AS priced
    FROM public.filings f
    LEFT JOIN LATERAL (
      SELECT close FROM public.prices_history
      WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
    ) ph_buy ON true
    WHERE f.insider_name IS NOT NULL
      AND COALESCE(f.transaction_date, f.filing_date) >= (CURRENT_DATE - INTERVAL '2 years')
      ${sectorClause}
    GROUP BY f.insider_name
    HAVING COUNT(*) FILTER (WHERE f.transaction_type IN ('buy','sell') AND f.is_open_market) >= ${minTrades}
    LIMIT ${limit}
  `;
}

function processLeaderboardRows(rows) {
  return rows.map(r=>{
    const hitRate = r.priced>0 ? Math.round((r.wins/r.priced)*100) : null;
    const omTotal = (r.om_buys||0)+(r.om_sells||0);
    const omDiscipline = r.total_buys>0 ? (r.om_buys/r.total_buys) : 0;
    // Same scoring shape as trustScore() but using query-computable proxies
    let s=0;
    if (hitRate!=null){if(hitRate>=70)s+=2;else if(hitRate>=50)s+=1;}else s+=0.5;
    if (omTotal>=10)s+=1;else if(omTotal>=5)s+=0.5;
    if (omDiscipline>=0.7)s+=0.5;
    const proxyScore = Math.max(0,Math.min(Math.round(s*10)/10,4)); // capped lower than full score (no realized-return data here)
    return {...r, hit_rate:hitRate, om_total:omTotal, proxy_score:proxyScore};
  }).sort((a,b)=>(b.proxy_score-a.proxy_score)||(b.wins-a.wins));
}

function LeaderboardEnvironment({ onOpenDetail }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [sectorF, setSectorF] = useState('');
  const [sectors, setSectors] = useState([]);
  const [minTrades, setMinTrades] = useState(5);
  const [sortKey, setSortKey] = useState('proxy_score');
  const [sortDir, setSortDir] = useState(-1);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    queryNeon(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL ORDER BY sector`)
      .then(r=>setSectors(r.map(x=>x.sector).filter(Boolean))).catch(()=>{});
  },[]);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL){setError('NEON_PROXY_URL not set');return;}
    setRows(null); setError(null);
    queryNeon(LEADERBOARD_QUERY(50, sectorF||null, minTrades))
      .then(r=>setRows(processLeaderboardRows(r)))
      .catch(e=>setError(e.message));
  },[sectorF,minTrades]);

  const sortedRows = useMemo(()=>{
    if (!rows) return null;
    return [...rows].sort((a,b)=>{
      let av=a[sortKey], bv=b[sortKey];
      if (sortKey==='insider_name') { av=av||''; bv=bv||''; const r=String(av).localeCompare(String(bv)); return sortDir>0?r:-r; }
      av = av==null?-Infinity:av; bv = bv==null?-Infinity:bv;
      if (av<bv) return sortDir; if (av>bv) return -sortDir; return 0;
    });
  },[rows,sortKey,sortDir]);

  function onSort(key){ if(sortKey===key) setSortDir(d=>-d); else { setSortKey(key); setSortDir(-1); } }
  const shp={sortCol:sortKey,sortDir,onSort};

  return (
    <div>
      <div className="filter-bar filter-bar--wrap">
        <select value={sectorF} onChange={e=>setSectorF(e.target.value)}>
          <option value="">All sectors</option>
          {sectors.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <div className="filter-sep"/>
        <span style={{fontSize:12,color:'var(--text-3)'}}>Min OM trades</span>
        <select value={minTrades} onChange={e=>setMinTrades(Number(e.target.value))}>
          <option value={2}>2+</option>
          <option value={5}>5+</option>
          <option value={10}>10+</option>
          <option value={20}>20+</option>
        </select>
      </div>

      {error?<div className="state-box state-box--error"><p>⚠ {error}</p></div>
      :sortedRows===null?<div className="state-box"><Spinner/><p>Ranking insiders…</p></div>
      :sortedRows.length===0?<div className="state-box"><div>◎</div><p>No insiders meet this threshold.</p></div>
      :<div className="table-wrap">
        <table>
          <thead><tr>
            <th>#</th>
            <SortTh label="Insider" colKey="insider_name" {...shp}/>
            <th>Role</th><th>Sectors</th>
            <SortTh label="OM Buys"  colKey="om_buys"      {...shp} right/>
            <SortTh label="OM Sells" colKey="om_sells"     {...shp} right/>
            <SortTh label="Bought $" colKey="bought_value" {...shp} right/>
            <SortTh label="Hit Rate" colKey="hit_rate"     {...shp} right/>
            <SortTh label="Proxy Score" colKey="proxy_score" {...shp}/>
          </tr></thead>
          <tbody>
            {sortedRows.map((r,i)=>(
              <tr key={i} className="row-clickable" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:r.insider_name,title:r.insider_title})}>
                <td className="td-rank">{i+1}</td>
                <td>
                  <div className="dp-clickable" style={{fontWeight:500}}>{r.insider_name}</div>
                  <div className="td-muted" style={{fontSize:11}}>{r.insider_title}</div>
                </td>
                <td><Badge type={`rel-${r.relationship||'weak'}`}>{r.relationship==='strong'?'C-Suite':r.relationship==='medium'?'Officer':'Director'}</Badge></td>
                <td className="td-muted" style={{fontSize:11}}>{(r.sectors||[]).slice(0,2).join(', ')||'—'}</td>
                <td className="td-right val-buy td-mono">{r.om_buys}</td>
                <td className="td-right val-sell td-mono">{r.om_sells}</td>
                <td className="td-right td-mono">{fmt.money(r.bought_value)}</td>
                <td className="td-right td-mono">{r.hit_rate!=null?`${r.hit_rate}%`:'—'}</td>
                <td style={{width:90}}><ConvictionBar score={r.proxy_score} max={4}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}

// ─── SECTOR MONEY FLOW environment ─────────────────────────────────────────────
function SECTOR_FLOW_QUERY(days=30) {
  return `
    SELECT sector,
           SUM(value) FILTER (WHERE transaction_type='buy' AND is_open_market AND value < 50000000000)  AS buy_value,
           SUM(value) FILTER (WHERE transaction_type='sell' AND is_open_market AND value < 50000000000) AS sell_value,
           COALESCE(SUM(value) FILTER (WHERE transaction_type='buy' AND is_open_market AND value < 50000000000),0)
             - COALESCE(SUM(value) FILTER (WHERE transaction_type='sell' AND is_open_market AND value < 50000000000),0) AS net_value,
           COUNT(DISTINCT insider_name) AS insider_count,
           COUNT(DISTINCT ticker) AS ticker_count
    FROM public.filings
    WHERE sector IS NOT NULL AND sector != 'Other'
      AND COALESCE(transaction_date, filing_date) >= (CURRENT_DATE - INTERVAL '${days} days')
    GROUP BY sector
    ORDER BY net_value DESC NULLS LAST
  `;
}

function SectorFlowEnvironment({ onOpenDetail }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(30);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL){setError('NEON_PROXY_URL not set');return;}
    setRows(null); setError(null);
    queryNeon(SECTOR_FLOW_QUERY(days)).then(setRows).catch(e=>setError(e.message));
  },[days]);

  const maxAbs = useMemo(()=>{
    if (!rows?.length) return 1;
    return Math.max(...rows.map(r=>Math.abs(r.net_value||0)), 1);
  },[rows]);

  return (
    <div>
      <div className="filter-bar filter-bar--wrap">
        <div className="date-pills">
          {[{l:'7d',d:7},{l:'30d',d:30},{l:'90d',d:90}].map(p=>(
            <button key={p.l} className={`pill${days===p.d?' pill--active':''}`} onClick={()=>setDays(p.d)}>{p.l}</button>
          ))}
        </div>
      </div>
      <p className="td-muted" style={{fontSize:11,marginBottom:10}}>
        Sector coverage is based on a fixed large-cap ticker map — tickers outside that map ("Other") are excluded here since they're not a meaningful sector grouping.
      </p>

      {error?<div className="state-box state-box--error"><p>⚠ {error}</p></div>
      :rows===null?<div className="state-box"><Spinner/><p>Aggregating sector flow…</p></div>
      :rows.length===0?<div className="state-box"><div>◎</div><p>No data in this window.</p></div>
      :<div className="sector-flow-list">
        {rows.map((r,i)=>{
          const pct = (Math.abs(r.net_value||0)/maxAbs)*100;
          const isPositive = (r.net_value||0)>=0;
          return (
            <div key={i} className="sector-flow-row">
              <div className="sector-flow-row__top">
                <span className="sector-flow-row__name">{r.sector}</span>
                <span className={`td-mono sector-flow-row__net ${isPositive?'val-buy':'val-sell'}`}>
                  {isPositive?'+':''}{fmt.money(r.net_value)}
                </span>
              </div>
              <div className="sector-flow-bar-track">
                <div className={`sector-flow-bar ${isPositive?'sector-flow-bar--buy':'sector-flow-bar--sell'}`} style={{width:`${pct}%`}}/>
              </div>
              <div className="sector-flow-row__meta">
                <span>{fmt.money(r.buy_value)} bought</span>
                <span>{fmt.money(r.sell_value)} sold</span>
                <span>{r.insider_count} insiders</span>
                <span>{r.ticker_count} tickers</span>
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}

// ─── ALL DATA ─────────────────────────────────────────────────────────────────
const DATA_PAGE = 100;
const DATA_DATE_PRESETS = [{l:'1d',d:1},{l:'3d',d:3},{l:'7d',d:7},{l:'30d',d:30},{l:'90d',d:90},{l:'All',d:null}];
const DATA_SORTABLE_COLS = [
  {key:'transaction_date', label:'Trade Date', type:'date'},
  {key:'ticker',           label:'Ticker',     type:'text'},
  {key:'company_name',     label:'Company',    type:'text'},
  {key:'insider_name',     label:'Insider',    type:'text'},
  {key:'transaction_type', label:'Type',       type:'text'},
  {key:'shares',           label:'Shares',     type:'num'},
  {key:'price_per_share',  label:'Price',      type:'num'},
  {key:'value',            label:'Value',      type:'num'},
  {key:'pct_owned_change', label:'Pos%',       type:'num'},
  {key:'relationship',     label:'Role',       type:'text'},
];

async function proxySQL(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({query:sql}),
  });
  if (!r.ok) throw new Error(`Proxy ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.rows||[];
}

function FilterPanel({
  open, sectors,
  openMkt, setOpenMkt, fromPortfolio, setFromPortfolio,
  sectorF, setSectorF, sourceF, setSourceF,
  relF, setRelF, typeF, setTypeF,
}) {
  if (!open) return null;
  return (
    <div className="fp-panel fp-panel--floating">
      <div className="fp-section">
        <div className="fp-section-label">Quick Filters</div>
        <label className="fp-check">
          <input type="checkbox" checked={openMkt} onChange={e=>setOpenMkt(e.target.checked)}/>
          Open market only
        </label>
        <label className="fp-check">
          <input type="checkbox" checked={fromPortfolio} onChange={e=>setFromPortfolio(e.target.checked)}/>
          From my portfolio
        </label>
      </div>

      <div className="fp-section">
        <div className="fp-section-label">Source</div>
        <div className="fp-pills">
          {[['','All'],['corporate','Corporate'],['political','Political']].map(([v,l])=>(
            <button key={v} className={`fp-pill${sourceF===v?' fp-pill--active':''}`} onClick={()=>setSourceF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="fp-section">
        <div className="fp-section-label">Role</div>
        <div className="fp-pills">
          {[['','All'],['strong','C-Suite'],['medium','Officer'],['weak','Director']].map(([v,l])=>(
            <button key={v} className={`fp-pill${relF===v?' fp-pill--active':''}`} onClick={()=>setRelF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="fp-section">
        <div className="fp-section-label">Transaction Type</div>
        <div className="fp-pills">
          {[['','All'],['buy','Buy'],['sell','Sell'],['other','Other']].map(([v,l])=>(
            <button key={v} className={`fp-pill${typeF===v?' fp-pill--active':''}`} onClick={()=>setTypeF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="fp-section">
        <div className="fp-section-label">Sector</div>
        <select value={sectorF} onChange={e=>setSectorF(e.target.value)} style={{width:'100%'}}>
          <option value="">All sectors</option>
          {sectors.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    </div>
  );
}

function DataPage({ onOpenDetail, portfolioTickers }) {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting,setExport] = useState(false);
  const [pg,      setPg]      = useState(0);
  const [error,   setError]   = useState(null);
  const [sectors, setSectors] = useState([]);
  const [search,  setSearch]  = useState('');
  const [searchInput, setSearchInput] = useState('');

  const [typeF,   setTypeF]   = useState('');
  const [relF,    setRelF]    = useState('');
  const [sectorF, setSectorF] = useState('');
  const [sourceF, setSourceF] = useState('');
  const [openMkt, setOpenMkt] = useState(false);
  const [fromPortfolio, setFromPortfolio] = useState(false);
  const [dPreset, setDPreset] = useState(7);
  const [dateFrom,setDateFrom]= useState('');
  const [dateTo,  setDateTo]  = useState('');

  const [filterOpen, setFilterOpen] = useState(false);
  const [sortKey, setSortKey] = useState('transaction_date');
  const [sortDir, setSortDir] = useState(-1);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    proxySQL(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL ORDER BY sector`)
      .then(r=>setSectors(r.map(x=>x.sector).filter(Boolean))).catch(()=>{});
  },[]);

  function where() {
    const c=[];
    const ef=dateFrom||(dPreset!=null?(()=>{const d=new Date();d.setDate(d.getDate()-dPreset);return d.toISOString().split('T')[0];})():null);
    if (ef)     c.push(`COALESCE(transaction_date,filing_date)>='${ef}'`);
    if (dateTo) c.push(`COALESCE(transaction_date,filing_date)<='${dateTo}'`);
    if (typeF)  c.push(`transaction_type='${typeF}'`);
    if (relF)   c.push(`relationship='${relF}'`);
    if (sectorF)c.push(`sector='${sectorF.replace(/'/g,"''")}'`);
    if (openMkt)c.push(`is_open_market=true`);
    if (sourceF==='corporate') c.push(`transaction_code NOT LIKE 'CONGRESS%'`);
    if (sourceF==='political') c.push(`transaction_code LIKE 'CONGRESS%'`);
    if (fromPortfolio && portfolioTickers && portfolioTickers.length) {
      c.push(`ticker IN (${portfolioTickers.map(t=>`'${t.replace(/'/g,"''")}'`).join(',')})`);
    } else if (fromPortfolio) {
      c.push(`1=0`); // no portfolio tickers loaded yet — show nothing rather than everything
    }
    if (search){const q=search.replace(/'/g,"''");c.push(`(ticker ILIKE '%${q}%' OR insider_name ILIKE '%${q}%' OR company_name ILIKE '%${q}%')`);}
    return c.length?'WHERE '+c.join(' AND '):'';
  }

  function orderBy() {
    const col = DATA_SORTABLE_COLS.find(c=>c.key===sortKey);
    const dir = sortDir>0?'ASC':'DESC';
    if (!col) return `ORDER BY COALESCE(transaction_date,filing_date) DESC`;
    if (sortKey==='transaction_date') return `ORDER BY COALESCE(transaction_date,filing_date) ${dir} NULLS LAST`;
    return `ORDER BY ${sortKey} ${dir} NULLS LAST`;
  }

  async function fetchPg(p) {
    if (!cfg.NEON_PROXY_URL){setError('NEON_PROXY_URL not set');return;}
    setLoading(true);setError(null);
    try {
      const w=where();
      if (p===0||total===null){
        const cnt=await proxySQL(`SELECT COUNT(*) AS count FROM public.filings ${w}`);
        setTotal(parseInt(cnt[0]?.count||0));
      }
      const data=await proxySQL(`
        SELECT transaction_date,filing_date,ticker,company_name,insider_name,insider_title,
               relationship,transaction_type,transaction_code,is_open_market,
               shares::float,price_per_share::float,value::float,pct_owned_change::float,sector
        FROM public.filings ${w}
        ${orderBy()}
        LIMIT ${DATA_PAGE} OFFSET ${p*DATA_PAGE}
      `);
      setRows(data);setPg(p);
    }catch(e){setError(e.message);}
    setLoading(false);
  }

  useEffect(()=>{setTotal(null);fetchPg(0);},[typeF,relF,sectorF,sourceF,openMkt,fromPortfolio,dateFrom,dateTo,dPreset,search,sortKey,sortDir]);

  function onSort(key) {
    if (sortKey===key) setSortDir(d=>-d);
    else { setSortKey(key); setSortDir(key==='transaction_date'?-1:1); }
  }

  async function doExport() {
    setExport(true);
    try {
      const data=await proxySQL(`
        SELECT transaction_date,filing_date,ticker,company_name,insider_name,insider_title,
               transaction_type,transaction_code,is_open_market,shares::float,
               price_per_share::float,value::float,pct_owned_change::float,relationship,sector,footnotes
        FROM public.filings ${where()}
        ${orderBy()} LIMIT 50000
      `);
      const hdrs=['transaction_date','filing_date','ticker','company_name','insider_name','insider_title',
        'transaction_type','transaction_code','is_open_market','shares','price_per_share',
        'value','pct_owned_change','relationship','sector','footnotes'];
      const csv=[hdrs.join(','),...data.map(r=>hdrs.map(h=>{
        const v=r[h];if(v==null)return '';
        const s=String(v);return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}`:s;
      }).join(','))].join('\n');
      const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
      a.download=`insider_trades_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
    }catch(e){alert(`Export failed: ${e.message}`);}
    setExport(false);
  }

  const totalPgs=total!=null?Math.ceil(total/DATA_PAGE):null;
  const activeFilterCount = [typeF,relF,sectorF,sourceF,openMkt,fromPortfolio].filter(Boolean).length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
          <div>
            <h2 className="page-title">All Data</h2>
            <p className="page-sub">{total!=null?`${total.toLocaleString()} filings matching filters · ${DATA_PAGE}/page`:'Loading…'}</p>
          </div>
          <button className="btn btn--primary" onClick={doExport} disabled={exporting}>
            {exporting?'⏳ Exporting…':'⬇ Export CSV'}
          </button>
        </div>
      </div>

      <div className="filter-row">
        <div className="filter-bar filter-bar--wrap">
          <div className="search-wrap">
            <span className="search-icon">⌕</span>
            <input type="search" placeholder="Ticker, insider, company… (Enter)"
              value={searchInput} onChange={e=>setSearchInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&setSearch(searchInput)}/>
          </div>
          <div className="date-pills">
            {DATA_DATE_PRESETS.map(p=>(
              <button key={p.l} className={`pill${dPreset===p.d&&!dateFrom?' pill--active':''}`}
                onClick={()=>{setDPreset(p.d);setDateFrom('');setDateTo('');}}>
                {p.l}</button>
            ))}
          </div>
          <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDPreset(null);}}/>
          <span style={{color:'var(--text-3)',fontSize:12}}>→</span>
          <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setDPreset(null);}}/>
        </div>
        <div className="fp-anchor">
          <button className={`fp-toggle${activeFilterCount?' fp-toggle--active':''}`} onClick={()=>setFilterOpen(o=>!o)}>
            <span>☰ Filters{activeFilterCount?` (${activeFilterCount})`:''}</span>
            <span className="fp-toggle-icon">{filterOpen?'×':'›'}</span>
          </button>
          <FilterPanel
            open={filterOpen}
            sectors={sectors}
            openMkt={openMkt} setOpenMkt={setOpenMkt}
            fromPortfolio={fromPortfolio} setFromPortfolio={setFromPortfolio}
            sectorF={sectorF} setSectorF={setSectorF}
            sourceF={sourceF} setSourceF={setSourceF}
            relF={relF} setRelF={setRelF}
            typeF={typeF} setTypeF={setTypeF}
          />
        </div>
      </div>

      <div className="data-layout">
        <div className="data-main">
          {error?<div className="state-box state-box--error"><p>⚠ {error}</p></div>
          :loading?<div className="state-box"><Spinner/><p>Loading…</p></div>
          :rows.length===0?<div className="state-box"><div>◎</div><p>No filings match these filters.</p></div>
          :<div className="table-wrap">
            <table>
              <thead><tr>
                {DATA_SORTABLE_COLS.map(c=>(
                  <SortTh key={c.key} label={c.label} colKey={c.key} sortCol={sortKey} sortDir={sortDir} onSort={onSort}
                    right={c.type==='num'}/>
                ))}
                <th>OM</th>
              </tr></thead>
              <tbody>
                {rows.map((r,i)=>{
                  const rel=r.relationship||'weak';
                  const rl=rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Dir';
                  const tt=r.transaction_type;
                  return (
                    <tr key={i} className={`row-${tt} row-clickable`}
                      onClick={()=>onOpenDetail&&onOpenDetail({type:'transaction',trade:{
                        ticker:r.ticker,company:r.company_name,company_name:r.company_name,
                        insiderName:r.insider_name,insider_name:r.insider_name,
                        title:r.insider_title,insider_title:r.insider_title,
                        transactionType:tt,transaction_type:tt,
                        transactionCode:r.transaction_code,transaction_code:r.transaction_code,
                        isOpenMarket:r.is_open_market,is_open_market:r.is_open_market,
                        price:r.price_per_share,price_per_share:r.price_per_share,
                        shares:r.shares,value:r.value,
                        pctOwnedChange:r.pct_owned_change,pct_owned_change:r.pct_owned_change,
                        transactionDate:r.transaction_date,transaction_date:r.transaction_date,
                        date:r.filing_date,filing_date:r.filing_date,
                        relationship:r.relationship,sector:r.sector,
                      }})}>
                      <td className="td-date">
                        <div className="td-date-main">{fmt.dateShort(r.transaction_date||r.filing_date)}</div>
                        {r.filing_date&&r.filing_date!==r.transaction_date&&
                          <div style={{fontSize:11,color:'var(--text-3)'}}>filed {fmt.dateShort(r.filing_date)}</div>}
                      </td>
                      <td><span className="ticker dp-clickable" onClick={e=>{e.stopPropagation();r.ticker&&onOpenDetail&&onOpenDetail({type:'ticker',ticker:r.ticker,company:r.company_name});}}>{r.ticker||'—'}</span></td>
                      <td className="td-company">
                        <div className="td-overflow">{r.company_name}</div>
                        <div className="td-sector-inline">{r.sector!=='Other'?r.sector:''}</div>
                      </td>
                      <td className="td-insider">
                        <div className="td-overflow dp-clickable" onClick={e=>{e.stopPropagation();r.insider_name&&onOpenDetail&&onOpenDetail({type:'trader',name:r.insider_name,title:r.insider_title});}}>{r.insider_name}</div>
                        <div className="td-muted td-overflow" style={{fontSize:11}}>{r.insider_title||'—'}</div>
                      </td>
                      <td>
                        <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>
                          {tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆ Other'}
                        </Badge>
                        {r.transaction_code&&<div className="code-pill-sm" title={TX_CODE_TOOLTIPS[r.transaction_code]||r.transaction_code}>{r.transaction_code}</div>}
                      </td>
                      <td className="td-right td-mono">{fmt.number(r.shares)}</td>
                      <td className="td-right td-mono">{fmt.price(r.price_per_share)}</td>
                      <td className="td-right td-mono">
                        <span className={tt==='buy'?'val-buy':tt==='sell'?'val-sell':''}>{fmt.money(r.value)}</span>
                      </td>
                      <td className="td-right td-mono">
                        {r.pct_owned_change!=null?<span className="val-buy">+{parseFloat(r.pct_owned_change).toFixed(1)}%</span>:'—'}
                      </td>
                      <td><Badge type={`rel-${rel}`}>{rl}</Badge></td>
                      <td style={{textAlign:'center'}}>{r.is_open_market&&<span className="om-dot">●</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}

          {!loading&&!error&&totalPgs>1&&(
            <div className="pagination">
              <span className="pagination__info">
                {pg*DATA_PAGE+1}–{Math.min((pg+1)*DATA_PAGE,total||0)} of {(total||0).toLocaleString()}
              </span>
              <div className="pagination__btns">
                <button className="btn" onClick={()=>fetchPg(0)}       disabled={pg===0||loading}>««</button>
                <button className="btn" onClick={()=>fetchPg(pg-1)}    disabled={pg===0||loading}>‹</button>
                <span className="pagination__counter">{pg+1}/{totalPgs}</span>
                <button className="btn" onClick={()=>fetchPg(pg+1)}    disabled={pg>=totalPgs-1||loading}>›</button>
                <button className="btn" onClick={()=>fetchPg(totalPgs-1)} disabled={pg>=totalPgs-1||loading}>»»</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PORTFOLIO ────────────────────────────────────────────────────────────────
function EquityCurve({ history }) {
  if (!history||!history.equity||!history.timestamp)
    return <div className="state-box"><div>◎</div><p>No equity history available.</p></div>;
  const equity=history.equity.filter(v=>v!=null);
  const ts=history.timestamp.slice(-equity.length);
  if (equity.length<2) return <div className="state-box"><p>Not enough data yet.</p></div>;
  const W=600,H=180,pad={t:14,r:14,b:26,l:58};
  const iW=W-pad.l-pad.r,iH=H-pad.t-pad.b;
  const mn=Math.min(...equity),mx=Math.max(...equity),rng=mx-mn||1;
  const pts=equity.map((v,i)=>[pad.l+(i/(equity.length-1))*iW,pad.t+(1-(v-mn)/rng)*iH]);
  const line=pts.map((p,i)=>`${i===0?'M':'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area=line+` L${pts[pts.length-1][0].toFixed(1)},${pad.t+iH} L${pad.l},${pad.t+iH} Z`;
  const up=equity[equity.length-1]>=equity[0];
  const lc=up?'var(--green-600)':'var(--red-600)';
  const gain=equity[equity.length-1]-equity[0];
  const yL=[0,.5,1].map(f=>({y:pad.t+(1-f)*iH,v:fmt.money(mn+f*rng)}));
  const step=Math.max(1,Math.floor(ts.length/4));
  const xL=ts.filter((_,i)=>i===0||i===ts.length-1||i%step===0).slice(0,5)
    .map(t=>({x:pad.l+(ts.indexOf(t)/(ts.length-1))*iW,
              lb:fmt.dateShort(new Date(t*1000).toISOString().split('T')[0])}));
  return (
    <div>
      <div style={{display:'flex',gap:10,marginBottom:12}}>
        <div className="stat-card" style={{flex:'0 0 auto'}}>
          <div className="stat-label">Period Return</div>
          <div className={`stat-value ${up?'val-buy':'val-sell'}`} style={{fontSize:18}}>
            {up?'+':''}{fmt.money(gain)}
          </div>
        </div>
        <div className="stat-card" style={{flex:'0 0 auto'}}>
          <div className="stat-label">Range</div>
          <div className="stat-value" style={{fontSize:14}}>{fmt.money(equity[0])} → {fmt.money(equity[equity.length-1])}</div>
        </div>
      </div>
      <div className="table-wrap" style={{padding:12}}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'auto',display:'block'}}>
          <defs>
            <linearGradient id="ecg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lc} stopOpacity=".15"/>
              <stop offset="100%" stopColor={lc} stopOpacity="0"/>
            </linearGradient>
          </defs>
          <path d={area} fill="url(#ecg)"/>
          {yL.map((l,i)=>(
            <g key={i}>
              <line x1={pad.l} y1={l.y} x2={pad.l+iW} y2={l.y} stroke="var(--border)" strokeWidth=".5"/>
              <text x={pad.l-5} y={l.y+4} textAnchor="end" fontSize="9" fill="var(--text-3)">{l.v}</text>
            </g>
          ))}
          <path d={line} fill="none" stroke={lc} strokeWidth="1.5" strokeLinejoin="round"/>
          {xL.map((l,i)=>(
            <text key={i} x={l.x} y={H-5} textAnchor="middle" fontSize="9" fill="var(--text-3)">{l.lb}</text>
          ))}
          <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="3" fill={lc}/>
        </svg>
      </div>
    </div>
  );
}

function PortfolioPage() {
  const [data,    setData]    = useState(null);
  const [history, setHistory] = useState(null);
  const [orders,  setOrders]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [ptab,    setPtab]    = useState('positions');
  const isPaper = !(cfg && cfg.ALPACA_LIVE);

  async function load() {
    if (!cfg.NEON_PROXY_URL){setError('NEON_PROXY_URL not set');setLoading(false);return;}
    setLoading(true);setError(null);
    try {
      const base=cfg.NEON_PROXY_URL;
      const [pR,hR,oR]=await Promise.all([
        fetch(`${base}/portfolio`),
        fetch(`${base}/portfolio/history`),
        fetch(`${base}/portfolio/orders`),
      ]);
      const port=await pR.json();
      if (port.error) throw new Error(port.error);
      setData(port);setHistory(await hR.json());
      const ord=await oR.json();setOrders(Array.isArray(ord)?ord:[]);
    }catch(e){setError(e.message);}
    setLoading(false);
  }

  useEffect(()=>{load();},[]);

  if (loading) return (
    <div className="page-content">
      <div className="page-header"><h2 className="page-title">Portfolio</h2></div>
      <div className="state-box"><Spinner/><p>Loading Alpaca portfolio…</p></div>
    </div>
  );

  if (error) return (
    <div className="page-content">
      <div className="page-header"><h2 className="page-title">Portfolio</h2></div>
      <div className="state-box state-box--error">
        <div>⚠</div><p>{error}</p>
        <p style={{fontSize:12,opacity:.7,marginTop:6}}>
          Check that ALPACA_KEY and ALPACA_SECRET are set as Cloudflare Worker secrets, then re-deploy.
        </p>
        <button className="btn btn--primary" onClick={load} style={{marginTop:10}}>Retry</button>
      </div>
    </div>
  );

  const acct=data?.account||{};
  const pos=data?.positions||[];
  const eq=parseFloat(acct.equity||0);
  const leq=parseFloat(acct.last_equity||0);
  const cash=parseFloat(acct.cash||0);
  const bp=parseFloat(acct.buying_power||0);
  const dpl=eq-leq;
  const dpct=leq>0?(dpl/leq)*100:0;
  const tupl=pos.reduce((s,p)=>s+parseFloat(p.unrealized_pl||0),0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between'}}>
          <div>
            <h2 className="page-title">Portfolio</h2>
            <p className="page-sub">
              <span className={`badge ${isPaper?'badge--other':'badge--buy'}`}>
                {isPaper?'Paper Trading':'Live Trading'}
              </span>
              {' '}Alpaca · {acct.account_number||''}
            </p>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>

      <div className="port-stats">
        <StatCard label="Portfolio Value" value={fmt.money(eq)}
          sub={`${dpl>=0?'+':''}${fmt.money(dpl)} today (${fmt.pct(dpct)})`}
          color={dpl>=0?'var(--green-600)':'var(--red-600)'}/>
        <StatCard label="Unrealized P&L"
          value={`${tupl>=0?'+':''}${fmt.money(tupl)}`}
          sub={`${pos.length} position${pos.length!==1?'s':''}`}
          color={tupl>=0?'var(--green-600)':'var(--red-600)'}/>
        <StatCard label="Cash"         value={fmt.money(cash)}/>
        <StatCard label="Buying Power" value={fmt.money(bp)}/>
      </div>

      <div className="port-tabs">
        {[['positions','Positions'],['history','Equity Curve'],['orders','Orders']].map(([id,lbl])=>(
          <button key={id} className={`port-tab${ptab===id?' port-tab--active':''}`}
            onClick={()=>setPtab(id)}>{lbl}</button>
        ))}
      </div>

      {ptab==='positions'&&(
        pos.length===0?(
          <div className="state-box"><div>◎</div><p>No open positions.{isPaper?' Paper trading account.':''}</p></div>
        ):(
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Symbol</th><th className="th--right">Qty</th>
                <th className="th--right">Avg Entry</th><th className="th--right">Current</th>
                <th className="th--right">Mkt Value</th><th className="th--right">Unreal P&L</th>
                <th className="th--right">Return</th><th className="th--right">Today P&L</th>
              </tr></thead>
              <tbody>
                {[...pos].sort((a,b)=>Math.abs(parseFloat(b.unrealized_pl||0))-Math.abs(parseFloat(a.unrealized_pl||0)))
                  .map((p,i)=>{
                    const upl=parseFloat(p.unrealized_pl||0);
                    const pct=parseFloat(p.unrealized_plpc||0)*100;
                    const tpl=parseFloat(p.unrealized_intraday_pl||0);
                    const mv=parseFloat(p.market_value||0);
                    return (
                      <tr key={i} className={p.side==='long'?'row-buy':'row-sell'}>
                        <td><span className="ticker">{p.symbol}</span>
                            <div className="td-muted" style={{fontSize:11}}>{p.side}</div></td>
                        <td className="td-right td-mono">{fmt.number(parseFloat(p.qty||0))}</td>
                        <td className="td-right td-mono">{fmt.price(parseFloat(p.avg_entry_price||0))}</td>
                        <td className="td-right td-mono">{fmt.price(parseFloat(p.current_price||0))}</td>
                        <td className="td-right td-mono">{fmt.money(mv)}</td>
                        <td className={`td-right td-mono ${upl>=0?'val-buy':'val-sell'}`}>{upl>=0?'+':''}{fmt.money(upl)}</td>
                        <td className={`td-right td-mono ${pct>=0?'val-buy':'val-sell'}`}>{pct>=0?'+':''}{pct.toFixed(2)}%</td>
                        <td className={`td-right td-mono ${tpl>=0?'val-buy':'val-sell'}`}>{tpl>=0?'+':''}{fmt.money(tpl)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )
      )}
      {ptab==='history'&&<EquityCurve history={history}/>}
      {ptab==='orders'&&(
        !orders||orders.length===0?(
          <div className="state-box"><div>◎</div><p>No recent orders.</p></div>
        ):(
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Symbol</th><th>Side</th><th>Type</th>
                <th className="th--right">Qty</th><th className="th--right">Filled Avg</th>
                <th>Status</th><th>Date</th>
              </tr></thead>
              <tbody>
                {orders.map((o,i)=>(
                  <tr key={i} className={o.side==='buy'?'row-buy':'row-sell'}>
                    <td><span className="ticker">{o.symbol}</span></td>
                    <td><Badge type={o.side==='buy'?'buy':'sell'}>{o.side==='buy'?'▲ Buy':'▼ Sell'}</Badge></td>
                    <td className="td-muted">{o.type}</td>
                    <td className="td-right td-mono">{parseFloat(o.filled_qty||0)}/{parseFloat(o.qty||0)}</td>
                    <td className="td-right td-mono">{o.filled_avg_price?fmt.price(parseFloat(o.filled_avg_price)):'—'}</td>
                    <td><span className={`badge ${o.status==='filled'?'badge--buy':o.status==='canceled'?'badge--sell':'badge--other'}`}>{o.status}</span></td>
                    <td><div className="td-date-main">{fmt.dateShort(o.submitted_at?.split('T')[0])}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
function App() {
  const [dark,setDark] = useTheme();
  const [page,setPage] = useState('dashboard');
  const [filings,setFilings]  = useState([]);
  const [loading,setLoading]  = useState(true);
  const [error,setError]      = useState(null);
  const [selSignal,setSelSig] = useState(null);
  const [hlTicker,setHlTick]  = useState(null);
  const [detail,setDetail]    = useState(null);
  const [detailHistory,setDetailHistory] = useState([]); // stack of previous `detail` states for back navigation
  const [portfolioTickers, setPortfolioTickers] = useState([]);

  const load = useCallback(async()=>{
    setLoading(true);setError(null);
    try{const d=await EdgarData.loadFilings();setFilings(d);}
    catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{load();},[load]);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    fetch(`${cfg.NEON_PROXY_URL}/portfolio`)
      .then(r=>r.json())
      .then(d=>{ if (!d.error && d.positions) setPortfolioTickers(d.positions.map(p=>p.symbol).filter(Boolean)); })
      .catch(()=>{});
  },[]);

  function drillSignal(s){setHlTick(s.ticker);setSelSig(s);setDetail({type:'signal',...s});setDetailHistory([]);setPage('signals');}
  function selectSignal(s){setSelSig(s);if(s){setHlTick(s.ticker);setDetail({type:'signal',...s});setDetailHistory([]);}else setDetail(null);}
  function openDetail(d){setDetail(d);setDetailHistory([]);} // fresh open from outside the panel resets history
  function closeDetail(){setDetail(null);setDetailHistory([]);setSelSig(null);}
  function panelNav(d){setDetail(prev=>{if(prev)setDetailHistory(h=>[...h,prev]);return d;});}
  function panelBack(){setDetailHistory(h=>{if(!h.length)return h;const prev=h[h.length-1];setDetail(prev);return h.slice(0,-1);});}
  function navTo(p){setPage(p);setDetail(null);setDetailHistory([]);setSelSig(null);setHlTick(null);}

  const panelOpen = !!detail;

  return (
    <div className={`app-shell${panelOpen?' app-shell--panel-open':''}`}>
      <Sidebar page={page} setPage={navTo} dark={dark} setDark={setDark}/>
      <main className="main-area">
        <div className="content-area">
          {page==='dashboard'&&<DashboardPage filings={filings} loading={loading} onDrillSignal={drillSignal} onOpenDetail={openDetail}/>}
          {page==='signals'  &&<InsightsPage   filings={filings} loading={loading}
            highlightTicker={hlTicker} setHighlightTicker={setHlTick}
            onSelectSignal={selectSignal} selectedSignal={selSignal}
            onOpenDetail={openDetail}/>}
          {page==='data'     &&<DataPage onOpenDetail={openDetail} portfolioTickers={portfolioTickers}/>}
          {page==='portfolio'&&<PortfolioPage/>}
        </div>
        <footer className="footer">
          <a href="https://www.sec.gov" target="_blank" rel="noreferrer">SEC EDGAR</a>
          {' · '}Not financial advice.
        </footer>
      </main>
      {panelOpen&&(
        <>
          <div className="panel-overlay" onClick={closeDetail}/>
          <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onNavigate={panelNav} onBack={panelBack} canGoBack={detailHistory.length>0}/>
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);