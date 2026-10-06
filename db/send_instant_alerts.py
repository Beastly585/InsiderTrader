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

# Rendering and sending go through email_kit, same as the digests and the
# welcome email: same look, plain-text part, one-click unsubscribe header,
# mailing address in the footer, and retries on 429/5xx.
import email_kit as ek

REASON_LABEL = {
    "watchlist_ticker":  "Stock you watch",
    "portfolio_holding": "In your portfolio",
    "followed_insider":  "Person you follow",
    "high_conviction":   "Large executive buy",
    "reversal":          "Direction change",
}
# When one trade matches several settings, show the most specific reason first.
REASON_ORDER = ["portfolio_holding", "followed_insider", "watchlist_ticker", "reversal", "high_conviction"]


def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


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


def get_insider_context(conn, insider_name: str, ticker: str, trade_date) -> str:
    """Generate a one-line factual context about this trade.
    No predictions, no recommendations — just what's observable in the filing history."""
    cur = conn.cursor()
    try:
        # How many trades has this insider made on this ticker?
        cur.execute("""
            SELECT COUNT(*),
                   MIN(COALESCE(transaction_date, filing_date)),
                   MAX(COALESCE(transaction_date, filing_date))
            FROM public.filings
            WHERE insider_name = %s AND ticker = %s AND is_open_market = true
        """, (insider_name, ticker))
        total, first_date, last_date = cur.fetchone()

        # Last trade before this one
        cur.execute("""
            SELECT transaction_type, COALESCE(transaction_date, filing_date)
            FROM public.filings
            WHERE insider_name = %s AND ticker = %s AND is_open_market = true
              AND COALESCE(transaction_date, filing_date) < %s
            ORDER BY COALESCE(transaction_date, filing_date) DESC LIMIT 1
        """, (insider_name, ticker, trade_date))
        prev = cur.fetchone()

        # How many OTHER insiders traded this ticker in the last 7 days?
        cur.execute("""
            SELECT COUNT(DISTINCT insider_name)
            FROM public.filings
            WHERE ticker = %s AND is_open_market = true
              AND COALESCE(transaction_date, filing_date) >= %s - INTERVAL '7 days'
              AND insider_name != %s
        """, (ticker, trade_date, insider_name))
        cluster_count = cur.fetchone()[0]

        # Build context line
        parts = []
        if prev:
            prev_type, prev_date = prev
            months_gap = max(1, (trade_date - prev_date).days // 30) if trade_date and prev_date else None
            if months_gap and months_gap >= 6:
                parts.append(f"First open-market trade in {months_gap} months")
        elif total <= 1:
            parts.append("First recorded open-market trade on this ticker")

        if cluster_count >= 2:
            parts.append(f"{cluster_count + 1} insiders trading this week")

        if total and total >= 5:
            parts.append(f"{total} total trades on record")

        return " · ".join(parts) if parts else ""
    except Exception:
        return ""


def is_congress(m: dict) -> bool:
    return str(m.get("transaction_code") or "").upper().startswith("CONGRESS")


def build_email(conn, clerk_user_id: str, matches: list[dict]) -> tuple[str, str]:
    """One email per user per run. matches are already de-duplicated: one entry
    per trade, with every reason it matched in m["reasons"]."""
    n = len(matches)
    first = matches[0]
    who0 = ek.pretty_person(first["insider_name"], is_congress(first))
    if n == 1:
        verb = "bought" if first["transaction_type"] == "buy" else "sold"
        subject = f"{first['ticker']}: {who0} {verb} {ek.amount(first['value'], is_congress(first))}"
    else:
        tickers = list(dict.fromkeys(m["ticker"] for m in matches))
        subject = f"{n} new insider trades: " + ", ".join(tickers[:3]) + (f" +{len(tickers) - 3}" if len(tickers) > 3 else "")

    cards = ""
    for m in matches:
        cg = is_congress(m)
        buy = m["transaction_type"] == "buy"
        who = ek.pretty_person(m["insider_name"], cg)
        role = "Member of Congress" if cg else ek.short_role(m.get("insider_title"))
        company = ek.pretty_company(m.get("company_name")) or m["ticker"]
        amount = ek.amount(m["value"], cg)
        stock_href = ek.track(ek.ticker_path(m["ticker"]), "alert", m["ticker"])
        person_href = ek.track(ek.insider_path(m["insider_name"]), "alert", "person")
        bits = [ek.short_date(m["trade_date"])]
        if not cg and m.get("shares"):
            bits.append(f"{m['shares']:,.0f} shares" + (f" at ${m['price_per_share']:,.2f}" if m.get("price_per_share") else ""))
        context = get_insider_context(conn, m["insider_name"], m["ticker"], m["trade_date"])
        reasons = "".join(ek.chip(REASON_LABEL[r], "accent") for r in m["reasons"])
        inner = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="vertical-align:top;">{ek.ticker_tag(m["ticker"], stock_href)}'
            f'<span style="font-family:{ek.FONT};font-size:14px;font-weight:700;color:{ek.TEXT};margin-left:8px;">{ek.esc(company)}</span></td>'
            f'<td style="vertical-align:top;text-align:right;white-space:nowrap;">{ek.chip(("Buy " if buy else "Sell ") + amount, "buy" if buy else "sell")}</td>'
            '</tr></table>'
            + ek.p(f'{ek.a(person_href, ek.esc(who), ek.TEXT, 700)} <span style="color:{ek.MUTED};">· {ek.esc(role)}</span>', 14, ek.TEXT_2, "10px 0 2px")
            + ek.p(ek.esc(" · ".join(bits)), 12, ek.MUTED, "0 0 8px")
            + (ek.p(ek.esc(context), 12.5, ek.TEXT_2, "0 0 8px") if context else "")
            + f'<div>{reasons}</div>'
        )
        cards += ek.card(inner, accent_left=ek.ACCENT if "portfolio_holding" in m["reasons"] else "")

    body = (ek.section(ek.esc(f"{n} new insider trade{'s' if n != 1 else ''} matched your alerts"),
                       cards, pad_top=22)
            + f'<tr><td class="px" style="padding:8px 28px 0;">{ek.button("Open Seli", ek.track("/", "alert", "cta"))}</td></tr>')
    html_doc = ek.shell(
        title="Seli alert", label="Alert",
        preheader=f"{who0} and {n - 1} more" if n > 1 else f"{who0}, {ek.short_date(first['trade_date'])}",
        body_rows=body,
        footer_html=ek.footer(reason="You're getting this because instant alerts are on in your Seli settings.",
                              clerk_user_id=clerk_user_id, unsub_kind="alerts"),
    )
    return subject, html_doc


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

    # One card per trade per user, even when it matches several settings
    # (a watched ticker you also hold used to appear twice in one email).
    seen: dict[tuple, dict] = {}

    def add_match(uid, filing, reason):
        key = (uid, filing["accession_number"], filing["ticker"], filing["transaction_type"],
               filing["trade_date"], filing.get("shares"), filing.get("value"))
        if key in seen:
            if reason not in seen[key]["reasons"]:
                seen[key]["reasons"].append(reason)
                seen[key]["reasons"].sort(key=REASON_ORDER.index)
            return
        m = {**filing, "reasons": [reason]}
        seen[key] = m
        per_user_matches.setdefault(uid, []).append(m)

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
        if not email_by_id.get(uid):
            continue
        matches.sort(key=lambda m: (m["trade_date"] or datetime.min.date(), m["value"] or 0), reverse=True)
        subject, html_doc = build_email(conn, uid, matches)
        if ek.send(to_email=email_by_id[uid], subject=subject, html_doc=html_doc, from_name="Seli Alerts",
                   clerk_user_id=uid, kind="instant_alert", unsub_kind="alerts"):
            sent += 1
        else:
            for m in matches:
                filing_failed.add(m["accession_number"])

    safe_to_mark = [f["accession_number"] for f in new_filings if f["accession_number"] not in filing_failed]

    log.info(f"Sent {sent}/{expected_notifications} alert email(s) to {len(per_user_matches)} user(s), covering {len(new_filings)} filings.")
    if sent < expected_notifications:
        log.warning(f"  {expected_notifications - sent} email(s) failed even after retries — "
                    f"{len(filing_failed)} filing(s) left unprocessed and will be re-checked next run.")

    if ek.DRY_RUN:
        log.info("DRY RUN: not marking filings as alerted, so a real run still sends them.")
        safe_to_mark = []
    if safe_to_mark:
        cur.execute("UPDATE public.filings SET alerted_at = now() WHERE accession_number = ANY(%s)",
                    (safe_to_mark,))
        conn.commit()
    cur.close(); conn.close()
    log.info(f"Marked {len(safe_to_mark)}/{len(new_filings)} filings as alert-processed.")


if __name__ == "__main__":
    main()
