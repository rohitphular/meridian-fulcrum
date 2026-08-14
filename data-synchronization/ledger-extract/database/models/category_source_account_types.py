# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.category_source_account_types
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.category_source_account_types"

COLS = [
    "category_id",
    "account_type_id",
]


class Row(TypedDict):
    category_id: str
    account_type_id: str


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
