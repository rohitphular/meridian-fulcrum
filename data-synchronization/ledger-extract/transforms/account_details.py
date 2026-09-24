from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from core.account_detail_contracts import CONTRACTS

_LOCAL_ISO = re.compile(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?")
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_INTEGER_MAX = 2**31 - 1


def _error(sheet: str, field: str, reason: str) -> ValueError:
    return ValueError(f"account_details: sheet={sheet} field={field} {reason}")


def _optional(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw.strip() or None
    return raw


def _decimal(value: Any, sheet: str, field: str) -> Decimal:
    # Decimal accepts Python-only spellings such as 1_000 and Unicode digits;
    # the Sheets importer accepts ASCII decimal notation only.
    if isinstance(value, bool) or _DECIMAL.fullmatch(str(value)) is None:
        raise _error(sheet, field, "must be a finite decimal number")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation as exc:
        raise _error(sheet, field, "must be a finite decimal number") from exc
    if not parsed.is_finite():
        raise _error(sheet, field, "must be a finite decimal number")
    return parsed


def _numeric_precision(value: Decimal, sheet: str, field: str) -> None:
    """Reject loss at the NUMERIC(38,18) boundary instead of silently rounding prices."""
    if value == 0:
        return
    digits = list(value.as_tuple().digits)
    exponent = value.as_tuple().exponent
    while digits and digits[-1] == 0:
        digits.pop()
        exponent += 1
    if value.adjusted() >= 20 or exponent < -18:
        raise _error(sheet, field, "cannot be stored exactly as NUMERIC(38,18)")


def _boolean(value: Any, sheet: str, field: str) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"true", "yes", "1"}:
        return True
    if text in {"false", "no", "0"}:
        return False
    raise _error(sheet, field, "must be true/false, yes/no, or 1/0")


def _local_date(value: Any, sheet: str, field: str) -> str:
    text = str(value).strip()
    if _LOCAL_ISO.fullmatch(text) is None:
        raise _error(sheet, field, "must be an ISO local date/datetime without a UTC offset")
    try:
        datetime.fromisoformat(text)
    except ValueError as exc:
        raise _error(sheet, field, "must be a valid ISO local date/datetime") from exc
    return text


def transform(sheet_name: str, row: dict[str, Any]) -> dict[str, Any]:
    """Validate one detail row and map fields, leaving money in major units for the writer.

    Optional blank values remain None. Dates remain local ISO text. No balance,
    valuation, timezone, lifecycle state, ownership adjustment or pricing is inferred.
    """
    if sheet_name not in CONTRACTS:
        raise ValueError(f"account_details: unsupported source sheet {sheet_name!r}")
    contract = CONTRACTS[sheet_name]
    # Source audit and sync controls are not database business or audit values.
    values = {field: _optional(row.get(field)) for field in contract.field_map}
    if values["record_status"] is None:
        raise _error(sheet_name, "record_status", "is required")
    for field in contract.required:
        if values[field] is None:
            raise _error(sheet_name, field, "is required")
    for field, value in values.items():
        if value is None:
            continue
        if field in contract.uuid_fields:
            try:
                values[field] = str(UUID(str(value)))
            except (ValueError, AttributeError) as exc:
                raise _error(sheet_name, field, "must be a valid UUID") from exc
        elif field in contract.boolean_fields:
            values[field] = _boolean(value, sheet_name, field)
        elif field in contract.integer_fields:
            parsed = _decimal(value, sheet_name, field)
            minimum, maximum = contract.integer_fields[field]
            ceiling = _INTEGER_MAX if maximum is None else maximum
            if parsed != parsed.to_integral_value() or not minimum <= parsed <= ceiling:
                raise _error(sheet_name, field, f"must be an integer between {minimum} and {ceiling}")
            values[field] = int(parsed)
        elif field in contract.decimal_fields:
            parsed = _decimal(value, sheet_name, field)
            if field in contract.nonnegative_fields and parsed < 0:
                raise _error(sheet_name, field, "must be nonnegative")
            if field in contract.positive_fields and parsed <= 0:
                raise _error(sheet_name, field, "must be positive")
            if field in contract.percentage_fields and not 0 <= parsed <= 100:
                raise _error(sheet_name, field, "must be between 0 and 100 percentage points")
            if field not in contract.money_fields:
                _numeric_precision(parsed, sheet_name, field)
            values[field] = parsed
        elif field in contract.date_fields:
            values[field] = _local_date(value, sheet_name, field)
        else:
            values[field] = str(value).strip()
        if field in contract.enums and values[field] not in contract.enums[field]:
            raise _error(sheet_name, field, "has an unsupported enum value")
    if values.get("interest_payment_frequency") == "annually":
        values["interest_payment_frequency"] = "annual"
    currency = values.get("instrument_currency_local")
    if currency is not None:
        currency = currency.upper()
        if len(currency) != 3 or not currency.isascii() or not currency.isalpha():
            raise _error(sheet_name, "instrument_currency_local", "must be a three-letter currency code")
        values["instrument_currency_local"] = currency
    return {"source_sheet": sheet_name, **{contract.field_map[field]: value for field, value in values.items()}}
