// ─────────────────────────────────────────────────────────────────────────────
// app.jsx  — React UI for SEC Form 4 Insider Trading Tracker
// ─────────────────────────────────────────────────────────────────────────────

const { useState, useEffect, useMemo, useCallback } = React;
const cfg = window.APP_CONFIG;

// ── Utility ──────────────────────────────────────────────────────────────────

function fmtNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}
function fmtMoney(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : {}}>{value}</div>
    </div>
  );
}

function Badge({ type, children }) {
  return <span className={`badge badge--${type}`}>{children}</span>;
}

function SortableHeader({ label, colKey, sortCol, sortDir, onSort }) {
  const active = sortCol === colKey;
  return (
    <th onClick={() => onSort(colKey)} className={active ? 'th--active' : ''}>
      {label}
      {active && <span className="sort-arrow">{sortDir > 0 ? ' ↑' : ' ↓'}</span>}
    </th>
  );
}

function FilingRow({ filing }) {
  const { date, ticker, company, insiderName, title, transactionType,
          shares, price, value, sector, relationship, relLabel } = filing;
  return (
    <tr>
      <td className="td-date">{date}</td>
      <td><span className="ticker">{ticker || '—'}</span></td>
      <td className="td-overflow" title={company}>{company}</td>
      <td className="td-overflow" title={insiderName}>{insiderName}</td>
      <td className="td-overflow td-muted" title={title}>{title || '—'}</td>
      <td>
        <Badge type={transactionType === 'buy' ? 'buy' : 'sell'}>
          {transactionType === 'buy' ? '▲ Buy' : '▼ Sell'}
        </Badge>
      </td>
      <td className="td-mono">{fmtNumber(shares)}</td>
      <td className="td-mono">${parseFloat(price || 0).toFixed(2)}</td>
      <td className="td-mono">{fmtMoney(value)}</td>
      <td className="td-sector">{sector}</td>
      <td><Badge type={`rel-${relationship}`}>{relLabel}</Badge></td>
    </tr>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  const [filings, setFilings]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [lastUpdated, setUpdated] = useState(null);

  // Filters
  const [search, setSearch]   = useState('');
  const [typeF,  setTypeF]    = useState('');
  const [relF,   setRelF]     = useState('');
  const [sectorF,setSectorF]  = useState('');

  // Sort
  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState(-1);

  // Pagination
  const [page, setPage] = useState(0);
  const PAGE = cfg.PAGE_SIZE || 25;

  // ── Load data ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await EdgarData.loadFilings();
      setFilings(data);
      setUpdated(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived sectors for filter dropdown ──────────────────────────────────
  const sectors = useMemo(() =>
    [...new Set(filings.map(f => f.sector))].sort(), [filings]);

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let out = filings.filter(f => {
      if (q && !`${f.ticker} ${f.insiderName} ${f.company}`.toLowerCase().includes(q)) return false;
      if (typeF   && f.transactionType !== typeF)   return false;
      if (relF    && f.relationship    !== relF)    return false;
      if (sectorF && f.sector          !== sectorF) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (['shares','price','value'].includes(sortCol)) {
        av = parseFloat(av) || 0; bv = parseFloat(bv) || 0;
      }
      if (av < bv) return  sortDir;
      if (av > bv) return -sortDir;
      return 0;
    });
    return out;
  }, [filings, search, typeF, relF, sectorF, sortCol, sortDir]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:   filings.length,
    buys:    filings.filter(f => f.transactionType === 'buy').length,
    sells:   filings.filter(f => f.transactionType === 'sell').length,
    tickers: new Set(filings.map(f => f.ticker).filter(Boolean)).size,
  }), [filings]);

  // ── Paged rows ────────────────────────────────────────────────────────────
  const totalPages = Math.ceil(filtered.length / PAGE);
  const pageRows   = filtered.slice(page * PAGE, (page + 1) * PAGE);

  function onSort(col) {
    if (sortCol === col) setSortDir(d => -d);
    else { setSortCol(col); setSortDir(-1); }
    setPage(0);
  }

  function onFilterChange(setter) {
    return e => { setter(e.target.value); setPage(0); };
  }

  const sharedHeaderProps = { sortCol, sortDir, onSort };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="layout">
      <header className="top-bar">
        <div className="top-bar__title">
          <span className="top-bar__icon">
            <i className="ti ti-report-money" aria-hidden="true"></i>
          </span>
          <div>
            <h1>SEC Form 4 — Insider Trading</h1>
            <p className="subtitle">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · ${filings.length} filings`
                : cfg.DATA_SOURCE === 'demo'
                  ? 'Demo mode — edit src/config.js to connect live data'
                  : 'Loading…'}
            </p>
          </div>
        </div>
        <button className="btn btn--refresh" onClick={load} disabled={loading}>
          <i className={`ti ti-refresh${loading ? ' spin' : ''}`} aria-hidden="true"></i>
          {loading ? ' Loading…' : ' Refresh'}
        </button>
      </header>

      {/* Stats */}
      <div className="stats-row">
        <StatCard label="Filings"        value={loading ? '…' : stats.total} />
        <StatCard label="Buys"           value={loading ? '…' : stats.buys}  color="var(--green-700)" />
        <StatCard label="Sells"          value={loading ? '…' : stats.sells} color="var(--red-700)" />
        <StatCard label="Unique tickers" value={loading ? '…' : stats.tickers} />
      </div>

      {/* Filters */}
      <div className="filters">
        <div className="search-wrap">
          <i className="ti ti-search" aria-hidden="true"></i>
          <input
            type="search"
            placeholder="Ticker, name, company…"
            value={search}
            onChange={onFilterChange(setSearch)}
            aria-label="Search filings"
          />
        </div>

        <select value={typeF} onChange={onFilterChange(setTypeF)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="buy">Buy / Acquisition</option>
          <option value="sell">Sell / Disposition</option>
        </select>

        <select value={relF} onChange={onFilterChange(setRelF)} aria-label="Filter by relationship">
          <option value="">All relationships</option>
          <option value="strong">Strong — Insider (C-suite)</option>
          <option value="medium">Medium — Officer (SVP/EVP)</option>
          <option value="weak">Weak — Director / 10%</option>
        </select>

        <select value={sectorF} onChange={onFilterChange(setSectorF)} aria-label="Filter by sector">
          <option value="">All sectors</option>
          {sectors.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      {error ? (
        <div className="state-box state-box--error">
          <i className="ti ti-alert-circle" aria-hidden="true"></i>
          <p>{error}</p>
          <button className="btn" onClick={load}>Retry</button>
        </div>
      ) : loading ? (
        <div className="state-box">
          <i className="ti ti-loader spin" aria-hidden="true"></i>
          <p>Fetching filings…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="state-box">
          <i className="ti ti-inbox" aria-hidden="true"></i>
          <p>No filings match your filters.</p>
        </div>
      ) : (
        <div className="table-wrap" role="region" aria-label="Insider trading filings">
          <table>
            <thead>
              <tr>
                <SortableHeader label="Date"         colKey="date"            {...sharedHeaderProps} />
                <SortableHeader label="Ticker"       colKey="ticker"          {...sharedHeaderProps} />
                <SortableHeader label="Company"      colKey="company"         {...sharedHeaderProps} />
                <SortableHeader label="Insider"      colKey="insiderName"     {...sharedHeaderProps} />
                <SortableHeader label="Title"        colKey="title"           {...sharedHeaderProps} />
                <SortableHeader label="Type"         colKey="transactionType" {...sharedHeaderProps} />
                <SortableHeader label="Shares"       colKey="shares"          {...sharedHeaderProps} />
                <SortableHeader label="Price"        colKey="price"           {...sharedHeaderProps} />
                <SortableHeader label="Value"        colKey="value"           {...sharedHeaderProps} />
                <SortableHeader label="Sector"       colKey="sector"          {...sharedHeaderProps} />
                <SortableHeader label="Relationship" colKey="relationship"    {...sharedHeaderProps} />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((f, i) => <FilingRow key={`${f.date}-${f.insiderName}-${i}`} filing={f} />)}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && !error && totalPages > 1 && (
        <div className="pagination">
          <span className="pagination__info">
            Showing {page * PAGE + 1}–{Math.min((page + 1) * PAGE, filtered.length)} of {filtered.length}
          </span>
          <div className="pagination__btns">
            <button className="btn" onClick={() => setPage(p => p - 1)} disabled={page === 0}>← Prev</button>
            <span className="pagination__counter">{page + 1} / {totalPages}</span>
            <button className="btn" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>Next →</button>
          </div>
        </div>
      )}

      <footer className="footer">
        Data from <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4&dateb=&owner=include&count=40" target="_blank" rel="noreferrer">SEC EDGAR</a>.
        Not financial advice.
        {cfg.DATA_SOURCE === 'demo' && ' · Demo mode — see README to connect live data.'}
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
