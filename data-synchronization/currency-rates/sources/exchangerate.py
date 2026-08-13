from __future__ import annotations

import math

import yfinance as yf

from py_logging import get_logger

import sources.constants as constants

logger = get_logger(__name__)

_TICKERS = {"BTC": "BTC-USD", "ETH": "ETH-USD", "SOL": "SOL-USD"}


def fetch_latest() -> dict[str, float]:
    """Fetch XAU-based rates for BTC/ETH/SOL via Yahoo Finance. Returns {code: grams_of_gold_per_unit}."""
    try:
        gold_df = yf.download("GC=F", period="5d", progress=False, auto_adjust=True)
    except Exception as e:
        logger.warning(f"fetch_latest: gold_download_failed error={e}")
        return {}

    if gold_df.empty:
        logger.warning("fetch_latest: gold_data_empty")
        return {}

    xau_usd = float(gold_df["Close"].squeeze().iloc[-1])
    if math.isnan(xau_usd):
        logger.warning("fetch_latest: gold_price_nan")
        return {}

    crypto_rates: dict[str, float] = {}
    for code, ticker in _TICKERS.items():
        try:
            df = yf.download(ticker, period="5d", progress=False, auto_adjust=True)
        except Exception as e:
            logger.warning(f"fetch_latest: currency={code} ticker={ticker} download_failed error={e}")
            continue
        if df.empty:
            logger.warning(f"fetch_latest: currency={code} ticker={ticker} no_data")
            continue
        crypto_usd = float(df["Close"].squeeze().iloc[-1])
        if math.isnan(crypto_usd) or crypto_usd == 0:
            logger.warning(f"fetch_latest: currency={code} invalid_price={crypto_usd}")
            continue
        crypto_rates[code] = (xau_usd / crypto_usd) / constants.TROY_OZ_TO_GRAM

    skipped = set(_TICKERS.keys()) - crypto_rates.keys()
    if skipped:
        logger.warning(f"fetch_latest: skipped currencies={sorted(skipped)}")
    logger.info(f"fetch_latest: currencies={sorted(crypto_rates.keys())}")
    return crypto_rates
