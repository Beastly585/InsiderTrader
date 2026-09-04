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

def generate_card_svg(s):
    """Generate a branded dark-theme signal card as SVG (1200×628 for Twitter)."""
    ticker = s['ticker']
    company = (s['company'] or '')[:40]
    insiders = s['insider_count']
    trades = s['trade_count']
    net = s['net_value']
    execs = s['exec_count']
    has_buys = s['has_buys']
    buy_val = fmt_money(s['buy_value'])
    sell_val = fmt_money(s['sell_value'])

    direction = "Buying" if net > 0 else "Selling"
    net_str = fmt_money(abs(net))
    net_color = "#4ade80" if net > 0 else "#ef4444"
    dir_color = "#4ade80" if net > 0 else "#ef4444"

    # Conviction-style bar
    score = min(s['attention_score'] / 3, 100)  # normalize to 0-100ish
    bar_pct = max(min(score, 100), 5)
    bar_color = "#4ade80" if bar_pct >= 60 else "#eab308" if bar_pct >= 30 else "#ef4444"

    today_str = date.today().strftime("%b %d, %Y")

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" width="1200" height="628">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d0d1a"/>
      <stop offset="100%" stop-color="#151530"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7c5cfc"/>
      <stop offset="100%" stop-color="#4dd4e6"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="628" fill="url(#bg)" rx="0"/>

  <!-- Subtle glow -->
  <circle cx="200" cy="100" r="300" fill="#7c5cfc" opacity="0.06"/>

  <!-- Top accent line -->
  <rect x="0" y="0" width="1200" height="3" fill="url(#accent)"/>

  <!-- Seli branding -->
  <text x="60" y="60" font-family="system-ui,-apple-system,sans-serif" font-size="18" font-weight="700" fill="#8888a0">seli.app</text>
  <text x="1140" y="60" font-family="system-ui,-apple-system,sans-serif" font-size="16" fill="#555" text-anchor="end">{today_str}</text>

  <!-- Ticker -->
  <text x="60" y="160" font-family="system-ui,-apple-system,sans-serif" font-size="72" font-weight="800" fill="#e8e8ec" letter-spacing="-2">${ticker}</text>

  <!-- Company -->
  <text x="60" y="200" font-family="system-ui,-apple-system,sans-serif" font-size="22" fill="#8888a0">{company}</text>

  <!-- Direction badge -->
  <rect x="60" y="230" width="{len(direction)*16+32}" height="36" rx="18" fill="{dir_color}" opacity="0.15"/>
  <text x="{60+len(direction)*8+16}" y="254" font-family="system-ui,-apple-system,sans-serif" font-size="16" font-weight="700" fill="{dir_color}" text-anchor="middle">{direction}</text>

  <!-- Stats grid -->
  <text x="60" y="320" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#555" letter-spacing="1">INSIDERS</text>
  <text x="60" y="355" font-family="system-ui,-apple-system,sans-serif" font-size="36" font-weight="800" fill="#e8e8ec">{insiders}</text>

  <text x="240" y="320" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#555" letter-spacing="1">C-SUITE</text>
  <text x="240" y="355" font-family="system-ui,-apple-system,sans-serif" font-size="36" font-weight="800" fill="#e8e8ec">{execs}</text>

  <text x="420" y="320" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#555" letter-spacing="1">TRADES</text>
  <text x="420" y="355" font-family="system-ui,-apple-system,sans-serif" font-size="36" font-weight="800" fill="#e8e8ec">{trades}</text>

  <text x="600" y="320" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#555" letter-spacing="1">NET VALUE</text>
  <text x="600" y="355" font-family="system-ui,-apple-system,sans-serif" font-size="36" font-weight="800" fill="{net_color}">{'+' if net > 0 else '-'}{net_str}</text>

  <!-- Buy/Sell breakdown -->
  <text x="60" y="420" font-family="system-ui,-apple-system,sans-serif" font-size="15" fill="#8888a0">Buys: <tspan fill="#4ade80" font-weight="600">{buy_val}</tspan>  ·  Sells: <tspan fill="#ef4444" font-weight="600">{sell_val}</tspan></text>

  <!-- Signal strength bar -->
  <text x="60" y="480" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#555" letter-spacing="1">SIGNAL STRENGTH</text>
  <rect x="60" y="496" width="500" height="10" rx="5" fill="#1a1a2e"/>
  <rect x="60" y="496" width="{bar_pct * 5}" height="10" rx="5" fill="{bar_color}"/>

  <!-- Divider -->
  <line x1="60" y1="545" x2="1140" y2="545" stroke="#222240" stroke-width="0.5"/>

  <!-- Footer -->
  <text x="60" y="585" font-family="system-ui,-apple-system,sans-serif" font-size="14" fill="#555">Open-market trades · SEC Form 4 filings · Last 48 hours</text>
  <text x="1140" y="585" font-family="system-ui,-apple-system,sans-serif" font-size="16" font-weight="700" fill="#7c5cfc" text-anchor="end">seli.app</text>
</svg>'''
    return svg


# ── Email via Resend ──────────────────────────────────────────────────────────

def send_card_email(signals_with_cards):
    """Email signal cards to Kevin via Resend."""
    import requests

    cards_html = ""
    for s, tweet, svg in signals_with_cards:
        # Convert SVG to a data URI for inline rendering
        import base64
        svg_b64 = base64.b64encode(svg.encode()).decode()

        cards_html += f'''
        <div style="margin-bottom:32px;background:#0d0d1a;border-radius:12px;padding:24px;border:1px solid #222240;">
          <div style="margin-bottom:16px;">
            <img src="data:image/svg+xml;base64,{svg_b64}" width="600" style="width:100%;max-width:600px;border-radius:8px;" alt="{s['ticker']} signal card"/>
          </div>
          <div style="background:#1a1a2e;border-radius:8px;padding:16px;margin-bottom:12px;">
            <div style="font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Copy-paste tweet text</div>
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
        Save/screenshot each card image → copy the tweet text → paste into Twitter/X
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
