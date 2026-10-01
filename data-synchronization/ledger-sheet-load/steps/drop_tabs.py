from __future__ import annotations

from py_logging import get_logger

from core.context import LoadContext
from core.gas_client import expect_ok

logger = get_logger(__name__)


def run(context: LoadContext) -> None:
    """Deletes the CSV-backed tabs, then recreates the ones the list endpoints own.

    Every other tab (dummy, rates, the audit log, ...) is kept. The server refuses the
    delete unless the spreadsheet id matches the environment's, so a run pointed at the
    wrong spreadsheet deletes nothing.
    """
    response = expect_ok("drop_tabs", context.client.post("factory_reset_delete_sheets", confirm="factory-reset", spreadsheet_id=context.spreadsheet_id))
    logger.info(f"drop_tabs: deleted={','.join(response.get('deleted') or [])}")
    for action in context.settings["recreate_actions"]:
        expect_ok(f"recreate:{action}", context.client.get(action))
        logger.info(f"drop_tabs: recreated_by={action}")
