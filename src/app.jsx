import React, { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';
import logoSimple from './assets/logo-simple.png';
import { isPro, buildSignals, processLeaderboardRows, RISK_APPETITE_THRESHOLDS, RISK_APPETITE_LABELS, tierFromPct, filterAndScoreSignals } from './lib/scoring.js';
import { fmt } from './lib/format.js';
import { useAuth, useUser, SignInButton, SignedIn, SignedOut, UserButton } from '@clerk/clerk-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import XLSX from 'xlsx-js-style'; // npm install xlsx-js-style — same API as plain xlsx, but plain xlsx silently drops cell styles (bold etc.) since that's a Pro-only feature there. Default import, not named — this package exports CommonJS-style.
// src/app.jsx — Seli — insider trading intelligence platform
// const { useState, useEffect, useMemo, useCallback, useRef } = React;
import cfg from './config.js';
import { loadFilings, computeSignals, getSector, REL_LABELS } from './edgar.js';

// ─── Utilities ────────────────────────────────────────────────────────────────
// (fmt now lives in src/lib/format.js — imported above — with real test
// coverage for the exact date-parsing bug class that hit three times this
// session, rather than living inline and untested here.)

// ─── Company profile cache & hooks ───────────────────────────────────────────
// Module-level cache so the same ticker only hits Finnhub once per page load.
const _profileCache = {};
const _descCache    = {};

async function fetchCompanyProfile(ticker) {
  if (_profileCache[ticker]) return _profileCache[ticker];
  if (!cfg.FINNHUB_API_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${cfg.FINNHUB_API_KEY}`);
    const d = await r.json();
    _profileCache[ticker] = (d && d.name) ? d : null;
    return _profileCache[ticker];
  } catch { return null; }
}

async function fetchCompanyMetrics(ticker) {
  if (!cfg.FINNHUB_API_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${cfg.FINNHUB_API_KEY}`);
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
      const padded = String(cik).replace(/^0+/,'').padStart(10,'0');
      const r = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
        headers: {'User-Agent': 'Seli research@seli.app'}
      });
      if (r.ok) {
        const d = await r.json();
        const desc = d?.description || null;
        _descCache[key] = desc;
        return desc;
      }
    }
  } catch {}
  _descCache[key] = null;
  return null;
}

// React hook — fetches profile + metrics + description for a ticker, returns
// loading state and the combined data object.
function useCompanyProfile(ticker, cik) {
  const [profile, setProfile]   = useState(null);
  const [metrics, setMetrics]   = useState(null);
  const [desc,    setDesc]      = useState(null);
  const [loading, setLoading]   = useState(true);
  useEffect(()=>{
    if (!ticker) { setLoading(false); return; }
    setLoading(true); setProfile(null); setMetrics(null); setDesc(null);
    Promise.all([
      fetchCompanyProfile(ticker),
      fetchCompanyMetrics(ticker),
      fetchCompanyDescription(ticker, cik),
    ]).then(([p,m,d])=>{
      setProfile(p); setMetrics(m); setDesc(d); setLoading(false);
    }).catch(()=>setLoading(false));
  },[ticker, cik]);
  return { profile, metrics, desc, loading };
}

// ─── Watchlist utilities ──────────────────────────────────────────────────────
// Stored in localStorage as a JSON array of ticker strings.
// No auth needed — entirely client-side.
// ─── Pro plan check ───────────────────────────────────────────────────────────
// plan and hasDataExport are written into Clerk publicMetadata by the Stripe
// webhook in neon-proxy.js — Neon is the real source of truth, this is just
// a fast client-side read of what the webhook already confirmed server-side.
// (isPro / hasDataExport now live in src/lib/scoring.js — imported above —
// so the same logic under test is the same logic actually running.)

// ─── Upgrade modal ────────────────────────────────────────────────────────────
// Shown when a free user tries to use a Pro feature.
// Comparison-table style, matching the reference layout's structure:
// logo, title, Free/Pro feature comparison, a plan selector, one CTA.
// Deliberately NOT including a fake testimonial/star-rating like the
// reference had — Seli doesn't have real customer reviews yet, and
// fabricating one would be dishonest. That visual slot is an honest
// trust line instead.
function UpgradeModal({ feature, pro, onClose }) {
  useEffect(()=>{
    const h = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  },[onClose]);

  const [checkoutProduct, setCheckoutProduct] = useState(null); // null | 'pro' | 'data_export'
  const [plan, setPlan] = useState(feature==='data_export' ? 'data_export' : 'pro'); // which card is selected in the picker
  const [statusModal, setStatusModal] = useState(null);
  const [processing, setProcessing] = useState(false); // true for the gap between payment succeeding and the confirmation being ready
  const [progressText, setProgressText] = useState(null); // live row-count updates during a large export

  // Personalized per the specific action that triggered this modal — a
  // generic "Upgrade to Pro" doesn't tell someone what they were actually
  // trying to do when they hit the wall, which is what actually motivates
  // the upgrade in the moment.
  const FEATURE_MESSAGES = {
    watchlist_ticker:  'Upgrade to Pro to track unlimited tickers and get notified the moment insiders trade them.',
    watchlist_insider: 'Upgrade to Pro to follow specific insiders and get notified on their trades.',
    notifications:      'Upgrade to Pro for email digests and instant alerts on the activity you care about.',
    portfolio:           'Upgrade to Pro to connect your brokerage and see insider activity on your real holdings.',
    data_export:         'Get a one-time CSV export of the full historical dataset — no subscription required.',
    full_history:        'Upgrade to Pro for full historical data — the free plan shows the last 12 months.',
    default:             'Full insider data, real-time alerts, and your own portfolio — in one view.',
  };
  const subtitle = FEATURE_MESSAGES[feature] || FEATURE_MESSAGES.default;

  const COMPARISON = [
    { label: 'Live dashboard & signals',  free: true,  pro: true },
    { label: 'Full historical data',      free: false, pro: true },
    { label: 'Portfolio linking',         free: false, pro: true },
    { label: 'Instant alerts',            free: false, pro: true },
  ];

  if (processing) {
    return <ProcessingModal text={progressText || (checkoutProduct==='pro' ? 'Setting up your subscription…' : 'Finalizing your purchase…')}/>;
  }

  if (statusModal) {
    return (
      <StatusModal
        title={statusModal.title}
        message={statusModal.message}
        onClose={()=>{ setStatusModal(null); onClose(); }}
      />
    );
  }

  if (checkoutProduct) {
    return (
      <CheckoutModal
        product={checkoutProduct}
        onClose={() => setCheckoutProduct(null)}
        onSuccess={async ()=>{
          const wasPro = checkoutProduct === 'pro';
          setProcessing(true);
          if (wasPro) {
            setCheckoutProduct(null);
            setProcessing(false);
            setStatusModal({ title: "You're a Pro member!", message: 'Full historical data, portfolio linking, and instant alerts are all unlocked now.' });
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
            setStatusModal({ title: 'Export started', message: 'Your download should begin automatically. Lost the file later? Re-download it anytime from Settings > Billing — no extra charge.' });
          } catch (e) {
            setCheckoutProduct(null);
            setProcessing(false);
            setProgressText(null);
            setStatusModal({ title: 'Purchase complete — download failed', message: `Your payment went through, but the download itself hit an error (${e.message}). Your purchase is saved — head to Settings > Billing and click "Re-download" to get your file, no extra charge.` });
          }
        }}
      />
    );
  }

  // Already-Pro users hitting the data-export wall don't need (or want) an
  // "Upgrade to Pro" pitch — they already have Pro, and the export is a
  // separate one-time purchase specifically because it's NOT part of the
  // subscription. A dedicated, single-purpose modal here instead of the
  // dual Free/Pro comparison avoids the confusing experience of being told
  // to upgrade to something you already have.
  if (feature==='data_export' && pro) {
    return (
      <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay'))onClose();}}>
        <div className="upgrade-modal upgrade-modal--export">
          <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{width:12,height:12}}/></button>
          <div className="logo-mark upgrade-modal__logo"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
          <div className="upgrade-modal__title">Buy full data export</div>
          <div className="upgrade-modal__subtitle">A one-time pull of everything currently in the database, delivered as CSV — separate from your Pro subscription.</div>
          <div className="export-price-card">
            <div className="export-price-card__row">
              <span className="export-price-card__label">Data export <span className="upgrade-plan-card__badge">One-time</span></span>
              <span className="export-price-card__price">$39.99</span>
            </div>
            <ul className="export-price-card__features">
              <li><IconCheck style={{width:12,height:12}}/>Every filing currently on record</li>
              <li><IconCheck style={{width:12,height:12}}/>Delivered as CSV, ready to download</li>
              <li><IconCheck style={{width:12,height:12}}/>Re-purchase anytime for a fresh pull</li>
            </ul>
          </div>
          <button className="upgrade-modal__cta" onClick={()=>setCheckoutProduct('data_export')}>Buy Export — $39.99</button>
          <div className="upgrade-modal__trust">
            <span><IconCheck style={{width:11,height:11,marginRight:3,verticalAlign:'-1px'}}/>Secure checkout via Stripe</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay'))onClose();}}>
      <div className="upgrade-modal upgrade-modal--large">
        <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{width:12,height:12}}/></button>

        <div className="logo-mark upgrade-modal__logo"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
        <div className="upgrade-modal__title">Upgrade to Pro</div>
        <div className="upgrade-modal__subtitle">{subtitle}</div>

        <div className="upgrade-modal__table">
          <div className="upgrade-modal__table-header">
            <span/>
            <span>Free</span>
            <span className="upgrade-modal__table-header--pro">Pro</span>
          </div>
          {COMPARISON.map(row=>(
            <div className="upgrade-modal__table-row" key={row.label}>
              <span className="upgrade-modal__table-label">{row.label}</span>
              <span className={row.free?'upgrade-check upgrade-check--yes':'upgrade-check upgrade-check--no'}>{row.free?<IconCheck style={{width:12,height:12}}/>:'–'}</span>
              <span className={row.pro?'upgrade-check upgrade-check--yes':'upgrade-check upgrade-check--no'}>{row.pro?<IconCheck style={{width:12,height:12}}/>:'–'}</span>
            </div>
          ))}
        </div>

        <div className="upgrade-modal__plans">
          <button className={`upgrade-plan-card${plan==='pro'?' upgrade-plan-card--active':''}`} onClick={()=>setPlan('pro')}>
            <span className="upgrade-plan-card__radio"/>
            <span>
              <span className="upgrade-plan-card__title">Pro</span>
              <span className="upgrade-plan-card__price">$11.99/month</span>
            </span>
          </button>
          <button className={`upgrade-plan-card${plan==='data_export'?' upgrade-plan-card--active':''}`} onClick={()=>setPlan('data_export')}>
            <span className="upgrade-plan-card__radio"/>
            <span>
              <span className="upgrade-plan-card__title">Data export <span className="upgrade-plan-card__badge">One-time</span></span>
              <span className="upgrade-plan-card__price">$39.99</span>
            </span>
          </button>
        </div>

        <button className="upgrade-modal__cta" onClick={()=>setCheckoutProduct(plan)}>
          {plan==='pro' ? 'Upgrade Now — $11.99/mo' : 'Buy Export — $39.99'}
        </button>

        <div className="upgrade-modal__trust">
          <span><IconCheck style={{width:11,height:11,marginRight:3,verticalAlign:'-1px'}}/>Secure checkout via Stripe</span>
          <span><IconCheck style={{width:11,height:11,marginRight:3,verticalAlign:'-1px'}}/>Cancel anytime</span>
        </div>
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
    title: 'Upgrade to Pro', price: '$11.99/month', endpoint: '/billing/create-subscription',
    subtitle: 'Full insider data, real-time alerts, and your own portfolio — in one view.',
    features: ['Full historical data', 'Portfolio linking', 'Instant alerts'],
  },
  data_export: {
    title: 'Buy full data export', price: '$39.99 one-time', endpoint: '/billing/create-data-purchase',
    subtitle: 'A one-time pull of everything currently in the database.',
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
function ProcessingModal({ text='Finishing up…' }) {
  return (
    <div className="upgrade-overlay">
      <div className="upgrade-modal" style={{maxWidth:300,textAlign:'center'}}>
        <div className="processing-dots"><span/><span/><span/></div>
        <p style={{fontSize:13,color:'var(--text-2)',marginTop:16}}>{text}</p>
      </div>
    </div>
  );
}

// ─── Status modal — reusable success/confirmation pattern ─────────────────────
function StatusModal({ title, message, onClose }) {
  return (
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay'))onClose();}}>
      <div className="upgrade-modal" style={{maxWidth:340,textAlign:'center'}}>
        <div className="status-modal__icon"><IconCheck style={{width:20,height:20}}/></div>
        <div className="upgrade-modal__title" style={{marginTop:14}}>{title}</div>
        <p style={{fontSize:13,color:'var(--text-2)',lineHeight:1.5,margin:'8px 0 20px'}}>{message}</p>
        <button className="upgrade-modal__cta" style={{margin:0}} onClick={onClose}>Done</button>
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
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay'))onClose();}}>
      <div className="checkout-modal checkout-modal--landscape">
        <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{width:12,height:12}}/></button>

        {/* Left — product info, stays constant regardless of payment state */}
        <div className="checkout-modal__info">
          <div className="checkout-modal__info-title">{copy.title}</div>
          <div className="checkout-modal__info-price">{copy.price}</div>
          <p className="checkout-modal__info-subtitle">{copy.subtitle}</p>
          <ul className="checkout-modal__features">
            {copy.features.map(f=>(
              <li key={f}><IconCheck style={{width:12,height:12}}/>{f}</li>
            ))}
          </ul>
          <div className="checkout-modal__trust">
            <IconCheck style={{width:11,height:11,marginRight:3,verticalAlign:'-1px'}}/>Secure checkout via Stripe
          </div>
        </div>

        {/* Right — payment form */}
        <div className="checkout-modal__pay">
          {error && <div className="checkout-error">{error} — <button className="checkout-retry" onClick={onClose}>close and try again</button></div>}

          {!error && !reactivating && !clientSecret && (
            <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div>
          )}

          {!error && reactivating && (
            <div style={{padding:'2rem',display:'flex',flexDirection:'column',alignItems:'center',gap:10}}>
              <Spinner/>
              <p style={{fontSize:12,color:'var(--text-2)'}}>Reactivating your subscription…</p>
            </div>
          )}

          {!error && !reactivating && clientSecret && (
            <Elements stripe={getStripePromise()} options={{ clientSecret }}>
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
        style={{marginTop:16}}
      >
        {submitting ? 'Processing…' : syncing ? 'Confirming…' : (product === 'pro' ? 'Subscribe' : 'Buy export')}
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
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay') && !busy)onClose();}}>
      <div className="upgrade-modal" style={{maxWidth:380}}>
        <div className="upgrade-modal__title">Are you sure?</div>
        <p style={{fontSize:13,color:'var(--text-2)',lineHeight:1.5,margin:'8px 0 16px',textAlign:'left'}}>
          You'll keep Pro access until the end of your current billing period — this doesn't cancel immediately.
        </p>
        <label style={{display:'block',textAlign:'left',fontSize:11.5,fontWeight:600,color:'var(--text-3)',marginBottom:6,textTransform:'uppercase',letterSpacing:'0.3px'}}>
          Want to leave feedback? (optional)
        </label>
        <textarea
          className="cancel-feedback-input"
          placeholder="What made you decide to cancel?"
          value={feedback}
          onChange={e=>setFeedback(e.target.value)}
          disabled={busy}
          rows={3}
        />
        <div style={{display:'flex',gap:10,marginTop:16}}>
          <button className="btn btn--ghost" style={{flex:1}} onClick={onClose} disabled={busy}>Go back</button>
          <button className="settings-danger-btn" style={{flex:1}} onClick={()=>onConfirm(feedback)} disabled={busy}>
            {busy ? 'Working…' : 'Unsubscribe'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Billing section (Settings tab) ────────────────────────────────────────────
function BillingSection({ user }) {
  const [status, setStatus]   = useState(null);
  const [loadErr, setLoadErr] = useState(null); // distinct from "no data" — see audit note
  const [busy, setBusy]       = useState(false);
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
  if (!status) return <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div>;

  const isProPlan = status.plan === 'pro' && (status.status === 'active' || status.status === 'trialing');
  const dataExports = status.dataExports || [];

  return (
    <>
      <div className="settings-group">
        <div className="settings-group__label">Current plan</div>
        <div className="settings-row settings-row--toggle">
          <div>
            <div className="settings-row__label">{isProPlan ? 'Pro — $11.99/month' : 'Free'}</div>
          </div>
          {!isProPlan && (
            <button className="btn btn--primary" onClick={()=>setCheckoutProduct('pro')}>Upgrade →</button>
          )}
          {isProPlan && !status.cancel_at_period_end && (
            <button className="settings-danger-btn" disabled={busy} onClick={()=>setConfirmCancel(true)}>
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
                <span className="settings-subsection__dot settings-subsection__dot--warn"/>
                Canceled — Pro access stays active until{' '}
                <strong>{new Date(status.current_period_end).toLocaleDateString()}</strong>.
                Changed your mind? <button className="settings-inline-link" disabled={busy} onClick={handleReactivate}>Reactivate</button>
              </>
            ) : (
              <>
                <span className="settings-subsection__dot settings-subsection__dot--ok"/>
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
          <button className="btn btn--primary" onClick={()=>setCheckoutProduct('data_export')}>
            {status.hasDataExport ? 'Buy again' : 'Buy →'}
          </button>
        </div>

        {/* Full purchase history, per the request — not just a yes/no flag. */}
        {dataExports.length > 0 && (
          <div className="settings-group" style={{marginTop:14}}>
            <div className="settings-group__label">Export history</div>
            {dataExports.map((p, i) => (
              <div key={i} className="settings-row settings-row--toggle">
                <div>
                  <div className="settings-row__label">
                    {new Date(p.purchased_at).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'})}
                  </div>
                  <div className="settings-row__sub">${(p.amount_cents/100).toFixed(2)}</div>
                </div>
                <button className="btn btn--ghost btn--sm" disabled={redownloadingIdx!=null} onClick={()=>handleRedownload(i, p.stripe_payment_intent_id)}>
                  {redownloadingIdx===i ? (progressText || 'Downloading…') : 'Re-download'}
                </button>
              </div>
            ))}
            {redownloadErr && <div className="checkout-error" style={{margin:'10px 16px'}}>{redownloadErr}</div>}
            <div className="td-muted" style={{fontSize:11,padding:'10px 16px'}}>
              Re-download gives you the data as it stood on this purchase's date — not anything newer added since.
            </div>
          </div>
        )}
      </div>

      {actionErr && <div className="checkout-error">{actionErr}</div>}

      {confirmCancel && (
        <CancelModal
          busy={busy}
          onConfirm={handleCancel}
          onClose={()=>setConfirmCancel(false)}
        />
      )}

      {processing && <ProcessingModal text={progressText || (checkoutProduct==='pro' ? 'Setting up your subscription…' : 'Finalizing your purchase…')}/>}

      {statusModal && (
        <StatusModal
          title={statusModal.title}
          message={statusModal.message}
          onClose={()=>setStatusModal(null)}
        />
      )}

      {checkoutProduct && !processing && (
        <CheckoutModal
          product={checkoutProduct}
          onClose={()=>setCheckoutProduct(null)}
          onSuccess={async ()=>{
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
              setStatusModal({ title: "You're a Pro member!", message: 'Full historical data, portfolio linking, and instant alerts are all unlocked now.' });
              return;
            }
            load();
            try {
              await downloadCSVFromR2('consume', msg => setProgressText(msg));
              setCheckoutProduct(null);
              setProcessing(false);
              setProgressText(null);
              setStatusModal({ title: 'Export started', message: 'Your download should begin automatically. Lost the file later? Re-download it anytime from Settings > Billing — no extra charge.' });
            } catch (e) {
              setCheckoutProduct(null);
              setProcessing(false);
              setProgressText(null);
              setStatusModal({ title: 'Purchase complete — download failed', message: `Your payment went through, but the download itself hit an error (${e.message}). Your purchase is saved — head to Settings > Billing and click "Re-download" to get your file, no extra charge.` });
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

function wlGet(key=WL_KEY) { try { return JSON.parse(localStorage.getItem(key)||'[]'); } catch { return []; } }
function wlSet(items, key=WL_KEY) { try { localStorage.setItem(key, JSON.stringify(items)); } catch {} }

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
    }
  } catch (e) {
    console.error('[watchlist] mutate request failed:', e.message);
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

function useWatchlist(user) {
  const pro = isPro(user);
  const [tickers,  setTickers]  = useState(()=> pro ? wlGet(WL_KEY)        : []);
  const [insiders, setInsiders] = useState(()=> pro ? wlGet(WL_INSIDER_KEY) : []);
  const [showUpgrade, setShowUpgrade] = useState(null); // null | 'watchlist_ticker' | 'watchlist_insider'

  // Load from Neon on mount for Pro users
  useEffect(()=>{
    if (!pro || !user) return;
    neonWatchlistLoad().then(items=>{
      if (!items) return;
      const t = items.filter(i=>i.item_type==='ticker').map(i=>i.item_value);
      const ins = items.filter(i=>i.item_type==='insider').map(i=>i.item_value);
      if (t.length)   { wlSet(t, WL_KEY);           setTickers(t); }
      if (ins.length) { wlSet(ins, WL_INSIDER_KEY);  setInsiders(ins); }
    });
  },[pro, user?.id]);

  // Toggle ticker
  const toggleTicker = useCallback((ticker) => {
    if (!pro) { setShowUpgrade('watchlist_ticker'); return; }
    setTickers(prev => {
      const next = prev.includes(ticker) ? prev.filter(t=>t!==ticker) : [...prev, ticker];
      wlSet(next, WL_KEY);
      neonWatchlistMutate('ticker', ticker, prev.includes(ticker) ? 'remove' : 'add');
      return next;
    });
  }, [pro]);

  // Toggle insider
  const toggleInsider = useCallback((name) => {
    if (!pro) { setShowUpgrade('watchlist_insider'); return; }
    setInsiders(prev => {
      const next = prev.includes(name) ? prev.filter(n=>n!==name) : [...prev, name];
      wlSet(next, WL_INSIDER_KEY);
      neonWatchlistMutate('insider', name, prev.includes(name) ? 'remove' : 'add');
      return next;
    });
  }, [pro]);

  const hasTicker  = useCallback((ticker) => tickers.includes(ticker),  [tickers]);
  const hasInsider = useCallback((name)   => insiders.includes(name),   [insiders]);

  // Legacy compat — existing code calls watchlist.toggle(ticker) and watchlist.has(ticker)
  const toggle = toggleTicker;
  const has    = hasTicker;

  return {
    tickers, insiders, toggle, has,
    toggleTicker, toggleInsider, hasTicker, hasInsider,
    showUpgrade, setShowUpgrade, pro,
  };
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function useTheme() {
  const [dark, setDark] = useState(() => {
    try { const s = localStorage.getItem('theme'); if (s) return s==='dark'; } catch(_){}
    // Default every new visitor to dark — Seli's primary identity — instead
    // of following the OS-level color-scheme preference. Only an explicit
    // in-app toggle (saved to localStorage above) switches this.
    return true;
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark?'dark':'light');
    try { localStorage.setItem('theme', dark?'dark':'light'); } catch(_){}
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
const RiskAppetiteContext = React.createContext([3, ()=>{}]);

// ─── Atoms ────────────────────────────────────────────────────────────────────
function Badge({ type, children }) {
  return <span className={`badge badge--${type}`}>{children}</span>;
}
function Spinner({ size=22 }) {
  return <div className="spinner" style={{width:size,height:size}}/>;
}
const TX_CODE_TOOLTIPS = {
  P:'Open market purchase',
  S:'Open market sale',
  A:'New shares granted to the insider as compensation — not purchased with their own money',
  M:'Insider exercised stock options they already held — not a new open-market purchase',
  J:'Shares moved between accounts or entities — not a market purchase or sale',
  G:'Shares given or received as a gift — no cash changed hands',
  F:'Shares withheld by the company to cover taxes owed when equity vested — not a discretionary sale',
  C:'A derivative security (option/warrant) converted into common stock',
  D:'Shares sold back to the company itself, not on the open market',
  E:'An option or right expired unused — no shares bought or sold',
  // Congressional PTRs (STOCK Act filings) never had an entry here, so
  // every one fell through to the raw code (codeLabel = TX_CODE_TOOLTIPS[code]||code)
  // — that's what was rendering as a bare "CONGRESS_S"/"CONGRESS_P" string
  // with no label above it in the trade detail rows. These report a dollar
  // RANGE, not an exact price, which is exactly why there's no price to
  // show — the label now says that instead of leaving the raw code visible.
  CONGRESS_P:'Congressional purchase — reported as a dollar range, not an exact price',
  CONGRESS_S:'Congressional sale — reported as a dollar range, not an exact price',
};

// Short, self-explanatory labels for the Data table — replaces the bare
// single-letter SEC code, which was only ever explained via a hover tooltip
// (invisible on touch devices, no visual cue that a tooltip even exists).
// Full explanation is still available on hover via TX_CODE_TOOLTIPS above.
const TX_CODE_SHORT = {
  P:'Buy (OM)',    S:'Sell (OM)',
  A:'Award',       M:'Exercise',
  J:'Transfer',    G:'Gift',
  F:'Tax w/h',      C:'Conversion',
  D:'To issuer',   E:'Expired',
  CONGRESS_P:'Buy (range)', CONGRESS_S:'Sell (range)',
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
function ConvictionBar({ score, max=15, showLabel=false }) {
  const [appetite] = React.useContext(RiskAppetiteContext);
  const pct = Math.min((score/max)*100, 100);
  const tier = tierFromPct(pct, appetite);
  const label = tier==='high'?'High':tier==='medium'?'Medium':'Low';
  const color = tier==='high'?'var(--green-600)':tier==='medium'?'var(--amber-600)':'var(--text-3)';
  const t = RISK_APPETITE_THRESHOLDS[appetite] || RISK_APPETITE_THRESHOLDS[3];
  // Only show label text when it's NOT High — color already communicates High,
  // but Low/Medium are warnings worth surfacing explicitly.
  const showText = showLabel && label !== 'High';
  return (
    <div className="conv-bar-wrap" title={`Conviction: ${label} (${score.toFixed(1)}/${max}) — combines exec participation, position size, and insider clustering`}>
      <div className="conv-bar-track">
        <div className="conv-bar-tick" style={{left:`${t.medium}%`}}/>
        <div className="conv-bar-tick" style={{left:`${t.high}%`}}/>
        <div className="conv-bar" style={{width:`${pct}%`,background:color}}/>
      </div>
      {showText&&<span className="conv-bar-label" style={{color}}>{label}</span>}
    </div>
  );
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────
// ─── Sidebar icon set ───────────────────────────────────────────────────────
// Outlined / 2px stroke / rounded corners, per the brand guide. Standard,
// widely-recognized icon shapes (same convention as Feather/Lucide) rather
// than inventing new ones — familiarity matters more than novelty here.
const ICON_PROPS = { viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:2, strokeLinecap:'round', strokeLinejoin:'round' };
function IconHome(p)      { return <svg {...ICON_PROPS} {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>; }
function IconInsights(p)  { return <svg {...ICON_PROPS} {...p}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>; }
function IconData(p)      { return <svg {...ICON_PROPS} {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>; }
function IconFavorites(p) { return <svg {...ICON_PROPS} {...p}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>; }
function IconSettings(p)  { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>; }
// "More" — mobile-only nav icon, opens the sheet holding everything that
// doesn't fit in the 2-icon mobile bar (Dashboard/Insights/Data/Watchlist/
// Settings). Standard horizontal-ellipsis "more" glyph.
function IconMore(p) { return <svg {...ICON_PROPS} {...p}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>; }
function IconHelp(p)      { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function IconSun(p)       { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>; }
function IconMoon(p)      { return <svg {...ICON_PROPS} {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>; }
function IconReversal(p)  { return <svg {...ICON_PROPS} {...p}><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>; }
function IconClose(p)     { return <svg {...ICON_PROPS} {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function IconCheck(p)      { return <svg {...ICON_PROPS} {...p}><polyline points="20 6 9 17 4 12"/></svg>; }
function IconWarning(p)    { return <svg {...ICON_PROPS} {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function IconBuyTri(p)     { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 4 21 19 3 19" fill="currentColor"/></svg>; }
function IconSellTri(p)    { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 20 3 5 21 5" fill="currentColor"/></svg>; }
function IconEmpty(p)      { return <svg {...ICON_PROPS} {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>; }
function IconMail(p)       { return <svg {...ICON_PROPS} {...p}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>; }
function IconMessage(p)    { return <svg {...ICON_PROPS} {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>; }
function IconLink(p)       { return <svg {...ICON_PROPS} {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>; }
function IconZap(p)        { return <svg {...ICON_PROPS} {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>; }
// Added for the Guide modal — 'raw-data' and 'using-seli' were previously
// reusing IconData and IconHome (already used by 'data-source' and
// 'welcome'), so two pairs of sections were visually identical in the nav,
// especially on the mobile layout where the label text is hidden and the
// icon is the only real way to tell sections apart.
function IconList(p)       { return <svg {...ICON_PROPS} {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>; }
function IconCompass(p)    { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>; }

const NAV = [
  {id:'dashboard', Icon:IconHome,      label:'Dashboard'},
  {id:'signals',   Icon:IconInsights,  label:'Insights'},
  {id:'data',      Icon:IconData,      label:'Data'},
  {id:'watchlist', Icon:IconFavorites, label:'Watchlist'},
];
function Sidebar({ page, setPage, dark, setDark, user, onUpgrade }) {
  const pro = isPro(user);
  const isMobile = useIsMobile();

  if (isMobile) {
    // All five real destinations shown directly — Home (replacing
    // Dashboard as the mobile landing page) plus Insights/Data/Watchlist/
    // Settings. A "More" sheet collapsing this to 2 icons was tried and
    // reverted after actual use — every destination here gets reached
    // often enough that hiding four of them behind an extra tap was a
    // net loss, not a win.
    return (
      <nav className="sidebar sidebar--compact">
        <button
          className={`nav-item nav-item--icon-only${page==='home'?' nav-item--active':''}`}
          onClick={()=>setPage('home')}
          title="Home" aria-label="Home">
          <IconHome className="nav-icon nav-icon--svg"/>
        </button>
        <button
          className={`nav-item nav-item--icon-only${page==='signals'?' nav-item--active':''}`}
          onClick={()=>setPage('signals')}
          title="Insights" aria-label="Insights">
          <IconInsights className="nav-icon nav-icon--svg"/>
        </button>
        <button
          className={`nav-item nav-item--icon-only${page==='data'?' nav-item--active':''}`}
          onClick={()=>setPage('data')}
          title="Data" aria-label="Data">
          <IconData className="nav-icon nav-icon--svg"/>
        </button>
        <button
          className={`nav-item nav-item--icon-only${page==='watchlist'?' nav-item--active':''}`}
          onClick={()=>setPage('watchlist')}
          title="Watchlist" aria-label="Watchlist">
          <IconFavorites className="nav-icon nav-icon--svg"/>
        </button>
        <button
          className={`nav-item nav-item--icon-only${page==='settings'?' nav-item--active':''}`}
          onClick={()=>setPage('settings')}
          title="Settings" aria-label="Settings">
          <IconSettings className="nav-icon nav-icon--svg"/>
        </button>
      </nav>
    );
  }

  return (
    <nav className="sidebar sidebar--compact">
      {/* Logo */}
      <div className="sidebar__logo" title="Seli — private beta">
        <div className="logo-mark logo-mark--beta">
          <img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/>
        </div>
      </div>

      {/* Primary nav — main pages only */}
      <div className="sidebar__nav">
        {NAV.map(n => (
          <button key={n.id}
            className={`nav-item nav-item--icon-only${page===n.id?' nav-item--active':''}`}
            onClick={()=>setPage(n.id)}
            title={n.label}
            aria-label={n.label}>
            <n.Icon className="nav-icon nav-icon--svg"/>
          </button>
        ))}
      </div>

      {/* Footer — utility items + plan status (visible from every page, not just Settings) */}
      <div className="sidebar__footer">
        {!pro && (
          <button className="nav-item nav-item--icon-only nav-item--sm nav-item--upgrade"
            onClick={onUpgrade}
            title="Upgrade to Pro"
            aria-label="Upgrade to Pro">
            <span className="nav-icon">$</span>
          </button>
        )}
        {/* Settings — gear, separate from primary nav */}
        <button
          className={`nav-item nav-item--icon-only nav-item--sm${page==='settings'?' nav-item--active':''}`}
          onClick={()=>setPage('settings')}
          title="Settings"
          aria-label="Settings">
          <IconSettings className="nav-icon nav-icon--svg"/>
        </button>
        {/* Sign out removed — redundant with Clerk's own UserButton dropdown
            in the status bar, which already handles account/sign-out. */}
      </div>
    </nav>
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
function navigateTo(path) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function getAuthHeaders() {
  // On a fresh page load, components can mount and fire their own
  // data-fetching effects before App's own effect (which registers
  // window.__clerkGetToken once Clerk finishes loading) has run — a real
  // race condition, not cosmetic. Without this wait, that fetch gets an
  // empty/wrong auth header, 401s, and nothing ever retries once the real
  // token becomes available a moment later — only a full remount
  // (navigating away and back) would trigger a fresh attempt. Poll briefly
  // for the token getter to appear rather than give up immediately; Clerk
  // typically finishes loading well within this window.
  if (!window.__clerkGetToken) {
    for (let i = 0; i < 40 && !window.__clerkGetToken; i++) {
      await new Promise(r => setTimeout(r, 50)); // up to ~2s total
    }
  }
  // Phase 2: Clerk JWT — registered by App once Clerk loads
  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) return { 'Authorization': `Bearer ${token}` };
    } catch {}
  }
  // No static-key fallback — a request without a valid Clerk token should
  // fail with a real 401, not silently succeed via a key that would
  // otherwise sit exposed in the public bundle the moment anyone set
  // VITE_WORKER_API_KEY, used or not.
  return {};
}

async function queryNeon(sql) {
  const r = await fetch(cfg.NEON_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ query: sql }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) throw new Error('You don\'t have access to this — check your plan in Settings');
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
    <span className="trust-stars-wrap">
      <span className="trust-stars__label" title="A weighted composite of hit rate, realized return size, trade volume, and how concentrated their buying is — not the same number as the hit-rate % shown below, which is a raw price outcome with no weighting.">Trust score</span>
      <span className="trust-stars" title={`${score}/5 — composite score (hit rate + return size + volume + concentration), distinct from the hit-rate % below`}>
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
    </span>
  );
}

// ─── Guide — the large, multi-section modal covering how Seli works, opened
// automatically the first time someone signs in, and reachable anytime
// through the "?" on any tile (jumping straight to the section that
// explains that tile) or a standing link elsewhere in the app. One shared
// modal with real navigation between sections, not seven separate small
// popups repeating similar ground.
//
// Content lives in one place (GUIDE_SECTIONS) so a tile's "?" and the
// guide's own sidebar always say the same thing about the same feature,
// rather than drifting apart the way seven independent tooltip strings
// eventually would.
const GUIDE_SECTIONS = [
  {
    id: 'welcome',
    label: 'Welcome',
    render: () => (
      <>
        <div className="guide-hero">
          <div className="guide-hero__mark" aria-hidden="true">
            <img src={logoSimple} alt="" style={{width:'100%',height:'100%',objectFit:'contain'}}/>
          </div>
        </div>
        <p>Seli watches every <strong>SEC Form 4 filing</strong> and every <strong>congressional stock disclosure</strong> as it's published, parses it, and makes it easy to review.</p>
        <p>This guide is a quick walkthrough of where the data comes from, how the scoring works, and the basics of each part of the website. All informational.</p>
        <p>Seli does not provide financial advice or personalized recommendations. It screens for insider movements, scores each trade based on peer-reviewed historical findings, and makes the results available to you.</p>
      </>
    ),
  },
  {
    id: 'using-seli',
    label: 'Using Seli',
    render: () => (
      <>
        <p>Seli has five sections, each serving a different purpose.</p>
        <h3 className="guide-section-heading">Dashboard</h3>
        <p>Your daily overview: market sentiment, sector performance, recent insider signals, top-ranked insiders, and market news.</p>
        <p className="td-muted" style={{fontSize:'0.8125rem'}}>Main use: quick snapshot of recent insider movement.</p>
        <EnvPreview type="dashboard"/>
        <h3 className="guide-section-heading" style={{marginTop:20}}>Insights</h3>
        <p>The full, filterable signal feed. Thousands of trades are reported daily, and it can be hard to keep track of what's significant. Seli compares each trade against peer-reviewed research on how insiders beat the market and scores each insider based on how much they beat the market (SPY) by. Every trade is scored equally.</p>
        <p>Insights is also where you'll see your portfolio information and any insider trades related to assets you currently hold.</p>
        <p className="td-muted" style={{fontSize:'0.8125rem'}}>Main use: find historically successful trading patterns and the insiders behind them.</p>
        <EnvPreview type="insights"/>
        <h3 className="guide-section-heading" style={{marginTop:20}}>Data</h3>
        <p>Raw, legible filing data. Every trade, searchable and filterable. If you want to draw your own conclusions, this is where to work.</p>
        <p className="td-muted" style={{fontSize:'0.8125rem'}}>Main use: deep dive into raw data, make your own deductions.</p>
        <EnvPreview type="data"/>
        <h3 className="guide-section-heading" style={{marginTop:20}}>Watchlist</h3>
        <p>Tickers and insiders you've chosen to follow. Their activity surfaces ahead of everything else, and it's what instant alerts and email digests are built from.</p>
        <h3 className="guide-section-heading" style={{marginTop:20}}>Settings</h3>
        <p>Your plan, billing, notification preferences, and brokerage connection all live here.</p>
      </>
    ),
  },
  {
    id: 'data-source',
    label: 'Sourcing the Data',
    render: () => (
      <>
        <p>Seli tracks only <strong>official SEC data filed by insiders.</strong></p>
        <ul>
          <li><strong>Corporate insiders.</strong> Form 4, filed with the SEC by executives, directors, and major shareholders. Corporate trades are reported within 2 business days of a trade.</li>
          <li><strong>Congress.</strong> Periodic transaction reports required under the STOCK Act, filed by senators and representatives. Congressional transactions must be filed within 45 days of a trade.</li>
        </ul>
        <p>Seli checks for new filings on a recurring basis throughout the trading day, so a disclosure typically shows up here <strong>within minutes</strong> of becoming public.</p>
      </>
    ),
  },
  {
    id: 'scoring',
    label: 'Data Scoring',
    render: () => (
      <>
        <p>Every trade is scored from a standardized approach based on peer-reviewed research. Seli calculates a <strong>conviction score</strong> for each trade, a number built from a few factors:</p>
        <ul>
          <li><strong>Relationship</strong> between the executor of the trade and the equity in question. C-suite executives and members of Congress are weighted more heavily (Ravina &amp; Sapienza, 2010).</li>
          <li><strong>Buys and sells aggregation</strong> within a time window helps strengthen or dilute a signal. Insider purchases predict positive abnormal returns; sales generally do not (Lakonishok &amp; Lee, 2001; Seyhun, 1986).</li>
          <li><strong>Dollar amounts</strong> play a small role in signal weighting, on a diminishing scale.</li>
          <li>A trade that represents a <strong>large share of someone's existing position</strong> counts for more than a routine top-up.</li>
        </ul>
        <p>Only <strong>open-market trades</strong> count toward this. Option exercises, RSU vests, and grants are left out entirely, since they don't reflect someone choosing to put their own money in.</p>
        <EnvPreview type="insights"/>
        <p style={{ marginTop: 4 }}>Insiders are also ranked by <strong>actual track record</strong>: win rate on past open-market buys, once there's enough history to be meaningful (5+ priced trades).</p>
        <div className="guide-trust-demo" aria-hidden="true">
          <TrustStars score={4.5}/>
        </div>
        <p style={{ marginTop: 12 }}><strong>This scoring is the same for every user.</strong> The same methodology, applied identically to every trade. Filters like watchlists or portfolio linking control which trades you see, but they never change how anything is scored. See <a href="/terms">Terms of Service</a>.</p>
      </>
    ),
  },
  {
    id: 'pro-features',
    label: 'Pro Features',
    render: () => (
      <>
        <p>Free covers the last 7 days: dashboard, leaderboard, and full filing data. Pro unlocks:</p>
        <ul>
          <li><strong>Full history.</strong> Every filing going back years.</li>
          <li><strong>Watchlists.</strong> Follow specific insiders or tickers and see their activity first.</li>
          <li><strong>Portfolio linking.</strong> Connect a brokerage (read-only) and see insider filings on stocks you hold.</li>
          <li><strong>Email notifications.</strong> Instant alerts when a filing matches your criteria, or a daily/weekly digest.</li>
        </ul>
        <p>All of this is configurable in <strong>Settings</strong>.</p>
      </>
    ),
  },
];

const GuideContext = createContext(null);

// Resolves the string icon names stored in GUIDE_SECTIONS to the actual
// icon components, kept as strings in the content array so that array
// stays plain data, not a mix of data and component references.
const GUIDE_ICON_MAP = {
  IconHome, IconData, IconInsights, IconZap, IconSettings, IconList, IconCompass,
};

// Compact, abstracted mockups of each of the five app environments, used
// in place of static placeholder screenshots in both the Guide modal and
// the landing page. Built from real divs and the app's own CSS variables
// rather than image files, so they render correctly in both light and
// dark theme automatically and never need to be re-captured when the
// real UI changes. Intentionally simplified, not a pixel clone of the
// real pages — the point is "recognize what this section looks like at
// a glance," not a literal screenshot.
function EnvPreview({ type }) {
  if (type === 'dashboard') return (
    <div className="env-preview">
      <div className="env-preview__stats">
        {['Sentiment', 'SPY', 'QQQ', 'Flow'].map(l => (
          <div key={l} className="env-preview__stat">
            <span className="env-preview__stat-label">{l}</span>
            <span className="env-preview__stat-val"/>
          </div>
        ))}
      </div>
      {[0,1,2].map(i => (
        <div key={i} className="env-preview__row">
          <span className="env-preview__ticker"/>
          <span className="env-preview__bar" style={{width:`${60-i*12}%`}}/>
          <span className="env-preview__num env-preview__num--pos"/>
        </div>
      ))}
    </div>
  );
  if (type === 'insights') return (
    <div className="env-preview env-preview--signals">
      <div className="env-preview__pills">
        {['30d','90d','1y','All'].map((p,i) => (
          <span key={p} className={`env-preview__pill env-preview__pill--label${i===1?' env-preview__pill--active':''}`}>{p}</span>
        ))}
      </div>
      {[
        {rank:1, rate:'94%', dir:'buy'},
        {rank:2, rate:'87%', dir:'buy'},
        {rank:3, rate:'61%', dir:'sell'},
        {rank:4, rate:'52%', dir:'buy'},
      ].map(r => (
        <div key={r.rank} className="env-preview__lb-row">
          <span className="env-preview__lb-rank">{r.rank}</span>
          <span className="env-preview__ticker"/>
          <span className="env-preview__wl-name"/>
          {r.dir==='buy'
            ? <IconBuyTri className="env-preview__lb-dir env-preview__lb-dir--buy" style={{width:8,height:8}}/>
            : <IconSellTri className="env-preview__lb-dir env-preview__lb-dir--sell" style={{width:8,height:8}}/>}
          <span className={`env-preview__lb-rate${parseFloat(r.rate)>=70?' env-preview__lb-rate--hi':''}`}>{r.rate}</span>
        </div>
      ))}
    </div>
  );
  if (type === 'data') return (
    <div className="env-preview env-preview--data">
      <div className="env-preview__toolbar">
        <span className="env-preview__search"/>
        <span className="env-preview__pill env-preview__pill--sm"/>
        <span className="env-preview__pill env-preview__pill--sm"/>
      </div>
      <div className="env-preview__thead">
        {['Date','Insider','Ticker','Type','Value'].map(h => (
          <span key={h} className="env-preview__th">{h}</span>
        ))}
      </div>
      <div className="env-preview__table">
        {[0,1,2,3].map(i => (
          <div key={i} className="env-preview__trow env-preview__trow--data">
            <span/>
            <span/>
            <span className="env-preview__ticker"/>
            <span className={`env-preview__code${i%3===0?' env-preview__code--sell':' env-preview__code--buy'}`}>{i%3===0?'S':'P'}</span>
            <span className="env-preview__num env-preview__num--pos"/>
          </div>
        ))}
      </div>
    </div>
  );
  if (type === 'watchlist') return (
    <div className="env-preview env-preview--watchlist">
      <div className="env-preview__wl-head">
        <span className="env-preview__wl-dot"/>
        <span className="env-preview__wl-acct">Brokerage linked</span>
      </div>
      {[
        {held:true,  buy:true},
        {held:true,  buy:false},
        {held:false, buy:true},
      ].map((r,i) => (
        <div key={i} className="env-preview__wl-row">
          <span className={`env-preview__star${r.held?' env-preview__star--filled':''}`}>★</span>
          <span className="env-preview__ticker env-preview__ticker--lg"/>
          <span className="env-preview__wl-name"/>
          <span className={`env-preview__wl-signal${r.buy?' env-preview__wl-signal--buy':' env-preview__wl-signal--sell'}`}>
            {r.buy ? '▲ Buying' : '▼ Selling'}
          </span>
        </div>
      ))}
    </div>
  );
  if (type === 'settings') return (
    <div className="env-preview env-preview--alerts">
      {[
        {isNew:true,  buy:true},
        {isNew:false, buy:true},
        {isNew:false, buy:false},
      ].map((r,i) => (
        <div key={i} className="env-preview__alert-row">
          <span className={`env-preview__alert-dot${r.buy?' env-preview__alert-dot--buy':' env-preview__alert-dot--sell'}`}/>
          <div className="env-preview__alert-body">
            <span className="env-preview__ticker"/>
            <span className="env-preview__alert-text"/>
          </div>
          {r.isNew && <span className="env-preview__alert-new">New</span>}
        </div>
      ))}
    </div>
  );
  return null;
}

// Same resolution pattern as GUIDE_ICON_MAP, for the landing page's What's
// Inside section — kept as a separate map rather than reused directly,
// since the two sections don't necessarily want identical icon sets long
// term even though they overlap today.
const LP_FEATURE_ICON_MAP = {
  IconData, IconInsights, IconLink, IconZap,
};

function GuideProvider({ children }) {
  const [openSection, setOpenSection] = useState(null); // null = closed, else a GUIDE_SECTIONS id

  // Auto-open once per browser, on first real visit to the app (not the
  // marketing/landing page) — localStorage only, same pattern already used
  // for theme elsewhere in this file. Not tied to a Neon
  // column: losing this flag on a new device just means seeing the guide
  // again, which is a low-stakes outcome, not one worth a server round trip.
  useEffect(() => {
    try {
      if (!localStorage.getItem('seli_guide_seen')) {
        setOpenSection('welcome');
        localStorage.setItem('seli_guide_seen', '1');
      }
    } catch (_) {}
  }, []);

  const openGuide = useCallback((sectionId) => setOpenSection(sectionId || 'welcome'), []);
  const closeGuide = useCallback(() => setOpenSection(null), []);

  return (
    <GuideContext.Provider value={{ openSection, openGuide, closeGuide }}>
      {children}
      {openSection && <GuideModal initialSection={openSection} onClose={closeGuide}/>}
    </GuideContext.Provider>
  );
}

function GuideModal({ initialSection, onClose }) {
  const [activeId, setActiveId] = useState(initialSection || 'welcome');
  const idx = GUIDE_SECTIONS.findIndex(s => s.id === activeId);
  const section = GUIDE_SECTIONS[idx] ?? GUIDE_SECTIONS[0];

  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-panel guide-modal">
        <div className="modal-panel__hdr guide-modal__hdr">
          <span className="modal-panel__title">Guide</span>
          <button className="modal-close" onClick={onClose} title="Close (Esc)">
            <IconClose style={{ width: 12, height: 12 }} />
          </button>
        </div>
        <div className="guide-modal__body">
          <nav className="guide-modal__nav" aria-label="Guide sections">
            {GUIDE_SECTIONS.map((s, i) => {
              return (
                <button
                  key={s.id}
                  className={`guide-modal__nav-item ${s.id === activeId ? 'guide-modal__nav-item--active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                  title={s.label}
                  aria-label={s.label}
                >
                  <span className="guide-modal__nav-num">{i + 1}</span>
                  {s.label}
                </button>
              );
            })}
          </nav>
          <div className="guide-modal__content">
            <div className="guide-modal__content-inner">
              {section.render()}
            </div>
            <div className="guide-modal__footer">
              <button
                className="btn btn--ghost btn--sm"
                disabled={idx === 0}
                onClick={() => setActiveId(GUIDE_SECTIONS[idx - 1].id)}
              >
                Back
              </button>
              <span className="td-muted" style={{ fontSize: '0.75rem' }}>{idx + 1} of {GUIDE_SECTIONS.length}</span>
              {idx < GUIDE_SECTIONS.length - 1 ? (
                <button className="btn btn--primary btn--sm" onClick={() => setActiveId(GUIDE_SECTIONS[idx + 1].id)}>
                  Next
                </button>
              ) : (
                <button className="btn btn--primary btn--sm" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="guide-modal__legal-bar">
          <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
          <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          <a href="/cookies" target="_blank" rel="noreferrer">Cookies</a>
        </div>
      </div>
    </div>
  );
}

// ─── Tile info button — the "?" on a tile. Thin trigger only: opens the
// shared Guide at the section that explains this specific tile, rather than
// rendering its own separate modal. Keeps one real explanation per topic
// instead of the guide and seven tile tooltips slowly saying slightly
// different things about the same feature.
function TileInfoButton({ section, title }) {
  const guide = useContext(GuideContext);
  return (
    <button
      className="tile-info-btn"
      onClick={(e) => { e.stopPropagation(); guide?.openGuide(section); }}
      title={`About: ${title}`}
      aria-label={`About ${title}`}
    >
      <IconHelp style={{ width: 12, height: 12 }} />
    </button>
  );
}

// Persistent status-bar entry point into the guide — always opens at the
// beginning, for anyone who wants the full walkthrough rather than one
// specific tile's answer. Previously this lived alongside a separate "?"
// icon that linked out to /about — two adjacent help-shaped icons doing
// different things. Consolidated into one: this is now the "?" itself.
function FeedbackButton({ page }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="status-bar__icon-btn"
        onClick={() => setOpen(true)}
        title="Send feedback"
        aria-label="Send feedback"
      >
        <IconMessage style={{ width: 16, height: 16 }} />
      </button>
      {open && <FeedbackModal page={page} onClose={() => setOpen(false)}/>}
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
      if (!r.ok) { const d = await r.json().catch(()=>({})); throw new Error(d.error || 'Something went wrong sending this — try again in a moment.'); }
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
      <div className="upgrade-modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
        <div className="upgrade-modal__title" style={{marginBottom:4}}>Send feedback</div>
        <p style={{fontSize:13,color:'var(--text-2)',margin:'0 0 14px'}}>
          Bug, confusing moment, something you wish existed — all of it helps during beta.
        </p>
        <input
          className="feedback-input"
          value={summary}
          onChange={e=>setSummary(e.target.value)}
          placeholder="Summary — one line"
          maxLength={200}
          autoFocus
        />
        <textarea
          className="feedback-textarea"
          style={{marginTop:8}}
          value={message}
          onChange={e=>setMessage(e.target.value)}
          onPaste={onPaste}
          placeholder="What's on your mind? (you can paste a screenshot directly in here)"
          rows={5}
        />
        {screenshots.length > 0 && (
          <div className="feedback-shots">
            {screenshots.map((s, i) => (
              <div key={i} className="feedback-shot">
                <img src={s.dataUrl} alt={s.name}/>
                <button className="feedback-shot__remove" onClick={()=>removeShot(i)} title="Remove" aria-label="Remove screenshot">
                  <IconClose style={{width:10,height:10}}/>
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:8}}>
          <button
            className="btn btn--ghost btn--sm"
            onClick={()=>fileInputRef.current?.click()}
            disabled={screenshots.length >= FEEDBACK_MAX_SCREENSHOTS}
          >
            Attach screenshot
          </button>
          <span className="td-muted" style={{fontSize:11}}>or paste one into the text box</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{display:'none'}}
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>
        {shotError && <div className="checkout-error" style={{marginTop:10}}>{shotError}</div>}
        {error && <div className="checkout-error" style={{marginTop:10}}>{error}</div>}
        <div style={{display:'flex',gap:8,marginTop:14,justifyContent:'flex-end'}}>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!summary.trim()||!message.trim()||sending} onClick={submit}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function GuideStatusBarButton() {
  const guide = useContext(GuideContext);
  return (
    <button
      className="status-bar__icon-btn"
      onClick={() => guide?.openGuide('welcome')}
      title="Guide"
      aria-label="Open guide"
    >
      <IconHelp style={{ width: 16, height: 16 }} />
    </button>
  );
}

// ─── Company profile card ─────────────────────────────────────────────────────
// Shown at the top of the ticker detail panel. Pulls Finnhub profile (market cap,
// industry, exchange, logo) and EDGAR description (Item 1 business summary).
function CompanyProfileCard({ ticker, cik, company }) {
  const { profile, metrics, desc, loading } = useCompanyProfile(ticker, cik);

  const mktCap = profile?.marketCapitalization
    ? `$${(profile.marketCapitalization/1000).toFixed(1)}B`
    : null;
  const w52hi = metrics?.['52WeekHigh']  ? `$${Number(metrics['52WeekHigh']).toFixed(2)}`  : null;
  const w52lo = metrics?.['52WeekLow']   ? `$${Number(metrics['52WeekLow']).toFixed(2)}`   : null;
  const pe    = metrics?.['peNormalizedAnnual'] ? Number(metrics['peNormalizedAnnual']).toFixed(1) : null;
  const beta  = metrics?.['beta']        ? Number(metrics['beta']).toFixed(2) : null;

  if (loading) return <div style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:8,borderBottom:'0.5px solid var(--border)'}}><Spinner size={14}/><span className="td-muted" style={{fontSize:12}}>Loading profile…</span></div>;
  if (!profile && !desc) return null;

  return (
    <div className="co-profile-card">
      {/* Header: logo + name + exchange */}
      <div className="co-profile-card__top">
        {profile?.logo&&<img src={profile.logo} alt="" className="co-profile-card__logo" onError={e=>e.target.style.display='none'}/>}
        <div style={{minWidth:0}}>
          <div className="co-profile-card__name">{profile?.name||company}</div>
          <div className="co-profile-card__sub">
            {[profile?.exchange, profile?.finnhubIndustry, profile?.country].filter(Boolean).join(' · ')}
          </div>
        </div>
        {profile?.weburl&&<a href={profile.weburl} target="_blank" rel="noreferrer" className="co-profile-card__web">↗</a>}
      </div>

      {/* Key stats row */}
      {(mktCap||w52hi||pe||beta)&&(
        <div className="co-profile-stats">
          {mktCap&&<div className="co-profile-stat"><span className="co-profile-stat__label">Market cap</span><span className="co-profile-stat__val">{mktCap}</span></div>}
          {(w52hi&&w52lo)&&<div className="co-profile-stat"><span className="co-profile-stat__label">52w range</span><span className="co-profile-stat__val">{w52lo} – {w52hi}</span></div>}
          {pe&&<div className="co-profile-stat"><span className="co-profile-stat__label">P/E</span><span className="co-profile-stat__val">{pe}</span></div>}
          {beta&&<div className="co-profile-stat"><span className="co-profile-stat__label">Beta</span><span className="co-profile-stat__val">{beta}</span></div>}
        </div>
      )}

      {/* Description — truncated with "more" expand */}
      {desc&&<CompanyDescExpanded desc={desc}/>}
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
      {desc.length > SHORT&&(
        <button className="co-profile-desc__toggle" onClick={()=>setExp(e=>!e)}>
          {exp ? ' less' : ' more'}
        </button>
      )}
    </div>
  );
}

// ─── Star (watchlist) button ──────────────────────────────────────────────────
function StarBtn({ ticker, watchlist }) {
  const isWatched = watchlist.has(ticker);
  const isPro     = watchlist.pro;
  return (
    <button
      className={`star-btn${isWatched?' star-btn--active':''}${!isPro?' star-btn--locked':''}`}
      title={isPro ? (isWatched?'Remove from watchlist':'Add to watchlist') : 'Pro feature — upgrade to track tickers'}
      onClick={e=>{e.stopPropagation();watchlist.toggle(ticker);}}>
      <svg viewBox="0 0 24 24" fill={isWatched?'currentColor':'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    </button>
  );
}

// Follow button for insiders — same pattern as StarBtn
function FollowBtn({ name, watchlist }) {
  const isFollowing = watchlist.hasInsider(name);
  const isPro       = watchlist.pro;
  return (
    <button
      className={`follow-btn${isFollowing?' follow-btn--active':''}${!isPro?' follow-btn--locked':''}`}
      title={isPro ? (isFollowing?'Unfollow insider':'Follow insider — get alerts on their trades') : 'Pro feature — upgrade to follow insiders'}
      onClick={e=>{e.stopPropagation();watchlist.toggleInsider(name);}}>
      <svg viewBox="0 0 24 24" fill={isFollowing?'currentColor':'none'} stroke="currentColor" strokeWidth={2} width="10" height="10" style={{marginRight:4,verticalAlign:'-1px'}}><circle cx="12" cy="12" r="9"/></svg>
      {isFollowing ? 'Following' : 'Follow'}
    </button>
  );
}

function DetailPanel({ detail, filings, onClose, onNavigate, onBack, canGoBack, watchlist, inline=false, onExpand, hideProfileCard=false }) {
  // Note: this component is only ever mounted by the caller when `detail` is
  // truthy (see App's panelOpen guard), so `d` is always defined here. No
  // early-return guard before the hooks below — that pattern breaks React's
  // hooks ordering the moment `detail` could vary between renders of the same
  // mounted instance (see the PortfolioSection fix for a real instance of this).
  const d = detail;

  const [traderRows, setTraderRows] = useState(null);
  const [tickerRows, setTickerRows] = useState(null);
  const [busy,       setBusy]       = useState(false);
  const [bundleOn,   setBundleOn]   = useState(true);
  const [omOnly,     setOmOnly]     = useState(true);
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
      WHERE f.ticker='${(d.ticker||'').replace(/'/g,"''")}'
        AND f.transaction_type IN ('buy','sell')
      ORDER BY COALESCE(f.transaction_date,f.filing_date) DESC LIMIT 200
    `).then(r=>{setTickerRows(r);setBusy(false);}).catch(()=>setBusy(false));
  },[d.type,d.ticker]);

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
    // For a BUY, price rising afterward is a good outcome. For a SELL, it's
    // the opposite — price rising after you sold means you left money on
    // the table. The percentage shown stays true to the actual price move
    // (so it never contradicts the prices displayed next to it — a sale
    // shown at $6.94 → $7.69 should never read as a negative number, that
    // would look like a math error), but the color now reflects whether
    // this was actually a good outcome for THIS trade's direction, which
    // previously used the same green-if-positive logic for both buys and
    // sells — backwards for every sell.
    const ret=(hasRealPrice&&cur&&!isForeign)?((cur-pr)/pr*100):null;
    const isGoodOutcome = ret!=null ? (tt==='sell' ? ret<0 : ret>=0) : null;
    const dt=r.transaction_date||r.transactionDate||r.date;
    const codeLabel = TX_CODE_TOOLTIPS[code]||code;
    const dateLabel = r._isCluster ? `${fmt.dateShort(r.transaction_date)}–${fmt.dateShort(r._lastDate)}` : fmt.dateShort(dt);
    // Scopes the eventual "expand to full Explore view" to whatever this
    // panel itself represents — DataDrawer already restores every filter
    // from this object and scrolls to/highlights the exact row that opened
    // it (see its own scrolledOnOpenRef effect), it just needed a caller
    // that actually attaches a dataFilters payload. Ticker/trader panels
    // are the two contexts this row list is used in with a real single
    // subject to scope to; anywhere else (a compact signals widget with no
    // one fixed subject) this stays null and expand falls back to the
    // existing general Insights drawer, unchanged.
    const rowDataFilters = d.type==='ticker' && d.ticker ? { search: d.ticker }
                          : d.type==='trader' && d.name ? { search: d.name }
                          : null;
    const openTransaction = () => nav('transaction', { trade: r, dataFilters: rowDataFilters });
    return (
      <div className={`dp-trade dp-trade--${tt} dp-clickable`}
           role="button" tabIndex={0}
           onClick={openTransaction}
           onKeyDown={(e)=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); openTransaction(); } }}>
        <div className={`dp-trade-split${inline?'':' dp-trade-split--stacked'}`}>
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
                  ? <span className="dp-clickable dp-trade-row2__name dp-trade-row2__name--lg" onClick={(e)=>{e.stopPropagation();nav('trader',{name:r.insider_name,title:r.title});}}>{r.insider_name}</span>
                  : <span className="dp-trade-date">{dateLabel}</span>}
                {r._isCluster&&<span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
                {isForeign&&<span style={{color:'var(--amber-600)'}} title="Price move too large to be reliable — verify manually"><IconWarning style={{width:10,height:10,display:'inline',verticalAlign:'-1px'}}/></span>}
              </div>
              <div className="dp-trade-left__bottom">
                {showInsider && r.insider_name && <span className="dp-trade-date">{dateLabel}</span>}
                {showTicker&&r.ticker&&<span className="ticker dp-clickable" onClick={(e)=>{e.stopPropagation();nav('ticker',{ticker:r.ticker,company:r.company_name});}}>{r.ticker}</span>}
              </div>
            </div>
          ) : showInsider && r.insider_name ? (
            <div className="dp-trade-toprow">
              <div className="dp-trade-toprow__left">
                <span className="dp-clickable dp-trade-row2__name" onClick={(e)=>{e.stopPropagation();nav('trader',{name:r.insider_name,title:r.title});}}>{r.insider_name}</span>
                <div className="dp-trade-toprow__meta">
                  <span className="dp-trade-date">{dateLabel}</span>
                  {r._isCluster&&<span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
                  {isForeign&&<span style={{color:'var(--amber-600)'}} title="Price move too large to be reliable — verify manually"><IconWarning style={{width:10,height:10,display:'inline',verticalAlign:'-1px'}}/></span>}
                </div>
              </div>
              <div className="dp-trade-toprow__badges">
                <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge>
                <span className="code-pill" title={codeLabel}>{(code==='P'||code==='S') ? code : (TX_CODE_SHORT[code]||code)}</span>
                {isOM&&<span className="dp-trade-om-label">Open market</span>}
              </div>
            </div>
          ) : (
            <div className="dp-trade-left">
              <div className="dp-trade-left__top">
                <span className="dp-trade-date">{dateLabel}</span>
                {r._isCluster&&<span className="cluster-badge" title={`${r._count} trades bundled`}>{r._count}×</span>}
              </div>
              <div className="dp-trade-left__bottom">
                <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge>
                <span className="code-pill" title={codeLabel}>{(code==='P'||code==='S') ? code : (TX_CODE_SHORT[code]||code)}</span>
                {isOM&&<span className="dp-trade-om-label">Open market</span>}
                {showTicker&&r.ticker&&<span className="ticker dp-clickable" onClick={(e)=>{e.stopPropagation();nav('ticker',{ticker:r.ticker,company:r.company_name});}}>{r.ticker}</span>}
                {isForeign&&<span style={{color:'var(--amber-600)'}} title="Price move too large to be reliable — verify manually"><IconWarning style={{width:10,height:10,display:'inline',verticalAlign:'-1px'}}/></span>}
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
                  <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge>
                  <span className="code-pill" title={codeLabel}>{(code==='P'||code==='S') ? code : (TX_CODE_SHORT[code]||code)}</span>
                </span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Shares</span>
                <span className="dp-trade-detail__val">{r.shares?fmt.number(r.shares):'—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Price</span>
                <span className="dp-trade-detail__val">{hasRealPrice?fmt.price(pr):'—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Now</span>
                {hasRealPrice&&ret!=null
                  ? <span className={`dp-trade-detail__val ${isGoodOutcome?'val-buy':'val-sell'}`}>{fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)</span>
                  : <span className="dp-trade-detail__val td-muted">—</span>}
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">% of position</span>
                <span className="dp-trade-detail__val val-buy">{(r.pct_owned_change||r.pctOwnedChange)!=null?`+${(r.pct_owned_change||r.pctOwnedChange).toFixed(0)}%`:'—'}</span>
              </div>
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Total</span>
                <span className="dp-trade-detail__val dp-trade-detail__val--total">{r.value?fmt.money(r.value):'—'}</span>
              </div>
            </div>
          ) : (
            <div className="dp-trade-right">
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Shares</span>
                <span className="dp-trade-detail__val">{r.shares?fmt.number(r.shares):'—'}</span>
              </div>
              {hasRealPrice ? (<>
                <div className="dp-trade-detail">
                  <span className="dp-trade-detail__label">Price</span>
                  <span className="dp-trade-detail__val">{fmt.price(pr)}</span>
                </div>
                {ret!=null && (
                  <div className="dp-trade-detail">
                    <span className="dp-trade-detail__label">Now</span>
                    <span className={`dp-trade-detail__val ${isGoodOutcome?'val-buy':'val-sell'}`}>
                      {fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)
                    </span>
                  </div>
                )}
              </>) : null}
              {(r.pct_owned_change||r.pctOwnedChange)!=null && (
                <div className="dp-trade-detail">
                  <span className="dp-trade-detail__label">% of position</span>
                  <span className="dp-trade-detail__val val-buy">+{(r.pct_owned_change||r.pctOwnedChange).toFixed(0)}%</span>
                </div>
              )}
              <div className="dp-trade-detail">
                <span className="dp-trade-detail__label">Total</span>
                <span className="dp-trade-detail__val dp-trade-detail__val--total">{r.value?fmt.money(r.value):'—'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const header=()=>{
    if(d.type==='trader')return<div style={{display:'flex',alignItems:'center',gap:8,flex:1}}><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,display:'flex',alignItems:'center',gap:6}}>{d.name}{traderRows?.[0]?.is_entity_owner&&<span className="entity-badge" title="This may be an entity (Trust/LLC) rather than an individual"><IconWarning style={{width:9,height:9,marginRight:2,verticalAlign:"-1px"}}/>entity</span>}</div>{traderStats?.title&&<div className="td-muted" style={{fontSize:11}}>{traderStats.title}</div>}</div>{watchlist&&<FollowBtn name={d.name} watchlist={watchlist}/>}</div>;
    if(d.type==='ticker')return(
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span className="ticker" style={{fontSize:17}}>{d.ticker}</span>
        <span style={{fontSize:13,color:'var(--text-2)',flex:1}}>{d.company}</span>
        {watchlist&&<StarBtn ticker={d.ticker} watchlist={watchlist}/>}
      </div>
    );
    if(d.type==='signal')return(
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span className="ticker" style={{fontSize:17}}>{d.ticker}</span>
        <span style={{fontSize:13,color:'var(--text-2)',flex:1}}>{d.company}</span>
        {watchlist&&<StarBtn ticker={d.ticker} watchlist={watchlist}/>}
      </div>
    );
    if(d.type==='transaction')return<div><div style={{display:'flex',alignItems:'baseline',gap:8}}><span className="ticker" style={{fontSize:15}}>{d.trade?.ticker}</span><span style={{fontSize:12,color:'var(--text-2)'}}>{d.trade?.company_name||d.trade?.company}</span></div><div className="td-muted" style={{fontSize:11}}>Transaction</div></div>;
  };

  return (
    <div className={inline?'detail-panel detail-panel--inline':'detail-panel'}>
      <div className="detail-panel__header">
        {canGoBack&&<button className="btn btn--ghost btn--icon" onClick={onBack} title="Back">←</button>}
        <div style={{minWidth:0,flex:1}}>{header()}</div>
        {!inline&&onExpand&&<button className="btn btn--ghost btn--icon" onClick={onExpand} title="Open full Explore view">⤢</button>}
        {!inline&&<button className="btn btn--ghost btn--icon" onClick={onClose}><IconClose style={{width:12,height:12}}/></button>}
        {inline&&canGoBack&&<button className="btn btn--ghost btn--icon" style={{fontSize:11}} onClick={onClose} title="Clear"><IconClose style={{width:12,height:12}}/></button>}
      </div>
      <div className="detail-panel__body">

        {d.type==='trader'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!traderStats?<div className="state-box" style={{padding:'2rem'}}><p>No trades found.</p></div>:(<>

          {/* HERO: previously showed only one of Realized P&L or Est.
              Position Value, with whichever wasn't primary buried in a
              small chip below. No real reason to force a choice — show
              both prominently when both apply, and gracefully fall back to
              whichever one actually exists otherwise (e.g. a fully open
              position with nothing realized yet has no P&L to show at all). */}
          {heroStats&&(
            <div className="trader-hero">
              <div className="trader-hero__top">
                <div className="trader-hero__metrics">
                  {heroStats.hasRealizedData && (
                    <div className="trader-hero__metric">
                      <div className="trader-hero__label">Realized P&L</div>
                      <div className={`trader-hero__value ${heroStats.totalRealized>=0?'val-buy':'val-sell'}`}>
                        {heroStats.totalRealized>=0?'+':''}{fmt.money(heroStats.totalRealized)}
                      </div>
                    </div>
                  )}
                  {heroStats.totalCurrentValue>0 && (
                    <div className="trader-hero__metric">
                      <div className="trader-hero__label">{heroStats.hasRealizedData?'Position Value':'Est. Position Value'}</div>
                      <div className={`trader-hero__value${heroStats.hasRealizedData?' trader-hero__value--secondary':''}`}>
                        {fmt.money(heroStats.totalCurrentValue)}
                      </div>
                    </div>
                  )}
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
              {traderStats.combinedHitRate!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Hit Rate <span className="trust-explain" title="% of priced buy+sell events that were profitable. Buys: stock up since purchase. Sells: sold above their own avg cost basis.">ⓘ</span></span><span className={`dp-sum-val ${traderStats.combinedHitRate>=60?'val-buy':traderStats.combinedHitRate<40?'val-sell':''}`}>{traderStats.combinedHitRate}% <span style={{fontSize:11,opacity:.7}}>({traderStats.withReturn} events)</span></span></div>}
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
                      <svg viewBox="0 0 24 24" fill="currentColor" width="7" height="7" style={{marginRight:3,verticalAlign:'-0.5px'}}><circle cx="12" cy="12" r="10"/></svg>
                      {s.stillHolding?'Holding':'Closed'}
                    </span>
                  </div>
                  <span className="td-muted" style={{fontSize:11}}>{s.tradeCount} txn{s.tradeCount!==1?'s':''}</span>
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
                  <span title="Average days between trade date and SEC filing acceptance">◷ {s.avgFilingLag!=null?`${s.avgFilingLag}d filing lag`:'lag n/a'}</span>
                  <span className="position-card__source">
                    {s.positionFlagged&&<span className="position-flagged-badge" title="SEC-reported figure looked implausible, fell back to estimate"><IconWarning style={{width:9,height:9,marginRight:2,verticalAlign:"-1px"}}/>flagged</span>}
                    {!s.positionFlagged&&s.stillHolding?(s.positionSource==='sec-reported'?'SEC-reported':'OM est.'):''}
                  </span>
                </div>

                {s.roundTrips.length>0&&(
                  <details className="position-card__roundtrips">
                    <summary>{s.roundTrips.length} closed round-trip{s.roundTrips.length!==1?'s':''} (FIFO, open-market)</summary>
                    {s.roundTrips.slice(0,8).map((rt,j)=>(
                      <div key={j} className="roundtrip-row">
                        <span className="td-muted" style={{fontSize:11}}>{fmt.dateShort(rt.buyDate)} → {fmt.dateShort(rt.sellDate)}</span>
                        <span className="td-muted" style={{fontSize:11}}>{rt.holdDays}d held</span>
                        <span style={{fontSize:11,fontFamily:'var(--font-mono)'}}>@{fmt.price(rt.buyPrice)}→{fmt.price(rt.sellPrice)}</span>
                        <span className={`roundtrip-pnl ${rt.pnl>=0?'val-buy':'val-sell'}`}>
                          {rt.pnl>=0?'+':''}{fmt.money(rt.pnl)} ({rt.pnlPct>=0?'+':''}{rt.pnlPct.toFixed(1)}%)
                        </span>
                      </div>
                    ))}
                    {s.roundTrips.length>8&&<div className="td-muted" style={{fontSize:11,padding:'4px 0'}}>+{s.roundTrips.length-8} more</div>}
                  </details>
                )}

                <details className="position-card__txns" open={perStockBreakdown.length===1}>
                  <summary>{displayRows.length} transaction{displayRows.length!==1?'s':''} for {s.ticker}{omOnly?' (open market only)':''}</summary>
                  <div className="position-card__txn-list">
                    {(inline?displayRows:displayRows.slice(0,5)).map((r,j)=><TRow key={j} r={r} showTicker={true} showInsider={false}/>)}
                  </div>
                  {!inline&&displayRows.length>5&&(
                    <button className="btn btn--ghost btn--sm position-card__view-full" onClick={()=>onExpand&&onExpand()}>
                      View full data — {displayRows.length} transactions →
                    </button>
                  )}
                </details>
              </div>
            );})}
          </>)}

        </>))}


        {d.type==='ticker'&&(busy?<div className="state-box" style={{padding:'2rem'}}><Spinner/><p>Loading…</p></div>:!tickerStats?<div className="state-box" style={{padding:'2rem'}}><p>No data.</p></div>:(<>
          {!hideProfileCard && <CompanyProfileCard ticker={d.ticker} cik={tickerRows?.[0]?.cik_issuer} company={d.company}/>}
          <div className="dp-summary">
            <div className="dp-sum-item"><span className="dp-sum-label">Buys</span><span className="val-buy dp-sum-val">{tickerStats.buys}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Sells</span><span className="val-sell dp-sum-val">{tickerStats.sells}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Net $</span><span className={`dp-sum-val ${tickerStats.net>=0?'val-buy':'val-sell'}`}>{tickerStats.net>=0?'+':''}{fmt.money(tickerStats.net)}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Exec</span><span className="dp-sum-val">{tickerStats.cSuite}</span></div>
            <div className="dp-sum-item"><span className="dp-sum-label">Insiders</span><span className="dp-sum-val">{tickerStats.insiders}</span></div>
          </div>
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
                <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{ins.title}</span>
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
          const isGoodOutcome = ret!=null ? (tt==='sell' ? ret<0 : ret>=0) : null;
          return(<>
            <div className="dp-summary">
              <div className="dp-sum-item"><span className="dp-sum-label">Type</span><Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Value</span><span className="dp-sum-val">{fmt.money(t.value)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Shares</span><span className="dp-sum-val">{fmt.number(t.shares)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">@ Price</span><span className="dp-sum-val">{fmt.price(pr)}{isForeign&&<span style={{color:'var(--amber-600)',fontSize:11}}> <IconWarning style={{width:9,height:9,display:'inline',verticalAlign:'-1px'}}/> verify (3x+ move)</span>}</span></div>
              {ret!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Now</span><span className={`dp-sum-val ${isGoodOutcome?'val-buy':'val-sell'}`}>{fmt.price(cur)} ({ret>=0?'+':''}{ret.toFixed(1)}%)</span></div>}
              {(t.pctOwnedChange||t.pct_owned_change)!=null&&<div className="dp-sum-item"><span className="dp-sum-label">Pos Δ</span><span className="dp-sum-val val-buy">+{(t.pctOwnedChange||t.pct_owned_change).toFixed(1)}%</span></div>}
            </div>
            <div className="dp-section-label" style={{marginTop:12}}>Insider</div>
            <div className="dp-insider-block">
              <div className="dp-insider-header">
                <RelBadge rel={t.relationship||'weak'}/>
                <span className="dp-clickable" style={{fontWeight:500,fontSize:12.5}} onClick={()=>nav('trader',{name:t.insiderName||t.insider_name,title:t.title||t.insider_title})}>{t.insiderName||t.insider_name}</span>
                <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{t.title||t.insider_title}</span>
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
// ── SentimentBar ─────────────────────────────────────────────────────────────
// Replaces the raw 5-stat pulse strip with meaningful market context:
//  • Fear & Greed score from feargreedchart.com (free, no key, CORS-enabled)
//  • SPY / QQQ / VIX prices from the same endpoint
//  • Seli's own 30-day insider net-buy ratio computed from your filings
// All of this is stable enough over a day to not feel stale on normal usage.
// ─── Market Pulse Tile ────────────────────────────────────────────────────────
// Consolidated: F&G score + index prices + insider flow + sector heatmap.
// Single API fetch. Finnhub fallback for index prices if raw_data unavailable.
const FG_COLORS = {
  'Extreme Fear':'#E55A55', Fear:'#E5943A', Neutral:'#9C9FAE',
  Greed:'#2DB87A', 'Extreme Greed':'#1A9E68',
};
function fgLabel(score) {
  if (score<=20) return 'Extreme Fear';
  if (score<=40) return 'Fear';
  if (score<=60) return 'Neutral';
  if (score<=80) return 'Greed';
  return 'Extreme Greed';
}

const SECTOR_WEIGHTS = [
  {label:'Technology',    sym:'XLK', weight:32.5},
  {label:'Financials',    sym:'XLF', weight:13.4},
  {label:'Healthcare',    sym:'XLV', weight:12.1},
  {label:'Industrials',   sym:'XLI', weight:8.9},
  {label:'Cons. Disc.',   sym:'XLY', weight:8.3},
  {label:'Comm. Svcs',    sym:'XLC', weight:8.2},
  {label:'Cons. Staples', sym:'XLP', weight:4.8},
  {label:'Energy',        sym:'XLE', weight:4.0},
  {label:'Materials',     sym:'XLB', weight:2.7},
  {label:'Utilities',     sym:'XLU', weight:2.5},
  {label:'Real Estate',   sym:'XLRE',weight:2.1},
];
const INDEX_SYMS = ['SPY','QQQ','IWM'];

// ─── Shared market data hook ──────────────────────────────────────────────────
// Fetches once per page load, shared between SentimentStrip and HeatmapOnly
// so we don't hit the API twice.
let _mktCache = null;
const _mktListeners = new Set();
function useMktData() {
  const [data, setData] = useState(_mktCache);
  useEffect(()=>{
    if (_mktCache) { setData(_mktCache); return; }
    const cb = d => setData(d);
    _mktListeners.add(cb);
    if (_mktListeners.size === 1) {
      // First subscriber kicks off the fetch
      fetch('https://feargreedchart.com/api/?action=all')
        .then(r=>r.json())
        .then(d=>{
          const market = d?.market || {};
          const out = { fgScore: d?.score?.score ?? null, indices:{}, sectors:{}, err:false };
          for (const [sym, item] of Object.entries(market)) {
            if (!item) continue;
            const price = item.price ?? item.close;
            const chg   = item.pct ?? item.chg;
            if (INDEX_SYMS.includes(sym))                    out.indices[sym]={price,chg};
            if (SECTOR_WEIGHTS.some(s=>s.sym===sym))         out.sectors[sym]={price,chg};
          }
          _mktCache = out;
          _mktListeners.forEach(fn=>fn(out));
        })
        .catch(()=>{
          const out = { fgScore:null, indices:{}, sectors:{}, err:true };
          _mktCache = out;
          _mktListeners.forEach(fn=>fn(out));
        });
    }
    return ()=>{ _mktListeners.delete(cb); };
  },[]);

  // Finnhub fallback for indices
  useEffect(()=>{
    if (!data || Object.keys(data.indices).length || !cfg.FINNHUB_API_KEY) return;
    Promise.all(INDEX_SYMS.map(sym=>
      fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${cfg.FINNHUB_API_KEY}`)
        .then(r=>r.json()).then(d=>({sym,price:d.c,chg:d.c&&d.pc?(((d.c-d.pc)/d.pc)*100):null}))
        .catch(()=>null)
    )).then(res=>{
      const idxOut={};
      for(const r of res) if(r?.price) idxOut[r.sym]={price:r.price,chg:r.chg};
      if(Object.keys(idxOut).length) {
        const updated = {...data, indices:idxOut};
        _mktCache = updated;
        setData(updated);
      }
    });
  },[data?.indices && Object.keys(data.indices).length]);

  return data;
}

// Full-width sentiment strip above the bento
function SentimentStrip({ filings }) {
  const mkt = useMktData();
  const insiderFlow = useMemo(()=>{
    const cut=(()=>{const d=new Date();d.setDate(d.getDate()-30);return d.toISOString().split('T')[0];})();
    const r=filings.filter(f=>(f.transactionDate||f.date||'')>=cut&&f.isOpenMarket);
    const bv=r.filter(f=>f.transactionType==='buy').reduce((s,f)=>s+(f.value||0),0);
    const sv=r.filter(f=>f.transactionType==='sell').reduce((s,f)=>s+(f.value||0),0);
    const t=bv+sv; if(!t) return null;
    const ratio=Math.round((bv/t)*100);
    return {ratio, label:ratio>=60?'Bullish':ratio>=45?'Neutral':'Bearish',
            color:ratio>=60?'var(--green-600)':ratio>=45?'var(--text-3)':'var(--red-600)'};
  },[filings]);

  const fgScore=mkt?.fgScore??null;
  const fgLbl=fgScore!=null?fgLabel(fgScore):null;
  const fgColor=fgLbl?FG_COLORS[fgLbl]:'var(--text-3)';
  const indices=mkt?.indices||{};

  return (
    <div className="mkt-tile mkt-tile--strip-only">
      <div className="mkt-tile__strip">
        <div className="mkt-stat mkt-stat--fg">
          <span className="mkt-stat__label">Sentiment</span>
          {fgScore!=null?<>
            <div className="mkt-fg-row">
              <span className="mkt-stat__val" style={{color:fgColor}}>{fgScore}</span>
              <span className="mkt-fg-lbl" style={{color:fgColor}}>{fgLbl}</span>
            </div>
            <div className="mkt-fg-bar">
              <div className="mkt-fg-bar__fill" style={{width:`${fgScore}%`,background:fgColor}}/>
              {[20,40,60,80].map(v=><div key={v} className="mkt-fg-bar__tick" style={{left:`${v}%`}}/>)}
            </div>
          </>:<span className="mkt-stat__loading">{mkt?.err?'—':'...'}</span>}
        </div>
        <div className="mkt-divider"/>
        {INDEX_SYMS.map(sym=>{
          const d=indices[sym];
          return (
            <div key={sym} className="mkt-stat">
              <span className="mkt-stat__label">{sym}</span>
              {d?.price!=null?<>
                <span className="mkt-stat__val">{fmt.price(d.price)}</span>
                {d.chg!=null&&<span className={`mkt-stat__chg ${d.chg>=0?'val-buy':'val-sell'}`}>{d.chg>=0?'+':''}{Number(d.chg).toFixed(2)}%</span>}
              </>:<span className="mkt-stat__loading">—</span>}
            </div>
          );
        })}
        <div className="mkt-divider"/>
        {insiderFlow&&(
          <div className="mkt-stat">
            <span className="mkt-stat__label">Insider flow (30d)</span>
            <span className="mkt-stat__val" style={{color:insiderFlow.color}}>{insiderFlow.label}</span>
            <span className="mkt-stat__chg" style={{color:'var(--text-3)'}}>{insiderFlow.ratio}% net buying</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Heatmap-only component — sits inside the left column tile
function HeatmapOnly() {
  const mkt = useMktData();
  const sectors=mkt?.sectors||{};
  const totalW=SECTOR_WEIGHTS.reduce((s,x)=>s+x.weight,0);

  function heatColor(chg) {
    if (chg==null) return 'var(--surface-3)';
    const a=Math.min(0.20+(Math.abs(chg)/3.5)*0.65,0.90);
    return chg>=0?`rgba(45,184,122,${a.toFixed(2)})`:`rgba(229,90,85,${a.toFixed(2)})`;
  }
  function heatText(chg) { return (chg!=null&&Math.abs(chg)>0.3)?'#fff':'var(--text-2)'; }

  return (
    <div className="mkt-tile__heatmap">
      <div className="mkt-heatmap-label">
        S&amp;P 500 sectors
        <span className="td-muted" style={{fontWeight:400,marginLeft:6}}>day return · by weight · ETF proxy</span>
        <TileInfoButton section="scoring" title="S&P 500 sector heatmap"/>
        {Object.keys(sectors).length===0&&(
          <span className="td-muted" style={{marginLeft:'auto',fontSize:11}}>
            {mkt?.err?'unavailable':'loading…'}
          </span>
        )}
      </div>
      <div className="mkt-heatmap-grid">
        {SECTOR_WEIGHTS.map(sec=>{
          const d=sectors[sec.sym];
          const chg=d?.chg??null, price=d?.price??null;
          const tc=heatText(chg);
          return (
            <div key={sec.sym} className={`mkt-heatmap-sq${chg==null?' mkt-heatmap-sq--empty':''}`}
              style={{flexBasis:`${(sec.weight/totalW)*100}%`,background:heatColor(chg)}}
              title={`${sec.label} (${sec.sym}) · ${price?`$${Number(price).toFixed(2)}`:'—'} · ${chg!=null?`${chg>=0?'+':''}${Number(chg).toFixed(2)}%`:'loading'}`}>
              <div className="mkt-heatmap-sq__name" style={{color:tc}}>{sec.label}</div>
              <div className="mkt-heatmap-sq__chg" style={{color:chg==null?'var(--text-3)':tc}}>
                {chg!=null?`${chg>=0?'+':''}${Number(chg).toFixed(2)}%`:sec.sym}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mkt-heatmap-legend">
        {[['≤−3%','rgba(229,90,85,0.9)'],['−1%','rgba(229,90,85,0.40)'],['flat','var(--surface-3)'],['1%','rgba(45,184,122,0.40)'],['≥3%','rgba(45,184,122,0.9)']].map(([l,c])=>(
          <div key={l} className="mkt-heatmap-legend__item">
            <div style={{width:10,height:10,borderRadius:2,background:c,border:'0.5px solid var(--border)'}}/>
            <span>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const DASH_DATE_OPTS = [{label:'1d',days:1},{label:'3d',days:3},{label:'7d',days:7},{label:'30d',days:30}];



// Single shared fetch for the Alpaca portfolio, used by the unified
// PortfolioSection below (summary + filing cross-reference + scoped news all
// need the same position list, so we fetch once and pass it down).
function usePortfolio(pro) {
  const [port, setPort] = useState(null);
  const [err,  setErr]  = useState(false);
  const [connected, setConnected] = useState(null); // null=checking, true/false once known
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [perf, setPerf] = useState(undefined); // undefined=not fetched, null=unavailable, [...points] once loaded

  const load = useCallback(async (isManualRefresh=false) => {
    if (!cfg.NEON_PROXY_URL) return;
    if (!pro) return; // avoid a call we already know the Worker will 403 — this is a Pro feature
    if (isManualRefresh) setRefreshing(true);
    try {
      const headers = await getAuthHeaders();
      // First check whether a brokerage is actually connected at all —
      // distinct from "connected but zero positions" or "not connected yet".
      const statusRes = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/status`, { headers }).then(r=>r.json()).catch(()=>null);
      if (!statusRes?.connection) { setConnected(false); return; }
      setConnected(true);

      const res = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/positions`, { headers });
      const data = await res.json();
      if (data.error) { setErr(true); return; }

      // Confirmed real shape (from an actual live response, not doc guessing):
      //   acct.positions = { results: [ { instrument: {symbol, raw_symbol,
      //     description}, units: "6.627678571", price: "42.385",
      //     cost_basis: "45.263209" } ], data_freshness: {...} }
      //   acct.balances = [ { currency: {...}, cash, buying_power } ]
      // Two things this fixes that the previous version got wrong: (1)
      // symbol lives under `instrument`, not directly on the position or
      // under a `.symbol` key; (2) units/price/cost_basis are STRINGS, not
      // numbers — this is exactly what caused the .toFixed() crash, since a
      // string silently flowed all the way to a render call expecting a
      // number.
      function extractPositionsArray(positions) {
        if (Array.isArray(positions)) return positions;
        if (positions && typeof positions === 'object') {
          if (Array.isArray(positions.results)) return positions.results;
          return Object.values(positions).filter(Array.isArray).flat();
        }
        return [];
      }

      const flatPositions = [];
      let totalValue = 0;
      for (const acct of (Array.isArray(data.accounts) ? data.accounts : [])) {
        for (const p of extractPositionsArray(acct.positions)) {
          const units = parseFloat(p.units) || 0;
          const price = parseFloat(p.price) || 0;
          const costBasis = p.cost_basis!=null ? parseFloat(p.cost_basis) : null;
          const marketValue = units * price;
          // Approximate unrealized gain/loss — real average cost per share
          // vs current price, times shares held. Not a substitute for the
          // brokerage's own official P/L (fees, partial-lot cost basis
          // nuances aren't captured here), but a solid real approximation.
          const openPnl = costBasis!=null ? (price - costBasis) * units : null;
          const openPnlPct = costBasis!=null && costBasis>0 ? ((price - costBasis) / costBasis) * 100 : null;
          flatPositions.push({
            symbol: p.instrument?.symbol || p.instrument?.raw_symbol || '—',
            company: p.instrument?.description || '',
            quantity: units,
            price,
            marketValue,
            openPnl,
            openPnlPct,
          });
          totalValue += marketValue;
        }
        for (const b of (Array.isArray(acct.balances) ? acct.balances : [])) {
          totalValue += b.cash || 0;
        }
      }
      setPort({ positions: flatPositions, totalValue });

      const perfRes = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/performance`, { headers }).then(r=>r.json()).catch(()=>null);
      setPerf(perfRes?.points?.length ? perfRes.points : null);
      setLastRefreshed(new Date());
      setErr(false);
    } catch (e) {
      console.error('[usePortfolio] failed:', e.message);
      setErr(true);
    } finally {
      if (isManualRefresh) setRefreshing(false);
    }
  }, [pro]);

  useEffect(() => {
    load();
    // Periodic auto-refresh — positions were previously a one-time snapshot
    // from whenever the page loaded, silently going stale the longer you
    // stayed on the page. Every 3 minutes strikes a reasonable balance
    // against hammering SnapTrade's API unnecessarily.
    const interval = setInterval(() => load(false), 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [load]);
  return { port, err, connected, refresh: () => load(true), refreshing, lastRefreshed, perf };
}

// News scoped specifically to the tickers actually held in the portfolio —
// distinct from MarketNews (broad headlines) and the old signal-ticker news,
// since "news about what I own" is a different question than "news about
// what insiders are buying."
function PortfolioTickerNews({ tickers }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(false);
  const hasKey = !!cfg.FINNHUB_API_KEY;
  const tickerKey = tickers.join(',');
  useEffect(()=>{
    if (!hasKey || !tickers.length) return;
    setLoading(true);
    const today=new Date().toISOString().split('T')[0];
    const from=new Date(); from.setDate(from.getDate()-5);
    const fromStr=from.toISOString().split('T')[0];
    Promise.all(tickers.slice(0,5).map(tk=>
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${tk}&from=${fromStr}&to=${today}&token=${cfg.FINNHUB_API_KEY}`)
        .then(r=>r.json()).then(a=>(a||[]).slice(0,2).map(n=>({...n,_ticker:tk}))).catch(()=>[])
    )).then(res=>{
      setNews(res.flat().filter(n=>n.headline&&n.url).sort((a,b)=>b.datetime-a.datetime).slice(0,6));
      setLoading(false);
    });
  },[tickerKey,hasKey]);

  if (!tickers.length) return null;
  if (!hasKey) return <div className="port-block__empty">News unavailable right now.</div>;
  if (loading) return <div style={{padding:'8px 0',display:'flex',justifyContent:'center'}}><Spinner size={14}/></div>;
  if (!news.length) return <div className="port-block__empty">No recent news for your holdings</div>;
  return (
    <div className="dash-news-list">
      {news.map((n,i)=>(
        <a key={i} className="dash-news-item" href={n.url} target="_blank" rel="noreferrer">
          <div className="dash-news-item__meta">
            <span className="ticker" style={{fontSize:11}}>{n._ticker}</span>
            <span className="td-muted" style={{fontSize:11}}>{n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}</span>
          </div>
          <div className="dash-news-item__headline">{n.headline}</div>
        </a>
      ))}
    </div>
  );
}

// Unified portfolio section: account summary, positions (flagged if an
// active insider signal exists on that ticker), explicit list of held
// tickers that have shown up in recent filings, and ticker-scoped news.

// Biggest movers — ranks tickers by absolute net $ flow across ALL sources
// (corporate + congressional combined), independent of the source-split
// tables above. This answers "what's moving the most" rather than "what's
// moving in each category," which the two source tables don't show on their own.

// Broad market news — Finnhub's general news category, not scoped to any
// ticker. Distinct from DashNews/PortfolioNews below, which are intentionally
// ticker-scoped to signals and holdings respectively.
// Shared fetch/filter logic between the compact dashboard tile and the
// expanded drawer, so the two never drift out of sync on what "My News"
// actually means.
//
// "My News" scope: starred tickers, plus tickers recently traded by
// followed insiders (derived from `filings`, which the dashboard already
// has loaded — there's no such thing as "news about an insider" from
// Finnhub, insiders aren't public entities with their own coverage, so the
// closest honest equivalent is news on what they've actually been trading).
// Capped at 15 tickers — Finnhub's free tier has no bulk multi-symbol news
// endpoint, so this is 15 real parallel requests, not one.
//
// Returns {ticker, reason} pairs, not bare strings — `reason` is what
// actually earns the personalization tag on each article: 'starred' if the
// ticker itself is on the watchlist, otherwise the name of the first
// followed insider whose trade pulled it in. A ticker can qualify both
// ways; starred wins since it's the more direct signal.
function useMyNewsTickers(watchlist, filings) {
  return useMemo(() => {
    if (!watchlist) return [];
    const starred = new Set(watchlist.tickers||[]);
    const reasonByTicker = new Map();
    for (const t of starred) reasonByTicker.set(t, 'starred');
    for (const f of (filings||[])) {
      if (!f.ticker || !f.insiderName || !watchlist.insiders?.includes(f.insiderName)) continue;
      if (!reasonByTicker.has(f.ticker)) reasonByTicker.set(f.ticker, f.insiderName);
    }
    return [...reasonByTicker.entries()].slice(0,15).map(([ticker,reason])=>({ticker,reason}));
  }, [watchlist?.tickers, watchlist?.insiders, filings]);
}

function useMarketNews({ myTickers, myNewsOn, limit }) {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(false);
  const hasKey = !!cfg.FINNHUB_API_KEY;
  const tickerKey = myTickers.map(t=>t.ticker).join(',');

  useEffect(() => {
    if (!hasKey) return;
    let cancelled = false;
    setLoading(true);

    if (myNewsOn) {
      if (!myTickers.length) { setNews([]); setLoading(false); return; }
      const to = new Date().toISOString().split('T')[0];
      const from = (()=>{const d=new Date();d.setDate(d.getDate()-14);return d.toISOString().split('T')[0];})();
      Promise.all(myTickers.map(({ticker,reason}) =>
        fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${cfg.FINNHUB_API_KEY}`)
          .then(r=>r.json()).then(a=>Array.isArray(a)?a.map(n=>({...n,_ticker:ticker,_reason:reason})):[]).catch(()=>[])
      )).then(results => {
        if (cancelled) return;
        const merged = results.flat()
          .filter(n=>n.headline&&n.url)
          .sort((a,b)=>(b.datetime||0)-(a.datetime||0))
          .slice(0, limit);
        setNews(merged); setLoading(false);
      });
    } else {
      fetch(`https://finnhub.io/api/v1/news?category=general&token=${cfg.FINNHUB_API_KEY}`)
        .then(r=>r.json())
        .then(a=>{
          if (cancelled) return;
          setNews((a||[]).filter(n=>n.headline&&n.url).slice(0, limit));
          setLoading(false);
        })
        .catch(()=>{ if(!cancelled) setLoading(false); });
    }
    return ()=>{ cancelled=true; };
  }, [hasKey, myNewsOn, limit, tickerKey]);

  return { news, loading, hasKey };
}

// Small tag showing exactly why an article surfaced under My News — the
// ticker, plus (on hover, and inline when it's not starred) which followed
// insider's trade actually pulled it in. Not just "personalized", a real
// reason.
function NewsMatchBadge({ ticker, reason }) {
  const viaInsider = reason && reason!=='starred';
  return (
    <span className="news-match-badge"
      title={viaInsider ? `${ticker} — matched via ${reason}'s recent trade` : `${ticker} — on your watchlist`}>
      {ticker}{viaInsider && <span className="news-match-badge__via"> · via {reason}</span>}
    </span>
  );
}

// Headlines open in a new tab rather than an in-app iframe — most
// publishers (Reuters, Bloomberg, WSJ, etc.) send X-Frame-Options or a CSP
// frame-ancestors header that blocks embedding entirely, so an iframe here
// would show a broken/blank frame for the majority of sources rather than
// the article. New tab is the reliable option, not a placeholder choice.
function NewsList({ news, loading, hasKey, emptyHint }) {
  if (!hasKey) return <div className="dp-placeholder" style={{padding:'1rem'}}><p style={{fontSize:11}}>No headlines available right now.</p></div>;
  if (loading) return <div style={{padding:'1.5rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>;
  if (!news.length) return <div style={{padding:'1rem',fontSize:12,color:'var(--text-3)'}}>{emptyHint||'No headlines available right now'}</div>;
  return (
    <div className="dash-news-list">
      {news.map((n,i)=>(
        <a key={i} className="dash-news-item" href={n.url} target="_blank" rel="noreferrer">
          <div className="dash-news-item__meta">
            {n._ticker&&<NewsMatchBadge ticker={n._ticker} reason={n._reason}/>}
            <span className="td-muted" style={{fontSize:11}}>{n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}</span>
          </div>
          <div className="dash-news-item__headline">{n.headline}</div>
        </a>
      ))}
    </div>
  );
}

function MarketNews({ watchlist, filings, limit=12, myNewsOn=false }) {
  const pro = !!watchlist?.pro;
  const myTickers = useMyNewsTickers(watchlist, filings);
  const { news, loading, hasKey } = useMarketNews({ myTickers, myNewsOn: myNewsOn&&pro, limit });

  return (
    <NewsList news={news} loading={loading} hasKey={hasKey}
      emptyHint={myNewsOn&&pro?'No recent news for your starred tickers or followed insiders\' trades.':undefined}/>
  );
}

function NewsDrawer({ watchlist, filings, onClose }) {
  const [myNewsOn, setMyNewsOn] = useState(false);
  const pro = !!watchlist?.pro;
  const myTickers = useMyNewsTickers(watchlist, filings);
  const { news, loading, hasKey } = useMarketNews({ myTickers, myNewsOn: myNewsOn&&pro, limit: 60 });

  return (
    <div className="drawer-overlay" onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="drawer drawer--news">
        <div className="drawer__hdr-row1">
          <span className="drawer__title">Market news</span>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <label
              className={`bundle-toggle${myNewsOn&&pro?' bundle-toggle--active':''}`}
              title={pro?'Only news for your starred tickers and followed insiders\' recent trades':'Pro feature — filters news to your starred tickers and followed insiders'}
            >
              <input type="checkbox" checked={myNewsOn&&pro}
                onChange={()=>pro?setMyNewsOn(v=>!v):watchlist?.setShowUpgrade?.('watchlist_ticker')}/>
              My news{!pro&&<span className="settings-pro-badge" style={{marginLeft:5}}>Pro</span>}
            </label>
            <button className="btn btn--ghost btn--icon" onClick={onClose}><IconClose style={{width:12,height:12}}/></button>
          </div>
        </div>
        <div className="drawer__body drawer__body--single">
          <NewsList news={news} loading={loading} hasKey={hasKey}
            emptyHint={myNewsOn&&pro?'No recent news for your starred tickers or followed insiders\' trades.':undefined}/>
        </div>
      </div>
    </div>
  );
}

// Tabbed signals workspace — the primary daily research surface.
// Each tab gets full tile width so rows are actually readable, unlike
// the three-column cramped layout. Tabs: Corporate | Congressional | Movers.

// ─── Home (mobile-only consolidated view) ─────────────────────────────────────
// Four fixed-height peek tiles — Portfolio, Recent Signals, Watchlist, Raw
// Data — each showing a handful of rows with sensible defaults, not the
// full filter controls those pages expose. "See all" hands off to the real
// page via seeAllFromHome, which is what powers the Home › Section
// breadcrumb back in AppInner. Reuses the exact same hooks/pipeline every
// other page already uses (usePortfolio, filterAndScoreSignals) rather
// than a parallel, simplified data path that could quietly drift from
// what the full pages actually show.
function HomeTile({ title, onSeeAll, children }) {
  return (
    <div className="home-tile">
      <div className="home-tile__hdr">
        <span className="home-tile__title">{title}</span>
        {onSeeAll && <button className="home-tile__see-all" onClick={onSeeAll}>See all →</button>}
      </div>
      <div className="home-tile__body">{children}</div>
    </div>
  );
}

function HomePage({ filings, loading, watchlist, user, onOpenDetail, onSeeAll }) {
  const pro = isPro(user);
  const portfolio = usePortfolio(pro);

  const recentSignals = useMemo(() => {
    if (!filings.length) return [];
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    return filterAndScoreSignals(filings, { cutoff: cutoffStr })
      .sort((a,b) => b.conviction - a.conviction)
      .slice(0, 4);
  }, [filings]);

  const watchlistFilings = useMemo(() => {
    if (!filings.length || (!watchlist.tickers.length && !watchlist.insiders.length)) return [];
    return filings
      .filter(f => watchlist.tickers.includes(f.ticker) || watchlist.insiders.includes(f.insiderName))
      .sort((a,b) => (b.transactionDate||b.date||'').localeCompare(a.transactionDate||a.date||''))
      .slice(0, 4);
  }, [filings, watchlist.tickers, watchlist.insiders]);

  const recentFilings = useMemo(() => {
    return [...filings]
      .sort((a,b) => (b.transactionDate||b.date||'').localeCompare(a.transactionDate||a.date||''))
      .slice(0, 4);
  }, [filings]);

  return (
    <div className="home-page">
      <HomeTile title="Recent Signals" onSeeAll={()=>onSeeAll('signals')}>
        {loading && <p className="home-tile__empty">Loading…</p>}
        {!loading && !recentSignals.length && <p className="home-tile__empty">No signals in the last 7 days.</p>}
        {recentSignals.map(s => (
          <div key={s.ticker} className="home-tile__row" onClick={()=>onSeeAll('signals')}>
            <span className="ticker">{s.ticker}</span>
            <span className="td-muted" style={{flex:1}}>{s.company}</span>
            <ConvictionBar score={s.conviction} max={15}/>
          </div>
        ))}
      </HomeTile>

      <HomeTile title="Raw Data" onSeeAll={()=>onSeeAll('data')}>
        {loading && <p className="home-tile__empty">Loading…</p>}
        {!loading && recentFilings.map((f,i) => (
          <div key={i} className="home-tile__row" onClick={()=>onSeeAll('data')}>
            <span className="td-date-main">{fmt.dateShort(f.transactionDate||f.date)}</span>
            <span className="ticker">{f.ticker}</span>
            <span className={f.transactionType==='buy' ? 'val-buy' : 'val-sell'} style={{marginLeft:'auto'}}>{fmt.money(f.value)}</span>
          </div>
        ))}
      </HomeTile>

      <HomeTile title="Portfolio" onSeeAll={pro && portfolio.connected ? () => onSeeAll('signals') : null}>
        {!pro && <p className="home-tile__empty">Portfolio linking is a Pro feature.</p>}
        {pro && portfolio.connected === false && (
          <p className="home-tile__empty">No brokerage connected — <button className="home-tile__link" onClick={()=>onSeeAll('settings')}>link your account</button> to see your real holdings.</p>
        )}
        {pro && portfolio.connected === null && <p className="home-tile__empty">Checking connection…</p>}
        {pro && portfolio.connected && portfolio.port && (
          <>
            <div className="home-tile__stat">{fmt.money(portfolio.port.totalValue)}</div>
            {portfolio.port.positions.slice(0, 3).map(p => (
              <div key={p.symbol} className="home-tile__row" onClick={()=>onSeeAll('signals')}>
                <span className="ticker">{p.symbol}</span>
                <span className="td-muted" style={{flex:1}}>{fmt.money(p.marketValue)}</span>
                {p.openPnlPct != null && <span className={p.openPnlPct >= 0 ? 'val-buy' : 'val-sell'}>{fmt.pct(p.openPnlPct)}</span>}
              </div>
            ))}
            {!portfolio.port.positions.length && <p className="home-tile__empty">Connected, no positions found.</p>}
          </>
        )}
      </HomeTile>

      <HomeTile title="Watchlist" onSeeAll={()=>onSeeAll('watchlist')}>
        {!watchlist.tickers.length && !watchlist.insiders.length && (
          <p className="home-tile__empty">No tickers or insiders followed yet.</p>
        )}
        {(watchlist.tickers.length > 0 || watchlist.insiders.length > 0) && !loading && !watchlistFilings.length && (
          <p className="home-tile__empty">Nothing new from your watchlist recently.</p>
        )}
        {watchlistFilings.map((f,i) => (
          <div key={i} className="home-tile__row" onClick={()=>onSeeAll('watchlist')}>
            <span className="ticker">{f.ticker}</span>
            <span className="td-muted" style={{flex:1}}>{f.insiderName}</span>
            <span className={f.transactionType==='buy' ? 'val-buy' : 'val-sell'}>{f.transactionType==='buy' ? 'Buy' : 'Sell'}</span>
          </div>
        ))}
      </HomeTile>

      {/* Reuses the real leaderboard component wholesale (same data fetch,
          same filter pills, same rows, and — as of this pass — the same
          mobile expand-in-place behavior) rather than a simplified parallel
          version. "See all" goes to Dashboard, which is where this same
          component already lives full-size; there's no separate dedicated
          Top Insiders page to link to instead. */}
      <HomeTile title="Top Insiders" onSeeAll={()=>onSeeAll('dashboard')}>
        <InsiderLeaderboardSidebar onOpenDetail={onOpenDetail} watchlist={watchlist}/>
      </HomeTile>
    </div>
  );
}

function DashboardPage({ filings, loading, onDrillSignal, onOpenDetail, watchlist }) {
  const [days, setDays] = useState(7);
  const isMobile = useIsMobile();
  const [newsExpanded, setNewsExpanded] = useState(false);
  const [newsMyNewsOn, setNewsMyNewsOn] = useState(false);
  const [insidersExpanded, setInsidersExpanded] = useState(false);
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);

  const signals = useMemo(()=>{
    const base = filings.filter(f=>
      f.isOpenMarket && f.transactionType==='buy' &&
      (f.transactionDate||f.date||'')>=cutoff
    );
    return buildSignals(base)
      .filter(s=>s.netValue>=100_000||s.cSuiteBuys>=1||s.isPolitical)
      .sort((a,b)=>b.conviction-a.conviction)
      .slice(0,30);
  },[filings,cutoff]);

  return (
    <div className="page-content">
      <SentimentStrip filings={filings}/>

      <div className="dash-bento">

        {/* LEFT: Heatmap (top) + Signals (below, scrollable) */}
        <div className="dash-col-left">
          <div className="dash-tile dash-tile--heatmap">
            <HeatmapOnly/>
          </div>
          <div className="dash-tile dash-tile--signals">
            <div className="dash-tile__hdr">
              <span className="dash-tile__title">Insider signals</span>
              <TileInfoButton section="scoring" title="Insider signals"/>
              <div className="dash-tile__hdr-controls">
                <div className="dash-tile-pills">
                  {DASH_DATE_OPTS.map(o=>(
                    <button key={o.label} className={`dash-tile-pill${days===o.days?' dash-tile-pill--active':''}`} onClick={()=>setDays(o.days)}>{o.label}</button>
                  ))}
                </div>
                <span className="dash-tile__sub">{signals.length} signals</span>
              </div>
            </div>
            <div className="dash-tile__body">
              {loading?<div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div>
              :signals.length===0?<div className="dash-inner-empty">
                <div style={{fontWeight:500,marginBottom:4}}>No signals in this window</div>
                <div style={{fontSize:11,color:'var(--text-3)',lineHeight:1.5}}>Form 4s are filed 1–2 days after transactions. Try the 7d or 30d window.</div>
              </div>
              :<div className="dash-sig-list">
                {signals.map(s=>{
                  const spent=s.avgReturn!=null&&s.avgReturn>20;
                  const big=s.avgReturn!=null&&s.avgReturn>50;
                  const hasReversal=detectReversalForTicker(s.ticker,filings);
                  return (
                    <div key={s.ticker} className="dash-sig-item" onClick={()=>{ if (!isMobile) onOpenDetail&&onOpenDetail({type:'signal',...s}); }}>
                      <div className="dash-sig-item__left">
                        <div className="dash-sig-item__row1">
                          <span className="ticker" style={{fontSize:13,fontWeight:700}}>{s.ticker}</span>
                          {hasReversal&&<span className="reversal-badge" title="An insider on this ticker recently traded in the opposite direction of their prior trade — previously buying, now selling (or vice versa)."><IconReversal className="reversal-badge__icon"/>reversal</span>}
                          <StarBtn ticker={s.ticker} watchlist={watchlist}/>
                        </div>
                        <div className="dash-sig-item__row2">
                          <span style={{fontSize:11,color:'var(--text-2)'}}>{s.company}</span>
                        </div>
                        <div className="dash-sig-item__row3">
                          <span className="td-muted" style={{fontSize:11}}>
                            {s.insiderCount} insider{s.insiderCount!==1?'s':''}
                            {s.cSuiteBuys>0?` · ${s.cSuiteBuys} exec buy${s.cSuiteBuys!==1?'s':''}`:''}
                          </span>
                          <span className="td-muted" style={{fontSize:11}}>{fmt.ago(s.lastTradeDate)}</span>
                        </div>
                      </div>
                      <div className="dash-sig-item__right">
                        <span className="dash-sig-item__net-label">Net flow</span>
                        <div className={`dash-sig-item__net ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</div>
                        {s.avgReturn!=null&&(
                          <span className={`ins-spent-badge ${big?'ins-spent-badge--big':spent?'ins-spent-badge--spent':'ins-spent-badge--fresh'}`}>
                            {s.avgReturn>=0?'+':''}{s.avgReturn.toFixed(0)}% {big||spent?'spent':'fresh'}
                          </span>
                        )}
                        <ConvictionBar score={s.conviction} showLabel={true}/>
                      </div>
                    </div>
                  );
                })}
              </div>}
            </div>
          </div>
        </div>

        {/* RIGHT: Top insiders (top, fixed) + News (bottom, scrollable) */}
        <div className="dash-col-right">
          <div className="dash-tile dash-tile--top-insiders">
            <div className="dash-tile__hdr">
              <span className="dash-tile__title">Top insiders</span>
              <TileInfoButton section="scoring" title="Top insiders"/>
              <div className="dash-tile__hdr-controls">
                <button className="btn btn--ghost btn--icon" onClick={()=>setInsidersExpanded(true)} title="Open full insiders view">⤢</button>
              </div>
            </div>
            <div className="dash-tile__body">
              <InsiderLeaderboardSidebar onOpenDetail={onOpenDetail} watchlist={watchlist}/>
            </div>
          </div>
          <div className="dash-tile dash-tile--news">
            <div className="dash-tile__hdr">
              <span className="dash-tile__title">Market news</span>
              <TileInfoButton section="welcome" title="Market news"/>
              <div className="dash-tile__hdr-controls">
                {watchlist&&(
                  <label
                    className={`bundle-toggle${newsMyNewsOn&&watchlist.pro?' bundle-toggle--active':''}`}
                    title={watchlist.pro?'Only news for your starred tickers and followed insiders\' recent trades':'Pro feature — filters news to your starred tickers and followed insiders'}
                  >
                    <input type="checkbox" checked={newsMyNewsOn&&watchlist.pro}
                      onChange={()=>watchlist.pro?setNewsMyNewsOn(v=>!v):watchlist.setShowUpgrade?.('watchlist_ticker')}/>
                    My news{!watchlist.pro&&<span className="settings-pro-badge" style={{marginLeft:5}}>Pro</span>}
                  </label>
                )}
                <button className="btn btn--ghost btn--icon" onClick={()=>setNewsExpanded(true)} title="Open full news view">⤢</button>
              </div>
            </div>
            <div className="dash-tile__body">
              <MarketNews watchlist={watchlist} filings={filings} limit={12} myNewsOn={newsMyNewsOn}/>
            </div>
          </div>
        </div>

      </div>
      {newsExpanded&&<NewsDrawer watchlist={watchlist} filings={filings} onClose={()=>setNewsExpanded(false)}/>}
      {insidersExpanded&&(
        <InsightsDrawer
          type="insiders"
          filings={filings}
          watchlist={watchlist}
          onClose={()=>setInsidersExpanded(false)}
          sigSort="conviction" sigDir={-1} sigOnSort={()=>{}}
          ensureFilingsWindow={()=>{}}
          filingsLoading={loading}
        />
      )}
    </div>
  );
}

// Helper — does this ticker have a reversal in the last 30d?
// Cheap per-row check using cached reversal list passed in.
function detectReversalForTicker(ticker, filings) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-30);
  const iso = cutoff.toISOString().split('T')[0];
  const rows = filings.filter(f=>f.ticker===ticker&&f.isOpenMarket&&(f.transactionDate||f.date||'')>=iso);
  const types = new Set(rows.map(f=>f.transactionType));
  return types.has('buy')&&types.has('sell');
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

// ─── INSIGHTS PAGE ────────────────────────────────────────────────────────────
function InsightsPage({ filings, loading, highlightTicker, setHighlightTicker, onSelectSignal, selectedSignal, onOpenDetail, onCloseDetail, user, ensureFilingsWindow, watchlist }) {
  const pro = isPro(user);
  const [appetite] = React.useContext(RiskAppetiteContext);
  const [days, setDays] = useState(7);
  // days=null means "All" — must resolve to no cutoff at all, not today's
  // date. The date-arithmetic version below silently coerced null to 0,
  // which set the cutoff to today (the narrowest possible window, the exact
  // opposite of "All") rather than an unbounded one.
  const cutoff = useMemo(()=>{
    if (days==null) return '2021-01-01'; // earliest data in the DB, matches edgar.js's own all-time floor
    const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];
  },[days]);
  const [sigSort, setSigSort] = useState('conviction');
  const [sigDir,  setSigDir]  = useState(-1);
  const [sourceF, setSourceF] = useState('');
  const [sectorF, setSectorF] = useState('');
  const [tab, setTab] = useState('research');
  const [minStrength, setMinStrength] = useState(1); // 1=any 2=medium+ 3=high only
  const [modal, setModal] = useState(null); // 'signals' | 'insiders' | null
  const [modalInitial, setModalInitial] = useState(null); // pre-selected item when opening
  const hlRef = useRef(null);
  const isMobile = useIsMobile();
  // Mobile-only: tapping a row expands it in place instead of opening the
  // right-side drawer — there's no room for a side panel on a phone, and
  // this was the actual cause of the "padding disappears after load" bug
  // too (the row's 5-column desktop grid has no mobile layout at all, so
  // once signals populated and rows rendered, the fixed-width columns
  // simply didn't fit and overflowed past the right edge). Desktop is
  // unaffected — same drawer, same click behavior as always.
  const [expandedTicker, setExpandedTicker] = useState(null);

  // Opens the Explore drawer pre-selected to whatever was clicked, instead of
  // the small centered quick-info modal — keeps this page's detail-viewing
  // in one consistent environment rather than two different ones.
  function openInDrawer(d) {
    if (d.type==='trader') { setModal('insiders'); setModalInitial(d); }
    else { setModal('signals'); setModalInitial(d); }
  }

  const sectors = useMemo(()=>[...new Set(filings.map(f=>f.sector).filter(s=>s&&s!=='Other'))].sort(),[filings]);

  // Conviction thresholds matching the bar segments (max=15): 33%=5, 66%=10
  const strengthThreshold = minStrength===3?10:minStrength===2?5:0;

  const signals = useMemo(()=>{
    const result = filterAndScoreSignals(filings, { cutoff, sourceF, sectorF, strengthThreshold });

    return result
      .sort((a,b)=>{
        const av=a[sigSort],bv=b[sigSort];
        let r;
        if(typeof av==='number') r = av<bv?-1:av>bv?1:0;
        else r = String(av||'').localeCompare(String(bv||''));
        return sigDir>0?r:-r;
      });
  },[filings,cutoff,sourceF,sectorF,sigSort,sigDir,strengthThreshold]);

  useEffect(()=>{
    if (highlightTicker&&hlRef.current)
      hlRef.current.scrollIntoView({behavior:'smooth',block:'center'});
  },[highlightTicker,signals]);

  function sigOnSort(col){if(sigSort===col)setSigDir(d=>-d);else{setSigSort(col);setSigDir(-1);}}
  function resetFilters(){setDays(7);setMinStrength(1);setSourceF('');setSectorF('');}
  const filtersAreDefault = days===7 && minStrength===1 && !sourceF && !sectorF;

  return (
    <div className="page-content">
      {/* Portfolio bar — above everything, full width */}
      {/* Two-column body — signals | insiders */}
      <div className="ins-3col">

        {/* LEFT: Signals */}
        <div className="ins-sig-panel ins-3col__signals">
          <div className="ins-sig-panel__hdr">
            <span className="ins-sig-panel__title">Insider signals</span>
            <TileInfoButton section="scoring" title="Insider signals"/>
            {!isMobile && (
              <div className="dash-tile__hdr-controls">
                <button className="btn btn--ghost btn--icon" onClick={()=>{onCloseDetail&&onCloseDetail();setModal('signals');}} title="Open full Explore view">⤢</button>
              </div>
            )}
          </div>

          {/* Filters — belong to this panel specifically, not floating above
              both columns ambiguously. Each group gets its own labeled block
              with real spacing so they read as distinct controls. */}
          <div className="ins-filter-row">
            <div className="ins-filter-group">
              <span className="ins-filter-group__label">Window</span>
              <div className="dash-tile-pills">
                {[{v:1,l:'1d'},{v:3,l:'3d'},{v:7,l:'7d'},{v:30,l:'30d'},{v:90,l:'90d'},{v:null,l:'All'}].map(o=>(
                  <button key={o.l} className={`dash-tile-pill${days===o.v?' dash-tile-pill--active':''}`}
                    onClick={()=>{setDays(o.v);ensureFilingsWindow&&ensureFilingsWindow(o.v);}}>{o.l}</button>
                ))}
              </div>
            </div>
            <div className="drawer__toolbar-divider"/>
            <div className="ins-filter-group">
              <span className="ins-filter-group__label">Strength</span>
              <div className="ins-strength-pills">
                {[{v:1,l:'Any'},{v:2,l:'Med+'},{v:3,l:'High'}].map(o=>(
                  <button key={o.v}
                    className={`ins-strength-pill${minStrength===o.v?' ins-strength-pill--active':''}`}
                    style={o.v===3&&minStrength===3?{background:'var(--green-600)',borderColor:'var(--green-600)',color:'#fff'}:
                           o.v===2&&minStrength===2?{background:'var(--amber-600)',borderColor:'var(--amber-600)',color:'#fff'}:{}}
                    onClick={()=>setMinStrength(o.v)}>{o.l}</button>
                ))}
              </div>
            </div>
            <div className="drawer__toolbar-divider"/>
            <div className="ins-filter-group">
              <span className="ins-filter-group__label">Type</span>
              <div className="dash-tile-pills">
                {[['','All'],['corporate','Corporate'],['political','Congressional']].map(([v,l])=>(
                  <button key={v} className={`dash-tile-pill${sourceF===v?' dash-tile-pill--active':''}`}
                    onClick={()=>{
                      setSourceF(v);
                      // Congressional filings can take up to 45 days to be
                      // disclosed — a real, structural lag, not a bug. A
                      // narrow window (the 7-day default, or anything under
                      // 90) will very often show zero congressional activity
                      // even when hundreds of real filings exist, simply
                      // because most haven't been required to file yet by
                      // that point. Widen automatically rather than let
                      // someone select "Congressional" and reasonably
                      // conclude the feature is broken.
                      if (v==='political' && (days==null ? false : days<90)) {
                        setDays(90);
                        ensureFilingsWindow&&ensureFilingsWindow(90);
                      }
                    }}>{l}</button>
                ))}
              </div>
            </div>
            <div className="drawer__toolbar-divider"/>
            <div className="ins-filter-group">
              <span className="ins-filter-group__label">Sector</span>
              <select className="ins-filter-select" value={sectorF} onChange={e=>setSectorF(e.target.value)}>
                <option value="">All sectors</option>
                {sectors.map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <span className="td-muted ins-filter-count">
              {signals.length} signals
              {!pro&&<span className="free-tier-inline"> · free plan: last 12mo only</span>}
            </span>
            {!filtersAreDefault&&(
              <button className="ins-filter-reset" onClick={resetFilters}>Reset filters</button>
            )}
          </div>

          <div className="ins-sig-col-hdrs">
            <button className="ins-col-sort" onClick={()=>sigOnSort('ticker')}>Ticker · Company{sigSort==='ticker'&&(sigDir<0?' ↓':' ↑')}</button>
            <span>Type</span>
            <button className="ins-col-sort" onClick={()=>sigOnSort('cSuiteBuys')}>Exec{sigSort==='cSuiteBuys'&&(sigDir<0?' ↓':' ↑')}</button>
            <button className="ins-col-sort" title="Conviction = exec participation × buy size × clustering" onClick={()=>sigOnSort('conviction')}>Signal ⓘ{sigSort==='conviction'&&(sigDir<0?' ↓':' ↑')}</button>
            <button className="ins-col-sort" style={{textAlign:'right',justifyContent:'flex-end'}} onClick={()=>sigOnSort('netValue')}>Net flow{sigSort==='netValue'&&(sigDir<0?' ↓':' ↑')}</button>
          </div>
          <div className="ins-sig-panel__body">
            {loading?<div className="state-box"><Spinner/><p>Computing signals…</p></div>
            :signals.length===0?<div className="ins-empty">
              <div style={{fontWeight:500,marginBottom:4}}>No qualifying signals</div>
              <div style={{fontSize:11,color:'var(--text-3)',lineHeight:1.5}}>
                {minStrength>1
                  ? 'Try lowering the strength filter or widening the timespan.'
                  : sourceF==='political'
                    ? 'Congressional trades can take up to 45 days to be disclosed — a much longer lag than corporate Form 4s. Try widening the window to 90d or All.'
                    : 'Form 4s file 1–2 business days after trades. Try 7d or 30d.'}
              </div>
            </div>
            :<div className="ins-sig-list">
              {signals.map((s,i)=>{
                const isHL=s.ticker===highlightTicker, isSel=s.ticker===selectedSignal?.ticker;
                const spent=s.avgReturn!=null&&s.avgReturn>20, big=s.avgReturn!=null&&s.avgReturn>50;
                const hasReversal=detectReversalForTicker(s.ticker,filings);
                const isCongress=s.isPolitical;
                const typeLabel=isCongress?'Congressional':'Corporate';
                const convPct=Math.min((s.conviction/15)*100,100);
                const tier=tierFromPct(convPct, appetite);
                return (
                  <div key={s.ticker} ref={isHL?hlRef:null}
                    className={`ins-sig-row ins-sig-row--${tier}${isSel?' ins-sig-row--selected':''}${isMobile&&expandedTicker===s.ticker?' ins-sig-row--expanded':''}`}
                    onClick={()=>{
                      if (isMobile) { setExpandedTicker(k => k===s.ticker ? null : s.ticker); return; }
                      setHighlightTicker(s.ticker);onSelectSignal(s);openInDrawer({type:'signal',...s});
                    }}>
                    <div className="ins-sig-row__left">
                      <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
                        <span className="ticker ins-sig-row__ticker">{s.ticker}</span>
                        {s.isPolitical&&<span className="badge badge--src-congress">Congress</span>}
                        {hasReversal&&<span className="reversal-badge" title="Insider recently traded in the opposite direction of their prior trade"><IconReversal className="reversal-badge__icon"/></span>}
                        <StarBtn ticker={s.ticker} watchlist={watchlist}/>
                      </div>
                      <div className="ins-sig-row__co">{s.company}</div>
                      {s.sector&&s.sector!=='Other'&&<div className="td-muted" style={{fontSize:11}}>{s.sector}</div>}
                    </div>
                    <div className="ins-sig-row__type">
                      <span className={`ins-type-badge${isCongress?' ins-type-badge--congress':''}`}>{typeLabel}</span>
                      <div className="td-muted ins-sig-row__type-meta">
                        {s.insiderCount} insider{s.insiderCount!==1?'s':''} · {fmt.ago(s.lastTradeDate)}
                      </div>
                    </div>
                    <div className="ins-sig-row__exec">
                      {s.cSuiteBuys>0
                        ? <span className="csuite-badge">{s.cSuiteBuys}×</span>
                        : <span className="td-muted" style={{fontSize:11}}>—</span>}
                    </div>
                    <div className="ins-sig-row__signal">
                      <ConvictionBar score={s.conviction} showLabel={true}/>
                      {s.avgReturn!=null&&(
                        <span className={`ins-spent-badge ${big?'ins-spent-badge--big':spent?'ins-spent-badge--spent':'ins-spent-badge--fresh'}`}>
                          {s.avgReturn>=0?'+':''}{s.avgReturn.toFixed(0)}% {big||spent?'spent':'fresh'}
                        </span>
                      )}
                    </div>
                    <div className="ins-sig-row__right">
                      <span className={`ins-sig-row__net ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
                    </div>
                    {/* Mobile-only — everything above hidden by default via CSS
                        (see .ins-sig-row--expanded), shown here as a proper
                        expanded block instead — with real detail, so there's
                        no need to jump anywhere else to actually see it. */}
                    {isMobile && (
                      <div className="ins-sig-row__expand-chevron">{expandedTicker===s.ticker ? '▴ Less' : '▾ More'}</div>
                    )}
                    {isMobile && expandedTicker===s.ticker && (
                      <div className="ins-sig-row__expanded" onClick={e=>e.stopPropagation()}>
                        <div className="ins-sig-row__expanded-grid">
                          <div><span className="td-muted">Type</span><br/>{typeLabel}</div>
                          <div><span className="td-muted">Sector</span><br/>{s.sector&&s.sector!=='Other'?s.sector:'—'}</div>
                          <div><span className="td-muted">Buys / Sells</span><br/>{s.buys} / {s.sells}</div>
                          <div><span className="td-muted">Insiders</span><br/>{s.insiderCount} · {fmt.ago(s.lastTradeDate)}</div>
                          <div><span className="td-muted">Exec buys</span><br/>{s.cSuiteBuys>0?`${s.cSuiteBuys}×`:'—'}</div>
                          {s.isPolitical && <div><span className="td-muted">Political buys</span><br/>{s.politicalBuys>0?`${s.politicalBuys}×`:'—'}</div>}
                          <div><span className="td-muted">Conviction score</span><br/>{s.conviction.toFixed(1)} / 15</div>
                          <div><span className="td-muted">Net flow</span><br/><span className={s.netValue>=0?'val-buy':'val-sell'}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span></div>
                          {s.avgReturn!=null && (
                            <div><span className="td-muted">Since trade</span><br/><span className={spent?'ins-spent-badge--spent':'ins-spent-badge--fresh'}>{s.avgReturn>=0?'+':''}{s.avgReturn.toFixed(0)}% {big||spent?'spent':'fresh'}</span></div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>}
          </div>
        </div>

      </div>

      {modal&&(
        <InsightsDrawer
          type={modal}
          filings={filings}
          initialDetail={modalInitial}
          onClose={()=>{setModal(null);setModalInitial(null);}}
          sigSort={sigSort} sigDir={sigDir} sigOnSort={sigOnSort}
          ensureFilingsWindow={ensureFilingsWindow} filingsLoading={loading}
          watchlist={watchlist}
          initialFilters={{days, sourceF, sectorF, minStrength}}
        />
      )}
    </div>
  );
}

// ─── InsightsDrawer ───────────────────────────────────────────────────────────
// Two-pane deep-dive drawer:
//   Left pane  = sortable/filterable list (signals or insiders)
//   Right pane = DetailPanel rendered inline with its own nav stack
// Clicking any row in the left pane drives the right pane without closing.
// Within the right pane, clicking an insider name / ticker navigates inline
// via the same back-button stack DetailPanel already supports.
function InsightsDrawer({ type, filings, onClose, sigSort, sigDir, sigOnSort, initialDetail, initialDetailStack, ensureFilingsWindow, filingsLoading, watchlist, initialFilters }) {
  const [appetite] = React.useContext(RiskAppetiteContext);

  // ── left pane state ──────────────────────────────────────────────────────
  // Seeded from the tile's current selections when opened via "Explore full
  // view" or a row click, so filtering work already done on the tile isn't
  // silently discarded — falls back to these defaults when opened with no
  // tile context (e.g. a deep-linked ticker/insider URL).
  const [search, setSearch]   = useState('');
  const [lbRows, setLbRows]   = useState(null);
  const [lbSort, setLbSort]   = useState('hit_rate');
  const [lbYearsBack, setLbYearsBack] = useState(2); // null = all-time
  const [lbSource, setLbSource] = useState(null); // null='all' | 'corporate' | 'congress'
  const [lbMinValue, setLbMinValue] = useState(50000); // minimum bought_value, filtered client-side — defaults to $50K rather than "Any" so a handful of small trades hitting 100% by chance doesn't dominate the default hit-rate sort
  const [lbDir,  setLbDir]    = useState(-1);
  const [srcF,   setSrcF]     = useState(initialFilters?.sourceF ?? '');
  const [secF,   setSecF]     = useState(initialFilters?.sectorF ?? '');
  const [minStr, setMinStr]   = useState(initialFilters?.minStrength ?? 1);
  const [daysBack, setDaysBack] = useState(initialFilters?.days ?? 30); // null = All time
  const [minValue, setMinValue] = useState(0);  // $ net value floor — tile has no equivalent to seed from

  // ── right pane nav stack ─────────────────────────────────────────────────
  // Each entry is a {type, ...props} detail object — same shape as DetailPanel's `detail` prop.
  // Seeded from initialDetailStack when arriving via "Expand" from the small
  // panel, so navigation history from before expanding isn't silently lost —
  // otherwise this always started empty regardless of what was already open.
  const [detailStack, setDetailStack] = useState(() => initialDetailStack || []); // history
  const [detail,      setDetail]      = useState(null);

  function navigate(d) {
    if (detail) setDetailStack(s=>[...s, detail]);
    setDetail(d);
  }
  function goBack() {
    const prev = detailStack[detailStack.length-1];
    setDetailStack(s=>s.slice(0,-1));
    setDetail(prev||null);
  }

  // Sectors for filter dropdown
  const sectors = useMemo(()=>[...new Set(filings.map(f=>f.sector).filter(s=>s&&s!=='Other'))].sort(),[filings]);

  // Strength threshold
  const strengthThreshold = minStr===3?10:minStr===2?5:0;

  // Filtered signals — computed directly from raw `filings`, NOT from the
  // `signals` prop the parent page passes in. The parent's own signal set is
  // already bounded by whatever day-range IT has selected (default 7d), so
  // filtering further inside the drawer could only ever narrow within that —
  // widening the Window filter here would do nothing, since data outside the
  // parent's window was never in the array to begin with. Building fresh from
  // `filings` makes the drawer's own Window filter the real source of truth.
  const filteredSignals = useMemo(()=>{
    const cutoff = daysBack!=null ? (()=>{ const d=new Date(); d.setDate(d.getDate()-daysBack); return d.toISOString().split('T')[0]; })() : null;
    const base = filings.filter(f=>{
      const tx = f.transactionDate||f.date||'';
      if (cutoff && tx<cutoff) return false;
      const isPol = !!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
      if (srcF==='corporate'&&isPol) return false;
      if (srcF==='political'&&!isPol) return false;
      if (secF&&f.sector!==secF) return false;
      return true;
    });
    let s = buildSignals(base)
      .filter(sig=>sig.cSuiteBuys>=1||sig.insiderCount>=2||sig.netValue>=100_000||sig.isPolitical)
      .filter(sig=>sig.conviction>=strengthThreshold);
    if (minValue>0) s = s.filter(sig=>Math.abs(sig.netValue)>=minValue);
    if (search) { const q=search.toLowerCase(); s=s.filter(sig=>sig.ticker.toLowerCase().includes(q)||sig.company.toLowerCase().includes(q)); }
    return s.sort((a,b)=>{
      const av=a[sigSort],bv=b[sigSort];
      if(typeof av==='number'){if(av<bv)return sigDir;if(av>bv)return -sigDir;}
      else{const r=String(av||'').localeCompare(String(bv||''));return sigDir>0?r:-r;}
      return 0;
    });
  },[filings,strengthThreshold,srcF,secF,daysBack,minValue,search,sigSort,sigDir]);

  // Insiders
  useEffect(()=>{
    if (type!=='insiders') return;
    queryNeon(LEADERBOARD_QUERY(200, null, 2, lbYearsBack, lbSource))
      .then(r=>setLbRows(processLeaderboardRows(r)))
      .catch(()=>setLbRows([]));
  },[type,lbYearsBack,lbSource]);

  const sortedLb = useMemo(()=>{
    if (!lbRows) return [];
    let rows = lbRows;
    if (search) { const q=search.toLowerCase(); rows=rows.filter(r=>r.insider_name.toLowerCase().includes(q)); }
    if (lbMinValue>0) { rows=rows.filter(r=>(r.bought_value||0)>=lbMinValue); }
    return [...rows].sort((a,b)=>{
      const av=a[lbSort]??-Infinity, bv=b[lbSort]??-Infinity;
      return lbDir>0?av-bv:bv-av;
    });
  },[lbRows,lbSort,lbDir,search,lbMinValue]);
  function lbOnSort(col){ if(lbSort===col)setLbDir(d=>-d); else{setLbSort(col);setLbDir(-1);} }

  function resetDrawerFilters(){setMinStr(1);setDaysBack(30);setMinValue(0);setSrcF('');setSecF('');setSearch('');}
  const drawerFiltersDefault = minStr===1 && daysBack===30 && minValue===0 && !srcF && !secF && !search;

  // Escape key
  useEffect(()=>{
    const h=e=>{ if(e.key==='Escape') { if(detail&&detailStack.length) goBack(); else if(detail) setDetail(null); else onClose(); }};
    window.addEventListener('keydown',h);
    return()=>window.removeEventListener('keydown',h);
  },[detail,detailStack,onClose]);

  // Open pre-selected to whatever was clicked, if anything — otherwise fall
  // back to the first item so the pane is never empty on open.
  useEffect(()=>{
    if (detail) return;
    if (initialDetail) { setDetail(initialDetail); return; }
    if (type==='signals' && filteredSignals.length) setDetail({type:'signal',...filteredSignals[0]});
  },[type, filteredSignals.length > 0, initialDetail]);

  useEffect(()=>{
    if (detail) return;
    if (initialDetail) return; // already handled above
    if (type==='insiders' && sortedLb.length) setDetail({type:'trader',name:sortedLb[0].insider_name,title:sortedLb[0].insider_title});
  },[type, sortedLb.length > 0, initialDetail]);

  // Scroll the left list to whatever's selected when the drawer first opens —
  // without this, expanding from a quick-glance preview lands the user on a
  // fully-scrolled, freshly-sorted list with the actual selection potentially
  // way off-screen, making it hard to tell what's selected or how it relates
  // to everything else in the list. Only fires once per open, not on every
  // later click within the drawer — a row the user just clicked is already
  // visible, so re-scrolling then would just be disorienting.
  const listRef = useRef(null);
  const scrolledOnOpenRef = useRef(false);
  useEffect(()=>{
    if (scrolledOnOpenRef.current || !detail) return;
    const key = detail.type==='trader' ? detail.name : detail.ticker;
    if (!key) return;
    const el = listRef.current?.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      scrolledOnOpenRef.current = true;
    }
  },[detail, filteredSignals, sortedLb]);

  return (
    <div className="drawer-overlay" onClick={e=>{ if(e.target.classList.contains('drawer-overlay')) onClose(); }}>
      <div className="drawer">

        {/* ── Drawer header ─────────────────────────────────────────── */}
        <div className="drawer__hdr drawer__hdr--stacked">
          {/* Row 1 — identity + close only. Filters (including search) live
              together in row 2 as one real toolbar, not split across two
              places. */}
          <div className="drawer__hdr-row1">
            <span className="drawer__title">
              {type==='signals' ? 'Insider Signals' : 'Top Insiders'}
            </span>
            <button className="modal-close" onClick={onClose} title="Close (Esc)"><IconClose style={{width:12,height:12}}/></button>
          </div>

          {/* Row 2 — one unified toolbar. Search is a filter like any other,
              so it lives in the same row with the same divider treatment
              instead of floating alone above everything else. */}
          {type==='signals'&&(
            <div className="drawer__toolbar">
              <div className="drawer__filter-group drawer__filter-group--search">
                <span className="drawer__filter-label">Search</span>
                <div className="drawer__search-wrap">
                  <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input className="drawer__search" placeholder="Ticker or company…"
                    value={search} onChange={e=>setSearch(e.target.value)} autoFocus/>
                </div>
              </div>

              <div className="drawer__toolbar-divider"/>

              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Strength</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[{v:1,l:'Any'},{v:2,l:'Med+'},{v:3,l:'High'}].map(o=>(
                    <button key={o.v}
                      className={`dash-tile-pill${minStr===o.v?' dash-tile-pill--active':''}`}
                      style={o.v===3&&minStr===3?{background:'var(--green-600)',borderColor:'var(--green-600)',color:'#fff'}:
                             o.v===2&&minStr===2?{background:'var(--amber-600)',borderColor:'var(--amber-600)',color:'#fff'}:{}}
                      onClick={()=>setMinStr(o.v)}>{o.l}</button>
                  ))}
                </div>
              </div>

              <div className="drawer__toolbar-divider"/>

              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Window</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[{v:3,l:'3d'},{v:7,l:'7d'},{v:30,l:'30d'},{v:90,l:'90d'},{v:null,l:'All'}].map(o=>(
                    <button key={o.l} className={`dash-tile-pill${daysBack===o.v?' dash-tile-pill--active':''}`}
                      onClick={()=>{setDaysBack(o.v);ensureFilingsWindow&&ensureFilingsWindow(o.v);}}>{o.l}</button>
                  ))}
                </div>
              </div>

              <div className="drawer__toolbar-divider"/>

              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Min value</span>
                <select className="ins-filter-select" value={minValue} onChange={e=>setMinValue(Number(e.target.value))}>
                  <option value={0}>Any</option>
                  <option value={100000}>$100K+</option>
                  <option value={500000}>$500K+</option>
                  <option value={1000000}>$1M+</option>
                </select>
              </div>

              <div className="drawer__toolbar-divider"/>

              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Type</span>
                <select className="ins-filter-select" value={srcF} onChange={e=>setSrcF(e.target.value)}>
                  <option value="">All types</option>
                  <option value="corporate">Corporate</option>
                  <option value="political">Congressional</option>
                </select>
              </div>

              <div className="drawer__toolbar-divider"/>

              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Sector</span>
                <select className="ins-filter-select" value={secF} onChange={e=>setSecF(e.target.value)}>
                  <option value="">All sectors</option>
                  {sectors.map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div className="drawer__toolbar-spacer"/>
              {!drawerFiltersDefault&&(
                <button className="ins-filter-reset" onClick={resetDrawerFilters}>Reset filters</button>
              )}
            </div>
          )}
          {type==='insiders'&&(
            <div className="drawer__toolbar">
              <div className="drawer__filter-group drawer__filter-group--search">
                <span className="drawer__filter-label">Search</span>
                <div className="drawer__search-wrap">
                  <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input className="drawer__search" placeholder="Insider name…"
                    value={search} onChange={e=>setSearch(e.target.value)} autoFocus/>
                </div>
              </div>
              <div className="drawer__toolbar-divider"/>
              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Source</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[[null,'All'],['corporate','Corporate'],['congress','Congress']].map(([v,l])=>(
                    <button key={l} className={`dash-tile-pill${lbSource===v?' dash-tile-pill--active':''}`}
                      onClick={()=>setLbSource(v)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="drawer__toolbar-divider"/>
              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Window</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[[1,'1yr'],[2,'2yr'],[5,'5yr'],[null,'All']].map(([v,l])=>(
                    <button key={l} className={`dash-tile-pill${lbYearsBack===v?' dash-tile-pill--active':''}`}
                      onClick={()=>setLbYearsBack(v)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="drawer__toolbar-divider"/>
              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Sort by</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[['hit_rate','Hit rate'],['om_buys','Buys'],['bought_value','Bought'],['avg_return','Biggest return']].map(([k,l])=>(
                    <button key={k} className={`dash-tile-pill${lbSort===k?' dash-tile-pill--active':''}`}
                      onClick={()=>lbOnSort(k)}>{l}{lbSort===k&&(lbDir<0?'↓':'↑')}</button>
                  ))}
                </div>
              </div>
              <div className="drawer__toolbar-divider"/>
              <div className="drawer__filter-group">
                <span className="drawer__filter-label">Min position</span>
                <div className="dash-tile-pills" style={{gap:2,alignItems:'center'}}>
                  {[[0,'Any'],[50000,'$50K'],[100000,'$100K'],[1000000,'$1M'],[10000000,'$10M']].map(([v,l])=>(
                    <button key={l} className={`dash-tile-pill${lbMinValue===v?' dash-tile-pill--active':''}`}
                      onClick={()=>setLbMinValue(v)}>{l}</button>
                  ))}
                  <input type="number" className="ins-filter-select" placeholder="Custom $" style={{width:84,marginLeft:4}}
                    value={lbMinValue&&![0,50000,100000,1000000,10000000].includes(lbMinValue)?lbMinValue:''}
                    onChange={e=>setLbMinValue(e.target.value?Number(e.target.value):0)}/>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Two-pane body ──────────────────────────────────────────── */}
        <div className="drawer__body">

          {/* LEFT: list */}
          <div className="drawer__list" ref={listRef}>
            {type==='signals'&&(
              <>
                <div className="drawer__list-hdr">
                  <span>{filteredSignals.length} signals{filingsLoading&&<span className="td-muted" style={{marginLeft:6,fontWeight:400}}><span className="spinner" style={{width:10,height:10,borderWidth:2,marginRight:4,display:'inline-block',verticalAlign:'-1px'}}/>loading more…</span>}</span>
                  <div className="dash-sig-sort" style={{marginLeft:'auto',gap:2}}>
                    {[['conviction','Conv'],['netValue','Net $'],['cSuiteBuys','Exec'],['lastTradeDate','Recent']].map(([k,l])=>(
                      <button key={k} className={`dash-sort-btn${sigSort===k?' dash-sort-btn--active':''}`} onClick={()=>sigOnSort(k)}>
                        {l}{sigSort===k&&(sigDir<0?'↓':'↑')}
                      </button>
                    ))}
                  </div>
                </div>
                {filteredSignals.length===0
                  ? <div className="drawer__empty">No signals match your filters</div>
                  : filteredSignals.map(s=>{
                    const isActive = detail?.ticker===s.ticker && detail?.type==='signal';
                    const convPct  = Math.min((s.conviction/15)*100,100);
                    const tier     = tierFromPct(convPct, appetite);
                    return (
                      <div key={s.ticker}
                        data-row-key={s.ticker}
                        className={`drawer__list-row drawer__list-row--${tier}${isActive?' drawer__list-row--active':''}`}
                        onClick={()=>{ setDetail({type:'signal',...s}); setDetailStack([]); }}>
                        <div className="drawer__list-row__main">
                          <span className="ticker" style={{fontSize:12,fontWeight:700}}>{s.ticker}</span>
                          {s.cSuiteBuys>0&&<span className="csuite-badge" style={{fontSize:11}}>{s.cSuiteBuys}×</span>}
                          {s.isPolitical&&<span className="badge badge--src-congress" style={{fontSize:11}}>C</span>}
                          <span className="td-muted" style={{fontSize:11,flex:1}}>{s.company}</span>
                          <span className={`td-mono drawer__list-row__val ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
                        </div>
                        <div className="drawer__list-row__sub">
                          <ConvictionBar score={s.conviction}/>
                          <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{fmt.ago(s.lastTradeDate)}</span>
                        </div>
                      </div>
                    );
                  })
                }
              </>
            )}

            {type==='insiders'&&(
              <>
                <div className="drawer__list-hdr">
                  <span>{sortedLb.length} insiders</span>
                </div>
                {lbRows===null
                  ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
                  : sortedLb.length===0
                    ? <div className="drawer__empty">No insiders match</div>
                    : sortedLb.map((r,i)=>{
                      const isActive = detail?.name===r.insider_name && detail?.type==='trader';
                      return (
                        <div key={i}
                          data-row-key={r.insider_name}
                          className={`drawer__list-row${isActive?' drawer__list-row--active':''}`}
                          onClick={()=>{ setDetail({type:'trader',name:r.insider_name,title:r.insider_title}); setDetailStack([]); }}>
                          <div className="drawer__list-row__main">
                            <span className="td-muted" style={{fontSize:11,width:18}}>{i+1}</span>
                            <span style={{fontSize:12,fontWeight:500,flex:1}}>{r.insider_name}</span>
                            {r.hit_rate!=null
                              ? <span
                                  className={`td-mono ${r.hit_rate>=70?'val-buy':r.hit_rate<50?'val-sell':''}`}
                                  style={{fontSize:13,fontWeight:700,cursor:r.avg_spy_return!=null?'help':'default'}}
                                  title={r.avg_spy_return!=null
                                    ? `Insider avg return: ${r.avg_return>=0?'+':''}${r.avg_return}% · Market (S&P 500) over the same periods: ${r.avg_spy_return>=0?'+':''}${r.avg_spy_return.toFixed(1)}%`
                                    : undefined}
                                >{r.hit_rate}%</span>
                              : <span className="td-muted" style={{fontSize:11,fontWeight:500,cursor:'help'}}
                                  title="Congressional filings disclose only a dollar range — no share count or purchase price — so a price-based hit rate can't be computed. Ranked by buy activity instead.">n/a</span>
                            }
                          </div>
                          <div className="drawer__list-row__sub">
                            <span className="td-muted" style={{fontSize:11}}>{r.insider_title||'Unknown'}</span>
                            <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{r.om_buys} buys · {fmt.money(r.bought_value)}</span>
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
                  <div style={{fontSize:24,marginBottom:8,opacity:.3}}>←</div>
                  <div style={{fontSize:13,color:'var(--text-3)'}}>Select a {type==='signals'?'signal':'trader'} to explore</div>
                </div>
              : <DetailPanel
                  detail={detail}
                  filings={filings}
                  onClose={()=>setDetail(null)}
                  onNavigate={(d)=>navigate(d)}
                  onBack={goBack}
                  canGoBack={detailStack.length>0}
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


// ─── InsightsPortfolioBar ─────────────────────────────────────────────────────
// Full-width horizontal bar above the signal/insider grid. Shows balance on the
// left and clickable position chips on the right. Flagged if insider activity
// exists on that ticker within the selected timespan.
function InsightsPortfolioBar({ filings, cutoff, days, onOpenDetail, onExpand, pro }) {
  const { port, err, connected, refresh, refreshing, lastRefreshed, perf } = usePortfolio(pro);

  const posSymbols = useMemo(()=>(port?.positions||[]).map(p=>p.symbol),[port]);

  // Real positions only — no longer merged with watchlist tickers. What you
  // hold and what you're watching are different questions; conflating them
  // here made it impossible to tell which was which.
  const activeSignalTickers = useMemo(()=>{
    const relevant = filings.filter(f=>
      posSymbols.includes(f.ticker) &&
      (f.transactionDate||f.date||'')>=cutoff &&
      f.isOpenMarket
    );
    return new Set(relevant.map(f=>f.ticker));
  },[filings,cutoff,posSymbols.join(',')]);

  if (!cfg.NEON_PROXY_URL) return null;

  const header = (
    <div className="ins-sig-panel__hdr" style={{flexShrink:0}}>
      <span>Portfolio</span>
      {port && (
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:6}}>
          {lastRefreshed && <span className="td-muted" style={{fontWeight:400,fontSize:10}}>Updated {fmt.ago(lastRefreshed.toISOString())}</span>}
          <button className="btn btn--ghost btn--icon" onClick={refresh} disabled={refreshing} title="Refresh positions" style={{width:22,height:22}}>
            <span style={{display:'inline-block',fontSize:12,animation:refreshing?'spin 1s linear infinite':'none'}}>⟳</span>
          </button>
        </div>
      )}
    </div>
  );

  if (!pro) {
    return (
      <div className="port-mini-tile">
        <div className="ins-sig-panel__hdr"><span className="ins-sig-panel__title">Portfolio</span></div>
        <div className="port-mini-tile__body">
          <span className="td-muted" style={{fontSize:11}}>
            Pro feature — <button className="port-inline-link" onClick={()=>navigateTo('/settings?section=billing')}>upgrade</button> to see insider activity on your real holdings.
          </span>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="port-mini-tile">
        <div className="ins-sig-panel__hdr"><span className="ins-sig-panel__title">Portfolio</span></div>
        <div className="port-mini-tile__body" style={{flexDirection:'row',alignItems:'center'}}>
          <span className="td-muted" style={{fontSize:11,color:'var(--red-600)'}}>Couldn't load your positions.</span>
          <button className="btn btn--ghost btn--sm" style={{marginLeft:'auto'}} onClick={refresh} disabled={refreshing}>{refreshing?'Retrying…':'Retry'}</button>
        </div>
      </div>
    );
  }

  if (connected===false) {
    return (
      <div className="port-mini-tile">
        <div className="ins-sig-panel__hdr"><span className="ins-sig-panel__title">Portfolio</span></div>
        <div className="port-mini-tile__body">
          <span className="td-muted" style={{fontSize:11}}>
            No brokerage connected — <button className="port-inline-link" onClick={()=>navigateTo('/settings?section=brokers')}>Link your account</button> to see your real holdings and get notified when insiders trade your stocks.
          </span>
        </div>
      </div>
    );
  }

  const pos = port?.positions||[];
  const totalPnl = pos.reduce((sum,p)=>sum+(p.openPnl||0),0);
  const totalCost = pos.reduce((sum,p)=>sum+((p.marketValue||0)-(p.openPnl||0)),0);
  const totalPnlPct = totalCost>0 ? (totalPnl/totalCost)*100 : null;
  const hasGrowth = pos.some(p=>p.openPnl!=null);

  return (
    <div className="port-mini-tile">
      {header}

      {!port ? (
        <div className="port-mini-tile__body" style={{display:'flex',justifyContent:'center',padding:'1.5rem'}}><Spinner size={16}/></div>
      ) : (
        <div className="port-mini-tile__body">
          {/* Position size + growth */}
          <div className="port-mini-tile__stats">
            <span className="port-mini-tile__val">{fmt.money(port.totalValue)}</span>
            {hasGrowth && (
              <span className={`port-mini-tile__growth ${totalPnl>=0?'val-buy':'val-sell'}`}>
                {totalPnl>=0?'+':''}{fmt.money(totalPnl)}{totalPnlPct!=null?` (${totalPnlPct>=0?'+':''}${totalPnlPct.toFixed(1)}%)`:''}
              </span>
            )}
          </div>

          {/* Performance chart — gracefully degrades if history isn't
              available yet, rather than show anything fabricated */}
          <div className="port-mini-tile__chart">
            {perf===undefined ? (
              <div style={{display:'flex',justifyContent:'center',padding:'0.5rem'}}><Spinner size={12}/></div>
            ) : perf===null || perf.length<2 ? (
              <p className="td-muted" style={{fontSize:10,textAlign:'center',padding:'0.4rem 0'}}>Performance history will appear here once available.</p>
            ) : (
              <PortfolioChartWithRanges points={perf} compact onExplore={onExpand}/>
            )}
          </div>

          {/* Ticker list — height-capped, scrolls internally rather than
              pushing Top insiders (below) out of view */}
          <div className="port-mini-tile__list">
            {pos.length===0
              ? <p className="td-muted" style={{fontSize:11,padding:'8px 0'}}>No open positions in your connected account.</p>
              : [...pos].sort((a,b)=>Math.abs(b.marketValue||0)-Math.abs(a.marketValue||0)).map((p,i)=>{
                  const hasActivity=activeSignalTickers.has(p.symbol);
                  const hasPnl = p.openPnl!=null;
                  return (
                    <div key={i} className="port-mini-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:p.symbol,company:p.company})}>
                      <span className="ticker" style={{fontSize:12,minWidth:50}}>{p.symbol}</span>
                      {hasActivity&&<span className="ins-port-chip__signal-badge" style={{fontSize:'0.5rem'}}>activity</span>}
                      <span className="td-muted" style={{fontSize:10,flex:1,textAlign:'right'}}>{fmt.money(p.marketValue)}</span>
                      {hasPnl && (
                        <span className={`${p.openPnl>=0?'val-buy':'val-sell'}`} style={{fontSize:10,fontFamily:'var(--font-mono)',minWidth:70,textAlign:'right'}}>
                          {p.openPnl>=0?'+':''}{p.openPnlPct.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  );
                })
            }
          </div>
        </div>
      )}

      {onExpand&&port&&(
        <button className="ins-panel-title-link" onClick={onExpand} style={{padding:'8px 14px',borderTop:'0.5px solid var(--border)',justifyContent:'center'}}>
          Explore <span className="ins-explore-hint" aria-hidden="true">⤢</span>
        </button>
      )}
    </div>
  );
}

// ─── PortfolioDrawer ──────────────────────────────────────────────────────────
// Full portfolio deep-dive: left pane = positions + stats + insider activity tabs,
// right pane = DetailPanel inline for selected ticker + news.
// Simple SVG line chart — no charting library dependency, matching the
// existing hand-rolled-SVG convention already used elsewhere in this file
// (see InsightsSectorChart). points: [{date, value}, ...] sorted ascending.
function PortfolioPerformanceChart({ points, onClick, compact=true }) {
  // The Explore view's container has no fixed width constraint and is
  // typically much wider than the compact tile's — a fixed 160px height
  // regardless of that width is exactly what produced the flat, stretched
  // look. Both dimensions grow for the non-compact case, not just height
  // alone, so the chart reads as genuinely taller rather than the same
  // thin strip rendered at a bigger scale.
  const W = compact ? 600 : 900, H = compact ? 160 : 280;
  const PAD_L = 56, PAD_R = 10, PAD_T = 10, PAD_B = 24;
  const svgRef = useRef(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const values = points.map(p=>p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max-min) || 1;
  const plotW = W-PAD_L-PAD_R, plotH = H-PAD_T-PAD_B;
  const stepX = plotW / (points.length-1);
  const coords = points.map((p,i)=>({
    x: PAD_L + i*stepX,
    y: PAD_T + plotH * (1 - (p.value-min)/range),
  }));
  const path = coords.map((c,i)=>`${i===0?'M':'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const isUp = values[values.length-1] >= values[0];
  const color = isUp?'var(--green-600)':'var(--red-600)';

  // Value axis — 3 gridlines (max, mid, min) rather than a dense scale,
  // matching how compact a Yahoo/Google Finance mini-chart actually is.
  const yTicks = [max, (max+min)/2, min];
  // Time axis — first, middle, last date. Enough to orient without
  // crowding a chart this size with a full date scale.
  const xTicks = [points[0], points[Math.floor((points.length-1)/2)], points[points.length-1]];

  // Converts a mouse event's screen position to the chart's own viewBox
  // coordinates, then finds the nearest actual data point by x — not a
  // continuous cursor-follows-exactly value, since the underlying data is
  // daily closes, not a continuous function; snapping to the nearest real
  // point is the honest representation of what the data actually is.
  const handleMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = W / rect.width; // viewBox width vs. actual rendered width — the svg is responsive (width="100%"), so these differ except at exactly 600px wide
    const svgX = (e.clientX - rect.left) * scaleX;
    const idx = Math.round((svgX - PAD_L) / stepX);
    const clamped = Math.max(0, Math.min(points.length - 1, idx));
    setHoverIdx(clamped);
  };

  const hover = hoverIdx != null ? { point: points[hoverIdx], coord: coords[hoverIdx] } : null;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
      style={{display:'block',cursor:onClick?'pointer':'default'}}
      onClick={onClick} role={onClick?'button':undefined} aria-label={onClick?'Open portfolio explorer':undefined}
      onMouseMove={handleMove} onMouseLeave={()=>setHoverIdx(null)}>
      {yTicks.map((v,i)=>{
        const y = PAD_T + plotH*(i/2);
        return (
          <g key={i}>
            <line x1={PAD_L} y1={y} x2={W-PAD_R} y2={y} stroke="var(--border)" strokeWidth="0.5"/>
            <text x={PAD_L-6} y={y+3} textAnchor="end" fontSize="9" fill="var(--text-3)">{fmt.money(v)}</text>
          </g>
        );
      })}
      {xTicks.map((p,i)=>(
        <text key={i}
          x={PAD_L + (i===0?0:i===1?plotW/2:plotW)}
          y={H-6}
          textAnchor={i===0?'start':i===1?'middle':'end'}
          fontSize="9" fill="var(--text-3)">
          {fmt.dateShort(p.date)}
        </text>
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth="2"/>
      {hover && (
        <g style={{pointerEvents:'none'}}>
          <line x1={hover.coord.x} y1={PAD_T} x2={hover.coord.x} y2={H-PAD_B}
            stroke="var(--text-3)" strokeWidth="1" strokeDasharray="2,2"/>
          <circle cx={hover.coord.x} cy={hover.coord.y} r="3.5" fill={color} stroke="var(--surface)" strokeWidth="1.5"/>
          {/* Tooltip box — flipped to the left side of the guide line past
              the chart's own midpoint, so it never renders partially off
              the right edge for points late in the series. */}
          {(() => {
            const boxW = 92, boxH = 30;
            const flip = hover.coord.x > PAD_L + plotW/2;
            const boxX = flip ? hover.coord.x - boxW - 8 : hover.coord.x + 8;
            const boxY = Math.max(PAD_T, Math.min(H-PAD_B-boxH, hover.coord.y - boxH/2));
            return (
              <g>
                <rect x={boxX} y={boxY} width={boxW} height={boxH} rx="4"
                  fill="var(--surface)" stroke="var(--border-md)" strokeWidth="0.5"/>
                <text x={boxX+8} y={boxY+13} fontSize="9" fill="var(--text-3)">{fmt.dateShort(hover.point.date)}</text>
                <text x={boxX+8} y={boxY+24} fontSize="10.5" fontWeight="700" fill="var(--text)">{fmt.money(hover.point.value)}</text>
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

// Time-range tabs, Yahoo/Google Finance style — no "1D" option, since
// prices_history stores daily closes, not intraday ticks, so that range
// could never show anything but a single flat point regardless of how
// much historical depth exists otherwise. Filters the already-fetched
// points client-side rather than re-fetching per range — same pattern as
// Insights' own day-window selector.
const PORTFOLIO_CHART_RANGES = [
  { key:'1w',  label:'1W',  days:7 },
  { key:'1m',  label:'1M',  days:30 },
  { key:'3m',  label:'3M',  days:90 },
  { key:'1y',  label:'1Y',  days:365 },
  { key:'all', label:'All', days:null },
];
function PortfolioChartWithRanges({ points, compact=false, onExplore }) {
  const [range, setRange] = useState('1m');
  const { display, fellBack } = useMemo(() => {
    const r = PORTFOLIO_CHART_RANGES.find(r=>r.key===range);
    if (!r || r.days==null) return { display: points, fellBack: false };
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-r.days);
    const iso = cutoff.toISOString().split('T')[0];
    const inRange = points.filter(p=>p.date>=iso);
    // Fewer than 2 points for the selected range isn't really "no data" —
    // it just means the position or the available history doesn't go back
    // that far yet. Show whatever data does exist (the life of the
    // position) rather than an empty state, but say so explicitly instead
    // of silently displaying something different from what was selected.
    return inRange.length>=2 ? { display: inRange, fellBack: false } : { display: points, fellBack: points.length>=2 };
  }, [points, range]);

  return (
    <div>
      <div className={`port-chart-ranges${compact?' port-chart-ranges--compact':''}`}>
        {PORTFOLIO_CHART_RANGES.map(r=>(
          <button key={r.key}
            className={`port-chart-range-btn${range===r.key?' port-chart-range-btn--active':''}`}
            onClick={()=>setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>
      {display.length<2 ? (
        <p className="td-muted" style={{fontSize:compact?10:11,textAlign:'center',padding:compact?'0.5rem 0':'1rem 0'}}>
          Not enough data yet.
        </p>
      ) : (
        <>
          {fellBack && (
            <p className="td-muted" style={{fontSize:compact?9:10,padding:'2px 12px 0'}}>
              Showing full history — not enough data for {PORTFOLIO_CHART_RANGES.find(r=>r.key===range)?.label} yet.
            </p>
          )}
          <PortfolioPerformanceChart points={display} onClick={onExplore} compact={compact}/>
        </>
      )}
    </div>
  );
}

function PortfolioDrawer({ filings, cutoff, days, onClose, watchlist, pro }) {
  const { port, perf } = usePortfolio(pro);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [detailStack, setDetailStack] = useState([]);
  const [tab, setTab] = useState('positions'); // 'positions' | 'activity' | 'news'

  const pos = port?.positions || [];

  const posSymbols = useMemo(()=>pos.map(p=>p.symbol), [pos.length]);

  // Recent insider activity on held tickers
  const activityByTicker = useMemo(()=>{
    const by = {};
    for (const f of filings) {
      if (!posSymbols.includes(f.ticker)) continue;
      if ((f.transactionDate||f.date||'') < cutoff) continue;
      if (!f.isOpenMarket) continue;
      if (!by[f.ticker]) by[f.ticker] = [];
      by[f.ticker].push(f);
    }
    return by;
  }, [filings, cutoff, posSymbols.join(',')]);

  // Right-pane nav stack
  function navTo(d) { if (detail) setDetailStack(s=>[...s,detail]); setDetail(d); }
  function goBack()  { const p=detailStack[detailStack.length-1]; setDetailStack(s=>s.slice(0,-1)); setDetail(p||null); }

  // Auto-select first position
  useEffect(()=>{
    if (pos.length && !selected) {
      const p = pos[0];
      setSelected(p.symbol);
      setDetail({type:'ticker', ticker:p.symbol, company:''});
    }
  }, [pos.length]);

  // Escape
  useEffect(()=>{
    const h = e => {
      if (e.key !== 'Escape') return;
      if (detail && detailStack.length) goBack();
      else onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [detail, detailStack, onClose]);

  // P&L bar scale
  const maxAbs = useMemo(()=>
    Math.max(1, ...pos.map(p=>Math.abs(p.openPnl||0)))
  , [pos]);

  return (
    <div className="drawer-overlay" onClick={e=>{if(e.target.classList.contains('drawer-overlay'))onClose();}}>
      <div className="drawer drawer--wide">

        {/* Header — title, total value, close. Chart moved to the right
            column, sitting above the ticker detail rather than spanning
            the full width above everything. */}
        <div className="drawer__hdr--stacked">
          <div className="drawer__hdr-row1">
            <span className="drawer__title">Portfolio</span>
            {port && <span className="port-hdr-val">{fmt.money(port.totalValue)}</span>}
            <button className="modal-close" onClick={onClose} title="Close (Esc)" style={{marginLeft:'auto'}}><IconClose style={{width:12,height:12}}/></button>
          </div>
        </div>

        <div className="drawer__body">

          {/* LEFT: tabs — Positions / Insider activity / News */}
          <div className="drawer__list">
            <div className="drawer__list-hdr">
              {[['positions','Positions'],['activity','Insider activity'],['news','News']].map(([id,l])=>(
                <button key={id}
                  className={`dash-tile-pill${tab===id?' dash-tile-pill--active':''}`}
                  style={{fontSize:11}} onClick={()=>setTab(id)}>{l}</button>
              ))}
            </div>

            {/* POSITIONS TAB */}
            {tab==='positions' && (
              !port
                ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
                : pos.length===0
                  ? <div className="drawer__empty">No open positions.<br/>Connect Alpaca to track your holdings here.</div>
                  : [...pos]
                    .sort((a,b)=>Math.abs(b.marketValue||0)-Math.abs(a.marketValue||0))
                    .map((p,i)=>{
                      const upl = p.openPnl;
                      const mv  = p.marketValue;
                      const qty = p.quantity;
                      const barW = upl!=null ? Math.min(Math.abs(upl)/maxAbs*100, 100) : 0;
                      const hasActivity = !!(activityByTicker[p.symbol]?.length);
                      const isActive = selected===p.symbol;
                      return (
                        <div key={i}
                          className={`drawer__list-row${isActive?' drawer__list-row--active':''}`}
                          onClick={()=>{ setSelected(p.symbol); setDetail({type:'ticker',ticker:p.symbol,company:''}); setDetailStack([]); }}>
                          <div className="drawer__list-row__main">
                            <span className="ticker" style={{fontSize:13,fontWeight:700}}>{p.symbol}</span>
                            {hasActivity&&<span className="reversal-badge" style={{fontSize:11}}>insider activity</span>}
                            <span className="td-muted" style={{fontSize:11,flex:1}}>{qty%1?qty.toFixed(2):qty} sh · {fmt.money(mv)}</span>
                            {upl!=null && <span className={`td-mono ${upl>=0?'val-buy':'val-sell'}`} style={{fontSize:12,fontWeight:700}}>{upl>=0?'+':''}{fmt.money(upl)}</span>}
                          </div>
                          {upl!=null && (
                            <div className="port-plbar-track">
                              <div className="port-plbar-fill" style={{width:`${barW}%`,background:upl>=0?'var(--green-600)':'var(--red-600)'}}/>
                            </div>
                          )}
                        </div>
                      );
                    })
            )}

            {/* INSIDER ACTIVITY TAB */}
            {tab==='activity' && (
              posSymbols.length===0
                ? <div className="drawer__empty">No positions to track.</div>
                : Object.keys(activityByTicker).length===0
                  ? <div className="drawer__empty">No open-market insider trades on your holdings in the last {days}d.</div>
                  : Object.entries(activityByTicker).map(([ticker,trades])=>(
                    <div key={ticker}>
                      <div className="port-activity-ticker-hdr">
                        <span className="ticker" style={{fontSize:12}}>{ticker}</span>
                        <span className="td-muted" style={{fontSize:11,marginLeft:6}}>{trades.length} trade{trades.length!==1?'s':''}</span>
                      </div>
                      {trades.map((f,i)=>(
                        <div key={i} className="drawer__list-row"
                          onClick={()=>{ setSelected(ticker); setDetail({type:'ticker',ticker,company:''}); setDetailStack([]); setTab('positions'); }}>
                          <div className="drawer__list-row__main">
                            <Badge type={f.transactionType==='buy'?'buy':'sell'}>{f.transactionType==='buy'?<IconBuyTri style={{width:8,height:8}}/>:<IconSellTri style={{width:8,height:8}}/>}</Badge>
                            <span style={{fontSize:11,fontWeight:500,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.insiderName}</span>
                            <span className={`td-mono ${f.transactionType==='buy'?'val-buy':'val-sell'}`} style={{fontSize:12,fontWeight:600}}>{fmt.money(f.value)}</span>
                          </div>
                          <div className="drawer__list-row__sub">
                            <span className="td-muted" style={{fontSize:11}}>{f.title||f.relationship||'Unknown'}</span>
                            <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{fmt.dateShort(f.transactionDate||f.date)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
            )}

            {/* NEWS TAB */}
            {tab==='news' && (
              posSymbols.length===0
                ? <div className="drawer__empty">No positions to fetch news for.</div>
                : <PortfolioTickerNews tickers={posSymbols}/>
            )}
          </div>

          {/* RIGHT: ticker profile (only once a position is selected) + performance chart (always shown) + inline ticker detail */}
          <div className="drawer__detail">
            {selected && <CompanyProfileCard ticker={selected} company={detail?.company||''}/>}
            <div className="port-perf-chart">
              {perf===undefined ? (
                <div style={{padding:'0.75rem',display:'flex',justifyContent:'center'}}><Spinner size={14}/></div>
              ) : perf===null || perf.length<2 ? (
                <p className="td-muted" style={{fontSize:11,padding:'0.6rem 1rem'}}>
                  Performance history will appear here once enough data has been collected.
                </p>
              ) : (
                <PortfolioChartWithRanges points={perf}/>
              )}
            </div>
            {!detail
              ? <div className="drawer__detail-empty">
                  <div style={{fontSize:24,marginBottom:8,opacity:.3}}>←</div>
                  <div style={{fontSize:13,color:'var(--text-3)'}}>Select a position to see insider trades</div>
                </div>
              : <DetailPanel
                  detail={detail}
                  filings={filings}
                  onClose={()=>setDetail(null)}
                  onNavigate={navTo}
                  onBack={goBack}
                  canGoBack={detailStack.length>0}
                  watchlist={watchlist}
                  inline={true}
                  hideProfileCard={true}
                />
            }
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── InsightsPortfolioPanel ───────────────────────────────────────────────────
// Kept for compatibility — no longer rendered in main Insights layout.

// ─── Portfolio filings panel ──────────────────────────────────────────────────

// Active insiders — who has been most active in the selected window

// ─── Leaderboard sidebar ────────────────────────────────────────────────────────
function InsiderLeaderboardSidebar({ onOpenDetail, watchlist }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [yearsBack, setYearsBack] = useState(null); // null = all-time, matches the previous fixed default
  const [source, setSource] = useState(null); // null='all' | 'corporate' | 'congress'
  const [sort, setSort] = useState('proxy_score');
  const [dir, setDir] = useState(-1);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) { setError('Not configured'); return; }
    setRows(null); setError(null);
    queryNeon(LEADERBOARD_QUERY(20, null, 5, yearsBack, source))
      .then(r=>setRows(processLeaderboardRows(r)))
      .catch(e=>setError(e.message||'Failed to load'));
  },[yearsBack,source]);

  const sorted = useMemo(()=>{
    if (!rows) return [];
    return [...rows].sort((a,b)=>{
      const av=a[sort]??-Infinity, bv=b[sort]??-Infinity;
      return dir>0?av-bv:bv-av;
    });
  },[rows,sort,dir]);
  function onSortClick(col){ if(sort===col)setDir(d=>-d); else{setSort(col);setDir(-1);} }
  const isMobile = useIsMobile();
  const [expandedKey, setExpandedKey] = useState(null);

  return (
    <div className="ins-lb-list-wrap">
      <div className="ins-lb-pill-row">
        <span className="ins-lb-pill-row__label">Window</span>
        {[[1,'1yr'],[2,'2yr'],[5,'5yr'],[null,'All']].map(([v,l])=>(
          <button key={l} className={`dash-tile-pill${yearsBack===v?' dash-tile-pill--active':''}`}
            onClick={()=>setYearsBack(v)}>{l}</button>
        ))}
        <span className="ins-lb-pill-row__label" style={{marginLeft:8}}>Source</span>
        {[[null,'All'],['corporate','Corp'],['congress','Congress']].map(([v,l])=>(
          <button key={l} className={`dash-tile-pill${source===v?' dash-tile-pill--active':''}`}
            onClick={()=>setSource(v)}>{l}</button>
        ))}
      </div>
      <div className="ins-lb-col-hdr">
        <span className="ins-lb-col-hdr__spacer"/>
        <span className="ins-lb-col-hdr__name">Insider</span>
        <button className={`ins-lb-col-hdr__sort${sort==='om_buys'?' ins-lb-col-hdr__sort--active':''}`} onClick={()=>onSortClick('om_buys')}>Buys{sort==='om_buys'&&(dir<0?' ↓':' ↑')}</button>
        <button className={`ins-lb-col-hdr__sort${sort==='hit_rate'?' ins-lb-col-hdr__sort--active':''}`} onClick={()=>onSortClick('hit_rate')}>Hit rate{sort==='hit_rate'&&(dir<0?' ↓':' ↑')}</button>
      </div>
      {error?<div className="ins-empty"><IconWarning style={{width:11,height:11,marginRight:3,verticalAlign:"-1px"}}/>{error}</div>
      :rows===null?<div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
      :rows.length===0?<div className="ins-empty">Not enough data yet</div>
      :<div className="ins-lb-list">
        {sorted.slice(0,15).map((r,i)=>{
          const isExpanded = isMobile && expandedKey===r.insider_name;
          return (
          <div key={i} className={`ins-lb-card${isExpanded?' ins-lb-card--expanded':''}`}
            onClick={()=>{
              if (isMobile) { setExpandedKey(k=>k===r.insider_name?null:r.insider_name); return; }
              onOpenDetail&&onOpenDetail({type:'trader',name:r.insider_name,title:r.insider_title});
            }}>
            <div className="ins-lb-card__rank">{i+1}</div>
            <div className="ins-lb-card__body">
              <div className="ins-lb-card__name dp-clickable">{r.insider_name}</div>
              <div className="td-muted" style={{fontSize:11}}>{r.insider_title||'Unknown'}</div>
              <div className="ins-lb-card__meta">
                <Badge type={`rel-${r.relationship||'weak'}`}>{r.relationship==='strong'?'C-Suite':r.relationship==='medium'?'Officer':'Dir'}</Badge>
                <span className="td-muted" style={{fontSize:11}}>{r.om_buys} buys · {fmt.money(r.bought_value)}</span>
              </div>
            </div>
            <div className="ins-lb-card__score">
              {watchlist&&<FollowBtn name={r.insider_name} watchlist={watchlist}/>}
              {r.hit_rate!=null
                ? <div
                    className={`ins-lb-card__rate ${r.hit_rate>=70?'val-buy':r.hit_rate>=50?'':'val-sell'}`}
                    style={{cursor:r.avg_spy_return!=null?'help':'default'}}
                    title={r.avg_spy_return!=null
                      ? `Insider avg return: ${r.avg_return>=0?'+':''}${r.avg_return}% · Market (S&P 500) over the same periods: ${r.avg_spy_return>=0?'+':''}${r.avg_spy_return.toFixed(1)}%`
                      : undefined}
                  >{r.hit_rate}%</div>
                : <div className="ins-lb-card__rate td-muted" style={{fontSize:'0.6875rem',cursor:'help'}}
                    title="Congressional filings disclose only a dollar range — no share count or purchase price — so a price-based hit rate can't be computed. Ranked by buy activity instead.">n/a</div>
              }
              <ConvictionBar score={r.proxy_score} max={4}/>
            </div>
            {isMobile && <div className="ins-sig-row__expand-chevron">{isExpanded ? '▴ Less' : '▾ More'}</div>}
            {isExpanded && (
              <div className="ins-sig-row__expanded" onClick={e=>e.stopPropagation()}>
                <div className="ins-sig-row__expanded-grid">
                  <div><span className="td-muted">Sells</span><br/>{r.om_sells||0}</div>
                  <div><span className="td-muted">Bought value</span><br/>{fmt.money(r.bought_value)}</div>
                  {r.avg_return!=null && <div><span className="td-muted">Avg return</span><br/><span className={r.avg_return>=0?'val-buy':'val-sell'}>{r.avg_return>=0?'+':''}{r.avg_return}%</span></div>}
                  {r.avg_spy_return!=null && <div><span className="td-muted">S&amp;P 500 same period</span><br/>{r.avg_spy_return>=0?'+':''}{r.avg_spy_return.toFixed(1)}%</div>}
                  <div><span className="td-muted">Conviction score</span><br/>{r.proxy_score.toFixed(1)} / 4</div>
                </div>
              </div>
            )}
          </div>
          );
        })}
      </div>}
    </div>
  );
}

// ─── Sector chart — treemap-style squares, sortable between market and SEC data ─
// Market data: feargreedchart.com raw_data has sector ETF prices+% changes
// SEC data: our own net buy/sell by sector (excludes 'Other' — too much noise)
// Toggle lets the user switch between the two views.
const SECTOR_ETFS = [
  {label:'Tech',      sym:'XLK'},  {label:'Finance',   sym:'XLF'},
  {label:'Healthcare',sym:'XLV'},  {label:'Energy',    sym:'XLE'},
  {label:'Staples',   sym:'XLP'},  {label:'Discretion',sym:'XLY'},
  {label:'Industrials',sym:'XLI'}, {label:'Real Estate',sym:'XLRE'},
  {label:'Utilities', sym:'XLU'},  {label:'Materials',  sym:'XLB'},
  {label:'Comms',     sym:'XLC'},
];
// Map our SEC sector names to the ETF sector labels for overlaying
const SEC_TO_ETF_LABEL = {
  'Technology':'Tech','Finance':'Finance','Healthcare':'Healthcare','Energy':'Energy',
  'Consumer Staples':'Staples','Consumer Discretionary':'Discretion',
  'Industrials':'Industrials','Real Estate':'Real Estate','Utilities':'Utilities',
  'Materials':'Materials','Communication Services':'Comms',
};


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
function LEADERBOARD_QUERY(limit=50, sectorFilter=null, minTrades=5, yearsBack=2, sourceFilter=null) {
  const sectorClause = sectorFilter ? `AND f.sector = '${sectorFilter.replace(/'/g,"''")}'` : '';
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
      GROUP BY f.insider_name
      HAVING COUNT(*) FILTER (WHERE f.transaction_type IN ('buy','sell') AND f.is_open_market) >= ${minTrades}
    ) agg
    ORDER BY proxy_rank DESC NULLS LAST
    LIMIT ${limit}
  `;
}

// (processLeaderboardRows now lives in src/lib/scoring.js — imported above.)


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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ query: sql }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) throw new Error('You don\'t have access to this — check your plan in Settings');
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

async function fetchExportViaSnapshot(mode, onProgress) {
  const r = await fetch(`${cfg.NEON_PROXY_URL}/export/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ mode }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) { const d = await r.json().catch(()=>({})); throw new Error(d.error || 'Full data export requires a one-time purchase.'); }
  if (!r.ok) throw new Error(`Something went wrong exporting this (status ${r.status}) — try again in a moment`);

  const contentType = r.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const d = await r.json().catch(()=>({}));
    if (d.error === 'snapshot_not_ready') return null; // expected — caller falls back
    throw new Error(d.error || 'Export failed');
  }

  // NDJSON stream — read and parse incrementally rather than buffering
  // the entire response before touching any of it, so progress updates
  // reflect real, ongoing work instead of jumping from 0 to everything
  // the instant the whole thing finishes downloading.
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const rows = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        rows.push(JSON.parse(line));
        if (onProgress && rows.length % 5000 === 0) onProgress(rows.length);
      }
    }
  }
  if (buffer.trim()) rows.push(JSON.parse(buffer));
  if (onProgress) onProgress(rows.length);
  return rows;
}

// Hits the dedicated /export route (server checks public.data_purchases
// before running anything) rather than the general query passthrough —
// same shape, different endpoint, so a non-purchaser can't just replay a
// normal /query request with a bigger LIMIT and get the export for free.
async function proxyExport({ selectCols, whereClause, cursor, pagesPerBatch=5, pageSize=20000, mode='consume' }) {
  const r = await fetch(`${cfg.NEON_PROXY_URL}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...await getAuthHeaders() },
    body: JSON.stringify({ selectCols, whereClause, cursor, pagesPerBatch, pageSize, mode }),
  });
  if (r.status === 401) throw new Error('Your session needs a refresh — try reloading the page');
  if (r.status === 403) { const d = await r.json().catch(()=>({})); throw new Error(d.error || 'Full data export requires a one-time purchase.'); }
  if (!r.ok) throw new Error(`Something went wrong exporting this (status ${r.status}) — try again in a moment`);
  const d = await r.json();
  if (d.error) {
    const diag = d.diagnostic
      ? ` [diagnostic: total rows in table = ${d.diagnostic.totalRowsInTable ?? 'unknown'}; most recent dates = ${JSON.stringify(d.diagnostic.mostRecentDates ?? d.diagnostic.diagnosticError)}]`
      : '';
    throw new Error(d.error + diag);
  }
  return { rows: d.rows || [], nextCursor: d.nextCursor || null, done: !!d.done };
}

// Wraps proxyExport with retries for the batch loop specifically — even
// with server-side batching cutting the number of client-visible requests
// by 5x+, a large export is still several dozen requests, and some
// transient failure along the way is fairly likely eventually. Only
// retries things that plausibly succeed on a second attempt — 401/403
// fail immediately, since those are deterministic access problems
// retrying won't fix.
async function proxyExportWithRetry(params, maxRetries=4) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await proxyExport(params);
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      const is503 = msg.includes('status 503');
      const retryable = is503 || msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('went wrong exporting');
      if (!retryable || attempt === maxRetries) throw e;
      // 503 gets much longer backoff — plausibly a connection pool that
      // needs real time to drain, not a one-off blip. Other transient
      // failures keep the shorter backoff.
      const delay = is503 ? 3000 * Math.pow(2, attempt) : 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}


const EXPORT_COLS = ['transaction_date','filing_date','ticker','company_name','insider_name','insider_title',
  'transaction_type','transaction_code','is_open_market','shares','price_per_share',
  'value','pct_owned_change','relationship','sector','footnotes'];

const EXPORT_HEADERS = ['Transaction Date','Filing Date','Ticker','Company','Insider Name','Insider Title',
  'Buy/Sell','Transaction Code','Open Market?','Shares','Price / Share',
  'Value ($)','% Owned Change','Relationship','Sector','Footnotes'];

// Column widths (characters) matched 1:1 to EXPORT_HEADERS above.
const EXPORT_COL_WIDTHS = [13,12,8,28,20,22,9,16,11,11,12,13,14,11,16,32];

const TX_CODE_LEGEND = [
  ...Object.entries(TX_CODE_TOOLTIPS),
  ['CONGRESS_P','Congressional purchase (STOCK Act disclosure)'],
  ['CONGRESS_S','Congressional sale (STOCK Act disclosure)'],
  ['CONGRESS_O','Congressional other/exchange transaction (STOCK Act disclosure)'],
];

const COLUMN_LEGEND = [
  ['Transaction Date','The date the trade itself happened, when disclosed. Congressional trades often disclose only a date range or amount band, not an exact price.'],
  ['Filing Date','The date the SEC or Congress actually received/processed the disclosure — usually a few days after the transaction date.'],
  ['Ticker','Stock ticker symbol, when the underlying security has one.'],
  ['Company','Full company or entity name as filed.'],
  ['Insider Name','The person or entity who made the trade.'],
  ['Insider Title','Their role at the company (e.g. CFO, Director), or House/Senate for congressional filers.'],
  ['Buy/Sell','Whether this was a purchase or a sale.'],
  ['Transaction Code','The SEC/STOCK Act code describing the transaction type — see the Code column below for what each one means.'],
  ['Open Market?','Yes if this was a real open-market cash purchase or sale — the kind that reflects a genuine bet with their own money, as opposed to a grant, award, gift, or tax withholding.'],
  ['Shares','Number of shares involved, when disclosed. Congressional filings typically do not disclose an exact share count.'],
  ['Price / Share','Price per share at the time of the trade, when disclosed.'],
  ['Value ($)','Total dollar value of the transaction, or the disclosed range midpoint for congressional trades.'],
  ['% Owned Change','Approximate percent change in the insider\'s total position this trade represents, when calculable.'],
  ['Relationship','Insider\'s seniority tier: strong (C-suite), medium (officer), or weak (director/10% owner/other).'],
  ['Sector','GICS-style sector classification for the company, when known.'],
  ['Footnotes','Any footnote text attached to the filing, verbatim.'],
];

// Shared by DataPage's own "Export CSV" button (filtered to whatever's
// currently on screen) and the "just bought it" auto-download after
// checkout (unfiltered — the full database, matching what was actually
// purchased). One function, one workbook-building/download path, so the
// two can't quietly drift into producing different files.
//
// The date bounds below are NOT optional/caller-supplied — they're always
// ANDed in regardless of what extraConditions contains. Previously the
// unfiltered "just bought it" path passed no WHERE clause at all, which is
// exactly how obviously-corrupt rows (transaction_date values like
// 3031-04-30, 2220-04-07, 2033-12-11 — years that don't exist in any real
// trading history) made it into a paying customer's download: nothing
// upstream was rejecting them. DataPage's own filtered browsing already
// had a same-shaped clamp, which is why this never showed up there — only
// on the one code path that had none.
async function downloadFullExport(extraConditions='', orderByClause="ORDER BY COALESCE(transaction_date,filing_date) DESC", mode='consume', onProgress=null) {
  const today = new Date().toISOString().split('T')[0];
  let data = null;

  // Snapshot path first — only valid for the unfiltered "everything"
  // export (extraConditions empty), since the pre-built snapshot doesn't
  // know about arbitrary filters. null specifically means "not ready yet"
  // (expected, recoverable) — falls through to the live batching path
  // below rather than failing the export over it.
  if (!extraConditions) {
    data = await fetchExportViaSnapshot(mode, onProgress);
  }

  if (data === null) {
  // Row inclusion stays permissive — same COALESCE check that was already
  // proven to work (this is what returned real rows before). Requiring
  // BOTH transaction_date AND filing_date to independently pass sanity
  // checking (the previous version of this fix) turned out to exclude
  // nearly the entire table — date corruption from the known ingestion
  // bugs is apparently common enough that a large share of rows have at
  // least one bad field even when the other is fine, and rejecting the
  // whole row for that lost real data along with the bad value.
  const conditions = [
    `COALESCE(transaction_date,filing_date)::date >= '2020-01-01'::date`,
    `COALESCE(transaction_date,filing_date)::date <= '${today}'::date`,
  ];
  if (extraConditions) conditions.push(extraConditions);

  // Each date field sanitized independently IN THE OUTPUT instead — a
  // corrupted transaction_date or filing_date comes back as NULL (blank
  // in the sheet) rather than either showing garbage or taking the row's
  // otherwise-good data down with it.
  const dateExpr = col => `CASE WHEN ${col}::date >= '2020-01-01'::date AND ${col}::date <= '${today}'::date THEN ${col} END AS ${col}`;
  const selectCols = EXPORT_COLS.map(c => {
    if (c==='transaction_date' || c==='filing_date') return dateExpr(c);
    if (c==='shares'||c==='price_per_share'||c==='value'||c==='pct_owned_change') return `${c}::float`;
    return c;
  }).join(',\n           ');

  // ctid appended as a tiebreaker — sort ties (very likely on a table this
  // size, since many rows share the same date) need a deterministic
  // secondary key for pagination to be gap-free and duplicate-free. ctid
  // always exists on any Postgres table. The Worker rebuilds this same
  // ORDER BY internally for each page it fetches — sent here mainly for
  // clarity/documentation, since the actual sort is now hardcoded
  // server-side to match.
  void orderByClause; // kept as a parameter for API compatibility; the Worker owns the actual ORDER BY now

  // Batched keyset pagination — the Worker loops internally across up to
  // 5 pages per request instead of the client making one request per
  // page. This is the fix for the sustained 503s: at one connection per
  // client request, a ~1M row export meant 45-100+ separate connections
  // opened in quick succession, which is what was overwhelming Neon under
  // sustained load — keyset pagination alone fixed the "gets slower with
  // depth" problem, but not the sheer number of connections. Batching
  // server-side cuts that count by 5x+ without needing new infrastructure.
  const PAGE_SIZE = 40000; // was 20000 — still comfortably under Neon's 64MB response cap, but halves the total request count for a large export
  const PAGES_PER_BATCH = 5;
  const MAX_ROWS = 2000000; // safety ceiling, not a real-world expectation
  data = [];
  let batchMode = mode;
  let cursor = null;
  while (true) {
    const { rows, nextCursor, done } = await proxyExportWithRetry({
      selectCols, whereClause: conditions.join(' AND '), cursor, pagesPerBatch: PAGES_PER_BATCH, pageSize: PAGE_SIZE, mode: batchMode,
    });
    data = data.concat(rows);
    if (onProgress) onProgress(data.length);
    cursor = nextCursor;
    if (done || data.length >= MAX_ROWS) break;
    // Only the FIRST batch should spend a one-time 'consume' allowance —
    // this is still one logical download, just split into several
    // requests because of the size cap. Every batch after the first uses
    // 'redownload' (requires only that a purchase exists at all) so
    // continuing doesn't fail because the first batch already marked the
    // purchase used.
    batchMode = 'redownload';
    // A small gap between batches rather than firing the next one the
    // instant this resolves — gives Neon's connection pool a beat to
    // release each connection before the next arrives.
    await new Promise(r => setTimeout(r, 150));
  }
  } // end of live-batching fallback (if data === null)

  if (data.length === 0) {
    throw new Error('No matching rows came back from the database — this looks like a real problem, not an empty result. Try again in a moment, and if it persists, this needs a look before you trust any export.');
  }

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: the data itself ──────────────────────────────────────────
  const sheetRows = data.map(r => ({
    'Transaction Date': r.transaction_date ? new Date(r.transaction_date) : '',
    'Filing Date':      r.filing_date ? new Date(r.filing_date) : '',
    'Ticker':           r.ticker || '',
    'Company':          r.company_name || '',
    'Insider Name':     r.insider_name || '',
    'Insider Title':    r.insider_title || '',
    'Buy/Sell':         r.transaction_type ? r.transaction_type[0].toUpperCase()+r.transaction_type.slice(1) : '',
    'Transaction Code': r.transaction_code || '',
    'Open Market?':     r.is_open_market===true ? 'Yes' : r.is_open_market===false ? 'No' : '',
    'Shares':           r.shares!=null ? Number(r.shares) : null,
    'Price / Share':    r.price_per_share!=null ? Number(r.price_per_share) : null,
    'Value ($)':        r.value!=null ? Number(r.value) : null,
    '% Owned Change':   r.pct_owned_change!=null ? Number(r.pct_owned_change) : null,
    'Relationship':     r.relationship || '',
    'Sector':           r.sector || '',
    'Footnotes':        r.footnotes || '',
  }));
  const ws = XLSX.utils.json_to_sheet(sheetRows, { header: EXPORT_HEADERS });
  ws['!cols'] = EXPORT_COL_WIDTHS.map(wch=>({wch}));

  // Real number/date formatting so Excel renders these as actual dates,
  // currency, and thousands-separated numbers — not plain text that
  // happens to look like one.
  const range = XLSX.utils.decode_range(ws['!ref']);
  const colFormats = { 0:'yyyy-mm-dd', 1:'yyyy-mm-dd', 9:'#,##0', 10:'$#,##0.00', 11:'$#,##0.00', 12:'0.00"%"' };
  for (let R = range.s.r + 1; R <= range.e.r; R++) {
    for (const [colIdx, fmt] of Object.entries(colFormats)) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: Number(colIdx) })];
      if (cell) cell.z = fmt;
    }
  }
  // Bold the header row — plain 'xlsx' silently drops this, which is
  // exactly why this uses xlsx-js-style instead.
  for (let C = range.s.c; C <= range.e.c; C++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (cell) cell.s = { font: { bold: true } };
  }
  XLSX.utils.book_append_sheet(wb, ws, 'Insider Trades');

  // ── Sheet 2: legend — column guide + transaction code reference ───────
  // Every row padded to exactly 2 columns, including section headers and
  // the blank separator — a ragged array-of-arrays (some 1-cell rows, some
  // 2-cell, one empty) is a real, avoidable risk for stricter XLSX readers
  // (Apple Numbers among them), and padding costs nothing.
  const legendRows = [
    ['COLUMN GUIDE',''],
    ['Column','What it means'],
    ...COLUMN_LEGEND,
    ['',''],
    ['TRANSACTION CODES',''],
    ['Code','Meaning'],
    ...TX_CODE_LEGEND,
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(legendRows);
  ws2['!cols'] = [{wch:18},{wch:70}];
  // Bold both section-title rows and both column-header rows (0, 1, and
  // the section break at COLUMN_LEGEND.length + 2).
  const boldLegendRows = [0, 1, COLUMN_LEGEND.length + 2, COLUMN_LEGEND.length + 3];
  for (const R of boldLegendRows) {
    for (let C = 0; C <= 1; C++) {
      const cell = ws2[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell) cell.s = { font: { bold: true } };
    }
  }
  XLSX.utils.book_append_sheet(wb, ws2, 'Legend');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  a.download=`insider_trades_${today}.xlsx`;
  a.click();
  return data.length;
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
        <div style={{display:'flex',gap:12}}>
          <label className="fp-check">
            <input type="checkbox" checked={openMkt} onChange={e=>setOpenMkt(e.target.checked)}/>
            Open market
          </label>
          <label className="fp-check">
            <input type="checkbox" checked={fromPortfolio} onChange={e=>setFromPortfolio(e.target.checked)}/>
            My portfolio
          </label>
        </div>
      </div>

      <div className="drawer__toolbar-divider"/>

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Source</span>
        <div className="dash-tile-pills">
          {[['','All'],['corporate','Corporate'],['political','Political']].map(([v,l])=>(
            <button key={v} className={`dash-tile-pill${sourceF===v?' dash-tile-pill--active':''}`} onClick={()=>setSourceF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider"/>

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Role</span>
        <div className="dash-tile-pills">
          {[['','All'],['strong','C-Suite'],['medium','Officer'],['weak','Director']].map(([v,l])=>(
            <button key={v} className={`dash-tile-pill${relF===v?' dash-tile-pill--active':''}`} onClick={()=>setRelF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider"/>

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Type</span>
        <div className="dash-tile-pills">
          {[['','All'],['buy','Buy'],['sell','Sell'],['other','Other']].map(([v,l])=>(
            <button key={v} className={`dash-tile-pill${typeF===v?' dash-tile-pill--active':''}`} onClick={()=>setTypeF(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="drawer__toolbar-divider"/>

      <div className="ins-filter-group">
        <span className="ins-filter-group__label">Sector</span>
        <select className="ins-filter-select" value={sectorF} onChange={e=>setSectorF(e.target.value)}>
          <option value="">All sectors</option>
          {sectors.map(s=><option key={s} value={s}>{s}</option>)}
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
function DataDrawer({ initialDetail, initialDetailStack, filterState, onClose, watchlist, portfolioTickers }) {
  const f = filterState || {};
  const [search,   setSearch]   = useState(f.search || '');
  const [typeF,    setTypeF]    = useState(f.typeF || '');
  const [relF,     setRelF]     = useState(f.relF || '');
  const [sectorF,  setSectorF]  = useState(f.sectorF || '');
  const [sourceF,  setSourceF]  = useState(f.sourceF || '');
  const [openMkt,  setOpenMkt]  = useState(f.openMkt || false);
  const [fromPortfolio, setFromPortfolio] = useState(f.fromPortfolio || false);
  const [dPreset,  setDPreset]  = useState(f.dPreset ?? 7);
  const [dateFrom, setDateFrom] = useState(f.dateFrom || '');
  const [dateTo,   setDateTo]   = useState(f.dateTo || '');
  const [sortKey,  setSortKey]  = useState(f.sortKey || 'transaction_date');
  const [sortDir,  setSortDir]  = useState(f.sortDir ?? -1);

  function resetFilters() {
    setSearch(''); setTypeF(''); setRelF(''); setSectorF(''); setSourceF('');
    setOpenMkt(false); setFromPortfolio(false);
    setDPreset(7); setDateFrom(''); setDateTo('');
  }

  const [rows,    setRows]    = useState(null);
  const [sectors, setSectors] = useState([]);
  const [detailStack, setDetailStack] = useState(()=>initialDetailStack||[]);
  const [detail,      setDetail]      = useState(initialDetail||null);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    proxySQL(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL ORDER BY sector`)
      .then(r=>setSectors(r.map(x=>x.sector).filter(Boolean))).catch(()=>{});
  },[]);

  function where() {
    const c=[];
    const ef=dateFrom||(dPreset!=null?(()=>{const d=new Date();d.setDate(d.getDate()-dPreset);return d.toISOString().split('T')[0];})():null);
    const et=dateTo||new Date().toISOString().split('T')[0];
    if (ef) c.push(`COALESCE(transaction_date,filing_date)>='${ef}'`);
    c.push(`COALESCE(transaction_date,filing_date)>='2021-01-01'`);
    c.push(`COALESCE(transaction_date,filing_date)<='${et}'`);
    if (typeF)  c.push(`transaction_type='${typeF}'`);
    if (relF)   c.push(`relationship='${relF}'`);
    if (sectorF)c.push(`sector='${sectorF.replace(/'/g,"''")}'`);
    if (openMkt)c.push(`is_open_market=true`);
    if (sourceF==='corporate') c.push(`transaction_code NOT LIKE 'CONGRESS%'`);
    if (sourceF==='political') c.push(`transaction_code LIKE 'CONGRESS%'`);
    if (fromPortfolio && portfolioTickers && portfolioTickers.length) {
      c.push(`ticker IN (${portfolioTickers.map(t=>`'${t.replace(/'/g,"''")}'`).join(',')})`);
    } else if (fromPortfolio) {
      c.push(`1=0`);
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

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    setRows(null);
    proxySQL(`
      SELECT transaction_date,filing_date,ticker,company_name,insider_name,insider_title,
             relationship,transaction_type,transaction_code,is_open_market,
             shares::float,price_per_share::float,value::float,pct_owned_change::float,sector
      FROM public.filings ${where()}
      ${orderBy()}
      LIMIT 300
    `).then(setRows).catch(()=>setRows([]));
  },[search,typeF,relF,sectorF,sourceF,openMkt,fromPortfolio,dPreset,dateFrom,dateTo,sortKey,sortDir]);

  function navigate(d) { if (detail) setDetailStack(s=>[...s, detail]); setDetail(d); }
  function goBack() { const prev=detailStack[detailStack.length-1]; setDetailStack(s=>s.slice(0,-1)); setDetail(prev||null); }

  // Same reasoning as InsightsDrawer's own version of this: expanding from a
  // docked preview should land with the row you were just looking at
  // visible and marked selected, not scrolled off the top of a freshly
  // fetched 300-row list. Only fires once per open.
  const rowKey = (t) => t ? `${t.ticker}|${t.insiderName||t.insider_name}|${t.transactionDate||t.transaction_date}` : null;
  const listRef = useRef(null);
  const scrolledOnOpenRef = useRef(false);
  useEffect(()=>{
    if (scrolledOnOpenRef.current || !detail || detail.type!=='transaction' || !rows) return;
    const key = rowKey(detail.trade);
    if (!key) return;
    const el = listRef.current?.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); scrolledOnOpenRef.current = true; }
  },[detail, rows]);

  return (
    <div className="drawer-overlay" onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="drawer">
        <div className="drawer__hdr-row1">
          <span className="drawer__title">Filings</span>
          <button className="btn btn--ghost btn--icon" onClick={onClose}><IconClose style={{width:12,height:12}}/></button>
        </div>

        <div className="drawer__toolbar">
          <div className="drawer__filter-group drawer__filter-group--search">
            <span className="drawer__filter-label">Search</span>
            <div className="drawer__search-wrap">
              <svg className="drawer__search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input className="drawer__search" placeholder="Ticker, insider, company…"
                value={search} onChange={e=>setSearch(e.target.value)} autoFocus/>
            </div>
          </div>
          <div className="drawer__toolbar-divider"/>
          <div className="drawer__filter-group">
            <span className="drawer__filter-label">Window</span>
            <div className="dash-tile-pills" style={{gap:2}}>
              {DATA_DATE_PRESETS.map(p=>(
                <button key={p.l} className={`dash-tile-pill${dPreset===p.d&&!dateFrom?' dash-tile-pill--active':''}`}
                  onClick={()=>{setDPreset(p.d);setDateFrom('');setDateTo('');}}>{p.l}</button>
              ))}
            </div>
          </div>
          {(search||typeF||relF||sectorF||sourceF||openMkt||fromPortfolio||dPreset!==7||dateFrom||dateTo) && (
            <>
              <div className="drawer__toolbar-spacer"/>
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
              <span>{rows==null?'Loading…':`${rows.length}${rows.length===300?'+':''} filing${rows.length===1?'':'s'}`}</span>
            </div>
            {rows===null
              ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
              : rows.length===0
                ? <div className="drawer__empty">No filings match these filters</div>
                : rows.map((r,i)=>{
                  const tt=r.transaction_type;
                  const trade = {
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
                  };
                  const isActive = detail?.type==='transaction' && detail?.trade?.ticker===r.ticker
                    && detail?.trade?.insiderName===r.insider_name && detail?.trade?.transactionDate===r.transaction_date;
                  return (
                    <div key={i}
                      data-row-key={rowKey(trade)}
                      className={`drawer__list-row${isActive?' drawer__list-row--active':''}`}
                      onClick={()=>navigate({type:'transaction',trade})}>
                      <div className="drawer__list-row__main">
                        <span className="ticker" style={{fontSize:12,fontWeight:700}}>{r.ticker||'—'}</span>
                        <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?'Buy':tt==='sell'?'Sell':'Other'}</Badge>
                        <span className="td-muted" style={{fontSize:11,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.company_name}</span>
                        <span className={`td-mono drawer__list-row__val ${tt==='buy'?'val-buy':tt==='sell'?'val-sell':''}`}>{r.value?fmt.money(r.value):'—'}</span>
                      </div>
                      <div className="drawer__list-row__sub">
                        <span className="td-muted" style={{fontSize:11}}>{r.insider_name}</span>
                        <span className="td-muted" style={{fontSize:11,marginLeft:'auto'}}>{fmt.dateShort(r.transaction_date||r.filing_date)}</span>
                      </div>
                    </div>
                  );
                })
            }
          </div>

          <div className="drawer__detail">
            {!detail
              ? <div className="drawer__detail-empty">
                  <div style={{fontSize:24,marginBottom:8,opacity:.3}}>←</div>
                  <div style={{fontSize:13,color:'var(--text-3)'}}>Select a filing to see details</div>
                </div>
              : <DetailPanel
                  detail={detail}
                  filings={[]}
                  onClose={()=>setDetail(null)}
                  onNavigate={navigate}
                  onBack={goBack}
                  canGoBack={detailStack.length>0}
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

function DataPage({ onOpenDetail, portfolioTickers, user, onUpgrade }) {
  const pro = isPro(user);
  // CSV export is its own $39.99 one-time product, deliberately separate
  // from the Pro subscription — Pro's job is to earn recurring revenue, and
  // giving away the one-time product's entire value for free the moment
  // someone subscribes undercuts it completely.
  //
  // This button ALWAYS opens the purchase flow, regardless of whether the
  // user has bought before — it never triggers a direct download itself.
  // The one download that comes with a purchase happens automatically
  // right after checkout; anything after that is a deliberate, separate
  // "Re-download" action in Settings > Billing, not a second free door
  // into the same data from here.
  const [rows,    setRows]    = useState([]);
  const [total,   setTotal]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [pg,      setPg]      = useState(0);
  const [error,   setError]   = useState(null);
  const [sectors, setSectors] = useState([]);
  const [search,  setSearch]  = useState('');
  const [searchInput, setSearchInput] = useState('');
  // Auto-commits searchInput → search (which the fetch effect below actually
  // depends on) a moment after typing stops, rather than requiring Enter.
  // Debounced rather than committing on every keystroke — this triggers a
  // paired COUNT(*) + paginated SELECT, and firing that twice per letter
  // while someone's mid-word would be wasteful; a short pause after the
  // last keystroke is unnoticeable to a person typing but avoids that.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [typeF,   setTypeF]   = useState('');
  const [relF,    setRelF]    = useState('');
  const [sectorF, setSectorF] = useState('');
  const [sourceF, setSourceF] = useState('');
  const [openMkt, setOpenMkt] = useState(false);
  const [fromPortfolio, setFromPortfolio] = useState(false);
  const [dPreset, setDPreset] = useState(7);
  const [dateFrom,setDateFrom]= useState('');
  const [dateTo,  setDateTo]  = useState('');

  const [sortKey, setSortKey] = useState('transaction_date');
  const [sortDir, setSortDir] = useState(-1);
  const isMobile = useIsMobile();

  function resetFilters() {
    setSearch(''); setSearchInput('');
    setTypeF(''); setRelF(''); setSectorF(''); setSourceF('');
    setOpenMkt(false); setFromPortfolio(false);
    setDPreset(7); setDateFrom(''); setDateTo('');
  }
  // Mobile-only — the real table has 10 columns, no reasonable phone width
  // fits that, so mobile gets a separate compact card list instead of a
  // squeezed/overflowing version of the same table. Tapping a card expands
  // it in place for the columns that don't fit in the compact view.
  const [expandedRow, setExpandedRow] = useState(null);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    proxySQL(`SELECT DISTINCT sector FROM public.filings WHERE sector IS NOT NULL ORDER BY sector`)
      .then(r=>setSectors(r.map(x=>x.sector).filter(Boolean))).catch(()=>{});
  },[]);

  function where() {
    const c=[];
    const ef=dateFrom||(dPreset!=null?(()=>{const d=new Date();d.setDate(d.getDate()-dPreset);return d.toISOString().split('T')[0];})():null);
    const et=dateTo||new Date().toISOString().split('T')[0]; // always clamp to today unless user picks a later date themselves
    if (ef) c.push(`COALESCE(transaction_date,filing_date)>='${ef}'`);
    c.push(`COALESCE(transaction_date,filing_date)>='2021-01-01'`); // hard floor regardless — matches edgar.js, covers the 'All' preset which otherwise has no lower bound at all
    c.push(`COALESCE(transaction_date,filing_date)<='${et}'`);
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
    if (!cfg.NEON_PROXY_URL){setError('Unable to connect right now — try refreshing the page.');return;}
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

  const totalPgs=total!=null?Math.ceil(total/DATA_PAGE):null;
  const activeFilterCount = [typeF,relF,sectorF,sourceF,openMkt,fromPortfolio].filter(Boolean).length;

  // Passed through on every onOpenDetail call from this page — marks the
  // resulting detail as having come from Data (so expanding it opens the
  // raw-filings explorer, not the Insights signals/insiders one) and seeds
  // that explorer with the filters already active here.
  const dataFilters = {search,typeF,relF,sectorF,sourceF,openMkt,fromPortfolio,dPreset,dateFrom,dateTo,sortKey,sortDir};

  return (
    <div className="page-content">
      <div className="data-toolbar">
        <div className="filter-bar filter-bar--wrap">
          <div className="search-wrap">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" placeholder="Ticker, insider, company…"
              value={searchInput}
              onChange={e=>setSearchInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&setSearch(searchInput)}/>
          </div>
          <div className="drawer__toolbar-divider"/>
          <div className="date-pills">
            {DATA_DATE_PRESETS.map(p=>(
              <button key={p.l} className={`pill${dPreset===p.d&&!dateFrom?' pill--active':''}`}
                title={p.l==='All'&&!pro?'Free plan is still capped at the last 12 months — Pro unlocks true full history':undefined}
                onClick={()=>{setDPreset(p.d);setDateFrom('');setDateTo('');}}>
                {p.l}</button>
            ))}
          </div>
          {!isMobile && (
            <>
              <div className="drawer__toolbar-divider"/>
              <div style={{display:'flex',alignItems:'center',gap:7}}>
                <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDPreset(null);}}/>
                <span style={{color:'var(--text-3)',fontSize:12}}>→</span>
                <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setDPreset(null);}}/>
              </div>
            </>
          )}
          {activeFilterCount > 0 || search || dPreset !== 7 || dateFrom || dateTo ? (
            <button className="ins-filter-reset" onClick={resetFilters}>Reset filters</button>
          ) : null}
          <button className="btn btn--primary btn--sm" style={{marginLeft:'auto',flexShrink:0}}
            onClick={()=>onUpgrade('data_export')}>
            Export CSV <span className="settings-pro-badge" style={{marginLeft:6}}>$</span>
          </button>
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
      </div>

      <div className="data-layout">
        <div className="data-main">
          {error?<div className="state-box state-box--error"><p><IconWarning style={{width:14,height:14,marginRight:4,verticalAlign:"-2px"}}/>{error}</p></div>
          :loading?<div className="state-box"><Spinner/><p>Loading…</p></div>
          :rows.length===0?<div className="state-box"><IconEmpty style={{width:28,height:28,color:"var(--text-3)"}}/><p>No filings match these filters.</p></div>
          :isMobile?<div className="data-mobile-list">
            {rows.map((r,i)=>{
              const rel=r.relationship||'weak';
              const rl=rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Dir';
              const tt=r.transaction_type;
              const rowKey = `${r.ticker}-${r.transaction_date||r.filing_date}-${i}`;
              const isOpen = expandedRow===rowKey;
              return (
                <div key={rowKey} className={`data-mobile-card row-${tt}${isOpen?' data-mobile-card--expanded':''}`}
                  onClick={()=>setExpandedRow(k=>k===rowKey?null:rowKey)}>
                  <div className="data-mobile-card__top">
                    <span className="ticker">{r.ticker||'—'}</span>
                    <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>
                      {tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆ Other'}
                    </Badge>
                    <span className={`td-mono ${tt==='buy'?'val-buy':tt==='sell'?'val-sell':''}`} style={{marginLeft:'auto'}}>{fmt.money(r.value)}</span>
                  </div>
                  <div className="data-mobile-card__sub">
                    <span className="td-overflow">{r.company_name}</span>
                    <span className="td-muted">{fmt.dateShort(r.transaction_date||r.filing_date)}</span>
                  </div>
                  {isOpen && (
                    <div className="data-mobile-card__expanded" onClick={e=>e.stopPropagation()}>
                      <div className="data-mobile-card__grid">
                        <div><span className="td-muted">Insider</span><br/>{r.insider_name||'—'}<br/><span className="td-muted" style={{fontSize:11}}>{r.insider_title||'—'}</span></div>
                        <div><span className="td-muted">Relationship</span><br/><Badge type={`rel-${rel}`}>{rl}</Badge></div>
                        <div><span className="td-muted">Shares</span><br/>{fmt.number(r.shares)}</div>
                        <div><span className="td-muted">Price</span><br/>{fmt.price(r.price_per_share)}</div>
                        <div><span className="td-muted">Sector</span><br/>{r.sector!=='Other'?r.sector:'—'}</div>
                        <div><span className="td-muted">% owned change</span><br/>{r.pct_owned_change!=null?<span className="val-buy">+{parseFloat(r.pct_owned_change).toFixed(1)}%</span>:'—'}</div>
                        <div><span className="td-muted">Transaction code</span><br/>{r.transaction_code?<span title={TX_CODE_TOOLTIPS[r.transaction_code]||r.transaction_code}>{TX_CODE_SHORT[r.transaction_code]||r.transaction_code}</span>:'—'}</div>
                        {r.filing_date && r.filing_date!==r.transaction_date && (
                          <div><span className="td-muted">Filed</span><br/>{fmt.dateShort(r.filing_date)}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          :<div className="table-wrap">
            <table>
              <thead><tr>
                {DATA_SORTABLE_COLS.map(c=>(
                  <SortTh key={c.key} label={c.label} colKey={c.key} sortCol={sortKey} sortDir={sortDir} onSort={onSort}
                    right={c.type==='num'}/>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((r,i)=>{
                  const rel=r.relationship||'weak';
                  const rl=rel==='strong'?'C-Suite':rel==='medium'?'Officer':'Dir';
                  const tt=r.transaction_type;
                  return (
                    <tr key={i} className={`row-${tt} row-clickable`}
                      onClick={()=>onOpenDetail&&onOpenDetail({type:'transaction',dataFilters,trade:{
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
                      <td><span className="ticker dp-clickable" onClick={e=>{e.stopPropagation();r.ticker&&onOpenDetail&&onOpenDetail({type:'ticker',dataFilters,ticker:r.ticker,company:r.company_name});}}>{r.ticker||'—'}</span></td>
                      <td className="td-company">
                        <div className="td-overflow">{r.company_name}</div>
                        <div className="td-sector-inline">{r.sector!=='Other'?r.sector:''}</div>
                      </td>
                      <td className="td-insider">
                        <div className="td-overflow dp-clickable" onClick={e=>{e.stopPropagation();r.insider_name&&onOpenDetail&&onOpenDetail({type:'trader',dataFilters,name:r.insider_name,title:r.insider_title});}}>{r.insider_name}</div>
                        <div className="td-muted td-overflow" style={{fontSize:11}}>{r.insider_title||'—'}</div>
                      </td>
                      <td>
                        <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>
                          {tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆ Other'}
                        </Badge>
                        {r.transaction_code&&<div className="code-pill-sm" title={TX_CODE_TOOLTIPS[r.transaction_code]||r.transaction_code}>{TX_CODE_SHORT[r.transaction_code]||r.transaction_code}</div>}
                      </td>
                      <td className="td-right td-mono td-secondary">{fmt.number(r.shares)}</td>
                      <td className="td-right td-mono td-secondary">{fmt.price(r.price_per_share)}</td>
                      <td className="td-right td-mono">
                        <span className={tt==='buy'?'val-buy':tt==='sell'?'val-sell':''}>{fmt.money(r.value)}</span>
                      </td>
                      <td className="td-right td-mono">
                        {r.pct_owned_change!=null?<span className="val-buy">+{parseFloat(r.pct_owned_change).toFixed(1)}%</span>:'—'}
                      </td>
                      <td><Badge type={`rel-${rel}`}>{rl}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}

          {!loading&&!error&&(
            <div className="pagination">
              <span className="pagination__info">
                {total!=null
                  ? `${pg*DATA_PAGE+1}–${Math.min((pg+1)*DATA_PAGE,total||0)} of ${total.toLocaleString()} filing${total===1?'':'s'}`
                  : ''}
                {!pro&&<span> · Free plan shows the last 12 months — <button className="free-tier-note__link" onClick={()=>onUpgrade('full_history')}>upgrade</button> for full history</span>}
              </span>
              <div className="pagination__btns">
                <button className="btn btn--sm" onClick={()=>fetchPg(0)}       disabled={pg===0||loading||totalPgs<=1}>««</button>
                <button className="btn btn--sm" onClick={()=>fetchPg(pg-1)}    disabled={pg===0||loading||totalPgs<=1}>‹</button>
                <span className="pagination__counter">{pg+1}/{totalPgs||1}</span>
                <button className="btn btn--sm" onClick={()=>fetchPg(pg+1)}    disabled={pg>=totalPgs-1||loading||totalPgs<=1}>›</button>
                <button className="btn btn--sm" onClick={()=>fetchPg(totalPgs-1)} disabled={pg>=totalPgs-1||loading||totalPgs<=1}>»»</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PORTFOLIO ────────────────────────────────────────────────────────────────

// Fills the dead space on a sparse/empty portfolio with something actually
// useful: recent strong insider-buy signals the person doesn't already hold,
// reusing buildSignals() rather than introducing a parallel computation.

// ─── WATCHLIST PAGE ───────────────────────────────────────────────────────────
// Shows all recent insider activity for tickers the user has starred.
// Entirely localStorage-backed — no auth needed.
function WatchlistPage({ filings, loading, onOpenDetail, watchlist, ensureFilingsWindow }) {
  const [days, setDays] = useState(30);
  const [tab, setTab]   = useState('tickers');
  const [sortKey, setSortKey] = useState('netValue');
  const [sortDir, setSortDir] = useState(-1);
  const [detail, setDetail] = useState(null);
  const [detailStack, setDetailStack] = useState([]);
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);
  const isMobile = useIsMobile();
  // Mobile-only — matches every other list now: a row tap expands in place
  // instead of opening any kind of panel, drawer, or "explore" view.
  const [expandedKey, setExpandedKey] = useState(null);

  const watchedTickers  = watchlist.tickers;
  const watchedInsiders = watchlist.insiders || [];

  function navigate(d) { if (detail) setDetailStack(s=>[...s, detail]); setDetail(d); }
  function goBack() { setDetailStack(s=>{ const next=[...s]; const prev=next.pop(); setDetail(prev||null); return next; }); }
  function selectRow(d) {
    if (isMobile) {
      const key = d.type==='ticker' ? d.ticker : d.name;
      setExpandedKey(k => k===key ? null : key);
      return;
    }
    setDetailStack([]); setDetail(d);
  }
  function jumpTo(i) { setDetail(detailStack[i]); setDetailStack(s=>s.slice(0,i)); }
  const crumbLabel = (d) => d.type==='ticker' ? d.ticker : d.name;

  // Reset selection when switching tabs or when the currently-selected item
  // gets unwatched out from under it (star/follow toggled off from within
  // the open detail pane itself).
  useEffect(()=>{ setDetail(null); setDetailStack([]); }, [tab]);
  useEffect(()=>{
    if (detail?.type==='ticker' && !watchedTickers.includes(detail.ticker)) { setDetail(null); setDetailStack([]); }
    if (detail?.type==='trader' && !watchedInsiders.includes(detail.name)) { setDetail(null); setDetailStack([]); }
  }, [watchedTickers, watchedInsiders]); // eslint-disable-line react-hooks/exhaustive-deps

  const signals = useMemo(()=>{
    if (!watchedTickers.length) return [];
    const base = filings.filter(f=>{
      if (!watchedTickers.includes(f.ticker)) return false;
      if ((f.transactionDate||f.date||'') < cutoff) return false;
      return true;
    });
    const built = buildSignals(base);
    // Tickers with zero qualifying signals in this window still belong on the
    // list — they're watched regardless of recent activity — so backfill a
    // bare placeholder row for any watched ticker buildSignals didn't produce.
    const seen = new Set(built.map(s=>s.ticker));
    watchedTickers.forEach(t=>{
      if (!seen.has(t)) built.push({ ticker:t, company:'', conviction:0, netValue:0, cSuiteBuys:0, insiderCount:0, lastTradeDate:null });
    });
    return built;
  },[filings, watchedTickers, cutoff]);

  const insiderRows = useMemo(()=>{
    if (!watchedInsiders.length) return [];
    const byName = {};
    filings
      .filter(f=>watchedInsiders.includes(f.insiderName) && (f.transactionDate||f.date||'')>=cutoff)
      .forEach(f=>{
        if (!byName[f.insiderName]) byName[f.insiderName] = { name:f.insiderName, title:f.title||'', trades:0, netValue:0, lastDate:null };
        byName[f.insiderName].trades++;
        byName[f.insiderName].netValue += (f.transactionType==='buy'?1:-1) * (f.value||0);
        const d = f.transactionDate||f.date;
        if (!byName[f.insiderName].lastDate || d>byName[f.insiderName].lastDate) byName[f.insiderName].lastDate = d;
      });
    watchedInsiders.forEach(n=>{ if (!byName[n]) byName[n] = { name:n, title:'', trades:0, netValue:0, lastDate:null }; });
    return Object.values(byName);
  },[filings, watchedInsiders, cutoff]);

  const sortedTickerRows = useMemo(()=>{
    return [...signals].sort((a,b)=>{
      const av=a[sortKey]??-Infinity, bv=b[sortKey]??-Infinity;
      if (typeof av==='string') return sortDir>0 ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir>0 ? av-bv : bv-av;
    });
  },[signals, sortKey, sortDir]);

  const sortedInsiderRows = useMemo(()=>{
    const key = sortKey==='conviction' ? 'trades' : sortKey==='lastTradeDate' ? 'lastDate' : sortKey; // map shared sort keys to this tab's field names
    return [...insiderRows].sort((a,b)=>{
      const av=a[key]??-Infinity, bv=b[key]??-Infinity;
      if (typeof av==='string') return sortDir>0 ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir>0 ? av-bv : bv-av;
    });
  },[insiderRows, sortKey, sortDir]);

  function onSort(key) { if (sortKey===key) setSortDir(d=>-d); else { setSortKey(key); setSortDir(-1); } }

  const rows = tab==='tickers' ? sortedTickerRows : sortedInsiderRows;
  const emptyNow = tab==='tickers' ? watchedTickers.length===0 : watchedInsiders.length===0;

  return (
    <div className="page-content">
      <div className="wl-toolbar">
        <div className="ins-filter-group">
          <span className="ins-filter-group__label">View</span>
          <div className="settings-tabs">
            <button className={`settings-tab${tab==='tickers'?' settings-tab--active':''}`} onClick={()=>setTab('tickers')}>
              Tickers {watchedTickers.length>0&&<span className="wl-tab-count">{watchedTickers.length}</span>}
            </button>
            <button className={`settings-tab${tab==='insiders'?' settings-tab--active':''}`} onClick={()=>setTab('insiders')}>
              Insiders {watchedInsiders.length>0&&<span className="wl-tab-count">{watchedInsiders.length}</span>}
            </button>
          </div>
        </div>
        <div className="drawer__toolbar-divider" style={{alignSelf:'stretch',margin:0}}/>
        <div className="ins-filter-group">
          <span className="ins-filter-group__label">Window</span>
          <div className="dash-tile-pills">
            {[7,30,90].map(d=>(
              <button key={d} className={`dash-tile-pill${days===d?' dash-tile-pill--active':''}`} onClick={()=>{setDays(d);ensureFilingsWindow&&ensureFilingsWindow(d);}}>{d}d</button>
            ))}
          </div>
        </div>
        <p className="page-sub" style={{margin:'0 0 0 auto'}}>
          {watchedTickers.length} ticker{watchedTickers.length!==1?'s':''} · {watchedInsiders.length} insider{watchedInsiders.length!==1?'s':''} tracked
        </p>
      </div>

      {emptyNow ? (
        <div className="wl-empty">
          {tab==='tickers' ? (
            <div className="wl-empty__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" width="40" height="40">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} width="40" height="40" style={{color:'var(--text-3)'}}><circle cx="12" cy="12" r="9"/></svg>
          )}
          <div className="wl-empty__title">{tab==='tickers' ? 'No tickers watched yet' : 'No insiders followed yet'}</div>
          <div className="wl-empty__sub">
            {tab==='tickers'
              ? 'Click the star on any ticker in Insights, the detail panel, or All Data to start tracking it here.'
              : 'Click "Follow" on any insider in the leaderboard or trader profile to track their activity here.'}
          </div>
        </div>
      ) : (
        <div className="drawer__body wl-drawer-body">
          <div className="drawer__list">
            <div className="drawer__list-hdr">
              <span>{rows.length} {tab}</span>
            </div>
            {tab==='tickers' ? (
              <div className="ins-sig-col-hdrs" style={{gridTemplateColumns:'1fr 100px 90px'}}>
                <button className="ins-col-sort" onClick={()=>onSort('ticker')}>Ticker · Company{sortKey==='ticker'&&(sortDir<0?' ↓':' ↑')}</button>
                <button className="ins-col-sort" onClick={()=>onSort('conviction')}>Signal{sortKey==='conviction'&&(sortDir<0?' ↓':' ↑')}</button>
                <button className="ins-col-sort" style={{textAlign:'right',justifyContent:'flex-end'}} onClick={()=>onSort('netValue')}>Net flow{sortKey==='netValue'&&(sortDir<0?' ↓':' ↑')}</button>
              </div>
            ) : (
              <div className="ins-sig-col-hdrs" style={{gridTemplateColumns:'1fr 70px 90px'}}>
                <button className="ins-col-sort" onClick={()=>onSort('name')}>Insider{sortKey==='name'&&(sortDir<0?' ↓':' ↑')}</button>
                <button className="ins-col-sort" onClick={()=>onSort('trades')}>Trades{sortKey==='trades'&&(sortDir<0?' ↓':' ↑')}</button>
                <button className="ins-col-sort" style={{textAlign:'right',justifyContent:'flex-end'}} onClick={()=>onSort('netValue')}>Net flow{sortKey==='netValue'&&(sortDir<0?' ↓':' ↑')}</button>
              </div>
            )}

            <div className="drawer__list-scroll">
              {tab==='tickers' ? sortedTickerRows.map(s=>{
                const isSel = detail?.type==='ticker' && detail.ticker===s.ticker;
                const isExpanded = isMobile && expandedKey===s.ticker;
                return (
                  <div key={s.ticker} className={`ins-sig-row${isSel?' ins-sig-row--selected':''}${isExpanded?' ins-sig-row--expanded':''}`} style={isMobile?undefined:{gridTemplateColumns:'1fr 100px 90px'}}
                    onClick={()=>selectRow({type:'ticker', ticker:s.ticker, company:s.company})}>
                    <div className="ins-sig-row__left">
                      <span className="ticker ins-sig-row__ticker">{s.ticker}</span>
                      <div className="ins-sig-row__co">{s.company}</div>
                    </div>
                    <div className="ins-sig-row__signal"><ConvictionBar score={s.conviction}/></div>
                    <div className="ins-sig-row__right"><span className={`ins-sig-row__net ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span></div>
                    {isMobile && <div className="ins-sig-row__expand-chevron">{isExpanded ? '▴ Less' : '▾ More'}</div>}
                    {isExpanded && (
                      <div className="ins-sig-row__expanded" onClick={e=>e.stopPropagation()}>
                        <div className="ins-sig-row__expanded-grid">
                          <div><span className="td-muted">Sector</span><br/>{s.sector&&s.sector!=='Other'?s.sector:'—'}</div>
                          <div><span className="td-muted">Buys / Sells</span><br/>{s.buys||0} / {s.sells||0}</div>
                          <div><span className="td-muted">Insiders</span><br/>{s.insiderCount||0}{s.lastTradeDate?` · ${fmt.ago(s.lastTradeDate)}`:''}</div>
                          <div><span className="td-muted">Exec buys</span><br/>{s.cSuiteBuys>0?`${s.cSuiteBuys}×`:'—'}</div>
                          <div><span className="td-muted">Conviction score</span><br/>{s.conviction.toFixed(1)} / 15</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }) : sortedInsiderRows.map(r=>{
                const isSel = detail?.type==='trader' && detail.name===r.name;
                const isExpanded = isMobile && expandedKey===r.name;
                return (
                  <div key={r.name} className={`ins-sig-row${isSel?' ins-sig-row--selected':''}${isExpanded?' ins-sig-row--expanded':''}`} style={isMobile?undefined:{gridTemplateColumns:'1fr 70px 90px'}}
                    onClick={()=>selectRow({type:'trader', name:r.name, title:r.title})}>
                    <div className="ins-sig-row__left">
                      <span className="ins-sig-row__ticker" style={{fontSize:13}}>{r.name}</span>
                      {r.title&&<div className="ins-sig-row__co">{r.title}</div>}
                    </div>
                    <div className="ins-sig-row__right"><span className={`ins-sig-row__net ${r.netValue>=0?'val-buy':'val-sell'}`}>{r.trades} trade{r.trades!==1?'s':''}</span></div>
                    {isMobile && <div className="ins-sig-row__expand-chevron">{isExpanded ? '▴ Less' : '▾ More'}</div>}
                    {isExpanded && (
                      <div className="ins-sig-row__expanded" onClick={e=>e.stopPropagation()}>
                        <div className="ins-sig-row__expanded-grid">
                          <div><span className="td-muted">Title</span><br/>{r.title||'—'}</div>
                          <div><span className="td-muted">Trades ({days}d)</span><br/>{r.trades}</div>
                          <div><span className="td-muted">Last trade</span><br/>{r.lastDate?fmt.ago(r.lastDate):'—'}</div>
                          <div><span className="td-muted">Net flow</span><br/><span className={r.netValue>=0?'val-buy':'val-sell'}>{r.netValue>=0?'+':''}{fmt.money(r.netValue)}</span></div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="drawer__detail">
            {!detail
              ? <div className="drawer__detail-empty">
                  <div style={{fontSize:24,marginBottom:8,opacity:.3}}>←</div>
                  <div style={{fontSize:13,color:'var(--text-3)'}}>Select a {tab==='tickers'?'ticker':'insider'} to explore</div>
                </div>
              : <>
                  {detailStack.length>0 && (
                    <div className="wl-breadcrumb">
                      {detailStack.map((d,i)=>(
                        <React.Fragment key={i}>
                          <button className="wl-breadcrumb__item" onClick={()=>jumpTo(i)}>{crumbLabel(d)}</button>
                          <span className="wl-breadcrumb__sep">›</span>
                        </React.Fragment>
                      ))}
                      <span className="wl-breadcrumb__current">{crumbLabel(detail)}</span>
                    </div>
                  )}
                  <DetailPanel
                    detail={detail}
                    filings={filings}
                    onClose={()=>{setDetail(null);setDetailStack([]);}}
                    onNavigate={navigate}
                    onBack={goBack}
                    canGoBack={detailStack.length>0}
                    watchlist={watchlist}
                    inline={true}
                  />
                </>
            }
          </div>
        </div>
      )}
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
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{marginLeft:'auto'}} onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
          </button>
        </div>
      </nav>
      <div className="legal-content">
        <h1>Terms of Service</h1>
        <p className="legal-date">Last updated: June 26, 2025</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using Seli ("the Service"), operated by SELI LLC ("we," "us," or "our"), you agree to be bound by these Terms of Service. If you don't agree, please don't use Seli.</p>

        <h2>2. Description of Service</h2>
        <p>Seli aggregates and scores publicly available SEC Form 4 insider trading disclosures, congressional trading disclosures filed under the STOCK Act, and related market data. Every trade you see on Seli is sourced from public government databases, including the SEC's EDGAR system.</p>

        <h2>3. Not Financial Advice</h2>
        <p>Seli is informational and educational, not investment guidance. Nothing here (conviction scores, rankings, alerts, or anything else) constitutes financial, investment, legal, or tax advice. We are not a registered investment advisor, broker-dealer, or financial planner. Talk to a qualified financial professional before making investment decisions. Past insider trading patterns don't predict future results.</p>

        <h2>4. Data Accuracy</h2>
        <p>We make reasonable efforts to keep Seli's data accurate, but we make no representations or warranties about its completeness, accuracy, or timeliness. SEC filings themselves can contain errors, and there can be delays between a filing's actual date and when it appears in Seli. You assume all risk associated with relying on this information.</p>

        <h2>5. User Accounts</h2>
        <p>You'll need an account to access certain features. You're responsible for keeping your account credentials secure, providing accurate information, and telling us right away if you notice unauthorized use of your account.</p>

        <h2>6. Brokerage Connections</h2>
        <p>If you connect a brokerage account, you're authorizing Seli to retrieve read-only account data (positions, balances, account information) on your behalf. We never store your brokerage credentials, and Seli can never execute a trade for you. You can disconnect your brokerage account at any time from Settings.</p>

        <h2>7. Subscriptions and Billing</h2>
        <p>Certain features require a paid subscription. Subscriptions bill monthly. You can cancel anytime; cancellation takes effect at the end of your current billing period, not immediately. We reserve the right to change pricing with 30 days' notice. Payments are processed by Stripe and subject to Stripe's own terms of service.</p>

        <h2>8. Prohibited Uses</h2>
        <p>You may not: (a) use Seli for any unlawful purpose; (b) scrape, crawl, or otherwise systematically extract data from Seli; (c) resell or redistribute our data without written permission; (d) attempt to gain unauthorized access to any part of Seli; (e) use Seli to facilitate insider trading or securities fraud.</p>

        <h2>9. Intellectual Property</h2>
        <p>Seli, including its design, algorithms, and conviction scoring methodology, is the property of SELI LLC. The underlying SEC filing data itself is public domain. You may not copy, modify, or distribute Seli's proprietary systems without permission.</p>

        <h2>10. Disclaimer of Warranties</h2>
        <p>Seli is provided "as is," without warranty of any kind. We disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.</p>

        <h2>11. Limitation of Liability</h2>
        <p>To the maximum extent permitted by law, SELI LLC isn't liable for indirect, incidental, special, consequential, or punitive damages arising from your use of Seli, including investment losses.</p>

        <h2>12. Governing Law</h2>
        <p>These Terms are governed by the laws of the State of New Mexico, United States, without regard to conflict of law principles.</p>

        <h2>13. Changes to Terms</h2>
        <p>We may update these Terms at any time. Continuing to use Seli after a change means you accept the new Terms.</p>

        <h2>14. Contact</h2>
        <p>Questions about these Terms? Contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
        <div className="lp-footer__logo">
          <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
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

// ─── PRIVACY POLICY ───────────────────────────────────────────────────────────
function PrivacyPage() {
  const [dark, setDark] = useTheme();
  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{marginLeft:'auto'}} onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
          </button>
        </div>
      </nav>
      <div className="legal-content">
        <h1>Privacy Policy</h1>
        <p className="legal-date">Last updated: June 26, 2025</p>

        <h2>1. Overview</h2>
        <p>Seli, operated by SELI LLC, takes your privacy seriously. Here's exactly what Seli collects, how it's used, and the rights you have over your own data.</p>

        <h2>2. Information We Collect</h2>
        <h3>Account Information</h3>
        <p>When you create a Seli account, we collect your email address and, if you sign in with Google, your Google profile name and picture. Authentication runs through Clerk (clerk.com). Seli never stores your password.</p>

        <h3>Watchlist Data</h3>
        <p>Tickers and insiders you add to your watchlist are stored in Seli's database, tied to your account.</p>

        <h3>Brokerage Connection Data</h3>
        <p>If you connect a brokerage account, Seli stores an encrypted access token to retrieve your portfolio data, and holds your position data temporarily for display. Seli never stores your brokerage username or password.</p>

        <h3>Usage Data</h3>
        <p>Standard server logs (IP addresses, browser type, pages visited) for security and performance monitoring. Seli never sells this data.</p>

        <h2>3. How We Use Your Information</h2>
        <p>To: (a) provide and improve Seli; (b) show your portfolio alongside relevant insider trading signals; (c) send transactional emails (account verification, password reset) through Clerk; (d) send alert emails if you subscribe to Pro notifications; (e) process payments through Stripe.</p>

        <h2>4. Data Sharing</h2>
        <p>Seli doesn't sell your personal data. We share data only with the service providers who help run Seli:</p>
        <ul>
          <li><strong>Clerk</strong> (clerk.com): authentication and user management</li>
          <li><strong>Stripe</strong> (stripe.com): payment processing</li>
          <li><strong>Neon</strong> (neon.tech): database hosting</li>
          <li><strong>Cloudflare</strong> (cloudflare.com): hosting and security</li>
        </ul>

        <h2>5. Data Retention</h2>
        <p>Your account data stays with us for as long as your account is active. Delete your account, and we delete your personal data within 30 days. Watchlist and broker connection data is removed immediately on disconnection or account deletion, with no delay.</p>

        <h2>6. Security</h2>
        <p>Encrypted connections (HTTPS), encrypted storage of sensitive tokens (AES-256), and access controls throughout. No system is 100% secure, so you use Seli at your own risk.</p>

        <h2>7. Your Rights</h2>
        <p>You can: (a) access or export your data by contacting us; (b) delete your account and everything tied to it, anytime; (c) disconnect any brokerage connection anytime from Settings; (d) opt out of marketing emails anytime.</p>

        <h2>8. Cookies</h2>
        <p>Seli uses only essential cookies required for authentication (managed by Clerk), with no advertising or tracking cookies. Full details live in our <a href="/cookies">Cookie Policy</a>.</p>

        <h2>9. Children's Privacy</h2>
        <p>Seli isn't directed at children under 13, and we don't knowingly collect personal information from anyone under 13.</p>

        <h2>10. Changes to This Policy</h2>
        <p>We may update this Privacy Policy periodically. We'll notify you of material changes by email or in Seli itself.</p>

        <h2>11. Contact</h2>
        <p>Questions about this Privacy Policy? Contact us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__frame">
        <div className="lp-footer__logo">
          <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
          <span className="lp-wordmark">Seli</span>
          <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
        </div>
        <div className="lp-footer__links">
          <a href="/">Home</a>
          <span>·</span>
          <a href="/terms" className="lp-footer__link-muted">Terms of Service</a>
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
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{marginLeft:'auto'}} onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
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
          <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
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
        <p>Seli has five sections, each doing a different job. Here's what each one is actually for.</p>
        <h3>Dashboard</h3>
        <p>Your <strong>daily overview</strong>: market sentiment, sector performance, the biggest insider signals from the last few days, top-ranked insiders, and market news. Start here if you just want to know what's happening today.</p>
        <EnvPreview type="dashboard"/>
        <h3>Insights</h3>
        <p>The full, filterable signal feed. Every trade Seli has scored, filterable by window, score, type (corporate vs. congressional), and sector — the complete, raw feed behind the Dashboard's highlights.</p>
        <EnvPreview type="insights"/>
        <h3>Data</h3>
        <p>The <strong>raw, unscored filings</strong>. Every trade, searchable and filterable, with a link back to the original government filing. No ranking or opinion applied. If you want to draw your own conclusions, this is where to work.</p>
        <EnvPreview type="data"/>
        <h3>Watchlist</h3>
        <p>Tickers and insiders you've chosen to follow (Pro). Their activity surfaces ahead of everything else, and it's what <strong>instant alerts and email digests</strong> are built from.</p>
        <EnvPreview type="watchlist"/>
        <h3>Settings</h3>
        <p>Your plan, billing, notification preferences, and brokerage connection all live here.</p>
        <EnvPreview type="settings"/>
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
        <p>Seli checks for new filings on a recurring basis throughout the trading day. A disclosure typically appears within minutes of becoming public, not the next morning.</p>
        <h3>Is this financial advice?</h3>
        <p>No. Seli is informational and educational only. Every trade shown, every score, and every alert is generated the exact same way for every user — nothing is personalized to your holdings, goals, or risk tolerance, even where a setting lets you filter or follow specific tickers. Conviction scores are Seli's own methodology for organizing public filings, not a signal about what to do with that information. Nothing here is a recommendation to buy, sell, or hold anything. See our <a href="/terms">Terms of Service</a> for the full disclaimer.</p>
        <h3>Can Seli place trades for me?</h3>
        <p>No. Brokerage connections are read-only. Seli can see your positions to show relevant signals, but it can never place a trade.</p>
        <h3>Why don't option exercises or RSU vests count toward conviction scores?</h3>
        <p>Only open-market trades, meaning someone putting their own cash in, count toward conviction. A scheduled option exercise or equity vest doesn't reflect a discretionary bet the way an open-market purchase does.</p>
        <h3>Still have a question?</h3>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Real questions from real users are exactly what shapes this FAQ and the product itself.</p>
      </>
    ),
  },
  {
    id: 'billing',
    label: 'Billing',
    render: () => (
      <>
        <h3>What does Pro include?</h3>
        <p>Full historical data (not just the last 7 days), watchlists, portfolio linking, and instant alerts or email digests, for $11.99 per month.</p>
        <h3>What's the Full Data Export?</h3>
        <p>A separate, one-time $39.99 purchase: a complete pull of the database as a spreadsheet, independent of a Pro subscription. Each purchase includes one download. If you need it again later, use Re-download in Settings &gt; Billing at no extra charge (this pulls current data, not a frozen copy from your original purchase date).</p>
        <h3>How do I cancel Pro?</h3>
        <p>Settings &gt; Billing &gt; Cancel subscription. You keep full access through the end of the period you already paid for. Cancellation doesn't cut you off immediately.</p>
        <h3>Can I come back after canceling?</h3>
        <p>Yes, anytime. Settings &gt; Billing shows a reactivate option if you cancel before the period actually ends, or you can simply upgrade again afterward.</p>
        <h3>Billing questions we didn't cover?</h3>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your account email and we'll sort it out directly.</p>
      </>
    ),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    render: () => (
      <>
        <p>Two separate systems, both configured in Settings &gt; Notifications, both Pro features.</p>
        <h3>Instant alerts</h3>
        <p>Fire as soon as a qualifying trade is detected: a ticker or insider on your watchlist trading, a stock you actually hold in a connected brokerage account, a large executive buy above your threshold, or a reversal (an insider trading opposite their recent pattern). Each trigger can be turned on or off independently.</p>
        <h3>Digests</h3>
        <p>A daily or weekly email summary instead of, or alongside, instant alerts. Top-scoring trades, filtered by minimum score, source (corporate or congressional), and whether it's limited to your watchlist.</p>
        <h3>Not receiving alerts you expect?</h3>
        <p>First check Settings &gt; Notifications to confirm the specific trigger is switched on. A common cause is a trigger being off by default. There's also a test-email button there to confirm delivery is working at all. If it's still not arriving, email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
      </>
    ),
  },
  {
    id: 'portfolio',
    label: 'Portfolio Connection',
    render: () => (
      <>
        <h3>How does linking work?</h3>
        <p>Through SnapTrade, a third-party connection service. Seli never sees or stores your brokerage username or password. Access is read-only: Seli can see your positions, never place a trade.</p>
        <h3>Can I disconnect?</h3>
        <p>Anytime, from Settings. Disconnecting removes the stored connection immediately, not on a delay.</p>
        <h3>My broker isn't listed</h3>
        <p>Broker support is expanding. If yours isn't available yet, check back, or let us know at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> which one you'd want to see supported.</p>
        <h3>The performance chart looks off</h3>
        <p>Portfolio performance is an approximation based on your current holdings, not a full reconstruction of every historical buy and sell. It shows what your present position would be worth over time, not necessarily your actual realized returns.</p>
      </>
    ),
  },
];

function HelpCenterPage() {
  const [activeId, setActiveId] = useState('using-seli');
  const idx = HELP_SECTIONS.findIndex(s => s.id === activeId);
  const section = HELP_SECTIONS[idx] ?? HELP_SECTIONS[0];
  const [dark, setDark] = useTheme();

  return (
    <div className="legal-page" data-theme={dark ? 'dark' : 'light'}>
      <nav className="lp-nav">
        <div className="lp-nav__frame">
          <a className="lp-nav__logo" href="/">
            <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
            <span className="lp-wordmark">Seli</span>
            <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
          </a>
          <button className="lp-btn-ghost lp-btn-ghost--icon" style={{marginLeft:'auto'}} onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
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
                onClick={() => setActiveId(s.id)}
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
          <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
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
  daily_digest:           false,
  weekly_digest:          false,
  digest_top_signals:     true,
  digest_congressional:   true,
  digest_corporate:       true,
  digest_watchlist_only:  false,
  digest_min_conviction:  'any',
  digest_max_signals:     10,   // 0 = unlimited
  digest_min_value:       0,    // 0 = any amount
  // Instant alerts
  instant_watchlist_ticker: false,
  instant_followed_insider: false,
  instant_high_conviction:  false,
  instant_reversal:         false,
  instant_min_value:                 0,        // 0 = any amount
  instant_high_conviction_threshold: 1000000,   // was hardcoded server-side before
};

function useNotificationPrefs(userId, pro) {
  const [prefs,  setPrefs]  = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState(null);

  useEffect(()=>{
    if (!userId) return;
    // Try localStorage first for instant load — avoids a blank flash while
    // the real network request is in flight.
    const cached = localStorage.getItem(`seli_prefs_${userId}`);
    if (cached) { try { setPrefs({...DEFAULT_PREFS,...JSON.parse(cached)}); } catch {} }
    if (!cfg.NEON_PROXY_URL || !pro) { setPrefs(p=>p||{...DEFAULT_PREFS}); return; }

    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs`, { headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load preferences');
        const p = data.prefs ? {...DEFAULT_PREFS, ...data.prefs} : {...DEFAULT_PREFS};
        setPrefs(p);
        localStorage.setItem(`seli_prefs_${userId}`, JSON.stringify(p));
      } catch {
        setPrefs(p=>p||{...DEFAULT_PREFS});
      }
    })();
  },[userId, pro]);

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
      setTimeout(()=>setSaved(false), 2500);
    } catch(e) { setError(e.message || 'Save failed — try again'); }
    setSaving(false);
  }

  return { prefs, saving, saved, error, save };
}

// ── Settings toggle row ────────────────────────────────────────────────────────
function SettingsToggle({ label, sub, checked, onChange, pro, disabled }) {
  return (
    <div className={`settings-row settings-row--toggle${disabled?' settings-row--disabled':''}`}>
      <div style={{flex:1}}>
        <div className="settings-row__label">{label}</div>
        {sub&&<div className="settings-row__sub">{sub}</div>}
      </div>
      <label className={`settings-toggle${(!pro||disabled)?' settings-toggle--locked':''}`}>
        <input type="checkbox" checked={!!checked} onChange={onChange} disabled={!pro||disabled}/>
        <span className="settings-toggle__track"/>
      </label>
    </div>
  );
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

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  async function connect() {
    setConnecting(true); setError(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/snaptrade/connect`, { method: 'POST', headers });
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

function SettingsPage({ user, onUpgrade }) {
  const pro   = isPro(user);
  const { prefs, saving, saved, error, save } = useNotificationPrefs(user?.id, pro);
  const snaptrade = useSnapTrade(pro);
  const portfolio = usePortfolio();
  const [section, setSection] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('section') || (params.get('snaptrade') ? 'brokers' : 'billing');
  });
  const [local,   setLocal]   = useState(null);
  const [testState, setTestState] = useState(null); // null | 'sending' | 'sent' | error string

  useEffect(()=>{ if (prefs && !local) setLocal({...prefs}); },[prefs]);

  function upd(key, val) { setLocal(p=>({...p, [key]:val})); }

  async function sendTestEmail() {
    setTestState('sending');
    try {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      const res = await fetch(`${cfg.NEON_PROXY_URL}/prefs/test-email`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test email failed');
      setTestState('sent');
      setTimeout(()=>setTestState(null), 4000);
    } catch (e) {
      setTestState(e.message || 'Test email failed');
      setTimeout(()=>setTestState(null), 5000);
    }
  }

  const SECTIONS = [
    {id:'billing',       label:'Billing',          icon:'$'},
    {id:'notifications', label:'Notifications',    Icon:IconMail},
    {id:'brokers',       label:'Link Portfolio',   Icon:IconLink},
  ];
  const [notifTab, setNotifTab] = useState('digests'); // sub-tab within Notifications

  return (
    <div className="settings-page">
      <div className="settings-layout">

        {/* ── Left sidebar nav ─────────────────────────────────────────── */}
        <div className="settings-sidenav">
          {SECTIONS.map(s=>(
            <button key={s.id}
              className={`settings-sidenav__item${section===s.id?' settings-sidenav__item--active':''}`}
              onClick={()=>setSection(s.id)}
              title={s.label}
              aria-label={s.label}>
              <span className="settings-sidenav__icon">{s.Icon ? <s.Icon style={{width:14,height:14}}/> : s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>

        {/* ── Content ──────────────────────────────────────────────────── */}
        <div className="settings-content">

          {/* BILLING */}
          {section==='billing'&&(
            <div className="settings-section">
              <div className="settings-section__title">Billing</div>
              <div className="settings-section__desc">Manage your plan, payment, and data export purchases.</div>
              <BillingSection user={user} />
            </div>
          )}

          {/* NOTIFICATIONS — digests and instant alerts as sub-tabs */}
          {section==='notifications'&&(<>
            <div className="settings-tabs" style={{marginBottom:14}}>
              <button className={`settings-tab${notifTab==='digests'?' settings-tab--active':''}`} onClick={()=>setNotifTab('digests')}>Email digests</button>
              <button className={`settings-tab${notifTab==='instant'?' settings-tab--active':''}`} onClick={()=>setNotifTab('instant')}>Instant alerts</button>
            </div>

          {/* EMAIL DIGESTS */}
          {notifTab==='digests'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Email digests
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Scheduled summaries delivered to your inbox. Choose your frequency and what to include.
                {!pro&&<button className="settings-section__lock" onClick={()=>onUpgrade('notifications')}> Upgrade to Pro to enable email digests.</button>}
              </div>

              {!local ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div> : (<>

                {/* Frequency — independent toggles, not mutually exclusive */}
                <div className="settings-group">
                  <div className="settings-group__label">Frequency</div>
                  <SettingsToggle
                    label="Daily digest"
                    sub="Every weekday morning at 8am ET"
                    checked={local.daily_digest}
                    onChange={e=>upd('daily_digest', e.target.checked)}
                    pro={pro}
                  />
                  <SettingsToggle
                    label="Weekly digest"
                    sub="Every Monday morning at 8am ET"
                    checked={local.weekly_digest}
                    onChange={e=>upd('weekly_digest', e.target.checked)}
                    pro={pro}
                  />
                </div>

                {/* Content — what to include in digests */}
                <div className={`settings-group${(!local.daily_digest&&!local.weekly_digest)||!pro?' settings-group--dimmed':''}`}>
                  <div className="settings-group__label">What to include</div>
                  <SettingsToggle
                    label="Top insider signals"
                    sub="Highest-scoring buys from the selected window"
                    checked={local.digest_top_signals}
                    onChange={e=>upd('digest_top_signals', e.target.checked)}
                    pro={pro}
                    disabled={!local.daily_digest && !local.weekly_digest}
                  />
                  <SettingsToggle
                    label="Corporate trades (Form 4)"
                    sub="C-suite and officer open-market transactions"
                    checked={local.digest_corporate}
                    onChange={e=>upd('digest_corporate', e.target.checked)}
                    pro={pro}
                    disabled={!local.daily_digest && !local.weekly_digest}
                  />
                  <SettingsToggle
                    label="Congressional trades (STOCK Act)"
                    sub="Senator and representative disclosures"
                    checked={local.digest_congressional}
                    onChange={e=>upd('digest_congressional', e.target.checked)}
                    pro={pro}
                    disabled={!local.daily_digest && !local.weekly_digest}
                  />
                  <SettingsToggle
                    label="Watchlist activity only"
                    sub="Limit digest to tickers and insiders you follow"
                    checked={local.digest_watchlist_only}
                    onChange={e=>upd('digest_watchlist_only', e.target.checked)}
                    pro={pro}
                    disabled={!local.daily_digest && !local.weekly_digest}
                  />
                </div>

                {/* Score filter */}
                <div className={`settings-group${(!local.daily_digest&&!local.weekly_digest)||!pro?' settings-group--dimmed':''}`}>
                  <div className="settings-group__label">Minimum signal strength</div>
                  <div className="settings-group__desc">Only include trades scoring above this level</div>
                  <div className="settings-pills" style={{marginTop:10}}>
                    {[
                      {v:'any',    l:'Any signal',  d:'All open-market trades'},
                      {v:'medium', l:'Medium+',     d:'Exec participation or $100K+'},
                      {v:'high',   l:'High only',   d:'C-suite clusters above $1M'},
                    ].map(o=>(
                      <button key={o.v}
                        className={`settings-pill${local.digest_min_conviction===o.v?' settings-pill--active':''}${!pro?' settings-pill--locked':''}`}
                        onClick={()=>pro&&upd('digest_min_conviction', o.v)}
                        title={o.d}>
                        {o.l}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Volume & sizing controls */}
                <div className={`settings-group${(!local.daily_digest&&!local.weekly_digest)||!pro?' settings-group--dimmed':''}`}>
                  <div className="settings-group__label">Digest size</div>
                  <div className="settings-row">
                    <div style={{flex:1}}>
                      <div className="settings-row__label">Max tickers per digest</div>
                      <div className="settings-row__sub">Caps how many tickers appear in one email, ranked by net flow</div>
                    </div>
                    <select className="settings-select" value={local.digest_max_signals} disabled={!pro}
                      onChange={e=>upd('digest_max_signals', Number(e.target.value))}>
                      {[5,10,20,50].map(n=><option key={n} value={n}>{n}</option>)}
                      <option value={0}>Unlimited</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <div style={{flex:1}}>
                      <div className="settings-row__label">Minimum trade value</div>
                      <div className="settings-row__sub">Skip tickers where no single trade reaches this size</div>
                    </div>
                    <select className="settings-select" value={local.digest_min_value} disabled={!pro}
                      onChange={e=>upd('digest_min_value', Number(e.target.value))}>
                      <option value={0}>Any amount</option>
                      <option value={10000}>$10K+</option>
                      <option value={50000}>$50K+</option>
                      <option value={250000}>$250K+</option>
                      <option value={1000000}>$1M+</option>
                    </select>
                  </div>
                </div>

                <div className="settings-save-row">
                  <button className="btn btn--primary" onClick={()=>save(local)} disabled={saving||!pro}>
                    {saving?'Saving…':saved?'✓ Saved':'Save digest settings'}
                  </button>
                  {pro&&(
                    <button className="btn btn--ghost" onClick={sendTestEmail} disabled={testState==='sending'}>
                      {testState==='sending'?'Sending…':'Send test email'}
                    </button>
                  )}
                  {saved&&<span className="settings-saved-msg"><IconCheck style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>Saved</span>}
                  {testState==='sent'&&<span className="settings-saved-msg"><IconCheck style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>Test email sent</span>}
                  {testState&&testState!=='sending'&&testState!=='sent'&&<span className="settings-saved-msg" style={{color:'var(--red-600)'}}><IconWarning style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>{testState}</span>}
                  {error&&<span className="settings-saved-msg" style={{color:'var(--red-600)'}}><IconWarning style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>{error}</span>}
                  {!pro&&<button className="settings-section__lock" onClick={()=>onUpgrade('notifications')}>Upgrade to Pro to save</button>}
                </div>
              </>)}
            </div>
          )}

          {/* INSTANT ALERTS */}
          {notifTab==='instant'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Instant alerts
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Real-time emails fired within minutes of a filing. Each trigger is independent.
                {!pro&&<button className="settings-section__lock" onClick={()=>onUpgrade('notifications')}> Upgrade to Pro to enable instant alerts.</button>}
              </div>

              {!local ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div> : (<>

                <div className="settings-group">
                  <div className="settings-group__label">Watchlist triggers</div>
                  <SettingsToggle
                    label="Watched ticker traded"
                    sub="Any insider trades a stock on your watchlist"
                    checked={local.instant_watchlist_ticker}
                    onChange={e=>upd('instant_watchlist_ticker', e.target.checked)}
                    pro={pro}
                  />
                  <SettingsToggle
                    label="Followed insider filed"
                    sub="Someone you follow submits a new Form 4"
                    checked={local.instant_followed_insider}
                    onChange={e=>upd('instant_followed_insider', e.target.checked)}
                    pro={pro}
                  />
                  <div className="settings-row">
                    <div style={{flex:1}}>
                      <div className="settings-row__label">Minimum trade value</div>
                      <div className="settings-row__sub">Applies to both watchlist triggers above — skip anything smaller</div>
                    </div>
                    <select className="settings-select" value={local.instant_min_value} disabled={!pro}
                      onChange={e=>upd('instant_min_value', Number(e.target.value))}>
                      <option value={0}>Any amount</option>
                      <option value={10000}>$10K+</option>
                      <option value={50000}>$50K+</option>
                      <option value={250000}>$250K+</option>
                    </select>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group__label">Signal triggers</div>
                  <SettingsToggle
                    label="Large executive buy"
                    sub="C-suite open-market buy at or above the threshold below — regardless of watchlist"
                    checked={local.instant_high_conviction}
                    onChange={e=>upd('instant_high_conviction', e.target.checked)}
                    pro={pro}
                  />
                  <div className="settings-row">
                    <div style={{flex:1}}>
                      <div className="settings-row__label">Minimum trade size</div>
                      <div className="settings-row__sub">Single-trade size required to trigger this alert</div>
                    </div>
                    <select className="settings-select" value={local.instant_high_conviction_threshold} disabled={!pro}
                      onChange={e=>upd('instant_high_conviction_threshold', Number(e.target.value))}>
                      <option value={250000}>$250K+</option>
                      <option value={500000}>$500K+</option>
                      <option value={1000000}>$1M+</option>
                      <option value={2000000}>$2M+</option>
                      <option value={5000000}>$5M+</option>
                    </select>
                  </div>
                  <SettingsToggle
                    label="Reversal detected"
                    sub="An insider on a watched ticker changes direction"
                    checked={local.instant_reversal}
                    onChange={e=>upd('instant_reversal', e.target.checked)}
                    pro={pro}
                  />
                </div>

                <div className="settings-save-row">
                  <button className="btn btn--primary" onClick={()=>save(local)} disabled={saving||!pro}>
                    {saving?'Saving…':saved?'✓ Saved':'Save alert settings'}
                  </button>
                  {pro&&(
                    <button className="btn btn--ghost" onClick={sendTestEmail} disabled={testState==='sending'}>
                      {testState==='sending'?'Sending…':'Send test email'}
                    </button>
                  )}
                  {saved&&<span className="settings-saved-msg"><IconCheck style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>Saved</span>}
                  {testState==='sent'&&<span className="settings-saved-msg"><IconCheck style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>Test email sent</span>}
                  {testState&&testState!=='sending'&&testState!=='sent'&&<span className="settings-saved-msg" style={{color:'var(--red-600)'}}><IconWarning style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>{testState}</span>}
                  {error&&<span className="settings-saved-msg" style={{color:'var(--red-600)'}}><IconWarning style={{width:11,height:11,marginRight:2,verticalAlign:"-1px"}}/>{error}</span>}
                  {!pro&&<button className="settings-section__lock" onClick={()=>onUpgrade('notifications')}>Upgrade to Pro to save</button>}
                </div>
              </>)}
            </div>
          )}
          </>)}

          {/* LINK PORTFOLIO */}
          {section==='brokers'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Link Portfolio
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Connect your brokerage via SnapTrade to see insider activity on your holdings. Read-only — Seli never trades on your behalf, and your login credentials go directly to your brokerage, never to Seli.
                {!pro&&<button className="settings-section__lock" onClick={()=>onUpgrade('portfolio')}> Upgrade to Pro to connect a brokerage.</button>}
              </div>

              {pro && (
                <div className="settings-group">
                  {snaptrade.status===null ? (
                    <div className="settings-broker-card"><span className="td-muted">Checking connection status…</span></div>
                  ) : !snaptrade.status.connection ? (
                    <div className="settings-broker-card">
                      <div className="settings-broker-card__left">
                        <div className="settings-broker-card__name">No brokerage connected</div>
                        <div className="settings-broker-card__sub">Fidelity, Alpaca, and 400M+ other accounts supported via SnapTrade</div>
                      </div>
                      <div className="settings-broker-card__right">
                        <button className="btn btn--primary btn--sm" onClick={snaptrade.connect} disabled={snaptrade.connecting}>
                          {snaptrade.connecting?'Redirecting…':'Connect'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings-broker-card">
                      <div className="settings-broker-card__left">
                        <div className="settings-broker-card__name">{snaptrade.status.connection.broker || 'Brokerage connected'}</div>
                        <div className="settings-broker-card__sub">
                          Read-only · Connected {new Date(snaptrade.status.connection.connected_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}
                        </div>
                      </div>
                      <div className="settings-broker-card__right">
                        <span className="settings-broker-status settings-broker-status--connected">Connected</span>
                        <button className="btn btn--ghost btn--sm" onClick={snaptrade.disconnect}>Disconnect</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {pro && snaptrade.status?.connection && (
                <div className="settings-group">
                  <div className="settings-group__label" style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <span>Positions</span>
                    {portfolio.lastRefreshed && <span style={{fontWeight:400,textTransform:'none',letterSpacing:0,fontSize:11}}>Updated {fmt.ago(portfolio.lastRefreshed.toISOString())}</span>}
                  </div>
                  <div style={{padding:'12px 14px'}}>
                    {!portfolio.port ? (
                      <div style={{display:'flex',alignItems:'center',gap:8}}><Spinner size={14}/><span className="td-muted" style={{fontSize:12}}>Loading positions…</span></div>
                    ) : portfolio.err ? (
                      <p className="td-muted" style={{fontSize:12,color:'var(--red-600)'}}>Couldn't load your positions right now.</p>
                    ) : portfolio.port.positions.length===0 ? (
                      <p className="td-muted" style={{fontSize:12}}>No positions found in this account.</p>
                    ) : (
                      <>
                        <p style={{fontSize:13,marginBottom:10}}>
                          <strong>{portfolio.port.positions.length}</strong> position{portfolio.port.positions.length!==1?'s':''} · <strong>{fmt.money(portfolio.port.totalValue)}</strong> total value
                        </p>
                        {[...portfolio.port.positions].sort((a,b)=>Math.abs(b.marketValue||0)-Math.abs(a.marketValue||0)).map((p,i)=>(
                          <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderTop:i>0?'0.5px solid var(--border)':'none'}}>
                            <span className="ticker" style={{fontSize:12,minWidth:56}}>{p.symbol}</span>
                            <span className="td-muted" style={{fontSize:11,flex:1}}>{p.company}</span>
                            <span style={{fontSize:12,fontFamily:'var(--font-mono)'}}>{fmt.money(p.marketValue)}</span>
                            {p.openPnl!=null && (
                              <span className={`${p.openPnl>=0?'val-buy':'val-sell'}`} style={{fontSize:11,fontFamily:'var(--font-mono)',minWidth:90,textAlign:'right'}}>
                                {p.openPnl>=0?'+':''}{fmt.money(p.openPnl)} ({p.openPnlPct>=0?'+':''}{p.openPnlPct.toFixed(1)}%)
                              </span>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                    <button className="btn btn--ghost btn--sm" style={{marginTop:12}} onClick={portfolio.refresh} disabled={portfolio.refreshing}>
                      {portfolio.refreshing?'Refreshing…':'Refresh'}
                    </button>
                  </div>
                </div>
              )}

              {snaptrade.error && (
                <p className="settings-section__note" style={{color:'var(--red-600)'}}>{snaptrade.error}</p>
              )}

              <p className="settings-section__note">
                Fidelity and Alpaca live-account access is pending broker approval — testing now via Alpaca Paper (no real account needed).
                Connections are read-only — positions and balances only, no trading access.
              </p>
            </div>
          )}

        </div>
      </div>

      {/* Fixed bar, independent of whichever tab's content is showing above it
          (and however tall that content is) — sits right above the app
          footer instead of scrolling with the active tab's content, which
          is what put it at wildly different heights depending on section. */}
      <div className="settings-legal-bar">
        <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
        <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
        <a href="/cookies" target="_blank" rel="noreferrer">Cookies</a>
      </div>
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
  { symbol:'NVDA', buy:true,  delta:'12.4%' },
  { symbol:'AAPL', buy:true,  delta:'3.1%'  },
  { symbol:'TSLA', buy:false, delta:'8.7%'  },
  { symbol:'MSFT', buy:true,  delta:'2.9%'  },
  { symbol:'META', buy:true,  delta:'5.6%'  },
  { symbol:'JPM',  buy:false, delta:'1.8%'  },
  { symbol:'AMZN', buy:true,  delta:'4.2%'  },
  { symbol:'GOOGL',buy:true,  delta:'6.3%'  },
  { symbol:'AVGO', buy:true,  delta:'7.1%'  },
  { symbol:'XOM',  buy:false, delta:'2.4%'  },
  { symbol:'UNH',  buy:true,  delta:'3.8%'  },
  { symbol:'V',    buy:false, delta:'1.2%'  },
  { symbol:'CRM',  buy:true,  delta:'5.9%'  },
  { symbol:'DIS',  buy:false, delta:'2.7%'  },
  { symbol:'ADBE', buy:true,  delta:'4.5%'  },
  { symbol:'PFE',  buy:false, delta:'1.6%'  },
];

function InfoTrustPage({ onBack, onEnter }) {
  return (
    <div className="lp-info">
      <div className="lp-info__inner">
        <a href="/" onClick={onBack} className="lp-info__back">← Back</a>

        {/* ── Title + brief intro ──────────────────────────────────────── */}
        <div className="lp-info__eyebrow">About Seli</div>
        <h1 className="lp-info__h1">Why insider trades are public record</h1>
        <p className="lp-info__lede">
          Every year, corporate insiders and members of Congress disclose thousands of stock trades —
          not because they want to, but because federal law requires it. That disclosure creates a genuinely
          rare thing in public markets: a legally mandated look at what the people closest to a company are
          actually doing with their own money.
        </p>

        {/* ── How insiders beat the market ─────────────────────────────── */}
        <section className="lp-info__section reveal">
          <h2>How insiders beat the market</h2>
          <p>
            The idea that insider trades carry real predictive information isn't new, and it isn't a fintech
            marketing claim either. It's decades of published financial economics research, summarized here
            rather than buried in a wall of citations.
          </p>
          <div className="lp-findings-grid">
            <div className="lp-finding-card reveal reveal--delay-0">
              <div className="lp-finding-card__icon"><IconInsights style={{width:18,height:18}}/></div>
              <div className="lp-finding-card__title">Buying beats selling as a signal</div>
              <div className="lp-finding-card__body">Insiders face real legal exposure for selling on bad non-public information. That risk doesn't apply the same way to buying, which is why purchases carry more predictive weight than sales.</div>
              <div className="lp-finding-card__cite">Seyhun, 1980s–90s</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-1">
              <div className="lp-finding-card__icon"><IconFavorites style={{width:18,height:18}}/></div>
              <div className="lp-finding-card__title">Clusters matter more than one trade</div>
              <div className="lp-finding-card__body">Several insiders buying independently around the same time is a stronger signal than one person acting alone. Seli's own scoring is built around this directly.</div>
              <div className="lp-finding-card__cite">Lakonishok &amp; Lee, 2001</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-2">
              <div className="lp-finding-card__icon"><IconZap style={{width:18,height:18}}/></div>
              <div className="lp-finding-card__title">Timing separates signal from noise</div>
              <div className="lp-finding-card__body">Routine, calendar-driven insider trades carry little predictive value. Opportunistic, irregularly-timed ones carry almost all of it.</div>
              <div className="lp-finding-card__cite">Cohen, Malloy &amp; Pomorski, 2012</div>
            </div>
            <div className="lp-finding-card reveal reveal--delay-3">
              <div className="lp-finding-card__icon"><IconData style={{width:18,height:18}}/></div>
              <div className="lp-finding-card__title">The rules keep changing, and matter</div>
              <div className="lp-finding-card__body">A 2023 SEC rule change to pre-scheduled 10b5-1 trading plans measurably shifted how insiders structure their disclosed sales. This is an active area of research, not a settled 1980s question.</div>
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
              { label:'SEC EDGAR + Congress', desc:'Form 4 filings and STOCK Act disclosures, straight from the source.' },
              { label:'Ingested & parsed', desc:'New filings pulled and structured automatically, typically within minutes of publication.' },
              { label:'Scored', desc:'Weighted by who\u2019s trading, how much relative to what they hold, and whether others are too.' },
              { label:'Surfaced', desc:'Ranked and shown as a signal — not buried in a raw filing.' },
            ].map((step,i,arr)=>(
              <React.Fragment key={i}>
                <div className="lp-pipeline__step">
                  <div className="lp-pipeline__num">{i+1}</div>
                  <div className="lp-pipeline__label">{step.label}</div>
                  <div className="lp-pipeline__desc">{step.desc}</div>
                </div>
                {i<arr.length-1 && <div className="lp-pipeline__arrow">→</div>}
              </React.Fragment>
            ))}
          </div>
          <p>
            You're never limited to just the ranked view. Every account can see the underlying raw filing
            data — ticker, insider, shares, price, transaction type, date — the same information Seli's own
            scoring is built from, not a black box on top of it. The scored, ranked signal view sits alongside
            it for when you want the fast read instead of the raw feed. Both update automatically as new
            filings arrive.
          </p>
          <p>
            Seli's conviction score is built directly around the same principles the research above
            established, not invented from scratch:
          </p>
          <ul className="lp-info__principles">
            <li><strong>Who's buying matters.</strong> A purchase from a C-suite executive — someone with the
              broadest view into the company — carries more weight than one from a director with narrower
              visibility.</li>
            <li><strong>Size relative to what they already own matters more than raw dollars.</strong> A
              $500K purchase from someone materially growing their existing stake is a stronger signal than
              the same dollar amount as a routine top-up on a much larger position.</li>
            <li><strong>Multiple insiders acting together matters.</strong> Directly following Lakonishok and
              Lee's finding — several insiders buying independently around the same time is treated as a
              stronger signal than one person acting alone.</li>
            <li><strong>Only real, personal-funds market transactions count at all.</strong> Stock grants,
              option exercises, and other compensation-related transfers are structurally excluded before a
              signal is ever scored — they don't reflect a personal bet the way an open-market purchase does.</li>
          </ul>
          <p>
            We don't publish the exact formula or weights — that's the specific part of this that's ours —
            but the underlying principles above are the actual mechanism, not a marketing simplification of it.
          </p>
        </section>

        {/* ── Historical analysis ──────────────────────────────────────── */}
        <section className="lp-info__section reveal">
          <h2>Historical analysis</h2>
          <div className="lp-timeline">
            {[
              { year:'1934', label:'Securities Exchange Act', desc:'Establishes the requirement that corporate insiders disclose their own trades to the public.' },
              { year:'2002', label:'Sarbanes-Oxley Act', desc:'Shortens the filing deadline from 10 days down to 2 business days — the modern Form 4 window.' },
              { year:'2012', label:'STOCK Act', desc:'Extends mandatory trade disclosure to members of Congress.' },
              { year:'Today', label:'Seli', desc:'Ingests every new filing — corporate and congressional — within minutes of publication.' },
            ].map((t,i)=>(
              <div key={i} className="lp-timeline__item">
                <div className="lp-timeline__year">{t.year}</div>
                <div className="lp-timeline__dot"/>
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
            window — insiders can have up to two business days to report a trade after it happens. That's
            actually faster than it used to be: Sarbanes-Oxley tightened the requirement from ten days down to
            two specifically to make this data more useful. But two days is still real lag, and for someone
            making decisions on minute-to-minute price action, this data is structurally too old to act on
            that way. We'd rather tell you that directly than let you find out the hard way.
          </p>
          <p>
            <strong>Scoring accuracy improves as more history is captured</strong>, not just as a matter of
            more data being generally better — an insider's track record can only be evaluated against the
            trades Seli has actually ingested. A newly backfilled period naturally starts thinner than one
            with years of accumulated history behind it.
          </p>
          <p>
            <strong>Academic findings describe average, historical tendencies</strong> — not a guarantee about
            any single trade, any single insider, or what happens next. Insiders are informed about their own
            companies; they aren't infallible, and markets can move against even a well-timed, well-informed
            trade.
          </p>
          <p>
            <strong>Nothing on this page or in Seli is financial advice.</strong> Seli surfaces public
            disclosure data and a scoring methodology built on published research — it does not recommend
            any specific trade, and past patterns, academic or otherwise, don't guarantee future results.
          </p>
        </section>

        <div className="lp-info__cta">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="lp-btn-primary lp-btn-primary--lg">Open Seli →</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <button className="lp-btn-primary lp-btn-primary--lg" onClick={onEnter}>Open Seli →</button>
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
            <line x1="0" y1="12" x2="240" y2="12" stroke="var(--border)" strokeWidth="0.5"/>
            <line x1="0" y1="35" x2="240" y2="35" stroke="var(--border)" strokeWidth="0.5"/>
            <line x1="0" y1="58" x2="240" y2="58" stroke="var(--border)" strokeWidth="0.5"/>
            <path d="M0,50 L30,46 L60,48 L90,38 L120,40 L150,26 L180,28 L210,12 L240,8" fill="none" stroke="var(--green-600)" strokeWidth="2"/>
          </svg>
        </div>
        <div className="port-mini-tile__list">
          {[
            {t:'NVDA',  v:'$18,204', pnl:'+6.2%', sig:true},
            {t:'AAPL',  v:'$9,880',  pnl:'+2.1%', sig:false},
            {t:'MSFT',  v:'$6,340',  pnl:'+3.7%', sig:true},
            {t:'TSLA',  v:'$4,110',  pnl:'-3.4%', sig:true},
            {t:'GOOGL', v:'$2,660',  pnl:'+1.4%', sig:false},
          ].map(r => (
            <div key={r.t} className="port-mini-row">
              <span className="ticker" style={{fontSize:12,minWidth:50}}>{r.t}</span>
              {r.sig && <span className="ins-port-chip__signal-badge" style={{fontSize:'0.5rem'}}>activity</span>}
              <span className="td-muted" style={{fontSize:10,flex:1,textAlign:'right'}}>{r.v}</span>
              <span className={parseFloat(r.pnl)>=0?'val-buy':'val-sell'} style={{fontSize:10,fontFamily:'var(--font-mono)',minWidth:50,textAlign:'right'}}>{r.pnl}</span>
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
      <div className="dash-tile__body" style={{padding:0}}>
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
            <p className="lp-mock-alert-email__intro">4 of your instant alerts were triggered:</p>
            <table className="lp-mock-alert-email__table"><tbody>
              {[
                {t:'NVDA', co:'NVIDIA Corp',    reason:'Watched ticker traded',  who:'Jensen Huang',   date:'Jul 22, 2026', action:'Buy',  detail:'12,000 sh @ $118.42', val:'$1.42M',    buy:true},
                {t:'TSLA', co:'Tesla Inc',      reason:'Large executive sale',   who:'Elon Musk',       date:'Jul 21, 2026', action:'Sell', detail:'610 sh @ $248.55',    val:'$151,616',  buy:false},
                {t:'MSFT', co:'Microsoft Corp', reason:'Followed insider filed', who:'Satya Nadella',   date:'Jul 21, 2026', action:'Buy',  detail:'340 sh @ $421.10',    val:'$143,174',  buy:true},
                {t:'ADSK', co:'Autodesk Inc',   reason:'You hold this stock',    who:'Andrew Anagnost', date:'Jul 19, 2026', action:'Buy',  detail:'95 sh @ $289.77',     val:'$27,528',   buy:true},
              ].map(r => (
                <tr key={r.t}>
                  <td>
                    <span className="lp-mock-alert-email__ticker">{r.t}</span><br/>
                    <span className="lp-mock-alert-email__muted">{r.co}</span>
                  </td>
                  <td className="lp-mock-alert-email__muted">{r.reason}</td>
                  <td>
                    <span className="lp-mock-alert-email__muted">{r.who}</span><br/>
                    <span className="lp-mock-alert-email__faint">{r.date}</span>
                  </td>
                  <td>
                    <span className={r.buy?'lp-mock-alert-email__buy':'lp-mock-alert-email__sell'}>{r.action}</span><br/>
                    <span className="lp-mock-alert-email__muted">{r.detail}</span>
                  </td>
                  <td className={`lp-mock-alert-email__val ${r.buy?'lp-mock-alert-email__buy':'lp-mock-alert-email__sell'}`}>{r.val}</td>
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
      <div className="dash-tile__body" style={{padding:0}}>
        <div className="table-wrap" style={{border:'none',borderRadius:0,boxShadow:'none'}}>
          <table>
            <thead><tr>
              <th>Date</th><th>Ticker</th><th>Type</th>
              <th className="th--right">Shares</th><th className="th--right">Price</th><th className="th--right">Value</th>
            </tr></thead>
            <tbody>
              {[
                {d:'Jul 22', t:'NVDA', tt:'buy',  sh:'1,200', px:'$118.42', val:'$142,104'},
                {d:'Jul 21', t:'MSFT', tt:'buy',  sh:'340',   px:'$421.10', val:'$143,174'},
                {d:'Jul 21', t:'TSLA', tt:'sell', sh:'610',   px:'$248.55', val:'$151,616'},
                {d:'Jul 19', t:'ADSK', tt:'buy',  sh:'95',    px:'$289.77', val:'$27,528'},
              ].map((r,i) => (
                <tr key={i} className={`row-${r.tt}`}>
                  <td className="td-date"><span className="td-date-main">{r.d}</span></td>
                  <td><span className="ticker">{r.t}</span></td>
                  <td>
                    <Badge type={r.tt}>
                      {r.tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>}
                    </Badge>
                  </td>
                  <td className="td-right td-mono td-secondary">{r.sh}</td>
                  <td className="td-right td-mono td-secondary">{r.px}</td>
                  <td className="td-right td-mono"><span className={r.tt==='buy'?'val-buy':'val-sell'}>{r.val}</span></td>
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
      <div className="dash-tile__body" style={{padding:0}}>
        <div className="ins-lb-list">
          {[
            {n:'A.L. Sarroff Fund', title:'10% Owner',    rel:'weak',   buys:'48 buys', val:'$4.2M', rate:94, score:4.8},
            {n:'Jason T. Adelman',  title:'Chief Exec.',  rel:'strong', buys:'3 buys',  val:'$820K', rate:87, score:4.2},
            {n:'325 Capital LLC',   title:'10% Owner',    rel:'weak',   buys:'2 buys',  val:'$610K', rate:71, score:3.6},
            {n:'AC Nordic ApS',     title:'Director',     rel:'medium', buys:'6 buys',  val:'$390K', rate:52, score:2.1},
          ].map((r,i) => (
            <div key={r.n} className="ins-lb-card">
              <div className="ins-lb-card__rank">{i+1}</div>
              <div className="ins-lb-card__body">
                <div className="ins-lb-card__name">{r.n}</div>
                <div className="td-muted" style={{fontSize:11}}>{r.title}</div>
                <div className="ins-lb-card__meta">
                  <Badge type={`rel-${r.rel}`}>{r.rel==='strong'?'C-Suite':r.rel==='medium'?'Officer':'Dir'}</Badge>
                  <span className="td-muted" style={{fontSize:11}}>{r.buys} · {r.val}</span>
                </div>
              </div>
              <div className="ins-lb-card__score">
                <div className={`ins-lb-card__rate ${r.rate>=70?'val-buy':r.rate>=50?'':'val-sell'}`}>{r.rate}%</div>
                <ConvictionBar score={r.score} max={4}/>
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
  const [dataSinceYear, setDataSinceYear] = useState(2018);
  useEffect(() => {
    fetch(`${cfg.NEON_PROXY_URL}/public/data-stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.oldest_filing_date) {
          const y = new Date(d.oldest_filing_date + 'T12:00:00').getFullYear();
          if (y && y > 2000 && y <= new Date().getFullYear()) setDataSinceYear(y);
        }
      })
      .catch(() => {}); // keep the 2018 fallback silently — this is a single word on a marketing page, not worth surfacing an error for
  }, []);

  // "What's Inside" content — four concrete things the product does, not
  // abstract feature names. Written plainly on purpose: short sentences,
  // no hedging, no forced enthusiasm.
  const WHATS_INSIDE = [
    {
      icon: 'IconLink',
      eyebrow: 'Portfolio',
      title: 'Watch your own holdings, and theirs',
      body: 'Link your brokerage and see insider activity on stocks you already own. Or skip that, and just follow the specific tickers and people you want to keep an eye on.',
      env: 'watchlist',
    },
    {
      icon: 'IconZap',
      eyebrow: 'Alerts',
      title: 'Get notified the moment it happens',
      body: 'When someone you follow trades, or a stock you hold gets a cluster of insider buying, you\'ll see it here — as close to real time as public filings allow.',
      env: 'settings',
    },
    {
      icon: 'IconData',
      eyebrow: 'Data',
      title: `Every filing since ${dataSinceYear}`,
      body: `House, Senate, and corporate insider trades, pulled straight from public SEC and STOCK Act disclosures. Nothing here is a rumor or a paid data feed. It's what was actually filed, going back to ${dataSinceYear}.`,
      env: 'data',
    },
    {
      icon: 'IconInsights',
      eyebrow: 'Signals',
      title: 'A ranked history, not a hot take',
      body: 'Corporate and political insiders ranked by their factual trading history: how often they traded, in what direction, and how large. It\'s a transparent scoring methodology applied the same way to everyone, not a recommendation to follow anyone specific.',
      env: 'insights',
    },
  ];
  useEffect(() => {
    function onPop() { setView(window.location.pathname === '/about' ? 'about' : 'home'); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function goToAbout(e) { e.preventDefault(); navigateTo('/about'); setView('about'); window.scrollTo(0,0); }
  function goHome(e) { if (e) e.preventDefault(); navigateTo('/'); setView('home'); window.scrollTo(0,0); }
  // Section links (Features/Pricing) need to work from the About view too —
  // a plain anchor tag does nothing there, since those sections don't exist
  // in the DOM while view==='about'. Navigate home first, then scroll once
  // the home view has actually rendered.
  function goToSection(e, hash) {
    e.preventDefault();
    if (view === 'about') {
      navigateTo('/'); setView('home');
      setTimeout(() => document.querySelector(hash)?.scrollIntoView({behavior:'smooth'}), 60);
    } else {
      document.querySelector(hash)?.scrollIntoView({behavior:'smooth'});
    }
  }

  // Scroll-reveal: observe .reveal elements and add .reveal--visible when in
  // viewport. Re-runs on every view change (not just once on mount) — home
  // and /about are conditionally rendered, so switching between them
  // unmounts and remounts a whole tree of .reveal elements that need to be
  // freshly observed each time, not just the ones present at first load.
  useEffect(()=>{
    const obs = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if(e.isIntersecting) { e.target.classList.add('reveal--visible'); obs.unobserve(e.target); }
      });
    },{ threshold:0.12, rootMargin:'0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));
    return ()=>obs.disconnect();
  },[view]);

  return (
    <div className="lp" data-theme={dark?'dark':'light'}>

      {/* Nav */}
      <nav className="lp-nav">
        <div className="lp-nav__frame">
        <a href="/" onClick={goHome} className="lp-nav__logo">
          <div className="lp-logo-mark"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
          <span className="lp-wordmark">Seli</span>
          <span className="beta-tag beta-tag--nav" title="Seli is in private beta">BETA</span>
        </a>
        <div className="lp-nav__links">
          <a href="#features" onClick={(e)=>goToSection(e,'#features')} className="lp-nav__link">Features</a>
          <a href="#pricing"  onClick={(e)=>goToSection(e,'#pricing')} className="lp-nav__link">Pricing</a>
          <a href="/about" onClick={goToAbout} className="lp-nav__link">About</a>
        </div>
        <div className="lp-nav__actions">
          <button className="lp-btn-ghost lp-btn-ghost--icon" onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
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

      {view==='about' ? (
        <InfoTrustPage onBack={goHome} onEnter={onEnter}/>
      ) : (<>
      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-bg" aria-hidden="true"/>
        <h1 className="lp-hero__h1 reveal reveal--delay-1">
          Public data from the people who beat the market.<br/>
          <span className="lp-hero__h1-accent">Legible. Instant. At your fingertips.</span>
        </h1>
        <p className="lp-hero__sub reveal reveal--delay-2">
          Every SEC Form 4 filing and congressional stock disclosure, the moment it's public.
          No rumors, no paid data feeds, nothing personalized to you — just what corporate
          executives, directors, and members of Congress actually filed, organized so you can
          actually read it. Track specific tickers or people, or browse the full record.
        </p>
        <div className="lp-hero__cta reveal reveal--delay-3">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="lp-btn-primary lp-btn-primary--lg">Open Seli →</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <button className="lp-btn-primary lp-btn-primary--lg" onClick={onEnter}>Open Seli →</button>
          </SignedIn>
        </div>

        {/* Product preview strip */}
        <div className="lp-preview reveal reveal--delay-4">
          <div className="lp-preview__bar">
            <div className="lp-preview__dots">
              <span/><span/><span/>
            </div>
            <span className="lp-preview__url">seli.app · Dashboard</span>
          </div>
          <div className="lp-preview__screen">
            {/* Simulated dashboard UI */}
            <div className="lp-screen-strip">
              {[['SENTIMENT','47 Neutral'],['SPY','$733.58 −1.45%'],['QQQ','$713.65 −3.29%'],['VIX','—'],['IWM','$295.32 −0.96%'],['INSIDER FLOW (30D)','Bullish 95% buying']].map(([l,v])=>(
                <div key={l} className="lp-screen-stat">
                  <span className="lp-screen-stat__label">{l}</span>
                  <span className="lp-screen-stat__val">{v}</span>
                </div>
              ))}
            </div>
            <div className="lp-screen-body">
              <div className="lp-screen-signals">
                <div className="lp-screen-hdr">INSIDER SIGNALS <span style={{opacity:.4,fontWeight:400}}>· 7d · 26 signals</span></div>
                {[
                  {t:'FMBM', c:'F&M Bank Corp',     v:'+$51K',   b:'8× exec', hi:true},
                  {t:'FISV', c:'Fiserv Inc',         v:'+$1.7M',  b:'6× exec', hi:true},
                  {t:'MSTR', c:'Strategy Inc',       v:'+$817K',  b:'1× exec', hi:false, rev:true},
                  {t:'COR',  c:'Cencora Inc',        v:'+$1.1M',  b:'1× exec', hi:false},
                  {t:'ADSK', c:'Autodesk Inc',       v:'+$499K',  b:'1× exec', hi:false},
                ].map(r=>(
                  <div key={r.t} className="lp-screen-row">
                    <div>
                      <span className="lp-screen-ticker">{r.t}</span>
                      {r.rev&&<span className="lp-screen-rev">↺</span>}
                      <span className="lp-screen-co">{r.c}</span>
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      {r.b&&<span className="lp-screen-badge">{r.b}</span>}
                      <span className={`lp-screen-val ${r.hi?'lp-screen-val--hi':''}`}>{r.v}</span>
                      <div className="lp-screen-bar">
                        <div className="lp-screen-bar__fill" style={{width:r.hi?'85%':'55%',background:r.hi?'#3ECF8E':'#7C6FFF'}}/>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="lp-screen-right">
                <div className="lp-screen-hdr">TOP INSIDERS <span style={{opacity:.4,fontWeight:400}}>· hit rate · all-time</span></div>
                {[
                  {n:'A.L. Sarroff Fund', r:'94%', buys:'48 buys'},
                  {n:'Adelman Jason T',   r:'100%',buys:'3 buys'},
                  {n:'325 Capital LLC',   r:'100%',buys:'2 buys'},
                  {n:'AC Nordic ApS',     r:'50%', buys:'6 buys'},
                ].map((r,i)=>(
                  <div key={i} className="lp-screen-lb-row">
                    <span className="lp-screen-lb-rank">{i+1}</span>
                    <span className="lp-screen-lb-name">{r.n}</span>
                    <span className="lp-screen-lb-buys">{r.buys}</span>
                    <span className={`lp-screen-lb-rate ${parseFloat(r.r)>=70?'lp-screen-lb-rate--hi':''}`}>{r.r}</span>
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
          {[...MARQUEE_TICKERS, ...MARQUEE_TICKERS].map((t,i)=>(
            <div key={i} className="lp-marquee__chip">
              <span className="lp-marquee__ticker">{t.symbol}</span>
              <span className={`lp-marquee__delta ${t.buy?'val-buy':'val-sell'}`}>{t.buy?'▲':'▼'} {t.delta}</span>
            </div>
          ))}
        </div>
        </div>
      </div>

      {/* Features */}
      <section className="lp-features" id="features">
        <div className="lp-section-label reveal">What's inside</div>
        <h2 className="lp-section-h2 reveal reveal--delay-1">Public data, actually easy to use.</h2>
        <div className="lp-benefit-list">
          {WHATS_INSIDE.map((f,i)=>{
            const Icon = LP_FEATURE_ICON_MAP[f.icon];
            return (
              <div key={f.title} className={`lp-benefit-row ${i%2===1?'lp-benefit-row--reverse':''} reveal reveal--delay-${i%3}`}>
                <div className="lp-benefit-row__text">
                  <div className="lp-benefit-row__icon">{Icon && <Icon style={{width:24,height:24}}/>}</div>
                  <div className="lp-benefit-row__eyebrow">{f.eyebrow}</div>
                  <div className="lp-benefit-row__title">{f.title}</div>
                  <div className="lp-benefit-row__body">{f.body}</div>
                </div>
                <div className="lp-benefit-row__snippet">
                  <div className="lp-benefit-snippet-box" aria-hidden="true">
                    <LPFeatureMock type={f.env}/>
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
        <h2 className="lp-section-h2 reveal reveal--delay-1">Simple, transparent pricing.</h2>

        {/* Main plans — two vertical cards */}
        <div className="lp-pricing-top">
          <div className="lp-price-card reveal reveal--delay-1">
            <div className="lp-price-card__name">Free</div>
            <div className="lp-price-card__price">$0<span>/mo</span></div>
            <div className="lp-price-card__desc">Start tracking insider moves today. No card required.</div>
            <ul className="lp-price-card__features">
              {['Dashboard & sector heatmap','7-day signal window','Top insiders leaderboard','Corporate + congressional trades','All filed SEC transactions dating back 1 year'].map(f=>(
                <li key={f}><span className="lp-check"><IconCheck style={{width:12,height:12}}/></span>{f}</li>
              ))}
            </ul>
            <div className="lp-price-card__spacer"/>
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
            <div className="lp-price-card__badge">Half-off</div>
            <div className="lp-price-card__name">Pro</div>
            <div className="lp-price-card__price">
              <span className="lp-price-card__price-strike">$11.99</span> $6.99<span>/mo</span>
            </div>
            <div className="lp-price-card__beta-note">Half off, forever — for the first 25 Beta users</div>
            <div className="lp-price-card__desc">Full history, every alert, every score — for serious research.</div>
            <ul className="lp-price-card__features">
              {['Everything in Free',`Full historical data (${dataSinceYear}→present)`,'Customizable email alerts, instant or digest','Full score breakdown on every trade','Connect your brokerage (SnapTrade)','Full insiders deep-dive'].map(f=>(
                <li key={f}><span className="lp-check"><IconCheck style={{width:12,height:12}}/></span>{f}</li>
              ))}
            </ul>
            <div className="lp-price-card__spacer"/>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-primary lp-btn-primary--full">Upgrade to Pro →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-primary lp-btn-primary--full" onClick={onEnter}>Upgrade to Pro →</button>
            </SignedIn>
          </div>
        </div>

        <div className="lp-price-card lp-price-card--landscape reveal reveal--delay-3">
          <div className="lp-price-card--landscape__info">
            <div className="lp-price-card__name">Data export</div>
            <div className="lp-price-card__desc">Just need the dataset? No subscription — download and own it.</div>
            <ul className="lp-price-card__features lp-price-card__features--inline">
              {['Complete Form 4 dataset',`${dataSinceYear}→present`,'Congressional trades included','CSV, instant download'].map(f=>(
                <li key={f}><span className="lp-check"><IconCheck style={{width:12,height:12}}/></span>{f}</li>
              ))}
            </ul>
          </div>
          <div className="lp-price-card--landscape__action">
            <div className="lp-price-card__price">$39.99<span>/one-time</span></div>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-ghost lp-btn-ghost--full">Download dataset →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-ghost lp-btn-ghost--full" onClick={onEnter}>Download dataset →</button>
            </SignedIn>
          </div>
        </div>
      </section>

      {/* About teaser — left-aligned, real substance, not a centered blurb.
          Fades out into a clear "read the rest" CTA rather than being
          truncated abruptly. */}
      <section className="lp-about-teaser reveal reveal--delay-1" id="about-teaser">
        <div className="lp-about-teaser__grid">
          <div className="lp-about-teaser__lead">
            <h2 className="lp-section-h2">The research is real. The filings are public.</h2>
            <p className="lp-about-teaser__intro">
              This isn't a hunch or a marketing angle. It's decades of financial economics research,
              hiding behind filings almost nobody reads. Federal law forces every insider to disclose their
              trades. Seli reads every single one, the moment it lands, so you don't have to.
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
          <div className="lp-logo-mark lp-logo-mark--sm"><img src={logoSimple} alt="Seli" style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>
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
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
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


// ── Routing — URL <-> app state ─────────────────────────────────────────────
// External paths are deliberately friendlier than internal page ids
// (page id 'signals' -> path 'insights') so shared/indexed URLs read well
// without renaming the internal id everywhere it's already used.
const PAGE_TO_PATH = { home:'home', dashboard:'', signals:'insights', data:'data', watchlist:'watchlist', settings:'settings' };
const PATH_TO_PAGE = { '':'dashboard', home:'home', insights:'signals', data:'data', watchlist:'watchlist', settings:'settings' };

function pathFromAppState(page, detail) {
  // Detail deep-link takes priority — the panel overlays whatever page is
  // behind it, so the URL should reflect the most specific thing on screen.
  if (detail?.type === 'ticker' && detail.ticker) {
    return `/ticker/${encodeURIComponent(detail.ticker)}`;
  }
  if (detail?.type === 'trader' && detail.name) {
    return `/insider/${encodeURIComponent(detail.name)}`;
  }
  const seg = PAGE_TO_PATH[page] ?? '';
  return seg ? `/${seg}` : '/';
}

function appStateFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'ticker' && parts[1]) {
    return { page: 'dashboard', detail: { type: 'ticker', ticker: decodeURIComponent(parts[1]).toUpperCase(), company: '' } };
  }
  if (parts[0] === 'insider' && parts[1]) {
    return { page: 'dashboard', detail: { type: 'trader', name: decodeURIComponent(parts[1]), title: '' } };
  }
  // Root path ('') has no explicit page name to look up — on mobile this
  // should land on the new consolidated Home rather than the desktop
  // Dashboard, since Home is what "quick check on my phone" now means.
  // A URL that explicitly said /insights, /data, etc. is respected as-is
  // on any device; this default only applies to a bare '/'.
  if (!parts[0] && isMobileViewport()) return { page: 'home', detail: null };
  const page = PATH_TO_PAGE[parts[0] || ''];
  return { page: page || 'dashboard', detail: null };
}

const PAGE_TITLES = { home:'Home', dashboard:'Dashboard', signals:'Insights', data:'Data', watchlist:'Watchlist', settings:'Settings' };

function titleFromAppState(page, detail) {
  if (detail?.type === 'ticker' && detail.ticker) {
    return `${detail.ticker}${detail.company ? ' — ' + detail.company : ''} — Insider Trading — Seli`;
  }
  if (detail?.type === 'trader' && detail.name) {
    return `${detail.name} — Insider Trading Activity — Seli`;
  }
  return `${PAGE_TITLES[page] || 'Dashboard'} — Seli`;
}

import * as Sentry from '@sentry/react';

// Not exported directly — see the wrapped default export at the bottom of
// this file. Renamed from App so an ErrorBoundary can sit ABOVE it: if
// this component itself throws during render, the boundary needs to be a
// parent of it, not something nested inside its own return, which
// wouldn't catch a crash in this component's own body.
function AppInner() {
  const [dark,setDark] = useTheme();
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();

  // Register Clerk token getter globally so edgar.js can use it without
  // needing to import Clerk directly (edgar.js is a plain ES module)
  const { signOut } = useAuth();
  useEffect(()=>{
    if (isSignedIn && getToken) {
      window.__clerkGetToken = () => getToken();
      window.__clerkSignOut  = () => signOut({ redirectUrl: '/' });
    } else {
      window.__clerkGetToken = null;
      window.__clerkSignOut  = null;
    }
  }, [isSignedIn, getToken, signOut]);

  // Show landing page if: Clerk hasn't loaded yet OR user is not signed in
  const showLanding = !isLoaded || !isSignedIn;
  // /about is a genuinely public page — signed-in users should be able to
  // reach it too (e.g. via the help icon in the status bar), not just
  // signed-out visitors. Without this, the authenticated router doesn't
  // recognize '/about' as a known page id and silently falls back to
  // Dashboard instead. Tracked as real state (not a one-off check) so it
  // correctly toggles back if the user navigates away within the same tab.
  const [isAboutPath, setIsAboutPath] = useState(() => window.location.pathname === '/about');
  useEffect(() => {
    function onPop() { setIsAboutPath(window.location.pathname === '/about'); }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const [page,setPage] = useState(()=>appStateFromPath(window.location.pathname).page);
  const [filings,setFilings]  = useState([]);
  const [loading,setLoading]  = useState(true);
  const [error,setError]      = useState(null);
  const [selSignal,setSelSig] = useState(null);
  const [hlTicker,setHlTick]  = useState(null);
  const [detail,setDetail]    = useState(()=>appStateFromPath(window.location.pathname).detail);
  // Back-history for the Data/Dashboard right-hand detail panel — previously
  // non-existent, meaning clicking a second item while one was already open
  // silently discarded the first with no way back. Not a breadcrumb (per
  // design intent) — just enough history for a single "back" affordance to
  // step through, matching the pattern already used by Insights/Watchlist/
  // Portfolio's own drawers.
  const [detailStack,setDetailStack] = useState([]);
  // Deep-linked ticker/insider URLs open straight to the full drawer — no
  // reason to make a shared link require an extra click to reach the content
  // it's actually linking to. Organic clicks from Dashboard/Data (via
  // openDetail) start as the small preview instead — see the plan discussion
  // on why those two pages get a lighter-weight first step and Insights/
  // Watchlist (which have their own separate, untouched drawer triggers)
  // don't need this distinction at all.
  const [detailFull,setDetailFull] = useState(()=>!!appStateFromPath(window.location.pathname).detail);
  const [portfolioTickers, setPortfolioTickers] = useState([]);
  const [showUpgradeModal, setShowUpgradeModal] = useState(null); // null | 'default' | 'data_export' | 'portfolio' | 'notifications' | 'risk_management'
  const [showStaleDataModal, setShowStaleDataModal] = useState(false);

  // ── Client-side routing ────────────────────────────────────────────────────
  // Deliberately narrow scope: top-level pages + the global ticker/insider
  // detail panel only. Nested drawer/watchlist-internal navigation stays pure
  // component state — folding that in too would be scope creep for what this
  // was actually asked to solve (shareable links + SEO entry points).
  //
  // Sync is effect-based rather than wrapping every setPage/openDetail call
  // site — any code path that changes `page` or `detail` gets picked up
  // automatically, so nothing elsewhere in the file needs to change.
  useEffect(() => {
    // /terms and /privacy are handled by an early return above, entirely
    // outside the page/detail state model — appStateFromPath has no entry
    // for them, so it was defaulting to 'dashboard' on mount, and this
    // effect would then push that path over whatever was actually in the
    // address bar. That's the actual mechanism behind "loads /terms, then
    // reverts to the dashboard a moment later": the URL got silently
    // overwritten, and the early-return check above reads the URL fresh
    // on every render, so it stopped matching once that happened.
    if (['/terms','/privacy','/cookies','/help'].includes(window.location.pathname)) return;
    const path = pathFromAppState(page, detail);
    if (window.location.pathname !== path) {
      window.history.pushState({ page, detail }, '', path);
    }
    document.title = titleFromAppState(page, detail);
  }, [page, detail]);

  useEffect(() => {
    function onPopState() {
      // Browser already changed window.location for us (back/forward) —
      // just read it and update state to match. The sync effect above will
      // see the path already matches and won't push a redundant new entry.
      const { page: p, detail: d } = appStateFromPath(window.location.pathname);
      setPage(p);
      setDetail(d);
      setDetailFull(!!d);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // How far back the currently-loaded `filings` array actually covers.
  // null = as wide as this user's plan allows (server enforces the real
  // ceiling — free capped at 1yr, Pro unbounded — client doesn't need to
  // know which plan it is, it just asks and the server clamps correctly).
  const [filingsWindowDays, setFilingsWindowDays] = useState(90);

  // enterApp now triggers Clerk sign-in via SignInButton — kept for
  // compatibility with LandingPage's onEnter prop
  function enterApp() {}

  const load = useCallback(async(daysBack)=>{
    setLoading(true);setError(null);
    try{const d=await loadFilings(daysBack);setFilings(d);}
    catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{load(filingsWindowDays);},[]); // eslint-disable-line react-hooks/exhaustive-deps

  // Called by any component whose own time-range control lets a user pick
  // something wider than what's currently loaded (e.g. Explore drawer's
  // 90d/All, Watchlist's 90d). Only re-fetches if the request is actually
  // wider than what's already in memory — narrower selections just filter
  // the existing array client-side, same as before, no network call.
  function ensureFilingsWindow(daysBack) {
    const requestedWider = daysBack == null || (filingsWindowDays != null && daysBack > filingsWindowDays);
    if (!requestedWider) return;
    setFilingsWindowDays(daysBack);
    load(daysBack);
  }

  // Most recent FILING date in the loaded dataset — filing_date (when SEC
  // received/processed it, i.e. when we'd have ingested it), not
  // transaction_date. Those two routinely differ: insiders have up to ~2
  // business days to report a trade, so a filing ingested today can carry
  // a transaction_date from a day or two earlier. Prioritizing
  // transaction_date here (as this used to) meant the "Through" indicator
  // showed how recent the underlying trades were, not how fresh our own
  // data pull is — which is what this is actually supposed to communicate.
  const lastFilingDate = useMemo(()=>{
    if (!filings.length) return null;
    const today = new Date().toISOString().split('T')[0];
    const max = filings.reduce((best,f)=>{
      const d = f.date||f.transactionDate||'';
      return d>best?d:best;
    },'');
    // Clamp to today — future dates indicate a bad DB row (malformed XML date)
    // Run: SELECT MAX(transaction_date) FROM public.filings to find and fix it
    return max>today ? today : max;
  },[filings]);
  // Shared by both the subtle status-bar indicator and the more prominent
  // top banner below — one computation, not two copies of the same date
  // math that could quietly drift apart from each other.
  const daysSinceLastFiling = useMemo(() => {
    if (!lastFilingDate) return null;
    return Math.floor((new Date() - new Date(lastFilingDate + 'T12:00:00')) / (1000*60*60*24));
  }, [lastFilingDate]);
  const isDataStale = daysSinceLastFiling != null && daysSinceLastFiling >= 3;

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    (async () => {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      // Was previously POSTing to a route removed from the Worker when
      // SnapTrade replaced it — silently failed for every user this whole
      // time, meaning the Data page's "filter to my portfolio" toggle
      // never actually worked. Fixed to call the real, current endpoint.
      fetch(`${cfg.NEON_PROXY_URL}/snaptrade/positions`, { method: 'GET', headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d?.accounts) return; // 403 (not Pro) or 404 (no linked account) both land here — expected, not an error
          const tickers = new Set();
          for (const acct of d.accounts) {
            const positions = acct.positions;
            // Same defensive parsing as handlePortfolioTickersBatch on the
            // Worker side — SnapTrade's own response can be a bare array,
            // or an object wrapping one, depending on the endpoint version.
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
        .catch(()=>{}); // a real network failure here just leaves the filter showing no results, not a crash
    })();
  },[]);

  function drillSignal(s){setHlTick(s.ticker);setSelSig(s);setDetail({type:'signal',...s});setDetailStack([]);setDetailFull(true);setPage('signals');}
  function selectSignal(s){setSelSig(s);if(s)setHlTick(s.ticker);}
  function openDetail(d){
    // Push whatever was open before onto the stack — covers both "clicked a
    // link inside the currently-open detail" and "clicked a different item
    // from the list while one was already open." Both are real navigation a
    // person would want to step back out of, not just a silent replace.
    setDetailStack(prev => detail ? [...prev, detail] : prev);
    setDetail(d);
    setDetailFull(false);
  }
  function goBackDetail(){
    setDetailStack(prev=>{
      const next=[...prev];
      const p=next.pop();
      setDetail(p||null);
      return next;
    });
  }
  function expandDetail(){setDetailFull(true);}
  function closeDetail(){setDetail(null);setDetailStack([]);setDetailFull(false);setSelSig(null);}
  // cameFromHome powers the "Home › Section" breadcrumb bar on mobile —
  // any *other* way of reaching a page (bottom nav, a shared link, the
  // desktop sidebar) should not show a breadcrumb back to a Home the
  // person never actually came from, so plain navTo() always clears it.
  // Only seeAllFromHome (used by Home's own "See all →" links) sets it.
  const [cameFromHome, setCameFromHome] = useState(false);
  function navTo(p){setPage(p);setDetail(null);setDetailStack([]);setDetailFull(false);setSelSig(null);setHlTick(null);setCameFromHome(false);}
  function seeAllFromHome(p){setPage(p);setDetail(null);setDetailStack([]);setDetailFull(false);setSelSig(null);setHlTick(null);setCameFromHome(true);}

  // Sort state for the shared full-drawer explorer — independent from
  // InsightsPage's own internal sort state, since this instance is opened
  // from Dashboard/Data/anywhere-else and isn't nested inside InsightsPage.
  const [expSort, setExpSort] = useState('conviction');
  const [expDir,  setExpDir]  = useState(-1);
  function expOnSort(col){ if(expSort===col) setExpDir(d=>-d); else { setExpSort(col); setExpDir(-1); } }

  const panelOpen = !!detail;
  const watchlist = useWatchlist(user);

  // ── Landing page gate ──────────────────────────────────────────────────────
  // ── Simple client-side routing for legal pages ────────────────────────────
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path === '/terms') return <TermsPage />;
  if (path === '/privacy') return <PrivacyPage />;
  if (path === '/cookies') return <CookiePage />;
  if (path === '/help') return <HelpCenterPage />;

  // ── Loading state — show minimal spinner while Clerk initializes
  // Prevents the flash of landing page that appears for ~200ms on first load
  if (!isLoaded) return (
    <div style={{
      minHeight:'100vh', background:'var(--bg)',
      display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      <div className="spinner" style={{width:32,height:32}}/>
    </div>
  );

  if (showLanding || isAboutPath) return <LandingPage onEnter={enterApp} dark={dark} setDark={setDark} isLoaded={isLoaded}/>;

  return (
    <>
    {isDataStale && (
      <button className="stale-banner" onClick={() => setShowStaleDataModal(true)}>
        <IconWarning style={{width:14,height:14}}/>
        Live data isn't updating right now — tap for details
      </button>
    )}
    {showStaleDataModal && (
      <div className="modal-overlay" onClick={(e)=>{if(e.target===e.currentTarget)setShowStaleDataModal(false);}}>
        <div className="modal-panel stale-modal">
          <div className="modal-panel__hdr">
            <span className="modal-panel__title">Data isn't updating</span>
            <button className="modal-close" onClick={()=>setShowStaleDataModal(false)} title="Close (Esc)">
              <IconClose style={{width:12,height:12}}/>
            </button>
          </div>
          <div className="modal-body stale-modal__body">
            <p>Live filing data hasn't updated in a few days. We're aware and working on it — nothing you need to do on your end.</p>
            <p className="stale-modal__timestamp">
              Last new filing: <strong>{lastFilingDate ? fmt.dateShort(lastFilingDate) : 'unknown'}</strong>
              {daysSinceLastFiling != null && ` (${daysSinceLastFiling} day${daysSinceLastFiling===1?'':'s'} ago)`}
            </p>
          </div>
        </div>
      </div>
    )}
    <GuideProvider>
    <div className={`app-shell${panelOpen?' app-shell--panel-open':''}${page==='settings'?' app-shell--settings':''}`}>
      <Sidebar page={page} setPage={navTo} dark={dark} setDark={setDark} user={user} onUpgrade={(f)=>setShowUpgradeModal(f||'default')}/>
      <main className="main-area">
        <div className="status-bar">
          {/* Page title — left */}
          <span className="status-bar__info">
            {PAGE_TITLES[page] || 'Seli'}
            <span className="beta-tag beta-tag--status" title="Seli is in private beta">BETA</span>
          </span>
          <div className="status-bar__meta">
            {/* Data freshness */}
            {lastFilingDate&&(
              <span className={isDataStale?'status-bar__stale':''} title={isDataStale?`Data through ${lastFilingDate} — may be behind`:`Data current through ${lastFilingDate}`}>
                <span className="status-bar__dot" style={isDataStale?{background:'var(--amber-600)'}:{}}/>
                {isDataStale?<><IconWarning style={{width:11,height:11,marginRight:3,verticalAlign:"-1px"}}/>{`Data through ${fmt.dateShort(lastFilingDate)}`}</>:`Through ${fmt.dateShort(lastFilingDate)}`}
              </span>
            )}
            {!lastFilingDate&&<span title={loading?'Syncing…':'Ready'}><span className="status-bar__dot"/>{loading?'Syncing…':'Ready'}</span>}
            {/* Feedback — real destination (Worker endpoint, stored in a
                table), not a mailto link that's easy to lose track of.
                Placed alongside Guide since both are "get help / weigh
                in" actions. */}
            <FeedbackButton page={page}/>
            {/* Guide — reachable anytime, not just on first sign-in or via a
                tile's "?". Opens in-app rather than a new tab, since it's
                part of using the product, not a separate reference page. */}
            <GuideStatusBarButton/>
            {/* Theme toggle — moved here from the sidebar */}
            <button className="status-bar__icon-btn" onClick={()=>setDark(d=>!d)}
              title={dark?'Switch to light mode':'Switch to dark mode'}
              aria-label={dark?'Switch to light mode':'Switch to dark mode'}>
              {dark ? <IconSun style={{width:16,height:16}}/> : <IconMoon style={{width:16,height:16}}/>}
            </button>
            {/* Avatar — Clerk's own dropdown (manage account, sign out, etc).
                Settings/billing are reachable via the gear icon in the sidebar. */}
            <SignedIn>
              <UserButton
                afterSignOutUrl="/"
                appearance={{
                  elements: {
                    avatarBox:          'clerk-avatar',
                    userButtonTrigger:  'clerk-avatar-trigger',
                    userButtonAvatarBox:'clerk-avatar-box',
                  }
                }}
              />
            </SignedIn>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="auth-btn">Sign in</button>
              </SignInButton>
            </SignedOut>
          </div>
        </div>
        <div className="content-area">
          {cameFromHome && page !== 'home' && (
            // Mobile-only via CSS (see .home-breadcrumb) — a person who
            // reached this page any other way (bottom nav, a shared link)
            // never set cameFromHome, so this simply doesn't render for them.
            <button className="home-breadcrumb" onClick={()=>navTo('home')}>
              <span className="home-breadcrumb__arrow">←</span>
              Home <span className="home-breadcrumb__sep">›</span> {PAGE_TITLES[page]}
            </button>
          )}
          {page==='home'     &&<HomePage filings={filings} loading={loading} watchlist={watchlist} user={user}
            onOpenDetail={openDetail} onSeeAll={seeAllFromHome}/>}
          {page==='dashboard'&&<DashboardPage filings={filings} loading={loading} onDrillSignal={drillSignal} onOpenDetail={openDetail} watchlist={watchlist}/>}
          {page==='signals'  &&<InsightsPage   filings={filings} loading={loading}
            highlightTicker={hlTicker} setHighlightTicker={setHlTick}
            onSelectSignal={selectSignal} selectedSignal={selSignal}
            onOpenDetail={openDetail} onCloseDetail={closeDetail} user={user}
            ensureFilingsWindow={ensureFilingsWindow} watchlist={watchlist}/>}
          {page==='data'     &&<DataPage onOpenDetail={openDetail} portfolioTickers={portfolioTickers} user={user} onUpgrade={(f)=>setShowUpgradeModal(f||'data_export')}/>}
          {page==='settings'  &&<SettingsPage user={user} onUpgrade={(f)=>setShowUpgradeModal(f||'default')}/>}
          {page==='watchlist' &&<WatchlistPage filings={filings} loading={loading} onOpenDetail={openDetail} watchlist={watchlist} ensureFilingsWindow={ensureFilingsWindow}/>}
        </div>
        <footer className="footer">
          <span className="footer__center">Private Beta · Not financial advice.</span>
          <a href="/help" target="_blank" rel="noreferrer" className="footer__right">Help</a>
        </footer>
      </main>
      {watchlist.showUpgrade&&(
        <UpgradeModal feature={watchlist.showUpgrade} pro={isPro(user)} onClose={()=>watchlist.setShowUpgrade(null)}/>
      )}
      {showUpgradeModal&&(
        <UpgradeModal feature={showUpgradeModal} pro={isPro(user)} onClose={()=>setShowUpgradeModal(null)}/>
      )}
      {panelOpen&&!detailFull&&(
        <>
          <div className="panel-overlay" onClick={closeDetail}/>
          <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onExpand={expandDetail} onNavigate={openDetail} onBack={goBackDetail} canGoBack={detailStack.length>0} watchlist={watchlist}/>
        </>
      )}
      {panelOpen&&detailFull&&(
        detail?.dataFilters
          ? <DataDrawer
              initialDetail={detail}
              initialDetailStack={detailStack}
              filterState={detail.dataFilters}
              onClose={closeDetail}
              watchlist={watchlist}
              portfolioTickers={portfolioTickers}
            />
          : <InsightsDrawer
              type={detail?.type==='trader' ? 'insiders' : 'signals'}
              filings={filings}
              onClose={closeDetail}
              initialDetail={detail}
              initialDetailStack={detailStack}
              sigSort={expSort} sigDir={expDir} sigOnSort={expOnSort}
              ensureFilingsWindow={ensureFilingsWindow}
              filingsLoading={loading}
              watchlist={watchlist}
            />
      )}
    </div>
    </GuideProvider>
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
export default function App() {
  return (
    <Sentry.ErrorBoundary fallback={AppErrorFallback}>
      <AppInner/>
    </Sentry.ErrorBoundary>
  );
}

