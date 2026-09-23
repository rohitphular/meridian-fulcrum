from __future__ import annotations

from typing import Any
from uuid import UUID

from py_db_migrate.adapters.postgres import get_client
from py_db_migrate.core.config import ConnectionConfig
from py_logging import get_logger

import database.accounts as accounts_db
import database.categories as categories_db
import database.subscriptions as subscriptions_db
import database.transactions as transactions_db
from database.job_execution_details import bootstrap_job_execution_details, upsert_job_execution_details
from sheets.client import SnapshotSheetsClient

logger = get_logger(__name__)
_ENTITIES = ("categories", "accounts", "transactions", "subscriptions")
_ID_COLUMNS = {
    "categories": ("category_master", "id"),
    "accounts": ("account_master", "id"),
    "transactions": ("transaction_master", "transaction_id"),
    "subscriptions": ("subscription_master", "subscription_id"),
}


def entity_enabled(entity: str, config: dict[str, Any]) -> bool:
    enabled = config["entities"][entity]["enabled"]
    if not isinstance(enabled, bool):
        raise ValueError(f"entity_enabled_must_be_boolean:{entity}")
    return enabled


class LedgerExtractJob:
    def __init__(self, db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str) -> None:
        self._db_config = db_config
        self._spreadsheet_id = spreadsheet_id
        self._service_account_file = service_account_file

    def run(self, config: dict[str, Any], *, reprocess: bool = False) -> None:
        enabled = [name for name in _ENTITIES if entity_enabled(name, config)]
        if not enabled:
            logger.info("run: enabled_entities=0")
            return
        conn = get_client(self._db_config)
        try:
            # Session lock survives per-row commits and is released on close.
            with conn.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_lock(73421, 1)")
                if not cursor.fetchone()[0]:
                    raise RuntimeError("ledger_extract_already_running")
            sheets_client = SnapshotSheetsClient(self._service_account_file, self._spreadsheet_id)
            sheets_client.capture(enabled)
            source_modified_at = sheets_client.get_modified_time()
            bootstrap_job_execution_details(conn)
            failures = 0
            account_map = None
            try:
                for name in enabled:
                    rows = sheets_client.snapshot_rows(name)
                    self._recover_missing_rows(conn, name, rows)
                    if reprocess:
                        for row in rows:
                            if str(row["sync_status"]).strip() == "in-sync":
                                row["sync_status"] = "update-pending"
                    if name == "categories":
                        failures = categories_db.upsert_categories(conn, sheets_client, rows, 1)
                    elif name == "accounts":
                        failures = accounts_db.upsert_accounts(conn, sheets_client, rows, 1)
                    else:
                        if account_map is None:
                            account_map = transactions_db.load_account_map(conn)
                        if name == "transactions":
                            failures = transactions_db.upsert_transactions(conn, sheets_client, rows, account_map)
                        else:
                            failures = subscriptions_db.upsert_subscriptions(conn, sheets_client, rows, account_map)
                    if failures:
                        logger.warning(f"run: entity={name} failed_rows={failures}")
                        raise RuntimeError(f"entity_rows_failed:{name}")
                if "transactions" in enabled or "subscriptions" in enabled:
                    transactions_db.retire_unused_references(conn)
            finally:
                sheets_client.flush_pending()
            # Drive modification time is informational, never a skip gate: rates,
            # DB restores and config changes can require retry without a Sheet edit.
            upsert_job_execution_details(conn, source_modified_at)
            logger.info(f"run: complete=true entities={len(enabled)}")
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def _recover_missing_rows(conn: Any, name: str, rows: list[dict[str, Any]]) -> None:
        """Recreate source in-sync records missing after DB restore or fresh setup."""
        table, column = _ID_COLUMNS[name]
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT {column} FROM {table}")
            present = {str(record[0]) for record in cursor.fetchall()}
        for row in rows:
            if str(row["sync_status"]).strip() == "in-sync" and str(UUID(str(row["id"]).strip())) not in present:
                row["sync_status"] = "create-pending"
                logger.warning(f"_recover_missing_rows: entity={name} row={row['_sheet_row_num']} reason=missing_database_row")
