from __future__ import annotations

import csv
import io
from datetime import date

import requests

from py_logging import get_logger

import sources.constants as constants

logger = get_logger(__name__)

BASE_URL = "https://stooq.com/q/d/l/"
HOMEPAGE = "https://stooq.com/"

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

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
}


def _new_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(_HEADERS)
    try:
        session.get(HOMEPAGE, timeout=15)
    except requests.RequestException as e:
        logger.warning(f"_new_session: homepage_fetch_failed error={e}")
    return session


def fetch_range(currency_code: str, from_date: date, to_date: date) -> dict[date, float]:
    """Fetch XAU/{currency} rates for a date range. Returns {date: rate_per_gram_xau}."""
    symbol = SYMBOLS.get(currency_code)
    if not symbol:
        logger.warning(f"fetch_range: currency={currency_code} no_stooq_symbol")
        return {}
    f = from_date.strftime("%Y%m%d")
    t = to_date.strftime("%Y%m%d")
    session = _new_session()
    try:
        resp = session.get(
            BASE_URL,
            params={"s": symbol, "f": f, "t": t, "i": "d"},
            headers={"Referer": f"https://stooq.com/q/d/?f={f}&t={t}&s={symbol}&c=0"},
            timeout=30,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning(f"fetch_range: currency={currency_code} http_error={e}")
        return {}
    return _parse_csv(resp.text, currency_code)


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
        logger.warning(f"_parse_csv: currency={currency_code} empty_or_invalid_response")
    return rows
