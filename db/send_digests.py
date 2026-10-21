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

How it decides what to send (the shared rules are in email_kit.py):
  - Daily covers the last COMPLETE filing day (Friday's filings on Monday),
    not the few filings that exist at 7am. Weekly covers the last 7 days.
  - The subject is the most specific new thing for this person, and the
    email opens with that same thing: their stocks if something happened,
    otherwise the top insider buy.
  - Trades already sent as instant alerts get one line, not a repeat.
  - Daily only goes out when there's something new; it skips the day a
    weekly went out. Weekly always goes (it's the "where your stocks stand").
  - Market totals are one quiet line near the bottom, compared with typical
    days or weeks.
  - Free users see the Pro pitch at most once every 4 weeks. Pro never does.
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
FREE_MARKET_ITEMS  = 4   # lead + 3


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
def pulse_line(pulse: dict | None, win: dict) -> str:
    """One quiet sentence near the bottom, not two big stat boxes up top: the
    market total is context, not the news."""
    if not pulse:
        return ""
    s = (f"Across the market {win['label']}, insiders filed {ek.plural(pulse['buy_n'], 'open-market buy')} "
         f"({ek.money(pulse['buy_v'])}) and {ek.plural(pulse['sell_n'], 'sale')} ({ek.money(pulse['sell_v'])}).")
    avg, period = pulse.get("avg_buy_n"), win["period"]
    if pulse.get("verdict") == "normal":
        s += f" A typical {period} for buying."
    elif pulse.get("verdict"):
        s += f" {'More' if pulse['verdict'] == 'more' else 'Fewer'} buys than a typical {period} (usually about {round(avg)})."
    return ek.p(ek.esc(s), 13, ek.MUTED, "0")


def rc_n(s: dict) -> int:
    return (s.get("recent_congress") or {"n": 0})["n"]


def is_active(s: dict) -> bool:
    return bool(s["recent_buys"]["n"] or s["recent_sells"]["n"] or rc_n(s))


def ticker_head(s: dict, href: str, chips_html: str = "") -> str:
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td class="stack" style="vertical-align:top;">{ek.ticker_tag(s["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};margin-left:8px;">{ek.esc(s["company"])}</span></td>'
            f'<td class="stack" style="vertical-align:top;text-align:right;white-space:nowrap;">{chips_html}</td>'
            f'</tr></table>')


def active_row(s: dict, href: str, portfolio: bool = False) -> str:
    """A watched (or held) ticker with new filings: what happened, in one or
    two plain sentences, with how much of their holding it was."""
    rb, rs = s["recent_buys"], s["recent_sells"]
    chips, lines = [], []
    if rb["n"]:
        chips.append(ek.chip(f"{ek.plural(rb['n'], 'buy')} · {ek.money(rb['v'])}", "buy"))
        top = rb["people"][0]
        lines.append(f"{ii.summarize_people(rb['people'])} bought {ek.money(rb['v'])}{ii.holding_phrase(top['pct'], False) if rb['insiders'] == 1 else ''}.")
    if rs["n"]:
        chips.append(ek.chip(f"{ek.plural(rs['n'], 'sale')} · {ek.money(rs['v'])}", "sell"))
        top = rs["people"][0]
        lines.append(f"{ii.summarize_people(rs['people'])} sold {ek.money(rs['v'])}{ii.holding_phrase(top['pct'], True) if rs['insiders'] == 1 else ''}.")
    rc = s.get("recent_congress") or {"n": 0}
    if rc["n"]:
        c = rc["latest"]
        chips.append(ek.chip("Congress", "accent"))
        lines.append(f"{c['name']} (Congress) disclosed a {'purchase' if c['type'] == 'buy' else 'sale'} of {ek.congress_range(c['value'])}"
                     f"{', traded ' + ek.short_date(c['date']) if c.get('date') else ''}.")
    held = ek.chip("You hold this", "accent") if portfolio else ""
    return (f'<tr><td style="padding:12px 0;border-top:1px solid {ek.BORDER};">{ticker_head(s, href, held + "".join(chips))}'
            + "".join(ek.p(ek.esc(l), 14, ek.TEXT_2, "6px 0 0") for l in lines) + "</td></tr>")


def quiet_row(s: dict, href: str) -> str:
    """Weekly only: one muted line on where a quiet stock stands."""
    lb, ys = s["last_buy"], s["yr_sells"]
    if not s["known"]:
        line = "No insider filings on record for this one yet."
    elif lb:
        line = f"No new filings. Last insider buy: {lb['name']} ({lb['role']}), {ek.money(lb['value'])}, {ek.ago(lb['date'])}."
    else:
        line = "No new filings, and no open-market insider buys on record."
    if s["known"] and ys["n"] and not s["yr_buys"]["n"]:
        line += f" {ek.plural(ys['n'], 'sale')} ({ek.money(ys['v'])}) in the last 12 months."
    return (f'<tr><td style="padding:10px 0;border-top:1px solid {ek.BORDER};">{ticker_head(s, href)}'
            + ek.p(ek.esc(line), 13, ek.MUTED, "4px 0 0") + "</td></tr>")


def table(rows_html: str) -> str:
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows_html}</table>'


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
    head = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="vertical-align:top;">{ek.ticker_tag(c["ticker"], t_href)}'
            f'<span style="font-family:{ek.FONT};font-size:14px;font-weight:700;color:{ek.TEXT};margin-left:8px;">{ek.esc(c["company"])}</span></td>'
            f'<td style="text-align:right;vertical-align:top;padding-left:12px;font-family:{ek.MONO};font-size:18px;font-weight:700;color:{ek.GREEN};white-space:nowrap;">{ek.money(c["total"])}</td>'
            f'</tr></table>')
    body = (head
            + ek.p(ek.esc(ii.lead_sentence(c)), 14, ek.TEXT_2, "12px 0 10px")
            + table(rows)
            + ek.p(ek.esc(ii.filing_context(c)), 13, ek.MUTED, "12px 0 0")
            + ek.p(ek.a(t_href, f"See every {ek.esc(c['ticker'])} filing &rarr;"), 13, ek.ACCENT, "12px 0 0"))
    return ek.card(body, accent_left=ek.GREEN)


def compact_row(c: dict, medium: str, campaign: str) -> str:
    href = ek.track(ek.ticker_path(c["ticker"]), medium, "more", campaign)
    top = c["buyers"][0]
    who = f"{top['name']} ({top['role']})" + (f" + {ek.plural(c['n_insiders'] - 1, 'other')}" if c["n_insiders"] > 1 else "")
    # role is already in `who`; keep only facts it doesn't say (stake, first buy in years)
    facts = [label for label, _ in c["facts"] if not label.endswith((" total", " buying"))][:2]
    detail = " · ".join([who] + facts)
    return (f'<tr><td style="padding:12px 0;border-top:1px solid {ek.BORDER};">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="vertical-align:top;">{ek.ticker_tag(c["ticker"], href)}'
            f'<span style="font-family:{ek.FONT};font-size:13px;color:{ek.TEXT};font-weight:600;margin-left:8px;">{ek.esc(c["company"])}</span></td>'
            f'<td style="text-align:right;vertical-align:top;padding-left:12px;font-family:{ek.MONO};font-size:14px;font-weight:700;color:{ek.GREEN};white-space:nowrap;">{ek.money(c["total"])}</td>'
            f'</tr></table>{ek.p(ek.esc(detail), 12, ek.MUTED, "6px 0 0")}</td></tr>')


def nudge_block(n_watch: int, medium: str, campaign: str, pro_pitch_ok: bool) -> tuple[str, str | None]:
    """Free users only. Returns (html, kind logged or None). Helpful nudges
    (an empty or half-empty watchlist) show whenever true; the Pro pitch shows
    at most once every 4 weeks."""
    if n_watch == 0:
        inner = (ek.p("<strong>Your watchlist is empty.</strong> Add up to 3 stocks or people and this email will start "
                      "with what their insiders did.", 14, ek.TEXT_2, "0 0 12px")
                 + ek.button("Add stocks", ek.track("/watchlist", medium, "nudge_empty", campaign)))
        kind = None
    elif n_watch < FREE_WATCHLIST_CAP:
        k = FREE_WATCHLIST_CAP - n_watch
        inner = ek.p(f"You're watching {n_watch} of {FREE_WATCHLIST_CAP} free slots. "
                     f"{ek.a(ek.track('/watchlist', medium, 'nudge_slot', campaign), 'Add ' + ('one more' if k == 1 else f'{k} more'))} "
                     f"and {'it' if k == 1 else 'they'}'ll show up here.", 13, ek.TEXT_2, "0")
        kind = None
    elif pro_pitch_ok:
        inner = (ek.p("<strong>Want to hear the same day?</strong> Pro emails you when an insider files on anything you watch, "
                      "with no 3-stock limit. $6.99/mo.", 13, ek.TEXT_2, "0 0 8px")
                 + ek.p(ek.a(ek.track("/account#billing", medium, "nudge_pro", campaign), "See what Pro includes &rarr;"), 13, ek.ACCENT, "0"))
        kind = "nudge_pro"
    else:
        return "", None
    return f'<tr><td class="px" style="padding:24px 28px 0;">{ek.card(inner, bg=ek.SOFT)}</td></tr>', kind


def who_phrase(people: list[dict], n: int) -> str:
    if n != 1:
        return f"{n} insiders"
    role = people[0]["role"]
    if role == "Congress":
        return "a member of Congress"
    if role == "10% owner":
        return "a 10% owner"
    return f"the {role}" if role in ii.CSUITE_ROLES or role == "Chair" else f"a {role.lower()}"


# ── Compose one email ───────────────────────────────────────────────────────
def compose(u: dict, *, weekly: bool, win: dict, statuses: dict, clusters_by_key: dict, pulse: dict | None,
            followed: dict, holdings: set[str], today: date, alerted: set[str], pro_pitch_ok: bool) -> dict | None:
    """Returns {subject, html, refs, extra_kinds} or None when there's nothing worth sending."""
    medium = "weekly_digest" if weekly else "daily_digest"
    campaign = today.isoformat()
    when = win["label"]  # "this week" | "yesterday" | "on Friday"
    pro = u["pro"]
    href = lambda t, what: ek.track(ek.ticker_path(t), medium, what, campaign)

    watch = sorted(set(u["tickers"]))
    w_status = [statuses[t] for t in watch if t in statuses]
    # Anything already sent as an instant alert is mentioned, not repeated.
    def fresh(s):
        accs = s["recent_buys"]["accs"] | s["recent_sells"]["accs"]
        return is_active(s) and not (accs and accs <= alerted and not rc_n(s))
    w_new = sorted([s for s in w_status if fresh(s)], key=lambda s: (-s["recent_buys"]["v"], -s["recent_sells"]["v"], s["ticker"]))
    w_alerted = [s for s in w_status if is_active(s) and not fresh(s)]
    w_quiet = [s for s in w_status if not is_active(s)]

    port_new = []
    if pro and holdings:
        port_new = [statuses[t] for t in sorted(holdings) if t in statuses and t not in set(watch) and fresh(statuses[t])]
    # A followed person's trade in a stock you also watch is already in that stock's row.
    fol = []
    for name in sorted(set(u["insiders"])):
        for g in followed.get(name, []):
            if g["ticker"] not in set(watch) and not (g["accs"] and g["accs"] <= alerted):
                fol.append(g)

    show_market = not (pro and u.get("digest_watchlist_only")) and (u.get("digest_top_signals") is not False or not pro)
    key = (bool(u.get("digest_corporate", True)), bool(u.get("digest_congressional", True)))
    clusters = clusters_by_key.get(key, []) if show_market else []
    if pro:
        thr, minv = conv_threshold(u.get("digest_min_conviction")), float(u.get("digest_min_value") or 0)
        clusters = [c for c in clusters if c["score"] >= thr and max(b["value"] for b in c["buyers"]) >= minv]
        cap = max(1, min(int(u.get("digest_max_signals") or 6), 6 if weekly else 4))
    else:
        cap = FREE_MARKET_ITEMS
    market = [c for c in clusters if c["ticker"] not in set(watch) and not c["congress"]][:cap]
    congress_pick = None
    if show_market and key[1]:
        congress_pick = next((c for c in clusters_by_key.get((False, True), [])
                              if c["ticker"] not in {m["ticker"] for m in market} and c["ticker"] not in set(watch)), None)
    lead, others = (market[0], market[1:]) if market else (None, [])

    personal = bool(w_new or port_new or fol)
    if not weekly and not (personal or lead):
        return None
    if weekly and not (w_status or lead or pulse):
        return None

    # Subject: the most specific new thing, and the body opens with that same thing.
    w_buying = [s for s in w_new if s["recent_buys"]["n"]]
    w_selling = [s for s in w_new if s["recent_sells"]["n"]]
    if w_buying:
        rb = w_buying[0]["recent_buys"]
        subject = f"{w_buying[0]['ticker']}: {who_phrase(rb['people'], rb['insiders'])} bought {ek.money(rb['v'])} {when}"
    elif w_selling:
        rs = w_selling[0]["recent_sells"]
        subject = f"{w_selling[0]['ticker']}: {who_phrase(rs['people'], rs['insiders'])} sold {ek.money(rs['v'])} {when}"
    elif lead:
        co, top = ii.short_company(lead["company"]), lead["buyers"][0]
        if lead["n_insiders"] >= 2:
            subject = f"{lead['n_insiders']} insiders at {co} bought {ek.money(lead['total'])} {when}"
        elif top["role"] in ii.CSUITE_ROLES or top["role"] == "Chair":
            subject = f"{co}'s {top['role']} bought {ek.money(lead['total'])} of stock {when}"
        else:
            subject = f"A {co} insider bought {ek.money(lead['total'])} of stock {when}"
    else:
        subject = "Your week in insider trading" if weekly else "Your daily insider brief"

    hi = f"Hey {ek.esc(u['first_name'])}," if u.get("first_name") else "Hey,"
    intro = (f"{hi} here's your week in insider trading." if weekly
             else f"{hi} here's what insiders filed {ek.esc(when)}.")
    rows = f'<tr><td class="px" style="padding:22px 28px 0;">{ek.p(intro, 15, ek.TEXT_2, "0")}</td></tr>'

    # ── Your stocks ──
    yours = ""
    if w_status:
        body = table("".join(active_row(s, href(s["ticker"], "watchlist")) for s in w_new))
        notes = []
        if w_alerted:
            notes.append("Already sent as alerts: " + ", ".join(s["ticker"] for s in w_alerted) + ".")
        if w_quiet and not weekly:
            notes.append(f"No new filings on {', '.join(s['ticker'] for s in w_quiet)}.")
        if weekly and w_quiet:
            body += table("".join(quiet_row(s, href(s["ticker"], "watchlist")) for s in w_quiet))
        if not w_new and not notes and not weekly:
            notes.append("Nothing new on the stocks you watch.")
        body += "".join(ek.p(ek.esc(n), 13, ek.MUTED, "10px 0 0") for n in notes)
        yours += ek.section("Your watchlist", body, pad_top=22)
    if fol:
        items = ""
        for g in fol[:4]:
            verb, color = ("bought", ek.GREEN) if g["type"] == "buy" else ("sold", ek.RED)
            items += ek.p(f'{ek.a(ek.track(ek.insider_path(g["raw"]), medium, "followed", campaign), ek.esc(g["name"]), ek.TEXT)} '
                          f'<span style="color:{color};font-weight:600;">{verb} {ek.amount(g["value"], g.get("congress", False))}</span> of '
                          f'{ek.ticker_tag(g["ticker"], href(g["ticker"], "followed"))}', 14, ek.TEXT_2, "0 0 10px")
        yours += ek.section("People you follow", items, pad_top=22)
    if port_new:
        yours += ek.section("In your portfolio", table("".join(active_row(s, href(s["ticker"], "portfolio"), portfolio=True) for s in port_new)), pad_top=22)

    # ── Market ──
    market_html = ""
    if lead:
        market_html += ek.section(f"Top insider buy {when}", lead_card(lead, medium, campaign), pad_top=26)
    if others:
        market_html += ek.section(f"More insider buying {when}", table("".join(compact_row(c, medium, campaign) for c in others)), pad_top=22)
    if congress_pick:
        b = congress_pick["buyers"][0]
        market_html += ek.section("From Congress", ek.p(
            f'{ek.esc(b["name"])} disclosed a purchase of {ek.congress_range(b["value"])} of '
            f'{ek.ticker_tag(congress_pick["ticker"], href(congress_pick["ticker"], "congress"))} '
            f'({ek.esc(congress_pick["company"])}). Members of Congress report ranges, often weeks after the trade.', 14, ek.TEXT_2, "0"), pad_top=22)

    rows += (yours + market_html) if (personal or not lead) else (market_html + yours)

    pl = pulse_line(pulse, win)
    if pl:
        rows += f'<tr><td class="px" style="padding:22px 28px 0;">{ek.divider("0 0 14px")}{pl}</td></tr>'

    extra_kinds = []
    if not pro:  # never shown to Pro
        nh, kind = nudge_block(len(watch) + len(u["insiders"]), medium, campaign, pro_pitch_ok)
        rows += nh
        if kind:
            extra_kinds.append(kind)

    cta = ("Open your watchlist", "/watchlist") if personal else ("See all insider buying", "/insider-buying")
    rows += f'<tr><td class="px" style="padding:24px 28px 0;">{ek.button(cta[0], ek.track(cta[1], medium, "cta", campaign))}</td></tr>'

    bits = []
    if lead and (personal or w_buying or w_selling):
        bits.append(f"top buy: {lead['ticker']}")
    if others:
        bits.append(f"{ek.plural(len(others), 'more insider buy')}")
    if w_status and not personal:
        bits.append("where your stocks stand")
    preheader = ("Plus " + ", ".join(bits) + ".") if bits else "Insider trades from SEC filings, in plain English."

    freq = "every Sunday" if weekly else "on weekday mornings, only when there's something new"
    html_doc = ek.shell(
        title=subject, preheader=preheader,
        label=("Weekly" if weekly else "Daily") + f" · {ek.long_date(today)}",
        body_rows=rows,
        footer_html=ek.footer(reason=f"You're getting the {'weekly' if weekly else 'daily'} digest, sent {freq}.",
                              clerk_user_id=u["clerk_user_id"]))
    refs = [s["ticker"] for s in w_new]
    return {"subject": subject, "html": html_doc, "refs": refs, "extra_kinds": extra_kinds}


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
    today = date.today()

    if weekly:
        freq = ("p.weekly_digest = true"
                # brand-new signups get the welcome email first; their first digest is next week
                " AND (p.signed_up_at IS NULL OR p.signed_up_at < now() - interval '18 hours')"
                + ("" if FORCE else " AND (p.last_weekly_digest_at IS NULL OR p.last_weekly_digest_at < now() - interval '5 days')"))
    else:
        freq = ("p.daily_digest = true AND s.plan = 'pro'"
                + ("" if FORCE else " AND (p.last_daily_digest_at IS NULL OR p.last_daily_digest_at < now() - interval '18 hours')"
                   # one scheduled email a day: Monday's catch-up weekly replaces the daily
                   " AND (p.last_weekly_digest_at IS NULL OR p.last_weekly_digest_at < now() - interval '18 hours')"))

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

    win = ii.digest_window(conn, weekly, today)
    all_tickers = {t for u in users for t in u["tickers"]} | {t for uid, ts in holdings.items() if uid in by_id and by_id[uid]["pro"] for t in ts}
    statuses = ii.ticker_status(conn, sorted(all_tickers), win["start"], win["end"], today=today)
    buys = ii.week_buys(conn, win["start"], win["end"])
    clusters_by_key = {k: ii.build_clusters(buys, include_corporate=k[0], include_congress=k[1])
                       for k in [(True, True), (True, False), (False, True)]}
    pulse = ii.market_pulse(conn, win["start"], win["end"], weekly)
    followed = ii.followed_activity(conn, [n for u in users for n in u["insiders"]], win["start"], win["end"])
    alerted = ek.alerted_refs(conn, [u["clerk_user_id"] for u in users if u["pro"]])
    log.info(f"  window {win['start']}..{win['end']}: {len(buys)} buys filed, "
             f"{len(clusters_by_key[(True, True)])} tickers with buying, {len(statuses)} watched/held tickers")

    stamp_col = "last_weekly_digest_at" if weekly else "last_daily_digest_at"
    sent = skipped = failed = 0
    for u in users:
        try:
            out = compose(u, weekly=weekly, win=win, statuses=statuses, clusters_by_key=clusters_by_key, pulse=pulse,
                          followed=followed, holdings=holdings.get(u["clerk_user_id"], set()), today=today,
                          alerted=alerted.get(u["clerk_user_id"], set()),
                          pro_pitch_ok=not u["pro"] and not ek.cooldown(conn, u["clerk_user_id"], "nudge_pro", 28))
        except Exception:
            log.exception(f"  compose failed for {u['email']}"); failed += 1; continue
        if not out:
            skipped += 1; continue
        ok = ek.send(to_email=u["email"], subject=out["subject"], html_doc=out["html"], clerk_user_id=u["clerk_user_id"],
                     from_name="Seli", kind=f"{DIGEST_TYPE}_digest")
        if ok:
            sent += 1
            ek.log_sent(conn, u["clerk_user_id"], f"{DIGEST_TYPE}_digest")
            for k in out["extra_kinds"]:
                ek.log_sent(conn, u["clerk_user_id"], k)
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
