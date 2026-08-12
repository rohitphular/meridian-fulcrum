from __future__ import annotations

import random
import time
from datetime import date, timedelta
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
        client = get_client(self._db)
        try:
            _fetch_and_store(client, from_date, to_date)
        finally:
            client.close()


def _fetch_and_store(client: Any, from_date: date, to_date: date) -> None:
    logger.info(f"fetch_and_store: from_date={from_date} to_date={to_date}")

    all_data: dict[str, dict[date, float]] = {}

    if config.source_enabled("stooq"):
        fiat_currencies = get_fiat_currencies(client)
        logger.info(f"fetch_and_store: source=stooq currencies={fiat_currencies}")
        for i, code in enumerate(fiat_currencies):
            if i > 0:
                time.sleep(random.uniform(1, 5))
            try:
                data = stooq.fetch_range(code, from_date, to_date)
                if data:
                    all_data[code] = data
                    logger.info(f"fetch_and_store: source=stooq currency={code} dates={len(data)}")
                else:
                    logger.warning(f"fetch_and_store: source=stooq currency={code} no_data")
            except Exception as e:
                logger.error(f"fetch_and_store: source=stooq currency={code} error={e}")

    all_dates: set[date] = set()
    for data in all_data.values():
        all_dates.update(data.keys())

    for rate_date in sorted(all_dates):
        rows: list[tuple] = []
        for code, data in all_data.items():
            rate = data.get(rate_date)
            if rate is not None:
                rows.append((code, rate_date, rate, "stooq"))
        rows.append(("XAU", rate_date, 1.0, "stooq"))
        upsert_rates(client, rows)

    if all_data:
        update_last_fetched(client, {code: max(data.keys()) for code, data in all_data.items()})

    logger.info(f"fetch_and_store: stooq complete dates={len(all_dates)}")
    forward_fill_rates(client, from_date, to_date)

    if config.source_enabled("exchangerate"):
        try:
            crypto = exchangerate.fetch_latest()
            rows = [(code, to_date, rate, "exchangerate") for code, rate in crypto.items()]
            upsert_rates(client, rows)
            update_last_fetched(client, {code: to_date for code in crypto})
            logger.info(f"fetch_and_store: source=exchangerate currencies={len(rows)}")
        except Exception as e:
            logger.error(f"fetch_and_store: source=exchangerate error={e}")
