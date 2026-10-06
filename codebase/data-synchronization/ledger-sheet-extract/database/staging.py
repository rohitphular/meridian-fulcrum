from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg2.extras import execute_values
from py_logging import get_logger

logger = get_logger(__name__)
# Snapshots older than this are pruned at extract, except the newest and unfinished runs.
RETENTION = "6 months"
# One lock for both Sheet-facing modes; ledger-database-load uses (73421, 1).
LOCK_KEY = (73421, 2)
LOAD_LOCK_KEY = (73421, 1)


@dataclass(frozen=True)
class StagedRow:
    tab: str
    sheet_row_num: int
    source_id: str
    cells: dict[str, Any]
    outcome: tuple[str, str, str]


def take_lock(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s, %s)", LOCK_KEY)
        if not cursor.fetchone()[0]:
            raise RuntimeError("ledger_sheet_extract_already_running")


def take_load_lock(conn: Any) -> None:
    """Acknowledge holds ledger-database-load's lock too, so a reload of the same run
    (hard-sync) cannot change its outcomes while they are written to the Sheet."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s, %s)", LOAD_LOCK_KEY)
        if not cursor.fetchone()[0]:
            raise RuntimeError("ledger_database_load_running")


def canonical_id(value: Any) -> str:
    text = str(value).strip()
    try:
        return str(UUID(text))
    except ValueError:
        return text


def store_snapshot(conn: Any, snapshots: dict[str, tuple[list[str], list[dict[str, Any]]]]) -> str:
    """Store one complete snapshot in a single transaction; returns its run id.

    Older unfinished runs are superseded, so only the newest can be loaded; runs
    past retention are removed unless they are the newest or not yet finished.
    """
    run_id = str(uuid.uuid4())
    try:
        with conn.cursor() as cursor:
            cursor.execute("UPDATE stg_runs SET status = 'superseded' WHERE status IN ('extracted', 'loaded')")
            superseded = cursor.rowcount
            cursor.execute("INSERT INTO stg_runs (run_id, status, enabled_tabs) VALUES (%s, 'extracted', %s)", (run_id, list(snapshots)))
            for tab, (headers, rows) in snapshots.items():
                cursor.execute("INSERT INTO stg_sheet_headers (run_id, tab, headers) VALUES (%s, %s, %s::jsonb)", (run_id, tab, json.dumps(headers)))
                values = [(run_id, tab, row["_sheet_row_num"], canonical_id(row["id"]), json.dumps({key: value for key, value in row.items() if key != "_sheet_row_num"})) for row in rows]
                if values:
                    execute_values(cursor, "INSERT INTO stg_sheet_rows (run_id, tab, sheet_row_num, source_id, cells) VALUES %s", values, template="(%s::uuid, %s, %s, %s, %s::jsonb)")
                logger.info(f"store_snapshot: tab={tab} rows={len(rows)}")
            cursor.execute(
                "DELETE FROM stg_runs WHERE captured_at < now() - %s::interval AND run_id <> %s AND status IN ('acknowledged', 'superseded')",
                (RETENTION, run_id),
            )
            pruned = cursor.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    logger.info(f"store_snapshot: run_id={run_id} tabs={len(snapshots)} superseded_runs={superseded} pruned_runs={pruned}")
    return run_id


def latest_loaded_run(conn: Any) -> str | None:
    """The newest run when it has been loaded and not yet acknowledged; otherwise None."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT run_id, status FROM stg_runs ORDER BY captured_at DESC, run_id DESC LIMIT 1")
        record = cursor.fetchone()
    conn.commit()
    if record is None or record[1] != "loaded":
        return None
    return str(record[0])


def pending_outcomes(conn: Any, run_id: str) -> list[StagedRow]:
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT tab, sheet_row_num, source_id, cells, outcome_status, outcome_date, outcome_notes
               FROM stg_sheet_rows WHERE run_id = %s AND outcome_status IS NOT NULL AND NOT acknowledged
               ORDER BY tab, sheet_row_num""",
            (run_id,),
        )
        records = cursor.fetchall()
    conn.commit()
    return [StagedRow(tab, row, source_id, cells, (status, sync_date or "", notes or "")) for tab, row, source_id, cells, status, sync_date, notes in records]


def mark_acknowledged(conn: Any, run_id: str, rows: list[StagedRow]) -> None:
    try:
        with conn.cursor() as cursor:
            if rows:
                execute_values(
                    cursor,
                    """UPDATE stg_sheet_rows AS staged SET acknowledged = true FROM (VALUES %s) AS data (run_id, tab, sheet_row_num)
                       WHERE staged.run_id = data.run_id::uuid AND staged.tab = data.tab AND staged.sheet_row_num = data.sheet_row_num""",
                    [(run_id, row.tab, row.sheet_row_num) for row in rows],
                )
            cursor.execute("UPDATE stg_runs SET status = 'acknowledged', acknowledged_at = now() WHERE run_id = %s AND status = 'loaded'", (run_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
