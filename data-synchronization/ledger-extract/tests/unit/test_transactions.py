from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from unittest.mock import Mock

import pytest

import database.transactions as database_transactions
import transforms.transactions as transactions
from transforms.dates import local_datetime
from transforms.financial import to_minor_units


def transaction_row(**changes: Any) -> dict[str, Any]:
    return {
        "id": "parent",
        "tx_date_local": "2026-09-23 10:20:30",
        "tx_timezone_local": "Europe/London",
        "parent_tx_id": "",
        "tx_type": "money-out",
        "account_id": "11111111-1111-4111-8111-111111111111",
        "tx_amount_local": "12.34",
        "major_category": "living",
        "minor_category": "food",
        "record_status": "active",
        "sync_status": "create-pending",
        **changes,
    }


def test_transaction_preserves_local_wall_time_and_uses_utc_date() -> None:
    typed = transactions.transform(transaction_row(tx_date_local="2026-09-23 00:20:30", tx_timezone_local="Asia/Kolkata"))
    assert typed["tx_date_time_base"] == datetime(2026, 9, 22, 18, 50, 30, tzinfo=timezone.utc)
    local_time, utc_day, local_day = database_transactions._extract_datetime_fields(typed["tx_date_time_base"], typed["tx_timezone_local"])
    assert local_time == datetime(2026, 9, 23, 0, 20, 30)
    assert (utc_day, local_day) == ("TUESDAY", "WEDNESDAY")


@pytest.mark.parametrize(
    "date_value, message",
    [
        ("2026-09-23", "expected_local_datetime_without_offset"),
        ("2026-09-23 10:20:30+05:30", "expected_local_datetime_without_offset"),
        ("2026-02-30 10:20:30", "invalid_datetime"),
        ("2026-03-29 01:30:00", "nonexistent_local_time"),
        ("2026-10-25 01:30:00", "ambiguous_local_time"),
    ],
)
def test_invalid_or_ambiguous_dates_fail_explicitly(date_value: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        transactions.transform(transaction_row(tx_date_local=date_value))


def test_invalid_timezone_fails() -> None:
    with pytest.raises(ValueError, match="invalid_timezone"):
        local_datetime("2026-09-23 10:20:30", "Unknown/Timezone", "date")


@pytest.mark.parametrize("empty_timezone", ["", "  ", None])
def test_legacy_blank_transaction_timezone_uses_documented_london_default(empty_timezone: Any) -> None:
    typed = transactions.transform(transaction_row(tx_timezone_local=empty_timezone))
    assert typed["tx_timezone_local"] == "Europe/London"
    assert typed["tx_date_time_base"].hour == 9


@pytest.mark.parametrize("amount", ["NaN", "sNaN", "Infinity", "-Infinity", "0", "-1", "garbage"])
def test_bad_transaction_amounts_fail(amount: str) -> None:
    with pytest.raises(ValueError):
        transactions.transform(transaction_row(tx_amount_local=amount))


@pytest.mark.parametrize("latitude, longitude", [("91", "0"), ("0", "181"), ("0", ""), ("NaN", "0"), ("0", "Infinity")])
def test_invalid_coordinates_fail_before_sql(latitude: str, longitude: str) -> None:
    with pytest.raises(ValueError):
        transactions.transform(transaction_row(user_location_latitude=latitude, user_location_longitude=longitude))


def test_self_parent_is_rejected() -> None:
    with pytest.raises(ValueError, match="self_parent_reference"):
        transactions.transform(transaction_row(parent_tx_id="parent"))


@pytest.mark.parametrize(
    "amount, precision, expected",
    [
        ("1.005", 2, 101),
        ("-1.005", 2, -101),
        ("0.000000001", 9, 1),
        ("9223372036854775807", 0, 9223372036854775807),
        ("-9223372036854775808", 0, -9223372036854775808),
        ("1e-1000000", 9, 0),
    ],
)
def test_minor_unit_rounding_and_signed_bigint_bounds(amount: str, precision: int, expected: int) -> None:
    assert to_minor_units(Decimal(amount), precision) == expected


@pytest.mark.parametrize("amount", ["9223372036854775808", "-9223372036854775809", "1e1000000", "NaN", "Infinity"])
def test_unsafe_minor_units_rejected(amount: str) -> None:
    with pytest.raises(ValueError):
        to_minor_units(Decimal(amount), 0)


@pytest.mark.parametrize("precision", [-1, 19, True, "2"])
def test_invalid_currency_precision_rejected(precision: Any) -> None:
    with pytest.raises(ValueError, match="invalid_decimal_places"):
        to_minor_units(Decimal("1"), precision)


def rate_connection(rate: Decimal | None) -> tuple[Mock, Mock]:
    conn = Mock()
    cursor = Mock()
    conn.cursor.return_value.__enter__ = Mock(return_value=cursor)
    conn.cursor.return_value.__exit__ = Mock(return_value=False)
    cursor.fetchone.return_value = None if rate is None else ("rate-id", rate)
    return conn, cursor


def test_conversion_uses_rounded_local_minor_units_and_exact_date() -> None:
    conn, cursor = rate_connection(Decimal("75"))
    assert database_transactions._resolve_amount(conn, Decimal("12.345"), "GBP", date(2026, 9, 22), {"GBP": 2, "XAU": 9}) == (1235, 164666667, "rate-id", Decimal("75"))
    assert cursor.execute.call_args.args[1] == ("GBP", date(2026, 9, 22))


@pytest.mark.parametrize("rate", [None, Decimal("0"), Decimal("-1"), Decimal("NaN"), Decimal("Infinity")])
def test_missing_or_invalid_rates_fail_without_fallback(rate: Decimal | None) -> None:
    conn, _ = rate_connection(rate)
    with pytest.raises(ValueError):
        database_transactions._resolve_amount(conn, Decimal("1"), "GBP", date(2026, 9, 22), {"GBP": 2, "XAU": 9})


def test_base_amount_rounding_to_zero_is_rejected() -> None:
    conn, _ = rate_connection(Decimal("99999999999"))
    with pytest.raises(ValueError, match="amount_rounds_to_zero_in_base_units"):
        database_transactions._resolve_amount(conn, Decimal("0.01"), "GBP", date(2026, 9, 22), {"GBP": 2, "XAU": 9})


def test_base_amount_overflow_is_rejected() -> None:
    conn, _ = rate_connection(Decimal("0.00000001"))
    with pytest.raises(ValueError, match="bigint_overflow"):
        database_transactions._resolve_amount(conn, Decimal("1000"), "GBP", date(2026, 9, 22), {"GBP": 2, "XAU": 9})


def test_xau_shortcut_checks_metadata() -> None:
    conn = Mock()
    assert database_transactions._resolve_amount(conn, Decimal("0.000000001"), "XAU", date(2026, 9, 22), {"XAU": 9}) == (1, 1, None, Decimal(1))
    conn.cursor.assert_not_called()
    with pytest.raises(ValueError, match="invalid_xau_decimal_places"):
        database_transactions._resolve_amount(conn, Decimal("1"), "XAU", date(2026, 9, 22), {"XAU": 6})


@pytest.mark.parametrize("raw", ["Alice:NaN;Bob:100", "Alice:Infinity", "Alice:99.9999", "Alice:50;Alice:50", "Alice;Bob:50", "Alice;", "Alice:0;Bob:100"])
def test_invalid_beneficiary_allocations_fail(raw: str) -> None:
    with pytest.raises(ValueError):
        database_transactions._parse_beneficiaries(raw)


def test_beneficiaries_preserve_exact_total_at_database_precision() -> None:
    shares = database_transactions._parse_beneficiaries("Alice;Bob;Carol")
    assert shares == [("Alice", Decimal("33.3333")), ("Bob", Decimal("33.3333")), ("Carol", Decimal("33.3334"))]
    assert sum(percentage for _, percentage in shares) == 100


def test_child_is_ordered_after_parent_without_losing_physical_rows() -> None:
    parent = transaction_row(_sheet_row_num=19)
    child = transaction_row(id="child", parent_tx_id="parent", account_id="22222222-2222-4222-8222-222222222222", tx_type="money-in", _sheet_row_num=3)
    assert database_transactions._group_rows([child, parent]) == [[(19, parent), (3, child)]]


def test_source_cycles_fail_before_database_writes() -> None:
    conn = Mock()
    with pytest.raises(ValueError, match="cyclic_parent_reference"):
        database_transactions.upsert_transactions(conn, Mock(), [transaction_row(parent_tx_id="child"), transaction_row(id="child", parent_tx_id="parent")], {})
    conn.cursor.assert_not_called()


def test_child_failure_rolls_back_parent_and_marks_both_rows_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = Mock()
    monkeypatch.setattr(database_transactions, "load_decimal_places", lambda _conn: {"GBP": 2, "XAU": 9})
    monkeypatch.setattr(database_transactions, "retire_unused_references", lambda _conn: None)
    visited = []

    def upsert(_conn: Any, typed: dict[str, Any], _accounts: dict[str, Any], _decimals: dict[str, int]) -> tuple[str, datetime]:
        visited.append(typed["transaction_id"])
        if typed["transaction_id"] == "child":
            raise ValueError("transactions: currency_rate_not_found")
        return "parent-id", datetime.now(timezone.utc)

    monkeypatch.setattr(database_transactions, "_upsert_row", upsert)
    flushed = Mock()
    monkeypatch.setattr(database_transactions.sheets_transactions, "flush", flushed)
    child = transaction_row(id="child", parent_tx_id="parent", tx_type="money-in", account_id="22222222-2222-4222-8222-222222222222")
    failures = database_transactions.upsert_transactions(conn, Mock(), [child, transaction_row()], {})
    assert failures == 2
    assert visited == ["parent", "child"]
    conn.commit.assert_not_called()
    conn.rollback.assert_called_once()
    assert len(flushed.call_args.args[2]) == 2


def test_unexpected_database_error_still_flushes_completed_results(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = Mock()
    monkeypatch.setattr(database_transactions, "load_decimal_places", lambda _conn: {})
    monkeypatch.setattr(database_transactions, "_validate_stored_relationships", lambda *_args: None)
    monkeypatch.setattr(database_transactions, "_upsert_row", Mock(side_effect=[("id", datetime.now(timezone.utc)), RuntimeError("connection lost")]))
    flushed = Mock()
    monkeypatch.setattr(database_transactions.sheets_transactions, "flush", flushed)
    with pytest.raises(RuntimeError, match="connection lost"):
        database_transactions.upsert_transactions(conn, Mock(), [transaction_row(), transaction_row(id="second")], {})
    conn.commit.assert_called_once()
    conn.rollback.assert_called_once()
    assert len(flushed.call_args.args[2]) == 1


def test_date_at_supported_range_boundary_fails_as_a_row_error() -> None:
    with pytest.raises(ValueError, match="datetime_out_of_range"):
        local_datetime("0001-01-01 00:00:00", "Asia/Kolkata", "date")


def test_account_reference_uuid_is_canonicalized() -> None:
    uppercase = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    typed = transactions.transform(transaction_row(account_id=uppercase))
    assert typed["account_id_sheet"] == uppercase.lower()


def test_invalid_account_reference_is_a_validation_error() -> None:
    with pytest.raises(ValueError, match="invalid_account_id"):
        transactions.transform(transaction_row(account_id="not-a-uuid"))
