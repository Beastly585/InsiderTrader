// src/components/ui.jsx — small building blocks for the research pages.
import React, { useEffect, useState } from 'react';

// True below a width, kept in sync as the window resizes. Tables use it to
// switch to stacked rows on phones instead of squeezing columns.
export function useNarrow(px = 640) {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

export function Card({ title, sub, action, children, className = '', id, pad = true }) {
  return (
    <section className={`sx-card ${className}`} id={id}>
      {(title || action) && (
        <header className="sx-card__hdr">
          <div className="sx-card__titles">
            {title && <h2 className="sx-card__title">{title}</h2>}
            {sub && <p className="sx-card__sub">{sub}</p>}
          </div>
          {action && <div className="sx-card__action">{action}</div>}
        </header>
      )}
      <div className={pad ? 'sx-card__body' : ''}>{children}</div>
    </section>
  );
}

export function Chip({ tone = 'neutral', children, title }) {
  return <span className={`sx-chip sx-chip--${tone}`} title={title}>{children}</span>;
}

export function TypeBadge({ type, om = true }) {
  if (type === 'buy') return <span className={`sx-type sx-type--buy${om ? '' : ' sx-type--muted'}`}>{om ? 'Buy' : 'Acquired'}</span>;
  if (type === 'sell') return <span className={`sx-type sx-type--sell${om ? '' : ' sx-type--muted'}`}>{om ? 'Sell' : 'Disposed'}</span>;
  return <span className="sx-type">{type}</span>;
}

export function Segmented({ options, value, onChange, size }) {
  return (
    <div className={`sx-seg${size === 'sm' ? ' sx-seg--sm' : ''}`} role="tablist">
      {options.map(o => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className={`sx-seg__btn${value === o.value ? ' sx-seg__btn--on' : ''}`}
          onClick={() => onChange(o.value)}>
          {o.label}{o.count != null && <span className="sx-seg__count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="sx-empty">
      {title && <div className="sx-empty__title">{title}</div>}
      {children && <div className="sx-empty__body">{children}</div>}
      {action && <div className="sx-empty__action">{action}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3, height = 14 }) {
  return (
    <div className="sx-skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="sx-skel__line" style={{ height, width: `${90 - (i % 3) * 18}%` }} />)}
    </div>
  );
}

export function ErrorNote({ message, onRetry }) {
  return (
    <div className="sx-error" role="alert">
      <span>{message || 'Something went wrong loading this.'}</span>
      {onRetry && <button className="sx-btn sx-btn--ghost sx-btn--sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

// The single upsell pattern: shown only where someone actually hits a limit.
export function Gate({ children, cta = 'See Pro', onUpgrade, feature = 'full_history' }) {
  return (
    <div className="sx-gate">
      <span className="sx-gate__text">{children}</span>
      <button className="sx-btn sx-btn--accent sx-btn--sm" onClick={() => onUpgrade?.(feature)}>{cta}</button>
    </div>
  );
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="sx-stat">
      <div className="sx-stat__label">{label}</div>
      <div className={`sx-stat__value${tone ? ` sx-stat__value--${tone}` : ''}`}>{value}</div>
      {sub && <div className="sx-stat__sub">{sub}</div>}
    </div>
  );
}

export function Icon({ name, size = 16, ...rest }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...rest };
  switch (name) {
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case 'bell': return <svg {...p}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>;
    case 'bell-off': return <svg {...p}><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M18.63 13A17.9 17.9 0 0 1 18 8" /><path d="M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;
    case 'plus': return <svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'check': return <svg {...p}><polyline points="20 6 9 17 4 12" /></svg>;
    case 'x': return <svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case 'external': return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>;
    case 'chevron': return <svg {...p}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'arrow': return <svg {...p}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>;
    case 'user': return <svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>;
    case 'building': return <svg {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 21v-4h6v4M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01" /></svg>;
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>;
    case 'info': return <svg {...p}><circle cx="12" cy="12" r="9" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>;
    default: return null;
  }
}
