from __future__ import annotations

import os
from datetime import date

from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
import sources.stooq as stooq
import sources.exchangerate as exchangerate
from database.upsert import upsert_rates, forward_fill_rates
from database.currency_master import get_fiat_currencies, update_last_fetched

logger = get_logger(__name__)


def main() -> None:
    csv_dir = config.historical_csv_dir()
    to_date = date.today()

    logger.info(f"historical: csv_dir={csv_dir} to_date={to_date}")

    client = get_client(config.db_config())
    try:
        fiat_currencies = get_fiat_currencies(client)
        logger.info(f"historical: currencies={fiat_currencies}")

        all_data: dict[str, dict[date, float]] = {}

        for code in fiat_currencies:
            symbol = stooq.SYMBOLS.get(code, f"xau{code.lower()}")
            file_path = os.path.join(csv_dir, f"{symbol}.csv")

            if not os.path.exists(file_path):
                logger.warning(f"historical: currency={code} file_missing={file_path}")
                continue

            try:
                rate_data = stooq.load_file(file_path, code)
                if rate_data:
                    all_data[code] = rate_data
                    logger.info(f"historical: currency={code} dates={len(rate_data)}")
                else:
                    logger.warning(f"historical: currency={code} file_empty={file_path}")
            except Exception as e:
                logger.error(f"historical: currency={code} error={e}")

        if not all_data:
            logger.warning("historical: skipped_reason=no_fiat_data_loaded")
            return

        all_dates: set[date] = set()
        for date_rates in all_data.values():
            all_dates.update(date_rates.keys())

        fiat_rows: list[tuple] = []
        for rate_date in sorted(all_dates):
            for code, date_rates in all_data.items():
                rate = date_rates.get(rate_date)
                if rate is not None:
                    fiat_rows.append((code, rate_date, rate, "stooq"))
            fiat_rows.append(("XAU", rate_date, 1.0, "stooq"))

        upsert_rates(client, fiat_rows)
        logger.info(f"historical: fiat complete dates={len(all_dates)} currencies={len(all_data)} rows={len(fiat_rows)}")

        update_last_fetched(client, {code: max(date_rates.keys()) for code, date_rates in all_data.items()})
        forward_fill_rates(client, min(all_dates), to_date)

        crypto = exchangerate.fetch_latest()
        if crypto:
            rows = [(code, to_date, rate, "exchangerate") for code, rate in crypto.items()]
            upsert_rates(client, rows)
            update_last_fetched(client, {code: to_date for code in crypto})
            logger.info(f"historical: crypto complete currencies={len(rows)}")

        logger.info(f"historical: complete fiat_currencies={len(all_data)} dates={len(all_dates)} to_date={to_date}")

    finally:
        client.close()


if __name__ == "__main__":
    main()
