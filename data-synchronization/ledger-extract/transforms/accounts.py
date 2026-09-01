from __future__ import annotations

import decimal
from typing import Any

_VALID_ACCOUNT_TYPES = {"asset", "investment", "liability"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}


def transform(row: dict[str, Any]) -> dict[str, Any]:
    raw_account_id = row.get("id")
    if raw_account_id is None or str(raw_account_id).strip() == "":
        raise ValueError("accounts: field=account_id is required but got empty/None")
    account_id = str(raw_account_id).strip()

    raw_account_name = row.get("name")
    if raw_account_name is None or str(raw_account_name).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=account_name is required but got empty/None")
    account_name = str(raw_account_name).strip()

    raw_account_type = row.get("type")
    if raw_account_type is None or str(raw_account_type).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=account_type is required but got empty/None")
    account_type = str(raw_account_type).strip()
    if account_type not in _VALID_ACCOUNT_TYPES:
        raise ValueError(f"accounts: account_id={account_id!r} field=account_type value={account_type!r} not in {_VALID_ACCOUNT_TYPES}")

    raw_account_subtype = row.get("sub_type")
    if raw_account_subtype is None or str(raw_account_subtype).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=account_subtype is required but got empty/None")
    account_subtype = str(raw_account_subtype).strip()

    raw_currency = row.get("currency")
    if raw_currency is None or str(raw_currency).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=currency_code is required but got empty/None")
    currency_code = str(raw_currency).strip().upper()
    if len(currency_code) != 3:
        raise ValueError(f"accounts: account_id={account_id!r} field=currency_code value={currency_code!r} must be exactly 3 characters")

    raw_opening_value = row.get("opening_value")
    if raw_opening_value is None or str(raw_opening_value).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=opening_value is required but got empty/None")
    try:
        opening_value = decimal.Decimal(str(raw_opening_value).strip())
    except decimal.InvalidOperation:
        raise ValueError(f"accounts: account_id={account_id!r} field=opening_value value={raw_opening_value!r} is not a valid decimal number")
    if not opening_value.is_finite():
        raise ValueError(f"accounts: account_id={account_id!r} field=opening_value value={raw_opening_value!r} is not finite")

    raw_description = row.get("description")
    if raw_description is not None and str(raw_description).strip() != "":
        account_description: str | None = str(raw_description).strip()
    else:
        account_description = None

    raw_record_status = row.get("record_status")
    if raw_record_status is None or str(raw_record_status).strip() == "":
        raise ValueError(f"accounts: account_id={account_id!r} field=record_status is required but got empty/None")
    record_status = str(raw_record_status).strip()
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError(f"accounts: account_id={account_id!r} field=record_status value={record_status!r} not in {_VALID_RECORD_STATUSES}")

    return {
        "account_id": account_id,
        "account_name": account_name,
        "account_type": account_type,
        "account_subtype": account_subtype,
        "currency_code": currency_code,
        "opening_value": opening_value,
        "account_description": account_description,
        "record_status": record_status,
    }
