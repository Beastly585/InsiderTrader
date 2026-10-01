// src/lib/intent.js
// What a signed-out visitor was trying to do when we asked them to sign up
// (watch NVDA, go Pro). Kept in localStorage across the sign-up redirect and
// finished by the app once they're signed in, so nobody lands on a generic
// page wondering where their click went. Expires after 30 minutes.
const KEY = 'seli_intent_v1';
const TTL = 30 * 60 * 1000;

export function setIntent(intent) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...intent, path: intent.path || window.location.pathname, at: Date.now() })); } catch { /* private mode */ }
}
export function peekIntent() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!v || Date.now() - (v.at || 0) > TTL) return null;
    return v;
  } catch { return null; }
}
export function clearIntent() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

// Clerk's modal sign-up/sign-in, sending the visitor back to where they were.
export function openSignUp(clerk, intent) {
  if (intent) setIntent(intent);
  const back = (intent && intent.path) || window.location.pathname;
  clerk?.openSignUp?.({
    forceRedirectUrl: back, signInForceRedirectUrl: back,
    afterSignUpUrl: back, afterSignInUrl: back, // older Clerk versions
  });
}
