from __future__ import annotations

from typing import Any
from uuid import UUID

_VALID_TX_TYPES = {"money-in", "money-out"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _required(row: dict[str, Any], field: str) -> str:
    value = _to_optional_str(row.get(field))
    if value is None:
        raise ValueError(f"categories: field={field} is required")
    return value


def _parse_bool_default_false(raw: Any, field: str) -> bool:
    if raw is None or str(raw).strip() == "":
        return False
    value = str(raw).strip().lower()
    if value in ("true", "1", "yes"):
        return True
    if value in ("false", "0", "no"):
        return False
    raise ValueError(f"categories: field={field} must be a boolean")


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate category identity, classification and booleans before database writes."""
    try:
        category_id = str(UUID(_required(row, "id")))
    except ValueError as exc:
        raise ValueError("categories: field=id must be a valid UUID") from exc
    typed: dict[str, Any] = {"id": category_id}
    for field in ("tx_type_key", "tx_type_label", "major_category_key", "major_category_label", "minor_category_key", "minor_category_label", "record_status"):
        typed[field] = _required(row, field)
    if typed["tx_type_key"] not in _VALID_TX_TYPES:
        raise ValueError("categories: field=tx_type_key must be money-in or money-out")
    if typed["record_status"] not in _VALID_RECORD_STATUSES:
        raise ValueError("categories: field=record_status must be active, inactive, deleted, or locked")
    for field in ("major_category_key", "minor_category_key"):
        if "|" in typed[field]:
            raise ValueError(f"categories: field={field} cannot contain '|'")
    for field in ("description", "tag_keywords", "counterparty_examples"):
        typed[field] = _to_optional_str(row.get(field))
    for field in ("source_account_mandatory", "target_account_mandatory", "is_subscription_eligible"):
        typed[field] = _parse_bool_default_false(row.get(field), field)
    typed["natural_key"] = "|".join(typed[field] for field in ("tx_type_key", "major_category_key", "minor_category_key"))
    return typed
