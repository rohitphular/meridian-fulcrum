from __future__ import annotations

from py_logging import get_logger

from core.context import LoadContext
from core.gas_client import expect_ok

logger = get_logger(__name__)


def run(context: LoadContext) -> None:
    """Imports every file in dependency order. Rows update by id or are added; nothing is deleted."""
    for dataset in context.datasets:
        response = expect_ok(f"load:{dataset.file}", context.client.post(dataset.action, **dataset.import_body(context.data_dir, dry_run=False)))
        logger.info(f"load_data: file={dataset.file} created={response.get('created', 0)} updated={response.get('updated', 0)}")
