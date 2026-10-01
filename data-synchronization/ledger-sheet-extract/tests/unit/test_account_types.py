from unittest.mock import MagicMock

import pytest

import core.extractor as extractor
from database import account_types
from sheets.contracts import HEADERS
from transforms.account_types import transform

_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def _row(**changes: object) -> dict:
    return {
        "id": _ID,
        "account_type_key": "asset",
        "account_type_label": "Asset",
        "account_subtype_key": "custom-savings",
        "account_subtype_label": "Custom savings",
        "description": "",
        "detail_sheet": "",
        "record_status": "active",
        "sync_status": "create-pending",
        **changes,
    }


@pytest.mark.parametrize(
    "field,value",
    [("id", "bad"), ("account_type_key", "unknown group"), ("account_subtype_key", "Bad key"), ("account_subtype_key", "bad__key"), ("account_subtype_label", " "), ("record_status", "disabled")],
)
def test_configuration_values_are_validated_before_database_work(field: str, value: object) -> None:
    conn, sheet = MagicMock(), MagicMock()
    assert account_types.upsert_account_types(conn, sheet, [_row(**{field: value})]) == 1
    conn.cursor.assert_not_called()
    conn.commit.assert_not_called()
    sheet.batch_update_rows.assert_called_once()
    assert sheet.batch_update_rows.call_args.args[0] == "account_types"
    assert sheet.batch_update_rows.call_args.args[1][0][1] == HEADERS["account_types"].index("sync_status") + 1
    assert sheet.batch_update_rows.call_args.args[1][0][2][0] == "create-failed"


def test_configuration_preserves_id_and_ignores_source_audit_values() -> None:
    typed = transform(_row(id=_ID.upper(), record_status="locked", created_at="old-source-time", updated_at="bad-audit", sync_date="bad-sync", sync_notes="private"))
    assert typed["id"] == _ID
    assert typed["record_status"] == "locked"
    assert typed["description"] is None
    assert not set(typed).intersection({"created_at", "updated_at", "sync_status", "sync_date", "sync_notes"})
    assert HEADERS["account_types"][-6:] == ("record_status", "sync_status", "sync_date", "sync_notes", "created_at", "updated_at")


def test_in_sync_account_type_skips_without_database_writes() -> None:
    conn, sheet = MagicMock(), MagicMock()
    assert account_types.upsert_account_types(conn, sheet, [_row(sync_status="in-sync")]) == 0
    conn.cursor.assert_not_called()
    conn.commit.assert_not_called()
    sheet.batch_update_rows.assert_not_called()


@pytest.mark.parametrize("failure", [ValueError("sheet_header_mismatch:account_types"), RuntimeError("sheet_changed_before_acknowledgement:account_types")])
def test_guard_failure_rolls_back_without_acknowledging_stale_source(failure: Exception, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(account_types, "_store", MagicMock())
    with pytest.raises(type(failure), match=str(failure)):
        account_types.upsert_account_types(conn, sheet, [_row()], before_commit=MagicMock(side_effect=failure))
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    sheet.batch_update_rows.assert_not_called()


def test_old_configs_do_not_implicitly_read_new_configuration_tab() -> None:
    assert not extractor.entity_enabled("account_types", {"entities": {}})
    with pytest.raises(ValueError, match="entity_enabled_must_be_boolean:account_types"):
        extractor.entity_enabled("account_types", {"entities": {"account_types": {"enabled": "false"}}})


def test_unmanaged_seed_with_matching_uuid_still_requires_source_claim() -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    rows = [_row(sync_status="in-sync", _sheet_row_num=2)]
    extractor.LedgerExtractJob._recover_missing_rows(conn, "account_types", rows)
    cursor.execute.assert_called_once_with("SELECT id FROM account_types WHERE is_sheet_managed AND sync_status = 'in-sync'")
    assert rows[0]["sync_status"] == "create-pending"


def test_group_tokens_derive_from_the_source_catalog() -> None:
    rows = [_row(account_type_key="custom-group", account_subtype_key="custom-item"), _row(id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", account_type_key="another", account_subtype_key="custom-group")]
    with pytest.raises(ValueError, match="account_subtype_key_conflicts_with_type_key"):
        account_types.upsert_account_types(MagicMock(), MagicMock(), rows)


@pytest.mark.parametrize("changes", [{"description": 123}, {"description": False}, {"detail_sheet": "unknown"}])
def test_account_type_source_matches_gas_policy_and_text_validation(changes: dict) -> None:
    with pytest.raises(ValueError, match="invalid_"):
        transform(_row(**changes))


def test_catalog_labels_and_processing_policies_are_source_values() -> None:
    typed = transform(_row(account_type_key="configured-group", account_type_label="Configured Group", detail_sheet="account_deposit"))
    assert typed["account_type_key"] == "configured-group"
    assert typed["account_type_label"] == "Configured Group"
    assert "is_loan" not in typed
    assert typed["detail_sheet"] == "account_deposit"


def test_catalog_family_labels_must_agree_before_any_database_write() -> None:
    conn = MagicMock()
    with pytest.raises(ValueError, match="account_type_labels_inconsistent"):
        account_types.upsert_account_types(conn, MagicMock(), [_row(), _row(id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", account_subtype_key="different", account_type_label="Other")])
    conn.cursor.assert_not_called()
