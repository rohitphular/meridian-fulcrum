from __future__ import annotations

import hashlib
from typing import Any

_VALID_TX_TYPES = {"money-in", "money-out", "money-transfer"}
_VALID_WORKFLOW_TYPES = {"account-credit", "account-debit", "funds-transfer", "forex-transfer", "debt-repayment"}
_VALID_TX_WORKFLOW_COMBOS = {
    ("money-in", "account-credit"),
    ("money-out", "account-debit"),
    ("money-out", "debt-repayment"),
    ("money-transfer", "funds-transfer"),
    ("money-transfer", "forex-transfer"),
    ("money-transfer", "debt-repayment"),
}


def _parse_bool(raw: Any, field: str) -> bool:
    if raw is None or raw == "":
        raise ValueError(f"categories: field={field} is required but got empty/None")
    s = str(raw)
    if s in ("TRUE", "true", "1", "Yes"):
        return True
    if s in ("FALSE", "false", "0", "No"):
        return False
    raise ValueError(f"categories: field={field} value={s!r} is not a recognised boolean")


def _parse_bool_optional(raw: Any, field: str) -> bool:
    if raw is None or raw == "":
        return False
    return _parse_bool(raw, field)


def _normalise_account_types_for_hash(raw: Any) -> str:
    """Normalise account type tokens for inclusion in the hash."""
    if raw is None or str(raw).strip() == "":
        return ""
    return ",".join(sorted(t.strip() for t in str(raw).split(",") if t.strip()))


def _to_optional_str(raw: Any) -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    return raw


def transform(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-convert a raw sheet row dict.

    Raises ValueError with a clear message on any validation failure.
    """
    # --- Extract raw values ---
    raw_tx_type = row.get("tx_type")
    raw_major_category = row.get("major_category")
    raw_minor_category = row.get("minor_category")
    raw_description = row.get("description")
    raw_is_active = row.get("is_active")
    raw_tag_keywords = row.get("tag_keywords")
    raw_counterparty_examples = row.get("counterparty_examples")
    raw_source_account_mandatory = row.get("source_account_mandatory")
    raw_target_account_mandatory = row.get("target_account_mandatory")
    raw_workflow_type = row.get("workflow_type")
    raw_is_subscription_eligible = row.get("is_subscription_eligible")
    raw_source_account_types = row.get("source_account_types")
    raw_target_account_types = row.get("target_account_types")

    # --- Validation ---

    # tx_type
    if raw_tx_type is None or str(raw_tx_type).strip() == "":
        raise ValueError("categories: field=tx_type is required but got empty/None")
    tx_type = str(raw_tx_type).strip()
    if "|" in tx_type:
        raise ValueError(f"categories: field=tx_type value={tx_type!r} contains invalid character '|'")
    if tx_type not in _VALID_TX_TYPES:
        raise ValueError(f"categories: field=tx_type value={tx_type!r} not in {_VALID_TX_TYPES}")

    # major_category
    if raw_major_category is None or str(raw_major_category).strip() == "":
        raise ValueError("categories: field=major_category is required but got empty/None")
    major_category = str(raw_major_category).strip()
    if "|" in major_category:
        raise ValueError(f"categories: field=major_category value={major_category!r} contains invalid character '|'")

    # minor_category
    if raw_minor_category is None or str(raw_minor_category).strip() == "":
        raise ValueError("categories: field=minor_category is required but got empty/None")
    minor_category = str(raw_minor_category).strip()
    if "|" in minor_category:
        raise ValueError(f"categories: field=minor_category value={minor_category!r} contains invalid character '|'")

    # is_active
    is_active = _parse_bool(raw_is_active, "is_active")

    # source_account_mandatory / target_account_mandatory
    source_account_mandatory = _parse_bool(raw_source_account_mandatory, "source_account_mandatory")
    target_account_mandatory = _parse_bool(raw_target_account_mandatory, "target_account_mandatory")

    # At least one of source/target must be mandatory
    if not source_account_mandatory and not target_account_mandatory:
        raise ValueError(f"categories: natural_key={tx_type}|{raw_major_category}|{raw_minor_category} source_account_mandatory and target_account_mandatory cannot both be False")

    # workflow_type
    if raw_workflow_type is None or str(raw_workflow_type).strip() == "":
        raise ValueError("categories: field=workflow_type is required but got empty/None")
    workflow_type = str(raw_workflow_type).strip()
    if workflow_type not in _VALID_WORKFLOW_TYPES:
        raise ValueError(f"categories: field=workflow_type value={workflow_type!r} not in {_VALID_WORKFLOW_TYPES}")
    if (tx_type, workflow_type) not in _VALID_TX_WORKFLOW_COMBOS:
        raise ValueError(f"categories: tx_type={tx_type!r} workflow_type={workflow_type!r} is not a valid combination")

    # is_subscription_eligible (optional — default False)
    is_subscription_eligible = _parse_bool_optional(raw_is_subscription_eligible, "is_subscription_eligible")

    # --- Hash computation (using raw sheet strings) ---
    # Normalise account type fields for hash only
    hash_source_account_types = _normalise_account_types_for_hash(raw_source_account_types)
    hash_target_account_types = _normalise_account_types_for_hash(raw_target_account_types)

    ordered_values = [
        raw_tx_type,
        raw_major_category,
        raw_minor_category,
        raw_description,
        raw_is_active,
        raw_tag_keywords,
        raw_counterparty_examples,
        raw_source_account_mandatory,
        raw_target_account_mandatory,
        raw_workflow_type,
        raw_is_subscription_eligible,
        hash_source_account_types,
        hash_target_account_types,
    ]
    row_hash = hashlib.sha256("|".join("" if v is None else str(v) for v in ordered_values).encode()).hexdigest()

    natural_key = f"{tx_type}|{raw_major_category}|{raw_minor_category}"

    return {
        "tx_type": tx_type,
        "major_category": raw_major_category,
        "minor_category": raw_minor_category,
        "description": _to_optional_str(raw_description),
        "is_active": is_active,
        "tag_keywords": _to_optional_str(raw_tag_keywords),
        "counterparty_examples": _to_optional_str(raw_counterparty_examples),
        "source_account_mandatory": source_account_mandatory,
        "target_account_mandatory": target_account_mandatory,
        "workflow_type": workflow_type,
        "is_subscription_eligible": is_subscription_eligible,
        "source_account_types": _to_optional_str(raw_source_account_types),
        "target_account_types": _to_optional_str(raw_target_account_types),
        "row_hash": row_hash,
        "natural_key": natural_key,
    }
