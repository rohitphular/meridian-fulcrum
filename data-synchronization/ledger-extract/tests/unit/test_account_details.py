from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.account_detail_contracts import CONTRACTS, DETAIL_SYNC_IGNORED_FIELDS, DETAIL_SYNC_METADATA, SYNC_DETAIL_SHEETS
from database.account_details import validate_account_change
from transforms.account_details import transform

DETAIL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
PROPERTY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def _row(sheet: str, **values: object) -> dict[str, object]:
    defaults: dict[str, dict[str, object]] = {
        "account_deposit": {},
        "account_liability_credit_card": {"credit_limit_local": "1000"},
        "account_liability_mortgage": {"original_principal_local": "1000", "term_months": "120"},
        "account_liability_personal_loan": {"original_principal_local": "1000", "term_months": "24"},
        "account_investment_property": {"acquisition_type": "INHERITED"},
        "account_investment_stocks": {"instrument_type": "EQUITY"},
    }
    metadata = {"record_status": "active"}
    return {"id": DETAIL_ID, "account_id": ACCOUNT_ID, **defaults[sheet], **metadata, **values}


def test_six_source_contracts_each_map_to_an_identically_named_table() -> None:
    assert len(CONTRACTS) == 6
    assert len({contract.target_table for contract in CONTRACTS.values()}) == 6
    assert SYNC_DETAIL_SHEETS == frozenset(CONTRACTS)
    for sheet, contract in CONTRACTS.items():
        assert sheet == contract.source_sheet == contract.target_table
        assert set(contract.field_map) == set(contract.headers) - DETAIL_SYNC_IGNORED_FIELDS
        assert len(set(contract.field_map.values())) == len(contract.field_map)
        assert set(contract.money_fields) <= set(contract.decimal_fields)
        assert all(contract.field_map[source] == target for source, target in contract.money_fields.items())
        assert contract.headers[-6:] == DETAIL_SYNC_METADATA


def test_detail_headers_requirements_and_enums_match_gas_registry() -> None:
    registry_path = Path(__file__).resolve().parents[4] / "expense-tracker" / "api" / "import-registry.gs"
    registry = registry_path.read_text()
    for sheet, contract in CONTRACTS.items():
        block = registry.split(f"  {sheet}: {{", 1)[1].split("    key_field:", 1)[0]
        headers = re.search(r"columns:\s*\[(.*?)\]", block, re.S)
        required = re.search(r"required:\s*\[(.*?)\]", block, re.S)
        numeric = re.search(r"numeric_fields:\s*\[(.*?)\]", block, re.S)
        assert headers is not None and required is not None
        assert tuple(re.findall(r"'([^']+)'", headers.group(1))) == contract.headers
        assert tuple(re.findall(r"'([^']+)'", required.group(1))) == contract.required
        assert numeric is not None
        assert set(re.findall(r"'([^']+)'", numeric.group(1))) == set(contract.decimal_fields) | set(contract.integer_fields)
        for field, expected in contract.enums.items():
            enum_match = re.search(rf"\b{field}:\s*\[(.*?)\]", block, re.S)
            assert enum_match is not None
            assert tuple(re.findall(r"'([^']+)'", enum_match.group(1))) == expected


@pytest.mark.parametrize("sheet", CONTRACTS)
def test_every_contract_maps_all_fields_and_preserves_blanks(sheet: str) -> None:
    result = transform(sheet, _row(sheet))
    assert result["source_sheet"] == sheet
    assert result["id"] == DETAIL_ID
    assert result["account_master_id"] == ACCOUNT_ID
    assert set(result) == {"source_sheet", *CONTRACTS[sheet].field_map.values()}
    for field, target in CONTRACTS[sheet].field_map.items():
        if field == "record_status" and sheet in SYNC_DETAIL_SHEETS:
            assert result[target] == "active"
        elif field not in CONTRACTS[sheet].required:
            assert result[target] is None


@pytest.mark.parametrize("sheet", CONTRACTS)
def test_uuid_variants_are_canonicalized(sheet: str) -> None:
    result = transform(sheet, _row(sheet, id=" {AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA} ", account_id=ACCOUNT_ID.upper()))
    assert result["id"] == DETAIL_ID
    assert result["account_master_id"] == ACCOUNT_ID


@pytest.mark.parametrize("sheet", CONTRACTS)
def test_missing_and_malformed_required_ids_fail(sheet: str) -> None:
    for field in ("id", "account_id"):
        for value in (None, "", "not-a-uuid"):
            with pytest.raises(ValueError, match=f"field={field}"):
                transform(sheet, _row(sheet, **{field: value}))


@pytest.mark.parametrize(
    "sheet,field",
    [
        ("account_liability_mortgage", "linked_property_account_id"),
        ("account_investment_stocks", "evaluation_currency_rate_id"),
    ],
)
def test_optional_reference_ids_are_validated(sheet: str, field: str) -> None:
    result = transform(sheet, _row(sheet, **{field: f"{{{PROPERTY_ID.upper()}}}"}))
    assert result[field] == PROPERTY_ID
    with pytest.raises(ValueError, match=f"field={field}"):
        transform(sheet, _row(sheet, **{field: "unknown"}))


@pytest.mark.parametrize("retired_value", [PROPERTY_ID, "invalid-retired-id"])
def test_property_ignores_retired_rate_reference(retired_value: str) -> None:
    sheet = "account_investment_property"
    contract = CONTRACTS[sheet]
    result = transform(sheet, _row(sheet, evaluation_currency_rate_id=retired_value, current_value_evaluation_date="2026-09-24"))
    assert "evaluation_currency_rate_id" not in contract.headers
    assert "evaluation_currency_rate_id" not in contract.field_map
    assert "evaluation_currency_rate_id" not in contract.uuid_fields
    assert "evaluation_currency_rate_id" not in result
    assert result["current_value_evaluation_date"] == "2026-09-24"


def test_boolean_false_and_decimal_zero_are_distinct_from_blank() -> None:
    sheet = "account_deposit"
    assert transform(sheet, _row(sheet, is_interest_paid=False, interest_rate=0))["is_interest_paid"] is False
    assert transform(sheet, _row(sheet, is_interest_paid=False, interest_rate=0))["interest_rate"] == Decimal(0)
    result = transform(sheet, _row(sheet, is_interest_paid=" ", interest_rate=""))
    assert result["is_interest_paid"] is None
    assert result["interest_rate"] is None
    for value in (True, "true", " YES ", 1):
        assert transform(sheet, _row(sheet, is_interest_paid=value))["is_interest_paid"] is True
    for value in (False, "false", " NO ", 0):
        assert transform(sheet, _row(sheet, is_interest_paid=value))["is_interest_paid"] is False
    with pytest.raises(ValueError, match="field=is_interest_paid"):
        transform(sheet, _row(sheet, is_interest_paid="maybe"))


@pytest.mark.parametrize("value", ["NaN", "sNaN", "Infinity", "-Infinity", "not-a-number", True, False])
def test_invalid_decimals_fail_without_coercing_boolean_values(value: object) -> None:
    with pytest.raises(ValueError, match="field=interest_rate"):
        transform("account_deposit", _row("account_deposit", interest_rate=value))


@pytest.mark.parametrize("value", ["1_000", "１.２", "١.٢", "0x10", "0b10", "1,000", "1 000"])
def test_decimal_text_matches_importer_ascii_grammar(value: str) -> None:
    with pytest.raises(ValueError, match="field=interest_rate"):
        transform("account_deposit", _row("account_deposit", interest_rate=value))
    with pytest.raises(ValueError, match="field=credit_limit_local"):
        transform("account_liability_credit_card", _row("account_liability_credit_card", credit_limit_local=value))
    with pytest.raises(ValueError, match="field=term_months"):
        transform("account_liability_personal_loan", _row("account_liability_personal_loan", term_months=value))


@pytest.mark.parametrize("value", ["+1.25e2", ".5", "1.", " 1.25 ", Decimal("1.25"), 1.25])
def test_importer_decimal_spellings_keep_exact_values(value: object) -> None:
    result = transform("account_deposit", _row("account_deposit", interest_rate=value))
    assert result["interest_rate"] == Decimal(str(value))


def test_interest_percentage_points_can_exceed_100_and_are_not_converted_to_apr() -> None:
    result = transform("account_liability_credit_card", _row("account_liability_credit_card", interest_rate="150.125", credit_limit_local="0"))
    assert result["interest_rate"] == Decimal("150.125")
    assert result["credit_limit_local_value"] == Decimal(0)
    assert "annual_percentage_rate" not in result
    with pytest.raises(ValueError, match="field=interest_rate"):
        transform("account_deposit", _row("account_deposit", interest_rate="-0.1"))


@pytest.mark.parametrize("field", ["property_ownership_percentage", "rent_ownership_percentage"])
def test_ownership_percentages_have_explicit_zero_to_100_bounds(field: str) -> None:
    for valid in ("0", "25.5", "100"):
        assert transform("account_investment_property", _row("account_investment_property", **{field: valid}))[field] == Decimal(valid)
    for invalid in ("-0.01", "100.01"):
        with pytest.raises(ValueError, match=f"field={field}"):
            transform("account_investment_property", _row("account_investment_property", **{field: invalid}))


@pytest.mark.parametrize("field", ["payment_month_day", "statement_month_day"])
def test_card_calendar_days_must_be_integral_between_1_and_31(field: str) -> None:
    for valid in (1, "31", "2.0"):
        result = transform("account_liability_credit_card", _row("account_liability_credit_card", **{field: valid}))
        assert result[CONTRACTS["account_liability_credit_card"].field_map[field]] == int(Decimal(str(valid)))
    for invalid in (0, 32, "1.5"):
        with pytest.raises(ValueError, match=f"field={field}"):
            transform("account_liability_credit_card", _row("account_liability_credit_card", **{field: invalid}))


def test_rent_calendar_ranges_and_loan_term_are_checked_without_defaults() -> None:
    with pytest.raises(ValueError, match="field=rent_month"):
        transform("account_investment_property", _row("account_investment_property", rent_month="13"))
    with pytest.raises(ValueError, match="field=rent_day"):
        transform("account_investment_property", _row("account_investment_property", rent_day="0"))
    for value in ("0", "1.5", str(2**31)):
        with pytest.raises(ValueError, match="field=term_months"):
            transform("account_liability_personal_loan", _row("account_liability_personal_loan", term_months=value))
    result = transform("account_liability_personal_loan", _row("account_liability_personal_loan", monthly_payment_local="0"))
    assert result["term_months"] == 24
    assert result["monthly_payment_local_value"] == Decimal(0)
    assert result["maturity_date_local"] is None


@pytest.mark.parametrize(
    "sheet,field",
    [
        ("account_liability_mortgage", "original_principal_local"),
    ],
)
def test_required_principals_must_be_positive(sheet: str, field: str) -> None:
    for invalid in ("", "0", "-1"):
        with pytest.raises(ValueError, match=f"field={field}"):
            transform(sheet, _row(sheet, **{field: invalid}))


def test_local_dates_preserve_wall_time_without_inventing_timezone() -> None:
    sheet = "account_investment_property"
    result = transform(sheet, _row(sheet, acquisition_date_local="2024-02-29", current_value_evaluation_date="2026-09-24T14:30:00.123456"))
    assert result["acquisition_date_local"] == "2024-02-29"
    assert result["current_value_evaluation_date"] == "2026-09-24T14:30:00.123456"
    for invalid in ("2025-02-29", "24/09/2026", "2026-09-24T14:30:00Z", "2026-09-24T14:30:00+01:00"):
        with pytest.raises(ValueError, match="field=acquisition_date_local"):
            transform(sheet, _row(sheet, acquisition_date_local=invalid))


def test_frequency_alias_is_explicit_and_other_enums_are_preserved() -> None:
    assert transform("account_deposit", _row("account_deposit", interest_payment_frequency="annually"))["interest_payment_frequency"] == "annual"
    assert transform("account_deposit", _row("account_deposit", interest_payment_frequency="at_maturity"))["interest_payment_frequency"] == "at_maturity"
    with pytest.raises(ValueError, match="field=interest_payment_frequency"):
        transform("account_deposit", _row("account_deposit", interest_payment_frequency="annual"))
    with pytest.raises(ValueError, match="field=rate_type"):
        transform("account_liability_mortgage", _row("account_liability_mortgage", rate_type="tracker"))


def test_stock_signed_values_and_precise_unit_prices_are_preserved_without_pricing() -> None:
    sheet = "account_investment_stocks"
    result = transform(
        sheet,
        _row(
            sheet,
            instrument_type="FUTURE",
            quantity="-2.5",
            position_side="SHORT",
            current_price_local="-0.000000000000000001",
            avg_cost_price_local="0.000000123456789123",
            cost_basis_local="-100.005",
            current_value_local="-123.45",
            contract_multiplier="100",
            instrument_currency_local=" usd ",
        ),
    )
    assert result["units_held"] == Decimal("-2.5")
    assert result["current_price_local"] == Decimal("-0.000000000000000001")
    assert result["avg_cost_price_local"] == Decimal("0.000000123456789123")
    assert result["cost_basis_local_value"] == Decimal("-100.005")
    assert result["current_value_local_value"] == Decimal("-123.45")
    assert result["contract_multiplier"] == Decimal(100)
    assert result["instrument_currency_local"] == "USD"
    assert result["position_side"] == "SHORT"
    assert "unit_value_local_value" not in result
    assert "local_currency" not in result
    assert result["record_status"] == "active"
    blank = transform(sheet, _row(sheet))
    assert blank["instrument_currency_local"] is None
    assert blank["units_held"] is None
    assert blank["current_value_local_value"] is None


@pytest.mark.parametrize("value", ["0.0000000000000000001", "100000000000000000000"])
def test_per_unit_prices_cannot_silently_lose_database_precision(value: str) -> None:
    with pytest.raises(ValueError, match=r"NUMERIC\(38,18\)"):
        transform("account_investment_stocks", _row("account_investment_stocks", current_price_local=value))


def test_more_than_18_fractional_digits_of_trailing_zeros_do_not_lose_value() -> None:
    result = transform("account_investment_stocks", _row("account_investment_stocks", current_price_local="1.0000000000000000000000"))
    assert result["current_price_local"] == Decimal(1)


def test_property_preserves_actual_rent_without_ownership_adjustment_or_monthly_conversion() -> None:
    sheet = "account_investment_property"
    result = transform(sheet, _row(sheet, rent_frequency="YEARLY", rent_amount_local="12000", rent_ownership_percentage="50", property_ownership_percentage="25", is_rented="no"))
    assert result["rent_amount_local_value"] == Decimal("12000")
    assert result["rent_ownership_percentage"] == Decimal(50)
    assert result["property_ownership_percentage"] == Decimal(25)
    assert result["is_rented"] is False
    assert "monthly_rental_income_local_value" not in result
    assert "purchase_price_local_value" not in result


def test_nonstock_amounts_reject_negative_values_and_preserve_valid_zero() -> None:
    sheet = "account_investment_property"
    assert transform(sheet, _row(sheet, current_value_local="0"))["current_value_local_value"] == Decimal(0)
    with pytest.raises(ValueError, match="field=current_value_local"):
        transform(sheet, _row(sheet, current_value_local="-1"))
    with pytest.raises(ValueError, match="field=contract_multiplier"):
        transform("account_investment_stocks", _row("account_investment_stocks", contract_multiplier="0"))


@pytest.mark.parametrize("sheet", sorted(SYNC_DETAIL_SHEETS))
def test_detail_source_sync_and_audit_fields_never_become_database_fields(sheet: str) -> None:
    result = transform(
        sheet, _row(sheet, record_status="deleted", sync_status="update-pending", sync_date="attempt-time", sync_notes="source-note", created_at="sheet-created", updated_at="sheet-updated")
    )
    assert result["record_status"] == "deleted"
    assert not DETAIL_SYNC_IGNORED_FIELDS.intersection(result)
    assert not DETAIL_SYNC_IGNORED_FIELDS.intersection(CONTRACTS[sheet].field_map)


@pytest.mark.parametrize("sheet", sorted(SYNC_DETAIL_SHEETS))
@pytest.mark.parametrize("status", [None, "", " ", "unknown"])
def test_sync_detail_record_status_is_required_and_validated(sheet: str, status: object) -> None:
    with pytest.raises(ValueError, match="field=record_status"):
        transform(sheet, _row(sheet, record_status=status))


@pytest.mark.parametrize("source_sheet", ["unrecognized_source", "account_investment_stocks"])
def test_master_guard_rejects_unknown_or_wrong_family_sources_with_safe_error(source_sheet: str) -> None:
    connection = MagicMock()
    # The first family queried is deposit. Even a known source belonging to
    # another table must not silently authorize a master subtype edit.
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = [(source_sheet,)]
    cursor.fetchone.return_value = ("account_deposit",)
    with pytest.raises(ValueError, match="^accounts: unknown_account_detail_source_requires_reconciliation$"):
        validate_account_change(connection, ACCOUNT_ID, "current")


@pytest.mark.parametrize("table", ["account_liability_mortgage", "account_liability_personal_loan"])
def test_master_guard_follows_configured_detail_policy(table: str) -> None:
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect = lambda: [(None,)] if f"FROM {table} WHERE" in cursor.execute.call_args.args[0] else []
    cursor.fetchone.side_effect = lambda: (table,) if "SELECT detail_sheet" in cursor.execute.call_args.args[0] else None
    validate_account_change(connection, ACCOUNT_ID, "configured-loan")
    cursor.fetchone.side_effect = lambda: (None,) if "SELECT detail_sheet" in cursor.execute.call_args.args[0] else None
    with pytest.raises(ValueError, match="^accounts: subtype_conflicts_with_account_details$"):
        validate_account_change(connection, ACCOUNT_ID, "configured-other")


@pytest.mark.parametrize("linked_table", ["account_liability_mortgage", "account_liability_personal_loan"])
def test_master_property_guard_checks_links_retained_in_either_loan_table(linked_table: str) -> None:
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    cursor.fetchone.side_effect = lambda: (None,) if "SELECT detail_sheet" in cursor.execute.call_args.args[0] else ((1,) if f"FROM {linked_table} WHERE" in cursor.execute.call_args.args[0] else None)
    with pytest.raises(ValueError, match="^accounts: subtype_conflicts_with_linked_property$"):
        validate_account_change(connection, ACCOUNT_ID, "configured-other")


def test_missing_source_policy_requires_sync_before_account_change() -> None:
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = None
    with pytest.raises(ValueError, match="account_type_configuration_requires_sync"):
        validate_account_change(connection, ACCOUNT_ID, "configured-subtype")
