from __future__ import annotations

from py_logging import get_logger

from core.context import LoadContext
from core.gas_client import expect_ok

logger = get_logger(__name__)


def run(context: LoadContext) -> None:
    """Dry-runs every file before anything changes.

    dry_run only parses and validates on the server; it never reads or writes a Sheet.
    """
    for dataset in context.datasets:
        response = expect_ok(f"check:{dataset.file}", context.client.post(dataset.action, **dataset.import_body(context.data_dir, dry_run=True)))
        logger.info(f"check_files: file={dataset.file} rows={response.get('rows', 0)}")
