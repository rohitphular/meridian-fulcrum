from __future__ import annotations

import argparse
import re
import signal
import sys

from py_logging import get_logger

import core.config as config
from core.jobs import acknowledge, extract

logger = get_logger(__name__)
MODES = ("extract", "acknowledge")


def _safe_failure_reason(error: Exception) -> str:
    # Codes, tab names and row numbers only: never cell values.
    reason = str(error)
    if re.fullmatch(r"[a-z_]+(?::[a-z_]+)?(?::row=[0-9]+)?", reason):
        return reason
    return "see_module_logs"


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
    parser = argparse.ArgumentParser(description="Stage the expense-tracker Sheet in PostgreSQL, or write sync outcomes back to it")
    parser.add_argument("--mode", required=True, choices=MODES, help="extract: read the enabled tabs into a new staging snapshot; acknowledge: write the loaded outcomes to the sync cells")
    args = parser.parse_args()
    for signum in _STOP_SIGNALS:
        signal.signal(signum, _on_stop_signal)
    logger.info(f"runner: start=true mode={args.mode}")
    try:
        if args.mode == "extract":
            extract(config.db_config(), config.spreadsheet_id(), config.service_account_file(), config.enabled_tabs(config.load_config()))
        else:
            acknowledge(config.db_config(), config.spreadsheet_id(), config.service_account_file())
    except KeyboardInterrupt:
        logger.error("runner: job_failed reason=interrupted")
        sys.exit(1)
    except Exception as e:
        logger.error(f"runner: job_failed error={type(e).__name__} reason={_safe_failure_reason(e)}")
        sys.exit(1)
    logger.info(f"runner: complete mode={args.mode}")


if __name__ == "__main__":
    main()
