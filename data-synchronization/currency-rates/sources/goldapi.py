from __future__ import annotations

import requests

BASE_URL = "https://www.goldapi.io/api"


def fetch_latest(api_key: str) -> float:
    """Fetch today's gold price per gram in USD. Returns gold_usd_per_gram."""
    resp = requests.get(
        f"{BASE_URL}/XAU/USD",
        headers={"x-access-token": api_key, "Content-Type": "application/json"},
        timeout=10,
    )
    resp.raise_for_status()
    return float(resp.json()["price_gram_24k"])
