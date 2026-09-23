import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from py_google_workspace.gsheets import SheetsClient

import sheets.subscriptions as subscription_sheet
import sheets.transactions as transaction_sheet
from sheets.client import SnapshotSheetsClient
from sheets.contracts import HEADERS

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
    return client


def test_contract_matches_current_gas_schemas() -> None:
    api = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"
    for plural, singular in (("categories", "category"), ("accounts", "account"), ("transactions", "transaction"), ("subscriptions", "subscription")):
        fields = re.findall(r"sheet_column_name:\s*'([^']+)'\s*,\s*sheet_column_position:\s*(\d+)", (api / f"{singular}-schema.gs").read_text())
        assert tuple(field for field, _ in sorted(fields, key=lambda pair: int(pair[1]))) == HEADERS[plural]


@pytest.mark.parametrize("bad_id", ["", "not-a-uuid"])
def test_invalid_identity_fails_before_writes(bad_id: str) -> None:
    with pytest.raises(ValueError, match="invalid_sheet_id"):
        SnapshotSheetsClient._validate_rows("accounts", [_row("accounts", id=bad_id)])


def test_duplicate_uuid_variants_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate_sheet_id"):
        SnapshotSheetsClient._validate_rows("accounts", [_row("accounts"), _row("accounts", id=IDENTITY.upper())])


def test_snapshot_preserves_physical_rows_and_raw_values() -> None:
    client = _client()
    worksheet = MagicMock()
    worksheet.row_values.return_value = list(HEADERS["accounts"])
    raw = [""] * len(HEADERS["accounts"])
    raw[0], raw[9], raw[13] = IDENTITY, 1234.5, "create-pending"
    worksheet.row_count = 3
    worksheet.get.return_value = [[], raw]
    client._ss = MagicMock()
    client._ss.worksheet.return_value = worksheet
    headers, rows = client._read_snapshot("accounts")
    client._headers["accounts"], client._snapshots["accounts"] = headers, rows
    assert client.snapshot_rows("accounts")[0]["_sheet_row_num"] == 3
    assert client.snapshot_rows("accounts")[0]["opening_value_local"] == 1234.5
    assert worksheet.get.call_args.kwargs["value_render_option"] == "UNFORMATTED_VALUE"


def test_reordered_headers_write_only_sync_columns(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    headers = list(reversed(HEADERS["transactions"]))
    row = _row("transactions", created_at="original", updated_at="original")
    client._headers["transactions"], client._snapshots["transactions"] = headers, [row]
    monkeypatch.setattr(client, "_read_snapshot", lambda _: (headers, deepcopy([row])))
    write = MagicMock()
    monkeypatch.setattr(SheetsClient, "batch_update_rows", write)
    update = transaction_sheet.write_back_success(2, "in-sync", "now", "", "replace-created", "replace-updated")
    client.batch_update_rows("transactions", [update])
    write.assert_not_called()
    client.flush_pending()
    updates = write.call_args.args[1]
    assert {headers[column - 1] for _, column, _ in updates} == {"sync_status", "sync_date", "sync_notes"}
    assert not any(value[0].startswith("replace") for _, _, value in updates)


def test_subscriptions_do_not_overwrite_source_timestamps() -> None:
    assert subscription_sheet.write_back_success(2, "original", "in-sync", "now", "", "updated") == (2, 15, ["in-sync", "now", ""])


def test_concurrent_edit_blocks_acknowledgement(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    headers, original = list(HEADERS["accounts"]), _row("accounts")
    client._headers["accounts"], client._snapshots["accounts"] = headers, [original]
    client.batch_update_rows("accounts", [(2, 14, ["in-sync", "now", ""])])
    edited = {**original, "account_name": "changed"}
    monkeypatch.setattr(client, "_read_snapshot", lambda _: (headers, [edited]))
    write = MagicMock()
    monkeypatch.setattr(SheetsClient, "batch_update_rows", write)
    with pytest.raises(RuntimeError, match="sheet_changed_before"):
        client.flush_pending()
    write.assert_not_called()


def test_empty_valid_sheet_allowed_but_bad_headers_rejected() -> None:
    client = _client()
    client._ss = MagicMock()
    worksheet = client._ss.worksheet.return_value
    worksheet.row_values.return_value = list(HEADERS["subscriptions"])
    worksheet.row_count = 1
    worksheet.get.return_value = []
    assert client._read_snapshot("subscriptions")[1] == []
    worksheet.row_values.return_value = ["id", "sync_status"]
    with pytest.raises(ValueError, match="sheet_header_mismatch"):
        client._read_snapshot("subscriptions")


def test_source_change_during_capture_aborts(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client()
    monkeypatch.setattr(client, "get_modified_time", MagicMock(side_effect=[datetime(2026, 1, 1, tzinfo=timezone.utc), datetime(2026, 1, 2, tzinfo=timezone.utc)]))
    monkeypatch.setattr(client, "_read_snapshot", lambda _: (list(HEADERS["accounts"]), [_row("accounts")]))
    with pytest.raises(RuntimeError, match="sheet_changed_during_snapshot"):
        client.capture(["accounts"])


def test_sparse_page_does_not_hide_later_rows() -> None:
    client = _client()
    worksheet = MagicMock()
    worksheet.row_values.return_value = list(HEADERS["accounts"])
    worksheet.row_count = 1002
    raw = [""] * len(HEADERS["accounts"])
    raw[0], raw[13] = IDENTITY, "create-pending"
    worksheet.get.side_effect = [[], [raw]]
    client._ss = MagicMock()
    client._ss.worksheet.return_value = worksheet
    _, rows = client._read_snapshot("accounts")
    assert len(rows) == 1
    assert rows[0]["_sheet_row_num"] == 1002
    assert worksheet.get.call_count == 2


def test_uuid_normalisation_preserves_transfer_groups_without_mutating_snapshot() -> None:
    client = _client()
    original = _row("transactions", id=IDENTITY.upper(), parent_tx_id="{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}")
    client._snapshots["transactions"] = [original]
    canonical = client.snapshot_rows("transactions")[0]
    assert canonical["id"] == IDENTITY
    assert canonical["parent_tx_id"] == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    assert original["id"] == IDENTITY.upper()
