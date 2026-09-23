from __future__ import annotations

import argparse
import re
import sys

from py_logging import get_logger

import core.config as config
from core.extractor import LedgerExtractJob

logger = get_logger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract ledger data from Sheets into PostgreSQL")
    parser.add_argument("--reprocess", action="store_true", help="Revalidate and update in-sync source rows (e.g. after transform or rate corrections)")
    args = parser.parse_args()
    logger.info(f"runner: start=true reprocess={args.reprocess}")
    try:
        job = LedgerExtractJob(config.db_config(), config.spreadsheet_id(), config.service_account_file())
        job.run(config.load_config(), reprocess=args.reprocess)
    except Exception as e:
        reason = str(e)
        if re.fullmatch(r"[a-z_]+(?::(?:categories|accounts|transactions|subscriptions))?(?::row=\d+)?", reason) is None:
            reason = "see_entity_logs"
        logger.error(f"runner: job_failed error={type(e).__name__} reason={reason}")
        sys.exit(1)
    logger.info("runner: complete")


if __name__ == "__main__":
    main()
