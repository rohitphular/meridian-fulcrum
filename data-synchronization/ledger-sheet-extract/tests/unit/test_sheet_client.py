"""Capture and read behaviour of the Sheets client (structure only: contracts live in ledger-database-load)."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from gspread.exceptions import APIError

from sheets.client import SnapshotSheetsClient, cell_range

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
HEADERS = ["id", "name", "amount", "sync_status", "sync_date", "sync_notes", "created_at"]
DETAIL_TABS = ["account_deposit", "account_liability_credit_card", "account_liability_mortgage"]


def _row(**values: object) -> dict:
    record = dict.fromkeys(HEADERS, "")
    record.update(id=IDENTITY, sync_status="create-pending", _sheet_row_num=2)
    record.update(values)
    return record


def _client() -> SnapshotSheetsClient:
    client = object.__new__(SnapshotSheetsClient)
    client._snapshots = {}
    client._headers = {}
    client._ss = MagicMock()
    client._read_requests = SimpleNamespace(call=lambda request: request())
    client._write_requests = SimpleNamespace(call=lambda request: request())
    return client


def _tabs(client: SnapshotSheetsClient, names: list[str], rows: list[list] | None = None) -> None:
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": name}} for name in names]}
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [HEADERS, *(rows or [])]} for _ in names]}


@pytest.mark.parametrize("bad_id", ["", "not-a-uuid"])
def test_invalid_identity_fails_before_staging(bad_id: str) -> None:
    with pytest.raises(ValueError, match="invalid_sheet_id"):
        SnapshotSheetsClient._validate_rows("account_master", [_row(id=bad_id)])


def test_duplicate_uuid_variants_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate_sheet_id"):
        SnapshotSheetsClient._validate_rows("account_master", [_row(), _row(id=IDENTITY.upper())])


@pytest.mark.parametrize("name", DETAIL_TABS)
def test_rows_require_a_known_sync_status(name: str) -> None:
    for status in (None, "", "synced", "unsupported"):
        with pytest.raises(ValueError, match=f"invalid_sync_status:{name}"):
            SnapshotSheetsClient._validate_rows(name, [_row(sync_status=status)])
    for status in ("create-pending", "create-failed", "update-pending", "update-failed", "in-sync"):
        SnapshotSheetsClient._validate_rows(name, [_row(sync_status=status)])


def test_same_uuid_in_two_tabs_is_allowed() -> None:
    client = _client()
    _tabs(client, ["account_liability_mortgage", "account_liability_personal_loan"], [[IDENTITY, "x", 1, "create-pending"]])
    client.capture(["account_liability_mortgage", "account_liability_personal_loan"])
    assert client.snapshot("account_liability_mortgage")[1][0]["id"] == IDENTITY
    assert client.snapshot("account_liability_personal_loan")[1][0]["id"] == IDENTITY


def test_snapshot_keeps_physical_rows_and_raw_cell_types() -> None:
    client = _client()
    _tabs(client, ["account_master"], [[], [IDENTITY, "Bank", 1234.5, "create-pending", "", "", True]])
    client.capture(["account_master"])
    headers, rows = client.snapshot("account_master")
    assert headers == HEADERS
    assert rows[0]["_sheet_row_num"] == 3
    assert rows[0]["amount"] == 1234.5 and rows[0]["created_at"] is True
    assert client._ss.values_batch_get.call_args.kwargs["params"]["valueRenderOption"] == "UNFORMATTED_VALUE"


def test_sparse_page_does_not_hide_later_rows_and_blank_rows_are_dropped() -> None:
    client = _client()
    _tabs(client, ["account_master"], [*([[]] * 1000), [IDENTITY, "", "", "create-pending"]])
    client.capture(["account_master"])
    rows = client.snapshot("account_master")[1]
    assert [row["_sheet_row_num"] for row in rows] == [1002]
    assert client._ss.values_batch_get.call_count == 1


def test_empty_tab_is_allowed_but_missing_id_or_sync_columns_and_duplicates_are_not() -> None:
    client = _client()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [HEADERS]}]}
    assert client._read_snapshots(["subscription_master"])["subscription_master"][1] == []
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [["id", "sync_status"]]}]}
    with pytest.raises(ValueError, match="sheet_header_missing_id_or_sync_columns:subscription_master"):
        client._read_snapshots(["subscription_master"])
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [[*HEADERS, "name"]]}]}
    with pytest.raises(ValueError, match="sheet_header_duplicate:subscription_master"):
        client._read_snapshots(["subscription_master"])


def test_row_wider_than_headers_is_rejected() -> None:
    client = _client()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [HEADERS, [IDENTITY, *[""] * len(HEADERS)]]}]}
    with pytest.raises(ValueError, match="sheet_row_wider_than_headers:account_master"):
        client._read_snapshots(["account_master"])


def test_capture_reads_all_enabled_tabs_in_one_request() -> None:
    client = _client()
    names = ["category_master", "account_master", *DETAIL_TABS]
    _tabs(client, names)
    client.capture(names)
    client._ss.fetch_sheet_metadata.assert_called_once()
    client._ss.values_batch_get.assert_called_once()
    assert client._ss.values_batch_get.call_args.args[0] == [f"'{name}'" for name in names]
    client._ss.worksheet.assert_not_called()
    client._ss.values_batch_update.assert_not_called()


def test_capture_never_reads_the_drive_modified_time(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    monkeypatch.setattr(client, "get_modified_time", MagicMock(side_effect=AssertionError("capture must not check the modified time")))
    _tabs(client, ["account_master"], [[IDENTITY, "", "", "create-pending"]])
    client.capture(["account_master"])
    assert client.snapshot("account_master")[1][0]["id"] == IDENTITY


def test_incomplete_batch_response_fails_closed() -> None:
    client = _client()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [HEADERS]}]}
    with pytest.raises(ValueError, match="sheet_snapshot_range_count_mismatch"):
        client._read_snapshots(["account_master", "category_master"])


def test_tab_removed_before_a_read_reports_the_missing_tab() -> None:
    client = _client()
    response = MagicMock(status_code=400)
    response.json.return_value = {"error": {"code": 400, "message": "range missing"}}
    client._ss.values_batch_get.side_effect = APIError(response)
    client._ss.fetch_sheet_metadata.return_value = {"sheets": []}
    with pytest.raises(ValueError, match="missing_enabled_sheet:account_master"):
        client.read_tabs(["account_master"])
    client._ss.values_batch_update.assert_not_called()


def test_missing_enabled_detail_tab_reports_configuration_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": "account_master"}}]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    with pytest.raises(ValueError, match="^missing_enabled_sheet:account_deposit$"):
        client.capture(["account_deposit"])
    logger.error.assert_called_once_with("_ensure_sheets_exist: missing_enabled_sheet=account_deposit action=create_or_import_tab_or_set_entities.account_deposit.enabled_false_in_config.yaml")


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_missing_canonical_master_requires_explicit_rename_without_legacy_fallback(canonical: str, legacy: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": legacy}}]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    with pytest.raises(ValueError, match=f"^missing_enabled_sheet:{canonical}$"):
        client.capture([canonical])
    assert "run_migrateMasterSheetNames_in_expense_tracker_for_legacy_tabs" in logger.error.call_args.args[0]
    client._ss.values_batch_get.assert_not_called()


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_enabled_master_name_collision_aborts_before_values_reads(canonical: str, legacy: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": title}} for title in (canonical, legacy)]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    with pytest.raises(ValueError, match=f"^master_sheet_name_collision:{canonical}$"):
        client.capture([canonical])
    client._ss.values_batch_get.assert_not_called()
    assert f"reconcile_legacy_{legacy}_and_{canonical}_tabs_before_retrying" in logger.error.call_args.args[0]
    assert client._snapshots == {}


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_disabled_master_name_collision_does_not_block_other_enabled_tabs(canonical: str, legacy: str) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": title}} for title in (canonical, legacy, "account_deposit")]}
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [HEADERS]}]}
    client.capture(["account_deposit"])
    assert set(client._snapshots) == {"account_deposit"}


def test_write_with_retry_replans_before_every_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    from sheets.requests import SheetsRequests

    client = _client()
    response = MagicMock(status_code=429)
    response.json.return_value = {"error": {"code": 429, "message": "quota"}}
    client._ss.values_batch_update.side_effect = [APIError(response), None]
    client._write_requests = SheetsRequests()
    monkeypatch.setattr("sheets.requests.time.sleep", lambda _: None)
    monkeypatch.setattr("sheets.requests.time.monotonic", MagicMock(side_effect=range(0, 10000, 100)))
    plans = [[cell_range("account_master", 2, 4, "in-sync")], []]
    plan = MagicMock(side_effect=plans)
    client.write_with_retry(plan)
    # The second plan (after the quota wait) found nothing safe to write, so nothing more was sent.
    assert plan.call_count == 2
    client._ss.values_batch_update.assert_called_once()
    assert client._ss.values_batch_update.call_args.kwargs["body"]["valueInputOption"] == "RAW"


def test_cell_range_addresses_one_cell() -> None:
    assert cell_range("account_master", 3, 4, "in-sync") == {"range": "'account_master'!D3", "values": [["in-sync"]]}
