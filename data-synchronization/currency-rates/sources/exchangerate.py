from __future__ import annotations

import requests

from py_logging import get_logger

import sources.constants as constants

logger = get_logger(__name__)

BASE_URL = "https://api.exchangerate.fun/latest"

TRACKED = {"BTC", "ETH", "SOL"}


def fetch_latest() -> dict[str, float]:
    """Fetch XAU-based rates for BTC/ETH/SOL. Returns empty dict on HTTP error."""
    try:
        resp = requests.get(BASE_URL, params={"base": "XAU"}, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning(f"fetch_latest: http_error={e}")
        return {}
    rates = resp.json()["rates"]
    crypto_rates = {
        code: float(rate) / constants.TROY_OZ_TO_GRAM
        for code, rate in rates.items()
        if code in TRACKED and isinstance(rate, (int, float))
    }
    skipped = TRACKED - crypto_rates.keys()
    if skipped:
        logger.warning(f"fetch_latest: skipped_reason=non_numeric currencies={sorted(skipped)}")
    logger.info(f"fetch_latest: currencies={sorted(crypto_rates.keys())}")
    return crypto_rates
