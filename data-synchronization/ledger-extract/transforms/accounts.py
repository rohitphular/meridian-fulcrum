from __future__ import annotations

import decimal
from typing import Any

_VALID_ACCOUNT_TYPES = {"asset", "investment", "liability"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw accounts sheet row dict.

    Raises ValueError with a clear message on any validation failure.
    """
    # id — UUID stamped by GAS on create; authoritative identifier for this row
    raw_id = row.get("id")
    if raw_id is None or str(raw_id).strip() == "":
        raise ValueError("accounts: field=id is required but got empty/None")
    account_id = str(raw_id).strip()

    # account_name (sheet col 2)
    raw_account_name = row.get("account_name")
    if raw_account_name is None or str(raw_account_name).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=account_name is required but got empty/None")
    account_name = str(raw_account_name).strip()

    # legal_entity_name (sheet col 3) — optional
    legal_entity_name = _to_optional_str(row.get("legal_entity_name"))

    # type → account_type (sheet col 4)
    raw_account_type = row.get("type")
    if raw_account_type is None or str(raw_account_type).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=account_type is required but got empty/None")
    account_type = str(raw_account_type).strip()
    if account_type not in _VALID_ACCOUNT_TYPES:
        raise ValueError(f"accounts: id={account_id!r} field=account_type value={account_type!r} not in {_VALID_ACCOUNT_TYPES}")

    # sub_type → account_subtype (sheet col 5)
    raw_account_subtype = row.get("sub_type")
    if raw_account_subtype is None or str(raw_account_subtype).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=account_subtype is required but got empty/None")
    account_subtype = str(raw_account_subtype).strip()

    # local_currency (sheet col 6)
    raw_currency = row.get("local_currency")
    if raw_currency is None or str(raw_currency).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=local_currency is required but got empty/None")
    local_currency = str(raw_currency).strip().upper()
    if len(local_currency) != 3:
        raise ValueError(f"accounts: id={account_id!r} field=local_currency value={local_currency!r} must be exactly 3 characters")

    # local_timezone (sheet col 7) — optional; auto-detected by browser on create, never user-typed
    local_timezone = _to_optional_str(row.get("local_timezone"))

    # opening_date_local (sheet col 8) — optional str; immutable after create; stored as-is (no UTC conversion)
    opening_date_local = _to_optional_str(row.get("opening_date_local"))

    # closing_date_local (sheet col 9) — optional; set when account is closed
    closing_date_local = _to_optional_str(row.get("closing_date_local"))

    # opening_value_local (sheet col 10)
    raw_opening_value = row.get("opening_value_local")
    if raw_opening_value is None or str(raw_opening_value).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=opening_value_local is required but got empty/None")
    try:
        opening_amount_local_value = decimal.Decimal(str(raw_opening_value).strip())
    except decimal.InvalidOperation:
        raise ValueError(f"accounts: id={account_id!r} field=opening_value_local value={raw_opening_value!r} is not a valid decimal number")
    if not opening_amount_local_value.is_finite():
        raise ValueError(f"accounts: id={account_id!r} field=opening_value_local value={raw_opening_value!r} is not finite")

    # description (sheet col 12) — optional
    account_description = _to_optional_str(row.get("description"))

    # record_status (sheet col 13)
    raw_record_status = row.get("record_status")
    if raw_record_status is None or str(raw_record_status).strip() == "":
        raise ValueError(f"accounts: id={account_id!r} field=record_status is required but got empty/None")
    record_status = str(raw_record_status).strip()
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError(f"accounts: id={account_id!r} field=record_status value={record_status!r} not in {_VALID_RECORD_STATUSES}")

    return {
        "id": account_id,
        "account_name": account_name,
        "legal_entity_name": legal_entity_name,
        "account_type": account_type,
        "account_subtype": account_subtype,
        "local_currency": local_currency,
        "local_timezone": local_timezone,
        "opening_date_local": opening_date_local,
        "closing_date_local": closing_date_local,
        "opening_amount_local_value": opening_amount_local_value,
        "account_description": account_description,
        "record_status": record_status,
    }
