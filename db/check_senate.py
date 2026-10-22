#!/usr/bin/env python3
"""
db/check_senate.py
Is the Senate disclosure site down, or is it turning *us* away?
Run it from your laptop, and compare with the GitHub Actions log.

    python check_senate.py

Read-only: it only loads the site's home page and the agreement step.
"""
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from fetch_political_trades import SENATE_BASE, BROWSER_HEADERS  # same headers the import uses

def show(label, r):
    body = " ".join(r.text.split())[:160]
    print(f"{label}: HTTP {r.status_code}  server={r.headers.get('Server')}  "
          f"retry-after={r.headers.get('Retry-After')}")
    print(f"   {body}")

try:
    ip = requests.get("https://api.ipify.org", timeout=10).text
    print(f"Your public IP: {ip}")
except Exception:
    pass

for label, headers in [("Plain Python request", {}), ("Browser-like request", BROWSER_HEADERS)]:
    try:
        show(label, requests.get(f"{SENATE_BASE}/search/home/", headers=headers, timeout=20))
    except Exception as e:
        print(f"{label}: no response ({e})")

print("""
How to read this:
  * 200 on the browser-like line: the site is up for you. If GitHub Actions
    still gets 503/403, the site is turning away cloud servers, so run the
    Senate import from this computer instead (see below).
  * 503 everywhere, including in your own browser at
    https://efdsearch.senate.gov/search/home/ : the site itself is down. Nothing
    to fix on your end.
  * 403 with "Access Denied" and a "Reference #": Akamai is blocking this
    network. Try another network, or your browser, to confirm.

Run the Senate import from this computer:
    python fetch_political_trades.py --senate --days 365
""")
