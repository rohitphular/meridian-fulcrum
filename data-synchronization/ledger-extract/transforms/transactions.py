from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_VALID_TX_TYPES = {"money-in", "money-out"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw transactions sheet row.

    Raises ValueError with prefix 'transactions: ' on any validation failure.
    """
    # Column 1 — id
    raw_id = row.get("id")
    if raw_id is None or str(raw_id).strip() == "":
        raise ValueError("transactions: field=id is required but got empty/None")
    transaction_id = str(raw_id).strip()

    # Column 2 — tx_date_time
    raw_tx_date_time = row.get("tx_date_time")
    if raw_tx_date_time is None or str(raw_tx_date_time).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_date_time is required but got empty/None")
    try:
        tx_date_time_naive = datetime.fromisoformat(str(raw_tx_date_time).strip())
    except ValueError:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_date_time value={raw_tx_date_time!r} is not a valid ISO datetime (YYYY-MM-DDTHH:MM)")

    # Column 3 — tx_timezone
    raw_tx_timezone = row.get("tx_timezone")
    if raw_tx_timezone is not None and str(raw_tx_timezone).strip() != "":
        tx_timezone_local = str(raw_tx_timezone).strip()
    else:
        tx_timezone_local = "Europe/London"
    try:
        ZoneInfo(tx_timezone_local)
    except (ZoneInfoNotFoundError, KeyError):
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_timezone value={tx_timezone_local!r} is not a recognised IANA timezone name")

    tx_timezone_base = "UTC"
    tx_date_time_base = tx_date_time_naive.replace(tzinfo=ZoneInfo(tx_timezone_base))

    # Column 4 — parent_tx_id
    raw_parent_tx_id = row.get("parent_tx_id")
    if raw_parent_tx_id is not None and str(raw_parent_tx_id).strip() != "":
        parent_tx_id: str | None = str(raw_parent_tx_id).strip()
    else:
        parent_tx_id = None

    # Column 5 — tx_type
    raw_tx_type = row.get("tx_type")
    if raw_tx_type is None or str(raw_tx_type).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_type is required but got empty/None")
    tx_type = str(raw_tx_type).strip()
    if tx_type not in _VALID_TX_TYPES:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_type value={tx_type!r} must be one of money-in, money-out")

    # Column 6 — account_id
    raw_account_id = row.get("account_id")
    if raw_account_id is None or str(raw_account_id).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=account_id is required but got empty/None")
    account_id_natural_key = str(raw_account_id).strip()

    # Column 7 — tx_amount
    raw_tx_amount = row.get("tx_amount")
    if raw_tx_amount is None or str(raw_tx_amount).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_amount is required but got empty/None")
    try:
        tx_amount = Decimal(str(raw_tx_amount).strip())
    except InvalidOperation:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_amount value={raw_tx_amount!r} is not a valid decimal number")
    if not tx_amount.is_finite():
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_amount value={raw_tx_amount!r} is not finite")
    if tx_amount <= 0:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_amount value={tx_amount} must be > 0")

    # Column 8 — major_category
    raw_major_category = row.get("major_category")
    if raw_major_category is None or str(raw_major_category).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=major_category is required but got empty/None")
    major_category = str(raw_major_category).strip()

    # Column 9 — minor_category
    raw_minor_category = row.get("minor_category")
    if raw_minor_category is None or str(raw_minor_category).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=minor_category is required but got empty/None")
    minor_category = str(raw_minor_category).strip()

    # Column 10 — description (optional)
    raw_description = row.get("description")
    if raw_description is not None and str(raw_description).strip() != "":
        tx_description: str | None = str(raw_description).strip()
    else:
        tx_description = None

    # Column 11 — counterparty_name (optional)
    raw_counterparty_name = row.get("counterparty_name")
    if raw_counterparty_name is not None and str(raw_counterparty_name).strip() != "":
        counterparty_name: str | None = str(raw_counterparty_name).strip()
    else:
        counterparty_name = None

    # Column 12 — tx_tags (optional)
    raw_tx_tags = row.get("tx_tags")
    if raw_tx_tags is not None and str(raw_tx_tags).strip() != "":
        tx_tags: str | None = str(raw_tx_tags).strip()
    else:
        tx_tags = None

    # Column 13 — beneficiaries (required)
    raw_beneficiaries = row.get("beneficiaries")
    if raw_beneficiaries is None or str(raw_beneficiaries).strip() == "":
        raise ValueError("transactions: beneficiary_required")
    beneficiaries_raw = str(raw_beneficiaries).strip()

    # Column 14 — user_location_area (optional)
    raw_user_location_area = row.get("user_location_area")
    if raw_user_location_area is not None and str(raw_user_location_area).strip() != "":
        user_location_area: str | None = str(raw_user_location_area).strip()
    else:
        user_location_area = None

    # Column 15 — user_location_city (optional)
    raw_user_location_city = row.get("user_location_city")
    if raw_user_location_city is not None and str(raw_user_location_city).strip() != "":
        user_location_city: str | None = str(raw_user_location_city).strip()
    else:
        user_location_city = None

    # Column 16 — user_location_country (optional)
    raw_user_location_country = row.get("user_location_country")
    if raw_user_location_country is not None and str(raw_user_location_country).strip() != "":
        user_location_country: str | None = str(raw_user_location_country).strip()
    else:
        user_location_country = None

    # Column 17 — user_location_latitude (optional)
    raw_user_location_latitude = row.get("user_location_latitude")
    if raw_user_location_latitude is not None and str(raw_user_location_latitude).strip() != "":
        try:
            user_location_latitude: Decimal | None = Decimal(str(raw_user_location_latitude).strip())
        except InvalidOperation:
            raise ValueError(f"transactions: transaction_id={transaction_id!r} field=user_location_latitude value={raw_user_location_latitude!r} is not a valid decimal number")
        if not user_location_latitude.is_finite():
            raise ValueError(f"transactions: transaction_id={transaction_id!r} field=user_location_latitude value={raw_user_location_latitude!r} is not finite")
    else:
        user_location_latitude = None

    # Column 18 — user_location_longitude (optional)
    raw_user_location_longitude = row.get("user_location_longitude")
    if raw_user_location_longitude is not None and str(raw_user_location_longitude).strip() != "":
        try:
            user_location_longitude: Decimal | None = Decimal(str(raw_user_location_longitude).strip())
        except InvalidOperation:
            raise ValueError(f"transactions: transaction_id={transaction_id!r} field=user_location_longitude value={raw_user_location_longitude!r} is not a valid decimal number")
        if not user_location_longitude.is_finite():
            raise ValueError(f"transactions: transaction_id={transaction_id!r} field=user_location_longitude value={raw_user_location_longitude!r} is not finite")
    else:
        user_location_longitude = None

    # Latitude/longitude pair consistency — both must be present or both absent
    if (user_location_latitude is None) != (user_location_longitude is None):
        raise ValueError(f"transactions: transaction_id={transaction_id!r} user_location_latitude and user_location_longitude must both be present or both absent")

    # Column 19 — record_status
    raw_record_status = row.get("record_status")
    if raw_record_status is None or str(raw_record_status).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=record_status is required but got empty/None")
    record_status = str(raw_record_status).strip()
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=record_status value={record_status!r} not in {_VALID_RECORD_STATUSES}")

    return {
        "transaction_id": transaction_id,
        "tx_date_time_base": tx_date_time_base,
        "tx_timezone_base": tx_timezone_base,
        "tx_timezone_local": tx_timezone_local,
        "parent_tx_id": parent_tx_id,
        "tx_type": tx_type,
        "account_id_natural_key": account_id_natural_key,
        "tx_amount": tx_amount,
        "major_category": major_category,
        "minor_category": minor_category,
        "tx_description": tx_description,
        "counterparty_name": counterparty_name,
        "tx_tags": tx_tags,
        "beneficiaries_raw": beneficiaries_raw,
        "user_location_area": user_location_area,
        "user_location_city": user_location_city,
        "user_location_country": user_location_country,
        "user_location_latitude": user_location_latitude,
        "user_location_longitude": user_location_longitude,
        "record_status": record_status,
    }
