# AUTO-GENERATED — do not edit manually.
# Tool: py-db-schema 0.1.0  DB: postgres  Table: public.job_execution_details
# Regenerate: py-db-schema generate --db postgres

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

__all__ = ["TABLE", "COLS", "Row", "to_row"]

TABLE = "public.job_execution_details"

COLS = [
    "job_name",
    "last_sheet_modified_at",
    "ran_at",
]


class Row(TypedDict):
    job_name: str
    last_sheet_modified_at: datetime | None
    ran_at: datetime


def to_row(record: Row) -> list:
    return [record[col] for col in COLS]
