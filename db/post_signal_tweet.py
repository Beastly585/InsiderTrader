"""
Post the day's strongest insider trading signals to Twitter/X.

Runs as a GitHub Action step after ingest. Queries Neon for the
highest-conviction signals from today's filings, formats concise
tweets, and posts via Twitter API v2 with OAuth 1.0a.

Posts up to MAX_TWEETS per day (default 2). Prioritizes signals
that are most likely to attract attention: well-known tickers,
large dollar values, multiple C-suite executives acting together.

Idempotency: tracks posted tickers in a tweet_log table. Safe to
run multiple times per day — won't double-post.

Required env vars:
  DATABASE_URL          — Neon connection string
  TWITTER_API_KEY       — Twitter app Consumer Key
  TWITTER_API_SECRET    — Twitter app Consumer Secret
  TWITTER_ACCESS_TOKEN  — User access token
  TWITTER_ACCESS_SECRET — User access token secret
  APP_URL               — e.g. https://seli.app

Optional:
  MAX_TWEETS            — max posts per day (default: 2)
  DRY_RUN               — "1" to print without posting
  TEST_PREVIEW          — "1" to show top 5 candidates without posting
"""

import os, sys, json, logging, hmac, hashlib, time, base64, urllib.parse, secrets
from datetime import date, timedelta

log = logging.getLogger("tweet")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s",
                    datefmt="%H:%M:%S")

DATABASE_URL       = os.environ.get("DATABASE_URL", "")
API_KEY            = os.environ.get("TWITTER_API_KEY", "")
API_SECRET         = os.environ.get("TWITTER_API_SECRET", "")
ACCESS_TOKEN       = os.environ.get("TWITTER_ACCESS_TOKEN", "")
ACCESS_SECRET      = os.environ.get("TWITTER_ACCESS_SECRET", "")
APP_URL            = os.environ.get("APP_URL", "https://seli.app")
MAX_TWEETS         = int(os.environ.get("MAX_TWEETS", "2"))
DRY_RUN            = os.environ.get("DRY_RUN", "0") == "1"
TEST_PREVIEW       = os.environ.get("TEST_PREVIEW", "0") == "1"

# Well-known tickers that get engagement on Twitter. Signals on these
# get priority over obscure micro-caps. This isn't exhaustive — any
# ticker with a strong enough signal still posts, but these get a
# scoring boost so they bubble to the top when competing.
HIGH_INTEREST_TICKERS = {
    'AAPL','MSFT','GOOGL','GOOG','AMZN','NVDA','META','TSLA','AMD','INTC',
    'NFLX','DIS','BA','JPM','GS','BAC','WFC','V','MA','PYPL',
    'CRM','ORCL','ADBE','SNOW','PLTR','COIN','HOOD','SOFI','SQ','SHOP',
    'UBER','LYFT','ABNB','RBLX','RIVN','LCID','NIO','GME','AMC','BBBY',
    'MSTR','MARA','RIOT','DKNG','PENN','CRWD','PANW','ZS','NET','OKTA',
    'MDB','DDOG','U','SE','BABA','JD','PDD','TSM','SMCI','ARM',
    'LLY','PFE','MRNA','JNJ','ABBV','UNH','CVS','XOM','CVX','COP',
    'WMT','COST','TGT','HD','LOW','NKE','SBUX','MCD','CMG','LULU',
    'SPY','QQQ','IWM','DIA','ARKK',
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


def tweets_posted_today(conn):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM public.tweet_log WHERE tweeted_date = CURRENT_DATE")
    return cur.fetchone()[0]


def get_top_signals(conn, limit=5):
    """
    Find the strongest untweeted signals from the last 48 hours.

    Scoring prioritizes:
      1. Multiple C-suite executives (cluster buying/selling)
      2. Large dollar values
      3. Well-known tickers (higher Twitter engagement)
      4. Buy signals over sell (buys are rarer and more actionable)
    """
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
               -- Attention score: higher = more tweetworthy
               (
                 insider_count * 10 +
                 exec_count * 15 +
                 CASE WHEN ticker IN ({high_tickers}) THEN 30 ELSE 0 END +
                 CASE WHEN has_buys THEN 20 ELSE 0 END +
                 LEAST(ABS(net_value) / 100000, 50)
               ) AS attention_score
        FROM signals
        WHERE ticker NOT IN (
            SELECT ticker FROM public.tweet_log WHERE tweeted_date = CURRENT_DATE
        )
        ORDER BY
          -- Strong buy clusters from known names first
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


def log_tweet(conn, ticker, tweet_text):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO public.tweet_log (ticker, tweet_text) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (ticker, tweet_text)
    )
    conn.commit()


# ── Tweet formatting ──────────────────────────────────────────────────────────

def fmt_money(v):
    v = abs(v)
    if v >= 1_000_000_000: return f"${v/1_000_000_000:.1f}B"
    if v >= 1_000_000: return f"${v/1_000_000:.1f}M"
    if v >= 1_000:     return f"${v/1_000:.0f}K"
    return f"${v:.0f}"


def format_tweet(s):
    """Format a clean, data-forward tweet. No emojis, no hype."""
    ticker = s['ticker']
    company = s['company'] or ticker
    insiders = s['insider_count']
    trades = s['trade_count']
    net = s['net_value']
    execs = s['exec_count']
    has_buys = s['has_buys']

    # Direction
    if net > 0:
        direction = "buying"
        value_str = fmt_money(net)
    else:
        direction = "selling"
        value_str = fmt_money(abs(net))

    lines = []

    # Headline
    if execs >= 3:
        lines.append(f"${ticker} — {execs} C-suite executives {direction}")
    elif execs >= 2:
        lines.append(f"${ticker} — {insiders} insiders {direction}, {execs} C-suite")
    else:
        lines.append(f"${ticker} — {insiders} insiders {direction}")

    # Value + trade count
    lines.append(f"{value_str} across {trades} open-market trade{'s' if trades != 1 else ''}")

    # Company name if short enough
    if company and company != ticker and len(company) < 35:
        lines.append(company)

    # Link
    lines.append("")
    lines.append(APP_URL)

    tweet = "\n".join(lines)

    # Trim if over 280
    if len(tweet) > 280:
        lines = [l for l in lines if l != company]
        tweet = "\n".join(lines)

    return tweet[:280]


# ── Twitter API v2 ────────────────────────────────────────────────────────────

def oauth_sign(method, url, params, body_params=None):
    oauth_params = {
        'oauth_consumer_key': API_KEY,
        'oauth_nonce': secrets.token_hex(16),
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp': str(int(time.time())),
        'oauth_token': ACCESS_TOKEN,
        'oauth_version': '1.0',
    }

    all_params = {**oauth_params, **(params or {}), **(body_params or {})}
    sorted_params = '&'.join(f'{urllib.parse.quote(k,"~")}={urllib.parse.quote(str(v),"~")}'
                             for k, v in sorted(all_params.items()))

    base_string = f'{method}&{urllib.parse.quote(url,"~")}&{urllib.parse.quote(sorted_params,"~")}'
    signing_key = f'{urllib.parse.quote(API_SECRET,"~")}&{urllib.parse.quote(ACCESS_SECRET,"~")}'

    sig = base64.b64encode(
        hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()
    ).decode()

    oauth_params['oauth_signature'] = sig
    auth_header = 'OAuth ' + ', '.join(
        f'{urllib.parse.quote(k,"~")}="{urllib.parse.quote(v,"~")}"'
        for k, v in sorted(oauth_params.items())
    )
    return auth_header


def post_tweet(text):
    import requests

    url = 'https://api.twitter.com/2/tweets'
    body = json.dumps({'text': text})
    auth = oauth_sign('POST', url, {})

    r = requests.post(url, data=body, headers={
        'Authorization': auth,
        'Content-Type': 'application/json',
    }, timeout=15)

    if r.status_code in (200, 201):
        data = r.json()
        tweet_id = data.get('data', {}).get('id', 'unknown')
        log.info(f"  Posted: twitter.com/i/status/{tweet_id}")
        return True
    else:
        log.error(f"  Twitter API {r.status_code}: {r.text}")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    if not DATABASE_URL:
        log.error("DATABASE_URL not set"); sys.exit(1)
    if not DRY_RUN and not TEST_PREVIEW and not all([API_KEY, API_SECRET, ACCESS_TOKEN, ACCESS_SECRET]):
        log.error("Twitter credentials not set"); sys.exit(1)

    conn = get_connection()
    ensure_tweet_log(conn)

    already = tweets_posted_today(conn)
    slots = MAX_TWEETS - already
    log.info(f"Tweets today: {already}/{MAX_TWEETS} — {slots} slot{'s' if slots != 1 else ''} remaining")

    if slots <= 0 and not TEST_PREVIEW:
        log.info("Daily limit reached. Done.")
        conn.close()
        return

    candidates = get_top_signals(conn, limit=5)

    if not candidates:
        log.info("No untweeted signals with 2+ insiders in the last 48h. Done.")
        conn.close()
        return

    # Preview mode — show all candidates without posting
    if TEST_PREVIEW:
        log.info(f"\n{'='*60}")
        log.info(f"  TOP {len(candidates)} CANDIDATES (preview only)")
        log.info(f"{'='*60}")
        for i, s in enumerate(candidates, 1):
            tweet = format_tweet(s)
            known = "★" if s['ticker'] in HIGH_INTEREST_TICKERS else " "
            log.info(f"\n  #{i} {known} ${s['ticker']}  score={s['attention_score']:.0f}  "
                     f"insiders={s['insider_count']}  execs={s['exec_count']}  "
                     f"net={fmt_money(s['net_value'])}  buys={'yes' if s['has_buys'] else 'no'}")
            log.info(f"  ┌{'─'*56}┐")
            for line in tweet.split('\n'):
                log.info(f"  │ {line:<54} │")
            log.info(f"  └{'─'*56}┘")
            log.info(f"  ({len(tweet)} chars)")
        conn.close()
        return

    # Post up to `slots` tweets
    posted = 0
    for s in candidates:
        if posted >= slots:
            break

        tweet = format_tweet(s)
        log.info(f"\n  Signal: ${s['ticker']} — {s['insider_count']} insiders, "
                 f"net {fmt_money(s['net_value'])}, score {s['attention_score']:.0f}")
        log.info(f"  Tweet ({len(tweet)} chars):\n{tweet}\n")

        if DRY_RUN:
            log.info("  DRY RUN — not posting")
            posted += 1
        else:
            if post_tweet(tweet):
                log_tweet(conn, s['ticker'], tweet)
                posted += 1
                if posted < slots:
                    time.sleep(5)  # small gap between tweets
            else:
                log.error(f"  Failed to post ${s['ticker']} — continuing")

    log.info(f"\nPosted {posted} tweet{'s' if posted != 1 else ''}. Done.")
    conn.close()


if __name__ == "__main__":
    run()
