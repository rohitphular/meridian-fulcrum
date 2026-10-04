"""Sync outcome for one report_master row, recorded in staging and acknowledged to the Sheet later."""

from __future__ import annotations

from typing import Any

from core import report_contract

WriteBack = tuple[int, int, list[str]]


def write_back(sheet_row_num: int, sync_status: str, sync_date: str, sync_notes: str) -> WriteBack:
    # 1-based position of sync_status in the contract's column order.
    return (sheet_row_num, report_contract.columns().index("sync_status") + 1, [sync_status, sync_date, sync_notes])


def flush(source: Any, sheet_name: str, write_backs: list[WriteBack]) -> None:
    if write_backs:
        source.batch_update_rows(sheet_name, write_backs)
