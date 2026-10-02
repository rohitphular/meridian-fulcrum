from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg2.extras import execute_values
from py_logging import get_logger

from core.source_contracts import HEADERS, validate_headers

logger = get_logger(__name__)
_SYNC_FIELDS = ("sync_status", "sync_date", "sync_notes")


@dataclass(frozen=True)
class StagingRun:
    run_id: str
    status: str
    enabled_tabs: tuple[str, ...]


def latest_run(conn: Any, *, allow_acknowledged: bool = False) -> StagingRun | None:
    """The newest extract run. None when it is already acknowledged (nothing new to load),
    unless `allow_acknowledged` (hard-sync): then it is loaded again and needs a new acknowledge.

    Only the newest run is ever loaded, so an older snapshot can never be replayed
    over newer database values; a new extract supersedes older unfinished runs.
    """
    with conn.cursor() as cursor:
        cursor.execute("SELECT run_id, status, enabled_tabs FROM stg_runs ORDER BY captured_at DESC, run_id DESC LIMIT 1")
        record = cursor.fetchone()
    conn.commit()
    if record is None:
        raise ValueError("no_staged_snapshot")
    run = StagingRun(str(record[0]), record[1], tuple(record[2]))
    if run.status == "acknowledged" and not allow_acknowledged:
        return None
    if run.status not in ("extracted", "loaded", "acknowledged"):
        raise ValueError(f"latest_snapshot_not_loadable:{run.status}")
    return run


class StagingSource:
    """Rows of one staged snapshot, and the sync outcome of each row the load handles.

    Takes the place of the Google Sheets client: the writers read `snapshot_rows`
    and queue outcomes through `batch_update_rows`; `flush_pending` stores them in
    staging for the acknowledge step. Nothing here talks to Google.
    """

    def __init__(self, conn: Any, run: StagingRun) -> None:
        self._conn = conn
        self.run = run
        self._snapshots: dict[str, list[dict[str, Any]]] = {}
        self._pending: dict[tuple[str, int], list[Any]] = {}

    def capture(self, names: list[str]) -> None:
        """Load and check the staged tabs (headers against the current sheet contract)."""
        with self._conn.cursor() as cursor:
            for name in names:
                cursor.execute("SELECT headers FROM stg_sheet_headers WHERE run_id = %s AND tab = %s", (self.run.run_id, name))
                record = cursor.fetchone()
                if record is None:
                    raise ValueError(f"tab_not_staged:{name}")
                validate_headers(name, list(record[0]))
                cursor.execute("SELECT sheet_row_num, cells FROM stg_sheet_rows WHERE run_id = %s AND tab = %s ORDER BY sheet_row_num", (self.run.run_id, name))
                self._snapshots[name] = [{**cells, "_sheet_row_num": row_number} for row_number, cells in cursor.fetchall()]
            # A reload of the same snapshot starts from no outcomes.
            cursor.execute("UPDATE stg_sheet_rows SET outcome_status = NULL, outcome_date = NULL, outcome_notes = NULL WHERE run_id = %s", (self.run.run_id,))
        self._conn.commit()

    def snapshot_rows(self, name: str) -> list[dict[str, Any]]:
        # Copies isolate handler normalisation/reconciliation from the stored snapshot.
        records = [row.copy() for row in self._snapshots[name] if any(value not in (None, "") for key, value in row.items() if key != "_sheet_row_num")]
        for record in records:
            record["id"] = str(UUID(str(record["id"]).strip()))
            for reference in ("parent_tx_id", "account_id"):
                if str(record.get(reference) or "").strip():
                    try:
                        record[reference] = str(UUID(str(record[reference]).strip()))
                    except ValueError:
                        pass  # The row handler reports invalid references to sync_notes.
        return records

    def batch_update_rows(self, name: str, updates: list[tuple[int, int, list[Any]]]) -> None:
        """Queue committed successes or validation failures: only the three sync cells."""
        for row_number, column, values in updates:
            fields = tuple(HEADERS[name][column - 1 : column - 1 + len(values)])
            if fields != _SYNC_FIELDS:
                raise ValueError("writeback_must_only_touch_sync_fields")
            if not any(row["_sheet_row_num"] == row_number for row in self._snapshots[name]):
                raise ValueError("writeback_row_outside_snapshot")
            self._pending[(name, row_number)] = list(values)

    def assert_unchanged(self) -> None:
        """A staged snapshot cannot change; edits made after it are left to the acknowledge step."""

    def flush_pending(self, *, mode: str) -> None:
        """Store the queued outcomes and mark the run loaded, also after a failed load."""
        self._conn.rollback()
        with self._conn.cursor() as cursor:
            if self._pending:
                execute_values(
                    cursor,
                    """UPDATE stg_sheet_rows AS staged SET outcome_status = data.status, outcome_date = data.sync_date, outcome_notes = data.notes, acknowledged = false
                       FROM (VALUES %s) AS data (run_id, tab, sheet_row_num, status, sync_date, notes)
                       WHERE staged.run_id = data.run_id::uuid AND staged.tab = data.tab AND staged.sheet_row_num = data.sheet_row_num""",
                    [(self.run.run_id, name, row, *values) for (name, row), values in self._pending.items()],
                )
            # A newer extract may have superseded this run meanwhile; then it stays superseded.
            # A hard-sync reload of an acknowledged run makes it loaded again, to be re-acknowledged.
            cursor.execute(
                """UPDATE stg_runs SET status = 'loaded', loaded_at = now(), load_mode = %s, acknowledged_at = NULL
                   WHERE run_id = %s AND (status IN ('extracted', 'loaded') OR (status = 'acknowledged' AND %s))""",
                (mode, self.run.run_id, mode == "hard-sync"),
            )
        self._conn.commit()
        logger.info(f"flush_pending: run_id={self.run.run_id} outcomes={len(self._pending)}")
        self._pending.clear()
