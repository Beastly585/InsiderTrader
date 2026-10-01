// src/components/Search.jsx — the front door. One box, everywhere:
// type a ticker, a company or a person, land on their page.
//   <SearchBox />                      top nav (press / or Cmd-K from anywhere)
//   <SearchBox mode="pick" onPick />   add-to-watchlist, onboarding
//   <SearchOverlay />                  full-screen version for phones
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { go, stockPath, insiderPath, getRecent, pushRecent } from '../lib/nav.jsx';
import { Icon } from './ui.jsx';

const resultCache = new Map();

function toItems(res) {
  return [
    ...res.stocks.map(s => ({ kind: 'stock', id: s.ticker, label: s.ticker, sub: s.company })),
    ...res.people.map(p => ({ kind: 'person', id: p.raw, label: p.name, sub: [p.role !== 'Insider' ? p.role : '', p.ticker].filter(Boolean).join(' · ') || p.title, congress: p.congress })),
  ];
}

export function openItem(item) {
  pushRecent({ kind: item.kind, id: item.id, label: item.label, sub: item.sub });
  go(item.kind === 'stock' ? stockPath(item.id) : insiderPath(item.id));
}

export function SearchBox({ mode = 'navigate', onPick, placeholder, autoFocus = false, variant = 'nav', watchlist, onDone, hotkey = false }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const seq = useRef(0);

  // Global shortcut: "/" or Cmd/Ctrl-K focuses the nav search.
  useEffect(() => {
    if (!hotkey) return;
    const onKey = e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);

  useEffect(() => {
    const onDoc = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const query = q.trim();
  useEffect(() => {
    setActive(0);
    if (!query) { setRes(null); setLoading(false); return; }
    const key = query.toLowerCase();
    if (resultCache.has(key)) { setRes(resultCache.get(key)); setLoading(false); return; }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      // Signed-out visitors (public stock and insider pages) use the public route.
      api(`${window.__clerkGetToken ? '/api' : '/public'}/search?q=${encodeURIComponent(query)}`)
        .then(r => { resultCache.set(key, r); if (id === seq.current) { setRes(r); setLoading(false); } })
        .catch(() => { if (id === seq.current) { setRes({ stocks: [], people: [], error: true }); setLoading(false); } });
    }, 140);
    return () => clearTimeout(t);
  }, [query]);

  let items = [];
  let heading = null;
  if (!query) {
    items = mode === 'navigate' ? getRecent().map(r => ({ ...r })) : [];
    heading = items.length ? 'Recent' : null;
  } else if (res) {
    items = toItems(res);
    const tickerish = /^[A-Za-z][A-Za-z0-9.\-]{0,5}$/.test(query);
    if (mode === 'navigate' && tickerish && !res.stocks.some(s => s.ticker === query.toUpperCase())) {
      items.push({ kind: 'stock', id: query.toUpperCase(), label: query.toUpperCase(), sub: 'Go to this ticker', fallback: true });
    }
  }

  const choose = useCallback(item => {
    if (!item) return;
    if (mode === 'pick') { onPick?.(item); setQ(''); inputRef.current?.focus(); return; }
    openItem(item);
    setQ(''); setOpen(false); inputRef.current?.blur(); onDone?.();
  }, [mode, onPick, onDone]);

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) choose(items[active]);
      else if (mode === 'navigate' && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(query)) choose({ kind: 'stock', id: query.toUpperCase(), label: query.toUpperCase() });
    } else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); onDone?.(); }
  }

  const showPanel = open && (query || items.length || mode === 'navigate');
  const isWatched = it => watchlist && (it.kind === 'stock' ? watchlist.hasTicker(it.id) : watchlist.hasInsider(it.id));

  return (
    <div className={`sx-search sx-search--${variant}`} ref={wrapRef}>
      <div className="sx-search__field">
        <Icon name="search" size={15} className="sx-search__icon" />
        <input
          ref={inputRef}
          className="sx-search__input"
          value={q}
          autoFocus={autoFocus}
          placeholder={placeholder || 'Search a ticker, company or insider'}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Search stocks and insiders"
          aria-expanded={!!showPanel}
          aria-autocomplete="list"
          role="combobox"
          autoComplete="off" spellCheck={false}
        />
        {loading && <span className="sx-search__spin" />}
        {!loading && hotkey && !q && <kbd className="sx-search__kbd">/</kbd>}
        {q && <button className="sx-search__clear" onClick={() => { setQ(''); inputRef.current?.focus(); }} aria-label="Clear"><Icon name="x" size={13} /></button>}
      </div>
      {showPanel && (
        <div className="sx-search__panel" role="listbox">
          {heading && <div className="sx-search__group">{heading}</div>}
          {query && res && !items.length && !loading && (
            <div className="sx-search__none">{res.error ? 'Search isn\'t responding. Try again in a moment.' : `Nothing found for "${query}".`}</div>
          )}
          {!query && !items.length && (
            <div className="sx-search__none">Try <b>NVDA</b>, a company like <b>Costco</b>, or a person like <b>Jensen Huang</b>.</div>
          )}
          {items.map((it, i) => {
            const firstPerson = it.kind === 'person' && (i === 0 || items[i - 1].kind !== 'person');
            const firstStock = query && it.kind === 'stock' && i === 0;
            return (
              <React.Fragment key={`${it.kind}:${it.id}:${i}`}>
                {firstStock && <div className="sx-search__group">Stocks</div>}
                {query && firstPerson && <div className="sx-search__group">People</div>}
                <button
                  role="option" aria-selected={i === active}
                  className={`sx-search__item${i === active ? ' sx-search__item--active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => choose(it)}>
                  <span className={`sx-search__badge sx-search__badge--${it.kind}`}>
                    <Icon name={it.kind === 'stock' ? 'building' : 'user'} size={13} />
                  </span>
                  <span className="sx-search__main">
                    <span className={it.kind === 'stock' ? 'sx-search__ticker' : 'sx-search__name'}>{it.label}</span>
                    {it.sub && <span className="sx-search__sub">{it.sub}{it.congress ? ' · Congress' : ''}</span>}
                  </span>
                  {mode === 'pick' ? (
                    <span className={`sx-search__pick${isWatched(it) ? ' sx-search__pick--on' : ''}`}>
                      <Icon name={isWatched(it) ? 'check' : 'plus'} size={13} />{isWatched(it) ? 'Watching' : 'Watch'}
                    </span>
                  ) : <Icon name="arrow" size={13} className="sx-search__go" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SearchOverlay({ onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="sx-search-overlay" role="dialog" aria-label="Search">
      <div className="sx-search-overlay__bar">
        <SearchBox autoFocus variant="overlay" onDone={onClose} />
        <button className="sx-btn sx-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
