// src/components/WatchButton.jsx
// One control for stocks and people. Watching something means:
//   - it shows up on Home and your Watchlist
//   - it's in your weekly digest (free) / daily digest (Pro)
//   - Pro: same-day email when a new filing lands (per-item bell on Watchlist)
import React from 'react';
import { Icon } from './ui.jsx';

export function isWatching(watchlist, kind, id) {
  return kind === 'stock' ? watchlist.hasTicker(id) : watchlist.hasInsider(id);
}

export default function WatchButton({ watchlist, kind, id, compact = false }) {
  if (!watchlist || !id) return null;
  const on = isWatching(watchlist, kind, id);
  const full = !on && !watchlist.pro && watchlist.freeSlotsLeft === 0;
  const what = kind === 'stock' ? 'this stock' : 'this person';
  const title = on ? `Watching ${what}. Click to stop.`
    : full ? `Your free watchlist is full (${watchlist.freeLimit}). Pro makes it unlimited.`
      : `Watch ${what}: it goes on your Home page and into your ${watchlist.pro ? 'digests and alerts' : 'weekly email'}.`;
  const toggle = e => {
    e.stopPropagation();
    kind === 'stock' ? watchlist.toggleTicker(id) : watchlist.toggleInsider(id);
  };
  if (compact) {
    return (
      <button className={`sx-watch sx-watch--icon${on ? ' sx-watch--on' : ''}`} onClick={toggle} title={title} aria-pressed={on} aria-label={on ? 'Stop watching' : 'Watch'}>
        <Icon name={on ? 'check' : 'plus'} size={14} />
      </button>
    );
  }
  return (
    <button className={`sx-watch${on ? ' sx-watch--on' : ''}`} onClick={toggle} title={title} aria-pressed={on}>
      <Icon name={on ? 'check' : 'bell'} size={14} />
      {on ? 'Watching' : 'Watch'}
    </button>
  );
}

// Per-item same-day alert toggle (Watchlist page). Free users get the gate.
export function AlertBell({ watchlist, kind, id, onUpgrade }) {
  const type = kind === 'stock' ? 'ticker' : 'insider';
  const on = watchlist.pro && watchlist.alertsOn(type, id);
  const title = !watchlist.pro ? 'Same-day email alerts are a Pro feature. Free accounts get this in the Sunday digest.'
    : on ? 'Same-day email alert is on. Click to mute (it stays in your digest).' : 'Muted: digest only. Click for same-day email alerts.';
  return (
    <button className={`sx-bell${on ? ' sx-bell--on' : ''}${!watchlist.pro ? ' sx-bell--locked' : ''}`} title={title} aria-pressed={on}
      aria-label={title}
      onClick={e => { e.stopPropagation(); if (!watchlist.pro) { onUpgrade?.('notifications'); return; } watchlist.setAlerts(type, id, !on); }}>
      <Icon name={on ? 'bell' : 'bell-off'} size={15} />
    </button>
  );
}
