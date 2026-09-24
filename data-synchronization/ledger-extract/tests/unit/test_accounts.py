from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from database import accounts
from transforms.accounts import transform

ACCOUNT_ID = "346e25f6-e004-4bc7-9ffd-581254f6b280"


@pytest.fixture(autouse=True)
def account_detail_guard(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    guard = MagicMock()
    monkeypatch.setattr(accounts, "validate_account_change", guard)
    return guard


@pytest.fixture
def account_row() -> dict:
    return {
        "id": ACCOUNT_ID,
        "account_name": "Test",
        "legal_entity_name": "Bank",
        "type": "asset",
        "sub_type": "current",
        "account_currency_local": "GBP",
        "local_timezone": "Europe/London",
        "account_opening_date_local": "2020-01-01",
        "account_closing_date_local": "",
        "tracking_start_date_local": "2025-09-15 00:00:00",
        "opening_value_local": "123.455",
        "description": "",
        "record_status": "active",
        "sync_status": "create-pending",
    }


def test_current_sheet_contract_keeps_real_open_and_snapshot_dates_separate(account_row: dict) -> None:
    typed = transform(account_row)
    assert typed["local_currency"] == "GBP"
    assert typed["opening_date_local"] == "2020-01-01"
    assert typed["tracking_start_date_local"] == "2025-09-15 00:00:00"
    assert typed["opening_amount_local_value"] == Decimal("123.455")


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", "not-a-uuid"),
        ("account_currency_local", "G1P"),
        ("opening_value_local", "NaN"),
        ("opening_value_local", "Infinity"),
        ("account_opening_date_local", "2025-02-30"),
        ("account_opening_date_local", "2025-01-01T01:00:00Z"),
        ("local_timezone", "Invalid/Zone"),
        ("tracking_start_date_local", "2025-03-30 01:30:00"),
        ("tracking_start_date_local", "2025-10-26 01:30:00"),
    ],
)
def test_invalid_account_input_is_rejected(account_row: dict, field: str, value: str) -> None:
    account_row[field] = value
    with pytest.raises(ValueError):
        transform(account_row)


@pytest.mark.parametrize("value", ["1_000.25", "١٢٣.٤٥", "１２３.４５", "1e２", "0x10", "0b10", "1 000", True, False])
def test_opening_value_rejects_non_source_decimal_syntax(account_row: dict, value: object) -> None:
    account_row["opening_value_local"] = value
    with pytest.raises(ValueError, match="field=opening_value_local must be a finite decimal number"):
        transform(account_row)


@pytest.mark.parametrize(
    "value,expected",
    [(0, "0"), (12.5, "12.5"), (Decimal("-123.4500"), "-123.45"), (Decimal("1E-100"), "1E-100"), (" +.5 ", "0.5"), ("1.", "1"), ("-2E+2", "-200"), ("0123.45e-2", "1.2345")],
)
def test_opening_value_preserves_numeric_scalars_and_ascii_decimal_notation(account_row: dict, value: object, expected: str) -> None:
    account_row["opening_value_local"] = value
    assert transform(account_row)["opening_amount_local_value"] == Decimal(expected)


def test_invalid_opening_value_writeback_does_not_reveal_source_text(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(accounts, "_load_decimal_places", lambda conn: {"GBP": 2})
    store = MagicMock()
    monkeypatch.setattr(accounts, "_store_account", store)
    account_row["opening_value_local"] = "private account 123_45"
    assert accounts.upsert_accounts(conn, sheet, [account_row], 1) == 1
    store.assert_not_called()
    conn.commit.assert_not_called()
    assert sheet.batch_update_rows.call_args.args[0] == "account_master"
    assert sheet.batch_update_rows.call_args.args[1][0][2][2] == "field=opening_value_local must be a finite decimal number"


def test_liability_sign_is_preserved_and_wrong_sign_rejected(account_row: dict) -> None:
    account_row.update(type="liability", sub_type="credit-card", opening_value_local="-10.005")
    assert transform(account_row)["opening_amount_local_value"] == Decimal("-10.005")
    assert accounts._compute_minor_units(Decimal("-10.005"), "GBP", 2, ("rate", Decimal("100"))) == (-1001, -100100000, "rate")
    account_row["opening_value_local"] = "10"
    with pytest.raises(ValueError, match="nonpositive"):
        transform(account_row)


@pytest.mark.parametrize("account_type,subtype", [("asset", "current"), ("investment", "stocks-shares")])
def test_signed_asset_and_investment_openings_are_preserved(account_row: dict, account_type: str, subtype: str) -> None:
    account_row.update(type=account_type, sub_type=subtype, opening_value_local="-10.005")
    typed = transform(account_row)
    assert typed["opening_amount_local_value"] == Decimal("-10.005")
    assert accounts._compute_minor_units(typed["opening_amount_local_value"], "GBP", 2, ("rate", Decimal("100"))) == (-1001, -100100000, "rate")


def test_fx_converts_rounded_local_storage_amount() -> None:
    assert accounts._compute_minor_units(Decimal("123.455"), "GBP", 2, ("rate", Decimal("100"))) == (12346, 1234600000, "rate")
    assert accounts._compute_minor_units(Decimal("0"), "GBP", 2, None) == (0, 0, None)
    assert accounts._compute_minor_units(Decimal("0.000000001"), "XAU", 9, None) == (1, 1, None)
    with pytest.raises(ValueError, match="XAU"):
        accounts._compute_minor_units(Decimal("1"), "XAU", 2, None)


@pytest.mark.parametrize("value", [Decimal("0"), Decimal("-1"), Decimal("NaN"), Decimal("Infinity")])
def test_invalid_exchange_rates_are_rejected(value: Decimal) -> None:
    with pytest.raises(ValueError, match="positive and finite"):
        accounts._compute_minor_units(Decimal("10"), "GBP", 2, ("rate", value))


def test_snapshot_date_selects_historical_rate(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("type-id",), None, (ACCOUNT_ID,)]
    lookup = MagicMock(return_value=("rate", Decimal("100")))
    monkeypatch.setattr(accounts, "_lookup_rate", lookup)
    accounts._store_account(conn, transform(account_row), {"GBP": 2})
    lookup.assert_called_once_with(conn, "GBP", "XAU", date(2025, 9, 15))
    assert cursor.execute.call_args.args[1][9:11] == (12346, 1234600000)
    assert cursor.execute.call_args.args[1][14] == Decimal("100")


def test_foreign_nonzero_snapshot_requires_date_but_zero_does_not(account_row: dict) -> None:
    account_row.update(account_opening_date_local="", tracking_start_date_local="")
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("type-id",), None]
    with pytest.raises(ValueError, match="set tracking_start_date_local"):
        accounts._store_account(conn, transform(account_row), {"GBP": 2})
    assert not any("INSERT" in call.args[0] or "UPDATE account_master SET" in call.args[0] for call in cursor.execute.call_args_list)
    account_row["opening_value_local"] = "0"
    cursor.fetchone.side_effect = [("type-id",), None, (ACCOUNT_ID,)]
    accounts._store_account(conn, transform(account_row), {"GBP": 2})
    assert cursor.execute.call_args.args[1][9:11] == (0, 0)
    assert cursor.execute.call_args.args[1][14] is None


def test_immutable_changes_do_not_modify_database(account_row: dict) -> None:
    typed = transform(account_row)
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    existing = tuple(12345 if field == "opening_amount_local_value" else typed[field] for field in accounts._IMMUTABLE_FIELDS)
    cursor.fetchone.side_effect = [("type-id",), existing]
    with pytest.raises(ValueError, match="immutable fields differ"):
        accounts._store_account(conn, typed, {"GBP": 2})
    assert not any("UPDATE account_master SET" in call.args[0] for call in cursor.execute.call_args_list)


def test_account_subtype_change_cannot_invalidate_existing_detail_rows(account_row: dict, account_detail_guard: MagicMock) -> None:
    typed = transform(account_row)
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    existing = tuple(12346 if field == "opening_amount_local_value" else typed[field] for field in accounts._IMMUTABLE_FIELDS)
    cursor.fetchone.side_effect = [("type-id",), existing, ("rate-id", Decimal("100"))]
    account_detail_guard.side_effect = ValueError("accounts: subtype conflicts with retained details")
    with pytest.raises(ValueError, match="retained details"):
        accounts._store_account(conn, typed, {"GBP": 2})
    account_detail_guard.assert_called_once_with(conn, ACCOUNT_ID, "current")
    assert not any("UPDATE account_master SET" in call.args[0] for call in cursor.execute.call_args_list)


def test_failed_row_rolls_back_reports_failure_and_preserves_sheet_row(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(accounts, "_load_decimal_places", lambda conn: {"GBP": 2})
    monkeypatch.setattr(accounts, "_store_account", MagicMock(side_effect=ValueError("accounts: invalid reference")))
    account_row["_sheet_row_num"] = 18
    assert accounts.upsert_accounts(conn, sheet, [account_row], 1) == 1
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    writeback = sheet.batch_update_rows.call_args.args[1][0]
    assert writeback[0] == 18
    assert writeback[2][0] == "create-failed"
    assert writeback[2][2] == "invalid reference"


@pytest.mark.parametrize("failure", [ValueError("sheet_header_mismatch:account_master"), RuntimeError("sheet_changed_before_acknowledgement:account_master")])
def test_source_guard_failure_rolls_back_without_acknowledgement(account_row: dict, monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    conn, sheet = MagicMock(), MagicMock()
    monkeypatch.setattr(accounts, "_load_decimal_places", lambda conn: {"GBP": 2})
    store = MagicMock()
    monkeypatch.setattr(accounts, "_store_account", store)
    guard = MagicMock(side_effect=failure)
    with pytest.raises(type(failure), match=str(failure)):
        accounts.upsert_accounts(conn, sheet, [account_row], 1, before_commit=guard)
    store.assert_called_once()
    guard.assert_called_once_with()
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    sheet.batch_update_rows.assert_not_called()


def test_success_is_acknowledged_only_after_source_guard_and_commit(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, sheet = MagicMock(), MagicMock()
    calls = []
    monkeypatch.setattr(accounts, "_load_decimal_places", lambda conn: {"GBP": 2})
    monkeypatch.setattr(accounts, "_store_account", lambda *args: calls.append("write"))
    conn.commit.side_effect = lambda: calls.append("commit")
    sheet.batch_update_rows.side_effect = lambda *args: calls.append("acknowledge")
    assert accounts.upsert_accounts(conn, sheet, [account_row], 1, before_commit=lambda: calls.append("source_guard")) == 0
    assert calls == ["write", "source_guard", "commit", "acknowledge"]
    assert sheet.batch_update_rows.call_args.args[1][0][2][0] == "in-sync"


def test_existing_snapshot_revalues_corrected_rate_and_fills_legacy_tracking_date(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    typed = transform(account_row)
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    existing_values = {**typed, "opening_amount_local_value": 12346, "tracking_start_date_local": None, "opening_date_local": "2020-01-01 00:00:00"}
    cursor.fetchone.side_effect = [("type-id",), tuple(existing_values[field] for field in accounts._IMMUTABLE_FIELDS)]
    lookup = MagicMock(return_value=("corrected-rate", Decimal("200")))
    monkeypatch.setattr(accounts, "_lookup_rate", lookup)
    accounts._store_account(conn, typed, {"GBP": 2})
    lookup.assert_called_once_with(conn, "GBP", "XAU", date(2025, 9, 15))
    assert cursor.execute.call_args.args[1][5:8] == ("2025-09-15 00:00:00", 617300000, "corrected-rate")
    assert cursor.execute.call_args.args[1][8] == Decimal("200")


def test_populated_tracking_date_cannot_be_changed(account_row: dict) -> None:
    typed = transform(account_row)
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    existing_values = {**typed, "opening_amount_local_value": 12346, "tracking_start_date_local": "2024-09-15 00:00:00"}
    cursor.fetchone.side_effect = [("type-id",), tuple(existing_values[field] for field in accounts._IMMUTABLE_FIELDS)]
    with pytest.raises(ValueError, match="tracking_start_date_local"):
        accounts._store_account(conn, typed, {"GBP": 2})
    assert not any("UPDATE account_master SET" in call.args[0] for call in cursor.execute.call_args_list)


def test_xau_account_captures_unit_conversion_rate_without_lookup(account_row: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    account_row["account_currency_local"] = "XAU"
    account_row["opening_value_local"] = "0.000000001"
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [("type-id",), None, (ACCOUNT_ID,)]
    lookup = MagicMock()
    monkeypatch.setattr(accounts, "_lookup_rate", lookup)
    accounts._store_account(conn, transform(account_row), {"XAU": 9})
    lookup.assert_not_called()
    assert cursor.execute.call_args.args[1][9:11] == (1, 1)
    assert cursor.execute.call_args.args[1][13:15] == (None, Decimal(1))
