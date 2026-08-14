from __future__ import annotations

from datetime import datetime
from typing import Any

from py_logging import get_logger

logger = get_logger(__name__)

_JOB_NAME = "ledger-extract"


def bootstrap_job_state(conn: Any) -> None:
    """INSERT ON CONFLICT DO NOTHING with sentinel ran_at. Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO job_state (job_name, last_sheet_modified_at, ran_at)
            VALUES (%s, NULL, '1970-01-01T00:00:00Z'::timestamptz)
            ON CONFLICT (job_name) DO NOTHING
            """,
            (_JOB_NAME,),
        )
    conn.commit()


def read_last_sheet_modified_at(conn: Any) -> datetime | None:
    """Return last_sheet_modified_at for the job; None on first run."""
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT last_sheet_modified_at FROM job_state WHERE job_name = %s",
            (_JOB_NAME,),
        )
        row = cursor.fetchone()
    return row[0] if row else None


def update_ran_at(conn: Any) -> None:
    """UPDATE ran_at = now() (early-exit path). Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE job_state SET ran_at = now() WHERE job_name = %s",
            (_JOB_NAME,),
        )
    conn.commit()
    logger.info("job_state: update_ran_at committed")


def upsert_job_state(conn: Any, last_sheet_modified_at: datetime) -> None:
    """Phase 3 finalise — UPSERT with cached modified time. Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO job_state (job_name, last_sheet_modified_at, ran_at)
            VALUES (%s, %s, now())
            ON CONFLICT (job_name) DO UPDATE
                SET last_sheet_modified_at = EXCLUDED.last_sheet_modified_at,
                    ran_at = EXCLUDED.ran_at
            """,
            (_JOB_NAME, last_sheet_modified_at),
        )
    conn.commit()
    logger.info(f"job_state: upsert_job_state committed last_sheet_modified_at={last_sheet_modified_at.isoformat()}")
