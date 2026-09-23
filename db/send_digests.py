#!/usr/bin/env python3
"""
db/send_digests.py
Weekly digest (every user who has it on, free AND Pro) and daily digest (Pro).

  DIGEST_TYPE=weekly python send_digests.py     # Sunday evening
  DIGEST_TYPE=daily  python send_digests.py     # weekday mornings, Pro only (default if unset)

  ONLY_EMAIL=you@x.com   send to just this one account (testing)
  DRY_RUN=true           build everything, send nothing
  PREVIEW_DIR=previews   also write every email to disk as HTML
  FORCE=true             ignore the "already sent this week" guard

What changed vs the old version, and why:
  - Free users get it. The old query joined subscriptions and required an
    active sub, so the 3-ticker free tier, which onboarding tells people
    comes with a Sunday digest, received nothing.
  - Leads with a story, not a list. One ranked "top buy" with who, how much,
    how much of their stake, and whether they've bought before, plus one
    line of plain context on what makes the filing stand out.
  - Watchlist always shows every ticker, even in a quiet week ("last insider
    buy was 14 months ago"). For a 3-ticker free user most weeks are quiet,
    and silence reads as "this thing isn't watching my stocks".
  - Market pulse: this week's buys/sales vs the 12-week average. One
    sentence, actually new information every week.
  - Subject line is the most interesting specific thing in the email, not
    "Your weekly digest: 12 tickers".
  - Rerun-safe (last_*_digest_at), one-click unsubscribe, plain-text part,
    UTM on every link so PostHog can tell you if it brings people back.
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

DIGEST_TYPE    = os.environ.get("DIGEST_TYPE", "daily")  # same default as the old script, so existing workflow steps behave the same
ONLY_EMAIL     = os.environ.get("ONLY_EMAIL", "").strip().lower()
FORCE          = os.environ.get("FORCE", "false").lower() == "true"
WORKER_URL     = os.environ.get("WORKER_URL") or os.environ.get("NEON_PROXY_URL", "")
WORKER_API_KEY = os.environ.get("WORKER_API_KEY", "")
FREE_WATCHLIST_CAP = 3
FREE_MARKET_ITEMS  = 5   # lead + 4


def portfolio_tickers_by_user() -> dict[str, set[str]]:
    if not WORKER_URL or not WORKER_API_KEY:
        log.info("WORKER_URL/WORKER_API_KEY not set, skipping portfolio section.")
        return {}
    try:
        r = requests.get(f"{WORKER_URL.rstrip('/')}/internal/portfolio-tickers-batch",
                         headers={"X-API-Key": WORKER_API_KEY}, timeout=60)
        if not r.ok:
            log.error(f"portfolio-tickers-batch {r.status_code}: {r.text[:200]}")
            return {}
        return {uid: set(ts) for uid, ts in r.json().get("tickers_by_user", {}).items()}
    except Exception as e:
        log.error(f"portfolio-tickers-batch failed: {e}")
        return {}


def conv_threshold(v) -> float:
    legacy = {"any": 0, "medium": 40, "high": 60, None: 0, "": 0}
    if v in legacy:
        return legacy[v]
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0


# ── Rendering pieces ────────────────────────────────────────────────────────
def pulse_block(pulse: dict | None, period_word: str) -> str:
    if not pulse:
        return ""
    stat = lambda label, big, small, color: (
        f'<td class="stack" width="50%" style="padding:12px 14px;background:{ek.SOFT};border-radius:8px;vertical-align:top;">'
        f'<div style="font-family:{ek.FONT};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{ek.MUTED};">{label}</div>'
        f'<div style="font-family:{ek.MONO};font-size:20px;font-weight:700;color:{color};margin-top:4px;">{big}</div>'
        f'<div style="font-family:{ek.FONT};font-size:12px;color:{ek.MUTED};margin-top:2px;">{small}</div></td>')
    grid = ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            + stat("Insiders bought", ek.money(pulse["buy_v"]), ek.plural(pulse["buy_n"], "filing"), ek.GREEN)
            + '<td width="10" style="font-size:0;">&nbsp;</td>'
            + stat("Insiders sold", ek.money(pulse["sell_v"]), ek.plural(pulse["sell_n"], "filing"), ek.RED)
            + "</tr></table>")
    line = ""
    if pulse["verdict"]:
        pct = round(abs(pulse["vs_avg"]) * 100)
        if pulse["verdict"] == "a normal amount of buying":
            line = f"About a normal {period_word} for insider buying, in line with the 12-{period_word} average."
        else:
            line = (f"That's {pulse['verdict']}: {pct}% {'above' if pulse['vs_avg'] > 0 else 'below'} "
                    f"the 12-{period_word} average number of buys.")
        line += " Sales usually outnumber buys in any given week."
    return grid + (ek.p(ek.esc(line), 13, ek.MUTED, "10px 0 0") if line else "")


def status_row(s: dict, href: str, *, sells_note: bool, portfolio: bool = False) -> tuple[str, bool]:
    """(html, used_sells_note). One ticker, one to two lines, always says something."""
    rb, rs, lb = s["recent_buys"], s["recent_sells"], s["last_buy"]
    chips, lines, used_note = [], [], False
    if rb["n"]:
        chips.append(ek.chip(f"{ek.plural(rb['n'], 'buy')} · {ek.money(rb['v'])}", "buy"))
        lines.append(f"{ii.summarize_people(rb['people'])} bought {ek.money(rb['v'])}.")
        top = rb["people"][0]
        if top["pct"] and top["pct"] >= 5:
            lines[-1] = lines[-1][:-1] + (f", growing their stake {top['pct']:.0f}%." if top["pct"] < 100 else ", more than doubling their stake.")
    if rs["n"]:
        chips.append(ek.chip(f"{ek.plural(rs['n'], 'sale')} · {ek.money(rs['v'])}", "sell"))
        lines.append(f"{ii.summarize_people(rs['people'])} sold {ek.money(rs['v'])}.")
        if not rb["n"] and sells_note:
            lines.append("Insiders sell for many reasons, including taxes, diversification and pre-scheduled trading plans.")
            used_note = True
    if not rb["n"] and not rs["n"]:
        chips.append(ek.chip("Quiet", "neutral"))
        if not s["known"]:
            lines.append("No insider filings on record for this ticker yet.")
        elif lb:
            lines.append(f"No insider trades. Last insider buy: {lb['name']} ({lb['role']}), {ek.money(lb['value'])}, {ek.ago(lb['date'])}.")
        else:
            lines.append("No insider trades. No open-market insider buys on record for this one.")
        ys = s["yr_sells"]
        if ys["n"] and s["known"]:
            yb_n = s["yr_buys"]["n"]
            lines.append(f"Last 12 months: {ek.plural(yb_n, 'buy') if yb_n else 'no buys'}, {ek.plural(ys['n'], 'sale')} ({ek.money(ys['v'])}).")
    held = ek.chip("You hold this", "accent") if portfolio else ""
    html = (f'<tr><td style="padding:12px 0;border-top:1px solid {ek.BORDER};">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td class="stack" style="vertical-align:top;">{ek.ticker_tag(s["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(s["company"])}</span></td>'
            f'<td class="stack" style="vertical-align:top;text-align:right;white-space:nowrap;">{held}{"".join(chips)}</td>'
            f'</tr></table>'
            + "".join(ek.p(ek.esc(l), 13, ek.TEXT_2 if i == 0 else ek.MUTED, "6px 0 0") for i, l in enumerate(lines))
            + "</td></tr>")
    return html, used_note


def status_table(statuses: list[dict], medium: str, campaign: str, portfolio: bool = False, sells_note_used: bool = False) -> tuple[str, bool]:
    rows = ""
    for s in statuses:
        h, used = status_row(s, ek.track(ek.ticker_path(s["ticker"]), medium, "watchlist" if not portfolio else "portfolio", campaign),
                             sells_note=not sells_note_used, portfolio=portfolio)
        sells_note_used = sells_note_used or used
        rows += h
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>', sells_note_used


def lead_card(c: dict, medium: str, campaign: str) -> str:
    t_href = ek.track(ek.ticker_path(c["ticker"]), medium, "lead", campaign)
    rows = ""
    for b in c["buyers"][:4]:
        stake = ek.chip(b["stake"], "neutral") if b["stake"] else ""
        rows += (f'<tr><td style="padding:8px 0;border-top:1px solid {ek.BORDER};font-family:{ek.FONT};font-size:13px;">'
                 f'{ek.a(ek.track(ek.insider_path(b["raw"]), medium, "lead_insider", campaign), ek.esc(b["name"]), ek.TEXT, 600)}'
                 f'<span style="color:{ek.MUTED};"> · {ek.esc(b["role"])}</span></td>'
                 f'<td style="padding:8px 0;border-top:1px solid {ek.BORDER};text-align:right;white-space:nowrap;">{stake}'
                 f'<span style="font-family:{ek.MONO};font-size:13px;font-weight:700;color:{ek.GREEN};">{ek.money(b["value"])}</span></td></tr>')
    more = len(c["buyers"]) - 4
    if more > 0:
        rows += f'<tr><td colspan="2" style="padding:6px 0 0;font-family:{ek.FONT};font-size:12px;color:{ek.MUTED};">+ {ek.plural(more, "more insider")}</td></tr>'
    chips = "".join(ek.chip(label, tone) for label, tone in c["facts"] if not label.endswith(" total"))
    why = (f'<div style="margin:14px 0 0;padding:12px 14px;background:{ek.TINT};border-radius:8px;">'
           f'<div style="font-family:{ek.FONT};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{ek.ACCENT_STR};margin-bottom:4px;">About this filing</div>'
           f'{ek.p(ek.esc(ii.filing_context(c)), 13, ek.TEXT_2, "0")}</div>')
    head = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="vertical-align:top;">{ek.ticker_tag(c["ticker"], t_href)}'
            f'<span style="font-family:{ek.FONT};font-size:14px;font-weight:700;color:{ek.TEXT};margin-left:8px;">{ek.esc(c["company"])}</span></td>'
            f'<td style="text-align:right;vertical-align:top;font-family:{ek.MONO};font-size:18px;font-weight:700;color:{ek.GREEN};white-space:nowrap;">{ek.money(c["total"])}</td>'
            f'</tr></table>')
    body = (head
            + ek.p(ek.esc(ii.lead_sentence(c)), 14, ek.TEXT_2, "12px 0 10px")
            + (f'<div style="margin:0 0 6px;">{chips}</div>' if chips else "")
            + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>'
            + why
            + ek.p(ek.a(t_href, f"See every {ek.esc(c['ticker'])} filing on Seli &rarr;"), 13, ek.ACCENT, "14px 0 0"))
    return ek.card(body, accent_left=ek.GREEN)


def compact_row(c: dict, medium: str, campaign: str) -> str:
    href = ek.track(ek.ticker_path(c["ticker"]), medium, "more", campaign)
    facts = [label for label, _ in c["facts"] if not label.endswith(" total")][:3]
    top = c["buyers"][0]
    detail = " · ".join(facts) if facts else f"{top['name']} ({top['role']})"
    return (f'<tr><td style="padding:12px 0;border-top:1px solid {ek.BORDER};">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="vertical-align:top;">{ek.ticker_tag(c["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.TEXT};font-weight:600;margin-left:8px;">{ek.esc(c["company"])}</span></td>'
            f'<td style="text-align:right;vertical-align:top;font-family:{ek.MONO};font-size:14px;font-weight:700;color:{ek.GREEN};white-space:nowrap;">{ek.money(c["total"])}</td>'
            f'</tr></table>{ek.p(ek.esc(detail), 12, ek.MUTED, "6px 0 0")}</td></tr>')


def nudge_block(n_watch: int, medium: str, campaign: str) -> str:
    """Free users only (caller checks). n_watch is the real server-side count,
    now that free watchlists sync to user_watchlist."""
    if n_watch == 0:
        inner = (ek.p("<strong>Your watchlist is empty.</strong> Add up to 3 tickers and this email will start "
                      "each week with insider activity on those stocks.", 14, ek.TEXT_2, "0 0 12px")
                 + ek.button("Add tickers", ek.track("/watchlist", medium, "nudge_empty", campaign)))
    elif n_watch < FREE_WATCHLIST_CAP:
        k = FREE_WATCHLIST_CAP - n_watch
        inner = ek.p(f"You're using {n_watch} of {FREE_WATCHLIST_CAP} free watchlist slots. "
                     f"{ek.a(ek.track('/watchlist', medium, 'nudge_slot', campaign), 'Add ' + ('another ticker' if k == 1 else f'{k} more tickers'))} "
                     f"and {'it' if k == 1 else 'they'}'ll show up here next week.", 14, ek.TEXT_2, "0")
    else:
        inner = (ek.p(f"<strong>You're using all {FREE_WATCHLIST_CAP} free watchlist slots.</strong> Pro removes the limit and adds "
                      "same-day email alerts when insiders file on stocks you watch. $6.99/mo.", 14, ek.TEXT_2, "0 0 10px")
                 + ek.p(ek.a(ek.track("/settings?section=billing", medium, "nudge_pro", campaign), "See what Pro includes &rarr;"), 13, ek.ACCENT, "0"))
    return f'<tr><td class="px" style="padding:26px 28px 0;">{ek.card(inner, bg=ek.SOFT)}</td></tr>'


# ── Compose one email ───────────────────────────────────────────────────────
def compose(u: dict, *, weekly: bool, statuses: dict, clusters_by_key: dict, pulse: dict | None,
            followed: dict, holdings: set[str], today: date) -> tuple[str, str] | None:
    medium = "weekly_digest" if weekly else "daily_digest"
    campaign = today.isoformat()
    period = "week" if weekly else "day"
    this_period = "this week" if weekly else "today"
    pro = u["pro"]

    watch = sorted(set(u["tickers"]))
    # active tickers first (buys, then sales), quiet ones after
    w_status = sorted([statuses[t] for t in watch if t in statuses],
                      key=lambda s: (-s["recent_buys"]["v"], -s["recent_sells"]["v"], s["ticker"]))
    w_active = [s for s in w_status if s["recent_buys"]["n"] or s["recent_sells"]["n"]]
    w_buying = sorted([s for s in w_status if s["recent_buys"]["n"]], key=lambda s: s["recent_buys"]["v"], reverse=True)

    show_market = not (pro and u.get("digest_watchlist_only")) and (u.get("digest_top_signals") is not False or not pro)
    key = (bool(u.get("digest_corporate", True)), bool(u.get("digest_congressional", True)))
    clusters = clusters_by_key.get(key, []) if show_market else []
    if pro:
        thr, minv = conv_threshold(u.get("digest_min_conviction")), float(u.get("digest_min_value") or 0)
        clusters = [c for c in clusters if c["score"] >= thr and max(b["value"] for b in c["buyers"]) >= minv]
        cap = max(1, min(int(u.get("digest_max_signals") or 10), 10))
    else:
        cap = FREE_MARKET_ITEMS
    # watchlist tickers already get their own row; don't repeat them below
    market = [c for c in clusters if c["ticker"] not in set(watch)][:cap]
    congress_pick = None
    if show_market and key[1]:
        congress_pick = next((c for c in clusters_by_key.get((False, True), [])
                              if c["ticker"] not in {m["ticker"] for m in market} and c["ticker"] not in set(watch)), None)
    lead, others = (market[0], market[1:]) if market else (None, [])

    port_status = []
    if pro and holdings:
        port_status = [statuses[t] for t in sorted(holdings) if t in statuses and t not in set(watch)
                       and (statuses[t]["recent_buys"]["n"] or statuses[t]["recent_sells"]["n"])]
    fol = [(name, acts) for name, acts in followed.items() if name in set(u["insiders"])]

    if not weekly and not (w_active or port_status or fol or lead):
        return None  # daily digest with nothing new: don't send
    if weekly and not (w_status or lead or pulse):
        return None

    # Subject: the most specific interesting thing in the email
    if w_buying:
        s0 = w_buying[0]
        rb0 = s0["recent_buys"]
        if rb0["insiders"] == 1:
            role = rb0["people"][0]["role"]
            who = "a member of Congress" if role == "Congress" else ("a 10% owner" if role == "10% owner" else
                  f"the {role}" if role in ii.CSUITE_ROLES else f"a {role.lower()}")
        else:
            who = f"{rb0['insiders']} insiders"
        subject = f"{s0['ticker']}: {who} bought {ek.money(rb0['v'])} {this_period}"
    elif lead:
        co = ii.short_company(lead["company"])
        top = lead["buyers"][0]
        if lead["n_insiders"] >= 2:
            subject = f"{lead['n_insiders']} insiders at {co} bought {ek.money(lead['total'])} {this_period}"
        elif top["role"] == "Congress":
            subject = f"A member of Congress bought {ek.money(lead['total'])} of {lead['ticker']}"
        elif top["role"] in ii.CSUITE_ROLES or top["role"] == "Chair":
            subject = f"{co}'s {top['role']} just bought {ek.money(lead['total'])} of stock"
        else:
            subject = f"A {co} insider bought {ek.money(lead['total'])} of stock {this_period}"
    else:
        subject = f"Your {'week' if weekly else 'day'} in insider trading"

    if watch:
        names = ", ".join(watch[:3]) + (f" +{len(watch) - 3}" if len(watch) > 3 else "")
        preheader = f"Plus what insiders did with {names}{' and how the week compared' if weekly else ''}."
    else:
        preheader = f"Plus how much insiders bought vs sold {this_period}."

    # Body
    hi = f"Hey {ek.esc(u['first_name'])}," if u.get("first_name") else "Hey,"
    intro = ek.p(f"{hi} here's what insiders did with their own money {this_period}.", 15, ek.TEXT_2, "0 0 16px")
    rows = f'<tr><td class="px" style="padding:22px 28px 0;">{intro}{pulse_block(pulse, period)}</td></tr>'

    watch_html = ""
    note_used = False
    if w_status:
        tbl, note_used = status_table(w_status, medium, campaign)
        sub = (f"{ek.plural(len(w_active), 'ticker')} with insider activity {this_period}." if w_active
               else f"Nothing filed on your tickers {this_period}. Here's where they stand.")
        watch_html = ek.section("Your watchlist", ek.p(ek.esc(sub), 13, ek.MUTED, "0 0 4px") + tbl, kicker="Yours")
    if fol:
        items = ""
        for name, acts in fol:
            for g in acts[:3]:
                verb, color = ("bought", ek.GREEN) if g["type"] == "buy" else ("sold", ek.RED)
                items += ek.p(f'{ek.a(ek.track(ek.insider_path(g["raw"]), medium, "followed", campaign), ek.esc(g["name"]), ek.TEXT)} '
                              f'<span style="color:{color};font-weight:600;">{verb} {ek.money(g["value"])}</span> of '
                              f'{ek.ticker_tag(g["ticker"], ek.track(ek.ticker_path(g["ticker"]), medium, "followed", campaign))}', 14, ek.TEXT_2, "0 0 10px")
        watch_html += ek.section("Insiders you follow", items, pad_top=24)
    if port_status:
        tbl, note_used = status_table(port_status, medium, campaign, portfolio=True, sells_note_used=note_used)
        watch_html += ek.section("In your portfolio", tbl, pad_top=24)

    market_html = ""
    if lead:
        market_html += ek.section(f"Featured filing {this_period}", ek.p("Chosen by how many insiders bought, their roles, trade size and stake change. It's a summary of what was filed, not a recommendation.", 13, ek.MUTED, "0 0 10px") + lead_card(lead, medium, campaign), kicker="Insider buying")
    if others:
        tbl = "".join(compact_row(c, medium, campaign) for c in others)
        market_html += ek.section(f"More insider buying {this_period}", f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{tbl}</table>', pad_top=24)
    if congress_pick:
        b = congress_pick["buyers"][0]
        market_html += ek.section("From Congress", ek.p(
            f'{ek.esc(b["name"])} bought {ek.money(congress_pick["total"])} of '
            f'{ek.ticker_tag(congress_pick["ticker"], ek.track(ek.ticker_path(congress_pick["ticker"]), medium, "congress", campaign))} '
            f'({ek.esc(congress_pick["company"])}). Congressional disclosures are often filed weeks after the trade date.', 14, ek.TEXT_2, "0"), pad_top=24)

    # Personal activity leads when there is some; otherwise the story does.
    rows += (watch_html + market_html) if w_active or port_status or fol else (market_html + watch_html)

    if not pro:  # never shown to Pro (plan = 'pro' in subscriptions, same check the Worker uses)
        rows += nudge_block(len(watch), medium, campaign)

    rows += (f'<tr><td class="px" style="padding:26px 28px 0;">'
             + ek.button("Open Seli", ek.track("/", medium, "cta", campaign)) + "</td></tr>")

    when = "every Sunday" if weekly else "on weekday mornings"
    html_doc = ek.shell(
        title=subject, preheader=preheader,
        label=("Weekly" if weekly else "Daily") + f" · {ek.long_date(today)}",
        body_rows=rows,
        footer_html=ek.footer(reason=f"You're getting this because the {'weekly' if weekly else 'daily'} digest is on for your Seli account. It goes out {when}.",
                              clerk_user_id=u["clerk_user_id"]))
    return subject, html_doc


# ── Main ────────────────────────────────────────────────────────────────────
USERS_SQL = """
SELECT p.clerk_user_id, p.email, p.first_name, p.digest_top_signals, p.digest_congressional,
       p.digest_corporate, p.digest_watchlist_only, p.digest_min_conviction,
       p.digest_max_signals, p.digest_min_value,
       (s.plan = 'pro') IS TRUE AS pro
  FROM public.user_preferences p
  LEFT JOIN public.subscriptions s ON s.clerk_user_id = p.clerk_user_id
 WHERE p.email IS NOT NULL
   AND p.email_unsubscribed_at IS NULL
   AND {freq_filter}
"""


def main():
    if DIGEST_TYPE not in ("weekly", "daily"):
        log.error("DIGEST_TYPE must be 'weekly' or 'daily'"); sys.exit(1)
    if not os.environ.get("DATABASE_URL"):
        log.error("DATABASE_URL required"); sys.exit(1)
    weekly = DIGEST_TYPE == "weekly"
    days = 7 if weekly else 1
    today = date.today()

    if weekly:
        freq = ("p.weekly_digest = true"
                # brand-new signups get the welcome email first; their first digest is next week
                " AND (p.signed_up_at IS NULL OR p.signed_up_at < now() - interval '18 hours')"
                + ("" if FORCE else " AND (p.last_weekly_digest_at IS NULL OR p.last_weekly_digest_at < now() - interval '5 days')"))
    else:
        freq = ("p.daily_digest = true AND s.plan = 'pro'"
                + ("" if FORCE else " AND (p.last_daily_digest_at IS NULL OR p.last_daily_digest_at < now() - interval '18 hours')"))

    conn = ek.get_connection()
    cur = conn.cursor()
    cur.execute(USERS_SQL.format(freq_filter=freq))
    cols = [d.name for d in cur.description]
    users = [dict(zip(cols, r)) for r in cur.fetchall()]
    if ONLY_EMAIL:
        users = [u for u in users if (u["email"] or "").lower() == ONLY_EMAIL]
    if not users:
        log.info(f"No users due for the {DIGEST_TYPE} digest."); conn.close(); return
    log.info(f"{DIGEST_TYPE} digest: {len(users)} user(s) due")

    cur.execute("SELECT clerk_user_id, item_type, item_value FROM public.user_watchlist WHERE clerk_user_id = ANY(%s)",
                ([u["clerk_user_id"] for u in users],))
    for u in users:
        u["tickers"], u["insiders"] = [], []
    by_id = {u["clerk_user_id"]: u for u in users}
    for uid, item_type, val in cur.fetchall():
        if item_type == "ticker":
            by_id[uid]["tickers"].append(str(val).upper())
        else:
            by_id[uid]["insiders"].append(val)
    cur.close()

    holdings = portfolio_tickers_by_user() if any(u["pro"] for u in users) else {}

    all_tickers = {t for u in users for t in u["tickers"]} | {t for uid, ts in holdings.items() if uid in by_id and by_id[uid]["pro"] for t in ts}
    statuses = ii.ticker_status(conn, sorted(all_tickers), window_days=days, today=today)
    buys = ii.week_buys(conn, days=days)
    clusters_by_key = {k: ii.build_clusters(buys, include_corporate=k[0], include_congress=k[1])
                       for k in [(True, True), (True, False), (False, True)]}
    pulse = ii.market_pulse(conn, days=days)
    followed = ii.followed_activity(conn, [n for u in users for n in u["insiders"]], days=days)
    log.info(f"  {len(buys)} buys filed, {len(clusters_by_key[(True, True)])} tickers with buying, "
             f"{len(statuses)} watched/held tickers")

    stamp_col = "last_weekly_digest_at" if weekly else "last_daily_digest_at"
    sent = skipped = failed = 0
    for u in users:
        try:
            out = compose(u, weekly=weekly, statuses=statuses, clusters_by_key=clusters_by_key, pulse=pulse,
                          followed=followed, holdings=holdings.get(u["clerk_user_id"], set()), today=today)
        except Exception:
            log.exception(f"  compose failed for {u['email']}"); failed += 1; continue
        if not out:
            skipped += 1; continue
        subject, html_doc = out
        ok = ek.send(to_email=u["email"], subject=subject, html_doc=html_doc, clerk_user_id=u["clerk_user_id"],
                     from_name=f"Seli {'Weekly' if weekly else 'Daily'}", kind=f"{DIGEST_TYPE}_digest")
        if ok:
            sent += 1
            if not ek.DRY_RUN:
                c2 = conn.cursor()
                c2.execute(f"UPDATE public.user_preferences SET {stamp_col} = now() WHERE clerk_user_id = %s", (u["clerk_user_id"],))
                conn.commit(); c2.close()
        else:
            failed += 1
    conn.close()
    log.info(f"Done. sent={sent} skipped={skipped} failed={failed}")
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
