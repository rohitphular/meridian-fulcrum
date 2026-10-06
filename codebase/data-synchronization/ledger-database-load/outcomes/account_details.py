"""Queue only source sync metadata; source audit timestamps remain untouched."""

from typing import Any

from core.account_detail_contracts import CONTRACTS


def flush(source: Any, sheet_name: str, updates: list[tuple[int, str, str, str]]) -> None:
    if not updates:
        return
    headers = CONTRACTS[sheet_name].headers
    column = headers.index("sync_status") + 1
    if headers[column - 1 : column + 2] != ("sync_status", "sync_date", "sync_notes"):
        raise ValueError("invalid_account_detail_sync_contract")
    source.batch_update_rows(sheet_name, [(row, column, [status, sync_date, notes]) for row, status, sync_date, notes in updates])
