from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import core.config as config
import sources.crypto as crypto
import sources.fiat as fiat
from database.currency_master import get_currencies, update_last_fetched
from database.locking import claim_job
from database.upsert import forward_fill_rates, upsert_rates

logger = get_logger(__name__)


class CurrencyRatesJob:
    def __init__(self, db: ConnectionConfig) -> None:
        self._db = db

    def run(self, from_date: date, to_date: date) -> tuple[int, int]:
        if from_date > to_date or to_date >= date.max:
            raise ValueError("invalid_date_range")
        client = None
        try:
            client = get_client(self._db)
            claim_job(client)
            counts = _fetch_and_store(client, from_date, to_date)
            client.commit()
            return counts
        except Exception:
            if client is not None:
                client.rollback()
            raise
        finally:
            if client is not None:
                client.close()


def store_rates(client: Any, rates_by_currency: dict[str, dict[date, Decimal]], source: str) -> None:
    """Write source rates and their watermarks in the caller's transaction."""
    rows = [(code, rate_date, rate, source) for code, date_rates in rates_by_currency.items() for rate_date, rate in sorted(date_rates.items())]
    upsert_rates(client, rows)
    update_last_fetched(client, {code: max(date_rates) for code, date_rates in rates_by_currency.items() if date_rates})


def store_identity_rates(client: Any, from_date: date, to_date: date) -> None:
    rows = [("XAU", from_date + timedelta(days=offset), Decimal(1), "synthetic") for offset in range((to_date - from_date).days + 1)]
    upsert_rates(client, rows)


def require_rates(codes: list[str], rates_by_currency: dict[str, dict[date, Decimal]]) -> None:
    """A missing tracked series must fail visibly instead of extending stale fills."""
    missing = [code for code in codes if not rates_by_currency.get(code)]
    if missing:
        logger.warning(f"require_rates: missing_currencies={','.join(missing)}")
        raise RuntimeError("missing_tracked_currency_rates")


def _fetch_and_store(client: Any, from_date: date, to_date: date) -> tuple[int, int]:
    logger.info(f"fetch_and_store: from_date={from_date} to_date={to_date}")
    if not config.source_enabled("yfinance"):
        logger.info("fetch_and_store: source=yfinance disabled=true")
        return 0, 0

    fiat_codes = get_currencies(client, "fiat")
    crypto_codes = get_currencies(client, "crypto")
    # One immutable gold snapshot anchors the entire daily cross-currency matrix.
    gold_prices = fiat.download_closes("GC=F", from_date, to_date) if fiat_codes or crypto_codes else {}
    fiat_rates = {code: fiat.fetch_range(code, from_date, to_date, gold_prices=gold_prices) for code in fiat_codes}
    require_rates(fiat_codes, fiat_rates)
    crypto_rates = crypto.fetch_range(crypto_codes, from_date, to_date, gold_prices=gold_prices)
    require_rates(crypto_codes, crypto_rates)

    store_rates(client, fiat_rates, "yfinance")
    store_rates(client, crypto_rates, "yfinance")
    store_identity_rates(client, from_date, to_date)
    forward_fill_rates(client, from_date, to_date, fiat_codes)
    all_dates = {rate_date for date_rates in fiat_rates.values() for rate_date in date_rates}
    logger.info(f"fetch_and_store: fiat_currencies={len(fiat_rates)} crypto_currencies={len(crypto_rates)} dates={len(all_dates)}")
    return len(fiat_rates), len(all_dates)
