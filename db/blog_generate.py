#!/usr/bin/env python3
"""
db/blog_generate.py
Writes seli.app/blog posts from the filings themselves. No AI writing: every
sentence is a template filled with numbers from the database, so a post is
never wrong about a figure and every post reads the same way.

A post only goes up when a trade clears the quality bar (RULES below):

  Every post   open-market only (code P or S), not bought in an offering,
               not a planned 10b5-1 trade, not a suspect amount or a
               duplicate, not a fund, price $1+, filed within 5 days of the
               trade, company insiders only (no Congress).
  Buys         at least one of: CEO, CFO, President or Chair buying $250K+;
               3+ insiders buying within 2 weeks; a first buy in 2+ years or
               a reversal, $100K+; one person buying $1M+.
  Sells        a higher bar: 3+ executives or directors selling $10M+ within
               2 weeks with the stock in the top 20% of its 52-week range; or
               a CEO or CFO selling $2M+ after a run of buying (reversal).
               Funds and big holders never count.
  Repeats      one post per stock and direction per 30 days. Later trades
               update that post instead of making a new one.

Review mode (default): new posts are saved as drafts and emailed to OPS_EMAIL
with a link to publish them. BLOG_AUTO_PUBLISH=true publishes straight away.

    python blog_generate.py                  after each ingest: last 4 days of filings
    python blog_generate.py --backtest 90    what WOULD have been posted over the last
                                             90 days (writes blog_backtest.md, changes nothing)
    python blog_generate.py --roundup        the weekly "Insider Buying This Week" post
                                             (Fridays), plus the same tables as Reddit markdown

Needs DATABASE_URL, and db/migrations/2026-10-28_blog.sql run for anything but --backtest.
Env: OPS_EMAIL (review emails), BLOG_AUTO_PUBLISH, DRY_RUN, plus email_kit's.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import secrets
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import email_kit as ek
import insider_intel as ii

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("seli.blog")

OPS_EMAIL = (os.environ.get("OPS_EMAIL") or os.environ.get("NOTIFY_EMAIL") or os.environ.get("WELCOME_REPLY_TO") or "").strip()
AUTO_PUBLISH = os.environ.get("BLOG_AUTO_PUBLISH", "false").lower() == "true"
AUTHOR = "Kevin Maresca"

# ── The quality bar ──────────────────────────────────────────────────────────
WINDOW_DAYS = 4            # each run looks at filings from the last 4 days
ROUNDUP_MIN = 100_000     # a roundup table row needs at least this much
FRESH_DAYS = 5             # filed within 5 calendar days (about 3 business days) of the trade
CLUSTER_DAYS = 14          # "together" means within 2 weeks
TOP_ROLES = {"CEO", "CFO", "President", "Chair"}
BUY_TOP_MIN = 250_000
BUY_CLUSTER_N = 3
BUY_CLUSTER_EACH = 25_000  # each of those 3 put in at least this much
BUY_CLUSTER_MIN = 250_000  # and together at least this much
BUY_SIGNAL_MIN = 100_000   # first buy in years / reversal
BUY_BIG_MIN = 1_000_000    # size alone: executives and directors only, not repeat buyers
BIG_REPEAT_DAYS = 180      # "repeat buyer": bought this stock in the 6 months before
LISTED_DAYS = 30           # a stock needs this much price history before the buy (no IPO-price buys)
PRICE_STALE_DAYS = 10      # latest close older than this: price data is off, skip
SELL_CLUSTER_N = 3
SELL_CLUSTER_MIN = 10_000_000
SELL_RANGE_MIN = 0.80      # top 20% of the 52-week range
SELL_REV_MIN = 2_000_000
REPEAT_DAYS = 30


# ── Small helpers ────────────────────────────────────────────────────────────
_SUFFIX = re.compile(r"[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group|incorporated|n\.?v\.?|s\.?a\.?)\.?$", re.I)


def short_company(name: str) -> str:
    s = name or ""
    for _ in range(2):
        s = _SUFFIX.sub("", s).strip()
    return s or name


def role_word(role: str) -> str:
    return ii.ek_role_word(role)


def role_title(role: str) -> str:
    """Role for a headline: CEO stays CEO, 'Board member' -> 'Director' reads better in a title."""
    return {"Director": "Director", "10% owner": "10% Owner", "VP": "VP", "C-suite exec": "Executive"}.get(role, role_word(role).title() if role not in ("CEO", "CFO", "COO", "CTO") else role)


def money_title(v: float) -> str:
    return ek.money(v)


def slugify(*parts) -> str:
    s = "-".join(str(p) for p in parts if p)
    s = s.lower().replace("$", "").replace("&", "and")
    s = re.sub(r"(\d)\.(\d)", r"\1-\2", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return re.sub(r"-{2,}", "-", s)[:110].strip("-")


def sec_url(acc: str, cik) -> str | None:
    if not acc or not cik:
        return None
    try:
        c = int(str(cik))
    except ValueError:
        return None
    return f"https://www.sec.gov/Archives/edgar/data/{c}/{acc.replace('-', '')}/{acc}-index.htm"


def num_word(n: int) -> str:
    words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
    return words[n] if 0 <= n < len(words) else str(n)


def date_span(d1: date, d2: date) -> str:
    if d1 == d2:
        return f"on {ek.short_date(d1)}"
    return f"between {ek.short_date(d1)} and {ek.short_date(d2)}"


def pct_txt(x: float, digits: int = 0) -> str:
    if round(x, digits) == 0:
        return "flat"
    return f"{'+' if x >= 0 else ''}{x:.{digits}f}%"


def surname(name: str) -> str:
    """'Julie Sweet' -> 'Sweet', 'Orrin H Ingram II' -> 'Ingram'. Used instead of a pronoun."""
    parts = [w for w in str(name or "").replace(",", " ").split() if w.rstrip(".").lower() not in ("jr", "sr", "ii", "iii", "iv", "md", "phd")]
    return parts[-1] if parts else str(name or "")


def range_word(pos: float) -> str:
    return "near the low" if pos < 0.25 else "near the high" if pos >= 0.75 else "mid-range"


def price_txt(v) -> str:
    return f"${v:,.2f}" if v is not None and v < 1000 else (f"${v:,.0f}" if v is not None else "n/a")


def shares_txt(n) -> str:
    return f"{n:,.0f}" if n is not None else "n/a"


# ── Database ─────────────────────────────────────────────────────────────────
def columns(cur) -> set[str]:
    cur.execute("""SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'filings'""")
    return {r[0] for r in cur.fetchall()}


def rows_sql(cols: set[str]) -> str:
    planned = "f.planned IS NOT TRUE" if "planned" in cols else "TRUE"
    dup = "f.duplicate_of IS NULL" if "duplicate_of" in cols else "TRUE"
    rev = "f.reversal" if "reversal" in cols else "NULL::text"
    base = f"""f.is_open_market AND f.transaction_code IN ('P', 'S') AND f.transaction_type IN ('buy', 'sell')
       AND f.ticker IS NOT NULL AND f.ticker <> '' AND {dup} AND {planned}
       AND COALESCE(f.price_per_share, 0) >= 1 AND COALESCE(f.value, 0) > 0
       AND COALESCE(f.relationship, '') <> 'congress' AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%%'
       AND COALESCE(f.transaction_date, f.filing_date) <= f.filing_date
       AND f.filing_date - COALESCE(f.transaction_date, f.filing_date) <= {FRESH_DAYS}"""
    return f"""
WITH fresh AS (
  SELECT DISTINCT f.ticker, f.transaction_type FROM public.filings f
   WHERE {base} AND f.filing_date > %(as_of)s::date - %(window)s AND f.filing_date <= %(as_of)s::date
)
SELECT f.accession_number, f.cik_issuer, f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
       f.transaction_type, f.shares::float AS shares, f.price_per_share::float AS price, f.value::float AS value,
       f.shares_owned_after::float AS owned_after, f.shares_owned_before::float AS owned_before,
       f.pct_owned_change::float AS pct, f.filing_date, COALESCE(f.transaction_date, f.filing_date) AS trade_date,
       {rev} AS reversal,
       -- "First buy in N years" only applies to buys; skipping the lookup for
       -- sales (most rows) keeps this quick.
       CASE WHEN f.transaction_type = 'buy' THEN
       (SELECT MAX(COALESCE(p.transaction_date, p.filing_date)) FROM public.filings p
         WHERE p.insider_name = f.insider_name AND p.ticker = f.ticker AND p.is_open_market AND p.transaction_type = 'buy'
           AND COALESCE(p.transaction_date, p.filing_date) < COALESCE(f.transaction_date, f.filing_date) - 30) END AS prior_buy_date,
       CASE WHEN f.transaction_type = 'buy' THEN
       (SELECT MIN(COALESCE(p.transaction_date, p.filing_date)) FROM public.filings p
         WHERE p.insider_name = f.insider_name AND p.ticker = f.ticker) END AS first_seen
  FROM public.filings f JOIN fresh ON fresh.ticker = f.ticker AND fresh.transaction_type = f.transaction_type
 WHERE {base}
   AND f.filing_date <= %(as_of)s::date
   AND COALESCE(f.transaction_date, f.filing_date) > %(as_of)s::date - {CLUSTER_DAYS + WINDOW_DAYS + FRESH_DAYS}
"""


def fetch(cur, sql, params=None) -> list[dict]:
    cur.execute(sql, params or {})
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def price_context(cur, ticker: str, as_of: date) -> dict | None:
    rows = fetch(cur, """
        SELECT date, close::float AS close FROM public.prices_history
         WHERE ticker = %(t)s AND date <= %(d)s AND date > %(d)s::date - 365 ORDER BY date""",
                 {"t": ticker, "d": as_of})
    if len(rows) < 20:
        return None
    closes = [r["close"] for r in rows if r["close"]]
    lo, hi, now = min(closes), max(closes), closes[-1]
    pos = (now - lo) / (hi - lo) if hi > lo else 0.5
    return {"now": now, "now_date": ek.as_date(rows[-1]["date"]), "first_date": ek.as_date(rows[0]["date"]),
            "low": lo, "high": hi, "pos": pos}


def range_pos(ctx: dict | None, price: float) -> float | None:
    if not ctx or ctx["high"] <= ctx["low"]:
        return None
    return max(0.0, min(1.0, (price - ctx["low"]) / (ctx["high"] - ctx["low"])))


def company_activity(cur, ticker: str, as_of: date, exclude: list[str]) -> dict:
    r = fetch(cur, """
        SELECT COUNT(*) FILTER (WHERE transaction_type = 'buy')::int AS buys,
               COALESCE(SUM(value) FILTER (WHERE transaction_type = 'buy'), 0)::float AS buy_v,
               COUNT(*) FILTER (WHERE transaction_type = 'sell')::int AS sells,
               COALESCE(SUM(value) FILTER (WHERE transaction_type = 'sell'), 0)::float AS sell_v
          FROM public.filings
         WHERE ticker = %(t)s AND is_open_market AND transaction_type IN ('buy', 'sell')
           AND COALESCE(relationship, '') <> 'congress' AND COALESCE(transaction_code, '') NOT LIKE 'CONGRESS%%'
           AND COALESCE(transaction_date, filing_date) > %(d)s::date - 365 AND filing_date <= %(d)s
           AND NOT (accession_number = ANY(%(x)s))""", {"t": ticker, "d": as_of, "x": exclude})[0]
    c = fetch(cur, """
        SELECT COUNT(*)::int AS n, COUNT(DISTINCT insider_name)::int AS members
          FROM public.filings
         WHERE ticker = %(t)s AND (relationship = 'congress' OR transaction_code LIKE 'CONGRESS%%')
           AND COALESCE(transaction_date, filing_date) > %(d)s::date - 365 AND filing_date <= %(d)s""",
              {"t": ticker, "d": as_of})[0]
    return {**r, "congress_n": c["n"], "congress_members": c["members"]}


def track_record(cur, name: str, as_of: date) -> dict | None:
    """This person's earlier open-market buys (any stock, 5 years, at least a
    month old): average return to the latest close and vs the S&P 500 over the
    same holding periods. Same idea as the leaderboard."""
    r = fetch(cur, """
        WITH b AS (
          SELECT f.ticker, f.price_per_share::float AS px, COALESCE(f.transaction_date, f.filing_date) AS d
            FROM public.filings f
           WHERE f.insider_name = %(n)s AND f.is_open_market AND f.transaction_type = 'buy'
             AND COALESCE(f.price_per_share, 0) > 0
             AND COALESCE(f.transaction_date, f.filing_date) BETWEEN %(d)s::date - 1825 AND %(d)s::date - 30
        ), j AS (
          SELECT b.px,
                 (SELECT close::float FROM public.prices_history p WHERE p.ticker = b.ticker AND p.date <= %(d)s ORDER BY date DESC LIMIT 1) AS now,
                 (SELECT close::float FROM public.benchmark_prices s WHERE s.symbol = 'SPY' AND s.date <= b.d ORDER BY date DESC LIMIT 1) AS spy0,
                 (SELECT close::float FROM public.benchmark_prices s WHERE s.symbol = 'SPY' AND s.date <= %(d)s ORDER BY date DESC LIMIT 1) AS spy1
            FROM b
        )
        SELECT COUNT(*)::int AS n,
               AVG((now - px) / px * 100) AS avg_ret,
               AVG((now - px) / px * 100 - (spy1 - spy0) / spy0 * 100) AS excess,
               COUNT(*) FILTER (WHERE now >= px * 1.05)::int AS wins,
               COUNT(*) FILTER (WHERE ABS(now - px) / px >= 0.05)::int AS moved
          FROM j WHERE now IS NOT NULL AND ABS((now - px) / px) < 3 AND spy0 IS NOT NULL AND spy1 IS NOT NULL""",
              {"n": name, "d": as_of})
    if not r or not r[0]["n"] or r[0]["n"] < 3:
        return None
    x = r[0]
    return {"n": x["n"], "avg": float(x["avg_ret"]), "excess": float(x["excess"]),
            "hit": round(x["wins"] / x["moved"] * 100) if x["moved"] else None}


# ── Grouping a stock's trades ────────────────────────────────────────────────
def people_of(rows: list[dict]) -> list[dict]:
    per: dict[str, dict] = {}
    for r in rows:
        name = r["insider_name"]
        p = per.setdefault(name, {
            "raw": name, "name": ek.pretty_person(name), "title": r.get("insider_title") or "",
            "role": ek.short_role(r.get("insider_title"), r.get("relationship")),
            "entity": ek.is_entity_name(name),
            "value": 0.0, "shares": 0.0, "first": None, "last": None, "filed": None,
            "pct": None, "owned_after": None, "owned_before": None, "reversal": None,
            "prior_buy_date": None, "first_seen": None, "accessions": [], "cik": r.get("cik_issuer"),
        })
        p["value"] += r["value"] or 0
        p["shares"] += r["shares"] or 0
        td, fd = ek.as_date(r["trade_date"]), ek.as_date(r["filing_date"])
        p["first"] = min(filter(None, [p["first"], td]), default=None)
        if td and (not p["last"] or td >= p["last"]):
            p["last"] = td
            if r.get("owned_after") is not None:
                p["owned_after"] = r["owned_after"]
        p["filed"] = max(filter(None, [p["filed"], fd]), default=None)
        if r.get("pct") is not None:
            p["pct"] = max(p["pct"] or 0, r["pct"])
        if p["owned_before"] is None and r.get("owned_before") is not None:
            p["owned_before"] = r["owned_before"]
        if r.get("reversal") in ("buy", "sell"):
            p["reversal"] = r["reversal"]
        pb = ek.as_date(r.get("prior_buy_date"))
        if pb and (not p["prior_buy_date"] or pb > p["prior_buy_date"]):
            p["prior_buy_date"] = pb
        fs = ek.as_date(r.get("first_seen"))
        if fs and (not p["first_seen"] or fs < p["first_seen"]):
            p["first_seen"] = fs
        if r["accession_number"] not in p["accessions"]:
            p["accessions"].append(r["accession_number"])
    out = sorted(per.values(), key=lambda p: -p["value"])
    for p in out:
        p["avg_price"] = p["value"] / p["shares"] if p["shares"] else None
        p["break"] = ii.buy_break(p["prior_buy_date"], p["first_seen"], p["last"])
        p["stake"] = ii._stake_label(p["pct"], p["owned_before"])
    return out


def qualify(direction: str, people: list[dict], get_pctx) -> tuple[list[str], list[str]]:
    """(tags, reasons) when this group clears the bar, else ([], []).
    get_pctx() fetches the price range; it's only called when the answer
    depends on it (a big sell cluster), so most stocks never need it."""
    persons = [p for p in people if not p["entity"]]
    tags, reasons = [], []
    if direction == "buy":
        top = [p for p in persons if p["role"] in TOP_ROLES and p["value"] >= BUY_TOP_MIN]
        real = [p for p in persons if p["value"] >= BUY_CLUSTER_EACH]
        if len(real) >= BUY_CLUSTER_N and sum(p["value"] for p in persons) >= BUY_CLUSTER_MIN:
            tags.append("Cluster buy"); reasons.append("cluster")
        if top:
            tags.append(f"{top[0]['role']} buy"); reasons.append("top")
        brk = [p for p in persons if p["break"] and p["value"] >= BUY_SIGNAL_MIN and p["role"] != "10% owner"]
        if brk:
            tags.append(brk[0]["break"][0]); reasons.append("break")
        rev = [p for p in persons if p["reversal"] == "buy" and p["value"] >= BUY_SIGNAL_MIN]
        if rev:
            tags.append("Reversal"); reasons.append("reversal")
        def repeat_buyer(p):
            return bool(p["prior_buy_date"] and p["last"] and (p["last"] - p["prior_buy_date"]).days <= BIG_REPEAT_DAYS)
        if any(p["value"] >= BUY_BIG_MIN and p["role"] != "10% owner" and not repeat_buyer(p) for p in persons) and not reasons:
            tags.append("$1M+ buy"); reasons.append("big")
    else:
        execs = [p for p in persons if p["role"] != "10% owner"]
        total = sum(p["value"] for p in execs)
        if len(execs) >= SELL_CLUSTER_N and total >= SELL_CLUSTER_MIN and (pctx := get_pctx()) and pctx["pos"] >= SELL_RANGE_MIN:
            tags.append("Big sell"); reasons.append("cluster")
        rev = [p for p in execs if p["reversal"] == "sell" and p["role"] in ("CEO", "CFO") and p["value"] >= SELL_REV_MIN]
        if rev:
            tags.append("Reversal"); reasons.append("reversal")
    return tags, reasons


def score(direction: str, people: list[dict], reasons: list[str]) -> float:
    persons = [p for p in people if not p["entity"]]
    s = len(reasons) * 10 + min(len(persons), 6) * 4
    s += sum(15 for p in persons if p["role"] in TOP_ROLES)
    total = sum(p["value"] for p in persons)
    s += min(20, max(0, (len(str(int(total))) - 5) * 4))  # bigger dollars, a little more
    return s if direction == "buy" else s - 10


# ── Writing the post ─────────────────────────────────────────────────────────
def build_post(cur, ticker: str, company_raw: str, direction: str, people: list[dict], tags: list[str],
               reasons: list[str], pctx: dict | None, as_of: date) -> dict:
    company = ek.pretty_company(company_raw) or ticker
    co = short_company(company)
    persons = [p for p in people if not p["entity"]] or people
    lead_p = persons[0]
    total = sum(p["value"] for p in people)
    shares = sum(p["shares"] for p in people)
    avg_px = total / shares if shares else None
    first = min(p["first"] for p in people if p["first"])
    last = max(p["last"] for p in people if p["last"])
    filed = max(p["filed"] for p in people if p["filed"])
    n = len(persons)
    buy = direction == "buy"
    verb, verb_s, past = ("buy", "buys", "bought") if buy else ("sell", "sells", "sold")
    accessions = sorted({a for p in people for a in p["accessions"]})
    activity = company_activity(cur, ticker, as_of, accessions)
    record = track_record(cur, lead_p["raw"], as_of) if buy else None
    pos_avg = range_pos(pctx, avg_px) if avg_px else None
    top = next((p for p in persons if p["role"] in TOP_ROLES), None)
    rev_p = next((p for p in persons if p["reversal"] == direction), None)
    brk_p = next((p for p in persons if p["break"] and buy), None)
    amt = money_title(total)
    cluster = "cluster" in reasons
    if cluster:
        subject = None
    elif "reversal" in reasons and rev_p and not (buy and top and rev_p is not top):
        subject = rev_p
    else:
        subject = top or lead_p

    # Title: company, ticker, who, amount, in that order (what people search).
    if "cluster" in reasons and buy:
        title = (f"{co} ({ticker}) {top['role']} and {n - 1} Other Insiders Buy {amt} of Stock" if top and n > 1
                 else f"{num_word(n).title()} {co} ({ticker}) Insiders Buy {amt} of Stock")
    elif not buy and "cluster" in reasons:
        tail = "Near 52-Week High" if pctx and pctx["pos"] >= 0.9 else "in Unplanned Sales"
        title = f"{num_word(n).title()} {co} ({ticker}) Insiders Sell {amt} {tail}"
    elif subject is rev_p and rev_p:
        title = f"{co} ({ticker}) {role_title(rev_p['role'])} {rev_p['name']} {verb_s.title()} {money_title(rev_p['value'])} After {'Selling' if buy else 'Buying'}"
    else:
        who = subject
        title = f"{co} ({ticker}) {role_title(who['role'])} {who['name']} Buys {money_title(who['value'])} of Stock"
        if who.get("break") and len(title) < 62:
            title += f", First Buy in {who['break'][1].replace('in ', '').replace(' of filings', '').title()}"

    # One-line summary (also the page's meta description).
    def role_lc(p):
        return p["role"] if p["role"] in ("CEO", "CFO", "COO", "CTO") else role_word(p["role"]).lower()
    if subject:
        others = [p for p in persons if p is not subject]
        summary = f"{company} ({ticker}) {role_lc(subject)} {subject['name']} {past} {ek.money(subject['value'])} of stock on the open market {date_span(subject['first'], subject['last'])}"
        if others:
            summary += f", with {plural0(len(others), 'other insider')} {'joining' if buy else 'also selling'}"
    else:
        summary = f"{num_word(n).capitalize()} insiders {past} {amt} of {company} ({ticker}) stock on the open market {date_span(first, last)}"
    summary += ", none of it planned in advance." if not buy else "."
    if buy and pos_avg is not None and pos_avg < 0.25:
        summary += " The buys came near the stock's 52-week low."
    elif not buy and pctx and pctx["pos"] >= 0.9:
        summary += " The stock sits near its 52-week high."


    # Lead paragraph.
    if subject:
        sp = subject
        lead = (f"{company} ({ticker}) {role_lc(sp)} {sp['name']} {past} {ek.money(sp['value'])} of company stock on the open market "
                f"{date_span(sp['first'], sp['last'])}, according to a Form 4 filed {ek.short_date(sp['filed'])}. ")
        if sp["avg_price"]:
            lead += f"{surname(sp['name'])} {'paid' if buy else 'sold at'} about {price_txt(sp['avg_price'])} a share"
        else:
            lead = lead.rstrip(". ") + ""
        lead_p = sp
    elif n > 1:
        lead = (f"{num_word(n).capitalize()} insiders at {company} ({ticker}) {past} {amt} of company stock on the open market "
                f"{date_span(first, last)}, according to Form 4 filings with the SEC. ")
        lead += f"The biggest {'buy' if buy else 'sale'} came from {role_word(lead_p['role']).lower() if lead_p['role'] not in ('CEO', 'CFO', 'COO', 'CTO') else lead_p['role']} {lead_p['name']} at {ek.money(lead_p['value'])}"
    else:
        lead = (f"{company} ({ticker}) {role_lc(lead_p)} {lead_p['name']} {past} {ek.money(lead_p['value'])} of company stock on the open market "
                f"{date_span(lead_p['first'], lead_p['last'])}, according to a Form 4 filed {ek.short_date(lead_p['filed'])}. ")
        if lead_p["avg_price"]:
            lead += f"{surname(lead_p['name'])} {'paid' if buy else 'sold at'} about {price_txt(lead_p['avg_price'])} a share"
    if buy and lead_p["pct"] and lead_p["pct"] >= 5:
        lead += (f", growing the direct stake {lead_p['pct']:.0f}%" if lead_p["pct"] < 100 else ", more than doubling the direct stake")
        if lead_p["owned_after"]:
            lead += f" to {shares_txt(lead_p['owned_after'])} shares"
    lead += "."
    if subject:
        also = [p for p in persons if p is not subject]
        if also:
            lead += (" " + ("Also buying: " if buy else "Also selling: ")
                     + ", ".join(f"{role_lc(p)} {p['name']} ({ek.money(p['value'])})" for p in also[:4])
                     + (f" and {plural0(len(also) - 4, 'other')}" if len(also) > 4 else "") + ".")

    facts = [["Total " + ("bought" if buy else "sold"), ek.money(total)],
             ["Insiders", str(n)],
             ["Trade dates", ek.short_date(first) if first == last else f"{ek.short_date(first)} to {ek.short_date(last)}"],
             ["Last filed", ek.short_date(filed)]]
    if avg_px:
        facts.append(["Avg price", price_txt(avg_px)])
    if pctx:
        chg = (pctx["now"] - avg_px) / avg_px * 100 if avg_px else None
        facts.append(["Price now", price_txt(pctx["now"]) + (f" ({pct_txt(chg, 1)} vs avg)" if chg is not None else "")])
        facts.append(["52-week range", f"{price_txt(pctx['low'])} to {price_txt(pctx['high'])}"])

    why = []
    if buy:
        if n >= BUY_CLUSTER_N:
            why.append(f"{n} insiders bought within 2 weeks. Several insiders buying together shows up far less often than one buying alone.")
        if top:
            why.append(f"The {role_word(top['role']) if top['role'] in ('CEO', 'CFO') else role_word(top['role']).lower()} is {'one of the buyers' if n > 1 else 'the buyer'}.")
        if brk_p:
            why.append(f"{brk_p['name']}'s first open-market buy of {ticker} {brk_p['break'][1]}.")
        if rev_p:
            why.append(f"Reversal: {rev_p['name']} had sold {ticker} at least twice in the previous 2 years without buying.")
        why.append("Bought with their own money on the open market: none of these were planned 10b5-1 trades or offering purchases.")
    else:
        if n >= SELL_CLUSTER_N:
            why.append(f"{n} executives and directors sold within 2 weeks, {amt} in all.")
        if pctx:
            why.append(f"The stock was at {pctx['pos'] * 100:.0f}% of its 52-week range, {range_word(pctx['pos'])}.")
        if rev_p:
            why.append(f"Reversal: {rev_p['name']} had bought {ticker} at least twice in the previous 2 years without selling.")
        why.append("None of these sales were set up in advance under a 10b5-1 plan.")

    context = []
    if pctx and avg_px:
        chg = (pctx["now"] - avg_px) / avg_px * 100
        vs = (f"about the same as the insiders' average {'buy' if buy else 'sale'} price" if abs(chg) < 0.5
              else f"{abs(chg):.1f}% {'above' if chg >= 0 else 'below'} the insiders' average {'buy' if buy else 'sale'} price")
        context.append(f"{ticker} closed at {price_txt(pctx['now'])} on {ek.short_date(pctx['now_date'])}, {vs}.")
    if pctx and pos_avg is not None:
        context.append(f"52-week range: {price_txt(pctx['low'])} to {price_txt(pctx['high'])}. "
                       f"The {'buys' if buy else 'sales'} came {range_word(pos_avg)} ({pos_avg * 100:.0f}% of the range).")
    other_b, other_s = activity["buys"], activity["sells"]
    buy_v = f" ({ek.money(activity['buy_v'])})" if other_b else ""
    sell_v = f" ({ek.money(activity['sell_v'])})" if other_s else ""
    if other_b or other_s:
        context.append(f"Apart from these, {ticker} insiders made {plural0(other_b, 'open-market buy')}{buy_v}"
                       f" and {plural0(other_s, 'open-market sale')}{sell_v} over the past 12 months.")
    else:
        context.append(f"Apart from these, {ticker} insiders made no open-market trades over the past 12 months.")
    if record:
        context.append(f"{lead_p['name']}'s earlier open-market buys ({record['n']}) are {pct_txt(record['avg'])} on average, "
                       f"{abs(record['excess']):.0f} points {'better' if record['excess'] >= 0 else 'worse'} than the S&P 500 over the same periods.")
    if activity["congress_n"]:
        context.append(f"Members of Congress disclosed {plural0(activity['congress_n'], 'trade')} in {ticker} over the past 12 months.")

    people_out = [{
        "raw": p["raw"], "name": p["name"], "role": p["role"], "title": p["title"], "entity": p["entity"],
        "value": round(p["value"]), "shares": round(p["shares"]), "price": round(p["avg_price"], 2) if p["avg_price"] else None,
        "stake": p["stake"], "owned_after": p["owned_after"], "first": str(p["first"]), "last": str(p["last"]),
        "filed": str(p["filed"]), "sec_url": sec_url(p["accessions"][0], p["cik"]),
        "flags": [f for f in [p["break"][0] if p["break"] and buy else None, "Reversal" if p["reversal"] == direction else None] if f],
    } for p in people]

    if subject:
        slug = slugify(ticker, subject["name"], role_word(subject["role"]), verb_s, ek.money(subject["value"]), "stock", str(as_of))
    else:
        slug = slugify(ticker, f"{n}-insiders", verb, amt, "stock", str(as_of))
    insiders = [{"raw": p["raw"], "name": p["name"], "role": p["role"]} for p in people]
    return {
        "slug": slug, "kind": direction, "ticker": ticker, "company": company, "insiders": insiders, "tags": tags,
        "title": title, "summary": summary, "amount": round(total), "accessions": accessions,
        "event_key": f"{ticker}|{direction}",
        "search": " ".join([ticker, company, title] + [p["name"] for p in people] + [p["raw"] for p in people]).lower(),
        "body": {
            "v": 1, "kind": direction, "author": AUTHOR, "as_of": str(as_of),
            "lead": lead, "facts": facts, "people": people_out, "why": why, "context": context,
            "signal": {"direction": direction, "insiders": n, "value": round(total), "tags": tags},
            "range": ({"low": pctx["low"], "high": pctx["high"], "now": pctx["now"], "avg": avg_px,
                       "pos": pctx["pos"], "avg_pos": pos_avg} if pctx else None),
            "first": str(first), "last": str(last), "filed": str(filed),
        },
    }


def plural0(n: int, one: str) -> str:
    return f"{'no' if n == 0 else n} {one}{'' if n == 1 else 's'}"


# ── Finding posts for one day ────────────────────────────────────────────────
def candidates(cur, cols: set[str], as_of: date) -> list[dict]:
    rows = fetch(cur, rows_sql(cols), {"as_of": as_of, "window": WINDOW_DAYS})
    groups: dict[tuple, list] = defaultdict(list)
    for r in rows:
        if ii.is_fund_name(r.get("company_name")):
            continue
        groups[(r["ticker"], r["transaction_type"])].append(r)
    posts = []
    for (ticker, direction), rs in groups.items():
        latest = max(ek.as_date(r["trade_date"]) for r in rs)
        rs = [r for r in rs if ek.as_date(r["trade_date"]) > latest - timedelta(days=CLUSTER_DAYS)]
        people = people_of(rs)
        got = {}
        def get_pctx(t=ticker):
            if "v" not in got:
                got["v"] = price_context(cur, t, as_of)
            return got["v"]
        tags, reasons = qualify(direction, people, get_pctx)
        if not reasons:
            continue
        pctx = get_pctx()
        if direction == "buy":
            # No price history from before the buy: a new listing, where insiders
            # usually buy at the IPO price. Old prices: something's off with the data.
            first_trade = min(p["first"] for p in people if p["first"])
            if (not pctx or pctx["first_date"] > first_trade - timedelta(days=LISTED_DAYS)
                    or (as_of - pctx["now_date"]).days > PRICE_STALE_DAYS):
                continue
        company = max(rs, key=lambda r: ek.as_date(r["filing_date"]))["company_name"]
        post = build_post(cur, ticker, company, direction, people, tags, reasons, pctx, as_of)
        post["score"] = score(direction, people, reasons)
        posts.append(post)
    return sorted(posts, key=lambda p: -p["score"])


# ── Saving ───────────────────────────────────────────────────────────────────
def existing(cur, event_key: str, as_of: date) -> dict | None:
    r = fetch(cur, """SELECT id, slug, status, accessions, published_at FROM public.blog_posts
                       WHERE event_key = %(k)s AND created_at > %(d)s::date - %(n)s
                       ORDER BY created_at DESC LIMIT 1""", {"k": event_key, "d": as_of, "n": REPEAT_DAYS})
    return r[0] if r else None


def save(conn, post: dict) -> tuple[str, dict | None]:
    """'new', 'updated' or 'skipped', plus the row."""
    cur = conn.cursor()
    old = existing(cur, post["event_key"], date.fromisoformat(post["body"]["as_of"]))
    if old:
        if old["status"] == "rejected" or set(post["accessions"]) <= set(old["accessions"] or []):
            return "skipped", old
        # Later trades in the same stock: refresh the same post (same address).
        cur.execute("""UPDATE public.blog_posts SET title = %s, summary = %s, body = %s, tags = %s, insiders = %s,
                              amount = %s, accessions = %s, search = %s, updated_at = now() WHERE id = %s""",
                    (post["title"], post["summary"], json.dumps(post["body"]), post["tags"], json.dumps(post["insiders"]),
                     post["amount"], sorted(set(old["accessions"] or []) | set(post["accessions"])), post["search"], old["id"]))
        conn.commit()
        return "updated", old
    slug, i = post["slug"], 2
    while fetch(cur, "SELECT 1 AS x FROM public.blog_posts WHERE slug = %(s)s", {"s": slug}):
        slug, i = f"{post['slug']}-{i}", i + 1
    token = secrets.token_urlsafe(24)
    status = "published" if AUTO_PUBLISH else "draft"
    cur.execute("""INSERT INTO public.blog_posts (slug, kind, status, ticker, company, insiders, tags, title, summary, body,
                                                 amount, event_key, accessions, search, review_token, published_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END)
                   RETURNING id""",
                (slug, post["kind"], status, post.get("ticker"), post.get("company"), json.dumps(post.get("insiders", [])),
                 post["tags"], post["title"], post["summary"], json.dumps(post["body"]), post.get("amount"),
                 post.get("event_key"), post.get("accessions", []), post["search"], token, status == "published"))
    pid = cur.fetchone()[0]
    conn.commit()
    return "new", {"id": pid, "slug": slug, "status": status, "review_token": token}


# ── Review email ─────────────────────────────────────────────────────────────
def review_email(post: dict, row: dict) -> None:
    if not OPS_EMAIL:
        log.warning("  No OPS_EMAIL set; draft saved without an email.")
        return
    b = post["body"]
    review = f"{ek.WORKER_URL}/blog/review?id={row['id']}&t={row['review_token']}"
    live = row.get("status") == "published"
    facts = "".join(f'<tr><td style="padding:4px 12px 4px 0;font-family:{ek.FONT};font-size:13px;color:{ek.MUTED};">{ek.esc(k)}</td>'
                    f'<td style="padding:4px 0;font-family:{ek.FONT};font-size:13px;color:{ek.TEXT};font-weight:600;">{ek.esc(v)}</td></tr>'
                    for k, v in b.get("facts", []))
    bullets = lambda items: "".join(ek.p("&bull; " + ek.esc(x), 14, ek.TEXT_2, "0 0 6px") for x in items)
    inner = (ek.p(" &nbsp;".join(ek.chip(t, "accent") for t in post["tags"]), 12, ek.MUTED, "0 0 10px")
             + ek.p(f"<b>{ek.esc(post['title'])}</b>", 18, ek.TEXT, "0 0 8px")
             + ek.p(ek.esc(post["summary"]), 14, ek.MUTED)
             + ek.p(ek.esc(b.get("lead", "")))
             + (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">{facts}</table>' if facts else "")
             + (ek.p("<b>Why it stands out</b>", 14, ek.TEXT, "8px 0 6px") + bullets(b.get("why", [])) if b.get("why") else "")
             + (ek.p("<b>Context</b>", 14, ek.TEXT, "12px 0 6px") + bullets(b.get("context", [])) if b.get("context") else "")
             + ("" if live else ek.button("Review and publish", review))
             + ek.p(("It's live: " + ek.a(f"{ek.APP_URL}/blog/{row['slug']}", f"seli.app/blog/{row['slug']}")) if live
                    else "Nothing goes live until you publish it. Ignore this email to leave it as a draft.", 12, ek.MUTED))
    rows = f'<tr><td class="px" style="padding:22px 28px 0;">{inner}</td></tr>'
    subject = ("Published: " if live else "Blog draft: ") + post["title"]
    html_doc = ek.shell(title=subject, preheader=post["summary"], label="Blog", body_rows=rows,
                        footer_html=ek.p("Sent to you only, from db/blog_generate.py.", 11, ek.FAINT, "0"))
    ek.send(to_email=OPS_EMAIL, subject=subject, html_doc=html_doc, from_name="Seli", clerk_user_id="ops", kind="blog_review")


def review_digest(items: list[tuple[dict, dict]]) -> None:
    """One email per run, listing every new draft (title, why, a Review
    button each), instead of one email per post."""
    if not items:
        return
    if not OPS_EMAIL:
        log.warning("  No OPS_EMAIL set; drafts saved without an email.")
        return
    live = all(row.get("status") == "published" for _, row in items)
    blocks = []
    for post, row in items:
        b = post["body"]
        url = (f"{ek.APP_URL}/blog/{row['slug']}" if row.get("status") == "published"
               else f"{ek.WORKER_URL}/blog/review?id={row['id']}&t={row['review_token']}")
        why = "".join(ek.p("&bull; " + ek.esc(x), 13, ek.TEXT_2, "0 0 4px") for x in b.get("why", [])[:3])
        blocks.append(
            ek.p(" &nbsp;".join(ek.chip(t, "accent") for t in post["tags"]), 12, ek.MUTED, "18px 0 6px")
            + ek.p(f"<b>{ek.esc(post['title'])}</b>", 16, ek.TEXT, "0 0 6px")
            + ek.p(ek.esc(post["summary"]), 13, ek.MUTED, "0 0 8px")
            + why
            + ek.p(ek.a(url, "Open it live" if row.get("status") == "published" else "Review and publish"), 13, ek.TEXT, "6px 0 0"))
    n = len(items)
    head = (ek.p(f"{n} new post{'s' if n != 1 else ''} went live." if live else
                 f"{n} new draft{'s' if n != 1 else ''} cleared the bar. Nothing goes live until you publish it; ignore any you don't want.",
                 14, ek.TEXT, "0 0 4px"))
    rows = f'<tr><td class="px" style="padding:22px 28px 0;">{head}{"".join(blocks)}</td></tr>'
    subject = (f"Blog: {n} new post{'s' if n != 1 else ''}" if live else f"Blog: {n} draft{'s' if n != 1 else ''} to review") \
        + f" ({', '.join(p['ticker'] for p, _ in items if p.get('ticker'))[:80]})"
    html_doc = ek.shell(title=subject, preheader=items[0][0]["title"], label="Blog", body_rows=rows,
                        footer_html=ek.p("Sent to you only, from db/blog_generate.py.", 11, ek.FAINT, "0"))
    ek.send(to_email=OPS_EMAIL, subject=subject, html_doc=html_doc, from_name="Seli", clerk_user_id="ops", kind="blog_review")


# ── Weekly roundup ───────────────────────────────────────────────────────────
def roundup(cur, cols: set[str], as_of: date) -> dict | None:
    """Monday to as_of. The biggest buying and selling by company insiders,
    open-market only, with price context and how much of the selling was planned."""
    start = as_of - timedelta(days=as_of.weekday())
    planned = "COALESCE(f.planned, false)" if "planned" in cols else "false"
    dup = "f.duplicate_of IS NULL" if "duplicate_of" in cols else "TRUE"
    per_person = fetch(cur, f"""
        SELECT f.ticker, MAX(f.company_name) AS company, f.transaction_type AS type, f.insider_name,
               COUNT(*)::int AS trades, SUM(f.value)::float AS value, SUM(f.shares)::float AS shares,
               COUNT(*) FILTER (WHERE {planned})::int AS planned
          FROM public.filings f
         WHERE f.is_open_market AND f.transaction_code IN ('P', 'S') AND {dup}
           AND f.ticker IS NOT NULL AND COALESCE(f.price_per_share, 0) >= 1
           AND COALESCE(f.relationship, '') <> 'congress' AND COALESCE(f.transaction_code, '') NOT LIKE 'CONGRESS%%'
           AND f.filing_date BETWEEN %(s)s AND %(e)s
           AND f.filing_date - COALESCE(f.transaction_date, f.filing_date) <= {FRESH_DAYS}
         GROUP BY f.ticker, f.transaction_type, f.insider_name""", {"s": start, "e": as_of})
    # Company insiders only, same as the posts: funds and companies filing as
    # big holders are left out, and so are closed-end funds.
    agg: dict = {}
    for r in per_person:
        if ii.is_fund_name(r["company"]) or ek.is_entity_name(r["insider_name"]):
            continue
        a = agg.setdefault((r["ticker"], r["type"]), {"ticker": r["ticker"], "company": r["company"], "type": r["type"],
                                                      "insiders": 0, "trades": 0, "value": 0.0, "shares": 0.0, "planned": 0})
        a["insiders"] += 1
        for k in ("trades", "value", "shares", "planned"):
            a[k] += r[k] or 0
    rows = list(agg.values())
    def table(kind, n=8):
        out = []
        for r in sorted([r for r in rows if r["type"] == kind and r["value"] >= ROUNDUP_MIN], key=lambda r: -r["value"])[:n]:
            pctx = price_context(cur, r["ticker"], as_of)
            avg = r["value"] / r["shares"] if r["shares"] else None
            out.append({"ticker": r["ticker"], "company": short_company(ek.pretty_company(r["company"]) or r["ticker"]),
                        "insiders": r["insiders"], "trades": r["trades"], "value": round(r["value"]),
                        "avg_price": round(avg, 2) if avg else None, "now": pctx["now"] if pctx else None,
                        "chg": ((pctx["now"] - avg) / avg * 100) if pctx and avg else None,
                        "range_pos": range_pos(pctx, avg) if pctx and avg else None,
                        "planned": r["planned"]})
        return out
    buys, sells = table("buy"), table("sell")
    if not buys and not sells:
        return None
    tb, ts = sum(r["value"] for r in rows if r["type"] == "buy"), sum(r["value"] for r in rows if r["type"] == "sell")
    span = f"{start:%b} {start.day} to {as_of:%b} {as_of.day}" if start.month != as_of.month else f"{start:%b} {start.day} to {as_of.day}"
    top_b = buys[0] if buys else None
    title = f"Insider Buying This Week ({span}): {top_b['company']} ({top_b['ticker']}) Leads" if top_b else f"Insider Trading This Week ({span})"
    summary = (f"Company insiders bought {ek.money(tb)} and sold {ek.money(ts)} on the open market this week. "
               f"The biggest buying and selling, with what they paid, where the stock sits now, and which sales were planned.")
    return {
        "slug": slugify("insider-buying-this-week", str(start), str(as_of)), "kind": "roundup", "ticker": None, "company": None,
        "insiders": [], "tags": ["Weekly roundup"], "title": title, "summary": summary, "amount": round(tb),
        "accessions": [], "event_key": f"roundup|{start}",
        "search": (title + " " + " ".join(r["ticker"] + " " + r["company"] for r in buys + sells)).lower(),
        "body": {"v": 1, "kind": "roundup", "author": AUTHOR, "as_of": str(as_of), "start": str(start),
                 "lead": summary.split(". ")[0] + ".", "bought": round(tb), "sold": round(ts),
                 "buys": buys, "sells": sells,
                 "method": "Open-market Form 4 trades by company insiders, filed this week. Funds, offering purchases and filings more than 5 days late are left out. "
                           "Planned means the trade was set up in advance under a 10b5-1 plan."},
    }


def reddit_markdown(post: dict) -> str:
    b = post["body"]
    def rng(p):
        return "n/a" if p is None else f"{range_word(p)} ({p * 100:.0f}%)"
    def px(v):
        return price_txt(v) if v else "n/a"
    out = [f"# {post['title']}", "", "**TL;DR**",
           f"* Insiders bought {ek.money(b['bought'])} and sold {ek.money(b['sold'])} on the open market this week", ""]
    if b["buys"]:
        out += ["## Biggest buying", "", "| Ticker | Insiders | Bought | Avg price | Now | 52-wk range |", "|---|---|---|---|---|---|"]
        def now_cell(r):
            return px(r["now"]) + (f" ({pct_txt(r['chg'], 1)})" if r["chg"] is not None else "")
        out += [f"| {r['ticker']} | {r['insiders']} | {ek.money(r['value'])} | {px(r['avg_price'])} | {now_cell(r)} | {rng(r['range_pos'])} |"
                for r in b["buys"]]
        out.append("")
    if b["sells"]:
        out += ["## Biggest selling", "", "| Ticker | Insiders | Sold | Planned 10b5-1 | 52-wk range |", "|---|---|---|---|---|"]
        out += [f"| {r['ticker']} | {r['insiders']} | {ek.money(r['value'])} | {r['planned']} of {r['trades']} | {rng(r['range_pos'])} |"
                for r in b["sells"]]
        out.append("")
    out += ["---", "", "**Notes**", "", "[your notes]", "", f"*{b['method']} Not advice, just what got filed.*"]
    return "\n".join(out)


# ── Runs ─────────────────────────────────────────────────────────────────────
def run_daily(conn, as_of: date) -> None:
    cur = conn.cursor()
    cols = columns(cur)
    posts = candidates(cur, cols, as_of)
    log.info(f"{len(posts)} stock(s) cleared the bar for {as_of}")
    new = []
    for post in posts:
        what, row = save(conn, post)
        log.info(f"  {what:8} {post['title']}")
        if what == "new":
            new.append((post, row))
    review_digest(new)


def run_roundup(conn, as_of: date) -> None:
    cur = conn.cursor()
    post = roundup(cur, columns(cur), as_of)
    if not post:
        log.info("Nothing to round up this week."); return
    what, row = save(conn, post)
    log.info(f"  {what:8} {post['title']}")
    md = reddit_markdown(post)
    Path(os.environ.get("ROUNDUP_OUT", "weekly_roundup.md")).write_text(md)
    if what == "new":
        review_email(post, row)
        if OPS_EMAIL:
            html_doc = ek.shell(title="Reddit post: " + post["title"], preheader="This week's tables, ready to paste", label="Weekly roundup",
                                body_rows=f'<tr><td class="px" style="padding:22px 28px 0;">'
                                          f'{ek.p("Paste this into Reddit with the Markdown editor on. Add your notes where it says [your notes].")}'
                                          f'<pre style="white-space:pre-wrap;font-family:{ek.MONO};font-size:12px;background:{ek.SOFT};padding:14px;border-radius:8px;">{ek.esc(md)}</pre></td></tr>',
                                footer_html=ek.p("Sent to you only, from db/blog_generate.py --roundup.", 11, ek.FAINT, "0"))
            ek.send(to_email=OPS_EMAIL, subject="Reddit post: " + post["title"], html_doc=html_doc, from_name="Seli",
                    clerk_user_id="ops", kind="blog_reddit")


def run_backtest(conn, days: int, out_path: str) -> None:
    """Every day of the last `days`, as if the generator had run that evening.
    Writes nothing to the database."""
    cur = conn.cursor()
    cols = columns(cur)
    today = date.today()
    seen: dict[str, tuple[date, set]] = {}
    published, updates, by_reason = [], 0, defaultdict(int)
    for k in range(days, -1, -1):
        d = today - timedelta(days=k)
        if d.weekday() >= 5:
            continue
        found = candidates(cur, cols, d)
        log.info(f"  {d}: {len(found)} cleared the bar")
        for post in found:
            key = post["event_key"]
            last = seen.get(key)
            if last and (d - last[0]).days < REPEAT_DAYS:
                if not set(post["accessions"]) <= last[1]:
                    updates += 1
                    seen[key] = (last[0], last[1] | set(post["accessions"]))
                continue
            seen[key] = (d, set(post["accessions"]))
            published.append((d, post))
            for t in post["tags"]:
                by_reason[t] += 1
    buys = sum(1 for _, p in published if p["kind"] == "buy")
    lines = [f"# Blog backtest: last {days} days", "",
             f"{len(published)} posts ({buys} buys, {len(published) - buys} sells), plus {updates} updates to existing posts.", "",
             "By tag: " + ", ".join(f"{k} {v}" for k, v in sorted(by_reason.items(), key=lambda x: -x[1])), ""]
    for d, p in sorted(published, key=lambda x: x[0], reverse=True):
        b = p["body"]
        lines += [f"## {d}: {p['title']}", "", f"`/blog/{p['slug']}`  ·  tags: {', '.join(p['tags'])}", "",
                  p["summary"], "", b["lead"], ""]
        lines += [f"- {w}" for w in b["why"]] + [""] + [f"- {c}" for c in b["context"]] + [""]
    Path(out_path).write_text("\n".join(lines))
    log.info(f"{len(published)} posts ({buys} buys, {len(published) - buys} sells), {updates} updates. Written to {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", type=int, metavar="DAYS")
    ap.add_argument("--roundup", action="store_true")
    ap.add_argument("--as-of", help="YYYY-MM-DD (default today)")
    ap.add_argument("--out", default="blog_backtest.md")
    args = ap.parse_args()
    conn = ek.get_connection()
    as_of = date.fromisoformat(args.as_of) if args.as_of else date.today()
    if args.backtest:
        return run_backtest(conn, args.backtest, args.out)
    cur = conn.cursor()
    cur.execute("SELECT to_regclass('public.blog_posts')")
    if cur.fetchone()[0] is None:
        log.info("public.blog_posts doesn't exist yet (db/migrations/2026-10-28_blog.sql). Skipping.")
        return
    conn.commit()
    if args.roundup:
        run_roundup(conn, as_of)
    else:
        run_daily(conn, as_of)


if __name__ == "__main__":
    main()
