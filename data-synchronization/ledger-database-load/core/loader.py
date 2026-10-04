from __future__ import annotations

import signal
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import database.account_details as account_details_db
import database.account_types as account_types_db
import database.accounts as accounts_db
import database.categories as categories_db
import database.reports as reports_db
import database.subscriptions as subscriptions_db
import database.transactions as transactions_db
from core.account_detail_contracts import CONTRACTS, SYNC_DETAIL_SHEETS
from core.staging_source import StagingSource, latest_run

logger = get_logger(__name__)


@contextmanager
def _uninterruptible() -> Iterator[None]:
    """Storing the outcomes must finish once started: Ctrl-C often arrives twice
    (from the terminal and forwarded by `uv run`), and a second one would drop them."""
    try:
        previous = {signum: signal.signal(signum, signal.SIG_IGN) for signum in (signal.SIGINT, signal.SIGTERM)}
    except ValueError:  # not the main thread: signals cannot arrive here anyway
        previous = {}
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


# report_master last: its filters refer to accounts and categories, and nothing depends on it.
_ENTITIES = ("account_types", "category_master", "account_master", *CONTRACTS, "transaction_master", "subscription_master", "report_master")
_ID_COLUMNS = {
    "account_types": ("account_types", "id"),
    "category_master": ("category_master", "id"),
    "account_master": ("account_master", "id"),
    "transaction_master": ("transaction_master", "transaction_id"),
    "subscription_master": ("subscription_master", "subscription_id"),
    "report_master": ("report_master", "id"),
    **{name: (CONTRACTS[name].target_table, "id") for name in SYNC_DETAIL_SHEETS},
}


class LedgerDatabaseLoadJob:
    """Transforms the latest staged snapshot and loads it into the ledger tables.

    Reads only PostgreSQL: ledger-sheet-extract staged the Sheet rows, and its
    acknowledge mode writes the outcomes recorded here back to the Sheet.
    """

    def __init__(self, db_config: ConnectionConfig) -> None:
        self._db_config = db_config

    def run(self, *, reprocess: bool = False) -> None:
        conn = get_client(self._db_config)
        try:
            # Session lock survives per-row commits and is released on close.
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(73421, 1)")
                if not cursor.fetchone()[0]:
                    raise RuntimeError("ledger_database_load_already_running")
            run = latest_run(conn, allow_acknowledged=reprocess)
            if run is None:
                logger.info("run: nothing_to_load=true reason=latest_snapshot_already_acknowledged hint=hard_sync_reloads_it")
                return
            unknown = [name for name in run.enabled_tabs if name not in _ENTITIES]
            if unknown:
                raise ValueError(f"unknown_staged_tab:{unknown[0]}")
            enabled = [name for name in _ENTITIES if name in run.enabled_tabs]
            logger.info(f"run: run_id={run.run_id} status={run.status} tabs={len(enabled)} reprocess={reprocess}")
            source = StagingSource(conn, run)
            source.capture(enabled)
            mode = "hard-sync" if reprocess else "normal-sync"
            failures = 0
            account_map = None
            try:
                for name in enabled:
                    rows = source.snapshot_rows(name)
                    self._recover_missing_rows(conn, name, rows)
                    if reprocess:
                        for row in rows:
                            if str(row["sync_status"]).strip() == "in-sync":
                                row["sync_status"] = "update-pending"
                    if name in SYNC_DETAIL_SHEETS:
                        failures = account_details_db.upsert_details(conn, source, name, rows, reprocess=reprocess)
                    elif name == "account_types":
                        failures = account_types_db.upsert_account_types(conn, source, rows)
                    elif name == "category_master":
                        failures = categories_db.upsert_categories(conn, source, rows, 1)
                    elif name == "account_master":
                        failures = accounts_db.upsert_accounts(conn, source, rows, 1)
                    elif name == "report_master":
                        # An invalid report is the user's to fix: its row says why (Invalid in
                        # the app). It must not fail the load and hold back every other report.
                        failed_reports = reports_db.upsert_reports(conn, source, rows)
                        if failed_reports:
                            logger.warning(f"run: entity=report_master failed_rows={failed_reports} fatal=false")
                        failures = 0
                    else:
                        if account_map is None:
                            account_map = transactions_db.load_account_map(conn)
                        if name == "transaction_master":
                            failures = transactions_db.upsert_transactions(conn, source, rows, account_map)
                        else:
                            failures = subscriptions_db.upsert_subscriptions(conn, source, rows, account_map)
                    if failures:
                        logger.warning(f"run: entity={name} failed_rows={failures}")
                        raise RuntimeError(f"entity_rows_failed:{name}")
                if "transaction_master" in enabled or "subscription_master" in enabled:
                    transactions_db.retire_unused_references(conn)
            except BaseException:
                # Outcomes of committed rows are kept even when a later row fails,
                # so the acknowledge step can still mark them and report failures.
                # A failure to store them must not hide the error that stopped the load.
                try:
                    with _uninterruptible():
                        source.flush_pending(mode=mode)
                except Exception as flush_error:
                    logger.error(f"run: flush_pending_failed=true error={type(flush_error).__name__}")
                raise
            with _uninterruptible():
                source.flush_pending(mode=mode)
            logger.info(f"run: complete=true entities={len(enabled)}")
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def _recover_missing_rows(conn: Any, name: str, rows: list[dict[str, Any]]) -> None:
        """Recreate source in-sync records missing after DB restore or fresh setup."""
        table, column = _ID_COLUMNS[name]
        with conn.cursor() as cursor:
            if name == "account_types":
                # Unsynchronized seeds must be claimed even when source IDs match.
                cursor.execute("SELECT id FROM account_types WHERE is_sheet_managed AND sync_status = 'in-sync'")
            elif name in SYNC_DETAIL_SHEETS:
                # An identically named legacy or different-source row is not a
                # synchronized source record: replay must expose that collision.
                cursor.execute(f"SELECT {column} FROM {table} WHERE source_sheet = %s", (name,))
            else:
                cursor.execute(f"SELECT {column} FROM {table}")
            present = {str(record[0]) for record in cursor.fetchall()}
        for row in rows:
            if str(row["sync_status"]).strip() == "in-sync" and str(UUID(str(row["id"]).strip())) not in present:
                row["sync_status"] = "create-pending"
                logger.warning(f"_recover_missing_rows: entity={name} row={row['_sheet_row_num']} reason=missing_database_row")
