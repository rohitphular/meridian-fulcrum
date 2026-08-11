from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.exchangerate as exchangerate
import sources.stooq as stooq
from database.upsert import upsert_rates

logger = get_logger(__name__)

TROY_OZ_TO_GRAM = 31.1035


class CurrencyRatesJob:
    def __init__(self, db: ConnectionConfig) -> None:
        self._db = db

    def run(self) -> None:
        today = date.today()
        client = get_client(self._db)
        try:
            xau_rates = exchangerate.fetch_latest()
            rows = [(code, today, value, "exchangerate") for code, value in xau_rates.items()]
            rows.append(("XAU", today, 1.0, "exchangerate"))
            upsert_rates(client, rows)
            logger.info(f"job: date={today} currencies={len(rows)}")
        except Exception as e:
            logger.error(f"job: date={today} error={e}")
        finally:
            client.close()

    def backfill(self, from_date: date) -> None:
        yesterday = date.today() - timedelta(days=1)
        client = get_client(self._db)
        try:
            _backfill_all(client, from_date, yesterday)
            logger.info(f"job: backfill complete from_date={from_date} to_date={yesterday}")
        finally:
            client.close()


def _backfill_all(client: Any, from_date: date, to_date: date) -> None:
    stooq_data = _load_stooq()
    if not stooq_data:
        logger.error("_backfill_all: stooq data unavailable, cannot backfill")
        return

    current_rates = exchangerate.fetch_latest()
    current_gold_usd_per_gram = current_rates.get("USD")
    if not current_gold_usd_per_gram:
        logger.error("_backfill_all: cannot determine current gold price, cannot backfill")
        return

    current = from_date
    while current <= to_date:
        close_price = stooq_data.get(current)
        if close_price is None:
            logger.warning(f"_backfill_all: date={current} skipped=no_gold_price")
            current += timedelta(days=1)
            continue

        historical_gold_usd_per_gram = close_price / TROY_OZ_TO_GRAM
        scale = historical_gold_usd_per_gram / current_gold_usd_per_gram

        rows = [(code, current, value * scale, "exchangerate+stooq") for code, value in current_rates.items()]
        rows.append(("XAU", current, 1.0, "stooq"))

        upsert_rates(client, rows)
        logger.info(f"_backfill_all: date={current} currencies={len(rows)}")
        current += timedelta(days=1)


def _load_stooq() -> dict[date, float]:
    try:
        return stooq.load_csv(config.stooq_csv_path())
    except Exception as e:
        logger.error(f"_load_stooq: error={e}")
        return {}
