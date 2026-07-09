import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useAuth, useUser, SignInButton, SignedIn, SignedOut, UserButton } from '@clerk/clerk-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
// src/app.jsx — Seli — insider trading intelligence platform
// const { useState, useEffect, useMemo, useCallback, useRef } = React;
import cfg from './config.js';
import { loadFilings, computeSignals, getSector, REL_LABELS } from './edgar.js';

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
function isPro(user) {
  if (!user) return false;
  return user.publicMetadata?.plan === 'pro';
}
function hasDataExport(user) {
  if (!user) return false;
  return user.publicMetadata?.hasDataExport === true;
}

// ─── Upgrade modal ────────────────────────────────────────────────────────────
// Shown when a free user tries to use a Pro feature.
// Comparison-table style, matching the reference layout's structure:
// logo, title, Free/Pro feature comparison, a plan selector, one CTA.
// Deliberately NOT including a fake testimonial/star-rating like the
// reference had — Seli doesn't have real customer reviews yet, and
// fabricating one would be dishonest. That visual slot is an honest
// trust line instead.
function UpgradeModal({ feature, onClose }) {
  useEffect(()=>{
    const h = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  },[onClose]);

  const [checkoutProduct, setCheckoutProduct] = useState(null); // null | 'pro' | 'data_export'
  const [plan, setPlan] = useState('pro'); // which card is selected in the picker
  const [statusModal, setStatusModal] = useState(null);

  const COMPARISON = [
    { label: 'Live dashboard & signals',  free: true,  pro: true },
    { label: 'Full historical data',      free: false, pro: true },
    { label: 'Portfolio linking',         free: false, pro: true },
    { label: 'Instant alerts',            free: false, pro: true },
    { label: 'CSV export',                free: false, pro: true },
  ];

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
        onSuccess={()=>{
          const wasPro = checkoutProduct === 'pro';
          setCheckoutProduct(null);
          setStatusModal(wasPro
            ? { title: "You're a Pro member!", message: 'Full historical data, portfolio linking, instant alerts, and CSV export are all unlocked now.' }
            : { title: 'Export unlocked', message: 'You can export the full database as CSV anytime from the Data page.' }
          );
        }}
      />
    );
  }

  return (
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay'))onClose();}}>
      <div className="upgrade-modal upgrade-modal--large">
        <button className="upgrade-modal__close" onClick={onClose} aria-label="Close"><IconClose style={{width:12,height:12}}/></button>

        <div className="logo-mark upgrade-modal__logo"><span style={{letterSpacing:'-1px',fontWeight:800}}>S</span></div>
        <div className="upgrade-modal__title">Upgrade to Pro</div>
        <div className="upgrade-modal__subtitle">Full insider data, real-time alerts, and your own portfolio — in one view.</div>

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
              <span className="upgrade-plan-card__price">$9.99</span>
            </span>
          </button>
        </div>

        <button className="upgrade-modal__cta" onClick={()=>setCheckoutProduct(plan)}>
          {plan==='pro' ? 'Upgrade Now — $11.99/mo' : 'Buy Export — $9.99'}
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
    features: ['Full historical data', 'Portfolio linking', 'Instant alerts', 'CSV export'],
  },
  data_export: {
    title: 'Buy full data export', price: '$9.99 one-time', endpoint: '/billing/create-data-purchase',
    subtitle: 'A one-time pull of everything currently in the database.',
    features: ['Every filing on record', 'Delivered as CSV', 'Re-purchase anytime for a fresh pull'],
  },
};

// ─── Confirm dialog — reusable "are you sure?" pattern ────────────────────────
function ConfirmModal({ title, message, confirmLabel='Confirm', cancelLabel='Never mind', danger=false, busy=false, onConfirm, onClose }) {
  return (
    <div className="upgrade-overlay" onClick={e=>{if(e.target.classList.contains('upgrade-overlay') && !busy)onClose();}}>
      <div className="upgrade-modal" style={{maxWidth:340}}>
        <div className="upgrade-modal__title">{title}</div>
        <p style={{fontSize:13,color:'var(--text-2)',lineHeight:1.5,margin:'8px 0 20px',textAlign:'left'}}>{message}</p>
        <div style={{display:'flex',gap:10}}>
          <button className="btn btn--ghost" style={{flex:1}} onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button className={danger?'settings-danger-btn':'upgrade-modal__cta'} style={{flex:1,margin:0}} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
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
        if (!res.ok) throw new Error(data.error || 'Could not start checkout');
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

          {!error && !clientSecret && (
            <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner/></div>
          )}

          {!error && clientSecret && (
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
      const fresh = await load();
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
      const fresh = await load();
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
            <div className="settings-row__sub">One-time pull of everything in the database — $9.99</div>
          </div>
          <button className="btn btn--primary" onClick={()=>setCheckoutProduct('data_export')}>
            {status.hasDataExport ? 'Buy again' : 'Buy →'}
          </button>
        </div>

        {/* Full purchase history, per the request — not just a yes/no flag. */}
        {dataExports.length > 0 && (
          <div className="settings-subsection settings-subsection--list">
            <div className="settings-subsection__heading">Export history</div>
            {dataExports.map((p, i) => (
              <div key={i} className="settings-export-row">
                <span>{new Date(p.purchased_at).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'})}</span>
                <span className="td-muted">${(p.amount_cents/100).toFixed(2)}</span>
              </div>
            ))}
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

      {statusModal && (
        <StatusModal
          title={statusModal.title}
          message={statusModal.message}
          onClose={()=>setStatusModal(null)}
        />
      )}

      {checkoutProduct && (
        <CheckoutModal
          product={checkoutProduct}
          onClose={()=>setCheckoutProduct(null)}
          onSuccess={()=>{
            const wasPro = checkoutProduct === 'pro';
            setCheckoutProduct(null);
            load();
            setStatusModal(wasPro
              ? { title: "You're a Pro member!", message: 'Full historical data, portfolio linking, instant alerts, and CSV export are all unlocked now.' }
              : { title: 'Export unlocked', message: 'You can export the full database as CSV anytime from the Data page.' }
            );
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
  const [showUpgrade, setShowUpgrade] = useState(false);

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
    if (!pro) { setShowUpgrade(true); return; }
    setTickers(prev => {
      const next = prev.includes(ticker) ? prev.filter(t=>t!==ticker) : [...prev, ticker];
      wlSet(next, WL_KEY);
      neonWatchlistMutate('ticker', ticker, prev.includes(ticker) ? 'remove' : 'add');
      return next;
    });
  }, [pro]);

  // Toggle insider
  const toggleInsider = useCallback((name) => {
    if (!pro) { setShowUpgrade(true); return; }
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
    // Default new visitors to dark — Seli's primary identity — unless
    // their system explicitly prefers light.
    return !window.matchMedia('(prefers-color-scheme: light)').matches;
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
function ConvictionBar({ score, max=15, showLabel=false }) {
  const pct = Math.min((score/max)*100, 100);
  const label = pct>66?'High':pct>33?'Medium':'Low';
  const color = pct>66?'var(--green-600)':pct>33?'var(--amber-600)':'var(--text-3)';
  // Only show label text when it's NOT High — color already communicates High,
  // but Low/Medium are warnings worth surfacing explicitly.
  const showText = showLabel && label !== 'High';
  return (
    <div className="conv-bar-wrap" title={`Conviction: ${label} (${score.toFixed(1)}/${max}) — combines exec participation, position size, and insider clustering`}>
      <div className="conv-bar-track">
        <div className="conv-bar-tick" style={{left:'33%'}}/>
        <div className="conv-bar-tick" style={{left:'66%'}}/>
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
function IconSun(p)       { return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>; }
function IconMoon(p)      { return <svg {...ICON_PROPS} {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>; }
function IconSignOut(p)   { return <svg {...ICON_PROPS} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>; }
function IconReversal(p)  { return <svg {...ICON_PROPS} {...p}><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>; }
function IconClose(p)     { return <svg {...ICON_PROPS} {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }
function IconCheck(p)      { return <svg {...ICON_PROPS} {...p}><polyline points="20 6 9 17 4 12"/></svg>; }
function IconWarning(p)    { return <svg {...ICON_PROPS} {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function IconBuyTri(p)     { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 4 21 19 3 19" fill="currentColor"/></svg>; }
function IconSellTri(p)    { return <svg viewBox="0 0 24 24" {...p}><polygon points="12 20 3 5 21 5" fill="currentColor"/></svg>; }
function IconFollowCircle(p){ return <svg {...ICON_PROPS} {...p}><circle cx="12" cy="12" r="9"/></svg>; }
function IconEmpty(p)      { return <svg {...ICON_PROPS} {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>; }
function IconMail(p)       { return <svg {...ICON_PROPS} {...p}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>; }
function IconZap(p)        { return <svg {...ICON_PROPS} {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>; }
function IconLink(p)       { return <svg {...ICON_PROPS} {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>; }

const NAV = [
  {id:'dashboard', Icon:IconHome,      label:'Dashboard'},
  {id:'signals',   Icon:IconInsights,  label:'Insights'},
  {id:'data',      Icon:IconData,      label:'Data'},
  {id:'watchlist', Icon:IconFavorites, label:'Watchlist'},
];
function Sidebar({ page, setPage, dark, setDark, user, onUpgrade }) {
  const pro = isPro(user);
  return (
    <nav className="sidebar sidebar--compact">
      {/* Logo */}
      <div className="sidebar__logo" title="Seli">
        <div className="logo-mark">
          <span style={{letterSpacing:'-1px',fontWeight:800}}>S</span>
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
        <div className="sidebar__footer-divider"/>
        {/* Settings — gear, separate from primary nav */}
        <button
          className={`nav-item nav-item--icon-only nav-item--sm${page==='settings'?' nav-item--active':''}`}
          onClick={()=>setPage('settings')}
          title="Settings"
          aria-label="Settings">
          <IconSettings className="nav-icon nav-icon--svg"/>
        </button>
        {/* Dark mode toggle */}
        <button className="nav-item nav-item--icon-only nav-item--sm"
          onClick={()=>setDark(d=>!d)}
          title={dark?'Switch to light mode':'Switch to dark mode'}
          aria-label={dark?'Switch to light mode':'Switch to dark mode'}>
          {dark
            ? <IconSun className="nav-icon nav-icon--svg sidebar__theme-icon"/>
            : <IconMoon className="nav-icon nav-icon--svg sidebar__theme-icon"/>}
        </button>
        <button className="nav-item nav-item--icon-only nav-item--sm nav-item--signout"
          onClick={()=>{ window.__clerkSignOut && window.__clerkSignOut(); }}
          title="Sign out"
          aria-label="Sign out">
          <IconSignOut className="nav-icon nav-icon--svg"/>
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
// ── Auth header helper ────────────────────────────────────────────────────────
// Phase 1: returns X-API-Key header using the key from config
// Phase 2: replace this function body with Clerk's getToken() call
// Everything else in the codebase calls this — nothing else needs to change
// when you upgrade from API key to JWT.
async function getAuthHeaders() {
  // Phase 2: Clerk JWT — registered by App once Clerk loads
  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) return { 'Authorization': `Bearer ${token}` };
    } catch {}
  }
  // Phase 1 fallback: API key
  if (cfg.WORKER_API_KEY) return { 'X-API-Key': cfg.WORKER_API_KEY };
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

function DetailPanel({ detail, filings, onClose, onNavigate, onBack, canGoBack, watchlist, inline=false, onExpand }) {
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
          <Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge>
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
              {isForeign&&<span style={{color:'var(--amber-600)'}}> <IconWarning style={{width:10,height:10,display:'inline',verticalAlign:'-1px'}}/></span>}
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
    <div className={expanded&&!inline?'detail-modal-overlay':undefined} onClick={expanded&&!inline?(e)=>{if(e.target===e.currentTarget)setExpanded(false);}:undefined}>
    <div className={inline?'detail-panel detail-panel--inline':expanded?'detail-panel detail-panel--modal':'detail-panel'}>
      <div className="detail-panel__header">
        {canGoBack&&<button className="btn btn--ghost btn--icon" onClick={onBack} title="Back">←</button>}
        <div style={{minWidth:0,flex:1}}>{header()}</div>
        {!inline&&onExpand&&<button className="btn btn--ghost btn--icon" onClick={onExpand} title="Open full Explore view">⤢</button>}
        {!inline&&<button className="btn btn--ghost btn--icon" onClick={()=>setExpanded(e=>!e)} title={expanded?'Collapse':'Enlarge'}>{expanded?'▣':'▢'}</button>}
        {!inline&&<button className="btn btn--ghost btn--icon" onClick={onClose}><IconClose style={{width:12,height:12}}/></button>}
        {inline&&canGoBack&&<button className="btn btn--ghost btn--icon" style={{fontSize:11}} onClick={onClose} title="Clear"><IconClose style={{width:12,height:12}}/></button>}
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
                      <svg viewBox="0 0 24 24" fill="currentColor" width="7" height="7" style={{marginRight:3,verticalAlign:'-0.5px'}}><circle cx="12" cy="12" r="10"/></svg>
                      {s.stillHolding?'Holding':'Closed'}
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
          <CompanyProfileCard ticker={d.ticker} cik={tickerRows?.[0]?.cik_issuer} company={d.company}/>
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
              <div className="dp-sum-item"><span className="dp-sum-label">Type</span><Badge type={tt==='buy'?'buy':tt==='sell'?'sell':'other'}>{tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆'}</Badge></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Value</span><span className="dp-sum-val">{fmt.money(t.value)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">Shares</span><span className="dp-sum-val">{fmt.number(t.shares)}</span></div>
              <div className="dp-sum-item"><span className="dp-sum-label">@ Price</span><span className="dp-sum-val">{fmt.price(pr)}{isForeign&&<span style={{color:'var(--amber-600)',fontSize:10}}> <IconWarning style={{width:9,height:9,display:'inline',verticalAlign:'-1px'}}/> verify (3x+ move)</span>}</span></div>
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
const INDEX_SYMS = ['SPY','QQQ','VIX','IWM'];

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
    const fn = sym => sym==='VIX'?'^VIX':sym;
    Promise.all(INDEX_SYMS.map(sym=>
      fetch(`https://finnhub.io/api/v1/quote?symbol=${fn(sym)}&token=${cfg.FINNHUB_API_KEY}`)
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
                <span className="mkt-stat__val">{sym==='VIX'?Number(d.price).toFixed(2):fmt.price(d.price)}</span>
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
        {Object.keys(sectors).length===0&&(
          <span className="td-muted" style={{marginLeft:'auto',fontSize:10}}>
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
    <div className="dash-inner-section">
      <div className="dash-inner-hdr">
        <span className="dash-inner-label">{title}</span>
        <span className="td-muted" style={{fontSize:10}}>{subtitle}</span>
        <div className="dash-sig-sort">
          {DASH_SORT_OPTS.map(o=>(
            <button key={o.key} className={`dash-sort-btn${sortKey===o.key?' dash-sort-btn--active':''}`} onClick={()=>tog(o.key)}>
              {o.label}{sortKey===o.key&&<span>{sortDir<0?'↓':'↑'}</span>}
            </button>
          ))}
        </div>
      </div>
      {loading ? <div style={{padding:'1rem',display:'flex',justifyContent:'center'}}><Spinner size={14}/></div>
      : sorted.length===0 ? <div className="dash-inner-empty">
          <div style={{fontWeight:500,marginBottom:4,color:'var(--text-2)'}}>No qualifying signals in this window</div>
          <div style={{fontSize:11,lineHeight:1.5}}>SEC Form 4s are typically filed 1–2 business days after the transaction. Weekend and holiday trades won't appear until Tuesday at the earliest. Try the 7d or 30d window for more data.</div>
        </div>
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

// Single shared fetch for the Alpaca portfolio, used by the unified
// PortfolioSection below (summary + filing cross-reference + scoped news all
// need the same position list, so we fetch once and pass it down).
function usePortfolio() {
  const [port, setPort] = useState(null);
  const [err,  setErr]  = useState(false);
  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    (async()=>{
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      fetch(`${cfg.NEON_PROXY_URL}/portfolio`, {
        method: 'POST', headers, body: JSON.stringify({}),
      }).then(r=>r.json()).then(d=>{if(!d.error)setPort(d);else setErr(true);}).catch(()=>setErr(true));
    })();
  },[]);
  return { port, err };
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
            <span className="ticker" style={{fontSize:10}}>{n._ticker}</span>
            <span className="td-muted" style={{fontSize:10}}>{n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}</span>
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
function PortfolioSection({ filings, cutoff, onOpenDetail }) {
  const { port, err } = usePortfolio();
  const posKey = (port?.positions||[]).map(p=>p.symbol).join(',');
  const posSymbols = useMemo(()=>(port?.positions||[]).map(p=>p.symbol),[posKey]);
  // Which held tickers have shown up in filings within the selected timespan —
  // explicitly surfaced as its own list per the request, not just a dot badge.
  // Must run on every render regardless of loading/error state below — hooks
  // can never be called conditionally or after an early return.
  const filingMatches = useMemo(()=>{
    const relevant = filings.filter(f=>f.ticker && posSymbols.includes(f.ticker) && (f.transactionDate||f.date||'')>=cutoff);
    const byTicker = {};
    for (const f of relevant) {
      if (!byTicker[f.ticker]) byTicker[f.ticker] = {ticker:f.ticker, buys:0, sells:0, insiders:new Set()};
      byTicker[f.ticker].insiders.add(f.insiderName);
      if (f.transactionType==='buy') byTicker[f.ticker].buys++;
      else if (f.transactionType==='sell') byTicker[f.ticker].sells++;
    }
    return Object.values(byTicker).map(t=>({...t, insiderCount:t.insiders.size}));
  },[filings,cutoff,posSymbols.join(',')]);

  if (err) return <div className="dp-placeholder" style={{padding:'1rem'}}><IconWarning style={{width:18,height:18}}/><p style={{fontSize:11}}>Portfolio linking isn't available right now.</p></div>;
  if (!port) return <div style={{padding:'1.5rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>;

  const acct=port.account||{};
  const pos=port.positions||[];
  const eq=parseFloat(acct.equity||0), leq=parseFloat(acct.last_equity||0);
  const dpl=eq-leq, dpct=leq>0?(dpl/leq)*100:0;

  const sigTickerSet = new Set(filingMatches.map(t=>t.ticker));

  return (
    <div className="port-section">
      {/* Balance hero */}
      <div className="port-balance">
        <div className="port-balance__eq">
          <span className="port-balance__val">{fmt.money(eq)}</span>
          <span className={`port-balance__chg ${dpl>=0?'val-buy':'val-sell'}`}>
            {dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)})
          </span>
        </div>
        <div className="port-balance__meta">
          <span className="port-balance__label">Total equity</span>
          <span className="port-balance__type">{cfg.ALPACA_LIVE?'Live':'Paper'}</span>
        </div>
      </div>

      {/* Positions */}
      <div className="port-block">
        <div className="port-block__label">Positions</div>
        {pos.length===0
          ? <div className="port-block__empty">No open positions</div>
          : <div className="port-pos-list">
              {[...pos].sort((a,b)=>Math.abs(parseFloat(b.market_value||0))-Math.abs(parseFloat(a.market_value||0))).map((p,i)=>{
                const upl=parseFloat(p.unrealized_pl||0);
                const tpl=parseFloat(p.unrealized_intraday_pl||0);
                const pct=parseFloat(p.unrealized_plpc||0)*100;
                const hasSig=sigTickerSet.has(p.symbol);
                return (
                  <div key={i} className={`port-pos-row${hasSig?' port-pos-row--signal':''}`} onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:p.symbol,company:''})}>
                    <div className="port-pos-row__left">
                      <span className="ticker" style={{fontSize:13}}>{p.symbol}</span>
                      {hasSig&&<span className="port-pos-signal-badge" title="Active insider signal">Signal ⬆</span>}
                    </div>
                    <div className="port-pos-row__right">
                      <span className="port-pos-row__mktval">{fmt.money(parseFloat(p.market_value||0))}</span>
                      <span className={`port-pos-row__pnl ${tpl>=0?'val-buy':'val-sell'}`}>{tpl>=0?'+':''}{fmt.money(tpl)}</span>
                      <span className={`port-pos-row__pct td-muted`}>({pct>=0?'+':''}{pct.toFixed(1)}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>}
      </div>

      {/* Holdings in recent filings */}
      {filingMatches.length>0&&(
        <div className="port-block">
          <div className="port-block__label">In recent filings</div>
          <div className="port-pos-list">
            {filingMatches.map(t=>(
              <div key={t.ticker} className="port-pos-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:t.ticker,company:''})}>
                <div className="port-pos-row__left">
                  <span className="ticker" style={{fontSize:13}}>{t.ticker}</span>
                  <span className="td-muted" style={{fontSize:11}}>{t.insiderCount} insider{t.insiderCount!==1?'s':''}</span>
                </div>
                <div className="port-pos-row__right">
                  {t.buys>0&&<span className="val-buy" style={{fontSize:12,fontWeight:600}}>{t.buys} buy{t.buys!==1?'s':''}</span>}
                  {t.sells>0&&<span className="val-sell" style={{fontSize:12,fontWeight:600}}>{t.sells} sell{t.sells!==1?'s':''}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Holdings news */}
      {posSymbols.length>0&&(
        <div className="port-block">
          <div className="port-block__label">Holdings news</div>
          <PortfolioTickerNews tickers={posSymbols}/>
        </div>
      )}
    </div>
  );
}

// Biggest movers — ranks tickers by absolute net $ flow across ALL sources
// (corporate + congressional combined), independent of the source-split
// tables above. This answers "what's moving the most" rather than "what's
// moving in each category," which the two source tables don't show on their own.
function BiggestMovers({ filings, cutoff, onOpenDetail }) {
  const movers = useMemo(()=>{
    const base = filings.filter(f=>f.isOpenMarket&&(f.transactionDate||f.date||'')>=cutoff);
    return buildSignals(base)
      .filter(s=>Math.abs(s.netValue)>=100_000)
      .sort((a,b)=>Math.abs(b.netValue)-Math.abs(a.netValue))
      .slice(0,10);
  },[filings,cutoff]);

  if (!movers.length) return <div className="dash-inner-empty">No significant movers in this window</div>;
  return (
    <div className="dash-inner-section">
      <div className="dash-inner-label">Biggest movers</div>
      <div className="dash-movers-list">
        {movers.map(s=>(
          <div key={s.ticker} className="dash-mover-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:s.ticker,company:s.company})}>
            <span className="ticker" style={{fontSize:12}}>{s.ticker}</span>
            <span className="td-muted dash-mover-row__sub">{s.insiderCount} insider{s.insiderCount!==1?'s':''}{s.isPolitical?' · Congress':''}</span>
            <span className={`td-mono dash-mover-row__val ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Broad market news — Finnhub's general news category, not scoped to any
// ticker. Distinct from DashNews/PortfolioNews below, which are intentionally
// ticker-scoped to signals and holdings respectively.
function MarketNews() {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(false);
  const hasKey = !!cfg.FINNHUB_API_KEY;
  useEffect(()=>{
    if (!hasKey) return;
    setLoading(true);
    fetch(`https://finnhub.io/api/v1/news?category=general&token=${cfg.FINNHUB_API_KEY}`)
      .then(r=>r.json())
      .then(a=>{ setNews((a||[]).filter(n=>n.headline&&n.url).slice(0,12)); setLoading(false); })
      .catch(()=>setLoading(false));
  },[hasKey]);
  if (!hasKey) return <div className="dp-placeholder" style={{padding:'1rem'}}><p style={{fontSize:11}}>No headlines available right now.</p></div>;
  if (loading) return <div style={{padding:'1.5rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>;
  if (!news.length) return <div style={{padding:'1rem',fontSize:12,color:'var(--text-3)'}}>No headlines available right now</div>;
  return (
    <div className="dash-news-list">
      {news.map((n,i)=>(
        <a key={i} className="dash-news-item" href={n.url} target="_blank" rel="noreferrer">
          <div className="dash-news-item__meta">
            <span className="td-muted" style={{fontSize:10}}>{n.source} · {fmt.ago(new Date(n.datetime*1000).toISOString().split('T')[0])}</span>
          </div>
          <div className="dash-news-item__headline">{n.headline}</div>
        </a>
      ))}
    </div>
  );
}

// Tabbed signals workspace — the primary daily research surface.
// Each tab gets full tile width so rows are actually readable, unlike
// the three-column cramped layout. Tabs: Corporate | Congressional | Movers.
function InsiderSignalsTabs({ corp, pol, filings, cutoff, loading, onRowClick, onOpenDetail }) {
  const [tab, setTab] = useState('corporate');
  const TABS = [
    { id:'corporate',    label:'Corporate',    count: corp.length },
    { id:'congressional',label:'Congressional', count: pol.length  },
    { id:'movers',       label:'Biggest movers' },
  ];
  return (
    <div className="sig-tabs-wrap">
      <div className="sig-tabs">
        {TABS.map(t=>(
          <button key={t.id} className={`sig-tab${tab===t.id?' sig-tab--active':''}`} onClick={()=>setTab(t.id)}>
            {t.label}
            {t.count!=null&&t.count>0&&<span className="sig-tab__count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="sig-tabs__body">
        {tab==='corporate'     && <DashSigTable signals={corp} loading={loading} title="Corporate" subtitle="C-suite · open market" onRowClick={onRowClick} onOpenDetail={onOpenDetail}/>}
        {tab==='congressional' && <DashSigTable signals={pol}  loading={loading} title="Congressional" subtitle="STOCK Act" onRowClick={onRowClick} onOpenDetail={onOpenDetail}/>}
        {tab==='movers'        && <BiggestMovers filings={filings} cutoff={cutoff} onOpenDetail={onOpenDetail}/>}
      </div>
    </div>
  );
}

function DashboardPage({ filings, loading, onDrillSignal, onOpenDetail, watchlist }) {
  const [days, setDays] = useState(7);
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);

  const signals = useMemo(()=>{
    const base = filings.filter(f=>
      f.isOpenMarket && f.transactionType==='buy' &&
      (f.transactionDate||f.date||'')>=cutoff
    );
    return buildSignals(base)
      .filter(s=>s.netValue>=100_000||s.cSuiteBuys>=1)
      .sort((a,b)=>b.conviction-a.conviction)
      .slice(0,30);
  },[filings,cutoff]);

  const bentoRef = React.useRef(null);
  useEffect(()=>{
    function measure(){
      if(!bentoRef.current)return;
      const top=bentoRef.current.getBoundingClientRect().top;
      bentoRef.current.style.setProperty('--dash-offset',`${top+16}px`);
    }
    measure();
    window.addEventListener('resize',measure);
    return()=>window.removeEventListener('resize',measure);
  },[]);

  return (
    <div className="page-content">
      <SentimentStrip filings={filings}/>

      <div className="dash-bento" ref={bentoRef}>

        {/* LEFT: Heatmap (top) + Signals (below, scrollable) */}
        <div className="dash-col-left">
          <div className="dash-tile dash-tile--heatmap">
            <HeatmapOnly/>
          </div>
          <div className="dash-tile dash-tile--signals">
            <div className="dash-tile__hdr">
              <span className="dash-tile__title">Insider signals</span>
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
                    <div key={s.ticker} className="dash-sig-item" onClick={()=>onOpenDetail&&onOpenDetail({type:'signal',...s})}>
                      <div className="dash-sig-item__left">
                        <div className="dash-sig-item__row1">
                          <span className="ticker" style={{fontSize:13,fontWeight:700}}>{s.ticker}</span>
                          {s.cSuiteBuys>0&&<span className="csuite-badge">{s.cSuiteBuys}×</span>}
                          {hasReversal&&<span className="reversal-badge" title="An insider on this ticker recently changed direction — previously buying, now selling (or vice versa). May signal a shift in insider sentiment."><IconReversal className="reversal-badge__icon"/>reversal</span>}
                          <StarBtn ticker={s.ticker} watchlist={watchlist}/>
                        </div>
                        <div className="dash-sig-item__row2">
                          <span style={{fontSize:11,color:'var(--text-2)'}}>{s.company}</span>
                          <span className="td-muted" style={{fontSize:10}}>{s.insiderCount} ins · {fmt.ago(s.lastTradeDate)}</span>
                        </div>
                      </div>
                      <div className="dash-sig-item__right">
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
              <span className="dash-tile__sub">by hit rate · 2yr</span>
            </div>
            <div className="dash-tile__body">
              <InsiderLeaderboardSidebar onOpenDetail={onOpenDetail} watchlist={watchlist}/>
            </div>
          </div>
          <div className="dash-tile dash-tile--news">
            <div className="dash-tile__hdr">
              <span className="dash-tile__title">Market news</span>
            </div>
            <div className="dash-tile__body">
              <MarketNews/>
            </div>
          </div>
        </div>

      </div>
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
  const [days, setDays] = useState(7);
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);
  const [sigSort, setSigSort] = useState('conviction');
  const [sigDir,  setSigDir]  = useState(-1);
  const [sourceF, setSourceF] = useState('');
  const [sectorF, setSectorF] = useState('');
  const [tab, setTab] = useState('research');
  const [minStrength, setMinStrength] = useState(1); // 1=any 2=medium+ 3=high only
  const [modal, setModal] = useState(null); // 'signals' | 'insiders' | null
  const [modalInitial, setModalInitial] = useState(null); // pre-selected item when opening
  const hlRef = useRef(null);

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
    const base = filings.filter(f=>{
      const tx = f.transactionDate||f.date||'';
      if (tx < cutoff) return false;
      const isPol = !!(f.transactionCode&&f.transactionCode.startsWith('CONGRESS'));
      if (sourceF==='corporate'&&isPol) return false;
      if (sourceF==='political'&&!isPol) return false;
      if (sectorF&&f.sector!==sectorF) return false;
      return true;
    });
    return buildSignals(base)
      .filter(s=>s.cSuiteBuys>=1||s.insiderCount>=2||s.netValue>=100_000)
      .filter(s=>s.conviction>=strengthThreshold)
      .sort((a,b)=>{
        const av=a[sigSort],bv=b[sigSort];
        if(typeof av==='number'){if(av<bv)return sigDir;if(av>bv)return -sigDir;}
        else{const r=String(av||'').localeCompare(String(bv||''));return sigDir>0?r:-r;}
        return 0;
      });
  },[filings,cutoff,sourceF,sectorF,sigSort,sigDir,strengthThreshold]);

  useEffect(()=>{
    if (highlightTicker&&hlRef.current)
      hlRef.current.scrollIntoView({behavior:'smooth',block:'center'});
  },[highlightTicker,signals]);

  function sigOnSort(col){if(sigSort===col)setSigDir(d=>-d);else{setSigSort(col);setSigDir(-1);}}
  function resetFilters(){setDays(7);setMinStrength(1);setSourceF('');setSectorF('');}
  const filtersAreDefault = days===7 && minStrength===1 && !sourceF && !sectorF;

  const [portModal, setPortModal] = useState(false);

  const colRef = useRef(null);
  useEffect(()=>{
    function measure(){
      if(!colRef.current)return;
      const top=colRef.current.getBoundingClientRect().top;
      colRef.current.style.setProperty('--ins-offset',`${top+16}px`);
    }
    measure();
    window.addEventListener('resize',measure);
    return()=>window.removeEventListener('resize',measure);
  },[]);

  return (
    <div className="page-content">
      {/* Portfolio bar — above everything, full width */}
      <InsightsPortfolioBar
        filings={filings} cutoff={cutoff} days={days}
        onOpenDetail={openInDrawer}
        onExpand={()=>{onCloseDetail&&onCloseDetail();setPortModal(true);}}
        watchlist={watchlist}
      />

      {/* Two-column body — signals | insiders */}
      <div className="ins-3col" ref={colRef}>

        {/* LEFT: Signals */}
        <div className="ins-sig-panel ins-3col__signals">
          <div className="ins-sig-panel__hdr ins-sig-panel__hdr--explorable">
            <button className="ins-panel-title-link" title="Open full Explore view" onClick={()=>{onCloseDetail&&onCloseDetail();setModal('signals');}}>
              Insider signals
              <span className="ins-explore-hint" aria-hidden="true">⤢</span>
            </button>
          </div>

          {/* Filters — belong to this panel specifically, not floating above
              both columns ambiguously. Each group gets its own labeled block
              with real spacing so they read as distinct controls. */}
          <div className="ins-filter-row">
            <div className="ins-filter-group">
              <span className="ins-filter-group__label">Window</span>
              <div className="dash-tile-pills">
                {[1,3,7,30,90].map(d=>(
                  <button key={d} className={`dash-tile-pill${days===d?' dash-tile-pill--active':''}`} onClick={()=>setDays(d)}>{d}d</button>
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
              <select className="ins-filter-select" value={sourceF} onChange={e=>setSourceF(e.target.value)}>
                <option value="">All types</option>
                <option value="corporate">Corporate only</option>
                <option value="political">Congressional only</option>
              </select>
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
                {minStrength>1?'Try lowering the strength filter or widening the timespan.':'Form 4s file 1–2 business days after trades. Try 7d or 30d.'}
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
                const tier=convPct>66?'high':convPct>33?'medium':'low';
                return (
                  <div key={s.ticker} ref={isHL?hlRef:null}
                    className={`ins-sig-row ins-sig-row--${tier}${isSel?' ins-sig-row--selected':''}`}
                    onClick={()=>{setHighlightTicker(s.ticker);onSelectSignal(s);openInDrawer({type:'signal',...s});}}>
                    <div className="ins-sig-row__left">
                      <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
                        <span className="ticker ins-sig-row__ticker">{s.ticker}</span>
                        {s.isPolitical&&<span className="badge badge--src-congress">Congress</span>}
                        {hasReversal&&<span className="reversal-badge" title="Insider recently changed direction — may signal shift in sentiment"><IconReversal className="reversal-badge__icon"/></span>}
                        <StarBtn ticker={s.ticker} watchlist={watchlist}/>
                      </div>
                      <div className="ins-sig-row__co">{s.company}</div>
                      {s.sector&&s.sector!=='Other'&&<div className="td-muted" style={{fontSize:10}}>{s.sector}</div>}
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
                  </div>
                );
              })}
            </div>}
          </div>
        </div>

        {/* MIDDLE: Top insiders leaderboard */}
        <div className="ins-lb-panel-wrap ins-3col__insiders">
          <div className="ins-sig-panel__hdr ins-sig-panel__hdr--explorable">
            <button className="ins-panel-title-link" title="Open full Explore view" onClick={()=>{onCloseDetail&&onCloseDetail();setModal('insiders');}}>
              Top insiders
              <span className="ins-explore-hint" aria-hidden="true">⤢</span>
            </button>
            <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· hit rate · 2yr</span>
          </div>
          <div className="ins-lb-panel__body">
            <InsiderLeaderboardSidebar onOpenDetail={openInDrawer} watchlist={watchlist}/>
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
      {portModal&&(
        <PortfolioDrawer
          filings={filings} cutoff={cutoff} days={days}
          onOpenDetail={onOpenDetail}
          onClose={()=>setPortModal(false)}
          watchlist={watchlist}
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
function InsightsDrawer({ type, filings, onClose, sigSort, sigDir, sigOnSort, initialDetail, ensureFilingsWindow, filingsLoading, watchlist, initialFilters }) {

  // ── left pane state ──────────────────────────────────────────────────────
  // Seeded from the tile's current selections when opened via "Explore full
  // view" or a row click, so filtering work already done on the tile isn't
  // silently discarded — falls back to these defaults when opened with no
  // tile context (e.g. a deep-linked ticker/insider URL).
  const [search, setSearch]   = useState('');
  const [lbRows, setLbRows]   = useState(null);
  const [lbSort, setLbSort]   = useState('hit_rate');
  const [lbDir,  setLbDir]    = useState(-1);
  const [srcF,   setSrcF]     = useState(initialFilters?.sourceF ?? '');
  const [secF,   setSecF]     = useState(initialFilters?.sectorF ?? '');
  const [minStr, setMinStr]   = useState(initialFilters?.minStrength ?? 1);
  const [daysBack, setDaysBack] = useState(initialFilters?.days ?? 30); // null = All time
  const [minValue, setMinValue] = useState(0);  // $ net value floor — tile has no equivalent to seed from

  // ── right pane nav stack ─────────────────────────────────────────────────
  // Each entry is a {type, ...props} detail object — same shape as DetailPanel's `detail` prop
  const [detailStack, setDetailStack] = useState([]); // history
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
      .filter(sig=>sig.cSuiteBuys>=1||sig.insiderCount>=2||sig.netValue>=100_000)
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
    queryNeon(LEADERBOARD_QUERY(200, null, 2))
      .then(r=>setLbRows(processLeaderboardRows(r)))
      .catch(()=>setLbRows([]));
  },[type]);

  const sortedLb = useMemo(()=>{
    if (!lbRows) return [];
    let rows = lbRows;
    if (search) { const q=search.toLowerCase(); rows=rows.filter(r=>r.insider_name.toLowerCase().includes(q)); }
    return [...rows].sort((a,b)=>{
      const av=a[lbSort]??-Infinity, bv=b[lbSort]??-Infinity;
      return lbDir>0?av-bv:bv-av;
    });
  },[lbRows,lbSort,lbDir,search]);
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
                <span className="drawer__filter-label">Sort by</span>
                <div className="dash-tile-pills" style={{gap:2}}>
                  {[['hit_rate','Hit rate'],['om_buys','Buys'],['bought_value','Bought']].map(([k,l])=>(
                    <button key={k} className={`dash-tile-pill${lbSort===k?' dash-tile-pill--active':''}`}
                      onClick={()=>lbOnSort(k)}>{l}{lbSort===k&&(lbDir<0?'↓':'↑')}</button>
                  ))}
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
                    const tier     = convPct>66?'high':convPct>33?'medium':'low';
                    return (
                      <div key={s.ticker}
                        data-row-key={s.ticker}
                        className={`drawer__list-row drawer__list-row--${tier}${isActive?' drawer__list-row--active':''}`}
                        onClick={()=>{ setDetail({type:'signal',...s}); setDetailStack([]); }}>
                        <div className="drawer__list-row__main">
                          <span className="ticker" style={{fontSize:12,fontWeight:700}}>{s.ticker}</span>
                          {s.cSuiteBuys>0&&<span className="csuite-badge" style={{fontSize:9}}>{s.cSuiteBuys}×</span>}
                          {s.isPolitical&&<span className="badge badge--src-congress" style={{fontSize:9}}>C</span>}
                          <span className="td-muted" style={{fontSize:10,flex:1}}>{s.company}</span>
                          <span className={`td-mono drawer__list-row__val ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
                        </div>
                        <div className="drawer__list-row__sub">
                          <ConvictionBar score={s.conviction}/>
                          <span className="td-muted" style={{fontSize:9,marginLeft:'auto'}}>{fmt.ago(s.lastTradeDate)}</span>
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
                            <span className="td-muted" style={{fontSize:10,width:18}}>{i+1}</span>
                            <span style={{fontSize:12,fontWeight:500,flex:1}}>{r.insider_name}</span>
                            {r.hit_rate!=null&&(
                              <span className={`td-mono ${r.hit_rate>=70?'val-buy':r.hit_rate<50?'val-sell':''}`} style={{fontSize:13,fontWeight:700}}>{r.hit_rate}%</span>
                            )}
                          </div>
                          <div className="drawer__list-row__sub">
                            <span className="td-muted" style={{fontSize:10}}>{r.insider_title||'Unknown'}</span>
                            <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{r.om_buys} buys · {fmt.money(r.bought_value)}</span>
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
function InsightsPortfolioBar({ filings, cutoff, days, onOpenDetail, onExpand, watchlist }) {
  const { port, err } = usePortfolio();

  const posKey = (port?.positions||[]).map(p=>p.symbol).join(',');
  const posSymbols = useMemo(()=>(port?.positions||[]).map(p=>p.symbol),[posKey]);

  const tickersOfInterest = useMemo(()=>{
    const all = new Set([...posSymbols,...watchlist.tickers]);
    return [...all];
  },[posKey,watchlist.tickers.join(',')]);

  const activeSignalTickers = useMemo(()=>{
    const relevant = filings.filter(f=>
      tickersOfInterest.includes(f.ticker) &&
      (f.transactionDate||f.date||'')>=cutoff &&
      f.isOpenMarket
    );
    return new Set(relevant.map(f=>f.ticker));
  },[filings,cutoff,tickersOfInterest.join(',')]);

  if (err || !cfg.NEON_PROXY_URL) return null;

  const acct = port?.account||{};
  const pos  = port?.positions||[];
  const eq   = parseFloat(acct.equity||0);
  const leq  = parseFloat(acct.last_equity||0);
  const dpl  = eq-leq, dpct = leq>0?(dpl/leq)*100:0;

  return (
    <div className="ins-port-bar">
      {/* Left: balance */}
      <div className="ins-port-bar__balance">
        <div className="ins-port-bar__label">Portfolio <span className="td-muted" style={{fontSize:10,fontWeight:400}}>{cfg.ALPACA_LIVE?'Live':'Paper'}</span></div>
        {!port
          ? <Spinner size={14}/>
          : <>
              <span className="ins-port-bar__val">{fmt.money(eq)}</span>
              <span className={`ins-port-bar__chg ${dpl>=0?'val-buy':'val-sell'}`}>{dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)})</span>
            </>
        }
      </div>
      <div className="ins-port-bar__divider"/>

      {/* Right: position chips — each is clickable */}
      <div className="ins-port-bar__chips">
        {!port
          ? <span className="td-muted" style={{fontSize:11}}>Loading positions…</span>
          : pos.length===0
            ? <span className="td-muted" style={{fontSize:11}}>No open positions — connect Alpaca to track holdings</span>
            : pos.sort((a,b)=>Math.abs(parseFloat(b.market_value||0))-Math.abs(parseFloat(a.market_value||0))).map((p,i)=>{
                const tpl=parseFloat(p.unrealized_intraday_pl||0);
                const pct=parseFloat(p.unrealized_plpc||0)*100;
                const hasActivity=activeSignalTickers.has(p.symbol);
                return (
                  <div key={i} className={`ins-port-chip${hasActivity?' ins-port-chip--active':''}`}
                    title={`${p.symbol} · ${fmt.money(parseFloat(p.market_value||0))} · ${pct>=0?'+':''}${pct.toFixed(1)}% today${hasActivity?' · Insider activity in this window':''}`}
                    onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:p.symbol,company:''})}>
                    <span className="ins-port-chip__ticker">{p.symbol}</span>
                    {hasActivity&&<span className="ins-port-chip__dot" title="Insider activity">●</span>}
                    <span className={`ins-port-chip__pnl ${tpl>=0?'val-buy':'val-sell'}`}>{tpl>=0?'+':''}{fmt.money(tpl)}</span>
                  </div>
                );
              })
        }
        {/* Watchlist tickers not in positions */}
        {watchlist.tickers.filter(t=>!posSymbols.includes(t)).map(t=>(
          <div key={t} className="ins-port-chip ins-port-chip--watch"
            title={`${t} · Watchlist${activeSignalTickers.has(t)?' · Insider activity in this window':''}`}
            onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:t,company:''})}>
            <span className="ins-port-chip__ticker">{t}</span>
            {activeSignalTickers.has(t)&&<span className="ins-port-chip__dot">●</span>}
            <span className="td-muted" style={{fontSize:10}}>★</span>
          </div>
        ))}
      </div>
      {onExpand&&(
        <button className="ins-expand-btn" onClick={onExpand} style={{margin:'0 14px',flexShrink:0}}>
          ⤢ Explore
        </button>
      )}
    </div>
  );
}

// ─── PortfolioDrawer ──────────────────────────────────────────────────────────
// Full portfolio deep-dive: left pane = positions + stats + insider activity tabs,
// right pane = DetailPanel inline for selected ticker + news.
function PortfolioDrawer({ filings, cutoff, days, onClose, watchlist }) {
  const { port } = usePortfolio();
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [detailStack, setDetailStack] = useState([]);
  const [tab, setTab] = useState('positions'); // 'positions' | 'activity' | 'news'

  const pos  = port?.positions || [];
  const acct = port?.account   || {};
  const eq   = parseFloat(acct.equity       || 0);
  const leq  = parseFloat(acct.last_equity  || 0);
  const bp   = parseFloat(acct.buying_power || 0);
  const dpl  = eq - leq;
  const dpct = leq > 0 ? (dpl / leq) * 100 : 0;

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
    Math.max(1, ...pos.map(p=>Math.abs(parseFloat(p.unrealized_pl||0))))
  , [pos]);

  return (
    <div className="drawer-overlay" onClick={e=>{if(e.target.classList.contains('drawer-overlay'))onClose();}}>
      <div className="drawer drawer--wide">

        {/* Header — account stats inline */}
        <div className="drawer__hdr">
          <span className="drawer__title">Portfolio</span>
          {port && <>
            <div className="port-ds"><span className="port-ds__label">Equity</span><span className="port-ds__val">{fmt.money(eq)}</span></div>
            <div className="port-ds"><span className="port-ds__label">Today</span><span className={`port-ds__val ${dpl>=0?'val-buy':'val-sell'}`}>{dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)})</span></div>
            <div className="port-ds"><span className="port-ds__label">Buying power</span><span className="port-ds__val">{fmt.money(bp)}</span></div>
            <span className="td-muted" style={{fontSize:10,padding:'0 4px'}}>{cfg.ALPACA_LIVE?'Live':'Paper'}</span>
          </>}
          <button className="modal-close" onClick={onClose} title="Close (Esc)" style={{marginLeft:'auto'}}><IconClose style={{width:12,height:12}}/></button>
        </div>

        <div className="drawer__body">

          {/* LEFT: tabs — Positions / Insider activity / News */}
          <div className="drawer__list">
            <div className="drawer__list-hdr">
              {[['positions','Positions'],['activity','Insider activity'],['news','News']].map(([id,l])=>(
                <button key={id}
                  className={`dash-tile-pill${tab===id?' dash-tile-pill--active':''}`}
                  style={{fontSize:10}} onClick={()=>setTab(id)}>{l}</button>
              ))}
            </div>

            {/* POSITIONS TAB */}
            {tab==='positions' && (
              !port
                ? <div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
                : pos.length===0
                  ? <div className="drawer__empty">No open positions.<br/>Connect Alpaca to track your holdings here.</div>
                  : [...pos]
                    .sort((a,b)=>Math.abs(parseFloat(b.market_value||0))-Math.abs(parseFloat(a.market_value||0)))
                    .map((p,i)=>{
                      const upl = parseFloat(p.unrealized_pl||0);
                      const tpl = parseFloat(p.unrealized_intraday_pl||0);
                      const mv  = parseFloat(p.market_value||0);
                      const qty = parseFloat(p.qty||p.shares||0);
                      const pct = parseFloat(p.unrealized_plpc||0)*100;
                      const barW = Math.min(Math.abs(upl)/maxAbs*100, 100);
                      const hasActivity = !!(activityByTicker[p.symbol]?.length);
                      const isActive = selected===p.symbol;
                      return (
                        <div key={i}
                          className={`drawer__list-row${isActive?' drawer__list-row--active':''}`}
                          onClick={()=>{ setSelected(p.symbol); setDetail({type:'ticker',ticker:p.symbol,company:''}); setDetailStack([]); }}>
                          <div className="drawer__list-row__main">
                            <span className="ticker" style={{fontSize:13,fontWeight:700}}>{p.symbol}</span>
                            {hasActivity&&<span className="reversal-badge" style={{fontSize:9}}>insider activity</span>}
                            <span className="td-muted" style={{fontSize:10,flex:1}}>{qty%1?qty.toFixed(2):qty} sh · {fmt.money(mv)}</span>
                            <span className={`td-mono ${upl>=0?'val-buy':'val-sell'}`} style={{fontSize:12,fontWeight:700}}>{upl>=0?'+':''}{fmt.money(upl)}</span>
                          </div>
                          {/* P&L bar */}
                          <div className="port-plbar-track">
                            <div className="port-plbar-fill" style={{width:`${barW}%`,background:upl>=0?'var(--green-600)':'var(--red-600)'}}/>
                          </div>
                          <div className="drawer__list-row__sub">
                            <span className="td-muted" style={{fontSize:10}}>total unrealized</span>
                            <span className={`td-mono ${tpl>=0?'val-buy':'val-sell'}`} style={{fontSize:10,marginLeft:'auto'}}>{tpl>=0?'+':''}{fmt.money(tpl)} today ({pct>=0?'+':''}{pct.toFixed(1)}%)</span>
                          </div>
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
                        <span className="td-muted" style={{fontSize:10,marginLeft:6}}>{trades.length} trade{trades.length!==1?'s':''}</span>
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
                            <span className="td-muted" style={{fontSize:10}}>{f.title||f.relationship||'Unknown'}</span>
                            <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{fmt.dateShort(f.transactionDate||f.date)}</span>
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

          {/* RIGHT: inline ticker detail panel */}
          <div className="drawer__detail">
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
function InsightsPortfolioPanel({ filings, cutoff, days, onOpenDetail, watchlist }) {
  const { port, err } = usePortfolio();

  const posKey = (port?.positions||[]).map(p=>p.symbol).join(',');
  const posSymbols = useMemo(()=>(port?.positions||[]).map(p=>p.symbol),[posKey]);

  // Recent filings that touch held OR watched tickers — this is the "tickers of interest" feed
  const tickersOfInterest = useMemo(()=>{
    const all = new Set([...posSymbols, ...watchlist.tickers]);
    return [...all];
  },[posKey, watchlist.tickers.join(',')]);

  const recentTrades = useMemo(()=>{
    if (!tickersOfInterest.length) return [];
    return filings
      .filter(f=>tickersOfInterest.includes(f.ticker) && (f.transactionDate||f.date||'')>=cutoff && f.isOpenMarket)
      .sort((a,b)=>((b.transactionDate||b.date||'')>(a.transactionDate||a.date||''))?1:-1)
      .slice(0,20);
  },[filings, cutoff, tickersOfInterest.join(',')]);

  if (err) return (
    <div className="ins-sig-panel">
      <div className="ins-sig-panel__hdr"><span className="ins-sig-panel__title">Your portfolio</span></div>
      <div className="ins-empty"><IconWarning style={{width:11,height:11,marginRight:3,verticalAlign:'-1px'}}/>Portfolio linking isn't available right now.</div>
    </div>
  );

  const acct = port?.account||{};
  const pos  = port?.positions||[];
  const eq   = parseFloat(acct.equity||0);
  const leq  = parseFloat(acct.last_equity||0);
  const dpl  = eq-leq, dpct = leq>0?(dpl/leq)*100:0;

  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>

      {/* Account summary */}
      <div className="ins-sig-panel">
        <div className="ins-sig-panel__hdr">
          <span className="ins-sig-panel__title">Portfolio</span>
          <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>{cfg.ALPACA_LIVE?'Live':'Paper'}</span>
        </div>
        {!port ? <div style={{padding:'12px 14px'}}><Spinner size={14}/></div>
        : <div>
            <div className="port-balance" style={{padding:'10px 14px',borderBottom:'0.5px solid var(--border)'}}>
              <div className="port-balance__eq">
                <span className="port-balance__val">{fmt.money(eq)}</span>
                <span className={`port-balance__chg ${dpl>=0?'val-buy':'val-sell'}`}>{dpl>=0?'+':''}{fmt.money(dpl)} ({fmt.pct(dpct)})</span>
              </div>
            </div>
            {pos.length===0
              ? <div className="ins-empty">No open positions</div>
              : <div>
                  {pos.slice(0,6).map((p,i)=>{
                    const tpl=parseFloat(p.unrealized_intraday_pl||0);
                    const pct=parseFloat(p.unrealized_plpc||0)*100;
                    const inFeed=tickersOfInterest.includes(p.symbol);
                    return (
                      <div key={i} className={`port-pos-row${inFeed?' port-pos-row--signal':''}`}
                        onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:p.symbol,company:''})}>
                        <div className="port-pos-row__left">
                          <span className="ticker" style={{fontSize:12}}>{p.symbol}</span>
                          {inFeed&&<span className="reversal-badge" style={{fontSize:9}}>insider activity</span>}
                        </div>
                        <div className="port-pos-row__right">
                          <span className="td-muted" style={{fontSize:11}}>{fmt.money(parseFloat(p.market_value||0))}</span>
                          <span className={`port-pos-row__pnl ${tpl>=0?'val-buy':'val-sell'}`}>{tpl>=0?'+':''}{fmt.money(tpl)}</span>
                          <span className="td-muted" style={{fontSize:10}}>({pct>=0?'+':''}{pct.toFixed(1)}%)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>}
          </div>}
      </div>

      {/* Recent trades on tickers of interest */}
      <div className="ins-sig-panel">
        <div className="ins-sig-panel__hdr">
          <span className="ins-sig-panel__title">Insider trades on your tickers</span>
          <span className="td-muted" style={{fontSize:10,marginLeft:'auto'}}>held + watchlist · last {days}d</span>
        </div>
        {tickersOfInterest.length===0
          ? <div className="ins-empty">Add tickers to your watchlist (☆) or connect Alpaca to see relevant trades here.</div>
          : recentTrades.length===0
            ? <div className="ins-empty">No open-market trades on your tickers in this window.</div>
            : <div>
                {recentTrades.map((f,i)=>(
                  <div key={i} className="wl-trade-row"
                    onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:f.ticker,company:f.company||''})}>
                    <span className="ticker" style={{fontSize:12}}>{f.ticker}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.insiderName}</div>
                      <div className="td-muted" style={{fontSize:10}}>{f.title||f.relationship}</div>
                    </div>
                    <Badge type={f.transactionType==='buy'?'buy':'sell'}>{f.transactionType==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>}</Badge>
                    <div style={{textAlign:'right',flexShrink:0}}>
                      <div className={`td-mono ${f.transactionType==='buy'?'val-buy':'val-sell'}`} style={{fontSize:12,fontWeight:600}}>{fmt.money(f.value)}</div>
                      <div className="td-muted" style={{fontSize:10}}>{fmt.dateShort(f.transactionDate||f.date)}</div>
                    </div>
                  </div>
                ))}
              </div>}
      </div>

      {/* Holdings news */}
      {posSymbols.length>0&&(
        <div className="ins-sig-panel">
          <div className="ins-sig-panel__hdr">
            <span className="ins-sig-panel__title">Holdings news</span>
          </div>
          <PortfolioTickerNews tickers={posSymbols}/>
        </div>
      )}
    </div>
  );
}

// ─── Portfolio filings panel ──────────────────────────────────────────────────
function PortfolioFilingsPanel({ filings, onOpenDetail }) {
  const { port } = usePortfolio();
  const cutoff30 = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-30);return d.toISOString().split('T')[0];},[]);
  const posSymbols = useMemo(()=>(port?.positions||[]).map(p=>p.symbol),[port?.positions?.length]);

  const matches = useMemo(()=>{
    if (!posSymbols.length) return [];
    const relevant = filings.filter(f=>posSymbols.includes(f.ticker)&&(f.transactionDate||f.date||'')>=cutoff30);
    const by = {};
    for(const f of relevant){
      if(!by[f.ticker]) by[f.ticker]={ticker:f.ticker,buys:0,sells:0,insiders:new Set(),value:0};
      by[f.ticker].insiders.add(f.insiderName);
      if(f.transactionType==='buy') by[f.ticker].buys++;
      else if(f.transactionType==='sell') by[f.ticker].sells++;
      by[f.ticker].value+=f.value||0;
    }
    return Object.values(by).map(t=>({...t,insiderCount:t.insiders.size}));
  },[filings,cutoff30,posSymbols.join(',')]);

  if (!port) return <div style={{padding:'16px',fontSize:12,color:'var(--text-3)'}}><Spinner size={14}/> Loading portfolio…</div>;
  if (!posSymbols.length) return <div className="ins-empty">No open positions — connect Alpaca to track holdings.</div>;
  if (!matches.length) return <div className="ins-empty">None of your holdings appeared in filings in the last 30 days.</div>;

  return (
    <div>
      {matches.map(t=>(
        <div key={t.ticker} className="port-pos-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'ticker',ticker:t.ticker,company:''})}>
          <div className="port-pos-row__left">
            <span className="ticker" style={{fontSize:13}}>{t.ticker}</span>
            <span className="td-muted" style={{fontSize:11}}>{t.insiderCount} insider{t.insiderCount!==1?'s':''}</span>
          </div>
          <div className="port-pos-row__right">
            {t.buys>0&&<span className="val-buy" style={{fontSize:12,fontWeight:600}}>{t.buys}B</span>}
            {t.sells>0&&<span className="val-sell" style={{fontSize:12,fontWeight:600,marginLeft:4}}>{t.sells}S</span>}
            <span className="td-muted" style={{fontSize:11,marginLeft:6}}>{fmt.money(t.value)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Active insiders — who has been most active in the selected window
function ActiveInsidersPanel({ filings, days, onOpenDetail }) {
  const cutoff = useMemo(()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];},[days]);

  const active = useMemo(()=>{
    const recent = filings.filter(f=>(f.transactionDate||f.date||'')>=cutoff&&f.isOpenMarket&&f.insiderName);
    const by = {};
    for(const f of recent){
      const k = f.insiderName;
      if(!by[k]) by[k]={name:k,title:f.insiderTitle||f.title,rel:f.relationship,tickers:new Set(),buyVal:0,sellVal:0,trades:0};
      by[k].tickers.add(f.ticker);
      by[k].trades++;
      if(f.transactionType==='buy') by[k].buyVal+=f.value||0;
      else by[k].sellVal+=f.value||0;
    }
    return Object.values(by)
      .map(r=>({...r,tickerCount:r.tickers.size,netVal:r.buyVal-r.sellVal}))
      .sort((a,b)=>Math.abs(b.netVal)-Math.abs(a.netVal))
      .slice(0,25);
  },[filings,cutoff]);

  if (!active.length) return <div className="ins-empty">No insider activity in this window. Try a wider timespan.</div>;

  return (
    <div className="ins-sig-panel">
      <div className="ins-sig-panel__hdr">
        <span className="ins-sig-panel__title">Active insiders <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· last {days}d · ranked by net flow</span></span>
      </div>
      <div className="ins-sig-list">
        {active.map((r,i)=>(
          <div key={r.name} className="ins-sig-row" style={{gridTemplateColumns:'1fr 1fr auto'}}
            onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:r.name,title:r.title})}>
            <div className="ins-sig-row__left">
              <span className="dp-clickable" style={{fontSize:13,fontWeight:500}}>{r.name}</span>
              <div style={{fontSize:11,color:'var(--text-3)'}}>{r.title||'Unknown title'}</div>
            </div>
            <div className="ins-sig-row__mid">
              <span className="td-muted" style={{fontSize:11}}>{r.tickerCount} ticker{r.tickerCount!==1?'s':''}</span>
              <span className="td-muted" style={{fontSize:11}}>{r.trades} trade{r.trades!==1?'s':''}</span>
            </div>
            <div className="ins-sig-row__right">
              <span className={`ins-sig-row__net ${r.netVal>=0?'val-buy':'val-sell'}`}>{r.netVal>=0?'+':''}{fmt.money(r.netVal)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Leaderboard sidebar ────────────────────────────────────────────────────────
function InsiderLeaderboardSidebar({ onOpenDetail, watchlist }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    queryNeon(LEADERBOARD_QUERY(20, null, 5))
      .then(r=>setRows(processLeaderboardRows(r)))
      .catch(e=>setError(e.message));
  },[]);

  return (
    <div className="ins-lb-list-wrap">
      {error?<div className="ins-empty"><IconWarning style={{width:11,height:11,marginRight:3,verticalAlign:"-1px"}}/>{error}</div>
      :rows===null?<div style={{padding:'2rem',display:'flex',justifyContent:'center'}}><Spinner size={16}/></div>
      :rows.length===0?<div className="ins-empty">Not enough data yet</div>
      :<div className="ins-lb-list">
        {rows.slice(0,15).map((r,i)=>(
          <div key={i} className="ins-lb-card" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:r.insider_name,title:r.insider_title})}>
            <div className="ins-lb-card__rank">{i+1}</div>
            <div className="ins-lb-card__body">
              <div style={{display:'flex',alignItems:'center',gap:6}}><div className="ins-lb-card__name dp-clickable">{r.insider_name}</div>{watchlist&&<FollowBtn name={r.insider_name} watchlist={watchlist}/>}</div>
              <div className="td-muted" style={{fontSize:10}}>{r.insider_title||'Unknown'}</div>
              <div className="ins-lb-card__meta">
                <Badge type={`rel-${r.relationship||'weak'}`}>{r.relationship==='strong'?'C-Suite':r.relationship==='medium'?'Officer':'Dir'}</Badge>
                <span className="td-muted" style={{fontSize:10}}>{r.om_buys} buys · {fmt.money(r.bought_value)}</span>
              </div>
            </div>
            <div className="ins-lb-card__score">
              {r.hit_rate!=null&&(
                <div className={`ins-lb-card__rate ${r.hit_rate>=70?'val-buy':r.hit_rate>=50?'':'val-sell'}`}>{r.hit_rate}%</div>
              )}
              <ConvictionBar score={r.proxy_score} max={4}/>
            </div>
          </div>
        ))}
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

function InsightsSectorChart({ filings, days }) {
  const [view, setView] = useState('market'); // 'market' | 'sec'
  const [mktData, setMktData] = useState(null);
  const [mktErr, setMktErr] = useState(false);

  useEffect(()=>{
    fetch('https://feargreedchart.com/api/?action=all')
      .then(r=>r.json())
      .then(d=>{
        // d.market is the correct key — {SYM: {price, chg, pct, closes}}
        if (!d?.market) return;
        const out = {};
        for (const [sym, item] of Object.entries(d.market)) {
          if (item) out[sym] = { ...item, symbol: sym };
        }
        setMktData(Object.keys(out).length ? out : null);
      })
      .catch(()=>setMktErr(true));
  },[]);

  // SEC net flow by sector from our own filings data
  const secFlow = useMemo(()=>{
    const cutoff = (()=>{const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().split('T')[0];})();
    const map = {};
    for (const f of filings) {
      const s = f.sector;
      if (!s||s==='Other') continue;
      if ((f.transactionDate||f.date||'')<cutoff) continue;
      if (!f.isOpenMarket) continue;
      if (!map[s]) map[s]={sector:s,buyVal:0,sellVal:0};
      if (f.transactionType==='buy') map[s].buyVal+=(f.value||0);
      else if (f.transactionType==='sell') map[s].sellVal+=(f.value||0);
    }
    return Object.values(map).map(s=>({...s,netVal:s.buyVal-s.sellVal}));
  },[filings,days]);

  const secHasMeaningfulData = secFlow.length>0 && secFlow.some(s=>Math.abs(s.netVal)>50_000);

  // Build squares data
  const squares = useMemo(()=>{
    if (view==='market') {
      return SECTOR_ETFS.map(e=>{
        const d = mktData?.[e.sym];
        const chg = d?.pct ?? d?.chg ?? null;
        // overlay SEC data if available
        const secSector = Object.entries(SEC_TO_ETF_LABEL).find(([,v])=>v===e.label)?.[0];
        const secD = secSector ? secFlow.find(s=>s.sector===secSector) : null;
        return {label:e.label, sym:e.sym, chg, secNet:secD?.netVal||null, loaded:!!mktData};
      });
    } else {
      // SEC view — only show sectors where we have data
      return secFlow
        .sort((a,b)=>Math.abs(b.netVal)-Math.abs(a.netVal))
        .map(s=>({label:SEC_TO_ETF_LABEL[s.sector]||s.sector, secNet:s.netVal, chg:null, loaded:true}));
    }
  },[view,mktData,secFlow]);

  const maxAbs = useMemo(()=>Math.max(1,...squares.map(s=>Math.abs(s.chg??0)).filter(Boolean)),[squares]);
  const maxSecAbs = useMemo(()=>Math.max(1,...squares.map(s=>Math.abs(s.secNet??0)).filter(Boolean)),[squares]);

  return (
    <div className="ins-sector-chart">
      <div className="ins-sector-chart__hdr">
        <span className="ins-sig-panel__title">Sector overview</span>
        <div className="ins-sector-toggle">
          <button className={`dash-tile-pill${view==='market'?' dash-tile-pill--active':''}`} onClick={()=>setView('market')}>Market ETFs</button>
          {secHasMeaningfulData&&<button className={`dash-tile-pill${view==='sec'?' dash-tile-pill--active':''}`} onClick={()=>setView('sec')}>Insider flow</button>}
          {!secHasMeaningfulData&&<span className="td-muted" style={{fontSize:11,padding:'0 8px'}}>Insider flow coverage limited — most filings unmapped to sectors</span>}
        </div>
      </div>
      <div className="ins-sector-squares">
        {squares.map((sq,i)=>{
          const intensity = view==='market'&&sq.chg!=null ? Math.min(Math.abs(sq.chg)/maxAbs, 1) : 0;
          const pos = view==='market' ? (sq.chg??0)>=0 : (sq.secNet??0)>=0;
          const secIntensity = sq.secNet!=null ? Math.min(Math.abs(sq.secNet)/maxSecAbs,1) : 0;
          const bgColor = view==='market'
            ? (sq.chg!=null ? (pos?`rgba(79,209,139,${0.15+intensity*0.5})`:`rgba(240,113,107,${0.15+intensity*0.5})`) : 'var(--surface-2)')
            : (sq.secNet!=null ? (pos?`rgba(79,209,139,${0.15+secIntensity*0.5})`:`rgba(240,113,107,${0.15+secIntensity*0.5})`) : 'var(--surface-2)');
          const mainVal = view==='market' ? sq.chg : sq.secNet;
          return (
            <div key={i} className="ins-sector-sq" style={{background:bgColor}}>
              <div className="ins-sector-sq__label">{sq.label}</div>
              {sq.sym&&<div className="td-muted" style={{fontSize:9}}>{sq.sym}</div>}
              {mainVal!=null&&(
                <div className={`ins-sector-sq__val ${mainVal>=0?'val-buy':'val-sell'}`}>
                  {view==='market'?`${mainVal>=0?'+':''}${mainVal.toFixed(1)}%`:`${mainVal>=0?'+':''}${fmt.money(mainVal)}`}
                </div>
              )}
              {(!sq.loaded)&&<div className="td-muted" style={{fontSize:10}}>…</div>}
              {view==='market'&&sq.secNet!=null&&(
                <div className={`ins-sector-sq__sec ${sq.secNet>=0?'val-buy':'val-sell'}`} title="Insider net flow">
                  {sq.secNet>=0?<IconBuyTri style={{width:9,height:9}}/>:<IconSellTri style={{width:9,height:9}}/>}{fmt.money(Math.abs(sq.secNet))} insiders
                </div>
              )}
            </div>
          );
        })}
      </div>
      {mktErr&&<div className="td-muted" style={{fontSize:11,padding:'8px 0'}}>Market ETF data unavailable — feargreedchart.com may be down.</div>}
    </div>
  );
}

// ─── Keep old environments for direct navigation (leaderboard + sector flow full pages)
// These are now only reached via the sidebar "full rankings" links, not primary nav


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
    <>
    <div className="snapshot-grid">
      <div className="snapshot-card">
        <div className="snapshot-card__hdr">
          <span className="snapshot-card__title">Top Signals <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· last 7d</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('signals')}>All signals →</button>
        </div>
        <div className="snapshot-card__context">Tickers with the most concentrated open-market buying by C-suite executives. Click any row to see who bought and how much.</div>
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
          <span className="snapshot-card__title">Top Insiders <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· ranked by hit rate</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('leaderboard')}>Full rankings →</button>
        </div>
        <div className="snapshot-card__context">Insiders with the highest % of open-market buys that gained since purchase — ranked over 2 years, minimum 5 trades.</div>
        {leaderPreview===null?<div style={{padding:'1rem'}}><Spinner size={16}/></div>
        :leaderPreview.length===0?<div className="snapshot-empty">Not enough data yet</div>
        :<div className="snapshot-list">
          {leaderPreview.map((l,i)=>(
            <div key={i} className="snapshot-row" onClick={()=>onOpenDetail&&onOpenDetail({type:'trader',name:l.insider_name,title:l.insider_title})}>
              <span className="snapshot-rank">{i+1}</span>
              <div style={{flex:1,minWidth:0}}>
                <div className="dp-clickable snapshot-row__name" style={{fontSize:12}}>{l.insider_name}</div>
                <div className="td-muted" style={{fontSize:10}}>{l.insider_title||'Unknown'}</div>
              </div>
              <div style={{textAlign:'right',flexShrink:0}}>
                {l.hit_rate!=null&&<div className={`td-mono ${l.hit_rate>=70?'val-buy':l.hit_rate>=50?'':'val-sell'}`} style={{fontSize:12,fontWeight:600}}>{l.hit_rate}%</div>}
                <div className="td-muted" style={{fontSize:10}}>{l.om_buys} buys</div>
              </div>
            </div>
          ))}
        </div>}
      </div>

      <div className="snapshot-card">
        <div className="snapshot-card__hdr">
          <span className="snapshot-card__title">Sector Flow <span className="td-muted" style={{fontWeight:400,fontSize:11}}>· last 30d</span></span>
          <button className="dp-nav-link" onClick={()=>onGoTo('sectorflow')}>Full breakdown →</button>
        </div>
        <div className="snapshot-card__context">Net insider buying vs selling by sector. Positive = insiders collectively buying; negative = net selling.</div>
        {sectorPreview===null?<div style={{padding:'1rem'}}><Spinner size={16}/></div>
        :sectorPreview.length===0?<div className="snapshot-empty">Not enough sector data yet — most tickers may be unmapped</div>
        :<div className="snapshot-list">
          {sectorPreview.map((s,i)=>(
            <div key={i} className="snapshot-row">
              <span style={{fontSize:12,flex:1}}>{s.sector}</span>
              <span className="td-muted" style={{fontSize:10,marginRight:8}}>{s.insider_count} insiders</span>
              <span className={`td-mono snapshot-sector-val ${s.net_value>=0?'val-buy':'val-sell'}`}>
                {s.net_value>=0?<IconBuyTri style={{width:9,height:9}}/>:<IconSellTri style={{width:9,height:9}}/>} {fmt.money(Math.abs(s.net_value))}
              </span>
            </div>
          ))}
        </div>}
      </div>
    </div>
    </>
  );
}

// ─── SIGNALS environment (existing table logic, now scoped as a sub-view) ─────

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

function DataPage({ onOpenDetail, portfolioTickers, user, onUpgrade }) {
  const pro = isPro(user);
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
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,gap:12}}>
        <p className="page-sub" style={{margin:0}}>
          {total!=null?`${total.toLocaleString()} filings matching filters · ${DATA_PAGE}/page`:'Loading…'}
          {!pro&&<span className="free-tier-inline"> · Free plan shows the last 12 months — <button className="free-tier-note__link" onClick={onUpgrade}>upgrade</button> for full history</span>}
        </p>
        <button className="btn btn--primary" onClick={pro ? doExport : onUpgrade} disabled={exporting}>
          {exporting
            ? (<><span className="spinner" style={{width:13,height:13,borderWidth:2,marginRight:6}}/>Exporting…</>)
            : pro
              ? '↓ Export CSV'
              : (<>Export CSV <span className="settings-pro-badge" style={{marginLeft:6}}>Pro</span></>)}
        </button>
      </div>

      <div className="data-toolbar">
        <div className="filter-bar filter-bar--wrap">
          <div className="search-wrap">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" placeholder="Ticker, insider, company… (Enter)"
              value={searchInput} onChange={e=>setSearchInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&setSearch(searchInput)}/>
          </div>
          <div className="date-pills">
            {DATA_DATE_PRESETS.map(p=>(
              <button key={p.l} className={`pill${dPreset===p.d&&!dateFrom?' pill--active':''}`}
                title={p.l==='All'&&!pro?'Free plan is still capped at the last 12 months — Pro unlocks true full history':undefined}
                onClick={()=>{setDPreset(p.d);setDateFrom('');setDateTo('');}}>
                {p.l}</button>
            ))}
          </div>
          <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setDPreset(null);}}/>
          <span style={{color:'var(--text-3)',fontSize:12}}>→</span>
          <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setDPreset(null);}}/>
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
                          {tt==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:tt==='sell'?<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>:'◆ Other'}
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
    return <div className="state-box"><IconEmpty style={{width:28,height:28,color:"var(--text-3)"}}/><p>No equity history available.</p></div>;
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

// Fills the dead space on a sparse/empty portfolio with something actually
// useful: recent strong insider-buy signals the person doesn't already hold,
// reusing buildSignals() rather than introducing a parallel computation.
function PortfolioSuggestions({ filings, ownedTickers, onOpenDetail }) {
  const owned = useMemo(()=>new Set((ownedTickers||[]).map(t=>(t||'').toUpperCase())),[ownedTickers]);
  const suggestions = useMemo(()=>{
    const cutoff = (()=>{const d=new Date();d.setDate(d.getDate()-14);return d.toISOString().split('T')[0];})();
    const base = filings.filter(f=>f.isOpenMarket&&f.transactionType==='buy'&&(f.transactionDate||f.date||'')>=cutoff);
    return buildSignals(base)
      .filter(s=>!owned.has((s.ticker||'').toUpperCase()) && (s.cSuiteBuys>=1||s.insiderCount>=2))
      .sort((a,b)=>b.conviction-a.conviction)
      .slice(0,5);
  },[filings,owned]);

  if (!suggestions.length) return null;
  return (
    <div className="port-suggest">
      <div className="port-suggest__hdr">
        <span className="port-suggest__title">Signals worth a look</span>
        <span className="td-muted" style={{fontSize:11}}>Based on recent insider conviction, not advice</span>
      </div>
      <div className="port-suggest__list">
        {suggestions.map(s=>(
          <div key={s.ticker} className="port-suggest__row" onClick={()=>onOpenDetail&&onOpenDetail({type:'signal',...s})}>
            <span className="ticker" style={{fontSize:13}}>{s.ticker}</span>
            <span className="td-muted" style={{fontSize:11,flex:1}}>{s.company}</span>
            <span className="td-muted" style={{fontSize:10.5}}>{s.insiderCount} insider{s.insiderCount!==1?'s':''}</span>
            <span className={`td-mono ${s.netValue>=0?'val-buy':'val-sell'}`} style={{fontSize:12,fontWeight:600}}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

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

  const watchedTickers  = watchlist.tickers;
  const watchedInsiders = watchlist.insiders || [];

  function navigate(d) { if (detail) setDetailStack(s=>[...s, detail]); setDetail(d); }
  function goBack() { setDetailStack(s=>{ const next=[...s]; const prev=next.pop(); setDetail(prev||null); return next; }); }
  function selectRow(d) { setDetailStack([]); setDetail(d); }
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
                return (
                  <div key={s.ticker} className={`ins-sig-row${isSel?' ins-sig-row--selected':''}`} style={{gridTemplateColumns:'1fr 100px 90px'}}
                    onClick={()=>selectRow({type:'ticker', ticker:s.ticker, company:s.company})}>
                    <div className="ins-sig-row__left">
                      <span className="ticker ins-sig-row__ticker">{s.ticker}</span>
                      <div className="ins-sig-row__co">{s.company}</div>
                    </div>
                    <ConvictionBar score={s.conviction}/>
                    <span className={`ins-sig-row__net ${s.netValue>=0?'val-buy':'val-sell'}`}>{s.netValue>=0?'+':''}{fmt.money(s.netValue)}</span>
                  </div>
                );
              }) : sortedInsiderRows.map(r=>{
                const isSel = detail?.type==='trader' && detail.name===r.name;
                return (
                  <div key={r.name} className={`ins-sig-row${isSel?' ins-sig-row--selected':''}`} style={{gridTemplateColumns:'1fr 70px 90px'}}
                    onClick={()=>selectRow({type:'trader', name:r.name, title:r.title})}>
                    <div className="ins-sig-row__left">
                      <span className="ins-sig-row__ticker" style={{fontSize:13}}>{r.name}</span>
                      {r.title&&<div className="ins-sig-row__co">{r.title}</div>}
                    </div>
                    <span className={`ins-sig-row__net ${r.netValue>=0?'val-buy':'val-sell'}`}>{r.trades} trade{r.trades!==1?'s':''}</span>
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
function PortfolioPage({ filings, onOpenDetail }) {
  const [data,    setData]    = useState(null);
  const [history, setHistory] = useState(null);
  const [orders,  setOrders]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [ptab,    setPtab]    = useState('positions');
  const isPaper = !(cfg && cfg.ALPACA_LIVE);

  async function load() {
    if (!cfg.NEON_PROXY_URL){setError('Unable to connect right now — try refreshing the page.');setLoading(false);return;}
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
        <IconWarning style={{width:20,height:20}}/><p>{error}</p>
        <p style={{fontSize:12,opacity:.7,marginTop:6}}>
          Portfolio linking isn't available right now — we're working on it.
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
          <div className="state-box"><IconEmpty style={{width:28,height:28,color:"var(--text-3)"}}/><p>No open positions.{isPaper?' Paper trading account.':''}</p></div>
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
      {ptab==='positions'&&pos.length<3&&filings&&filings.length>0&&(
        <PortfolioSuggestions filings={filings} ownedTickers={pos.map(p=>p.symbol)} onOpenDetail={onOpenDetail}/>
      )}
      {ptab==='history'&&<EquityCurve history={history}/>}
      {ptab==='orders'&&(
        !orders||orders.length===0?(
          <div className="state-box"><IconEmpty style={{width:28,height:28,color:"var(--text-3)"}}/><p>No recent orders.</p></div>
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
                    <td><Badge type={o.side==='buy'?'buy':'sell'}>{o.side==='buy'?<><IconBuyTri style={{width:8,height:8,marginRight:3}}/>Buy</>:<><IconSellTri style={{width:8,height:8,marginRight:3}}/>Sell</>}</Badge></td>
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

// ─── TERMS OF SERVICE ─────────────────────────────────────────────────────────
function TermsPage() {
  return (
    <div className="legal-page" data-theme="dark">
      <nav className="lp-nav">
        <a className="lp-nav__logo" href="/">
          <div className="lp-logo-mark">S</div>
          <span className="lp-wordmark">Seli</span>
        </a>
      </nav>
      <div className="legal-content">
        <h1>Terms of Service</h1>
        <p className="legal-date">Last updated: June 26, 2025</p>

        <h2>1. Acceptance of Terms</h2>
        <p>By accessing or using Seli ("the Service"), operated by Kevin Maresca ("we," "us," or "our"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>

        <h2>2. Description of Service</h2>
        <p>Seli is a financial intelligence platform that aggregates and displays publicly available SEC Form 4 insider trading disclosures, congressional trading disclosures filed under the STOCK Act, and related market data. All data displayed is sourced from public government databases including the SEC's EDGAR system.</p>

        <h2>3. Not Financial Advice</h2>
        <p>The information provided by Seli is for informational and educational purposes only. Nothing on this Service constitutes financial, investment, legal, or tax advice. We are not a registered investment advisor, broker-dealer, or financial planner. You should consult a qualified financial professional before making any investment decisions. Past insider trading patterns are not indicative of future results.</p>

        <h2>4. Data Accuracy</h2>
        <p>We make reasonable efforts to display accurate data sourced from public filings. However, we make no representations or warranties about the completeness, accuracy, or timeliness of the data. SEC filings may contain errors, and there may be delays between filing dates and our display of data. You assume all risk associated with your use of this information.</p>

        <h2>5. User Accounts</h2>
        <p>You must create an account to access certain features. You are responsible for maintaining the security of your account credentials. You agree to provide accurate information and to notify us immediately of any unauthorized use of your account.</p>

        <h2>6. Brokerage Connections</h2>
        <p>If you connect a brokerage account, you authorize us to retrieve read-only account data (positions, balances, and account information) on your behalf. We do not store your brokerage credentials. We do not execute trades on your behalf. You may disconnect your brokerage account at any time through your account settings.</p>

        <h2>7. Subscriptions and Billing</h2>
        <p>Certain features require a paid subscription. Subscriptions are billed monthly. You may cancel at any time; cancellation takes effect at the end of the current billing period. We reserve the right to change pricing with 30 days notice. Payments are processed by Stripe and subject to their terms of service.</p>

        <h2>8. Prohibited Uses</h2>
        <p>You may not: (a) use the Service for any unlawful purpose; (b) scrape, crawl, or otherwise systematically extract data from the Service; (c) resell or redistribute our data without written permission; (d) attempt to gain unauthorized access to any part of the Service; (e) use the Service to facilitate insider trading or securities fraud.</p>

        <h2>9. Intellectual Property</h2>
        <p>The Service, including its design, algorithms, and conviction scoring methodology, is the property of Kevin Maresca. The underlying SEC filing data is public domain. You may not copy, modify, or distribute our proprietary systems without permission.</p>

        <h2>10. Disclaimer of Warranties</h2>
        <p>The Service is provided "as is" without warranty of any kind. We disclaim all warranties, express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement.</p>

        <h2>11. Limitation of Liability</h2>
        <p>To the maximum extent permitted by law, Kevin Maresca shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service, including any investment losses.</p>

        <h2>12. Governing Law</h2>
        <p>These Terms are governed by the laws of the State of New Mexico, United States, without regard to conflict of law principles.</p>

        <h2>13. Changes to Terms</h2>
        <p>We may update these Terms at any time. Continued use of the Service after changes constitutes acceptance of the new Terms.</p>

        <h2>14. Contact</h2>
        <p>Questions about these Terms? Contact us at <a href="mailto:7withak@gmail.com">7withak@gmail.com</a>.</p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__logo">
          <div className="lp-logo-mark lp-logo-mark--sm">S</div>
          <span className="lp-wordmark">Seli</span>
        </div>
        <div className="lp-footer__links">
          <a href="/">Home</a>
          <span>·</span>
          <a href="/privacy" className="lp-footer__link-muted">Privacy Policy</a>
        </div>
      </footer>
    </div>
  );
}

// ─── PRIVACY POLICY ───────────────────────────────────────────────────────────
function PrivacyPage() {
  return (
    <div className="legal-page" data-theme="dark">
      <nav className="lp-nav">
        <a className="lp-nav__logo" href="/">
          <div className="lp-logo-mark">S</div>
          <span className="lp-wordmark">Seli</span>
        </a>
      </nav>
      <div className="legal-content">
        <h1>Privacy Policy</h1>
        <p className="legal-date">Last updated: June 26, 2025</p>

        <h2>1. Overview</h2>
        <p>Seli, operated by Kevin Maresca, is committed to protecting your privacy. This policy explains what information we collect, how we use it, and your rights regarding your data.</p>

        <h2>2. Information We Collect</h2>
        <h3>Account Information</h3>
        <p>When you create an account, we collect your email address and, if you sign in with Google, your Google profile name and profile picture. Authentication is handled by Clerk (clerk.com) — we do not store your password.</p>

        <h3>Watchlist Data</h3>
        <p>If you add tickers or insiders to your watchlist, we store those preferences in our database associated with your account identifier.</p>

        <h3>Brokerage Connection Data</h3>
        <p>If you connect a brokerage account, we store an encrypted access token in our database to retrieve your portfolio data. We store your position data temporarily for display purposes. We do not store your brokerage username or password.</p>

        <h3>Usage Data</h3>
        <p>We collect standard server logs including IP addresses, browser type, and pages visited for security and performance monitoring. We do not sell this data.</p>

        <h2>3. How We Use Your Information</h2>
        <p>We use your information to: (a) provide and improve the Service; (b) display your portfolio alongside relevant insider trading signals; (c) send transactional emails (account verification, password reset) through Clerk; (d) send alert emails if you subscribe to Pro notifications; (e) process payments through Stripe.</p>

        <h2>4. Data Sharing</h2>
        <p>We do not sell your personal data. We share data only with the following service providers who process it on our behalf:</p>
        <ul>
          <li><strong>Clerk</strong> (clerk.com) — authentication and user management</li>
          <li><strong>Stripe</strong> (stripe.com) — payment processing</li>
          <li><strong>Neon</strong> (neon.tech) — database hosting</li>
          <li><strong>Cloudflare</strong> (cloudflare.com) — hosting and security</li>
        </ul>

        <h2>5. Data Retention</h2>
        <p>We retain your account data for as long as your account is active. If you delete your account, we will delete your personal data within 30 days. Watchlist and broker connection data is deleted immediately upon disconnection or account deletion.</p>

        <h2>6. Security</h2>
        <p>We use industry-standard security measures including encrypted connections (HTTPS), encrypted storage of sensitive tokens (AES-256), and access controls. No system is 100% secure — you use the Service at your own risk.</p>

        <h2>7. Your Rights</h2>
        <p>You may: (a) access or export your data by contacting us; (b) delete your account and associated data at any time; (c) disconnect any brokerage connection at any time through account settings; (d) opt out of marketing emails at any time.</p>

        <h2>8. Cookies</h2>
        <p>We use only essential cookies required for authentication (managed by Clerk). We do not use advertising or tracking cookies.</p>

        <h2>9. Children's Privacy</h2>
        <p>The Service is not directed at children under 13. We do not knowingly collect personal information from children under 13.</p>

        <h2>10. Changes to This Policy</h2>
        <p>We may update this Privacy Policy periodically. We will notify you of material changes by email or through the Service.</p>

        <h2>11. Contact</h2>
        <p>Questions about this Privacy Policy? Contact us at <a href="mailto:7withak@gmail.com">7withak@gmail.com</a>.</p>
      </div>
      <footer className="lp-footer">
        <div className="lp-footer__logo">
          <div className="lp-logo-mark lp-logo-mark--sm">S</div>
          <span className="lp-wordmark">Seli</span>
        </div>
        <div className="lp-footer__links">
          <a href="/">Home</a>
          <span>·</span>
          <a href="/terms" className="lp-footer__link-muted">Terms of Service</a>
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

function SettingsPage({ user, onUpgrade }) {
  const pro   = isPro(user);
  const { prefs, saving, saved, error, save } = useNotificationPrefs(user?.id, pro);
  const [section, setSection] = useState('billing');
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
    {id:'billing',  label:'Billing',        icon:'$'},
    {id:'digests',  label:'Email digests',  Icon:IconMail},
    {id:'instant',  label:'Instant alerts', Icon:IconZap},
    {id:'brokers',  label:'Connections',    Icon:IconLink},
  ];

  return (
    <div className="settings-page">
      <div className="settings-layout">

        {/* ── Left sidebar nav ─────────────────────────────────────────── */}
        <div className="settings-sidenav">
          {SECTIONS.map(s=>(
            <button key={s.id}
              className={`settings-sidenav__item${section===s.id?' settings-sidenav__item--active':''}`}
              onClick={()=>setSection(s.id)}>
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

          {/* EMAIL DIGESTS */}
          {section==='digests'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Email digests
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Scheduled summaries delivered to your inbox. Choose your frequency and what to include.
                {!pro&&<button className="settings-section__lock" onClick={onUpgrade}> Upgrade to Pro to enable email digests.</button>}
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
                    sub="Highest-conviction buys from the selected window"
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

                {/* Conviction filter */}
                <div className={`settings-group${(!local.daily_digest&&!local.weekly_digest)||!pro?' settings-group--dimmed':''}`}>
                  <div className="settings-group__label">Minimum signal strength</div>
                  <div className="settings-group__desc">Only include signals above this conviction level</div>
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
                  {!pro&&<button className="settings-section__lock" onClick={onUpgrade}>Upgrade to Pro to save</button>}
                </div>
              </>)}
            </div>
          )}

          {/* INSTANT ALERTS */}
          {section==='instant'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Instant alerts
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Real-time emails fired within minutes of a filing. Each trigger is independent.
                {!pro&&<button className="settings-section__lock" onClick={onUpgrade}> Upgrade to Pro to enable instant alerts.</button>}
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
                    label="High conviction signal"
                    sub="C-suite buy at or above your threshold below — regardless of watchlist"
                    checked={local.instant_high_conviction}
                    onChange={e=>upd('instant_high_conviction', e.target.checked)}
                    pro={pro}
                  />
                  <div className="settings-row">
                    <div style={{flex:1}}>
                      <div className="settings-row__label">High conviction threshold</div>
                      <div className="settings-row__sub">Minimum single-trade size to count as high conviction</div>
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
                  {!pro&&<button className="settings-section__lock" onClick={onUpgrade}>Upgrade to Pro to save</button>}
                </div>
              </>)}
            </div>
          )}

          {/* CONNECTIONS */}
          {section==='brokers'&&(
            <div className="settings-section">
              <div className="settings-section__title">
                Brokerage connections
                {!pro&&<span className="settings-pro-badge" style={{marginLeft:10}}>Pro</span>}
              </div>
              <div className="settings-section__desc">
                Connect your brokerage to see insider activity on your holdings. Read-only — we never trade on your behalf.
                {!pro&&<button className="settings-section__lock" onClick={onUpgrade}> Upgrade to Pro to connect a brokerage.</button>}
              </div>

              {[
                {name:'Alpaca',               sub:'Commission-free trading · Paper + live accounts', note:'Pending OAuth approval'},
                {name:'Tradier',              sub:'Commission-free trading · Options support',        note:'Coming soon'},
                {name:'Interactive Brokers',  sub:'Professional-grade platform',                      note:'Coming soon'},
              ].map(b=>(
                <div key={b.name} className="settings-broker-card">
                  <div className="settings-broker-card__left">
                    <div className="settings-broker-card__name">{b.name}</div>
                    <div className="settings-broker-card__sub">{b.sub}</div>
                  </div>
                  <div className="settings-broker-card__right">
                    <span className="settings-broker-status settings-broker-status--disconnected">Not connected</span>
                    <button className="btn btn--ghost btn--sm" disabled title={b.note}>Connect</button>
                  </div>
                </div>
              ))}

              <p className="settings-section__note">
                OAuth approval from each brokerage is required before connections go live.
                Connections are read-only — positions and balances only, no trading access.
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
// Linear-inspired: stark, large type, single purpose per section.
// Stripe-inspired: structured nav, clear hierarchy, trust signals.
const FEATURES = [
  {icon:'01', title:'Real-time filings',        body:'Every SEC Form 4 ingested within minutes of publication — corporate C-suite trades and congressional STOCK Act disclosures. No delays, no manual lookups.'},
  {icon:'02', title:'Conviction scoring',        body:'Signals ranked by exec participation, position size change, and clustering. Cut through noise instantly — filter to High-conviction buys in one click.'},
  {icon:'03', title:'Portfolio overlay',         body:'Connect your brokerage. See exactly which insiders are trading stocks you own. Get alerted the moment a reversal hits your holdings.'},
  {icon:'04', title:'Corporate + congressional', body:'Track Form 4 filings from company insiders alongside STOCK Act disclosures from senators and representatives — in the same dashboard.'},
];

function LandingPage({ onEnter, dark, setDark }) {
  // Scroll-reveal: observe .reveal elements and add .reveal--visible when in viewport
  useEffect(()=>{
    const obs = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if(e.isIntersecting) { e.target.classList.add('reveal--visible'); obs.unobserve(e.target); }
      });
    },{ threshold:0.12, rootMargin:'0px 0px -40px 0px' });
    document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));
    return ()=>obs.disconnect();
  },[]);

  return (
    <div className="lp" data-theme={dark?'dark':'light'}>

      {/* Nav */}
      <nav className="lp-nav">
        <div className="lp-nav__logo">
          <div className="lp-logo-mark">ID</div>
          <span className="lp-wordmark">Seli</span>
        </div>
        <div className="lp-nav__links">
          <a href="#features" className="lp-nav__link">Features</a>
          <a href="#pricing"  className="lp-nav__link">Pricing</a>
          <a href="#about"    className="lp-nav__link">About</a>
        </div>
        <div className="lp-nav__actions">
          <button className="lp-btn-ghost" onClick={()=>setDark(d=>!d)} title="Toggle theme">
            {dark?<IconSun style={{width:15,height:15}}/>:<IconMoon style={{width:15,height:15}}/>}
          </button>
          <SignedOut>
            <SignInButton mode="modal">
              <button className="lp-btn-ghost">Log in</button>
            </SignInButton>
            <SignInButton mode="modal">
              <button className="lp-btn-primary">Open app →</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <button className="lp-btn-primary" onClick={onEnter}>Go to app →</button>
          </SignedIn>
        </div>
      </nav>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero__eyebrow reveal reveal--delay-0">
          <span className="lp-badge">Form 4 · STOCK Act · Real-time</span>
        </div>
        <h1 className="lp-hero__h1 reveal reveal--delay-1">
          Insider trading signals.<br/>
          <span className="lp-hero__h1-accent">Before the market moves.</span>
        </h1>
        <p className="lp-hero__sub reveal reveal--delay-2">
          Seli ingests every SEC Form 4 within minutes of publication,
          scores each signal by conviction, and surfaces the ones worth acting on.
          Built for serious retail investors.
        </p>
        <div className="lp-hero__cta reveal reveal--delay-3">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="lp-btn-primary lp-btn-primary--lg">Open Seli</button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <button className="lp-btn-primary lp-btn-primary--lg" onClick={onEnter}>Go to app →</button>
          </SignedIn>
          <span className="lp-hero__cta-note">Free during beta · No credit card</span>
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
                <div className="lp-screen-hdr">TOP INSIDERS <span style={{opacity:.4,fontWeight:400}}>· hit rate · 2yr</span></div>
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

      {/* Features */}
      <section className="lp-features" id="features">
        <div className="lp-section-label reveal">What's inside</div>
        <h2 className="lp-section-h2 reveal reveal--delay-1">The edge retail investors haven't had. Until now.</h2>
        <div className="lp-features-grid lp-features-grid--2col">
          {FEATURES.map((f,i)=>(
            <div key={f.title} className={`lp-feature-card reveal reveal--delay-${i%3}`}>
              <div className="lp-feature-icon">{f.icon}</div>
              <div className="lp-feature-title">{f.title}</div>
              <div className="lp-feature-body">{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="lp-pricing" id="pricing">
        <div className="lp-section-label reveal">Pricing</div>
        <h2 className="lp-section-h2 reveal reveal--delay-1">Simple, transparent pricing.</h2>

        {/* Main plans — two vertical cards */}
        <div className="lp-pricing-grid">
          <div className="lp-price-card reveal reveal--delay-1">
            <div className="lp-price-card__name">Free</div>
            <div className="lp-price-card__price">$0<span>/mo</span></div>
            <div className="lp-price-card__desc">Start tracking insider moves today. No card required.</div>
            <ul className="lp-price-card__features">
              {['Dashboard & sector heatmap','7-day signal window','Top insiders leaderboard','Corporate + congressional trades','Form 4 data table'].map(f=>(
                <li key={f}><span className="lp-check"><IconCheck style={{width:12,height:12}}/></span>{f}</li>
              ))}
            </ul>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-ghost lp-btn-ghost--full">Get started free →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-ghost lp-btn-ghost--full" onClick={onEnter}>Open app →</button>
            </SignedIn>
          </div>
          <div className="lp-price-card lp-price-card--featured reveal reveal--delay-2">
            <div className="lp-price-card__badge">Coming soon</div>
            <div className="lp-price-card__name">Pro</div>
            <div className="lp-price-card__price">$8<span>/mo</span></div>
            <div className="lp-price-card__desc">For investors who need to act before the market catches up.</div>
            <ul className="lp-price-card__features">
              {['Everything in Free','Full historical data (2021→present)','Email alerts — instant or digest','Custom alert filters (conviction, sector)','Portfolio reversal notifications','Brokerage connection (Alpaca, more)','CSV export','Deep-dive explorer'].map(f=>(
                <li key={f}><span className="lp-check"><IconCheck style={{width:12,height:12}}/></span>{f}</li>
              ))}
            </ul>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-btn-primary lp-btn-primary--full">Join waitlist →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-btn-primary lp-btn-primary--full" onClick={onEnter}>Join waitlist →</button>
            </SignedIn>
          </div>
        </div>

        {/* Data export — horizontal card, opt-out framing */}
        <div className="lp-data-export-card reveal reveal--delay-3">
          <div className="lp-data-export-card__left">
            <div className="lp-data-export-card__eyebrow">Don't need a subscription?</div>
            <div className="lp-data-export-card__title">Just download the data</div>
            <div className="lp-data-export-card__desc">
              The complete Form 4 dataset — every open-market insider trade from 2021 to present.
              Tickers, insiders, values, dates, roles, congressional trades. CSV, instant download.
            </div>
          </div>
          <div className="lp-data-export-card__right">
            <div className="lp-data-export-card__price">
              <span className="lp-data-export-card__amount">$9.99</span>
              <span className="lp-data-export-card__period">one-time</span>
            </div>
            <SignedOut>
              <SignInButton mode="modal">
                <button className="lp-data-export-card__btn">Download dataset →</button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <button className="lp-data-export-card__btn" onClick={onEnter}>Download dataset →</button>
            </SignedIn>
            <div className="lp-data-export-card__note">No subscription · Instant download</div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-footer__logo">
          <div className="lp-logo-mark lp-logo-mark--sm">S</div>
          <span className="lp-wordmark">Seli</span>
        </div>
        <div className="lp-footer__links">
          <a href="https://www.sec.gov" target="_blank" rel="noreferrer">SEC EDGAR</a>
          <span>·</span>
          <a href="/terms" className="lp-footer__link-muted">Terms</a>
          <span>·</span>
          <a href="/privacy" className="lp-footer__link-muted">Privacy</a>
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
            <button className="lp-btn-ghost" onClick={onEnter}>Open app →</button>
          </SignedIn>
        </div>
      </footer>

    </div>
  );
}


// ── Routing — URL <-> app state ─────────────────────────────────────────────
// External paths are deliberately friendlier than internal page ids
// (page id 'signals' -> path 'insights') so shared/indexed URLs read well
// without renaming the internal id everywhere it's already used.
const PAGE_TO_PATH = { dashboard:'', signals:'insights', data:'data', watchlist:'watchlist', settings:'settings' };
const PATH_TO_PAGE = { '':'dashboard', insights:'signals', data:'data', watchlist:'watchlist', settings:'settings' };

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
  const page = PATH_TO_PAGE[parts[0] || ''];
  return { page: page || 'dashboard', detail: null };
}

const PAGE_TITLES = { dashboard:'Dashboard', signals:'Insights', data:'Data', watchlist:'Watchlist', settings:'Settings' };

function titleFromAppState(page, detail) {
  if (detail?.type === 'ticker' && detail.ticker) {
    return `${detail.ticker}${detail.company ? ' — ' + detail.company : ''} — Insider Trading — Seli`;
  }
  if (detail?.type === 'trader' && detail.name) {
    return `${detail.name} — Insider Trading Activity — Seli`;
  }
  return `${PAGE_TITLES[page] || 'Dashboard'} — Seli`;
}

export default function App() {
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

  const [page,setPage] = useState(()=>appStateFromPath(window.location.pathname).page);
  const [filings,setFilings]  = useState([]);
  const [loading,setLoading]  = useState(true);
  const [error,setError]      = useState(null);
  const [selSignal,setSelSig] = useState(null);
  const [hlTicker,setHlTick]  = useState(null);
  const [detail,setDetail]    = useState(()=>appStateFromPath(window.location.pathname).detail);
  // Deep-linked ticker/insider URLs open straight to the full drawer — no
  // reason to make a shared link require an extra click to reach the content
  // it's actually linking to. Organic clicks from Dashboard/Data (via
  // openDetail) start as the small preview instead — see the plan discussion
  // on why those two pages get a lighter-weight first step and Insights/
  // Watchlist (which have their own separate, untouched drawer triggers)
  // don't need this distinction at all.
  const [detailFull,setDetailFull] = useState(()=>!!appStateFromPath(window.location.pathname).detail);
  const [portfolioTickers, setPortfolioTickers] = useState([]);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

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

  // Most recent filing date in the loaded dataset — shown in status bar so
  // users know immediately whether the data is fresh (especially on Monday mornings
  // after a weekend gap where new filings may not have been ingested yet).
  const lastFilingDate = useMemo(()=>{
    if (!filings.length) return null;
    const today = new Date().toISOString().split('T')[0];
    const max = filings.reduce((best,f)=>{
      const d = f.transactionDate||f.date||'';
      return d>best?d:best;
    },'');
    // Clamp to today — future dates indicate a bad DB row (malformed XML date)
    // Run: SELECT MAX(transaction_date) FROM public.filings to find and fix it
    return max>today ? today : max;
  },[filings]);

  useEffect(()=>{
    if (!cfg.NEON_PROXY_URL) return;
    (async () => {
      const headers = { 'Content-Type': 'application/json', ...await getAuthHeaders() };
      fetch(`${cfg.NEON_PROXY_URL}/portfolio`, {
        method: 'POST', headers, body: JSON.stringify({}),
      }).then(r=>r.json()).then(d=>{if(!d.error&&d.positions)setPortfolioTickers(d.positions.map(p=>p.symbol).filter(Boolean));}).catch(()=>{});
    })();
  },[]);

  function drillSignal(s){setHlTick(s.ticker);setSelSig(s);setDetail({type:'signal',...s});setDetailFull(true);setPage('signals');}
  function selectSignal(s){setSelSig(s);if(s)setHlTick(s.ticker);}
  function openDetail(d){setDetail(d);setDetailFull(false);}
  function expandDetail(){setDetailFull(true);}
  function closeDetail(){setDetail(null);setDetailFull(false);setSelSig(null);}
  function navTo(p){setPage(p);setDetail(null);setDetailFull(false);setSelSig(null);setHlTick(null);}

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
  const path = window.location.pathname;
  if (path === '/terms') return <TermsPage />;
  if (path === '/privacy') return <PrivacyPage />;

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

  if (showLanding) return <LandingPage onEnter={enterApp} dark={dark} setDark={setDark} isLoaded={isLoaded}/>;

  return (
    <div className={`app-shell${panelOpen?' app-shell--panel-open':''}`}>
      <Sidebar page={page} setPage={navTo} dark={dark} setDark={setDark} user={user} onUpgrade={()=>setShowUpgradeModal(true)}/>
      <main className="main-area">
        <div className="status-bar">
          {/* Page title — left */}
          <span className="status-bar__info">
            {page==='settings'?'Settings':NAV.find(n=>n.id===page)?.label||'Seli'}
          </span>
          <div className="status-bar__meta">
            {/* Data freshness */}
            {lastFilingDate&&(()=>{
              const daysSince = Math.floor((new Date()-new Date(lastFilingDate+'T12:00:00'))/(1000*60*60*24));
              const stale = daysSince>=3;
              return (
                <span className={stale?'status-bar__stale':''} title={stale?`Data through ${lastFilingDate} — may be behind`:`Data current through ${lastFilingDate}`}>
                  <span className="status-bar__dot" style={stale?{background:'var(--amber-600)'}:{}}/>
                  {stale?<><IconWarning style={{width:11,height:11,marginRight:3,verticalAlign:"-1px"}}/>{`Data through ${fmt.dateShort(lastFilingDate)}`}</>:`Through ${fmt.dateShort(lastFilingDate)}`}
                </span>
              );
            })()}
            {!lastFilingDate&&<span><span className="status-bar__dot"/>{loading?'Syncing…':'Ready'}</span>}
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
          {page==='dashboard'&&<DashboardPage filings={filings} loading={loading} onDrillSignal={drillSignal} onOpenDetail={openDetail} watchlist={watchlist}/>}
          {page==='signals'  &&<InsightsPage   filings={filings} loading={loading}
            highlightTicker={hlTicker} setHighlightTicker={setHlTick}
            onSelectSignal={selectSignal} selectedSignal={selSignal}
            onOpenDetail={openDetail} onCloseDetail={closeDetail} user={user}
            ensureFilingsWindow={ensureFilingsWindow} watchlist={watchlist}/>}
          {page==='data'     &&<DataPage onOpenDetail={openDetail} portfolioTickers={portfolioTickers} user={user} onUpgrade={()=>setShowUpgradeModal(true)}/>}
          {page==='settings'  &&<SettingsPage user={user} onUpgrade={()=>setShowUpgradeModal(true)}/>}
          {page==='watchlist' &&<WatchlistPage filings={filings} loading={loading} onOpenDetail={openDetail} watchlist={watchlist} ensureFilingsWindow={ensureFilingsWindow}/>}
        </div>
        <footer className="footer">
          <a href="https://www.sec.gov" target="_blank" rel="noreferrer">SEC EDGAR</a>
          {' · '}
          <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
          {' · '}
          <a href="/privacy" target="_blank" rel="noreferrer">Privacy</a>
          {' · '}Not financial advice.
        </footer>
      </main>
      {watchlist.showUpgrade&&(
        <UpgradeModal feature="watchlist" onClose={()=>watchlist.setShowUpgrade(false)}/>
      )}
      {showUpgradeModal&&(
        <UpgradeModal feature="default" onClose={()=>setShowUpgradeModal(false)}/>
      )}
      {panelOpen&&!detailFull&&(
        <>
          <div className="panel-overlay" onClick={closeDetail}/>
          <DetailPanel detail={detail} filings={filings} onClose={closeDetail} onExpand={expandDetail} onNavigate={openDetail} watchlist={watchlist}/>
        </>
      )}
      {panelOpen&&detailFull&&(
        <InsightsDrawer
          type={detail?.type==='trader' ? 'insiders' : 'signals'}
          filings={filings}
          onClose={closeDetail}
          initialDetail={detail}
          sigSort={expSort} sigDir={expDir} sigOnSort={expOnSort}
          ensureFilingsWindow={ensureFilingsWindow}
          filingsLoading={loading}
          watchlist={watchlist}
        />
      )}
    </div>
  );
}

