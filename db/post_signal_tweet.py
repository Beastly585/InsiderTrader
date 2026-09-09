"""
Generate ready-to-post signal cards for Twitter/X.

Runs after ingest. Finds the day's strongest insider trading signals —
both cluster signals (2+ insiders on the same stock) and individual
big trades on high-interest tickers — generates copy-pasteable tweet
text + a branded dark-theme signal card (HTML rendered inline), and
emails both to you via Resend.

Workflow: open email → screenshot the card → copy the tweet text →
paste into Twitter. Zero API cost, full editorial control.

Required env vars:
  DATABASE_URL          — Neon connection string
  RESEND_API_KEY        — Resend API key (already set for alerts)
  ALERTS_FROM_EMAIL     — sender address (already set)
  NOTIFY_EMAIL          — where to send the cards (your email)
  APP_URL               — e.g. https://seli.app

Optional:
  MAX_CARDS             — max signals per email (default: 3)
  DRY_RUN               — "1" to print without emailing
  TEST_PREVIEW          — "1" to show candidates in the log
"""

import os, sys, re, json, logging
from datetime import date, timedelta
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

log = logging.getLogger("tweet")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s",
                    datefmt="%H:%M:%S")

DATABASE_URL       = os.environ.get("DATABASE_URL", "")
RESEND_API_KEY     = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL         = os.environ.get("ALERTS_FROM_EMAIL", "")
NOTIFY_EMAIL       = os.environ.get("NOTIFY_EMAIL", "")
APP_URL            = os.environ.get("APP_URL", "https://seli.app")
MAX_CARDS          = int(os.environ.get("MAX_CARDS", "3"))
DRY_RUN            = os.environ.get("DRY_RUN", "0") == "1"
TEST_PREVIEW       = os.environ.get("TEST_PREVIEW", "0") == "1"

# Logo hosted on your domain — used in the screenshot card header/footer
# instead of a text link (the card gets screenshotted so links are useless).
LOGO_URL = os.environ.get("LOGO_URL", "https://seli.app/favicon.png")

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
            card_type TEXT DEFAULT 'cluster',
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
    """Cluster signals — 2+ insiders trading the same stock in the last 48h."""
    cur = conn.cursor()
    cutoff = (date.today() - timedelta(days=2)).isoformat()
    high_tickers = ",".join(f"'{t}'" for t in HIGH_INTEREST_TICKERS)

    cur.execute(f"""
        WITH recent AS (
            SELECT ticker, company_name, transaction_type, value,
                   insider_name, insider_title, relationship, is_open_market,
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
    return [dict(zip(cols, r), card_type='cluster') for r in rows]


def get_individual_trades(conn, limit=5):
    """Individual big trades on high-interest tickers by C-suite execs.
    Single-insider trades noteworthy on their own because the ticker is
    widely followed and the insider is senior enough."""
    cur = conn.cursor()
    cutoff = (date.today() - timedelta(days=2)).isoformat()
    high_tickers = ",".join(f"'{t}'" for t in HIGH_INTEREST_TICKERS)

    cur.execute(f"""
        SELECT
            f.ticker,
            f.company_name AS company,
            f.insider_name,
            f.insider_title AS title,
            f.transaction_type,
            COALESCE(f.value, 0) AS value,
            f.shares,
            f.price_per_share AS price,
            f.relationship,
            COALESCE(f.transaction_date, f.filing_date) AS trade_date
        FROM public.filings f
        WHERE COALESCE(f.transaction_date, f.filing_date) >= %s
          AND f.is_open_market = true
          AND f.ticker IN ({high_tickers})
          AND f.relationship = 'strong'
          AND COALESCE(f.value, 0) >= 100000
          AND f.ticker NOT IN (
              SELECT ticker FROM public.tweet_log WHERE tweeted_date = CURRENT_DATE
          )
        ORDER BY f.value DESC
        LIMIT %s
    """, (cutoff, limit))

    rows = cur.fetchall()
    cols = ['ticker', 'company', 'insider_name', 'title',
            'transaction_type', 'value', 'shares', 'price',
            'relationship', 'trade_date']
    results = []
    for r in rows:
        d = dict(zip(cols, r))
        d['card_type'] = 'individual'
        d['insider_count'] = 1
        d['trade_count'] = 1
        d['exec_count'] = 1
        d['has_buys'] = d['transaction_type'] == 'buy'
        d['buy_value'] = d['value'] if d['has_buys'] else 0
        d['sell_value'] = d['value'] if not d['has_buys'] else 0
        d['net_value'] = d['value'] if d['has_buys'] else -d['value']
        d['attention_score'] = (
            30 +  # high-interest ticker
            15 +  # C-suite
            (20 if d['has_buys'] else 0) +
            min(d['value'] / 100000, 50)
        )
        results.append(d)
    return results


def log_card(conn, ticker, tweet_text, card_type='cluster'):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO public.tweet_log (ticker, tweet_text, card_type) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
        (ticker, tweet_text, card_type)
    )
    conn.commit()


# ── Formatting ────────────────────────────────────────────────────────────────

def fmt_money(v):
    v = abs(v)
    if v >= 1_000_000_000: return f"${v/1_000_000_000:.1f}B"
    if v >= 1_000_000: return f"${v/1_000_000:.1f}M"
    if v >= 1_000:     return f"${v/1_000:.0f}K"
    return f"${v:.0f}"


def short_title(title):
    """Abbreviate SEC insider titles for tweet readability."""
    if not title: return ''
    t = title
    for full, abbr in [
        ('Chief Executive Officer', 'CEO'), ('Chief Financial Officer', 'CFO'),
        ('Chief Operating Officer', 'COO'), ('Chief Technology Officer', 'CTO'),
        ('President and CEO', 'President & CEO'), ('Executive Vice President', 'EVP'),
        ('Senior Vice President', 'SVP'), ('Vice President', 'VP'),
        ('General Counsel', 'GC'),
    ]:
        t = re.sub(re.escape(full), abbr, t, flags=re.I)
    return t.strip()[:40]


def format_tweet(s):
    """Tweet text for a cluster signal (2+ insiders)."""
    ticker = s['ticker']
    company = s['company'] or ticker
    insiders = s['insider_count']
    trades = s['trade_count']
    net = s['net_value']
    execs = s['exec_count']

    direction = "buying" if net > 0 else "selling"
    value_str = fmt_money(net) if net > 0 else fmt_money(abs(net))

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


def format_individual_tweet(s):
    """Tweet text for a single insider trade on a buzz ticker."""
    ticker = s['ticker']
    company = s['company'] or ticker
    name = s.get('insider_name', '')
    title = short_title(s.get('title', ''))
    direction = "bought" if s['has_buys'] else "sold"
    value_str = fmt_money(s['value'])

    if name and title:
        headline = f"${ticker} — {name} ({title}) just {direction} {value_str}"
    elif name:
        headline = f"${ticker} — {name} just {direction} {value_str}"
    else:
        headline = f"${ticker} — C-suite insider just {direction} {value_str}"

    lines = [headline]

    if company and company != ticker and len(company) < 35:
        lines.append(company)

    lines.append("")
    lines.append(APP_URL)
    tweet = "\n".join(lines)

    if len(tweet) > 280:
        lines = [l for l in lines if l != company]
        tweet = "\n".join(lines)

    return tweet[:280]


# ── Signal cards (HTML for email → screenshot) ────────────────────────────────
# Logo in header/footer instead of text links — the card gets screenshotted
# so clickable links are useless. The logo is the branding.

LOGO_IMG = f'<img src="{LOGO_URL}" alt="Seli" width="20" height="20" style="display:inline-block;vertical-align:middle;border-radius:4px;"/>'
LOGO_WITH_NAME = f'{LOGO_IMG} <span style="font-size:13px;font-weight:700;color:#8888a0;vertical-align:middle;margin-left:4px;">Seli</span>'


def generate_cluster_card(s):
    """Card for cluster signals — multiple insiders on the same stock."""
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
  <tr><td style="height:3px;background:linear-gradient(90deg,#7c5cfc,#4dd4e6);font-size:1px;">&nbsp;</td></tr>
  <tr><td style="padding:16px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>{LOGO_WITH_NAME}</td>
      <td style="text-align:right;font-size:12px;color:#555;font-family:system-ui,-apple-system,sans-serif;">{today_str}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:14px 20px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:36px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;letter-spacing:-1px;padding-right:14px;">${ticker}</td>
      <td style="vertical-align:middle;">
        <span style="display:inline-block;background:{dir_bg};color:{dir_color};font-size:12px;font-weight:700;padding:4px 10px;border-radius:12px;">{direction}</span>
      </td>
    </tr></table>
    <div style="font-size:13px;color:#8888a0;margin-top:4px;font-family:system-ui,-apple-system,sans-serif;">{company}</div>
  </td></tr>
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
  <tr><td style="padding:12px 20px 0;">
    <div style="font-size:13px;color:#8888a0;font-family:system-ui,-apple-system,sans-serif;">
      Buys: <span style="color:#4ade80;font-weight:600;">{buy_val}</span> &nbsp;·&nbsp; Sells: <span style="color:#ef4444;font-weight:600;">{sell_val}</span>
    </div>
  </td></tr>
  <tr><td style="padding:14px 20px 0;">
    <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:6px;">Signal Strength</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:400px;"><tr>
      <td style="width:{bar_pct}%;height:8px;background:{bar_color};border-radius:4px 0 0 4px;font-size:1px;">&nbsp;</td>
      <td style="width:{100-bar_pct}%;height:8px;background:#1a1a2e;border-radius:0 4px 4px 0;font-size:1px;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:14px 20px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #222240;padding-top:12px;"><tr>
      <td style="font-size:11px;color:#555;font-family:system-ui,-apple-system,sans-serif;">Open-market trades &middot; SEC Form 4 &middot; Last 48h</td>
      <td style="text-align:right;">{LOGO_IMG}</td>
    </tr></table>
  </td></tr>
</table>'''


def generate_individual_card(s):
    """Card for a single high-profile insider trade on a buzz ticker."""
    ticker = s['ticker']
    company = (s['company'] or '')[:40]
    name = s.get('insider_name', 'C-Suite Executive')
    title = short_title(s.get('title', ''))
    value = s['value']
    shares = s.get('shares')
    price = s.get('price')

    direction = "Bought" if s['has_buys'] else "Sold"
    value_str = fmt_money(value)
    val_color = "#4ade80" if s['has_buys'] else "#ef4444"
    dir_bg = "rgba(74,222,128,0.15)" if s['has_buys'] else "rgba(239,68,68,0.15)"
    dir_color = "#4ade80" if s['has_buys'] else "#ef4444"

    today_str = date.today().strftime("%b %d, %Y")

    shares_str = f"{shares:,.0f}" if shares else "\u2014"
    price_str = f"${price:,.2f}" if price else "\u2014"

    return f'''<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;border-radius:12px;overflow:hidden;border:1px solid #222240;">
  <tr><td style="height:3px;background:linear-gradient(90deg,#7c5cfc,#4dd4e6);font-size:1px;">&nbsp;</td></tr>
  <tr><td style="padding:16px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>{LOGO_WITH_NAME}</td>
      <td style="text-align:right;font-size:12px;color:#555;font-family:system-ui,-apple-system,sans-serif;">{today_str}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:14px 20px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:36px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;letter-spacing:-1px;padding-right:14px;">${ticker}</td>
      <td style="vertical-align:middle;">
        <span style="display:inline-block;background:{dir_bg};color:{dir_color};font-size:12px;font-weight:700;padding:4px 10px;border-radius:12px;">{direction}</span>
      </td>
    </tr></table>
    <div style="font-size:13px;color:#8888a0;margin-top:4px;font-family:system-ui,-apple-system,sans-serif;">{company}</div>
  </td></tr>
  <tr><td style="padding:16px 20px 0;">
    <div style="font-size:18px;font-weight:700;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{name}</div>
    <div style="font-size:12px;color:#8888a0;margin-top:2px;font-family:system-ui,-apple-system,sans-serif;">{title}</div>
  </td></tr>
  <tr><td style="padding:16px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:33%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Value</div>
        <div style="font-size:24px;font-weight:800;color:{val_color};font-family:system-ui,-apple-system,sans-serif;">{value_str}</div>
      </td>
      <td style="width:33%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Shares</div>
        <div style="font-size:24px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{shares_str}</div>
      </td>
      <td style="width:33%;vertical-align:top;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;font-family:system-ui,-apple-system,sans-serif;margin-bottom:4px;">Price</div>
        <div style="font-size:24px;font-weight:800;color:#e8e8ec;font-family:system-ui,-apple-system,sans-serif;">{price_str}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:14px 20px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #222240;padding-top:12px;"><tr>
      <td style="font-size:11px;color:#555;font-family:system-ui,-apple-system,sans-serif;">Open-market trade &middot; SEC Form 4</td>
      <td style="text-align:right;">{LOGO_IMG}</td>
    </tr></table>
  </td></tr>
</table>'''


def generate_card(s):
    if s.get('card_type') == 'individual':
        return generate_individual_card(s)
    return generate_cluster_card(s)


def generate_tweet(s):
    if s.get('card_type') == 'individual':
        return format_individual_tweet(s)
    return format_tweet(s)


# ── Email ─────────────────────────────────────────────────────────────────────

def send_card_email(signals_with_cards):
    import requests

    cards_html = ""
    for s, tweet, card_html in signals_with_cards:
        type_label = "Individual trade" if s.get('card_type') == 'individual' else "Cluster signal"
        cards_html += f'''
        <div style="margin-bottom:28px;">
          <div style="margin-bottom:14px;">
            {card_html}
          </div>
          <div style="background:#1a1a2e;border-radius:8px;padding:14px 16px;margin-bottom:8px;">
            <div style="font-size:10px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Copy-paste tweet text</div>
            <pre style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#e8e8ec;white-space:pre-wrap;margin:0;line-height:1.5;">{tweet}</pre>
          </div>
          <div style="font-size:11px;color:#555;">
            {type_label} &middot; Score: {s['attention_score']:.0f} &middot; {"&#9733; " if s['ticker'] in HIGH_INTEREST_TICKERS else ""}{s['ticker']}
          </div>
        </div>
        '''

    html = f'''
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#0a0a14;color:#e8e8ec;">
      <div style="margin-bottom:24px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">Signal Cards Ready</div>
        <div style="font-size:13px;color:#888;">{date.today().strftime("%B %d, %Y")} &middot; {len(signals_with_cards)} signal{'s' if len(signals_with_cards) != 1 else ''} to post</div>
      </div>
      <div style="font-size:13px;color:#888;margin-bottom:20px;padding:12px;background:#1a1a2e;border-radius:8px;">
        Screenshot the card &rarr; copy the tweet text &rarr; paste into Twitter/X &rarr; post
      </div>
      {cards_html}
      <div style="text-align:center;padding:16px;font-size:12px;color:#444;">
        <a href="{APP_URL}" style="color:#7c5cfc;text-decoration:none;">seli.app</a>
      </div>
    </div>
    '''

    tickers_str = ', '.join('$'+s['ticker'] for s,_,_ in signals_with_cards)
    r = requests.post("https://api.resend.com/emails", json={
        "from": FROM_EMAIL,
        "to": [NOTIFY_EMAIL],
        "subject": f"Signal cards \u2014 {tickers_str} \u2014 {date.today().strftime('%b %d')}",
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
    log.info(f"Cards today: {already}/{MAX_CARDS} \u2014 {slots} slot{'s' if slots != 1 else ''} remaining")

    if slots <= 0 and not TEST_PREVIEW:
        log.info("Daily limit reached. Done.")
        conn.close()
        return

    # Gather both types of candidates
    cluster_candidates = get_top_signals(conn, limit=5)
    individual_candidates = get_individual_trades(conn, limit=5)

    # Merge, deduplicate by ticker (cluster wins if both exist), sort by score
    seen_tickers = set()
    all_candidates = []
    for s in cluster_candidates:
        if s['ticker'] not in seen_tickers:
            seen_tickers.add(s['ticker'])
            all_candidates.append(s)
    for s in individual_candidates:
        if s['ticker'] not in seen_tickers:
            seen_tickers.add(s['ticker'])
            all_candidates.append(s)

    all_candidates.sort(key=lambda s: s['attention_score'], reverse=True)

    if not all_candidates:
        log.info("No untweeted signals or individual trades in the last 48h. Done.")
        conn.close()
        return

    # Preview mode
    if TEST_PREVIEW:
        log.info(f"\n{'='*60}")
        log.info(f"  TOP {len(all_candidates)} CANDIDATES")
        log.info(f"{'='*60}")
        for i, s in enumerate(all_candidates, 1):
            tweet = generate_tweet(s)
            known = "\u2605" if s['ticker'] in HIGH_INTEREST_TICKERS else " "
            ctype = s.get('card_type', 'cluster')
            log.info(f"\n  #{i} {known} ${s['ticker']}  type={ctype}  score={s['attention_score']:.0f}  "
                     f"insiders={s['insider_count']}  execs={s['exec_count']}  "
                     f"net={fmt_money(s['net_value'])}  buys={'yes' if s['has_buys'] else 'no'}")
            if ctype == 'individual':
                log.info(f"     {s.get('insider_name','?')} \u2014 {short_title(s.get('title',''))}")
            for line in tweet.split('\n'):
                log.info(f"  \u2502 {line}")
            log.info(f"  ({len(tweet)} chars)")
        conn.close()
        return

    # Generate cards
    to_send = []
    for s in all_candidates[:slots]:
        tweet = generate_tweet(s)
        card_html = generate_card(s)
        to_send.append((s, tweet, card_html))
        ctype = s.get('card_type', 'cluster')
        log.info(f"  Card [{ctype}]: ${s['ticker']} \u2014 score {s['attention_score']:.0f}")

    if DRY_RUN:
        log.info(f"\n  DRY RUN \u2014 {len(to_send)} cards generated, not emailing")
        for s, tweet, card_html in to_send:
            log.info(f"\n  Tweet text:\n{tweet}\n")
            log.info(f"  Card HTML: {len(card_html)} bytes")
    else:
        log.info(f"\n  Sending {len(to_send)} cards via email\u2026")
        if send_card_email(to_send):
            for s, tweet, _ in to_send:
                log_card(conn, s['ticker'], tweet, s.get('card_type', 'cluster'))
            log.info(f"  Logged {len(to_send)} cards to tweet_log")
        else:
            log.error("  Email failed \u2014 will retry on next run")

    conn.close()
    log.info("Done.")


if __name__ == "__main__":
    run()
