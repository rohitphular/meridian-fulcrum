from __future__ import annotations

import os
from datetime import date

from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.stooq as stooq
import sources.exchangerate as exchangerate
from database.upsert import upsert_rates

logger = get_logger(__name__)

FIAT_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "AUD", "CAD", "CHF", "SGD", "AED", "HKD", "BRL", "KRW"]


def main() -> None:
    csv_dir = config.historical_csv_dir()
    to_date = date.today()

    logger.info(f"historical: csv_dir={csv_dir} to_date={to_date}")

    all_data: dict[str, dict[date, float]] = {}

    for code in FIAT_CURRENCIES:
        symbol = stooq.SYMBOLS.get(code, f"xau{code.lower()}")
        file_path = os.path.join(csv_dir, f"{symbol}.csv")

        if not os.path.exists(file_path):
            logger.warning(f"historical: currency={code} file_missing={file_path}")
            continue

        try:
            data = stooq.load_file(file_path, code)
            if data:
                all_data[code] = data
                logger.info(f"historical: currency={code} dates={len(data)}")
            else:
                logger.warning(f"historical: currency={code} file_empty={file_path}")
        except Exception as e:
            logger.error(f"historical: currency={code} error={e}")

    all_dates: set[date] = set()
    for data in all_data.values():
        all_dates.update(data.keys())

    fiat_rows: list[tuple] = []
    for rate_date in sorted(all_dates):
        for code, data in all_data.items():
            rate = data.get(rate_date)
            if rate is not None:
                fiat_rows.append((code, rate_date, rate, "stooq"))
        fiat_rows.append(("XAU", rate_date, 1.0, "stooq"))

    client = get_client(config.db_config())
    try:
        upsert_rates(client, fiat_rows)
        logger.info(f"historical: fiat complete dates={len(all_dates)} currencies={len(all_data)} rows={len(fiat_rows)}")

        try:
            crypto = exchangerate.fetch_latest()
            rows = [(code, to_date, rate, "exchangerate") for code, rate in crypto.items()]
            upsert_rates(client, rows)
            logger.info(f"historical: crypto complete currencies={len(rows)}")
        except Exception as e:
            logger.error(f"historical: source=exchangerate error={e}")

    finally:
        client.close()


if __name__ == "__main__":
    main()
