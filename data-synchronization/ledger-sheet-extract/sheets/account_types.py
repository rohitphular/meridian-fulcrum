"""Account-type acknowledgements only update sync state, never source audit data."""

from typing import Any

from sheets.contracts import HEADERS


def flush(sheets_client: Any, updates: list[tuple[int, str, str, str]]) -> None:
    if updates:
        column = HEADERS["account_types"].index("sync_status") + 1
        sheets_client.batch_update_rows("account_types", [(row, column, [status, timestamp, notes]) for row, status, timestamp, notes in updates])
