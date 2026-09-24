from unittest.mock import MagicMock

import pytest

from database import categories
from transforms.categories import transform

CATEGORY_ID = "346e25f6-e004-4bc7-9ffd-581254f6b280"


@pytest.fixture
def category_row() -> dict:
    return {
        "id": CATEGORY_ID,
        "tx_type_key": "money-out",
        "tx_type_label": "Money Out",
        "major_category_key": "food",
        "major_category_label": "Food",
        "minor_category_key": "groceries",
        "minor_category_label": "Groceries",
        "record_status": "active",
        "source_account_mandatory": True,
        "target_account_mandatory": "FALSE",
        "is_subscription_eligible": "Yes",
        "source_account_types": "current, investment",
        "target_account_types": "",
        "sync_status": "create-pending",
    }


def test_category_uuid_booleans_and_natural_key_are_preserved(category_row: dict) -> None:
    typed = transform(category_row)
    assert typed["id"] == CATEGORY_ID
    assert typed["source_account_mandatory"] is True
    assert typed["target_account_mandatory"] is False
    assert typed["is_subscription_eligible"] is True
    assert typed["natural_key"] == "money-out|food|groceries"


@pytest.mark.parametrize("field,value", [("id", "wrong"), ("source_account_mandatory", "probably"), ("tx_type_key", "transfer"), ("record_status", "disabled")])
def test_invalid_categories_fail_before_database_work(category_row: dict, field: str, value: str) -> None:
    category_row[field] = value
    with pytest.raises(ValueError):
        transform(category_row)


def test_investment_hint_expands_all_investment_subtypes_without_duplicates() -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect = [[("shares",), ("pension",)], [("shares",)]]
    assert categories._resolve_account_types(conn, "investment, stocks_shares, investment") == ["shares", "pension"]
    assert "account_type_key = %s" in cursor.execute.call_args_list[0].args[0]
    assert "account_subtype_key = %s" in cursor.execute.call_args_list[1].args[0]


def test_unknown_hint_fails_atomically_and_reports_failure(category_row: dict) -> None:
    conn, sheet = MagicMock(), MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    assert categories.upsert_categories(conn, sheet, [category_row], 1) == 1
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    assert not any("INSERT" in call.args[0] or "DELETE" in call.args[0] for call in cursor.execute.call_args_list)
    assert sheet.batch_update_rows.call_args.args[0] == "category_master"
    assert sheet.batch_update_rows.call_args.args[1][0][2][0] == "create-failed"


def test_master_and_hint_changes_rollback_together(category_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(categories, "_resolve_account_types", lambda conn, value: [])
    monkeypatch.setattr(categories, "_insert_category", lambda conn, typed: CATEGORY_ID)
    monkeypatch.setattr(categories, "_replace_join_rows", MagicMock(side_effect=ValueError("categories: bad mapping")))
    assert categories.upsert_categories(conn, sheet, [category_row], 1) == 1
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()


def test_database_outage_is_not_swallowed(category_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(categories, "_resolve_account_types", MagicMock(side_effect=RuntimeError("connection lost")))
    with pytest.raises(RuntimeError, match="connection lost"):
        categories.upsert_categories(conn, sheet, [category_row], 1)
    conn.rollback.assert_called_once()
    sheet.batch_update_rows.assert_not_called()


def test_referenced_classification_key_change_is_rejected_before_mutation(category_row: dict) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("money-out", "food", "groceries"), (True,)]
    category_row["major_category_key"] = "travel"
    with pytest.raises(ValueError, match="classification keys have transaction/subscription references"):
        categories._insert_category(conn, transform(category_row))
    assert not any("INSERT" in call.args[0] or "DELETE" in call.args[0] for call in cursor.execute.call_args_list)


def test_category_label_change_does_not_reinterpret_classification(category_row: dict) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("money-out", "food", "groceries"), (CATEGORY_ID,)]
    category_row["major_category_label"] = "Food & Drink"
    assert categories._insert_category(conn, transform(category_row)) == CATEGORY_ID
    assert len(cursor.execute.call_args_list) == 2
    assert cursor.execute.call_args.args[1][4] == "Food & Drink"


def test_unreferenced_category_keys_can_change_without_changing_identity(category_row: dict) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("money-out", "food", "groceries"), (False,), (CATEGORY_ID,)]
    category_row["minor_category_key"] = "market"
    assert categories._insert_category(conn, transform(category_row)) == CATEGORY_ID
    assert cursor.execute.call_args.args[1][0] == CATEGORY_ID
    assert cursor.execute.call_args.args[1][5] == "market"


@pytest.mark.parametrize("raw", ["stocks_shares", " STOCKS_SHARES "])
def test_legacy_hint_resolves_only_to_eligible_canonical_catalog_key(raw: str) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect = [[], [("shares",)]]
    assert categories._resolve_account_types(conn, raw) == ["shares"]
    assert cursor.execute.call_args.args[1] == ("stocks-shares",)
    for call in cursor.execute.call_args_list:
        assert "is_sheet_managed" in call.args[0]
        assert "sync_status='in-sync'" in call.args[0]
        assert "record_status IN ('active','locked')" in call.args[0]


def test_unknown_legacy_hint_is_not_silently_dropped() -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    with pytest.raises(ValueError, match="unknown, inactive, or unsynced"):
        categories._resolve_account_types(conn, "unknown_type")


def test_legacy_and_canonical_hints_produce_one_reference() -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect = [[], [("shares",)], [("shares",)]]
    assert categories._resolve_account_types(conn, "stocks_shares, stocks-shares") == ["shares"]


def test_unchanged_dependency_check_releases_locks_without_sheet_ack(category_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    category_row["sync_status"] = "in-sync"
    monkeypatch.setattr(categories, "_investment_mapping_changed", lambda conn, row: False)
    assert categories.upsert_categories(conn, sheet, [category_row], 1) == 0
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    sheet.batch_update_rows.assert_not_called()
