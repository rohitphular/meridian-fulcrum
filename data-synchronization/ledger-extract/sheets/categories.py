from __future__ import annotations

from py_google_workspace.gsheets import SheetsClient

_SYNC_STATUS_COL = 16

WriteBack = tuple[int, int, list]


def write_back(sheet_row_num: int, sync_status: str, sync_date_time: str, sync_notes: str) -> WriteBack:
    """Return a batch update entry for a single row's sync columns.

    Does not call the Sheets API — callers accumulate these and pass them to flush().
    """
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date_time, sync_notes])


def flush(sheets_client: SheetsClient, sheet_name: str, write_backs: list[WriteBack]) -> None:
    """Write all accumulated sync column updates to the sheet in a single API call."""
    if write_backs:
        sheets_client.batch_update_rows(sheet_name, write_backs)
