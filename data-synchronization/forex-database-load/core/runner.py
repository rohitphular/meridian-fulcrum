from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from py_logging import get_logger

import core.config as config
from core.errors import failure_reason
from core.fetcher import CurrencyRatesJob

logger = get_logger(__name__)


def main() -> None:
    to_date = datetime.now(timezone.utc).date()
    from_date = to_date - timedelta(days=364)

    logger.info(f"runner: from_date={from_date} to_date={to_date}")
    try:
        job = CurrencyRatesJob(config.db_config())
        fiat_count, date_count = job.run(from_date, to_date)
    except Exception as e:
        logger.error(f"runner: job_failed error={type(e).__name__} reason={failure_reason(e)}")
        sys.exit(1)
    logger.info(f"runner: complete from_date={from_date} to_date={to_date} fiat_currencies={fiat_count} dates={date_count}")


if __name__ == "__main__":
    main()
