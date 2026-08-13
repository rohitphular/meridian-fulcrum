from __future__ import annotations

from datetime import date
from typing import Any

from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.stooq as stooq
import sources.exchangerate as exchangerate
from database.upsert import upsert_rates, forward_fill_rates
from database.currency_master import get_fiat_currencies, update_last_fetched

logger = get_logger(__name__)


class CurrencyRatesJob:
    def __init__(self, db: ConnectionConfig) -> None:
        self._db = db

    def run(self, from_date: date, to_date: date) -> None:
        client = None
        try:
            client = get_client(self._db)
            _fetch_and_store(client, from_date, to_date)
        finally:
            if client is not None:
                client.close()


def _fetch_and_store(client: Any, from_date: date, to_date: date) -> None:
    logger.info(f"fetch_and_store: from_date={from_date} to_date={to_date}")

    if not config.source_enabled("yfinance"):
        logger.info("fetch_and_store: source=yfinance disabled")
        return

    all_data: dict[str, dict[date, float]] = {}

    fiat_currencies = get_fiat_currencies(client)
    logger.info(f"fetch_and_store: source=yfinance currencies={fiat_currencies}")
    for code in fiat_currencies:
        rate_data = stooq.fetch_range(code, from_date, to_date)
        if rate_data:
            all_data[code] = rate_data
            logger.info(f"fetch_and_store: source=yfinance currency={code} dates={len(rate_data)}")
        else:
            logger.warning(f"fetch_and_store: source=yfinance currency={code} no_data")

    all_dates: set[date] = set()
    for date_rates in all_data.values():
        all_dates.update(date_rates.keys())

    for rate_date in sorted(all_dates):
        rows: list[tuple] = []
        for code, date_rates in all_data.items():
            rate = date_rates.get(rate_date)
            if rate is not None:
                rows.append((code, rate_date, rate, "yfinance"))
        rows.append(("XAU", rate_date, 1.0, "yfinance"))
        upsert_rates(client, rows)

    if all_data:
        update_last_fetched(client, {code: max(date_rates.keys()) for code, date_rates in all_data.items()})

    logger.info(f"fetch_and_store: fiat complete dates={len(all_dates)}")
    forward_fill_rates(client, from_date, to_date)

    crypto = exchangerate.fetch_latest()
    if crypto:
        rows = [(code, to_date, rate, "yfinance") for code, rate in crypto.items()]
        upsert_rates(client, rows)
        update_last_fetched(client, {code: to_date for code in crypto})
        logger.info(f"fetch_and_store: source=yfinance crypto currencies={len(rows)}")
