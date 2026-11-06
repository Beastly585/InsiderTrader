// src/components/BubbleSphere.jsx — the watchlist as a wall of tiles.
//
// Each stock or person is a small rounded tile showing just its name and the
// last amount up or down. Tiles are packed tightly in staggered rows, like
// bricks, and the rows trace an oval: the middle rows are the longest and
// hold the most recent activity; rows thin out toward the top and bottom.
// Within a row, buys sit to the left and sales to the right (people and quiet
// stocks between), so each side of the wall reads as one color.
//
// Hover (or keyboard focus, or a first tap on a phone) grows a tile in place
// to show the full name, date, what happened and links. Tiles in its row
// slide sideways and the rows above and below shift to make room; it all
// moves with CSS transitions. The positions come from the geometry below,
// no library.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../lib/nav.jsx';
import { shortDate } from '../lib/text.js';
import { Icon } from './ui.jsx';

const BRICK_H = 44;               // every tile is the same height...
const BASE_W = [60, 72, 88, 112]; // ...width by tier: quiet, year, 30 days, this week
const FS = [11, 12, 13.5, 16];    // name size by tier
const GAP = 4;
const EXP_W = 244, EXP_H = 136;   // a tile when opened
// Room above and below the wall so an opened tile and the rows it pushes
// stay inside the frame; KEY_H is the legend underneath.
const EDGE = Math.ceil((EXP_H - BRICK_H) / 2) + 8, KEY_H = 30;
const SIDE = { buy: 0, people: 1, quiet: 2, sell: 3 }; // left to right in a row
const byWeight = (a, b) => (b.tier - a.tier) || (b.weight - a.weight) || String(a.label).localeCompare(String(b.label));

function brickWidth(it) {
  const fs = FS[it.tier];
  const em = it.mono ? 0.62 : 0.58;
  const text = Math.max(String(it.label).length * fs * em, it.amt && it.tier > 0 ? it.amt.length * 10.5 * 0.62 : 0);
  return Math.max(BASE_W[it.tier], Math.round(text + 22));
}

function layout(items, W) {
  const Rx = Math.max(140, W / 2 - 8);
  const rowH = BRICK_H + GAP;
  const sized = items.slice().sort(byWeight).map(it => ({ it, w: brickWidth(it), h: BRICK_H }));
  const total = sized.reduce((n, b) => n + b.w + GAP, 0);
  // Fewest rows whose oval outline holds every tile (with a little slack).
  let rows = 1, widths = [];
  for (; rows < 40; rows++) {
    const Ry = (rows * rowH) / 2 + rowH * 0.35;
    widths = Array.from({ length: rows }, (_, i) => {
      const y = (i + 0.5) * rowH - (rows * rowH) / 2;
      return 2 * Rx * Math.sqrt(Math.max(0.05, 1 - (y / Ry) ** 2));
    });
    if (widths.reduce((a, b) => a + b, 0) >= total * 1.12) break;
  }
  // Fill the middle row first, then alternate above and below, most active
  // first, so the busiest tiles end up in the center.
  const mid = Math.floor((rows - 1) / 2);
  const order = [mid];
  for (let d = 1; order.length < rows; d++) { if (mid - d >= 0) order.push(mid - d); if (mid + d < rows) order.push(mid + d); }
  const rowItems = Array.from({ length: rows }, () => []);
  const used = Array(rows).fill(0);
  let r = 0;
  for (const b of sized) {
    while (r < order.length - 1 && used[order[r]] + b.w > widths[order[r]]) r++;
    rowItems[order[r]].push(b); used[order[r]] += b.w + GAP;
  }
  // Lay each row out centered: grouped left to right by kind, and inside the
  // buy and sell groups the biggest sit nearest the middle.
  const H = EDGE + rows * rowH + EDGE + KEY_H;
  const placed = [];
  rowItems.forEach((list, i) => {
    const sorted = list.slice().sort((a, b) => (SIDE[a.it.group] - SIDE[b.it.group])
      || (a.it.group === 'buy' ? -byWeight(a.it, b.it) : byWeight(a.it, b.it)));
    const width = sorted.reduce((n, b) => n + b.w, 0) + GAP * Math.max(0, sorted.length - 1);
    let x = W / 2 - width / 2;
    const y = EDGE + i * rowH + BRICK_H / 2;
    for (const b of sorted) { placed.push({ it: b.it, w: b.w, h: b.h, x: x + b.w / 2, y, row: i }); x += b.w + GAP; }
  });
  return { H, placed };
}

// While one tile is open: where it sits (kept inside the frame) and where
// every other tile moves so nothing overlaps it or each other.
function pushes(placed, openKey, W, H) {
  const o = placed.find(p => p.it.key === openKey);
  if (!o) return { center: null, off: {} };
  const ox = Math.min(Math.max(o.x, EXP_W / 2 + 2), W - EXP_W / 2 - 2);
  const oy = Math.min(Math.max(o.y, EXP_H / 2 + 2), H - KEY_H - EXP_H / 2 - 2);
  const open = { x: ox, y: oy, w: EXP_W, h: EXP_H, fixed: true };
  const pos = [open, ...placed.filter(p => p !== o).map(p => ({ p, x: p.x, y: p.y, w: p.w, h: p.h, row: p.row }))];
  // Separate overlapping boxes along whichever axis needs the smaller move:
  // same-row neighbours slide sideways, rows above and below shift up/down.
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i], b = pos[j];
        const px = (a.w + b.w) / 2 + GAP - Math.abs(b.x - a.x);
        const py = (a.h + b.h) / 2 + GAP - Math.abs(b.y - a.y);
        if (px <= 0 || py <= 0) continue;
        const horiz = px < py * 1.6;
        const sx = Math.sign(b.x - a.x) || 1, sy = Math.sign(b.y - a.y) || 1;
        const share = a.fixed ? [0, 1] : b.fixed ? [1, 0] : [0.5, 0.5];
        if (horiz) { a.x -= sx * px * share[0]; b.x += sx * px * share[1]; }
        else { a.y -= sy * py * share[0]; b.y += sy * py * share[1]; }
        moved = true;
      }
    }
    // Keep everything inside the frame (above the key).
    for (const q of pos) {
      if (q.fixed) continue;
      const y = Math.min(Math.max(q.y, q.h / 2 + 2), H - KEY_H - q.h / 2 - 2);
      const x = Math.min(Math.max(q.x, q.w / 2 + 2), W - q.w / 2 - 2);
      if (y !== q.y || x !== q.x) { q.y = y; q.x = x; moved = true; }
    }
    if (!moved) break;
  }
  const off = {};
  for (const q of pos) if (!q.fixed && (Math.abs(q.x - q.p.x) > 0.5 || Math.abs(q.y - q.p.y) > 0.5)) off[q.p.it.key] = [q.x - q.p.x, q.y - q.p.y];
  return { center: [ox, oy], off };
}

export default function BubbleSphere({ items, sigText, sigPath }) {
  const ref = useRef(null);
  const [W, setW] = useState(720);
  const [openKey, setOpenKey] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { H, placed } = useMemo(() => layout(items, W), [items, W]);
  const { center, off } = useMemo(() => pushes(placed, openKey, W, H), [placed, openKey, W, H]);
  const canHover = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

  const go2 = (e, path) => { e.stopPropagation(); if (e.metaKey || e.ctrlKey) { window.open(path, '_blank'); return; } e.preventDefault(); go(path); };
  const onTap = (e, p) => {
    if (!canHover && openKey !== p.it.key) { e.preventDefault(); setOpenKey(p.it.key); return; } // phones: first tap opens
    go2(e, p.it.path);
  };

  return (
    <div ref={ref} className="hx-bub" style={{ height: H }} onMouseLeave={() => canHover && setOpenKey(null)}
      role="list" aria-label="Everything you watch: most recent in the middle rows, buys to the left, sales to the right">
      {placed.map(p => {
        const it = p.it;
        const isOpen = openKey === it.key;
        const [dx, dy] = off[it.key] || [0, 0];
        const x = isOpen ? center[0] : p.x + dx, y = isOpen ? center[1] : p.y + dy;
        const w = isOpen ? EXP_W : p.w, h = isOpen ? EXP_H : p.h;
        return (
          <div key={it.key} role="listitem" tabIndex={0}
            className={`hx-bb hx-bb--${it.side} hx-bb--t${it.tier}${isOpen ? ' hx-bb--open' : ''}${it.signal ? ' hx-bb--sig' : ''}`}
            style={{ left: x, top: y, width: w, height: h, zIndex: isOpen ? 50 : 1, '--fs': `${FS[it.tier]}px` }}
            onMouseEnter={() => canHover && setOpenKey(it.key)}
            onFocus={() => setOpenKey(it.key)}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpenKey(k => (k === it.key ? null : k)); }}
            onClick={e => onTap(e, p)}
            onKeyDown={e => { if (e.key === 'Enter') go2(e, it.path); if (e.key === 'Escape') setOpenKey(null); }}
            aria-label={`${it.title}${it.amt ? `, ${it.amt}` : ''}. ${it.detail}${it.signal ? ` Signal: ${sigText(it.signal)}.` : ''}`}>
            {!isOpen ? (
              <span className="hx-bb__face">
                <span className={`hx-bb__label${it.mono ? ' sx-mono' : ''}`}>{it.label}</span>
                {it.amt && it.tier > 0 && <span className="hx-bb__amt sx-mono">{it.amt}</span>}
              </span>
            ) : (
              <span className="hx-bb__face hx-bb__face--open">
                <span className="hx-bb__title">{it.title}</span>
                <span className="hx-bb__meta">
                  {it.amt && <b className="sx-mono">{it.amt}</b>}{it.date && <span>{shortDate(it.date)}</span>}
                  {it.tags.map(t => <span key={t} className="hx-bb__tag">{t}</span>)}
                </span>
                <span className="hx-bb__detail">{it.detail}</span>
                {it.signal && <span className="hx-bb__sigline"><Icon name="trend" size={10} /> {it.signal.why.slice(0, 2).join(' · ')}</span>}
                <span className="hx-bb__links">
                  <a href={it.path} onClick={e => go2(e, it.path)}>Open <Icon name="arrow" size={10} /></a>
                  {it.signal && <a href={sigPath(it.signal)} onClick={e => go2(e, sigPath(it.signal))}>Signal <Icon name="arrow" size={10} /></a>}
                </span>
              </span>
            )}
            {it.signal && !isOpen && <span className="hx-bb__sig" aria-hidden="true"><Icon name="trend" size={9} /></span>}
            {it.tags.includes('New') && !isOpen && <span className="hx-bb__new" aria-hidden="true" />}
          </div>
        );
      })}
      <div className="hx-bub__key" aria-hidden="true">
        <span><i className="hx-dot hx-dot--buy" />bought</span>
        <span><i className="hx-dot hx-dot--sell" />sold</span>
        <span><i className="hx-dot hx-dot--cg" />Congress</span>
        <span><i className="hx-sigdot"><Icon name="trend" size={9} /></i>in Signals</span>
        <span className="hx-sphere__size">Wider and nearer the middle = more recent</span>
      </div>
    </div>
  );
}
