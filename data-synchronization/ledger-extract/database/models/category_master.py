# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.category_master
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.category_master"

COLS = [
    "id",
    "tx_type",
    "major_category",
    "minor_category",
    "description",
    "is_active",
    "tag_keywords",
    "counterparty_examples",
    "source_account_mandatory",
    "target_account_mandatory",
    "workflow_type",
    "is_subscription_eligible",
    "row_hash",
    "is_deleted",
    "created_at",
    "updated_at",
    "deleted_at",
]


class Row(TypedDict):
    id: str
    tx_type: str
    major_category: str
    minor_category: str
    description: str | None
    is_active: bool
    tag_keywords: str | None
    counterparty_examples: str | None
    source_account_mandatory: bool
    target_account_mandatory: bool
    workflow_type: str
    is_subscription_eligible: bool
    row_hash: str
    is_deleted: bool
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
