// src/lib/api.js — the one way pages talk to the Worker's named endpoints.
// Shares the Clerk token cache with app.jsx/edgar.js (window.__seliAuth) so
// there's still a single token poll across the whole app.
import { useEffect, useRef, useState, useCallback } from 'react';
import cfg from '../config.js';

if (typeof window !== 'undefined' && !window.__seliAuth) window.__seliAuth = { poll: null, token: null, expiry: 0 };

export async function authHeaders() {
  const auth = window.__seliAuth;
  if (auth.token && Date.now() < auth.expiry) return { Authorization: `Bearer ${auth.token}` };
  if (!window.__clerkGetToken) {
    if (!auth.poll) {
      auth.poll = (async () => {
        for (let i = 0; i < 40 && !window.__clerkGetToken; i++) await new Promise(r => setTimeout(r, 50));
        auth.poll = null;
      })();
    }
    await auth.poll;
  }
  if (window.__clerkGetToken) {
    try {
      const token = await window.__clerkGetToken();
      if (token) { auth.token = token; auth.expiry = Date.now() + 10_000; return { Authorization: `Bearer ${token}` }; }
    } catch { /* fall through */ }
  }
  return {};
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  // /public/* needs no sign-in; don't wait on Clerk for it.
  const headers = path.startsWith('/public/') ? {} : { ...(await authHeaders()) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${cfg.NEON_PROXY_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Couldn\'t reach Seli. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // "Missing query" / "Not found" mean the Worker predates this endpoint
    // (app deployed before the Worker). Log it for us, keep it readable for users.
    const stale = data.error === 'Missing query' || res.status === 404;
    if (stale) console.error(`[api] ${path} returned ${res.status} "${data.error}". Is the Worker deployed with worker/lib/research.js?`);
    const msg = res.status === 401 ? 'Your session needs a refresh. Reload the page.'
      : stale ? 'This part of Seli is being updated. Try again in a few minutes.'
        : (data.error || 'Something went wrong. Try again in a moment.');
    throw new ApiError(msg, res.status);
  }
  return data;
}

// Session cache so going back to a page you just saw is instant. The page
// still refetches in the background and swaps in fresh data when it lands.
const cache = new Map();
// Public pages arrive with their data already embedded by the server
// (window.__SELI_PREFETCH__, see edge/seo.js). Seed the cache with it and
// skip the first fetch for those paths.
const prefetched = new Set();
if (typeof window !== 'undefined' && window.__SELI_PREFETCH__) {
  for (const [k, v] of Object.entries(window.__SELI_PREFETCH__)) { cache.set(k, v); prefetched.add(k); }
}
export function clearApiCache(prefix = '') { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); }

// After something that changes what the Worker returns for this user (going
// Pro, canceling), every page on screen refetches in place. Nothing unmounts,
// so an open modal (like the "You're on Pro" one) stays put.
export function refreshApi() {
  clearApiCache('/api/');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('seli:refresh'));
}

// The first year of data Seli has (Pro sees everything since then). One
// lookup per page load, shared by every "since YEAR" in the app.
let sincePromise = null;
export function useDataSinceYear() {
  const [year, setYear] = useState(null);
  useEffect(() => {
    if (!sincePromise) {
      sincePromise = api('/public/data-stats').then(d => {
        const y = d?.oldest_filing_date ? Number(String(d.oldest_filing_date).slice(0, 4)) : null;
        return y && y > 2000 && y <= new Date().getFullYear() ? y : null;
      }).catch(() => null);
    }
    let live = true;
    sincePromise.then(y => { if (live) setYear(y); });
    return () => { live = false; };
  }, []);
  return year;
}

export function useApi(path) {
  const [state, setState] = useState(() => ({ data: path ? cache.get(path) ?? null : null, error: null, loading: !!path }));
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    if (prefetched.delete(path) && cache.has(path)) { setState({ data: cache.get(path), error: null, loading: false, path }); return; }
    const id = ++seq.current;
    const ctl = new AbortController();
    setState(s => ({ data: cache.get(path) ?? (s.path === path ? s.data : null), error: null, loading: true, path }));
    api(path, { signal: ctl.signal })
      .then(d => { cache.set(path, d); if (id === seq.current) setState({ data: d, error: null, loading: false, path }); })
      .catch(e => { if (e.name !== 'AbortError' && id === seq.current) setState(s => ({ ...s, error: e.message, loading: false })); });
    return () => ctl.abort();
  }, [path]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (!path || path.startsWith('/public/')) return;
    const h = () => load();
    window.addEventListener('seli:refresh', h);
    return () => window.removeEventListener('seli:refresh', h);
  }, [load, path]);
  return { ...state, reload: load };
}
