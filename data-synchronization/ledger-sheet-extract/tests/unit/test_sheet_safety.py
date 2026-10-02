import re
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from gspread.exceptions import APIError
from gspread.utils import a1_to_rowcol

import sheets.subscriptions as subscription_sheet
import sheets.transactions as transaction_sheet
from core.account_detail_contracts import SYNC_DETAIL_SHEETS
from sheets.client import SnapshotSheetsClient
from sheets.contracts import DETAIL_HEADERS, HEADERS

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _row(sheet: str, **values: object) -> dict:
    record = dict.fromkeys(HEADERS[sheet], "")
    record.update(id=IDENTITY, sync_status="create-pending", _sheet_row_num=2)
    record.update(values)
    return record


def _client() -> SnapshotSheetsClient:
    client = object.__new__(SnapshotSheetsClient)
    client._snapshots = {}
    client._headers = {}
    client._pending = {}
    client._ss = MagicMock()
    client._read_requests = SimpleNamespace(call=lambda request: request())
    client._write_requests = SimpleNamespace(call=lambda request: request())
    return client


def test_contract_matches_current_gas_schemas() -> None:
    api = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"
    for plural, singular in (("category_master", "category"), ("account_master", "account"), ("transaction_master", "transaction"), ("subscription_master", "subscription")):
        fields = re.findall(r"sheet_column_name:\s*'([^']+)'\s*,\s*sheet_column_position:\s*(\d+)", (api / f"{singular}-schema.gs").read_text())
        assert tuple(field for field, _ in sorted(fields, key=lambda pair: int(pair[1]))) == HEADERS[plural]


def test_detail_headers_match_current_import_registry() -> None:
    registry = Path(__file__).resolve().parents[4] / "expense-tracker" / "api" / "import-registry.gs"
    source = registry.read_text()
    for name, headers in DETAIL_HEADERS.items():
        declaration = re.search(rf"\b{re.escape(name)}:\s*\{{([\s\S]*?)\n  \}},", source)
        assert declaration is not None, name
        columns = re.search(r"\bcolumns:\s*\[([^\]]+)\]", declaration.group(1))
        assert columns is not None, name
        assert tuple(re.findall(r"'([^']+)'", columns.group(1))) == headers, name


def test_property_snapshot_rejects_unmigrated_rate_reference_header() -> None:
    name = "account_investment_property"
    headers = list(HEADERS[name])
    assert len(headers) == 23
    assert headers[16] == "property_address"
    headers.insert(16, "evaluation_currency_rate_id")
    client = _client()
    client._ss = MagicMock()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [headers]}]}
    with pytest.raises(ValueError, match="sheet_header_mismatch:account_investment_property"):
        client._read_snapshots([name])[name]


def test_legacy_account_type_snapshot_requires_explicit_source_upgrade() -> None:
    legacy = [field for field in HEADERS["account_types"] if field != "detail_sheet"]
    with pytest.raises(ValueError, match="^account_types_migration_required$"):
        SnapshotSheetsClient._parse_snapshot("account_types", [legacy])
    # An unrelated malformed schema must not be diagnosed as the known migration.
    with pytest.raises(ValueError, match="^sheet_header_mismatch:account_types$"):
        SnapshotSheetsClient._parse_snapshot("account_types", [legacy[:-1]])


def test_retired_is_loan_column_requires_sheet_cleanup() -> None:
    headers = list(HEADERS["account_types"])
    headers.insert(headers.index("detail_sheet"), "is_loan")
    with pytest.raises(ValueError, match="^account_types_is_loan_column_present$"):
        SnapshotSheetsClient._parse_snapshot("account_types", [headers])


def test_separate_loan_tables_allow_same_uuid_in_different_tabs(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    monkeypatch.setattr(client, "_ensure_sheets_exist", lambda _: None)
    monkeypatch.setattr(client, "_read_snapshots", lambda names: {name: (list(HEADERS[name]), [{"id": IDENTITY, "sync_status": "create-pending", "_sheet_row_num": 2}]) for name in names})
    client.capture(["account_liability_mortgage", "account_liability_personal_loan"])
    assert client.snapshot_rows("account_liability_mortgage")[0]["id"] == IDENTITY
    assert client.snapshot_rows("account_liability_personal_loan")[0]["id"] == IDENTITY


def test_detail_source_change_is_detected_without_pending_acknowledgements(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    name = "account_deposit"
    original = {"id": IDENTITY, "interest_rate": "2.5", "_sheet_row_num": 2}
    client._snapshots[name] = [original]
    client._headers[name] = list(HEADERS[name])
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {name: (list(HEADERS[name]), [{**original, "interest_rate": "3"}])})
    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement:account_deposit"):
        client.assert_unchanged()


@pytest.mark.parametrize("bad_id", ["", "not-a-uuid"])
def test_invalid_identity_fails_before_writes(bad_id: str) -> None:
    with pytest.raises(ValueError, match="invalid_sheet_id"):
        SnapshotSheetsClient._validate_rows("account_master", [_row("account_master", id=bad_id)])


def test_duplicate_uuid_variants_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate_sheet_id"):
        SnapshotSheetsClient._validate_rows("account_master", [_row("account_master"), _row("account_master", id=IDENTITY.upper())])


def test_snapshot_preserves_physical_rows_and_raw_values() -> None:
    client = _client()
    raw = [""] * len(HEADERS["account_master"])
    raw[0], raw[9], raw[13] = IDENTITY, 1234.5, "create-pending"
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS["account_master"]), [], raw]}]}
    headers, rows = client._read_snapshots(["account_master"])["account_master"]
    client._headers["account_master"], client._snapshots["account_master"] = headers, rows
    assert client.snapshot_rows("account_master")[0]["_sheet_row_num"] == 3
    assert client.snapshot_rows("account_master")[0]["opening_value_local"] == 1234.5
    assert client._ss.values_batch_get.call_args.kwargs["params"]["valueRenderOption"] == "UNFORMATTED_VALUE"


def test_reordered_headers_write_only_sync_columns(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    headers = list(reversed(HEADERS["transaction_master"]))
    row = _row("transaction_master", created_at="original", updated_at="original")
    client._headers["transaction_master"], client._snapshots["transaction_master"] = headers, [row]
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {name: (headers, deepcopy([row])) for name in client._snapshots})
    write = client._ss.values_batch_update
    update = transaction_sheet.write_back_success(2, "in-sync", "now", "", "replace-created", "replace-updated")
    client.batch_update_rows("transaction_master", [update])
    write.assert_not_called()
    client.flush_pending()
    payload = write.call_args.kwargs["body"]
    assert payload["valueInputOption"] == "RAW"
    updates = [(*a1_to_rowcol(update["range"].split("!")[1]), update["values"][0]) for update in payload["data"]]
    assert {headers[column - 1] for _, column, _ in updates} == {"sync_status", "sync_date", "sync_notes"}
    assert not any(value[0].startswith("replace") for _, _, value in updates)


def test_subscriptions_do_not_overwrite_source_timestamps() -> None:
    assert subscription_sheet.write_back_success(2, "original", "in-sync", "now", "", "updated") == (2, 15, ["in-sync", "now", ""])


def test_concurrent_edit_blocks_acknowledgement(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    headers, original = list(HEADERS["account_master"]), _row("account_master")
    client._headers["account_master"], client._snapshots["account_master"] = headers, [original]
    client.batch_update_rows("account_master", [(2, 14, ["in-sync", "now", ""])])
    edited = {**original, "account_name": "changed"}
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {"account_master": (headers, [edited])})
    write = client._ss.values_batch_update
    with pytest.raises(RuntimeError, match="sheet_changed_before"):
        client.flush_pending()
    write.assert_not_called()


def test_empty_valid_sheet_allowed_but_bad_headers_rejected() -> None:
    client = _client()
    client._ss = MagicMock()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS["subscription_master"])]}]}
    assert client._read_snapshots(["subscription_master"])["subscription_master"][1] == []
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [["id", "sync_status"]]}]}
    with pytest.raises(ValueError, match="sheet_header_mismatch"):
        client._read_snapshots(["subscription_master"])


def test_missing_enabled_detail_tab_reports_configuration_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss = MagicMock()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": "account_master"}}]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    name = "account_deposit"
    with pytest.raises(ValueError, match=f"^missing_enabled_sheet:{name}$"):
        client.capture([name])
    logger.error.assert_called_once_with(f"_ensure_sheets_exist: missing_enabled_sheet={name} action=create_or_import_tab_or_set_entities.{name}.enabled_false_in_config.yaml")
    assert client._pending == {}


def test_sparse_page_does_not_hide_later_rows() -> None:
    client = _client()
    raw = [""] * len(HEADERS["account_master"])
    raw[0], raw[13] = IDENTITY, "create-pending"
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS["account_master"]), *([[]] * 1000), raw]}]}
    headers, rows = client._read_snapshots(["account_master"])["account_master"]
    client._headers["account_master"], client._snapshots["account_master"] = headers, rows
    assert len(client.snapshot_rows("account_master")) == 1
    assert client.snapshot_rows("account_master")[0]["_sheet_row_num"] == 1002
    assert client._ss.values_batch_get.call_count == 1


def test_uuid_normalisation_preserves_transfer_groups_without_mutating_snapshot() -> None:
    client = _client()
    original = _row("transaction_master", id=IDENTITY.upper(), parent_tx_id="{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}")
    client._snapshots["transaction_master"] = [original]
    canonical = client.snapshot_rows("transaction_master")[0]
    assert canonical["id"] == IDENTITY
    assert canonical["parent_tx_id"] == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    assert original["id"] == IDENTITY.upper()


@pytest.mark.parametrize("original_value,changed_value", [(0, False), (1, True), (False, 0), (True, 1)])
def test_detail_commit_guard_distinguishes_numeric_and_boolean_cells(original_value: object, changed_value: object, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    name = "account_liability_credit_card"
    headers = list(HEADERS[name])
    original = dict.fromkeys(headers, "")
    original.update(id=IDENTITY, account_id=IDENTITY, credit_limit_local=original_value, _sheet_row_num=2)
    client._headers[name], client._snapshots[name] = headers, [original]
    changed = {**original, "credit_limit_local": changed_value}
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {name: (headers, [changed])})
    with pytest.raises(RuntimeError, match=f"sheet_changed_before_acknowledgement:{name}"):
        client.assert_unchanged()


def test_write_retry_rechecks_source_after_quota_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    from sheets.requests import SheetsRequests

    client = _client()
    headers = list(HEADERS["account_master"])
    original = _row("account_master", opening_value_local=0)
    client._headers["account_master"], client._snapshots["account_master"] = headers, [original]
    client.batch_update_rows("account_master", [(2, 14, ["in-sync", "now", ""])])
    changed = {**original, "opening_value_local": False}
    read = MagicMock(side_effect=[{"account_master": (headers, deepcopy([original]))}, {"account_master": (headers, [changed])}])
    monkeypatch.setattr(client, "_read_snapshots", read)
    response = MagicMock(status_code=429)
    response.json.return_value = {"error": {"code": 429, "message": "quota"}}
    client._ss.values_batch_update.side_effect = APIError(response)
    client._write_requests = SheetsRequests()
    # A fake clock avoids real waiting while exercising the actual retry helper.
    monkeypatch.setattr("sheets.requests.time.sleep", lambda _: None)
    monkeypatch.setattr("sheets.requests.time.monotonic", MagicMock(side_effect=range(0, 1000, 100)))
    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement:account_master"):
        client.flush_pending()
    assert read.call_count == 2
    client._ss.values_batch_update.assert_called_once()
    assert client._pending


@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
def test_sync_detail_snapshot_requires_valid_sync_state(name: str) -> None:
    row = _row(name)
    for status in (None, "", "synced", "unsupported"):
        with pytest.raises(ValueError, match=f"invalid_sync_status:{name}"):
            SnapshotSheetsClient._validate_rows(name, [{**row, "sync_status": status}])
    for status in ("create-pending", "create-failed", "update-pending", "update-failed", "in-sync"):
        SnapshotSheetsClient._validate_rows(name, [{**row, "sync_status": status}])


@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
def test_sync_detail_reordered_headers_acknowledge_only_sync_cells(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    headers = list(reversed(HEADERS[name]))
    row = _row(name, record_status="locked", created_at="original-created", updated_at="original-updated")
    client._headers[name], client._snapshots[name] = headers, [row]
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {name: (headers, deepcopy([row])) for name in client._snapshots})
    canonical_sync_column = HEADERS[name].index("sync_status") + 1
    client.batch_update_rows(name, [(2, canonical_sync_column, ["in-sync", "now", ""])])
    write = client._ss.values_batch_update
    client.flush_pending()
    payload = write.call_args.kwargs["body"]
    assert payload["valueInputOption"] == "RAW"
    updates = [(*a1_to_rowcol(update["range"].split("!")[1]), update["values"][0]) for update in payload["data"]]
    assert {headers[column - 1] for _, column, _ in updates} == {"sync_status", "sync_date", "sync_notes"}
    assert not any("original" in str(values) for _, _, values in updates)
    assert row["created_at"] == "original-created"
    assert row["updated_at"] == "original-updated"
    assert row["record_status"] == "locked"


@pytest.mark.parametrize("field", ["record_status", "created_at", "updated_at"])
def test_detail_acknowledgement_rejects_source_audit_and_status_mutation(field: str) -> None:
    client = _client()
    name = "account_deposit"
    client._headers[name], client._snapshots[name] = list(HEADERS[name]), [_row(name)]
    with pytest.raises(ValueError, match="writeback_must_only_touch_sync_fields"):
        client.batch_update_rows(name, [(2, HEADERS[name].index(field) + 1, ["overwrite"])])


def test_capture_and_guards_read_all_enabled_tabs_in_one_request(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    names = ["category_master", "account_master", *sorted(SYNC_DETAIL_SHEETS)]
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": name}} for name in names]}
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS[name])]} for name in names]}
    client.capture(names)
    for _ in range(23):
        client.assert_unchanged()
    client.flush_pending()
    client._ss.fetch_sheet_metadata.assert_called_once()
    assert client._ss.values_batch_get.call_count == 25
    for call in client._ss.values_batch_get.call_args_list:
        assert call.args[0] == [f"'{name}'" for name in names]
    client._ss.worksheet.assert_not_called()
    client._ss.values_batch_update.assert_not_called()


@pytest.mark.parametrize("change", ["append_row", "extra_column", "reorder_header", "raw_type"])
def test_batched_guard_detects_fresh_source_changes(change: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    name = "account_master"
    headers = list(HEADERS[name])
    row = _row(name, opening_value_local=0)
    values = [headers, [row[field] for field in headers]]
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": name}}]}
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": deepcopy(values)}]}
    client.capture([name])
    client.batch_update_rows(name, [(2, 14, ["in-sync", "now", ""])])
    if change == "append_row":
        values.append(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
    elif change == "extra_column":
        values[1].append("new cell beyond captured headers")
    elif change == "reorder_header":
        values[0].reverse()
        values[1].reverse()
    else:
        values[1][headers.index("opening_value_local")] = False
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": values}]}
    with pytest.raises((RuntimeError, ValueError), match="sheet_changed_before_acknowledgement|sheet_row_wider_than_headers"):
        client.flush_pending()
    client._ss.values_batch_update.assert_not_called()
    assert client._pending


def test_incomplete_batch_response_fails_closed() -> None:
    client = _client()
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS["account_master"])]}]}
    with pytest.raises(ValueError, match="sheet_snapshot_range_count_mismatch"):
        client._read_snapshots(["account_master", "category_master"])


def test_removed_tab_during_guard_reports_missing_source(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    name = "account_master"
    headers = list(HEADERS[name])
    client._headers[name], client._snapshots[name] = headers, [_row(name)]
    client.batch_update_rows(name, [(2, 14, ["in-sync", "now", ""])])
    response = MagicMock(status_code=400)
    response.json.return_value = {"error": {"code": 400, "message": "range missing"}}
    client._ss.values_batch_get.side_effect = APIError(response)
    client._ss.fetch_sheet_metadata.return_value = {"sheets": []}
    with pytest.raises(ValueError, match="missing_enabled_sheet:account_master"):
        client.flush_pending()
    client._ss.values_batch_update.assert_not_called()
    assert client._pending


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_missing_canonical_master_requires_explicit_rename_without_legacy_fallback(canonical: str, legacy: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": legacy}}]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    with pytest.raises(ValueError, match=f"^missing_enabled_sheet:{canonical}$"):
        client.capture([canonical])
    assert "run_migrateMasterSheetNames_in_expense_tracker_for_legacy_tabs" in logger.error.call_args.args[0]
    assert canonical in logger.error.call_args.args[0]
    client._ss.values_batch_get.assert_not_called()
    client._ss.values_batch_update.assert_not_called()


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_enabled_master_name_collision_aborts_before_values_reads(canonical: str, legacy: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": title}} for title in (canonical, legacy)]}
    logger = MagicMock()
    monkeypatch.setattr("sheets.client.logger", logger)
    with pytest.raises(ValueError, match=f"^master_sheet_name_collision:{canonical}$"):
        client.capture([canonical])
    client._ss.fetch_sheet_metadata.assert_called_once()
    client._ss.values_batch_get.assert_not_called()
    client._ss.values_batch_update.assert_not_called()
    assert f"reconcile_legacy_{legacy}_and_{canonical}_tabs_before_retrying" in logger.error.call_args.args[0]
    assert client._snapshots == {}


@pytest.mark.parametrize("canonical,legacy", [("account_master", "accounts"), ("category_master", "categories"), ("subscription_master", "subscriptions"), ("transaction_master", "transactions")])
def test_disabled_master_name_collision_does_not_block_other_enabled_tabs(canonical: str, legacy: str, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    client._ss.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": title}} for title in (canonical, legacy, "account_deposit")]}
    client._ss.values_batch_get.return_value = {"valueRanges": [{"values": [list(HEADERS["account_deposit"])]}]}
    client.capture(["account_deposit"])
    client._ss.fetch_sheet_metadata.assert_called_once()
    client._ss.values_batch_get.assert_called_once()
    assert set(client._snapshots) == {"account_deposit"}


def test_account_type_headers_match_dynamic_gas_schema_registry() -> None:
    schema = Path(__file__).resolve().parents[4] / "expense-tracker" / "api" / "account-type-schema.gs"
    fields = re.findall(r"^\s+\['([^']+)',", schema.read_text(), re.MULTILINE)
    assert tuple(fields) == HEADERS["account_types"]


def test_capture_never_reads_the_drive_modified_time(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    monkeypatch.setattr(client, "get_modified_time", MagicMock(side_effect=AssertionError("capture must not check the modified time")))
    monkeypatch.setattr(client, "_ensure_sheets_exist", lambda _: None)
    monkeypatch.setattr(client, "_read_snapshots", lambda _: {"account_master": (list(HEADERS["account_master"]), [_row("account_master")])})
    client.capture(["account_master"])
    assert client._snapshots["account_master"][0]["id"] == _row("account_master")["id"]
