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
  dateShort: d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—',
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
  {id:'signals',   icon:'⬆', label:'Signals'},
  {id:'data',      icon:'≡', label:'All Data'},
  {id:'portfolio', icon:'◎', label:'Portfolio'},
];
function Sidebar({ page, setPage, dark, setDark }) {
  return (
    <nav className="sidebar">
      <div className="sidebar__logo">
        <div className="logo-mark">IT</div>
        <div className="logo-text">
          <div className="logo-name">InsiderDesk</div>
          <div className="logo-sub">Trading Intelligence</div>
        </div>
      </div>
      <div className="sidebar__nav">
        {NAV.map(n => (
          <button key={n.id}
            className={`nav-item${page===n.id?' nav-item--active':''}`}
            onClick={()=>setPage(n.id)}>
            <span className="nav-icon">{n.icon}</span>
            <span className="nav-label">{n.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar__footer">
        <button className="nav-item nav-item--sm" onClick={()=>setDark(d=>!d)}>
          <span className="nav-icon">{dark?'☀':'☾'}</span>
          <span className="nav-label">{dark?'Light':'Dark'}</span>
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

// ─── Detail panel ─── trader / ticker / transaction / signal ─────────────────
async function queryNeon(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({query:sql}),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.rows||[];
}

function trustScore(st) {
  if (!st||st.omBuys<2) return null;
  let s=0;
  if (st.hitRate!=null){if(st.hitRate>=70)s+=2;else if(st.hitRate>=50)s+=1;}else s+=0.5;
  if (st.avgReturn!=null){if(st.avgReturn>=20)s+=1.5;else if(st.avgReturn>=5)s+=1;else if(st.avgReturn>=0)s+=0.5;}
  if (st.omBuys>=10)s+=1;else if(st.omBuys>=5)s+=0.5;
  if (st.totalBuys>0&&st.omBuys/st.totalBuys>=0.7)s+=0.5;
  return Math.min(Math.round(s*10)/10,5);
}

function TrustStars({score}) {
  if (score===null) return <span className="td-muted" style={{fontSize:11}}>Insufficient data</span>;
  const full=Math.floor(score), half=score-full>=0.3?1:0, empty=5-full-half;
  return (
    <span className="trust-stars" title={`${score}/5`}>
      {'★'.repeat(full)}{half?'½':''}{' ☆'.repeat(empty).trim()}
      <span style={{fontSize:11,marginLeft:5,fontFamily:'var(--font-mono)'}}>{score}/5</span>
    </span>
  );
}

function DetailPanel({ detail, filings, onClose, onNavigate }) {
  if (!detail) return null;
  const [traderRows,  setTraderRows]  = useState(null);
  const [tickerRows,  setTickerRows]  = useState(null);
  const [busy,        setBusy]        = useState(false);
  const nav = (type,data) => onNavigate&&onNavigate({type,...data});

  // Load full trader history from Neon
  useEffect(()=>{
    if (detail.type!=='trader') return;
    setTraderRows(null); setBusy(true);
    queryNeon(`
      SELECT f.transaction_date,f.filing_date,f.ticker,f.company_name,
             f.transaction_type,f.transaction_code,f.is_open_market,
             f.shares::float,f.price_per_share::float AS price,
             f.value::float,f.pct_owned_change::float,
             f.relationship,f.insider_title AS title,f.sector,
             ph.close::float AS current_price
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph ON true
      WHERE f.insider_name='${detail.name.replace(/'/g,"''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r=>{setTraderRows(r);setBusy(false);}).catch(()=>setBusy(false));
  },[detail.type,detail.name]);

  // Load full ticker history from Neon
  useEffect(()=>{
    if (detail.type!=='ticker') return;
    setTickerRows(null); setBusy(true);
    queryNeon(`
      SELECT f.transaction_date,f.filing_date,f.insider_name,
             f.insider_title AS title,f.relationship,
             f.transaction_type,f.transaction_code,f.is_open_market,
             f.shares::float,f.price_per_share::float AS price,
             f.value::float,f.pct_owned_change::float,f.sector,
             ph.close::float AS current_price
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph ON true
      WHERE f.ticker='${(detail.ticker||'').replace(/'/g,"''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r=>{setTickerRows(r);setBusy(false);}).catch(()=>setBusy(false));
  },[detail.type,detail.ticker]);

  const traderStats = useMemo(()=>{
    if (!traderRows?.length) return null;
    const buys=traderRows.filter(r=>r.transaction_type==='buy');
    const sells=traderRows.filter(r=>r.transaction_type==='sell');
    const omBuys=buys.filter(r=>r.is_open_market);
    const withRet=omBuys.filter(r=>r.price>0&&r.current_price!=null);
    const winners=withRet.filter(r=>r.current_price>=r.price);
    const avgReturn=withRet.length?+(withRet.reduce((s,r)=>s+((r.current_price-r.price)/r.price*100),0)/withRet.length).toFixed(1):null;
    const hitRate=withRet.length?Math.round((winners.length/withRet.length)*100):null;
    const byTk={};
    for (const r of omBuys){
      if(!r.ticker||!r.price||!r.current_price)continue;
      if(!byTk[r.ticker])byTk[r.ticker]={ticker:r.ticker,ret:0,count:0};
      byTk[r.ticker].ret+=((r.current_price-r.price)/r.price)*100;
      byTk[r.ticker].count++;
    }
    const bestTickers=Object.values(byTk).map(t=>({...t,avgRet:t.ret/t.count})).sort((a,b)=>b.avgRet-a.avgRet).slice(0,3);
    const dates=traderRows.map(r=>r.transaction_date||r.filing_date).filter(Boolean).sort();
    return {
      totalBuys:buys.length,sells:sells.length,omBuys:omBuys.length,
      avgReturn,hitRate,withReturn:withRet.length,
      totalBuyVal:omBuys.reduce((s,r)=>s+(r.value||0),0),
      companies:[...new Set(traderRows.map(r=>r.ticker).filter(Boolean))],
      sectors:[...new Set(traderRows.map(r=>r.sector).filter(Boolean))],
      role:traderRows[0]?.relationship||'weak',title:traderRows[0]?.title||'',
      bestTickers,firstTrade:dates[dates.length-1],lastTrade:dates[0],
    };
  },[traderRows]);

  const tickerStats = useMemo(()=>{
    if (!tickerRows?.length) return null;
    const buys=tickerRows.filter(r=>r.transaction_type==='buy');
    const sells=tickerRows.filter(r=>r.transaction_type==='sell');
    const cSuite=buys.filter(r=>r.relationship==='strong'&&r.is_open_market);
    const names=[...new Set(tickerRows.map(r=>r.insider_name).filter(Boolean))];
    return {
      buys:buys.length,sells:sells.length,cSuite:cSuite.length,insiders:names.length,
      insiderNames:names.slice(0,5),
      net:buys.reduce((s,r)=>s+(r.value||0),0)-sells.reduce((s,r)=>s+(r.value||0),0),
    };
  },[tickerRows]);

  const byInsider = useMemo(()=>{
    if (detail.type!=='signal') return [];
    const map={};
    for (const t of detail.trades||[]) {
      const k=t.insiderName||'Unknown';
      if (!map[k]) map[k]={name:k,title:t.title,rel:t.relationship,trades:[]};
      map[k].trades.push(t);
    }
    for (const v of Object.values(map))
      v.trades.sort((a,b)=>(b.transactionDate||b.date||'').localeCompare(a.transactionDate||a.date||''));
    return Object.values(map).sort((a,b)=>{
      const ra=a.rel==='strong'?0:a.rel==='medium'?1:2,rb=b.rel==='strong'?0:b.rel==='medium'?1:2;
      if(ra!==rb)return ra-rb;
      return b.trades.reduce((s,t)=>s+(t.value||0),0)-a.trades.reduce((s,t)=>s+(t.value||0),0);
    });
  },[detail]);

  const score = traderStats?trustScore(traderStats):null;

  const RelBadge=({rel})=><Badge type={`rel-${rel}`}>{rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Director'}</Badge>;

  const TRow=({r,showTicker,showInsider})=>{
    const tt=r.transaction_type||r.transactionType;
    const pr=r.price||r.price_per_share;
    const cur=r.current_price||r.currentPrice;
    const ret=(pr&&cur&&pr>0)?((cur-pr)/pr*100):null;
    const dt=r.transaction_date||r.transactionDate||r.date;
    return (
      <div className={`dp-trade dp-trade--${tt}`}>
        <div className="dp-trade-top">
          <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>
            {tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆'}
          </Badge>
          {showTicker&&r.ticker&&<span className="ticker dp-clickable" style={{fontSize:11}}
            onClick={()=>nav('ticker',{ticker:r.ticker,company:r.company_name})}>{r.ticker}</span>}
          {showInsider&&r.insider_name&&<span className="dp-clickable" style={{fontSize:11}}
            onClick={()=>nav('trader',{name:r.insider_name,title:r.title})}>{r.insider_name}</span>}
          <span className="dp-trade-val">{fmt.money(r.value)}</span>
          <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{fmt.dateShort(dt)}</span>
        </div>
        <div style={{display:'flex',gap:8,marginTop:3,flexWrap:'wrap',fontSize:10,color:'var(--text-3)'}}>
          {pr!=null&&<span>
            <span style={{color:'var(--text-2)',fontFamily:'var(--font-mono)'}}>@ {fmt.price(pr)}</span>
            {ret!=null&&<span className={ret>=0?'val-buy':'val-sell'}> now {fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)</span>}
          </span>}
          {(r.pct_owned_change||r.pctOwnedChange)!=null&&<span className="val-buy">+{(r.pct_owned_change||r.pctOwnedChange).toFixed(0)}%pos</span>}
          {r.shares&&<span>{fmt.number(r.shares)} sh</span>}
          {(r.transaction_code||r.transactionCode)&&<span>{r.transaction_code||r.transactionCode}{(r.is_open_market||r.isOpenMarket)&&<span className="om-dot"> ●</span>}</span>}
        </div>
      </div>
    );
  };

  const header=()=>{
    if(detail.type==='trader')return<div><div style={{fontWeight:600,fontSize:15}}>{detail.name}</div>{traderStats?.title&&<div className="td-muted" style={{fontSize:11}}>{traderStats.title}</div>}</div>;
    if(detail.type==='ticker')return<div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:17}}>{detail.ticker}</span><span style={{fontSize:13,color:'var(--text-2)'}}>{detail.company}</span></div>;
    if(detail.type==='signal')return<div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:17}}>{detail.ticker}</span><span style={{fontSize:13,color:'var(--text-2)'}}>{detail.company}</span></div>;
    if(detail.type==='transaction')return<div><div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:15}}>{detail.trade?.ticker}</span><span style={{fontSize:12,color:'var(--text-2)'}}>{detail.trade?.company_name||detail.trade?.company}</span></div><div className="td-muted" style={{fontSize:11}}>Transaction detail</div></div>;
  };

  return (
    <div className="detail-panel">
      <div className="detail-panel__header">
        <div style={{minWidth:0,flex:1}}>{header()}</div>
        <button className="btn btn--ghost btn--icon" onClick={onClose}>✕</button>
      </div>
      <div className="detail-panel__body">

        {detail.type==='trader'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!traderStats?<div className="state-box" style={{padding:'2rem'}}><p>No trades found.</p></div>:(<>
          <div className="trader-trust"><div className="trader-trust__label">Trust Score</div><TrustStars score={score}/></div>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Role</span><RelBadge rel={traderStats.role}/></div>
            <div className="dp-sum-item"><span className="dp-sum-label">OM Buys</span><span className="val-buy dp-sum-val">{traderStats.omBuys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{traderStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Total $</span><span className="dp-sum-val">{fmt.money(traderStats.totalBuyVal)}</span></div>
            {traderStats.hitRate!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Hit Rate</span><span className={`dp-sum-val ${traderStats.hitRate>=60?'val-buy':traderStats.hitRate<40?'val-sell':''}`}>{traderStats.hitRate}% <span style={{fontSize:9,opacity:.7}}>({traderStats.withReturn})</span></span></div>}
            {traderStats.avgReturn!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Avg Return</span><span className={`dp-sum-val ${traderStats.avgReturn>=0?'val-buy':'val-sell'}`}>{traderStats.avgReturn>=0?'+':''}{traderStats.avgReturn}%</span></div>}
          </div>
          {traderStats.firstTrade&&<div className="trader-meta-row"><span>Active</span><span>{fmt.dateShort(traderStats.firstTrade)} – {fmt.dateShort(traderStats.lastTrade)}</span></div>}
          {traderStats.companies.length>0&&<div className="trader-meta-row"><span>Companies</span><span style={{textAlign:'right'}}>{traderStats.companies.slice(0,6).map((tk,i)=><span key={tk} className="ticker dp-clickable" style={{fontSize:11,marginLeft:i>0?4:0}} onClick={()=>nav('ticker',{ticker:tk,company:''})}>{tk}</span>)}{traderStats.companies.length>6&&<span className="td-muted" style={{fontSize:10}}> +{traderStats.companies.length-6}</span>}</span></div>}
          {traderStats.sectors.length>0&&<div className="trader-meta-row"><span>Sectors</span><span style={{fontSize:11,textAlign:'right'}}>{traderStats.sectors.slice(0,3).join(' · ')}</span></div>}
          {traderStats.bestTickers.length>0&&traderStats.bestTickers[0].avgRet>0&&(<><div className="dp-section-label" style={{marginTop:12}}>Best Performers</div>{traderStats.bestTickers.map((t,i)=><div key={i} className="trader-best-row"><span className="ticker dp-clickable" style={{fontSize:11}} onClick={()=>nav('ticker',{ticker:t.ticker,company:''})}>{t.ticker}</span><span className={t.avgRet>=0?'val-buy':'val-sell'} style={{fontFamily:'var(--font-mono)',fontSize:11}}>{t.avgRet>=0?'+':''}{t.avgRet.toFixed(1)}% avg</span><span className="td-muted" style={{fontSize:10}}>{t.count} trade{t.count!==1?'s':''}</span></div>)}</>)}
          <div className="dp-section-label" style={{marginTop:14}}>Trade History ({traderRows.length}{traderRows.length>=200?' — latest 200':''})</div>
          {traderRows.map((r,i)=><TRow key={i} r={r} showTicker={true} showInsider={false}/>)}
        </>))}

        {detail.type==='ticker'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!tickerStats?<div className="state-box" style={{padding:'2rem'}}><p>No data found.</p></div>:(<>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{tickerStats.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{tickerStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${tickerStats.net>=0?'val-buy':'val-sell'}`}>{tickerStats.net>=0?'+':''}{fmt.money(tickerStats.net)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Exec</span><span className="dp-sum-val">{tickerStats.cSuite}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{tickerStats.insiders}</span></div>
          </div>
          {tickerStats.insiderNames.length>0&&<div className="trader-meta-row"><span>Insiders</span><span style={{textAlign:'right'}}>{tickerStats.insiderNames.map((n,i)=><span key={n} className="dp-clickable" style={{fontSize:11,marginLeft:i>0?6:0}} onClick={()=>nav('trader',{name:n,title:''})}>{n.split(' ').pop()}</span>)}</span></div>}
          <div className="dp-section-label" style={{marginTop:12}}>All Insider Activity ({tickerRows.length})</div>
          {tickerRows.map((r,i)=><TRow key={i} r={r} showTicker={false} showInsider={true}/>)}
        </>))}

        {detail.type==='signal'&&(<>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{detail.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{detail.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${detail.netValue>=0?'val-buy':'val-sell'}`}>{detail.netValue>=0?'+':''}{fmt.money(detail.netValue)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Exec</span><span className="dp-sum-val">{detail.cSuiteBuys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{detail.insiderCount}</span></div>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,marginTop:14}}>
            <div className="dp-section-label" style={{margin:0}}>Trades by Insider</div>
            <button className="dp-nav-link" onClick={()=>nav('ticker',{ticker:detail.ticker,company:detail.company})}>Full history →</button>
          </div>
          {byInsider.map((ins,i)=>(
            <div key={i} className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={ins.rel}/>
                <span className="dp-clickable" style={{fontWeight:500,fontSize:12.5}} onClick={()=>nav('trader',{name:ins.name,title:ins.title})}>{ins.name}</span>
                <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{ins.title}</span>
              </div>
              {ins.trades.map((t,j)=><TRow key={j} r={{
                ...t,transaction_type:t.transactionType,transaction_code:t.transactionCode,
                is_open_market:t.isOpenMarket,price:t.price,current_price:t.currentPrice,
                pct_owned_change:t.pctOwnedChange,transaction_date:t.transactionDate,
              }} showTicker={false} showInsider={false}/>)}
            </div>
          ))}
        </>)}

        {detail.type==='transaction'&&detail.trade&&(()=>{
          const t=detail.trade;
          const tt=t.transactionType||t.transaction_type;
          const pr=t.price||t.price_per_share;
          const cur=t.currentPrice||t.current_price;
          const ret=(pr&&cur&&pr>0)?((cur-pr)/pr*100):null;
          return(<>
            <div className="dp-summary">
              <div className="dp-sum-item"><span className="dp-sum-label">Type</span><Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆'}</Badge></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Value</span><span className="dp-sum-val">{fmt.money(t.value)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Shares</span><span className="dp-sum-val">{fmt.number(t.shares)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">@ Price</span><span className="dp-sum-val">{fmt.price(pr)}</span></div>
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
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
const DASH_SORT_OPTS = [
  {key:'conviction', label:'Conviction'},
  {key:'netValue',   label:'Net $'},
  {key:'cSuiteBuys', label:'Exec Buys'},
  {key:'lastTradeDate', label:'Recency'},
];
const DASH_DATE_OPTS = [
  {label:'1d', days:1},
  {label:'3d', days:3},
  {label:'7d', days:7},
  {label:'30d',days:30},
];

function DashSignalTable({ signals, loading, title, subtitle, onSignalClick, onOpenDetail }) {
  const [sortKey, setSortKey] = useState('conviction');
  const [sortDir, setSortDir] = useState(-1);

  const sorted = useMemo(()=>[...signals].sort((a,b)=>{
    const av=a[sortKey], bv=b[sortKey];
    if (typeof av==='number'){if(av<bv)return sortDir;if(av>bv)return -sortDir;}
    else{const r=String(av||'').localeCompare(String(bv||''));return sortDir>0?r:-r;}
    return 0;
  }),[signals,sortKey,sortDir]);

  function toggleSort(k){
    if(sortKey===k)setSortDir(d=>-d);
    else{setSortKey(k);setSortDir(-1);}
  }

  return (
    <div className="dash-sig-table">
      <div className="dash-sig-table__header">
        <div className="dash-sig-table__title">
          <span>{title}</span>
          <span className="dash-sig-table__sub">{subtitle}</span>
        </div>
        <div className="dash-sig-sort">
          {DASH_SORT_OPTS.map(o=>(
            <button key={o.key}
              className={`dash-sort-btn${sortKey===o.key?' dash-sort-btn--active':''}`}
              onClick={()=>toggleSort(o.key)}>
              {o.label}
              {sortKey===o.key&&<span style={{marginLeft:2}}>{sortDir<0?'↓':'↑'}</span>}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{padding:'1.5rem',display:'flex',justifyContent:'center'}}><Spinner/></div>
      ) : sorted.length===0 ? (
        <div className="dash-sig-empty">No signals in this date range</div>
      ) : (
        <table className="dash-sig-tbl">
          <tbody>
            {sorted.map(s=>(
              <tr key={s.ticker} className="dash-sig-row"
                onClick={()=>onSignalClick(s)}>
                <td className="dst-ticker">
                  <span className="ticker"
                    onClick={e=>{e.stopPropagation();onOpenDetail&&onOpenDetail({type:'ticker',ticker:s.ticker,company:s.company});}}>
                    {s.ticker}
                  </span>
                </td>
                <td className="dst-company">
                  <div className="td-overflow" style={{maxWidth:140,fontSize:12}}>{s.company}</div>
                  <div style={{fontSize:10,color:'var(--text-3)'}}>{s.sector!=='Other'?s.sector:''}</div>
                </td>
                <td className="dst-meta">
                  {s.cSuiteBuys>0&&<span className="csuite-badge">{s.cSuiteBuys}×exec</span>}
                  <span className="td-muted" style={{fontSize:10}}>{s.insiderCount} insider{s.insiderCount!==1?'s':''}</span>
                  <span className="td-muted" style={{fontSize:10}}>{fmt.ago(s.lastTradeDate)}</span>
                </td>
                <td className="dst-val">
                  <span className={`dst-net ${s.netValue>=0?'val-buy':'val-sell'}`}>
                    {s.netValue>=0?'+':''}{fmt.money(s.netValue)}
                  </span>
                  <div style={{marginTop:2}}><ConvictionBar score={s.conviction}/></div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DashPortfolioSnippet({ filings }) {
  const [port, setPort]   = useState(null);
  const [err,  setErr]    = useState(false);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    fetch(`${cfg.NEON_PROXY_URL}/portfolio`)
      .then(r=>r.json())
      .then(d=>{ if(!d.error) setPort(d); else setErr(true); })
      .catch(()=>setErr(true));
  },[]);

  if (err || !port) return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">◎ Portfolio</div>
      <div className="dp-placeholder" style={{padding:'1rem',gap:6}}>
        <span style={{fontSize:18}}>🔗</span>
        <p style={{fontSize:11}}>{err?'Could not load Alpaca data':'Loading…'}</p>
      </div>
    </div>
  );

  const acct = port.account || {};
  const pos  = port.positions || [];
  const eq   = parseFloat(acct.equity||0);
  const leq  = parseFloat(acct.last_equity||0);
  const dpl  = eq - leq;
  const dpct = leq>0 ? (dpl/leq)*100 : 0;

  // Which positions have active insider signals in the last 7 days?
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-7);
  const iso = cutoff.toISOString().split('T')[0];
  const activeSignalTickers = new Set(
    filings
      .filter(f=>f.isOpenMarket&&f.transactionType==='buy'
                 &&(f.transactionDate||f.date||'')>=iso)
      .map(f=>f.ticker)
  );

  return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">
        ◎ Portfolio
        <span style={{fontSize:11,fontWeight:400,color:'var(--text-3)',marginLeft:6}}>
          {cfg.ALPACA_LIVE?'Live':'Paper'}
        </span>
      </div>
      <div className="dash-port-eq">
        <span className="dash-port-val">{fmt.money(eq)}</span>
        <span className={`dash-port-chg ${dpl>=0?'val-buy':'val-sell'}`}>
          {dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)}) today
        </span>
      </div>
      {pos.length===0 ? (
        <div style={{fontSize:12,color:'var(--text-3)',padding:'8px 14px'}}>No open positions</div>
      ) : (
        <div className="dash-port-positions">
          {[...pos]
            .sort((a,b)=>Math.abs(parseFloat(b.market_value||0))-Math.abs(parseFloat(a.market_value||0)))
            .map((p,i)=>{
              const upl  = parseFloat(p.unrealized_pl||0);
              const tpl  = parseFloat(p.unrealized_intraday_pl||0);
              const pct  = parseFloat(p.unrealized_plpc||0)*100;
              const hasSig = activeSignalTickers.has(p.symbol);
              return (
                <div key={i} className={`dash-pos-row${hasSig?' dash-pos-row--signal':''}`}>
                  <span className="ticker" style={{fontSize:11}}>
                    {p.symbol}
                    {hasSig&&<span className="dash-pos-signal-dot" title="Active insider signal">⬆</span>}
                  </span>
                  <span className="td-muted" style={{fontSize:11}}>{fmt.money(parseFloat(p.market_value||0))}</span>
                  <span className={`dash-pos-pnl ${tpl>=0?'val-buy':'val-sell'}`} style={{fontSize:11,fontFamily:'var(--font-mono)'}}>
                    {tpl>=0?'+':''}{fmt.money(tpl)}
                    <span style={{fontSize:10,opacity:.7}}> ({pct>=0?'+':''}{pct.toFixed(1)}%)</span>
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function DashNewsSnippet({ filings }) {
  const [news,    setNews]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // Get top tickers from recent signals to fetch news for
  const topTickers = useMemo(()=>{
    const cut=new Date(); cut.setDate(cut.getDate()-7);
    const iso=cut.toISOString().split('T')[0];
    const sigs = buildSignals(
      filings.filter(f=>f.isOpenMarket&&f.transactionType==='buy'
                      &&(f.transactionDate||f.date||'')>=iso)
    ).sort((a,b)=>b.conviction-a.conviction).slice(0,5);
    return sigs.map(s=>s.ticker);
  },[filings]);

  useEffect(()=>{
    const key = cfg.FINNHUB_API_KEY;
    if (!key || !topTickers.length) return;
    setLoading(true); setError(null);

    const today = new Date().toISOString().split('T')[0];
    const from  = new Date(); from.setDate(from.getDate()-3);
    const fromStr = from.toISOString().split('T')[0];

    // Fetch news for up to 3 top tickers, combine and dedupe
    Promise.all(
      topTickers.slice(0,3).map(tk=>
        fetch(`https://finnhub.io/api/v1/company-news?symbol=${tk}&from=${fromStr}&to=${today}&token=${key}`)
          .then(r=>r.json())
          .then(arr=>(arr||[]).slice(0,3).map(n=>({...n,_ticker:tk})))
          .catch(()=>[])
      )
    ).then(results=>{
      const all = results.flat()
        .filter(n=>n.headline&&n.url)
        .sort((a,b)=>b.datetime-a.datetime)
        .slice(0,6);
      setNews(all);
      setLoading(false);
    });
  },[topTickers.join(',')]);

  const hasKey = !!cfg.FINNHUB_API_KEY;

  return (
    <div className="dash-right-card">
      <div className="dash-right-card__title">📰 News</div>
      {!hasKey ? (
        <div className="dp-placeholder" style={{padding:'1rem',gap:6}}>
          <span style={{fontSize:18}}>📡</span>
          <p style={{fontSize:11}}>Add <code>FINNHUB_API_KEY</code> to <code>config.js</code> for live headlines on active tickers.</p>
          <p style={{fontSize:10,opacity:.6}}>Free at finnhub.io — no credit card</p>
        </div>
      ) : loading ? (
        <div style={{padding:'1rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
      ) : error ? (
        <div style={{padding:'1rem',fontSize:12,color:'var(--red-600)'}}>{error}</div>
      ) : news.length===0 ? (
        <div style={{padding:'1rem',fontSize:12,color:'var(--text-3)'}}>No recent news for active signal tickers</div>
      ) : (
        <div className="dash-news-list">
          {news.map((n,i)=>(
            <a key={i} className="dash-news-item" href={n.url} target="_blank" rel="noreferrer">
              <div className="dash-news-item__meta">
                <span className="ticker" style={{fontSize:10}}>{n._ticker}</span>
                <span className="td-muted" style={{fontSize:10}}>
                  {n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}
                </span>
              </div>
              <div className="dash-news-item__headline">{n.headline}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardPage({ filings, loading, onDrillSignal, onOpenDetail, setPage }) {
  const [days, setDays] = useState(3);

  const cutoff = useMemo(()=>{
    const d=new Date(); d.setDate(d.getDate()-days);
    return d.toISOString().split('T')[0];
  },[days]);

  const corp = useMemo(()=>{
    return buildSignals(filings.filter(f=>
      !(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'))
      &&f.isOpenMarket&&f.transactionType==='buy'&&f.relationship==='strong'
      &&(f.transactionDate||f.date||'')>=cutoff
    )).filter(s=>s.netValue>=250_000||s.cSuiteBuys>=1);
  },[filings,cutoff]);

  const pol = useMemo(()=>{
    return buildSignals(filings.filter(f=>
      (f.transactionCode&&f.transactionCode.startsWith('CONGRESS'))
      &&f.transactionType==='buy'
      &&(f.transactionDate||f.date||'')>=cutoff
    ));
  },[filings,cutoff]);

  return (
    <div className="page-content">
      <div className="dash-header-row">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p className="page-sub">{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
        </div>
        <div className="dash-date-filter">
          <span style={{fontSize:11,color:'var(--text-3)'}}>Show signals from last</span>
          <div className="date-pills">
            {DASH_DATE_OPTS.map(o=>(
              <button key={o.label}
                className={`pill${days===o.days?' pill--active':''}`}
                onClick={()=>setDays(o.days)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="dash-main-layout">
        {/* Left: signals */}
        <div className="dash-left">
          <DashSignalTable
            signals={corp} loading={loading}
            title="🏢 Corporate" subtitle="C-suite · open market"
            onSignalClick={onDrillSignal} onOpenDetail={onOpenDetail}
          />
          <DashSignalTable
            signals={pol} loading={loading}
            title="⚑ Congressional" subtitle="STOCK Act"
            onSignalClick={onDrillSignal} onOpenDetail={onOpenDetail}
          />
        </div>

        {/* Right: portfolio + news */}
        <div className="dash-right">
          <DashPortfolioSnippet filings={filings}/>
          <DashNewsSnippet filings={filings}/>
        </div>
      </div>
    </div>
  );
}

// ─── SIGNALS ──────────────────────────────────────────────────────────────────
const DATE_PRESETS=[{label:'3d',days:3},{label:'7d',days:7},{label:'14d',days:14},{label:'30d',days:30},{label:'All',days:null}];

function SignalsPage({ filings, loading, highlightTicker, setHighlightTicker, onSelectSignal, selectedSignal, onOpenDetail }) {
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
      .filter(s=>s.netValue>=minNet||s.cSuiteBuys>=2||s.insiderCount>=5)
      .sort((a,b)=>{
        let av=a[sSort],bv=b[sSort];
        if (typeof av==='number'){if(av<bv)return sDir;if(av>bv)return -sDir;}
        else{const r=String(av||'').localeCompare(String(bv||''));return sDir>0?r:-r;}
        return 0;
      });
  },[filings,effFrom,to,sectorF,sourceF,minNet,sSort,sDir]);

  useEffect(()=>{
    if (highlightTicker&&hlRef.current)
      hlRef.current.scrollIntoView({behavior:'smooth',block:'center'});
  },[highlightTicker,signals]);

  function onSort(col){if(sSort===col)setSDir(d=>-d);else{setSSort(col);setSDir(-1);}}
  function doPreset(days){setPreset(days);setFrom('');setTo('');}
  const shp={sortCol:sSort,sortDir:sDir,onSort};

  return (
    <div className="page-content">
      <div className="page-header">
        <h2 className="page-title">Signals</h2>
        <p className="page-sub">Open-market buys · click row for insider detail</p>
      </div>
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

// ─── ALL DATA ─────────────────────────────────────────────────────────────────
const DATA_PAGE = 100;

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

function DataPage({ onOpenDetail }) {
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting,setExport] = useState(false);
  const [pg,      setPg]      = useState(0);
  const [error,   setError]   = useState(null);
  const [sectors, setSectors] = useState([]);
  const [search,  setSearch]  = useState('');
  const [typeF,   setTypeF]   = useState('');
  const [relF,    setRelF]    = useState('');
  const [sectorF, setSectorF] = useState('');
  const [sourceF, setSourceF] = useState('');
  const [openMkt, setOpenMkt] = useState(false);
  const [dateFrom,setDateFrom]= useState('');
  const [dateTo,  setDateTo]  = useState('');
  const [dPreset, setDPreset] = useState(null);

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
    if (search){const q=search.replace(/'/g,"''");c.push(`(ticker ILIKE '%${q}%' OR insider_name ILIKE '%${q}%' OR company_name ILIKE '%${q}%')`);}
    return c.length?'WHERE '+c.join(' AND '):'';
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
        ORDER BY COALESCE(transaction_date,filing_date) DESC,value DESC NULLS LAST
        LIMIT ${DATA_PAGE} OFFSET ${p*DATA_PAGE}
      `);
      setRows(data);setPg(p);
    }catch(e){setError(e.message);}
    setLoading(false);
  }

  useEffect(()=>{setTotal(null);fetchPg(0);},[typeF,relF,sectorF,sourceF,openMkt,dateFrom,dateTo,dPreset]);

  async function doExport() {
    setExport(true);
    try {
      const data=await proxySQL(`
        SELECT transaction_date,filing_date,ticker,company_name,insider_name,insider_title,
               transaction_type,transaction_code,is_open_market,shares::float,
               price_per_share::float,value::float,pct_owned_change::float,relationship,sector,footnotes
        FROM public.filings ${where()}
        ORDER BY COALESCE(transaction_date,filing_date) DESC LIMIT 50000
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

  return (
    <div className="page-content">
      <div className="page-header">
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
          <div>
            <h2 className="page-title">All Filings</h2>
            <p className="page-sub">{total!=null?`${total.toLocaleString()} total · ${DATA_PAGE}/page`:'Select filters or search'}</p>
          </div>
          <button className="btn btn--primary" onClick={doExport} disabled={exporting}>
            {exporting?'⏳ Exporting…':'⬇ Export CSV'}
          </button>
        </div>
      </div>
      <div className="filter-bar filter-bar--wrap">
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input type="search" placeholder="Ticker, insider, company… (Enter)"
            value={search} onChange={e=>setSearch(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&(setTotal(null),fetchPg(0))}/>
        </div>
        <div className="date-pills">
          {[{l:'7d',d:7},{l:'30d',d:30},{l:'90d',d:90},{l:'1yr',d:365},{l:'All',d:null}].map(p=>(
            <button key={p.l} className={`pill${dPreset===p.d&&!dateFrom?' pill--active':''}`}
              onClick={()=>{setDPreset(p.d);setDateFrom('');setDateTo('');setTotal(null);}}>
              {p.l}</button>
          ))}
        </div>
        <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDPreset(null);setTotal(null);}}/>
        <span style={{color:'var(--text-3)',fontSize:12}}>→</span>
        <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setDPreset(null);setTotal(null);}}/>
        <div className="filter-sep"/>
        <select value={typeF} onChange={e=>{setTypeF(e.target.value);setTotal(null);}}>
          <option value="">All types</option><option value="buy">▲ Buy</option>
          <option value="sell">▼ Sell</option><option value="other">◆ Other</option>
        </select>
        <select value={relF} onChange={e=>{setRelF(e.target.value);setTotal(null);}}>
          <option value="">All roles</option><option value="strong">C-Suite</option>
          <option value="medium">Officer</option><option value="weak">Director</option>
        </select>
        <select value={sectorF} onChange={e=>{setSectorF(e.target.value);setTotal(null);}}>
          <option value="">All sectors</option>{sectors.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sourceF} onChange={e=>{setSourceF(e.target.value);setTotal(null);}}>
          <option value="">All sources</option>
          <option value="corporate">Corporate</option><option value="political">Political</option>
        </select>
        <label style={{display:'flex',alignItems:'center',gap:5,fontSize:12.5,color:'var(--text-2)',whiteSpace:'nowrap',cursor:'pointer'}}>
          <input type="checkbox" checked={openMkt} onChange={e=>{setOpenMkt(e.target.checked);setTotal(null);}}/>
          OM only
        </label>
      </div>

      {error?<div className="state-box state-box--error"><p>⚠ {error}</p></div>
      :loading?<div className="state-box"><Spinner/><p>Loading…</p></div>
      :rows.length===0&&total===null?<div className="state-box"><div>≡</div><p>Select a filter or press Enter to search.</p></div>
      :rows.length===0?<div className="state-box"><div>◎</div><p>No filings match.</p></div>
      :<div className="table-wrap">
        <table>
          <thead><tr>
            <th>Trade Date</th><th>Ticker</th><th>Company</th><th>Insider</th>
            <th>Type</th><th className="th--right">Shares</th><th className="th--right">Price</th>
            <th className="th--right">Value</th><th className="th--right">Pos%</th>
            <th>Role</th><th>OM</th>
          </tr></thead>
          <tbody>
            {rows.map((r,i)=>{
              const rel=r.relationship||'weak';
              const rl=rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Dir';
              const tt=r.transaction_type;
              return (
                <tr key={i} className={`row-${tt} row-clickable`} onClick={()=>onOpenDetail&&onOpenDetail({type:'transaction',trade:{ticker:r.ticker,company:r.company_name,insiderName:r.insider_name,insider_name:r.insider_name,title:r.insider_title,insider_title:r.insider_title,transactionType:tt,transaction_type:tt,transactionCode:r.transaction_code,transaction_code:r.transaction_code,transactionCodeLabel:r.transaction_code_label,isOpenMarket:r.is_open_market,is_open_market:r.is_open_market,price:r.price_per_share,price_per_share:r.price_per_share,shares:r.shares,value:r.value,pctOwnedChange:r.pct_owned_change,pct_owned_change:r.pct_owned_change,transactionDate:r.transaction_date,transaction_date:r.transaction_date,date:r.filing_date,filing_date:r.filing_date,relationship:r.relationship,relLabel:r.relationship==='strong'?'C-Suite':r.relationship==='medium'?'Officer':'Director',sector:r.sector}})}>
                  <td className="td-date">
                    <div className="td-date-main">{fmt.dateShort(r.transaction_date||r.filing_date)}</div>
                    {r.filing_date&&r.filing_date!==r.transaction_date&&
                      <div style={{fontSize:11,color:'var(--text-3)'}}>filed {fmt.dateShort(r.filing_date)}</div>}
                  </td>
                  <td><span className="ticker">{r.ticker||'—'}</span></td>
                  <td className="td-company">
                    <div className="td-overflow">{r.company_name}</div>
                    <div className="td-sector-inline">{r.sector!=='Other'?r.sector:''}</div>
                  </td>
                  <td className="td-insider">
                    <div className="td-overflow">{r.insider_name}</div>
                    <div className="td-muted td-overflow" style={{fontSize:11}}>{r.insider_title||'—'}</div>
                  </td>
                  <td>
                    <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>
                      {tt==='buy'?'▲ Buy':tt==='sell'?'▼ Sell':'◆ Other'}
                    </Badge>
                    {r.transaction_code&&<div style={{fontFamily:'var(--font-mono)',fontSize:10,color:'var(--text-3)',marginTop:2}}>{r.transaction_code}</div>}
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

  const load = useCallback(async()=>{
    setLoading(true);setError(null);
    try{const d=await EdgarData.loadFilings();setFilings(d);}
    catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{load();},[load]);

  const [detail, setDetail] = useState(null);

  function drillSignal(s){setHlTick(s.ticker);setSelSig(s);setDetail({type:'signal',...s});setPage('signals');}
  function selectSignal(s){setSelSig(s);if(s){setHlTick(s.ticker);setDetail({type:'signal',...s});}else setDetail(null);}
  function openDetail(d){setDetail(d);}
  function closeDetail(){setDetail(null);setSelSig(null);}
  function panelNav(d){setDetail(d);}
  function navTo(p){setPage(p);setDetail(null);setSelSig(null);setHlTick(null);}

  const panelOpen = !!detail;

  return (
    <div className={`app-shell${panelOpen?' app-shell--panel-open':''}`}>
      <Sidebar page={page} setPage={navTo} dark={dark} setDark={setDark}/>
      <main className="main-area">
        <div className="content-area">
          {page==='dashboard'&&<DashboardPage filings={filings} loading={loading} onDrillSignal={drillSignal} onOpenDetail={openDetail} setPage={navTo}/>}
          {page==='signals'  &&<SignalsPage   filings={filings} loading={loading}
            highlightTicker={hlTicker} setHighlightTicker={setHlTick}
            onSelectSignal={selectSignal} selectedSignal={selSignal}
            onOpenDetail={openDetail}/>}
          {page==='data'     &&<DataPage onOpenDetail={openDetail}/>}
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
          <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onNavigate={panelNav}/>
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);