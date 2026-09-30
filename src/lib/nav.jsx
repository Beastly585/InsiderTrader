// src/lib/nav.jsx — URLs for the two things Seli is about (stocks and the
// people who trade them) and one navigation helper everything uses.
//
// Rule: a ticker or a person's name anywhere in the app is a real link to
// its page. Same click, same result, back button works, cmd-click opens a tab.
import React from 'react';

export const stockPath = t => `/stock/${encodeURIComponent(String(t || '').toUpperCase())}`;
// Raw insider_name, exactly as stored (emails link the same way).
export const insiderPath = raw => `/insider/${encodeURIComponent(raw || '')}`;

export function go(path, { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  const cur = window.location.pathname + window.location.search;
  if (cur === path && !replace) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: { seliPush: !replace } }));
  // pushState doesn't scroll to #anchors the way a normal link does.
  const hash = path.split('#')[1];
  if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

function isPlainClick(e) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function Link({ to, children, className, onClick, title, style, ...rest }) {
  return (
    <a href={to} className={className} title={title} style={style} {...rest}
      onClick={e => {
        e.stopPropagation();
        onClick?.(e);
        if (e.defaultPrevented || !isPlainClick(e)) return;
        e.preventDefault();
        go(to);
      }}>
      {children}
    </a>
  );
}

export function StockLink({ ticker, children, className = '', plain = false, ...rest }) {
  if (!ticker) return children ?? null;
  return <Link to={stockPath(ticker)} className={`${plain ? 'sx-textlink' : 'sx-tk'} ${className}`} {...rest}>{children ?? ticker}</Link>;
}

export function InsiderLink({ raw, children, className = '', ...rest }) {
  if (!raw) return children ?? null;
  return <Link to={insiderPath(raw)} className={`sx-person ${className}`} {...rest}>{children ?? raw}</Link>;
}

// ── Recently viewed (for the empty search box) ─────────────────────────────
const RECENT_KEY = 'seli_recent_v1';
export function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function pushRecent(item) { // {kind:'stock'|'person', id, label, sub}
  try {
    const next = [item, ...getRecent().filter(r => !(r.kind === item.kind && r.id === item.id))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
}
