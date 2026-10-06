from __future__ import annotations

from collections import defaultdict
from typing import Any

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import database.staging as staging
from sheets.client import SYNC_FIELDS, SnapshotSheetsClient, cell_range

logger = get_logger(__name__)


def extract(db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str, tabs: list[str]) -> None:
    """One batched read of the enabled tabs into a new staging snapshot."""
    if not tabs:
        logger.info("extract: enabled_tabs=0")
        return
    conn = get_client(db_config)
    try:
        staging.take_lock(conn)
        client = SnapshotSheetsClient(service_account_file, spreadsheet_id)
        client.capture(tabs)
        staging.store_snapshot(conn, {tab: client.snapshot(tab) for tab in tabs})
    finally:
        conn.close()


def _same_cells(staged: dict[str, Any], current: dict[str, Any]) -> bool:
    """Every cell except the sync cells, compared with types (False must not equal 0).

    A column added to the tab since the snapshot is not an edit while it is blank;
    a column that has gone, or a filled new one, is.
    """
    keys = (set(staged) | set(current)) - {"_sheet_row_num", *SYNC_FIELDS}
    for key in keys:
        if key not in staged and current[key] in (None, ""):
            continue
        if key not in staged or key not in current:
            return False
        if type(staged[key]) is not type(current[key]) or staged[key] != current[key]:
            return False
    return True


def acknowledge(db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str) -> None:
    """Write the loaded run's outcomes to the Sheet's sync cells, matching rows by id.

    A row edited since the snapshot (any cell but the sync cells differs), or no longer
    found exactly once, is left as it is: it stays pending and the next run picks it up.
    """
    conn = get_client(db_config)
    try:
        staging.take_lock(conn)
        staging.take_load_lock(conn)
        run_id = staging.latest_loaded_run(conn)
        if run_id is None:
            logger.info("acknowledge: nothing_to_acknowledge=true reason=newest_snapshot_not_loaded_or_already_acknowledged")
            return
        outcomes = staging.pending_outcomes(conn, run_id)
        by_tab: dict[str, list[staging.StagedRow]] = defaultdict(list)
        for row in outcomes:
            by_tab[row.tab].append(row)
        written: list[staging.StagedRow] = []
        counts: dict[str, dict[str, int]] = {}
        if by_tab:
            client = SnapshotSheetsClient(service_account_file, spreadsheet_id)

            def plan() -> list[dict[str, Any]]:
                written.clear()
                counts.clear()
                ranges: list[dict[str, Any]] = []
                current = client.read_tabs(list(by_tab))
                for tab, staged_rows in by_tab.items():
                    headers, rows = current[tab]
                    columns = {field: headers.index(field) + 1 for field in SYNC_FIELDS}
                    by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
                    for row in rows:
                        if any(value not in (None, "") for key, value in row.items() if key != "_sheet_row_num"):
                            by_id[staging.canonical_id(row.get("id", ""))].append(row)
                    tally = counts.setdefault(tab, {"written": 0, "edited_since_snapshot": 0, "not_found": 0})
                    for staged in staged_rows:
                        matches = by_id.get(staged.source_id, [])
                        if len(matches) != 1:
                            tally["not_found"] += 1
                            continue
                        if not _same_cells(staged.cells, matches[0]):
                            tally["edited_since_snapshot"] += 1
                            continue
                        ranges.extend(cell_range(tab, matches[0]["_sheet_row_num"], columns[field], value) for field, value in zip(SYNC_FIELDS, staged.outcome))
                        written.append(staged)
                        tally["written"] += 1
                return ranges

            client.write_with_retry(plan)
        staging.mark_acknowledged(conn, run_id, written)
        for tab, tally in counts.items():
            logger.info(f"acknowledge: tab={tab} written={tally['written']} edited_since_snapshot={tally['edited_since_snapshot']} not_found={tally['not_found']}")
        logger.info(f"acknowledge: run_id={run_id} outcomes={len(outcomes)} written={len(written)}")
    finally:
        conn.close()
