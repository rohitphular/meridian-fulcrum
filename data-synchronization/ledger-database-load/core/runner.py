from __future__ import annotations

import argparse
import re
import signal
import sys

from py_logging import get_logger

import core.config as config
from core.account_detail_contracts import CONTRACTS
from core.loader import LedgerDatabaseLoadJob

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
    if re.fullmatch(r"(?:latest_snapshot_not_loadable|tab_not_staged):[a-z_]+", reason):
        return reason
    if re.fullmatch(rf"[a-z_]+(?::(?:{_ENTITY_NAMES}))?(?::row=[0-9]+)?", reason):
        return reason
    return "see_entity_logs"


_STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def _on_stop_signal(_signum: int, _frame: object) -> None:
    """Ctrl-C, SIGTERM (kill, a scheduler) and SIGHUP all unwind like Ctrl-C, once.

    One Ctrl-C usually arrives twice (from the terminal and forwarded by `uv run`); a
    second interrupt would cut the clean-up short, so later signals are ignored.
    A job that then hangs needs SIGKILL (the consolidated pipeline sends it after 10 s).
    """
    for signum in _STOP_SIGNALS:
        signal.signal(signum, signal.SIG_IGN)
    raise KeyboardInterrupt


def main() -> None:
    parser = argparse.ArgumentParser(description="Transform the latest staged Sheet snapshot and load it into PostgreSQL")
    parser.add_argument("--reprocess", action="store_true", help="Revalidate and update in-sync rows too (e.g. after transform or rate corrections)")
    args = parser.parse_args()
    for signum in _STOP_SIGNALS:
        signal.signal(signum, _on_stop_signal)
    logger.info(f"runner: start=true reprocess={args.reprocess}")
    try:
        LedgerDatabaseLoadJob(config.db_config()).run(reprocess=args.reprocess)
    except KeyboardInterrupt:
        logger.error("runner: job_failed reason=interrupted")
        sys.exit(1)
    except Exception as e:
        reason = _safe_failure_reason(e)
        logger.error(f"runner: job_failed error={type(e).__name__} reason={reason}")
        sys.exit(1)
    logger.info("runner: complete")


if __name__ == "__main__":
    main()
