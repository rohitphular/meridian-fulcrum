from __future__ import annotations

from datetime import date
from decimal import Decimal

from py_logging import get_logger

import sources.constants as constants
import sources.fiat as fiat

logger = get_logger(__name__)

_TICKERS = {"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD"}


def fetch_range(currency_codes: list[str], from_date: date, to_date: date) -> dict[str, dict[date, Decimal]]:
    """Return crypto units per gram XAU for dates with both gold and crypto closes.

    Gold is a futures proxy. Non-trading gold days are omitted, rather than
    attributing a stale gold close or a current crypto quote to another date.
    """
    if not currency_codes:
        return {}
    unsupported = set(currency_codes) - _TICKERS.keys()
    if unsupported:
        raise ValueError(f"Unsupported crypto currencies {sorted(unsupported)}; add their ticker mappings before tracking them")
    gold_prices = fiat.download_closes("GC=F", from_date, to_date)
    if not gold_prices:
        return {}
    currencies: dict[str, dict[date, Decimal]] = {}
    for code in dict.fromkeys(currency_codes):
        ticker = _TICKERS[code]
        crypto_prices = fiat.download_closes(ticker, from_date, to_date)
        rates = {rate_date: gold_prices[rate_date] / crypto_prices[rate_date] / constants.TROY_OZ_TO_GRAM for rate_date in gold_prices.keys() & crypto_prices.keys()}
        if rates:
            currencies[code] = rates
        else:
            logger.warning(f"fetch_range: currency={code} reason=no_matching_dates")
    logger.info(f"fetch_range: currencies={sorted(currencies)}")
    return currencies
