from __future__ import annotations

import csv
import io
import math
from datetime import date, timedelta

import yfinance as yf

from py_logging import get_logger

import sources.constants as constants

logger = get_logger(__name__)

# Used by historical.py to derive local CSV filenames.
SYMBOLS = {
    "USD": "xauusd",
    "EUR": "xaueur",
    "GBP": "xaugbp",
    "JPY": "xaujpy",
    "CNY": "xaucny",
    "INR": "xauinr",
    "AUD": "xauaud",
    "CAD": "xaucad",
    "CHF": "xauchf",
    "SGD": "xausgd",
    "AED": "xauaed",
    "HKD": "xauhkd",
    "BRL": "xaubrl",
    "KRW": "xaukrw",
}

# (ticker, multiply): if multiply=True, XAU/CCY = XAU/USD * rate (USD/CCY pair e.g. USDJPY).
# If multiply=False, XAU/CCY = XAU/USD / rate (CCY/USD pair e.g. EURUSD).
_FOREX: dict[str, tuple[str, bool]] = {
    "EUR": ("EURUSD=X", False),
    "GBP": ("GBPUSD=X", False),
    "JPY": ("USDJPY=X", True),
    "CNY": ("USDCNY=X", True),
    "INR": ("USDINR=X", True),
    "AUD": ("AUDUSD=X", False),
    "CAD": ("CADUSD=X", False),
    "CHF": ("CHFUSD=X", False),
    "SGD": ("SGDUSD=X", False),
    "AED": ("USDAED=X", True),
    "HKD": ("USDHKD=X", True),
    "BRL": ("USDBRL=X", True),
    "KRW": ("USDKRW=X", True),
}


def fetch_range(currency_code: str, from_date: date, to_date: date) -> dict[date, float]:
    """Fetch XAU/{currency} rates for a date range via Yahoo Finance. Returns {date: rate_per_gram_xau}."""
    start = from_date.isoformat()
    end = (to_date + timedelta(days=1)).isoformat()  # yfinance end is exclusive

    try:
        gold_df = yf.download("GC=F", start=start, end=end, progress=False, auto_adjust=True)
    except Exception as e:
        logger.warning(f"fetch_range: currency={currency_code} gold_download_failed error={e}")
        return {}

    if gold_df.empty:
        logger.warning(f"fetch_range: currency={currency_code} gold_data_empty")
        return {}

    # yfinance ≥0.2 returns MultiIndex columns for single-ticker downloads; squeeze collapses to Series.
    xau_usd = gold_df["Close"].squeeze()
    if xau_usd.ndim != 1:
        logger.warning(f"fetch_range: currency={currency_code} unexpected_gold_shape={gold_df['Close'].shape}")
        return {}

    if currency_code == "USD":
        per_gram = xau_usd / constants.TROY_OZ_TO_GRAM
        return {d.date(): float(v) for d, v in per_gram.items() if not math.isnan(float(v))}

    if currency_code not in _FOREX:
        logger.warning(f"fetch_range: currency={currency_code} no_forex_ticker")
        return {}

    ticker, multiply = _FOREX[currency_code]

    try:
        forex_df = yf.download(ticker, start=start, end=end, progress=False, auto_adjust=True)
    except Exception as e:
        logger.warning(f"fetch_range: currency={currency_code} forex_download_failed ticker={ticker} error={e}")
        return {}

    if forex_df.empty:
        logger.warning(f"fetch_range: currency={currency_code} forex_empty ticker={ticker}")
        return {}

    forex_rate = forex_df["Close"].squeeze()
    if forex_rate.ndim != 1:
        logger.warning(f"fetch_range: currency={currency_code} unexpected_forex_shape ticker={ticker} shape={forex_df['Close'].shape}")
        return {}

    common = xau_usd.index.intersection(forex_rate.index)
    xau_usd = xau_usd.loc[common]
    forex_rate = forex_rate.loc[common]

    xau_ccy = xau_usd * forex_rate if multiply else xau_usd / forex_rate
    per_gram = xau_ccy / constants.TROY_OZ_TO_GRAM

    return {d.date(): float(v) for d, v in per_gram.items() if not math.isnan(float(v))}


def load_file(file_path: str, currency_code: str) -> dict[date, float]:
    """Parse a local stooq CSV file. Returns {date: rate_per_gram_xau}."""
    with open(file_path) as f:
        return _parse_csv(f.read(), currency_code)


def _parse_csv(text: str, currency_code: str) -> dict[date, float]:
    rows: dict[date, float] = {}
    skipped = 0
    reader = csv.DictReader(io.StringIO(text.strip()))
    for row in reader:
        try:
            rows[date.fromisoformat(row["Date"])] = float(row["Close"]) / constants.TROY_OZ_TO_GRAM
        except (KeyError, ValueError):
            skipped += 1
    if skipped:
        logger.warning(f"_parse_csv: currency={currency_code} skipped_rows={skipped}")
    if not rows:
        snippet = text.strip()[:200].replace("\n", "\\n")
        logger.warning(f"_parse_csv: currency={currency_code} empty_or_invalid_response response_snippet={snippet!r}")
    return rows
