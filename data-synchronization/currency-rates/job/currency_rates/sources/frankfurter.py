from __future__ import annotations

from datetime import date

import requests

BASE_URL = "https://api.frankfurter.app"
CURRENCIES = "EUR,GBP,JPY,CNY,INR,AUD,CAD,CHF,SGD,HKD,BRL,KRW"


def fetch_latest() -> dict[str, float]:
    """Fetch today's fiat rates vs USD. Returns {currency_code: rate_vs_usd}."""
    resp = requests.get(f"{BASE_URL}/latest", params={"from": "USD", "to": CURRENCIES}, timeout=10)
    resp.raise_for_status()
    return resp.json()["rates"]


def fetch_date(rate_date: date) -> dict[str, float]:
    """Fetch fiat rates vs USD for a specific date. Returns {currency_code: rate_vs_usd}."""
    resp = requests.get(f"{BASE_URL}/{rate_date.isoformat()}", params={"from": "USD", "to": CURRENCIES}, timeout=10)
    resp.raise_for_status()
    return resp.json()["rates"]
