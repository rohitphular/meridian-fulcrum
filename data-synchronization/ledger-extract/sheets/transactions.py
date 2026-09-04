from __future__ import annotations

from py_google_workspace.gsheets import SheetsClient

_SYNC_STATUS_COL = 20

WriteBack = tuple[int, int, list[str]]


def write_back_success(
    sheet_row_num: int,
    sync_status: str,
    sync_date_time: str,
    sync_notes: str,
    created_at: str,
    updated_at: str,
) -> WriteBack:
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date_time, sync_notes, created_at, updated_at])


def write_back_failure(
    sheet_row_num: int,
    sync_status: str,
    sync_date_time: str,
    sync_notes: str,
) -> WriteBack:
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date_time, sync_notes])


def flush(sheets_client: SheetsClient, sheet_name: str, write_backs: list[WriteBack]) -> None:
    if write_backs:
        sheets_client.batch_update_rows(sheet_name, write_backs)
