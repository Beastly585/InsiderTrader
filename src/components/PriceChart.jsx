// src/components/PriceChart.jsx — price line with insider buys and sells
// marked on the day they traded. The one picture the whole product is about.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { money, price as fmtPrice, shortDate, congressRange } from '../lib/text.js';
import { Segmented } from './ui.jsx';

const RANGES = [{ value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 1095, label: '3Y' }];

function useWidth(ref) {
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export default function PriceChart({ prices, trades, height = 240 }) {
  const wrap = useRef(null);
  const width = useWidth(wrap);
  const [range, setRange] = useState(365);
  const [hover, setHover] = useState(null);

  const data = useMemo(() => {
    if (!prices?.length) return null;
    const lastDate = prices[prices.length - 1][0];
    const cutoff = new Date(Date.parse(lastDate + 'T00:00:00Z') - range * 86400000).toISOString().slice(0, 10);
    const pts = prices.filter(p => p[0] >= cutoff && p[1] != null);
    if (pts.length < 2) return null;
    // Group open-market trades by the price date they fall on (weekends roll back).
    const idxFor = d => { let lo = 0, hi = pts.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
    const marks = new Map();
    for (const t of trades || []) {
      if (!t.om || !t.date || t.date < pts[0][0] || (t.type !== 'buy' && t.type !== 'sell')) continue;
      const i = idxFor(t.date);
      if (i < 0) continue;
      const key = `${i}:${t.type}`;
      if (!marks.has(key)) marks.set(key, { i, type: t.type, value: 0, trades: [] });
      const m = marks.get(key);
      m.value += t.value || 0; m.trades.push(t);
    }
    const closes = pts.map(p => p[1]);
    const lo = Math.min(...closes), hi = Math.max(...closes);
    const pad = (hi - lo) * 0.08 || hi * 0.05;
    return { pts, marks: [...marks.values()], lo: lo - pad, hi: hi + pad };
  }, [prices, trades, range]);

  if (!data) return <div className="sx-chart__none">Price history isn't available for this ticker yet. The filings below are still complete.</div>;

  const L = 8, R = 52, T = 10, B = 24;
  const W = width, H = height;
  const x = i => L + (i / (data.pts.length - 1)) * (W - L - R);
  const y = v => T + (1 - (v - data.lo) / (data.hi - data.lo)) * (H - T - B);
  const path = data.pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const area = `${path}L${x(data.pts.length - 1).toFixed(1)},${H - B}L${x(0).toFixed(1)},${H - B}Z`;
  const ticks = niceTicks(data.lo, data.hi);
  const first = data.pts[0][1], last = data.pts[data.pts.length - 1][1];
  const chg = (last - first) / first * 100;
  // Log scale so a $200K buy is still visible next to a $14M sale.
  const r = v => Math.max(3.5, Math.min(9, 3 + 1.6 * Math.log10(Math.max(v, 1e4) / 1e4)));
  // Buys drawn last so they sit on top of sales on the same day.
  const ordered = [...data.marks].sort((a, b) => (a.type === 'buy') - (b.type === 'buy'));

  // Month labels, thinned to fit.
  const months = [];
  let prevM = '';
  data.pts.forEach((p, i) => { const m = p[0].slice(0, 7); if (m !== prevM) { months.push({ i, d: p[0] }); prevM = m; } });
  const every = Math.ceil(months.length / Math.max(2, Math.floor((W - L - R) / 70)));
  const monthLabels = months.filter((_, k) => k % every === 0 && k > 0);

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    const i = Math.round(((px - L) / (W - L - R)) * (data.pts.length - 1));
    setHover(Math.max(0, Math.min(data.pts.length - 1, i)));
  }
  const hMarks = hover == null ? [] : data.marks.filter(m => Math.abs(m.i - hover) <= Math.max(1, Math.round(data.pts.length / 120)));
  const hp = hover != null ? data.pts[hover] : null;

  return (
    <div className="sx-chart" ref={wrap}>
      <div className="sx-chart__top">
        <div className="sx-chart__legend">
          <span className="sx-chart__key sx-chart__key--buy">Insider buy</span>
          <span className="sx-chart__key sx-chart__key--sell">Insider sale</span>
          <span className={`sx-chart__chg ${chg >= 0 ? 'sx-up' : 'sx-down'}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}% over this range</span>
        </div>
        <Segmented size="sm" options={RANGES} value={range} onChange={setRange} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="sx-chart__svg"
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}
        role="img" aria-label={`Price chart with ${data.marks.length} insider trade markers`}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="sx-chart__grid" />
            <text x={W - R + 6} y={y(v) + 3.5} className="sx-chart__axis">{fmtPrice(v)}</text>
          </g>
        ))}
        {monthLabels.map(m => (
          <text key={m.d} x={x(m.i)} y={H - 6} className="sx-chart__axis" textAnchor="middle">{shortDate(m.d.slice(0, 7) + '-01', { year: false }).replace(/ 1$/, '')}</text>
        ))}
        <path d={area} className="sx-chart__area" />
        <path d={path} className="sx-chart__line" />
        {ordered.map(m => (
          <circle key={`${m.i}:${m.type}`} cx={x(m.i)} cy={y(data.pts[m.i][1])} r={r(m.value)}
            className={`sx-chart__mark sx-chart__mark--${m.type}${m.trades.some(t => t.congress) ? ' sx-chart__mark--congress' : ''}`} />
        ))}
        {hp && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="sx-chart__cross" />
            <circle cx={x(hover)} cy={y(hp[1])} r={3} className="sx-chart__dot" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="sx-chart__tip" style={{ left: `${Math.min(Math.max(x(hover) / W * 100, 12), 78)}%` }}>
          <div className="sx-chart__tip-date">{shortDate(hp[0], { year: true })} · {fmtPrice(hp[1])}</div>
          {hMarks.flatMap(m => m.trades).slice(0, 4).map((t, k) => (
            <div key={k} className={`sx-chart__tip-row sx-chart__tip-row--${t.type}`}>
              {t.name} {t.type === 'buy' ? 'bought' : 'sold'} {t.congress ? congressRange(t.value) : money(t.value)}
            </div>
          ))}
          {hMarks.flatMap(m => m.trades).length > 4 && <div className="sx-chart__tip-more">+{hMarks.flatMap(m => m.trades).length - 4} more</div>}
        </div>
      )}
    </div>
  );
}
