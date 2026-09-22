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
  { id: 'direction', label: 'Purchase (not a sale)',       points: 1, description: 'Sells are excluded from conviction scoring entirely — insiders sell for many reasons. A buy means the insider is putting their own money behind the stock.' },
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

function IconBuilding({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 22v-4h6v4" /><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
    </svg>
  );
}

function IconLandmark({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="3" y1="22" x2="21" y2="22" /><line x1="6" y1="18" x2="6" y2="11" /><line x1="10" y1="18" x2="10" y2="11" /><line x1="14" y1="18" x2="14" y2="11" /><line x1="18" y1="18" x2="18" y2="11" /><polygon points="12 2 20 7 4 7" /><line x1="2" y1="18" x2="22" y2="18" />
    </svg>
  );
}

function IconUserCheck({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

function IconBarChart({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}

function IconUsers({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconSettings({ size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconSun({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconMoon({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function IconHome({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function IconChevronLeft({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconChevronRight({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconChevronDown({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Theme toggle (reads/writes same localStorage key as app.jsx useTheme) ───
function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('theme'); if (s) return s === 'dark'; } catch (_) {}
    return true; // default dark, matches app.jsx
  });

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch (_) {}
  }

  return (
    <button className="ob__theme-toggle" onClick={toggle} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? <IconSun size={18} /> : <IconMoon size={18} />}
    </button>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────
function StepWelcome({ stats, onNext }) {
  function onHeadlineMove(e) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }

  return (
    <div className="ob-step ob-step--welcome">
      <div className="ob-welcome__content">
        <p className="ob-welcome__greeting">Welcome to Seli — let's walk you through the basics.</p>
        <h1
          className="ob-welcome__headline"
          onMouseMove={onHeadlineMove}
          onMouseEnter={e => e.currentTarget.classList.add('ob-welcome__headline--glow')}
          onMouseLeave={e => e.currentTarget.classList.remove('ob-welcome__headline--glow')}
        >
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
  const [activeCard, setActiveCard] = useState(null);

  const categories = [
    {
      id: 'corporate',
      title: 'Corporate Executives',
      tier: 'Strong signal',
      tagline: 'CEOs, CFOs, directors, and 10% owners filing SEC Form 4.',
      description: 'They file within 2 business days of any trade. Their access to material non-public information makes their trades the most informative.',
      Icon: IconBuilding,
    },
    {
      id: 'congress',
      title: 'Members of Congress',
      tier: 'Strong signal',
      tagline: 'Representatives and Senators disclosing under the STOCK Act.',
      description: 'House filings appear near-realtime; Senate disclosures often lag 30–45 days. Committee assignments can reveal sector-specific insight.',
      Icon: IconLandmark,
    },
    {
      id: 'officers',
      title: 'Other Officers',
      tier: 'Medium signal',
      tagline: 'VPs, SVPs, and other titled insiders required to disclose.',
      description: 'Their trades carry less weight in the conviction score — they\'re typically further from strategic decisions, but cluster patterns still matter.',
      Icon: IconUserCheck,
    },
  ];

  return (
    <div className="ob-step ob-step--insiders">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">The data sources</span>
        <h2 className="ob-step__title">Who are "insiders"?</h2>
        <p className="ob-step__subtitle">Seli tracks three categories of people whose trades become public record. Hover or tap for details.</p>
      </div>
      <div className="ob-insiders__grid">
        {categories.map(cat => {
          const isOpen = activeCard === cat.id;
          const sample = sampleFilings[cat.id];
          return (
            <button
              key={cat.id}
              className={`ob-insider-card${isOpen ? ' ob-insider-card--open' : ''}`}
              onClick={() => setActiveCard(isOpen ? null : cat.id)}
              onMouseEnter={() => setActiveCard(cat.id)}
              onMouseLeave={() => setActiveCard(null)}
            >
              <div className="ob-insider-card__top">
                <span className="ob-insider-card__icon"><cat.Icon size={20} /></span>
                <div className="ob-insider-card__text">
                  <div className="ob-insider-card__title">{cat.title}</div>
                  <div className="ob-insider-card__tier">{cat.tier}</div>
                </div>
              </div>
              <div className="ob-insider-card__tagline">{cat.tagline}</div>
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
    { id: 'name', label: 'Insider Name & Title', field: 'Jane Smith, CEO', factorId: 'role', points: 2, tooltip: 'C-suite trades carry the most weight. Their title determines relationship strength in the conviction score.' },
    { id: 'type', label: 'Transaction Type', field: 'Open-Market Purchase', factorId: 'market', points: 2, tooltip: 'Open-market buys are the most informative signal. Grants, exercises, and auto-plan trades are usually routine.' },
    { id: 'value', label: 'Value', field: '$2,450,000', factorId: 'value', points: 3, tooltip: 'The dollar amount of the trade. $1M+ trades get the highest value boost. Seli also shows % of position — how much of the insider\'s own holdings this trade represents.' },
    { id: 'routine', label: 'Routine Flag', field: 'Non-routine', factorId: 'routine', points: 3, tooltip: 'This trade is NOT on a pre-set 10b5-1 plan. The insider made a deliberate decision — this gets a +3 boost.' },
    { id: 'direction', label: 'Direction', field: 'Purchase', factorId: 'direction', points: 1, tooltip: 'Sells are excluded from conviction scoring entirely. A purchase means the insider is betting their own money — the only reason to buy.' },
  ];

  function toggleHotspot(hs) {
    setActiveHotspot(prev => prev === hs.id ? null : hs.id);
    setRevealedFactors(prev => {
      const next = new Set(prev);
      next.add(hs.factorId);
      return next;
    });
  }

  const currentScore = SIGNAL_FACTORS.filter(f => revealedFactors.has(f.id)).reduce((sum, f) => sum + f.points, 0);
  const allRevealed = revealedFactors.size === hotspots.length;

  return (
    <div className="ob-step ob-step--filing">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Understanding the data</span>
        <h2 className="ob-step__title">Reading a filing</h2>
        <p className="ob-step__subtitle">Click each row to see what it means — and watch the score build.</p>
      </div>

      <div className="ob-filing__card">
        <div className="ob-filing__card-header">
          <span className="ob-filing__card-badge">SEC Form 4</span>
          <span className="ob-filing__card-date">Filed Sep 19, 2026</span>
        </div>
        <div className="ob-filing__hotspots">
          {hotspots.map((hs, idx) => {
            const isActive = activeHotspot === hs.id;
            const isRevealed = revealedFactors.has(hs.factorId);
            // Only pulse the next-up hint after the user has clicked at least once
            const isNextUp = revealedFactors.size > 0 && !isRevealed && hotspots.findIndex(h => !revealedFactors.has(h.factorId)) === idx;
            return (
              <button
                key={hs.id}
                className={`ob-hotspot${isActive ? ' ob-hotspot--active' : ''}${isRevealed ? ' ob-hotspot--revealed' : ''}${isNextUp ? ' ob-hotspot--next' : ''}`}
                onClick={() => toggleHotspot(hs)}
              >
                <div className="ob-hotspot__row">
                  <div className="ob-hotspot__content">
                    <span className="ob-hotspot__label">{hs.label}</span>
                    <span className="ob-hotspot__field">{hs.field}</span>
                  </div>
                  <span className="ob-hotspot__indicator">
                    {isRevealed ? (
                      <IconCheck size={14} className="ob-hotspot__check" />
                    ) : (
                      <IconChevronRight size={14} className="ob-hotspot__chevron" />
                    )}
                  </span>
                </div>
                {/* Inline explanation — always in DOM, revealed via CSS transition */}
                <div className={`ob-hotspot__explain${isActive ? ' ob-hotspot__explain--open' : ''}`}>
                  <p>{hs.tooltip}</p>
                  <span className="ob-hotspot__points-tag">+{hs.points} conviction</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Standalone conviction score bar */}
      <div className={`ob-score-bar${allRevealed ? ' ob-score-bar--complete' : ''}`}>
        <div className="ob-score-bar__top">
          <span className="ob-score-bar__label">Conviction Score</span>
          <span className="ob-score-bar__value" key={currentScore}>
            {currentScore}<span className="ob-score-bar__max"> / 14</span>
          </span>
        </div>
        <div className="ob-score-bar__track">
          <div
            className="ob-score-bar__fill"
            style={{ width: `${(currentScore / 14) * 100}%` }}
          />
          {/* Threshold markers */}
          <span className="ob-score-bar__marker" style={{ left: '35.7%' }} title="Moderate (5)" />
          <span className="ob-score-bar__marker" style={{ left: '64.3%' }} title="Strong (9)" />
        </div>
        <div className="ob-score-bar__factors">
          {SIGNAL_FACTORS.map(f => (
            <span key={f.id} className={`ob-score-bar__chip${revealedFactors.has(f.id) ? ' ob-score-bar__chip--active' : ''}`}>
              {f.label} <strong>+{f.points}</strong>
            </span>
          ))}
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
  const [activeTier, setActiveTier] = useState(null);

  const tiers = [
    { id: 'high', range: '10–14', label: 'High Conviction', color: 'var(--green-600)', bg: 'var(--green-50)', tagline: 'Rare, high-confidence insider trades', description: 'C-suite or congressional, non-routine, open-market, large value. Rare and worth immediate attention.' },
    { id: 'medium', range: '6–9', label: 'Medium Conviction', color: 'var(--blue-600)', bg: 'var(--blue-50)', tagline: 'Multiple signal filters cleared', description: 'Meaningful trades that clear multiple signal filters. Worth monitoring and investigating further.' },
    { id: 'low', range: '3–5', label: 'Low Conviction', color: 'var(--amber-600)', bg: 'var(--amber-50)', tagline: 'Some signal, possibly routine', description: 'Some signal but may be routine, small, or from lower-ranked insiders. Useful for pattern-tracking.' },
    { id: 'noise', range: '0–2', label: 'Noise', color: 'var(--text-3)', bg: 'var(--surface-2)', tagline: 'Likely routine or automatic', description: 'Likely routine grants, small dispositions, or weak-relationship insiders. Seli still tracks them so you can filter them out.' },
  ];

  return (
    <div className="ob-step ob-step--conviction">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">The scoring system</span>
        <h2 className="ob-step__title">Conviction levels</h2>
        <p className="ob-step__subtitle">Every filing gets a score from 0 to 14. Hover or tap each level to learn more.</p>
      </div>
      <div className="ob-conviction__scale">
        {tiers.map(tier => (
          <div
            key={tier.id}
            className={`ob-conviction__tier${activeTier === tier.id ? ' ob-conviction__tier--active' : ''}`}
            style={{ '--tier-color': tier.color, '--tier-bg': tier.bg }}
            onMouseEnter={() => setActiveTier(tier.id)}
            onMouseLeave={() => setActiveTier(null)}
            onClick={() => setActiveTier(activeTier === tier.id ? null : tier.id)}
          >
            <div className="ob-conviction__badge" style={{ background: tier.bg, color: tier.color }}>
              {tier.range}
            </div>
            <div className="ob-conviction__info">
              <div className="ob-conviction__label" style={{ color: tier.color }}>{tier.label}</div>
              <div className="ob-conviction__tagline">{tier.tagline}</div>
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
  const [activeTab, setActiveTab] = useState('dashboard');

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', Icon: IconHome },
    { id: 'data', label: 'Data', Icon: IconBarChart },
    { id: 'insiders', label: 'Insiders', Icon: IconUsers },
    { id: 'watchlist', label: 'Watchlist', Icon: IconStar },
    { id: 'settings', label: 'Settings', Icon: IconSettings },
  ];

  const tabContent = {
    dashboard: {
      description: 'Your home base — a live snapshot of the most important insider activity right now.',
      preview: (
        <div className="ob-preview ob-preview--dashboard">
          <div className="ob-preview__stats">
            <div className="ob-preview__stat"><span className="ob-preview__stat-val">847</span><span className="ob-preview__stat-lbl">Filings today</span></div>
            <div className="ob-preview__stat"><span className="ob-preview__stat-val ob-preview__stat-val--green">23</span><span className="ob-preview__stat-lbl">High conviction</span></div>
            <div className="ob-preview__stat"><span className="ob-preview__stat-val">$42M</span><span className="ob-preview__stat-lbl">Total value</span></div>
          </div>
          <div className="ob-preview__feed">
            <div className="ob-preview__feed-row"><span className="ob-preview__ticker">NVDA</span><span className="ob-preview__name">Jensen Huang</span><span className="ob-preview__badge ob-preview__badge--buy">Buy</span><span className="ob-preview__amt">$12.4M</span></div>
            <div className="ob-preview__feed-row"><span className="ob-preview__ticker">AAPL</span><span className="ob-preview__name">Tim Cook</span><span className="ob-preview__badge ob-preview__badge--sell">Sell</span><span className="ob-preview__amt">$8.1M</span></div>
          </div>
        </div>
      ),
    },
    data: {
      description: 'Two views in one — scored signals grouped by conviction, and raw filings straight from the SEC. Filter by sector, source, date, and more.',
      preview: (
        <div className="ob-preview ob-preview--data">
          <div className="ob-preview__filters">
            <span className="ob-preview__chip ob-preview__chip--active">Signals</span>
            <span className="ob-preview__chip">Raw Filings</span>
            <span className="ob-preview__chip">High Conviction</span>
          </div>
          <div className="ob-preview__table">
            <div className="ob-preview__table-head"><span>Ticker</span><span>Insider</span><span>Type</span><span>Score</span></div>
            <div className="ob-preview__table-row"><span className="ob-preview__ticker">MSFT</span><span>Satya Nadella</span><span>Purchase</span><span className="ob-preview__score">92</span></div>
            <div className="ob-preview__table-row"><span className="ob-preview__ticker">GOOGL</span><span>Sundar Pichai</span><span>Purchase</span><span className="ob-preview__score">74</span></div>
            <div className="ob-preview__table-row"><span className="ob-preview__ticker">META</span><span>Mark Zuckerberg</span><span>Sale</span><span className="ob-preview__score ob-preview__score--low">—</span></div>
          </div>
        </div>
      ),
    },
    insiders: {
      description: 'Ranked leaderboard of insiders by track record and conviction accuracy. Click any name for their full trading history and trend.',
      preview: (
        <div className="ob-preview ob-preview--insiders">
          <div className="ob-preview__leaderboard">
            <div className="ob-preview__leader"><span className="ob-preview__rank">#1</span><span className="ob-preview__leader-name">Mark Cuban</span><span className="ob-preview__leader-title">Director</span><span className="ob-preview__accuracy">89%</span></div>
            <div className="ob-preview__leader"><span className="ob-preview__rank">#2</span><span className="ob-preview__leader-name">Lisa Su</span><span className="ob-preview__leader-title">CEO</span><span className="ob-preview__accuracy">84%</span></div>
            <div className="ob-preview__leader"><span className="ob-preview__rank">#3</span><span className="ob-preview__leader-name">Jamie Dimon</span><span className="ob-preview__leader-title">CEO</span><span className="ob-preview__accuracy">81%</span></div>
          </div>
        </div>
      ),
    },
    watchlist: {
      description: 'Activity for just the tickers you care about. You\'ll build yours in the next step.',
      preview: (
        <div className="ob-preview ob-preview--watchlist">
          <div className="ob-preview__tickers">
            <span className="ob-preview__ticker-chip">AAPL</span>
            <span className="ob-preview__ticker-chip">NVDA</span>
            <span className="ob-preview__ticker-chip">TSLA</span>
            <span className="ob-preview__ticker-chip ob-preview__ticker-chip--add">+ Add</span>
          </div>
          <div className="ob-preview__feed">
            <div className="ob-preview__feed-row"><span className="ob-preview__ticker">AAPL</span><span className="ob-preview__name">Jeff Williams</span><span className="ob-preview__badge ob-preview__badge--buy">Buy</span><span className="ob-preview__amt">$2.1M</span></div>
            <div className="ob-preview__feed-row"><span className="ob-preview__ticker">TSLA</span><span className="ob-preview__name">Robyn Denholm</span><span className="ob-preview__badge ob-preview__badge--sell">Sell</span><span className="ob-preview__amt">$5.8M</span></div>
          </div>
        </div>
      ),
    },
    settings: {
      description: 'Control how and when Seli reaches you — digest emails, real-time alerts, and more.',
      preview: (
        <div className="ob-preview ob-preview--settings">
          <div className="ob-preview__toggles">
            <div className="ob-preview__toggle-row"><span>Daily digest email</span><span className="ob-preview__switch ob-preview__switch--on" /></div>
            <div className="ob-preview__toggle-row"><span>High-conviction alerts</span><span className="ob-preview__switch ob-preview__switch--on" /></div>
            <div className="ob-preview__toggle-row"><span>Congressional trade alerts</span><span className="ob-preview__switch" /></div>
          </div>
        </div>
      ),
    },
  };

  return (
    <div className="ob-step ob-step--datamap">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Navigating the app</span>
        <h2 className="ob-step__title">Where the data lives</h2>
        <p className="ob-step__subtitle">Five pages, each with a different job. Tap to preview.</p>
      </div>

      {/* Tab bar */}
      <div className="ob-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`ob-tabs__tab${activeTab === tab.id ? ' ob-tabs__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.Icon size={18} />
            <span className="ob-tabs__label">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Preview panel */}
      <div className="ob-tabs__panel">
        <div className="ob-tabs__preview" key={activeTab}>
          {tabContent[activeTab].preview}
        </div>
        <p className="ob-tabs__desc">{tabContent[activeTab].description}</p>
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
function StepNotifications({ user, pro, onNext }) {
  const [digestOn, setDigestOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Persist the weekly digest preference to the real user_preferences table
  async function toggleDigest(enabled) {
    setDigestOn(enabled);
    if (!user?.id) return;
    setSaving(true);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.__clerkGetToken) {
        try {
          const token = await window.__clerkGetToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch {}
      }
      // Load existing prefs, merge, and save
      let existing = {};
      try {
        const cached = localStorage.getItem(`seli_prefs_${user.id}`);
        if (cached) existing = JSON.parse(cached);
      } catch {}
      const updated = { ...existing, weekly_digest: enabled };
      localStorage.setItem(`seli_prefs_${user.id}`, JSON.stringify(updated));
      await fetch(`${cfg.NEON_PROXY_URL}/prefs`, {
        method: 'POST', headers, body: JSON.stringify(updated),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  }

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
            <input type="checkbox" checked={digestOn} onChange={e => toggleDigest(e.target.checked)} disabled={saving} />
            <span className="ob-notif__toggle-track" />
            <span className="ob-notif__toggle-label">
              {saving ? 'Saving…' : saved ? 'Saved ✓' : digestOn ? 'Enabled' : 'Disabled'}
            </span>
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

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Skip button */}
      <button className="ob__skip" onClick={handleSkip}>
        Skip to dashboard →
      </button>

      {/* Step dots with prev/next arrows */}
      <div className="ob__dots-nav">
        <button
          className={`ob__dots-arrow${step === 0 ? ' ob__dots-arrow--hidden' : ''}`}
          onClick={() => step > 0 && setStep(step - 1)}
          aria-label="Previous step"
        >
          <IconChevronLeft size={16} />
        </button>
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
        <button
          className={`ob__dots-arrow${step === TOTAL_STEPS - 1 ? ' ob__dots-arrow--hidden' : ''}`}
          onClick={() => step < TOTAL_STEPS - 1 && goNext()}
          aria-label="Next step"
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* Steps */}
      {step === 0 && <StepWelcome stats={stats} onNext={goNext} />}
      {step === 1 && <StepInsiderTypes sampleFilings={sampleFilings} onNext={goNext} />}
      {step === 2 && <StepReadingFiling onNext={goNext} />}
      {step === 3 && <StepConviction onNext={goNext} />}
      {step === 4 && <StepDataMap onNext={goNext} />}
      {step === 5 && <StepWatchlist watchlist={watchlist} onNext={goNext} />}
      {step === 6 && <StepNotifications user={user} pro={pro} onNext={goNext} />}
      {step === 7 && <StepReady watchlist={watchlist} onComplete={handleComplete} />}
    </div>
  );
}

const STEP_NAMES = ['welcome', 'insider_types', 'reading_filing', 'conviction', 'data_map', 'watchlist', 'notifications', 'ready'];
