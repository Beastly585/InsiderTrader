"""
db/email_kit.py
Shared plumbing for every Seli email: brand tokens, HTML building blocks,
formatting, tracked links, one-click unsubscribe, and the Resend send call.

send_digests.py and send_welcome.py both import from here so the two emails
look like one product and there's exactly one place that talks to Resend.
(send_instant_alerts.py can move onto this later; it isn't touched here.)

Env:
  RESEND_API_KEY      required unless DRY_RUN=true
  ALERTS_FROM_EMAIL   sender address on the verified Resend domain
  APP_URL             https://seli.app
  NEON_PROXY_URL      Worker base URL, used for the unsubscribe endpoint
  EMAIL_LINK_SECRET   same value as the Worker secret of the same name
  MAILING_ADDRESS     physical address for the footer (CAN-SPAM wants one on
                      anything with a promo in it). Optional but set it.
  DRY_RUN             true = log instead of send
  PREVIEW_DIR         if set, every email is also written there as .html
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html as _html
import logging
import os
import re
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:  # dotenv is optional; GitHub Actions passes env directly
    pass

log = logging.getLogger("seli.email")

RESEND_API_KEY    = os.environ.get("RESEND_API_KEY", "")
FROM_EMAIL        = os.environ.get("ALERTS_FROM_EMAIL", "alerts@mail.seli.app")
APP_URL           = os.environ.get("APP_URL", "https://seli.app").rstrip("/")
WORKER_URL        = (os.environ.get("NEON_PROXY_URL") or os.environ.get("WORKER_URL")
                     or "https://neon-proxy.beastly-insider-trades.workers.dev").rstrip("/")
EMAIL_LINK_SECRET = os.environ.get("EMAIL_LINK_SECRET", "")
MAILING_ADDRESS   = os.environ.get("MAILING_ADDRESS", "")
DRY_RUN           = os.environ.get("DRY_RUN", "false").lower() == "true"
PREVIEW_DIR       = os.environ.get("PREVIEW_DIR", "")

# ── Brand: light theme, same values as send_digests/send_instant_alerts ─────
ACCENT      = "#5A4FE8"
ACCENT_STR  = "#4338C9"
AQUA        = "#3FBFA0"
GREEN       = "#15803D"
GREEN_BG    = "#ECFDF3"
RED         = "#C0392B"
RED_BG      = "#FEF2F2"
TEXT        = "#111827"
TEXT_2      = "#374151"
MUTED       = "#6B7280"
FAINT       = "#9CA3AF"
BORDER      = "#E5E7EB"
BG          = "#FFFFFF"
PAGE_BG     = "#F3F4F6"
TINT        = "#F8F7FF"
SOFT        = "#F9FAFB"

FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"


# ── Formatting ───────────────────────────────────────────────────────────────
def esc(s) -> str:
    """HTML-escape. Company and insider names contain & and ' all the time
    (AT&T, O'Reilly); the old templates dropped them in raw."""
    return _html.escape("" if s is None else str(s), quote=True)


def money(v) -> str:
    if v is None:
        return "n/a"
    v = float(v)
    sign = "-" if v < 0 else ""
    v = abs(v)
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if v >= div * 0.9995:
            n = v / div
            s = f"{n:,.0f}" if n >= 99.95 else f"{n:,.1f}".rstrip("0").rstrip(".")
            return f"{sign}${s}{suf}"
    return f"{sign}${v:,.0f}"


def as_date(d) -> date | None:
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    try:
        return date.fromisoformat(str(d)[:10])
    except ValueError:
        return None


def short_date(d) -> str:
    d = as_date(d)
    return f"{d:%b} {d.day}" if d else ""


def long_date(d) -> str:
    d = as_date(d)
    return f"{d:%b} {d.day}, {d.year}" if d else ""


def ago(d, today: date | None = None) -> str:
    """'3 days ago', '5 weeks ago', '14 months ago', '3 years ago'."""
    d = as_date(d)
    if not d:
        return ""
    today = today or date.today()
    days = (today - d).days
    if days <= 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 14:
        return f"{days} days ago"
    if days < 60:
        return f"{days // 7} weeks ago"
    months = round(days / 30.44)
    if months < 24:
        return f"{months} months ago"
    return f"{days // 365} years ago"


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


_ENTITY_RE = re.compile(r"\b(INC|LLC|L\.?P\.?|LTD|CORP|CO|FUND|TRUST|CAPITAL|PARTNERS|HOLDINGS|MANAGEMENT|"
                        r"ADVISORS|ADVISERS|GROUP|INVESTMENTS?|VENTURES|FOUNDATION|BANK|PLC|SA|AG|NV|GP|MASTER)\b", re.I)
_SUFFIXES = {"JR", "SR", "II", "III", "IV", "MD", "PHD"}
_SMALL = {"of", "and", "the", "for", "&"}
_KEEP_UPPER = {"LLC", "LP", "GP", "PLC", "USA", "US", "NV", "SA", "AG", "REIT", "ETF", "II", "III", "IV", "AT&T"}


def _titlecase_word(w: str) -> str:
    if w.upper() in _KEEP_UPPER:
        return w.upper()
    if "&" in w and len(w) <= 5:
        return w.upper()
    if "-" in w:
        return "-".join(_titlecase_word(p) for p in w.split("-"))
    if w.startswith("MC") and len(w) > 3:
        return "Mc" + w[2:].capitalize()
    if "'" in w:
        return "'".join(p.capitalize() for p in w.split("'"))
    return w.capitalize()


def pretty_company(name) -> str:
    """EDGAR issuer names are ALL CAPS ('NVIDIA CORP'). Title-case them, but
    leave 2-3 letter tokens alone (IBM, AMD, 3M, AT&T) and anything that's
    already mixed case."""
    if not name:
        return ""
    s = str(name).strip()
    if s != s.upper():
        return s
    out = []
    for i, w in enumerate(s.split()):
        if i and w.lower() in _SMALL:
            out.append(w.lower())
        elif len(w.strip(".,")) <= 3 and w.upper() not in {"INC", "CO", "LTD", "THE", "NEW", "ONE", "CORP"}:
            out.append(w)
        else:
            out.append(_titlecase_word(w))
    return " ".join(out).replace(" Inc.", " Inc").replace(" Co.", " Co")


def pretty_person(name, is_congress: bool = False) -> str:
    """EDGAR reporting-owner names come as 'LAST FIRST MIDDLE' in caps
    ('HUANG JEN HSUN'). Flip to 'Jen Hsun Huang'. Entities (funds, trusts,
    LLCs) and congressional names (already 'First Last') are only
    re-cased, never reordered."""
    if not name:
        return ""
    s = " ".join(str(name).replace(",", " ").split())
    if s != s.upper():
        return s
    words = s.split()
    if is_congress or _ENTITY_RE.search(s) or not (2 <= len(words) <= 5):
        return " ".join(_titlecase_word(w) for w in words)
    suffix = [w for w in words if w.strip(".") in _SUFFIXES]
    core = [w for w in words if w.strip(".") not in _SUFFIXES]
    if len(core) >= 2:
        core = core[1:] + core[:1]
    return " ".join(_titlecase_word(w) for w in core + suffix)


_ROLE_PATTERNS = [
    (re.compile(r"\bceo\b|chief executive", re.I), "CEO"),
    (re.compile(r"\bcfo\b|chief financial", re.I), "CFO"),
    (re.compile(r"\bcoo\b|chief operating", re.I), "COO"),
    (re.compile(r"\bcto\b|chief tech", re.I), "CTO"),
    (re.compile(r"chief\s+\w+\s+officer|\bc[a-z]o\b", re.I), "C-suite exec"),
    (re.compile(r"\bpresident\b", re.I), "President"),
    (re.compile(r"chair", re.I), "Chair"),
    (re.compile(r"\bevp\b|\bsvp\b|vice pres|\bvp\b", re.I), "VP"),
    (re.compile(r"general counsel", re.I), "General Counsel"),
    (re.compile(r"10%|ten percent", re.I), "10% owner"),
    (re.compile(r"director", re.I), "Director"),
]


def short_role(title, relationship=None) -> str:
    if relationship == "congress":
        return "Congress"
    t = title or ""
    for rx, label in _ROLE_PATTERNS:
        if rx.search(t):
            return label
    return "Officer" if relationship in ("strong", "medium") else "Insider"


# ── Links ────────────────────────────────────────────────────────────────────
def track(path: str, medium: str, content: str = "", campaign: str = "") -> str:
    """App link with UTM params. PostHog picks utm_* up automatically on the
    landing pageview, so 'did the digest bring anyone back' is a filter on
    utm_medium, no extra instrumentation needed."""
    if path.startswith("http"):
        base = path
    else:
        base = APP_URL + (path if path.startswith("/") else "/" + path)
    q = {"utm_source": "email", "utm_medium": medium}
    if campaign:
        q["utm_campaign"] = campaign
    if content:
        q["utm_content"] = content
    return base + ("&" if "?" in base else "?") + urlencode(q)


def ticker_path(ticker: str) -> str:
    return f"/ticker/{quote(str(ticker).upper())}"


def insider_path(raw_name: str) -> str:
    # Must be the RAW insider_name: the app matches on the stored value.
    return f"/insider/{quote(str(raw_name))}"


def link_sig(kind: str, clerk_user_id: str) -> str:
    mac = hmac.new(EMAIL_LINK_SECRET.encode(), f"{kind}:{clerk_user_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def unsubscribe_url(clerk_user_id: str, kind: str = "digest") -> str:
    if not EMAIL_LINK_SECRET:
        return APP_URL + "/settings?section=notifications"
    return f"{WORKER_URL}/email/unsubscribe?" + urlencode(
        {"u": clerk_user_id, "k": kind, "t": link_sig(kind, clerk_user_id)})


# ── HTML building blocks (table layout, inline styles: Gmail/Outlook safe) ──
def p(text_html: str, size: int = 15, color: str = TEXT_2, margin: str = "0 0 14px", weight: int = 400) -> str:
    return (f'<p style="margin:{margin};font-family:{FONT};font-size:{size}px;line-height:1.6;'
            f'color:{color};font-weight:{weight};">{text_html}</p>')


def a(href: str, label_html: str, color: str = ACCENT, weight: int = 600) -> str:
    return f'<a href="{esc(href)}" style="color:{color};font-weight:{weight};text-decoration:none;">{label_html}</a>'


def ticker_tag(ticker: str, href: str) -> str:
    return (f'<a href="{esc(href)}" style="font-family:{MONO};font-weight:700;font-size:13px;color:{ACCENT};'
            f'text-decoration:none;background:{TINT};padding:3px 7px;border-radius:5px;">{esc(ticker)}</a>')


def chip(text: str, tone: str = "neutral") -> str:
    fg, bg = {"buy": (GREEN, GREEN_BG), "sell": (RED, RED_BG), "accent": (ACCENT_STR, TINT)}.get(tone, (TEXT_2, SOFT))
    return (f'<span style="display:inline-block;font-family:{FONT};font-size:11px;font-weight:600;color:{fg};'
            f'background:{bg};padding:3px 8px;border-radius:5px;margin:0 4px 4px 0;line-height:1.4;">{esc(text)}</span>')


def button(label: str, href: str, secondary: bool = False) -> str:
    bg, fg, border = (BG, ACCENT_STR, f"1px solid {BORDER}") if secondary else (ACCENT, "#ffffff", "0")
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 0;"><tr><td style="border-radius:8px;background:{bg};">'
            f'<a href="{esc(href)}" style="display:inline-block;font-family:{FONT};font-size:14px;font-weight:700;color:{fg};'
            f'text-decoration:none;padding:12px 22px;border-radius:8px;border:{border};">{esc(label)}</a></td></tr></table>')


def section(title: str, inner_html: str, kicker: str = "", pad_top: int = 28) -> str:
    k = (f'<div style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;'
         f'color:{ACCENT};margin:0 0 6px;">{esc(kicker)}</div>') if kicker else ""
    return (f'<tr><td style="padding:{pad_top}px 28px 0;">{k}'
            f'<div style="font-family:{FONT};font-size:18px;font-weight:800;color:{TEXT};letter-spacing:-.3px;margin:0 0 12px;">{title}</div>'
            f'{inner_html}</td></tr>')


def card(inner_html: str, accent_left: str = "", bg: str = BG) -> str:
    left = f"border-left:4px solid {accent_left};" if accent_left else ""
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid {BORDER};'
            f'border-radius:10px;{left}background:{bg};margin:0 0 10px;"><tr><td style="padding:16px 18px;">{inner_html}</td></tr></table>')


def divider(margin: str = "22px 0 0") -> str:
    return f'<div style="height:1px;background:{BORDER};margin:{margin};line-height:1px;font-size:1px;">&nbsp;</div>'


def shell(*, title: str, preheader: str, label: str, body_rows: str, footer_html: str) -> str:
    pad = "&nbsp;&zwnj;" * 90
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>{esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  @media (max-width:520px){{ .px{{padding-left:18px!important;padding-right:18px!important}} .stack{{display:block!important;width:100%!important;text-align:left!important}} }}
  a{{color:{ACCENT}}}
</style>
</head>
<body style="margin:0;padding:0;background:{PAGE_BG};-webkit-text-size-adjust:100%;">
<!--[if mso]><style>table,td,div,p,a,span{{font-family:Arial,sans-serif!important}}</style><![endif]-->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{esc(preheader)}{pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAGE_BG};">
<tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:{BG};border-radius:14px;overflow:hidden;">
  <tr><td style="height:4px;line-height:4px;font-size:4px;background:{ACCENT};background-image:linear-gradient(90deg,{ACCENT} 0%,{ACCENT_STR} 60%,{AQUA} 100%);">&nbsp;</td></tr>
  <tr><td class="px" style="padding:20px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><a href="{esc(APP_URL)}" style="font-family:{FONT};font-size:20px;font-weight:800;color:{TEXT};text-decoration:none;letter-spacing:-.4px;">Seli</a></td>
      <td style="text-align:right;font-family:{FONT};font-size:12px;font-weight:600;color:{MUTED};">{esc(label)}</td>
    </tr></table>
  </td></tr>
{body_rows}
  <tr><td class="px" style="padding:30px 28px 26px;">{footer_html}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


DISCLAIMER = ("Seli summarizes public SEC Form 4 and STOCK Act disclosures for informational purposes only. "
              "Nothing in this email is investment advice or a recommendation to buy, sell or hold any security. "
              "Past insider activity does not predict future stock performance.")


def footer(*, reason: str, clerk_user_id: str, manage: bool = True) -> str:
    unsub = unsubscribe_url(clerk_user_id)
    links = [a(unsub, "Unsubscribe", MUTED, 500)]
    if manage:
        links.append(a(track("/settings?section=notifications", "footer"), "Email settings", MUTED, 500))
    addr = p(esc(MAILING_ADDRESS), 11, FAINT, "6px 0 0") if MAILING_ADDRESS else ""
    return (divider("0 0 16px")
            + p(esc(reason) + " " + DISCLAIMER, 11, FAINT, "0 0 8px")
            + p(" &nbsp;·&nbsp; ".join(links), 11, FAINT, "0")
            + addr)


# ── HTML to plain text (multipart/alternative helps deliverability) ─────────
def html_to_text(html_doc: str) -> str:
    s = re.sub(r"(?is)<(head|style|script)\b.*?</\1>", "", html_doc)
    s = re.sub(r'(?is)<div style="display:none.*?</div>', "", s)  # preheader
    s = re.sub(r'(?is)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>',
               lambda m: f"{re.sub('<[^>]+>', '', m.group(2)).strip()} ({_html.unescape(m.group(1))})", s)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|tr|h\d|li|table)>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = _html.unescape(s).replace("‌", "").replace("\xa0", " ")
    lines = [" ".join(line.split()) for line in s.splitlines()]
    out, blank = [], 0
    for line in lines:
        if line:
            out.append(line); blank = 0
        elif blank == 0 and out:
            out.append(""); blank = 1
    return "\n".join(out).strip() + "\n"


# ── Send ─────────────────────────────────────────────────────────────────────
def _preview_write(kind: str, to_email: str, subject: str, html_doc: str) -> None:
    if not PREVIEW_DIR:
        return
    d = Path(PREVIEW_DIR); d.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{kind}-{to_email}".lower()).strip("-")
    (d / f"{slug}.html").write_text(html_doc, encoding="utf-8")
    (d / f"{slug}.subject.txt").write_text(subject + "\n", encoding="utf-8")


def send(*, to_email: str, subject: str, html_doc: str, from_name: str, clerk_user_id: str,
         kind: str, reply_to: str | None = None, from_email: str | None = None, max_retries: int = 3) -> bool:
    _preview_write(kind, to_email, subject, html_doc)
    if DRY_RUN:
        log.info(f"  [DRY RUN] {kind} -> {to_email}: {subject}")
        return True
    if not RESEND_API_KEY:
        log.error("RESEND_API_KEY missing"); return False
    unsub = unsubscribe_url(clerk_user_id)
    payload = {
        "from": f"{from_name} <{from_email or FROM_EMAIL}>",
        "to": [to_email],
        "subject": subject,
        "html": html_doc,
        "text": html_to_text(html_doc),
        "headers": {
            "List-Unsubscribe": f"<{unsub}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        "tags": [{"name": "kind", "value": kind}],
    }
    if reply_to:
        payload["reply_to"] = reply_to
    for attempt in range(max_retries):
        try:
            r = requests.post("https://api.resend.com/emails",
                              headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
                              json=payload, timeout=15)
            if r.ok:
                return True
            log.error(f"  Resend {r.status_code} for {to_email} (attempt {attempt + 1}): {r.text[:200]}")
            if not (r.status_code == 429 or r.status_code >= 500):
                return False
        except Exception as e:  # network blip
            log.error(f"  Send failed for {to_email} (attempt {attempt + 1}): {e}")
        if attempt < max_retries - 1:
            time.sleep(2 * (attempt + 1))
    return False


def get_connection(database_url: str | None = None):
    url = database_url or os.environ.get("DATABASE_URL", "")
    try:
        import psycopg
        return psycopg.connect(url)
    except ImportError:
        import psycopg2
        return psycopg2.connect(url)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
