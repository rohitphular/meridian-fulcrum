from __future__ import annotations

import requests

BASE_URL = "https://api.exchangerate.fun/latest"
TROY_OZ_TO_GRAM = 31.1035

TRACKED = {"BTC", "ETH", "SOL"}


def fetch_latest() -> dict[str, float]:
    """Fetch all rates with XAU as base. Returns {currency_code: units_per_gram_xau}.

    exchangerate.fun uses XAU = 1 troy ounce (ISO 4217). We divide by 31.1035
    to convert to per gram, which is our storage unit.
    """
    resp = requests.get(BASE_URL, params={"base": "XAU"}, timeout=30)
    resp.raise_for_status()
    rates = resp.json()["rates"]
    return {code: float(rate) / TROY_OZ_TO_GRAM for code, rate in rates.items() if code in TRACKED}
