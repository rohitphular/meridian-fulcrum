from __future__ import annotations

from typing import Any
from uuid import UUID

from gspread.exceptions import APIError
from gspread.utils import absolute_range_name, rowcol_to_a1
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

from sheets.contracts import HEADERS
from sheets.requests import SheetsRequests

logger = get_logger(__name__)
_LEGACY_MASTER_SHEETS = {"account_master": "accounts", "category_master": "categories", "subscription_master": "subscriptions", "transaction_master": "transactions"}
_SYNC_FIELDS = {"sync_status", "sync_date", "sync_notes"}
_SYNC_STATUSES = {"in-sync", "create-pending", "create-failed", "update-pending", "update-failed"}


class SnapshotSheetsClient(SheetsClient):
    """Pinned-library adapter: validated snapshots and buffered sync acknowledgements.

    Reads raw numeric cells (not currency-formatted display strings). Rechecks the
    source before acknowledgements. Sheets has no compare-and-swap; operators must
    still avoid concurrent edits during extraction, especially the final write.
    """

    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None:
        self._read_requests = SheetsRequests()
        self._write_requests = SheetsRequests()
        # Opening the spreadsheet also consumes a Sheets read request.
        self._read_requests.call(lambda: super(SnapshotSheetsClient, self).__init__(service_account_file, spreadsheet_id, is_readonly=False))
        self._snapshots: dict[str, list[dict[str, Any]]] = {}
        self._headers: dict[str, list[str]] = {}
        self._pending: dict[str, list[tuple[int, int, list[Any]]]] = {}

    def _ensure_sheets_exist(self, names: list[str]) -> None:
        metadata = self._read_requests.call(lambda: self._ss.fetch_sheet_metadata(params={"fields": "sheets.properties.title"}))
        titles = {sheet["properties"]["title"] for sheet in metadata["sheets"]}
        for name in names:
            legacy_name = _LEGACY_MASTER_SHEETS.get(name)
            if name in titles and legacy_name in titles:
                logger.error(f"_ensure_sheets_exist: master_sheet_name_collision={name} action=reconcile_legacy_{legacy_name}_and_{name}_tabs_before_retrying")
                raise ValueError(f"master_sheet_name_collision:{name}")
            if name not in titles:
                action = f"create_or_import_tab_or_set_entities.{name}.enabled_false_in_config.yaml"
                if name in _LEGACY_MASTER_SHEETS:
                    action = f"run_migrateMasterSheetNames_in_expense_tracker_for_legacy_tabs_or_{action}"
                logger.error(f"_ensure_sheets_exist: missing_enabled_sheet={name} action={action}")
                raise ValueError(f"missing_enabled_sheet:{name}")

    def _read_snapshots(self, names: list[str]) -> dict[str, tuple[list[str], list[dict[str, Any]]]]:
        # The shared client exposes no raw-value/header API; keep that integration
        # in this adapter and pin its version in uv.lock.
        if not names:
            return {}
        # Whole-tab ranges include new rows/columns, even beyond the original grid.
        # One batch reads every enabled tab; never do worksheet metadata/header/page
        # requests per tab inside the per-account commit guard.
        ranges = [absolute_range_name(name) for name in names]
        try:
            response = self._read_requests.call(
                lambda: self._ss.values_batch_get(ranges, params={"majorDimension": "ROWS", "valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "FORMATTED_STRING"})
            )
        except APIError as error:
            if error.response.status_code == 400:
                # A tab may have been removed after initial metadata validation.
                self._ensure_sheets_exist(names)
            raise
        value_ranges = response.get("valueRanges", [])
        if len(value_ranges) != len(names):
            raise ValueError("sheet_snapshot_range_count_mismatch")
        return {name: self._parse_snapshot(name, cells.get("values", [])) for name, cells in zip(names, value_ranges, strict=True)}

    @staticmethod
    def _parse_snapshot(name: str, values: list[list[Any]]) -> tuple[list[str], list[dict[str, Any]]]:
        headers = values[0] if values else []
        legacy_type_headers = set(HEADERS["account_types"]) - {"is_loan", "detail_sheet"}
        if name == "account_types" and len(headers) == len(legacy_type_headers) and set(headers) == legacy_type_headers:
            logger.error("_parse_snapshot: entity=account_types error=account_types_migration_required action=import_complete_updated_account_types_csv_in_expense_tracker_configure")
            raise ValueError("account_types_migration_required")
        if len(headers) != len(set(headers)) or set(headers) != set(HEADERS[name]):
            raise ValueError(f"sheet_header_mismatch:{name}")
        rows = []
        for row_number, raw in enumerate(values[1:], start=2):
            if len(raw) > len(headers):
                raise ValueError(f"sheet_row_wider_than_headers:{name}")
            # Interior blanks stay in the response and retain physical row numbers.
            cells = list(raw) + [""] * (len(headers) - len(raw))
            record = dict(zip(headers, cells))
            record["_sheet_row_num"] = row_number
            rows.append(record)
        return headers, rows

    def capture(self, names: list[str]) -> None:
        before = self.get_modified_time()
        self._ensure_sheets_exist(names)
        for name, (headers, rows) in self._read_snapshots(names).items():
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
            if str(row.get("sync_status") or "").strip() not in _SYNC_STATUSES:
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

    @staticmethod
    def _same_snapshot(current: list[dict[str, Any]], expected: list[dict[str, Any]]) -> bool:
        """Compare raw scalar cell types as well as values: False must not equal 0."""
        if len(current) != len(expected):
            return False
        for actual_row, original_row in zip(current, expected, strict=True):
            if actual_row.keys() != original_row.keys():
                return False
            for field, original_value in original_row.items():
                actual_value = actual_row[field]
                if type(actual_value) is not type(original_value) or actual_value != original_value:
                    return False
        return True

    def assert_unchanged(self) -> None:
        """Check every captured tab, also used before committing detail writes."""
        snapshots = self._read_snapshots(list(self._snapshots))
        for name, expected in self._snapshots.items():
            headers, current = snapshots[name]
            if headers != self._headers[name] or not self._same_snapshot(current, expected):
                raise RuntimeError(f"sheet_changed_before_acknowledgement:{name}")

    def flush_pending(self) -> None:
        if not self._pending:
            self.assert_unchanged()
            return
        ranges = []
        for name, updates in self._pending.items():
            for row_number, column, values in updates:
                ranges.append({"range": absolute_range_name(name, rowcol_to_a1(row_number, column)), "values": [values]})

        def write_acknowledgements() -> None:
            # Run AFTER write backoff, before every attempt. A concurrent edit
            # during a quota wait must not receive a stale in-sync acknowledgement.
            self.assert_unchanged()
            self._ss.values_batch_update(body={"valueInputOption": "RAW", "data": ranges})

        # One write for all tabs avoids partial acknowledgement between tabs.
        self._write_requests.call(write_acknowledgements)
        self._pending.clear()
        logger.info("flush_pending: complete=true")
