# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.currency_rates
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import date, datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.currency_rates"

COLS = [
    "id",
    "rate_date",
    "base_currency_code",
    "quote_currency_code",
    "rate_value",
    "rate_source",
    "created_at",
    "updated_at",
]


class Row(TypedDict):
    id: str
    rate_date: date
    base_currency_code: str
    quote_currency_code: str
    rate_value: float
    rate_source: str
    created_at: datetime
    updated_at: datetime


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
