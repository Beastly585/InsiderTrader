// src/app.jsx
const { useState, useEffect, useMemo, useCallback } = React;
const cfg = window.APP_CONFIG;

// ── Utilities ──────────────────────────────────────────────────────────────────

const fmt = {
  number: n => n == null ? '—' : Number(n).toLocaleString(),
  money:  n => {
    if (n == null) return '—';
    const a = Math.abs(n);
    const s = n < 0 ? '-' : '';
    if (a >= 1_000_000_000) return `${s}$${(a/1_000_000_000).toFixed(1)}B`;
    if (a >= 1_000_000)     return `${s}$${(a/1_000_000).toFixed(1)}M`;
    if (a >= 1_000)         return `${s}$${(a/1_000).toFixed(0)}K`;
    return `${s}$${a.toFixed(0)}`;
  },
  price: n => n == null ? '—' : `$${parseFloat(n).toFixed(2)}`,
  date:  d => {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  },
  dateShort: d => {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'});
  },
  pct: n => n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(0)}%`,
};

// ── Theme ──────────────────────────────────────────────────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('theme'); if (s) return s === 'dark'; } catch(_){}
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch(_){}
  }, [dark]);
  return [dark, setDark];
}

// ── Small components ───────────────────────────────────────────────────────────
function Badge({ type, children }) {
  return <span className={`badge badge--${type}`}>{children}</span>;
}

function StatCard({ label, value, sub, color, mono }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ ...(color ? {color} : {}), ...(mono ? {fontFamily:'var(--font-mono)'} : {}) }}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SortTh({ label, colKey, sortCol, sortDir, onSort, right, title: ttl }) {
  const active = sortCol === colKey;
  return (
    <th onClick={() => onSort(colKey)}
        className={`th-sort${active?' th--active':''}${right?' th--right':''}`}
        title={ttl}>
      {label}{active ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function ConvictionBar({ score, max = 15 }) {
  const pct = Math.min((score / max) * 100, 100);
  const color = pct > 60 ? 'var(--green-600)' : pct > 30 ? 'var(--amber-600)' : 'var(--text-3)';
  return (
    <div className="conv-bar-wrap" title={`Conviction score: ${score.toFixed(1)}`}>
      <div className="conv-bar" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ── Filings row ────────────────────────────────────────────────────────────────
function FilingRow({ f }) {
  const txDate = f.transactionDate || f.date;
  const fileDate = f.date;
  const showFiledDate = fileDate && txDate && fileDate !== txDate;

  return (
    <tr className={`row-${f.transactionType}`}>
      <td className="td-date">
        <div className="td-date-main">{fmt.dateShort(txDate)}</div>
        {showFiledDate && <div className="td-date-sub">filed {fmt.dateShort(fileDate)}</div>}
      </td>
      <td><span className="ticker">{f.ticker || '—'}</span></td>
      <td className="td-company">
        <div className="td-overflow td-company-name" title={f.company}>{f.company}</div>
        <div className="td-sector-inline">{f.sector !== 'Other' ? f.sector : ''}</div>
      </td>
      <td className="td-insider">
        <div className="td-overflow" title={f.insiderName}>{f.insiderName}</div>
        <div className="td-muted td-overflow" title={f.title}>{f.title || '—'}</div>
      </td>
      <td>
        <Badge type={f.transactionType === 'buy' ? 'buy' : f.transactionType === 'sell' ? 'sell' : 'other'}>
          {f.transactionType === 'buy' ? '▲ Buy' : f.transactionType === 'sell' ? '▼ Sell' : '◆ Other'}
        </Badge>
        {f.transactionCode && (
          <div className="td-code" title={f.transactionCodeLabel}>{f.transactionCode}</div>
        )}
      </td>
      <td className="td-right td-mono">{fmt.number(f.shares)}</td>
      <td className="td-right td-mono">{fmt.price(f.price)}</td>
      <td className="td-right td-mono td-value-cell">
        <span className={f.transactionType === 'buy' ? 'val-buy' : f.transactionType === 'sell' ? 'val-sell' : ''}>
          {fmt.money(f.value)}
        </span>
      </td>
      <td><Badge type={`rel-${f.relationship}`}>{f.relLabel}</Badge></td>
      <td className="td-om">
        {f.isOpenMarket && <span className="om-dot" title="Open market transaction">●</span>}
      </td>
    </tr>
  );
}

// ── Signal row ─────────────────────────────────────────────────────────────────
function SignalRow({ s, rank, onClick, selected }) {
  const netDir = s.netValue > 0 ? 'buy' : s.netValue < 0 ? 'sell' : 'other';
  return (
    <tr className={`signal-row${selected ? ' signal-row--selected' : ''}`} onClick={() => onClick(s)}>
      <td className="td-rank">{rank}</td>
      <td><span className="ticker">{s.ticker}</span></td>
      <td className="td-company">
        <div className="td-overflow" title={s.company}>{s.company}</div>
        <div className="td-sector-inline">{s.sector !== 'Other' ? s.sector : ''}</div>
      </td>
      <td className="td-center">
        <span className="sig-count buy-count">{s.buys}</span>
        <span className="sig-sep"> / </span>
        <span className="sig-count sell-count">{s.sells}</span>
      </td>
      <td className="td-right td-mono">{fmt.money(s.buyValue)}</td>
      <td className="td-right td-mono">
        <span className={netDir === 'buy' ? 'val-buy' : netDir === 'sell' ? 'val-sell' : ''}>
          {s.netValue >= 0 ? '+' : ''}{fmt.money(s.netValue)}
        </span>
      </td>
      <td className="td-center">{s.cSuiteBuys > 0 ? <span className="csuite-badge">{s.cSuiteBuys} exec</span> : '—'}</td>
      <td className="td-center">{s.insiderCount}</td>
      <td className="td-date-main">{fmt.dateShort(s.lastTradeDate)}</td>
      <td style={{width:'100px'}}>
        <ConvictionBar score={s.conviction} />
      </td>
    </tr>
  );
}

// ── Signal detail panel ────────────────────────────────────────────────────────
function SignalDetail({ signal, onClose }) {
  if (!signal) return null;
  const trades = signal.trades.slice().sort((a,b) => (b.transactionDate||b.date).localeCompare(a.transactionDate||a.date));
  return (
    <div className="signal-detail">
      <div className="signal-detail__header">
        <div>
          <span className="ticker" style={{fontSize:'18px'}}>{signal.ticker}</span>
          <span className="signal-detail__co"> — {signal.company}</span>
        </div>
        <button className="btn btn--ghost" onClick={onClose}>✕</button>
      </div>
      <div className="signal-detail__stats">
        <div className="sd-stat"><span className="sd-label">Buys</span><span className="val-buy">{signal.buys}</span></div>
        <div className="sd-stat"><span className="sd-label">Sells</span><span className="val-sell">{signal.sells}</span></div>
        <div className="sd-stat"><span className="sd-label">Buy $</span><span>{fmt.money(signal.buyValue)}</span></div>
        <div className="sd-stat"><span className="sd-label">Exec Buys</span><span>{signal.cSuiteBuys}</span></div>
        <div className="sd-stat"><span className="sd-label">Insiders</span><span>{signal.insiderCount}</span></div>
      </div>
      <div className="signal-detail__trades">
        {trades.map((f, i) => (
          <div key={i} className={`sd-trade sd-trade--${f.transactionType}`}>
            <div className="sd-trade-left">
              <Badge type={f.transactionType === 'buy' ? 'buy' : f.transactionType === 'sell' ? 'sell' : 'other'}>
                {f.transactionType === 'buy' ? '▲' : '▼'}
              </Badge>
              <div>
                <div className="sd-trade-name">{f.insiderName}</div>
                <div className="td-muted" style={{fontSize:'11px'}}>{f.title}</div>
              </div>
            </div>
            <div className="sd-trade-right">
              <div className="td-mono">{fmt.money(f.value)}</div>
              <div className="td-muted" style={{fontSize:'11px'}}>{fmt.date(f.transactionDate||f.date)} · {f.transactionCode}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Date presets ───────────────────────────────────────────────────────────────
const DATE_PRESETS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1yr', days: 365 },
  { label: 'All', days: null },
];

// ── Main App ───────────────────────────────────────────────────────────────────
function App() {
  const [dark, setDark] = useTheme();
  const [filings, setFilings]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [updated, setUpdated]   = useState(null);
  const [tab, setTab]           = useState('filings'); // 'filings' | 'signals'
  const [selectedSignal, setSelectedSignal] = useState(null);

  // Filters (shared between tabs via date)
  const [search,  setSearch]    = useState('');
  const [typeF,   setTypeF]     = useState('');
  const [relF,    setRelF]      = useState('');
  const [sectorF, setSectorF]   = useState('');
  const [openMkt, setOpenMkt]   = useState(false);
  const [datePreset, setDatePreset] = useState(30);
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo,   setDateTo]       = useState('');

  // Sort
  const [sortCol, setSortCol]   = useState('transactionDate');
  const [sortDir, setSortDir]   = useState(-1);
  const [sigSort, setSigSort]   = useState('conviction');
  const [sigDir,  setSigDir]    = useState(-1);

  // Pagination
  const [page, setPage] = useState(0);
  const PAGE = cfg.PAGE_SIZE || 25;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await EdgarData.loadFilings();
      setFilings(data);
      setUpdated(new Date());
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sectors = useMemo(() =>
    [...new Set(filings.map(f => f.sector).filter(Boolean))].sort(), [filings]);

  const effectiveDateFrom = useMemo(() => {
    if (dateFrom) return dateFrom;
    if (datePreset === null) return '';
    const d = new Date(); d.setDate(d.getDate() - datePreset);
    return d.toISOString().split('T')[0];
  }, [dateFrom, datePreset]);

  // ── Filtered filings ───────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let out = filings.filter(f => {
      if (q && !`${f.ticker} ${f.insiderName} ${f.company}`.toLowerCase().includes(q)) return false;
      if (typeF   && f.transactionType !== typeF)   return false;
      if (relF    && f.relationship    !== relF)    return false;
      if (sectorF && f.sector          !== sectorF) return false;
      if (openMkt && !f.isOpenMarket)               return false;
      const tx = f.transactionDate || f.date;
      if (effectiveDateFrom && tx && tx < effectiveDateFrom) return false;
      if (dateTo            && tx && tx > dateTo)            return false;
      return true;
    });
    return [...out].sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (['shares','price','value','signal'].includes(sortCol)) { av = parseFloat(av)||0; bv = parseFloat(bv)||0; }
      if (av < bv) return  sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });
  }, [filings, search, typeF, relF, sectorF, openMkt, effectiveDateFrom, dateTo, sortCol, sortDir]);

  // ── Signals ────────────────────────────────────────────────────────────────
  const signals = useMemo(() => {
    // Use date-filtered filings for signals
    const base = filings.filter(f => {
      const tx = f.transactionDate || f.date;
      if (effectiveDateFrom && tx && tx < effectiveDateFrom) return false;
      if (dateTo            && tx && tx > dateTo)            return false;
      if (sectorF && f.sector !== sectorF) return false;
      return true;
    });
    const raw = EdgarData.computeSignals(base);
    return [...raw].sort((a, b) => {
      let av = a[sigSort], bv = b[sigSort];
      if (typeof av === 'number') { if (av < bv) return sigDir; if (av > bv) return -sigDir; }
      else { const r = String(av||'').localeCompare(String(bv||'')); return sigDir > 0 ? r : -r; }
      return 0;
    });
  }, [filings, effectiveDateFrom, dateTo, sectorF, sigSort, sigDir]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const buys  = filings.filter(f => f.transactionType === 'buy');
    const sells = filings.filter(f => f.transactionType === 'sell');
    const omBuys = filings.filter(f => f.isOpenMarket && f.transactionType === 'buy' && f.relationship === 'strong');
    return {
      total:   filings.length,
      buys:    buys.length,
      sells:   sells.length,
      buyVal:  buys.reduce((s,f) => s+(f.value||0), 0),
      sellVal: sells.reduce((s,f) => s+(f.value||0), 0),
      execBuys: omBuys.length,
      tickers: new Set(filings.map(f=>f.ticker).filter(Boolean)).size,
    };
  }, [filings]);

  const totalPages = Math.ceil(filtered.length / PAGE);
  const pageRows   = filtered.slice(page * PAGE, (page + 1) * PAGE);

  function onSort(col) {
    if (sortCol === col) setSortDir(d => -d);
    else { setSortCol(col); setSortDir(-1); }
    setPage(0);
  }
  function onSigSort(col) {
    if (sigSort === col) setSigDir(d => -d);
    else { setSigSort(col); setSigDir(-1); }
  }
  function onFilter(setter) { return e => { setter(e.target.value); setPage(0); }; }
  function setPreset(days) { setDatePreset(days); setDateFrom(''); setDateTo(''); setPage(0); }
  function clearFilters() { setSearch(''); setTypeF(''); setRelF(''); setSectorF(''); setOpenMkt(false); setPage(0); }
  const hasFilters = search || typeF || relF || sectorF || openMkt;

  const shp = { sortCol, sortDir, onSort };

  return (
    <div className="layout">

      {/* ── Header ── */}
      <header className="top-bar">
        <div className="top-bar__left">
          <div className="top-bar__logo">
            <div>
              <h1>Insider Trading Desk</h1>
              <p className="subtitle">
                {updated
                  ? `Updated ${updated.toLocaleTimeString()} · ${filings.length.toLocaleString()} filings`
                  : cfg.DATA_SOURCE === 'demo' ? 'Demo mode — set DATA_SOURCE in config.js' : 'Loading…'}
              </p>
            </div>
          </div>
        </div>
        <div className="top-bar__right">
          <button className="btn btn--ghost" onClick={() => setDark(d => !d)}>
            {dark ? '☀ Light' : '☾ Dark'}
          </button>
          <button className="btn btn--primary" onClick={load} disabled={loading}>
            {loading ? '↻ Loading…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {/* ── Stats row ── */}
      <div className="stats-row">
        <StatCard label="Total Filings"  value={loading ? '…' : stats.total.toLocaleString()} />
        <StatCard label="Buys"           value={loading ? '…' : stats.buys.toLocaleString()}
          sub={loading ? '' : fmt.money(stats.buyVal)} color="var(--green-600)" />
        <StatCard label="Sells"          value={loading ? '…' : stats.sells.toLocaleString()}
          sub={loading ? '' : fmt.money(stats.sellVal)} color="var(--red-600)" />
        <StatCard label="Exec Open Buys" value={loading ? '…' : stats.execBuys.toLocaleString()}
          sub="C-suite, open market" color="var(--blue-600)" />
        <StatCard label="Tickers"        value={loading ? '…' : stats.tickers.toLocaleString()} />
      </div>

      {/* ── Date bar ── */}
      <div className="date-row">
        <span className="date-row__label">Period:</span>
        <div className="date-pills">
          {DATE_PRESETS.map(p => (
            <button key={p.label}
              className={`pill${datePreset === p.days && !dateFrom ? ' pill--active' : ''}`}
              onClick={() => setPreset(p.days)}>{p.label}</button>
          ))}
        </div>
        <span className="date-row__sep">|</span>
        <span className="date-row__label">Custom:</span>
        <input type="date" value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setDatePreset(null); setPage(0); }} />
        <span className="date-row__label">→</span>
        <input type="date" value={dateTo}
          onChange={e => { setDateTo(e.target.value); setDatePreset(null); setPage(0); }} />
      </div>

      {/* ── Tabs ── */}
      <div className="tabs">
        <button className={`tab${tab === 'filings' ? ' tab--active' : ''}`}
          onClick={() => setTab('filings')}>
          Filings
          {!loading && <span className="tab-count">{filtered.length.toLocaleString()}</span>}
        </button>
        <button className={`tab${tab === 'signals' ? ' tab--active' : ''}`}
          onClick={() => { setTab('signals'); setSelectedSignal(null); }}>
          Signals
          {!loading && <span className="tab-count">{signals.length}</span>}
        </button>
      </div>

      {/* ── Filings tab ── */}
      {tab === 'filings' && (
        <>
          <div className="filters">
            <div className="search-wrap">
              <span className="search-icon">⌕</span>
              <input type="search" placeholder="Ticker, insider, company…"
                value={search} onChange={onFilter(setSearch)} />
            </div>
            <select value={typeF} onChange={onFilter(setTypeF)}>
              <option value="">All types</option>
              <option value="buy">▲ Buy</option>
              <option value="sell">▼ Sell</option>
              <option value="other">◆ Other</option>
            </select>
            <select value={relF} onChange={onFilter(setRelF)}>
              <option value="">All roles</option>
              <option value="strong">C-Suite</option>
              <option value="medium">Officer</option>
              <option value="weak">Director</option>
            </select>
            <select value={sectorF} onChange={onFilter(setSectorF)}>
              <option value="">All sectors</option>
              {sectors.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="filter-toggle">
              <input type="checkbox" checked={openMkt} onChange={e => { setOpenMkt(e.target.checked); setPage(0); }} />
              Open market only
            </label>
            {hasFilters && (
              <button className="btn btn--ghost" onClick={clearFilters}>✕ Clear</button>
            )}
          </div>

          {error ? (
            <div className="state-box state-box--error">
              <div>⚠</div><p>{error}</p>
              <button className="btn btn--primary" onClick={load}>Retry</button>
            </div>
          ) : loading ? (
            <div className="state-box"><div className="spinner"/><p>Fetching filings…</p></div>
          ) : filtered.length === 0 ? (
            <div className="state-box"><div>◎</div><p>No filings match your filters.</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Trade Date"   colKey="transactionDate" {...shp} title="Date of the actual transaction" />
                    <SortTh label="Ticker"       colKey="ticker"          {...shp} />
                    <SortTh label="Company"      colKey="company"         {...shp} />
                    <SortTh label="Insider"      colKey="insiderName"     {...shp} />
                    <SortTh label="Type"         colKey="transactionType" {...shp} />
                    <SortTh label="Shares"       colKey="shares"          {...shp} right />
                    <SortTh label="Price"        colKey="price"           {...shp} right />
                    <SortTh label="Value"        colKey="value"           {...shp} right />
                    <SortTh label="Role"         colKey="relationship"    {...shp} />
                    <th title="Open market transaction (P or S code) — highest signal">OM</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((f, i) => <FilingRow key={`${f.accessionNumber}-${i}`} f={f} />)}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && totalPages > 1 && (
            <div className="pagination">
              <span className="pagination__info">
                {page*PAGE+1}–{Math.min((page+1)*PAGE, filtered.length)} of {filtered.length.toLocaleString()}
              </span>
              <div className="pagination__btns">
                <button className="btn" onClick={() => setPage(0)}        disabled={page === 0}>««</button>
                <button className="btn" onClick={() => setPage(p=>p-1)}   disabled={page === 0}>‹</button>
                <span className="pagination__counter">{page+1}/{totalPages}</span>
                <button className="btn" onClick={() => setPage(p=>p+1)}   disabled={page >= totalPages-1}>›</button>
                <button className="btn" onClick={() => setPage(totalPages-1)} disabled={page >= totalPages-1}>»»</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Signals tab ── */}
      {tab === 'signals' && (
        <div className="signals-layout">
          <div className={`signals-table-wrap${selectedSignal ? ' signals-table-wrap--narrow' : ''}`}>
            <div className="signals-hint">
              Ranked by conviction score — C-suite open-market buys weighted highest. Click a row to see all trades.
            </div>
            {loading ? (
              <div className="state-box"><div className="spinner"/><p>Computing signals…</p></div>
            ) : signals.length === 0 ? (
              <div className="state-box"><div>◎</div><p>No signals in this period.</p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <SortTh label="Ticker"       colKey="ticker"       sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} />
                      <SortTh label="Company"      colKey="company"      sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} />
                      <th title="Buys / Sells">B/S</th>
                      <SortTh label="Buy $"        colKey="buyValue"     sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} right />
                      <SortTh label="Net $"        colKey="netValue"     sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} right
                        title="Buy value minus sell value in this period" />
                      <SortTh label="Exec Buys"    colKey="cSuiteBuys"   sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} />
                      <SortTh label="# Insiders"   colKey="insiderCount" sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} />
                      <SortTh label="Last Trade"   colKey="lastTradeDate" sortCol={sigSort} sortDir={sigDir} onSort={onSigSort} />
                      <SortTh label="Conviction"   colKey="conviction"   sortCol={sigSort} sortDir={sigDir} onSort={onSigSort}
                        title="Weighted score: C-suite open-market buys + value + count" />
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((s, i) => (
                      <SignalRow key={s.ticker} s={s} rank={i+1}
                        selected={selectedSignal?.ticker === s.ticker}
                        onClick={setSelectedSignal} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {selectedSignal && (
            <SignalDetail signal={selectedSignal} onClose={() => setSelectedSignal(null)} />
          )}
        </div>
      )}

      <footer className="footer">
        Data: <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4" target="_blank" rel="noreferrer">SEC EDGAR Form 4</a>
        {' · '}Not financial advice.
        {cfg.DATA_SOURCE === 'demo' && ' · Demo mode.'}
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
