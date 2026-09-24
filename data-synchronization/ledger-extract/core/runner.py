from __future__ import annotations

import argparse
import re
import sys

from py_logging import get_logger

import core.config as config
from core.account_detail_contracts import CONTRACTS
from core.extractor import LedgerExtractJob

logger = get_logger(__name__)
_DETAIL_NAMES = "|".join(re.escape(name) for name in CONTRACTS)
_ENTITY_NAMES = "|".join(("account_types", "category_master", "account_master", "transaction_master", "subscription_master", _DETAIL_NAMES))


def _safe_failure_reason(error: Exception) -> str:
    reason = str(error)
    if re.fullmatch(r"transactions: [a-z_]+", reason):
        return reason.replace("transactions: ", "transaction_error:", 1)
    if re.fullmatch(r"subscriptions: [a-z_]+", reason):
        return reason.replace("subscriptions: ", "subscription_error:", 1)
    if re.fullmatch(rf"account_detail_error:(?:{_DETAIL_NAMES}):row=[0-9]+:[a-z_]+", reason):
        return reason
    if re.fullmatch(rf"[a-z_]+(?::(?:{_ENTITY_NAMES}))?(?::row=[0-9]+)?", reason):
        return reason
    return "see_entity_logs"


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract ledger data from Sheets into PostgreSQL")
    parser.add_argument("--reprocess", action="store_true", help="Revalidate and update in-sync source rows (e.g. after transform or rate corrections)")
    args = parser.parse_args()
    logger.info(f"runner: start=true reprocess={args.reprocess}")
    try:
        job = LedgerExtractJob(config.db_config(), config.spreadsheet_id(), config.service_account_file())
        job.run(config.load_config(), reprocess=args.reprocess)
    except Exception as e:
        reason = _safe_failure_reason(e)
        logger.error(f"runner: job_failed error={type(e).__name__} reason={reason}")
        sys.exit(1)
    logger.info("runner: complete")


if __name__ == "__main__":
    main()
