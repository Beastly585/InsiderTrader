#!/usr/bin/env node
// verify_isolation.mjs
//
// Real, automated multi-account isolation test against the LIVE Worker —
// not a mock, not a unit test of pure logic. Confirms the actual guarantee
// your manual testing already suggested holds (two browsers, one Pro/one
// not, no shared watchlist) but does it programmatically, against every
// user-scoped endpoint, so it can be re-run after any future change without
// needing to manually re-check two browser windows by eye.
//
// Setup (one-time, per run):
//   1. Sign into two real Seli accounts in two separate browser sessions
//      (normal window + incognito, or two different browsers).
//   2. Open DevTools → Application/Storage → find the Clerk session token,
//      OR simpler: open DevTools → Network tab, find any authenticated
//      request to your Worker, and copy the `Authorization: Bearer ...`
//      header value. That's ACCOUNT_A_TOKEN / ACCOUNT_B_TOKEN below.
//   3. Run:
//        WORKER_URL=https://your-worker.workers.dev \
//        ACCOUNT_A_TOKEN=eyJ... \
//        ACCOUNT_B_TOKEN=eyJ... \
//        node verify_isolation.mjs
//
// This test is intentionally destructive-but-cleans-up: it adds two
// distinguishable, obviously-fake tickers (ZZISOTEST1 / ZZISOTEST2) to each
// account's real watchlist, checks isolation, then removes them at the end
// — including on failure, via a try/finally.

const WORKER_URL = process.env.WORKER_URL;
const TOKEN_A = process.env.ACCOUNT_A_TOKEN;
const TOKEN_B = process.env.ACCOUNT_B_TOKEN;

if (!WORKER_URL || !TOKEN_A || !TOKEN_B) {
  console.error('Missing required env vars. Need WORKER_URL, ACCOUNT_A_TOKEN, ACCOUNT_B_TOKEN.');
  process.exit(1);
}

const TEST_TICKER_A = 'ZZISOTEST1';
const TEST_TICKER_B = 'ZZISOTEST2';

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label}`);
    failures++;
  }
}

async function call(token, path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON response, leave null */ }
  return { status: res.status, body };
}

async function getWatchlist(token, label) {
  const { status, body } = await call(token, '/watchlist');
  if (status !== 200) {
    throw new Error(
      `/watchlist call for ${label} failed with status ${status}: ${JSON.stringify(body)}\n` +
      `Most likely cause: an expired token — Clerk session tokens are short-lived. ` +
      `Grab a fresh one and re-run immediately rather than pausing between copying and running.`
    );
  }
  if (!Array.isArray(body?.items)) {
    throw new Error(`/watchlist call for ${label} returned 200 but an unexpected shape: ${JSON.stringify(body)}`);
  }
  return body.items;
}

async function addTicker(token, ticker) {
  return call(token, '/watchlist', {
    method: 'POST',
    body: JSON.stringify({ action: 'add', item_type: 'ticker', item_value: ticker }),
  });
}

async function removeTicker(token, ticker) {
  return call(token, '/watchlist', {
    method: 'POST',
    body: JSON.stringify({ action: 'remove', item_type: 'ticker', item_value: ticker }),
  });
}

async function main() {
  console.log('\n=== Multi-account isolation test (live Worker) ===\n');

  try {
    console.log('1. Watchlist isolation');
    await addTicker(TOKEN_A, TEST_TICKER_A);
    await addTicker(TOKEN_B, TEST_TICKER_B);

    const listA = await getWatchlist(TOKEN_A, 'Account A');
    const listB = await getWatchlist(TOKEN_B, 'Account B');
    const tickersA = listA.map(i => i.item_value || i.ticker || i);
    const tickersB = listB.map(i => i.item_value || i.ticker || i);

    check('Account A sees its own test ticker', tickersA.includes(TEST_TICKER_A));
    check("Account A does NOT see Account B's test ticker", !tickersA.includes(TEST_TICKER_B));
    check('Account B sees its own test ticker', tickersB.includes(TEST_TICKER_B));
    check("Account B does NOT see Account A's test ticker", !tickersB.includes(TEST_TICKER_A));

    console.log('\n2. Billing/subscription isolation');
    const billingA = await call(TOKEN_A, '/billing/status');
    const billingB = await call(TOKEN_B, '/billing/status');
    check('Both billing status calls succeed independently', billingA.status === 200 && billingB.status === 200);
    // Written assuming your real test setup: one account Pro, one free.
    // If you run this against two accounts on the SAME plan, this specific
    // check will correctly fail — that's expected, not a bug in the test —
    // comment it out or adjust for that case rather than trust a false pass.
    const planA = billingA.body?.plan ?? billingA.body?.status;
    const planB = billingB.body?.plan ?? billingB.body?.status;
    check(
      `Plan/status genuinely differs between accounts as expected (A: ${planA}, B: ${planB})`,
      planA !== planB
    );

    console.log('\n3. Adversarial input — Account A cannot act on Account B\'s data even if it explicitly tries');
    // Attempt to use Account A's token to remove Account B's real ticker by
    // guessing/supplying it directly. This should have zero effect on B's
    // list — the server must ignore anything not scoped to A's own
    // verified token, regardless of what the request body claims.
    await removeTicker(TOKEN_A, TEST_TICKER_B);
    const listBAfter = await getWatchlist(TOKEN_B, 'Account B (post-adversarial-check)');
    const tickersBAfter = listBAfter.map(i => i.item_value || i.ticker || i);
    check(
      "Account A's attempt to remove Account B's ticker had no effect on B's actual list",
      tickersBAfter.includes(TEST_TICKER_B)
    );

    console.log('\n4. Unauthenticated access is rejected');
    const noAuth = await fetch(`${WORKER_URL}/watchlist`);
    check('Request with no Authorization header is rejected (401)', noAuth.status === 401);

  } finally {
    console.log('\nCleaning up test data...');
    await removeTicker(TOKEN_A, TEST_TICKER_A);
    await removeTicker(TOKEN_B, TEST_TICKER_B);
    // Also attempt cleanup of the cross-attempt in case it somehow succeeded
    await removeTicker(TOKEN_B, TEST_TICKER_B).catch(() => {});
  }

  console.log(`\n${'='.repeat(50)}`);
  if (failures === 0) {
    console.log('\x1b[32mAll isolation checks passed.\x1b[0m');
  } else {
    console.log(`\x1b[31m${failures} check(s) FAILED — do not treat isolation as verified.\x1b[0m`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Test run crashed:', e);
  process.exit(1);
});
