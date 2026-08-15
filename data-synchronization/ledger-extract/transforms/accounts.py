from __future__ import annotations

import hashlib
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _to_decimal(raw: Any, field: str, account_id: str) -> Decimal | None:
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip()
    try:
        return Decimal(s)
    except InvalidOperation:
        raise ValueError(f"accounts: account_id={account_id!r} field={field} value={s!r} is not a valid decimal number")


def _to_date(raw: Any, field: str, account_id: str) -> date | None:
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip()
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise ValueError(f"accounts: account_id={account_id!r} field={field} value={s!r} is not a valid ISO date (YYYY-MM-DD)")


def _to_int(raw: Any, field: str, account_id: str) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip()
    try:
        return int(s)
    except ValueError:
        raise ValueError(f"accounts: account_id={account_id!r} field={field} value={s!r} is not a valid integer")


def _to_bool_default_false(raw: Any, field: str, account_id: str) -> bool:
    if raw is None or str(raw).strip() == "":
        return False
    s = str(raw).strip()
    if s in ("TRUE", "true", "1", "Yes", "yes"):
        return True
    if s in ("FALSE", "false", "0", "No", "no"):
        return False
    raise ValueError(f"accounts: account_id={account_id!r} field={field} value={s!r} is not a recognised boolean")


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw accounts sheet row dict.

    Raises ValueError with a clear message on any validation failure.
    """
    # --- Common fields ---
    raw_id = row.get("id")
    raw_name = row.get("name")
    raw_institution_name = row.get("institution_name")
    raw_type = row.get("type")
    raw_sub_type = row.get("sub_type")
    raw_currency = row.get("currency")
    raw_description = row.get("description")

    if raw_id is None or str(raw_id).strip() == "":
        raise ValueError("accounts: field=id is required but got empty/None")
    account_id = str(raw_id).strip()

    if raw_name is None or str(raw_name).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=name is required but got empty/None")
    account_name = str(raw_name).strip()

    if raw_type is None or str(raw_type).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=type is required but got empty/None")
    account_type = str(raw_type).strip()

    if raw_sub_type is None or str(raw_sub_type).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=sub_type is required but got empty/None")
    sub_type = str(raw_sub_type).strip()

    if raw_currency is None or str(raw_currency).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=currency is required but got empty/None")
    currency_code = str(raw_currency).strip().upper()
    if len(currency_code) != 3:
        raise ValueError(f"accounts: account_id={account_id!r} field=currency value={currency_code!r} must be exactly 3 characters")

    # --- Extension fields (type conversion; structure-type validation in DB layer) ---
    raw_balance = row.get("balance")
    raw_interest_rate = row.get("interest_rate")
    raw_rate_type = row.get("rate_type")
    raw_interest_payment_frequency = row.get("interest_payment_frequency")
    raw_current_value = row.get("current_value")
    raw_cost_basis = row.get("cost_basis")
    raw_units_held = row.get("units_held")
    raw_unit_value = row.get("unit_value")
    raw_unit_type = row.get("unit_type")
    raw_face_value = row.get("face_value")
    raw_purchase_price = row.get("purchase_price")
    raw_start_date = row.get("start_date")
    raw_maturity_date = row.get("maturity_date")
    raw_purchase_date = row.get("purchase_date")
    raw_property_address = row.get("property_address")
    raw_is_rental = row.get("is_rental")
    raw_monthly_rental_income = row.get("monthly_rental_income")
    raw_principal_lent = row.get("principal_lent")
    raw_credit_limit = row.get("credit_limit")
    raw_annual_percentage_rate = row.get("annual_percentage_rate")
    raw_minimum_payment = row.get("minimum_payment")
    raw_payment_due_day = row.get("payment_due_day")
    raw_statement_day = row.get("statement_day")
    raw_original_principal_amount = row.get("original_principal_amount")
    raw_outstanding_balance = row.get("outstanding_balance")
    raw_term_months = row.get("term_months")
    raw_monthly_payment = row.get("monthly_payment")
    raw_end_date = row.get("end_date")

    # --- Hash computation (all raw sheet values, fixed order) ---
    ordered_values = [
        raw_id,
        raw_name,
        raw_institution_name,
        raw_type,
        raw_sub_type,
        raw_currency,
        raw_description,
        raw_balance,
        raw_interest_rate,
        raw_rate_type,
        raw_interest_payment_frequency,
        raw_current_value,
        raw_cost_basis,
        raw_units_held,
        raw_unit_value,
        raw_unit_type,
        raw_face_value,
        raw_purchase_price,
        raw_start_date,
        raw_maturity_date,
        raw_purchase_date,
        raw_property_address,
        raw_is_rental,
        raw_monthly_rental_income,
        raw_principal_lent,
        raw_credit_limit,
        raw_annual_percentage_rate,
        raw_minimum_payment,
        raw_payment_due_day,
        raw_statement_day,
        raw_original_principal_amount,
        raw_outstanding_balance,
        raw_term_months,
        raw_monthly_payment,
        raw_end_date,
    ]
    row_hash = hashlib.sha256("|".join("" if v is None else str(v) for v in ordered_values).encode()).hexdigest()

    return {
        "account_id": account_id,
        "account_name": account_name,
        "institution_name": _to_optional_str(raw_institution_name),
        "account_type": account_type,
        "sub_type": sub_type,
        "currency_code": currency_code,
        "account_description": _to_optional_str(raw_description),
        "row_hash": row_hash,
        "natural_key": account_id,
        # extension fields
        "balance": _to_decimal(raw_balance, "balance", account_id),
        "interest_rate": _to_decimal(raw_interest_rate, "interest_rate", account_id),
        "rate_type": _to_optional_str(raw_rate_type),
        "interest_payment_frequency": _to_optional_str(raw_interest_payment_frequency),
        "current_value": _to_decimal(raw_current_value, "current_value", account_id),
        "cost_basis": _to_decimal(raw_cost_basis, "cost_basis", account_id),
        "units_held": _to_decimal(raw_units_held, "units_held", account_id),
        "unit_value": _to_decimal(raw_unit_value, "unit_value", account_id),
        "unit_type": _to_optional_str(raw_unit_type),
        "face_value": _to_decimal(raw_face_value, "face_value", account_id),
        "purchase_price": _to_decimal(raw_purchase_price, "purchase_price", account_id),
        "start_date": _to_date(raw_start_date, "start_date", account_id),
        "maturity_date": _to_date(raw_maturity_date, "maturity_date", account_id),
        "purchase_date": _to_date(raw_purchase_date, "purchase_date", account_id),
        "property_address": _to_optional_str(raw_property_address),
        "is_rental": _to_bool_default_false(raw_is_rental, "is_rental", account_id),
        "monthly_rental_income": _to_decimal(raw_monthly_rental_income, "monthly_rental_income", account_id),
        "principal_lent": _to_decimal(raw_principal_lent, "principal_lent", account_id),
        "credit_limit": _to_decimal(raw_credit_limit, "credit_limit", account_id),
        "annual_percentage_rate": _to_decimal(raw_annual_percentage_rate, "annual_percentage_rate", account_id),
        "minimum_payment": _to_decimal(raw_minimum_payment, "minimum_payment", account_id),
        "payment_due_day": _to_int(raw_payment_due_day, "payment_due_day", account_id),
        "statement_day": _to_int(raw_statement_day, "statement_day", account_id),
        "original_principal_amount": _to_decimal(raw_original_principal_amount, "original_principal_amount", account_id),
        "outstanding_balance": _to_decimal(raw_outstanding_balance, "outstanding_balance", account_id),
        "term_months": _to_int(raw_term_months, "term_months", account_id),
        "monthly_payment": _to_decimal(raw_monthly_payment, "monthly_payment", account_id),
        "end_date": _to_date(raw_end_date, "end_date", account_id),
    }
