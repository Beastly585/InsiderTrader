// src/onboard.jsx — Interactive onboarding flow for new Seli users
// Lives at seli.app/onboard — full-screen, no main nav, immersive.
// Skippable at any time. Writes to real watchlist on step 6.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import cfg from './config.js';
// Styles live at the bottom of style.css (ob-* prefix) — no separate import needed.

// ── Constants ────────────────────────────────────────────────────────────────
const TOTAL_STEPS = 8;

// Popular tickers for the quick-add grid (step 6)
const POPULAR_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM',
  'V', 'UNH', 'JNJ', 'WMT', 'PG', 'MA', 'HD', 'BAC',
  'XOM', 'COST', 'ABBV', 'CRM', 'PFE', 'KO', 'MCD', 'DIS',
];

// Signal scoring breakdown for the interactive builder (step 3)
const SIGNAL_FACTORS = [
  { id: 'market',    label: 'Open-market trade',          points: 2, description: 'Not a grant, option exercise, or automatic plan — the insider chose to buy or sell on the open market.' },
  { id: 'role',      label: 'C-suite or congressional',   points: 2, description: 'CEO, CFO, President, or member of Congress. These insiders have the deepest view into the company.' },
  { id: 'routine',   label: 'Non-routine trade',          points: 3, description: 'Not on a pre-set 10b5-1 plan. The insider made a deliberate, discretionary decision to trade.' },
  { id: 'value',     label: 'Trade value ≥ $1M',          points: 3, description: 'Large dollar amount — the insider is putting serious capital behind their conviction.' },
  { id: 'direction', label: 'Purchase (not a sale)',       points: 1, description: 'Buys are more informative than sells. Insiders sell for many reasons, but they buy for one: they think the stock is going up.' },
];

// ── Icons (inline SVG to avoid import dependencies) ─────────────────────────
function IconArrowRight({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function IconCheck({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconPlus({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconX({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconStar({ size = 16, filled = false, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function IconBell({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconSearch({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────
function StepWelcome({ stats, onNext }) {
  return (
    <div className="ob-step ob-step--welcome">
      <div className="ob-welcome__content">
        <h1 className="ob-welcome__headline">
          Every time a CEO, director, or member of Congress buys or sells stock, it becomes public record.
        </h1>
        <p className="ob-welcome__sub">
          Seli turns that raw data into signals you can actually use.
        </p>
        <div className="ob-welcome__stats">
          {stats.totalFilings != null && (
            <div className="ob-stat">
              <span className="ob-stat__number">{(stats.totalFilings || 0).toLocaleString()}</span>
              <span className="ob-stat__label">Filings tracked</span>
            </div>
          )}
          {stats.uniqueInsiders != null && (
            <div className="ob-stat">
              <span className="ob-stat__number">{(stats.uniqueInsiders || 0).toLocaleString()}</span>
              <span className="ob-stat__label">Unique insiders</span>
            </div>
          )}
          {stats.companiesCovered != null && (
            <div className="ob-stat">
              <span className="ob-stat__number">{(stats.companiesCovered || 0).toLocaleString()}</span>
              <span className="ob-stat__label">Companies covered</span>
            </div>
          )}
        </div>
        <button className="ob-cta" onClick={onNext}>
          See how it works <IconArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Who Are Insiders? ────────────────────────────────────────────────
function StepInsiderTypes({ sampleFilings, onNext }) {
  const [expanded, setExpanded] = useState(new Set());

  const categories = [
    {
      id: 'corporate',
      title: 'Corporate Executives',
      tier: 'Strong signal',
      description: 'CEOs, CFOs, directors, and 10% owners. They file SEC Form 4 within 2 business days of any trade. Their access to material non-public information makes their trades the most informative.',
      icon: '🏢',
    },
    {
      id: 'congress',
      title: 'Members of Congress',
      tier: 'Strong signal',
      description: 'Representatives and Senators required to disclose trades under the STOCK Act. House filings appear near-realtime; Senate disclosures often lag 30–45 days.',
      icon: '🏛️',
    },
    {
      id: 'officers',
      title: 'Other Officers',
      tier: 'Medium signal',
      description: 'VPs, SVPs, and other titled insiders. Still legally required to disclose, but their trades carry less weight in the conviction score — they\'re typically further from strategic decisions.',
      icon: '📋',
    },
  ];

  function toggleCard(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="ob-step ob-step--insiders">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">The data sources</span>
        <h2 className="ob-step__title">Who are "insiders"?</h2>
        <p className="ob-step__subtitle">Seli tracks three categories of people whose trades become public record. Tap each to learn more.</p>
      </div>
      <div className="ob-insiders__grid">
        {categories.map(cat => {
          const isOpen = expanded.has(cat.id);
          const sample = sampleFilings[cat.id];
          return (
            <button
              key={cat.id}
              className={`ob-insider-card${isOpen ? ' ob-insider-card--open' : ''}`}
              onClick={() => toggleCard(cat.id)}
            >
              <div className="ob-insider-card__top">
                <span className="ob-insider-card__icon">{cat.icon}</span>
                <div>
                  <div className="ob-insider-card__title">{cat.title}</div>
                  <div className="ob-insider-card__tier">{cat.tier}</div>
                </div>
              </div>
              {isOpen && (
                <div className="ob-insider-card__body">
                  <p>{cat.description}</p>
                  {sample && (
                    <div className="ob-insider-card__sample">
                      <div className="ob-insider-card__sample-label">Recent filing:</div>
                      <div className="ob-insider-card__sample-row">
                        <span className="ob-sample__name">{sample.insiderName}</span>
                        <span className={`ob-sample__type ob-sample__type--${sample.transactionType}`}>
                          {sample.transactionType === 'buy' ? 'Buy' : 'Sell'}
                        </span>
                        <span className="ob-sample__ticker">{sample.ticker}</span>
                        {sample.value && (
                          <span className="ob-sample__value">${(sample.value / 1000).toFixed(0)}k</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <button className="ob-cta" onClick={onNext}>
        Next: How to read a filing <IconArrowRight size={16} />
      </button>
    </div>
  );
}

// ── Step 3: Reading a Filing ─────────────────────────────────────────────────
function StepReadingFiling({ onNext }) {
  const [revealedFactors, setRevealedFactors] = useState(new Set());
  const [activeHotspot, setActiveHotspot] = useState(null);

  const hotspots = [
    { id: 'name', label: 'Insider Name & Title', field: 'Jane Smith, CEO', factorId: 'role', tooltip: 'This is who made the trade. Their title determines relationship strength — C-suite trades carry the most weight.' },
    { id: 'type', label: 'Transaction Type', field: 'Open-Market Purchase', factorId: 'market', tooltip: 'Open-market buys are the most informative signal. Grants, exercises, and auto-plan trades are usually routine.' },
    { id: 'value', label: 'Value', field: '$2,450,000', factorId: 'value', tooltip: 'The dollar amount of the trade. $1M+ trades get the highest value boost in the scoring algorithm.' },
    { id: 'routine', label: 'Routine Flag', field: 'Non-routine', factorId: 'routine', tooltip: 'This trade is NOT on a pre-set 10b5-1 plan. The insider made a deliberate decision — this gets a +3 boost.' },
    { id: 'direction', label: 'Direction', field: 'Purchase', factorId: 'direction', tooltip: 'Buys are more informative than sells. Insiders sell for many reasons — they buy for only one.' },
  ];

  function revealHotspot(hs) {
    setActiveHotspot(hs.id);
    setRevealedFactors(prev => {
      const next = new Set(prev);
      next.add(hs.factorId);
      return next;
    });
  }

  const currentScore = SIGNAL_FACTORS.filter(f => revealedFactors.has(f.id)).reduce((sum, f) => sum + f.points, 0);

  return (
    <div className="ob-step ob-step--filing">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Understanding the data</span>
        <h2 className="ob-step__title">Reading a filing</h2>
        <p className="ob-step__subtitle">Tap each part of this filing to see what it means and how it contributes to the conviction score.</p>
      </div>

      <div className="ob-filing__layout">
        {/* The mock filing card */}
        <div className="ob-filing__card">
          <div className="ob-filing__card-header">
            <span className="ob-filing__card-badge">SEC Form 4</span>
            <span className="ob-filing__card-date">Filed Sep 19, 2026</span>
          </div>
          <div className="ob-filing__hotspots">
            {hotspots.map(hs => (
              <button
                key={hs.id}
                className={`ob-hotspot${activeHotspot === hs.id ? ' ob-hotspot--active' : ''}${revealedFactors.has(hs.factorId) ? ' ob-hotspot--revealed' : ''}`}
                onClick={() => revealHotspot(hs)}
              >
                <span className="ob-hotspot__label">{hs.label}</span>
                <span className="ob-hotspot__field">{hs.field}</span>
                {activeHotspot === hs.id && (
                  <div className="ob-hotspot__tooltip">{hs.tooltip}</div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Signal score builder */}
        <div className="ob-score-builder">
          <div className="ob-score-builder__header">
            <span className="ob-score-builder__label">Conviction Score</span>
            <span className="ob-score-builder__value">{currentScore}<span className="ob-score-builder__max">/14</span></span>
          </div>
          <div className="ob-score-builder__bar">
            <div className="ob-score-builder__fill" style={{ width: `${(currentScore / 14) * 100}%` }} />
          </div>
          <div className="ob-score-builder__factors">
            {SIGNAL_FACTORS.map(f => (
              <div key={f.id} className={`ob-factor${revealedFactors.has(f.id) ? ' ob-factor--active' : ''}`}>
                <span className="ob-factor__label">{f.label}</span>
                <span className="ob-factor__points">+{f.points}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button className="ob-cta" onClick={onNext}>
        Next: Conviction levels <IconArrowRight size={16} />
      </button>
    </div>
  );
}

// ── Step 4: Signal Score Breakdown ───────────────────────────────────────────
function StepConviction({ onNext }) {
  const tiers = [
    { range: '10–14', label: 'High Conviction', color: 'var(--green-600)', bg: 'var(--green-50)', description: 'C-suite or congressional, non-routine, open-market, large value. Rare and worth immediate attention.' },
    { range: '6–9', label: 'Medium Conviction', color: 'var(--blue-600)', bg: 'var(--blue-50)', description: 'Meaningful trades that clear multiple signal filters. Worth monitoring.' },
    { range: '3–5', label: 'Low Conviction', color: 'var(--amber-600)', bg: 'var(--amber-50)', description: 'Some signal but may be routine, small, or from lower-ranked insiders.' },
    { range: '0–2', label: 'Noise', color: 'var(--text-3)', bg: 'var(--surface-2)', description: 'Likely routine grants, small dispositions, or weak-relationship insiders.' },
  ];

  return (
    <div className="ob-step ob-step--conviction">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">The scoring system</span>
        <h2 className="ob-step__title">Conviction levels</h2>
        <p className="ob-step__subtitle">Every filing gets a score from 0 to 14. Here's what each range means.</p>
      </div>
      <div className="ob-conviction__scale">
        {tiers.map((tier, i) => (
          <div key={i} className="ob-conviction__tier">
            <div className="ob-conviction__badge" style={{ background: tier.bg, color: tier.color }}>
              {tier.range}
            </div>
            <div className="ob-conviction__info">
              <div className="ob-conviction__label" style={{ color: tier.color }}>{tier.label}</div>
              <div className="ob-conviction__desc">{tier.description}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="ob-conviction__note">
        By default, Seli shows you everything. You can filter to only see the conviction levels you care about.
      </p>
      <button className="ob-cta" onClick={onNext}>
        Next: Where data lives <IconArrowRight size={16} />
      </button>
    </div>
  );
}

// ── Step 5: Where Data Lives ─────────────────────────────────────────────────
function StepDataMap({ onNext }) {
  const [activeSection, setActiveSection] = useState(null);

  const sections = [
    {
      id: 'filings',
      title: 'All Filings',
      icon: '📊',
      description: 'Every filing, filterable by date, conviction, transaction type, source, and sector. The firehose — when you want to scan everything.',
    },
    {
      id: 'insiders',
      title: 'Insiders',
      icon: '👤',
      description: 'Ranked leaderboard of insiders by track record. Click any name to see their complete trading history and conviction trend.',
    },
    {
      id: 'watchlist',
      title: 'Your Watchlist',
      icon: '⭐',
      description: 'Filings filtered to only the tickers you follow. This is where most users should spend their time. You\'ll set yours up next.',
    },
    {
      id: 'settings',
      title: 'Settings & Alerts',
      icon: '⚙️',
      description: 'Notification preferences, portfolio linking, account management. Control how and when Seli reaches you.',
    },
  ];

  return (
    <div className="ob-step ob-step--datamap">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Navigating the app</span>
        <h2 className="ob-step__title">Where the data lives</h2>
        <p className="ob-step__subtitle">Four sections, each with a different job. Tap to preview.</p>
      </div>
      <div className="ob-datamap__grid">
        {sections.map(sec => (
          <button
            key={sec.id}
            className={`ob-datamap__card${activeSection === sec.id ? ' ob-datamap__card--active' : ''}`}
            onClick={() => setActiveSection(activeSection === sec.id ? null : sec.id)}
          >
            <span className="ob-datamap__icon">{sec.icon}</span>
            <span className="ob-datamap__title">{sec.title}</span>
            {activeSection === sec.id && (
              <p className="ob-datamap__desc">{sec.description}</p>
            )}
          </button>
        ))}
      </div>
      <button className="ob-cta" onClick={onNext}>
        Next: Build your watchlist <IconArrowRight size={16} />
      </button>
    </div>
  );
}

// ── Step 6: Build Your Watchlist ─────────────────────────────────────────────
function StepWatchlist({ watchlist, onNext }) {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef(null);
  const [recentCount, setRecentCount] = useState(null);

  // Search tickers using the existing Neon query (searches the filings table)
  const doSearch = useCallback(async (query) => {
    if (!query || query.length < 1) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const headers = { 'Content-Type': 'application/json' };
      // Try to get auth headers for authenticated search
      if (window.__clerkGetToken) {
        try {
          const token = await window.__clerkGetToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch {}
      }
      const q = query.toUpperCase().replace(/'/g, "''");
      const res = await fetch(cfg.NEON_PROXY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: `SELECT DISTINCT ticker, company_name FROM filings WHERE ticker ILIKE '${q}%' OR company_name ILIKE '%${q}%' ORDER BY ticker LIMIT 10`
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults((data.rows || []).map(r => ({ ticker: r.ticker, name: r.company_name })));
      }
    } catch {}
    setSearching(false);
  }, []);

  function onSearchChange(e) {
    const val = e.target.value;
    setSearch(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (val.length >= 1) {
      searchTimeout.current = setTimeout(() => doSearch(val), 300);
    } else {
      setSearchResults([]);
    }
  }

  // Fetch recent filing count for user's watchlist tickers
  useEffect(() => {
    if (watchlist.tickers.length === 0) { setRecentCount(null); return; }
    const tickers = watchlist.tickers.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
    (async () => {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (window.__clerkGetToken) {
          try {
            const token = await window.__clerkGetToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;
          } catch {}
        }
        const res = await fetch(cfg.NEON_PROXY_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: `SELECT COUNT(*) as cnt FROM filings WHERE ticker IN (${tickers}) AND filing_date >= CURRENT_DATE - INTERVAL '14 days'`
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setRecentCount(data.rows?.[0]?.cnt || 0);
        }
      } catch {}
    })();
  }, [watchlist.tickers]);

  const addedSet = new Set(watchlist.tickers);

  return (
    <div className="ob-step ob-step--watchlist">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Get personal</span>
        <h2 className="ob-step__title">Build your watchlist</h2>
        <p className="ob-step__subtitle">Add the tickers you own, follow, or are curious about. Seli will filter insider activity to just these stocks.</p>
      </div>

      {/* Search */}
      <div className="ob-watchlist__search-wrap">
        <IconSearch size={16} className="ob-watchlist__search-icon" />
        <input
          type="text"
          className="ob-watchlist__search"
          placeholder="Search by ticker or company name…"
          value={search}
          onChange={onSearchChange}
          autoComplete="off"
        />
        {searching && <div className="ob-watchlist__search-spinner" />}
      </div>

      {/* Search results */}
      {searchResults.length > 0 && (
        <div className="ob-watchlist__results">
          {searchResults.map(r => (
            <button
              key={r.ticker}
              className={`ob-watchlist__result${addedSet.has(r.ticker) ? ' ob-watchlist__result--added' : ''}`}
              onClick={() => { if (!addedSet.has(r.ticker)) watchlist.toggleTicker(r.ticker); }}
            >
              <span className="ob-watchlist__result-ticker">{r.ticker}</span>
              <span className="ob-watchlist__result-name">{r.name}</span>
              {addedSet.has(r.ticker) ? (
                <IconCheck size={14} className="ob-watchlist__result-check" />
              ) : (
                <IconPlus size={14} />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Popular tickers grid */}
      <div className="ob-watchlist__popular">
        <div className="ob-watchlist__popular-label">Popular tickers — tap to add</div>
        <div className="ob-watchlist__popular-grid">
          {POPULAR_TICKERS.map(ticker => (
            <button
              key={ticker}
              className={`ob-watchlist__chip${addedSet.has(ticker) ? ' ob-watchlist__chip--added' : ''}`}
              onClick={() => watchlist.toggleTicker(ticker)}
            >
              {ticker}
              {addedSet.has(ticker) && <IconCheck size={12} />}
            </button>
          ))}
        </div>
      </div>

      {/* Current watchlist */}
      {watchlist.tickers.length > 0 && (
        <div className="ob-watchlist__current">
          <div className="ob-watchlist__current-header">
            <span className="ob-watchlist__current-label">
              <IconStar size={14} filled />
              Your watchlist ({watchlist.tickers.length})
            </span>
            {recentCount != null && (
              <span className="ob-watchlist__recent-count">
                {recentCount} filing{recentCount !== 1 ? 's' : ''} in the last 14 days
              </span>
            )}
          </div>
          <div className="ob-watchlist__current-tickers">
            {watchlist.tickers.map(t => (
              <span key={t} className="ob-watchlist__current-tag">
                {t}
                <button className="ob-watchlist__current-remove" onClick={() => watchlist.toggleTicker(t)} aria-label={`Remove ${t}`}>
                  <IconX size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <button className="ob-cta" onClick={onNext}>
        {watchlist.tickers.length >= 3
          ? <>Next: Notifications <IconArrowRight size={16} /></>
          : <>Skip for now <IconArrowRight size={16} /></>
        }
      </button>
      {watchlist.tickers.length < 3 && watchlist.tickers.length > 0 && (
        <p className="ob-watchlist__nudge">Add {3 - watchlist.tickers.length} more to get the most out of Seli</p>
      )}
    </div>
  );
}

// ── Step 7: Notifications ────────────────────────────────────────────────────
function StepNotifications({ pro, onNext }) {
  const [digestOn, setDigestOn] = useState(true);

  const proAlerts = [
    { id: 'watchlist', label: 'Watchlist ticker activity', description: 'Get notified when any insider trades a stock you follow.' },
    { id: 'followed', label: 'Followed insider activity', description: 'Get notified when a specific insider you follow makes any trade.' },
    { id: 'conviction', label: 'High-conviction trades', description: 'C-suite purchases above your conviction threshold.' },
    { id: 'reversal', label: 'Direction reversals', description: 'An insider who usually sells starts buying, or vice versa.' },
  ];

  return (
    <div className="ob-step ob-step--notifications">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Stay informed</span>
        <h2 className="ob-step__title">Never miss a signal</h2>
        <p className="ob-step__subtitle">Choose how Seli keeps you in the loop.</p>
      </div>

      <div className="ob-notif__tiers">
        {/* Free tier */}
        <div className="ob-notif__tier">
          <div className="ob-notif__tier-header">
            <span className="ob-notif__tier-badge">Free</span>
            <span className="ob-notif__tier-title">Weekly Digest</span>
          </div>
          <p className="ob-notif__tier-desc">A weekly email summarizing the top insider activity across your watchlist. Every Sunday evening.</p>
          <label className="ob-notif__toggle">
            <input type="checkbox" checked={digestOn} onChange={e => setDigestOn(e.target.checked)} />
            <span className="ob-notif__toggle-track" />
            <span className="ob-notif__toggle-label">{digestOn ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {/* Pro tier */}
        <div className={`ob-notif__tier ob-notif__tier--pro${!pro ? ' ob-notif__tier--locked' : ''}`}>
          <div className="ob-notif__tier-header">
            <span className="ob-notif__tier-badge ob-notif__tier-badge--pro">Pro</span>
            <span className="ob-notif__tier-title">Instant Alerts</span>
          </div>
          <p className="ob-notif__tier-desc">Real-time notifications the moment a filing lands. Never be the last to know.</p>
          <div className="ob-notif__alert-list">
            {proAlerts.map(a => (
              <div key={a.id} className="ob-notif__alert-item">
                <IconBell size={14} />
                <div>
                  <div className="ob-notif__alert-label">{a.label}</div>
                  <div className="ob-notif__alert-desc">{a.description}</div>
                </div>
              </div>
            ))}
          </div>
          {!pro && (
            <div className="ob-notif__pro-cta">
              Upgrade to Pro for $6.99/mo to unlock instant alerts →
            </div>
          )}
        </div>
      </div>

      <button className="ob-cta" onClick={onNext}>
        Almost done <IconArrowRight size={16} />
      </button>
    </div>
  );
}

// ── Step 8: Your Dashboard Is Ready ─────────────────────────────────────────
function StepReady({ watchlist, onComplete }) {
  const tips = [
    { title: 'Filter by conviction', description: 'Use the conviction filter on any view to show only the trades that matter to you.' },
    { title: 'Click any insider', description: 'Tap an insider\'s name to see their complete trading history and conviction trend.' },
    { title: 'Revisit this guide', description: 'You can always come back here from the Guide button in the navigation.' },
  ];

  return (
    <div className="ob-step ob-step--ready">
      <div className="ob-step__header">
        <h2 className="ob-step__title ob-ready__title">Your dashboard is ready</h2>
        <p className="ob-step__subtitle">
          {watchlist.tickers.length > 0
            ? `You're following ${watchlist.tickers.length} ticker${watchlist.tickers.length !== 1 ? 's' : ''}. Here's what insiders have been doing with them.`
            : 'You haven\'t added any tickers yet — you can always add them later from the Watchlist page.'
          }
        </p>
      </div>

      <div className="ob-ready__tips">
        {tips.map((tip, i) => (
          <div key={i} className="ob-ready__tip">
            <div className="ob-ready__tip-num">{i + 1}</div>
            <div>
              <div className="ob-ready__tip-title">{tip.title}</div>
              <div className="ob-ready__tip-desc">{tip.description}</div>
            </div>
          </div>
        ))}
      </div>

      <button className="ob-cta ob-cta--primary" onClick={onComplete}>
        Go to your dashboard <IconArrowRight size={16} />
      </button>
    </div>
  );
}


// ── Main Onboarding Component ────────────────────────────────────────────────
export default function OnboardingFlow({ user, watchlist, pro, onComplete, onSkip }) {
  const [step, setStep] = useState(() => {
    // Resume from last step if user refreshed mid-flow
    try {
      const saved = localStorage.getItem('seli_onboard_step');
      if (saved != null) return Math.min(parseInt(saved, 10), TOTAL_STEPS - 1);
    } catch {}
    return 0;
  });
  const [stats, setStats] = useState({});
  const [sampleFilings, setSampleFilings] = useState({});
  const containerRef = useRef(null);

  // Persist current step
  useEffect(() => {
    try { localStorage.setItem('seli_onboard_step', String(step)); } catch {}
  }, [step]);

  // Scroll to top on step change
  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTo(0, 0);
  }, [step]);

  // Load data for steps 1 & 2 on mount
  useEffect(() => {
    // Aggregate stats
    fetch(`${cfg.NEON_PROXY_URL}/public/data-stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setStats({
            totalFilings: d.total_filings || d.totalFilings,
            uniqueInsiders: d.unique_insiders || d.uniqueInsiders,
            companiesCovered: d.companies_covered || d.companiesCovered,
          });
        }
      })
      .catch(() => {});

    // Sample filings by category (corporate, congress, officers)
    (async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (window.__clerkGetToken) {
        try {
          const token = await window.__clerkGetToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch {}
      }
      try {
        // Get one recent filing per insider type
        const queries = {
          corporate: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM filings WHERE relationship = 'strong' AND transaction_type = 'buy' AND value > 100000 ORDER BY filing_date DESC LIMIT 1`,
          congress: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM filings WHERE source = 'congress' ORDER BY filing_date DESC LIMIT 1`,
          officers: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM filings WHERE relationship = 'medium' ORDER BY filing_date DESC LIMIT 1`,
        };
        const samples = {};
        for (const [key, query] of Object.entries(queries)) {
          try {
            const res = await fetch(cfg.NEON_PROXY_URL, { method: 'POST', headers, body: JSON.stringify({ query }) });
            if (res.ok) {
              const data = await res.json();
              if (data.rows?.[0]) {
                const r = data.rows[0];
                samples[key] = {
                  insiderName: r.insider_name,
                  ticker: r.ticker,
                  companyName: r.company_name,
                  transactionType: r.transaction_type,
                  value: r.value,
                };
              }
            }
          } catch {}
        }
        setSampleFilings(samples);
      } catch {}
    })();
  }, []);

  // PostHog tracking
  useEffect(() => {
    try {
      if (window.posthog) {
        window.posthog.capture('onboarding_step_viewed', { step, step_name: STEP_NAMES[step] });
        if (step === 0) window.posthog.capture('onboarding_started');
      }
    } catch {}
  }, [step]);

  function goNext() {
    if (step < TOTAL_STEPS - 1) setStep(step + 1);
  }

  function handleComplete() {
    try { localStorage.removeItem('seli_onboard_step'); } catch {}
    try {
      if (window.posthog) {
        window.posthog.capture('onboarding_completed', { tickers_added: watchlist.tickers.length });
      }
    } catch {}
    onComplete();
  }

  function handleSkip() {
    try { localStorage.removeItem('seli_onboard_step'); } catch {}
    try {
      if (window.posthog) {
        window.posthog.capture('onboarding_skipped', { last_step: step, step_name: STEP_NAMES[step] });
      }
    } catch {}
    onSkip();
  }

  return (
    <div className="ob" ref={containerRef}>
      {/* Progress bar */}
      <div className="ob__progress">
        <div className="ob__progress-fill" style={{ width: `${((step + 1) / TOTAL_STEPS) * 100}%` }} />
      </div>

      {/* Skip button */}
      <button className="ob__skip" onClick={handleSkip}>
        Skip to dashboard →
      </button>

      {/* Step dots */}
      <div className="ob__dots">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <button
            key={i}
            className={`ob__dot${i === step ? ' ob__dot--active' : ''}${i < step ? ' ob__dot--done' : ''}`}
            onClick={() => i <= step && setStep(i)}
            aria-label={`Step ${i + 1}`}
          />
        ))}
      </div>

      {/* Steps */}
      {step === 0 && <StepWelcome stats={stats} onNext={goNext} />}
      {step === 1 && <StepInsiderTypes sampleFilings={sampleFilings} onNext={goNext} />}
      {step === 2 && <StepReadingFiling onNext={goNext} />}
      {step === 3 && <StepConviction onNext={goNext} />}
      {step === 4 && <StepDataMap onNext={goNext} />}
      {step === 5 && <StepWatchlist watchlist={watchlist} onNext={goNext} />}
      {step === 6 && <StepNotifications pro={pro} onNext={goNext} />}
      {step === 7 && <StepReady watchlist={watchlist} onComplete={handleComplete} />}
    </div>
  );
}

const STEP_NAMES = ['welcome', 'insider_types', 'reading_filing', 'conviction', 'data_map', 'watchlist', 'notifications', 'ready'];
