#!/usr/bin/env python3
"""
db/send_digests.py
Runs once daily (DIGEST_TYPE=daily) and once weekly (DIGEST_TYPE=weekly) as
separate scheduled steps. Pro-gated, same as instant alerts — matches the
Settings > Email digests tab's own "Upgrade to Pro to enable email digests."

Respects each user's own filters:
  - digest_watchlist_only   : restrict to their watchlist tickers only
  - digest_congressional / digest_corporate : which filing sources to include
  - digest_min_conviction   : 'any' | 'medium' | 'high' — a simplified proxy
                              based on trade value + insider seniority, not
                              the full client-side conviction algorithm
  - digest_top_signals      : cap the email at the top N tickers by net buy
                              value, rather than listing every single trade

This is a simplified summary, not a re-implementation of the app's full
signal-clustering logic — good enough for an email digest, not meant to be
pixel-identical to the in-app Insights view.
"""
from __future__ import annotations
import os, sys, re, logging, requests
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL   = os.environ.get("DATABASE_URL", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL     = os.environ.get("ALERTS_FROM_EMAIL", "alerts@mail.seli.app")
APP_URL        = os.environ.get("APP_URL", "https://seli.app")
DIGEST_TYPE    = os.environ.get("DIGEST_TYPE", "daily")  # 'daily' | 'weekly'
DRY_RUN        = os.environ.get("DRY_RUN", "false").lower() == "true"

if DIGEST_TYPE not in ("daily", "weekly"):
    log.error("DIGEST_TYPE must be 'daily' or 'weekly'"); sys.exit(1)
if not DATABASE_URL:
    log.error("DATABASE_URL required"); sys.exit(1)
if not RESEND_API_KEY and not DRY_RUN:
    log.error("RESEND_API_KEY required (or DRY_RUN=true)"); sys.exit(1)

CSUITE_TITLE_RE = re.compile(r"chief|ceo|cfo|coo|cto|president", re.I)
PERIOD_DAYS = 1 if DIGEST_TYPE == "daily" else 7


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


def send_email(to_email, subject, html) -> bool:
    if DRY_RUN:
        log.info(f"  [DRY RUN] would send to {to_email}: {subject}")
        return True
    try:
        r = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
            json={"from": FROM_EMAIL, "to": [to_email], "subject": subject, "html": html},
            timeout=15,
        )
        if not r.ok:
            log.error(f"  Resend error for {to_email}: {r.status_code} {r.text[:200]}")
            return False
        return True
    except Exception as e:
        log.error(f"  Send failed for {to_email}: {e}")
        return False


def fmt_money(v):
    if v is None: return "—"
    v = float(v)
    for div, suf in [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")]:
        if abs(v) >= div: return f"${v/div:,.1f}{suf}"
    return f"${v:,.0f}"


def conviction_tier(rows_for_ticker) -> str:
    """Simplified proxy: any C-suite buy >= $1M = high, any buy >= $100K = medium, else low."""
    has_high = any(r["value"] and r["value"] >= 1_000_000 and r["insider_title"] and CSUITE_TITLE_RE.search(r["insider_title"]) for r in rows_for_ticker)
    if has_high: return "high"
    has_med = any(r["value"] and r["value"] >= 100_000 for r in rows_for_ticker)
    return "medium" if has_med else "low"


def build_digest_html(period_label: str, tickers: list[dict]) -> str:
    rows = ""
    for t in tickers:
        color = "#22D3A5" if t["net_value"] >= 0 else "#ef4444"
        rows += f"""
        <tr style="border-bottom:1px solid #232A36;">
          <td style="padding:10px 8px;"><a href="{APP_URL}" style="color:#7C6FFF;font-weight:700;text-decoration:none;">{t['ticker']}</a><br>
              <span style="color:#8B95A5;font-size:12px;">{t['company']}</span></td>
          <td style="padding:10px 8px;color:#8B95A5;font-size:12px;text-transform:capitalize;">{t['tier']}</td>
          <td style="padding:10px 8px;font-size:12px;">{t['insider_count']} insider{'s' if t['insider_count'] != 1 else ''}</td>
          <td style="padding:10px 8px;text-align:right;font-weight:600;color:{color};">{fmt_money(t['net_value'])}</td>
        </tr>"""
    return f"""
    <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
      <p style="font-size:14px;">Your {period_label} insider trading digest — {len(tickers)} ticker{'s' if len(tickers)!=1 else ''} with notable activity:</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        {rows}
      </table>
      <p style="margin-top:20px;"><a href="{APP_URL}" style="color:#7C6FFF;">Open Seli →</a></p>
      <p style="color:#8B95A5;font-size:11px;margin-top:24px;">
        You're getting this because you enabled the {period_label} digest in Settings. Not financial advice.
      </p>
    </div>"""


def main():
    conn = get_connection()
    cur = conn.cursor()

    freq_col = "daily_digest" if DIGEST_TYPE == "daily" else "weekly_digest"
    cur.execute(f"""
        SELECT p.clerk_user_id, p.email, p.digest_top_signals, p.digest_congressional,
               p.digest_corporate, p.digest_watchlist_only, p.digest_min_conviction,
               p.digest_max_signals, p.digest_min_value
        FROM public.user_preferences p
        JOIN public.subscriptions s ON s.clerk_user_id = p.clerk_user_id
        WHERE s.status IN ('active','trialing') AND p.{freq_col} = true
    """)
    ucols = [d.name for d in cur.description]
    users = [dict(zip(ucols, row)) for row in cur.fetchall()]

    if not users:
        log.info(f"No users subscribed to the {DIGEST_TYPE} digest — nothing to do.")
        cur.close(); conn.close(); return

    log.info(f"Building {DIGEST_TYPE} digest for {len(users)} user(s)...")

    # Pull the period's raw open-market filings once, filter/aggregate per
    # user in Python — cheaper than N separate queries for a modest user count.
    cur.execute("""
        SELECT ticker, company_name, insider_name, insider_title, transaction_type,
               value, transaction_code
        FROM public.filings
        WHERE is_open_market = true
          AND COALESCE(transaction_date, filing_date) >= CURRENT_DATE - %s
    """, (PERIOD_DAYS,))
    fcols = [d.name for d in cur.description]
    period_filings = [dict(zip(fcols, row)) for row in cur.fetchall()]

    if not period_filings:
        log.info("No filings in this period — skipping send for all users.")
        cur.close(); conn.close(); return

    period_label = "daily" if DIGEST_TYPE == "daily" else "weekly"
    sent = 0

    for u in users:
        rows = period_filings
        if u["digest_watchlist_only"]:
            cur.execute("SELECT item_value FROM public.user_watchlist WHERE clerk_user_id = %s AND item_type = 'ticker'", (u["clerk_user_id"],))
            watched = {r[0] for r in cur.fetchall()}
            if not watched:
                continue  # opted into watchlist-only but has nothing watched — nothing to send
            rows = [r for r in rows if r["ticker"] in watched]

        if not u["digest_congressional"]:
            rows = [r for r in rows if not (r["transaction_code"] or "").startswith("CONGRESS")]
        if not u["digest_corporate"]:
            rows = [r for r in rows if (r["transaction_code"] or "").startswith("CONGRESS")]

        by_ticker = defaultdict(list)
        for r in rows:
            by_ticker[r["ticker"]].append(r)

        tickers = []
        for ticker, trs in by_ticker.items():
            net = sum((t["value"] or 0) if t["transaction_type"] == "buy" else -(t["value"] or 0) for t in trs)
            tier = conviction_tier(trs)
            if u["digest_min_conviction"] == "high" and tier != "high": continue
            if u["digest_min_conviction"] == "medium" and tier == "low": continue
            # Minimum trade value filter — 0 means no minimum (matches the UI's "Any amount")
            if u["digest_min_value"] and max((t["value"] or 0) for t in trs) < u["digest_min_value"]: continue
            tickers.append({
                "ticker": ticker, "company": trs[0]["company_name"],
                "tier": tier, "insider_count": len({t["insider_name"] for t in trs}),
                "net_value": net,
            })

        if not tickers:
            continue  # nothing matched this user's filters this period

        tickers.sort(key=lambda t: abs(t["net_value"]), reverse=True)
        # digest_max_signals: 0 (or unset) means unlimited — otherwise cap at
        # the user's chosen number, replacing the old fixed-at-10 boolean.
        cap = u.get("digest_max_signals") or 0
        if cap > 0:
            tickers = tickers[:cap]

        html = build_digest_html(period_label, tickers)
        subject = f"Your {period_label} digest — {len(tickers)} ticker{'s' if len(tickers)!=1 else ''} to know about"
        if send_email(u["email"], subject, html):
            sent += 1

    conn.close()
    log.info(f"Sent {sent} {DIGEST_TYPE} digest email(s) out of {len(users)} subscribed user(s).")


if __name__ == "__main__":
    main()
