"""
db/insider_intel.py
The "what actually happened" layer behind the digest and welcome email.
Pure data: SQL + Python aggregation, no HTML. email templates live in
send_digests.py / send_welcome.py.

What it produces:
  week_buys()        every open-market buy FILED in the window, with the
                     insider's previous buy date on that ticker attached
  build_clusters()   those buys grouped by ticker, ranked, with plain-English
                     facts ("3 insiders buying", "CEO buying", "first buy in
                     4 yrs", "+38% stake") and a lead-story sentence
  market_pulse()     this window's buy/sell counts vs the trailing 12 windows
  ticker_status()    per-ticker status for a watchlist: this window's buys and
                     sells, 12-month totals, and the last insider buy ever,
                     so a quiet week still says something useful

About the ranking score: it's an email-side approximation built from the
same factors as lib/scoring.js (who, how many, how big, % of stake,
non-routine, recency). It's used to ORDER things and never shown as a
number, because a number that doesn't match what the app shows when they
click through would cost trust. If scoring.js ever moves server-side (or
gets stored per filing), swap rank_score() for it.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date

from email_kit import as_date, money, plural, pretty_company, pretty_person, short_role

CSUITE_ROLES = {"CEO", "CFO", "COO", "CTO", "President", "C-suite exec"}


def _rows(cur):
    cols = [d.name for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def is_congress(r: dict) -> bool:
    return r.get("relationship") == "congress" or (r.get("transaction_code") or "").upper().startswith("CONGRESS")


# ── Buys filed in the window ─────────────────────────────────────────────────
WEEK_BUYS_SQL = """
SELECT f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship,
       f.transaction_code, f.value::float AS value, f.price_per_share::float AS price,
       f.pct_owned_change::float AS pct, f.shares_owned_before::float AS owned_before,
       f.is_routine, f.filing_date,
       COALESCE(f.transaction_date, f.filing_date) AS trade_date,
       (SELECT MAX(COALESCE(p.transaction_date, p.filing_date))
          FROM public.filings p
         WHERE p.insider_name = f.insider_name AND p.ticker = f.ticker
           AND p.is_open_market = true AND p.transaction_type = 'buy'
           AND COALESCE(p.transaction_date, p.filing_date) < COALESCE(f.transaction_date, f.filing_date) - 30
       ) AS prior_buy_date
  FROM public.filings f
 WHERE f.is_open_market = true
   AND f.transaction_type = 'buy'
   AND f.ticker IS NOT NULL
   AND f.filing_date >  CURRENT_DATE - %(days)s
   AND f.filing_date <= CURRENT_DATE
   -- late filings for old trades aren't news
   AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - (%(days)s + 45)
   AND COALESCE(f.value, 0) >= %(min_value)s
   -- sub-$1 stocks: tiny dollar amounts, huge percent swings, mostly noise
   AND (f.price_per_share IS NULL OR f.price_per_share >= 1)
"""


def week_buys(conn, days: int = 7, min_value: float = 10_000) -> list[dict]:
    cur = conn.cursor()
    cur.execute(WEEK_BUYS_SQL, {"days": days, "min_value": min_value})
    rows = _rows(cur)
    cur.close()
    return rows


# ── Clusters ─────────────────────────────────────────────────────────────────
def _gap_years(prior, trade) -> float | None:
    prior, trade = as_date(prior), as_date(trade)
    if not prior or not trade:
        return None
    return (trade - prior).days / 365.25


def _stake_label(pct, owned_before) -> str | None:
    if pct is None:
        return "New position" if owned_before is not None and owned_before <= 0 else None
    if pct < 5:
        return None
    if pct < 100:
        return f"+{pct:.0f}% stake"
    mult = 1 + pct / 100
    return f"Stake {mult:.0f}x" if mult >= 10 else f"Stake {mult:.1f}x".replace(".0x", "x")


def rank_score(c: dict) -> float:
    n = c["n_insiders"]
    s = {1: 0, 2: 18, 3: 28}.get(n, 32)
    if c["csuite"]:
        s += 20
    elif any(b["role"] in ("Chair", "VP", "General Counsel", "Officer") for b in c["buyers"]):
        s += 8
    if c["congress"]:
        s += 6
    if c["nonroutine"]:
        s += 10
    s += max(0.0, min(21.0, 7 * math.log10(max(c["total"], 1) / 25_000)))
    mp = c["max_pct"] or 0
    s += 14 if mp >= 50 else 10 if mp >= 25 else 6 if mp >= 10 else 0
    if c["first_buy"]:
        s += 8
    # a lone fund / 10% owner topping up is the least interesting kind of buy
    if n == 1 and c["buyers"][0]["role"] == "10% owner":
        s -= 12
    return max(0.0, min(100.0, s))


def build_clusters(buys: list[dict], *, include_corporate: bool = True, include_congress: bool = True) -> list[dict]:
    by_ticker: dict[str, list[dict]] = defaultdict(list)
    for r in buys:
        cg = is_congress(r)
        if (cg and not include_congress) or (not cg and not include_corporate):
            continue
        by_ticker[r["ticker"]].append(r)

    clusters = []
    for ticker, rows in by_ticker.items():
        buyers: dict[str, dict] = {}
        for r in rows:
            b = buyers.setdefault(r["insider_name"], {
                "raw": r["insider_name"],
                "name": pretty_person(r["insider_name"], is_congress(r)),
                "title": r.get("insider_title") or "",
                "role": short_role(r.get("insider_title"), "congress" if is_congress(r) else r.get("relationship")),
                "relationship": r.get("relationship"),
                "value": 0.0, "pct": None, "owned_before": r.get("owned_before"),
                "last_trade": None, "prior_buy_date": r.get("prior_buy_date"),
                "nonroutine": False, "congress": is_congress(r),
            })
            b["value"] += r.get("value") or 0
            if r.get("pct") is not None:
                b["pct"] = max(b["pct"] or 0, r["pct"])
            td = as_date(r.get("trade_date"))
            if td and (b["last_trade"] is None or td > b["last_trade"]):
                b["last_trade"] = td
            if r.get("is_routine") is False:
                b["nonroutine"] = True
            # most recent earlier buy wins (each row's value is already a MAX)
            if r.get("prior_buy_date") and (b["prior_buy_date"] is None or as_date(r["prior_buy_date"]) > as_date(b["prior_buy_date"])):
                b["prior_buy_date"] = r["prior_buy_date"]

        blist = sorted(buyers.values(), key=lambda b: b["value"], reverse=True)
        for b in blist:
            gap = _gap_years(b["prior_buy_date"], b["last_trade"])
            b["gap_years"] = gap
            b["first_buy"] = (b["prior_buy_date"] is None) or (gap is not None and gap >= 2)
            b["stake"] = _stake_label(b["pct"], b["owned_before"])

        c = {
            "ticker": ticker,
            "company": pretty_company(rows[0].get("company_name")) or ticker,
            "buyers": blist,
            "n_insiders": len(blist),
            "total": sum(b["value"] for b in blist),
            # relationship='strong' is set for ANY is_officer at ingest (VPs too), so go by title
            "csuite": [b for b in blist if b["role"] in CSUITE_ROLES],
            "congress": any(b["congress"] for b in blist),
            "nonroutine": any(b["nonroutine"] for b in blist),
            "max_pct": max((b["pct"] or 0) for b in blist),
            "first_buy": [b for b in blist if b["first_buy"] and b["role"] != "10% owner"],
            "last_trade": max((b["last_trade"] for b in blist if b["last_trade"]), default=None),
        }
        c["score"] = rank_score(c)
        c["facts"] = cluster_facts(c)
        clusters.append(c)

    clusters.sort(key=lambda c: (c["score"], c["total"]), reverse=True)
    return clusters


def _roles_phrase(bs: list[dict]) -> str:
    roles = []
    for b in bs:
        if b["role"] not in roles:
            roles.append(b["role"])
    return " + ".join(roles[:2])


def cluster_facts(c: dict) -> list[tuple[str, str]]:
    """Short factual chips, most important first. (label, tone)"""
    f: list[tuple[str, str]] = []
    if c["n_insiders"] >= 2:
        f.append((f"{c['n_insiders']} insiders buying", "buy"))
    if c["csuite"]:
        f.append((f"{_roles_phrase(c['csuite'])} buying", "buy"))
    elif c["congress"]:
        f.append(("Member of Congress", "accent"))
    fb = c["first_buy"]
    if fb:
        g = fb[0]["gap_years"]
        f.append((f"First buy in {round(g)} yrs" if g else "First buy on record", "accent"))
    stakes = [b for b in c["buyers"] if b["stake"]]
    if stakes:
        top = max(stakes, key=lambda b: (b["pct"] or 0))
        f.append((top["stake"], "neutral"))
    if c["nonroutine"]:
        f.append(("Non-routine", "neutral"))
    f.append((f"{money(c['total'])} total", "neutral"))
    return f[:5]


def lead_sentence(c: dict) -> str:
    """One or two plain sentences, no hype. Plain text; caller escapes."""
    top = c["buyers"][0]
    who = top["name"]
    role = top["role"]
    role_bit = "a member of Congress" if role == "Congress" else ("a 10% owner" if role == "10% owner" else f"the {role}" if role in CSUITE_ROLES or role in ("Chair", "General Counsel") else f"a {role.lower()}")
    if c["n_insiders"] >= 2:
        s = f"{c['n_insiders']} insiders at {c['company']} bought {money(c['total'])} of stock this week. The biggest check came from {who}, {role_bit}, at {money(top['value'])}"
    else:
        s = f"{who}, {role_bit} at {c['company']}, bought {money(top['value'])} of stock on the open market"
    if top["pct"] is not None and top["pct"] >= 5:
        s += f", growing their stake by {top['pct']:.0f}%" if top["pct"] < 100 else f", growing their stake {1 + top['pct'] / 100:.1f}x".replace(".0x", "x")
    s += "."
    fb = [b for b in c["first_buy"] if b["gap_years"]]
    if fb:
        b = fb[0]
        s += f" It's {b['name']}'s first open-market buy of {c['ticker']} in {round(b['gap_years'])} years."
    elif c["first_buy"] and c["first_buy"][0] is top:
        s += f" It's the first open-market buy of {c['ticker']} on record for {top['name']}."
    return s


def filing_context(c: dict) -> str:
    """One plain, descriptive line about what makes this filing stand out.
    Explains the data, never what the stock might do. Rotates with what's
    actually true about the lead so regular readers learn something new."""
    fb = [b for b in c["first_buy"] if b["gap_years"]]
    if c["n_insiders"] >= 3:
        return ("When several insiders at one company file open-market buys within a few weeks, it's called a cluster. "
                "Clusters show up less often than single buys, which is why Seli points them out.")
    if fb:
        return (f"{fb[0]['name']} hadn't filed an open-market buy of {c['ticker']} in {round(fb[0]['gap_years'])} years. "
                "Seli flags it when an insider's filings break from their usual pattern.")
    if c["csuite"]:
        return ("Most executive stock comes from grants and option exercises. An open-market buy means the executive "
                "paid market price with their own money, which happens less often.")
    if (c["max_pct"] or 0) >= 25:
        return ("Stake change compares the shares bought to what the insider already held, "
                "so the dollar amount can be read against the size of their existing position.")
    if c["congress"]:
        return "Congressional trades are disclosed under the STOCK Act, often weeks after the trade date."
    return ("Open-market buys are trades an insider chose to make at market price, as opposed to grants, "
            "option exercises or pre-scheduled plan trades.")


# ── Market pulse ─────────────────────────────────────────────────────────────
PULSE_SQL = """
SELECT ((CURRENT_DATE - f.filing_date) / %(days)s)::int AS bucket,
       f.transaction_type,
       COUNT(DISTINCT f.accession_number) AS n,
       COALESCE(SUM(f.value), 0)::float  AS v
  FROM public.filings f
 WHERE f.is_open_market = true
   AND f.transaction_type IN ('buy', 'sell')
   AND f.ticker IS NOT NULL
   AND f.filing_date >  CURRENT_DATE - %(days)s * 13
   AND f.filing_date <= CURRENT_DATE
 GROUP BY 1, 2
"""


def market_pulse(conn, days: int = 7) -> dict | None:
    cur = conn.cursor()
    cur.execute(PULSE_SQL, {"days": days})
    rows = _rows(cur)
    cur.close()
    # CURRENT_DATE - filing_date is 0..days*13-1; bucket 0 = the latest window
    now = {"buy": (0, 0.0), "sell": (0, 0.0)}
    hist = defaultdict(lambda: {"buy": 0, "sell": 0})
    for r in rows:
        b = r["bucket"]
        if b == 0:
            now[r["transaction_type"]] = (r["n"], r["v"])
        elif 1 <= b <= 12:
            hist[b][r["transaction_type"]] = r["n"]
    if now["buy"][0] + now["sell"][0] == 0:
        return None
    weeks = [hist[b] for b in range(1, 13) if hist[b]["buy"] + hist[b]["sell"] > 0]
    avg_buy = sum(w["buy"] for w in weeks) / len(weeks) if weeks else None
    out = {"buy_n": now["buy"][0], "buy_v": now["buy"][1], "sell_n": now["sell"][0], "sell_v": now["sell"][1],
           "avg_buy_n": avg_buy, "vs_avg": None, "verdict": None}
    if avg_buy and len(weeks) >= 4:
        ratio = out["buy_n"] / avg_buy
        out["vs_avg"] = ratio - 1
        out["verdict"] = ("more buying than usual" if ratio >= 1.2 else
                          "less buying than usual" if ratio <= 0.8 else "a normal amount of buying")
    return out


# ── Watchlist / portfolio ticker status ─────────────────────────────────────
TICKER_ROWS_SQL = """
SELECT f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
       f.transaction_type, f.value::float AS value, f.pct_owned_change::float AS pct,
       f.accession_number, f.filing_date, COALESCE(f.transaction_date, f.filing_date) AS trade_date
  FROM public.filings f
 WHERE f.ticker = ANY(%(tickers)s)
   AND f.is_open_market = true
   AND f.transaction_type IN ('buy', 'sell')
   AND f.filing_date <= CURRENT_DATE
   AND COALESCE(f.transaction_date, f.filing_date) >= CURRENT_DATE - 380
"""

LAST_BUY_SQL = """
SELECT DISTINCT ON (f.ticker)
       f.ticker, f.company_name, f.insider_name, f.insider_title, f.relationship, f.transaction_code,
       f.value::float AS value, COALESCE(f.transaction_date, f.filing_date) AS trade_date
  FROM public.filings f
 WHERE f.ticker = ANY(%(tickers)s)
   AND f.is_open_market = true AND f.transaction_type = 'buy'
   AND COALESCE(f.transaction_date, f.filing_date) <= CURRENT_DATE
   -- corporate insiders only; Congress trades are reported separately (as ranges)
   AND COALESCE(f.relationship, '') <> 'congress'
   AND COALESCE(f.transaction_code, '') NOT ILIKE 'CONGRESS%%'
 ORDER BY f.ticker, COALESCE(f.transaction_date, f.filing_date) DESC, f.value DESC NULLS LAST
"""

NAME_SQL = """
SELECT DISTINCT ON (f.ticker) f.ticker, f.company_name
  FROM public.filings f
 WHERE f.ticker = ANY(%(tickers)s) AND f.company_name IS NOT NULL
 ORDER BY f.ticker, f.filing_date DESC
"""


def _agg(rows: list[dict]) -> dict:
    per: dict[str, dict] = {}
    for r in rows:
        p = per.setdefault(r["insider_name"], {"raw": r["insider_name"], "name": pretty_person(r["insider_name"], is_congress(r)),
                                               "role": short_role(r.get("insider_title"), "congress" if is_congress(r) else r.get("relationship")),
                                               "value": 0.0, "pct": None, "last": None})
        p["value"] += r.get("value") or 0
        if r.get("pct") is not None:
            p["pct"] = max(p["pct"] or 0, r["pct"])
        td = as_date(r.get("trade_date"))
        if td and (p["last"] is None or td > p["last"]):
            p["last"] = td
    people = sorted(per.values(), key=lambda x: x["value"], reverse=True)
    return {"n": len({r["accession_number"] for r in rows}), "v": sum(r.get("value") or 0 for r in rows),
            "insiders": len(people), "people": people}


def ticker_status(conn, tickers: list[str], window_days: int = 7, today: date | None = None) -> dict[str, dict]:
    """{ticker: status}. window = 'recent' activity (7 for weekly digest, 1 for
    daily, 90 for the welcome email). 12-month totals and the last-ever buy
    come along regardless so quiet tickers still get a useful line."""
    tickers = sorted({t.upper() for t in tickers if t})
    if not tickers:
        return {}
    today = today or date.today()
    cur = conn.cursor()
    cur.execute(TICKER_ROWS_SQL, {"tickers": tickers})
    rows = _rows(cur)
    cur.execute(LAST_BUY_SQL, {"tickers": tickers})
    last_buys = {r["ticker"]: r for r in _rows(cur)}
    cur.execute(NAME_SQL, {"tickers": tickers})
    names = {r["ticker"]: r["company_name"] for r in _rows(cur)}
    cur.close()

    by_t: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_t[r["ticker"]].append(r)

    def congress_view(rs):
        rs = sorted(rs, key=lambda r: as_date(r["trade_date"]) or date.min, reverse=True)
        return {"n": len(rs), "latest": None if not rs else {
            "name": pretty_person(rs[0]["insider_name"], True), "type": rs[0]["transaction_type"],
            "value": rs[0].get("value"), "date": as_date(rs[0]["trade_date"])}}

    out = {}
    for t in tickers:
        rs = by_t.get(t, [])
        corp = [r for r in rs if not is_congress(r)]
        cong = [r for r in rs if is_congress(r)]
        is_recent = lambda r: as_date(r["filing_date"]) and (today - as_date(r["filing_date"])).days < window_days
        in_year = lambda r: as_date(r["trade_date"]) and (today - as_date(r["trade_date"])).days <= 365
        lb = last_buys.get(t)
        out[t] = {
            "ticker": t,
            "company": pretty_company(names.get(t) or (lb or {}).get("company_name")) or t,
            "known": bool(names.get(t)),
            # Corporate insiders (Form 4). Exact dollar amounts.
            "recent_buys": _agg([r for r in corp if is_recent(r) and r["transaction_type"] == "buy"]),
            "recent_sells": _agg([r for r in corp if is_recent(r) and r["transaction_type"] == "sell"]),
            "yr_buys": _agg([r for r in corp if in_year(r) and r["transaction_type"] == "buy"]),
            "yr_sells": _agg([r for r in corp if in_year(r) and r["transaction_type"] == "sell"]),
            "last_buy": None if not lb else {
                "raw": lb["insider_name"], "name": pretty_person(lb["insider_name"], False),
                "role": short_role(lb.get("insider_title"), lb.get("relationship")),
                "value": lb.get("value"), "date": as_date(lb["trade_date"]),
            },
            # Congress (STOCK Act). Amounts are ranges; shown separately.
            "recent_congress": congress_view([r for r in cong if is_recent(r)]),
            "yr_congress": congress_view([r for r in cong if in_year(r)]),
        }
    return out


# ── Followed insiders ────────────────────────────────────────────────────────
FOLLOWED_SQL = """
SELECT f.insider_name, f.insider_title, f.relationship, f.transaction_code, f.ticker, f.company_name,
       f.transaction_type, f.value::float AS value, f.filing_date,
       COALESCE(f.transaction_date, f.filing_date) AS trade_date
  FROM public.filings f
 WHERE f.insider_name = ANY(%(names)s)
   AND f.is_open_market = true AND f.transaction_type IN ('buy', 'sell')
   AND f.filing_date > CURRENT_DATE - %(days)s AND f.filing_date <= CURRENT_DATE
"""


def followed_activity(conn, names: list[str], days: int = 7) -> dict[str, list[dict]]:
    if not names:
        return {}
    cur = conn.cursor()
    cur.execute(FOLLOWED_SQL, {"names": sorted(set(names)), "days": days})
    rows = _rows(cur)
    cur.close()
    grouped: dict[tuple, dict] = {}
    for r in rows:
        k = (r["insider_name"], r["ticker"], r["transaction_type"])
        g = grouped.setdefault(k, {"raw": r["insider_name"], "name": pretty_person(r["insider_name"], is_congress(r)),
                                   "ticker": r["ticker"], "company": pretty_company(r["company_name"]),
                                   "type": r["transaction_type"], "value": 0.0})
        g["value"] += r.get("value") or 0
    out: dict[str, list[dict]] = defaultdict(list)
    for (name, _, _), g in grouped.items():
        out[name].append(g)
    return out


def summarize_people(people: list[dict], limit: int = 1) -> str:
    """'Jane Doe (CFO)' or 'Jane Doe (CFO) and 2 others'."""
    if not people:
        return ""
    head = f"{people[0]['name']} ({people[0]['role']})"
    rest = len(people) - 1
    return head if rest <= 0 else f"{head} and {plural(rest, 'other')}"


_CORP_SUFFIX = re.compile(r"[,.]?\s+(inc|corp|corporation|co|company|ltd|plc|holdings|group|incorporated|n\.?v\.?|s\.?a\.?)\.?$", re.I)


def short_company(name: str) -> str:
    """'Crocs Inc' -> 'Crocs', 'Bank of America Corp' -> 'Bank of America'. For subject lines."""
    s = name or ""
    for _ in range(2):
        s = _CORP_SUFFIX.sub("", s).strip()
    return s or name
