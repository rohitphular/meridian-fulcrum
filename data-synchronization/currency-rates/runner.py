from __future__ import annotations

import argparse
from datetime import date

from py_logging import get_logger

import core.config as config
from core.fetcher import CurrencyRatesJob

logger = get_logger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Currency rates fetch job")
    parser.add_argument("--backfill", metavar="YYYY-MM-DD", help="Backfill from this date to yesterday")
    args = parser.parse_args()

    db = config.db_config()

    job = CurrencyRatesJob(db)

    if args.backfill:
        from_date = date.fromisoformat(args.backfill)
        logger.info(f"runner: mode=backfill from_date={from_date}")
        job.backfill(from_date)
    else:
        logger.info("runner: mode=daily")
        job.run()


if __name__ == "__main__":
    main()
