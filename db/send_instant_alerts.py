#!/usr/bin/env python3
"""
db/send_instant_alerts.py
Runs as a step in the ingest workflow, right after fetch_filings_neon.py.
Checks filings that haven't been alert-processed yet (alerted_at IS NULL)
against each Pro user's watchlist + instant-alert preferences, and sends one
batched email per user for whatever matched in this run.

Deliberately simpler than the digest — a single event-driven list, not a
multi-section newsletter — but shares the same brand language (colors,
header gradient) so the two feel like the same product, not two different
ones.

Four trigger types, matching the Settings > Instant alerts UI exactly:
  - instant_watchlist_ticker : any insider trades a ticker they're watching
                               (subject to their instant_min_value floor)
  - instant_followed_insider : an insider they follow files a new Form 4
                               (subject to their instant_min_value floor)
  - instant_high_conviction  : a single C-suite open-market buy at or above
                               their own instant_high_conviction_threshold,
                               regardless of watchlist — this is a simplified
                               single-buy threshold, not true multi-insider
                               cluster detection, which would need a heavier
                               query. Internal field name kept as-is to avoid
                               a schema/preferences migration; the reason
                               label shown in the actual email is "Large
                               executive buy" (see reason_label below) —
                               purely factual/descriptive rather than
                               evaluative language like "high conviction",
                               to stay clearly informational rather than
                               reading as a recommendation.
  - instant_reversal         : an insider on a watched ticker changes
                               direction from their immediately prior trade
                               (subject to their instant_min_value floor)
"""
from __future__ import annotations
import os, sys, re, time, logging, requests
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# Same auto-load as fetch_filings_neon.py / fetch_political_trades.py in
# this same db/ folder — this script was the one outlier reading only from
# the shell environment, which is what made a placeholder value ("...")
# easy to paste in literally instead of the real connection string. With
# this, DATABASE_URL (and everything else below) loads from db/.env
# automatically, the same as its sibling scripts, and testing this file no
# longer requires retyping the connection string by hand each run.
load_dotenv(Path(__file__).parent / ".env")

DATABASE_URL     = os.environ.get("DATABASE_URL", "")
RESEND_API_KEY   = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL       = os.environ.get("ALERTS_FROM_EMAIL", "alerts@mail.seli.app")
FROM_NAME        = "Seli - Alert"
APP_URL          = os.environ.get("APP_URL", "https://seli.app")
DRY_RUN          = os.environ.get("DRY_RUN", "false").lower() == "true"
BATCH_LIMIT      = 2000  # safety cap — a normal 15-min cycle should be far under this
# For the portfolio-holding trigger — reuses the same server-to-server
# endpoint and key the Worker already exposes for exactly this purpose
# (handlePortfolioTickersBatch), rather than duplicating SnapTrade calls
# or credentials here.
WORKER_API_KEY   = os.environ.get("WORKER_API_KEY", "")
NEON_PROXY_URL   = os.environ.get("NEON_PROXY_URL", "https://neon-proxy.beastly-insider-trades.workers.dev")

if not DATABASE_URL:
    log.error("DATABASE_URL required"); sys.exit(1)
if not RESEND_API_KEY and not DRY_RUN:
    log.error("RESEND_API_KEY required (or set DRY_RUN=true to test without sending)"); sys.exit(1)

CSUITE_TITLE_RE = re.compile(r"chief|ceo|cfo|coo|cto|president", re.I)

# Same brand palette as send_digests.py — light theme, pulled from the app's
# own style.css variables, not invented separately per template.
C_ACCENT       = "#5A4FE8"
C_ACCENT_STR   = "#4338C9"
C_AQUA         = "#3FBFA0"
C_GREEN        = "#15803D"
C_RED          = "#C0392B"
C_TEXT         = "#111827"
C_TEXT_MUTED   = "#6B7280"
C_TEXT_FAINT   = "#9CA3AF"
C_BORDER       = "#E5E7EB"
C_BG           = "#FFFFFF"


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


def send_email(to_email: str, subject: str, html: str, max_retries: int = 3) -> bool:
    if DRY_RUN:
        log.info(f"  [DRY RUN] would send to {to_email}: {subject}")
        return True
    for attempt in range(max_retries):
        try:
            r = requests.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
                json={"from": f"{FROM_NAME} <{FROM_EMAIL}>", "to": [to_email], "subject": subject, "html": html},
                timeout=15,
            )
            if r.ok:
                return True
            # 429 (rate limited) and 5xx (Resend-side issue) are worth
            # retrying — a filing gets marked processed regardless of send
            # outcome below, so a transient failure here previously meant
            # silent, permanent loss of that specific alert. A genuine 4xx
            # (bad request, bad key) won't succeed on retry, so fail fast
            # on those instead of wasting the remaining attempts.
            retryable = r.status_code == 429 or r.status_code >= 500
            log.error(f"  Resend error for {to_email} (attempt {attempt+1}/{max_retries}): {r.status_code} {r.text[:200]}")
            if not retryable:
                return False
        except Exception as e:
            log.error(f"  Send failed for {to_email} (attempt {attempt+1}/{max_retries}): {e}")
        if attempt < max_retries - 1:
            time.sleep(2 * (attempt + 1))  # 2s, 4s
    return False


def fmt_money(v):
    if v is None: return "—"
    v = float(v)
    sign = "-" if v < 0 else ""
    v = abs(v)
    for div, suf in [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")]:
        if v >= div: return f"{sign}${v/div:,.1f}{suf}"
    return f"{sign}${v:,.0f}"


def fetch_portfolio_tickers() -> dict[str, set[str]]:
    """Real per-user holdings, sourced from the Worker's existing
    /internal/portfolio-tickers-batch endpoint — the same server-to-server
    route and WORKER_API_KEY already used for this exact purpose elsewhere,
    not a new SnapTrade integration. Only Pro users with an active
    connection have anything here. If WORKER_API_KEY isn't set, or the
    call fails for any reason, this degrades to an empty mapping rather
    than crashing the whole alert run — the watchlist/insider/reversal
    triggers should keep working even if the portfolio piece is
    unavailable for a moment.
    """
    if not WORKER_API_KEY:
        log.warning("  WORKER_API_KEY not set — skipping portfolio-holding trigger this run.")
        return {}
    try:
        r = requests.get(
            f"{NEON_PROXY_URL}/internal/portfolio-tickers-batch",
            headers={"X-API-Key": WORKER_API_KEY},
            timeout=30,
        )
        if not r.ok:
            log.warning(f"  portfolio-tickers-batch returned {r.status_code} — skipping this run: {r.text[:200]}")
            return {}
        data = r.json().get("tickers_by_user", {})
        return {uid: set(tickers) for uid, tickers in data.items()}
    except Exception as e:
        log.warning(f"  portfolio-tickers-batch failed — skipping this run: {e}")
        return {}


def build_email(user_email: str, matches: list[dict]) -> tuple[str, str]:
    n = len(matches)
    subject = f"{n} insider alert{'s' if n != 1 else ''} — {matches[0]['ticker']}" if n == 1 else f"{n} insider alerts triggered"
    rows = ""
    for m in matches:
        reason_label = {
            "watchlist_ticker":   "Watched ticker traded",
            "followed_insider":   "Followed insider filed",
            "high_conviction":    "Large executive buy",
            "reversal":           "Reversal detected",
            "portfolio_holding":  "You hold this stock",
        }[m["reason"]]
        color = C_GREEN if m["transaction_type"] == "buy" else C_RED
        action = "Buy" if m["transaction_type"] == "buy" else "Sell"
        # Filings only ever report a date, never a time of day — showing a
        # fabricated timestamp here would be showing something the source
        # filing itself doesn't contain.
        date_label = m["trade_date"].strftime("%b %d, %Y") if m["trade_date"] else "—"
        shares_label = f"{m['shares']:,.0f} sh" if m["shares"] is not None else None
        price_label = f"@ ${m['price_per_share']:,.2f}" if m["price_per_share"] else None
        detail_bits = " ".join(b for b in (shares_label, price_label) if b) or "—"
        rows += f"""
        <tr>
          <td style="padding:12px 8px;border-bottom:1px solid {C_BORDER};">
            <a href="{APP_URL}" style="color:{C_ACCENT};font-weight:700;text-decoration:none;font-size:14px;">{m['ticker']}</a><br>
            <span style="color:{C_TEXT_MUTED};font-size:12px;">{m['company_name']}</span>
          </td>
          <td style="padding:12px 8px;border-bottom:1px solid {C_BORDER};color:{C_TEXT_MUTED};font-size:12px;">{reason_label}</td>
          <td style="padding:12px 8px;border-bottom:1px solid {C_BORDER};font-size:12px;color:{C_TEXT_MUTED};">{m['insider_name']}{f'<br><span style="color:{C_TEXT_FAINT};">{m["insider_title"]}</span>' if m.get('insider_title') else ''}<br><span style="color:{C_TEXT_FAINT};">{date_label}</span></td>
          <td style="padding:12px 8px;border-bottom:1px solid {C_BORDER};font-size:12px;color:{color};font-weight:700;">{action}<br><span style="color:{C_TEXT_MUTED};font-weight:400;">{detail_bits}</span></td>
          <td style="padding:12px 8px;border-bottom:1px solid {C_BORDER};text-align:right;font-weight:700;color:{color};font-size:13px;white-space:nowrap;">{fmt_money(m['value'])}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Seli — alert</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:{C_BG};border-radius:12px;overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,{C_ACCENT} 0%,{C_ACCENT_STR} 60%,{C_AQUA} 100%);padding:20px 24px;">
    <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">Seli</span>
    <span style="color:rgba(255,255,255,0.85);font-size:13px;margin-left:8px;">Instant alert</span>
  </td></tr>
  <tr><td style="padding:20px 20px 8px;">
    <p style="font-size:14px;color:{C_TEXT};margin:0;">{n} of your instant alert{'s were' if n != 1 else ' was'} triggered:</p>
  </td></tr>
  <tr><td style="padding:0 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      {rows}
    </table>
  </td></tr>
  <tr><td style="padding:20px;">
    <a href="{APP_URL}" style="display:inline-block;background:{C_ACCENT};color:#ffffff;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;">Open Seli →</a>
  </td></tr>
  <tr><td style="padding:0 20px 20px;">
    <p style="color:{C_TEXT_FAINT};font-size:11px;margin:0;">
      You're getting this because you enabled instant alerts in Settings. Informational only, not financial advice or a recommendation to buy or sell anything.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""
    return subject, html


def main():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT f.accession_number, f.ticker, f.company_name, f.insider_name, f.insider_title,
               f.transaction_type, f.transaction_code, f.value, f.is_open_market,
               f.shares, f.price_per_share,
               COALESCE(f.transaction_date, f.filing_date) AS trade_date,
               (SELECT p.transaction_type FROM public.filings p
                WHERE p.insider_name = f.insider_name AND p.ticker = f.ticker
                  AND p.is_open_market = true
                  AND COALESCE(p.transaction_date, p.filing_date) < COALESCE(f.transaction_date, f.filing_date)
                ORDER BY COALESCE(p.transaction_date, p.filing_date) DESC LIMIT 1
               ) AS prior_type
        FROM public.filings f
        WHERE f.alerted_at IS NULL AND f.is_open_market = true
          -- Recency guard — the actual permanent fix for the backfill
          -- flood. alerted_at IS NULL only means "never been considered
          -- by this script," not "just happened" — a bulk historical
          -- insert (a backfill, a re-run, a data fix) creates rows with
          -- alerted_at NULL regardless of how old the trade itself is.
          -- Without this, "watchlist_ticker" and "followed_insider"
          -- alerts could fire on trades from a decade ago the moment
          -- they're inserted. 5 days covers the ingest workflow's own
          -- Tier D safety-net lookback (4 days) with a small buffer,
          -- while staying nowhere near old enough to let backfilled
          -- history through as if it just happened.
          AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - INTERVAL '5 days'
        ORDER BY COALESCE(f.transaction_date, f.filing_date)
        LIMIT %s
    """, (BATCH_LIMIT,))
    cols = [d.name for d in cur.description]
    new_filings = [dict(zip(cols, row)) for row in cur.fetchall()]

    if not new_filings:
        log.info("Nothing to do — no unprocessed filings.")
        cur.close(); conn.close(); return

    log.info(f"Checking {len(new_filings)} new filings against Pro users' alert preferences...")

    cur.execute("""
        SELECT p.clerk_user_id, p.email, p.instant_watchlist_ticker, p.instant_followed_insider,
               p.instant_high_conviction, p.instant_reversal,
               p.instant_min_value, p.instant_high_conviction_threshold
        FROM public.user_preferences p
        JOIN public.subscriptions s ON s.clerk_user_id = p.clerk_user_id
        WHERE s.status IN ('active','trialing')
          AND (p.instant_watchlist_ticker OR p.instant_followed_insider
               OR p.instant_high_conviction OR p.instant_reversal)
    """)
    ucols = [d.name for d in cur.description]
    users = [dict(zip(ucols, row)) for row in cur.fetchall()]

    if not users:
        log.info("No Pro users have any instant alert enabled — marking filings processed, nothing to send.")
        cur.execute("UPDATE public.filings SET alerted_at = now() WHERE accession_number = ANY(%s)",
                    ([f["accession_number"] for f in new_filings],))
        conn.commit(); cur.close(); conn.close(); return

    user_ids = [u["clerk_user_id"] for u in users]
    cur.execute("""
        SELECT clerk_user_id, item_type, item_value FROM public.user_watchlist
        WHERE clerk_user_id = ANY(%s)
    """, (user_ids,))
    watchlist_tickers = {}
    watchlist_insiders = {}
    for uid, item_type, item_value in cur.fetchall():
        target = watchlist_tickers if item_type == "ticker" else watchlist_insiders
        target.setdefault(uid, set()).add(item_value)

    # Real portfolio holdings for the new "ptfl has it" trigger — fetched
    # once per run, not once per user, since the Worker's endpoint already
    # returns everyone's holdings in a single batched call.
    portfolio_tickers = fetch_portfolio_tickers()

    per_user_matches: dict[str, list[dict]] = {}

    def add_match(uid, filing, reason):
        per_user_matches.setdefault(uid, []).append({**filing, "reason": reason})

    for f in new_filings:
        is_reversal = f["prior_type"] is not None and f["prior_type"] != f["transaction_type"]
        is_csuite_buy = (
            f["transaction_type"] == "buy"
            and f["value"] is not None
            and f["insider_title"] and CSUITE_TITLE_RE.search(f["insider_title"])
        )

        for u in users:
            uid = u["clerk_user_id"]
            min_value = u["instant_min_value"] or 0
            meets_min = f["value"] is not None and f["value"] >= min_value

            if u["instant_watchlist_ticker"] and meets_min and f["ticker"] in watchlist_tickers.get(uid, ()):
                add_match(uid, f, "watchlist_ticker")
            # Same toggle as watchlist_ticker, deliberately — "a ticker you
            # care about traded" is the same underlying idea whether it's
            # explicitly starred or actually sitting in a connected
            # brokerage account. A separate settings toggle would mean
            # another DB column, another Settings UI control, and another
            # thing for a user to have to know to turn on; this way it
            # just works the moment they connect a broker and already
            # have watchlist alerts on.
            if u["instant_watchlist_ticker"] and meets_min and f["ticker"] in portfolio_tickers.get(uid, ()):
                add_match(uid, f, "portfolio_holding")
            if u["instant_followed_insider"] and meets_min and f["insider_name"] in watchlist_insiders.get(uid, ()):
                add_match(uid, f, "followed_insider")
            hc_threshold = u["instant_high_conviction_threshold"] or 1_000_000
            if u["instant_high_conviction"] and is_csuite_buy and f["value"] >= hc_threshold:
                add_match(uid, f, "high_conviction")
            if u["instant_reversal"] and is_reversal and meets_min and f["ticker"] in watchlist_tickers.get(uid, ()):
                add_match(uid, f, "reversal")

    email_by_id = {u["clerk_user_id"]: u["email"] for u in users}

    # Per-filing delivery tracking — this is the actual fix for the earlier
    # bug. Previously every filing in a batch got marked alerted_at=now()
    # regardless of whether any individual send failed, so a transient
    # Resend issue could silently and permanently lose that user's alert —
    # the filing would never be looked at again. Now a filing with at
    # least one failed delivery stays unprocessed and gets reconsidered
    # next run. The tradeoff: a user who WAS successfully notified about
    # that same filing could get a duplicate on the retry. A duplicate is
    # a minor annoyance; a silently missed alert defeats the point of the
    # feature — worth the tradeoff.
    filing_failed = set()  # accession_numbers with at least one failed delivery this run
    expected_notifications = len(per_user_matches)  # one email owed per matching user
    sent = 0
    for uid, matches in per_user_matches.items():
        subject, html = build_email(email_by_id[uid], matches)
        if send_email(email_by_id[uid], subject, html):
            sent += 1
        else:
            for m in matches:
                filing_failed.add(m["accession_number"])

    safe_to_mark = [f["accession_number"] for f in new_filings if f["accession_number"] not in filing_failed]

    log.info(f"Sent {sent}/{expected_notifications} alert email(s) to {len(per_user_matches)} user(s), covering {len(new_filings)} filings.")
    if sent < expected_notifications:
        log.warning(f"  {expected_notifications - sent} email(s) failed even after retries — "
                    f"{len(filing_failed)} filing(s) left unprocessed and will be re-checked next run.")

    if safe_to_mark:
        cur.execute("UPDATE public.filings SET alerted_at = now() WHERE accession_number = ANY(%s)",
                    (safe_to_mark,))
        conn.commit()
    cur.close(); conn.close()
    log.info(f"Marked {len(safe_to_mark)}/{len(new_filings)} filings as alert-processed.")


if __name__ == "__main__":
    main()
