from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

from py_logging import get_logger

from core.context import LoadContext
from core.datasets import read_csv, write_csv
from core.gas_client import expect_ok

logger = get_logger(__name__)


def run(context: LoadContext) -> Path | None:
    """Gives every CSV row without an id a UUID; returns the backup folder, if any file changed.

    The server parses each file and returns it with ids filled (fill_csv_ids): a short row
    is padded to the header width, and a file with any filled id is re-serialised with
    minimal quoting. Changed files are backed up first, then overwritten, so later syncs
    update rows by id instead of adding them again.
    """
    backup_dir: Path | None = None
    for dataset in context.datasets:
        path = context.data_dir / dataset.file
        response = expect_ok(f"fill_ids:{dataset.file}", context.client.post("fill_csv_ids", csv=read_csv(path)))
        filled = int(response.get("filled") or 0)
        if filled == 0:
            continue
        if backup_dir is None:
            backup_dir = context.data_dir / ".backup" / datetime.now().strftime("%Y%m%d-%H%M%S")
            backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup_dir / dataset.file)
        write_csv(path, response["csv"])
        logger.info(f"fill_ids: file={dataset.file} filled={filled}")
    if backup_dir is None:
        logger.info("fill_ids: every row already has an id")
    else:
        logger.info(f"fill_ids: originals saved in {backup_dir}")
    return backup_dir
