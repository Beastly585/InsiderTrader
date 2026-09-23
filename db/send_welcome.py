#!/usr/bin/env python3
"""
db/send_welcome.py
The day-2 email. Runs once a day (09:00 ET) and sends to everyone who signed
up 10+ hours ago and hasn't had it yet, so it lands the morning after signup:
inside the window where new users currently vanish, and before their first
Sunday digest.

Short note from Kevin in four clearly separated sections:
  1. Welcome           what Seli is, and that we only email if they've opted in
  2. What you're following   one factual line per watchlist ticker (or an
                       "add tickers" button if empty)
  3. What happens next exactly which emails they're set to get, based on
                       their real settings, and where to change it
  4. Need help?        reply / support address

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
from datetime import date

import requests

import email_kit as ek
import insider_intel as ii

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ONLY_EMAIL       = os.environ.get("ONLY_EMAIL", "").strip().lower()
BACKFILL         = os.environ.get("BACKFILL", "false").lower() == "true"
SYNC_FROM_CLERK  = os.environ.get("SYNC_FROM_CLERK", "false").lower() == "true"
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
FROM_EMAIL       = os.environ.get("WELCOME_FROM_EMAIL") or ek.FROM_EMAIL
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
def block(kicker: str, title: str, inner: str, first: bool = False) -> str:
    """One clearly separated section: divider, small label, heading, content."""
    rule = "" if first else f'<div style="height:1px;background:{ek.BORDER};margin:0 0 22px;line-height:1px;font-size:1px;">&nbsp;</div>'
    return (f'<tr><td class="px" style="padding:{22 if first else 26}px 28px 0;">{rule}'
            f'<div style="font-family:{ek.FONT};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:{ek.ACCENT};margin:0 0 4px;">{ek.esc(kicker)}</div>'
            f'<div style="font-family:{ek.FONT};font-size:18px;font-weight:800;color:{ek.TEXT};letter-spacing:-.3px;margin:0 0 10px;">{ek.esc(title)}</div>'
            f'{inner}</td></tr>')


def follow_row(s: dict) -> str:
    """One ticker, one line of plain fact."""
    href = ek.track(ek.ticker_path(s["ticker"]), MEDIUM, "following")
    lb, ys = s["last_buy"], s["yr_sells"]
    if not s["known"]:
        line = "No insider filings on record yet."
    elif lb:
        line = f"Last insider buy: {lb['name']} ({lb['role']}), {ek.money(lb['value'])}, {ek.ago(lb['date'])}."
    elif ys["n"]:
        line = f"No insider buys on record. {ek.plural(ys['n'], 'insider sale')} in the last 12 months."
    else:
        line = "No open-market insider trades on record."
    return (f'<tr><td style="padding:10px 0;border-top:1px solid {ek.BORDER};">'
            f'{ek.ticker_tag(s["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(s["company"])}</span>'
            f'{ek.p(ek.esc(line), 13, ek.TEXT_2, "6px 0 0")}</td></tr>')


def email_plan(u: dict) -> list[str]:
    """Plain sentences describing exactly what this person has turned on."""
    on = []
    if u.get("weekly_digest"):
        on.append("a weekly digest on Sunday evenings covering insider activity on your watchlist and the week's notable insider buying")
    if u.get("pro") and u.get("daily_digest"):
        on.append("a daily digest on weekday mornings")
    if u.get("pro") and u.get("instant_any"):
        on.append("an alert the day an insider files on something you've set alerts for")
    if not on:
        return ["All Seli emails are off for you, so this is the only one you'll get unless you turn something on."]
    lines = ["You're set to get " + (on[0] if len(on) == 1 else ", ".join(on[:-1]) + " and " + on[-1]) + ". That's it."]
    if u.get("pro") and not u.get("instant_any"):
        lines.append("You're on Pro, so same-day alerts are available too. They're off until you turn them on.")
    return lines


def compose(u: dict, statuses: dict, backfill: bool, today: date) -> tuple[str, str]:
    name = u.get("first_name")
    watch = [statuses[t] for t in sorted(set(u["tickers"])) if t in statuses]
    P = lambda html, **kw: ek.p(html, **{"size": 15, "color": ek.TEXT_2, **kw})
    settings = ek.track("/settings?section=notifications", MEDIUM, "settings")

    # 1. Welcome
    hello = P(f"Hey {ek.esc(name) if name else 'there'},", margin="0 0 12px")
    if backfill:
        hello += P("Kevin here, I built Seli. You signed up a while back, so here's a quick hello and a rundown of how things work now.")
    else:
        hello += P("Thanks for signing up. I'm Kevin, I built Seli.")
    hello += P("Seli tracks the stock trades that company insiders and members of Congress are required to disclose, "
               "and lays them out so they're easy to read. We won't fill up your inbox: you only hear from us if you've "
               "turned on a digest or alerts.", margin="0")
    rows = block("Welcome", "Welcome to Seli", hello, first=True)

    # 2. What you're following
    if watch:
        tbl = "".join(follow_row(s) for s in watch)
        inner = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{tbl}</table>'
                 + ek.p(ek.a(ek.track("/watchlist", MEDIUM, "watchlist"), "Open your watchlist &rarr;"), 13, ek.ACCENT, "12px 0 0"))
    else:
        limit = "Add as many as you like." if u.get("pro") else "Free accounts can follow up to 3."
        target = "/watchlist" if u.get("onboarded_at") else "/onboard"
        inner = (P(f"Nothing yet. Add the tickers you own or keep an eye on and Seli will track insider filings on them. {limit}", margin="0 0 14px")
                 + ek.button("Add tickers", ek.track(target, MEDIUM, "add_tickers")))
    rows += block("Your watchlist", "What you're following", inner)

    # 3. What happens next
    nxt = "".join(P(ek.esc(l), margin="0 0 10px") for l in email_plan(u))
    nxt += P(f"You can change any of this in {ek.a(settings, 'Settings')}, or unsubscribe with the link at the bottom of any email.", margin="0")
    rows += block("Next", "What happens next", nxt)

    # 4. Support
    reach = (f"reply to this email or write to {ek.a('mailto:' + REPLY_TO, ek.esc(REPLY_TO))}" if REPLY_TO
             else "just reply to this email")
    help_html = (P(f"Questions, something broken, or a feature you want? {reach[0].upper() + reach[1:]}. It comes straight to me and I read every one.", margin="0 0 16px")
                 + P("Kevin", margin="0", weight=600, color=ek.TEXT))
    rows += block("Support", "Need help?", help_html)

    subject = "Welcome to Seli"
    preheader = "What you're following, what to expect, and how to reach me."
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
    statuses = ii.ticker_status(conn, sorted({t for u in by_id.values() for t in u["tickers"]}), window_days=90, today=today)

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
