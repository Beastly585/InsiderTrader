#!/usr/bin/env python3
"""
db/send_welcome.py
The day-2 email. Runs once a day (09:00 ET) and sends to everyone who signed
up 10+ hours ago and hasn't had it yet, so it lands the morning after signup:
inside the window where new users currently vanish, and before their first
Sunday digest.

A short note from Kevin that looks like one: no section labels or stat
boxes. One line per stock they picked (or an "Add your stocks" button if they
haven't), one sentence on exactly which emails they'll get from their real
settings, and how to reach him.

  python send_welcome.py                 # normal daily run
  BACKFILL=true python send_welcome.py   # also users who signed up before this
                                         # existed (older than 14 days, never welcomed)
  SYNC_FROM_CLERK=true ...               # first create prefs rows for Clerk users
                                         # who don't have one (needs CLERK_SECRET_KEY)
  ONLY_EMAIL / DRY_RUN / PREVIEW_DIR     same as send_digests.py

Env:
  WELCOME_FROM_EMAIL   defaults to ALERTS_FROM_EMAIL
  WELCOME_REPLY_TO     where replies go (your real inbox). Strongly recommended:
                       the email tells people to hit reply.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, timedelta

import requests

import email_kit as ek
import insider_intel as ii

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ONLY_EMAIL       = os.environ.get("ONLY_EMAIL", "").strip().lower()
BACKFILL         = os.environ.get("BACKFILL", "false").lower() == "true"
SYNC_FROM_CLERK  = os.environ.get("SYNC_FROM_CLERK", "false").lower() == "true"
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
# From a person, not "alerts@": founder welcomes get more replies and are less
# likely to land in Promotions. Any address on the verified Resend domain works
# without a real mailbox behind it; replies go to WELCOME_REPLY_TO.
FROM_EMAIL       = os.environ.get("WELCOME_FROM_EMAIL") or ("kevin@" + ek.FROM_EMAIL.split("@", 1)[1])
REPLY_TO         = os.environ.get("WELCOME_REPLY_TO") or None
MIN_AGE_HOURS    = int(os.environ.get("WELCOME_MIN_AGE_HOURS", "10"))
MEDIUM           = "welcome"


# ── Optional one-time sync: Clerk users -> user_preferences rows ────────────
def sync_from_clerk(conn) -> int:
    """Existing users from before the user.created webhook have no prefs row,
    so no script can see them. Pull them from Clerk and create one with the
    weekly digest on (same default new signups get). Never touches existing rows."""
    if not CLERK_SECRET_KEY:
        log.error("SYNC_FROM_CLERK needs CLERK_SECRET_KEY"); return 0
    created, offset = 0, 0
    cur = conn.cursor()
    while True:
        r = requests.get("https://api.clerk.com/v1/users", params={"limit": 100, "offset": offset, "order_by": "created_at"},
                         headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"}, timeout=30)
        r.raise_for_status()
        batch = r.json()
        batch = batch.get("data", batch) if isinstance(batch, dict) else batch
        if not batch:
            break
        for u in batch:
            email = next((e["email_address"] for e in u.get("email_addresses", []) if e.get("id") == u.get("primary_email_address_id")), None) \
                or next((e["email_address"] for e in u.get("email_addresses", [])), None)
            if not email:
                continue
            cur.execute("""
                INSERT INTO public.user_preferences
                  (clerk_user_id, email, first_name, signed_up_at, daily_digest, weekly_digest,
                   digest_top_signals, digest_congressional, digest_corporate, digest_watchlist_only,
                   digest_min_conviction, digest_max_signals, digest_min_value,
                   instant_watchlist_ticker, instant_followed_insider, instant_high_conviction, instant_reversal,
                   instant_min_value, instant_high_conviction_threshold, updated_at)
                VALUES (%s, %s, %s, to_timestamp(%s / 1000.0), FALSE, TRUE, TRUE, TRUE, TRUE, FALSE, '0', 10, 0,
                        FALSE, FALSE, FALSE, FALSE, 0, 1000000, now())
                ON CONFLICT (clerk_user_id) DO UPDATE
                  SET signed_up_at = COALESCE(public.user_preferences.signed_up_at, EXCLUDED.signed_up_at),
                      first_name   = COALESCE(public.user_preferences.first_name, EXCLUDED.first_name)
                RETURNING (xmax = 0) AS inserted
            """, (u["id"], email, (u.get("first_name") or "").strip()[:60] or None, u.get("created_at") or 0))
            if cur.fetchone()[0]:
                created += 1
        conn.commit()
        if len(batch) < 100:
            break
        offset += 100
    cur.close()
    log.info(f"Clerk sync: created {created} new prefs row(s).")
    return created


# ── Pieces ──────────────────────────────────────────────────────────────────
# A note from a person, so it looks like one: no section labels, no stat
# boxes, one button at most. The only "data" is a line per stock they chose.
def follow_line(s: dict) -> str:
    """One stock, one plain line: the most useful thing we know."""
    href = ek.track(ek.ticker_path(s["ticker"]), MEDIUM, "following")
    yb, ys, lb, rb = s["yr_buys"], s["yr_sells"], s["last_buy"], s["recent_buys"]
    if not s["known"]:
        line = "No insider filings on record yet. You'll hear when the first one comes in."
    elif rb["n"]:
        line = f"Insiders bought {ek.money(rb['v'])} in the last 90 days ({ek.plural(rb['insiders'], 'insider')})."
    elif lb and ys["n"]:
        line = (f"Insiders sold {ek.money(ys['v'])} over the last year. The last insider buy was "
                f"{ek.ago(lb['date'])} ({lb['name']}, {ek.money(lb['value'])}).")
    elif lb:
        line = f"Quiet lately. The last insider buy was {ek.ago(lb['date'])} ({lb['name']}, {ek.money(lb['value'])})."
    elif ys["n"]:
        line = f"Insiders sold {ek.money(ys['v'])} over the last year, with no open-market buys."
    else:
        line = "No open-market insider trades in the last year."
    return (f'<tr><td style="padding:10px 0;border-top:1px solid {ek.BORDER};">'
            f'{ek.ticker_tag(s["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(s["company"])}</span>'
            + ek.p(ek.esc(line), 14, ek.TEXT_2, "6px 0 0") + "</td></tr>")


def email_plan(u: dict) -> str:
    """One sentence on exactly what they'll get, from their real settings."""
    on = []
    if u.get("weekly_digest"):
        on.append("a short email on Sunday evenings")
    if u.get("pro") and u.get("daily_digest"):
        on.append("a daily brief on weekday mornings when something new comes in")
    if u.get("pro") and u.get("instant_any"):
        on.append("an alert the day an insider files on something you've set alerts for")
    if not on:
        return "Your Seli emails are all off, so this is the only one you'll get unless you turn something on."
    return "From here you'll get " + (on[0] if len(on) == 1 else ", ".join(on[:-1]) + " and " + on[-1]) + ". Nothing else."


def compose(u: dict, statuses: dict, backfill: bool, today: date) -> tuple[str, str]:
    name = u.get("first_name")
    watch = [statuses[t] for t in sorted(set(u["tickers"])) if t in statuses]
    P = lambda html, **kw: ek.p(html, **{"size": 15, "color": ek.TEXT_2, **kw})
    settings = ek.track("/account#emails", MEDIUM, "settings")

    body = P(f"Hey {ek.esc(name) if name else 'there'},", margin="0 0 14px")
    body += (P("Kevin here. I built Seli, and you signed up a while back, so here's a quick hello.") if backfill
             else P("Thanks for signing up. I'm Kevin, and I built Seli."))
    body += P("Executives, directors and members of Congress have to report when they buy or sell their own company's stock. "
              "Seli reads every one of those filings and tells you, in plain English, when it touches a stock you care about.")

    if watch:
        body += P("Here's where the stocks you're watching stand:", margin="4px 0 4px")
        body += f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">{"".join(follow_line(s) for s in watch)}</table>'
    else:
        limit = "" if u.get("pro") else " (up to 3 on the free plan)"
        target = "/watchlist" if u.get("onboarded_at") else "/onboard"
        body += P(f"You're not watching anything yet. Add the stocks you own or are thinking about{limit}, and that's what Seli will keep an eye on.",
                  margin="0 0 14px")
        body += f'<div style="margin:0 0 20px;">{ek.button("Add your stocks", ek.track(target, MEDIUM, "add_tickers"))}</div>'

    body += P(ek.esc(email_plan(u)) + f" You can change that any time in {ek.a(settings, 'your settings')}.")
    reach = f"just reply or write to {ek.a('mailto:' + REPLY_TO, ek.esc(REPLY_TO))}" if REPLY_TO else "just reply to this email"
    body += P(f"If something's confusing or broken, or there's a feature you want, {reach}. It comes straight to me.", margin="0 0 18px")
    body += P("Kevin", margin="0", weight=600, color=ek.TEXT)

    rows = f'<tr><td class="px" style="padding:22px 28px 0;">{body}</td></tr>'
    subject = "Welcome to Seli" if not watch else f"Welcome to Seli: where {', '.join(s['ticker'] for s in watch[:3])} stand"
    preheader = "A quick hello, and what you'll hear from us." if not watch else "What insiders have done in the stocks you picked."
    html_doc = ek.shell(title=subject, preheader=preheader, label="Welcome", body_rows=rows,
                        footer_html=ek.footer(reason="You're getting this because you signed up for Seli.",
                                              clerk_user_id=u["clerk_user_id"]))
    return subject, html_doc


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    if not os.environ.get("DATABASE_URL"):
        log.error("DATABASE_URL required"); sys.exit(1)
    conn = ek.get_connection()
    if SYNC_FROM_CLERK:
        sync_from_clerk(conn)

    window = ("(p.signed_up_at < now() - interval '14 days' OR p.signed_up_at IS NULL)" if BACKFILL
              else f"p.signed_up_at <= now() - interval '{MIN_AGE_HOURS} hours' AND p.signed_up_at >= now() - interval '14 days'")
    cur = conn.cursor()
    cur.execute(f"""
        SELECT p.clerk_user_id, p.email, p.first_name, p.signed_up_at, p.onboarded_at,
               p.weekly_digest IS TRUE AS weekly_digest, p.daily_digest IS TRUE AS daily_digest,
               (p.instant_watchlist_ticker OR p.instant_followed_insider
                OR p.instant_high_conviction OR p.instant_reversal) IS TRUE AS instant_any,
               (s.plan = 'pro') IS TRUE AS pro
          FROM public.user_preferences p
          LEFT JOIN public.subscriptions s ON s.clerk_user_id = p.clerk_user_id
         WHERE p.welcome_sent_at IS NULL
           AND p.email IS NOT NULL
           AND p.email_unsubscribed_at IS NULL
           AND {window}
    """)
    cols = [d.name for d in cur.description]
    users = [dict(zip(cols, r)) for r in cur.fetchall()]
    if ONLY_EMAIL:
        users = [u for u in users if (u["email"] or "").lower() == ONLY_EMAIL]
    if not users:
        log.info("Nobody due a welcome email."); conn.close(); return
    log.info(f"Welcome: {len(users)} user(s) due{' (backfill)' if BACKFILL else ''}")

    cur.execute("SELECT clerk_user_id, item_value FROM public.user_watchlist WHERE item_type = 'ticker' AND clerk_user_id = ANY(%s)",
                ([u["clerk_user_id"] for u in users],))
    by_id = {u["clerk_user_id"]: {**u, "tickers": []} for u in users}
    for uid, t in cur.fetchall():
        by_id[uid]["tickers"].append(str(t).upper())
    cur.close()

    today = date.today()
    statuses = ii.ticker_status(conn, sorted({t for u in by_id.values() for t in u["tickers"]}), today - timedelta(days=90), today, today=today)

    sent = failed = 0
    for u in by_id.values():
        try:
            subject, html_doc = compose(u, statuses, BACKFILL, today)
        except Exception:
            log.exception(f"  compose failed for {u['email']}"); failed += 1; continue
        ok = ek.send(to_email=u["email"], subject=subject, html_doc=html_doc, clerk_user_id=u["clerk_user_id"],
                     from_name="Kevin at Seli", from_email=FROM_EMAIL, reply_to=REPLY_TO, kind="welcome")
        if ok:
            sent += 1
            ek.log_sent(conn, u["clerk_user_id"], "welcome")
            if not ek.DRY_RUN:
                c2 = conn.cursor()
                c2.execute("UPDATE public.user_preferences SET welcome_sent_at = now() WHERE clerk_user_id = %s", (u["clerk_user_id"],))
                conn.commit(); c2.close()
        else:
            failed += 1
    conn.close()
    log.info(f"Done. sent={sent} failed={failed}")
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
