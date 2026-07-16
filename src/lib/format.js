// src/lib/format.js
// Pure formatting helpers, extracted from app.jsx so they're independently
// testable. This exact bug class — assuming a bare date string
// ("2026-07-13") when the actual value is a full ISO timestamp
// ("2026-07-13T14:23:01.234Z") — has caused three separate real bugs this
// session (Settings' connected_at showing "Invalid Date", the portfolio
// tile showing "Updated NaNy", and fmt.dateShort before it was hardened).
// fmt.date had the identical unfixed vulnerability and is fixed here too,
// found while extracting rather than left for a fourth occurrence.

export const fmt = {
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

  // Parses a date string that may be either a bare date ("2026-07-13") or a
  // full ISO timestamp ("2026-07-13T14:23:01.234Z"). Appending 'T00:00:00'
  // onto a string that already has a time component produces an
  // unparseable date — this is the single root cause behind three separate
  // bugs this session, so every date-parsing helper here goes through this
  // one shared, tested path instead of each reimplementing the same check
  // (or forgetting to).
  _parseFlexibleDate(d) {
    if (!d) return null;
    const hasTime = /T\d{2}:\d{2}/.test(d);
    const parsed = new Date(hasTime ? d : d+'T00:00:00');
    return isNaN(parsed) ? null : parsed;
  },

  date:      d => {
    const parsed = fmt._parseFlexibleDate(d);
    return parsed ? parsed.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
  },

  dateShort: d => {
    const parsed = fmt._parseFlexibleDate(d);
    return parsed ? parsed.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : '—';
  },

  ago:       d => {
    const parsed = fmt._parseFlexibleDate(d);
    if (!parsed) return '—';
    const days = Math.floor((Date.now()-parsed)/86400000);
    if (!Number.isFinite(days)) return '—';
    if (days===0) return 'today'; if (days===1) return 'yesterday';
    if (days<30) return `${days}d ago`;
    if (days<365) return `${Math.floor(days/30)}mo ago`;
    return `${Math.floor(days/365)}y ago`;
  },
};
