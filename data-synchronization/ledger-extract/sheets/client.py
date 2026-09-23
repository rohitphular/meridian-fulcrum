from __future__ import annotations

from typing import Any
from uuid import UUID

from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

from sheets.contracts import HEADERS

logger = get_logger(__name__)
_BATCH_SIZE = 1000
_SYNC_FIELDS = {"sync_status", "sync_date", "sync_notes"}
_SYNC_STATUSES = {"in-sync", "create-pending", "create-failed", "update-pending", "update-failed"}


class SnapshotSheetsClient(SheetsClient):
    """Pinned-library adapter: validated snapshots and buffered sync acknowledgements.

    Reads raw numeric cells (not currency-formatted display strings). Rechecks the
    source before acknowledgements. Sheets has no compare-and-swap; operators must
    still avoid concurrent edits during extraction, especially the final write.
    """

    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None:
        super().__init__(service_account_file, spreadsheet_id, is_readonly=False)
        self._snapshots: dict[str, list[dict[str, Any]]] = {}
        self._headers: dict[str, list[str]] = {}
        self._pending: dict[str, list[tuple[int, int, list[Any]]]] = {}

    def _read_snapshot(self, name: str) -> tuple[list[str], list[dict[str, Any]]]:
        # The shared client exposes no raw-value/header API; keep that integration
        # in this adapter and pin its version in uv.lock.
        worksheet = self._with_retry(lambda: self._ss.worksheet(name))
        headers = self._with_retry(lambda: worksheet.row_values(1))
        if len(headers) != len(set(headers)) or set(headers) != set(HEADERS[name]):
            raise ValueError(f"sheet_header_mismatch:{name}")
        rows = []
        row_start = 2
        while row_start <= worksheet.row_count:
            row_end = min(row_start + _BATCH_SIZE - 1, worksheet.row_count)
            raw_rows = self._with_retry(lambda: worksheet.get(f"{row_start}:{row_end}", value_render_option="UNFORMATTED_VALUE", date_time_render_option="FORMATTED_STRING"))
            for index, raw in enumerate(raw_rows):
                if len(raw) > len(headers):
                    raise ValueError(f"sheet_row_wider_than_headers:{name}")
                values = list(raw) + [""] * (len(headers) - len(raw))
                record = dict(zip(headers, values))
                record["_sheet_row_num"] = row_start + index
                rows.append(record)
            # Sheets trims trailing blanks in each response. A short page is
            # not EOF: there can be populated rows after a sparse page.
            row_start += _BATCH_SIZE
        return headers, rows

    def capture(self, names: list[str]) -> None:
        before = self.get_modified_time()
        for name in names:
            headers, rows = self._read_snapshot(name)
            self._validate_rows(name, rows)
            self._headers[name] = headers
            self._snapshots[name] = rows
        if self.get_modified_time() != before:
            raise RuntimeError("sheet_changed_during_snapshot")

    @staticmethod
    def _validate_rows(name: str, rows: list[dict[str, Any]]) -> None:
        seen = set()
        for row in rows:
            if not any(value not in (None, "") for key, value in row.items() if key != "_sheet_row_num"):
                continue
            try:
                identity = str(UUID(str(row["id"]).strip()))
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError(f"invalid_sheet_id:{name}:row={row['_sheet_row_num']}") from error
            if identity in seen:
                raise ValueError(f"duplicate_sheet_id:{name}:row={row['_sheet_row_num']}")
            seen.add(identity)
            if str(row["sync_status"]).strip() not in _SYNC_STATUSES:
                raise ValueError(f"invalid_sync_status:{name}:row={row['_sheet_row_num']}")

    def snapshot_rows(self, name: str) -> list[dict[str, Any]]:
        # Copies isolate handler normalisation/reconciliation from the source guard.
        records = [row.copy() for row in self._snapshots[name] if any(value not in (None, "") for key, value in row.items() if key != "_sheet_row_num")]
        for record in records:
            record["id"] = str(UUID(str(record["id"]).strip()))
            for reference in ("parent_tx_id", "account_id"):
                if str(record.get(reference) or "").strip():
                    try:
                        record[reference] = str(UUID(str(record[reference]).strip()))
                    except ValueError:
                        pass  # The row handler reports invalid references to sync_notes.
        return records

    def batch_update_rows(self, name: str, updates: list[tuple[int, int, list[Any]]]) -> None:
        """Queue committed successes or validation failures; never source audit fields."""
        for row_number, column, values in updates:
            fields = HEADERS[name][column - 1 : column - 1 + len(values)]
            if len(fields) != len(values) or not set(fields) <= _SYNC_FIELDS:
                raise ValueError("writeback_must_only_touch_sync_fields")
            if not any(row["_sheet_row_num"] == row_number for row in self._snapshots[name]):
                raise ValueError("writeback_row_outside_snapshot")
            for field, value in zip(fields, values):
                self._pending.setdefault(name, []).append((row_number, self._headers[name].index(field) + 1, [value]))

    def flush_pending(self) -> None:
        # Check all enabled tabs before acknowledging any; another tab may contain
        # an account/category edit that invalidates a committed dependent row.
        for name, expected in self._snapshots.items():
            headers, current = self._read_snapshot(name)
            if headers != self._headers[name] or current != expected:
                raise RuntimeError(f"sheet_changed_before_acknowledgement:{name}")
        for name, updates in self._pending.items():
            # Recheck each tab immediately before its write to narrow the race.
            headers, current = self._read_snapshot(name)
            if headers != self._headers[name] or current != self._snapshots[name]:
                raise RuntimeError(f"sheet_changed_before_acknowledgement:{name}")
            super().batch_update_rows(name, updates)
        self._pending.clear()
        logger.info("flush_pending: complete=true")
