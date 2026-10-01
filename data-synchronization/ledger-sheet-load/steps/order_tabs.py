from __future__ import annotations

from py_logging import get_logger

from core.context import LoadContext
from core.gas_client import expect_ok

logger = get_logger(__name__)


def run(context: LoadContext) -> None:
    """Reapplies the configured tab order through ensureExpenseTrackerSheetOrder() (arrange_sheet_tabs)."""
    response = expect_ok("order_tabs", context.client.post("arrange_sheet_tabs"))
    if response.get("changed"):
        logger.info(f"order_tabs: arranged moved={response.get('moved', 0)}")
    else:
        logger.info("order_tabs: already in order")
