# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.ledger_data_checksums
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.ledger_data_checksums"

COLS = [
    "entity",
    "natural_key",
    "row_hash",
    "last_seen_at",
]


class Row(TypedDict):
    entity: str
    natural_key: str
    row_hash: str
    last_seen_at: datetime


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
