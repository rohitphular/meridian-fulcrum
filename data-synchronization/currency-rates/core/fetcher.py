from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.frankfurter as frankfurter
import sources.coingecko as coingecko
import sources.goldapi as goldapi
import sources.stooq as stooq
from database.upsert import upsert_rates

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
            gold_usd_per_gram = _fetch_gold_daily()
            if gold_usd_per_gram is None:
                logger.info("job: status=skipped reason=no_gold_price")
                return
            rows = _fetch_fiat(today, gold_usd_per_gram)
            rows += _fetch_crypto(today, gold_usd_per_gram)
            rows.append(("XAU", today, 1.0, "goldapi.io"))
            upsert_rates(client, rows)
            logger.info(f"job: date={today} currencies={len(rows)}")
        finally:
            client.close()

    def backfill(self, from_date: date) -> None:
        """Backfill from from_date to yesterday — skips already-present rows."""
        yesterday = date.today() - timedelta(days=1)
        client = get_client(self._db)
        try:
            _backfill_all(client, from_date, yesterday)
            logger.info(f"job: backfill complete from_date={from_date} to_date={yesterday}")
        finally:
            client.close()


def _fetch_gold_daily() -> float | None:
    if not config.source_enabled("goldapi"):
        logger.info("_fetch_gold_daily: status=disabled")
        return None
    key = config.goldapi_key()
    if not key:
        logger.info("_fetch_gold_daily: status=skipped reason=CR_GOLDAPI_KEY_not_set")
        return None
    try:
        return goldapi.fetch_latest(key)
    except Exception as e:
        logger.error(f"_fetch_gold_daily: error={e}")
        return None


def _fetch_fiat(rate_date: date, gold_usd_per_gram: float) -> list[tuple]:
    if not config.source_enabled("frankfurter"):
        logger.info(f"_fetch_fiat: status=disabled date={rate_date}")
        return []
    rows = []
    try:
        fiat_rates = frankfurter.fetch_date(rate_date)
        for code, rate_vs_usd in fiat_rates.items():
            rows.append((code, rate_date, rate_vs_usd * gold_usd_per_gram, "frankfurter"))
        aed_vs_usd = fiat_rates.get("USD", 1.0) * AED_PER_USD
        rows.append(("AED", rate_date, aed_vs_usd * gold_usd_per_gram, "hardcoded"))
        logger.info(f"_fetch_fiat: date={rate_date} currencies={len(rows)}")
    except Exception as e:
        logger.error(f"_fetch_fiat: date={rate_date} error={e}")
    return rows


def _fetch_crypto(rate_date: date, gold_usd_per_gram: float) -> list[tuple]:
    if not config.source_enabled("coingecko"):
        logger.info(f"_fetch_crypto: status=disabled date={rate_date}")
        return []
    rows = []
    try:
        crypto_rates = coingecko.fetch_latest()
        for code, rate_vs_usd in crypto_rates.items():
            rows.append((code, rate_date, rate_vs_usd * gold_usd_per_gram, "coingecko"))
        logger.info(f"_fetch_crypto: date={rate_date} currencies={len(rows)}")
    except Exception as e:
        logger.error(f"_fetch_crypto: date={rate_date} error={e}")
    return rows


def _backfill_all(client: Any, from_date: date, to_date: date) -> None:
    crypto_data = _fetch_crypto_range(from_date, to_date)
    stooq_data = stooq.load_csv(config.stooq_csv_path())

    current = from_date
    while current <= to_date:
        close_price = stooq_data.get(current)
        if close_price is None:
            logger.warning(f"_backfill_all: date={current} skipped=no_gold_price")
            current += timedelta(days=1)
            continue

        gold_usd_per_gram = close_price / TROY_OZ_TO_GRAM
        rows = _fetch_fiat(current, gold_usd_per_gram)

        for code, daily in crypto_data.items():
            price = daily.get(current)
            if price is not None:
                rows.append((code, current, price * gold_usd_per_gram, "coingecko"))
            else:
                logger.warning(f"_backfill_all: date={current} currency={code} skipped=no_price")

        rows.append(("XAU", current, 1.0, "stooq"))

        if rows:
            upsert_rates(client, rows)
            logger.info(f"_backfill_all: date={current} currencies={len(rows)}")

        current += timedelta(days=1)


def _fetch_crypto_range(from_date: date, to_date: date) -> dict[str, dict[date, float]]:
    if not config.source_enabled("coingecko"):
        logger.info("_fetch_crypto_range: status=disabled")
        return {}
    try:
        return coingecko.fetch_range(from_date, to_date)
    except Exception as e:
        logger.error(f"_fetch_crypto_range: error={e}")
        return {}
