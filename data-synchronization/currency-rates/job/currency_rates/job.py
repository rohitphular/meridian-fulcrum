from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import config
from currency_rates.sources import frankfurter, coingecko, goldapi, stooq
from currency_rates.db.upsert import upsert_rates

logger = get_logger(__name__)

AED_PER_USD = 3.6725
TROY_OZ_TO_GRAM = 31.1035


class CurrencyRatesJob:
    def __init__(self, db: ConnectionConfig) -> None:
        self._db = db

    def run(self) -> None:
        """Daily fetch — one call per source, upserts today's rates."""
        today = date.today()
        client = get_client(self._db)
        try:
            gold_usd_per_gram = goldapi.fetch_latest(config.goldapi_key())
            rows = _build_rows(today, gold_usd_per_gram, "goldapi.io")
            upsert_rates(client, rows)
            logger.info(f"job: date={today} currencies={len(rows)}")
        finally:
            client.close()

    def backfill(self, from_date: date) -> None:
        """Backfill from from_date to yesterday — skips already-present rows."""
        yesterday = date.today() - timedelta(days=1)
        client = get_client(self._db)
        try:
            _backfill_fiat(client, from_date, yesterday)
            _backfill_crypto(client, from_date, yesterday)
            logger.info(f"job: backfill complete from_date={from_date} to_date={yesterday}")
        finally:
            client.close()


def _build_rows(rate_date: date, gold_usd_per_gram: float, gold_source: str) -> list[tuple]:
    rows = []

    fiat_rates = frankfurter.fetch_date(rate_date)
    for code, rate_vs_usd in fiat_rates.items():
        rows.append((code, rate_date, rate_vs_usd * gold_usd_per_gram, "frankfurter"))

    aed_vs_usd = fiat_rates.get("USD", 1.0) * AED_PER_USD
    rows.append(("AED", rate_date, aed_vs_usd * gold_usd_per_gram, "hardcoded"))

    crypto_rates = coingecko.fetch_latest()
    for code, rate_vs_usd in crypto_rates.items():
        rows.append((code, rate_date, rate_vs_usd * gold_usd_per_gram, "coingecko"))

    rows.append(("XAU", rate_date, 1.0, gold_source))

    return rows


def _backfill_fiat(client: Any, from_date: date, to_date: date) -> None:
    current = from_date
    while current <= to_date:
        gold_csv_rows = stooq.fetch_csv_row(current)
        if gold_csv_rows is not None:
            gold_usd_per_gram = gold_csv_rows / TROY_OZ_TO_GRAM
            rows = _build_rows(current, gold_usd_per_gram, "stooq")
            upsert_rates(client, rows)
            logger.info(f"job: backfill date={current} currencies={len(rows)}")
        current += timedelta(days=1)


def _backfill_crypto(client: Any, from_date: date, to_date: date) -> None:
    pass
