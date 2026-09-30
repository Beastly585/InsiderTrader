// src/onboard.jsx — Interactive onboarding flow for new Seli users
// Lives at seli.app/onboard — full-screen, no main nav, immersive.
// Skippable at any time. Writes to real watchlist on step 6.
import React, { useState, useEffect, useRef } from 'react';
import cfg from './config.js';
import { SearchBox } from './components/Search.jsx';
import { SCORE_TIERS, prettyPerson } from './lib/text.js';
// Styles live at the bottom of style.css (ob-* prefix) — no separate import needed.

// ── Constants ────────────────────────────────────────────────────────────────
const TOTAL_STEPS = 7;

// Popular tickers for the quick-add grid (step 6)
const POPULAR_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM',
  'V', 'UNH', 'JNJ', 'WMT', 'PG', 'MA', 'HD', 'BAC',
  'XOM', 'COST', 'ABBV', 'CRM', 'PFE', 'KO', 'MCD', 'DIS',
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


function IconX({ size = 16, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
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


// Touch screens fire mouseenter on tap, right before click. Cards that open on
// hover AND toggle on click would open then instantly close on a phone, so
// hover handlers only attach on devices that can actually hover.
const CAN_HOVER = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches;

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
        <p className="ob-welcome__greeting">Welcome to Seli. Let's walk you through the basics.</p>
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
      description: 'Their trades carry less weight in the conviction score. They\'re typically further from strategic decisions, but cluster patterns still matter.',
      Icon: IconUserCheck,
    },
  ];

  return (
    <div className="ob-step ob-step--insiders">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">The data sources</span>
        <h2 className="ob-step__title">Who are "insiders"?</h2>
        <p className="ob-step__subtitle">Seli tracks three categories of people whose trades become public record. {CAN_HOVER ? 'Hover or tap' : 'Tap a card'} for details.</p>
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
              onMouseEnter={CAN_HOVER ? () => setActiveCard(cat.id) : undefined}
              onMouseLeave={CAN_HOVER ? () => setActiveCard(null) : undefined}
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

// ── Step 3: What makes a filing stand out ─────────────────────────────────────
// The same facts the app and the emails call out on a real filing. No points
// or made-up arithmetic here: Seli's actual score is 0-100 (next step).
const STANDOUT = [
  { id: 'om', label: 'Open-market', field: 'Bought at market price, own money', why: 'Most insider stock arrives as grants and option exercises. An open-market buy is a choice to pay full price, which is why Seli leaves the rest out of summaries.' },
  { id: 'role', label: 'Who', field: 'CEO or CFO', why: 'Senior executives see the most of the business. Directors and VPs count too, just for less.' },
  { id: 'cluster', label: 'How many', field: '3 insiders in two weeks', why: 'When several insiders at one company buy within a few weeks it\'s called a cluster. Rarer than a single buy.' },
  { id: 'first', label: 'History', field: 'First buy in 4 years', why: 'A break from someone\'s usual pattern says more than a regular top-up.' },
  { id: 'stake', label: 'Stake change', field: '+38% stake', why: 'Shares bought compared with what they already held. The same dollar amount means more to someone with a small position.' },
  { id: 'plan', label: 'Timing', field: 'Not pre-scheduled', why: 'Trades set up months ahead under a 10b5-1 plan say less about what the insider thinks today.' },
];

function StepReadingFiling({ onNext }) {
  const [open, setOpen] = useState(new Set());
  const toggle = id => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOpen = open.size === STANDOUT.length;
  return (
    <div className="ob-step ob-step--filing">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Reading a filing</span>
        <h2 className="ob-step__title">What makes one stand out</h2>
        <p className="ob-step__subtitle">Thousands of insider trades are filed every week and most are routine. These are the things Seli looks for. Tap each one.</p>
      </div>
      <div className="ob-filing__card">
        <div className="ob-filing__card-header">
          <span className="ob-filing__card-badge">Example buy</span>
          <span className="ob-filing__card-date">SEC Form 4</span>
        </div>
        <div className="ob-filing__hotspots">
          {STANDOUT.map((f, idx) => {
            const isOpen = open.has(f.id);
            const isNext = open.size > 0 && !isOpen && STANDOUT.findIndex(x => !open.has(x.id)) === idx;
            return (
              <button key={f.id} className={`ob-hotspot${isOpen ? ' ob-hotspot--active ob-hotspot--revealed' : ''}${isNext ? ' ob-hotspot--next' : ''}`} onClick={() => toggle(f.id)}>
                <div className="ob-hotspot__row">
                  <div className="ob-hotspot__content">
                    <span className="ob-hotspot__label">{f.label}</span>
                    <span className="ob-hotspot__field">{f.field}</span>
                  </div>
                  <span className="ob-hotspot__indicator">{isOpen ? <IconCheck size={14} className="ob-hotspot__check" /> : <IconChevronRight size={14} className="ob-hotspot__chevron" />}</span>
                </div>
                <div className={`ob-hotspot__explain${isOpen ? ' ob-hotspot__explain--open' : ''}`}><p>{f.why}</p></div>
              </button>
            );
          })}
        </div>
      </div>
      <p className="ob-conviction__note">{allOpen ? 'That\'s the whole list. ' : ''}Stock pages and the weekly email point these out in plain English on real filings.</p>
      <button className="ob-cta" onClick={onNext}>Next: the score <IconArrowRight size={16} /></button>
    </div>
  );
}

// ── Step 4: The score ──────────────────────────────────────────────────────────
// Same 0-100 scale and labels as the app (src/lib/text.js SCORE_TIERS).
function StepConviction({ onNext }) {
  const [activeTier, setActiveTier] = useState(null);
  const colors = { High: ['var(--green-600)', 'var(--green-50)'], Medium: ['var(--accent)', 'var(--accent-50)'], Low: ['var(--text-2)', 'var(--surface-2)'] };
  const ranges = { High: '60–100', Medium: '35–59', Low: '1–34' };
  return (
    <div className="ob-step ob-step--conviction">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">One score</span>
        <h2 className="ob-step__title">Conviction, from 0 to 100</h2>
        <p className="ob-step__subtitle">Seli adds up those markers into one score for insider buying on each stock. {CAN_HOVER ? 'Hover or tap' : 'Tap'} a level.</p>
      </div>
      <div className="ob-conviction__scale">
        {SCORE_TIERS.map(tier => {
          const [color, bg] = colors[tier.label];
          return (
            <div key={tier.label}
              className={`ob-conviction__tier${activeTier === tier.label ? ' ob-conviction__tier--active' : ''}`}
              style={{ '--tier-color': color, '--tier-bg': bg }}
              onMouseEnter={CAN_HOVER ? () => setActiveTier(tier.label) : undefined}
              onMouseLeave={CAN_HOVER ? () => setActiveTier(null) : undefined}
              onClick={() => setActiveTier(activeTier === tier.label ? null : tier.label)}>
              <div className="ob-conviction__badge" style={{ background: bg, color }}>{ranges[tier.label]}</div>
              <div className="ob-conviction__info">
                <div className="ob-conviction__label" style={{ color }}>{tier.label}</div>
                <div className="ob-conviction__desc">{tier.blurb}</div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="ob-conviction__note">Sales aren't scored. Insiders sell for taxes, diversification and scheduled plans, so a sale on its own says little. Seli still shows every one.</p>
      <button className="ob-cta" onClick={onNext}>Next: pick what to watch <IconArrowRight size={16} /></button>
    </div>
  );
}

// ── Step 5: Watch stocks and people ─────────────────────────────────────────────
function StepWatchlist({ watchlist, onNext }) {
  const tickers = watchlist.tickers;
  const people = watchlist.insiders || [];
  const count = tickers.length + people.length;
  const limit = watchlist.pro ? null : watchlist.freeLimit;
  return (
    <div className="ob-step ob-step--watchlist">
      <div className="ob-step__header">
        <span className="ob-step__eyebrow">Get personal</span>
        <h2 className="ob-step__title">What do you want to watch?</h2>
        <p className="ob-step__subtitle">Stocks you own or follow, or people you want to keep tabs on. They show up first in the app and in your email.{limit ? ` Free accounts watch up to ${limit}.` : ''}</p>
      </div>

      <div className="ob-watchlist__search-wrap">
        <SearchBox mode="pick" variant="inline" watchlist={watchlist} placeholder="Search a ticker, company or person"
          onPick={it => {
            const on = it.kind === 'stock' ? watchlist.hasTicker(it.id) : watchlist.hasInsider(it.id);
            if (!on) (it.kind === 'stock' ? watchlist.toggleTicker(it.id) : watchlist.toggleInsider(it.id));
          }} />
      </div>

      <div className="ob-watchlist__popular">
        <div className="ob-watchlist__popular-label">Popular. Tap to add</div>
        <div className="ob-watchlist__popular-grid">
          {POPULAR_TICKERS.slice(0, 16).map(ticker => {
            const on = tickers.includes(ticker);
            return (
              <button key={ticker} className={`ob-watchlist__chip${on ? ' ob-watchlist__chip--added' : ''}`} onClick={() => watchlist.toggleTicker(ticker)}>
                {ticker}{on && <IconCheck size={12} />}
              </button>
            );
          })}
        </div>
      </div>

      {count > 0 && (
        <div className="ob-watchlist__current">
          <div className="ob-watchlist__current-header">
            <span className="ob-watchlist__current-label"><IconBell size={14} /> Watching {count}{limit ? ` of ${limit}` : ''}</span>
          </div>
          <div className="ob-watchlist__current-tickers">
            {tickers.map(t => (
              <span key={t} className="ob-watchlist__current-tag">{t}
                <button className="ob-watchlist__current-remove" onClick={() => watchlist.toggleTicker(t)} aria-label={`Remove ${t}`}><IconX size={10} /></button>
              </span>
            ))}
            {people.map(n => (
              <span key={n} className="ob-watchlist__current-tag ob-watchlist__current-tag--person">{prettyPerson(n)}
                <button className="ob-watchlist__current-remove" onClick={() => watchlist.toggleInsider(n)} aria-label="Remove"><IconX size={10} /></button>
              </span>
            ))}
          </div>
        </div>
      )}

      <button className="ob-cta" onClick={onNext}>
        {count ? <>Next: emails <IconArrowRight size={16} /></> : <>Skip for now <IconArrowRight size={16} /></>}
      </button>
    </div>
  );
}

// ── Step 7: Notifications ────────────────────────────────────────────────────
function StepNotifications({ user, pro, onNext, digestOn: digestOnProp = true, onDigestChange }) {
  const [digestOn, setDigestOn] = useState(digestOnProp);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // Persist the weekly digest choice. /prefs/digest works for free users and
  // only touches weekly_digest. The old version POSTed a localStorage-merged
  // body to /prefs, which 403s for free users (Pro-only route) and, for Pro
  // users with an empty cache, overwrote every other setting with FALSE.
  // It also never checked the response, so it showed "Saved" either way.
  async function toggleDigest(enabled) {
    const prev = digestOn;
    setDigestOn(enabled);
    onDigestChange?.(enabled);
    if (!user?.id) return;
    setSaving(true); setSaveError(false);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.__clerkGetToken) {
        try { const token = await window.__clerkGetToken(); if (token) headers['Authorization'] = `Bearer ${token}`; } catch {}
      }
      const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs/digest`, {
        method: 'POST', headers, body: JSON.stringify({ weekly_digest: enabled }),
      });
      if (!res.ok) throw new Error(`prefs/digest ${res.status}`);
      try {
        const key = `seli_prefs_${user.id}`;
        const cached = JSON.parse(localStorage.getItem(key) || '{}');
        localStorage.setItem(key, JSON.stringify({ ...cached, weekly_digest: enabled }));
      } catch {}
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setDigestOn(prev); onDigestChange?.(prev); setSaveError(true);
    }
    setSaving(false);
  }

  const proAlerts = [
    { id: 'watchlist', label: 'Anything you watch', description: 'An email the day a new filing lands for a stock or person you watch.' },
    { id: 'conviction', label: 'Big executive buys', description: 'A CEO, CFO or other C-suite executive buys a lot of any stock.' },
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
          <p className="ob-notif__tier-desc">One email every Sunday evening: what insiders did with everything you watch (even in quiet weeks), plus the week's most notable insider buying and why it stands out.</p>
          <label className="ob-notif__toggle">
            <input type="checkbox" checked={digestOn} onChange={e => toggleDigest(e.target.checked)} disabled={saving} />
            <span className="ob-notif__toggle-track" />
            <span className="ob-notif__toggle-label">
              {saving ? 'Saving…' : saveError ? "Couldn't save, try again" : saved ? 'Saved ✓' : digestOn ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>

        {/* Pro tier */}
        <div className={`ob-notif__tier ob-notif__tier--pro${!pro ? ' ob-notif__tier--locked' : ''}`}>
          <div className="ob-notif__tier-header">
            <span className="ob-notif__tier-badge ob-notif__tier-badge--pro">Pro</span>
            <span className="ob-notif__tier-title">Instant Alerts</span>
          </div>
          <p className="ob-notif__tier-desc">Same-day emails when a new filing lands, plus a daily digest.</p>
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
          <div className="ob-notif__portfolio-note">
            Link your brokerage in Account and your holdings get the same treatment as what you watch.
          </div>
          {!pro && (
            <div className="ob-notif__pro-cta">
              Pro is $6.99/mo. You can upgrade anytime from Account.
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

// ── Step 8: You're All Set ──────────────────────────────────────────────────
function StepReady({ watchlist, onComplete }) {
  const n = watchlist.tickers.length + (watchlist.insiders || []).length;
  return (
    <div className="ob-step ob-step--ready">
      <div className="ob-step__header">
        <h2 className="ob-step__title ob-ready__title">You're all set</h2>
        <p className="ob-step__subtitle">
          {n > 0 ? `You're watching ${n} ${n === 1 ? 'thing' : 'things'}. Home shows what insiders did with them first.` : 'Watch anything from its page, or from your Watchlist.'}
        </p>
      </div>
      {watchlist.tickers.length > 0 && (
        <div className="ob-ready__tickers">
          {watchlist.tickers.map(t => <span key={t} className="ob-ready__ticker">{t}</span>)}
        </div>
      )}
      <p className="ob-ready__guide-note">
        Look up any stock or person with the search box at the top. Press <kbd>/</kbd> to jump to it.
      </p>
      <button className="ob-cta ob-cta--primary" onClick={onComplete}>
        Go to Seli <IconArrowRight size={16} />
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
      if (saved != null) return Math.min(parseInt(saved, 10) || 0, TOTAL_STEPS - 1);
    } catch {}
    return 0;
  });
  const [stats, setStats] = useState({});
  const [sampleFilings, setSampleFilings] = useState({});
  const [digestOn, setDigestOn] = useState(true);
  const containerRef = useRef(null);

  // Tell the Worker onboarding is done (or skipped) and what the digest
  // toggle ended up as. This is what makes sure a prefs row exists with a
  // real email even if the Clerk webhook didn't fire, and it's the
  // onboarded_at the welcome email uses to pick "/watchlist" vs "/onboard".
  // Fire-and-forget with keepalive so navigating away doesn't cancel it.
  async function reportOnboardDone(skipped) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.__clerkGetToken) {
        try { const token = await window.__clerkGetToken(); if (token) headers['Authorization'] = `Bearer ${token}`; } catch {}
      }
      fetch(`${cfg.NEON_PROXY_URL}/onboard/complete`, {
        method: 'POST', headers, keepalive: true,
        body: JSON.stringify({ skipped, weekly_digest: digestOn }),
      }).catch(() => {});
    } catch {}
  }

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
          corporate: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM public.filings WHERE relationship = 'strong' AND transaction_type = 'buy' AND value > 100000 ORDER BY filing_date DESC LIMIT 1`,
          congress: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM public.filings WHERE source = 'congress' ORDER BY filing_date DESC LIMIT 1`,
          officers: `SELECT insider_name, ticker, company_name, transaction_type, value, filing_date FROM public.filings WHERE relationship = 'medium' ORDER BY filing_date DESC LIMIT 1`,
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
    reportOnboardDone(false);
    try { localStorage.removeItem('seli_onboard_step'); } catch {}
    try {
      if (window.posthog) {
        window.posthog.capture('onboarding_completed', { tickers_added: watchlist.tickers.length, people_added: (watchlist.insiders || []).length });
      }
    } catch {}
    onComplete();
  }

  function handleSkip() {
    reportOnboardDone(true);
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

      {/* Top bar: theme toggle + skip. Transparent on desktop, solid on mobile. */}
      <div className="ob__topbar">
        <ThemeToggle />
        <button className="ob__skip" onClick={handleSkip}>
          Skip to Seli →
        </button>
      </div>

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
      {step === 4 && <StepWatchlist watchlist={watchlist} onNext={goNext} />}
      {step === 5 && <StepNotifications user={user} pro={pro} onNext={goNext} digestOn={digestOn} onDigestChange={setDigestOn} />}
      {step === 6 && <StepReady watchlist={watchlist} onComplete={handleComplete} />}
    </div>
  );
}

const STEP_NAMES = ['welcome', 'insider_types', 'standout', 'score', 'watchlist', 'notifications', 'ready'];
