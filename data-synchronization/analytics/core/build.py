"""build: compute every report into analytics.report_output, from one consistent snapshot.

1. Take the analytics lock (73421, 3) and commit a `running` run row.
2. In ONE REPEATABLE READ transaction: record what was read (source watermark), run each
   build step (mart, pre-built reports, user reports: tasks 09-11), mark the run built,
   commit. Every read sees the same snapshot even while a load commits row by row, and a
   failure leaves no partial output: the run is marked failed and the transaction rolled back.
3. Prune old generations (config.yaml keep_generations).
Nothing here touches the Sheet: publishing is a separate step.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from datetime import date, datetime, timezone
from typing import Any

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import core.config as config
import database.runs as runs
from core.context import BuildContext
from core.errors import error_code

logger = get_logger(__name__)


# Steps run in order inside the build transaction: step(conn, context): the mart, then
# the pre-built and user-defined reports (core/steps.py).
def _default_steps() -> list[tuple[str, Callable[[Any, BuildContext], None]]]:
    from core.steps import STEPS

    return list(STEPS)


BUILD_STEPS: list[tuple[str, Callable[[Any, BuildContext], None]]] = _default_steps()


def build(db_config: ConnectionConfig, *, mode: str = "build", anchor_date: date | None = None, keep: int | None = None) -> str:
    """Returns the generation id of the built run."""
    contract_version = config.contract("report-definition")["contract_version"]
    keep = config.keep_generations(config.load_config()) if keep is None else keep
    anchor = anchor_date or datetime.now(timezone.utc).date()
    conn = get_client(db_config)
    try:
        runs.take_lock(conn)
        runs.require_source_tables(conn)
        generation_id = str(uuid.uuid4())
        runs.start(conn, generation_id, mode, anchor, contract_version)
        logger.info(f"build: generation_id={generation_id} anchor_date={anchor} contract_version={contract_version} steps={len(BUILD_STEPS)}")
        started = time.monotonic()
        context = BuildContext(generation_id, anchor)
        try:
            with conn.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            watermark = runs.source_watermark(conn)
            for name, step in BUILD_STEPS:
                step_started = time.monotonic()
                step(conn, context)
                logger.info(f"build: step={name} seconds={time.monotonic() - step_started:.1f}")
            runs.finish(conn, generation_id, watermark, context.counts())
            conn.commit()
        except BaseException as error:
            conn.rollback()
            runs.fail(conn, generation_id, error_code(error))
            raise
        removed = runs.prune(conn, keep)
        logger.info(
            f"build: complete=true generation_id={generation_id} reports_ok={context.reports_ok} reports_failed={context.reports_failed} "
            f"rows_not_loaded={context.rows_not_loaded} missing_currencies={len(context.missing_currencies)} pruned={removed} seconds={time.monotonic() - started:.1f}"
        )
        return generation_id
    finally:
        conn.close()  # also releases the session lock


def check(db_config: ConnectionConfig) -> dict[str, Any]:
    """Reads only: the analytics schema is migrated and the report definitions are visible."""
    conn = get_client(db_config)
    try:
        runs.require_source_tables(conn)
        with conn.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM analytics.run")
            run_count = cursor.fetchone()[0]
            cursor.execute("SELECT report_type, record_status, count(*) FROM report_master GROUP BY 1, 2 ORDER BY 1, 2")
            definitions = {f"{report_type}:{status}": count for report_type, status, count in cursor.fetchall()}
        conn.rollback()
    finally:
        conn.close()
    summary = ", ".join(f"{key}={value}" for key, value in definitions.items()) or "none"
    logger.info(f"check: runs={run_count} contract_version={config.contract('report-definition')['contract_version']} report_master={summary}")
    return {"runs": run_count, "report_master": definitions}
