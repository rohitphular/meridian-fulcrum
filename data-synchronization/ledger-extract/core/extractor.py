from __future__ import annotations

from typing import Any

import psycopg2
from py_db_migrate.core.config import ConnectionConfig
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import database.accounts as accounts_db
import database.categories as categories_db
import database.transactions as transactions_db
from database.job_execution_details import bootstrap_job_execution_details, read_last_sheet_modified_at, update_ran_at, upsert_job_execution_details

logger = get_logger(__name__)

_BATCH_SIZE = 1000


def entity_enabled(entity: str, config: dict) -> bool:
    return bool(config["entities"][entity]["enabled"])


class LedgerExtractJob:
    def __init__(self, db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str) -> None:
        self._spreadsheet_id = spreadsheet_id
        self._service_account_file = service_account_file
        logger.info(f"__init__: db_connect host={db_config.host} port={db_config.port} dbname={db_config.connect_database}")
        self._conn = psycopg2.connect(
            host=db_config.host,
            port=db_config.port,
            user=db_config.user,
            password=db_config.password,
            dbname=db_config.connect_database,
        )
        logger.info("__init__: db_connect_ok")

    def run(self, config: dict[str, Any]) -> None:
        try:
            # --- Phase 1: Job state ---
            logger.info("run: bootstrap_job_execution_details")
            bootstrap_job_execution_details(self._conn)
            logger.info("run: read_last_sheet_modified_at")
            last_sheet_modified_at = read_last_sheet_modified_at(self._conn)
            logger.info(f"run: last_sheet_modified_at={last_sheet_modified_at.isoformat() if last_sheet_modified_at else None}")

            logger.info("run: sheets_client_init")
            sheets_client = SheetsClient(self._service_account_file, self._spreadsheet_id, is_readonly=False)
            logger.info("run: get_modified_time")
            current_sheet_modified_at = sheets_client.get_modified_time()

            if current_sheet_modified_at == last_sheet_modified_at:
                update_ran_at(self._conn)
                logger.info(f"run: no_changes sheet_modified_at={current_sheet_modified_at.isoformat()}")
                return

            # --- Phase 2: Entity extraction ---
            if entity_enabled("categories", config):
                self._extract_categories(sheets_client)

            if entity_enabled("accounts", config):
                self._extract_accounts(sheets_client)

            if entity_enabled("transactions", config):
                self._extract_transactions(sheets_client)

            # TODO: subscriptions

            # --- Phase 3: Finalise ---
            upsert_job_execution_details(self._conn, current_sheet_modified_at)
        finally:
            self._conn.close()

    def _extract_categories(self, sheets_client: SheetsClient) -> None:
        row_start = 1
        first_batch = True
        while True:
            rows = sheets_client.read_sheet("categories", row_start, row_start + _BATCH_SIZE - 1)
            if first_batch:
                if len(rows) == 0:
                    raise RuntimeError("categories: zero rows returned from sheet — aborting to prevent full wipe")
                first_batch = False
            if not rows:
                break
            categories_db.upsert_categories(self._conn, sheets_client, rows, row_start)
            if len(rows) < _BATCH_SIZE:
                break
            row_start += _BATCH_SIZE

    def _extract_accounts(self, sheets_client: SheetsClient) -> None:
        row_start = 1
        all_rows: list[dict[str, Any]] = []
        while True:
            rows = sheets_client.read_sheet("accounts", row_start, row_start + _BATCH_SIZE - 1)
            if row_start == 1 and len(rows) == 0:
                raise RuntimeError("accounts: zero rows returned from sheet — aborting to prevent full wipe")
            all_rows.extend(rows)
            if len(rows) < _BATCH_SIZE:
                break
            row_start += _BATCH_SIZE
        structure_type_map = accounts_db.load_structure_type_map(self._conn)
        accounts_db.upsert_accounts(self._conn, all_rows, structure_type_map)

    def _extract_transactions(self, sheets_client: SheetsClient) -> None:
        row_start = 1
        all_rows: list[dict[str, Any]] = []
        while True:
            rows = sheets_client.read_sheet("transactions", row_start, row_start + _BATCH_SIZE - 1)
            if row_start == 1 and len(rows) == 0:
                raise RuntimeError("transactions: zero rows returned from sheet — aborting to prevent full wipe")
            all_rows.extend(rows)
            if len(rows) < _BATCH_SIZE:
                break
            row_start += _BATCH_SIZE
        account_name_map = transactions_db.load_account_name_map(self._conn)
        transactions_db.upsert_transactions(self._conn, all_rows, account_name_map)
