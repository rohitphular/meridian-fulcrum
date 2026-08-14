# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.account_types
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.account_types"

COLS = [
    "id",
    "type",
    "sub_type",
    "is_deleted",
    "created_at",
    "deleted_at",
]


class Row(TypedDict):
    id: str
    type: str
    sub_type: str
    is_deleted: bool
    created_at: datetime
    deleted_at: datetime | None


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
