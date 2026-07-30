#!/usr/bin/env python3
"""
db/send_digests.py
Runs once daily (DIGEST_TYPE=daily) and once weekly (DIGEST_TYPE=weekly) as
separate scheduled steps. Pro-gated, same as instant alerts — matches the
Settings > Email digests tab's own "Upgrade to Pro to enable email digests."

Reads as a real newsletter now, not a single flat list — three sections,
each shown only when it has content:
  1. Insights              — top signals overall, respecting the user's
                              existing filters (source, min conviction, min
                              value)
  2. Movers in your Portfolio — activity on tickers the user actually holds,
                              via SnapTrade (fetched once per run through the
                              Worker's internal batch endpoint — portfolio
                              positions are never stored in this database,
                              only available live through SnapTrade, and
                              decryption of a user's connection secret stays
                              inside the Worker's own single audited path
                              rather than being duplicated here)
  3. Movers you follow      — activity on watchlisted tickers/insiders

Respects each user's own filters:
  - digest_watchlist_only   : when true, ONLY the "Movers you follow" section
                              is sent — skips Insights and Portfolio entirely,
                              preserving this setting's original, explicit
                              meaning rather than silently reinterpreting it
  - digest_congressional / digest_corporate : which filing sources to include
  - digest_min_conviction   : 'any' | 'medium' | 'high' — a simplified proxy
                              based on trade value + insider seniority, not
                              the full client-side conviction algorithm
  - digest_top_signals      : cap the email at the top N tickers by net BUY
                              value (fixed this run — was previously sorting
                              by absolute value, which ranked heavy selling
                              exactly as "top" as heavy buying, contradicting
                              this setting's own name and the app's own
                              buying-is-the-signal thesis throughout)

This is a simplified summary, not a re-implementation of the app's full
signal-clustering logic — good enough for an email digest, not meant to be
pixel-identical to the in-app Insights view.
"""
from __future__ import annotations
import os, sys, re, logging, requests
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL     = os.environ.get("DATABASE_URL", "")
RESEND_API_KEY   = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL       = os.environ.get("ALERTS_FROM_EMAIL", "alerts@mail.seli.app")
APP_URL          = os.environ.get("APP_URL", "https://seli.app")
DIGEST_TYPE      = os.environ.get("DIGEST_TYPE", "daily")  # 'daily' | 'weekly'
DRY_RUN          = os.environ.get("DRY_RUN", "false").lower() == "true"
WORKER_URL       = os.environ.get("WORKER_URL", "")
WORKER_API_KEY   = os.environ.get("WORKER_API_KEY", "")

if DIGEST_TYPE not in ("daily", "weekly"):
    log.error("DIGEST_TYPE must be 'daily' or 'weekly'"); sys.exit(1)
if not DATABASE_URL:
    log.error("DATABASE_URL required"); sys.exit(1)
if not RESEND_API_KEY and not DRY_RUN:
    log.error("RESEND_API_KEY required (or DRY_RUN=true)"); sys.exit(1)

CSUITE_TITLE_RE = re.compile(r"chief|ceo|cfo|coo|cto|president", re.I)
PERIOD_DAYS = 1 if DIGEST_TYPE == "daily" else 7
FROM_NAME = f"Seli - {'Daily' if DIGEST_TYPE == 'daily' else 'Weekly'} Digest"

# ── Brand colors — pulled directly from the app's own light-theme CSS
# variables (style.css), not invented separately for email. Using the LIGHT
# theme specifically: email clients default to a white background, and the
# previous version used the app's DARK-mode green/red/border values on an
# assumed-white background, which is why row borders were nearly invisible
# and the palette read as slightly off in real inboxes.
C_ACCENT       = "#5A4FE8"  # light-theme --accent
C_ACCENT_STR   = "#4338C9"  # light-theme --accent-strong
C_AQUA         = "#3FBFA0"  # a light-mode-legible shade of the brand aqua (#8BE8CF is a dark-background accent — too pale to read against white, darkened for contrast while staying the same hue)
C_GREEN        = "#15803D"  # light-theme --green-600
C_RED          = "#C0392B"  # light-theme --red-600
C_TEXT         = "#111827"
C_TEXT_MUTED   = "#6B7280"
C_TEXT_FAINT   = "#9CA3AF"
C_BORDER       = "#E5E7EB"  # a real light-mode border — the old #232A36 was a dark-mode value, nearly invisible on white
C_BG           = "#FFFFFF"
C_SECTION_BG   = "#F8F7FF"  # a very light purple tint for section headers


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
            json={"from": f"{FROM_NAME} <{FROM_EMAIL}>", "to": [to_email], "subject": subject, "html": html},
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
    sign = "-" if v < 0 else ""
    v = abs(v)
    for div, suf in [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")]:
        if v >= div: return f"{sign}${v/div:,.1f}{suf}"
    return f"{sign}${v:,.0f}"


def conviction_tier(rows_for_ticker) -> str:
    """Simplified proxy: any C-suite buy >= $1M = high, any buy >= $100K = medium, else low."""
    has_high = any(r["value"] and r["value"] >= 1_000_000 and r["insider_title"] and CSUITE_TITLE_RE.search(r["insider_title"]) for r in rows_for_ticker)
    if has_high: return "high"
    has_med = any(r["value"] and r["value"] >= 100_000 for r in rows_for_ticker)
    return "medium" if has_med else "low"

# Factual labels for the conviction proxy tiers — shown in the email body.
# These describe *what happened* (executive + dollar size) rather than
# implying a forward-looking assessment ("High conviction" reads as "this
# is a confident bet" — which is investment advice language).
TIER_LABELS = {
    "high":   "Executive · $1M+",
    "medium": "Open-market · $100K+",
    "low":    "Open-market",
}


def fetch_portfolio_tickers_by_user() -> dict[str, set[str]]:
    """One batch call to the Worker's internal endpoint, covering every Pro
    user with a linked SnapTrade account — not a per-user call. Decryption
    of each user's connection secret happens entirely inside the Worker's
    own single audited path (getSnapTradeConnection); this script never
    touches encrypted secrets or decryption keys directly. Best-effort: if
    the Worker call fails for any reason, the digest still sends without the
    portfolio section rather than blocking the whole run."""
    if not WORKER_URL or not WORKER_API_KEY:
        log.info("WORKER_URL/WORKER_API_KEY not set — skipping 'Movers in your Portfolio' section for this run.")
        return {}
    try:
        r = requests.get(
            f"{WORKER_URL}/internal/portfolio-tickers-batch",
            headers={"X-API-Key": WORKER_API_KEY},
            timeout=60,  # this call fans out to SnapTrade per linked user server-side, can be slow
        )
        if not r.ok:
            log.error(f"portfolio-tickers-batch failed: {r.status_code} {r.text[:200]}")
            return {}
        data = r.json().get("tickers_by_user", {})
        return {uid: set(tickers) for uid, tickers in data.items()}
    except Exception as e:
        log.error(f"portfolio-tickers-batch request failed: {e}")
        return {}


def build_ticker_card(t: dict) -> str:
    """Single-column stacked card per ticker — renders identically on any
    viewport width. No multi-column table rows that squeeze on mobile."""
    color = C_GREEN if t["net_value"] >= 0 else C_RED
    tier_label = TIER_LABELS.get(t["tier"], "Open-market")
    return f"""
    <tr><td style="padding:0 0 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid {C_BORDER};border-radius:8px;overflow:hidden;">
        <tr><td style="padding:14px 16px;">
          <!--[if mso]><table width="100%"><tr><td width="70%"><![endif]-->
          <div style="display:inline-block;vertical-align:top;width:65%;">
            <a href="{APP_URL}" style="color:{C_ACCENT};font-weight:700;text-decoration:none;font-size:15px;line-height:1.3;">{t['ticker']}</a>
            <div style="color:{C_TEXT_MUTED};font-size:12px;line-height:1.4;margin-top:2px;">{t['company']}</div>
          </div>
          <!--[if mso]></td><td width="30%" align="right"><![endif]-->
          <div style="display:inline-block;vertical-align:top;width:30%;text-align:right;">
            <div style="color:{color};font-weight:700;font-size:15px;line-height:1.3;">{fmt_money(t['net_value'])}</div>
          </div>
          <!--[if mso]></td></tr></table><![endif]-->
          <div style="margin-top:8px;font-size:12px;color:{C_TEXT_MUTED};line-height:1.4;">
            {tier_label} &middot; {t['insider_count']} insider{'s' if t['insider_count'] != 1 else ''}
          </div>
        </td></tr>
      </table>
    </td></tr>"""


def build_section(title: str, subtitle: str, tickers: list[dict]) -> str:
    if not tickers:
        return ""
    cards = "".join(build_ticker_card(t) for t in tickers)
    return f"""
    <tr><td style="padding:20px 0 8px;">
      <div style="background:{C_SECTION_BG};border-radius:8px;padding:12px 16px;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:700;color:{C_ACCENT_STR};text-transform:uppercase;letter-spacing:0.04em;">{title}</div>
        <div style="font-size:12px;color:{C_TEXT_MUTED};margin-top:2px;">{subtitle}</div>
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        {cards}
      </table>
    </td></tr>"""


def build_digest_html(period_label: str, insights: list[dict], portfolio_movers: list[dict], watchlist_movers: list[dict], watchlist_only: bool) -> str:
    total = len(insights) + len(portfolio_movers) + len(watchlist_movers)
    day_or_week = period_label.replace('daily','day').replace('weekly','week')
    sections = ""
    if not watchlist_only:
        sections += build_section("Insider activity", f"Open-market trades filed in the past {day_or_week}", insights)
        sections += build_section("In your portfolio", "Insider trades on tickers you hold", portfolio_movers)
    sections += build_section("On your watchlist", "Insider trades on tickers you follow", watchlist_movers)

    # Preheader — hidden text that appears in the inbox preview line (Gmail,
    # Apple Mail, Outlook) before the user opens the email. Without this,
    # clients fall back to the first visible body text, which is usually the
    # section header ("INSIDER ACTIVITY") — not useful as a preview.
    preheader = f"{total} ticker{'s' if total!=1 else ''} with insider activity this {day_or_week}."
    # Pad with invisible whitespace so clients don't pull in body text after
    # the preheader to fill the preview line.
    preheader_pad = "&nbsp;&zwnj;" * 80

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Seli — {period_label} digest</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<!--[if mso]><style>table,td{{font-family:Arial,sans-serif;}}</style><![endif]-->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{preheader}{preheader_pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:{C_BG};border-radius:12px;overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,{C_ACCENT} 0%,{C_ACCENT_STR} 60%,{C_AQUA} 100%);padding:20px 24px;">
    <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.02em;">Seli</span>
    <span style="color:rgba(255,255,255,0.85);font-size:13px;margin-left:8px;">{period_label.capitalize()} digest</span>
  </td></tr>
  <tr><td style="padding:20px 20px 4px;">
    <p style="font-size:14px;color:{C_TEXT};margin:0;">{total} ticker{'s' if total!=1 else ''} with insider activity this {day_or_week}:</p>
  </td></tr>
  <tr><td style="padding:0 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      {sections}
    </table>
  </td></tr>
  <tr><td style="padding:20px;">
    <a href="{APP_URL}" style="display:inline-block;background:{C_ACCENT};color:#ffffff;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Open Seli →</a>
  </td></tr>
  <tr><td style="padding:0 20px 20px;">
    <p style="color:{C_TEXT_FAINT};font-size:11px;line-height:1.5;margin:0 0 6px;">
      You're getting this because you enabled the {period_label} digest in Settings.
      This is a factual summary of publicly filed insider trading disclosures, not financial advice or a recommendation to buy or sell any security.
    </p>
    <p style="color:{C_TEXT_FAINT};font-size:11px;line-height:1.5;margin:0;">
      <a href="{APP_URL}/settings?section=notifications" style="color:{C_TEXT_MUTED};">Manage email preferences</a>
      — turn off just this digest, or turn off every Seli email (digests and instant alerts) from the same page.
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


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

    portfolio_tickers_by_user = fetch_portfolio_tickers_by_user()

    period_label = "daily" if DIGEST_TYPE == "daily" else "weekly"
    sent = 0

    def apply_shared_filters(rows, u):
        if not u["digest_congressional"]:
            rows = [r for r in rows if not (r["transaction_code"] or "").startswith("CONGRESS")]
        if not u["digest_corporate"]:
            rows = [r for r in rows if (r["transaction_code"] or "").startswith("CONGRESS")]
        return rows

    def build_ticker_list(rows, u, cap_applies=True):
        by_ticker = defaultdict(list)
        for r in rows:
            by_ticker[r["ticker"]].append(r)
        tickers = []
        for ticker, trs in by_ticker.items():
            net = sum((t["value"] or 0) if t["transaction_type"] == "buy" else -(t["value"] or 0) for t in trs)
            tier = conviction_tier(trs)
            if u["digest_min_conviction"] == "high" and tier != "high": continue
            if u["digest_min_conviction"] == "medium" and tier == "low": continue
            if u["digest_min_value"] and max((t["value"] or 0) for t in trs) < u["digest_min_value"]: continue
            tickers.append({
                "ticker": ticker, "company": trs[0]["company_name"],
                "tier": tier, "insider_count": len({t["insider_name"] for t in trs}),
                "net_value": net,
            })
        tickers.sort(key=lambda t: t["net_value"], reverse=True)
        if cap_applies:
            cap = u.get("digest_max_signals") or 0
            if cap > 0:
                tickers = tickers[:cap]
        return tickers

    for u in users:
        base_rows = apply_shared_filters(period_filings, u)

        watchlist_rows = []
        cur.execute("SELECT item_value FROM public.user_watchlist WHERE clerk_user_id = %s AND item_type = 'ticker'", (u["clerk_user_id"],))
        watched = {r[0] for r in cur.fetchall()}
        if watched:
            watchlist_rows = [r for r in base_rows if r["ticker"] in watched]

        portfolio_rows = []
        held = portfolio_tickers_by_user.get(u["clerk_user_id"])
        if held:
            portfolio_rows = [r for r in base_rows if r["ticker"] in held]

        insights = build_ticker_list(base_rows, u) if not u["digest_watchlist_only"] else []
        portfolio_movers = build_ticker_list(portfolio_rows, u, cap_applies=False) if not u["digest_watchlist_only"] else []
        watchlist_movers = build_ticker_list(watchlist_rows, u, cap_applies=False)

        if u["digest_watchlist_only"] and not watched:
            continue

        total = len(insights) + len(portfolio_movers) + len(watchlist_movers)
        if total == 0:
            continue

        html = build_digest_html(period_label, insights, portfolio_movers, watchlist_movers, u["digest_watchlist_only"])
        subject = f"Your {period_label} digest — {total} ticker{'s' if total!=1 else ''} with insider activity"
        if send_email(u["email"], subject, html):
            sent += 1

    conn.close()
    log.info(f"Sent {sent} {DIGEST_TYPE} digest email(s) out of {len(users)} subscribed user(s).")


if __name__ == "__main__":
    main()
