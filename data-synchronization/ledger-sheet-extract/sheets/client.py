from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import UUID

from gspread.exceptions import APIError
from gspread.utils import absolute_range_name, rowcol_to_a1
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

from sheets.requests import SheetsRequests

logger = get_logger(__name__)
_LEGACY_MASTER_SHEETS = {"account_master": "accounts", "category_master": "categories", "subscription_master": "subscriptions", "transaction_master": "transactions"}
SYNC_FIELDS = ("sync_status", "sync_date", "sync_notes")
_REQUIRED_HEADERS = ("id", *SYNC_FIELDS)
_SYNC_STATUSES = {"in-sync", "create-pending", "create-failed", "update-pending", "update-failed"}


class SnapshotSheetsClient(SheetsClient):
    """Pinned-library adapter: one batched read of the enabled tabs, and sync-cell writes.

    Reads raw numeric cells (not currency-formatted display strings). Each tab's
    business columns are checked against the GAS contract by ledger-database-load;
    here only the structure the staging and acknowledge steps rely on is checked.
    """

    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None:
        self._read_requests = SheetsRequests()
        self._write_requests = SheetsRequests()
        # Opening the spreadsheet also consumes a Sheets read request.
        self._read_requests.call(lambda: super(SnapshotSheetsClient, self).__init__(service_account_file, spreadsheet_id, is_readonly=False))
        self._snapshots: dict[str, list[dict[str, Any]]] = {}
        self._headers: dict[str, list[str]] = {}

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
        if len(headers) != len(set(headers)):
            raise ValueError(f"sheet_header_duplicate:{name}")
        if any(field not in headers for field in _REQUIRED_HEADERS):
            raise ValueError(f"sheet_header_missing_id_or_sync_columns:{name}")
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
        self._ensure_sheets_exist(names)
        for name, (headers, rows) in self._read_snapshots(names).items():
            self._validate_rows(name, rows)
            self._headers[name] = headers
            self._snapshots[name] = rows

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

    def snapshot(self, name: str) -> tuple[list[str], list[dict[str, Any]]]:
        """Headers and raw rows of a captured tab, exactly as read (fully blank rows dropped)."""
        rows = [row for row in self._snapshots[name] if any(value not in (None, "") for key, value in row.items() if key != "_sheet_row_num")]
        return list(self._headers[name]), rows

    def read_tabs(self, names: list[str]) -> dict[str, tuple[list[str], list[dict[str, Any]]]]:
        """A fresh read of the tabs (no validation), for the acknowledge step."""
        return self._read_snapshots(names)

    def write_with_retry(self, plan: Callable[[], list[dict[str, Any]]]) -> None:
        """Write the cell ranges `plan` returns, re-planning before every attempt.

        The plan re-reads the Sheet, so a row edited during a quota wait is never
        given a stale acknowledgement.
        """

        def attempt() -> None:
            ranges = plan()
            if ranges:
                self._ss.values_batch_update(body={"valueInputOption": "RAW", "data": ranges})

        self._write_requests.call(attempt)


def cell_range(name: str, row_number: int, column: int, value: Any) -> dict[str, Any]:
    return {"range": absolute_range_name(name, rowcol_to_a1(row_number, column)), "values": [[value]]}
