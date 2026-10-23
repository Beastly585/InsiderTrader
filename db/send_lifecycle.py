#!/usr/bin/env python3
"""
db/send_lifecycle.py
Emails sent because of something a person did (or didn't finish), not on a
calendar. Runs as a step after every ingest run (hourly on weekdays) and after
the daily email run, so it costs no extra GitHub Actions minutes.

  kind            when                                          sent from
  lc_checkout     started Pro checkout, didn't pay, 2h+ ago     Kevin
  lc_cancel       clicked cancel (within the last 3 days)       Kevin   (account notice)
  lc_ending       canceled Pro ends in 1 to 3.5 days            Seli    (account notice)
  lc_first_stock  signed up 4 to 10 days ago, watchlist empty   Kevin
  lc_alerts_off   paying Pro, watching things, every same-day   Kevin
                  alert switched off
  lc_free_limit   free account tried to add a 4th stock or      Kevin   (once per 30 days)
                  person 6 hours to 3 days ago, and it's still
                  not on their list (user_events, written by the Worker)

House rules (see email_kit.py for the ones every sender follows):
  - Account notices go once per cancellation. The checkout reminder,
    lc_first_stock and lc_alerts_off go once per person, ever (the checkout
    and alerts ones promise not to mention it again). lc_free_limit can come
    back after 30 days, for a different stock.
  - The trigger is re-checked at send time, so an email never goes to someone
    who already finished checkout, reactivated, or added a stock.
  - Non-account emails (lc_checkout, lc_first_stock): skipped for anyone who
    unsubscribed, at most one every 3 days per person, never within 2 days of
    the welcome email. Account notices go regardless, like a receipt.
  - Quiet hours: nothing sends between 9pm and 8am Eastern. It goes on the
    next run instead.
  - The send is recorded in email_log BEFORE it goes out (and removed if the
    send fails), so a hiccup can't turn into the same email every hour. If
    email_log doesn't exist, this script sends nothing.

  python send_lifecycle.py
  DRY_RUN=true PREVIEW_DIR=out python send_lifecycle.py     # build, don't send
  SAMPLE=true ONLY_EMAIL=you@x.com python send_lifecycle.py  # every template,
       # with sample dates, sent to that one account (subject starts "[Test]"),
       # nothing logged. Add DRY_RUN=true PREVIEW_DIR=out to only write files.
  ONLY=lc_checkout,lc_cancel                                   # run some rules
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import email_kit as ek

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ONLY_EMAIL = os.environ.get("ONLY_EMAIL", "").strip().lower()
SAMPLE     = os.environ.get("SAMPLE", "false").lower() == "true"
ONLY       = {k.strip() for k in os.environ.get("ONLY", "").split(",") if k.strip()}
IGNORE_QUIET_HOURS = os.environ.get("IGNORE_QUIET_HOURS", "false").lower() == "true"

KEVIN_FROM = os.environ.get("WELCOME_FROM_EMAIL") or ("kevin@" + ek.FROM_EMAIL.split("@", 1)[1])
REPLY_TO   = os.environ.get("WELCOME_REPLY_TO") or None
ET         = ZoneInfo("America/New_York")

NUDGE_KINDS = ["lc_checkout", "lc_first_stock", "lc_alerts_off", "lc_free_limit"]   # the non-account ones, which share the 3-day cap
MEDIUM = "lifecycle"


# ── Small helpers ────────────────────────────────────────────────────────────
def rows(conn, sql: str, params=None) -> list[dict]:
    cur = conn.cursor()
    cur.execute(sql, params or {})
    cols = [d.name for d in cur.description]
    out = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    return out


def P(html: str, **kw) -> str:
    return ek.p(html, **{"size": 15, "color": ek.TEXT_2, **kw})


def hello(u: dict) -> str:
    name = (u.get("first_name") or "").strip()
    return P(f"Hey {ek.esc(name) if name else 'there'},", margin="0 0 14px")


def sign_off(name: str = "Kevin") -> str:
    return P(name, margin="4px 0 0", weight=600, color=ek.TEXT)


def nice_date(d) -> str:
    """'Tuesday, November 3'."""
    d = d.astimezone(ET).date() if isinstance(d, datetime) else ek.as_date(d)
    return f"{d:%A}, {d:%B} {d.day}"


def page(subject: str, preheader: str, label: str, body: str, reason: str, uid: str) -> str:
    return ek.shell(title=subject, preheader=preheader, label=label,
                    body_rows=f'<tr><td class="px" style="padding:22px 28px 0;">{body}</td></tr>',
                    footer_html=ek.footer(reason=reason, clerk_user_id=uid))


def link(path: str, content: str) -> str:
    return ek.track(path, MEDIUM, content)


# ── 1. Unfinished checkout ───────────────────────────────────────────────────
# A Stripe subscription is created (status 'incomplete') when someone presses
# Subscribe, just before the card is charged, and the webhook writes that
# status here. Still 'incomplete' (or 'incomplete_expired', the same attempt
# 23 hours later) with no live subscription since means they tried to pay and
# it didn't go through: a declined card, or a bank check they didn't finish.
# Opening the form and closing it creates nothing, so it never triggers this.
CHECKOUT_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, s.stripe_subscription_id AS ref, s.updated_at AS at
  FROM public.subscriptions s
  JOIN public.user_preferences p ON p.clerk_user_id = s.clerk_user_id
 WHERE s.status IN ('incomplete', 'incomplete_expired')
   AND s.stripe_subscription_id IS NOT NULL
   AND s.updated_at <= now() - interval '2 hours'
   AND s.updated_at >= now() - interval '4 days'
   AND p.email IS NOT NULL AND p.email_unsubscribed_at IS NULL
"""


def checkout_email(u: dict) -> tuple[str, str]:
    subject = "Did checkout give you trouble?"
    body = hello(u)
    body += P("I saw you started upgrading to Seli Pro but it didn't go through. If something broke, "
              "or the card form gave you trouble, just reply and tell me what happened. I'll fix it.")
    body += P("If you just changed your mind, no worries. I won't bug you about it again.")
    body += f'<div style="margin:2px 0 20px;">{ek.button("Finish upgrading", link("/account#billing", "checkout_finish"))}</div>'
    body += sign_off()
    return subject, page(subject, "Your upgrade didn't go through. Anything break?", "Seli Pro", body,
                         "You're getting this because you started upgrading to Seli Pro.", u["clerk_user_id"])


# ── 2. Cancel confirmation (account notice) ─────────────────────────────────
CANCEL_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, s.current_period_end AS ends,
       s.stripe_subscription_id || ':' || to_char(s.current_period_end, 'YYYY-MM-DD') AS ref,
       EXISTS (SELECT 1 FROM public.cancellation_feedback c WHERE c.clerk_user_id = s.clerk_user_id) AS gave_feedback
  FROM public.subscriptions s
  JOIN public.user_preferences p ON p.clerk_user_id = s.clerk_user_id
 WHERE s.plan = 'pro' AND s.status IN ('active', 'trialing')
   AND s.cancel_at_period_end IS TRUE
   AND s.stripe_subscription_id IS NOT NULL
   AND s.current_period_end > now() + interval '12 hours'
   AND s.updated_at >= now() - interval '3 days'
   AND p.email IS NOT NULL
"""


def cancel_email(u: dict) -> tuple[str, str]:
    when = nice_date(u["ends"])
    subject = f"Your Seli Pro plan ends {when.split(', ', 1)[1]}"
    body = hello(u)
    body += P(f"This confirms you canceled Seli Pro. You won't be charged again, and Pro stays on until "
              f"<b style=\"color:{ek.TEXT};\">{ek.esc(when)}</b>. After that your account switches to the free plan.")
    body += P(f"If you change your mind before then, you can keep Pro from {ek.a(link('/account#billing', 'cancel_keep'), 'your billing settings')}.")
    if u.get("gave_feedback"):
        body += P("Thanks for the note you left when you canceled. I read every one.", margin="0 0 18px")
    else:
        body += P("If you have a second, I'd really like to know what made you cancel. Just reply, even one line helps.",
                  margin="0 0 18px")
    body += sign_off()
    return subject, page(subject, f"Pro stays on until {when}. You won't be charged again.", "Account", body,
                         "You're getting this because you canceled Seli Pro.", u["clerk_user_id"])


# ── 3. Pro ends soon (account notice) ───────────────────────────────────────
ENDING_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, s.current_period_end AS ends,
       'end:' || s.stripe_subscription_id || ':' || to_char(s.current_period_end, 'YYYY-MM-DD') AS ref
  FROM public.subscriptions s
  JOIN public.user_preferences p ON p.clerk_user_id = s.clerk_user_id
 WHERE s.plan = 'pro' AND s.status IN ('active', 'trialing')
   AND s.cancel_at_period_end IS TRUE
   AND s.stripe_subscription_id IS NOT NULL
   AND s.current_period_end BETWEEN now() + interval '1 day' AND now() + interval '3 days 12 hours'
   AND p.email IS NOT NULL
"""


def ending_email(u: dict) -> tuple[str, str]:
    when = nice_date(u["ends"])
    subject = f"Seli Pro ends on {when}"
    body = hello(u)
    body += P(f"A quick heads up: your Pro plan ends on <b style=\"color:{ek.TEXT};\">{ek.esc(when)}</b>. "
              "You won't be charged. After that your account switches to the free plan, "
              "and same-day alerts and the daily brief stop.")
    body += P("Want to keep it? It's one click from your billing settings.", margin="0 0 6px")
    body += f'<div style="margin:2px 0 20px;">{ek.button("Keep Pro", link("/account#billing", "ending_keep"), secondary=True)}</div>'
    body += sign_off("The Seli team")
    return subject, page(subject, f"Your Pro plan ends {when}. You won't be charged.", "Account", body,
                         "You're getting this because your Seli Pro plan is ending.", u["clerk_user_id"])


# ── 4. Pick your first stock ────────────────────────────────────────────────
FIRST_STOCK_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, p.signed_up_at, p.onboarded_at
  FROM public.user_preferences p
 WHERE p.signed_up_at <= now() - interval '4 days'
   AND p.signed_up_at >= now() - interval '10 days'
   AND p.welcome_sent_at IS NOT NULL
   AND p.email IS NOT NULL AND p.email_unsubscribed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.user_watchlist w WHERE w.clerk_user_id = p.clerk_user_id)
"""

# Well-known stocks (the most-filed-on tickers, a decent stand-in for big
# companies) with real open-market insider buying in the last few weeks.
# Same filters as the digests: no duplicates, no flagged trades (those have
# is_open_market = false), no Congress, nothing under $1 a share.
PICKS_SQL = """
WITH popular AS (
  SELECT e.key, e.label FROM public.search_entities e
   WHERE e.kind = 'stock' AND e.last_date >= CURRENT_DATE - 365
   ORDER BY e.n DESC LIMIT 300
)
SELECT f.ticker, MAX(e.label) AS company,
       COUNT(DISTINCT f.insider_name)::int AS insiders,
       SUM(f.value)::float AS v,
       MAX(COALESCE(f.transaction_date, f.filing_date)) AS last
  FROM public.filings f
  JOIN popular e ON e.key = f.ticker
 WHERE f.is_open_market = true AND f.transaction_type = 'buy'
   AND f.duplicate_of IS NULL
   AND COALESCE(f.relationship, '') <> 'congress'
   AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%%'
   AND f.filing_date >= CURRENT_DATE - 45
   AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - 60
   AND COALESCE(f.value, 0) >= 10000
   AND (f.price_per_share IS NULL OR f.price_per_share >= 1)
 GROUP BY f.ticker
HAVING SUM(f.value) >= 100000
 ORDER BY COUNT(DISTINCT f.insider_name) DESC, SUM(f.value) DESC
 LIMIT 3
"""


def pick_row(s: dict) -> str:
    href = link(ek.ticker_path(s["ticker"]), "first_stock_pick")
    line = (f"{ek.plural(s['insiders'], 'insider')} bought {ek.money(s['v'])} on the open market, "
            f"most recently {ek.ago(s['last'])}.")
    return (f'<tr><td style="padding:10px 0;border-top:1px solid {ek.BORDER};">'
            f'{ek.ticker_tag(s["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(ek.pretty_company(s["company"]) or s["ticker"])}</span>'
            + ek.p(ek.esc(line), 14, ek.TEXT_2, "6px 0 0") + "</td></tr>")


def first_stock_email(u: dict, picks: list[dict]) -> tuple[str, str]:
    days = (ek.utcnow() - u["signed_up_at"]).days if u.get("signed_up_at") else 7
    when = "a few days ago" if days < 7 else "last week"
    target = "/watchlist" if u.get("onboarded_at") else "/onboard"
    subject = "A few stocks to start your watchlist" if picks else "What should Seli watch for you?"
    body = hello(u)
    body += P(f"You signed up for Seli {when} but haven't picked any stocks yet, so there's nothing for me to watch for you. "
              "The easiest place to start is the stocks you already own, or ones you're thinking about buying.")
    if picks:
        body += P("If you want ideas, these well-known names have had real insider buying in the last few weeks:", margin="4px 0 4px")
        body += f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">{"".join(pick_row(s) for s in picks)}</table>'
    body += f'<div style="margin:2px 0 18px;">{ek.button("Pick your stocks", link(target, "first_stock_add"))}</div>'
    body += P("The free plan covers up to 3. Once you've added some, you'll get a short email on Sundays with what insiders did in them.",
              size=14, color=ek.MUTED, margin="0 0 18px")
    body += sign_off()
    return subject, page(subject, "Add a stock or two and Seli starts watching insider trades for you.", "Getting started", body,
                         "You're getting this because you signed up for Seli.", u["clerk_user_id"])


# ── 5. Pro with every alert switched off ────────────────────────────────────
# Same-day alerts are the main thing Pro adds. Someone paying for it with all
# of them off is only hearing about their stocks in the digest.
ALERTS_OFF_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, p.daily_digest IS TRUE AS daily_digest,
       (SELECT array_agg(w.item_value ORDER BY w.added_at DESC) FROM public.user_watchlist w
         WHERE w.clerk_user_id = p.clerk_user_id AND w.item_type = 'ticker') AS tickers,
       (SELECT count(*) FROM public.user_watchlist w WHERE w.clerk_user_id = p.clerk_user_id) AS n_watch
  FROM public.subscriptions s
  JOIN public.user_preferences p ON p.clerk_user_id = s.clerk_user_id
 WHERE s.plan = 'pro' AND s.status IN ('active', 'trialing')
   AND s.stripe_subscription_id IS NOT NULL          -- paying, not comped
   AND s.cancel_at_period_end IS NOT TRUE
   AND s.updated_at <= now() - interval '2 days'      -- give a new subscriber time to set things up
   AND NOT COALESCE(p.instant_watchlist_ticker OR p.instant_followed_insider
                    OR p.instant_high_conviction OR p.instant_reversal, false)
   AND EXISTS (SELECT 1 FROM public.user_watchlist w WHERE w.clerk_user_id = p.clerk_user_id)
   AND p.email IS NOT NULL AND p.email_unsubscribed_at IS NULL
"""


def list_phrase(items: list[str], total: int) -> str:
    """'AAPL', 'AAPL and NVDA', 'AAPL, NVDA and 3 more'."""
    items = [i for i in items if i][:2]
    more = total - len(items)
    if not items:
        return "the things you watch"
    if more > 0:
        return ", ".join(items) + f" and {more} more"
    return " and ".join(items)


def alerts_off_email(u: dict) -> tuple[str, str]:
    subject = "Your same-day alerts are off"
    what = list_phrase(u.get("tickers") or [], int(u.get("n_watch") or 0))
    where = "your daily brief" if u.get("daily_digest") else "your Sunday email"
    body = hello(u)
    body += P(f"Quick one: you're on Pro, but same-day alerts are switched off, so news on {ek.esc(what)} "
              f"only reaches you in {where}.")
    body += P("Turn them on and you'll get an email the day an insider files on anything you watch.", margin="0 0 6px")
    body += f'<div style="margin:2px 0 18px;">{ek.button("Turn on alerts", link("/account#emails", "alerts_off_on"))}</div>'
    body += P("If you left them off on purpose, ignore this. I won't mention it again.", margin="0 0 18px")
    body += sign_off()
    return subject, page(subject, "You're paying for same-day alerts, but they're switched off.", "Seli Pro", body,
                         "You're getting this because you're on Seli Pro.", u["clerk_user_id"])


# ── 6. Hit the free limit ───────────────────────────────────────────────────
# The page shows the Pro pitch on the spot; this is the next-day follow-up:
# what insiders did in the thing they wanted, then the two ways to watch it.
FREE_LIMIT_SQL = """
SELECT DISTINCT ON (p.clerk_user_id)
       p.clerk_user_id, p.email, p.first_name, e.ref AS ref, e.created_at AS at
  FROM public.user_events e
  JOIN public.user_preferences p ON p.clerk_user_id = e.clerk_user_id
  LEFT JOIN public.subscriptions s ON s.clerk_user_id = e.clerk_user_id
 WHERE e.kind = 'free_limit'
   AND e.created_at BETWEEN now() - interval '3 days' AND now() - interval '6 hours'
   AND NOT COALESCE(s.plan = 'pro' AND s.status IN ('active', 'trialing'), false)
   -- not on their list since (they may have swapped it in)
   AND NOT EXISTS (SELECT 1 FROM public.user_watchlist w
                    WHERE w.clerk_user_id = p.clerk_user_id AND w.item_type || ':' || w.item_value = e.ref)
   AND p.email IS NOT NULL AND p.email_unsubscribed_at IS NULL
 ORDER BY p.clerk_user_id, e.created_at DESC
"""


def when_phrase(ts) -> str:
    d = ts.astimezone(ET).date() if isinstance(ts, datetime) else ek.as_date(ts)
    today = ek.utcnow().astimezone(ET).date()
    return "earlier today" if d == today else "yesterday" if (today - d).days == 1 else f"on {d:%A}"


def ticker_line(s: dict) -> str:
    """Where a stock stands, one plain sentence (same wording as the welcome email)."""
    yb, ys, lb, rb = s["yr_buys"], s["yr_sells"], s["last_buy"], s["recent_buys"]
    if not s["known"]:
        return "No insider filings on record yet."
    if rb["n"]:
        return f"Insiders bought {ek.money(rb['v'])} in the last 90 days ({ek.plural(rb['insiders'], 'insider')})."
    if lb and ys["n"]:
        return (f"Insiders sold {ek.money(ys['v'])} over the last year. The last insider buy was "
                f"{ek.ago(lb['date'])} ({lb['name']}, {ek.money(lb['value'])}).")
    if lb:
        return f"Quiet lately. The last insider buy was {ek.ago(lb['date'])} ({lb['name']}, {ek.money(lb['value'])})."
    if ys["n"]:
        return f"Insiders sold {ek.money(ys['v'])} over the last year, with no open-market buys."
    return "No open-market insider trades in the last year."


def free_limit_email(u: dict, conn=None) -> tuple[str, str]:
    kind, _, value = (u.get("ref") or "ticker:").partition(":")
    stock = kind == "ticker"
    when = when_phrase(u["at"]) if u.get("at") else "recently"
    status = None
    if stock and conn is not None:
        import insider_intel as ii
        today = date.today()
        try:
            status = ii.ticker_status(conn, [value], today - timedelta(days=90), today, today=today).get(value.upper())
        except Exception:
            conn.rollback()
    name = value.upper() if stock else ek.pretty_person(value)
    subject = f"{name} didn't make it onto your watchlist"
    body = hello(u)
    body += P(f"You tried to add {ek.esc(name)} {when}, but free accounts watch up to 3 stocks or people, "
              "so it didn't go on your list.")
    if status:
        href = link(ek.ticker_path(value), "free_limit_stock")
        body += P("In case it helps, here's where it stands:", margin="4px 0 4px")
        body += (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">'
                 f'<tr><td style="padding:10px 0;border-top:1px solid {ek.BORDER};border-bottom:1px solid {ek.BORDER};">'
                 f'{ek.ticker_tag(value.upper(), href)}'
                 f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(status["company"])}</span>'
                 + ek.p(ek.esc(ticker_line(status)), 14, ek.TEXT_2, "6px 0 0") + "</td></tr></table>")
    elif not stock:
        body += P(f'You can still see everything {ek.esc(name)} has filed on {ek.a(link(ek.insider_path(value), "free_limit_person"), "their page")}.')
    body += P("Two ways to get it on there: swap it in for one of your current 3 on "
              f"{ek.a(link('/watchlist', 'free_limit_watchlist'), 'your watchlist')}, or go Pro, which lifts the limit "
              "and emails you the same day insiders trade ($6.99/month).", margin="0 0 6px")
    body += f'<div style="margin:2px 0 18px;">{ek.button("See Pro", link("/account#billing", "free_limit_pro"))}</div>'
    body += sign_off()
    return subject, page(subject, f"Free accounts watch up to 3. Here's where {name} stands anyway.", "Watchlist", body,
                         "You're getting this because you tried to add something to your Seli watchlist.", u["clerk_user_id"])


# ── Rules, in priority order ─────────────────────────────────────────────────
# account=True: an account notice (sent even to people who unsubscribed from
# other email, and not counted against the 3-day cap).
RULES = [
    {"kind": "lc_checkout",    "sql": CHECKOUT_SQL,    "build": checkout_email,    "account": False, "from": "kevin", "once_ever": True},
    {"kind": "lc_cancel",      "sql": CANCEL_SQL,      "build": cancel_email,      "account": True,  "from": "kevin"},
    {"kind": "lc_ending",      "sql": ENDING_SQL,      "build": ending_email,      "account": True,  "from": "seli",
     "skip_if_recent": ("lc_cancel", 4)},   # they were just told
    {"kind": "lc_first_stock", "sql": FIRST_STOCK_SQL, "build": first_stock_email, "account": False, "from": "kevin", "once_ever": True},
    {"kind": "lc_alerts_off",  "sql": ALERTS_OFF_SQL,  "build": alerts_off_email,  "account": False, "from": "kevin", "once_ever": True},
    {"kind": "lc_free_limit",  "sql": FREE_LIMIT_SQL,  "build": free_limit_email,  "account": False, "from": "kevin", "repeat_days": 30,
     "needs_table": "user_events"},
]


def table_exists(conn, name: str) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{name}",))
    ok = cur.fetchone()[0]
    cur.close()
    return bool(ok)


def quiet_hours(now: datetime) -> bool:
    h = now.astimezone(ET).hour
    return h >= 21 or h < 8


def reserve(conn, uid: str, kind: str, ref) -> int | None:
    """Write the log row first. Returns its id (to undo on failure)."""
    cur = conn.cursor()
    cur.execute("INSERT INTO public.email_log (clerk_user_id, kind, ref) VALUES (%s, %s, %s) RETURNING id", (uid, kind, ref))
    rid = cur.fetchone()[0]
    conn.commit(); cur.close()
    return rid


def unreserve(conn, rid: int) -> None:
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM public.email_log WHERE id = %s", (rid,))
        conn.commit(); cur.close()
    except Exception as e:
        log.error(f"  couldn't remove log row {rid} after a failed send: {e}")
        try:
            conn.rollback()
        except Exception:
            pass


def send_one(rule: dict, u: dict, subject: str, html_doc: str, test: bool = False) -> bool:
    kevin = rule["from"] == "kevin"
    return ek.send(to_email=u["email"], subject=("[Test] " + subject) if test else subject, html_doc=html_doc,
                   clerk_user_id=u["clerk_user_id"], kind=rule["kind"],
                   from_name="Kevin at Seli" if kevin else "Seli",
                   from_email=KEVIN_FROM if kevin else None,
                   reply_to=REPLY_TO)


def eligible(conn, rule: dict, u: dict) -> str | None:
    """Why this person is skipped, or None if the email can go."""
    uid, kind = u["clerk_user_id"], rule["kind"]
    if rule.get("once_ever"):
        if ek.already_sent(conn, uid, kind):
            return "already sent"
    elif ek.already_sent(conn, uid, kind, u.get("ref")):
        return "already sent for this"
    if rule.get("repeat_days") and ek.cooldown(conn, uid, kind, rule["repeat_days"]):
        return f"sent in the last {rule['repeat_days']} days"
    if rule.get("skip_if_recent"):
        other, days = rule["skip_if_recent"]
        if ek.cooldown(conn, uid, other, days):
            return f"{other} went out recently"
    if not rule["account"]:
        if ek.cooldown(conn, uid, NUDGE_KINDS, 3):
            return "another nudge in the last 3 days"
        if ek.cooldown(conn, uid, "welcome", 2):
            return "welcome email in the last 2 days"
    return None


def run_sample(conn) -> None:
    """Every template for one account, with sample dates. Nothing is logged."""
    if not ONLY_EMAIL:
        log.error("SAMPLE needs ONLY_EMAIL"); sys.exit(1)
    found = rows(conn, """SELECT p.clerk_user_id, p.email, p.first_name, p.signed_up_at, p.onboarded_at
                            FROM public.user_preferences p WHERE lower(p.email) = %(e)s""", {"e": ONLY_EMAIL})
    if not found:
        log.error(f"No account for {ONLY_EMAIL}"); sys.exit(1)
    u = found[0]
    now = ek.utcnow()
    picks = rows(conn, PICKS_SQL)
    samples = [
        (RULES[0], {**u}),
        (RULES[1], {**u, "ends": now + timedelta(days=24), "gave_feedback": False}),
        (RULES[2], {**u, "ends": now + timedelta(days=3)}),
        (RULES[3], {**u, "signed_up_at": u.get("signed_up_at") or now - timedelta(days=5)}),
        (RULES[4], {**u, "tickers": ["AAPL", "NVDA", "MSFT"], "n_watch": 5, "daily_digest": True}),
        (RULES[5], {**u, "ref": "ticker:NVDA", "at": now - timedelta(hours=20)}),
    ]
    for rule, data in samples:
        if ONLY and rule["kind"] not in ONLY:
            continue
        subject, html_doc = (rule["build"](data, picks) if rule["kind"] == "lc_first_stock"
                             else rule["build"](data, conn) if rule["kind"] == "lc_free_limit" else rule["build"](data))
        ok = send_one(rule, data, subject, html_doc, test=True)
        log.info(f"  sample {rule['kind']}: {'sent' if ok else 'FAILED'}  ({subject})")


def main():
    if not os.environ.get("DATABASE_URL"):
        log.error("DATABASE_URL required"); sys.exit(1)
    conn = ek.get_connection()
    if SAMPLE:
        run_sample(conn); conn.close(); return
    if not ek.log_ready(conn):
        log.error("email_log isn't there (run db/migrations/2026-10-19_email_log.sql). "
                  "Sending nothing: without it these emails can't tell what was already sent.")
        conn.close(); return
    now = ek.utcnow()
    if quiet_hours(now) and not IGNORE_QUIET_HOURS:
        log.info(f"Quiet hours ({now.astimezone(ET):%H:%M} ET). Nothing sent; the next daytime run picks it up.")
        conn.close(); return

    picks = None
    sent_to: set[str] = set()     # one lifecycle email per person per run
    sent = failed = 0
    for rule in RULES:
        kind = rule["kind"]
        if ONLY and kind not in ONLY:
            continue
        if rule.get("needs_table") and not table_exists(conn, rule["needs_table"]):
            log.info(f"{kind}: skipped, {rule['needs_table']} isn't there yet (db/migrations/2026-10-23_annual_and_events.sql)")
            continue
        try:
            people = rows(conn, rule["sql"])
        except Exception:
            log.exception(f"{kind}: query failed, skipping this rule"); conn.rollback(); failed += 1; continue
        if ONLY_EMAIL:
            people = [u for u in people if (u["email"] or "").lower() == ONLY_EMAIL]
        log.info(f"{kind}: {len(people)} candidate(s)")
        for u in people:
            uid = u["clerk_user_id"]
            if uid in sent_to:
                log.info(f"  skip {u['email']}: already got one this run"); continue
            why = eligible(conn, rule, u)
            if why:
                log.info(f"  skip {u['email']}: {why}"); continue
            try:
                if kind == "lc_first_stock":
                    if picks is None:
                        picks = rows(conn, PICKS_SQL)
                    subject, html_doc = rule["build"](u, picks)
                elif kind == "lc_free_limit":
                    subject, html_doc = rule["build"](u, conn)
                else:
                    subject, html_doc = rule["build"](u)
            except Exception:
                log.exception(f"  compose failed for {u['email']}"); conn.rollback(); failed += 1; continue
            rid = None if ek.DRY_RUN else reserve(conn, uid, kind, u.get("ref"))
            if send_one(rule, u, subject, html_doc):
                sent += 1; sent_to.add(uid)
                log.info(f"  sent {kind} -> {u['email']}: {subject}")
            else:
                failed += 1
                if rid:
                    unreserve(conn, rid)
    conn.close()
    log.info(f"Done. sent={sent} failed={failed}")
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
