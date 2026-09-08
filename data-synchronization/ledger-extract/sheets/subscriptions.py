from __future__ import annotations

from py_google_workspace.gsheets import SheetsClient

_CREATED_AT_COL = 14   # success write-back starts here (created_at)
_SYNC_STATUS_COL = 15  # failure write-back starts here (sync_status)

WriteBack = tuple[int, int, list[str]]


def write_back_success(
    sheet_row_num: int,
    created_at: str,
    sync_status: str,
    sync_date: str,
    sync_notes: str,
    updated_at: str,
) -> WriteBack:
    return (sheet_row_num, _CREATED_AT_COL, [created_at, sync_status, sync_date, sync_notes, updated_at])


def write_back_failure(
    sheet_row_num: int,
    sync_status: str,
    sync_date: str,
    sync_notes: str,
) -> WriteBack:
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date, sync_notes])


def flush(sheets_client: SheetsClient, sheet_name: str, write_backs: list[WriteBack]) -> None:
    if write_backs:
        sheets_client.batch_update_rows(sheet_name, write_backs)
