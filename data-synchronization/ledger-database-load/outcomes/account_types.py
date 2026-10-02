"""Account-type acknowledgements only update sync state, never source audit data."""

from typing import Any

from core.source_contracts import HEADERS


def flush(source: Any, updates: list[tuple[int, str, str, str]]) -> None:
    if updates:
        column = HEADERS["account_types"].index("sync_status") + 1
        source.batch_update_rows("account_types", [(row, column, [status, timestamp, notes]) for row, status, timestamp, notes in updates])
