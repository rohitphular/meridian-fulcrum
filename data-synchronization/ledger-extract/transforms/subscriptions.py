from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

_VALID_FREQUENCIES = {"weekly", "monthly", "quarterly", "annual"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}
_VALID_TX_TYPES = {"money-in", "money-out"}
_MONTHLY_FREQUENCIES = {"monthly", "quarterly", "annual"}


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw subscriptions sheet row.

    Raises ValueError with prefix 'subscriptions: ' on any validation failure.
    """
    # Column 1 — id → subscription_id
    raw_id = row.get("id")
    if raw_id is None or str(raw_id).strip() == "":
        raise ValueError("subscriptions: id_required")
    subscription_id = str(raw_id).strip()

    # Column 2 — subscription_name → name
    raw_name = row.get("subscription_name")
    if raw_name is None or str(raw_name).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} name_required")
    name = str(raw_name).strip()

    # Column 3 — counterparty_name (optional)
    raw_counterparty_name = row.get("counterparty_name")
    if raw_counterparty_name is not None and str(raw_counterparty_name).strip() != "":
        counterparty_name: str | None = str(raw_counterparty_name).strip()
    else:
        counterparty_name = None

    # Column 4 — subscription_amount_local → amount_local as Decimal
    raw_amount = row.get("subscription_amount_local")
    if raw_amount is None or str(raw_amount).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=subscription_amount_local is required but got empty/None")
    try:
        amount_local = Decimal(str(raw_amount).strip())
    except InvalidOperation:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=subscription_amount_local value={raw_amount!r} is not a valid decimal number")
    if not amount_local.is_finite():
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=subscription_amount_local value={raw_amount!r} is not finite")
    if amount_local <= 0:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=subscription_amount_local value={amount_local} must be > 0")

    # Column 5 — frequency
    raw_frequency = row.get("frequency")
    if raw_frequency is None or str(raw_frequency).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=frequency is required but got empty/None")
    frequency = str(raw_frequency).strip()
    if frequency not in _VALID_FREQUENCIES:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=frequency value={frequency!r} must be one of weekly, monthly, quarterly, annual")

    # Column 6 — day_of_month
    raw_day_of_month = row.get("day_of_month")
    raw_day_of_month_str = str(raw_day_of_month).strip() if raw_day_of_month is not None else ""
    day_of_month: int | None

    if frequency in _MONTHLY_FREQUENCIES:
        if raw_day_of_month_str == "":
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} missing_day_of_month — required when frequency={frequency!r}")
        try:
            day_of_month = int(raw_day_of_month_str)
        except (ValueError, TypeError):
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_month value={raw_day_of_month_str!r} — must be an integer 1–31")
        if not (1 <= day_of_month <= 31):
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_month value={day_of_month} — must be between 1 and 31")
    else:
        # weekly — optional; validate if non-blank
        if raw_day_of_month_str != "":
            try:
                day_of_month = int(raw_day_of_month_str)
            except (ValueError, TypeError):
                raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_month value={raw_day_of_month_str!r} — must be an integer 1–31")
            if not (1 <= day_of_month <= 31):
                raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_month value={day_of_month} — must be between 1 and 31")
        else:
            day_of_month = None

    # Column 7 — day_of_week
    raw_day_of_week = row.get("day_of_week")
    raw_day_of_week_str = str(raw_day_of_week).strip() if raw_day_of_week is not None else ""
    day_of_week: int | None

    if frequency == "weekly":
        if raw_day_of_week_str == "":
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} missing_day_of_week — required when frequency='weekly'")
        try:
            day_of_week = int(raw_day_of_week_str)
        except (ValueError, TypeError):
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_week value={raw_day_of_week_str!r} — must be an integer 1–7")
        if not (1 <= day_of_week <= 7):
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_week value={day_of_week} — must be between 1 and 7")
    else:
        # non-weekly — optional; validate if non-blank
        if raw_day_of_week_str != "":
            try:
                day_of_week = int(raw_day_of_week_str)
            except (ValueError, TypeError):
                raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_week value={raw_day_of_week_str!r} — must be an integer 1–7")
            if not (1 <= day_of_week <= 7):
                raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_day_of_week value={day_of_week} — must be between 1 and 7")
        else:
            day_of_week = None

    # Column 8 — source_account → account_id_sheet
    raw_source_account = row.get("source_account")
    if raw_source_account is None or str(raw_source_account).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=source_account is required but got empty/None")
    account_id_sheet = str(raw_source_account).strip()

    # Column 9 — tx_type
    raw_tx_type = row.get("tx_type")
    if raw_tx_type is None or str(raw_tx_type).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} tx_type_required")
    tx_type = str(raw_tx_type).strip()
    if tx_type not in _VALID_TX_TYPES:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_tx_type value={tx_type!r} — must be money-in or money-out")

    # Column 10 — major_category
    raw_major_category = row.get("major_category")
    if raw_major_category is None or str(raw_major_category).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} major_category_required")
    major_category = str(raw_major_category).strip()

    # Column 11 — minor_category
    raw_minor_category = row.get("minor_category")
    if raw_minor_category is None or str(raw_minor_category).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} minor_category_required")
    minor_category = str(raw_minor_category).strip()

    # Column 12 — description (optional)
    raw_description = row.get("description")
    if raw_description is not None and str(raw_description).strip() != "":
        description: str | None = str(raw_description).strip()
    else:
        description = None

    # Column 13 — record_status
    raw_record_status = row.get("record_status")
    if raw_record_status is None or str(raw_record_status).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=record_status is required but got empty/None")
    record_status = str(raw_record_status).strip()
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} field=record_status value={record_status!r} not in {_VALID_RECORD_STATUSES}")

    # Columns 14–18 are write-back only — not read here.

    # Column 19 — subscription_start_date_local
    raw_start_date = row.get("subscription_start_date_local")
    if raw_start_date is None or str(raw_start_date).strip() == "":
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} subscription_start_date_required")
    try:
        subscription_start_date_local = datetime.strptime(str(raw_start_date).strip(), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_subscription_start_date value={raw_start_date!r} — expected YYYY-MM-DD HH:MM:SS")

    # Column 20 — subscription_end_date_local (optional)
    raw_end_date = row.get("subscription_end_date_local")
    subscription_end_date_local: datetime | None
    if raw_end_date is not None and str(raw_end_date).strip() != "":
        try:
            subscription_end_date_local = datetime.strptime(str(raw_end_date).strip(), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            raise ValueError(f"subscriptions: subscription_id={subscription_id!r} invalid_subscription_end_date value={raw_end_date!r} — expected YYYY-MM-DD HH:MM:SS")
    else:
        subscription_end_date_local = None

    # Column 21 — subscription_timezone_local (optional; pass through as-is)
    raw_timezone = row.get("subscription_timezone_local")
    if raw_timezone is not None and str(raw_timezone).strip() != "":
        subscription_timezone_local: str | None = str(raw_timezone).strip()
    else:
        subscription_timezone_local = None

    return {
        "subscription_id": subscription_id,
        "name": name,
        "counterparty_name": counterparty_name,
        "amount_local": amount_local,
        "frequency": frequency,
        "day_of_month": day_of_month,
        "day_of_week": day_of_week,
        "account_id_sheet": account_id_sheet,
        "tx_type": tx_type,
        "major_category": major_category,
        "minor_category": minor_category,
        "description": description,
        "record_status": record_status,
        "subscription_start_date_local": subscription_start_date_local,
        "subscription_end_date_local": subscription_end_date_local,
        "subscription_timezone_local": subscription_timezone_local,
    }
