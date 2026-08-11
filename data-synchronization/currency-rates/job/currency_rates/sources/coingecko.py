from __future__ import annotations

from datetime import date, datetime, timezone

import requests

BASE_URL = "https://api.coingecko.com/api/v3"

COINS = {
    "bitcoin": "BTC",
    "ethereum": "ETH",
    "solana": "SOL",
}


def fetch_latest() -> dict[str, float]:
    """Fetch current crypto prices vs USD. Returns {currency_code: price_vs_usd}."""
    ids = ",".join(COINS.keys())
    resp = requests.get(f"{BASE_URL}/simple/price", params={"ids": ids, "vs_currencies": "usd"}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return {COINS[coin_id]: data[coin_id]["usd"] for coin_id in COINS if coin_id in data}


def fetch_range(from_date: date, to_date: date) -> dict[str, dict[date, float]]:
    """Fetch historical daily prices for all coins over a date range.

    Returns {currency_code: {rate_date: price_vs_usd}}.
    """
    from_ts = int(datetime(from_date.year, from_date.month, from_date.day, tzinfo=timezone.utc).timestamp())
    to_ts = int(datetime(to_date.year, to_date.month, to_date.day, 23, 59, 59, tzinfo=timezone.utc).timestamp())

    result: dict[str, dict[date, float]] = {}
    for coin_id, code in COINS.items():
        resp = requests.get(
            f"{BASE_URL}/coins/{coin_id}/market_chart/range",
            params={"vs_currency": "usd", "from": from_ts, "to": to_ts},
            timeout=30,
        )
        resp.raise_for_status()
        prices = resp.json().get("prices", [])
        result[code] = {
            datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date(): price
            for ts_ms, price in prices
        }
    return result
