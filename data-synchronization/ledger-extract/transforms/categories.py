from __future__ import annotations

from typing import Any

_VALID_TX_TYPES = {"money-in", "money-out"}
_VALID_RECORD_STATUSES = {"active", "inactive", "deleted", "locked"}


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return str(raw).strip()


def _parse_bool_default_false(raw: Any, field: str) -> bool:
    if raw is None or str(raw).strip() == "":
        return False
    s = str(raw).strip()
    if s in ("TRUE", "true", "1", "Yes", "yes"):
        return True
    if s in ("FALSE", "false", "0", "No", "no"):
        return False
    raise ValueError(f"categories: field={field} value={s!r} is not a recognised boolean")


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw categories sheet row dict.

    Raises ValueError with a clear message on any validation failure.
    """
    # tx_type_key
    raw_tx_type_key = row.get("tx_type_key")
    if raw_tx_type_key is None or str(raw_tx_type_key).strip() == "":
        raise ValueError("categories: field=tx_type_key is required but got empty/None")
    tx_type_key = str(raw_tx_type_key).strip()
    if tx_type_key not in _VALID_TX_TYPES:
        raise ValueError(f"categories: field=tx_type_key value={tx_type_key!r} not in {_VALID_TX_TYPES}")

    # tx_type_label
    raw_tx_type_label = row.get("tx_type_label")
    if raw_tx_type_label is None or str(raw_tx_type_label).strip() == "":
        raise ValueError("categories: field=tx_type_label is required but got empty/None")
    tx_type_label = str(raw_tx_type_label).strip()

    # major_category_key
    raw_major_category_key = row.get("major_category_key")
    if raw_major_category_key is None or str(raw_major_category_key).strip() == "":
        raise ValueError("categories: field=major_category_key is required but got empty/None")
    major_category_key = str(raw_major_category_key).strip()
    if "|" in major_category_key:
        raise ValueError(f"categories: field=major_category_key value={major_category_key!r} contains invalid character '|'")

    # major_category_label
    raw_major_category_label = row.get("major_category_label")
    if raw_major_category_label is None or str(raw_major_category_label).strip() == "":
        raise ValueError("categories: field=major_category_label is required but got empty/None")
    major_category_label = str(raw_major_category_label).strip()

    # minor_category_key
    raw_minor_category_key = row.get("minor_category_key")
    if raw_minor_category_key is None or str(raw_minor_category_key).strip() == "":
        raise ValueError("categories: field=minor_category_key is required but got empty/None")
    minor_category_key = str(raw_minor_category_key).strip()
    if "|" in minor_category_key:
        raise ValueError(f"categories: field=minor_category_key value={minor_category_key!r} contains invalid character '|'")

    # minor_category_label
    raw_minor_category_label = row.get("minor_category_label")
    if raw_minor_category_label is None or str(raw_minor_category_label).strip() == "":
        raise ValueError("categories: field=minor_category_label is required but got empty/None")
    minor_category_label = str(raw_minor_category_label).strip()

    # record_status
    raw_record_status = row.get("record_status")
    if raw_record_status is None or str(raw_record_status).strip() == "":
        raise ValueError("categories: field=record_status is required but got empty/None")
    record_status = str(raw_record_status).strip()
    if record_status not in _VALID_RECORD_STATUSES:
        raise ValueError(f"categories: field=record_status value={record_status!r} not in {_VALID_RECORD_STATUSES}")

    # Boolean fields — default False if empty or None
    source_account_mandatory = _parse_bool_default_false(row.get("source_account_mandatory"), "source_account_mandatory")
    target_account_mandatory = _parse_bool_default_false(row.get("target_account_mandatory"), "target_account_mandatory")
    is_subscription_eligible = _parse_bool_default_false(row.get("is_subscription_eligible"), "is_subscription_eligible")

    natural_key = f"{tx_type_key}|{major_category_key}|{minor_category_key}"

    return {
        "tx_type_key": tx_type_key,
        "tx_type_label": tx_type_label,
        "major_category_key": major_category_key,
        "major_category_label": major_category_label,
        "minor_category_key": minor_category_key,
        "minor_category_label": minor_category_label,
        "description": _to_optional_str(row.get("description")),
        "tag_keywords": _to_optional_str(row.get("tag_keywords")),
        "counterparty_examples": _to_optional_str(row.get("counterparty_examples")),
        "source_account_mandatory": source_account_mandatory,
        "target_account_mandatory": target_account_mandatory,
        "is_subscription_eligible": is_subscription_eligible,
        "record_status": record_status,
        "natural_key": natural_key,
    }
