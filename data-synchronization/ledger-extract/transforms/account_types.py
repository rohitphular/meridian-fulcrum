"""Validate account-type configuration without changing source identity or keys."""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from core.account_detail_contracts import CONTRACTS

_STATUSES = {"active", "inactive", "deleted", "locked"}
_KEY = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")


def transform(row: dict[str, Any]) -> dict[str, Any]:
    typed: dict[str, Any] = {}
    for field in ("id", "account_type_key", "account_type_label", "account_subtype_key", "account_subtype_label", "record_status"):
        value = row.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"account_types: required_{field}")
        typed[field] = value.strip()
    try:
        typed["id"] = str(UUID(typed["id"]))
    except ValueError as error:
        raise ValueError("account_types: invalid_id") from error
    for field in ("account_type_key", "account_subtype_key"):
        if _KEY.fullmatch(typed[field]) is None:
            raise ValueError(f"account_types: invalid_{field}")
    detail = row.get("detail_sheet")
    if detail is not None and not isinstance(detail, str):
        raise ValueError("account_types: invalid_detail_sheet")
    typed["detail_sheet"] = detail.strip() or None if isinstance(detail, str) else None
    if typed["detail_sheet"] is not None and typed["detail_sheet"] not in CONTRACTS:
        raise ValueError("account_types: invalid_detail_sheet")
    if typed["record_status"] not in _STATUSES:
        raise ValueError("account_types: invalid_record_status")
    description = row.get("description")
    if description is not None and not isinstance(description, str):
        raise ValueError("account_types: invalid_description")
    typed["description"] = None if description is None or str(description).strip() == "" else str(description).strip()
    return typed
