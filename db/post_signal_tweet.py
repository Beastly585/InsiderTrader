"""
Generate ready-to-post signal cards for Twitter/X.

Runs after ingest. Finds the day's strongest insider trading signals,
generates copy-pasteable tweet text + a branded dark-theme signal card
(SVG rendered inline), and emails both to you via Resend.

Workflow: open email → copy text → save/screenshot the card → paste
into Twitter. Zero API cost, full editorial control.

Required env vars:
  DATABASE_URL          — Neon connection string
  RESEND_API_KEY        — Resend API key (already set for alerts)
  ALERTS_FROM_EMAIL     — sender address (already set)
  NOTIFY_EMAIL          — where to send the cards (your email)
  APP_URL               — e.g. https://seli.app

Optional:
  MAX_CARDS             — max signals per email (default: 2)
  DRY_RUN               — "1" to print without emailing
  TEST_PREVIEW          — "1" to show candidates in the log
"""

import os, sys, json, logging
from datetime import date, timedelta

log = logging.getLogger("tweet")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s",
                    datefmt="%H:%M:%S")

DATABASE_URL       = os.environ.get("DATABASE_URL", "")
RESEND_API_KEY     = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL         = os.environ.get("ALERTS_FROM_EMAIL", "")
NOTIFY_EMAIL       = os.environ.get("NOTIFY_EMAIL", "")
APP_URL            = os.environ.get("APP_URL", "https://seli.app")
MAX_CARDS          = int(os.environ.get("MAX_CARDS", "2"))
DRY_RUN            = os.environ.get("DRY_RUN", "0") == "1"
TEST_PREVIEW       = os.environ.get("TEST_PREVIEW", "0") == "1"

HIGH_INTEREST_TICKERS = {
    'AAPL','MSFT','GOOGL','GOOG','AMZN','NVDA','META','TSLA','AMD','INTC',
    'NFLX','DIS','BA','JPM','GS','BAC','WFC','V','MA','PYPL',
    'CRM','ORCL','ADBE','SNOW','PLTR','COIN','HOOD','SOFI','SQ','SHOP',
    'UBER','LYFT','ABNB','RBLX','RIVN','LCID','NIO','GME','AMC',
    'MSTR','MARA','RIOT','DKNG','PENN','CRWD','PANW','ZS','NET','OKTA',
    'MDB','DDOG','U','SE','BABA','JD','PDD','TSM','SMCI','ARM',
    'LLY','PFE','MRNA','JNJ','ABBV','UNH','CVS','XOM','CVX','COP',
    'WMT','COST','TGT','HD','LOW','NKE','SBUX','MCD','CMG','LULU',
}


# ── DB ────────────────────────────────────────────────────────────────────────

def get_connection():
    try:
        import psycopg; return psycopg.connect(DATABASE_URL)
    except ImportError:
        import psycopg2; return psycopg2.connect(DATABASE_URL)


def ensure_tweet_log(conn):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS public.tweet_log (
            id SERIAL PRIMARY KEY,
            ticker TEXT NOT NULL,
            tweeted_date DATE NOT NULL DEFAULT CURRENT_DATE,
            tweet_text TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE(ticker, tweeted_date)
        )
    """)
    conn.commit()


def cards_sent_today(conn):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM public.tweet_log WHERE tweeted_date = CURRENT_DATE")
    return cur.fetchone()[0]


def get_top_signals(conn, limit=5):
    cur = conn.cursor()
    cutoff = (date.today() - timedelta(days=2)).isoformat()
    high_tickers = ",".join(f"'{t}'" for t in HIGH_INTEREST_TICKERS)

    cur.execute(f"""
        WITH recent AS (
            SELECT ticker, company_name, transaction_type, value,
                   insider_name, relationship, is_open_market,
                   COALESCE(transaction_date, filing_date) AS trade_date
            FROM public.filings
            WHERE COALESCE(transaction_date, filing_date) >= %s
              AND is_open_market = true
              AND ticker IS NOT NULL
        ),
        signals AS (
            SELECT
                ticker,
                MAX(company_name) AS company,
                COUNT(DISTINCT insider_name) AS insider_count,
                COUNT(*) AS trade_count,
                SUM(CASE WHEN transaction_type = 'buy' THEN COALESCE(value,0) ELSE 0 END) AS buy_value,
                SUM(CASE WHEN transaction_type = 'sell' THEN COALESCE(value,0) ELSE 0 END) AS sell_value,
                SUM(CASE WHEN transaction_type = 'buy' THEN COALESCE(value,0)
                         ELSE -COALESCE(value,0) END) AS net_value,
                COUNT(*) FILTER (WHERE relationship = 'strong') AS exec_count,
                bool_or(transaction_type = 'buy') AS has_buys,
                MAX(trade_date) AS last_date
            FROM recent
            GROUP BY ticker
            HAVING COUNT(DISTINCT insider_name) >= 2
        )
        SELECT ticker, company, insider_count, trade_count,
               buy_value, sell_value, net_value, exec_count,
               has_buys, last_date,
               (insider_count * 10 + exec_count * 15 +
                CASE WHEN ticker IN ({high_tickers}) THEN 30 ELSE 0 END +
                CASE WHEN has_buys THEN 20 ELSE 0 END +
                LEAST(ABS(net_value) / 100000, 50)) AS attention_score
        FROM signals
        WHERE ticker NOT IN (
            SELECT ticker FROM public.tweet_log WHERE tweeted_date = CURRENT_DATE
        )
        ORDER BY
          (exec_count >= 2 AND has_buys AND ticker IN ({high_tickers})) DESC,
          (insider_count * 10 + exec_count * 15 +
           CASE WHEN ticker IN ({high_tickers}) THEN 30 ELSE 0 END +
           CASE WHEN has_buys THEN 20 ELSE 0 END +
           LEAST(ABS(net_value) / 100000, 50)) DESC
        LIMIT %s
    """, (cutoff, limit))

    rows = cur.fetchall()
    cols = ['ticker', 'company', 'insider_count', 'trade_count',
            'buy_value', 'sell_value', 'net_value', 'exec_count',
            'has_buys', 'last_date', 'attention_score']
    return [dict(zip(cols, r)) for r in rows]


def log_card(conn, ticker, tweet_text):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO public.tweet_log (ticker, tweet_text) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (ticker, tweet_text)
    )
    conn.commit()


# ── Formatting ────────────────────────────────────────────────────────────────

def fmt_money(v):
    v = abs(v)
    if v >= 1_000_000_000: return f"${v/1_000_000_000:.1f}B"
    if v >= 1_000_000: return f"${v/1_000_000:.1f}M"
    if v >= 1_000:     return f"${v/1_000:.0f}K"
    return f"${v:.0f}"


def format_tweet(s):
    ticker = s['ticker']
    company = s['company'] or ticker
    insiders = s['insider_count']
    trades = s['trade_count']
    net = s['net_value']
    execs = s['exec_count']

    if net > 0:
        direction = "buying"
        value_str = fmt_money(net)
    else:
        direction = "selling"
        value_str = fmt_money(abs(net))

    lines = []
    if execs >= 3:
        lines.append(f"${ticker} — {execs} C-suite executives {direction}")
    elif execs >= 2:
        lines.append(f"${ticker} — {insiders} insiders {direction}, {execs} C-suite")
    else:
        lines.append(f"${ticker} — {insiders} insiders {direction}")

    lines.append(f"{value_str} across {trades} open-market trade{'s' if trades != 1 else ''}")

    if company and company != ticker and len(company) < 35:
        lines.append(company)

    lines.append("")
    lines.append(APP_URL)
    tweet = "\n".join(lines)

    if len(tweet) > 280:
        lines = [l for l in lines if l != company]
        tweet = "\n".join(lines)

    return tweet[:280]


# ── Signal card (SVG) ─────────────────────────────────────────────────────────

def generate_card_html(s):
    """Generate a branded signal card as an HTML table for email embedding.
    Uses only table-based layout and inline styles — renders in Gmail,
    Apple Mail, Outlook, and every mobile client."""
    ticker = s['ticker']
    company = (s['company'] or '')[:40]
    insiders = s['insider_count']
    trades = s['trade_count']
    net = s['net_value']
    execs = s['exec_count']
    buy_val = fmt_money(s['buy_value'])
    sell_val = fmt_money(s['sell_value'])

    direction = "Buying" if net > 0 else "Selling"
    net_str = fmt_money(abs(net))
    net_color = "#4ade80" if net > 0 else "#ef4444"
    dir_bg = "rgba(74,222,128,0.15)" if net > 0 else "rgba(239,68,68,0.15)"
    dir_color = "#4ade80" if net > 0 else "#ef4444"

    score = min(s.get('attention_score', 0) / 3, 100)
    bar_pct = max(min(int(score), 100), 5)
    bar_color = "#4ade80" if bar_pct >= 60 else "#eab308" if bar_pct >= 30 else "#ef4444"

    today_str = date.today().strftime("%b %d, %Y")

    return f'''<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;border-radius:12px;overflow:hidden;border:1px solid #222240;">
  <!-- Accent bar -->
  <tr><td style="height:3px;background:linear-gradient(90deg,#7c5cfc,#4dd4e6);font-size:1px;">&nbsp;</td></tr>
  <!-- Header -->
  <tr><td style="padding:16px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:13px;color:#8888a0;font-family:system-ui,-apple-system,sans-serif;">seli.app</td>
      <td style="text-align:right;font-size:12px;color:#555;font-family:system-ui,-apple-system,sans-serif;">{today_str}</td>
    </tr></table>
  </td></tr>
  <!-- Ticker + Direction -->
  <tr><td style="padding:14px 20px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:36px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;letter-spacing:-1px;padding-right:14px;">${ticker}</td>
      <td style="vertical-align:middle;">
        <span style="display:inline-block;background:{dir_bg};color:{dir_color};font-size:12px;font-weight:700;padding:4px 10px;border-radius:12px;">{direction}</span>
      </td>
    </tr></table>
    <div style="font-size:13px;color:#8888a0;margin-top:4px;font-family:system-ui,-apple-system,sans-serif;">{company}</div>
  </td></tr>
  <!-- Stats grid -->
  <tr><td style="padding:16px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:25%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Insiders</div>
        <div style="font-size:24px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{insiders}</div>
      </td>
      <td style="width:25%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">C-Suite</div>
        <div style="font-size:24px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{execs}</div>
      </td>
      <td style="width:25%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Trades</div>
        <div style="font-size:24px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{trades}</div>
      </td>
      <td style="width:25%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Net Value</div>
        <div style="font-size:24px;font-weight:800;color:{net_color};font-family:system-ui,-apple-system,sans-serif;">{'+'if net>0 else'-'}{net_str}</div>
      </td>
    </tr></table>
  </td></tr>
  <!-- Buy/Sell breakdown -->
  <tr><td style="padding:12px 20px 0;">
    <div style="font-size:13px;color:#8888a0;font-family:system-ui,-apple-system,sans-serif;">
      Buys: <span style="color:#4ade80;font-weight:600;">{buy_val}</span> &nbsp;·&nbsp; Sells: <span style="color:#ef4444;font-weight:600;">{sell_val}</span>
    </div>
  </td></tr>
  <!-- Signal bar -->
  <tr><td style="padding:14px 20px 0;">
    <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:6px;">Signal Strength</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:400px;"><tr>
      <td style="width:{bar_pct}%;height:8px;background:{bar_color};border-radius:4px 0 0 4px;font-size:1px;">&nbsp;</td>
      <td style="width:{100-bar_pct}%;height:8px;background:#1a1a2e;border-radius:0 4px 4px 0;font-size:1px;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:14px 20px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #222240;padding-top:12px;"><tr>
      <td style="font-size:11px;color:#555;font-family:system-ui,-apple-system,sans-serif;">Open-market trades · SEC Form 4 · Last 48h</td>
      <td style="text-align:right;font-size:13px;font-weight:700;color:#7c5cfc;font-family:system-ui,-apple-system,sans-serif;">seli.app</td>
    </tr></table>
  </td></tr>
</table>'''


def send_card_email(signals_with_cards):
    import requests

    cards_html = ""
    for s, tweet, card_html in signals_with_cards:
        cards_html += f'''
        <div style="margin-bottom:28px;">
          <!-- Signal card — renders as HTML table, works in all email clients -->
          <div style="margin-bottom:14px;">
            {card_html}
          </div>
          <!-- Copy-paste tweet text -->
          <div style="background:#1a1a2e;border-radius:8px;padding:14px 16px;margin-bottom:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Copy-paste tweet text</div>
            <pre style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#e8e8ec;white-space:pre-wrap;margin:0;line-height:1.5;">{tweet}</pre>
          </div>
          <div style="font-size:11px;color:#555;">
            Score: {s['attention_score']:.0f} · {s['insider_count']} insiders · {s['exec_count']} C-suite · {"★ High-interest ticker" if s['ticker'] in HIGH_INTEREST_TICKERS else "Regular ticker"}
          </div>
        </div>
        '''

    html = f'''
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#0a0a14;color:#e8e8ec;">
      <div style="margin-bottom:24px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">Signal Cards Ready</div>
        <div style="font-size:13px;color:#888;">{date.today().strftime("%B %d, %Y")} · {len(signals_with_cards)} signal{'s' if len(signals_with_cards) != 1 else ''} to post</div>
      </div>
      <div style="font-size:13px;color:#888;margin-bottom:20px;padding:12px;background:#1a1a2e;border-radius:8px;">
        Copy the tweet text below each card → paste into Twitter/X → post
      </div>
      {cards_html}
      <div style="text-align:center;padding:16px;font-size:12px;color:#444;">
        <a href="{APP_URL}" style="color:#7c5cfc;text-decoration:none;">seli.app</a>
      </div>
    </div>
    '''

    r = requests.post("https://api.resend.com/emails", json={
        "from": FROM_EMAIL,
        "to": [NOTIFY_EMAIL],
        "subject": f"Signal cards — {', '.join('$'+s['ticker'] for s,_,_ in signals_with_cards)} — {date.today().strftime('%b %d')}",
        "html": html,
    }, headers={
        "Authorization": f"Bearer {RESEND_API_KEY}",
        "Content-Type": "application/json",
    }, timeout=15)

    if r.status_code in (200, 201):
        log.info("  Email sent successfully")
        return True
    else:
        log.error(f"  Resend API {r.status_code}: {r.text}")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    if not DATABASE_URL:
        log.error("DATABASE_URL not set"); sys.exit(1)
    if not DRY_RUN and not TEST_PREVIEW and not all([RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL]):
        log.error("Email credentials not set (RESEND_API_KEY, ALERTS_FROM_EMAIL, NOTIFY_EMAIL)"); sys.exit(1)

    conn = get_connection()
    ensure_tweet_log(conn)

    already = cards_sent_today(conn)
    slots = MAX_CARDS - already
    log.info(f"Cards today: {already}/{MAX_CARDS} — {slots} slot{'s' if slots != 1 else ''} remaining")

    if slots <= 0 and not TEST_PREVIEW:
        log.info("Daily limit reached. Done.")
        conn.close()
        return

    candidates = get_top_signals(conn, limit=5)

    if not candidates:
        log.info("No untweeted signals with 2+ insiders in the last 48h. Done.")
        conn.close()
        return

    # Preview mode
    if TEST_PREVIEW:
        log.info(f"\n{'='*60}")
        log.info(f"  TOP {len(candidates)} CANDIDATES")
        log.info(f"{'='*60}")
        for i, s in enumerate(candidates, 1):
            tweet = format_tweet(s)
            known = "★" if s['ticker'] in HIGH_INTEREST_TICKERS else " "
            log.info(f"\n  #{i} {known} ${s['ticker']}  score={s['attention_score']:.0f}  "
                     f"insiders={s['insider_count']}  execs={s['exec_count']}  "
                     f"net={fmt_money(s['net_value'])}  buys={'yes' if s['has_buys'] else 'no'}")
            for line in tweet.split('\n'):
                log.info(f"  │ {line}")
            log.info(f"  ({len(tweet)} chars)")
        conn.close()
        return

    # Generate cards for the top signals
    to_send = []
    for s in candidates[:slots]:
        tweet = format_tweet(s)
        svg = generate_card_svg(s)
        to_send.append((s, tweet, svg))
        log.info(f"  Card: ${s['ticker']} — {s['insider_count']} insiders, "
                 f"net {fmt_money(s['net_value'])}, score {s['attention_score']:.0f}")

    if DRY_RUN:
        log.info(f"\n  DRY RUN — {len(to_send)} cards generated, not emailing")
        for s, tweet, svg in to_send:
            log.info(f"\n  Tweet text:\n{tweet}\n")
            log.info(f"  SVG card: {len(svg)} bytes")
    else:
        log.info(f"\n  Sending {len(to_send)} cards via email…")
        if send_card_email(to_send):
            for s, tweet, _ in to_send:
                log_card(conn, s['ticker'], tweet)
            log.info(f"  Logged {len(to_send)} cards to tweet_log")
        else:
            log.error("  Email failed — will retry on next run")

    conn.close()
    log.info("Done.")


if __name__ == "__main__":
    run()
