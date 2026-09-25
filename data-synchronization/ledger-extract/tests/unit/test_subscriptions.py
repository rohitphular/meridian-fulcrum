from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import Mock

import pytest

import database.subscriptions as database_subscriptions
import transforms.subscriptions as subscriptions


def subscription_row(**changes: Any) -> dict[str, Any]:
    return {
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "subscription_name": "Monthly bill",
        "subscription_amount_local": "12.345",
        "frequency": "monthly",
        "day_of_month": "15",
        "source_account": "11111111-1111-4111-8111-111111111111",
        "tx_type": "money-out",
        "major_category": "living",
        "minor_category": "utilities",
        "record_status": "active",
        "sync_status": "create-pending",
        "subscription_start_date_local": "2026-09-23 10:00:00",
        "subscription_timezone_local": "Europe/London",
        **changes,
    }


def test_subscription_dates_have_explicit_offset_for_timestamptz() -> None:
    typed = subscriptions.transform(subscription_row())
    assert typed["subscription_start_date_local"].astimezone(timezone.utc) == datetime(2026, 9, 23, 9, tzinfo=timezone.utc)


def test_optional_start_and_timezone_remain_absent() -> None:
    typed = subscriptions.transform(subscription_row(subscription_start_date_local="", subscription_timezone_local=""))
    assert typed["subscription_start_date_local"] is None
    assert typed["subscription_timezone_local"] is None


@pytest.mark.parametrize(
    "changes, error",
    [
        ({"subscription_timezone_local": ""}, "missing_subscription_timezone_local"),
        ({"subscription_timezone_local": "Invalid/Zone"}, "invalid_subscription_timezone_local"),
        ({"subscription_end_date_local": "2026-09-22 10:00:00"}, "end_before_start"),
        ({"subscription_start_date_local": "2026-03-29 01:30:00"}, "nonexistent_local_time"),
        ({"subscription_start_date_local": "2026-10-25 01:30:00"}, "ambiguous_local_time"),
        ({"subscription_start_date_local": "2026-09-23 10:00:00Z"}, "expected_local_datetime_without_offset"),
    ],
)
def test_invalid_subscription_dates_fail(changes: dict[str, str], error: str) -> None:
    with pytest.raises(ValueError, match=error):
        subscriptions.transform(subscription_row(**changes))


@pytest.mark.parametrize("amount", ["NaN", "Infinity", "-1", "0", "1_000", "1,000", "12bad", True, "0x10", "١٢.٥", "1e٢"])
def test_invalid_subscription_amounts_fail(amount: str) -> None:
    with pytest.raises(ValueError):
        subscriptions.transform(subscription_row(subscription_amount_local=amount))


@pytest.mark.parametrize(
    "changes",
    [
        {"frequency": "weekly", "day_of_week": ""},
        {"frequency": "weekly", "day_of_week": "8"},
        {"day_of_month": "32"},
        {"day_of_month": "1.5"},
        {"frequency": "monthly", "day_of_month": ""},
        {"day_of_month": "1_0"},
        {"day_of_week": "0_1"},
        {"day_of_month": "١٥"},
        {"frequency": "weekly", "day_of_week": "٢"},
    ],
)
def test_schedule_anchors_are_validated(changes: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        subscriptions.transform(subscription_row(**changes))


def test_minor_unit_overflow_is_a_row_failure_and_does_not_abort_next_row(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = Mock()
    monkeypatch.setattr(database_subscriptions, "_lock_identity", lambda *_args: None)
    monkeypatch.setattr(database_subscriptions, "_load_locked_account", lambda *_args: {"11111111-1111-4111-8111-111111111111": ("account-id", "GBP", "current")})
    monkeypatch.setattr(database_subscriptions, "load_decimal_places", lambda _conn: {"GBP": 2})
    monkeypatch.setattr(database_subscriptions, "lookup_category", lambda *_args: "category-id")
    monkeypatch.setattr(database_subscriptions, "resolve_counterparty", lambda *_args: None)
    stored = Mock(return_value=("db-id", datetime.now(timezone.utc)))
    monkeypatch.setattr(database_subscriptions, "_do_upsert", stored)
    flushed = Mock()
    monkeypatch.setattr(database_subscriptions.sheets_subscriptions, "flush", flushed)
    failures = database_subscriptions.upsert_subscriptions(
        conn,
        Mock(),
        [subscription_row(subscription_amount_local="1e1000000"), subscription_row(id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")],
        {"11111111-1111-4111-8111-111111111111": ("account-id", "GBP", "current")},
    )
    assert failures == 1
    conn.rollback.assert_called_once()
    conn.commit.assert_called_once()
    assert stored.call_args.args[2]["amount_local"] == 1235
    assert flushed.call_args.args[1] == "subscription_master"
    assert len(flushed.call_args.args[2]) == 2


def test_deleted_to_active_restore_uses_same_upsert_path(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = Mock()
    monkeypatch.setattr(database_subscriptions, "_lock_identity", lambda *_args: None)
    monkeypatch.setattr(database_subscriptions, "_load_locked_account", lambda *_args: {"11111111-1111-4111-8111-111111111111": ("account-id", "GBP", "current")})
    monkeypatch.setattr(database_subscriptions, "load_decimal_places", lambda _conn: {})
    monkeypatch.setattr(database_subscriptions, "_resolve_dependencies", lambda *_args: {})
    stored = Mock(return_value=("same-id", datetime.now(timezone.utc)))
    monkeypatch.setattr(database_subscriptions, "_do_upsert", stored)
    monkeypatch.setattr(database_subscriptions.sheets_subscriptions, "flush", Mock())
    assert database_subscriptions.upsert_subscriptions(conn, Mock(), [subscription_row(sync_status="update-pending")], {}) == 0
    assert stored.call_args.args[1]["record_status"] == "active"
    conn.commit.assert_called_once()


def test_duplicate_source_ids_fail_before_any_database_writes() -> None:
    conn = Mock()
    with pytest.raises(ValueError, match="duplicate_source_id"):
        database_subscriptions.upsert_subscriptions(conn, Mock(), [subscription_row(), subscription_row()], {})
    conn.cursor.assert_not_called()


def test_subscription_account_reference_uuid_is_canonicalized() -> None:
    uppercase = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    typed = subscriptions.transform(subscription_row(source_account=uppercase))
    assert typed["account_id_sheet"] == uppercase.lower()


def test_invalid_subscription_account_reference_fails() -> None:
    with pytest.raises(ValueError, match="invalid_source_account"):
        subscriptions.transform(subscription_row(source_account="not-a-uuid"))


@pytest.mark.parametrize(
    "classification",
    [
        {"tx_type": "", "major_category": "", "minor_category": ""},
        {"tx_type": "money-in", "major_category": "", "minor_category": ""},
        {"tx_type": "", "major_category": "living", "minor_category": "utilities"},
    ],
)
def test_optional_classification_is_preserved_without_category_lookup(classification: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    typed = subscriptions.transform(subscription_row(**classification))
    lookup = Mock()
    monkeypatch.setattr(database_subscriptions, "lookup_category", lookup)
    monkeypatch.setattr(database_subscriptions, "resolve_counterparty", lambda *_args: None)
    deps = database_subscriptions._resolve_dependencies(Mock(), typed, {typed["account_id_sheet"]: ("account-id", "GBP", "current")}, {"GBP": 2})
    assert deps["category_id"] is None
    lookup.assert_not_called()
    for field, value in classification.items():
        assert typed[field] == (value or None)


def test_complete_unknown_classification_still_rejects_broken_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    typed = subscriptions.transform(subscription_row())
    monkeypatch.setattr(database_subscriptions, "lookup_category", lambda *_args: None)
    with pytest.raises(ValueError, match="category_not_found"):
        database_subscriptions._resolve_dependencies(Mock(), typed, {typed["account_id_sheet"]: ("account-id", "GBP", "current")}, {"GBP": 2})


def test_optional_direction_still_rejects_invalid_value() -> None:
    with pytest.raises(ValueError, match="invalid_tx_type"):
        subscriptions.transform(subscription_row(tx_type="transfer"))


@pytest.mark.parametrize("identity", ["not-a-uuid", "123", "", None])
def test_subscription_identity_must_be_a_uuid(identity: Any) -> None:
    with pytest.raises(ValueError, match="invalid_id|id_required"):
        subscriptions.transform(subscription_row(id=identity))


def test_subscription_identity_and_source_audits_are_stable() -> None:
    typed = subscriptions.transform(subscription_row(id="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", created_at="source-created", updated_at="source-updated"))
    assert typed["subscription_id"] == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    assert "created_at" not in typed and "updated_at" not in typed


def test_case_variant_duplicates_fail_before_database_access() -> None:
    conn = Mock()
    with pytest.raises(ValueError, match="duplicate_source_id"):
        database_subscriptions.upsert_subscriptions(conn, Mock(), [subscription_row(), subscription_row(id="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")], {})
    conn.cursor.assert_not_called()


@pytest.mark.parametrize("frequency", ["quarterly", "annual"])
def test_long_cadences_require_an_explicit_start_anchor(frequency: str) -> None:
    with pytest.raises(ValueError, match="missing_subscription_start_date_local"):
        subscriptions.transform(subscription_row(frequency=frequency, subscription_start_date_local=""))
    assert subscriptions.transform(subscription_row(frequency=frequency))["subscription_start_date_local"] is not None


@pytest.mark.parametrize("value", [0, False, "Invalid/Zone"])
def test_invalid_timezone_is_not_replaced_by_a_default(value: Any) -> None:
    with pytest.raises(ValueError, match="invalid_subscription_timezone_local"):
        subscriptions.transform(subscription_row(subscription_start_date_local="", subscription_timezone_local=value))


def test_normal_sync_does_not_touch_existing_in_sync_rows() -> None:
    conn, sheets = Mock(), Mock()
    assert database_subscriptions.upsert_subscriptions(conn, sheets, [subscription_row(sync_status="in-sync")], {}) == 0
    conn.cursor.assert_not_called()
    conn.commit.assert_not_called()
    sheets.batch_update_rows.assert_not_called()
