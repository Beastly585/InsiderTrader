// src/lib/visit.js — "since your last visit" for Home.
//
// A visit is a stretch of using Seli with no gap longer than 30 minutes.
// When a new visit starts, the end of the previous one becomes "since".
// Reloading or clicking around during a visit doesn't move it, so Home
// doesn't shrink to nothing while you're using it.
//
// Kept per account in this browser. Another device has its own record; a
// browser with no record (first visit, cleared storage) uses the full 30 days.
// Storage that's blocked or unavailable falls back to 30 days too.

const KEY = uid => `seli_visit_v1:${uid}`;
const GAP_MS = 30 * 60 * 1000;
const MAX_DAYS = 30;
const DAY_MS = 864e5;

const read = uid => { try { return JSON.parse(localStorage.getItem(KEY(uid)) || 'null'); } catch { return null; } };
const write = (uid, rec) => { try { localStorage.setItem(KEY(uid), JSON.stringify(rec)); } catch { /* private mode */ } };

// Calendar date in New York, where SEC filing dates come from.
export const etDate = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const started = new Map(); // uid -> this page load's answer, so it holds still for the whole load

// When this visit's "since" is (ms), starting a new visit if it's been a while.
export function visitSince(uid, now = Date.now()) {
  if (!uid) return null;
  if (started.has(uid)) return started.get(uid);
  let rec = read(uid);
  if (!rec || !Number.isFinite(rec.last) || !Number.isFinite(rec.since)) rec = { since: now - MAX_DAYS * DAY_MS, last: now };
  else if (now - rec.last > GAP_MS) rec = { since: rec.last, last: now };
  else rec = { ...rec, last: now };
  write(uid, rec);
  started.set(uid, rec.since);
  keepAlive(uid);
  return rec.since;
}

// Moves "last seen" forward while the tab is open and when it's left, so the
// next visit starts from when you actually stopped looking.
const alive = new Set();
function keepAlive(uid) {
  if (alive.has(uid) || typeof window === 'undefined') return;
  alive.add(uid);
  const touch = () => { const rec = read(uid); if (rec) write(uid, { ...rec, last: Date.now() }); };
  setInterval(() => { if (document.visibilityState === 'visible') touch(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', touch);
  window.addEventListener('pagehide', touch);
}

// Days Home should cover: every filing day from the last visit's date through
// today, 1 to 30.
export function windowDays(since, now = Date.now()) {
  if (!Number.isFinite(since)) return MAX_DAYS;
  const a = Date.parse(etDate(since) + 'T00:00:00Z');
  const b = Date.parse(etDate(now) + 'T00:00:00Z');
  return Math.min(MAX_DAYS, Math.max(1, Math.round((b - a) / DAY_MS) + 1));
}

// "Since your last visit" wording for the card.
export function sinceLabel(since, now = Date.now()) {
  if (!Number.isFinite(since) || now - since >= MAX_DAYS * DAY_MS - 60000) return 'Last 30 days';
  const d = windowDays(since, now);
  if (d === 1) return 'Since your last visit, earlier today';
  if (d === 2) return 'Since your last visit, yesterday';
  return `Since your last visit, ${d - 1} days ago`;
}
