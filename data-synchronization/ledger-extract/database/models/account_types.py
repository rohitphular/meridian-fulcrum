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
    "account_type_key",
    "account_subtype_key",
    "description",
    "record_status",
    "created_at",
    "updated_at",
    "account_type_label",
    "account_subtype_label",
    "is_sheet_managed",
    "sync_status",
    "sync_date",
    "sync_notes",
    "is_loan",
    "detail_sheet",
]


class Row(TypedDict):
    id: str
    account_type_key: str
    account_subtype_key: str
    description: str | None
    record_status: str
    created_at: datetime
    updated_at: datetime
    account_type_label: str
    account_subtype_label: str
    is_sheet_managed: bool
    sync_status: str | None
    sync_date: datetime | None
    sync_notes: str | None
    is_loan: bool
    detail_sheet: str | None


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
