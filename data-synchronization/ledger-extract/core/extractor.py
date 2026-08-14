from __future__ import annotations

from typing import Any

import psycopg2
from py_db_migrate.core.config import ConnectionConfig
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import database.categories as upsert_db
from database.job_execution_details import bootstrap_job_execution_details, read_last_sheet_modified_at, update_ran_at, upsert_job_execution_details

logger = get_logger(__name__)


def entity_enabled(entity: str, config: dict) -> bool:
    return bool(config.get("entities", {}).get(entity, {}).get("enabled", False))


class LedgerExtractJob:
    def __init__(self, db_config: ConnectionConfig, spreadsheet_id: str, service_account_file: str) -> None:
        self._spreadsheet_id = spreadsheet_id
        self._service_account_file = service_account_file
        logger.info(f"extractor: db_connect host={db_config.host} port={db_config.port} dbname={db_config.connect_database}")
        self._conn = psycopg2.connect(
            host=db_config.host,
            port=db_config.port,
            user=db_config.user,
            password=db_config.password,
            dbname=db_config.connect_database,
        )
        logger.info("extractor: db_connect_ok")

    def run(self, config: dict[str, Any]) -> None:
        # --- Phase 1: Job state ---
        logger.info("extractor: bootstrap_job_execution_details")
        bootstrap_job_execution_details(self._conn)
        logger.info("extractor: read_last_sheet_modified_at")
        last_sheet_modified_at = read_last_sheet_modified_at(self._conn)
        logger.info(f"extractor: last_sheet_modified_at={last_sheet_modified_at.isoformat() if last_sheet_modified_at else None}")

        logger.info("extractor: sheets_client_init")
        sheets_client = SheetsClient(self._service_account_file, self._spreadsheet_id)
        logger.info("extractor: get_modified_time")
        current_sheet_modified_at = sheets_client.get_modified_time()

        if current_sheet_modified_at == last_sheet_modified_at:
            update_ran_at(self._conn)
            logger.info(f"extractor: no_changes sheet_modified_at={current_sheet_modified_at.isoformat()}")
            return

        # --- Phase 2: Entity extraction ---
        if entity_enabled("categories", config):
            self._extract_categories(sheets_client)

        # TODO: accounts
        # TODO: transactions
        # TODO: subscriptions

        # --- Phase 3: Finalise ---
        upsert_job_execution_details(self._conn, current_sheet_modified_at)

    def _extract_categories(self, sheets_client: SheetsClient) -> None:
        rows = sheets_client.read_sheet("categories")
        if len(rows) == 0:
            raise RuntimeError("categories: zero rows returned from sheet — aborting to prevent full wipe")
        upsert_db.upsert_categories(self._conn, rows)
