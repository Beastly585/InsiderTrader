import React, { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';
import logoSimple from './assets/logo-simple.png';
import { isPro, buildSignals, processLeaderboardRows, RISK_APPETITE_THRESHOLDS, RISK_APPETITE_LABELS, tierFromPct, filterAndScoreSignals } from './lib/scoring.js';
import { fmt } from './lib/format.js';
import { useAuth, useUser, useClerk, SignInButton, SignedIn, SignedOut } from '@clerk/clerk-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
// src/app.jsx — Seli — insider trading intelligence platform
// const { useState, useEffect, useMemo, useCallback, useRef } = React;
import cfg from './config.js';
import { loadFilings, getSector, REL_LABELS, secFilingUrl } from './edgar.js';
import OnboardingFlow from './onboard.jsx';
import './research.css';
import { go, stockPath, insiderPath } from './lib/nav.jsx';
import { clearApiCache } from './lib/api.js';
import { SearchBox, SearchOverlay } from './components/Search.jsx';
import { Icon, Card } from './components/ui.jsx';
import StockPage from './pages/StockPage.jsx';
import InsiderPage from './pages/InsiderPage.jsx';
import HomeFeed from './pages/HomeFeed.jsx';
import WatchlistPage from './pages/WatchlistPage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';

// ─── Utilities ────────────────────────────────────────────────────────────────
// (fmt now lives in src/lib/format.js — imported above — with real test
// coverage for the exact date-parsing bug class that hit three times this
// session, rather than living inline and untested here.)

// ── Role abbreviation ─────────────────────────────────────────────────────────
// Insider titles from SEC filings are verbose ("Chief Executive Officer",
// "Executive Vice President and Chief Financial Officer"). Abbreviate for
// compact display in profile headers and affiliation lists.
function shortRole(title) {
  if (!title) return '';
  let t = title;
  // Full title → abbreviation replacements (order matters — longest first)
  t = t.replace(/Chief Executive Officer/gi, 'CEO');
  t = t.replace(/Chief Financial Officer/gi, 'CFO');
  t = t.replace(/Chief Operating Officer/gi, 'COO');
  t = t.replace(/Chief Technology Officer/gi, 'CTO');
  t = t.replace(/Chief Information Officer/gi, 'CIO');
  t = t.replace(/Chief Marketing Officer/gi, 'CMO');
  t = t.replace(/Chief Strategy Officer/gi, 'CSO');
  t = t.replace(/Chief Legal Officer/gi, 'CLO');
  t = t.replace(/Chief Revenue Officer/gi, 'CRO');
  t = t.replace(/Chief People Officer/gi, 'CPO');
  t = t.replace(/Chief Compliance Officer/gi, 'CCO');
  t = t.replace(/Executive Vice President/gi, 'EVP');
  t = t.replace(/Senior Vice President/gi, 'SVP');
  t = t.replace(/Vice President/gi, 'VP');
  t = t.replace(/General Counsel/gi, 'GC');
  t = t.replace(/Chairman of the Board/gi, 'Chairman');
  t = t.replace(/President and CEO/gi, 'President & CEO');
  t = t.replace(/\band\b/gi, '&');
  // Clean up double spaces, trailing commas
  t = t.replace(/\s{2,}/g, ' ').replace(/,\s*$/, '').trim();
  return t;
}

// ─── Company profile cache & hooks ───────────────────────────────────────────
// Module-level cache so the same ticker only hits Finnhub once per page load.
const _profileCache = {};
const _descCache = {};

async function fetchCompanyProfile(ticker) {
  if (_profileCache[ticker]) return _profileCache[ticker];
  if (!cfg.NEON_PROXY_URL) return null;
  try {
    const r = await fetch(`${cfg.NEON_PROXY_URL}/finnhub/profile?symbol=${encodeURIComponent(ticker)}`, { headers: await getAuthHeaders() });
    const d = await r.json();
    _profileCache[ticker] = (d && d.name) ? d : null;
    return _profileCache[ticker];
  } catch { return null; }
}

async function fetchCompanyMetrics(ticker) {
  if (!cfg.NEON_PROXY_URL) return null;
  try {
    const r = await fetch(`${cfg.NEON_PROXY_URL}/finnhub/metrics?symbol=${encodeURIComponent(ticker)}`, { headers: await getAuthHeaders() });
    const d = await r.json();
    return d?.metric || null;
  } catch { return null; }
}

async function fetchCompanyDescription(ticker, cik) {
  const key = cik || ticker;
  if (_descCache[key] !== undefined) return _descCache[key];
  try {
    // EDGAR submissions endpoint — free, no key, returns description for most companies.
    // CIK must be zero-padded to 10 digits.
    if (cik) {
      const padded = String(cik).replace(/^0+/, '').padStart(10, '0');
      const r = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
        headers: { 'User-Agent': 'Seli research@seli.app' }
      });
      if (r.ok) {
        const d = await r.json();
        const desc = d?.description || null;
        _descCache[key] = desc;
        return desc;
      }
    }
  } catch { }
  _descCache[key] = null;
  return null;
}

// React hook — fetches profile + metrics + description for a ticker, returns
// loading state and the combined data object.
function useCompanyProfile(ticker, cik) {
  const [profile, setProfile] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [desc, setDesc] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!ticker) { setLoading(false); return; }
    setLoading(true); setProfile(null); setMetrics(null); setDesc(null);
    Promise.all([
      fetchCompanyProfile(ticker),
      fetchCompanyMetrics(ticker),
      fetchCompanyDescription(ticker, cik),
    ]).then(([p, m, d]) => {
      setProfile(p); setMetrics(m); setDesc(d); setLoading(false);
    }).catch(() => setLoading(false));
  }, [ticker, cik]);
  return { profile, metrics, desc, loading };
}

// ─── Watchlist utilities ──────────────────────────────────────────────────────
// Stored in localStorage as a JSON array of ticker strings.
// No auth needed — entirely client-side.
// ─── Pro plan check ───────────────────────────────────────────────────────────
// BillingContext fetches /billing/status from the Worker (Neon) on mount.
// plan === 'pro' is the source of truth — covers Stripe subscribers and
// manually comped users. Clerk metadata is the instant pre-fetch hint.

const BillingContext = createContext({ pro: false, hasDataExport: false, billingStatus: null, refreshBilling: () => { } });

function BillingProvider({ children }) {
  const { user } = useUser();
  const { isSignedIn } = useAuth();
  const clerkPro = user?.publicMetadata?.plan === 'pro';
  const clerkExport = !!user?.publicMetadata?.hasDataExport;
  const [billingStatus, setBillingStatus] = useState(null);
  const [fetchedPro, setFetchedPro] = useState(null);
  const [fetchedExport, setFetchedExport] = useState(null);

  const fetchBilling = useCallback(async () => {
    if (!cfg.NEON_PROXY_URL || !isSignedIn) return;
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/billing/status`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      setBillingStatus(data);
      setFetchedPro(data.plan === 'pro');
      setFetchedExport(!!data.hasDataExport);
    } catch { }
  }, [isSignedIn]);

  useEffect(() => { fetchBilling(); }, [fetchBilling]);

  const pro = fetchedPro !== null ? fetchedPro : clerkPro;
  const hasDataExport = fetchedExport !== null ? fetchedExport : clerkExport;

  return (
    <BillingContext.Provider value={{ pro, hasDataExport, billingStatus, refreshBilling: fetchBilling }}>
      {children}
    </BillingContext.Provider>
  );
}

function useBilling() { return useContext(BillingContext); }


// ─── Upgrade modal ────────────────────────────────────────────────────────────
const PRO_PRICE_DISPLAY = '$6.99';
const PRO_PRICE_LABEL = '$6.99/mo';

// Shown when a free user tries to use a Pro feature.
// Comparison-table style, matching the reference layout's structure:
// logo, title, Free/Pro feature comparison, a plan selector, one CTA.
// Deliberately NOT including a fake testimonial/star-rating like the
// reference had — Seli doesn't have real customer reviews yet, and
// fabricating one would be dishonest. That visual slot is an honest
// trust line instead.
function UpgradeModal({ feature, pro, onClose }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const [checkoutProduct, setCheckoutProduct] = useState(null); // null | 'pro' | 'data_export'
  const [plan, setPlan] = useState(feature === 'data_export' || feature === 'data_export_direct' ? 'data_export' : 'pro'); // which card is selected in the picker
  const [statusModal, setStatusModal] = useState(null);
  const [processing, setProcessing] = useState(false); // true for the gap between payment succeeding and the confirmation being ready
  const [progressText, setProgressText] = useState(null); // live row-count updates during a large export

  // Direct checkout: skip the comparison modal and go straight to Stripe.
  // Explicit: 'data_export_direct' and 'pro_direct' always go direct.
  // Mobile: ANY Pro-intent feature skips the comparison modal on phones —
  // there isn't enough screen space for Free vs Pro side-by-side, and the
  // user already clicked a contextual "Go Pro" / "Upgrade" button so they
  // know what they're buying. The comparison is still useful on desktop
  // where it's a side-by-side layout and the trigger might be less specific.
  const isMobileModal = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
  const proIntentFeatures = ['default', 'watchlist', 'watchlist_ticker', 'watchlist_insider', 'notifications', 'portfolio', 'full_history'];
  useEffect(() => {
    if (feature === 'data_export_direct') setCheckoutProduct('data_export');
    else if (feature === 'pro_direct') setCheckoutProduct('pro');
    else if (isMobileModal && proIntentFeatures.includes(feature)) setCheckoutProduct('pro');
  }, [feature]);

  // Outcome-oriented messages — tell the user what changes for them, not
  // what features they unlock.
  const FEATURE_MESSAGES = {
    watchlist_ticker: "You're watching 3 things, the free limit. Pro watches as many stocks and people as you like, and emails you the same day they file.",
    watchlist_insider: "You're watching 3 things, the free limit. Pro watches as many stocks and people as you like, and emails you the same day they file.",
    notifications: 'Set it and forget it. Pro sends you email digests and instant alerts — you only open Seli when something happens.',
    portfolio: "Link your brokerage and Seli watches every stock you own. You'll know about insider moves before the market reacts.",
    data_export: 'Get a one-time CSV export of the full historical dataset — no subscription required.',
    full_history: 'Free shows 12 months. Pro unlocks the full picture — every filing back to 2010, so you see the patterns that matter.',
    my_news: 'My News filters headlines to only the tickers and insiders you follow. Set it up once, and your feed shows only what matters to you.',
    default: 'Tell Seli what to watch. It does the rest.',
  };
  const subtitle = FEATURE_MESSAGES[feature] || FEATURE_MESSAGES.default;

  // Modal variants — same shell, different narrative based on what triggered it.
  // "Never miss a trade" for watchlist/alert triggers, "See the full picture"
  // for data/history triggers, "Make it yours" for portfolio/personalization.
  const MODAL_VARIANTS = {
    alert: {
      title: 'Never miss a trade again',
      outcomes: [
        { step: '1', text: 'Pick the stocks, insiders, or politicians you care about' },
        { step: '2', text: 'Seli monitors every Form 4 — 24/7, automatically' },
        { step: '3', text: 'Get alerted before the market reacts' },
      ],
      cta: 'Start watching',
    },
    data: {
      title: 'See the full picture',
      outcomes: [
        { step: '1', text: 'Unlock every filing back to 2010, not just 12 months' },
        { step: '2', text: 'Filter by insider, sector, trade size, and score' },
        { step: '3', text: 'Spot patterns that only show up over years' },
      ],
      cta: 'Unlock full data',
    },
    personalize: {
      title: 'Make it yours',
      outcomes: [
        { step: '1', text: 'Link your brokerage — Seli watches your portfolio' },
        { step: '2', text: 'Follow insiders and get notified when they trade' },
        { step: '3', text: 'Your watchlist, your alerts, one view' },
      ],
      cta: 'Personalize Seli',
    },
  };

  // Map each feature key to the right variant
  const FEATURE_TO_VARIANT = {
    watchlist_ticker: 'alert', watchlist_insider: 'alert', notifications: 'alert', alerts: 'alert', default: 'alert',
    full_history: 'data', data_explorer: 'data', insider_detail: 'data',
    portfolio: 'personalize', watchlist_limit: 'personalize', my_news: 'personalize',
  };

  const variant = MODAL_VARIANTS[FEATURE_TO_VARIANT[feature] || 'alert'];
  const OUTCOMES = variant.outcomes;

  if (processing) {
    return <ProcessingModal text={progressText || (checkoutProduct === 'pro' ? 'Setting up your subscription…' : 'Finalizing your purchase…')} />;
  }

  if (statusModal) {
    return (
      <StatusModal
        title={statusModal.title}
        message={statusModal.message}
        onClose={() => { setStatusModal(null); onClose(); }}
      />
    );
  }

  if (checkoutProduct) {
    return (
      <CheckoutModal
        product={checkoutProduct}
        onClose={() => { setCheckoutProduct(null); if (feature === 'data_export_direct' || feature === 'pro_direct' || (isMobileModal && proIntentFeatures.includes(feature))) onClose(); }}
        onSuccess={async () => {
          const wasPro = checkoutProduct === 'pro';
          setProcessing(true);
          if (wasPro) {
            setCheckoutProduct(null);
            setProcessing(false);
            setStatusModal({ type: 'pro', title: "You're a Pro member!" });
            return;
          }
          // Data export — the whole point of paying for this is getting the
          // file, not being told where to go click a different button for
          // it. Start the download immediately, then confirm what happened.
          try {
            await downloadCSVFromR2('consume', msg => setProgressText(msg));
            setCheckoutProduct(null);
            setProcessing(false);
            setProgressText(null);
            setStatusModal({ title: 'Export started', message: 'Your download should begin automatically. Lost the file later? Re-download it anytime at seli.app/redownload, at no extra charge.' });
          } catch (e) {
            setCheckoutProduct(null);
            setProcessing(false);
            setProgressText(null);
            setStatusModal({ title: 'Purchase complete — download failed', message: `Your payment went through, but the download itself hit an error (${e.message}). Your purchase is saved. Go to seli.app/redownload to get your file, no extra charge.` });
          }
        }}
      />
    );
  }

  // Data export is its own $39.99 one-time product, separate from the Pro
  // subscription — anyone can buy it, free or Pro. Show the focused export
  // modal instead of the dual Free/Pro comparison.
  if (feature === 'data_export') {
    return (
      <div className="upgrade-overlay" onClick={e => { if (e.target.classList.contains('upgrade-overlay')) onClose(); }}>
        <div className="upgrade-modal upgrade-modal--narrative">
          <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{ width: 12, height: 12 }} /></button>

          <div className="upgrade-narrative__header">
            <div className="logo-mark upgrade-modal__logo"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <h2 className="upgrade-narrative__title">Own the data</h2>
            <p className="upgrade-narrative__sub">The only place to get every SEC Form 4 filing in one clean CSV. No scraping, no cleaning, no API — just download and go.</p>
          </div>

          <div className="upgrade-narrative__outcomes">
            <div className="upgrade-narrative__outcome">
              <span className="upgrade-narrative__step-num">1</span>
              <span className="upgrade-narrative__outcome-text">Every insider filing on record — one click, one file</span>
            </div>
            <div className="upgrade-narrative__outcome">
              <span className="upgrade-narrative__step-num">2</span>
              <span className="upgrade-narrative__outcome-text">Opens in Excel, Google Sheets, Python, R — whatever you use</span>
            </div>
            <div className="upgrade-narrative__outcome">
              <span className="upgrade-narrative__step-num">3</span>
              <span className="upgrade-narrative__outcome-text">Buy again anytime for a fresh pull with the latest filings</span>
            </div>
          </div>

          <div className="upgrade-narrative__cta-section">
            <button className="upgrade-modal__cta" onClick={() => setCheckoutProduct('data_export')}>Download — $39.99 one-time</button>
          </div>

          <div className="upgrade-modal__trust">
            <span><IconCheck style={{ width: 11, height: 11, marginRight: 3, verticalAlign: '-1px' }} />Secure checkout via Stripe</span>
            <span><IconCheck style={{ width: 11, height: 11, marginRight: 3, verticalAlign: '-1px' }} />No subscription</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="upgrade-overlay" onClick={e => { if (e.target.classList.contains('upgrade-overlay')) onClose(); }}>
      <div className="upgrade-modal upgrade-modal--narrative">
        <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{ width: 12, height: 12 }} /></button>

        {/* Narrative header */}
        <div className="upgrade-narrative__header">
          <div className="logo-mark upgrade-modal__logo"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
          <h2 className="upgrade-narrative__title">{variant.title}</h2>
          <p className="upgrade-narrative__sub">{subtitle}</p>
        </div>

        {/* Three steps */}
        <div className="upgrade-narrative__outcomes">
          {OUTCOMES.map((o, i) => (
            <div className="upgrade-narrative__outcome" key={i}>
              <span className="upgrade-narrative__step-num">{o.step}</span>
              <span className="upgrade-narrative__outcome-text">{o.text}</span>
            </div>
          ))}
        </div>

        {/* Price + CTA */}
        <div className="upgrade-narrative__cta-section">
          <button className="upgrade-modal__cta" onClick={() => setCheckoutProduct('pro')}>
            {variant.cta} — {PRO_PRICE_LABEL}
          </button>
        </div>

        <div className="upgrade-modal__trust">
          <span><IconCheck style={{ width: 11, height: 11, marginRight: 3, verticalAlign: '-1px' }} />Secure checkout via Stripe</span>
          <span><IconCheck style={{ width: 11, height: 11, marginRight: 3, verticalAlign: '-1px' }} />Cancel anytime</span>
        </div>

        <button className="upgrade-narrative__alt-link" onClick={() => setCheckoutProduct('data_export')}>
          Or just the dataset — $39.99 one-time →
        </button>
      </div>
    </div>
  );
}

// ─── Checkout (Stripe Elements) ────────────────────────────────────────────────
// Handles BOTH products — Pro subscription and the one-time data export.
// Same component either way: the backend returns a client_secret regardless
// of whether it's backing a Subscription's PaymentIntent or a standalone one,
// and Elements mounts the right payment UI automatically from that secret.
let _stripePromise = null;
function getStripePromise() {
  if (!_stripePromise) _stripePromise = loadStripe(cfg.STRIPE_PUBLISHABLE_KEY);
  return _stripePromise;
}

const PRODUCT_COPY = {
  pro: {
    title: 'Seli Pro', price: `${PRO_PRICE_DISPLAY}/month`, endpoint: '/billing/create-subscription',
    subtitle: 'Full insider data, real-time alerts, and your own watchlist — in one view.',
    features: ['Full historical data', 'Portfolio linking', 'Instant alerts'],
  },
  data_export: {
    title: 'Own the data', price: '$39.99 one-time', endpoint: '/billing/create-data-purchase',
    subtitle: 'Every SEC Form 4 filing in one clean CSV — download and go.',
    features: ['Every filing on record', 'Delivered as CSV', 'Re-purchase anytime for a fresh pull'],
  },
};

// ─── Confirm dialog — reusable "are you sure?" pattern ────────────────────────
// ─── Processing modal — covers the real gap between "payment succeeded"
// and "we know what to tell you" (e.g. the export download itself is still
// in flight). Previously that gap had no modal at all: checkoutProduct was
// cleared immediately, but statusModal wasn't set until after an await
// resolved, so there was a render in between where neither was true and
// the component fell through to the underlying pricing picker — which is
// exactly the "flashes back to the original modal" bug this replaces.
// No close button on purpose — nothing to cancel mid-flight.
function ProcessingModal({ text = 'Finishing up…' }) {
  return (
    <div className="upgrade-overlay">
      <div className="upgrade-modal" style={{ maxWidth: 300, textAlign: 'center' }}>
        <div className="processing-dots"><span /><span /><span /></div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 16 }}>{text}</p>
      </div>
    </div>
  );
}

// ─── Status modal — reusable success/confirmation pattern ─────────────────────
function StatusModal({ type, title, message, onClose }) {
  const isPro = type === 'pro';
  return (
    <div className="upgrade-overlay" onClick={e => { if (e.target.classList.contains('upgrade-overlay')) onClose(); }}>
      <div className="upgrade-modal" style={{ maxWidth: isPro ? 480 : 420, textAlign: 'center', padding: isPro ? '40px 36px 32px' : undefined }}>
        {isPro ? (
          <>
            <div className="logo-mark" style={{ width: 44, height: 44, margin: '0 auto 16px' }}><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <div className="status-modal__icon" style={{ margin: '0 auto 16px' }}><IconCheck style={{ width: 22, height: 22 }} /></div>
            <div className="upgrade-modal__title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>{title}</div>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 24 }}>
              Your founding member rate is locked in. Here's what's unlocked:
            </p>
            <div style={{ textAlign: 'left', background: 'var(--surface-2)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px 20px', marginBottom: 24 }}>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  ['Full historical data', '2010→present, every filed SEC insider trade'],
                  ['Portfolio linking', 'Connect your brokerage to see insider activity on your holdings'],
                  ['Instant alerts', 'Get notified the moment insiders trade your watched tickers'],
                  ['Full score breakdown', 'See conviction scoring on every signal'],
                  ['Insiders deep-dive', 'Complete leaderboard with filters and hit-rate analysis'],
                ].map(([feat, desc]) => (
                  <li key={feat} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--green-600)', marginTop: 2, flexShrink: 0 }}><IconCheck style={{ width: 14, height: 14 }} /></span>
                    <span>
                      <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text)', display: 'block' }}>{feat}</span>
                      <span style={{ fontSize: '0.6875rem', color: 'var(--text-3)' }}>{desc}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <button className="upgrade-modal__cta" style={{ width: '100%' }} onClick={onClose}>Start exploring</button>
          </>
        ) : (
          <>
            <div className="status-modal__icon"><IconCheck style={{ width: 20, height: 20 }} /></div>
            <div className="upgrade-modal__title" style={{ marginTop: 14 }}>{title}</div>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, margin: '8px 0 20px' }}>{message}</p>
            <button className="upgrade-modal__cta" style={{ margin: 0 }} onClick={onClose}>Done</button>
          </>
        )}
      </div>
    </div>
  );
}

function CheckoutModal({ product, onClose, onSuccess }) {
  const { user } = useUser();
  const [clientSecret, setClientSecret] = useState(null);
  const [error, setError] = useState(null);
  // True only for the reactivation path below — there's no payment step,
  // just a wait for Stripe's webhook to land.
  const [reactivating, setReactivating] = useState(false);
  const copy = PRODUCT_COPY[product];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
        const res = await fetch(`${cfg.NEON_PROXY_URL}${copy.endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email: user?.primaryEmailAddress?.emailAddress }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Could not start checkout');
        if (data.reactivated) {
          // An existing subscription was resumed server-side instead of a
          // new one being created (see handleCreateSubscription's
          // reactivation path) — there's no payment to confirm, so this
          // skips the Elements/card form entirely. But it still has to wait
          // out the same webhook race CheckoutForm.handleConfirm() below
          // already handles for a normal payment: Stripe's API call
          // returning doesn't mean Clerk's publicMetadata (what the rest of
          // the app reads to know someone's Pro) is updated yet — only the
          // async customer.subscription.updated webhook does that. Calling
          // onSuccess() immediately here, as an earlier version of this fix
          // did, meant "You're a Pro member!" could show before the backend
          // had actually caught up — leaving Settings > Billing still
          // showing Free/Upgrade right after, and a second click correctly
          // (but confusingly) hitting the "already have one" guard.
          if (cancelled) return;
          setReactivating(true);
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise(r => setTimeout(r, 1500));
            const fresh = await user?.reload().catch(() => null);
            if (fresh?.publicMetadata?.plan === 'pro') break;
          }
          if (cancelled) return;
          setReactivating(false);
          onSuccess && onSuccess();
          return;
        }
        if (!cancelled) setClientSecret(data.clientSecret);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [product]);

  return (
    <div className="upgrade-overlay" onClick={e => { if (e.target.classList.contains('upgrade-overlay')) onClose(); }}>
      <div className="checkout-modal checkout-modal--landscape">
        <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{ width: 12, height: 12 }} /></button>

        {/* Left — product info, stays constant regardless of payment state */}
        <div className="checkout-modal__info">
          <div className="logo-mark checkout-modal__logo"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
          <div className="checkout-modal__info-title">{copy.title}</div>
          <div className="checkout-modal__info-price">{copy.price}</div>
          <p className="checkout-modal__info-subtitle">{copy.subtitle}</p>
          <ul className="checkout-modal__features">
            {copy.features.map(f => (
              <li key={f}><IconCheck style={{ width: 12, height: 12 }} />{f}</li>
            ))}
          </ul>
          <div className="checkout-modal__trust">
            <IconCheck style={{ width: 11, height: 11, marginRight: 3, verticalAlign: '-1px' }} />Secure checkout via Stripe
          </div>
        </div>

        {/* Right — payment form */}
        <div className="checkout-modal__pay">
          {error && <div className="checkout-error">{
            error.includes('No such customer') || error.includes('customer')
              ? 'Your account needs a quick reset before checkout. Please sign out, sign back in, and try again.'
              : error
          } — <button className="checkout-retry" onClick={onClose}>close and try again</button></div>}

          {!error && !reactivating && !clientSecret && (
            <div style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          )}

          {!error && reactivating && (
            <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <Spinner />
              <p style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>Reactivating your subscription…</p>
            </div>
          )}

          {!error && !reactivating && clientSecret && (
            <Elements stripe={getStripePromise()} options={{
              clientSecret,
              appearance: {
                theme: 'night',
                variables: {
                  colorPrimary: '#7c5cfc',
                  colorBackground: 'var(--surface, #1a1a2e)',
                  colorText: 'var(--text, #e2e2e8)',
                  colorDanger: '#ef4444',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  borderRadius: '8px',
                  spacingUnit: '4px',
                },
                rules: {
                  '.Input': { backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' },
                  '.Input:focus': { border: '1px solid #7c5cfc', boxShadow: '0 0 0 1px #7c5cfc' },
                  '.Label': { color: 'rgba(255,255,255,0.6)', fontSize: '0.8125rem', fontWeight: '500' },
                  '.Tab': { backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' },
                  '.Tab--selected': { backgroundColor: '#7c5cfc', border: '1px solid #7c5cfc', color: '#fff' },
                  '.Tab:hover': { border: '1px solid rgba(255,255,255,0.2)' },
                },
              },
            }}>
              <CheckoutForm product={product} onSuccess={onSuccess} onClose={onClose} />
            </Elements>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckoutForm({ product, onSuccess, onClose }) {
  const stripe = useStripe();
  const elements = useElements();
  const { user } = useUser();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  async function handleConfirm() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setFormError(null);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (error) {
      setFormError(error.message);
      setSubmitting(false);
      return;
    }

    // Payment succeeded client-side, but the webhook that actually grants
    // access runs async on Stripe's side — Clerk's metadata isn't updated
    // yet at this exact moment. Poll for it instead of leaving the UI stale
    // until the user manually reloads the page.
    setSubmitting(false);
    setSyncing(true);
    const wantsPro = product === 'pro';
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      const fresh = await user?.reload().catch(() => null);
      const ok = wantsPro
        ? fresh?.publicMetadata?.plan === 'pro'
        : fresh?.publicMetadata?.hasDataExport === true;
      if (ok) break;
    }
    setSyncing(false);
    onSuccess && onSuccess();
  }

  return (
    <>
      <PaymentElement />
      {formError && <div className="checkout-error">{formError}</div>}
      <button
        className="upgrade-modal__cta"
        disabled={!stripe || submitting || syncing}
        onClick={handleConfirm}
        style={{ marginTop: 16 }}
      >
        {submitting ? 'Processing…' : syncing ? 'Confirming…' : (product === 'pro' ? 'Go Pro' : 'Buy export')}
      </button>
      <div className="upgrade-modal__note">
        {product === 'pro'
          ? 'Cancel anytime from Settings → Billing.'
          : 'One-time charge. You can re-purchase later for a fresh pull.'}
      </div>
    </>
  );
}

// ─── Cancel-subscription modal — confirmation + optional feedback ─────────────
function CancelModal({ busy, onConfirm, onClose }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="upgrade-overlay" onClick={e => { if (e.target.classList.contains('upgrade-overlay') && !busy) onClose(); }}>
      <div className="upgrade-modal" style={{ maxWidth: 380 }}>
        <div className="upgrade-modal__title">Are you sure?</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, margin: '8px 0 16px', textAlign: 'left' }}>
          You'll keep Pro access until the end of your current billing period — this doesn't cancel immediately.
        </p>
        <label style={{ display: 'block', textAlign: 'left', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
          Want to leave feedback? (optional)
        </label>
        <textarea
          className="cancel-feedback-input"
          placeholder="What made you decide to cancel?"
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
          disabled={busy}
          rows={3}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="btn btn--ghost" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Go back</button>
          <button className="settings-danger-btn" style={{ flex: 1 }} onClick={() => onConfirm(feedback)} disabled={busy}>
            {busy ? 'Working…' : 'Unsubscribe'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Billing section (Settings tab) ────────────────────────────────────────────
function BillingSection({ user }) {
  const [status, setStatus] = useState(null);
  const [loadErr, setLoadErr] = useState(null); // distinct from "no data" — see audit note
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [checkoutProduct, setCheckoutProduct] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [statusModal, setStatusModal] = useState(null); // null | {title, message}
  const [processing, setProcessing] = useState(false);
  const [progressText, setProgressText] = useState(null); // live row-count updates during a large export
  const [redownloadingIdx, setRedownloadingIdx] = useState(null); // index of the export-history row currently downloading, or null
  const [redownloadErr, setRedownloadErr] = useState(null);

  async function handleRedownload(idx, purchaseId) {
    setRedownloadingIdx(idx); setRedownloadErr(null); setProgressText(null);
    try {
      await downloadCSVFromR2('redownload', msg => setProgressText(msg), purchaseId);
    } catch (e) {
      setRedownloadErr(e.message);
    }
    setRedownloadingIdx(null); setProgressText(null);
  }

  async function load() {
    setLoadErr(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${cfg.NEON_PROXY_URL}/billing/status`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
      setStatus(data);
      return data; // returned so callers (e.g. cancel) can use fresh data immediately,
      // rather than reading stale state from a closure right after setState
    } catch (e) {
      // Explicit error state — NOT silently treated as "free plan, no data".
      // This is exactly the gap flagged in the UX audit: failures were
      // previously indistinguishable from empty results.
      setLoadErr(e.message || 'Could not load billing status');
      return null;
    }
  }
  useEffect(() => { load(); }, []);

  async function handleCancel(feedback) {
    setBusy(true); setActionErr(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/billing/cancel`, {
        method: 'POST', headers,
        body: JSON.stringify({ feedback: feedback || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancel failed');

      // The Worker only calls Stripe here — it relies entirely on Stripe's
      // async webhook to actually update Neon afterward (same as the
      // checkout flow's user.reload() race, just never fixed here too).
      // A single immediate re-fetch can easily land before the webhook has,
      // showing stale "still active" status. Poll briefly instead.
      let fresh = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        fresh = await load();
        if (fresh?.cancel_at_period_end) break;
        await new Promise(r => setTimeout(r, 1500));
      }

      setConfirmCancel(false);
      setStatusModal({
        title: 'Subscription canceled',
        message: fresh?.current_period_end
          ? `You'll keep Pro access until ${new Date(fresh.current_period_end).toLocaleDateString()}, then move to Free automatically.`
          : `You'll keep Pro access through the end of your current billing period, then move to Free automatically.`,
      });
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReactivate() {
    setBusy(true); setActionErr(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/billing/reactivate`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reactivate failed');

      // Same webhook race as cancel above — poll until cancel_at_period_end
      // actually flips back to false, rather than trust one immediate fetch.
      let fresh = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        fresh = await load();
        if (fresh && !fresh.cancel_at_period_end) break;
        await new Promise(r => setTimeout(r, 1500));
      }

      setStatusModal({
        title: 'Subscription reactivated',
        message: fresh?.current_period_end
          ? `You're all set — renews automatically on ${new Date(fresh.current_period_end).toLocaleDateString()}.`
          : `You're all set — your subscription will continue renewing automatically.`,
      });
    } catch (e) {
      setActionErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loadErr) {
    return (
      <div className="settings-error-banner">
        Couldn't load your billing info right now ({loadErr}).
        <button className="checkout-retry" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!status) return <div style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const isProPlan = status.plan === 'pro' && (status.status === 'active' || status.status === 'trialing');
  const dataExports = status.dataExports || [];

  return (
    <>
      <div className="settings-group">
        <div className="settings-group__label">Current plan</div>
        <div className="settings-row settings-row--toggle">
          <div>
            <div className="settings-row__label">{isProPlan ? `Seli Pro — ${PRO_PRICE_LABEL}` : 'Free'}</div>
          </div>
          {!isProPlan && (
            <button className="btn btn--primary" onClick={() => setCheckoutProduct('pro')}>Go Pro →</button>
          )}
          {isProPlan && !status.cancel_at_period_end && (
            <button className="settings-danger-btn" disabled={busy} onClick={() => setConfirmCancel(true)}>
              Cancel subscription
            </button>
          )}
          {isProPlan && status.cancel_at_period_end && (
            <button className="btn btn--primary" disabled={busy} onClick={handleReactivate}>
              {busy ? 'Working…' : 'Reactivate'}
            </button>
          )}
        </div>

        {/* Renewal/cancellation status — its own clearly separated subsection,
            not just a small caption line, per the request for more robustness here. */}
        {isProPlan && status.current_period_end && (
          <div className="settings-subsection">
            {status.cancel_at_period_end ? (
              <>
                <span className="settings-subsection__dot settings-subsection__dot--warn" />
                Canceled — Pro access stays active until{' '}
                <strong>{new Date(status.current_period_end).toLocaleDateString()}</strong>.
                Changed your mind? <button className="settings-inline-link" disabled={busy} onClick={handleReactivate}>Reactivate</button>
              </>
            ) : (
              <>
                <span className="settings-subsection__dot settings-subsection__dot--ok" />
                Renews automatically on <strong>{new Date(status.current_period_end).toLocaleDateString()}</strong>.
              </>
            )}
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group__label">Full data export</div>
        <div className="settings-row settings-row--toggle">
          <div>
            <div className="settings-row__label">
              {status.hasDataExport ? 'Purchased' : 'Not purchased'}
            </div>
            <div className="settings-row__sub">One-time pull of everything in the database — $39.99</div>
          </div>
          <button className="btn btn--primary" onClick={() => setCheckoutProduct('data_export')}>
            {status.hasDataExport ? 'Buy again' : 'Buy →'}
          </button>
        </div>

        {status.hasDataExport && (
          <div className="settings-row" style={{ paddingTop: 8 }}>
            <a href="/redownload" target="_blank" rel="noopener" style={{ fontSize: '0.8125rem', color: 'var(--accent-strong)', textDecoration: 'none', fontWeight: 500 }}>
              Already purchased? Re-download or look up an order →
            </a>
          </div>
        )}
      </div>

      {actionErr && <div className="checkout-error">{actionErr}</div>}

      {confirmCancel && (
        <CancelModal
          busy={busy}
          onConfirm={handleCancel}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {processing && <ProcessingModal text={progressText || (checkoutProduct === 'pro' ? 'Setting up your subscription…' : 'Finalizing your purchase…')} />}

      {statusModal && (
        <StatusModal
          title={statusModal.title}
          message={statusModal.message}
          onClose={() => setStatusModal(null)}
        />
      )}

      {checkoutProduct && !processing && (
        <CheckoutModal
          product={checkoutProduct}
          onClose={() => setCheckoutProduct(null)}
          onSuccess={async () => {
            const wasPro = checkoutProduct === 'pro';
            setProcessing(true);
            if (wasPro) {
              // Same webhook race as handleCancel/handleReactivate above —
              // CheckoutModal already waits for Clerk's publicMetadata to
              // flip before calling this, so Neon's row (written earlier in
              // the same webhook) should be fresh by now too, but poll
              // rather than assume: a single fire-and-forget load() here
              // was the actual bug behind Billing still showing Free/Upgrade
              // right after a successful reactivation.
              let fresh = null;
              for (let attempt = 0; attempt < 6; attempt++) {
                fresh = await load();
                if (fresh?.plan === 'pro') break;
                await new Promise(r => setTimeout(r, 1500));
              }
              setCheckoutProduct(null);
              setProcessing(false);
              setStatusModal({ type: 'pro', title: "You're a Pro member!" });
              return;
            }
            load();
            try {
              await downloadCSVFromR2('consume', msg => setProgressText(msg));
              setCheckoutProduct(null);
              setProcessing(false);
              setProgressText(null);
              setStatusModal({ title: 'Export started', message: 'Your download should begin automatically. Lost the file later? Re-download it anytime at seli.app/redownload, at no extra charge.' });
            } catch (e) {
              setCheckoutProduct(null);
              setProcessing(false);
              setProgressText(null);
              setStatusModal({ title: 'Purchase complete — download failed', message: `Your payment went through, but the download itself hit an error (${e.message}). Your purchase is saved. Go to seli.app/redownload to get your file, no extra charge.` });
            }
          }}
        />
      )}
    </>
  );
}


// Two item types: 'ticker' and 'insider'
// Storage: localStorage (instant) + Neon (persistent, Pro users only)
// Free users: watchlist is NOT saved — clicking star shows upgrade modal

const WL_KEY = 'seli_watchlist_v1';
const WL_INSIDER_KEY = 'seli_insiders_v1';

function wlGet(key = WL_KEY) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } }
function wlSet(items, key = WL_KEY) { try { localStorage.setItem(key, JSON.stringify(items)); } catch { } }

// Neon-backed watchlist mutation — writes to user_watchlist table via Worker
async function neonWatchlistMutate(itemType, itemValue, action) {
  if (!cfg.NEON_PROXY_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
    const res = await fetch(`${cfg.NEON_PROXY_URL}/watchlist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, item_type: itemType, item_value: itemValue }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('[watchlist] mutate failed:', data.error || res.status);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[watchlist] mutate request failed:', e.message);
    return { ok: false, status: 0 };
  }
}

// Load watchlist from Neon on mount for Pro users
async function neonWatchlistLoad() {
  if (!cfg.NEON_PROXY_URL) return null;
  try {
    const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
    const res = await fetch(`${cfg.NEON_PROXY_URL}/watchlist`, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('[watchlist] load failed:', data.error || res.status); return null; }
    return data.items || null;
  } catch (e) {
    console.error('[watchlist] load request failed:', e.message);
    return null;
  }
}

const FREE_WATCHLIST_LIMIT = 3;

function useWatchlist(user) {
  const { pro, billingStatus } = useBilling();
  // One list, two kinds of thing: stocks and people. Free accounts get
  // FREE_WATCHLIST_LIMIT watched items in total (the Worker enforces the same
  // cap). Pro is unlimited. Everything syncs to Neon so the emails see it.
  const [tickers, setTickers] = useState(() => wlGet(WL_KEY));
  const [insiders, setInsiders] = useState(() => wlGet(WL_INSIDER_KEY));
  const [alerts, setAlertsMap] = useState({}); // "ticker:NVDA" -> false when muted
  const [showUpgrade, setShowUpgrade] = useState(null); // null | 'watchlist_ticker' | 'watchlist_insider'

  // Waits for billingStatus so a Pro user with stale Clerk metadata isn't
  // treated as free. If the server has nothing but this browser does (lists
  // built before server sync), push the local list up once, capped for free.
  const billingKnown = billingStatus !== null;
  useEffect(() => {
    if (!user || !billingKnown) return;
    neonWatchlistLoad().then(items => {
      if (!items) return;
      const t = items.filter(i => i.item_type === 'ticker').map(i => i.item_value);
      const ins = items.filter(i => i.item_type === 'insider').map(i => i.item_value);
      setAlertsMap(Object.fromEntries(items.map(i => [`${i.item_type}:${i.item_value}`, i.alerts !== false])));
      if (t.length || ins.length) {
        wlSet(t, WL_KEY); setTickers(t);
        wlSet(ins, WL_INSIDER_KEY); setInsiders(ins);
      } else {
        const local = wlGet(WL_KEY);
        (pro ? local : local.slice(0, FREE_WATCHLIST_LIMIT)).forEach(tk => neonWatchlistMutate('ticker', tk, 'add'));
      }
    });
  }, [pro, user?.id, billingKnown]);

  const count = tickers.length + insiders.length;
  // Refs mirror state so toggles can decide from the latest list without
  // running side effects inside a setState updater (StrictMode runs those twice).
  const tickersRef = useRef(tickers); tickersRef.current = tickers;
  const insidersRef = useRef(insiders); insidersRef.current = insiders;

  const makeToggle = (type, ref, set, key, upgradeKey) => (value) => {
    const prev = ref.current;
    if (prev.includes(value)) {
      const next = prev.filter(v => v !== value);
      ref.current = next; set(next); wlSet(next, key);
      neonWatchlistMutate(type, value, 'remove');
      return;
    }
    if (!pro && tickersRef.current.length + insidersRef.current.length >= FREE_WATCHLIST_LIMIT) { setShowUpgrade(upgradeKey); return; }
    const next = [...prev, value];
    ref.current = next; set(next); wlSet(next, key);
    // The Worker has the final say (free cap, auth). Undo the add if it refuses.
    neonWatchlistMutate(type, value, 'add').then(r => {
      if (r?.ok !== false) return;
      const back = ref.current.filter(v => v !== value);
      ref.current = back; set(back); wlSet(back, key);
      if (r.status === 403) setShowUpgrade(upgradeKey);
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toggleTicker = useCallback(makeToggle('ticker', tickersRef, setTickers, WL_KEY, 'watchlist_ticker'), [pro]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toggleInsider = useCallback(makeToggle('insider', insidersRef, setInsiders, WL_INSIDER_KEY, 'watchlist_insider'), [pro]);

  // Per-item same-day alerts (Pro). Optimistic, rolled back if the save fails.
  const setAlerts = useCallback(async (type, value, on) => {
    const k = `${type}:${value}`;
    setAlertsMap(m => ({ ...m, [k]: on }));
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/watchlist`, { method: 'POST', headers, body: JSON.stringify({ action: 'alerts', item_type: type, item_value: value, alerts: on }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setAlertsMap(m => ({ ...m, [k]: !on }));
    }
  }, []);
  const alertsOn = useCallback((type, value) => alerts[`${type}:${value}`] !== false, [alerts]);

  const hasTicker = useCallback((ticker) => tickers.includes(ticker), [tickers]);
  const hasInsider = useCallback((name) => insiders.includes(name), [insiders]);

  return {
    tickers, insiders, toggle: toggleTicker, has: hasTicker,
    toggleTicker, toggleInsider, hasTicker, hasInsider,
    alertsOn, setAlerts,
    showUpgrade, setShowUpgrade, pro,
    freeLimit: FREE_WATCHLIST_LIMIT,
    freeSlotsLeft: pro ? Infinity : Math.max(0, FREE_WATCHLIST_LIMIT - count),
  };
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('theme'); if (s) return s === 'dark'; } catch (_) { }
    // Default every new visitor to dark — Seli's primary identity — instead
    // of following the OS-level color-scheme preference. Only an explicit
    // in-app toggle (saved to localStorage above) switches this.
    return true;
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (_) { }
  }, [dark]);
  return [dark, setDark];
}


// ── Mobile detection ──────────────────────────────────────────────────────────
// Matches the same 640px breakpoint style.css already uses for the bottom
// tab bar — this is the one place the actual set of navigable destinations
// differs by device (mobile: Home + More; desktop: the full nav), not just
// layout, so it needs a real JS check alongside the CSS media queries,
// not instead of them.
const MOBILE_BREAKPOINT = '(max-width: 640px)';
function isMobileViewport() {
  // Raw, synchronous — safe to call from a useState lazy initializer
  // (before any effect has run) or from route-parsing helpers that live
  // outside any component at all.
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT).matches;
}
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(isMobileViewport);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

// ── Signal tier threshold ─────────────────────────────────────────────────────
// Used to be a per-user "risk appetite" preference (1-5, adjustable in
// Settings) controlling how hard it was for a signal to read as "high"/green.
// Removed deliberately: the same underlying score rendering as "High" for
// one subscriber and "Medium" for another — based on a personal setting
// they chose — is exactly the kind of individualized, tailored-to-the-
// subscriber presentation that risks stepping outside the "impersonal"
// requirement of the Investment Advisers Act publisher's exclusion. Every
// user now sees the identical thresholds (level 3, "Balanced" — matches
// what the neutral/default setting always was), via the same Context so
// ConvictionBar and every other consumer needed no changes beyond this.
// (RISK_APPETITE_THRESHOLDS / RISK_APPETITE_LABELS / tierFromPct still live
// in src/lib/scoring.js, untouched — only the ability for a user to change
// which level applies to them has been removed, not the underlying,
// already-tested tiering math.)
const RiskAppetiteContext = React.createContext([3, () => { }]);


// ─── Atoms ────────────────────────────────────────────────────────────────────
function Badge({ type, children }) {
  return <span className={`badge badge--${type}`}>{children}</span>;
}
// Returns the display label for an insider's role, distinguishing
// congressional insiders from corporate C-suite.
function insiderRoleLabel(r) {
  if (r?.is_congress) return { badge: 'rel-strong', label: 'Congress' };
  if (r?.relationship === 'strong') return { badge: 'rel-strong', label: 'C-Suite' };
  if (r?.relationship === 'medium') return { badge: 'rel-medium', label: 'Officer' };
  return { badge: 'rel-weak', label: 'Dir' };
}

// Inline info tooltip — hover to see explanation
function InfoTip({ tip, children }) {
  return (
    <span className="info-tip-wrap">
      {children}
      <span className="info-tip" title={tip}>ⓘ</span>
    </span>
  );
}

// Stat tile with optional tooltip on label
function HelpStat({ label, tip, value, sub, color, style }) {
  return (
    <div className="ws-stat">
      <div className="ws-stat__label">{tip ? <InfoTip tip={tip}>{label}</InfoTip> : label}</div>
      <div className="ws-stat__value" style={{ color, ...style }}>{value}</div>
      {sub && <div className="ws-stat__sub">{sub}</div>}
    </div>
  );
}

// Tooltip definitions — single source of truth for all explanations
const TIPS = {
  // Signal columns
  conviction: 'Composite score (0–100) combining trade type, insider clustering, C-suite involvement, position sizing, dollar value, timing, and recency. Higher = stronger signal.',
  netValue: 'Total buy value minus total sell value for this ticker. Negative means more insider selling than buying.',
  insiders: 'Number of distinct insiders who traded this ticker in the selected window.',
  trades: 'Total number of open-market transactions (buys + sells) for this ticker.',
  signalDate: 'Date of the most recent transaction for this ticker.',
  // Raw filing columns
  pctPosition: 'How much the insider\'s total holdings changed from this trade. +67% means they increased their position by two-thirds.',
  tradeValue: 'Dollar value of the transaction (shares × price).',
  role: 'Insider\'s relationship to the company. C-Suite = CEO/CFO/COO/etc. Officer = SVP/VP/GC. Dir = board director or 10% owner.',
  tradeType: 'Buy = open-market purchase. Sell = open-market sale. Only open-market trades are shown — option exercises and gifts are excluded.',
  // Insider profile
  hitRate: 'Percentage of priced trades where the stock moved in the insider\'s favor within 6 months. Requires 5+ priced trades to display.',
  avgReturn: 'Average percentage return across all priced trades, measured 6 months after the trade date.',
  omBuys: 'Open-market buys — purchases made with the insider\'s own money on the open market.',
  omSells: 'Open-market sells — sales executed on the open market (not option exercises or scheduled plans).',
  pricedTrades: 'Trades where we could measure a 6-month return — the stock had pricing data for both the trade date and 6 months later.',
  totalBought: 'Total dollar value of all open-market purchases.',
  insiderScore: 'Composite score (0–100) based on alpha over SPY, hit rate, role, trade volume, and discipline. Low sample sizes and sell-only insiders are penalized.',
  alpha: 'Return above what SPY delivered over the same period. +10% alpha means this insider beat the market by 10 percentage points.',
  // Stat tiles
  highConviction: 'Signals scoring 60 or above out of 100 — the strongest insider activity.',
  netFlow: 'Total buy value minus total sell value across all signals. Shows whether insiders are net buying or selling.',
  // Filters
  windowFilter: 'How far back to look. A 7d window shows only trades from the last 7 days.',
  strengthFilter: 'Minimum conviction score to show. "High" = 60+, "Med+" = 35+.',
  sourceFilter: 'Corporate = SEC Form 4 filings. Congress = congressional trading disclosures.',
};
function Spinner({ size = 22 }) {
  return <div className="spinner" style={{ width: size, height: size }} />;
}
// Skeleton loading rows — fills the available space with pulsing placeholder
// rows instead of a centered spinner. Looks like content is about to appear
// rather than "something is spinning in a void."
function SkeletonRows({ count = 6, style: extraStyle }) {
  return (
    <div className="skel-wrap" style={extraStyle}>
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
const TX_CODE_TOOLTIPS = {
  P: 'Open market purchase',
  S: 'Open market sale',
  A: 'New shares granted to the insider as compensation — not purchased with their own money',
  M: 'Insider exercised stock options they already held — not a new open-market purchase',
  J: 'Shares moved between accounts or entities — not a market purchase or sale',
  G: 'Shares given or received as a gift — no cash changed hands',
  F: 'Shares withheld by the company to cover taxes owed when equity vested — not a discretionary sale',
  C: 'A derivative security (option/warrant) converted into common stock',
  D: 'Shares sold back to the company itself, not on the open market',
  E: 'An option or right expired unused — no shares bought or sold',
  // Congressional PTRs (STOCK Act filings) never had an entry here, so
  // every one fell through to the raw code (codeLabel = TX_CODE_TOOLTIPS[code]||code)
  // — that's what was rendering as a bare "CONGRESS_S"/"CONGRESS_P" string
  // with no label above it in the trade detail rows. These report a dollar
  // RANGE, not an exact price, which is exactly why there's no price to
  // show — the label now says that instead of leaving the raw code visible.
  CONGRESS_P: 'Congressional purchase — reported as a dollar range, not an exact price',
  CONGRESS_S: 'Congressional sale — reported as a dollar range, not an exact price',
};

// Short, self-explanatory labels for the Data table — replaces the bare
// single-letter SEC code, which was only ever explained via a hover tooltip
// (invisible on touch devices, no visual cue that a tooltip even exists).
// Full explanation is still available on hover via TX_CODE_TOOLTIPS above.
const TX_CODE_SHORT = {
  P: 'Buy (OM)', S: 'Sell (OM)',
  A: 'Award', M: 'Exercise',
  J: 'Transfer', G: 'Gift',
  F: 'Tax w/h', C: 'Conversion',
  D: 'To issuer', E: 'Expired',
  CONGRESS_P: 'Buy (range)', CONGRESS_S: 'Sell (range)',
};


function ConvictionBar({ score, max = 100, showLabel = false }) {
  const pct = Math.min((score / max) * 100, 100);
  const tier = pct >= 85 ? 'very-high' : pct >= 60 ? 'high' : pct >= 40 ? 'medium' : pct >= 20 ? 'low' : 'very-low';
  const label = tier === 'very-high' ? 'Very High' : tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : tier === 'low' ? 'Low' : 'Very Low';
  const color = tier === 'very-high' ? 'var(--green-600)' : tier === 'high' ? '#5EC26A' : tier === 'medium' ? 'var(--amber-600)' : tier === 'low' ? 'var(--text-3)' : 'var(--text-3)';
  const showText = showLabel;
  return (
    <div className="conv-bar-wrap" title={`${Math.round(score)}/${max} — ${label}`}>
      <div className="conv-bar-track">
        <div className="conv-bar-tick" style={{ left: '20%' }} />
        <div className="conv-bar-tick" style={{ left: '40%' }} />
        <div className="conv-bar-tick" style={{ left: '60%' }} />
        <div className="conv-bar-tick" style={{ left: '85%' }} />
        <div className="conv-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
      {showText && <span className="conv-bar-label" style={{ color }}>{label}</span>}
    </div>
  );
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────
// ─── Sidebar icon set ───────────────────────────────────────────────────────
// Outlined / 2px stroke / rounded corners, per the brand guide. Standard,
// widely-recognized icon shapes (same convention as Feather/Lucide) rather
// than inventing new ones — familiarity matters more than novelty here.
const ICON_PROPS = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
function IconHome(p) { return <svg {...ICON_PROPS} {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>; }
function IconInsights(p) { return <svg {...ICON_PROPS} {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>; }
function IconData(p) { return <svg {...ICON_PROPS} {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>; }
function IconFavorites(p) { return <svg {...ICON_PROPS} {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>; }


function IconDownload(p) { return <svg {...ICON_PROPS} {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>; }

function IconSun(p) { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>; }
function IconMoon(p) { return <svg {...ICON_PROPS} {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>; }
function IconReversal(p) { return <svg {...ICON_PROPS} {...p}><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>; }
function IconClose(p) { return <svg {...ICON_PROPS} {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>; }
function IconCheck(p) { return <svg {...ICON_PROPS} {...p}><polyline points="20 6 9 17 4 12" /></svg>; }
function IconWarning(p) { return <svg {...ICON_PROPS} {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>; }
function IconBuyTri(p) { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 4 21 19 3 19" fill="currentColor" /></svg>; }
function IconSellTri(p) { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 20 3 5 21 5" fill="currentColor" /></svg>; }


function IconMessage(p) { return <svg {...ICON_PROPS} {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>; }
function IconLink(p) { return <svg {...ICON_PROPS} {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>; }
function IconZap(p) { return <svg {...ICON_PROPS} {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>; }


function IconLock(p) { return <svg {...ICON_PROPS} {...p}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>; }

// ─── Top Nav ──────────────────────────────────────────────────────────────────
// Logo, four text links, search, and your avatar. Everything that isn't a
// place (theme, help, feedback, account, sign out, data freshness) lives in
// the avatar menu instead of a row of icons.
const NAV_LINKS = [
  { id: 'home', label: 'Home', short: 'Home', Icon: IconHome, path: '/' },
  { id: 'watchlist', label: 'Watchlist', short: 'Watchlist', Icon: IconFavorites, path: '/watchlist' },
  { id: 'leaderboard', label: 'Leaderboard', short: 'Leaders', Icon: IconInsights, path: '/leaderboard' },
  { id: 'dashboard', label: 'Data', short: 'Data', Icon: IconData, path: '/data' },
];

function AccountMenu({ user, dark, setDark, lastFilingDate, isDataStale }) {
  const { pro } = useBilling();
  const { signOut } = useAuth();
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const name = user?.firstName || user?.fullName || '';
  const email = user?.primaryEmailAddress?.emailAddress || '';
  const initial = (name || email || '?').trim()[0]?.toUpperCase() || '?';
  const pick = fn => () => { setOpen(false); fn(); };
  return (
    <div className="sx-menu" ref={ref}>
      <button className="sx-avatar" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        {user?.imageUrl && user?.hasImage ? <img src={user.imageUrl} alt="" /> : <span>{initial}</span>}
        {isDataStale && <span className="sx-avatar__dot" title="Data isn't updating" />}
      </button>
      {open && (
        <div className="sx-menu__panel" role="menu">
          <div className="sx-menu__who">
            <div className="sx-menu__name">{name || email}{pro && <span className="sx-pro">Pro</span>}</div>
            {name && email && <div className="sx-menu__email">{email}</div>}
          </div>
          <button role="menuitem" className="sx-menu__item" onClick={pick(() => go('/account'))}>Account and emails</button>
          {!pro && <button role="menuitem" className="sx-menu__item sx-menu__item--accent" onClick={pick(() => go('/account#billing'))}>See Pro · {PRO_PRICE_LABEL}</button>}
          <button role="menuitem" className="sx-menu__item" onClick={pick(() => clerk?.openUserProfile?.())}>Login and security</button>
          <div className="sx-menu__sep" />
          <button role="menuitemcheckbox" aria-checked={dark} className="sx-menu__item sx-menu__item--row" onClick={() => setDark(d => !d)}>
            Dark mode <span className={`sx-mini-toggle${dark ? ' sx-mini-toggle--on' : ''}`} />
          </button>
          <a role="menuitem" className="sx-menu__item" href="/help" target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Help center</a>
          <button role="menuitem" className="sx-menu__item" onClick={pick(() => setFeedback(true))}>Send feedback</button>
          <div className="sx-menu__sep" />
          {lastFilingDate && (
            <div className={`sx-menu__meta${isDataStale ? ' sx-menu__meta--stale' : ''}`}>
              {isDataStale ? 'Data isn\'t updating. ' : ''}Newest filing {fmt.dateShort(lastFilingDate)}
            </div>
          )}
          <button role="menuitem" className="sx-menu__item" onClick={pick(() => signOut({ redirectUrl: '/' }))}>Sign out</button>
        </div>
      )}
      {feedback && <FeedbackModal page={window.location.pathname} onClose={() => setFeedback(false)} />}
    </div>
  );
}

function TopNav({ page, user, dark, setDark, lastFilingDate, isDataStale }) {
  const isMobile = useIsMobile();
  const [searchOpen, setSearchOpen] = useState(false);
  const logo = (
    <a className="sx-nav__logo" href="/" onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go('/'); }} aria-label="Seli home">
      <img src={logoSimple} alt="" /><span>Seli</span>
    </a>
  );
  const menu = <AccountMenu user={user} dark={dark} setDark={setDark} lastFilingDate={lastFilingDate} isDataStale={isDataStale} />;
  if (isMobile) {
    return (
      <>
        <header className="sx-nav">
          {logo}
          <div className="sx-nav__right">
            <button className="sx-nav__icon" onClick={() => setSearchOpen(true)} aria-label="Search stocks and insiders"><Icon name="search" size={18} /></button>
            {menu}
          </div>
        </header>
        {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
        <nav className="bottomnav">
          {NAV_LINKS.map(n => (
            <button key={n.id} className={`bottomnav__btn${page === n.id ? ' bottomnav__btn--active' : ''}`} onClick={() => go(n.path)} aria-current={page === n.id ? 'page' : undefined}>
              <n.Icon style={{ width: 20, height: 20 }} /><span className="bottomnav__label">{n.short}</span>
            </button>
          ))}
        </nav>
      </>
    );
  }
  return (
    <header className="sx-nav">
      {logo}
      <nav className="sx-nav__links" aria-label="Main">
        {NAV_LINKS.map(n => (
          <a key={n.id} href={n.path} aria-current={page === n.id ? 'page' : undefined}
            className={`sx-nav__link${page === n.id ? ' sx-nav__link--on' : ''}`}
            onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(n.path); }}>{n.label}</a>
        ))}
      </nav>
      <div className="sx-nav__end">
        <div className="sx-nav__search"><SearchBox hotkey /></div>
        <div className="sx-nav__right">{menu}</div>
      </div>
    </header>
  );
}


// ─── Signal aggregation ───────────────────────────────────────────────────────
// (buildSignals now lives in src/lib/scoring.js — imported above — so the
// exact logic under test in the test suite is the exact logic actually
// running here, not a parallel copy that can silently drift.)

// ─── Detail panel ─── signal / trader / ticker / transaction ─────────────────
// ── Auth header helper ────────────────────────────────────────────────────────
// Phase 1: returns X-API-Key header using the key from config
// Phase 2: replace this function body with Clerk's getToken() call
// Everything else in the codebase calls this — nothing else needs to change
// when you upgrade from API key to JWT.
// Navigate to an in-app path without a full page reload — dispatches a
// popstate event so the router's existing onPopState handler (built for
// real back/forward navigation) picks it up and updates page state the
// same way it already does, rather than needing a separate mechanism.
function navigateTo(path) { go(path); }

// ─── Auth token cache ────────────────────────────────────────────────────────
// On mount, 15-20+ callers across app.jsx AND edgar.js independently call
// getAuthHeaders(), each one independently polling for window.__clerkGetToken
// with 50ms sleeps for up to 2 seconds. loadFilings (the critical-path query)
// lives in edgar.js with its own separate copy of getAuthHeaders — so even
// caching here didn't help the main data fetch at all.
//
// Fix: store the poll promise and token cache on window.__seliAuth so both
// files share a single polling loop and a single token cache. Whichever
// file's getAuthHeaders runs first creates the shared state; every other
// caller across both files piggybacks on it.
if (!window.__seliAuth) window.__seliAuth = { poll: null, token: null, expiry: 0 };

async function getAuthHeaders() {
  const auth = window.__seliAuth;

  // Fast path: reuse a recently-fetched token (Clerk tokens are valid for
  // 60s; we cache for 10s to stay well within that window while still
  // avoiding 15+ concurrent getToken() calls on mount).
  if (auth.token && Date.now() < auth.expiry) {
    return { 'Authorization': `Bearer ${auth.token}` };
  }

  // If the token getter isn't registered yet, wait — but share a single
  // polling promise across all concurrent callers (in BOTH files) instead
  // of N independent polling loops.
  if (!window.__clerkGetToken) {
    if (!auth.poll) {
      auth.poll = (async () => {
        for (let i = 0; i < 40 && !window.__clerkGetToken; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        auth.poll = null;
      })();
    }
    await auth.poll;
  }

  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) {
        auth.token = token;
        auth.expiry = Date.now() + 10_000; // cache 10s
        return { 'Authorization': `Bearer ${token}` };
      }
    } catch { }
  }
  return {};
}

async function queryNeon(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ query: sql }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) throw new Error('You don\'t have access to this — check your plan in Account');
  if (!r.ok) throw new Error('Something went wrong loading this — try again in a moment');
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.rows || [];
}

// Bundle consecutive same-direction trades by the same insider+ticker within
// a window (default 5 trading days) into a single combined row. Pure display
// aggregation — does not touch underlying data.
function clusterTrades(rows, windowDays = 5) {
  if (!rows || !rows.length) return [];
  // Sort ascending by date so we can walk forward and group
  const sorted = [...rows].sort((a, b) => {
    const ad = a.transaction_date || a.filing_date || '';
    const bd = b.transaction_date || b.filing_date || '';
    return ad.localeCompare(bd);
  });

  const clusters = [];
  let current = null;

  for (const r of sorted) {
    const tt = r.transaction_type;
    const dt = r.transaction_date || r.filing_date;
    if (!dt) { clusters.push({ ...r, _isCluster: false, _count: 1 }); continue; }
    const dtMs = new Date(dt + 'T00:00:00').getTime();

    const sameGroup = current
      && current.transaction_type === tt
      && current._ticker === (r.ticker || '')
      && current._insider === (r.insider_name || '')
      && (dtMs - current._lastMs) <= windowDays * 86400000;

    if (sameGroup) {
      current._trades.push(r);
      current._lastMs = dtMs;
      current.shares = (current.shares || 0) + (r.shares || 0);
      current.value = (current.value || 0) + (r.value || 0);
      current._count++;
      // weighted avg price
      const totalShares = current._trades.reduce((s, t) => s + (t.shares || 0), 0);
      current.price_per_share = totalShares > 0
        ? current._trades.reduce((s, t) => s + ((t.price || t.price_per_share || 0) * (t.shares || 0)), 0) / totalShares
        : current.price_per_share;
      current.price = current.price_per_share;
      current.transaction_date = current._trades[0].transaction_date || current._trades[0].filing_date; // earliest
      current._lastDate = dt; // most recent
    } else {
      if (current) clusters.push(current);
      current = {
        ...r, _isCluster: true, _count: 1, _trades: [r],
        _ticker: r.ticker || '', _insider: r.insider_name || '',
        _lastMs: dtMs, _lastDate: dt,
      };
    }
  }
  if (current) clusters.push(current);

  // Mark single-trade "clusters" as non-clusters for display purposes
  for (const c of clusters) if (c._count === 1) c._isCluster = false;

  // Return newest-first to match existing sort convention
  return clusters.sort((a, b) => {
    const ad = a._lastDate || a.transaction_date || a.filing_date || '';
    const bd = b._lastDate || b.transaction_date || b.filing_date || '';
    return bd.localeCompare(ad);
  });
}

// Trust score now factors BOTH buy-side appreciation (unrealized) AND sell-side
// realized gains (did they sell at a profit vs their own historical buys),
// not just "did the stock go up since they bought." A net seller with bad
// realized P&L will no longer score well just because their few buys are green.
function trustScore(st) {
  if (!st || st.omBuys < 2) return null;
  let s = 0;
  // Combined hit rate (buys priced correctly + profitable sells), weighted more
  if (st.combinedHitRate != null) { if (st.combinedHitRate >= 70) s += 2; else if (st.combinedHitRate >= 50) s += 1; } else s += 0.5;
  if (st.avgRealizedReturn != null) { if (st.avgRealizedReturn >= 20) s += 1.5; else if (st.avgRealizedReturn >= 5) s += 1; else if (st.avgRealizedReturn >= 0) s += 0.5; else s -= 0.5; }
  if (st.omBuys + st.omSells >= 10) s += 1; else if (st.omBuys + st.omSells >= 5) s += 0.5;
  if (st.totalBuys > 0 && st.omBuys / st.totalBuys >= 0.7) s += 0.5;
  return Math.max(0, Math.min(Math.round(s * 10) / 10, 5));
}


// Same resolution pattern as GUIDE_ICON_MAP, for the landing page's What's
// Inside section — kept as a separate map rather than reused directly,
// since the two sections don't necessarily want identical icon sets long
// term even though they overlap today.
const LP_FEATURE_ICON_MAP = {
  IconData, IconInsights, IconLink, IconZap, IconFavorites,
};


// Persistent status-bar entry point into the guide — always opens at the
// beginning, for anyone who wants the full walkthrough rather than one
// specific tile's answer. Previously this lived alongside a separate "?"
// icon that linked out to /about — two adjacent help-shaped icons doing
// different things. Consolidated into one: this is now the "?" itself.
function FeedbackButton({ page, label }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={label ? 'sx-btn sx-btn--sm' : 'topnav__icon-btn'}
        onClick={() => setOpen(true)}
        title="Send feedback"
        aria-label="Send feedback"
      >
        {label || <IconMessage style={{ width: 15, height: 15 }} />}
      </button>
      {open && <FeedbackModal page={page} onClose={() => setOpen(false)} />}
    </>
  );
}

// Max screenshots and per-image size match the server's own caps
// (FEEDBACK_MAX_SCREENSHOTS / FEEDBACK_MAX_SCREENSHOT_BYTES in
// neon-proxy.js) — kept in sync by hand since the client needs to reject
// oversized/excess images before spending a POST on them, not just rely
// on the server to say no after the fact.
const FEEDBACK_MAX_SCREENSHOTS = 4;
const FEEDBACK_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5MB

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function FeedbackModal({ page, onClose }) {
  const [summary, setSummary] = useState('');
  const [message, setMessage] = useState('');
  const [screenshots, setScreenshots] = useState([]); // [{dataUrl, name}]
  const [shotError, setShotError] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const fileInputRef = useRef(null);

  async function addFiles(files) {
    setShotError(null);
    const incoming = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    if (!incoming.length) return;
    const room = FEEDBACK_MAX_SCREENSHOTS - screenshots.length;
    if (room <= 0) { setShotError(`Up to ${FEEDBACK_MAX_SCREENSHOTS} screenshots per report.`); return; }
    const toAdd = incoming.slice(0, room);
    if (incoming.length > toAdd.length) setShotError(`Only added ${toAdd.length} — up to ${FEEDBACK_MAX_SCREENSHOTS} screenshots per report.`);
    const oversized = toAdd.some(f => f.size > FEEDBACK_MAX_SCREENSHOT_BYTES);
    if (oversized) { setShotError('One of those is over 5MB — try a smaller image.'); }
    const ok = toAdd.filter(f => f.size <= FEEDBACK_MAX_SCREENSHOT_BYTES);
    try {
      const dataUrls = await Promise.all(ok.map(fileToDataUrl));
      setScreenshots(prev => [...prev, ...ok.map((f, i) => ({ dataUrl: dataUrls[i], name: f.name || 'pasted-image.png' }))]);
    } catch {
      setShotError('Could not read one of those images — try again.');
    }
  }

  function onPaste(e) {
    const items = Array.from(e.clipboardData?.items || []).filter(it => it.type.startsWith('image/'));
    if (!items.length) return; // let normal text paste through untouched
    e.preventDefault();
    addFiles(items.map(it => it.getAsFile()).filter(Boolean));
  }

  function removeShot(i) {
    setScreenshots(prev => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!summary.trim() || !message.trim()) return;
    setSending(true); setError(null);
    try {
      const r = await fetch(`${cfg.NEON_PROXY_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
        body: JSON.stringify({
          summary: summary.trim(),
          message: message.trim(),
          page,
          screenshots: screenshots.map(s => ({ data: s.dataUrl })),
        }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Something went wrong sending this — try again in a moment.'); }
      setSent(true);
    } catch (e) {
      setError(e.message);
    }
    setSending(false);
  }

  if (sent) {
    return (
      <StatusModal
        title="Thanks — got it"
        message="Every piece of feedback during beta directly shapes what gets built next. Appreciate you taking the time."
        onClose={onClose}
      />
    );
  }

  return (
    <div className="upgrade-overlay" onClick={onClose}>
      <div className="upgrade-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="upgrade-modal__title" style={{ marginBottom: 4 }}>Send feedback</div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 14px' }}>
          Bug, confusing moment, something you wish existed — all of it helps during beta.
        </p>
        <input
          className="feedback-input"
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="Summary — one line"
          maxLength={200}
          autoFocus
        />
        <textarea
          className="feedback-textarea"
          style={{ marginTop: 8 }}
          value={message}
          onChange={e => setMessage(e.target.value)}
          onPaste={onPaste}
          placeholder="What's on your mind? (you can paste a screenshot directly in here)"
          rows={5}
        />
        {screenshots.length > 0 && (
          <div className="feedback-shots">
            {screenshots.map((s, i) => (
              <div key={i} className="feedback-shot">
                <img src={s.dataUrl} alt={s.name} />
                <button className="feedback-shot__remove" onClick={() => removeShot(i)} title="Remove" aria-label="Remove screenshot">
                  <IconClose style={{ width: 10, height: 10 }} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={screenshots.length >= FEEDBACK_MAX_SCREENSHOTS}
          >
            Attach screenshot
          </button>
          <span className="td-muted" style={{ fontSize: '0.6875rem' }}>or paste one into the text box</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>
        {shotError && <div className="checkout-error" style={{ marginTop: 10 }}>{shotError}</div>}
        {error && <div className="checkout-error" style={{ marginTop: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!summary.trim() || !message.trim() || sending} onClick={submit}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Company profile card ─────────────────────────────────────────────────────
// Shown at the top of the ticker detail panel. Pulls Finnhub profile (market cap,
// industry, exchange, logo) and EDGAR description (Item 1 business summary).
function CompanyProfileCard({ ticker, cik, company }) {
  const { profile, metrics, desc, loading } = useCompanyProfile(ticker, cik);

  const mktCap = profile?.marketCapitalization
    ? `$${(profile.marketCapitalization / 1000).toFixed(1)}B`
    : null;
  const w52hi = metrics?.['52WeekHigh'] ? `$${Number(metrics['52WeekHigh']).toFixed(2)}` : null;
  const w52lo = metrics?.['52WeekLow'] ? `$${Number(metrics['52WeekLow']).toFixed(2)}` : null;
  const pe = metrics?.['peNormalizedAnnual'] ? Number(metrics['peNormalizedAnnual']).toFixed(1) : null;
  const beta = metrics?.['beta'] ? Number(metrics['beta']).toFixed(2) : null;

  if (loading) return <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '0.5px solid var(--border)' }}><Spinner size={14} /><span className="td-muted" style={{ fontSize: '0.75rem' }}>Loading profile…</span></div>;
  if (!profile && !desc) return null;

  return (
    <div className="co-profile-card">
      {/* Header: logo + name + exchange */}
      <div className="co-profile-card__top">
        {profile?.logo && <img src={profile.logo} alt="" className="co-profile-card__logo" onError={e => e.target.style.display = 'none'} />}
        <div style={{ minWidth: 0 }}>
          <div className="co-profile-card__name">{profile?.name || company}</div>
          <div className="co-profile-card__sub">
            {[profile?.exchange, profile?.finnhubIndustry, profile?.country].filter(Boolean).join(' · ')}
          </div>
        </div>
        {profile?.weburl && <a href={profile.weburl} target="_blank" rel="noreferrer" className="co-profile-card__web">↗</a>}
      </div>

      {/* Key stats row */}
      {(mktCap || w52hi || pe || beta) && (
        <div className="co-profile-stats">
          {mktCap && <div className="co-profile-stat"><span className="co-profile-stat__label">Market cap</span><span className="co-profile-stat__val">{mktCap}</span></div>}
          {(w52hi && w52lo) && <div className="co-profile-stat"><span className="co-profile-stat__label">52w range</span><span className="co-profile-stat__val">{w52lo} – {w52hi}</span></div>}
          {pe && <div className="co-profile-stat"><span className="co-profile-stat__label">P/E</span><span className="co-profile-stat__val">{pe}</span></div>}
          {beta && <div className="co-profile-stat"><span className="co-profile-stat__label">Beta</span><span className="co-profile-stat__val">{beta}</span></div>}
        </div>
      )}

      {/* Description — truncated with "more" expand */}
      {desc && <CompanyDescExpanded desc={desc} />}
    </div>
  );
}

function CompanyDescExpanded({ desc }) {
  const [exp, setExp] = useState(false);
  const SHORT = 280;
  const short = desc.length > SHORT && !exp;
  return (
    <div className="co-profile-desc">
      {short ? desc.slice(0, SHORT).trimEnd() + '…' : desc}
      {desc.length > SHORT && (
        <button className="co-profile-desc__toggle" onClick={() => setExp(e => !e)}>
          {exp ? ' less' : ' more'}
        </button>
      )}
    </div>
  );
}

// ─── Star (watchlist) button ──────────────────────────────────────────────────
function StarBtn({ ticker, watchlist }) {
  const isWatched = watchlist.has(ticker);
  const isPro = watchlist.pro;
  // Free users get FREE_WATCHLIST_LIMIT real slots; only look locked once they're full.
  const full = !isPro && !isWatched && watchlist.freeSlotsLeft === 0;
  const title = isWatched ? 'Remove from watchlist'
    : isPro ? 'Add to watchlist'
    : full ? `Free watchlist is full (${watchlist.freeLimit}). Pro makes it unlimited.`
    : `Add to watchlist (${watchlist.freeSlotsLeft} of ${watchlist.freeLimit} free slots left)`;
  return (
    <button
      className={`star-btn${isWatched ? ' star-btn--active' : ''}${full ? ' star-btn--locked' : ''}`}
      title={title}
      onClick={e => { e.stopPropagation(); watchlist.toggle(ticker); }}>
      <svg viewBox="0 0 24 24" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  );
}

// Follow button for insiders — same pattern as StarBtn
function FollowBtn({ name, watchlist, compact = false }) {
  const isFollowing = watchlist.hasInsider(name);
  const isPro = watchlist.pro;
  if (compact) {
    // Icon-only variant for use inside table rows
    return (
      <button
        className={`star-btn${isFollowing ? ' star-btn--active' : ''}${!isPro ? ' star-btn--locked' : ''}`}
        title={isPro ? (isFollowing ? 'Unfollow' : 'Follow insider') : 'Pro feature'}
        onClick={e => { e.stopPropagation(); watchlist.toggleInsider(name); }}>
        <svg viewBox="0 0 24 24" fill={isFollowing ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} width="12" height="12">
          <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
      </button>
    );
  }
  return (
    <button
      className={`follow-btn${isFollowing ? ' follow-btn--active' : ''}${!isPro ? ' follow-btn--locked' : ''}`}
      title={isPro ? (isFollowing ? 'Unfollow insider' : 'Follow insider — get alerts on their trades') : 'Pro feature — upgrade to follow insiders'}
      onClick={e => { e.stopPropagation(); watchlist.toggleInsider(name); }}>
      <svg viewBox="0 0 24 24" fill={isFollowing ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} width="10" height="10" style={{ marginRight: 4, verticalAlign: '-1px' }}><circle cx="12" cy="12" r="9" /></svg>
      {isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}


// DetailPanelHeader extracted from DetailPanel to avoid TDZ
function DetailPanelHeader({ d, traderStats, traderRows, inline, watchlist, nav }) {
  if (d.type === 'trader') {
    const affs = traderStats?.affiliations || [];
    const maxChips = inline ? affs.length : 3; // inline = explore, show all
    const visibleAffs = affs.slice(0, maxChips);
    const hiddenCount = affs.length - visibleAffs.length;
    return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>{d.name}{traderRows?.[0]?.is_entity_owner && <span className="entity-badge" title="This may be an entity (Trust/LLC) rather than an individual"><IconWarning style={{ width: 9, height: 9, marginRight: 2, verticalAlign: "-1px" }} />entity</span>}</div>{affs.length > 0 && <div className="trader-aff-list">{visibleAffs.map((a) => <span key={a.ticker} className="trader-aff-chip" title={`${a.title || REL_LABELS[a.relationship] || 'Director'} at ${a.ticker}`}><span className="trader-aff-chip__role">{shortRole(a.title) || REL_LABELS[a.relationship] || 'Director'}</span> at <span className="ticker dp-clickable" onClick={() => nav('ticker', { ticker: a.ticker, company: a.company })}>{a.ticker}</span></span>)}{hiddenCount > 0 && <span className="trader-aff-chip trader-aff-chip--more">+{hiddenCount} more</span>}</div>}</div>{watchlist && <FollowBtn name={d.name} watchlist={watchlist} />}</div>;
  }
  if (d.type === 'ticker') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="ticker" style={{ fontSize: 17 }}>{d.ticker}</span>
      <span style={{ fontSize: 13, color: 'var(--text-2)', flex: 1 }}>{d.company}</span>
      {watchlist && <StarBtn ticker={d.ticker} watchlist={watchlist} />}
    </div>
  );
  if (d.type === 'signal') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="ticker dp-clickable" style={{ fontSize: 17, cursor: 'pointer' }}
        onClick={() => nav('ticker', { ticker: d.ticker, company: d.company })}>{d.ticker}</span>
      <span style={{ fontSize: 13, color: 'var(--text-2)', flex: 1 }}>{d.company}</span>
      <button className="dp-explore-btn" onClick={() => nav('ticker', { ticker: d.ticker, company: d.company })}>
        View all activity →
      </button>
      {watchlist && <StarBtn ticker={d.ticker} watchlist={watchlist} />}
    </div>
  );
  if (d.type === 'transaction') return <div><div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span className="ticker" style={{ fontSize: 15 }}>{d.trade?.ticker}</span><span style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>{d.trade?.company_name || d.trade?.company}</span></div><div className="td-muted" style={{ fontSize: '0.6875rem' }}>Transaction</div></div>;
}

// RelBadge and TRow extracted to module level to prevent TDZ
const RelBadge = ({ rel }) => <Badge type={`rel-${rel}`}>{rel === 'strong' ? 'Exec' : rel === 'medium' ? 'Officer' : 'Director'}</Badge>;


function DetailPanel({ detail, filings, onClose, onNavigate, onBack, canGoBack, watchlist, inline = false, onExpand, hideProfileCard = false }) {
  // Note: this component is only ever mounted by the caller when `detail` is
  // truthy (see App's panelOpen guard), so `d` is always defined here. No
  // early-return guard before the hooks below — that pattern breaks React's
  // hooks ordering the moment `detail` could vary between renders of the same
  // mounted instance (see the PortfolioSection fix for a real instance of this).
  const d = detail;

  const [traderRows, setTraderRows] = useState(null);
  const [tickerRows, setTickerRows] = useState(null);
  const [signalPrice, setSignalPrice] = useState(null); // current price for signal-type details
  const [busy, setBusy] = useState(false);
  const [bundleOn, setBundleOn] = useState(true);
  const [omOnly, setOmOnly] = useState(true);

  // Fetch current price for signal-type details so the NOW column shows data.
  // Signal trades come from the client-side filings array (no price join),
  // unlike ticker/trader details which use server queries with LATERAL JOIN.
  useEffect(() => {
    if (d.type !== 'signal' || !d.ticker) return;
    setSignalPrice(null);
    queryNeon(`SELECT close::float AS current_price FROM public.prices_history WHERE ticker='${(d.ticker || '').replace(/'/g, "''")}' ORDER BY date DESC LIMIT 1`)
      .then(r => setSignalPrice(r?.[0]?.current_price ?? null))
      .catch(() => setSignalPrice(null));
  }, [d.type, d.ticker]);
  // When the current detail originated from the Data page (it has
  // dataFilters), carry those filters forward to any sub-navigation so
  // that expanding always opens the DataDrawer (filings explore), not the
  // InsightsDrawer (signals explore). Without this, clicking "All SYBT
  // trades →" from a Data-originated transaction would lose the dataFilters
  // on the new detail, causing expand to fall through to InsightsDrawer.
  const nav = (type, data, opts) => {
    // Stocks and people are pages now. This panel only survives inside the
    // Data page's explore drawers, and a click on a ticker or a name there
    // goes to its page like everywhere else.
    if (type === 'ticker' && data?.ticker) { go(stockPath(data.ticker)); return; }
    if (type === 'trader' && data?.name) { go(insiderPath(data.name)); return; }
    if (!onNavigate) return;
    const forwarded = d.dataFilters ? { dataFilters: d.dataFilters, ...data } : data;
    onNavigate({ type, ...forwarded }, opts);
  };

  const TRow = ({ r, showTicker, showInsider }) => {
    const tt = r.transaction_type || r.transactionType;
    const code = r.transaction_code || r.transactionCode;
    const isOM = r.is_open_market || r.isOpenMarket;
    const pr = r.price || r.price_per_share;
    const cur = r.current_price || r.currentPrice;
    // Only P/S codes carry a real market price. A/M/J/etc often show $0 or a
    // strike price that isn't comparable — don't compute a misleading return.
    const hasRealPrice = isOM && pr > 0;
    const isForeign = r.is_foreign_price || r.isForeignPrice || (hasRealPrice && cur && Math.abs((cur - pr) / pr) >= 3);
    // For a BUY, price rising afterward is a good outcome. For a SELL, it's
    // the opposite — price rising after you sold means you left money on
    // the table. The percentage shown stays true to the actual price move
    // (so it never contradicts the prices displayed next to it — a sale
    // shown at $6.94 → $7.69 should never read as a negative number, that
    // would look like a math error), but the color now reflects whether
    // this was actually a good outcome for THIS trade's direction, which
    // previously used the same green-if-positive logic for both buys and
    // sells — backwards for every sell.
    const ret = (hasRealPrice && cur && !isForeign) ? ((cur - pr) / pr * 100) : null;
    const isGoodOutcome = ret != null ? (tt === 'sell' ? ret < 0 : ret >= 0) : null;
    const dt = r.transaction_date || r.transactionDate || r.date;
    const codeLabel = TX_CODE_TOOLTIPS[code] || code;
    const dateLabel = r._isCluster ? `${fmt.dateShort(r.transaction_date)}–${fmt.dateShort(r._lastDate)}` : fmt.dateShort(dt);
    const secUrl = secFilingUrl(r.accessionNumber || r.accession_number, r.cikIssuer || r.cik_issuer);
    const secIcon = secUrl ? (
      <a href={secUrl} target="_blank" rel="noopener noreferrer"
        className="dp-trade-sec-link"
        title="View original SEC filing"
        onClick={e => e.stopPropagation()}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V11" />
          <path d="M9 2h5v5" />
          <path d="M14 2 7 9" />
        </svg>
        <span className="dp-trade-sec-tooltip">View SEC filing</span>
      </a>
    ) : null;
    // Scopes the eventual "expand to full Explore view" to whatever this
    // panel itself represents — DataDrawer already restores every filter
    // from this object and scrolls to/highlights the exact row that opened
    // it (see its own scrolledOnOpenRef effect), it just needed a caller
    // that actually attaches a dataFilters payload. Ticker/trader panels
    // are the two contexts this row list is used in with a real single
    // subject to scope to; anywhere else (a compact signals widget with no
    // one fixed subject) this stays null and expand falls back to the
    // existing general Insights drawer, unchanged.
    const rowDataFilters = d.type === 'ticker' && d.ticker ? { search: d.ticker }
      : d.type === 'trader' && d.name ? { search: d.name }
        : null;
    const openTransaction = () => nav('transaction', { trade: r, dataFilters: rowDataFilters });
    return (
      <div className={`dp-trade dp-trade--${tt} dp-clickable`}
        role="button" tabIndex={0}
        onClick={openTransaction}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTransaction(); } }}>
        <div className={`dp-trade-split${inline ? '' : ' dp-trade-split--stacked'}`}>
          {/* LEFT — context: what kind of trade, when, who/what ticker.
  
              The wide inline drawer (Filings Explore) keeps this to just
              name+date — Buy/Sell + code become their OWN column in the
              grid below, aligned with Shares/Price/etc., instead of a
              separate badge cluster floating next to the name that didn't
              line up with anything. The narrow docked panel has room to
              keep badges attached to the row's top line instead. */}
          {inline ? (
            <div className="dp-trade-left">
              <div className="dp-trade-left__top">
                {showInsider && r.insider_name
                  ? <span className="dp-clickable dp-trade-row2__name dp-trade-row2__name--lg" onClick={(e) => { e.stopPropagation(); nav('trader', { name: r.insider_name, title: r.title }); }}>{r.insider_name}</span>
                  : <><span className="dp-trade-date">{dateLabel}</span>{secIcon}</>}
                {r._isCluster && <span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
                {isForeign && <span style={{ color: 'var(--amber-600)' }} title="Price move too large to be reliable — verify manually"><IconWarning style={{ width: 10, height: 10, display: 'inline', verticalAlign: '-1px' }} /></span>}
              </div>
              <div className="dp-trade-left__bottom">
                {showInsider && r.insider_name && <><span className="dp-trade-date">{dateLabel}</span>{secIcon}</>}
                {showTicker && r.ticker && <span className="ticker dp-clickable" onClick={(e) => { e.stopPropagation(); nav('ticker', { ticker: r.ticker, company: r.company_name }); }}>{r.ticker}</span>}
              </div>
            </div>
          ) : showInsider && r.insider_name ? (
            <div className="dp-trade-toprow">
              <div className="dp-trade-toprow__left">
                <span className="dp-clickable dp-trade-row2__name" onClick={(e) => { e.stopPropagation(); nav('trader', { name: r.insider_name, title: r.title }); }}>{r.insider_name}</span>
                <div className="dp-trade-toprow__meta">
                  <span className="dp-trade-date">{dateLabel}</span>
                  {secIcon}
                  {r._isCluster && <span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
                  {isForeign && <span style={{ color: 'var(--amber-600)' }} title="Price move too large to be reliable — verify manually"><IconWarning style={{ width: 10, height: 10, display: 'inline', verticalAlign: '-1px' }} /></span>}
                </div>
              </div>
              <div className="dp-trade-toprow__badges">
                <Badge type={tt === 'buy' ? 'buy' : tt === 'sell' ? 'sell' : 'other'}>{tt === 'buy' ? <><IconBuyTri style={{ width: 8, height: 8, marginRight: 3 }} />Buy</> : tt === 'sell' ? <><IconSellTri style={{ width: 8, height: 8, marginRight: 3 }} />Sell</> : '◆'}</Badge>
                <span className="code-pill" title={codeLabel}>{(code === 'P' || code === 'S') ? code : (TX_CODE_SHORT[code] || code)}</span>
                {isOM && <span className="dp-trade-om-label">Open market</span>}
              </div>
            </div>
          ) : (
            <div className="dp-trade-left">
              <div className="dp-trade-left__top">
                <span className="dp-trade-date">{dateLabel}</span>
                {secIcon}
                {r._isCluster && <span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
              </div>
              <div className="dp-trade-left__bottom">
                <Badge type={tt === 'buy' ? 'buy' : tt === 'sell' ? 'sell' : 'other'}>{tt === 'buy' ? <><IconBuyTri style={{ width: 8, height: 8, marginRight: 3 }} />Buy</> : tt === 'sell' ? <><IconSellTri style={{ width: 8, height: 8, marginRight: 3 }} />Sell</> : '◆'}</Badge>
                <span className="code-pill" title={codeLabel}>{(code === 'P' || code === 'S') ? code : (TX_CODE_SHORT[code] || code)}</span>
                {showTicker && r.ticker && <span className="ticker dp-clickable" onClick={(e) => { e.stopPropagation(); nav('ticker', { ticker: r.ticker, company: r.company_name }); }}>{r.ticker}</span>}
                {isForeign && <span style={{ color: 'var(--amber-600)' }} title="Price move too large to be reliable — verify manually"><IconWarning style={{ width: 10, height: 10, display: 'inline', verticalAlign: '-1px' }} /></span>}
              </div>
            </div>
          )}
          {/* RIGHT — every number that describes the purchase itself, all
              grouped together and explicitly labeled: shares, price then,
              price now, position change, and the total dollar amount.
  
              In the wide inline drawer (`inline`), this is a fixed 5-column
              grid where EVERY column slot always renders — showing "—" when
              a value doesn't apply — so the columns line up vertically across
              every transaction row regardless of which fields each row has.
              In the narrow docked side panel there isn't room for a rigid
              5-column table, so it keeps the original content-width flex
              layout that only shows the cells that apply. */}
          {inline ? (
            <div className="dp-trade-right dp-trade-right--grid">
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Type</span>
                <span className="dp-trade-detail__val dp-trade-detail__val--type">
                  <Badge type={tt === 'buy' ? 'buy' : tt === 'sell' ? 'sell' : 'other'}>{tt === 'buy' ? <><IconBuyTri style={{ width: 8, height: 8, marginRight: 3 }} />Buy</> : tt === 'sell' ? <><IconSellTri style={{ width: 8, height: 8, marginRight: 3 }} />Sell</> : '◆'}</Badge>
                  <span className="code-pill" title={codeLabel}>{(code === 'P' || code === 'S') ? code : (TX_CODE_SHORT[code] || code)}</span>
                </span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Shares</span>
                <span className="dp-trade-detail__val">{r.shares ? fmt.number(r.shares) : '—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Price</span>
                <span className="dp-trade-detail__val">{hasRealPrice ? fmt.price(pr) : '—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Now</span>
                {hasRealPrice && ret != null
                  ? <span className={`dp-trade-detail__val ${isGoodOutcome ? 'val-buy' : 'val-sell'}`}>{fmt.price(cur)} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)</span>
                  : <span className="dp-trade-detail__val td-muted">—</span>}
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">% of position</span>
                <span className="dp-trade-detail__val val-buy">{(r.pct_owned_change || r.pctOwnedChange) != null ? `+${(r.pct_owned_change || r.pctOwnedChange).toFixed(0)}%` : '—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Total</span>
                <span className="dp-trade-detail__val dp-trade-detail__val--total">{r.value ? fmt.money(r.value) : '—'}</span>
              </div>
            </div>
          ) : (
            <div className="dp-trade-right">
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Shares</span>
                <span className="dp-trade-detail__val">{r.shares ? fmt.number(r.shares) : '—'}</span>
              </div>
              {hasRealPrice ? (<>
                <div className="dp-trade-detail">
                  <span className="dp-trade-detail__label">Price</span>
                  <span className="dp-trade-detail__val">{fmt.price(pr)}</span>
                </div>
                {ret != null && (
                  <div className="dp-trade-detail">
                    <span className="dp-trade-detail__label">Now</span>
                    <span className={`dp-trade-detail__val ${isGoodOutcome ? 'val-buy' : 'val-sell'}`}>
                      {fmt.price(cur)} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)
                    </span>
                  </div>
                )}
              </>) : null}
              {(r.pct_owned_change || r.pctOwnedChange) != null && (
                <div className="dp-trade-detail">
                  <span className="dp-trade-detail__label">% of position</span>
                  <span className="dp-trade-detail__val val-buy">+{(r.pct_owned_change || r.pctOwnedChange).toFixed(0)}%</span>
                </div>
              )}
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Total</span>
                <span className="dp-trade-detail__val dp-trade-detail__val--total">{r.value ? fmt.money(r.value) : '—'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (d.type !== 'trader') return;
    setTraderRows(null); setBusy(true);
    queryNeon(`
      SELECT f.accession_number,f.cik_issuer,
             f.transaction_date,f.filing_date,f.ticker,f.company_name,
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
      WHERE f.insider_name='${d.name.replace(/'/g, "''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r => { setTraderRows(r); setBusy(false); }).catch(() => { setTraderRows([]); setBusy(false); });
  }, [d.type, d.name]);

  useEffect(() => {
    if (d.type !== 'ticker') return;
    setTickerRows(null); setBusy(true);
    queryNeon(`
      SELECT f.accession_number,f.transaction_date,f.filing_date,f.insider_name,
             f.insider_title AS title,f.relationship,
             f.transaction_type,f.transaction_code,f.is_open_market,
             f.shares::float,f.price_per_share::float AS price,
             f.value::float,f.pct_owned_change::float,f.sector,
             f.cik_issuer,
             ph.close::float AS current_price,
             CASE WHEN f.price_per_share>0 AND ph.close IS NOT NULL
               AND ABS((ph.close-f.price_per_share)/f.price_per_share)>=3.0
               THEN true ELSE false END AS is_foreign_price
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph ON true
      WHERE f.ticker='${(d.ticker || '').replace(/'/g, "''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r => { setTickerRows(r); setBusy(false); }).catch(() => { setTickerRows([]); setBusy(false); });
  }, [d.type, d.ticker]);

  const traderStats = useMemo(() => {
    if (!traderRows?.length) return null;
    const buys = traderRows.filter(r => r.transaction_type === 'buy');
    const sells = traderRows.filter(r => r.transaction_type === 'sell');
    const omBuys = buys.filter(r => r.is_open_market);
    const omSells = sells.filter(r => r.is_open_market);

    // Only P/S coded trades have a real, economically meaningful price.
    // Grants (A), exercises (M), and "other" (J) often carry $0 or a strike
    // price that isn't comparable to market price — exclude these from
    // return calculations entirely rather than silently treating $0 as a loss.
    const pricedBuys = omBuys.filter(r => r.price > 0 && r.current_price != null && Math.abs((r.current_price - r.price) / r.price) < 3);
    const pricedSells = omSells.filter(r => r.price > 0);

    // Unrealized: buys where stock is still above/below entry today
    const buyWinners = pricedBuys.filter(r => r.current_price >= r.price);
    const avgUnrealizedReturn = pricedBuys.length
      ? +(pricedBuys.reduce((s, r) => s + ((r.current_price - r.price) / r.price * 100), 0) / pricedBuys.length).toFixed(1)
      : null;

    // Realized: did sells happen at a profit relative to that insider's own
    // average buy price on the same ticker? This is the actual "did they make
    // money" question, not just "did the stock go up since any buy."
    const buyPriceByTicker = {};
    for (const r of pricedBuys) {
      if (!buyPriceByTicker[r.ticker]) buyPriceByTicker[r.ticker] = { totalCost: 0, totalShares: 0 };
      buyPriceByTicker[r.ticker].totalCost += r.price * (r.shares || 0);
      buyPriceByTicker[r.ticker].totalShares += (r.shares || 0);
    }
    const realizedTrades = pricedSells.map(r => {
      const bp = buyPriceByTicker[r.ticker];
      const avgCost = bp && bp.totalShares > 0 ? bp.totalCost / bp.totalShares : null;
      const realizedReturn = avgCost ? ((r.price - avgCost) / avgCost * 100) : null;
      return { ...r, avgCost, realizedReturn };
    }).filter(r => r.realizedReturn != null);

    const sellWinners = realizedTrades.filter(r => r.realizedReturn >= 0);
    const avgRealizedReturn = realizedTrades.length
      ? +(realizedTrades.reduce((s, r) => s + r.realizedReturn, 0) / realizedTrades.length).toFixed(1)
      : null;

    // Combined hit rate across BOTH sides — this is the honest profitability number
    const allOutcomes = [...pricedBuys.map(() => null), ...realizedTrades]; // placeholder structure
    const winCount = buyWinners.length + sellWinners.length;
    const totalEvaluated = pricedBuys.length + realizedTrades.length;
    const combinedHitRate = totalEvaluated > 0 ? Math.round((winCount / totalEvaluated) * 100) : null;

    // Best performers by ticker (unrealized buy-side, for "what's working" context)
    const byTk = {};
    for (const r of pricedBuys) { if (!byTk[r.ticker]) byTk[r.ticker] = { ticker: r.ticker, ret: 0, count: 0 }; byTk[r.ticker].ret += ((r.current_price - r.price) / r.price) * 100; byTk[r.ticker].count++; }
    const bestTickers = Object.values(byTk).map(t => ({ ...t, avgRet: t.ret / t.count })).sort((a, b) => b.avgRet - a.avgRet).slice(0, 3);

    // Current holding status per ticker: sum all OM buy shares minus OM sell
    // shares, most recent transaction first — tells you if they likely still
    // hold a position based on net share flow.
    const holdingByTicker = {};
    for (const r of traderRows) {
      if (!r.ticker || !r.is_open_market) continue;
      if (!holdingByTicker[r.ticker]) holdingByTicker[r.ticker] = { netShares: 0, lastDate: null };
      const sh = r.shares || 0;
      holdingByTicker[r.ticker].netShares += (r.transaction_type === 'buy' ? sh : -sh);
      const dt = r.transaction_date || r.filing_date;
      if (!holdingByTicker[r.ticker].lastDate || dt > holdingByTicker[r.ticker].lastDate) holdingByTicker[r.ticker].lastDate = dt;
    }
    const holdings = Object.entries(holdingByTicker).map(([ticker, h]) => ({ ticker, ...h, stillHolding: h.netShares > 0 }));

    const dates = traderRows.map(r => r.transaction_date || r.filing_date).filter(Boolean).sort();

    // Build affiliations: for each company this insider has filed at, capture
    // their title, relationship, company name, and most recent activity date.
    // An insider CAN be affiliated with multiple companies (e.g. director on
    // multiple boards). Sort by most recent first — the top entry is their
    // "primary" affiliation.
    const affMap = {};
    for (const r of traderRows) {
      if (!r.ticker) continue;
      const dt = r.transaction_date || r.filing_date || '';
      if (!affMap[r.ticker] || dt > affMap[r.ticker].lastDate) {
        affMap[r.ticker] = {
          ticker: r.ticker,
          company: r.company_name || r.ticker,
          title: r.title || '',
          relationship: r.relationship || 'weak',
          lastDate: dt,
        };
      }
    }
    const affiliations = Object.values(affMap).sort((a, b) => b.lastDate.localeCompare(a.lastDate));

    return {
      totalBuys: buys.length, sells: sells.length, omBuys: omBuys.length, omSells: omSells.length,
      avgReturn: avgUnrealizedReturn, avgRealizedReturn, hitRate: combinedHitRate, combinedHitRate,
      withReturn: totalEvaluated,
      totalBuyVal: omBuys.reduce((s, r) => s + (r.value || 0), 0),
      totalSellVal: omSells.reduce((s, r) => s + (r.value || 0), 0),
      companies: [...new Set(traderRows.map(r => r.ticker).filter(Boolean))],
      sectors: [...new Set(traderRows.map(r => r.sector).filter(Boolean))],
      role: affiliations[0]?.relationship || 'weak',
      title: affiliations[0]?.title || '',
      affiliations,
      bestTickers, holdings,
      firstTrade: dates[dates.length - 1], lastTrade: dates[0],
    };
  }, [traderRows]);

  // Per-stock breakdown: for each ticker this insider has traded, compute
  // hold duration pattern (avg days between matched buy->sell pairs), avg
  // filing lag, current estimated position + live value, and a reversal-
  // paired transaction list (FIFO-matched buys/sells with realized P&L and
  // hold time per closed round-trip).
  const perStockBreakdown = useMemo(() => {
    if (!traderRows?.length) return [];
    // In OM-only mode, only consider rows that are open-market P/S transactions
    // for ALL calculations (position, hold time, P&L). In all-data mode, every
    // row counts toward the position calc but P&L/hold-time still only uses
    // priced (OM) trades since grants/exercises don't have a comparable cost basis.
    const sourceRows = omOnly ? traderRows.filter(r => r.is_open_market) : traderRows;
    const byTicker = {};
    for (const r of sourceRows) {
      if (!r.ticker) continue;
      if (!byTicker[r.ticker]) byTicker[r.ticker] = [];
      byTicker[r.ticker].push(r);
    }

    return Object.entries(byTicker).map(([ticker, rows]) => {
      const sorted = [...rows].sort((a, b) => {
        const ad = a.transaction_date || a.filing_date || '', bd = b.transaction_date || b.filing_date || '';
        return ad.localeCompare(bd); // oldest first for FIFO matching
      });

      // FIFO match: walk chronologically, maintain an open-lot queue of buys,
      // match each sell against the oldest open buy(s) to compute hold time
      // and realized P&L per round-trip.
      const lots = []; // {date, shares remaining, price}
      const roundTrips = [];
      for (const r of sorted) {
        if (!r.is_open_market) continue; // only OM trades for hold-time/P&L purposes
        const dt = r.transaction_date || r.filing_date;
        if (r.transaction_type === 'buy' && r.price > 0) {
          lots.push({ date: dt, shares: r.shares || 0, price: r.price });
        } else if (r.transaction_type === 'sell' && r.price > 0) {
          let sellSharesRemaining = r.shares || 0;
          while (sellSharesRemaining > 0 && lots.length > 0) {
            const lot = lots[0];
            const matched = Math.min(lot.shares, sellSharesRemaining);
            if (matched > 0) {
              const buyDt = new Date(lot.date + 'T00:00:00');
              const sellDt = new Date(dt + 'T00:00:00');
              const holdDays = Math.round((sellDt - buyDt) / 86400000);
              roundTrips.push({
                ticker, buyDate: lot.date, sellDate: dt, shares: matched,
                buyPrice: lot.price, sellPrice: r.price,
                pnl: (r.price - lot.price) * matched,
                pnlPct: ((r.price - lot.price) / lot.price) * 100,
                holdDays,
              });
            }
            lot.shares -= matched;
            sellSharesRemaining -= matched;
            if (lot.shares <= 0.001) lots.shift();
          }
        }
      }

      // Avg hold time across closed round-trips
      const avgHoldDays = roundTrips.length
        ? Math.round(roundTrips.reduce((s, rt) => s + rt.holdDays, 0) / roundTrips.length)
        : null;

      // Avg filing lag for this ticker
      const lagRows = rows.filter(r => r.filing_lag_days != null);
      const avgFilingLag = lagRows.length
        ? Math.round(lagRows.reduce((s, r) => s + r.filing_lag_days, 0) / lagRows.length)
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
      const directRows = sorted.filter(r => !r.is_derivative);
      const reportedShares = [...directRows].reverse().find(r => r.shares_owned_after != null)?.shares_owned_after;
      const fifoRemainingShares = lots.reduce((s, l) => s + l.shares, 0);

      // Sanity bound: SEC-reported figure shouldn't be wildly disproportionate
      // to the actual transaction sizes we've observed for this insider+ticker.
      // If shares_owned_after is more than 200x the largest single transaction
      // we've seen, treat it as suspect (likely a filer typo or scope error)
      // and fall back to the FIFO estimate instead of showing a clearly wrong number.
      const maxTxnShares = Math.max(0, ...sorted.map(r => r.shares || 0));
      const reportedIsPlausible = reportedShares == null || maxTxnShares === 0
        || reportedShares <= maxTxnShares * 200;

      const remainingShares = omOnly
        ? fifoRemainingShares
        : (reportedShares != null && reportedIsPlausible ? reportedShares : fifoRemainingShares);

      const currentPrice = sorted[sorted.length - 1]?.current_price;
      const currentValue = (remainingShares > 0 && currentPrice) ? remainingShares * currentPrice : null;

      const totalRealizedPnl = roundTrips.reduce((s, rt) => s + rt.pnl, 0);
      const company = rows[0]?.company_name;

      return {
        ticker, company, rows: sorted, roundTrips: roundTrips.reverse(), // newest first for display
        avgHoldDays, avgFilingLag, remainingShares, currentPrice, currentValue,
        reportedShares, fifoRemainingShares, totalRealizedPnl,
        positionSource: omOnly ? 'om-fifo' : (reportedShares != null && reportedIsPlausible ? 'sec-reported' : 'om-fifo'),
        positionFlagged: reportedShares != null && !reportedIsPlausible,
        stillHolding: remainingShares > 0.001,
        tradeCount: rows.length,
      };
    }).sort((a, b) => {
      // Most recently active ticker first
      const aLast = a.rows[a.rows.length - 1]?.transaction_date || '';
      const bLast = b.rows[b.rows.length - 1]?.transaction_date || '';
      return bLast.localeCompare(aLast);
    });
  }, [traderRows, omOnly]);

  // Aggregate hero metrics across all stocks — the "headline number" for the profile
  const heroStats = useMemo(() => {
    if (!perStockBreakdown.length) return null;
    const totalRealized = perStockBreakdown.reduce((s, p) => s + (p.totalRealizedPnl || 0), 0);
    const totalCurrentValue = perStockBreakdown.reduce((s, p) => s + (p.currentValue || 0), 0);
    const holdingCount = perStockBreakdown.filter(p => p.stillHolding).length;
    const closedCount = perStockBreakdown.filter(p => !p.stillHolding && p.roundTrips.length > 0).length;
    const hasRealizedData = perStockBreakdown.some(p => p.roundTrips.length > 0);
    return { totalRealized, totalCurrentValue, holdingCount, closedCount, hasRealizedData };
  }, [perStockBreakdown]);

  const tickerStats = useMemo(() => {
    if (!tickerRows?.length) return null;
    const buys = tickerRows.filter(r => r.transaction_type === 'buy');
    const sells = tickerRows.filter(r => r.transaction_type === 'sell');
    const names = [...new Set(tickerRows.map(r => r.insider_name).filter(Boolean))];
    return { buys: buys.length, sells: sells.length, cSuite: buys.filter(r => r.relationship === 'strong' && r.is_open_market).length, insiders: names.length, insiderNames: names.slice(0, 5), net: buys.reduce((s, r) => s + (r.value || 0), 0) - sells.reduce((s, r) => s + (r.value || 0), 0) };
  }, [tickerRows]);

  const tickerRowsDisplay = useMemo(() => {
    if (!tickerRows) return [];
    return bundleOn ? clusterTrades(tickerRows) : tickerRows;
  }, [tickerRows, bundleOn]);

  const byInsider = useMemo(() => {
    if (d.type !== 'signal') return [];
    const map = {};
    const trades = d.trades || [];
    for (const t of trades) { const k = t.insiderName || 'Unknown'; if (!map[k]) map[k] = { name: k, title: t.title, rel: t.relationship, trades: [] }; map[k].trades.push(t); }
    for (const v of Object.values(map)) v.trades.sort((a, b) => (b.transactionDate || b.date || '').localeCompare(a.transactionDate || a.date || ''));
    return Object.values(map).sort((a, b) => { const ra = a.rel === 'strong' ? 0 : a.rel === 'medium' ? 1 : 2, rb = b.rel === 'strong' ? 0 : b.rel === 'medium' ? 1 : 2; if (ra !== rb) return ra - rb; return b.trades.reduce((s, t) => s + (t.value || 0), 0) - a.trades.reduce((s, t) => s + (t.value || 0), 0); });
  }, [d]);

  const score = traderStats ? trustScore(traderStats) : null;

  return (
    <div className={inline ? 'detail-panel detail-panel--inline' : 'detail-panel'}>
      <div className="detail-panel__header">
        {canGoBack && <button className="btn btn--ghost btn--icon" onClick={onBack} title="Back"></button>}
        <div style={{ minWidth: 0, flex: 1 }}>{<DetailPanelHeader d={d} traderStats={traderStats} traderRows={traderRows} inline={inline} watchlist={watchlist} nav={nav} />}</div>
        {!inline && onExpand && <button className="btn btn--ghost btn--icon" onClick={onExpand} title="Open full Explore view">⤢</button>}
        {!inline && <button className="btn btn--ghost btn--icon" onClick={onClose}><IconClose style={{ width: 12, height: 12 }} /></button>}
        {inline && canGoBack && <button className="btn btn--ghost btn--icon" style={{ fontSize: '0.6875rem' }} onClick={onClose} title="Clear"><IconClose style={{ width: 12, height: 12 }} /></button>}
      </div>
      <div className="detail-panel__body">

        {d.type === 'trader' && (busy ? <SkeletonRows count={6} /> : !traderStats ? <div className="state-box" style={{ padding: '2rem' }}><p>No trades found.</p></div> : (<>

          {/* ── Sparse profile gate — need OM buys for meaningful stats ── */}
          {traderStats.omBuys < 2 ? (
            <div className="trader-sparse">
              <div className="trader-sparse__notice">
                <span style={{ fontWeight: 600 }}>Limited data</span>
                <span className="td-muted">This insider has {traderStats.omBuys === 0 ? 'no' : 'only ' + traderStats.omBuys} open-market buy{traderStats.omBuys === 1 ? '' : 's'} on record — not enough to compute performance stats.{traderStats.omSells > 0 ? ` (${traderStats.omSells} sell${traderStats.omSells !== 1 ? 's' : ''} recorded)` : ''}</span>
              </div>
              {traderStats.totalBuys + traderStats.sells > 0 && (
                <div className="td-muted" style={{ fontSize: '0.6875rem', marginTop: 4 }}>
                  {traderStats.totalBuys + traderStats.sells} total filing{traderStats.totalBuys + traderStats.sells !== 1 ? 's' : ''} (including grants, exercises, and other non-market transactions)
                </div>
              )}
              {traderStats.firstTrade && <div className="td-muted" style={{ fontSize: '0.625rem', marginTop: 6 }}>Active {fmt.dateShort(traderStats.firstTrade)} – {fmt.dateShort(traderStats.lastTrade)}</div>}
            </div>
          ) : (<>

            {/* ── Account overview card — hero metrics + stats in one container ── */}
            {heroStats && (
              <div className="trader-hero">
                <div className="trader-hero__top">
                  <div className="trader-hero__metrics">
                    {heroStats.hasRealizedData && (
                      <div className="trader-hero__metric">
                        <div className="trader-hero__label">Realized P&L</div>
                        <div className={`trader-hero__value ${heroStats.totalRealized >= 0 ? 'val-buy' : 'val-sell'}`}>
                          {heroStats.totalRealized >= 0 ? '+' : ''}{fmt.money(heroStats.totalRealized)}
                        </div>
                      </div>
                    )}
                    {heroStats.totalCurrentValue > 0 && (
                      <div className="trader-hero__metric">
                        <div className="trader-hero__label">{heroStats.hasRealizedData ? 'Position Value' : 'Est. Position Value'}</div>
                        <div className={`trader-hero__value${heroStats.hasRealizedData ? ' trader-hero__value--secondary' : ''}`}>
                          {fmt.money(heroStats.totalCurrentValue)}
                        </div>
                      </div>
                    )}
                  </div>
                  {score != null && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, minWidth: 80 }}>
                    <span style={{ fontSize: '0.625rem', color: 'var(--text-3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.04em' }}>Score</span>
                    <span className="td-mono" style={{ fontSize: '0.875rem', fontWeight: 700 }}>{score.toFixed(1)}</span>
                    <ConvictionBar score={score} max={100} />
                  </div>}
                </div>
                <div className="trader-hero__chips">
                  <span className="hero-chip">{heroStats.holdingCount} holding{heroStats.holdingCount !== 1 ? 's' : ''}</span>
                  <span className="hero-chip">{heroStats.closedCount} closed</span>
                  {traderStats.combinedHitRate != null &&
                    <span className={`hero-chip ${traderStats.combinedHitRate >= 60 ? 'hero-chip--good' : traderStats.combinedHitRate < 40 ? 'hero-chip--bad' : ''}`}>
                      {traderStats.combinedHitRate}% hit rate
                    </span>}
                  {traderStats.firstTrade && <span className="hero-chip">{fmt.dateShort(traderStats.firstTrade)} – {fmt.dateShort(traderStats.lastTrade)}</span>}
                </div>
                {/* Stats breakdown — inside the hero card. Collapsed in sidebar, open in explore. */}
                <details className="trader-stats-toggle" open={inline}>
                  <summary>Stats breakdown</summary>
                  <div className="dp-summary" style={{ marginTop: 8 }}>
                    <div className="dp-sum-item"><span className="dp-sum-label">OM Buys</span><span className="val-buy dp-sum-val">{traderStats.omBuys}</span></div>
                    <div className="dp-sum-item"><span className="dp-sum-label">OM Sells</span><span className="val-sell dp-sum-val">{traderStats.omSells}</span></div>
                    <div className="dp-sum-item"><span className="dp-sum-label">Bought $</span><span className="dp-sum-val">{fmt.money(traderStats.totalBuyVal)}</span></div>
                    <div className="dp-sum-item"><span className="dp-sum-label">Sold $</span><span className="dp-sum-val">{fmt.money(traderStats.totalSellVal)}</span></div>
                    {traderStats.combinedHitRate != null && <div className="dp-sum-item"><span className="dp-sum-label">Hit Rate <span className="trust-explain" title="% of priced buy+sell events that were profitable. Buys: stock up since purchase. Sells: sold above their own avg cost basis.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.combinedHitRate >= 60 ? 'val-buy' : traderStats.combinedHitRate < 40 ? 'val-sell' : ''}`}>{traderStats.combinedHitRate}% <span style={{ fontSize: '0.6875rem', opacity: .7 }}>({traderStats.withReturn} events)</span></span></div>}
                    {traderStats.avgRealizedReturn != null && <div className="dp-sum-item"><span className="dp-sum-label">Realized Avg <span className="trust-explain" title="Average % gain/loss on actual sells, vs their own historical average buy price on that ticker.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.avgRealizedReturn >= 0 ? 'val-buy' : 'val-sell'}`}>{traderStats.avgRealizedReturn >= 0 ? '+' : ''}{traderStats.avgRealizedReturn}%</span></div>}
                    {traderStats.avgReturn != null && <div className="dp-sum-item"><span className="dp-sum-label">Unrealized Avg <span className="trust-explain" title="Average % the stock has moved since their open-market buys, vs current price.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.avgReturn >= 0 ? 'val-buy' : 'val-sell'}`}>{traderStats.avgReturn >= 0 ? '+' : ''}{traderStats.avgReturn}%</span></div>}
                  </div>
                </details>
              </div>
            )}

          </>)}

          {perStockBreakdown.length > 0 && (<>
            <div className="dp-section-label" style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Positions</span>
              <div style={{ display: 'flex', gap: 10 }}>
                {inline && (
                  <label className="bundle-toggle" title="Bundle consecutive same-direction trades by this insider within a few days into one row.">
                    <input type="checkbox" checked={bundleOn} onChange={e => setBundleOn(e.target.checked)} />
                    Bundle nearby
                  </label>
                )}
                <label className="bundle-toggle" title="When on, every number on this page — position, hold-time, P&L, and the transactions listed below — uses ONLY open-market (real cash) buys and sells. Grants, exercises, and gifts are excluded entirely. When off, current position uses the insider's own SEC-reported total holdings, but hold-time/P&L still only ever use priced trades.">
                  <input type="checkbox" checked={omOnly} onChange={e => setOmOnly(e.target.checked)} />
                  Own-money purchases only
                </label>
              </div>
            </div>
            {perStockBreakdown.map((s, i) => {
              const displayRows = (inline ? bundleOn : true) ? clusterTrades(s.rows) : s.rows;
              return (
                <div key={i} className="position-card">
                  <div className="position-card__top">
                    <div className="position-card__id">
                      <span className="ticker dp-clickable" style={{ fontSize: 14 }} onClick={() => nav('ticker', { ticker: s.ticker, company: s.company })}>{s.ticker}</span>
                      <span className={`holding-status ${s.stillHolding ? 'holding-status--yes' : 'holding-status--no'}`}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="7" height="7" style={{ marginRight: 3, verticalAlign: '-0.5px' }}><circle cx="12" cy="12" r="10" /></svg>
                        {s.stillHolding ? 'Holding' : 'Closed'}
                      </span>
                    </div>
                    <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{s.tradeCount} txn{s.tradeCount !== 1 ? 's' : ''}</span>
                  </div>

                  <div className="position-card__value-row">
                    <div className="position-card__value-block">
                      <span className="position-card__value-label">
                        {s.stillHolding ? 'Current Position' : 'Realized P&L'}
                        <span className="trust-explain" title={s.stillHolding ? (s.positionFlagged ? "The SEC-reported share count for this ticker looked implausible relative to actual transaction sizes (likely a derivative-security mix-up or filer error), so we fell back to an open-market-only estimate instead." : s.positionSource === 'sec-reported' ? "From the insider's own most recent SEC-reported total holdings (includes grants, exercises, gifts, everything)." : "From open-market buy/sell flow only (FIFO). May understate true holdings if they also received grants or exercised options.") : "Sum of all closed FIFO-matched round-trips, open-market trades only."}>ⓘ</span>
                      </span>
                      {s.stillHolding ? (
                        <span className="position-card__value">
                          {fmt.number(s.remainingShares)} sh
                          {s.currentValue && <span className="position-card__value-sub"> · {fmt.money(s.currentValue)}</span>}
                        </span>
                      ) : (
                        <span className={`position-card__value ${s.totalRealizedPnl >= 0 ? 'val-buy' : 'val-sell'}`}>
                          {s.roundTrips.length ? `${s.totalRealizedPnl >= 0 ? '+' : ''}${fmt.money(s.totalRealizedPnl)}` : '—'}
                        </span>
                      )}
                    </div>
                    {s.stillHolding && s.roundTrips.length > 0 && (
                      <div className="position-card__value-block position-card__value-block--secondary">
                        <span className="position-card__value-label">Realized so far</span>
                        <span className={`position-card__value position-card__value--small ${s.totalRealizedPnl >= 0 ? 'val-buy' : 'val-sell'}`}>
                          {s.totalRealizedPnl >= 0 ? '+' : ''}{fmt.money(s.totalRealizedPnl)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="position-card__meta">
                    <span title="Average days held across closed round-trips">⏱ {s.avgHoldDays != null ? `${s.avgHoldDays}d avg hold` : 'hold time n/a'}</span>
                    <span title="Average days between trade date and SEC filing acceptance">◷ {s.avgFilingLag != null ? `${s.avgFilingLag}d filing lag` : 'lag n/a'}</span>
                    <span className="position-card__source">
                      {s.positionFlagged && <span className="position-flagged-badge" title="SEC-reported figure looked implausible, fell back to estimate"><IconWarning style={{ width: 9, height: 9, marginRight: 2, verticalAlign: "-1px" }} />flagged</span>}
                      {!s.positionFlagged && s.stillHolding ? (s.positionSource === 'sec-reported' ? 'SEC-reported' : 'OM est.') : ''}
                    </span>
                  </div>

                  {s.roundTrips.length > 0 && (
                    <details className="position-card__roundtrips">
                      <summary>{s.roundTrips.length} closed round-trip{s.roundTrips.length !== 1 ? 's' : ''} (FIFO, open-market)</summary>
                      {s.roundTrips.slice(0, 8).map((rt, j) => (
                        <div key={j} className="roundtrip-row">
                          <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{fmt.dateShort(rt.buyDate)} → {fmt.dateShort(rt.sellDate)}</span>
                          <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{rt.holdDays}d held</span>
                          <span style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)' }}>@{fmt.price(rt.buyPrice)}→{fmt.price(rt.sellPrice)}</span>
                          <span className={`roundtrip-pnl ${rt.pnl >= 0 ? 'val-buy' : 'val-sell'}`}>
                            {rt.pnl >= 0 ? '+' : ''}{fmt.money(rt.pnl)} ({rt.pnlPct >= 0 ? '+' : ''}{rt.pnlPct.toFixed(1)}%)
                          </span>
                        </div>
                      ))}
                      {s.roundTrips.length > 8 && <div className="td-muted" style={{ fontSize: '0.6875rem', padding: '4px 0' }}>+{s.roundTrips.length - 8} more</div>}
                    </details>
                  )}

                  <details className="position-card__txns" open={perStockBreakdown.length === 1}>
                    <summary>{displayRows.length} transaction{displayRows.length !== 1 ? 's' : ''} for {s.ticker}{omOnly ? ' (open market only)' : ''}</summary>
                    <div className="position-card__txn-list">
                      {(inline ? displayRows : displayRows.slice(0, 5)).map((r, j) => <TRow key={j} r={r} showTicker={true} showInsider={false} />)}
                    </div>
                    {!inline && displayRows.length > 5 && (
                      <button className="btn btn--ghost btn--sm position-card__view-full" onClick={() => onExpand && onExpand()}>
                        View full data — {displayRows.length} transactions →
                      </button>
                    )}
                  </details>
                </div>
              );
            })}
          </>)}

        </>))}


        {d.type === 'ticker' && (busy ? <SkeletonRows count={6} /> : !tickerStats ? <div className="state-box" style={{ padding: '2rem' }}><p>No data.</p></div> : (<>
          {!hideProfileCard && <CompanyProfileCard ticker={d.ticker} cik={tickerRows?.[0]?.cik_issuer} company={d.company} />}
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{tickerStats.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{tickerStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${tickerStats.net >= 0 ? 'val-buy' : 'val-sell'}`}>{tickerStats.net >= 0 ? '+' : ''}{fmt.money(tickerStats.net)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Moves</span><span className="dp-sum-val">{tickerStats.buys + tickerStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{tickerStats.insiders}</span></div>
          </div>
          <div className="dp-section-label" style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>All Insider Activity ({bundleOn ? tickerRowsDisplay.length : tickerRows.length})</span>
            <label className="bundle-toggle">
              <input type="checkbox" checked={bundleOn} onChange={e => setBundleOn(e.target.checked)} />
              Bundle nearby trades
            </label>
          </div>
          {tickerRowsDisplay.map((r, i) => <TRow key={i} r={r} showTicker={false} showInsider={true} />)}
        </>))}

        {d.type === 'signal' && (<>
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{d.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{d.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${d.netValue >= 0 ? 'val-buy' : 'val-sell'}`}>{d.netValue >= 0 ? '+' : ''}{fmt.money(d.netValue)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Moves</span><span className="dp-sum-val">{d.buys + d.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{d.insiderCount}</span></div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, marginTop: 14 }}>
            <div className="dp-section-label" style={{ margin: 0 }}>Trades by Insider</div>
            <button className="dp-nav-link" onClick={() => nav('ticker', { ticker: d.ticker, company: d.company })}>Full history →</button>
          </div>
          {byInsider.map((ins, i) => (
            <div key={i} className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={ins.rel} />
                <span className="dp-clickable" style={{ fontWeight: 500, fontSize: 12.5 }} onClick={() => nav('trader', { name: ins.name, title: ins.title })}>{ins.name}</span>
                <span className="td-muted" style={{ fontSize: '0.6875rem', marginLeft: 'auto' }}>{ins.title}</span>
              </div>
              {ins.trades.map((t, j) => <TRow key={j} r={{ ...t, insider_name: t.insiderName || ins.name, title: t.title || ins.title, transaction_type: t.transactionType, transaction_code: t.transactionCode, is_open_market: t.isOpenMarket, price: t.price, current_price: signalPrice, pct_owned_change: t.pctOwnedChange, transaction_date: t.transactionDate, is_foreign_price: t.isForeignPrice }} showTicker={false} showInsider={true} />)}
            </div>
          ))}
        </>)}

        {d.type === 'transaction' && d.trade && (() => {
          const t = d.trade;
          const tt = t.transactionType || t.transaction_type;
          const pr = t.price || t.price_per_share;
          const cur = t.currentPrice || t.current_price;
          const isForeign = t.isForeignPrice || t.is_foreign_price || (pr && cur && pr > 0 && Math.abs((cur - pr) / pr) >= 3);
          const ret = (pr && cur && pr > 0 && !isForeign) ? ((cur - pr) / pr * 100) : null;
          const isGoodOutcome = ret != null ? (tt === 'sell' ? ret < 0 : ret >= 0) : null;
          return (<>
            <div className="dp-summary">
              <div className="dp-sum-item"><span className="dp-sum-label">Type</span><Badge type={tt === 'buy' ? 'buy' : tt === 'sell' ? 'sell' : 'other'}>{tt === 'buy' ? <><IconBuyTri style={{ width: 8, height: 8, marginRight: 3 }} />Buy</> : tt === 'sell' ? <><IconSellTri style={{ width: 8, height: 8, marginRight: 3 }} />Sell</> : '◆'}</Badge></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Value</span><span className="dp-sum-val">{fmt.money(t.value)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Shares</span><span className="dp-sum-val">{fmt.number(t.shares)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">@ Price</span><span className="dp-sum-val">{fmt.price(pr)}{isForeign && <span style={{ color: 'var(--amber-600)', fontSize: '0.6875rem' }}> <IconWarning style={{ width: 9, height: 9, display: 'inline', verticalAlign: '-1px' }} /> verify (3x+ move)</span>}</span></div>
              {ret != null && <div className="dp-sum-item"><span className="dp-sum-label">Now</span><span className={`dp-sum-val ${isGoodOutcome ? 'val-buy' : 'val-sell'}`}>{fmt.price(cur)} ({ret >= 0 ? '+' : ''}{ret.toFixed(1)}%)</span></div>}
              {(t.pctOwnedChange || t.pct_owned_change) != null && <div className="dp-sum-item"><span className="dp-sum-label">Pos Δ</span><span className="dp-sum-val val-buy">+{(t.pctOwnedChange || t.pct_owned_change).toFixed(1)}%</span></div>}
            </div>
            <div className="dp-section-label" style={{ marginTop: 12 }}>Insider</div>
            <div className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={t.relationship || 'weak'} />
                <span className="dp-clickable" style={{ fontWeight: 500, fontSize: 12.5 }} onClick={() => nav('trader', { name: t.insiderName || t.insider_name, title: t.title || t.insider_title })}>{t.insiderName || t.insider_name}</span>
                <span className="td-muted" style={{ fontSize: '0.6875rem', marginLeft: 'auto' }}>{t.title || t.insider_title}</span>
              </div>
            </div>
            <div className="dp-section-label" style={{ marginTop: 12 }}>Details</div>
            <div className="dp-detail-list">
              {[['Trade date', fmt.date(t.transactionDate || t.transaction_date)], ['Filed', fmt.date(t.date || t.filing_date)], ['Code', t.transactionCode || t.transaction_code], ['Open market', (t.isOpenMarket || t.is_open_market) ? '✓ Yes' : 'No'], ['Sector', t.sector]].filter(([, v]) => v && v !== '—').map(([k, v], i) => (<div key={i} className="dp-detail-row"><span>{k}</span><span>{v}</span></div>))}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 12 }}>
              <button className="dp-nav-link" onClick={() => nav('trader', { name: t.insiderName || t.insider_name, title: t.title }, { expand: true })}>Trader profile →</button>
              <button className="dp-nav-link" onClick={() => nav('ticker', { ticker: t.ticker, company: t.company_name || t.company }, { expand: true })}>All {t.ticker} trades →</button>
            </div>
          </>);
        })()}

      </div>
    </div>
  );
}


// ─── Shared market data hook ──────────────────────────────────────────────────
// Fetches once per page load, shared between SentimentStrip and HeatmapOnly
// so we don't hit the API twice.
let _mktCache = null;
const _mktListeners = new Set();


// Tabbed signals workspace — the primary daily research surface.
// Each tab gets full tile width so rows are actually readable, unlike
// the three-column cramped layout. Tabs: Corporate | Congressional | Movers.

function DashboardPage({ filings, loading, onDrillSignal, onOpenDetail, watchlist, user, onUpgrade, initialTab }) {
  const { pro } = useBilling();
  const isMobile = useIsMobile();

  // ── State ─────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState(initialTab || 'signals');
  const [days, setDays] = useState(7);
  const [sourceF, setSourceF] = useState('');
  const [sectorF, setSectorF] = useState('');
  const [minStr, setMinStr] = useState(1);
  const [txType, setTxType] = useState('all');
  const [rawRoleF, setRawRoleF] = useState('');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sigSort, setSigSort] = useState('conviction');
  const [sigDir, setSigDir] = useState(-1);
  const [rawSort, setRawSort] = useState('date');
  const [rawDir, setRawDir] = useState(-1);
  // Expanded rows — multiple can be open simultaneously
  const [expandedSigs, setExpandedSigs] = useState(new Set()); // Set of tickers
  const [expandedRaws, setExpandedRaws] = useState(new Set()); // Set of indices
  // Full-screen explore drawer (top-right button)
  const [drawer, setDrawer] = useState(null); // null | 'signals' | 'insiders' | 'raw'

  // Lock body scroll when a local drawer is open
  useEffect(() => {
    if (drawer) document.body.classList.add('drawer-open');
    else document.body.classList.remove('drawer-open');
    return () => document.body.classList.remove('drawer-open');
  }, [drawer]);

  const cutoff = useMemo(() => {
    if (days == null) return '2013-01-01'; // matches earliest backfilled data
    const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split('T')[0];
  }, [days]);

  const rawCutoff = useMemo(() => {
    if (dateFrom) return dateFrom; // custom date range overrides preset
    if (days == null) return null;
    const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split('T')[0];
  }, [days, dateFrom]);

  const rawDateTo = useMemo(() => {
    return dateTo || null; // null = no upper bound (today)
  }, [dateTo]);

  const sectors = useMemo(() =>
    [...new Set(filings.map(f => f.sector).filter(s => s && s !== 'Other'))].sort(),
    [filings]);

  const strengthThreshold = minStr === 3 ? 60 : minStr === 2 ? 35 : 0;

  // ── Signals ───────────────────────────────────────────────────────────────
  const allSignals = useMemo(() => {
    const result = filterAndScoreSignals(filings, { cutoff, sourceF, sectorF, strengthThreshold });
    const q = search.toLowerCase();
    return result.filter(s => !q || s.ticker.toLowerCase().includes(q) || (s.company || '').toLowerCase().includes(q));
  }, [filings, cutoff, sourceF, sectorF, strengthThreshold, search]);

  const signals = useMemo(() =>
    [...allSignals].sort((a, b) => {
      const av = a[sigSort] ?? -Infinity, bv = b[sigSort] ?? -Infinity;
      const r = typeof av === 'number' ? (av < bv ? -1 : av > bv ? 1 : 0) : String(av).localeCompare(String(bv));
      return sigDir > 0 ? r : -r;
    }),
    [allSignals, sigSort, sigDir]);

  // ── Raw filings ───────────────────────────────────────────────────────────
  const allRaw = useMemo(() => {
    const q = search.toLowerCase();
    return filings.filter(f => {
      if (!f.isOpenMarket) return false;
      if (sectorF && f.sector !== sectorF) return false;
      if (txType !== 'all' && f.transactionType !== txType) return false;
      if (rawRoleF && f.relationship !== rawRoleF) return false;
      if (rawCutoff && (f.transactionDate || f.date || '') < rawCutoff) return false;
      if (rawDateTo && (f.transactionDate || f.date || '') > rawDateTo) return false;
      if (q && !f.ticker?.toLowerCase().includes(q) && !(f.company || '').toLowerCase().includes(q) && !(f.insiderName || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [filings, sectorF, txType, rawRoleF, rawCutoff, rawDateTo, search]);

  const [rawPage, setRawPage] = useState(1);
  const rawFilings = useMemo(() =>
    [...allRaw].sort((a, b) => {
      const aV = rawSort === 'date' ? (a.transactionDate || a.date || '') : rawSort === 'value' ? (a.value || 0) : rawSort === 'pctChange' ? (a.pctOwnedChange || 0) : (a.shares || 0);
      const bV = rawSort === 'date' ? (b.transactionDate || b.date || '') : rawSort === 'value' ? (b.value || 0) : rawSort === 'pctChange' ? (b.pctOwnedChange || 0) : (b.shares || 0);
      return rawDir > 0 ? (aV > bV ? 1 : -1) : (bV > aV ? 1 : -1);
    }).slice(0, rawPage * 100),
    [allRaw, rawSort, rawDir, rawPage]);

  function onSigSort(col) { if (sigSort === col) setSigDir(d => -d); else { setSigSort(col); setSigDir(-1); } }
  function onRawSort(col) { if (rawSort === col) setRawDir(d => -d); else { setRawSort(col); setRawDir(-1); } }
  const hasFilters = search || sectorF || sourceF || minStr > 1 || days !== 7 || dateFrom || dateTo || (tab === 'raw' && (txType !== 'all' || rawRoleF !== ''));
  function resetFilters() { setSearch(''); setSectorF(''); setSourceF(''); setMinStr(1); setDays(7); setTxType('all'); setRawRoleF(''); setDateFrom(''); setDateTo(''); }

  function toggleSig(ticker) {
    setExpandedSigs(prev => { const n = new Set(prev); n.has(ticker) ? n.delete(ticker) : n.add(ticker); return n; });
  }
  function toggleRaw(idx) {
    setExpandedRaws(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  }

  // Get individual trades for an expanded signal row
  function getSignalTrades(s) {
    return filings.filter(f =>
      f.isOpenMarket && f.ticker === s.ticker &&
      (f.transactionDate || f.date || '') >= (s.lastTradeDate ? new Date(new Date(s.lastTradeDate).getTime() - 90 * 86400000).toISOString().split('T')[0] : cutoff)
    ).sort((a, b) => (b.transactionDate || b.date || '').localeCompare(a.transactionDate || a.date || '')).slice(0, 8);
  }

  // State for seamless drawer handoff — passes selected signal/ticker into the drawer
  const [drawerInitSignal, setDrawerInitSignal] = useState(null);
  const [drawerInitTicker, setDrawerInitTicker] = useState(null);

  function openSignalsDrawer(signal) {
    if (signal?.ticker) { go(stockPath(signal.ticker)); return; }
    if (isMobile) { onOpenDetail(signal ? { type: 'signal', ...signal } : null, { expand: true }); return; }
    setDrawerInitSignal(signal ? { type: 'signal', ...signal } : null);
    setDrawer('signals');
  }
  function openRawDrawer(ticker, company) {
    if (ticker) { go(stockPath(ticker)); return; }
    if (isMobile) { onOpenDetail(ticker ? { type: 'ticker', ticker, company } : null, { expand: true }); return; }
    setDrawerInitTicker(ticker ? { type: 'ticker', ticker, company } : null);
    setDrawer('raw');
  }

  return (
    <div className="ws-page">
      <div className="ws-page-hdr">
        <div style={{ flex: 1 }}>
          <h1 className="ws-page-title">Market Data</h1>
          <p className="ws-page-sub">{isMobile ? 'Tap any row to see the details.' : 'Click any row to see details inline. Use "Explore full view" for deep analysis.'}</p>
        </div>
        <button className="data-export-btn" onClick={() => onUpgrade('data_export_direct')}><IconDownload style={{ width: 13, height: 13 }} /> Download Dataset</button>
      </div>

      {/* Stat strip */}
      <div className="ws-stat-strip">
        <HelpStat label="Showing" value={tab === 'signals' ? signals.length : rawFilings.length} sub={`${tab === 'signals' ? 'signals' : 'filings'} after filters`} tip="Number of results after all filters are applied." />
        <HelpStat label="High conviction" value={loading ? '—' : signals.filter(s => s.conviction >= 60).length} sub="Score ≥60" tip={TIPS.highConviction} />
        <HelpStat label="Unique tickers" value={loading ? '—' : tab === 'signals' ? new Set(signals.map(s => s.ticker)).size : new Set(rawFilings.map(f => f.ticker)).size} sub="In current view" tip="Number of distinct stocks with insider activity in the current filtered view." />
        <HelpStat label="Net flow" value={loading ? '—' : fmt.money(signals.reduce((s, x) => s + x.netValue, 0))} sub="Buys − sells" color={signals.reduce((s, x) => s + x.netValue, 0) >= 0 ? 'var(--green-600)' : 'var(--red-600)'} tip={TIPS.netFlow} />
      </div>

      <div className="ws-tile">
        {/* Tab bar + Explore full view */}
        <div className="ws-toolbar-hdr">
          <div className="ws-toolbar-tabs">
            <button className={`ws-toolbar-tab${tab === 'signals' ? ' ws-toolbar-tab--active' : ''}`}
              onClick={() => { setTab('signals'); setExpandedRaws(new Set()); }}>
              Signals <span className="ws-tile__count">{loading ? '…' : allSignals.length}</span>
            </button>
            <button className={`ws-toolbar-tab${tab === 'raw' ? ' ws-toolbar-tab--active' : ''}`}
              onClick={() => { setTab('raw'); setExpandedSigs(new Set()); }}>
              Raw filings <span className="ws-tile__count">{loading ? '…' : allRaw.length}</span>
            </button>
          </div>
          <div className="ws-toolbar-right">
            {tab === 'raw' && <button className="btn btn--primary btn--sm" style={{ flexShrink: 0 }} onClick={() => onUpgrade('data_export_direct')}>Export CSV</button>}
            {/* Opens the correct full drawer for whichever tab is active.
                Hidden on mobile — the drawer's two-pane layout doesn't work
                on phone-sized viewports; the inline expand + page navigation
                already handles mobile well. */}
            {!isMobile && <button className="ws-toolbar-explore-btn"
              onClick={() => tab === 'signals' ? openSignalsDrawer(null) : openRawDrawer(null, null)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14L21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
              Explore full view
            </button>}
          </div>
        </div>

        {/* Filter bar — collapses on mobile behind a toggle */}
        <div className="ws-filter-bar">
          <div className="ws-filter-bar__row ws-filter-bar__row--search">
            <div className="ws-search-wrap">
              <span className="ws-search-icon">⌕</span>
              <input className="ws-search-input" value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'signals' ? 'Ticker or company…' : 'Ticker, company, or insider…'} />
              {search && <button className="ws-search-clear" onClick={() => setSearch('')}>×</button>}
            </div>
            {isMobile && <button className="ws-filter-toggle" onClick={() => setFiltersOpen(f => !f)}>
              Filters{hasFilters ? ' ●' : ''} {filtersOpen ? '▴' : '▾'}
            </button>}
          </div>
          {(!isMobile || filtersOpen) && <>
            <div className="ws-filter-bar__row">

              {tab === 'signals' && <>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Window</span>
                  <div className="ws-pills">
                    {[{ v: 1, l: '1d' }, { v: 3, l: '3d' }, { v: 7, l: '7d' }, { v: 30, l: '30d' }, { v: 90, l: '90d' }, { v: null, l: 'All' }].map(o => {
                      if (!pro && (o.v === null || o.v > 7)) return null;
                      return <button key={o.l} className={`ws-pill${days === o.v ? ' ws-pill--active' : ''}`} onClick={() => setDays(o.v)}>{o.l}</button>;
                    })}
                    {!pro && <button className="ws-pill ws-pill--locked" onClick={() => onUpgrade('full_history')}><IconLock style={{ width: 10, height: 10, marginRight: 3, verticalAlign: '-1px' }} />More</button>}
                  </div>
                </div>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Strength</span>
                  <div className="ws-pills">
                    {[{ v: 1, l: 'Any' }, { v: 2, l: 'Med+' }, { v: 3, l: 'High' }].map(o => (
                      <button key={o.v} className={`ws-pill${minStr === o.v ? ' ws-pill--active' : ''}`}
                        style={o.v === 3 && minStr === 3 ? { background: 'var(--green-600)', borderColor: 'var(--green-600)', color: '#fff' } : o.v === 2 && minStr === 2 ? { background: 'var(--amber-600)', borderColor: 'var(--amber-600)', color: '#fff' } : {}}
                        onClick={() => setMinStr(o.v)}>{o.l}</button>
                    ))}
                  </div>
                </div>
              </>}

              {tab === 'raw' && <>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Date</span>
                  <div className="ws-pills">
                    {[{ v: 1, l: '1d' }, { v: 7, l: '7d' }, { v: 30, l: '30d' }, { v: null, l: 'All' }].map(o => (
                      <button key={o.l} className={`ws-pill${days === o.v && !dateFrom ? ' ws-pill--active' : ''}`} onClick={() => { setDays(o.v); setDateFrom(''); setDateTo(''); }}>{o.l}</button>
                    ))}
                  </div>
                </div>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Range</span>
                  <div className="drawer__date-range">
                    <input type="date" className="drawer__date-input" value={dateFrom}
                      onChange={e => { setDateFrom(e.target.value); if (e.target.value) setDays(null); }} />
                    <span className="drawer__date-sep">→</span>
                    <input type="date" className="drawer__date-input" value={dateTo}
                      onChange={e => { setDateTo(e.target.value); if (e.target.value) setDays(null); }} />
                  </div>
                </div>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Type</span>
                  <div className="ws-pills">
                    {[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']].map(([v, l]) => (
                      <button key={v} className={`ws-pill${txType === v ? ' ws-pill--active' : ''}`} onClick={() => setTxType(v)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="ws-filter-group">
                  <span className="ws-filter-label">Role</span>
                  <div className="ws-pills">
                    {[['', 'All'], ['strong', 'C-Suite'], ['medium', 'Officer']].map(([v, l]) => (
                      <button key={v} className={`ws-pill${rawRoleF === v ? ' ws-pill--active' : ''}`} onClick={() => setRawRoleF(v)}>{l}</button>
                    ))}
                  </div>
                </div>
              </>}
            </div>

            <div className="ws-filter-bar__row">
              {tab === 'signals' && <>
                <div className="ws-filter-group" style={{ borderLeft: 'none', paddingLeft: 0 }}>
                  <span className="ws-filter-label">Type</span>
                  <div className="ws-pills">
                    {[['', 'All'], ['corporate', 'Corp'], ['political', 'Congress']].map(([v, l]) => (
                      <button key={v} className={`ws-pill${sourceF === v ? ' ws-pill--active' : ''}`} onClick={() => setSourceF(v)}>{l}</button>
                    ))}
                  </div>
                </div>
              </>}
              <div className="ws-filter-group" style={{ borderLeft: tab === 'raw' ? 'none' : '', paddingLeft: tab === 'raw' ? 0 : '' }}>
                <span className="ws-filter-label">Sector</span>
                <select className="ws-select" value={sectorF} onChange={e => setSectorF(e.target.value)}>
                  <option value="">All sectors</option>
                  {sectors.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {hasFilters && <button className="ws-clear-btn" onClick={resetFilters}>Clear</button>}
            </div>
          </>}
        </div>

        {/* ── SIGNALS TABLE ─────────────────────────────────────────────── */}
        {tab === 'signals' && (
          loading ? <SkeletonRows count={10} /> : signals.length === 0 ? (
            <div className="ws-empty">No signals match these filters. Try widening the window or clearing filters.</div>
          ) : (
            <>
              <div className="ws-col-hdrs ws-col-hdrs--data">
                <button className={`ws-col-sort${sigSort === 'ticker' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('ticker')}>Ticker{sigSort === 'ticker' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>
                {!isMobile && <button className={`ws-col-sort${sigSort === 'company' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('company')}>Company{sigSort === 'company' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>}
                {!isMobile && <button className={`ws-col-sort${sigSort === 'lastTradeDate' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('lastTradeDate')}><InfoTip tip={TIPS.signalDate}>Date</InfoTip>{sigSort === 'lastTradeDate' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>}
                <button className={`ws-col-sort ws-col-sort--right${sigSort === 'insiderCount' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('insiderCount')}><InfoTip tip={TIPS.insiders}>{isMobile ? 'Ins' : 'Insiders'}</InfoTip>{sigSort === 'insiderCount' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>
                {!isMobile && <button className={`ws-col-sort ws-col-sort--right${sigSort === 'buys' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('buys')}><InfoTip tip={TIPS.trades}>Trades</InfoTip>{sigSort === 'buys' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>}
                <button className={`ws-col-sort ws-col-sort--right${sigSort === 'netValue' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('netValue')}><InfoTip tip={TIPS.netValue}>{isMobile ? 'Value' : 'Net value'}</InfoTip>{sigSort === 'netValue' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>
                <button className={`ws-col-sort ws-col-sort--right${sigSort === 'conviction' ? ' ws-col-sort--active' : ''}`} onClick={() => onSigSort('conviction')}><InfoTip tip={TIPS.conviction}>{isMobile ? 'Conv' : 'Conviction'}</InfoTip>{sigSort === 'conviction' && (sigDir < 0 ? ' ↓' : ' ↑')}</button>
              </div>
              <div>
                {signals.map(s => {
                  const isBuy = s.direction !== 'sell';
                  const isExp = expandedSigs.has(s.ticker);
                  const hasRev = detectReversalForTicker(s.ticker, filings);
                  const trades = isExp ? getSignalTrades(s) : [];
                  return (
                    <div key={s.ticker} className={`ws-row${isExp ? ' ws-row--open' : ''}`}
                      style={{ borderLeft: `3px solid ${isBuy ? 'var(--green-600)' : 'var(--red-600)'}` }}>

                      {/* ── Main row — click anywhere to expand ── */}
                      <div className="ws-row__main ws-row__main--data" style={{ cursor: 'pointer' }}
                        onClick={() => toggleSig(s.ticker)}>
                        <div className="ws-row__cell">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span className="ws-row__chevron ws-row__chevron--lg">{isExp ? '▾' : '▸'}</span>
                            <span className="ticker">{s.ticker}</span>
                            {hasRev && <span className="reversal-badge" style={{ fontSize: 9, padding: '0 3px' }}><IconReversal className="reversal-badge__icon" />rev</span>}
                            <div onClick={e => e.stopPropagation()}>
                              <StarBtn ticker={s.ticker} watchlist={watchlist} />
                            </div>
                          </div>
                          {isMobile && <div className="ws-mob-sub" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1, paddingLeft: 18 }}>{s.company}</div>}
                        </div>
                        {!isMobile && <div className="ws-row__cell ws-row__cell--overflow">{s.company}</div>}
                        {!isMobile && <div className="ws-row__cell ws-row__cell--muted" style={{ fontSize: 11 }}>{fmt.dateShort(s.lastTradeDate)}</div>}
                        <div className="ws-row__cell ws-row__cell--right">
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.insiderCount}</span>
                        </div>
                        {!isMobile && <div className="ws-row__cell ws-row__cell--right">
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.buys + s.sells}</span>
                        </div>}
                        <div className="ws-row__cell ws-row__cell--right">
                          <span className={`ws-data-mono${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : ''}{fmt.money(s.netValue)}</span>
                        </div>
                        <div className="ws-row__cell">
                          <ConvictionBar score={s.conviction} max={100} showLabel={!isMobile} />
                        </div>
                      </div>

                      {/* ── Expanded detail ── */}
                      {isExp && (
                        <div className="ws-row__detail" onClick={e => e.stopPropagation()}>

                          {/* Signal summary row */}
                          <div className="ws-row__detail-summary">
                            <div><span className="ws-data-label">Last trade</span><div className="ws-row__detail-val">{fmt.dateShort(s.lastTradeDate)}</div></div>
                            <div><span className="ws-data-label">Net flow</span><div className={`ws-row__detail-val${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : ''}{fmt.money(s.netValue)}</div></div>
                            <div><span className="ws-data-label">Exec transactions</span><div className="ws-row__detail-val">{s.cSuiteBuys > 0 ? `${s.cSuiteBuys} trade${s.cSuiteBuys !== 1 ? 's' : ''}` : '—'}</div></div>
                            <div><span className="ws-data-label">Insiders</span><div className="ws-row__detail-val">{s.insiderCount}</div></div>
                            <div><span className="ws-data-label">Sector</span><div className="ws-row__detail-val">{s.sector || '—'}</div></div>
                            <div><span className="ws-data-label">Conviction</span><div className="ws-row__detail-val">{Math.round(s.conviction)}</div></div>
                            {s.avgReturn != null && <div><span className="ws-data-label">Since trade</span><div className={`ws-row__detail-val${s.avgReturn >= 0 ? ' val-buy' : ' val-sell'}`}>{s.avgReturn >= 0 ? '+' : ''}{s.avgReturn.toFixed(1)}%</div></div>}
                          </div>

                          {/* Individual trade history */}
                          {trades.length > 0 && (
                            <div className="ws-row__detail-trades">
                              <div className="ws-row__detail-trades-hdr">
                                <span className="ws-data-label">Individual trades · {s.company}</span>
                              </div>
                              {trades.map((f, ti) => {
                                const fb = f.transactionType === 'buy';
                                const su = secFilingUrl(f.accessionNumber, f.cikIssuer);
                                return (
                                  <div key={ti} className="ws-row__trade-line">
                                    <span className="ws-row__trade-date ws-data-label">{fmt.dateShort(f.transactionDate || f.date)}</span>
                                    <span className="ws-row__trade-who">{f.insiderName} <span style={{ color: 'var(--text-3)', fontSize: 10 }}>{f.title ? '· ' + f.title.split(' ').slice(0, 3).join(' ') : ''}</span></span>
                                    <span className={`ws-type-badge${fb ? ' ws-type-badge--buy' : ' ws-type-badge--sell'}`} style={{ flexShrink: 0 }}>{fb ? 'Buy' : 'Sell'}</span>
                                    {f.shares && <span className="ws-row__trade-shares" style={{ color: 'var(--text-3)', fontSize: 11 }}>{fmt.number(f.shares)} sh</span>}
                                    <span className={`ws-data-mono${fb ? ' val-buy' : ' val-sell'}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>{fb ? '+' : '−'}{fmt.money(f.value)}</span>
                                    {su && <a href={su} target="_blank" rel="noopener noreferrer" className="ws-sec-link" onClick={e => e.stopPropagation()}>↗</a>}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Desktop only: phones get the inline expand and nothing else */}
                          {!isMobile && (
                            <div className="ws-row__detail-footer">
                              <button className="ws-row__detail-cta" onClick={() => openSignalsDrawer(s)}>
                                Open full ↗
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ws-tbl-footer"><span>{signals.length} signals · click row to expand</span></div>
            </>
          )
        )}

        {/* ── RAW FILINGS TABLE ─────────────────────────────────────────── */}
        {tab === 'raw' && (
          loading ? <SkeletonRows count={12} /> : rawFilings.length === 0 ? (
            <div className="ws-empty">No filings match these filters.</div>
          ) : (
            <>
              {/* Same outer width as signals. 7-col grid: chevron+date | ticker | insider | role | type | ±position | value */}
              <div className="ws-col-hdrs ws-col-hdrs--raw">
                <span className="ws-col-sort">Ticker</span>
                {!isMobile && <span className="ws-col-sort">Insider</span>}
                <button className={`ws-col-sort${rawSort === 'date' ? ' ws-col-sort--active' : ''}`} onClick={() => onRawSort('date')}>Date{rawSort === 'date' && (rawDir < 0 ? ' ↓' : ' ↑')}</button>
                {!isMobile && <span className="ws-col-sort"><InfoTip tip={TIPS.role}>Role</InfoTip></span>}
                <span className="ws-col-sort"><InfoTip tip={TIPS.tradeType}>Type</InfoTip></span>
                {!isMobile && <button className={`ws-col-sort ws-col-sort--right${rawSort === 'pctChange' ? ' ws-col-sort--active' : ''}`} onClick={() => onRawSort('pctChange')}><InfoTip tip={TIPS.pctPosition}>% Position</InfoTip>{rawSort === 'pctChange' && (rawDir < 0 ? ' ↓' : ' ↑')}</button>}
                <button className={`ws-col-sort ws-col-sort--right${rawSort === 'value' ? ' ws-col-sort--active' : ''}`} onClick={() => onRawSort('value')}><InfoTip tip={TIPS.tradeValue}>Value</InfoTip>{rawSort === 'value' && (rawDir < 0 ? ' ↓' : ' ↑')}</button>
              </div>
              <div>
                {rawFilings.map((f, i) => {
                  const isBuy = f.transactionType === 'buy';
                  const isExp = expandedRaws.has(i);
                  const secUrl = secFilingUrl(f.accessionNumber, f.cikIssuer);
                  // Sibling filings for this insider × ticker combo
                  const siblingFilings = isExp ? filings.filter(x => x.ticker === f.ticker && x.insiderName === f.insiderName && x.isOpenMarket && x.accessionNumber !== f.accessionNumber).sort((a, b) => (b.transactionDate || b.date || '').localeCompare(a.transactionDate || a.date || '')).slice(0, 5) : [];
                  return (
                    <div key={i} className={`ws-row${isExp ? ' ws-row--open' : ''}`}
                      style={{ borderLeft: `3px solid ${isBuy ? 'var(--green-600)' : 'var(--red-600)'}` }}>

                      <div className="ws-row__main ws-row__main--raw" style={{ cursor: 'pointer' }}
                        onClick={() => toggleRaw(i)}>
                        <div className="ws-row__cell">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span className="ws-row__chevron ws-row__chevron--lg">{isExp ? '▾' : '▸'}</span>
                            <span className="ticker">{f.ticker}</span>
                          </div>
                          {isMobile && <div className="ws-mob-sub" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1, paddingLeft: 18 }}>{f.insiderName}</div>}
                        </div>
                        {!isMobile && <div className="ws-row__cell ws-row__cell--overflow" style={{ fontSize: 12 }}>{f.insiderName}</div>}
                        <div className="ws-row__cell ws-row__cell--muted" style={{ fontSize: 11 }}>
                          {fmt.dateShort(f.transactionDate || f.date)}
                        </div>
                        {!isMobile && <div className="ws-row__cell"><Badge type={`rel-${f.relationship || 'weak'}`}>{f.relationship === 'strong' ? 'C-Suite' : f.relationship === 'medium' ? 'Officer' : 'Dir'}</Badge></div>}
                        <div className="ws-row__cell"><span className={`ws-type-badge${isBuy ? ' ws-type-badge--buy' : ' ws-type-badge--sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span></div>
                        {!isMobile && <div className="ws-row__cell ws-row__cell--right">
                          <span className={`ws-row__pos-change${isBuy ? ' val-buy' : ' val-sell'}`}>
                            {f.pctOwnedChange != null ? `${isBuy ? '+' : '−'}${Math.abs(f.pctOwnedChange).toFixed(1)}%` : '—'}
                          </span>
                        </div>}
                        <div className="ws-row__cell ws-row__cell--right">
                          <span className={`ws-data-mono${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : '−'}{fmt.money(f.value)}</span>
                        </div>
                      </div>

                      {isExp && (
                        <div className="ws-row__detail" onClick={e => e.stopPropagation()}>

                          {/* Filing details */}
                          <div className="ws-row__detail-summary">
                            <div><span className="ws-data-label">Insider</span><div className="ws-row__detail-val">{f.insiderName}</div></div>
                            <div><span className="ws-data-label">Title</span><div className="ws-row__detail-val">{f.title || '—'}</div></div>
                            <div><span className="ws-data-label">Position change</span><div className={`ws-row__detail-val${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : '−'}{f.shares ? fmt.number(f.shares) + ' sh' : '—'}</div></div>
                            <div><span className="ws-data-label">Price / share</span><div className="ws-row__detail-val">{f.price ? fmt.price(f.price) : '—'}</div></div>
                            <div><span className="ws-data-label">Total value</span><div className={`ws-row__detail-val${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : '−'}{fmt.money(f.value)}</div></div>
                            <div><span className="ws-data-label">Company</span><div className="ws-row__detail-val">{f.company || f.ticker}</div></div>
                            <div><span className="ws-data-label">Sector</span><div className="ws-row__detail-val">{f.sector || '—'}</div></div>
                            {secUrl && <div><span className="ws-data-label">Source</span><div><a href={secUrl} target="_blank" rel="noopener noreferrer" className="ws-sec-link">↗ SEC filing</a></div></div>}
                          </div>

                          {/* Other trades by same insider at same ticker */}
                          {siblingFilings.length > 0 && (
                            <div className="ws-row__detail-trades">
                              <div className="ws-row__detail-trades-hdr">
                                <span className="ws-data-label">Other trades — {f.insiderName} at {f.ticker}</span>
                              </div>
                              {siblingFilings.map((sf, si) => {
                                const sfb = sf.transactionType === 'buy';
                                return (
                                  <div key={si} className="ws-row__trade-line">
                                    <span className="ws-row__trade-date ws-data-label">{fmt.dateShort(sf.transactionDate || sf.date)}</span>
                                    <span className={`ws-type-badge${sfb ? ' ws-type-badge--buy' : ' ws-type-badge--sell'}`} style={{ flexShrink: 0 }}>{sfb ? 'Buy' : 'Sell'}</span>
                                    {sf.shares && <span className={`ws-row__pos-change${sfb ? ' val-buy' : ' val-sell'}`}>{sfb ? '+' : '−'}{fmt.number(sf.shares)} sh</span>}
                                    <span className={`ws-data-mono${sfb ? ' val-buy' : ' val-sell'}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>{sfb ? '+' : '−'}{fmt.money(sf.value)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Single CTA: opens raw explore with same filters + this ticker pre-selected */}
                          {!isMobile && (
                            <div className="ws-row__detail-footer">
                              <button className="ws-row__detail-cta" onClick={() => openRawDrawer(f.ticker, f.company)}>
                                Open full ↗
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ws-tbl-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Showing {rawFilings.length} of {allRaw.length} filings · open-market only · click row to expand</span>
                {rawFilings.length < allRaw.length && (
                  <button className="btn btn--sm" onClick={() => setRawPage(p => p + 1)}>Load more</button>
                )}
              </div>
            </>
          )
        )}
      </div>

      {/* Full-screen explore drawer — desktop only. On mobile, openSignalsDrawer
          and openRawDrawer redirect to onOpenDetail instead of setting drawer state,
          but this guard ensures the drawer never renders on small viewports. */}
      {!isMobile && (drawer === 'signals' || drawer === 'insiders') && (
        <InsightsDrawer
          type={drawer}
          filings={filings}
          initialDetail={drawerInitSignal}
          onClose={() => { setDrawer(null); setDrawerInitSignal(null); }}
          onSwitchToData={() => { setDrawer(null); setDrawerInitSignal(null); setTimeout(() => setDrawer('raw'), 50); }}
          sigSort={sigSort} sigDir={sigDir} sigOnSort={onSigSort}
          ensureFilingsWindow={() => { }} filingsLoading={loading}
          watchlist={watchlist}
          initialFilters={{ days, sourceF, sectorF, minStrength: minStr }}
          pro={pro}
        />
      )}
      {!isMobile && drawer === 'raw' && (
        <DataDrawer
          initialDetail={drawerInitTicker || { type: 'data', dataFilters: { days, sectorF, txType, rawRoleF } }}
          initialDetailStack={[]}
          filterState={{ days, sectorF, txType, rawRoleF }}
          onClose={() => { setDrawer(null); setDrawerInitTicker(null); }}
          onSwitchTab={(tab) => { setDrawer(null); setDrawerInitTicker(null); setTimeout(() => setDrawer(tab === 'signals' ? 'signals' : 'insiders'), 50); }}
          watchlist={watchlist}
          portfolioTickers={[]}
          pro={pro}
          onUpgrade={onUpgrade}
        />
      )}
    </div>
  );
}


// ─── INSIGHTS PAGE ────────────────────────────────────────────────────────────
// Helper — does this ticker have a reversal in the last 30d?
// Cheap per-row check using cached reversal list passed in.
function detectReversalForTicker(ticker, filings) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const iso = cutoff.toISOString().split('T')[0];
  const rows = filings.filter(f => f.ticker === ticker && f.isOpenMarket && (f.transactionDate || f.date || '') >= iso);
  const types = new Set(rows.map(f => f.transactionType));
  return types.has('buy') && types.has('sell');
}


function ScoreRing({ score = 0, size = 76 }) {
  const pct = Math.min((score || 0) / 100, 1);
  const r2 = (size - 8) / 2, circ = 2 * Math.PI * r2, dash = pct * circ;
  const color = score >= 65 ? 'var(--green-600)' : score >= 35 ? 'var(--accent)' : 'var(--amber-600)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r2} fill="none" stroke="var(--surface-3)" strokeWidth={6} />
      <circle cx={size / 2} cy={size / 2} r={r2} fill="none" stroke={color} strokeWidth={6}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .4s ease' }} />
      <text x={size / 2} y={size / 2 - 4} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: size * 0.22, fontWeight: 700, fontFamily: 'var(--font-mono)', fill: color, userSelect: 'none' }}>
        {score != null ? score : '—'}
      </text>
      <text x={size / 2} y={size / 2 + size * 0.2} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: size * 0.13, fill: 'var(--text-3)', fontFamily: 'var(--font)', userSelect: 'none' }}>
        /100
      </text>
    </svg>
  );
}

// Two-pane deep-dive drawer:
//   Left pane  = sortable/filterable list (signals or insiders)
//   Right pane = DetailPanel rendered inline with its own nav stack
// Clicking any row in the left pane drives the right pane without closing.
// Within the right pane, clicking an insider name / ticker navigates inline
// via the same back-button stack DetailPanel already supports.
function InsiderProfileDrawer({ name, title, filings, watchlist, lbRows, onOpenDetail }) {
  const [txExpanded, setTxExpanded] = useState(new Set());
  const r = useMemo(() => {
    if (!lbRows) return null;
    const nameLower = (name || '').toLowerCase();
    return lbRows.find(x => (x.insider_name || '').toLowerCase() === nameLower) || null;
  }, [lbRows, name]);
  const role = insiderRoleLabel(r);

  // Full trade history — query DB directly, no limit
  const [profileTrades, setProfileTrades] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setTradesLoading(true);
    setProfileTrades([]);
    const escaped = (name || '').replace(/'/g, "''");
    queryNeon(`
      SELECT accession_number, cik_issuer, transaction_date, filing_date AS date,
             ticker, company_name AS company, insider_name, insider_title AS title,
             transaction_type, transaction_code, is_open_market, is_officer,
             shares::float, price_per_share::float AS price, value::float,
             shares_owned_after::float, pct_owned_change::float, sector, relationship
      FROM public.filings
      WHERE LOWER(insider_name) = LOWER('${escaped}')
        AND is_open_market = true
      ORDER BY COALESCE(transaction_date, filing_date) DESC
      LIMIT 200
    `).then(rows => {
      if (cancelled) return;
      setProfileTrades((rows || []).map(row => ({
        accessionNumber: row.accession_number, cikIssuer: row.cik_issuer,
        transactionDate: row.transaction_date, date: row.date,
        ticker: row.ticker, company: row.company, insiderName: row.insider_name,
        title: row.title, transactionType: row.transaction_type,
        transactionCode: row.transaction_code, isOpenMarket: row.is_open_market,
        shares: row.shares, price: row.price, value: row.value,
        sharesOwnedAfter: row.shares_owned_after, pctOwnedChange: row.pct_owned_change,
        sector: row.sector, relationship: row.relationship,
      })));
    }).catch(() => {
      if (cancelled) return;
      const nameLower = (name || '').toLowerCase();
      setProfileTrades(filings
        .filter(f => (f.insiderName || '').toLowerCase() === nameLower)
        .sort((a, b) => (b.transactionDate || b.date || '').localeCompare(a.transactionDate || a.date || '')));
    }).finally(() => { if (!cancelled) setTradesLoading(false); });
    return () => { cancelled = true; };
  }, [name]);

  const profileCompanies = useMemo(() => {
    const map = {};
    profileTrades.forEach(f => {
      if (!map[f.ticker]) map[f.ticker] = { ticker: f.ticker, company: f.company, buys: 0, sells: 0, lastDate: '' };
      if (f.transactionType === 'buy') map[f.ticker].buys++; else map[f.ticker].sells++;
      const d = f.transactionDate || f.date || '';
      if (d > map[f.ticker].lastDate) map[f.ticker].lastDate = d;
    });
    return Object.values(map).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  }, [profileTrades]);
  const initials = name.split(' ').map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
  const hrC = r?.hit_rate >= 70 ? 'var(--green-600)' : r?.hit_rate < 50 ? 'var(--red-600)' : 'var(--text-2)';
  const retC = (r?.avg_return ?? 0) >= 0 ? 'var(--green-600)' : 'var(--red-600)';

  return (
    <div className="ip-profile" style={{ padding: '20px 24px', gap: 18, overflowY: 'auto', height: '100%' }}>
      <div className="ip-profile__head">
        <div className="ip-profile__avatar">{initials}</div>
        <div className="ip-profile__identity">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="ip-profile__name">{name}</div>
            <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}><FollowBtn name={name} watchlist={watchlist} /></div>
          </div>
          {profileCompanies.length > 0 && (
            <div className="ip-profile__affiliations">
              {profileCompanies.slice(0, 4).map(c => (
                <span key={c.ticker} className="ip-aff-badge" onClick={() => onOpenDetail && onOpenDetail({ type: 'ticker', ticker: c.ticker, company: c.company })}>
                  <Badge type={role.badge}>{role.label}</Badge>
                  <span style={{ fontSize: 11, color: 'var(--text-2)' }}>at</span>
                  <span className="ticker" style={{ fontSize: 11, cursor: 'pointer' }}>{c.ticker}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <ScoreRing score={r?.proxy_score ?? 0} size={72} />
      </div>
      {r && (
        <div className="ip-profile__stats" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
          {[
            { label: 'Hit rate', val: r.hit_rate != null ? `${r.hit_rate}%` : '—', color: hrC },
            { label: 'Avg return', val: r.avg_return != null ? (r.avg_return >= 0 ? '+' : '') + r.avg_return.toFixed(1) + '%' : '—', color: retC },
            { label: 'OM buys', val: r.om_buys, color: 'var(--text)' },
            { label: 'OM sells', val: r.om_sells || 0, color: 'var(--text)' },
            { label: 'Total bought', val: fmt.money(r.bought_value), color: 'var(--text)' },
          ].map(s => (
            <div key={s.label} className="ip-stat">
              <span className="ip-stat__val" style={{ color: s.color, fontFamily: 'var(--font-mono)' }}>{s.val}</span>
              <span className="ip-stat__label">{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {profileCompanies.length > 0 && (
        <div className="ip-profile__section">
          <div className="ip-profile__section-label">Companies traded</div>
          <div className="ip-profile__companies">
            {profileCompanies.slice(0, 6).map(c => (
              <div key={c.ticker} className="ip-company-chip"
                onClick={() => onOpenDetail && onOpenDetail({ type: 'ticker', ticker: c.ticker, company: c.company })}>
                <span className="ticker" style={{ fontSize: 11 }}>{c.ticker}</span>
                <span className="ip-company-chip__name">{c.company}</span>
                <div className="ip-company-chip__counts">
                  {c.buys > 0 && <span className="val-buy" style={{ fontSize: 10, fontWeight: 700 }}>+{c.buys}</span>}
                  {c.sells > 0 && <span className="val-sell" style={{ fontSize: 10, fontWeight: 700 }}>−{c.sells}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="ip-profile__section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="ip-profile__section-label">
          <span>All transactions{profileTrades.length ? ` · ${profileTrades.length} found` : ''}</span>
        </div>
        {tradesLoading ? (
          <SkeletonRows count={8} />
        ) : profileTrades.length === 0 ? (
          <div className="ws-empty" style={{ padding: '12px 0', fontSize: 12 }}>No open-market transactions found.</div>
        ) : (
          <div className="ip-tx-list">
            {profileTrades.map((f, i) => {
              const isBuy = f.transactionType === 'buy', isExpTx = txExpanded.has(i);
              return (
                <div key={i} className="ip-tx-row" style={{ borderLeft: `2px solid ${isBuy ? 'var(--green-600)' : 'var(--red-600)'}` }}>
                  <div className="ip-tx-row__main" onClick={() => setTxExpanded(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}>
                    <span className="ip-tx-row__date">{fmt.dateShort(f.transactionDate || f.date)}</span>
                    <span className="ticker" style={{ fontSize: 12, minWidth: 40 }}>{f.ticker}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 8px' }}>{f.company}</span>
                    <span className={`ws-type-badge${isBuy ? ' ws-type-badge--buy' : ' ws-type-badge--sell'}`}>{isBuy ? 'Buy' : 'Sell'}</span>
                    <span className={`ws-data-mono${isBuy ? ' val-buy' : ' val-sell'}`} style={{ minWidth: 72, textAlign: 'right' }}>{isBuy ? '+' : '−'}{fmt.money(f.value)}</span>
                    <span className="ip-tx-row__chevron">{isExpTx ? '▾' : '▸'}</span>
                  </div>
                  {isExpTx && (
                    <div className="ip-tx-row__detail">
                      <div><span className="ws-data-label">Shares</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{f.shares ? fmt.number(f.shares) : '—'}</span></div>
                      <div><span className="ws-data-label">Price</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{f.price ? fmt.price(f.price) : '—'}</span></div>
                      <div><span className="ws-data-label">Total</span><span className={`ws-data-mono${isBuy ? ' val-buy' : ' val-sell'}`}>{isBuy ? '+' : '−'}{fmt.money(f.value)}</span></div>
                      {f.accessionNumber && f.cikIssuer && <div><span className="ws-data-label">SEC</span><a href={secFilingUrl(f.accessionNumber, f.cikIssuer)} target="_blank" rel="noopener noreferrer" className="ws-sec-link">↗ View</a></div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function InsightsDrawer({ type, filings, onClose, sigSort, sigDir, sigOnSort, initialDetail, initialDetailStack, ensureFilingsWindow, filingsLoading, watchlist, initialFilters, pro, onSwitchToData }) {
  const [appetite] = React.useContext(RiskAppetiteContext);

  // Tab switcher — user can pivot between views within the drawer
  const [activeTab, setActiveTab] = useState(type || 'signals'); // 'signals' | 'insiders' | 'data'

  // Reset detail when switching tabs so the pane doesn't show stale content.
  // Pre-warm: start the leaderboard fetch on click BEFORE state updates, so
  // data is already in flight by the time the tab renders.
  function switchTab(tab) {
    if (tab === activeTab) return;
    if (tab === 'data' && onSwitchToData) { onSwitchToData(); return; }
    if (tab === 'insiders') fetchLeaderboard(500, 2, lbYearsBack, lbSource).catch(() => { });
    setActiveTab(tab);
    setDetail(null);
    setDetailStack([]);
  }

  // ── left pane state ──────────────────────────────────────────────────────
  // Seeded from the tile's current selections when opened via "Explore full
  // view" or a row click, so filtering work already done on the tile isn't
  // silently discarded — falls back to these defaults when opened with no
  // tile context (e.g. a deep-linked ticker/insider URL).
  const [search, setSearch] = useState('');
  const [lbRows, setLbRows] = useState(null);
  const [lbSort, setLbSort] = useState('proxy_score');
  const [lbYearsBack, setLbYearsBack] = useState(2); // null = all-time
  const [lbSource, setLbSource] = useState(null); // null='all' | 'corporate' | 'congress'
  const [lbMinValue, setLbMinValue] = useState(50000); // minimum bought_value, filtered client-side — defaults to $50K rather than "Any" so a handful of small trades hitting 100% by chance doesn't dominate the default hit-rate sort
  const [lbDir, setLbDir] = useState(-1);
  const [srcF, setSrcF] = useState(initialFilters?.sourceF ?? '');
  const [secF, setSecF] = useState(initialFilters?.sectorF ?? '');
  const [minStr, setMinStr] = useState(initialFilters?.minStrength ?? 1);
  const [daysBack, setDaysBack] = useState(() => {
    const initial = initialFilters?.days ?? 7;
    if (!pro && (initial === null || initial > 7)) return 7;
    return initial;
  });
  const [minValue, setMinValue] = useState(0);  // $ net value floor — tile has no equivalent to seed from

  // ── right pane nav stack ─────────────────────────────────────────────────
  // Each entry is a {type, ...props} detail object — same shape as DetailPanel's `detail` prop.
  // Seeded from initialDetailStack when arriving via "Expand" from the small
  // panel, so navigation history from before expanding isn't silently lost —
  // otherwise this always started empty regardless of what was already open.
  const [detailStack, setDetailStack] = useState(() => initialDetailStack || []); // history
  const [detail, setDetail] = useState(null);

  function navigate(d) {
    if (detail) setDetailStack(s => [...s, detail]);
    // When navigating to an insider profile, switch to the insiders tab
    // so the new profile layout renders instead of the old inline one
    if (d?.type === 'trader' && activeTab !== 'insiders') {
      setActiveTab('insiders');
    }
    setDetail(d);
  }
  function goBack() {
    const prev = detailStack[detailStack.length - 1];
    setDetailStack(s => s.slice(0, -1));
    setDetail(prev || null);
  }

  // Sectors for filter dropdown
  const sectors = useMemo(() => [...new Set(filings.map(f => f.sector).filter(s => s && s !== 'Other'))].sort(), [filings]);

  // Strength threshold
  const strengthThreshold = minStr === 3 ? 60 : minStr === 2 ? 35 : 0;

  // Filtered signals — computed directly from raw `filings`, NOT from the
  // `signals` prop the parent page passes in. The parent's own signal set is
  // already bounded by whatever day-range IT has selected (default 7d), so
  // filtering further inside the drawer could only ever narrow within that —
  // widening the Window filter here would do nothing, since data outside the
  // parent's window was never in the array to begin with. Building fresh from
  // `filings` makes the drawer's own Window filter the real source of truth.
  const filteredSignals = useMemo(() => {
    const cutoff = daysBack != null ? (() => { const d = new Date(); d.setDate(d.getDate() - daysBack); return d.toISOString().split('T')[0]; })() : null;
    const base = filings.filter(f => {
      const tx = f.transactionDate || f.date || '';
      if (cutoff && tx < cutoff) return false;
      const isPol = !!(f.transactionCode && f.transactionCode.startsWith('CONGRESS'));
      if (srcF === 'corporate' && isPol) return false;
      if (srcF === 'political' && !isPol) return false;
      if (secF && f.sector !== secF) return false;
      return true;
    });
    let s = buildSignals(base)
      .filter(sig => {
        if (sig.direction === 'sell') return sig.sellValue >= 50_000;
        return sig.cSuiteBuys >= 1 || sig.insiderCount >= 2 || sig.netValue >= 100_000 || sig.isPolitical;
      })
      .filter(sig => sig.conviction >= strengthThreshold);
    if (minValue > 0) s = s.filter(sig => Math.abs(sig.netValue) >= minValue);
    if (search) { const q = search.toLowerCase(); s = s.filter(sig => sig.ticker.toLowerCase().includes(q) || sig.company.toLowerCase().includes(q)); }
    return s.sort((a, b) => {
      const av = a[sigSort], bv = b[sigSort];
      if (typeof av === 'number') { if (av < bv) return sigDir; if (av > bv) return -sigDir; }
      else { const r = String(av || '').localeCompare(String(bv || '')); return sigDir > 0 ? r : -r; }
      return 0;
    });
  }, [filings, strengthThreshold, srcF, secF, daysBack, minValue, search, sigSort, sigDir]);

  // ── Insiders: shared cache + server-side search ──────────────────────────
  // Base load (no name filter) uses the shared module-level cache so
  // navigating between Insights tile → drawer → back doesn't re-query.
  // Stale-while-revalidate: filter changes keep showing previous rows with
  // a loading indicator instead of wiping to a skeleton.
  const [lbLoading, setLbLoading] = useState(false);
  // Server-side search rows — when the user types a name, we query the
  // server with the name in the WHERE clause so insiders outside the
  // top 500 are findable. Null = not searching, use base rows.
  const [lbSearchRows, setLbSearchRows] = useState(null);
  // Debounced search term for server-side insider search
  const [lbSearchTerm, setLbSearchTerm] = useState('');
  useEffect(() => {
    if (activeTab !== 'insiders') return;
    const t = setTimeout(() => setLbSearchTerm(search), 300);
    return () => clearTimeout(t);
  }, [search, activeTab]);

  // Base load — shared cache, stale-while-revalidate
  useEffect(() => {
    if (activeTab !== 'insiders') return;
    setLbLoading(true);
    fetchLeaderboard(500, 2, lbYearsBack, lbSource)
      .then(r => { setLbRows(r); setLbLoading(false); })
      .catch(() => { setLbRows(prev => prev || []); setLbLoading(false); });
  }, [activeTab, lbYearsBack, lbSource]);

  // Server-side name search — fires when debounced search term changes.
  // Searches the full database, not just the cached top 500.
  useEffect(() => {
    if (activeTab !== 'insiders') return;
    if (!lbSearchTerm) { setLbSearchRows(null); return; }
    setLbLoading(true);
    fetchLeaderboard(500, 1, lbYearsBack, lbSource, lbSearchTerm)
      .then(r => { setLbSearchRows(r); setLbLoading(false); })
      .catch(() => { setLbSearchRows([]); setLbLoading(false); });
  }, [lbSearchTerm, lbYearsBack, lbSource, activeTab]);

  const sortedLb = useMemo(() => {
    // Use server search results when searching, base rows otherwise
    const source = lbSearchTerm ? lbSearchRows : lbRows;
    if (!source) return [];
    let rows = source;
    // Client-side name filter for instant feedback while debounce is pending
    if (search && !lbSearchTerm) { const q = search.toLowerCase(); rows = rows.filter(r => r.insider_name.toLowerCase().includes(q)); }
    if (lbMinValue > 0) { rows = rows.filter(r => (r.bought_value || 0) >= lbMinValue); }
    return [...rows].sort((a, b) => {
      const av = a[lbSort] ?? -Infinity, bv = b[lbSort] ?? -Infinity;
      return lbDir > 0 ? av - bv : bv - av;
    });
  }, [lbRows, lbSearchRows, lbSearchTerm, lbSort, lbDir, search, lbMinValue]);
  function lbOnSort(col) { if (lbSort === col) setLbDir(d => -d); else { setLbSort(col); setLbDir(-1); } }

  function resetDrawerFilters() { setMinStr(1); setDaysBack(30); setMinValue(0); setSrcF(''); setSecF(''); setSearch(''); }
  const drawerFiltersDefault = minStr === 1 && daysBack === 30 && minValue === 0 && !srcF && !secF && !search;

  // Escape key
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') { if (detail && detailStack.length) goBack(); else if (detail) setDetail(null); else onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [detail, detailStack, onClose]);

  // Open pre-selected to whatever was clicked, if anything — otherwise fall
  // back to the first item so the pane is never empty on open.
  useEffect(() => {
    if (detail) return;
    if (initialDetail) { setDetail(initialDetail); return; }
    if (activeTab === 'signals' && filteredSignals.length) setDetail({ type: 'signal', ...filteredSignals[0] });
  }, [activeTab, filteredSignals.length > 0, initialDetail]);

  useEffect(() => {
    if (detail) return;
    if (initialDetail) return; // already handled above
    if (activeTab === 'insiders' && sortedLb.length) setDetail({ type: 'trader', name: sortedLb[0].insider_name, title: sortedLb[0].insider_title });
  }, [activeTab, sortedLb.length > 0, initialDetail]);

  // Scroll the left list to whatever's selected when the drawer first opens —
  // without this, expanding from a quick-glance preview lands the user on a
  // fully-scrolled, freshly-sorted list with the actual selection potentially
  // way off-screen, making it hard to tell what's selected or how it relates
  // to everything else in the list. Only fires once per open, not on every
  // later click within the drawer — a row the user just clicked is already
  // visible, so re-scrolling then would just be disorienting.
  const listRef = useRef(null);
  const scrolledOnOpenRef = useRef(false);
  useEffect(() => {
    if (scrolledOnOpenRef.current || !detail) return;
    const key = detail.type === 'trader' ? detail.name : detail.ticker;
    if (!key) return;
    const el = listRef.current?.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      scrolledOnOpenRef.current = true;
    }
  }, [detail, filteredSignals, sortedLb]);

  return (
    <div className="drawer-overlay" onClick={e => { if (e.target.classList.contains('drawer-overlay')) onClose(); }}>
      <div className="drawer">

        {/* Branded top bar — matches topnav height so the page behind remains visible */}
        <div className="drawer__topbar">
          <div className="drawer__topbar-logo">
            <div className="topnav__mark" style={{ width: 22, height: 22 }}><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="topnav__wordmark" style={{ fontSize: 14 }}>Seli</span>
          </div>
          <div className="drawer__tabs">
            {[['signals', 'Signals'], ['insiders', 'Insiders'], ['data', 'Raw Data']].map(([k, l]) => (
              <button key={k}
                className={`drawer__tab${activeTab === k ? ' drawer__tab--active' : ''}`}
                onClick={() => switchTab(k)}>{l}</button>
            ))}
          </div>
          {!pro && <button className="drawer__topbar-cta" onClick={() => { if (window.__seliUpgrade) window.__seliUpgrade('pro_direct'); }}>Go Pro</button>}
          <button className="modal-close" onClick={onClose} title="Close (Esc)" style={{ marginLeft: pro ? 'auto' : 0 }}><IconClose style={{ width: 12, height: 12 }} /></button>
        </div>

        {/* Filter toolbar — changes per active tab */}
        {activeTab === 'signals' && (
          <div className="drawer__toolbar">
            <div className="drawer__filter-group drawer__filter-group--search">
              <span className="drawer__filter-label">Search</span>
              <div className="drawer__search-wrap">
                <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                <input className="drawer__search" placeholder="Ticker or company…"
                  value={search} onChange={e => setSearch(e.target.value)} autoFocus />
              </div>
            </div>

            <div className="drawer__toolbar-divider" />

            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Strength</span>
              <div className="dash-tile-pills" style={{ gap: 2 }}>
                {[{ v: 1, l: 'Any' }, { v: 2, l: 'Med+' }, { v: 3, l: 'High' }].map(o => (
                  <button key={o.v}
                    className={`dash-tile-pill${minStr === o.v ? ' dash-tile-pill--active' : ''}`}
                    style={o.v === 3 && minStr === 3 ? { background: 'var(--green-600)', borderColor: 'var(--green-600)', color: '#fff' } :
                      o.v === 2 && minStr === 2 ? { background: 'var(--amber-600)', borderColor: 'var(--amber-600)', color: '#fff' } : {}}
                    onClick={() => setMinStr(o.v)}>{o.l}</button>
                ))}
              </div>
            </div>

            <div className="drawer__toolbar-divider" />

            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Window</span>
              <div className="dash-tile-pills" style={{ gap: 2 }}>
                {[{ v: 3, l: '3d' }, { v: 7, l: '7d' }].map(o => (
                  <button key={o.l} className={`dash-tile-pill${daysBack === o.v ? ' dash-tile-pill--active' : ''}`}
                    onClick={() => { setDaysBack(o.v); ensureFilingsWindow && ensureFilingsWindow(o.v); }}>{o.l}</button>
                ))}
                {pro ? [{ v: 30, l: '30d' }, { v: 90, l: '90d' }, { v: null, l: 'All' }].map(o => (
                  <button key={o.l} className={`dash-tile-pill${daysBack === o.v ? ' dash-tile-pill--active' : ''}`}
                    onClick={() => { setDaysBack(o.v); ensureFilingsWindow && ensureFilingsWindow(o.v); }}>{o.l}</button>
                )) : (
                  <button className="dash-tile-pill dash-tile-pill--locked" onClick={() => { if (window.__seliUpgrade) window.__seliUpgrade('full_history'); }}><IconLock style={{ width: 10, height: 10, marginRight: 3, verticalAlign: '-1px' }} />More</button>
                )}
              </div>
            </div>

            <div className="drawer__toolbar-divider" />

            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Min value</span>
              <select className="ins-filter-select" value={minValue} onChange={e => setMinValue(Number(e.target.value))}>
                <option value={0}>Any</option>
                <option value={100000}>$100K+</option>
                <option value={500000}>$500K+</option>
                <option value={1000000}>$1M+</option>
              </select>
            </div>

            <div className="drawer__toolbar-divider" />

            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Type</span>
              <select className="ins-filter-select" value={srcF} onChange={e => setSrcF(e.target.value)}>
                <option value="">All types</option>
                <option value="corporate">Corporate</option>
                <option value="political">Congressional</option>
              </select>
            </div>

            <div className="drawer__toolbar-divider" />

            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Sector</span>
              <select className="ins-filter-select" value={secF} onChange={e => setSecF(e.target.value)}>
                <option value="">All sectors</option>
                {sectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div className="drawer__toolbar-spacer" />
            {!drawerFiltersDefault && (
              <button className="ins-filter-reset" onClick={resetDrawerFilters}>Reset filters</button>
            )}
          </div>
        )}
        {activeTab === 'insiders' && (
          <div className="drawer__toolbar">
            <div className="drawer__filter-group drawer__filter-group--search">
              <span className="drawer__filter-label">Search</span>
              <div className="drawer__search-wrap">
                <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                <input className="drawer__search" placeholder="Insider name…"
                  value={search} onChange={e => setSearch(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="drawer__toolbar-divider" />
            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Source</span>
              <div className="dash-tile-pills" style={{ gap: 2 }}>
                {[[null, 'All'], ['corporate', 'Corporate'], ['congress', 'Congress']].map(([v, l]) => {
                  if (!pro && v !== null) return null;
                  return (
                    <button key={l} className={`dash-tile-pill${lbSource === v ? ' dash-tile-pill--active' : ''}`}
                      onClick={() => setLbSource(v)}>{l}</button>
                  );
                })}
              </div>
            </div>
            <div className="drawer__toolbar-divider" />
            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Window</span>
              <div className="dash-tile-pills" style={{ gap: 2 }}>
                {[[1, '1yr'], [2, '2yr'], [5, '5yr'], [null, 'All']].map(([v, l]) => {
                  if (!pro && v !== null) return null;
                  return (
                    <button key={l} className={`dash-tile-pill${lbYearsBack === v ? ' dash-tile-pill--active' : ''}`}
                      onClick={() => setLbYearsBack(v)}>{l}</button>
                  );
                })}
              </div>
            </div>
            <div className="drawer__toolbar-divider" />
            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Sort by</span>
              <div className="dash-tile-pills" style={{ gap: 2 }}>
                {[['proxy_score', 'Score'], ['om_buys', 'Buys'], ['bought_value', 'Bought'], ['avg_return', 'Biggest return']].map(([k, l]) => (
                  <button key={k} className={`dash-tile-pill${lbSort === k ? ' dash-tile-pill--active' : ''}`}
                    onClick={() => lbOnSort(k)}>{l}{lbSort === k && (lbDir < 0 ? '↓' : '↑')}</button>
                ))}
              </div>
            </div>
            <div className="drawer__toolbar-divider" />
            <div className="drawer__filter-group">
              <span className="drawer__filter-label">Min position</span>
              <div className="dash-tile-pills" style={{ gap: 2, alignItems: 'center' }}>
                {[[0, 'Any'], [50000, '$50K'], [100000, '$100K'], [1000000, '$1M'], [10000000, '$10M']].map(([v, l]) => (
                  <button key={l} className={`dash-tile-pill${lbMinValue === v ? ' dash-tile-pill--active' : ''}`}
                    onClick={() => setLbMinValue(v)}>{l}</button>
                ))}
                <input type="number" className="ins-filter-select" placeholder="Custom $" style={{ width: 84, marginLeft: 4 }}
                  value={lbMinValue && ![0, 50000, 100000, 1000000, 10000000].includes(lbMinValue) ? lbMinValue : ''}
                  onChange={e => setLbMinValue(e.target.value ? Number(e.target.value) : 0)} />
              </div>
            </div>
          </div>
        )}

        {/* ── Two-pane body ──────────────────────────────────────────── */}
        <div className="drawer__body">

          {/* LEFT: list */}
          <div className="drawer__list" ref={listRef}>
            {activeTab === 'signals' && (
              <>
                <div className="drawer__list-hdr">
                  <span>{filteredSignals.length} signals{filingsLoading && <span className="td-muted" style={{ marginLeft: 6, fontWeight: 400 }}><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, marginRight: 4, display: 'inline-block', verticalAlign: '-1px' }} />loading more…</span>}</span>
                  <div className="dash-sig-sort" style={{ marginLeft: 'auto', gap: 2 }}>
                    {[['conviction', 'Conv'], ['netValue', 'Net $'], ['buys', 'Moves'], ['lastTradeDate', 'Recent']].map(([k, l]) => (
                      <button key={k} className={`dash-sort-btn${sigSort === k ? ' dash-sort-btn--active' : ''}`} onClick={() => sigOnSort(k)}>
                        {l}{sigSort === k && (sigDir < 0 ? '↓' : '↑')}
                      </button>
                    ))}
                  </div>
                </div>
                {filteredSignals.length === 0
                  ? <div className="drawer__empty">No signals match your filters</div>
                  : filteredSignals.map(s => {
                    const isActive = detail?.ticker === s.ticker && detail?.activeTab === 'signal';
                    const convPct = Math.min((s.conviction / 100) * 100, 100);
                    const tier = tierFromPct(convPct, appetite);
                    return (
                      <div key={s.ticker}
                        data-row-key={s.ticker}
                        className={`drawer__list-row drawer__list-row--${tier}${isActive ? ' drawer__list-row--active' : ''}`}
                        onClick={() => { setDetail({ type: 'signal', ...s }); setDetailStack([]); }}>
                        <div className="drawer__list-row__main">
                          <span className="ticker" style={{ fontSize: '0.75rem', fontWeight: 700 }}>{s.ticker}</span>
                          {s.cSuiteBuys > 0 && <span className="csuite-badge" style={{ fontSize: '0.6875rem' }}>{s.cSuiteBuys}×</span>}
                          {s.isPolitical && <span className="badge badge--src-congress" style={{ fontSize: '0.6875rem' }}>C</span>}
                          <span className="td-muted" style={{ fontSize: '0.6875rem', flex: 1 }}>{s.company}</span>
                          <span className={`td-mono drawer__list-row__val ${s.netValue >= 0 ? 'val-buy' : 'val-sell'}`}>{s.netValue >= 0 ? '+' : ''}{fmt.money(s.netValue)}</span>
                        </div>
                        <div className="drawer__list-row__sub">
                          <ConvictionBar score={s.conviction} />
                          <span className="td-muted" style={{ fontSize: '0.6875rem', marginLeft: 'auto' }}>{fmt.ago(s.lastTradeDate)}</span>
                        </div>
                      </div>
                    );
                  })
                }
              </>
            )}

            {activeTab === 'insiders' && (
              <>
                <div className="drawer__list-hdr">
                  <span>{lbRows === null && !lbSearchRows ? '' : '' + sortedLb.length + ' insiders'}{lbLoading && sortedLb.length > 0 && <span className="td-muted" style={{ marginLeft: 6, fontWeight: 400 }}><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, marginRight: 4, display: 'inline-block', verticalAlign: '-1px' }} />updating…</span>}</span>
                </div>
                {lbRows === null && !lbSearchRows
                  ? <SkeletonRows count={12} />
                  : lbLoading && sortedLb.length === 0
                    ? <SkeletonRows count={8} />
                    : sortedLb.length === 0
                      ? <div className="drawer__empty">No insiders match</div>
                      : sortedLb.map((r, i) => {
                        const isActive = detail?.type === 'trader' && detail?.name === r.insider_name;
                        return (
                          <div key={i}
                            data-row-key={r.insider_name}
                            className={`drawer__list-row${isActive ? ' drawer__list-row--active' : ''}`}
                            onClick={() => { setDetail({ type: 'trader', name: r.insider_name, title: r.insider_title }); setDetailStack([]); }}>
                            <div className="drawer__list-row__main">
                              <span className="td-muted" style={{ fontSize: '0.6875rem', width: 18 }}>{i + 1}</span>
                              <span style={{ fontSize: '0.75rem', fontWeight: 500, flex: 1 }}>{r.insider_name}</span>
                              <span className="td-mono" style={{ fontSize: 13, fontWeight: 700 }}>{r.proxy_score}</span>
                            </div>
                            <div className="drawer__list-row__sub">
                              <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{r.insider_title || 'Unknown'}</span>
                              <span className="td-muted" style={{ fontSize: '0.6875rem', marginLeft: 'auto' }}>{r.om_buys} buys · {fmt.money(r.bought_value)}</span>
                            </div>
                          </div>
                        );
                      })
                }
              </>
            )}
          </div>

          {/* RIGHT: inline detail panel */}
          <div className="drawer__detail">
            {!detail
              ? <div className="drawer__detail-empty">
                <div style={{ fontSize: 24, marginBottom: 8, opacity: .3 }}></div>
                <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Select a {activeTab === 'signals' ? 'signal' : 'trader'} to explore</div>
              </div>
              : activeTab === 'insiders' && detail.type === 'trader'
                ? <InsiderProfileDrawer name={detail.name} title={detail.title} filings={filings} watchlist={watchlist} lbRows={lbRows || []} onOpenDetail={(d) => navigate(d)} />
                : <DetailPanel
                  detail={detail}
                  filings={filings}
                  onClose={() => setDetail(null)}
                  onNavigate={(d) => navigate(d)}
                  onBack={goBack}
                  canGoBack={detailStack.length > 0}
                  watchlist={watchlist}
                  inline={true}
                />
            }
          </div>

        </div>
      </div>
    </div>
  );
}


// ─── Keep old environments for direct navigation (leaderboard + sector flow full pages)
// These are now only reached via the sidebar "full rankings" links, not primary nav


// ─── SNAPSHOT — overview cards, one per environment ────────────────────────────

// ─── SIGNALS environment (existing table logic, now scoped as a sub-view) ─────

// ─── INSIDER LEADERBOARD environment ───────────────────────────────────────────
// Aggregate query: ranks insiders by a simplified, query-computable proxy for
// trust score (priced-trade hit rate + OM discipline + volume), since running
// the full per-insider trustScore() pipeline for every insider in the DB isn't
// practical in one query. This is consistent with the same approximation used
// for "Related Insiders" on the trader profile.
function LEADERBOARD_QUERY(limit = 50, sectorFilter = null, minTrades = 5, yearsBack = 2, sourceFilter = null, nameFilter = null) {
  const sectorClause = sectorFilter ? `AND f.sector = '${sectorFilter.replace(/'/g, "''")}'` : '';
  // Server-side name search — highly selective, so the LATERAL JOINs only
  // run over the handful of matching rows instead of the full table.
  const nameClause = nameFilter ? `AND f.insider_name ILIKE '%${nameFilter.replace(/'/g, "''")}%'` : '';
  // Date window is now a real parameter rather than hardcoded — yearsBack=null
  // means no date filter at all (true all-time), used by the unsortable
  // preview tiles (Dashboard, Insights side panel) where "all-time" is the
  // more honest ranking than an arbitrary 2-year cutoff nobody chose.
  const dateClause = yearsBack != null
    ? `AND COALESCE(f.transaction_date, f.filing_date) >= (CURRENT_DATE - INTERVAL '${Number(yearsBack)} years')`
    : '';
  // Corporate vs congressional — congressional trades are the only ones
  // whose transaction_code starts with 'CONGRESS' (set at ingestion).
  const sourceClause = sourceFilter === 'congress' ? `AND f.transaction_code LIKE 'CONGRESS%'`
    : sourceFilter === 'corporate' ? `AND (f.transaction_code IS NULL OR f.transaction_code NOT LIKE 'CONGRESS%')`
      : '';
  // Win/loss now requires a MEANINGFUL margin (5%+) rather than the old
  // razor-thin `close >= buy price`, where a stock up $0.01 counted as a
  // full win identically to one up 400%. Trades that are roughly flat
  // (within ±5%) are excluded from `priced` entirely rather than forced
  // into a binary — a "push" shouldn't count as evidence of skill either way.
  //
  // Known limitation, not yet fixed here: this still compares against a
  // snapshot of the CURRENT price, not the market's own move over the same
  // window — so a rising market can inflate everyone's hit rate regardless
  // of actual stock-picking skill. A true fix needs a benchmark (e.g. SPY)
  // with full historical daily closes to compare each trade's date against,
  // which public.prices_history doesn't have yet — it only maintains a
  // rolling recent snapshot per ticker, not a multi-year series. That's a
  // separate backfill task, not a query change alone.
  // Approach 5 from the earlier brainstorm: show the market's own return as
  // context alongside the existing hit-rate number, without redefining
  // "win" or touching the existing scoring formula at all. Deliberately the
  // cheapest, lowest-risk of the options discussed — no new judgment call
  // about what counts as a win, just an honest second number sitting next
  // to the first one. Known limitation, stated plainly rather than hidden:
  // the comparison window still varies per trade (transaction date to
  // today), so a 2020 trade and a trade from last week aren't measured over
  // equal spans — a fixed-horizon or calendar-year version would be more
  // rigorous, but needs a full per-ticker historical price backfill, a
  // materially bigger project than this.
  return `
    SELECT agg.*,
      -- Proxy rank, mirroring processLeaderboardRows' own weights (hit rate,
      -- return magnitude, relationship tier, trade volume) — used ONLY to
      -- order rows before LIMIT is applied. This is the actual fix: without
      -- this, the query had no ORDER BY at all, so LIMIT cut off whatever
      -- arbitrary subset Postgres happened to return first (which read as
      -- roughly alphabetical) — the true top performers by any real
      -- criterion could easily have been excluded before ever reaching the
      -- frontend's own scoring. The frontend still computes its own
      -- authoritative proxy_score for display; this is purely to make sure
      -- the right rows survive the LIMIT in the first place.
      --
      -- Subquery, not a WITH CTE: the Worker's query endpoint only allows
      -- requests starting with the literal word SELECT (a real, deliberate
      -- security guard, not something to route around) — a CTE starting
      -- with WITH failed that check and 403'd, which is what actually
      -- caused this to look like a Pro-access problem for every user
      -- regardless of plan. Same query logic, just restructured to start
      -- with SELECT instead.
      (
        CASE WHEN agg.priced>=5 AND agg.wins::float/NULLIF(agg.priced,0)>=0.7 THEN 2
             WHEN agg.priced>=5 AND agg.wins::float/NULLIF(agg.priced,0)>=0.5 THEN 1
             ELSE 0 END
        + CASE WHEN agg.avg_return_pct>=30 THEN 1.5
               WHEN agg.avg_return_pct>=15 THEN 1
               WHEN agg.avg_return_pct>=5  THEN 0.5
               WHEN agg.avg_return_pct<0   THEN -0.5
               ELSE 0 END
        + CASE WHEN agg.relationship='strong' THEN 1.5
               WHEN agg.relationship='medium' THEN 0.75
               ELSE 0 END
        + CASE WHEN (agg.om_buys+agg.om_sells)>=10 THEN 1
               WHEN (agg.om_buys+agg.om_sells)>=5  THEN 0.5
               ELSE 0 END
        + CASE WHEN agg.total_buys>0 AND agg.om_buys::float/agg.total_buys>=0.7 THEN 0.5 ELSE 0 END
      ) AS proxy_rank
    FROM (
      SELECT f.insider_name,
             -- Pick the most frequently-filed title for this name, not just
             -- whatever GROUP BY happened to land on — avoids one person
             -- splitting into multiple rows because their title varied
             -- across filings (e.g. "President" vs "President and CEO").
             MODE() WITHIN GROUP (ORDER BY f.insider_title) AS insider_title,
             MODE() WITHIN GROUP (ORDER BY f.relationship)  AS relationship,
             BOOL_OR(f.transaction_code LIKE 'CONGRESS%') AS is_congress,
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
                 AND ph_buy.close >= f.price_per_share * 1.05
                 AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
             ) AS wins,
             COUNT(*) FILTER (
               WHERE f.transaction_type='buy' AND f.is_open_market
                 AND f.price_per_share>0 AND ph_buy.close IS NOT NULL
                 AND (ph_buy.close >= f.price_per_share * 1.05 OR ph_buy.close <= f.price_per_share * 0.95)
                 AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
             ) AS priced,
             -- Magnitude, not just frequency — a bare hit-rate can't tell
             -- "wins often by a little" apart from "wins less often but by a
             -- lot." Averaged over the same sanity-bounded, priced trade set.
             AVG(
               CASE WHEN f.transaction_type='buy' AND f.is_open_market
                         AND f.price_per_share>0 AND ph_buy.close IS NOT NULL
                         AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
                    THEN (ph_buy.close-f.price_per_share)/f.price_per_share*100
               END
             ) AS avg_return_pct,
             -- SPY's own return over the exact same transaction-date-to-today
             -- window, averaged over the SAME priced trade set as
             -- avg_return_pct above (same WHERE conditions deliberately
             -- duplicated, not approximated) — so the two numbers are
             -- directly comparable context, not two different populations.
             -- NULL (not 0) whenever benchmark_prices doesn't have data for
             -- the relevant dates yet, so an incomplete backfill degrades
             -- gracefully instead of silently reporting a false 0% move.
             AVG(
               CASE WHEN f.transaction_type='buy' AND f.is_open_market
                         AND f.price_per_share>0 AND ph_buy.close IS NOT NULL
                         AND ABS((ph_buy.close-f.price_per_share)/f.price_per_share)<3
                         AND spy_then.close IS NOT NULL AND spy_now.close IS NOT NULL
                    THEN (spy_now.close-spy_then.close)/spy_then.close*100
               END
             ) AS avg_spy_return_pct
      FROM public.filings f
      LEFT JOIN LATERAL (
        SELECT close FROM public.prices_history
        WHERE ticker=f.ticker ORDER BY date DESC LIMIT 1
      ) ph_buy ON true
      -- SPY's closing price on or before the transaction date — <=, not =,
      -- since the exact date may be a weekend/holiday when SPY didn't
      -- trade, same "walk back to the last real session" idea used
      -- elsewhere for market data.
      LEFT JOIN LATERAL (
        SELECT close FROM public.benchmark_prices
        WHERE symbol='SPY' AND date <= COALESCE(f.transaction_date, f.filing_date)
        ORDER BY date DESC LIMIT 1
      ) spy_then ON true
      LEFT JOIN LATERAL (
        SELECT close FROM public.benchmark_prices
        WHERE symbol='SPY' ORDER BY date DESC LIMIT 1
      ) spy_now ON true
      WHERE f.insider_name IS NOT NULL
        ${dateClause}
        ${sectorClause}
        ${sourceClause}
        ${nameClause}
      GROUP BY f.insider_name
      HAVING COUNT(*) FILTER (WHERE f.transaction_type IN ('buy','sell') AND f.is_open_market) >= ${minTrades}
    ) agg
    ORDER BY proxy_rank DESC NULLS LAST
    LIMIT ${limit}
  `;
}

// (processLeaderboardRows now lives in src/lib/scoring.js — imported above.)

// ─── Shared leaderboard cache ────────────────────────────────────────────────
// Module-level so every component that needs leaderboard data (sidebar preview,
// Insights tile, InsightsDrawer) shares a single cache instead of independently
// firing the same expensive LATERAL JOIN query. Keyed by filter combination.
// The sidebar's LIMIT 20 can slice from a cached LIMIT 500 if it's warm.
const _lbCache = new Map();
function lbCacheKey(yearsBack, source) { return `${yearsBack}|${source || 'all'}`; }

// Fetch with shared cache — returns processed rows. Callers get the cached
// promise if an identical request is already in flight, avoiding duplicate
// concurrent queries for the same filter set.
function fetchLeaderboard(limit, minTrades, yearsBack, source, nameFilter = null) {
  // Name-filtered queries are one-off searches, not cached — the result set
  // is specific to the search string and usually tiny.
  if (nameFilter) {
    return queryNeon(LEADERBOARD_QUERY(limit, null, minTrades, yearsBack, source, nameFilter))
      .then(r => processLeaderboardRows(r));
  }
  const key = lbCacheKey(yearsBack, source);
  const cached = _lbCache.get(key);
  // Return cached data if we have it AND the cached limit covers what's asked
  if (cached && cached.limit >= limit && cached.rows) return Promise.resolve(cached.rows);
  // If an identical or wider request is already in flight, piggyback on it
  if (cached && cached.promise && cached.limit >= limit) return cached.promise;
  const promise = queryNeon(LEADERBOARD_QUERY(limit, null, minTrades, yearsBack, source))
    .then(r => {
      const rows = processLeaderboardRows(r);
      _lbCache.set(key, { rows, limit, promise: null });
      return rows;
    })
    .catch(e => {
      // Don't cache failures — let the next caller retry
      const entry = _lbCache.get(key);
      if (entry && entry.promise === promise) _lbCache.delete(key);
      throw e;
    });
  _lbCache.set(key, { rows: null, limit, promise });
  return promise;
}


const DATA_DATE_PRESETS = [{ l: '1d', d: 1 }, { l: '3d', d: 3 }, { l: '7d', d: 7 }, { l: '30d', d: 30 }, { l: '90d', d: 90 }, { l: 'All', d: null }];
const DATA_SORTABLE_COLS = [
  { key: 'transaction_date', label: 'Trade Date', type: 'date' },
  { key: 'ticker', label: 'Ticker', type: 'text' },
  { key: 'company_name', label: 'Company', type: 'text' },
  { key: 'insider_name', label: 'Insider', type: 'text' },
  { key: 'transaction_type', label: 'Type', type: 'text' },
  { key: 'shares', label: 'Shares', type: 'num' },
  { key: 'price_per_share', label: 'Price', type: 'num' },
  { key: 'value', label: 'Value', type: 'num' },
  { key: 'pct_owned_change', label: 'Pos%', type: 'num' },
  { key: 'relationship', label: 'Role', type: 'text' },
];

async function proxySQL(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ query: sql }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) throw new Error('You don\'t have access to this — check your plan in Account');
  if (!r.ok) throw new Error('Something went wrong loading this — try again in a moment');
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.rows || [];
}

// Tries the pre-built R2 snapshot first — nearly all of a large export is
// served from a static file instead of pulled live through Neon, which is
// what actually removes the sustained-connection pressure that kept
// causing 503s on the old all-live-query path. Returns null (not a
// thrown error) specifically when no snapshot exists yet, since that's an
// expected, recoverable state the caller should fall back from — not
// something to bail out of the whole export over.
// ── CSV download (per-year files, zipped, in R2) ────────────────────────────
// The production export path for full-database purchases: downloads a ZIP
// of one CSV per calendar year — Excel and Numbers both cap out at 1,048,576
// rows (the old .xls limit both inherited), which this dataset blows past as
// a single file. The server scopes the data to the PURCHASE DATE, not
// today, so re-downloads never leak data bought later for free. No NDJSON
// parsing, no XLSX building, no multi-GB browser heap. The old NDJSON→XLSX
// pipeline (fetchExportViaSnapshot + downloadFullExport) stays for the Data
// page's filtered in-app export where the dataset is small enough to build
// client-side.
async function downloadCSVFromR2(mode = 'consume', onProgress = null, purchaseId = null) {
  const r = await fetch(`${cfg.NEON_PROXY_URL}/export/csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ mode, ...(purchaseId ? { purchaseId } : {}) }),
  });

  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || 'Full data export requires a one-time purchase.');
  }
  if (r.status === 202) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || 'Your export is being prepared — try again in a few minutes.');
  }
  if (!r.ok) throw new Error(`Export failed (status ${r.status})`);

  // Stream the response into a Blob with progress tracking
  const contentLength = Number(r.headers.get('Content-Length') || 0);
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      const mb = Math.round(received / 1024 / 1024);
      const pct = contentLength ? Math.round((received / contentLength) * 100) : 0;
      onProgress(contentLength ? `${mb} MB (${pct}%)` : `${mb} MB downloaded…`);
    }
  }

  const blob = new Blob(chunks, { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `seli_insider_trades_${new Date().toISOString().split('T')[0]}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  return received;
}


function FilterPanel({
  sectors,
  openMkt, setOpenMkt, fromPortfolio, setFromPortfolio,
  sectorF, setSectorF, sourceF, setSourceF,
  relF, setRelF, typeF, setTypeF,
}) {
  return (
    <div className="ins-filter-row">
      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Quick</span>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="fp-check">
            <input type="checkbox" checked={openMkt} onChange={e => setOpenMkt(e.target.checked)} />
            Open market only
          </label>
          <label className="fp-check">
            <input type="checkbox" checked={fromPortfolio} onChange={e => setFromPortfolio(e.target.checked)} />
            My portfolio
          </label>
        </div>
      </div>

      <div className="drawer__toolbar-divider" />

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Source</span>
        <div className="dash-tile-pills">
          {[['', 'All'], ['corporate', 'Corporate'], ['political', 'Political']].map(([v, l]) => (
            <button key={v} className={`dash-tile-pill${sourceF === v ? ' dash-tile-pill--active' : ''}`} onClick={() => setSourceF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider" />

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Role</span>
        <div className="dash-tile-pills">
          {[['', 'All'], ['strong', 'Exec'], ['medium', 'Officer'], ['weak', 'Director']].map(([v, l]) => (
            <button key={v} className={`dash-tile-pill${relF === v ? ' dash-tile-pill--active' : ''}`} onClick={() => setRelF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider" />

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Type</span>
        <div className="dash-tile-pills">
          {[['', 'All'], ['buy', 'Buy'], ['sell', 'Sell'], ['other', 'Other']].map(([v, l]) => (
            <button key={v} className={`dash-tile-pill${typeF === v ? ' dash-tile-pill--active' : ''}`} onClick={() => setTypeF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider" />

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Sector</span>
        <select className="ins-filter-select" value={sectorF} onChange={e => setSectorF(e.target.value)}>
          <option value="">All sectors</option>
          {sectors.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    </div>
  );
}

// ─── Data Drawer — expanded raw-filings explorer ───────────────────────────
// Opened when "expand" is triggered on a detail that originated from the
// Data page (marked by the presence of `dataFilters` on the detail object).
// Deliberately separate from InsightsDrawer: that component's two modes
// (ticker-aggregated signals, per-insider profiles) are a genuinely
// different data shape from Data's own — raw, itemized filings with Data's
// own columns (ticker/company/insider/type/value/date). Reusing
// InsightsDrawer for this would mean "expand" always drops someone into a
// different mental model than the one they were just looking at, which was
// the actual complaint this exists to fix.
//
// Seeded from `filterState` (DataPage's active filters at the moment
// something was opened) so expanding doesn't throw away filtering work
// already done — same reasoning InsightsDrawer already uses for its own
// initialFilters. Runs its own query rather than reading DataPage's state
// directly, since DataPage may since have unmounted.
function DataDrawer({ initialDetail, initialDetailStack, filterState, onClose, watchlist, portfolioTickers, pro, onUpgrade, onSwitchTab }) {
  const f = filterState || {};
  const [search, setSearch] = useState(f.search || '');
  const [typeF, setTypeF] = useState(f.typeF || '');
  const [relF, setRelF] = useState(f.relF || '');
  const [sectorF, setSectorF] = useState(f.sectorF || '');
  const [sourceF, setSourceF] = useState(f.sourceF || '');
  const [openMkt, setOpenMkt] = useState(f.openMkt || false);
  const [fromPortfolio, setFromPortfolio] = useState(f.fromPortfolio || false);
  const [dPreset, setDPreset] = useState(f.dPreset ?? 7);
  const [dateFrom, setDateFrom] = useState(f.dateFrom || '');
  const [dateTo, setDateTo] = useState(f.dateTo || '');
  const [sortKey, setSortKey] = useState(f.sortKey || 'transaction_date');
  const [sortDir, setSortDir] = useState(f.sortDir ?? -1);

  function resetFilters() {
    setSearch(''); setTypeF(''); setRelF(''); setSectorF(''); setSourceF('');
    setOpenMkt(false); setFromPortfolio(false);
    setDPreset(7); setDateFrom(''); setDateTo('');
  }

  const [rows, setRows] = useState(null);
  const [sectors, setSectors] = useState([]);
  const [detailStack, setDetailStack] = useState(() => initialDetailStack || []);
  const [detail, setDetail] = useState(initialDetail || null);

  useEffect(() => {
    if (!cfg.NEON_PROXY_URL) return;
    proxySQL(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL ORDER BY sector`)
      .then(r => setSectors(r.map(x => x.sector).filter(Boolean))).catch(() => { });
  }, []);

  function where() {
    const c = [];
    const ef = dateFrom || (dPreset != null ? (() => { const d = new Date(); d.setDate(d.getDate() - dPreset); return d.toISOString().split('T')[0]; })() : null);
    const et = dateTo || new Date().toISOString().split('T')[0];
    if (ef) c.push(`COALESCE(transaction_date,filing_date)>='${ef}'`);
    c.push(`COALESCE(transaction_date,filing_date)>='2013-01-01'`); // hard floor — matches earliest backfilled data
    c.push(`COALESCE(transaction_date,filing_date)<='${et}'`);
    if (typeF) c.push(`transaction_type='${typeF}'`);
    if (relF) c.push(`relationship='${relF}'`);
    if (sectorF) c.push(`sector='${sectorF.replace(/'/g, "''")}'`);
    if (openMkt) c.push(`is_open_market=true`);
    if (sourceF === 'corporate') c.push(`transaction_code NOT LIKE 'CONGRESS%'`);
    if (sourceF === 'political') c.push(`transaction_code LIKE 'CONGRESS%'`);
    if (fromPortfolio && portfolioTickers && portfolioTickers.length) {
      c.push(`ticker IN (${portfolioTickers.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})`);
    } else if (fromPortfolio) {
      c.push(`1=0`);
    }
    if (search) { const q = search.replace(/'/g, "''"); c.push(`(ticker ILIKE '%${q}%' OR insider_name ILIKE '%${q}%' OR company_name ILIKE '%${q}%')`); }
    return c.length ? 'WHERE ' + c.join(' AND ') : '';
  }
  function orderBy() {
    const col = DATA_SORTABLE_COLS.find(c => c.key === sortKey);
    const dir = sortDir > 0 ? 'ASC' : 'DESC';
    if (!col) return `ORDER BY COALESCE(transaction_date,filing_date) DESC`;
    if (sortKey === 'transaction_date') return `ORDER BY COALESCE(transaction_date,filing_date) ${dir} NULLS LAST`;
    return `ORDER BY ${sortKey} ${dir} NULLS LAST`;
  }

  // Stale-while-revalidate: keep showing previous rows while new query runs.
  // Only null out on very first load (rows starts null from useState).
  const EXPLORE_PAGE = 200;
  const [dataLoading, setDataLoading] = useState(false);
  const [explorePage, setExplorePage] = useState(0);
  const [exploreTotal, setExploreTotal] = useState(null);

  function loadExplorePage(p) {
    if (!cfg.NEON_PROXY_URL) return;
    setDataLoading(true);
    const w = where();
    // Get total count on first load or filter change
    if (p === 0) {
      proxySQL(`SELECT COUNT(*) AS count FROM public.filings ${w}`).then(r => {
        setExploreTotal(parseInt(r[0]?.count || 0));
      }).catch(() => { });
    }
    proxySQL(`
      SELECT transaction_date,filing_date,ticker,company_name,insider_name,insider_title,
             relationship,transaction_type,transaction_code,is_open_market,
             shares::float,price_per_share::float,value::float,pct_owned_change::float,sector
      FROM public.filings ${w}
      ${orderBy()}
      LIMIT ${EXPLORE_PAGE} OFFSET ${p * EXPLORE_PAGE}
    `).then(r => { setRows(r); setExplorePage(p); setDataLoading(false); }).catch(() => { setRows(prev => prev || []); setDataLoading(false); });
  }

  useEffect(() => {
    loadExplorePage(0);
  }, [search, typeF, relF, sectorF, sourceF, openMkt, fromPortfolio, dPreset, dateFrom, dateTo, sortKey, sortDir]);

  function navigate(d) { if (detail) setDetailStack(s => [...s, detail]); setDetail(d); }
  function goBack() { const prev = detailStack[detailStack.length - 1]; setDetailStack(s => s.slice(0, -1)); setDetail(prev || null); }

  // Same reasoning as InsightsDrawer's own version of this: expanding from a
  // docked preview should land with the row you were just looking at
  // visible and marked selected, not scrolled off the top of a freshly
  // fetched 300-row list. Only fires once per open.
  const rowKey = (t) => t ? `${t.ticker}|${t.insiderName || t.insider_name}|${t.transactionDate || t.transaction_date}` : null;
  const listRef = useRef(null);
  const scrolledOnOpenRef = useRef(false);
  useEffect(() => {
    if (scrolledOnOpenRef.current || !detail || detail.type !== 'transaction' || !rows) return;
    const key = rowKey(detail.trade);
    if (!key) return;
    const el = listRef.current?.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); scrolledOnOpenRef.current = true; }
  }, [detail, rows]);

  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer">
        <div className="drawer__topbar">
          <div className="drawer__topbar-logo">
            <div className="topnav__mark" style={{ width: 22, height: 22 }}><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="topnav__wordmark" style={{ fontSize: 14 }}>Seli</span>
          </div>
          <div className="drawer__tabs">
            {[['signals', 'Signals'], ['insiders', 'Insiders'], ['data', 'Raw Data']].map(([k, l]) => (
              <button key={k}
                className={`drawer__tab${k === 'data' ? ' drawer__tab--active' : ''}`}
                onClick={() => { if (k !== 'data' && onSwitchTab) onSwitchTab(k); }}>{l}</button>
            ))}
          </div>
          <button className="drawer__topbar-cta" onClick={() => onUpgrade && onUpgrade('data_export_direct')}>Export CSV</button>
          <button className="btn btn--ghost btn--icon" onClick={onClose} style={{ marginLeft: 0 }}><IconClose style={{ width: 12, height: 12 }} /></button>
        </div>

        <div className="drawer__toolbar">
          <div className="drawer__filter-group drawer__filter-group--search">
            <span className="drawer__filter-label">Search</span>
            <div className="drawer__search-wrap">
              <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input className="drawer__search" placeholder="Ticker, insider, company…"
                value={search} onChange={e => setSearch(e.target.value)} autoFocus />
            </div>
          </div>
          <div className="drawer__toolbar-divider" />
          <div className="drawer__filter-group">
            <span className="drawer__filter-label">Window</span>
            <div className="dash-tile-pills" style={{ gap: 2 }}>
              {DATA_DATE_PRESETS.map(p => {
                if (!pro && p.d === null) return null;
                return (
                  <button key={p.l} className={`dash-tile-pill${dPreset === p.d && !dateFrom ? ' dash-tile-pill--active' : ''}`}
                    onClick={() => { setDPreset(p.d); setDateFrom(''); setDateTo(''); }}>{p.l}</button>
                );
              })}
              {!pro && <button className="dash-tile-pill dash-tile-pill--locked" onClick={() => onUpgrade && onUpgrade('full_history')}><IconLock style={{ width: 10, height: 10, marginRight: 3, verticalAlign: '-1px' }} />All</button>}
            </div>
          </div>
          <div className="drawer__toolbar-divider" />
          <div className="drawer__filter-group">
            <span className="drawer__filter-label">Date range</span>
            <div className="drawer__date-range">
              <input type="date" className="drawer__date-input" value={dateFrom}
                min={!pro ? new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0] : undefined}
                onChange={e => {
                  if (!pro) {
                    const floor = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];
                    if (e.target.value && e.target.value < floor) { onUpgrade && onUpgrade('full_history'); return; }
                  }
                  setDateFrom(e.target.value); setDPreset(null);
                }} />
              <span className="drawer__date-sep">→</span>
              <input type="date" className="drawer__date-input" value={dateTo}
                onChange={e => { setDateTo(e.target.value); setDPreset(null); }} />
            </div>
          </div>
          {(search || typeF || relF || sectorF || sourceF || openMkt || fromPortfolio || dPreset !== 7 || dateFrom || dateTo) && (
            <>
              <div className="drawer__toolbar-spacer" />
              <button className="ins-filter-reset" onClick={resetFilters}>Reset filters</button>
            </>
          )}
        </div>

        <FilterPanel
          sectors={sectors}
          openMkt={openMkt} setOpenMkt={setOpenMkt}
          fromPortfolio={fromPortfolio} setFromPortfolio={setFromPortfolio}
          sectorF={sectorF} setSectorF={setSectorF}
          sourceF={sourceF} setSourceF={setSourceF}
          relF={relF} setRelF={setRelF}
          typeF={typeF} setTypeF={setTypeF}
        />

        <div className="drawer__body">
          <div className="drawer__list" ref={listRef}>
            <div className="drawer__list-hdr">
              <span>{rows == null ? '' : (exploreTotal != null ? `${explorePage * EXPLORE_PAGE + 1}–${Math.min((explorePage + 1) * EXPLORE_PAGE, exploreTotal)} of ${exploreTotal.toLocaleString()}` : `${rows.length}`) + ' filing' + (rows.length === 1 ? '' : 's')}{dataLoading && rows != null && <span className="td-muted" style={{ marginLeft: 6, fontWeight: 400 }}><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, marginRight: 4, display: 'inline-block', verticalAlign: '-1px' }} />updating…</span>}</span>
            </div>
            {rows === null
              ? <SkeletonRows count={12} />
              : dataLoading && rows.length === 0
                ? <SkeletonRows count={8} />
                : rows.length === 0
                  ? <div className="drawer__empty">No filings match these filters</div>
                  : rows.map((r, i) => {
                    const tt = r.transaction_type;
                    const trade = {
                      ticker: r.ticker, company: r.company_name, company_name: r.company_name,
                      insiderName: r.insider_name, insider_name: r.insider_name,
                      title: r.insider_title, insider_title: r.insider_title,
                      transactionType: tt, transaction_type: tt,
                      transactionCode: r.transaction_code, transaction_code: r.transaction_code,
                      isOpenMarket: r.is_open_market, is_open_market: r.is_open_market,
                      price: r.price_per_share, price_per_share: r.price_per_share,
                      shares: r.shares, value: r.value,
                      pctOwnedChange: r.pct_owned_change, pct_owned_change: r.pct_owned_change,
                      transactionDate: r.transaction_date, transaction_date: r.transaction_date,
                      date: r.filing_date, filing_date: r.filing_date,
                      relationship: r.relationship, sector: r.sector,
                    };
                    const isActive = detail?.type === 'transaction' && detail?.trade?.ticker === r.ticker
                      && detail?.trade?.insiderName === r.insider_name && detail?.trade?.transactionDate === r.transaction_date;
                    return (
                      <div key={i}
                        data-row-key={rowKey(trade)}
                        className={`drawer__list-row${isActive ? ' drawer__list-row--active' : ''}`}
                        onClick={() => navigate({ type: 'transaction', trade })}>
                        <div className="drawer__list-row__main">
                          <span className="ticker" style={{ fontSize: '0.75rem', fontWeight: 700 }}>{r.ticker || '—'}</span>
                          <Badge type={tt === 'buy' ? 'buy' : tt === 'sell' ? 'sell' : 'other'}>{tt === 'buy' ? 'Buy' : tt === 'sell' ? 'Sell' : 'Other'}</Badge>
                          <span className="td-muted" style={{ fontSize: '0.6875rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company_name}</span>
                          <span className={`td-mono drawer__list-row__val ${tt === 'buy' ? 'val-buy' : tt === 'sell' ? 'val-sell' : ''}`}>{r.value ? fmt.money(r.value) : '—'}</span>
                        </div>
                        <div className="drawer__list-row__sub">
                          <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{r.insider_name}</span>
                          <span className="td-muted" style={{ fontSize: '0.6875rem', marginLeft: 'auto' }}>{fmt.dateShort(r.transaction_date || r.filing_date)}</span>
                        </div>
                      </div>
                    );
                  })
            }
            {exploreTotal != null && exploreTotal > EXPLORE_PAGE && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '10px 0', fontSize: 12 }}>
                <button className="btn btn--sm" disabled={explorePage === 0} onClick={() => loadExplorePage(0)}>««</button>
                <button className="btn btn--sm" disabled={explorePage === 0} onClick={() => loadExplorePage(explorePage - 1)}>‹</button>
                <span style={{ color: 'var(--text-2)' }}>{explorePage + 1}/{Math.ceil(exploreTotal / EXPLORE_PAGE)}</span>
                <button className="btn btn--sm" disabled={(explorePage + 1) * EXPLORE_PAGE >= exploreTotal} onClick={() => loadExplorePage(explorePage + 1)}>›</button>
                <button className="btn btn--sm" disabled={(explorePage + 1) * EXPLORE_PAGE >= exploreTotal} onClick={() => loadExplorePage(Math.ceil(exploreTotal / EXPLORE_PAGE) - 1)}>»»</button>
              </div>
            )}
          </div>
          {!detail
            ? <div className="drawer__detail-empty">
              <div style={{ fontSize: 24, marginBottom: 8, opacity: .3 }}></div>
              <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Select a filing to see details</div>
            </div>
            : <DetailPanel
              detail={detail}
              filings={[]}
              onClose={() => setDetail(null)}
              onNavigate={navigate}
              onBack={goBack}
              canGoBack={detailStack.length > 0}
              watchlist={watchlist}
              inline={true}
            />
          }
        </div>
      </div>
    </div>
  );
}


// ─── PORTFOLIO PAGE ───────────────────────────────────────────────────────────

// ─── ROOT APP ─────────────────────────────────────────────────────────────────

// ─── TERMS OF SERVICE ─────────────────────────────────────────────────────────
// Referenced by Terms, Privacy, Cookie Policy, and the Help Center rather
// than repeated as a literal in each — one place to change going forward.
const SUPPORT_EMAIL = 'admin@seli.app';

function TermsPage() {
  const [dark, setDark] = useTheme();
  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{ marginLeft: 'auto' }} onClick={() => setDark(d => !d)} title="Toggle theme">
            {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
          </button>
        </div>
      </nav>
      <div className="legal-content">
        <h1>Terms of Service</h1>
        <p className="legal-date">Last updated: August 2, 2026</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using Seli ("the Service"), operated by SELI LLC, a New Mexico limited liability company ("SELI," "we," "us," or "our"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, do not use Seli.</p>
        <p>We may update these Terms at any time. Material changes will be communicated by email or a notice within the Service at least 30 days before they take effect. Your continued use of Seli after the effective date constitutes acceptance of the revised Terms. If you do not agree to the updated Terms, you must stop using the Service.</p>

        <h2>2. Description of Service</h2>
        <p>Seli is a data aggregation and research platform. It collects and organizes publicly available SEC Form 4 insider trading disclosures, congressional periodic transaction reports filed under the STOCK Act, and related public market data. The data is sourced from government databases including the SEC's EDGAR system and congressional disclosure portals.</p>
        <p>Seli applies a uniform, non-personalized scoring methodology to this data and presents it alongside the original filing data. The scoring is applied identically to every trade and every user.</p>

        <h2>3. Not Financial Advice</h2>
        <p><strong>Seli does not provide financial, investment, legal, or tax advice.</strong> No content on Seli, including conviction scores, insider rankings, alert notifications, portfolio overlays, data exports, or any other feature, constitutes a recommendation to buy, sell, or hold any security. Seli is not a registered investment advisor, broker-dealer, or financial planner under federal or state law.</p>
        <p>The scoring methodology is based on published academic research describing historical statistical tendencies across large samples of insider trades. Historical patterns do not predict future results. Individual trades, insiders, and market conditions vary. You are solely responsible for your own investment decisions.</p>
        <p>Consult a qualified financial professional before making investment decisions based on any information you find on Seli or elsewhere.</p>

        <h2>4. Data Accuracy and Limitations</h2>
        <p>We make commercially reasonable efforts to keep Seli's data accurate and current, but we make no representations or warranties about the completeness, accuracy, reliability, or timeliness of any data on the platform. Specific limitations include:</p>
        <ul>
          <li>SEC Form 4 filings may be filed up to two business days after a transaction occurs. Congressional disclosures may be filed up to 45 days after a transaction.</li>
          <li>SEC filings themselves may contain errors filed by the reporting persons.</li>
          <li>Ingestion, parsing, or scoring errors may occasionally occur on Seli's end despite reasonable quality controls.</li>
          <li>Market data (prices, returns, sector classifications) is sourced from third-party providers and may be delayed, incomplete, or inaccurate.</li>
          <li>Historical data coverage varies by time period and may be less complete for earlier years.</li>
        </ul>
        <p>You assume all risk associated with relying on this information.</p>

        <h2>5. User Accounts</h2>
        <p>An account is required to access certain features. You are responsible for maintaining the confidentiality of your account credentials, providing accurate registration information, and notifying us promptly of any unauthorized use at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
        <p>We may suspend or terminate accounts that violate these Terms, remain inactive for an extended period, or are used in a manner that threatens the security or integrity of the Service.</p>

        <h2>6. Brokerage Connections</h2>
        <p>If you connect a brokerage account through SnapTrade, you authorize Seli to retrieve read-only account data (positions, balances, account metadata) on your behalf. Seli never stores your brokerage login credentials and can never execute trades or move funds on your behalf. The brokerage connection is subject to SnapTrade's own terms and privacy policy. You can disconnect your brokerage at any time from Settings, which immediately revokes Seli's access.</p>

        <h2>7. Subscriptions, Billing, and Refunds</h2>
        <p>Certain features require a paid Pro subscription ({PRO_PRICE_LABEL}) or a one-time data export purchase ($39.99). All payments are processed by Stripe and subject to <a href="https://stripe.com/legal" target="_blank" rel="noopener noreferrer">Stripe's terms of service</a>.</p>
        <p><strong>Subscriptions.</strong> Pro subscriptions bill monthly. You may cancel at any time; cancellation takes effect at the end of the current billing period. No partial-month refunds are issued for cancellations. We reserve the right to change pricing with at least 30 days' notice to current subscribers.</p>
        <p><strong>Data exports.</strong> Each data export purchase provides a one-time download of the database as it exists at the time of purchase. Data exports are non-refundable once the download link has been generated.</p>
        <p><strong>Refund requests.</strong> If you believe you were charged in error or have not received the service you paid for, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> within 30 days of the charge. We will review each request individually.</p>

        <h2>8. Prohibited Uses</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use Seli for any purpose that violates applicable law, including securities law.</li>
          <li>Scrape, crawl, or systematically extract data from Seli by automated means.</li>
          <li>Resell, sublicense, or redistribute Seli's data, scoring, or rankings without written permission.</li>
          <li>Attempt to reverse-engineer the scoring methodology, algorithms, or backend systems.</li>
          <li>Attempt to gain unauthorized access to any part of Seli, its infrastructure, or other users' accounts.</li>
          <li>Use Seli in any manner that could disable, overburden, or impair the Service.</li>
          <li>Use Seli to facilitate insider trading, securities fraud, or market manipulation.</li>
        </ul>

        <h2>9. Intellectual Property</h2>
        <p>The Service, including its design, user interface, algorithms, scoring methodology, and all related intellectual property, is owned by SELI LLC. The underlying SEC and congressional filing data is public domain. Your use of Seli does not grant you ownership of or rights to any part of the Service beyond the limited license to use it under these Terms.</p>
        <p>You may use data you access through Seli (including data exports you purchase) for your own personal, non-commercial research purposes. Redistribution, resale, or commercial use of exported data requires written permission from SELI LLC.</p>

        <h2>10. Disclaimer of Warranties</h2>
        <p><strong>SELI IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, COMPLETENESS, AND NON-INFRINGEMENT.</strong></p>
        <p>We do not warrant that the Service will be uninterrupted, error-free, or free from harmful components. We do not warrant the accuracy, reliability, or completeness of any data, scores, rankings, or other content on the platform.</p>

        <h2>11. Limitation of Liability</h2>
        <p><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, SELI LLC, ITS MEMBERS, OFFICERS, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, LOSS OF DATA, INVESTMENT LOSSES, OR BUSINESS INTERRUPTION, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF OR INABILITY TO USE SELI, REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT, STRICT LIABILITY, OR OTHERWISE), EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</strong></p>
        <p>Our total aggregate liability for all claims arising out of or relating to these Terms or the Service shall not exceed the greater of (a) the total amount you paid to SELI LLC in the twelve (12) months immediately preceding the event giving rise to the claim, or (b) one hundred dollars ($100).</p>

        <h2>12. Indemnification</h2>
        <p>You agree to indemnify, defend, and hold harmless SELI LLC, its members, officers, employees, and agents from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or relating to: (a) your use of or reliance on the Service; (b) your violation of these Terms; (c) your violation of any applicable law or regulation; or (d) any investment decisions you make based in whole or in part on information obtained through Seli.</p>

        <h2>13. Dispute Resolution</h2>
        <p><strong>Governing law.</strong> These Terms are governed by and construed in accordance with the laws of the State of New Mexico, without regard to conflict of law principles.</p>
        <p><strong>Informal resolution.</strong> Before filing any formal proceeding, you agree to first contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and attempt to resolve the dispute informally for at least 30 days.</p>
        <p><strong>Jurisdiction.</strong> If informal resolution fails, any legal action or proceeding arising under these Terms shall be brought exclusively in the state or federal courts located in Bernalillo County, New Mexico, and you consent to the personal jurisdiction of such courts.</p>
        <p><strong>Class action waiver.</strong> You agree that any dispute resolution proceedings will be conducted only on an individual basis and not as a class, consolidated, or representative action.</p>

        <h2>14. Severability</h2>
        <p>If any provision of these Terms is found to be unenforceable or invalid, that provision shall be limited or eliminated to the minimum extent necessary so that the remaining Terms remain in full force and effect.</p>

        <h2>15. Entire Agreement</h2>
        <p>These Terms, together with the <a href="/privacy">Privacy Policy</a> and <a href="/cookies">Cookie Policy</a>, constitute the entire agreement between you and SELI LLC regarding your use of Seli and supersede any prior agreements.</p>

        <h2>16. Contact</h2>
        <p>SELI LLC<br />Albuquerque, New Mexico<br /><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </div>
          <div className="lp-footer__links">
            <a href="/">Home</a>
            <span>·</span>
            <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
            <span>·</span>
            <a href="/cookies" className="lp-footer__link-muted">Cookies</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── PRIVACY POLICY ───────────────────────────────────────────────────────────
function PrivacyPage() {
  const [dark, setDark] = useTheme();
  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{ marginLeft: 'auto' }} onClick={() => setDark(d => !d)} title="Toggle theme">
            {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
          </button>
        </div>
      </nav>
      <div className="legal-content">
        <h1>Privacy Policy</h1>
        <p className="legal-date">Last updated: August 2, 2026</p>

        <h2>1. Overview</h2>
        <p>This Privacy Policy describes how SELI LLC ("SELI," "we," "us," or "our") collects, uses, shares, and protects your personal information when you use Seli. By using the Service, you consent to the practices described in this policy.</p>

        <h2>2. Information We Collect</h2>

        <h3>Account Information</h3>
        <p>When you create a Seli account, we collect your email address and, if you sign in with Google, your name and profile picture. Authentication is handled by Clerk (clerk.com). Seli never receives or stores your password.</p>

        <h3>Billing Information</h3>
        <p>If you subscribe to Pro or purchase a data export, payment is processed by Stripe. Seli receives a Stripe customer ID and subscription status. We never receive, process, or store your full credit card number, bank account details, or other payment credentials.</p>

        <h3>Watchlist and Preference Data</h3>
        <p>Tickers and insiders you add to your watchlist, notification preferences, and display settings (theme, filters) are stored in our database and tied to your account.</p>

        <h3>Brokerage Data</h3>
        <p>If you connect a brokerage account through SnapTrade, Seli stores an encrypted connection token and retrieves your portfolio positions (holdings, balances, account metadata) on a read-only basis. Seli never receives or stores your brokerage login credentials and cannot execute trades or transfer funds.</p>

        <h3>Usage Data</h3>
        <p>We collect standard server logs (IP addresses, browser type, pages visited, timestamps) for security monitoring, performance optimization, and debugging. If analytics tooling is added in the future, this policy will be updated before any new data collection begins.</p>

        <h2>3. How We Use Your Information</h2>
        <p>We use the information we collect to:</p>
        <ul>
          <li>Provide, operate, and improve the Service.</li>
          <li>Display insider trading activity relevant to your portfolio holdings and watchlist.</li>
          <li>Send transactional emails (account verification, password reset) through Clerk.</li>
          <li>Send digest and instant alert notifications if you have enabled them in Account.</li>
          <li>Process payments through Stripe.</li>
          <li>Respond to support requests.</li>
          <li>Detect and prevent fraud, abuse, or security incidents.</li>
        </ul>

        <h2>4. Data Sharing and Sub-Processors</h2>
        <p><strong>Seli does not sell your personal data.</strong> We do not share your personal information with third parties for their own marketing purposes. We share data only with the following service providers ("sub-processors") who process it on our behalf to operate the Service:</p>
        <table className="legal-table">
          <thead><tr><th>Provider</th><th>Purpose</th><th>Data shared</th></tr></thead>
          <tbody>
            <tr><td><a href="https://clerk.com/privacy" target="_blank" rel="noopener noreferrer">Clerk</a></td><td>Authentication, user management</td><td>Email, name, profile picture</td></tr>
            <tr><td><a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">Stripe</a></td><td>Payment processing</td><td>Email, payment method (direct to Stripe)</td></tr>
            <tr><td><a href="https://neon.tech/privacy" target="_blank" rel="noopener noreferrer">Neon</a></td><td>Database hosting</td><td>Account data, watchlist, preferences</td></tr>
            <tr><td><a href="https://cloudflare.com/privacypolicy" target="_blank" rel="noopener noreferrer">Cloudflare</a></td><td>Hosting, CDN, security</td><td>Request metadata (IP, headers)</td></tr>
            <tr><td><a href="https://snaptrade.com/privacy" target="_blank" rel="noopener noreferrer">SnapTrade</a></td><td>Brokerage connection</td><td>Connection token, portfolio data</td></tr>
            <tr><td><a href="https://resend.com/privacy" target="_blank" rel="noopener noreferrer">Resend</a></td><td>Email delivery</td><td>Email address, email content</td></tr>
          </tbody>
        </table>
        <p>We may also disclose your information if required by law, subpoena, court order, or other legal process, or if we believe disclosure is necessary to protect the rights, property, or safety of SELI LLC, our users, or the public.</p>

        <h2>5. Data Retention</h2>
        <p>Your account data is retained for as long as your account is active. If you delete your account, we will delete your personal data within 30 days. Watchlist data, notification preferences, and brokerage connection tokens are deleted immediately upon account deletion or disconnection. Anonymized, aggregated data that cannot be used to identify you may be retained indefinitely for service improvement purposes.</p>

        <h2>6. Security</h2>
        <p>We use industry-standard security measures including encrypted connections (TLS/HTTPS), encrypted storage of sensitive tokens (AES-256), and access controls. Despite these measures, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

        <h2>7. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have the following rights regarding your personal data:</p>
        <ul>
          <li><strong>Access.</strong> Request a copy of the personal data we hold about you.</li>
          <li><strong>Correction.</strong> Request correction of inaccurate personal data.</li>
          <li><strong>Deletion.</strong> Request deletion of your account and associated personal data.</li>
          <li><strong>Portability.</strong> Request your data in a structured, machine-readable format.</li>
          <li><strong>Opt-out.</strong> Unsubscribe from digest or alert emails at any time from Settings or by using the unsubscribe link in any email.</li>
          <li><strong>Disconnect.</strong> Revoke brokerage access at any time from Settings.</li>
        </ul>
        <p>To exercise any of these rights, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We will respond within 30 days.</p>

        <h2>8. State Privacy Rights</h2>

        <h3>California (CCPA/CPRA)</h3>
        <p>If you are a California resident, you have the right to: (a) know what personal information we collect, use, and disclose; (b) request deletion of your personal information; (c) opt out of the sale or sharing of your personal information (Seli does not sell or share personal information for cross-context behavioral advertising); and (d) not be discriminated against for exercising your privacy rights. To submit a verifiable consumer request, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>

        <h3>Other U.S. States</h3>
        <p>Residents of Colorado, Connecticut, Virginia, Utah, and other states with consumer privacy laws have similar rights to access, correct, delete, and opt out of certain processing of personal data. Contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> to exercise these rights.</p>

        <h2>9. Cookies</h2>
        <p>Seli uses only essential cookies required for authentication. We do not use advertising, analytics, or tracking cookies. Full details are in our <a href="/cookies">Cookie Policy</a>.</p>

        <h2>10. Children's Privacy</h2>
        <p>Seli is not directed at anyone under the age of 18. We do not knowingly collect personal information from anyone under 18. If we learn that we have collected personal information from someone under 18, we will delete it promptly.</p>

        <h2>11. International Users</h2>
        <p>Seli is operated from the United States. If you access Seli from outside the United States, your information will be transferred to and processed in the United States, which may have different data protection standards than your jurisdiction.</p>

        <h2>12. Changes to This Policy</h2>
        <p>We may update this Privacy Policy periodically. Material changes will be communicated by email or a notice within the Service. The "Last updated" date at the top of this page reflects when it was most recently revised.</p>

        <h2>13. Contact</h2>
        <p>SELI LLC<br />Albuquerque, New Mexico<br /><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </div>
          <div className="lp-footer__links">
            <a href="/">Home</a>
            <span>·</span>
            <a href="/terms" className="lp-footer__link-muted">Terms</a>
            <span>·</span>
            <a href="/cookies" className="lp-footer__link-muted">Cookies</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── COOKIE POLICY ────────────────────────────────────────────────────────────
function CookiePage() {
  const [dark, setDark] = useTheme();
  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{ marginLeft: 'auto' }} onClick={() => setDark(d => !d)} title="Toggle theme">
            {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
          </button>
        </div>
      </nav>
      <div className="legal-content">
        <h1>Cookie Policy</h1>
        <p className="legal-date">Last updated: July 22, 2026</p>

        <h2>1. What This Covers</h2>
        <p>The cookies and similar browser-storage technologies (like localStorage) Seli actually uses. Kept short on purpose, since Seli doesn't use advertising or tracking cookies, and never sells data to anyone.</p>

        <h2>2. Essential Cookies</h2>
        <p>Signing in and staying signed in requires a session cookie, set by Seli's authentication provider, Clerk (clerk.com). It's strictly necessary. Without it, Seli can't tell you're signed in, so there's no opt-out for it while still using an account.</p>

        <h2>3. Local Storage (Not a Cookie, But Similar)</h2>
        <p>Seli also uses your browser's localStorage (data that stays on your device, never sent to our servers) for a couple of small preferences: whether you've already seen the welcome guide, and your light/dark theme choice. Clearing your browser's site data resets these to their defaults, and your account itself is untouched.</p>

        <h2>4. What Seli Doesn't Use</h2>
        <p>No advertising cookies. No third-party tracking or analytics cookies. No cross-site tracking. No cookie-based fingerprinting.</p>

        <h2>5. Third-Party Services</h2>
        <p>A few features route through services with their own cookie practices while you're actively using them, such as Stripe during checkout and your brokerage's own site during the SnapTrade connection flow. Seli doesn't control those cookies, and their own policies apply while you're on their pages.</p>

        <h2>6. Your Choices</h2>
        <p>Most browsers let you block or delete cookies in settings. Blocking Clerk's session cookie prevents sign-in entirely, since it's required for authentication, and there's no way around this while still using a Seli account.</p>

        <h2>7. Changes to This Policy</h2>
        <p>We may update this policy if what Seli uses changes. Material changes show up here with an updated date.</p>

        <h2>8. Contact</h2>
        <p>Questions about this Cookie Policy? Contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </div>
          <div className="lp-footer__links">
            <a href="/">Home</a>
            <span>·</span>
            <a href="/privacy" className="lp-footer__link-muted">Privacy Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── HELP CENTER ──────────────────────────────────────────────────────────────
// A real, linkable page, not just a modal, so a support email or footer
// link can point somewhere specific. Every section ends in a live path
// forward (a link to Settings, or to support) rather than leaving the
// reader stuck if the article didn't solve their problem.
const HELP_SECTIONS = [
  {
    id: 'using-seli',
    label: 'Using Seli',
    render: () => (
      <>
        <p>Seli is built around two things: <strong>stocks</strong> and the <strong>people who trade them</strong>. Each has its own page, and every ticker or name anywhere in the app links to it.</p>
        <h3>Search</h3>
        <p>The search box at the top takes a ticker (NVDA), a company (Costco) or a person (Jensen Huang). Press <kbd>/</kbd> or <kbd>Cmd</kbd>+<kbd>K</kbd> from anywhere to jump to it.</p>
        <h3>Stock pages</h3>
        <p>A plain-English summary of what insiders have done lately, a price chart with every insider buy and sale marked on it, who's trading, and the filings themselves with links to the SEC originals.</p>
        <h3>Insider pages</h3>
        <p>Where the person sits, how their past open-market buys have done since (with the number of buys behind every figure), what they still hold, and every trade.</p>
        <h3>Home</h3>
        <p>Activity on what you watch first. Then the week's most notable insider buying, the same story the Sunday email leads with, then other buying, Congress, and the largest sales.</p>
        <h3>Watchlist</h3>
        <p>The stocks and people you watch, plus your brokerage holdings if you've linked one. Each row says what insiders did. Pro accounts get a bell on each row for same-day email alerts.</p>
        <h3>Data and Leaderboard</h3>
        <p><strong>Data</strong> is the full feed: scored signals grouped by stock, or every raw filing, with filters. <strong>Leaderboard</strong> ranks insiders by how their buys have done.</p>
        <h3>Account</h3>
        <p>Your plan, which emails you get, and your linked brokerage.</p>
      </>
    ),
  },
  {
    id: 'glossary',
    label: 'What the numbers mean',
    render: () => (
      <>
        <h3>Open-market trade</h3>
        <p>An insider buying or selling shares at the market price with their own money (SEC codes P and S). Grants, option exercises and shares withheld for taxes aren't decisions to buy or sell, so Seli shows them but leaves them out of summaries and scores.</p>
        <h3>Form 4 and the STOCK Act</h3>
        <p>Company officers, directors and 10% owners file a Form 4 within two business days of a trade, with exact share counts and prices. Members of Congress disclose under the STOCK Act, often weeks later, and only as a dollar range. Seli shows congressional amounts as the range, never a made-up exact figure.</p>
        <h3>Pre-scheduled plan (10b5-1)</h3>
        <p>A trade set up months in advance under a written plan. Marked "Planned" in filings tables. These say less about what the insider thinks today.</p>
        <h3>Cluster</h3>
        <p>Several insiders at one company buying within a few weeks. Rarer than a single buy, which is why Seli points them out.</p>
        <h3>Stake change</h3>
        <p>Shares bought compared with what the insider already held. A $200K buy that doubles someone's stake reads differently from one that adds 1%.</p>
        <h3>Conviction score (0 to 100)</h3>
        <p>Seli's one score, on buys only. It adds up how many markers of a meaningful insider buy a stock has: senior insiders, open-market, not pre-scheduled, size, stake change, and several insiders at once.</p>
        <p><strong>60 and up: High.</strong> Several strong markers at once. <strong>35 to 59: Medium.</strong> Clears a few markers. <strong>Under 35: Low.</strong> Small, routine-looking, or from further down the org chart. Sales aren't scored: insiders sell for too many unrelated reasons.</p>
        <h3>Hit rate</h3>
        <p>On insider pages and the leaderboard: the share of someone's open-market buys where the stock is now at least 5% higher than their buy price. Buys within 5% either way count as flat and are left out. The number of buys it's based on is always shown next to it.</p>
        <h3>Avg since buy vs. S&amp;P 500</h3>
        <p>The average move from each buy price to the latest close, next to what the S&amp;P 500 did over the same periods. It's context, not a prediction.</p>
      </>
    ),
  },
  {
    id: 'faq',
    label: 'FAQ',
    render: () => (
      <>
        <h3>Where does the data come from?</h3>
        <p>Every trade comes from a public government filing: SEC Form 4 for corporate insiders, and STOCK Act periodic transaction reports for Congress. Nothing is scraped from rumors or licensed from a third party.</p>
        <h3>How current is it?</h3>
        <p>Seli checks for new filings throughout the trading day. A disclosure typically appears within minutes of becoming public. The date at the top of the app shows the newest filing Seli has.</p>
        <h3>Is this financial advice?</h3>
        <p>No. Seli is informational and educational only. Every summary, score and alert is generated the same way for every user. Nothing is personalized to your holdings, goals or risk tolerance, even when you choose which stocks to watch. Nothing here is a recommendation to buy, sell or hold anything. See the <a href="/terms">Terms of Service</a> for the full disclaimer.</p>
        <h3>Can Seli place trades for me?</h3>
        <p>No. Brokerage connections are read-only.</p>
        <h3>Still have a question?</h3>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Real questions from real users are exactly what shapes this page and the product.</p>
      </>
    ),
  },
  {
    id: 'billing',
    label: 'Plans and billing',
    render: () => (
      <>
        <h3>What's free?</h3>
        <p>Every stock page and every insider page, with the last 12 months of trades (track records and summaries use full history). Watch up to 3 stocks or people, and get the Sunday digest about them.</p>
        <h3>What does Pro add?</h3>
        <p>Full trade history, unlimited watching, a daily digest, same-day email alerts, linking your brokerage, the full leaderboard, for {PRO_PRICE_DISPLAY} per month.</p>
        <h3>What's the Full Data Export?</h3>
        <p>A separate, one-time $39.99 purchase: the complete database as a spreadsheet, independent of Pro. If you need it again later, use <a href="/redownload">seli.app/redownload</a> at no extra charge.</p>
        <h3>How do I cancel Pro?</h3>
        <p>Account, Plan and billing, Cancel subscription. You keep access through the end of the period you paid for, and can reactivate anytime.</p>
        <h3>Billing questions we didn't cover?</h3>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your account email.</p>
      </>
    ),
  },
  {
    id: 'alerts',
    label: 'Emails and alerts',
    render: () => (
      <>
        <p>What you watch decides what's in your emails. Which emails you get is set in Account, Emails.</p>
        <h3>Weekly digest (everyone)</h3>
        <p>Sunday evening: what insiders did with every stock and person you watch (quiet weeks included), plus the week's most notable insider buying.</p>
        <h3>Daily digest (Pro)</h3>
        <p>Weekday mornings, only when something you watch had a filing.</p>
        <h3>Same-day alerts (Pro)</h3>
        <p>An email the day a new filing lands for something you watch. Turn them on in Account, then mute individual stocks or people with the bell on your Watchlist. Two optional extras: big C-suite buys on any stock, and an insider switching from selling to buying on a stock you watch.</p>
        <h3>Not getting an email you expect?</h3>
        <p>Check Account, Emails, and use Send test email there. Still missing? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      </>
    ),
  },
  {
    id: 'portfolio',
    label: 'Linked brokerage',
    render: () => (
      <>
        <h3>How does linking work?</h3>
        <p>Through SnapTrade, a third-party connection service. Seli never sees your brokerage login. Access is read-only: positions only, never trading.</p>
        <h3>What does it do?</h3>
        <p>Your holdings show up on Home and your Watchlist marked "You hold this", and in your digests.</p>
        <h3>Can I disconnect?</h3>
        <p>Anytime, from Account. The stored connection is removed immediately.</p>
      </>
    ),
  },
];

// ── Public CSV Data Download page ─────────────────────────────────────────
// SEO-optimized public page for the $39.99 one-time data export.
// No auth required to view — purchase CTA opens the sign-in modal for
// unauthenticated visitors, or navigates to Settings > Billing for
// signed-in users.
function DataDownloadPage() {
  const [dark, setDark] = useTheme();

  const SAMPLE_ROWS = [
    { date: '2026-07-28', ticker: 'AAPL', company: 'Apple Inc.', insider: 'WILLIAMS JEFFREY E', title: 'General Counsel', type: 'Buy', shares: '10,500', price: '$198.42', value: '$2.1M', pct: '+12.3%', role: 'Executive', routine: 'No' },
    { date: '2026-07-25', ticker: 'NVDA', company: 'NVIDIA Corp', insider: 'HUANG JEN HSUN', title: 'CEO', type: 'Buy', shares: '50,000', price: '$112.80', value: '$5.6M', pct: '+3.1%', role: 'Executive', routine: 'No' },
    { date: '2026-07-24', ticker: 'JPM', company: 'JPMorgan Chase', insider: 'DIMON JAMES', title: 'CEO', type: 'Buy', shares: '25,000', price: '$221.35', value: '$5.5M', pct: '+1.8%', role: 'Executive', routine: 'Yes' },
    { date: '2026-07-22', ticker: 'MSFT', company: 'Microsoft Corp', insider: 'NADELLA SATYA', title: 'CEO', type: 'Sell', shares: '8,000', price: '$438.90', value: '$3.5M', pct: '-0.4%', role: 'Executive', routine: 'Yes' },
    { date: '2026-07-20', ticker: 'TSLA', company: 'Tesla, Inc.', insider: 'TANEJA VAIBHAV', title: 'CFO', type: 'Buy', shares: '5,000', price: '$248.15', value: '$1.2M', pct: '+8.7%', role: 'Executive', routine: 'No' },
  ];

  const COLUMNS = [
    { name: 'transaction_date', desc: 'Date the trade occurred' },
    { name: 'filing_date', desc: 'Date the SEC filing was published' },
    { name: 'ticker', desc: 'Stock ticker symbol' },
    { name: 'company_name', desc: 'Full company name' },
    { name: 'insider_name', desc: 'Reporting insider' },
    { name: 'insider_title', desc: 'Title or role at the company' },
    { name: 'transaction_type', desc: 'Buy or Sell' },
    { name: 'transaction_code', desc: 'SEC code (P = purchase, S = sale)' },
    { name: 'is_open_market', desc: 'Voluntary open-market trade' },
    { name: 'shares', desc: 'Shares traded' },
    { name: 'price_per_share', desc: 'Price at time of trade' },
    { name: 'value', desc: 'Total dollar value' },
    { name: 'shares_owned_after', desc: 'Holdings after the trade' },
    { name: 'pct_owned_change', desc: 'Position change (%)' },
    { name: 'relationship', desc: 'Executive, Officer, or Director' },
    { name: 'is_routine', desc: 'Routine pattern flag (Cohen et al. 2012)' },
    { name: 'sector', desc: 'Sector classification' },
    { name: 'accession_number', desc: 'SEC EDGAR accession number for source verification' },
  ];

  const [checkoutLoading, setCheckoutLoading] = useState(false);

  function handleBuy() {
    setCheckoutLoading(true);
    fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/checkout/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(r => r.json())
      .then(d => {
        if (d.url) window.location.href = d.url;
        else { alert('Could not start checkout. Please try again.'); setCheckoutLoading(false); }
      })
      .catch(() => { alert('Could not start checkout. Please try again.'); setCheckoutLoading(false); });
  }

  const buyCTA = (
    <div style={{ textAlign: 'center' }}>
      <button className="lp-btn-primary lp-btn-primary--lg" onClick={handleBuy} disabled={checkoutLoading}>
        {checkoutLoading ? 'Loading checkout...' : 'Buy now — $39.99'}
      </button>
    </div>
  );

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
            <a href="/about" className="lp-nav__link">About</a>
            <button className="lp-btn-ghost lp-btn-ghost--icon" onClick={() => setDark(d => !d)} title="Toggle theme">
              {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
            </button>
          </div>
        </div>
      </nav>
      <div className="legal-content" style={{ maxWidth: 960 }}>

        <div className="lp-info__eyebrow">Insider Trading Data Export</div>
        <h1 style={{ fontSize: 'clamp(1.375rem, 5vw, 2.25rem)', fontWeight: 800, letterSpacing: '-1px', lineHeight: 1.1, marginBottom: 20 }}>Download 10+ Years of SEC Insider Trading Data</h1>
        <p style={{ fontSize: '0.9375rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 8 }}>
          The same insider trading data that powers Bloomberg terminals and institutional research desks — structured, clean, and
          a fraction of the cost. Every open-market SEC Form 4 filing from corporate executives, directors, and 10% owners,
          with routine-trade flags for separating signal from noise. One-time purchase, yours forever.
        </p>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginBottom: 12 }}>
          Compressed ZIP · one CSV per calendar year · {COLUMNS.length} fields per transaction · Excel, Python, R, or any tool that reads CSV
        </p>
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 28 }}>
          Researchers, quants, and serious investors use insider trading data to build models, screen for
          investment ideas, and backtest strategies. Academic studies show insider purchases outperform the
          market by 4–5% annually. This is the raw data behind those findings — ready for your own analysis.
          Congressional disclosures are available for free within the app but are not included in the data export.
        </p>

        {buyCTA}

        <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', textAlign: 'center', marginTop: 10, marginBottom: 0 }}>
          Checkout powered by Stripe. No account required.
        </p>

        <hr style={{ border: 'none', borderTop: '0.5px solid var(--border)', margin: '40px 0' }} />

        <section className="lp-info__section">
          <h2>Sample data</h2>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', margin: '12px 0', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', minWidth: 420 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Date', 'Ticker', 'Insider', 'Type', 'Value', 'Role'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: '0.6875rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SAMPLE_ROWS.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--accent-strong)', whiteSpace: 'nowrap' }}>{r.ticker}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.insider}</td>
                    <td style={{ padding: '8px 10px' }}><span style={{ color: r.type === 'Buy' ? 'var(--green-600)' : 'var(--red-600)', fontWeight: 600 }}>{r.type}</span></td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.value}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', fontStyle: 'italic' }}>
            Representative sample showing 6 of {COLUMNS.length} fields. Actual export contains all columns listed below.
          </p>
        </section>

        <section className="lp-info__section">
          <h2>Column schema ({COLUMNS.length} fields)</h2>
          <div style={{ overflowX: 'auto', margin: '12px 0', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <table className="legal-table" style={{ margin: 0 }}>
              <thead>
                <tr><th style={{ width: 200 }}>Column</th><th>Description</th></tr>
              </thead>
              <tbody>
                {COLUMNS.map(c => (
                  <tr key={c.name}>
                    <td><code style={{ fontSize: '0.75rem', background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 3 }}>{c.name}</code></td>
                    <td>{c.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lp-info__section">
          <h2>Use cases</h2>
          <ul className="lp-info__principles">
            <li><strong>Backtest insider trading signals.</strong> Filter to open-market executive
              purchases and measure forward returns across holding periods.</li>
            <li><strong>Academic research.</strong> Over a decade of Form 4 insider filings with
              consistent parsing, ready for statistical analysis.</li>
            <li><strong>Sector analysis.</strong> Aggregate insider buying and selling patterns by
              sector, time period, or insider role.</li>
            <li><strong>Congressional trading.</strong> STOCK Act disclosures in the same schema as
              corporate filings for direct comparison.</li>
            <li><strong>Build your own models.</strong> The raw data behind Seli's scoring, available
              for your own methodology.</li>
          </ul>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>
            Raw EDGAR XML is free but requires heavy parsing. Commercial insider data APIs run
            $200-500+/month. This is a one-time $39.99 purchase with no recurring fee.
          </p>
        </section>

        <section style={{ textAlign: 'center', padding: '40px 0', borderTop: '0.5px solid var(--border)', marginTop: 24 }}>
          {buyCTA}
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginTop: 16, marginBottom: 20 }}>
            One-time purchase. No subscription. Re-download anytime from your account.
          </p>
          <a href="/" style={{ fontSize: '0.875rem', color: 'var(--accent-strong)', textDecoration: 'none', fontWeight: 500 }}>
            Or explore Seli free — real-time signals, scoring, and alerts →
          </a>
        </section>

      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </div>
          <div className="lp-footer__links">
            <a href="/">Home</a>
            <span>·</span>
            <a href="/about" className="lp-footer__link-muted">About</a>
            <span>·</span>
            <a href="/terms" className="lp-footer__link-muted">Terms</a>
            <span>·</span>
            <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
// ── Purchase Complete page ─────────────────────────────────────────────────
// Shown after Stripe Checkout redirect. Verifies payment, shows download
// button, and displays the order ID for re-download reference.
function PurchaseCompletePage() {
  const [dark, setDark] = useTheme();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [orderInfo, setOrderInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) { setStatus('error'); return; }

    // Verify the session and get order info
    fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/checkout/csv-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, info_only: true }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setStatus('error'); return; }
        setOrderInfo({ sessionId, orderId: d.order_id, email: d.email, date: d.purchase_date });
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, []);

  function handleDownload() {
    setDownloading(true);
    const params = new URLSearchParams(window.location.search);
    fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/checkout/csv-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: params.get('session_id') }),
    })
      .then(r => {
        if (!r.ok) throw new Error('Download failed');
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `seli_insider_trades_${orderInfo?.date || 'export'}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setDownloading(false);
      })
      .catch(() => { setDownloading(false); setStatus('error'); });
  }

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
          </a>
        </div>
      </nav>
      <div className="legal-content" style={{ maxWidth: 600, textAlign: 'center', paddingTop: 60 }}>
        {status === 'loading' && (
          <>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 12 }}>Verifying your purchase...</div>
            <SkeletonRows count={3} />
          </>
        )}
        {status === 'ready' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Payment confirmed</div>
            <p style={{ color: 'var(--text-2)', marginBottom: 24 }}>
              Your insider trading dataset is ready to download.
            </p>
            <button
              className="lp-btn-primary lp-btn-primary--lg"
              onClick={handleDownload}
              disabled={downloading}
              style={{ marginBottom: 24 }}
            >
              {downloading ? 'Preparing download...' : 'Download dataset (.zip)'}
            </button>

            <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '20px 24px', textAlign: 'left', marginBottom: 24 }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-3)', marginBottom: 12 }}>Order details — save this</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: '0.875rem' }}>
                <span style={{ color: 'var(--text-3)' }}>Order ID</span>
                <span style={{ fontFamily: 'monospace', fontSize: '0.8125rem', wordBreak: 'break-all' }}>{orderInfo?.orderId || '—'}</span>
                <span style={{ color: 'var(--text-3)' }}>Email</span>
                <span>{orderInfo?.email || '—'}</span>
                <span style={{ color: 'var(--text-3)' }}>Data through</span>
                <span>{orderInfo?.date || '—'}</span>
              </div>
            </div>

            <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', lineHeight: 1.6 }}>
              Need to re-download later? Go to <a href="/redownload" style={{ color: 'var(--accent-strong)' }}>seli.app/redownload</a> and
              enter your Order ID and email. A receipt has been sent to your email by Stripe.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>×</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Something went wrong</div>
            <p style={{ color: 'var(--text-2)', marginBottom: 24 }}>
              We couldn't verify your purchase. If you were charged, your payment is safe.
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-3)', marginBottom: 24 }}>
              Contact <a href="mailto:admin@seli.app" style={{ color: 'var(--accent-strong)' }}>admin@seli.app</a> with
              your Stripe receipt and we'll get your download sorted.
            </p>
            <a href="/data-download" className="lp-btn-primary">Back to Data Export</a>
          </>
        )}
      </div>
    </div>
  );
}

// ── Re-download page ──────────────────────────────────────────────────────
function RedownloadPage() {
  const [dark, setDark] = useTheme();
  const { isSignedIn, getToken } = useAuth();
  const [orderId, setOrderId] = useState('');
  const [email, setEmail] = useState('');
  const [lookupStatus, setLookupStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [activeTab, setActiveTab] = useState(isSignedIn ? 'history' : 'lookup');

  useEffect(() => {
    if (!isSignedIn) { setHistory([]); return; }
    setActiveTab('history');
    (async () => {
      try {
        const token = await getToken();
        const r = await fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/billing/status', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const d = await r.json();
        // API returns dataExports, not purchases
        setHistory(d.dataExports || []);
      } catch (e) { setHistoryError(e.message); setHistory([]); }
    })();
  }, [isSignedIn]);

  async function downloadBlob(fetchPromise, filename) {
    setDownloadProgress({ label: 'Preparing download...', pct: 0 });
    setErrorMsg('');
    try {
      const r = await fetchPromise;
      if (!r.ok) {
        // Try to parse a JSON error body — but the response might be HTML
        // (e.g. a 404 page) or empty, so fall back gracefully.
        let msg = `Server returned ${r.status}`;
        try {
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('json')) {
            const d = await r.json();
            if (d.error) msg = d.error;
          }
        } catch { }
        throw new Error(msg);
      }
      const total = parseInt(r.headers.get('content-length') || '0', 10);
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const recMB = (received / 1_048_576).toFixed(1);
        const pct = total > 0 ? Math.round((received / total) * 100) : null;
        setDownloadProgress({
          label: total > 0
            ? `Downloading… ${recMB}MB / ${(total / 1_048_576).toFixed(1)}MB`
            : `Downloading… ${recMB}MB`,
          pct,
        });
      }
      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadProgress({ label: 'Download complete', pct: 100 });
      setTimeout(() => setDownloadProgress(null), 3000);
    } catch (e) {
      setDownloadProgress(null);
      setErrorMsg(e.message || 'Download failed — try again in a moment.');
      setLookupStatus('error');
    }
  }

  function handleRedownload(purchase) {
    (async () => {
      const token = await getToken();
      await downloadBlob(
        fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/export/csv', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'redownload', purchaseId: purchase.stripe_payment_intent_id }),
        }),
        `seli_insider_trades_${purchase.purchased_at?.split('T')[0] || 'export'}.zip`
      );
    })();
  }

  function handleLookup(e) {
    e.preventDefault();
    if (!orderId.trim() || !email.trim()) return;
    setLookupStatus('loading');
    setErrorMsg('');
    downloadBlob(
      fetch(cfg.NEON_PROXY_URL.replace(/\/+$/, '') + '/checkout/csv-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId.trim(), email: email.trim() }),
      }),
      'seli_insider_trades_export.zip'
    ).then(() => setLookupStatus('idle'));
  }

  const tabStyle = (active) => ({
    padding: '10px 20px', fontSize: '0.875rem', fontWeight: active ? 600 : 400,
    color: active ? 'var(--accent-strong)' : 'var(--text-3)',
    background: 'none', border: 'none',
    borderBottom: active ? '2px solid var(--accent-strong)' : '2px solid transparent',
    cursor: 'pointer', fontFamily: 'var(--font)',
  });

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
            <a href="/help" className="lp-nav__link">Help</a>
            <a href="/data-download" className="lp-nav__link">Buy data</a>
          </div>
        </div>
      </nav>
      <div className="legal-content" style={{ maxWidth: 560, paddingTop: 48 }}>

        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>Download your data export</h1>
        <p style={{ color: 'var(--text-2)', marginBottom: 24, fontSize: '0.9375rem' }}>
          Already purchased? Re-download your dataset below.
        </p>

        {downloadProgress && (
          <div style={{ marginBottom: 24, padding: '16px 20px', background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 8 }}>
            <div style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: 8 }}>{downloadProgress.label}</div>
            <div style={{ width: '100%', height: 6, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                width: downloadProgress.pct != null ? `${downloadProgress.pct}%` : '60%',
                height: '100%', background: 'var(--accent-strong)', borderRadius: 3,
                transition: 'width 0.3s ease',
                animation: downloadProgress.pct == null ? 'skel-fade 1s ease-in-out infinite alternate' : 'none',
              }} />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setActiveTab('history')} style={tabStyle(activeTab === 'history')}>My purchases</button>
          <button onClick={() => setActiveTab('lookup')} style={tabStyle(activeTab === 'lookup')}>Look up an order</button>
        </div>

        {/* Fixed-height tab content area prevents width/height jumping */}
        <div style={{ minHeight: 260 }}>

          {activeTab === 'history' && (
            <section>
              {!isSignedIn ? (
                <div style={{ textAlign: 'center', padding: '32px 0' }}>
                  <p style={{ color: 'var(--text-2)', marginBottom: 16, fontSize: '0.9375rem' }}>
                    Sign in to see purchases linked to your account.
                  </p>
                  <SignInButton mode="modal" afterSignInUrl="/redownload">
                    <button className="lp-btn-primary">Sign in</button>
                  </SignInButton>
                </div>
              ) : history === null ? (
                <SkeletonRows count={3} />
              ) : history.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 0' }}>
                  <p style={{ color: 'var(--text-3)', fontSize: '0.9375rem', marginBottom: 16 }}>
                    {historyError ? 'Could not load purchase history.' : 'No data export purchases on this account.'}
                  </p>
                  <a href="/data-download" style={{ color: 'var(--accent-strong)', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}>
                    Purchase the dataset →
                  </a>
                </div>
              ) : (
                <div style={{ border: '0.5px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  {history.map((p, i) => {
                    const dateStr = p.purchased_at ? p.purchased_at.slice(0, 10) : null;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: i < history.length - 1 ? '0.5px solid var(--border)' : 'none' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>Insider Trading Dataset</div>
                          <div style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginTop: 2 }}>
                            {dateStr ? fmt.date(dateStr) : '—'} · ${(p.amount_cents / 100).toFixed(2)}
                            {p.downloaded_at ? ' · downloaded' : ''}
                          </div>
                        </div>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={() => handleRedownload(p)}
                          disabled={downloadProgress != null}
                        >Re-download</button>
                      </div>
                    );
                  })}
                </div>
              )}
              {isSignedIn && history && history.length > 0 && errorMsg && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--red-600)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, marginTop: 12 }}>
                  {errorMsg}
                </div>
              )}
              {isSignedIn && history && history.length > 0 && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginTop: 12 }}>
                  Each re-download delivers the latest available data.
                </p>
              )}
            </section>
          )}

          {activeTab === 'lookup' && (
            <section>
              <p style={{ color: 'var(--text-2)', marginBottom: 20, fontSize: '0.875rem' }}>
                Enter the Order ID and email from your Stripe receipt to re-download.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Order ID</label>
                  <input type="text" value={orderId} onChange={e => setOrderId(e.target.value)}
                    placeholder="pi_3Nk8..."
                    style={{ width: '100%', padding: '10px 12px', fontSize: '0.875rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontFamily: 'monospace', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Email used at checkout</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    style={{ width: '100%', padding: '10px 12px', fontSize: '0.875rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', boxSizing: 'border-box' }}
                  />
                </div>
                <button className="lp-btn-primary" onClick={handleLookup}
                  disabled={lookupStatus === 'loading' || !orderId.trim() || !email.trim() || downloadProgress != null}
                  style={{ width: '100%', padding: '12px' }}
                >{lookupStatus === 'loading' ? 'Verifying...' : 'Download'}</button>
                {lookupStatus === 'error' && (
                  <div style={{ fontSize: '0.8125rem', color: 'var(--red-600)', padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>
                    {errorMsg || 'Could not verify this order. Double-check your Order ID and email.'}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginTop: 28, lineHeight: 1.6, textAlign: 'center' }}>
          Need help? Contact <a href="mailto:admin@seli.app" style={{ color: 'var(--accent-strong)' }}>admin@seli.app</a>
        </p>
      </div>
    </div>
  );
}

function HelpCenterPage() {
  const [activeId, setActiveId] = useState(() => {
    const h = window.location.hash.slice(1);
    return HELP_SECTIONS.some(x => x.id === h) ? h : 'using-seli';
  });
  const idx = HELP_SECTIONS.findIndex(s => s.id === activeId);
  const section = HELP_SECTIONS[idx] ?? HELP_SECTIONS[0];
  const [dark, setDark] = useTheme();

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{ marginLeft: 'auto' }} onClick={() => setDark(d => !d)} title="Toggle theme">
            {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
          </button>
        </div>
      </nav>
      <div className="legal-content help-center">
        <h1>Help Center</h1>
        <div className="help-center__body">
          <nav className="help-center__nav" aria-label="Help topics">
            {HELP_SECTIONS.map(s => (
              <button
                key={s.id}
                className={`help-center__nav-item ${s.id === activeId ? 'help-center__nav-item--active' : ''}`}
                onClick={() => { setActiveId(s.id); window.history.replaceState({}, '', `/help#${s.id}`); }}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="help-center__content">
            {section.render()}
          </div>
        </div>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </div>
          <div className="lp-footer__links">
            <a href="/">Home</a>
            <span>·</span>
            <a href="/terms" className="lp-footer__link-muted">Terms</a>
            <span>·</span>
            <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
            <span>·</span>
            <a href="/cookies" className="lp-footer__link-muted">Cookies</a>
          </div>
        </div>
      </footer>
    </div>
  );
}


// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
// Three sections: Account (Clerk), Notifications, Connected accounts
// Notifications prefs saved to Neon user_preferences table via Worker
// Connected accounts: placeholder for Alpaca OAuth (Phase 2)

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

// Default prefs — matches expanded Neon schema
const DEFAULT_PREFS = {
  // Digests
  daily_digest: false,
  weekly_digest: false,
  digest_top_signals: true,
  digest_congressional: true,
  digest_corporate: true,
  digest_watchlist_only: false,
  digest_min_conviction: 'any',
  digest_max_signals: 10,
  digest_min_value: 0,
  // Instant alerts
  instant_watchlist_ticker: false,
  instant_followed_insider: false,
  instant_high_conviction: false,
  instant_reversal: false,
  instant_large_trade: false,
  instant_min_value: 0,
  instant_high_conviction_threshold: 1000000,
  // Preferences
  csuite_only: false,
};

// ── Blog ──────────────────────────────────────────────────────────────────────
const BLOG_ARTICLES = [
  { slug: 'what-is-insider-trading-signal', tag: 'Fundamentals', tagColor: null,
    title: 'What is an insider trading signal — and why do they outperform?',
    desc: 'SEC Form 4 filings reveal when corporate officers, directors, and 10% owners trade their company\'s stock. Academic research consistently shows these trades outperform the market by 4–5% annually. Here\'s what drives the edge, how conviction scoring separates noise from signal, and what retail investors should actually do with the data.',
    read: '12 min read', date: 'Updated Sep 2026', featured: true },
  { slug: 'conviction-scoring-explained', tag: 'How Seli works', tagColor: null,
    title: 'How conviction scoring ranks insider trades',
    desc: 'Not every insider trade matters. A CEO buying $2M of their own stock on the open market is a fundamentally different signal than a director exercising options. Seli\'s scoring system weighs who traded, how much, whether multiple insiders are buying, and historical accuracy to surface the trades with real predictive power.',
    read: '8 min read', date: 'Sep 2026' },
  { slug: 'congressional-trading-stock-act', tag: 'Congressional trades', tagColor: 'green',
    title: 'Congressional stock trading: what the STOCK Act disclosures actually tell you',
    desc: 'Members of Congress are required to disclose their stock trades within 45 days. Some do it in 2. Seli tracks every STOCK Act filing alongside corporate insider trades, scored with the same conviction system. Here\'s how to read them, what the reporting lag means, and which members trade most actively.',
    read: '10 min read', date: 'Sep 2026' },
  { slug: 'cluster-buying-explained', tag: 'Strategy', tagColor: null,
    title: 'Cluster buying: when multiple insiders buy the same stock',
    desc: 'A single insider buying is a data point. Three insiders buying the same stock in the same week is a pattern. Cluster buying events have historically preceded significant price moves. We break down what qualifies as a cluster, how to spot them in real time, and what the historical data says about their hit rate.',
    read: '7 min read', date: 'Sep 2026' },
  { slug: 'sec-form-4-guide', tag: 'Reference', tagColor: null,
    title: 'How to read an SEC Form 4 filing',
    desc: 'Every insider trade filed with the SEC follows the same format — but reading raw EDGAR filings is tedious. This is a field guide to Form 4: what each section means, the difference between transaction codes, and how to distinguish open-market purchases from option exercises.',
    read: '6 min read', date: 'Sep 2026' },
  { slug: 'insider-selling-vs-buying', tag: 'Analysis', tagColor: 'red',
    title: 'Why insider selling is usually noise — and when it isn\'t',
    desc: 'Insiders sell for dozens of reasons: tax planning, diversification, estate liquidity. Most selling is financially meaningless. But some patterns — unusual volume, first-time sellers, sales after quiet periods — do carry signal. Here\'s how to tell the difference.',
    read: '9 min read', date: 'Sep 2026' },
  { slug: 'portfolio-alerts-insider-activity', tag: 'Product', tagColor: null,
    title: 'Get alerted when insiders trade stocks in your portfolio',
    desc: 'Seli Pro lets you connect your brokerage and get instant email alerts when any corporate insider or member of Congress trades a stock you hold. No more checking EDGAR manually. Here\'s how to set it up and what the alerts contain.',
    read: '4 min read', date: 'Sep 2026' },
  { slug: 'form-4-dataset-csv', tag: 'Data', tagColor: null,
    title: 'The complete SEC Form 4 dataset: 10+ years, every insider trade, one download',
    desc: 'Seli\'s CSV export contains every corporate insider trade and congressional stock disclosure from 2010 to present. 18 fields per transaction, split by year, linked to the original EDGAR filing. Built for quant researchers, data journalists, and anyone who needs the raw data.',
    read: '5 min read', date: 'Sep 2026' },
];

function BlogPage({ dark, setDark }) {
  useEffect(() => {
    document.title = 'Seli Blog — Insider Trading Intelligence, SEC Form 4 Analysis & Market Signals';
  }, []);

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a href="/" className="lp-nav__logo">
            <img src="/favicon.png" alt="Seli" className="lp-logo-mark lp-logo-mark--sm" />
            <span className="lp-wordmark">Seli</span>
          </a>
          <div className="lp-nav__links">
            <a href="/" className="lp-nav__link">App</a>
            <a href="/data-download" className="lp-nav__link">Data</a>
            <a href="/blog" className="lp-nav__link" style={{ color: 'var(--accent-strong)' }}>Blog</a>
          </div>
          <div className="lp-nav__actions">
            <button className="lp-btn-ghost lp-btn-ghost--icon" onClick={() => setDark(d => !d)} title={dark ? 'Light mode' : 'Dark mode'}>
              {dark ? <IconSun style={{ width: 14, height: 14 }} /> : <IconMoon style={{ width: 14, height: 14 }} />}
            </button>
            <a href="/" className="lp-btn-primary" style={{ textDecoration: 'none' }}>Try free</a>
          </div>
        </div>
      </nav>

      <div className="blog-page">
        <div className="blog-hero">
          <h1>Insider trading intelligence, demystified</h1>
          <p>Research, analysis, and strategy for tracking what corporate insiders and members of Congress are buying and selling — and why it matters for your portfolio.</p>
        </div>

        <div className="blog-articles">
          {BLOG_ARTICLES.map((a, i) => (
            <a key={a.slug} href={`/blog/${a.slug}`} className={`blog-card${a.featured ? ' blog-card--featured' : ''}`}>
              <span className={`blog-card__tag${a.tagColor === 'green' ? ' blog-card__tag--green' : a.tagColor === 'red' ? ' blog-card__tag--red' : ''}`}>{a.tag}</span>
              <h2>{a.title}</h2>
              <p>{a.desc}</p>
              <div className="blog-card__meta">
                <span>{a.read}</span>
                <span className="blog-card__dot" />
                <span>{a.date}</span>
              </div>
            </a>
          ))}
        </div>

        <div className="blog-cta">
          <div className="blog-cta__inner">
            <h3>See what insiders are buying before the market reacts</h3>
            <p>Real-time SEC Form 4 signals scored by conviction. Watchlists, alerts, congressional trades, and full data export.</p>
            <a href="/" className="blog-cta__btn">Start free — no credit card</a>
            <div className="blog-cta__note">Pro unlocks full history, instant alerts, and portfolio linking for $6.99/mo</div>
          </div>
        </div>
      </div>

      <footer className="lp-footer">
        <div className="lp-footer__frame">
          <div className="lp-footer__logo">
            <img src="/favicon.png" alt="Seli" className="lp-logo-mark lp-logo-mark--sm" />
            <span className="lp-wordmark">Seli</span>
          </div>
          <div className="lp-footer__links">
            <span>© 2026 Seli</span>
            <a href="/terms" className="lp-footer__link-muted">Terms</a>
            <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
            <a href="/help" className="lp-footer__link-muted">Help</a>
            <span className="lp-footer__link-muted">Private Beta · Not financial advice.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function useNotificationPrefs(userId, pro) {
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!userId) return;
    // Try localStorage first for instant load — avoids a blank flash while
    // the real network request is in flight.
    const cached = localStorage.getItem(`seli_prefs_${userId}`);
    if (cached) { try { setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(cached) }); } catch { } }
    // Free users load too: they need the real weekly_digest value. GET /prefs
    // was never Pro-gated server-side, only this early return was.
    if (!cfg.NEON_PROXY_URL) { setPrefs(p => p || { ...DEFAULT_PREFS }); return; }

    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs`, { headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load preferences');
        const p = data.prefs ? { ...DEFAULT_PREFS, ...data.prefs } : { ...DEFAULT_PREFS };
        setPrefs(p);
        localStorage.setItem(`seli_prefs_${userId}`, JSON.stringify(p));
      } catch {
        setPrefs(p => p || { ...DEFAULT_PREFS });
      }
    })();
  }, [userId, pro]);

  async function save(updated) {
    if (!userId) return;
    setSaving(true); setError(null);
    try {
      localStorage.setItem(`seli_prefs_${userId}`, JSON.stringify(updated));
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs`, {
        method: 'POST', headers, body: JSON.stringify(updated),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setPrefs(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e.message || 'Save failed — try again');
      setSaving(false);
      throw e;
    }
    setSaving(false);
  }

  // For saves that bypass save() (the free weekly toggle): update the
  // last-saved baseline so the page doesn't think there's an unsaved change.
  function markSaved(partial) {
    setPrefs(p => {
      const next = { ...DEFAULT_PREFS, ...(p || {}), ...partial };
      try { localStorage.setItem(`seli_prefs_${userId}`, JSON.stringify(next)); } catch { }
      return next;
    });
  }

  return { prefs, saving, saved, error, save, markSaved };
}


function useSnapTrade(pro) {
  const [status, setStatus] = useState(null);       // null=loading, {connection:null|{...}}
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const refreshStatus = useCallback(async () => {
    if (!pro || !cfg.NEON_PROXY_URL) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/status`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load connection status');
      setStatus(data);
    } catch (e) {
      setError(e.message);
    }
  }, [pro]);

  // On mount: if we just returned from SnapTrade's redirect, confirm the
  // connection first (flips status from 'pending' to 'active' on the worker)
  // then check status. Without this, the row stays 'pending' and every
  // downstream query filtering by status='active' returns nothing.
  // SnapTrade redirects back with ?connection_id=... (their own param),
  // ignoring the query string on customRedirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isSnapTradeReturn = params.has('connection_id') || params.get('snaptrade');
    if (isSnapTradeReturn && pro && cfg.NEON_PROXY_URL) {
      (async () => {
        try {
          const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
          await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/confirm`, { method: 'POST', headers, body: JSON.stringify({}) });
        } catch (e) {
          console.error('[useSnapTrade] confirm failed:', e.message);
        }
        // Clean SnapTrade params from the URL so a page refresh doesn't re-confirm
        const url = new URL(window.location);
        url.searchParams.delete('snaptrade');
        url.searchParams.delete('status');
        url.searchParams.delete('connection_id');
        window.history.replaceState({}, '', url.pathname + (url.search || ''));
        await refreshStatus();
      })();
    } else {
      refreshStatus();
    }
  }, [refreshStatus, pro]);

  async function connect() {
    setConnecting(true); setError(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/connect`, {
        method: 'POST', headers, body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connect failed');
      window.location.href = data.redirectURI; // hand off to SnapTrade's hosted portal
    } catch (e) {
      setError(e.message);
      setConnecting(false);
    }
  }

  async function disconnect() {
    setError(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/disconnect`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Disconnect failed');
      await refreshStatus();
    } catch (e) {
      setError(e.message);
    }
  }

  return { status, connecting, error, connect, disconnect };
}

// ─── ACCOUNT ──────────────────────────────────────────────────────────────────
// Everything about you on one page: plan, emails, linked brokerage,
// appearance, help. Per-stock/per-person alerts live on the Watchlist (the
// bell on each row); this page only has the account-wide switches.
// Settings save as you change them. No save button to forget.
function SxToggle({ checked, onChange, disabled, label }) {
  return (
    <label className="sx-toggle" aria-label={label}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span />
    </label>
  );
}
function SxSetting({ label, sub, pro, locked, nested, children }) {
  return (
    <div className={`sx-set${nested ? ' sx-set--nested' : ''}`}>
      <div>
        <div className="sx-set__label">{label}{pro && locked && <span className="sx-pro">Pro</span>}</div>
        {sub && <div className="sx-set__sub">{sub}</div>}
      </div>
      <div className="sx-set__ctl">{children}</div>
    </div>
  );
}

function AccountPage({ user, onUpgrade, dark, setDark }) {
  const { pro } = useBilling();
  const { prefs, save, markSaved } = useNotificationPrefs(user?.id, pro);
  const snaptrade = useSnapTrade(pro);
  const [local, setLocal] = useState(null);
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | error text
  const [testState, setTestState] = useState(null);
  useEffect(() => { if (prefs) setLocal({ ...DEFAULT_PREFS, ...prefs }); }, [prefs]);

  // Old links (emails, SnapTrade return) use ?section=; new ones use #anchors.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const map = { notifications: 'emails', billing: 'billing', brokers: 'portfolio' };
    const target = map[params.get('section')] || (params.has('connection_id') || params.get('snaptrade') ? 'portfolio' : null) || window.location.hash.slice(1);
    if (target) setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }, []);

  async function update(patch) {
    if (!local) return;
    const next = { ...local, ...patch };
    const prev = local;
    setLocal(next);
    setStatus('saving');
    try {
      if (pro) {
        await save(next);
      } else {
        // Free accounts can only change the weekly digest (its own endpoint).
        const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
        const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs/digest`, { method: 'POST', headers, body: JSON.stringify({ weekly_digest: !!next.weekly_digest }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Save failed');
        markSaved({ weekly_digest: !!next.weekly_digest });
      }
      setStatus('saved');
      setTimeout(() => setStatus(s => (s === 'saved' ? null : s)), 2000);
    } catch (e) {
      setLocal(prev);
      setStatus(e.message || 'Couldn\'t save. Try again.');
    }
  }

  async function sendTestEmail() {
    setTestState('sending');
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs/test-email`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test email failed');
      setTestState(`Sent to ${data.sentTo || 'your email'}`);
    } catch (e) {
      setTestState(e.message || 'Test email failed');
    }
    setTimeout(() => setTestState(null), 5000);
  }

  const L = local;
  const lock = !pro;
  const alertsOn = !!(L && (L.instant_watchlist_ticker || L.instant_followed_insider));
  const marketWide = !!(L && L.digest_top_signals && !L.digest_watchlist_only);
  const anyDigest = !!(L && (L.weekly_digest || (pro && L.daily_digest)));

  return (
    <div className="sx-page sx-page--narrow">
      <header className="sx-head sx-head--page">
        <div className="sx-head__main">
          <h1 className="sx-head__title">Account</h1>
          <p className="sx-head__desc">{user?.primaryEmailAddress?.emailAddress ? `Signed in as ${user.primaryEmailAddress.emailAddress}. ` : ''}Emails go to this address.</p>
        </div>
        <div className="sx-head__actions">
          {status === 'saving' && <span className="sx-muted sx-small">Saving…</span>}
          {status === 'saved' && <span className="sx-saved">Saved</span>}
          {status && status !== 'saving' && status !== 'saved' && <span className="sx-err">{status}</span>}
        </div>
      </header>
      <nav className="sx-acct-nav" aria-label="Account sections">
        <a href="#billing">Plan</a><a href="#emails">Emails</a><a href="#portfolio">Brokerage</a><a href="#more">Appearance &amp; help</a>
      </nav>

      <Card id="billing" title="Plan and billing"><BillingSection user={user} /></Card>

      <Card id="emails" title="Emails" sub="What Seli sends you. The stocks and people you watch decide what's in them.">
        {!L ? <Spinner /> : (<>
          <SxSetting label="Weekly digest" sub="Sunday evening: what insiders did with everything you watch, plus the week's most notable insider buying.">
            <SxToggle label="Weekly digest" checked={L.weekly_digest} onChange={v => update({ weekly_digest: v })} />
          </SxSetting>
          <SxSetting label="Daily digest" sub="Weekday mornings, only when something you watch had a filing." pro locked={lock}>
            <SxToggle label="Daily digest" checked={pro && L.daily_digest} disabled={lock} onChange={v => update({ daily_digest: v })} />
          </SxSetting>
          <SxSetting label="Same-day alerts" sub="An email the day a new filing lands for a stock or person you watch. Mute individual ones with the bell on your Watchlist." pro locked={lock}>
            <SxToggle label="Same-day alerts" checked={pro && alertsOn} disabled={lock} onChange={v => update({ instant_watchlist_ticker: v, instant_followed_insider: v })} />
          </SxSetting>
          {pro && alertsOn && (
            <SxSetting nested label="Skip small trades" sub="Only alert on trades at least this size.">
              <select className="sx-select" value={L.instant_min_value} onChange={e => update({ instant_min_value: Number(e.target.value) })}>
                <option value={0}>Any size</option><option value={10000}>$10K+</option><option value={50000}>$50K+</option><option value={250000}>$250K+</option>
              </select>
            </SxSetting>
          )}
          <SxSetting label="Big executive buys anywhere" sub="A CEO, CFO or other C-suite executive buys at least this much of any stock, watched or not." pro locked={lock}>
            {pro && L.instant_high_conviction && (
              <select className="sx-select" value={L.instant_high_conviction_threshold} onChange={e => update({ instant_high_conviction_threshold: Number(e.target.value) })}>
                <option value={250000}>$250K+</option><option value={500000}>$500K+</option><option value={1000000}>$1M+</option><option value={5000000}>$5M+</option>
              </select>
            )}
            <SxToggle label="Big executive buys" checked={pro && L.instant_high_conviction} disabled={lock} onChange={v => update({ instant_high_conviction: v })} />
          </SxSetting>
          <SxSetting label="Change of direction" sub="An insider at a stock you watch starts buying after a run of selling, or the reverse." pro locked={lock}>
            <SxToggle label="Change of direction" checked={pro && L.instant_reversal} disabled={lock} onChange={v => update({ instant_reversal: v })} />
          </SxSetting>
          <SxSetting label="Market-wide buying in digests" sub={anyDigest ? 'Include the most notable insider buying across the market, not just your list.' : 'Turn on a digest first.'} pro locked={lock}>
            <SxToggle label="Market-wide buying" checked={pro ? marketWide : true} disabled={lock || !anyDigest} onChange={v => update({ digest_top_signals: v, digest_watchlist_only: !v })} />
          </SxSetting>
          <SxSetting label="Congressional trades in digests" sub="STOCK Act disclosures from members of Congress." pro locked={lock}>
            <SxToggle label="Congressional trades" checked={pro ? L.digest_congressional : true} disabled={lock || !anyDigest} onChange={v => update({ digest_congressional: v })} />
          </SxSetting>
          {lock ? (
            <div className="sx-gate sx-gate--block" style={{ marginTop: 10 }}>
              <span className="sx-gate__text">Free accounts get the weekly digest. Pro adds the daily digest, same-day alerts and these filters.</span>
              <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={() => onUpgrade('notifications')}>See Pro</button>
            </div>
          ) : (
            <div className="sx-set">
              <div className="sx-set__sub">Check that emails reach you.</div>
              <div className="sx-set__ctl">
                {testState && testState !== 'sending' && <span className="sx-muted sx-small">{testState}</span>}
                <button className="sx-btn sx-btn--sm" onClick={sendTestEmail} disabled={testState === 'sending'}>{testState === 'sending' ? 'Sending…' : 'Send test email'}</button>
              </div>
            </div>
          )}
        </>)}
      </Card>

      <Card id="portfolio" title="Linked brokerage" sub="Read-only. Seli sees positions, never your login and never trading access.">
        {!pro ? (
          <div className="sx-gate sx-gate--block">
            <span className="sx-gate__text">Link a brokerage and your holdings show up on Home and your Watchlist, and in your digests.</span>
            <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={() => onUpgrade('portfolio')}>See Pro</button>
          </div>
        ) : snaptrade.status === null ? (
          <span className="sx-muted">Checking connection…</span>
        ) : !snaptrade.status.connection ? (
          <SxSetting label="No brokerage linked" sub="Fidelity, Schwab, Robinhood, Alpaca and most others, through SnapTrade.">
            <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={snaptrade.connect} disabled={snaptrade.connecting}>{snaptrade.connecting ? 'Redirecting…' : 'Link brokerage'}</button>
          </SxSetting>
        ) : (
          <SxSetting label={snaptrade.status.connection.broker || 'Brokerage linked'}
            sub={`Connected ${new Date(snaptrade.status.connection.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}>
            <button className="sx-btn sx-btn--ghost sx-btn--sm" onClick={snaptrade.disconnect}>Disconnect</button>
          </SxSetting>
        )}
        {snaptrade.error && <p className="sx-err">{snaptrade.error}</p>}
      </Card>

      <Card id="more" title="Appearance and help">
        <SxSetting label="Dark mode"><SxToggle label="Dark mode" checked={dark} onChange={setDark} /></SxSetting>
        <SxSetting label="How Seli works" sub="What the numbers mean, where the data comes from, and common questions.">
          <a className="sx-btn sx-btn--sm" href="/help" target="_blank" rel="noreferrer">Help center</a>
        </SxSetting>
        <SxSetting label="Replay the intro" sub="The short walkthrough new accounts see.">
          <button className="sx-btn sx-btn--sm" onClick={() => go('/onboard')}>Start</button>
        </SxSetting>
        <SxSetting label="Something broken or missing?" sub="Goes straight to Kevin.">
          <FeedbackButton page="account" label="Send feedback" />
        </SxSetting>
      </Card>
    </div>
  );
}

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
// Linear-inspired: stark, large type, single purpose per section.
// Stripe-inspired: structured nav, clear hierarchy, trust signals.
// FEATURES content now lives inline in LandingPage (see WHATS_INSIDE below
// that function's fetch of dataSinceYear) — moved out of this module-level
// constant since the first item needs that fetched value, which a plain
// constant array can't reference.

// ─── INFO / TRUST PAGE ──────────────────────────────────────────────────────
// Real URL (/about), separate from onboarding — built to answer "is this
// actually worth trusting" with real citations and honest limitations,
// not just marketing copy.
// Illustrative sample data for the landing page marquee — not live data.
const MARQUEE_TICKERS = [
  { symbol: 'NVDA', buy: true, delta: '12.4%' },
  { symbol: 'AAPL', buy: true, delta: '3.1%' },
  { symbol: 'TSLA', buy: false, delta: '8.7%' },
  { symbol: 'MSFT', buy: true, delta: '2.9%' },
  { symbol: 'META', buy: true, delta: '5.6%' },
  { symbol: 'JPM', buy: false, delta: '1.8%' },
  { symbol: 'AMZN', buy: true, delta: '4.2%' },
  { symbol: 'GOOGL', buy: true, delta: '6.3%' },
  { symbol: 'AVGO', buy: true, delta: '7.1%' },
  { symbol: 'XOM', buy: false, delta: '2.4%' },
  { symbol: 'UNH', buy: true, delta: '3.8%' },
  { symbol: 'V', buy: false, delta: '1.2%' },
  { symbol: 'CRM', buy: true, delta: '5.9%' },
  { symbol: 'DIS', buy: false, delta: '2.7%' },
  { symbol: 'ADBE', buy: true, delta: '4.5%' },
  { symbol: 'PFE', buy: false, delta: '1.6%' },
];

function InfoTrustPage({ onBack, onEnter }) {
  return (
    <div className="lp-info">
      <div className="lp-info__inner">
        <a href="/" onClick={onBack} className="lp-info__back"> Back</a>

        {/* ── Title + brief intro ──────────────────────────────────────── */}
        <div className="lp-info__eyebrow">About Seli</div>
        <h1 className="lp-info__h1">Why insider trades are public record</h1>
        <p className="lp-info__lede">
          Every year, corporate insiders and members of Congress disclose thousands of stock trades
          because federal law requires it. That disclosure creates a legally mandated look at what
          the people closest to a company are actually doing with their own money.
        </p>

        {/* ── How insiders beat the market ─────────────────────────────── */}
        <section className="lp-info__section reveal">
          <h2>How insiders beat the market</h2>
          <p>
            The predictive value of insider trades is backed by decades of published financial
            economics research. Here's a summary of the key findings.
          </p>
          <div className="lp-findings-grid">
            <div className="lp-finding-card reveal reveal--delay-0">
              <div className="lp-finding-card__icon"><IconInsights style={{ width: 18, height: 18 }} /></div>
              <div className="lp-finding-card__title">Buying beats selling as a signal</div>
              <div className="lp-finding-card__body">Insiders face real legal exposure for selling on non-public information. That risk doesn't apply the same way to buying, which is why purchases carry more predictive weight than sales.</div>
              <div className="lp-finding-card__cite">Seyhun, 1980s–90s</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-1">
              <div className="lp-finding-card__icon"><IconFavorites style={{ width: 18, height: 18 }} /></div>
              <div className="lp-finding-card__title">Clusters matter more than one trade</div>
              <div className="lp-finding-card__body">Several insiders buying independently around the same time is a stronger signal than one person acting alone. Seli's scoring is built around this directly.</div>
              <div className="lp-finding-card__cite">Lakonishok &amp; Lee, 2001</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-2">
              <div className="lp-finding-card__icon"><IconZap style={{ width: 18, height: 18 }} /></div>
              <div className="lp-finding-card__title">Timing separates signal from noise</div>
              <div className="lp-finding-card__body">Routine, calendar-driven insider trades carry little predictive value. Opportunistic, irregularly timed ones carry almost all of it.</div>
              <div className="lp-finding-card__cite">Cohen, Malloy &amp; Pomorski, 2012</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-3">
              <div className="lp-finding-card__icon"><IconData style={{ width: 18, height: 18 }} /></div>
              <div className="lp-finding-card__title">The rules keep changing, and matter</div>
              <div className="lp-finding-card__body">A 2023 SEC rule change to pre-scheduled 10b5-1 trading plans measurably shifted how insiders structure their disclosed sales. This is an active area of research.</div>
              <div className="lp-finding-card__cite">Avci, Schipani, Seyhun &amp; Verstein, 2025</div>
            </div>
          </div>
          <p className="lp-info__citation-note">
            Full sources: Jaffe (1974); Seyhun, "Insiders' Profits, Costs of Trading, and Market Efficiency,"
            Journal of Financial Economics (1986); Seyhun, "The Information Content of Aggregate Insider
            Trading," Journal of Business (1988); Lakonishok & Lee, "Are Insider Trades Informative?" (2001);
            Cohen, Malloy & Pomorski, "Decoding Inside Information" (2012); Avci, Schipani, Seyhun & Verstein,
            "Insider Trading by Other Means," Harvard Business Law Review (2025).
          </p>
        </section>

        {/* ── How Seli gets and scores the data ────────────────────────── */}
        <section className="lp-info__section reveal">
          <h2>How Seli gets and scores the data</h2>
          <div className="lp-pipeline">
            {[
              { label: 'SEC EDGAR + Congress', desc: 'Form 4 filings and STOCK Act disclosures, straight from the source.' },
              { label: 'Ingested & parsed', desc: 'New filings pulled and structured automatically, typically within minutes of publication.' },
              { label: 'Scored', desc: 'Weighted by who is trading, how much relative to what they hold, and whether others are too.' },
              { label: 'Surfaced', desc: 'Ranked and shown as a signal, with the raw filing always accessible alongside it.' },
            ].map((step, i, arr) => (
              <React.Fragment key={i}>
                <div className="lp-pipeline__step">
                  <div className="lp-pipeline__num">{i + 1}</div>
                  <div className="lp-pipeline__label">{step.label}</div>
                  <div className="lp-pipeline__desc">{step.desc}</div>
                </div>
                {i < arr.length - 1 && <div className="lp-pipeline__arrow">→</div>}
              </React.Fragment>
            ))}
          </div>
          <p>
            Every account can see the underlying raw filing data: ticker, insider, shares, price,
            transaction type, date. The scored signal view sits alongside it for a faster read.
            Both update automatically as new filings arrive.
          </p>
          <p>
            Seli's conviction score is built directly around the principles the research above
            established:
          </p>
          <ul className="lp-info__principles">
            <li><strong>Who's buying matters.</strong> A purchase from a C-suite executive, someone with the
              broadest view into the company, carries more weight than one from a director with narrower
              visibility.</li>
            <li><strong>Size relative to what they already own matters more than raw dollars.</strong> A
              $500K purchase from someone materially growing their existing stake is a stronger signal than
              the same dollar amount as a routine top-up on a much larger position.</li>
            <li><strong>Multiple insiders acting together matters.</strong> Directly following Lakonishok and
              Lee's finding: several insiders buying independently around the same time is treated as a
              stronger signal than one person acting alone.</li>
            <li><strong>Only real, personal-funds market transactions count.</strong> Stock grants,
              option exercises, and other compensation-related transfers are excluded before a
              signal is ever scored. They don't reflect a personal bet the way an open-market purchase does.</li>
          </ul>
          <p>
            We don't publish the exact formula or weights, but the principles above are the actual
            mechanism the scoring is built on.
          </p>
        </section>

        {/* ── Historical analysis ──────────────────────────────────────── */}
        <section className="lp-info__section reveal">
          <h2>Historical analysis</h2>
          <div className="lp-timeline">
            {[
              { year: '1934', label: 'Securities Exchange Act', desc: 'Establishes the requirement that corporate insiders disclose their own trades to the public.' },
              { year: '2002', label: 'Sarbanes-Oxley Act', desc: 'Shortens the filing deadline from 10 days down to 2 business days, the modern Form 4 window.' },
              { year: '2012', label: 'STOCK Act', desc: 'Extends mandatory trade disclosure to members of Congress.' },
              { year: 'Today', label: 'Seli', desc: 'Ingests every new filing, corporate and congressional, within minutes of publication.' },
            ].map((t, i) => (
              <div key={i} className="lp-timeline__item">
                <div className="lp-timeline__year">{t.year}</div>
                <div className="lp-timeline__dot" />
                <div className="lp-timeline__label">{t.label}</div>
                <div className="lp-timeline__desc">{t.desc}</div>
              </div>
            ))}
          </div>
          <div className="lp-stat-tiles">
            <div className="lp-stat-tile">
              <div className="lp-stat-tile__val">2 days</div>
              <div className="lp-stat-tile__label">Maximum legal disclosure window for a corporate insider trade — down from 10 days pre-2002.</div>
            </div>
            <div className="lp-stat-tile">
              <div className="lp-stat-tile__val val-buy">+4.3%</div>
              <div className="lp-stat-tile__label">Abnormal return over 300 days for firms with more insider buying than selling — Seyhun (1986).</div>
            </div>
            <div className="lp-stat-tile">
              <div className="lp-stat-tile__val val-sell">-2.2%</div>
              <div className="lp-stat-tile__label">The reverse — abnormal return for firms with more insider selling than buying, same study.</div>
            </div>
          </div>
          <p className="lp-info__citation-note">
            These are historical academic findings across broad samples of insider trades, not a guarantee
            about any individual trade, insider, or what Seli's own scored signals will return going forward.
          </p>
        </section>

        {/* ── Disclosures ───────────────────────────────────────────────── */}
        <section className="lp-info__section lp-info__section--limits reveal">
          <h2>Disclosures</h2>
          <p>
            <strong>This is not a day-trading tool.</strong> Form 4 filings carry a mandatory disclosure
            window. Insiders can have up to two business days to report a trade after it happens. Sarbanes-Oxley
            tightened the requirement from ten days down to two specifically to make this data more useful, but
            two days is still real lag. For someone making decisions on minute-to-minute price action, this data
            is structurally too old to act on that way.
          </p>
          <p>
            <strong>Scoring accuracy improves as more history is captured.</strong> An insider's track record
            can only be evaluated against the trades Seli has actually ingested. A newly backfilled period
            naturally starts thinner than one with years of accumulated history behind it.
          </p>
          <p>
            <strong>Academic findings describe average, historical tendencies.</strong> They are not a guarantee
            about any single trade, any single insider, or what happens next. Insiders are informed about their
            own companies. They are not infallible, and markets can move against even a well-timed,
            well-informed trade.
          </p>
          <p>
            <strong>Nothing on this page or in Seli is financial advice.</strong> Seli surfaces public
            disclosure data and a scoring methodology built on published research. It does not recommend
            any specific trade, and past patterns do not guarantee future results.
          </p>
        </section>

        <div className="lp-info__cta">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="lp-btn-primary lp-btn-primary--lg">Explore Seli →</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <button className="lp-btn-primary lp-btn-primary--lg" onClick={onEnter}>Explore Seli →</button>
          </SignedIn>
        </div>
      </div>
    </div>
  );
}

// Landing-page-only feature mockups. Portfolio, Data, and Top Insiders reuse
// the real app's own classes/components verbatim (.port-mini-tile, the
// Data page's bare <table>/Badge markup, .ins-lb-card + ConvictionBar).
// Alerts reproduces send_instant_alerts.py's actual email markup and colors
// (see .lp-mock-alert-email in the CSS). All four are styled identically to
// the real thing they're representing — only the data is mock.
function LPFeatureMock({ type }) {
  if (type === 'watchlist') return (
    <div className="port-mini-tile lp-mock-tile">
      <div className="ins-sig-panel__hdr"><span className="ins-sig-panel__title">Portfolio</span></div>
      <div className="port-mini-tile__body">
        <div className="port-mini-tile__stats">
          <span className="port-mini-tile__val">$41,194</span>
          <span className="port-mini-tile__growth val-buy">+$2,014 (+5.1%)</span>
        </div>
        <div className="port-mini-tile__chart">
          <svg viewBox="0 0 240 70" width="100%" height="70" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="12" x2="240" y2="12" stroke="var(--border)" strokeWidth="0.5" />
            <line x1="0" y1="35" x2="240" y2="35" stroke="var(--border)" strokeWidth="0.5" />
            <line x1="0" y1="58" x2="240" y2="58" stroke="var(--border)" strokeWidth="0.5" />
            <path d="M0,50 L30,46 L60,48 L90,38 L120,40 L150,26 L180,28 L210,12 L240,8" fill="none" stroke="var(--green-600)" strokeWidth="2" />
          </svg>
        </div>
        <div className="port-mini-tile__list">
          {[
            { t: 'NVDA', v: '$18,204', pnl: '+6.2%', sig: true },
            { t: 'AAPL', v: '$9,880', pnl: '+2.1%', sig: false },
            { t: 'MSFT', v: '$6,340', pnl: '+3.7%', sig: true },
            { t: 'TSLA', v: '$4,110', pnl: '-3.4%', sig: true },
            { t: 'GOOGL', v: '$2,660', pnl: '+1.4%', sig: false },
          ].map(r => (
            <div key={r.t} className="port-mini-row">
              <span className="ticker" style={{ fontSize: '0.75rem', minWidth: 50 }}>{r.t}</span>
              {r.sig && <span className="ins-port-chip__signal-badge" style={{ fontSize: '0.5rem' }}>activity</span>}
              <span className="td-muted" style={{ fontSize: '0.625rem', flex: 1, textAlign: 'right' }}>{r.v}</span>
              <span className={parseFloat(r.pnl) >= 0 ? 'val-buy' : 'val-sell'} style={{ fontSize: '0.625rem', fontFamily: 'var(--font-mono)', minWidth: 50, textAlign: 'right' }}>{r.pnl}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  if (type === 'settings') return (
    <div className="dash-tile lp-mock-tile">
      <div className="dash-tile__hdr">
        <span className="dash-tile__title">Alerts</span>
        <span className="dash-tile__sub">Instant</span>
      </div>
      <div className="dash-tile__body" style={{ padding: 0 }}>
        {/* Reproduces send_instant_alerts.py's build_email() output — same
            gradient header, colors (C_ACCENT/C_ACCENT_STR/C_AQUA/C_GREEN/
            C_RED etc.), and row layout, as fixed hex values rather than the
            app's CSS variables. That's deliberate: a real email always
            renders with the colors baked into its HTML, regardless of
            anyone's light/dark theme — matching it means matching that. */}
        <div className="lp-mock-alert-email">
          <div className="lp-mock-alert-email__hdr">
            <span className="lp-mock-alert-email__brand">Seli</span>
            <span className="lp-mock-alert-email__kind">Instant alert</span>
          </div>
          <div className="lp-mock-alert-email__body">
            <p className="lp-mock-alert-email__intro">3 of your instant alerts were triggered:</p>
            <table className="lp-mock-alert-email__table"><tbody>
              {[
                { t: 'NVDA', co: 'NVIDIA Corp', reason: 'Watched ticker traded', who: 'Jensen Huang', date: 'Jul 22, 2026', action: 'Buy', detail: '12,000 sh @ $118.42', val: '$1.42M', buy: true },
                { t: 'TSLA', co: 'Tesla Inc', reason: 'Large executive sale', who: 'Elon Musk', date: 'Jul 21, 2026', action: 'Sell', detail: '610 sh @ $248.55', val: '$151,616', buy: false },
                { t: 'MSFT', co: 'Microsoft Corp', reason: 'Followed insider filed', who: 'Satya Nadella', date: 'Jul 21, 2026', action: 'Buy', detail: '340 sh @ $421.10', val: '$143,174', buy: true },
              ].map(r => (
                <tr key={r.t}>
                  <td>
                    <span className="lp-mock-alert-email__ticker">{r.t}</span><br />
                    <span className="lp-mock-alert-email__muted">{r.co}</span>
                  </td>
                  <td className="lp-mock-alert-email__muted">{r.reason}</td>
                  <td>
                    <span className="lp-mock-alert-email__muted">{r.who}</span><br />
                    <span className="lp-mock-alert-email__faint">{r.date}</span>
                  </td>
                  <td>
                    <span className={r.buy ? 'lp-mock-alert-email__buy' : 'lp-mock-alert-email__sell'}>{r.action}</span><br />
                    <span className="lp-mock-alert-email__muted">{r.detail}</span>
                  </td>
                  <td className={`lp-mock-alert-email__val ${r.buy ? 'lp-mock-alert-email__buy' : 'lp-mock-alert-email__sell'}`}>{r.val}</td>
                </tr>
              ))}
            </tbody></table>
            <div className="lp-mock-alert-email__cta">Open Seli →</div>
          </div>
        </div>
      </div>
    </div>
  );
  if (type === 'data') return (
    <div className="dash-tile lp-mock-tile">
      <div className="dash-tile__hdr">
        <span className="dash-tile__title">Data</span>
        <span className="dash-tile__sub">Filings</span>
      </div>
      <div className="dash-tile__body" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ border: 'none', borderRadius: 0, boxShadow: 'none' }}>
          <table>
            <thead><tr>
              <th>Date</th><th>Ticker</th><th>Type</th>
              <th className="th--right">Shares</th><th className="th--right">Price</th><th className="th--right">Value</th>
            </tr></thead>
            <tbody>
              {[
                { d: 'Jul 22', t: 'NVDA', tt: 'buy', sh: '1,200', px: '$118.42', val: '$142,104' },
                { d: 'Jul 21', t: 'MSFT', tt: 'buy', sh: '340', px: '$421.10', val: '$143,174' },
                { d: 'Jul 21', t: 'TSLA', tt: 'sell', sh: '610', px: '$248.55', val: '$151,616' },
                { d: 'Jul 19', t: 'ADSK', tt: 'buy', sh: '95', px: '$289.77', val: '$27,528' },
                { d: 'Jul 18', t: 'AAPL', tt: 'sell', sh: '32,528', px: '$250.12', val: '$8.1M' },
                { d: 'Jul 18', t: 'JPM', tt: 'buy', sh: '2,400', px: '$267.30', val: '$641,520' },
                { d: 'Jul 17', t: 'GOOGL', tt: 'buy', sh: '780', px: '$192.45', val: '$150,111' },
              ].map((r, i) => (
                <tr key={i} className={`row-${r.tt}`}>
                  <td className="td-date"><span className="td-date-main">{r.d}</span></td>
                  <td><span className="ticker">{r.t}</span></td>
                  <td>
                    <Badge type={r.tt}>
                      {r.tt === 'buy' ? <><IconBuyTri style={{ width: 8, height: 8, marginRight: 3 }} />Buy</> : <><IconSellTri style={{ width: 8, height: 8, marginRight: 3 }} />Sell</>}
                    </Badge>
                  </td>
                  <td className="td-right td-mono td-secondary">{r.sh}</td>
                  <td className="td-right td-mono td-secondary">{r.px}</td>
                  <td className="td-right td-mono"><span className={r.tt === 'buy' ? 'val-buy' : 'val-sell'}>{r.val}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
  if (type === 'insights') return (
    <div className="dash-tile lp-mock-tile">
      <div className="dash-tile__hdr">
        <span className="dash-tile__title">Top insiders</span>
        <span className="dash-tile__sub">All-time</span>
      </div>
      <div className="dash-tile__body" style={{ padding: 0 }}>
        <div className="ins-lb-list">
          {[
            { n: 'A.L. Sarroff Fund', title: '10% Owner', rel: 'weak', buys: '48 buys', val: '$4.2M', rate: 94, score: 4.8 },
            { n: 'Jason T. Adelman', title: 'Chief Exec.', rel: 'strong', buys: '3 buys', val: '$820K', rate: 87, score: 4.2 },
            { n: '325 Capital LLC', title: '10% Owner', rel: 'weak', buys: '2 buys', val: '$610K', rate: 71, score: 3.6 },
            { n: 'AC Nordic ApS', title: 'Director', rel: 'medium', buys: '6 buys', val: '$390K', rate: 52, score: 2.1 },
          ].map((r, i) => (
            <div key={r.n} className="ins-lb-card">
              <div className="ins-lb-card__rank">{i + 1}</div>
              <div className="ins-lb-card__body">
                <div className="ins-lb-card__name">{r.n}</div>
                <div className="td-muted" style={{ fontSize: '0.6875rem' }}>{r.title}</div>
                <div className="ins-lb-card__meta">
                  <Badge type={`rel-${r.rel}`}>{r.rel === 'strong' ? 'Exec' : r.rel === 'medium' ? 'Officer' : 'Dir'}</Badge>
                  <span className="td-muted" style={{ fontSize: '0.6875rem' }}>{r.buys} · {r.val}</span>
                </div>
              </div>
              <div className="ins-lb-card__score">
                <div className={`ins-lb-card__rate ${r.rate >= 70 ? 'val-buy' : r.rate >= 50 ? '' : 'val-sell'}`}>{r.rate}%</div>
                <ConvictionBar score={r.score} max={4} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  return null;
}

function LandingPage({ onEnter, dark, setDark }) {
  // Real URL for the About/Trust page (shareable, indexable) rather than an
  // anchor scroll — reuses the same navigateTo/popstate pattern already
  // built for the authenticated app's router, so this needed no changes to
  // App-level routing logic at all.
  const [view, setView] = useState(() => window.location.pathname === '/about' ? 'about' : 'home');
  // Real earliest-filing-date fetch for the "since 2018" style claim on this
  // page, rather than a hardcoded year that quietly drifts wrong as more
  // history gets backfilled. Uses the genuinely public data-stats endpoint
  // (no auth path involved at all, unlike the generic query endpoint) since
  // this page renders before anyone has signed in. 2018 is the fallback if
  // the fetch hasn't resolved yet or fails outright, not the source of truth.
  const [dataSinceYear, setDataSinceYear] = useState(2010);
  useEffect(() => {
    fetch(`${cfg.NEON_PROXY_URL}/public/data-stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.oldest_filing_date) {
          const y = new Date(d.oldest_filing_date + 'T12:00:00').getFullYear();
          if (y && y > 2000 && y <= new Date().getFullYear()) setDataSinceYear(y);
        }
      })
      .catch(() => { }); // keep the 2018 fallback silently — this is a single word on a marketing page, not worth surfacing an error for
  }, []);

  // "What's Inside" content — four concrete things the product does, not
  // abstract feature names. Written plainly on purpose: short sentences,
  // no hedging, no forced enthusiasm.
  const WHATS_INSIDE = [
    {
      icon: 'IconInsights',
      eyebrow: 'Scored signals',
      title: 'Cut through the noise',
      body: 'Thousands of insider trades are filed every week. Most are routine. Seli scores each one against peer-reviewed research — who traded, how much of their position they moved, whether other insiders are buying the same stock — and surfaces the ones with real conviction behind them.',
      env: 'insights',
    },
    {
      icon: 'IconZap',
      eyebrow: 'Instant alerts',
      title: 'Be the first to know, not the last to react',
      body: 'Get notified the moment a filing lands — not hours later when the market has already moved. Follow specific tickers or insiders. Instant alerts, daily digests, or weekly summaries — your call.',
      env: 'settings',
    },
    {
      icon: 'IconFavorites',
      eyebrow: 'Watchlist & portfolio',
      title: 'Track what matters to you',
      body: 'Build a watchlist of tickers and insiders you care about. Connect your brokerage (read-only) and Seli watches your actual holdings for insider activity. When a CEO or director trades something in your portfolio, you\'ll know.',
      env: 'watchlist',
    },
    {
      icon: 'IconData',
      eyebrow: 'Deep-dive data',
      title: `Every filing since ${dataSinceYear}, at your fingertips`,
      body: 'Corporate executive trades, congressional stock disclosures, insider profiles, and transaction history — searchable, filterable, and linked to the original government filing. When you want to dig deeper and draw your own conclusions, the full dataset is here.',
      env: 'data',
    },
  ];
  useEffect(() => {
    function onPop() { setView(window.location.pathname === '/about' ? 'about' : 'home'); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function goToAbout(e) { e.preventDefault(); navigateTo('/about'); setView('about'); window.scrollTo(0, 0); }
  function goHome(e) { if (e) e.preventDefault(); navigateTo('/'); setView('home'); window.scrollTo(0, 0); }
  // Section links (Features/Pricing) need to work from the About view too —
  // a plain anchor tag does nothing there, since those sections don't exist
  // in the DOM while view==='about'. Navigate home first, then scroll once
  // the home view has actually rendered.
  function goToSection(e, hash) {
    e.preventDefault();
    if (view === 'about') {
      navigateTo('/'); setView('home');
      setTimeout(() => document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth' }), 60);
    } else {
      document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth' });
    }
  }

  // Scroll-reveal: observe .reveal elements and add .reveal--visible when in
  // viewport. Re-runs on every view change (not just once on mount) — home
  // and /about are conditionally rendered, so switching between them
  // unmounts and remounts a whole tree of .reveal elements that need to be
  // freshly observed each time, not just the ones present at first load.
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('reveal--visible'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, [view]);

  return (
    <div className="lp" data-theme={dark ? 'dark' : 'light'}>

      {/* Nav */}
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a href="/" onClick={goHome} className="lp-nav__logo">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <div className="lp-nav__links">
            <a href="#features" onClick={(e) => goToSection(e, '#features')} className="lp-nav__link">Features</a>
            <a href="#pricing" onClick={(e) => goToSection(e, '#pricing')} className="lp-nav__link">Pricing</a>
            <a href="/about" onClick={goToAbout} className="lp-nav__link">About</a>
          </div>
          <div className="lp-nav__actions">
            <button className="lp-btn-ghost lp-btn-ghost--icon" onClick={() => setDark(d => !d)} title="Toggle theme">
              {dark ? <IconSun style={{ width: 15, height: 15 }} /> : <IconMoon style={{ width: 15, height: 15 }} />}
            </button>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-primary">Open Seli →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-primary" onClick={onEnter}>Open Seli →</button>
            </SignedIn>
          </div>
        </div>
      </nav>

      {view === 'about' ? (
        <InfoTrustPage onBack={goHome} onEnter={onEnter} />
      ) : (<>
        {/* Hero */}
        <section className="lp-hero">
          <div className="lp-hero-bg" aria-hidden="true" />
          <p className="lp-hero__eyebrow reveal reveal--delay-1">SEC Insider Trading & Congressional Stock Tracker</p>
          <h1 className="lp-hero__h1 reveal reveal--delay-1">
            See what insiders are buying<br />
            <span className="lp-hero__h1-accent">before the market reacts.</span>
          </h1>
          <p className="lp-hero__sub reveal reveal--delay-2">
            CEOs, directors, and members of Congress are legally required to disclose their stock trades.
            Seli watches every SEC Form 4 filing and STOCK Act disclosure, scores each trade by conviction,
            and alerts you within minutes — not hours.
          </p>
          <div className="lp-hero__cta reveal reveal--delay-3">
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-primary lp-btn-primary--lg">Explore Seli →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-primary lp-btn-primary--lg" onClick={onEnter}>Explore Seli →</button>
            </SignedIn>
          </div>
          <p className="lp-hero__trust reveal reveal--delay-3">SEC Form 4 filings · STOCK Act disclosures · Real-time alerts · Free to start</p>

          {/* Product preview strip */}
          <div className="lp-preview reveal reveal--delay-4">
            <div className="lp-preview__bar">
              <div className="lp-preview__dots">
                <span /><span /><span />
              </div>
              <span className="lp-preview__url">seli.app · Dashboard</span>
            </div>
            <div className="lp-preview__screen">
              {/* Simulated dashboard UI */}
              <div className="lp-screen-strip">
                {[['SENTIMENT', '47 Neutral'], ['SPY', '$733.58 −1.45%'], ['QQQ', '$713.65 −3.29%'], ['VIX', '—'], ['IWM', '$295.32 −0.96%'], ['INSIDER FLOW (30D)', 'Bullish 95% buying']].map(([l, v]) => (
                  <div key={l} className="lp-screen-stat">
                    <span className="lp-screen-stat__label">{l}</span>
                    <span className="lp-screen-stat__val">{v}</span>
                  </div>
                ))}
              </div>
              <div className="lp-screen-body">
                <div className="lp-screen-signals">
                  <div className="lp-screen-hdr">INSIDER SIGNALS <span style={{ opacity: .4, fontWeight: 400 }}>· 7d · 26 signals</span></div>
                  {[
                    { t: 'FMBM', c: 'F&M Bank Corp', v: '+$51K', b: '8× exec', hi: true },
                    { t: 'FISV', c: 'Fiserv Inc', v: '+$1.7M', b: '6× exec', hi: true },
                    { t: 'MSTR', c: 'Strategy Inc', v: '+$817K', b: '1× exec', hi: false, rev: true },
                    { t: 'COR', c: 'Cencora Inc', v: '+$1.1M', b: '1× exec', hi: false },
                    { t: 'ADSK', c: 'Autodesk Inc', v: '+$499K', b: '1× exec', hi: false },
                  ].map(r => (
                    <div key={r.t} className="lp-screen-row">
                      <div>
                        <span className="lp-screen-ticker">{r.t}</span>
                        {r.rev && <span className="lp-screen-rev">↺</span>}
                        <span className="lp-screen-co">{r.c}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {r.b && <span className="lp-screen-badge">{r.b}</span>}
                        <span className={`lp-screen-val ${r.hi ? 'lp-screen-val--hi' : ''}`}>{r.v}</span>
                        <div className="lp-screen-bar">
                          <div className="lp-screen-bar__fill" style={{ width: r.hi ? '85%' : '55%', background: r.hi ? '#3ECF8E' : '#7C6FFF' }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="lp-screen-right">
                  <div className="lp-screen-hdr">TOP INSIDERS <span style={{ opacity: .4, fontWeight: 400 }}>· hit rate · all-time</span></div>
                  {[
                    { n: 'A.L. Sarroff Fund', r: '94%', buys: '48 buys' },
                    { n: 'Adelman Jason T', r: '100%', buys: '3 buys' },
                    { n: '325 Capital LLC', r: '100%', buys: '2 buys' },
                    { n: 'AC Nordic ApS', r: '50%', buys: '6 buys' },
                  ].map((r, i) => (
                    <div key={i} className="lp-screen-lb-row">
                      <span className="lp-screen-lb-rank">{i + 1}</span>
                      <span className="lp-screen-lb-name">{r.n}</span>
                      <span className="lp-screen-lb-buys">{r.buys}</span>
                      <span className={`lp-screen-lb-rate ${parseFloat(r.r) >= 70 ? 'lp-screen-lb-rate--hi' : ''}`}>{r.r}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Scrolling ticker marquee — sample data, illustrative only.
          Duplicated content + translateX(-50%) for a seamless infinite
          loop. Deliberately different technique from the hero spiral, so
          the page has real animation even if one approach doesn't render
          well in a given environment. */}
        <div className="lp-marquee">
          <div className="lp-marquee__frame">
            <div className="lp-marquee__track">
              {[...MARQUEE_TICKERS, ...MARQUEE_TICKERS].map((t, i) => (
                <div key={i} className="lp-marquee__chip">
                  <span className="lp-marquee__ticker">{t.symbol}</span>
                  <span className={`lp-marquee__delta ${t.buy ? 'val-buy' : 'val-sell'}`}>{t.buy ? '▲' : '▼'} {t.delta}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Features */}
        <section className="lp-features" id="features">
          <div className="lp-section-label reveal">What Seli does</div>
          <h2 className="lp-section-h2 reveal reveal--delay-1">Insider trading signals, alerts, and data</h2>
          <div className="lp-benefit-list">
            {WHATS_INSIDE.map((f, i) => {
              const Icon = LP_FEATURE_ICON_MAP[f.icon];
              return (
                <div key={f.title} className={`lp-benefit-row ${i % 2 === 1 ? 'lp-benefit-row--reverse' : ''} reveal reveal--delay-${i % 3}`}>
                  <div className="lp-benefit-row__text">
                    <div className="lp-benefit-row__icon">{Icon && <Icon style={{ width: 24, height: 24 }} />}</div>
                    <div className="lp-benefit-row__eyebrow">{f.eyebrow}</div>
                    <div className="lp-benefit-row__title">{f.title}</div>
                    <div className="lp-benefit-row__body">{f.body}</div>
                  </div>
                  <div className="lp-benefit-row__snippet">
                    <div className="lp-benefit-snippet-box" aria-hidden="true">
                      <LPFeatureMock type={f.env} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Pricing */}
        <section className="lp-pricing" id="pricing">
          <div className="lp-section-label reveal">Pricing</div>
          <h2 className="lp-section-h2 reveal reveal--delay-1">Start researching for free</h2>

          {/* Main plans — two vertical cards */}
          <div className="lp-pricing-top">
            <div className="lp-price-card reveal reveal--delay-1">
              <div className="lp-price-card__name">Free</div>
              <div className="lp-price-card__price">$0<span>/mo</span></div>
              <div className="lp-price-card__desc">Explore insider activity and see what's moving. No card required.</div>
              <ul className="lp-price-card__features">
                {['Every stock and insider page', '12 months of trades on each', 'Watch 3 stocks or people', 'Sunday digest about what you watch', 'Corporate + congressional trades'].map(f => (
                  <li key={f}><span className="lp-check"><IconCheck style={{ width: 12, height: 12 }} /></span>{f}</li>
                ))}
              </ul>
              <div className="lp-price-card__spacer" />
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="lp-btn-ghost lp-btn-ghost--full">Get started free →</button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <button className="lp-btn-ghost lp-btn-ghost--full" onClick={onEnter}>Open Seli →</button>
              </SignedIn>
            </div>
            <div className="lp-price-card lp-price-card--featured reveal reveal--delay-2">
              <div className="lp-price-card__name">Seli Pro</div>
              <div className="lp-price-card__price">
                $6.99<span>/mo</span>
              </div>
              <div className="lp-price-card__desc">Full history, every alert, every score — for serious research.</div>
              <ul className="lp-price-card__features">
                {['Everything in Free', `Full historical data (${dataSinceYear}→present)`, 'Customizable email alerts, instant or digest', 'Full score breakdown on every trade', 'Connect your brokerage (SnapTrade)', 'Full insiders deep-dive'].map(f => (
                  <li key={f}><span className="lp-check"><IconCheck style={{ width: 12, height: 12 }} /></span>{f}</li>
                ))}
              </ul>
              <div className="lp-price-card__spacer" />
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="lp-btn-primary lp-btn-primary--full">Go Pro →</button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <button className="lp-btn-primary lp-btn-primary--full" onClick={onEnter}>Go Pro →</button>
              </SignedIn>
            </div>
          </div>

          <div className="lp-price-card lp-price-card--landscape reveal reveal--delay-3">
            <div className="lp-price-card--landscape__info">
              <div className="lp-price-card__name">Data export</div>
              <div className="lp-price-card__desc">Just need the dataset? No subscription — download and own it.</div>
              <ul className="lp-price-card__features lp-price-card__features--inline">
                {['Complete Form 4 dataset', `${dataSinceYear}→present`, 'Congressional trades included', 'CSV, instant download'].map(f => (
                  <li key={f}><span className="lp-check"><IconCheck style={{ width: 12, height: 12 }} /></span>{f}</li>
                ))}
              </ul>
            </div>
            <div className="lp-price-card--landscape__action">
              <div className="lp-price-card__price">$39.99<span>/one-time</span></div>
              <a href="/data-download" className="lp-btn-ghost lp-btn-ghost--full" style={{ textDecoration: 'none', textAlign: 'center' }}>Download dataset →</a>
            </div>
          </div>
        </section>

        {/* About teaser — left-aligned, real substance, not a centered blurb.
          Fades out into a clear "read the rest" CTA rather than being
          truncated abruptly. */}
        <section className="lp-about-teaser reveal reveal--delay-1" id="about-teaser">
          <div className="lp-about-teaser__grid">
            <div className="lp-about-teaser__lead">
              <h2 className="lp-section-h2">The information is public. Finding what's important isn't.</h2>
              <p className="lp-about-teaser__intro">
                Federal law forces every corporate insider and member of Congress to disclose their stock
                trades. The data is there — buried in thousands of SEC filings per week. Academic research
                shows these trades outperform the market: insider purchases generate +4.3% abnormal returns
                annually (Seyhun, 1986), and cluster buying — multiple insiders at the same company — is
                an even stronger signal (Lakonishok & Lee, 2001). Seli turns that pile of government filings
                into something you can actually act on.
              </p>
            </div>
            <div className="lp-about-teaser__advantages">
              <div className="lp-advantage">
                <div className="lp-advantage__stat val-buy">+4.3%</div>
                <div className="lp-advantage__label">Abnormal return over 300 days for firms with more insider buying than selling.</div>
                <div className="lp-advantage__source">Seyhun (1986)</div>
              </div>
              <div className="lp-advantage">
                <div className="lp-advantage__stat">2 days</div>
                <div className="lp-advantage__label">The legal maximum an insider can wait before disclosing a trade — and Seli ingests it within minutes.</div>
                <div className="lp-advantage__source">Sarbanes-Oxley, 2002</div>
              </div>
              <div className="lp-advantage">
                <div className="lp-advantage__stat val-buy">4.8%</div>
                <div className="lp-advantage__label">Spread between strong-buy and strong-sell insider portfolios in the year after the trade.</div>
                <div className="lp-advantage__source">Lakonishok & Lee (2001)</div>
              </div>
              <div className="lp-advantage">
                <div className="lp-advantage__stat">↑ stronger</div>
                <div className="lp-advantage__label">Signal strengthens measurably when multiple insiders buy the same stock independently.</div>
                <div className="lp-advantage__source">Lakonishok & Lee (2001)</div>
              </div>
            </div>
          </div>
          <a href="/about" onClick={goToAbout} className="lp-about-teaser__link">
            Read the full research, methodology, and disclosures <span className="lp-explore-hint" aria-hidden="true">→</span>
          </a>
        </section>

        {/* Footer */}
        <footer className="lp-footer">
          <div className="lp-footer__frame">
            <div className="lp-footer__logo">
              <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /></div>
              <span className="lp-wordmark">Seli</span>
              <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
            </div>
            <div className="lp-footer__links">
              <a href="https://www.sec.gov" target="_blank" rel="noreferrer">SEC EDGAR</a>
              <span>·</span>
              <a href="/help" className="lp-footer__link-muted">Help</a>
              <span>·</span>
              <a href="/terms" className="lp-footer__link-muted">Terms</a>
              <span>·</span>
              <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
              <span>·</span>
              <a href="/cookies" className="lp-footer__link-muted">Cookies</a>
              <span>·</span>
              <span>Not financial advice</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="lp-btn-ghost">Sign in →</button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <button className="lp-btn-ghost" onClick={onEnter}>Open Seli →</button>
              </SignedIn>
            </div>
          </div>
        </footer>
      </>)}

    </div>
  );
}


// ── Routing ─────────────────────────────────────────────────────────────────
// The URL is the state. Every screen has a real path, back/forward just work,
// and a stock or a person is always its own page (never a panel or drawer
// over some other page). Old paths keep working and get rewritten.
//   /                       Home feed
//   /stock/:ticker          Stock page      (/ticker/:t redirects here; emails use it)
//   /insider/:rawName       Insider page
//   /data                   Signals + raw filings explorer
//   /leaderboard            Insider rankings (/insights redirects here)
//   /watchlist              What you watch + what you hold
//   /account                Plan, emails, linked brokerage (/settings redirects here)
function routeFromLocation(loc = window.location) {
  const parts = loc.pathname.split('/').filter(Boolean);
  const [a, b] = parts;
  if (!a || a === 'home') return { page: 'home', canonical: a === 'home' ? '/' : null };
  if ((a === 'stock' || a === 'ticker') && b) {
    const ticker = decodeURIComponent(b).toUpperCase();
    return { page: 'stock', ticker, canonical: a === 'ticker' ? stockPath(ticker) : null };
  }
  if (a === 'insider' && b) return { page: 'insider', raw: decodeURIComponent(parts.slice(1).join('/')) };
  if (a === 'data') return { page: 'dashboard' };
  if (a === 'leaderboard') return { page: 'leaderboard' };
  if (a === 'insights' || a === 'insiders') return { page: 'leaderboard', canonical: '/leaderboard' };
  if (a === 'watchlist') return { page: 'watchlist' };
  if (a === 'account') return { page: 'account' };
  if (a === 'settings') return { page: 'account', canonical: '/account' };
  return { page: 'home', canonical: '/' };
}
const PAGE_PATHS = { home: '/', dashboard: '/data', data: '/data', signals: '/leaderboard', leaderboard: '/leaderboard', watchlist: '/watchlist', settings: '/account', account: '/account' };
const PAGE_TITLES = { home: 'Home', dashboard: 'Data', leaderboard: 'Leaderboard', watchlist: 'Watchlist', account: 'Account' };
const STANDALONE_PATHS = ['/terms', '/privacy', '/cookies', '/help', '/data-download', '/purchase-complete', '/redownload', '/about', '/onboard'];

import * as Sentry from '@sentry/react';

// Not exported directly — see the wrapped default export at the bottom of
// this file. Renamed from App so an ErrorBoundary can sit ABOVE it.
function AppInner() {
  const [dark, setDark] = useTheme();
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();
  const { pro: billingPro } = useBilling();

  // Register Clerk token getter globally so edgar.js / lib/api.js can use it.
  const { signOut } = useAuth();
  useEffect(() => {
    if (isSignedIn && getToken) {
      window.__clerkGetToken = () => getToken();
      window.__clerkSignOut = () => signOut({ redirectUrl: '/' });
    } else {
      window.__clerkGetToken = null;
      window.__clerkSignOut = null;
      if (window.__seliAuth) { window.__seliAuth.token = null; window.__seliAuth.expiry = 0; }
      clearApiCache();
    }
  }, [isSignedIn, getToken, signOut]);

  const showLanding = !isLoaded || !isSignedIn;

  // ── Route state (read from the URL, updated on push/back/forward) ────────
  const [route, setRoute] = useState(() => routeFromLocation());
  const mainRef = useRef(null);
  useEffect(() => {
    function onPop(e) {
      const r = routeFromLocation();
      setRoute(r);
      // New navigation starts at the top; back/forward leaves the browser alone.
      if (e?.state?.seliPush && mainRef.current) mainRef.current.scrollTop = 0;
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Rewrite legacy paths (/ticker/X, /settings, /insights) in place.
  useEffect(() => {
    if (route.canonical && !STANDALONE_PATHS.includes(window.location.pathname)) {
      window.history.replaceState({}, '', route.canonical + window.location.search + window.location.hash);
    }
  }, [route]);
  useEffect(() => {
    if (PAGE_TITLES[route.page] && route.page !== 'home') document.title = `${PAGE_TITLES[route.page]} · Seli`;
    // Canonical follows the page (useSEO only runs once, on first load).
    const link = document.querySelector('link[rel="canonical"]');
    if (link) link.href = 'https://seli.app' + (window.location.pathname === '/' ? '' : window.location.pathname);
  }, [route]);
  const page = route.page;
  const isAboutPath = window.location.pathname === '/about';

  const [filings, setFilings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [portfolioTickers, setPortfolioTickers] = useState([]);
  const [showUpgradeModal, setShowUpgradeModal] = useState(null);
  const onUpgrade = useCallback((f) => setShowUpgradeModal(f || 'default'), []);

  // Deeply nested components (the Data page's drawers) open the upgrade modal through this.
  useEffect(() => {
    window.__seliUpgrade = (f) => setShowUpgradeModal(f || 'default');
    return () => { window.__seliUpgrade = null; };
  }, []);

  // /?purchase=data_export lands straight in checkout (from /data-download).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get('purchase');
    if (purchase === 'data_export' || purchase === 'default') {
      setShowUpgradeModal(purchase);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  const [showStaleDataModal, setShowStaleDataModal] = useState(false);

  // Old components still dispatch seli:nav with a page id.
  useEffect(() => {
    function onSeliNav(e) { if (e.detail) go(PAGE_PATHS[e.detail] || '/'); }
    window.addEventListener('seli:nav', onSeliNav);
    return () => window.removeEventListener('seli:nav', onSeliNav);
  }, []);

  // The Data page still works off the client-side filings window. The new
  // pages (home, stock, insider, watchlist) fetch just what they need from
  // the Worker, so this only loads when Data is opened.
  const [filingsWindowDays] = useState(7);
  const needsFilings = page === 'dashboard';
  const filingsRequested = useRef(false);
  function enterApp() { }

  const load = useCallback(async (daysBack) => {
    setLoading(true); setError(null);
    try { const d = await loadFilings(daysBack); setFilings(d); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // Wait for Clerk: on mobile fresh loads the JWT isn't ready at first.
    if (!isLoaded || !isSignedIn || !needsFilings || filingsRequested.current) return;
    filingsRequested.current = true;
    load(filingsWindowDays);
  }, [isLoaded, isSignedIn, needsFilings]); // eslint-disable-line react-hooks/exhaustive-deps


  // Freshness indicator: newest filing date Seli has (from /public/data-stats-
  // independent source: the Data page's filings when loaded, else the feed).
  const [latestFiling, setLatestFiling] = useState(null);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !cfg.NEON_PROXY_URL) return;
    queryNeon(`SELECT MAX(filing_date) AS d FROM public.filings WHERE filing_date <= CURRENT_DATE`)
      .then(r => setLatestFiling(r?.[0]?.d ? String(r[0].d).slice(0, 10) : null))
      .catch(() => { });
  }, [isLoaded, isSignedIn]);
  const lastFilingDate = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const fromFilings = filings.reduce((best, f) => { const d = f.date || f.transactionDate || ''; return d > best ? d : best; }, '');
    const max = [latestFiling || '', fromFilings].sort().pop();
    if (!max) return null;
    return max > today ? today : max;
  }, [filings, latestFiling]);
  const daysSinceLastFiling = useMemo(() => {
    if (!lastFilingDate) return null;
    return Math.floor((new Date() - new Date(lastFilingDate + 'T12:00:00')) / (1000 * 60 * 60 * 24));
  }, [lastFilingDate]);
  // Weekend-aware: Friday's filing is the latest expected on Sat/Sun/Mon morning.
  const dayOfWeek = new Date().getDay();
  const staleThreshold = (dayOfWeek === 0 || dayOfWeek === 1 || dayOfWeek === 6) ? 4 : 2;
  const isDataStale = daysSinceLastFiling != null && daysSinceLastFiling >= staleThreshold;

  // Linked-brokerage tickers (Pro). 403/404 = not Pro / not linked, both expected.
  useEffect(() => {
    if (!cfg.NEON_PROXY_URL || !isSignedIn) return;
    (async () => {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      fetch(`${cfg.NEON_PROXY_URL}/snaptrade/positions`, { method: 'GET', headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d?.accounts) return;
          const tickers = new Set();
          for (const acct of d.accounts) {
            const positions = acct.positions;
            const list = Array.isArray(positions) ? positions
              : (positions && typeof positions === 'object')
                ? (Array.isArray(positions.results) ? positions.results : Object.values(positions).filter(Array.isArray).flat())
                : [];
            for (const p of list) {
              const ticker = p.instrument?.symbol || p.instrument?.raw_symbol;
              if (ticker) tickers.add(ticker);
            }
          }
          setPortfolioTickers([...tickers]);
        })
        .catch(() => { });
    })();
  }, [isSignedIn]);

  // Anything that used to open a panel or drawer now goes to a page.
  const openDetail = useCallback((d) => {
    if (!d) return;
    const ticker = d.ticker || d.trade?.ticker;
    const name = d.name || d.insiderName;
    if ((d.type === 'trader' || d.type === 'insider') && name) go(insiderPath(name));
    else if (ticker) go(stockPath(ticker));
  }, []);

  const watchlist = useWatchlist(user);
  const [alertsMaster, setAlertsMaster] = useState(null);

  // ── First-run onboarding redirect ─────────────────────────────────────
  // Accounts created in the last 7 days that haven't finished or skipped
  // onboarding get sent there once. "Done" is remembered locally and via
  // onboarded_at from GET /prefs. Any doubt means no redirect.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user?.id) return;
    const p = window.location.pathname;
    if (p === '/onboard' || window.location.search.includes('purchase=')) return;
    if (STANDALONE_PATHS.includes(p) || p.startsWith('/blog')) return;
    const flag = `seli_onboarded_${user.id}`;
    try { if (localStorage.getItem(flag)) return; } catch { }
    const created = user.createdAt ? new Date(user.createdAt).getTime() : 0;
    if (!created || Date.now() - created > 7 * 24 * 3600 * 1000) {
      try { localStorage.setItem(flag, '1'); } catch { }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.prefs?.onboarded_at) { try { localStorage.setItem(flag, '1'); } catch { } return; }
        go('/onboard', { replace: true });
      } catch { }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, user?.id]);
  function finishOnboarding() {
    try { if (user?.id) localStorage.setItem(`seli_onboarded_${user.id}`, '1'); } catch { }
    go('/', { replace: true });
  }

  // Same-day alert master switch (for the Watchlist page's "alerts are off" note).
  useEffect(() => {
    if (!isSignedIn || !billingPro || !cfg.NEON_PROXY_URL || page !== 'watchlist') return;
    (async () => {
      try {
        const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs`, { headers: await getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setAlertsMaster(!!(data.prefs?.instant_watchlist_ticker || data.prefs?.instant_followed_insider));
      } catch { }
    })();
  }, [isSignedIn, billingPro, page]);

  // ── Standalone pages ──────────────────────────────────────────────────────
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path === '/terms') return <TermsPage />;
  if (path === '/privacy') return <PrivacyPage />;
  if (path === '/cookies') return <CookiePage />;
  if (path === '/help') return <HelpCenterPage />;
  if (path === '/blog' || path.startsWith('/blog/')) return <BlogPage dark={dark} setDark={setDark} />;
  if (path === '/data-download') return <DataDownloadPage />;
  if (path === '/purchase-complete') return <PurchaseCompletePage />;
  if (path === '/redownload') return <RedownloadPage />;

  if (!isLoaded) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" style={{ width: 32, height: 32 }} />
    </div>
  );

  if (showLanding || isAboutPath) return <LandingPage onEnter={enterApp} dark={dark} setDark={setDark} isLoaded={isLoaded} />;

  if (path === '/onboard') {
    return <OnboardingFlow user={user} watchlist={watchlist} pro={billingPro} onComplete={finishOnboarding} onSkip={finishOnboarding} />;
  }

  return (
    <>
      {isDataStale && !error && (
        <button className="stale-banner" onClick={() => setShowStaleDataModal(true)}>
          <IconWarning style={{ width: 14, height: 14 }} />
          Live data isn't updating right now — tap for details
        </button>
      )}
      {error && page === 'dashboard' && (
        <div className="stale-banner stale-banner--error" role="alert">
          <IconWarning style={{ width: 14, height: 14 }} />
          <span>Failed to load filing data. <button className="stale-banner__retry" onClick={() => load(filingsWindowDays)}>Retry</button></span>
        </div>
      )}
      {showStaleDataModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowStaleDataModal(false); }}>
          <div className="modal-panel stale-modal">
            <div className="modal-panel__hdr">
              <span className="modal-panel__title">Data isn't updating</span>
              <button className="modal-close" onClick={() => setShowStaleDataModal(false)} title="Close (Esc)"><IconClose style={{ width: 12, height: 12 }} /></button>
            </div>
            <div className="modal-body stale-modal__body">
              <p>Live filing data hasn't updated in a few days. We're aware and working on it.</p>
              <p className="stale-modal__timestamp">
                Last new filing: <strong>{lastFilingDate ? fmt.dateShort(lastFilingDate) : 'unknown'}</strong>
                {daysSinceLastFiling != null && ` (${daysSinceLastFiling} day${daysSinceLastFiling === 1 ? '' : 's'} ago)`}
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="ws-shell">
        <TopNav page={page} user={user} dark={dark} setDark={setDark} lastFilingDate={lastFilingDate} isDataStale={isDataStale} />
        <main className="ws-main" ref={mainRef}>
          {page === 'home' && <HomeFeed watchlist={watchlist} portfolioTickers={portfolioTickers} user={user} />}
          {page === 'stock' && <StockPage key={route.ticker} ticker={route.ticker} watchlist={watchlist} onUpgrade={onUpgrade}
            renderProfile={(t, cik, company) => <CompanyProfileCard ticker={t} cik={cik} company={company} />} />}
          {page === 'insider' && <InsiderPage key={route.raw} raw={route.raw} watchlist={watchlist} onUpgrade={onUpgrade} />}
          {page === 'dashboard' && <DashboardPage filings={filings} loading={loading} onDrillSignal={openDetail} onOpenDetail={openDetail} watchlist={watchlist} user={user} onUpgrade={onUpgrade} />}
          {page === 'leaderboard' && <LeaderboardPage fetchLeaderboard={fetchLeaderboard} pro={billingPro} onUpgrade={onUpgrade} />}
          {page === 'watchlist' && <WatchlistPage watchlist={watchlist} portfolioTickers={billingPro ? portfolioTickers : []} onUpgrade={onUpgrade} alertsMasterOn={alertsMaster} />}
          {page === 'account' && <AccountPage user={user} onUpgrade={onUpgrade} dark={dark} setDark={setDark} />}
        </main>
        <footer className="ws-footer">
          <span>Private Beta · Not financial advice.</span>
          <a href="/help" target="_blank" rel="noreferrer">Help</a>
          <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
          <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
        </footer>
        {watchlist.showUpgrade && <UpgradeModal feature={watchlist.showUpgrade} pro={billingPro} onClose={() => watchlist.setShowUpgrade(null)} />}
        {showUpgradeModal && <UpgradeModal feature={showUpgradeModal} pro={billingPro} onClose={() => setShowUpgradeModal(null)} />}
      </div>
    </>
  );
}

// Sentry.init at module level — runs once, on import, before AppInner ever
// renders. Ideally this lives in a separate entry file that runs before
// React even starts, but this project's actual mounting file isn't
// something I have access to from this conversation; module-level code
// here still runs before any component renders, so this achieves the same
// effect without needing to touch a file I can't see or verify.
// Safe to call even if VITE_SENTRY_DSN isn't set yet — Sentry's own SDK
// no-ops on an empty/undefined dsn rather than throwing, the same
// graceful-degradation behavior relied on for the Worker side.
Sentry.init({
  dsn: cfg.SENTRY_DSN || '',
  tracesSampleRate: 0.1, // matches the Worker's own sampling rate — errors are always captured regardless of this number, it only controls trace/performance-data volume
});

function AppErrorFallback({ error }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
      textAlign: 'center', fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Something went wrong.</div>
      <div style={{ fontSize: 14, color: '#6B7280', maxWidth: 400 }}>
        We've been notified and are looking into it. Refreshing the page usually fixes this.
      </div>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: '#5A4FE8', color: '#fff', fontWeight: 600, fontSize: 13,
        }}
      >
        Reload
      </button>
    </div>
  );
}

// The actual export — every consumer of this module (the real mounting
// file, whatever it imports App as) gets the boundary-wrapped version
// automatically, with no change needed on that file's end. A crash
// anywhere in AppInner's tree now shows this fallback instead of a blank
// white screen, and gets reported to Sentry automatically since
// Sentry.ErrorBoundary reports what it catches on its own.
// ── SEO: dynamic canonical URL + page title per route ─────────────────────
// Without this, every SPA route serves the same static <link rel="canonical">
// from index.html, which tells Google "every page is a duplicate of the
// homepage." This sets it correctly per route so /about, /data-download, etc.
// get indexed as separate pages.
const SEO_TITLES = {
  '/': 'Seli — Know When Insiders Move | SEC Form 4 & Congressional Stock Trades',
  '/about': 'How Insider Trades Beat the Market | Research & Methodology — Seli',
  '/data-download': 'Download SEC Insider Trading Data (CSV) | 10+ Years of Form 4 Filings — Seli',
  '/terms': 'Terms of Service — Seli',
  '/privacy': 'Privacy Policy — Seli',
  '/cookies': 'Cookie Policy — Seli',
  '/help': 'Help Center — Seli',
  '/data': 'Insider Trading Signals & Raw SEC Filings | Market Data — Seli',
  '/insights': 'Top Insider Traders Ranked by Performance | Leaderboard — Seli',
  '/home': 'Seli — Know When Insiders Move | SEC Form 4 & Congressional Stock Trades',
  '/blog': 'Seli Blog — Insider Trading Intelligence, SEC Form 4 Analysis & Market Signals',
  '/onboard': 'Get Started — Seli',
};
const SEO_DESCRIPTIONS = {
  '/': 'Track SEC Form 4 insider trades and congressional stock disclosures in real time. Scored by conviction, with instant alerts and portfolio integration. Free to start.',
  '/about': 'The peer-reviewed research behind insider trading signals. How corporate insider buying outperforms the market by 4-5% annually, and how Seli scores each trade using findings from Seyhun, Lakonishok & Lee, and Cohen et al.',
  '/data-download': 'Download the complete SEC Form 4 insider trading dataset. 10+ years of corporate executive trades as structured CSV. One-time purchase, $39.99. Works with Excel, Python, R.',
  '/data': 'Live feed of SEC Form 4 insider trades scored by conviction. Filter by sector, type, role, and date. Export to CSV.',
  '/insiders': 'See which corporate insiders have the best track records. Ranked by hit rate, average return, and proxy score across 10+ years of open-market trades.',
  '/blog': 'Research, analysis, and strategy for tracking SEC Form 4 insider trades. Conviction scoring, cluster detection, congressional trade tracking, and dataset guides.',
  '/onboard': 'Interactive onboarding guide for Seli. Learn how insider trading signals work, build your watchlist, and set up alerts.',
};

function useSEO() {
  React.useEffect(() => {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const origin = 'https://seli.app';
    const url = `${origin}${path === '/' ? '' : path}`;
    const title = SEO_TITLES[path] || 'Seli — Insider Trading Intelligence';
    const desc = SEO_DESCRIPTIONS[path] || SEO_DESCRIPTIONS['/'];

    // Canonical
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) { link = document.createElement('link'); link.rel = 'canonical'; document.head.appendChild(link); }
    link.href = url;

    // Title
    document.title = title;

    // Meta description
    setMeta('description', desc);

    // Open Graph
    setMeta('og:title', title, 'property');
    setMeta('og:description', desc, 'property');
    setMeta('og:url', url, 'property');
    setMeta('og:type', 'website', 'property');
    setMeta('og:site_name', 'Seli', 'property');
    setMeta('og:image', `${origin}/og-image.png`, 'property');

    // Twitter Card
    setMeta('twitter:card', 'summary_large_image');
    setMeta('twitter:title', title);
    setMeta('twitter:description', desc);
    setMeta('twitter:image', `${origin}/og-image.png`);

    // JSON-LD structured data — WebApplication + Organization
    let script = document.querySelector('script[data-seli-jsonld]');
    if (!script) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-seli-jsonld', '');
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Seli',
      url: origin,
      description: SEO_DESCRIPTIONS['/'],
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      offers: [
        { '@type': 'Offer', price: '0', priceCurrency: 'USD', name: 'Free', description: 'Every stock and insider page, 12 months of trades, weekly digest' },
        { '@type': 'Offer', price: '6.99', priceCurrency: 'USD', name: 'Pro', description: 'Full history, alerts, portfolio linking', priceSpecification: { '@type': 'UnitPriceSpecification', billingDuration: 'P1M' } },
        { '@type': 'Offer', price: '39.99', priceCurrency: 'USD', name: 'Data Export', description: 'Complete SEC Form 4 dataset as CSV' },
      ],
      creator: { '@type': 'Organization', name: 'Seli', url: origin },
    });
  }, []);
}

function setMeta(nameOrProp, content, attr = 'name') {
  let el = document.querySelector(`meta[${attr}="${nameOrProp}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, nameOrProp); document.head.appendChild(el); }
  el.content = content;
}

export default function App() {
  useSEO();
  return (
    <Sentry.ErrorBoundary fallback={AppErrorFallback}>
      <BillingProvider>
        <AppInner />
      </BillingProvider>
    </Sentry.ErrorBoundary>
  );
}

