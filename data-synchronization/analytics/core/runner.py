from __future__ import annotations

import argparse
import signal
import sys

from py_logging import get_logger

import core.config as config
from core.build import build, check
from core.errors import error_code
from core.publish import publish

logger = get_logger(__name__)
MODES = ("refresh", "build", "publish", "check")

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
    parser = argparse.ArgumentParser(description="Compute the expense-tracker reports from PostgreSQL and publish them to the Sheet")
    parser.add_argument(
        "--mode",
        required=True,
        choices=MODES,
        help="refresh: build then publish; build: compute into PostgreSQL only; publish: send the last good build to the Sheet; check: read-only checks",
    )
    args = parser.parse_args()
    for signum in _STOP_SIGNALS:
        signal.signal(signum, _on_stop_signal)
    logger.info(f"runner: start=true mode={args.mode}")
    try:
        if args.mode == "check":
            check(config.db_config())
        else:
            if args.mode in ("refresh", "build"):
                build(config.db_config(), mode=args.mode)
            if args.mode in ("refresh", "publish"):
                # refresh skips an unchanged generation; publish always re-sends the last good one.
                publish(config.db_config(), config.spreadsheet_id(), config.service_account_file(), force=args.mode == "publish")
    except KeyboardInterrupt:
        logger.error("runner: job_failed reason=interrupted")
        sys.exit(1)
    except Exception as error:
        logger.error(f"runner: job_failed error={type(error).__name__} reason={error_code(error)}")
        sys.exit(1)
    logger.info(f"runner: complete mode={args.mode}")


if __name__ == "__main__":
    main()
