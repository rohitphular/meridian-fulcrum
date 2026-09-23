from __future__ import annotations

import csv
import io
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

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


def download_closes(ticker: str, from_date: date, to_date: date) -> dict[date, Decimal]:
    """Read finite positive daily closes, preserving the provider's session dates."""
    if from_date > to_date or to_date == date.max:
        raise ValueError("Use an ordered date range with to_date earlier than 9999-12-31")
    try:
        prices = yf.download(ticker, start=from_date.isoformat(), end=(to_date + timedelta(days=1)).isoformat(), progress=False, auto_adjust=False)
    except Exception as error:
        logger.warning(f"download_closes: ticker={ticker} reason=download_failed error={type(error).__name__}")
        return {}
    if prices.empty:
        logger.warning(f"download_closes: ticker={ticker} reason=no_data")
        return {}
    if "Close" not in prices:
        logger.warning(f"download_closes: ticker={ticker} reason=missing_close")
        return {}
    closes = prices["Close"]
    # Squeeze only the column axis: squeezing all axes loses one-row downloads.
    if closes.ndim == 2:
        if closes.shape[1] != 1:
            logger.warning(f"download_closes: ticker={ticker} reason=ambiguous_close_columns")
            return {}
        closes = closes.iloc[:, 0]
    rates: dict[date, Decimal] = {}
    for timestamp, value in closes.items():
        try:
            rate_date = date.fromisoformat(str(timestamp)[:10])
            rate = Decimal(str(value))
            if not rate.is_finite() or rate <= 0:
                raise ValueError("nonpositive_or_nonfinite_close")
        except (ValueError, InvalidOperation, TypeError):
            logger.warning(f"download_closes: ticker={ticker} reason=invalid_close_row")
            continue
        if from_date <= rate_date <= to_date:
            rates[rate_date] = rate
    logger.info(f"download_closes: ticker={ticker} rows={len(rates)}")
    return rates


def fetch_range(currency_code: str, from_date: date, to_date: date) -> dict[date, Decimal]:
    """Return quote currency units per gram XAU, using matching session dates."""
    if currency_code not in SYMBOLS:
        raise ValueError(f"Unsupported fiat currency {currency_code}; add its SYMBOLS and forex ticker mapping before tracking it")
    gold_prices = download_closes("GC=F", from_date, to_date)
    if currency_code == "USD":
        return {rate_date: price / constants.TROY_OZ_TO_GRAM for rate_date, price in gold_prices.items()}
    if not gold_prices:
        return {}
    ticker, multiply = _FOREX[currency_code]
    forex_prices = download_closes(ticker, from_date, to_date)
    rates: dict[date, Decimal] = {}
    for rate_date in gold_prices.keys() & forex_prices.keys():
        gold_price = gold_prices[rate_date]
        forex_price = forex_prices[rate_date]
        quote_per_ounce = gold_price * forex_price if multiply else gold_price / forex_price
        rates[rate_date] = quote_per_ounce / constants.TROY_OZ_TO_GRAM
    return rates


def load_file(file_path: Path | str, currency_code: str) -> dict[date, Decimal]:
    """Parse a local XAU/CCY CSV whose Close is quote currency per troy ounce."""
    return _parse_csv(Path(file_path).read_text(encoding="utf-8-sig"), currency_code)


def _parse_csv(text: str, currency_code: str) -> dict[date, Decimal]:
    rows: dict[date, Decimal] = {}
    reader = csv.DictReader(io.StringIO(text.strip().lstrip("\ufeff")), strict=True)
    if not reader.fieldnames or not {"Date", "Close"}.issubset(reader.fieldnames):
        logger.warning(f"_parse_csv: currency={currency_code} reason=missing_date_close_headers")
        return {}
    try:
        for row in reader:
            try:
                rate_date = date.fromisoformat(row["Date"])
                close = Decimal(row["Close"])
                if not close.is_finite() or close <= 0:
                    raise ValueError("nonpositive_or_nonfinite_close")
                rows[rate_date] = close / constants.TROY_OZ_TO_GRAM
            except (KeyError, TypeError, ValueError, InvalidOperation):
                logger.warning(f"_parse_csv: currency={currency_code} line={reader.line_num} reason=invalid_row")
    except csv.Error:
        # A malformed quoted record can consume following rows; reject the whole file.
        logger.warning(f"_parse_csv: currency={currency_code} line={reader.line_num} reason=malformed_csv")
        return {}
    if not rows:
        logger.warning(f"_parse_csv: currency={currency_code} reason=no_valid_rows")
    return rows
