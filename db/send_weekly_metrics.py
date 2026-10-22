#!/usr/bin/env python3
"""
db/send_weekly_metrics.py
A short Sunday-evening email to you (not to users) with how Seli did this
week: signups and how many actually picked a stock, Pro, money in, emails
sent, and whether the ingest kept up. Runs after the weekly digest in
.github/workflows/emails.yml.

Each number is "this week" (the last 7 days) next to "last week" (the 7 days
before). A query that fails (a table that isn't there yet) shows "n/a" and the
rest of the email still goes out. It skips if one already went out in the last
5 days, so the Monday catch-up run can't send a second.

  python send_weekly_metrics.py
  DRY_RUN=true PREVIEW_DIR=out python send_weekly_metrics.py   # write HTML, don't send

Env:
  OPS_EMAIL   where it goes (falls back to NOTIFY_EMAIL, then WELCOME_REPLY_TO)
"""
from __future__ import annotations

import json
import logging
import os
import sys

import email_kit as ek

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

TO = (os.environ.get("OPS_EMAIL") or os.environ.get("NOTIFY_EMAIL") or os.environ.get("WELCOME_REPLY_TO") or "").strip()
PRO_PRICE = 6.99
KIND = "ops_metrics"   # email_log kind; clerk_user_id is "ops" for these rows


def one(conn, sql: str, params=None):
    """First column of the first row, or None if the query fails."""
    try:
        cur = conn.cursor()
        cur.execute(sql, params or {})
        r = cur.fetchone()
        cur.close()
        return r[0] if r else None
    except Exception as e:
        log.warning(f"  query failed ({str(e).splitlines()[0][:120]})")
        conn.rollback()
        return None


def rows(conn, sql: str, params=None) -> list:
    try:
        cur = conn.cursor()
        cur.execute(sql, params or {})
        out = cur.fetchall()
        cur.close()
        return out
    except Exception as e:
        log.warning(f"  query failed ({str(e).splitlines()[0][:120]})")
        conn.rollback()
        return []


# Every weekly number takes a window: %(a)s days ago up to %(b)s days ago.
W = "BETWEEN now() - make_interval(days => %(a)s) AND now() - make_interval(days => %(b)s)"
# Same windows on a date column (filing dates have no time of day).
DW = "> CURRENT_DATE - %(a)s AND filing_date <= CURRENT_DATE - %(b)s"
THIS, LAST = {"a": 7, "b": 0}, {"a": 14, "b": 7}

WEEKLY = [
    # (section, label, sql)
    ("People", "New signups", f"SELECT count(*) FROM public.user_preferences WHERE signed_up_at {W}"),
    ("People", "...who picked at least one stock or person",
     f"""SELECT count(*) FROM public.user_preferences p WHERE p.signed_up_at {W}
          AND EXISTS (SELECT 1 FROM public.user_watchlist w WHERE w.clerk_user_id = p.clerk_user_id)"""),
    ("People", "...who finished or skipped onboarding", f"SELECT count(*) FROM public.user_preferences WHERE signed_up_at {W} AND onboarded_at IS NOT NULL"),
    ("People", "Unsubscribed from email", f"SELECT count(*) FROM public.user_preferences WHERE email_unsubscribed_at {W}"),
    ("Money", "Pro checkouts that didn't go through",
     f"SELECT count(*) FROM public.subscriptions WHERE status IN ('incomplete', 'incomplete_expired') AND updated_at {W}"),
    ("Money", "Pro cancellations (scheduled)",
     f"SELECT count(*) FROM public.subscriptions WHERE cancel_at_period_end IS TRUE AND updated_at {W}"),
    ("Money", "Dataset purchases", f"SELECT count(*) FROM public.data_purchases WHERE purchased_at {W}"),
    ("Money", "Dataset revenue", f"SELECT COALESCE(sum(amount_cents), 0) / 100.0 FROM public.data_purchases WHERE purchased_at {W}"),
    ("Data", "Form 4 filings added", f"SELECT count(DISTINCT accession_number) FROM public.filings WHERE filing_date {DW} AND COALESCE(transaction_code, '') NOT LIKE 'CONGRESS%%'"),
    ("Data", "Congress trades added", f"SELECT count(*) FROM public.filings WHERE filing_date {DW} AND transaction_code LIKE 'CONGRESS%%'"),
    ("Data", "Ingest runs", f"SELECT count(*) FROM public.ingest_runs WHERE finished_at {W}"),
    ("Data", "...incomplete runs", f"SELECT count(*) FROM public.ingest_runs WHERE NOT ok AND finished_at {W}"),
]

# Right now, no week-over-week.
NOW = [
    ("People", "Accounts", "SELECT count(*) FROM public.user_preferences"),
    ("People", "Accounts watching something", "SELECT count(DISTINCT clerk_user_id) FROM public.user_watchlist"),
    ("Money", "Paying Pro subscribers",
     "SELECT count(*) FROM public.subscriptions WHERE plan = 'pro' AND status IN ('active', 'trialing') AND stripe_subscription_id IS NOT NULL"),
    ("Money", "Free Pro (comped) accounts",
     "SELECT count(*) FROM public.subscriptions WHERE plan = 'pro' AND status IN ('active', 'trialing') AND stripe_subscription_id IS NULL"),
    ("Data", "Last complete ingest run", "SELECT to_char(max(finished_at) AT TIME ZONE 'America/New_York', 'Dy Mon DD, HH12:MI AM \"ET\"') FROM public.ingest_runs WHERE ok"),
    ("Data", "Newest Form 4 filing date", "SELECT to_char(max(filing_date), 'Dy Mon DD') FROM public.filings WHERE filing_date <= CURRENT_DATE AND filing_date >= CURRENT_DATE - 30 AND COALESCE(transaction_code, '') NOT LIKE 'CONGRESS%%'"),
]


def fmt(v, label: str) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, str):
        return v
    if "revenue" in label.lower() or label.startswith("MRR"):
        return f"${float(v):,.2f}"
    return f"{int(v):,}"


# Numbers where going up is bad news (shown red when they rise).
UP_IS_BAD = {"Unsubscribed from email", "Pro checkouts that didn't go through", "Pro cancellations (scheduled)", "...incomplete runs"}


def delta(a, b, label: str = "") -> str:
    try:
        d = float(a) - float(b)
    except (TypeError, ValueError):
        return ""
    if d == 0:
        return ""
    good = (d > 0) != (label in UP_IS_BAD)
    money = "revenue" in label.lower()
    amount = f"${abs(d):,.2f}" if money else f"{abs(d):,.0f}"
    return f'<span style="color:{ek.GREEN if good else ek.RED};font-size:12px;margin-left:6px;">{"+" if d > 0 else "−"}{amount}</span>'


def table(rows_html: str) -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;">'
            f'<tr><td></td><td style="text-align:right;font-family:{ek.FONT};font-size:11px;color:{ek.MUTED};padding:0 0 6px;">This week</td>'
            f'<td style="text-align:right;font-family:{ek.FONT};font-size:11px;color:{ek.MUTED};padding:0 0 6px 14px;">Last week</td></tr>'
            f'{rows_html}</table>')


def row(label: str, a: str, b: str = "", extra: str = "") -> str:
    td = f'font-family:{ek.FONT};font-size:14px;padding:7px 0;border-top:1px solid {ek.BORDER};'
    sub = label.startswith("...")
    return (f'<tr><td style="{td}color:{ek.MUTED if sub else ek.TEXT_2};{"padding-left:12px;" if sub else ""}">{ek.esc(label)}</td>'
            f'<td style="{td}text-align:right;color:{ek.TEXT};font-weight:600;white-space:nowrap;">{a}{extra}</td>'
            f'<td style="{td}text-align:right;color:{ek.MUTED};white-space:nowrap;padding-left:14px;">{b}</td></tr>')


def main():
    if not os.environ.get("DATABASE_URL"):
        log.error("DATABASE_URL required"); sys.exit(1)
    if not TO:
        log.error("Set OPS_EMAIL (or NOTIFY_EMAIL) to where this should go."); sys.exit(1)
    conn = ek.get_connection()
    if not ek.DRY_RUN and ek.log_ready(conn) and ek.cooldown(conn, "ops", KIND, 5):
        log.info("Weekly numbers already went out in the last 5 days."); conn.close(); return

    sections: dict[str, str] = {}
    snapshot = {}
    for sec, label, sql in WEEKLY:
        a, b = one(conn, sql, THIS), one(conn, sql, LAST)
        snapshot[label] = None if a is None else float(a)
        sections[sec] = sections.get(sec, "") + row(label, fmt(a, label), fmt(b, label), delta(a, b, label))
    now_rows: dict[str, str] = {}
    for sec, label, sql in NOW:
        v = one(conn, sql)
        snapshot[label] = v if isinstance(v, str) or v is None else float(v)
        now_rows[sec] = now_rows.get(sec, "") + row(label, fmt(v, label))
    paying = snapshot.get("Paying Pro subscribers")
    if isinstance(paying, float):
        now_rows["Money"] += row("MRR (paying Pro × $6.99)", fmt(paying * PRO_PRICE, "MRR"))

    # Emails sent, by kind.
    sent = rows(conn, """SELECT kind, count(*) FILTER (WHERE sent_at > now() - interval '7 days'),
                                count(*) FILTER (WHERE sent_at BETWEEN now() - interval '14 days' AND now() - interval '7 days')
                           FROM public.email_log WHERE sent_at > now() - interval '14 days' AND clerk_user_id <> 'ops'
                          GROUP BY kind ORDER BY 2 DESC""")
    email_rows = "".join(row(k, f"{int(a):,}", f"{int(b):,}") for k, a, b in sent) or row("Nothing logged", "0", "0")

    # Who signed up this week (so you can say hi).
    people = rows(conn, """SELECT p.email, p.signed_up_at,
                                  (SELECT count(*) FROM public.user_watchlist w WHERE w.clerk_user_id = p.clerk_user_id)
                             FROM public.user_preferences p WHERE p.signed_up_at > now() - interval '7 days'
                            ORDER BY p.signed_up_at DESC LIMIT 15""")
    people_html = "".join(
        f'<tr><td style="font-family:{ek.FONT};font-size:13px;color:{ek.TEXT_2};padding:5px 0;border-top:1px solid {ek.BORDER};">{ek.esc(e)}</td>'
        f'<td style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};padding:5px 0;border-top:1px solid {ek.BORDER};text-align:right;white-space:nowrap;">'
        f'{ek.short_date(d)} · watching {n}</td></tr>' for e, d, n in people)

    signups = snapshot.get("New signups")
    activated = snapshot.get("...who picked at least one stock or person")
    headline = (f"{int(signups)} signup{'s' if signups != 1 else ''}"
                + (f", {int(activated)} picked a stock" if signups and activated is not None else "")
                + (f", {int(paying)} paying Pro" if isinstance(paying, float) else ""))
    if signups is None:
        headline = "This week's numbers"

    body = ek.p(ek.esc(headline + " this week."), 17, ek.TEXT, "0 0 16px", 700)
    for sec in ("People", "Money", "Data"):
        body += ek.p(sec.upper(), 11, ek.ACCENT, "14px 0 6px", 700)
        body += table(sections.get(sec, "")) + table_now(now_rows.get(sec, ""))
    body += ek.p("EMAILS SENT", 11, ek.ACCENT, "14px 0 6px", 700) + table(email_rows)
    if people_html:
        body += ek.p("WHO SIGNED UP", 11, ek.ACCENT, "14px 0 6px", 700)
        body += f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{people_html}</table>'

    subject = f"Seli this week: {headline}"
    html_doc = ek.shell(title=subject, preheader=headline, label="Weekly numbers",
                        body_rows=f'<tr><td class="px" style="padding:22px 28px 0;">{body}</td></tr>',
                        footer_html=ek.p("Sent to you only, from db/send_weekly_metrics.py.", 11, ek.FAINT, "0"))
    ok = ek.send(to_email=TO, subject=subject, html_doc=html_doc, from_name="Seli", clerk_user_id="ops", kind=KIND)
    if ok:
        ek.log_sent(conn, "ops", KIND, [json.dumps({k: v for k, v in snapshot.items() if v is not None}, default=str)[:2000]])
        log.info(f"Sent: {subject}")
    conn.close()
    if not ok:
        sys.exit(2)


def table_now(rows_html: str) -> str:
    if not rows_html:
        return ""
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;">{rows_html}</table>'


if __name__ == "__main__":
    main()
