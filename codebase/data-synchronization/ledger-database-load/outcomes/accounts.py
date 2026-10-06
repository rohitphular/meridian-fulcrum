"""Sync outcome for one source row (status, date, notes), recorded in staging and acknowledged to the Sheet later."""

from __future__ import annotations

from typing import Any

_SYNC_STATUS_COL = 14

WriteBack = tuple[int, int, list[str]]


def write_back(sheet_row_num: int, sync_status: str, sync_date: str, sync_notes: str) -> WriteBack:
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date, sync_notes])


def flush(source: Any, sheet_name: str, write_backs: list[WriteBack]) -> None:
    if write_backs:
        source.batch_update_rows(sheet_name, write_backs)
