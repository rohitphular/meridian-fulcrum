from __future__ import annotations

from datetime import date, timedelta

from py_logging import get_logger

import core.config as config
from core.fetcher import CurrencyRatesJob

logger = get_logger(__name__)


def main() -> None:
    to_date = date.today()
    from_date = to_date - timedelta(days=365)

    logger.info(f"runner: from_date={from_date} to_date={to_date}")
    job = CurrencyRatesJob(config.db_config())
    job.run(from_date, to_date)
    logger.info(f"runner: complete from_date={from_date} to_date={to_date}")


if __name__ == "__main__":
    main()
