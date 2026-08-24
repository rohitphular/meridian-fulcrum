# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.currency_master
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import date, datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.currency_master"

COLS = [
    "id",
    "currency_code",
    "currency_name",
    "currency_symbol",
    "decimal_places",
    "currency_type",
    "is_tracked",
    "currency_rank",
    "last_fetched_date",
    "created_at",
    "updated_at",
    "minor_unit_name",
]


class Row(TypedDict):
    id: str
    currency_code: str
    currency_name: str
    currency_symbol: str
    decimal_places: int
    currency_type: str
    is_tracked: bool
    currency_rank: int | None
    last_fetched_date: date | None
    created_at: datetime
    updated_at: datetime
    minor_unit_name: str


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
