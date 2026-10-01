from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from py_logging import get_logger

import core.config as config
from core.context import LoadContext
from core.credentials import read_credentials
from core.datasets import Dataset, collect_datasets
from core.gas_client import GasClient
from core.loader import MODES, LedgerSheetLoadJob

logger = get_logger(__name__)


def _safe_failure_reason(error: Exception) -> str:
    # Codes and file names only: labels are "<step>:<file>" or "<step>:<action>".
    reason = str(error)
    if re.fullmatch(r"[a-z_]+(?::[A-Za-z0-9_.\-]+){0,2}", reason):
        return reason
    return "unexpected_error"


def _confirm(mode: str, env: str, spreadsheet_id: str, data_dir: Path, datasets: list[Dataset]) -> bool:
    print("")
    if mode == "sheet-rebuild":
        print(f"Sheet rebuild — environment: {env}")
        print(f"  Spreadsheet : {spreadsheet_id}")
        print("  Deletes     : account_types, category_master, account_master, 6 account detail tabs,")
        print("                subscription_master, transaction_master (all other tabs are kept)")
        print(f"  Loads       : {len(datasets)} files from {data_dir}")
        print("")
        return input(f"Type '{env}' to continue: ").strip() == env
    print(f"Sheet sync — environment: {env}")
    print(f"  Spreadsheet : {spreadsheet_id}")
    print(f"  Loads       : {len(datasets)} files from {data_dir} into the existing tabs")
    print("                (rows are matched by id; rows missing from a file are left in the Sheet)")
    print("")
    return input("Continue? [y/N] ").strip() in ("y", "Y")


def main() -> None:
    parser = argparse.ArgumentParser(description="Load local ledger CSV files into the expense-tracker Sheet")
    parser.add_argument("--env", required=True, help="Environment name, shown in the confirmation")
    parser.add_argument("--mode", required=True, choices=MODES, help="sheet-rebuild: delete, recreate and reload the tabs; sheet-sync: update rows by id and add new ones")
    args = parser.parse_args()
    logger.info(f"runner: start=true env={args.env} mode={args.mode}")
    try:
        settings = config.load_config()
        data_dir = config.data_dir(settings)
        datasets = collect_datasets(settings, data_dir)
        spreadsheet_id = config.spreadsheet_id()
        if not _confirm(args.mode, args.env, spreadsheet_id, data_dir, datasets):
            logger.info("runner: cancelled=true nothing_changed=true")
            sys.exit(1)
        pin, totp = read_credentials()
        context = LoadContext(GasClient(config.script_url(), pin), data_dir, datasets, spreadsheet_id, settings)
        LedgerSheetLoadJob(context).run(args.mode, totp)
    except (KeyboardInterrupt, EOFError):
        logger.error("runner: job_failed reason=interrupted")
        sys.exit(1)
    except Exception as e:
        logger.error(f"runner: job_failed error={type(e).__name__} reason={_safe_failure_reason(e)}")
        sys.exit(1)
    logger.info(f"runner: complete mode={args.mode}")


if __name__ == "__main__":
    main()
