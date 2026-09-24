from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from transforms.dates import local_datetime

_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _required(row: dict[str, Any], field: str) -> str:
    value = _to_optional_str(row.get(field))
    if value is None:
        raise ValueError(f"accounts: field={field} is required")
    return value


def _local_date(raw: Any, field: str, timezone_name: str | None) -> str | None:
    value = _to_optional_str(raw)
    if value is None:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)?", value) is None:
        raise ValueError(f"accounts: field={field} must be an ISO local date or datetime without an offset")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"accounts: field={field} must be an ISO local date or datetime") from exc
    if parsed.tzinfo is not None:
        raise ValueError(f"accounts: field={field} must be local wall time without a UTC offset")
    if timezone_name is not None:
        local_datetime(parsed.isoformat(sep=" "), timezone_name, field)
    return value


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Map the current 19-column GAS account contract to database field names."""
    try:
        account_id = str(UUID(_required(row, "id")))
    except ValueError as exc:
        raise ValueError("accounts: field=id must be a valid UUID") from exc
    account_type = _required(row, "type")
    account_subtype = _required(row, "sub_type")
    for field, key in (("type", account_type), ("sub_type", account_subtype)):
        if re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", key) is None:
            raise ValueError(f"accounts: field={field} must be a hyphenated key")
    local_currency = _required(row, "account_currency_local").upper()
    if len(local_currency) != 3 or not local_currency.isascii() or not local_currency.isalpha():
        raise ValueError("accounts: field=account_currency_local must be a three-letter currency code")
    local_timezone = _to_optional_str(row.get("local_timezone"))
    if local_timezone is not None:
        try:
            ZoneInfo(local_timezone)
        except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
            raise ValueError("accounts: field=local_timezone must be a recognised IANA timezone") from exc
    opening_date = _local_date(row.get("account_opening_date_local"), "account_opening_date_local", local_timezone)
    closing_date = _local_date(row.get("account_closing_date_local"), "account_closing_date_local", local_timezone)
    tracking_date = _local_date(row.get("tracking_start_date_local"), "tracking_start_date_local", local_timezone)
    if opening_date is not None and closing_date is not None and datetime.fromisoformat(closing_date) < datetime.fromisoformat(opening_date):
        raise ValueError("accounts: account_closing_date_local precedes account_opening_date_local")
    opening_text = _required(row, "opening_value_local")
    # Match the source's ASCII decimal grammar; Decimal itself also accepts
    # underscores and Unicode digits, which are not valid source amounts.
    if isinstance(row["opening_value_local"], bool) or _DECIMAL.fullmatch(opening_text) is None:
        raise ValueError("accounts: field=opening_value_local must be a finite decimal number")
    try:
        opening_amount = Decimal(opening_text)
    except InvalidOperation as exc:
        raise ValueError("accounts: field=opening_value_local must be a decimal number") from exc
    if not opening_amount.is_finite():
        raise ValueError("accounts: field=opening_value_local must be finite")
    if account_type == "liability" and opening_amount > 0:
        raise ValueError("accounts: opening value must be nonpositive for liabilities")
    record_status = _required(row, "record_status")
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError("accounts: field=record_status must be active, inactive, deleted, or locked")
    return {
        "id": account_id,
        "account_name": _required(row, "account_name"),
        "legal_entity_name": _to_optional_str(row.get("legal_entity_name")),
        "account_type": account_type,
        "account_subtype": account_subtype,
        "local_currency": local_currency,
        "local_timezone": local_timezone,
        "opening_date_local": opening_date,
        "closing_date_local": closing_date,
        "tracking_start_date_local": tracking_date,
        "opening_amount_local_value": opening_amount,
        "account_description": _to_optional_str(row.get("description")),
        "record_status": record_status,
    }
