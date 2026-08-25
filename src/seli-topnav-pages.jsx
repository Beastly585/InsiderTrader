// ─── seli-topnav-pages.jsx ────────────────────────────────────────────────────
// Drop-in replacement for the Sidebar + status bar + HomePage + DashboardPage.
// Adds: TopNav, redesigned HomePage, redesigned DataPage, new InsidersPage.
// Integrates with the existing data layer (loadFilings, buildSignals,
// processLeaderboardRows, queryNeon, LEADERBOARD_QUERY, fmt, etc.) exactly
// as the current pages do — nothing in edgar.js, scoring.js, or format.js changes.
//
// HOW TO USE:
//   1. Paste this block into app.jsx, replacing the Sidebar function and the
//      existing HomePage / DashboardPage functions.
//   2. In AppInner's return, replace <Sidebar .../> with <TopNav .../> and
//      remove the .app-shell / .main-area wrappers (see AppInner patch below).
//   3. Add the new CSS block from seli-topnav.css into style.css.
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// TOP NAV
// ══════════════════════════════════════════════════════════════════════════════
function TopNav({ page, setPage, dark, setDark, user, onUpgrade, lastFilingDate, isDataStale, loading }) {
  const pro = isPro(user);
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);

  const NAV_LINKS = [
    { id: 'home',     label: 'Home',     Icon: IconHome },
    { id: 'data',     label: 'Data',     Icon: IconData },
    { id: 'signals',  label: 'Insiders', Icon: IconInsights },
  ];

  function nav(id) { setPage(id); setMenuOpen(false); }

  // Mobile bottom bar
  if (isMobile) {
    return (
      <>
        {/* Slim top bar — logo + data freshness + avatar */}
        <header className="topnav">
          <div className="topnav__logo" onClick={() => nav('home')}>
            <div className="topnav__mark">
              <img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </div>
            <span className="topnav__wordmark">Seli</span>
            <span className="topnav__beta">BETA</span>
          </div>
          <div className="topnav__right">
            {lastFilingDate && (
              <span className={`topnav__freshness${isDataStale ? ' topnav__freshness--stale' : ''}`}>
                <span className="topnav__dot" style={isDataStale ? { background: 'var(--amber-600)' } : {}} />
                {fmt.dateShort(lastFilingDate)}
              </span>
            )}
            <button className="topnav__icon-btn" onClick={() => setDark(d => !d)} aria-label="Toggle theme">
              {dark ? <IconSun style={{ width: 16, height: 16 }} /> : <IconMoon style={{ width: 16, height: 16 }} />}
            </button>
            <SignedIn>
              <UserButton afterSignOutUrl="/"
                appearance={{ elements: { avatarBox: 'clerk-avatar', userButtonTrigger: 'clerk-avatar-trigger', userButtonAvatarBox: 'clerk-avatar-box' } }} />
            </SignedIn>
          </div>
        </header>

        {/* Bottom tab bar */}
        <nav className="bottomnav">
          {NAV_LINKS.map(n => (
            <button key={n.id} className={`bottomnav__btn${page === n.id ? ' bottomnav__btn--active' : ''}`} onClick={() => nav(n.id)} aria-label={n.label}>
              <n.Icon style={{ width: 20, height: 20 }} />
              <span className="bottomnav__label">{n.label}</span>
            </button>
          ))}
          <button className={`bottomnav__btn${page === 'settings' ? ' bottomnav__btn--active' : ''}`} onClick={() => nav('settings')} aria-label="Settings">
            <IconSettings style={{ width: 20, height: 20 }} />
            <span className="bottomnav__label">Settings</span>
          </button>
        </nav>
      </>
    );
  }

  // Desktop top bar
  return (
    <header className="topnav">
      <div className="topnav__logo" onClick={() => nav('home')}>
        <div className="topnav__mark">
          <img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <span className="topnav__wordmark">Seli</span>
        <span className="topnav__beta">BETA</span>
      </div>

      <nav className="topnav__links">
        {NAV_LINKS.map(n => (
          <button key={n.id} className={`topnav__link${page === n.id ? ' topnav__link--active' : ''}`} onClick={() => nav(n.id)}>
            <n.Icon style={{ width: 14, height: 14 }} />
            {n.label}
          </button>
        ))}
      </nav>

      <div className="topnav__right">
        {/* Data freshness */}
        {lastFilingDate && (
          <span className={`topnav__freshness${isDataStale ? ' topnav__freshness--stale' : ''}`} title={`Data through ${lastFilingDate}`}>
            <span className="topnav__dot" style={isDataStale ? { background: 'var(--amber-600)' } : {}} />
            {isDataStale ? `Stale · ${fmt.dateShort(lastFilingDate)}` : `Through ${fmt.dateShort(lastFilingDate)}`}
          </span>
        )}
        {loading && !lastFilingDate && (
          <span className="topnav__freshness"><span className="topnav__dot" />Syncing…</span>
        )}

        <FeedbackButton page={page} />

        <button className="topnav__icon-btn" onClick={() => setDark(d => !d)} aria-label="Toggle theme" title={dark ? 'Light mode' : 'Dark mode'}>
          {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
        </button>

        {!pro && (
          <button className="topnav__upgrade" onClick={() => onUpgrade('default')}>
            Upgrade → $6.99
          </button>
        )}

        <button className={`topnav__icon-btn${page === 'settings' ? ' topnav__icon-btn--active' : ''}`} onClick={() => nav('settings')} aria-label="Settings" title="Settings">
          <IconSettings style={{ width: 15, height: 15 }} />
        </button>

        <SignedIn>
          <UserButton afterSignOutUrl="/"
            appearance={{ elements: { avatarBox: 'clerk-avatar', userButtonTrigger: 'clerk-avatar-trigger', userButtonAvatarBox: 'clerk-avatar-box' } }} />
        </SignedIn>
        <SignedOut>
          <SignInButton mode="modal">
            <button className="topnav__upgrade">Sign in</button>
          </SignInButton>
        </SignedOut>
      </div>
    </header>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SHARED PRIMITIVES
// ══════════════════════════════════════════════════════════════════════════════

// Tile wrapper
function Tile({ children, style, className = '' }) {
  return (
    <div className={`ws-tile ${className}`} style={style}>{children}</div>
  );
}
function TileHdr({ title, sub, count, action, actionLabel = 'See all' }) {
  return (
    <div className="ws-tile__hdr">
      <div className="ws-tile__hdr-left">
        <span className="ws-tile__title">{title}</span>
        {sub && <span className="ws-tile__sub">{sub}</span>}
        {count != null && <span className="ws-tile__count">{count}</span>}
      </div>
      {action && (
        <button className="ws-tile__action" onClick={action}>{actionLabel} →</button>
      )}
    </div>
  );
}

// Conviction bar — reuses the real ConvictionBar component from app.jsx
// (already defined there; this wrapper just matches our layout needs)
function MiniConvBar({ score, max = 15 }) {
  const pct = Math.min(100, (score / max) * 100);
  const color = pct >= 70 ? 'var(--green-600)' : pct >= 45 ? 'var(--amber-600)' : 'var(--text-3)';
  return (
    <div className="ws-convbar">
      <div className="ws-convbar__track">
        <div className="ws-convbar__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="ws-convbar__label" style={{ color }}>{score}/{max}</span>
    </div>
  );
}

// Relationship badge
function RelBadge({ rel, small }) {
  const cfgMap = {
    strong: { label: 'C-Suite', cls: 'badge badge--rel-strong' },
    medium: { label: 'Officer', cls: 'badge badge--rel-medium' },
    congress: { label: 'Congress', cls: 'badge badge--congress' },
    weak: { label: 'Director', cls: 'badge badge--rel-weak' },
  };
  const c = cfgMap[rel] || cfgMap.weak;
  return <span className={c.cls} style={small ? { fontSize: 10, padding: '1px 5px' } : {}}>{c.label}</span>;
}

// Stat card
function StatCard({ label, value, sub, color, onClick }) {
  return (
    <div className={`ws-stat${onClick ? ' ws-stat--clickable' : ''}`} onClick={onClick}>
      <div className="ws-stat__label">{label}</div>
      <div className="ws-stat__value" style={color ? { color } : {}}>{value}</div>
      {sub && <div className="ws-stat__sub">{sub}</div>}
    </div>
  );
}

// Pills filter
function PillFilter({ options, value, onChange }) {
  return (
    <div className="ws-pills">
      {options.map(o => (
        <button key={o.value ?? o.label} className={`ws-pill${value === (o.value ?? o.label) ? ' ws-pill--active' : ''}`} onClick={() => onChange(o.value ?? o.label)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Search input
function SearchBox({ value, onChange, placeholder = 'Search…', style }) {
  return (
    <div className="ws-search" style={style}>
      <IconData style={{ width: 13, height: 13, position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', pointerEvents: 'none' }} />
      <IconInsights style={{ width: 0, height: 0, display: 'none' }} />
      {/* Use a plain magnifier via unicode since we can't inline SVG inside input */}
      <span className="ws-search__icon">⌕</span>
      <input
        className="ws-search__input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button className="ws-search__clear" onClick={() => onChange('')} aria-label="Clear">×</button>
      )}
    </div>
  );
}

// Sortable TH
function SortHeader({ label, col, sortCol, sortDir, onSort, right }) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`ws-th ws-th--sort${active ? ' ws-th--active' : ''}${right ? ' ws-th--right' : ''}`}
    >
      {label}{active ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

// Skeleton rows
function WsSkeleton({ count = 6 }) {
  return (
    <div className="skel-wrap">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skel-row" style={{ animationDelay: `${i * 60}ms` }}>
          <span className="skel-bar skel-bar--sm" />
          <span className="skel-bar skel-bar--lg" />
          <span className="skel-bar skel-bar--md" />
        </div>
      ))}
    </div>
  );
}

// Sector insider-flow heatmap computed from real filings
function InsiderFlowHeatmap({ filings }) {
  const SECTORS = ['Technology', 'Finance', 'Healthcare', 'Energy', 'Consumer Discretionary', 'Consumer Staples', 'Industrials', 'Real Estate', 'Utilities', 'Materials', 'Communication Services'];
  const SHORT = { 'Technology': 'Tech', 'Finance': 'Finance', 'Healthcare': 'Health', 'Energy': 'Energy', 'Consumer Discretionary': 'Disc.', 'Consumer Staples': 'Staples', 'Industrials': 'Indust.', 'Real Estate': 'Real Est.', 'Utilities': 'Utilities', 'Materials': 'Materials', 'Communication Services': 'Comms' };

  const sectorFlow = useMemo(() => {
    const cut = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0]; })();
    const map = {};
    for (const f of filings) {
      if (!f.isOpenMarket) continue;
      const dt = f.transactionDate || f.date || '';
      if (dt < cut) continue;
      const s = f.sector || 'Other';
      if (!map[s]) map[s] = { buy: 0, sell: 0 };
      if (f.transactionType === 'buy') map[s].buy += f.value || 0;
      else if (f.transactionType === 'sell') map[s].sell += f.value || 0;
    }
    return map;
  }, [filings]);

  const rows = SECTORS.map(s => {
    const d = sectorFlow[s] || { buy: 0, sell: 0 };
    const net = d.buy - d.sell;
    const total = d.buy + d.sell;
    const ratio = total > 0 ? d.buy / total : 0.5;
    return { sector: s, short: SHORT[s] || s, net, ratio };
  }).filter(r => r.net !== 0).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 8);

  if (!rows.length) {
    return <div className="ws-empty" style={{ padding: '20px 0', fontSize: 12, textAlign: 'center' }}>Sector flow data loading…</div>;
  }

  return (
    <div className="ws-heatmap">
      {rows.map(r => {
        const bull = r.net >= 0;
        const intensity = Math.min(0.88, Math.abs(r.ratio - 0.5) * 2.2);
        const bg = bull
          ? `rgba(62,207,142,${0.08 + intensity * 0.28})`
          : `rgba(240,96,96,${0.08 + intensity * 0.28})`;
        return (
          <div key={r.sector} className="ws-heatmap-sq" style={{ background: bg }}>
            <div className="ws-heatmap-sq__name">{r.short}</div>
            <div className="ws-heatmap-sq__val" style={{ color: bull ? 'var(--green-600)' : 'var(--red-600)' }}>
              {bull ? '+' : ''}{fmt.money(r.net)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HOME PAGE (replaces both HomePage + DashboardPage)
// ══════════════════════════════════════════════════════════════════════════════
function WebHomePage({ filings, loading, watchlist, user, onOpenDetail, onSeeAll, onUpgrade }) {
  const pro = isPro(user);
  const isMobile = useIsMobile();
  const [sigDays, setSigDays] = useState(7);

  const cutoff = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - sigDays); return d.toISOString().split('T')[0];
  }, [sigDays]);

  // Build signals from real data exactly as DashboardPage does
  const signals = useMemo(() => {
    const base = filings.filter(f =>
      f.isOpenMarket && f.transactionType === 'buy' &&
      (f.transactionDate || f.date || '') >= cutoff
    );
    return buildSignals(base)
      .filter(s => s.direction !== 'sell' ? (s.netValue >= 100_000 || s.cSuiteBuys >= 1) : s.sellValue >= 50_000)
      .sort((a, b) => b.conviction - a.conviction)
      .slice(0, 12);
  }, [filings, cutoff]);

  // Summary stats from real filings
  const stats = useMemo(() => {
    const cut30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0]; })();
    const recent = filings.filter(f => f.isOpenMarket && (f.transactionDate || f.date || '') >= cut30);
    const buyVal = recent.filter(f => f.transactionType === 'buy').reduce((s, f) => s + (f.value || 0), 0);
    const buyCnt = recent.filter(f => f.transactionType === 'buy').length;
    const highConv = signals.filter(s => s.conviction >= 10).length;
    const csuiteCount = signals.reduce((n, s) => n + (s.cSuiteBuys || 0), 0);
    return { buyVal, buyCnt, highConv, csuiteCount };
  }, [filings, signals]);

  // Recent raw filings for news-feed panel
  const recentFilings = useMemo(() => {
    return [...filings]
      .filter(f => f.isOpenMarket)
      .sort((a, b) => (b.transactionDate || b.date || '') > (a.transactionDate || a.date || '') ? 1 : -1)
      .slice(0, 8);
  }, [filings]);

  return (
    <div className="ws-page">
      {/* Stat strip */}
      <div className="ws-stat-strip">
        <StatCard label="Net buy value · 30d" value={fmt.money(stats.buyVal)} sub={`${stats.buyCnt} transactions`} color="var(--green-600)" />
        <StatCard label="High-conviction signals" value={loading ? '—' : stats.highConv} sub="Score ≥10/15" />
        <StatCard label="C-Suite buyers" value={loading ? '—' : stats.csuiteCount} sub="Open market, window" />
        <StatCard label="Sectors with net buying" value={loading ? '—' : signals.reduce((s, sig) => s.add(sig.sector), new Set()).size} sub="30d insider flow" />
      </div>

      {/* Market context strip */}
      <div style={{ marginBottom: 16 }}>
        <SentimentStrip filings={filings} />
      </div>

      {/* Main grid */}
      <div className={`ws-home-grid${isMobile ? ' ws-home-grid--mobile' : ''}`}>

        {/* LEFT: signals feed */}
        <div className="ws-home-left">
          <Tile>
            <TileHdr
              title="Insider signals"
              count={loading ? null : signals.length}
              sub="Scored by conviction"
              action={() => onSeeAll('signals')}
            />
            <div className="ws-tile__filters">
              <PillFilter
                options={[
                  { label: '1d', value: 1 }, { label: '3d', value: 3 },
                  { label: '7d', value: 7 }, { label: '30d', value: 30 },
                ]}
                value={sigDays}
                onChange={v => {
                  setSigDays(Number(v));
                  if (Number(v) > 7 && !pro) { onUpgrade('full_history'); }
                }}
              />
            </div>

            {loading ? <WsSkeleton count={8} /> : signals.length === 0 ? (
              <div className="ws-empty">
                No signals in this window — try widening the date range.
                Form 4s are typically filed 1–2 days after transactions.
              </div>
            ) : (
              <div>
                {signals.map((s, i) => {
                  const isBuy = s.direction !== 'sell';
                  const hasReversal = detectReversalForTicker(s.ticker, filings);
                  return (
                    <div key={s.ticker} className="ws-sig-row" onClick={() => onOpenDetail({ type: 'signal', ...s })}>
                      <div className="ws-sig-row__left">
                        <div className="ws-sig-row__top">
                          <span className="ws-ticker">{s.ticker}</span>
                          <RelBadge rel={s.isPolitical ? 'congress' : s.relationship} small />
                          {s.cSuiteBuys > 0 && (
                            <span className="badge badge--exec">{s.cSuiteBuys} exec</span>
                          )}
                          {hasReversal && (
                            <span className="reversal-badge">
                              <IconReversal className="reversal-badge__icon" />reversal
                            </span>
                          )}
                          <StarBtn ticker={s.ticker} watchlist={watchlist} />
                        </div>
                        <div className="ws-sig-row__company">{s.company}</div>
                        <div className="ws-sig-row__meta">
                          {s.insiderCount} insider{s.insiderCount !== 1 ? 's' : ''}
                          {s.cSuiteBuys > 0 ? ` · ${s.cSuiteBuys} exec buy${s.cSuiteBuys !== 1 ? 's' : ''}` : ''}
                          {' · '}{fmt.ago(s.lastTradeDate)}
                          {' · '}{s.sector}
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <MiniConvBar score={s.conviction} max={15} />
                        </div>
                      </div>
                      <div className="ws-sig-row__right">
                        <div className={`ws-sig-row__val${isBuy ? ' val-buy' : ' val-sell'}`}>
                          {isBuy ? '+' : ''}{fmt.money(s.netValue)}
                        </div>
                        <div className="ws-sig-row__dir">
                          {isBuy ? '▲ Net buying' : '▼ Net selling'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="ws-tile__footer">
              <button className="ws-tile__see-all-btn" onClick={() => onSeeAll('signals')}>
                View all signals with full filters →
              </button>
            </div>
          </Tile>
        </div>

        {/* RIGHT: sidebar panels */}
        <div className="ws-home-right">

          {/* Sector flow heatmap */}
          {!isMobile && (
            <Tile style={{ marginBottom: 14 }}>
              <TileHdr title="Sector flow" sub="Insider net buys · 30d" />
              <div className="ws-tile__body">
                {loading ? <WsSkeleton count={3} /> : <InsiderFlowHeatmap filings={filings} />}
              </div>
            </Tile>
          )}

          {/* Market heatmap */}
          {!isMobile && (
            <Tile style={{ marginBottom: 14 }}>
              <div className="ws-tile__body">
                <HeatmapOnly />
              </div>
            </Tile>
          )}

          {/* Recent filings feed */}
          <Tile>
            <TileHdr title="Recent filings" sub="Open-market trades" action={() => onSeeAll('data')} />
            <div>
              {loading ? <WsSkeleton count={6} /> : recentFilings.map((f, i) => {
                const isBuy = f.transactionType === 'buy';
                return (
                  <div key={i} className="ws-filing-row" onClick={() => onOpenDetail({ type: 'ticker', ticker: f.ticker, company: f.company })}>
                    <div className="ws-filing-row__bar" style={{ background: isBuy ? 'var(--green-600)' : 'var(--red-600)' }} />
                    <div className="ws-filing-row__body">
                      <div className="ws-filing-row__top">
                        <span className="ws-ticker">{f.ticker}</span>
                        <span className={`ws-filing-row__type${isBuy ? ' val-buy' : ' val-sell'}`}>
                          {isBuy ? '▲ Buy' : '▼ Sell'}
                        </span>
                        <span className="ws-filing-row__val" style={{ color: isBuy ? 'var(--green-600)' : 'var(--red-600)' }}>
                          {fmt.money(f.value)}
                        </span>
                      </div>
                      <div className="ws-filing-row__meta">
                        {f.insiderName} · {f.title ? f.title.split(' ').slice(0, 3).join(' ') : ''} · {fmt.ago(f.transactionDate || f.date)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Tile>

          {/* Top insiders sidebar preview */}
          <Tile style={{ marginTop: 14 }}>
            <TileHdr title="Top insiders" sub="By composite score" action={() => onSeeAll('signals')} actionLabel="Full leaderboard" />
            <div className="ws-tile__body">
              <InsiderLeaderboardSidebar onOpenDetail={onOpenDetail} watchlist={watchlist} pro={pro} />
            </div>
          </Tile>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA PAGE — unified signals + raw filings, deep filters + deep-dive panel
// ══════════════════════════════════════════════════════════════════════════════
function WebDataPage({ filings, loading, onOpenDetail, portfolioTickers, user, onUpgrade, ensureFilingsWindow }) {
  const pro = isPro(user);
  const isMobile = useIsMobile();

  // ── view state
  const [tab, setTab] = useState('signals'); // 'signals' | 'filings'
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('all');
  const [txType, setTxType] = useState('all');
  const [relFilter, setRelFilter] = useState('all');
  const [sigDays, setSigDays] = useState(30);
  const [sortCol, setSortCol] = useState('conviction');
  const [sortDir, setSortDir] = useState(-1);
  const [filSortCol, setFilSortCol] = useState('date');
  const [filSortDir, setFilSortDir] = useState(-1);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  function onSort(col) {
    if (sortCol === col) setSortDir(d => -d); else { setSortCol(col); setSortDir(-1); }
    setPage(0);
  }
  function onFilSort(col) {
    if (filSortCol === col) setFilSortDir(d => -d); else { setFilSortCol(col); setFilSortDir(-1); }
    setPage(0);
  }

  const cutoff = useMemo(() => {
    if (sigDays == null) return null;
    const d = new Date(); d.setDate(d.getDate() - sigDays); return d.toISOString().split('T')[0];
  }, [sigDays]);

  // Signals (tab 1)
  const allSignals = useMemo(() => {
    const base = filings.filter(f =>
      f.isOpenMarket &&
      (!cutoff || (f.transactionDate || f.date || '') >= cutoff)
    );
    return buildSignals(base)
      .filter(s => s.direction !== 'sell' ? (s.netValue >= 50_000 || s.cSuiteBuys >= 1) : s.sellValue >= 50_000);
  }, [filings, cutoff]);

  const filteredSignals = useMemo(() => {
    const q = search.toLowerCase();
    return allSignals.filter(s => {
      if (q && !s.ticker.toLowerCase().includes(q) && !s.company.toLowerCase().includes(q)) return false;
      if (sector !== 'all' && s.sector !== sector) return false;
      if (relFilter !== 'all') {
        if (relFilter === 'strong' && s.cSuiteBuys === 0) return false;
        if (relFilter === 'congress' && !s.isPolitical) return false;
      }
      return true;
    }).sort((a, b) => {
      const av = a[sortCol] ?? -Infinity, bv = b[sortCol] ?? -Infinity;
      return sortDir > 0 ? av - bv : bv - av;
    });
  }, [allSignals, search, sector, relFilter, sortCol, sortDir]);

  // Filings (tab 2)
  const filteredFilings = useMemo(() => {
    const q = search.toLowerCase();
    return filings.filter(f => {
      if (!f.isOpenMarket) return false;
      if (q && !f.ticker?.toLowerCase().includes(q) && !f.company?.toLowerCase().includes(q) && !f.insiderName?.toLowerCase().includes(q)) return false;
      if (sector !== 'all' && f.sector !== sector) return false;
      if (txType !== 'all' && f.transactionType !== txType) return false;
      if (relFilter !== 'all') {
        if (relFilter === 'strong' && f.relationship !== 'strong') return false;
        if (relFilter === 'medium' && f.relationship !== 'medium') return false;
        if (relFilter === 'congress' && f.relationship !== 'congress') return false;
      }
      return true;
    }).sort((a, b) => {
      const aVal = filSortCol === 'date' ? (a.transactionDate || a.date || '') :
                   filSortCol === 'value' ? (a.value || 0) :
                   filSortCol === 'shares' ? (a.shares || 0) : 0;
      const bVal = filSortCol === 'date' ? (b.transactionDate || b.date || '') :
                   filSortCol === 'value' ? (b.value || 0) :
                   filSortCol === 'shares' ? (b.shares || 0) : 0;
      return filSortDir > 0 ? (aVal > bVal ? 1 : -1) : (bVal > aVal ? 1 : -1);
    });
  }, [filings, search, sector, txType, relFilter, filSortCol, filSortDir]);

  const sectors = useMemo(() => ['all', ...Array.from(new Set(filings.map(f => f.sector).filter(Boolean))).sort()], [filings]);

  const sigPage = filteredSignals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const filPage = filteredFilings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalItems = tab === 'signals' ? filteredSignals.length : filteredFilings.length;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  const buyCount = useMemo(() => filings.filter(f => f.isOpenMarket && f.transactionType === 'buy').length, [filings]);
  const buyVal = useMemo(() => filings.filter(f => f.isOpenMarket && f.transactionType === 'buy').reduce((s, f) => s + (f.value || 0), 0), [filings]);

  return (
    <div className="ws-page">
      {/* Page header */}
      <div className="ws-page-hdr">
        <h1 className="ws-page-title">Market Data</h1>
        <p className="ws-page-sub">Scored insider signals and raw SEC Form 4 filings — searchable, sortable, linked to original government filings.</p>
      </div>

      {/* Stats */}
      <div className="ws-stat-strip">
        <StatCard label="Open-market buys" value={loading ? '—' : buyCount} sub={fmt.money(buyVal)} color="var(--green-600)" />
        <StatCard label="High-conviction signals" value={loading ? '—' : allSignals.filter(s => s.conviction >= 10).length} sub="Score ≥10/15" />
        <StatCard label="Unique tickers" value={loading ? '—' : new Set(filings.filter(f => f.isOpenMarket).map(f => f.ticker)).size} sub="With open-market activity" />
        <StatCard label="Filtered results" value={totalItems} sub={`${tab === 'signals' ? 'signals' : 'filings'} matching filters`} />
      </div>

      {/* Toolbar */}
      <div className="ws-toolbar">
        {/* Tab nav */}
        <div className="ws-toolbar__tabs">
          {[['signals', 'Signals'], ['filings', 'All Filings']].map(([v, l]) => (
            <button key={v} className={`ws-toolbar__tab${tab === v ? ' ws-toolbar__tab--active' : ''}`} onClick={() => { setTab(v); setPage(0); }}>
              {l}
              {!loading && <span className="ws-toolbar__tab-count">{v === 'signals' ? allSignals.length : filings.filter(f => f.isOpenMarket).length}</span>}
            </button>
          ))}
        </div>

        {/* Filters row */}
        <div className="ws-toolbar__filters">
          <SearchBox
            value={search}
            onChange={v => { setSearch(v); setPage(0); }}
            placeholder={tab === 'signals' ? 'Ticker or company…' : 'Ticker, company, or insider…'}
            style={{ flex: 1, minWidth: 160, maxWidth: 280 }}
          />

          <select className="ws-select" value={sector} onChange={e => { setSector(e.target.value); setPage(0); }}>
            <option value="all">All sectors</option>
            {sectors.filter(s => s !== 'all').map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {tab === 'filings' && (
            <select className="ws-select" value={txType} onChange={e => { setTxType(e.target.value); setPage(0); }}>
              <option value="all">Buy & sell</option>
              <option value="buy">Buys only</option>
              <option value="sell">Sells only</option>
            </select>
          )}

          <select className="ws-select" value={relFilter} onChange={e => { setRelFilter(e.target.value); setPage(0); }}>
            <option value="all">All roles</option>
            <option value="strong">C-Suite only</option>
            <option value="medium">Officers+</option>
            <option value="congress">Congressional</option>
          </select>

          {tab === 'signals' && (
            <PillFilter
              options={[
                { label: '7d', value: 7 }, { label: '30d', value: 30 },
                { label: '90d', value: 90 }, { label: 'All', value: null },
              ]}
              value={sigDays}
              onChange={v => {
                const n = v === null ? null : Number(v);
                if (n === null || n > 7) {
                  if (!pro) { onUpgrade('full_history'); return; }
                  if (n) ensureFilingsWindow(n);
                  else ensureFilingsWindow(null);
                }
                setSigDays(n);
                setPage(0);
              }}
            />
          )}

          {(search || sector !== 'all' || txType !== 'all' || relFilter !== 'all') && (
            <button className="ws-clear-btn" onClick={() => { setSearch(''); setSector('all'); setTxType('all'); setRelFilter('all'); setPage(0); }}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── SIGNALS TABLE */}
      {tab === 'signals' && (
        <Tile>
          {loading ? <WsSkeleton count={10} /> : filteredSignals.length === 0 ? (
            <div className="ws-empty">No signals match these filters. Try widening the date range or clearing filters.</div>
          ) : (
            <>
              <div className="ws-tbl-wrap">
                <table className="ws-table">
                  <thead>
                    <tr>
                      <SortHeader label="Ticker" col="ticker" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                      {!isMobile && <th className="ws-th">Company</th>}
                      {!isMobile && <th className="ws-th">Sector</th>}
                      <SortHeader label="Insiders" col="insiderCount" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                      <SortHeader label="Net Value" col="netValue" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                      <SortHeader label="Conviction" col="conviction" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                      {!isMobile && <SortHeader label="Last Trade" col="lastTradeDate" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />}
                    </tr>
                  </thead>
                  <tbody>
                    {sigPage.map((s, i) => {
                      const isBuy = s.direction !== 'sell';
                      return (
                        <tr key={s.ticker} className={`ws-tr${isBuy ? ' ws-tr--buy' : ' ws-tr--sell'}`} onClick={() => onOpenDetail({ type: 'signal', ...s })}>
                          <td className="ws-td">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span className="ws-ticker">{s.ticker}</span>
                              <RelBadge rel={s.isPolitical ? 'congress' : s.relationship} small />
                              {s.cSuiteBuys > 0 && <span className="badge badge--exec" style={{ fontSize: 10 }}>{s.cSuiteBuys}×</span>}
                            </div>
                            {isMobile && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{s.company}</div>}
                          </td>
                          {!isMobile && <td className="ws-td ws-td--overflow">{s.company}</td>}
                          {!isMobile && <td className="ws-td ws-td--muted">{s.sector}</td>}
                          <td className="ws-td ws-td--right ws-td--mono">{s.insiderCount}</td>
                          <td className="ws-td ws-td--right">
                            <span className={`ws-td--mono ws-td--fw ${isBuy ? 'val-buy' : 'val-sell'}`}>
                              {isBuy ? '+' : ''}{fmt.money(s.netValue)}
                            </span>
                          </td>
                          <td className="ws-td" style={{ minWidth: 120 }}>
                            <MiniConvBar score={s.conviction} max={15} />
                          </td>
                          {!isMobile && <td className="ws-td ws-td--muted">{fmt.dateShort(s.lastTradeDate)}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="ws-pagination">
                  <span className="ws-pagination__info">{filteredSignals.length} signals · page {page + 1} of {totalPages}</span>
                  <div className="ws-pagination__btns">
                    <button className="ws-pag-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Prev</button>
                    <button className="ws-pag-btn" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>Next →</button>
                  </div>
                </div>
              )}
            </>
          )}
        </Tile>
      )}

      {/* ── FILINGS TABLE */}
      {tab === 'filings' && (
        <Tile>
          {loading ? <WsSkeleton count={12} /> : filteredFilings.length === 0 ? (
            <div className="ws-empty">No filings match these filters.</div>
          ) : (
            <>
              <div className="ws-tbl-wrap">
                <table className="ws-table">
                  <thead>
                    <tr>
                      <SortHeader label="Date" col="date" sortCol={filSortCol} sortDir={filSortDir} onSort={onFilSort} />
                      <th className="ws-th">Ticker</th>
                      {!isMobile && <th className="ws-th">Insider</th>}
                      {!isMobile && <th className="ws-th">Role</th>}
                      <th className="ws-th">Type</th>
                      {!isMobile && <SortHeader label="Shares" col="shares" sortCol={filSortCol} sortDir={filSortDir} onSort={onFilSort} right />}
                      {!isMobile && <th className="ws-th ws-th--right">Price</th>}
                      <SortHeader label="Value" col="value" sortCol={filSortCol} sortDir={filSortDir} onSort={onFilSort} right />
                      <th className="ws-th" title="View original SEC filing">SEC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filPage.map((f, i) => {
                      const isBuy = f.transactionType === 'buy';
                      const secUrl = secFilingUrl(f.accessionNumber, f.cikIssuer);
                      return (
                        <tr key={i} className={`ws-tr${isBuy ? ' ws-tr--buy' : ' ws-tr--sell'}`} onClick={() => onOpenDetail({ type: 'ticker', ticker: f.ticker, company: f.company })}>
                          <td className="ws-td ws-td--muted">{fmt.dateShort(f.transactionDate || f.date)}</td>
                          <td className="ws-td">
                            <span className="ws-ticker">{f.ticker}</span>
                            {isMobile && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{f.insiderName}</div>}
                          </td>
                          {!isMobile && <td className="ws-td ws-td--overflow" style={{ maxWidth: 160 }}>{f.insiderName}</td>}
                          {!isMobile && <td className="ws-td"><RelBadge rel={f.relationship} small /></td>}
                          <td className="ws-td">
                            <span className={`badge${isBuy ? ' badge--buy' : ' badge--sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span>
                          </td>
                          {!isMobile && <td className="ws-td ws-td--right ws-td--mono">{f.shares ? fmt.number(f.shares) : '—'}</td>}
                          {!isMobile && <td className="ws-td ws-td--right ws-td--mono">{f.price ? fmt.price(f.price) : '—'}</td>}
                          <td className="ws-td ws-td--right">
                            <span className={`ws-td--mono ws-td--fw ${isBuy ? 'val-buy' : 'val-sell'}`}>
                              {isBuy ? '+' : '−'}{fmt.money(f.value)}
                            </span>
                          </td>
                          <td className="ws-td" onClick={e => e.stopPropagation()}>
                            {secUrl ? (
                              <a href={secUrl} target="_blank" rel="noopener noreferrer" className="ws-sec-link" title="View SEC filing">↗</a>
                            ) : <span className="ws-td--muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Footer */}
              <div className="ws-tbl-footer">
                <span>{filteredFilings.length.toLocaleString()} filings · Open-market only · {new Set(filteredFilings.map(f => f.ticker)).size} tickers</span>
                {totalPages > 1 && (
                  <div className="ws-pagination__btns">
                    <button className="ws-pag-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Prev</button>
                    <span className="ws-pag-info">p. {page + 1}/{totalPages}</span>
                    <button className="ws-pag-btn" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>Next →</button>
                  </div>
                )}
              </div>
            </>
          )}
        </Tile>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// INSIDERS PAGE — full leaderboard with sortable table + profile deep-dive
// (replaces the old Insights leaderboard tab)
// ══════════════════════════════════════════════════════════════════════════════
function WebInsidersPage({ filings, loading: filingsLoading, onOpenDetail, watchlist, user, onUpgrade }) {
  const pro = isPro(user);
  const isMobile = useIsMobile();

  const [rows, setRows] = useState(null);
  const [lbError, setLbError] = useState(null);
  const [yearsBack, setYearsBack] = useState(2);
  const [source, setSource] = useState(null); // null=all | 'corporate' | 'congress'
  const [sortCol, setSortCol] = useState('proxy_score');
  const [sortDir, setSortDir] = useState(-1);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 30;

  useEffect(() => {
    if (!cfg.NEON_PROXY_URL) { setLbError('Not configured'); return; }
    setRows(null); setLbError(null);
    queryNeon(LEADERBOARD_QUERY(200, null, 2, yearsBack, source))
      .then(r => setRows(processLeaderboardRows(r)))
      .catch(e => setLbError(e.message || 'Failed to load'));
  }, [yearsBack, source]);

  function onSort(col) {
    if (sortCol === col) setSortDir(d => -d); else { setSortCol(col); setSortDir(-1); }
    setPage(0);
  }

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.toLowerCase();
    return [...rows].filter(r => {
      if (!q) return true;
      return (r.insider_name || '').toLowerCase().includes(q) ||
             (r.insider_title || '').toLowerCase().includes(q);
    }).sort((a, b) => {
      const av = a[sortCol] ?? -Infinity, bv = b[sortCol] ?? -Infinity;
      return sortDir > 0 ? av - bv : bv - av;
    });
  }, [rows, search, sortCol, sortDir]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  // Stats from leaderboard rows
  const stats = useMemo(() => {
    if (!rows) return {};
    const withHitRate = rows.filter(r => r.hit_rate != null);
    const avgHit = withHitRate.length ? Math.round(withHitRate.reduce((s, r) => s + r.hit_rate, 0) / withHitRate.length) : null;
    const topHit = withHitRate.length ? Math.round(Math.max(...withHitRate.map(r => r.hit_rate))) : null;
    const totalVal = rows.reduce((s, r) => s + (r.bought_value || 0), 0);
    return { count: rows.length, avgHit, topHit, totalVal };
  }, [rows]);

  // Insider profile — their filing history from the already-loaded filings array
  const profileFilings = useMemo(() => {
    if (!selected) return [];
    return filings.filter(f => f.insiderName === selected.insider_name && f.isOpenMarket)
      .sort((a, b) => (b.transactionDate || b.date || '') > (a.transactionDate || a.date || '') ? 1 : -1)
      .slice(0, 12);
  }, [selected, filings]);

  return (
    <div className="ws-page">
      <div className="ws-page-hdr">
        <h1 className="ws-page-title">Insider Profiles</h1>
        <p className="ws-page-sub">Track individual insiders by historical accuracy and position size — ranked by composite score. Click any row to see full profile and filing history.</p>
      </div>

      {/* Stats */}
      <div className="ws-stat-strip">
        <StatCard label="Tracked insiders" value={rows ? stats.count : '—'} sub="Open-market traders" />
        <StatCard label="Avg hit rate" value={stats.avgHit != null ? `${stats.avgHit}%` : '—'} sub="Profitable trades" color={stats.avgHit >= 60 ? 'var(--green-600)' : undefined} />
        <StatCard label="Best hit rate" value={stats.topHit != null ? `${stats.topHit}%` : '—'} sub="Top performer" color="var(--green-600)" />
        <StatCard label="Total buy value tracked" value={stats.totalVal ? fmt.money(stats.totalVal) : '—'} sub={`${yearsBack ?? 'All'} yr window`} />
      </div>

      <div className={`ws-ins-layout${selected ? ' ws-ins-layout--split' : ''}`}>

        {/* Leaderboard */}
        <div className="ws-ins-table-col">
          <Tile>
            {/* Toolbar */}
            <div className="ws-toolbar__filters" style={{ padding: '10px 14px' }}>
              <SearchBox value={search} onChange={v => { setSearch(v); setPage(0); }} placeholder="Search insider or title…" style={{ flex: 1, minWidth: 140 }} />

              {pro ? (
                <>
                  <PillFilter
                    options={[{ label: '1yr', value: 1 }, { label: '2yr', value: 2 }, { label: '5yr', value: 5 }, { label: 'All', value: null }]}
                    value={yearsBack}
                    onChange={v => setYearsBack(v)}
                  />
                  <PillFilter
                    options={[{ label: 'All', value: null }, { label: 'Corp', value: 'corporate' }, { label: 'Congress', value: 'congress' }]}
                    value={source}
                    onChange={v => setSource(v)}
                  />
                </>
              ) : (
                <button className="ws-pill" onClick={() => onUpgrade('full_history')} style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                  Pro filters →
                </button>
              )}
            </div>

            {lbError ? (
              <div className="ws-empty" style={{ color: 'var(--red-600)' }}>
                <IconWarning style={{ width: 14, height: 14, marginRight: 4 }} />{lbError}
              </div>
            ) : rows === null ? (
              <WsSkeleton count={12} />
            ) : filtered.length === 0 ? (
              <div className="ws-empty">No insiders match your search.</div>
            ) : (
              <>
                <div className="ws-tbl-wrap">
                  <table className="ws-table">
                    <thead>
                      <tr>
                        <th className="ws-th" style={{ width: 36, textAlign: 'center' }}>#</th>
                        <SortHeader label="Insider" col="insider_name" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                        <SortHeader label="Buys" col="om_buys" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                        {!isMobile && <SortHeader label="Value" col="bought_value" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />}
                        {!isMobile && <SortHeader label="Hit Rate" col="hit_rate" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />}
                        {!isMobile && <SortHeader label="Avg Return" col="avg_return" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />}
                        <SortHeader label="Score" col="proxy_score" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r, i) => {
                        const rank = page * PAGE_SIZE + i + 1;
                        const isSelected = selected?.insider_name === r.insider_name;
                        const hrC = r.hit_rate >= 70 ? 'var(--green-600)' : r.hit_rate < 50 ? 'var(--red-600)' : 'var(--text-2)';
                        const retC = (r.avg_return ?? 0) >= 0 ? 'var(--green-600)' : 'var(--red-600)';
                        return (
                          <tr key={r.insider_name} className={`ws-tr ws-tr--clickable${isSelected ? ' ws-tr--selected' : ''}`} onClick={() => setSelected(isSelected ? null : r)}>
                            <td className="ws-td" style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 11, fontWeight: 600 }}>{rank}</td>
                            <td className="ws-td">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                <FollowBtn name={r.insider_name} watchlist={watchlist} />
                                <div>
                                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.insider_name}</div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                                    <RelBadge rel={r.relationship} small />
                                    {!isMobile && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.insider_title || 'Unknown'}</span>}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="ws-td ws-td--right ws-td--mono">{r.om_buys}</td>
                            {!isMobile && <td className="ws-td ws-td--right ws-td--mono">{fmt.money(r.bought_value)}</td>}
                            {!isMobile && (
                              <td className="ws-td ws-td--right">
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, color: hrC }}>
                                  {r.hit_rate != null ? `${r.hit_rate}%` : '—'}
                                </span>
                              </td>
                            )}
                            {!isMobile && (
                              <td className="ws-td ws-td--right">
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, color: retC }}>
                                  {r.avg_return != null ? `${r.avg_return >= 0 ? '+' : ''}${r.avg_return.toFixed(1)}%` : '—'}
                                </span>
                              </td>
                            )}
                            <td className="ws-td" style={{ minWidth: 110 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12 }}>{r.proxy_score?.toFixed(1) ?? '—'}</span>
                                <div style={{ flex: 1, minWidth: 40 }}>
                                  <MiniConvBar score={r.proxy_score ?? 0} max={5} />
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="ws-tbl-footer">
                  <span>{filtered.length} insiders · Score = weighted composite of hit rate, returns, volume &amp; role</span>
                  {totalPages > 1 && (
                    <div className="ws-pagination__btns">
                      <button className="ws-pag-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
                      <span className="ws-pag-info">p. {page + 1}/{totalPages}</span>
                      <button className="ws-pag-btn" disabled={page === totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </Tile>
        </div>

        {/* Profile panel */}
        {selected && (
          <div className="ws-ins-profile">
            <Tile style={{ position: 'sticky', top: 72 }}>
              <div className="ws-ins-profile__inner">
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>{selected.insider_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 7 }}>{selected.insider_title || 'Unknown'}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <RelBadge rel={selected.relationship} />
                      <FollowBtn name={selected.insider_name} watchlist={watchlist} />
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)} className="topnav__icon-btn">
                    <IconClose style={{ width: 14, height: 14 }} />
                  </button>
                </div>

                {/* Metric grid */}
                <div className="ws-ins-metric-grid">
                  {[
                    { label: 'Open-mkt buys', value: selected.om_buys },
                    { label: 'Open-mkt sells', value: selected.om_sells || 0 },
                    { label: 'Value purchased', value: fmt.money(selected.bought_value), mono: false },
                    { label: 'Hit rate', value: selected.hit_rate != null ? `${selected.hit_rate}%` : '—', color: selected.hit_rate >= 70 ? 'var(--green-600)' : selected.hit_rate < 50 ? 'var(--red-600)' : undefined },
                    { label: 'Avg return', value: selected.avg_return != null ? `${selected.avg_return >= 0 ? '+' : ''}${selected.avg_return.toFixed(1)}%` : '—', color: (selected.avg_return ?? 0) >= 0 ? 'var(--green-600)' : 'var(--red-600)' },
                    { label: 'Composite score', value: selected.proxy_score?.toFixed(1) ?? '—' },
                  ].map(m => (
                    <div key={m.label} className="ws-ins-metric">
                      <div className="ws-ins-metric__label">{m.label}</div>
                      <div className="ws-ins-metric__val" style={m.color ? { color: m.color } : {}}>{m.value}</div>
                    </div>
                  ))}
                </div>

                {/* Score bar */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 5 }}>Composite score · {selected.proxy_score?.toFixed(1) ?? '—'}/5.0</div>
                  <MiniConvBar score={selected.proxy_score ?? 0} max={5} />
                </div>

                {/* Button to open full detail panel */}
                <button
                  className="ws-profile-explore-btn"
                  onClick={() => onOpenDetail({ type: 'trader', name: selected.insider_name, title: selected.insider_title })}
                >
                  Open full profile →
                </button>

                {/* Recent filings from loaded dataset */}
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-3)', marginBottom: 9 }}>
                    Recent filings {profileFilings.length === 0 ? '(not in current window)' : `· ${profileFilings.length} found`}
                  </div>
                  {profileFilings.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      No open-market trades in the currently-loaded window. Widen the date range on the Data page to see more history.
                    </div>
                  ) : profileFilings.map((f, i) => {
                    const isBuy = f.transactionType === 'buy';
                    const secUrl = secFilingUrl(f.accessionNumber, f.cikIssuer);
                    return (
                      <div key={i} className="ws-profile-filing" onClick={() => onOpenDetail({ type: 'transaction', trade: f })}>
                        <div className="ws-profile-filing__bar" style={{ background: isBuy ? 'var(--green-600)' : 'var(--red-600)' }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span className="ws-ticker">{f.ticker}</span>
                            <span className={`badge${isBuy ? ' badge--buy' : ' badge--sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span>
                            {secUrl && (
                              <a href={secUrl} target="_blank" rel="noopener noreferrer" className="ws-sec-link" onClick={e => e.stopPropagation()} title="SEC filing">↗</a>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                            {fmt.dateShort(f.transactionDate || f.date)} · {f.shares ? fmt.number(f.shares) + ' shares' : ''} {f.price ? `@ ${fmt.price(f.price)}` : ''}
                          </div>
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: isBuy ? 'var(--green-600)' : 'var(--red-600)', flexShrink: 0 }}>
                          {isBuy ? '+' : '−'}{fmt.money(f.value)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Tile>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// APPINNER PATCH
// Replace the existing AppInner return with this. The key changes:
//   1. Remove <Sidebar/> and .app-shell / .main-area / .content-area wrappers
//   2. Replace status-bar with the new TopNav
//   3. Route 'home' → WebHomePage, 'data' → WebDataPage, 'signals' → WebInsidersPage
//   4. Keep all existing modals, detail panels, watchlist logic unchanged
// ══════════════════════════════════════════════════════════════════════════════
/*

// In AppInner, replace the return() block with:

  return (
    <>
      {isDataStale && !error && (
        <button className="stale-banner" onClick={() => setShowStaleDataModal(true)}>
          <IconWarning style={{width:14,height:14}}/> Live data isn't updating right now — tap for details
        </button>
      )}
      {error && (
        <div className="stale-banner stale-banner--error" role="alert">
          <IconWarning style={{width:14,height:14}}/>
          <span>Failed to load filing data. <button className="stale-banner__retry" onClick={()=>load(filingsWindowDays)}>Retry</button></span>
        </div>
      )}
      {showStaleDataModal && (
        <div className="modal-overlay" onClick={(e)=>{if(e.target===e.currentTarget)setShowStaleDataModal(false);}}>
          <div className="modal-panel stale-modal">
            <div className="modal-panel__hdr">
              <span className="modal-panel__title">Data isn't updating</span>
              <button className="modal-close" onClick={()=>setShowStaleDataModal(false)} title="Close"><IconClose style={{width:12,height:12}}/></button>
            </div>
            <div className="modal-body stale-modal__body">
              <p>Live filing data hasn't updated in a few days. We're aware and working on it.</p>
              <p className="stale-modal__timestamp">
                Last new filing: <strong>{lastFilingDate ? fmt.dateShort(lastFilingDate) : 'unknown'}</strong>
                {daysSinceLastFiling != null && ` (${daysSinceLastFiling} day${daysSinceLastFiling===1?'':'s'} ago)`}
              </p>
            </div>
          </div>
        </div>
      )}

      <GuideProvider>
        <div className={`ws-shell${panelOpen ? ' ws-shell--panel-open' : ''}`}>

          <TopNav
            page={page}
            setPage={navTo}
            dark={dark}
            setDark={setDark}
            user={user}
            onUpgrade={(f) => setShowUpgradeModal(f || 'default')}
            lastFilingDate={lastFilingDate}
            isDataStale={isDataStale}
            loading={loading}
          />

          <main className="ws-main">
            {cameFromHome && page !== 'home' && (
              <button className="home-breadcrumb" onClick={() => navTo('home')}>
                <span className="home-breadcrumb__arrow">←</span>
                Home <span className="home-breadcrumb__sep">›</span> {PAGE_TITLES[page]}
              </button>
            )}

            {page === 'home' && (
              <WebHomePage
                filings={filings} loading={loading} watchlist={watchlist} user={user}
                onOpenDetail={openDetail} onSeeAll={seeAllFromHome} onUpgrade={(f) => setShowUpgradeModal(f || 'default')}
              />
            )}
            {page === 'data' && (
              <WebDataPage
                filings={filings} loading={loading} onOpenDetail={openDetail}
                portfolioTickers={portfolioTickers} user={user}
                onUpgrade={(f) => setShowUpgradeModal(f || 'data_export')}
                ensureFilingsWindow={ensureFilingsWindow}
              />
            )}
            {page === 'signals' && (
              <WebInsidersPage
                filings={filings} loading={loading} onOpenDetail={openDetail}
                watchlist={watchlist} user={user} onUpgrade={(f) => setShowUpgradeModal(f || 'default')}
              />
            )}
            {page === 'settings' && (
              <SettingsPage user={user} onUpgrade={(f) => setShowUpgradeModal(f || 'default')} />
            )}

            <footer className="ws-footer">
              <span>Private Beta · Not financial advice.</span>
              <a href="/help" target="_blank" rel="noreferrer">Help</a>
              <FeedbackButton page={page} />
            </footer>
          </main>

          {watchlist.showUpgrade && (
            <UpgradeModal feature={watchlist.showUpgrade} pro={isPro(user)} onClose={() => watchlist.setShowUpgrade(null)} />
          )}
          {showUpgradeModal && (
            <UpgradeModal feature={showUpgradeModal} pro={isPro(user)} onClose={() => setShowUpgradeModal(null)} />
          )}
          {panelOpen && !detailFull && (
            <>
              <div className="panel-overlay" onClick={closeDetail} />
              <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onExpand={expandDetail} onNavigate={openDetail} onBack={goBackDetail} canGoBack={detailStack.length > 0} watchlist={watchlist} />
            </>
          )}
          {panelOpen && detailFull && (
            detail?.dataFilters
              ? <DataDrawer initialDetail={detail} initialDetailStack={detailStack} filings={filings} onClose={closeDetail} onNavigate={openDetail} watchlist={watchlist} user={user} ensureFilingsWindow={ensureFilingsWindow} sortCol={expSort} sortDir={expDir} onSort={expOnSort}/>
              : <>
                  <div className="panel-overlay" onClick={closeDetail}/>
                  <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onExpand={null} onNavigate={openDetail} onBack={goBackDetail} canGoBack={detailStack.length>0} watchlist={watchlist}/>
                </>
          )}
        </div>
      </GuideProvider>
    </>
  );

*/
