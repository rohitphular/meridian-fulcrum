from __future__ import annotations

import sys

from py_logging import get_logger

import core.config as config
from core.extractor import LedgerExtractJob

logger = get_logger(__name__)


def main() -> None:
    logger.info("runner: start")
    try:
        job = LedgerExtractJob(config.db_config(), config.spreadsheet_id(), config.service_account_file())
        job.run(config.load_config())
    except Exception as e:
        logger.error(f"runner: job_failed error={e}")
        sys.exit(1)
    logger.info("runner: complete")


if __name__ == "__main__":
    main()
