from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

_DAY_NAMES = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
_LOCAL_TZ = ZoneInfo("Europe/London")


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _to_decimal(raw: Any, field: str, transaction_id: str) -> Decimal | None:
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip()
    try:
        return Decimal(s)
    except InvalidOperation:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field={field} value={s!r} is not a valid decimal number")


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw transactions sheet row dict.

    Raises ValueError with a clear message on any validation failure.
    """
    # --- Raw values ---
    raw_tx_date_time = row.get("tx_date_time")
    raw_tx_type = row.get("tx_type")
    raw_source_account = row.get("source_account")
    raw_target_account = row.get("target_account")
    raw_amount = row.get("amount")
    raw_currency = row.get("currency")
    raw_user_location_area = row.get("user_location_area")
    raw_user_location_city = row.get("user_location_city")
    raw_user_location_country = row.get("user_location_country")
    raw_counterparty_name = row.get("counterparty_name")
    raw_counterparty_location_area = row.get("counterparty_location_area")
    raw_counterparty_location_city = row.get("counterparty_location_city")
    raw_counterparty_location_country = row.get("counterparty_location_country")
    raw_major_category = row.get("major_category")
    raw_minor_category = row.get("minor_category")
    raw_tags = row.get("tx_tags")
    raw_description = row.get("description")

    # Natural key — SHA-256 of 6 identifying fields; stable across metadata edits
    transaction_id = hashlib.sha256(
        "|".join(
            [
                raw_tx_date_time or "",
                raw_tx_type or "",
                raw_source_account or "",
                raw_target_account or "",
                raw_amount or "",
                raw_currency or "",
            ]
        ).encode()
    ).hexdigest()

    # Row hash — all 17 raw source columns in fixed order
    row_hash = hashlib.sha256(
        "|".join(
            [
                raw_tx_date_time or "",
                raw_tx_type or "",
                raw_source_account or "",
                raw_target_account or "",
                raw_amount or "",
                raw_currency or "",
                raw_user_location_area or "",
                raw_user_location_city or "",
                raw_user_location_country or "",
                raw_counterparty_name or "",
                raw_counterparty_location_area or "",
                raw_counterparty_location_city or "",
                raw_counterparty_location_country or "",
                raw_major_category or "",
                raw_minor_category or "",
                raw_tags or "",
                raw_description or "",
            ]
        ).encode()
    ).hexdigest()

    # --- Required field validation ---
    if raw_tx_date_time is None or str(raw_tx_date_time).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_date_time is required but got empty/None")
    try:
        tx_date_time_naive = datetime.fromisoformat(str(raw_tx_date_time).strip())
    except ValueError:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_date_time value={raw_tx_date_time!r} is not a valid ISO datetime (YYYY-MM-DDTHH:MM)")
    # Sheet stores wall-clock UK local time (GMT/BST) — no TZ suffix
    tx_date_time_local = tx_date_time_naive  # stored as TIMESTAMP (no TZ) — preserves what user entered
    tx_date_time_base = tx_date_time_naive.replace(tzinfo=_LOCAL_TZ).astimezone(timezone.utc)
    tx_day_of_week_local = _DAY_NAMES[tx_date_time_local.weekday()]
    tx_day_of_week_base = _DAY_NAMES[tx_date_time_base.weekday()]

    if raw_tx_type is None or str(raw_tx_type).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_type is required but got empty/None")
    tx_type = str(raw_tx_type).strip()
    if tx_type not in ("money-in", "money-out", "money-transfer"):
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=tx_type value={tx_type!r} must be one of money-in, money-out, money-transfer")

    if raw_amount is None or str(raw_amount).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=amount is required but got empty/None")
    tx_amount_local = _to_decimal(raw_amount, "amount", transaction_id)
    if tx_amount_local <= 0:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=amount value={tx_amount_local} must be > 0")

    if raw_currency is None or str(raw_currency).strip() == "":
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=currency is required but got empty/None")
    tx_currency_local = str(raw_currency).strip().upper()
    if len(tx_currency_local) != 3:
        raise ValueError(f"transactions: transaction_id={transaction_id!r} field=currency value={tx_currency_local!r} must be exactly 3 characters")

    return {
        "transaction_id": transaction_id,
        "natural_key": transaction_id,
        "row_hash": row_hash,
        "tx_date_time_base": tx_date_time_base,
        "tx_date_time_local": tx_date_time_local,
        "tx_day_of_week_base": tx_day_of_week_base,
        "tx_day_of_week_local": tx_day_of_week_local,
        "tx_type": tx_type,
        # raw account names passed through for the DB layer to resolve to UUIDs
        "source_account_name": _to_optional_str(raw_source_account),
        "target_account_name": _to_optional_str(raw_target_account),
        "tx_amount_local": tx_amount_local,
        "tx_currency_local": tx_currency_local,
        # tx_amount_base, tx_currency_base, local_to_base_currency_rate_ref resolved by DB layer via currency_rates
        "user_location_area": _to_optional_str(raw_user_location_area),
        "user_location_city": _to_optional_str(raw_user_location_city),
        "user_location_country": _to_optional_str(raw_user_location_country),
        "counterparty_name": _to_optional_str(raw_counterparty_name),
        "counterparty_location_area": _to_optional_str(raw_counterparty_location_area),
        "counterparty_location_city": _to_optional_str(raw_counterparty_location_city),
        "counterparty_location_country": _to_optional_str(raw_counterparty_location_country),
        "tx_tags": _to_optional_str(raw_tags),
        "tx_description": _to_optional_str(raw_description),
        # category lookup keys — not stored; used by DB layer to resolve category_id
        "major_category": _to_optional_str(raw_major_category),
        "minor_category": _to_optional_str(raw_minor_category),
    }
