from __future__ import annotations

from datetime import datetime
from typing import Any

from py_logging import get_logger

logger = get_logger(__name__)

_JOB_NAME = "ledger-extract"


def bootstrap_job_execution_details(conn: Any) -> None:
    """INSERT ON CONFLICT DO NOTHING with sentinel ran_at. Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO job_execution_details (job_name, last_sheet_modified_at, ran_at)
            VALUES (%s, NULL, '1970-01-01T00:00:00Z'::timestamptz)
            ON CONFLICT (job_name) DO NOTHING
            """,
            (_JOB_NAME,),
        )
    conn.commit()


def upsert_job_execution_details(conn: Any, last_sheet_modified_at: datetime) -> None:
    """Phase 3 finalise — UPSERT with cached modified time. Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO job_execution_details (job_name, last_sheet_modified_at, ran_at)
            VALUES (%s, %s, now())
            ON CONFLICT (job_name) DO UPDATE
                SET last_sheet_modified_at = EXCLUDED.last_sheet_modified_at,
                    ran_at = EXCLUDED.ran_at
            """,
            (_JOB_NAME, last_sheet_modified_at),
        )
    conn.commit()
    logger.info(f"upsert_job_execution_details: committed last_sheet_modified_at={last_sheet_modified_at.isoformat()}")
