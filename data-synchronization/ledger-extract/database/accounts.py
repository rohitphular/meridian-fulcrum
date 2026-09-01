from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.accounts as sheets_accounts
from transforms import accounts as accounts_transform

logger = get_logger(__name__)

_SHEET_NAME = "accounts"
_VALID_SYNC_STATUSES = {"create-pending", "create-failed", "update-pending", "update-failed", "in-sync"}
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}


def _to_sync_notes(e: Exception) -> str:
    if isinstance(e, ValueError):
        return str(e).removeprefix("accounts: ")
    if isinstance(e, pg_errors.UniqueViolation):
        return "Duplicate account_id — already exists in DB"
    if isinstance(e, pg_errors.ForeignKeyViolation):
        return "Unknown account type/subtype combination — check that account_type and account_subtype match a row in account_types"
    if isinstance(e, pg_errors.CheckViolation):
        constraint = e.diag.constraint_name
        if constraint is not None and "opening_value_sign" in constraint:
            return "Opening value sign mismatch: liabilities must be ≤ 0, assets/investments must be ≥ 0"
        if constraint is not None and "record_status" in constraint:
            return "Invalid record_status — must be active, inactive, deleted, or locked"
        if constraint is not None and "currency" in constraint:
            return "currency_code must be a 3-character uppercase ISO code"
        return f"DB constraint violation: {constraint}"
    if isinstance(e, pg_errors.NotNullViolation):
        return f"Required field is null: {e.diag.column_name}"
    return "Unexpected error — check job logs for details"


def upsert_accounts(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], row_start: int) -> None:
    """Process a batch of account rows and write all sync column updates back in one API call.

    row_start is the 1-indexed data row number of the first row in this batch
    (1 = first row after header). Sheet row = row_start + row_index + 1.
    """
    in_sync_count = sum(1 for row in rows if row.get("sync_status") == "in-sync")
    actionable_count = sum(1 for row in rows if row.get("sync_status") in _ACTIONABLE)
    logger.info(f"upsert_accounts: batch_start entity=accounts row_start={row_start} total={len(rows)} in_sync={in_sync_count} actionable={actionable_count}")

    write_backs: list[sheets_accounts.WriteBack] = []
    inserted = 0
    updated = 0
    failed = 0

    for row_index, row in enumerate(rows):
        sheet_row_num = row_start + row_index + 1

        raw_sync_status = row.get("sync_status")
        if raw_sync_status is None or str(raw_sync_status).strip() == "":
            logger.warning(f"upsert_accounts: missing_sync_status entity=accounts row={sheet_row_num} — skipping")
            continue
        sync_status = str(raw_sync_status).strip()
        if sync_status == "in-sync":
            continue
        if sync_status not in _VALID_SYNC_STATUSES:
            logger.warning(f"upsert_accounts: unknown_sync_status entity=accounts row={sheet_row_num} sync_status={sync_status!r} — skipping")
            continue

        failed_status = "create-failed" if sync_status in ("create-pending", "create-failed") else "update-failed"

        try:
            typed = accounts_transform.transform(row)
        except ValueError as e:
            sync_dt = datetime.now(timezone.utc).isoformat()
            logger.warning(f"upsert_accounts: transform_error entity=accounts row={sheet_row_num} sync_status={failed_status} error={e}")
            write_backs.append(sheets_accounts.write_back(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
            failed += 1
            continue

        natural_key = typed["account_id"]

        if sync_status in ("create-pending", "create-failed"):
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO account_master (
                            account_id, account_name, account_type, account_subtype,
                            currency_code, opening_value, account_description, record_status,
                            created_at, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                        ON CONFLICT (account_id) DO UPDATE SET
                            account_name        = EXCLUDED.account_name,
                            account_type        = EXCLUDED.account_type,
                            account_subtype     = EXCLUDED.account_subtype,
                            currency_code       = EXCLUDED.currency_code,
                            opening_value       = EXCLUDED.opening_value,
                            account_description = EXCLUDED.account_description,
                            record_status       = EXCLUDED.record_status,
                            updated_at          = now()
                        RETURNING id
                        """,
                        (
                            typed["account_id"],
                            typed["account_name"],
                            typed["account_type"],
                            typed["account_subtype"],
                            typed["currency_code"],
                            typed["opening_value"],
                            typed["account_description"],
                            typed["record_status"],
                        ),
                    )
                    cursor.fetchone()
                conn.commit()
                sync_dt = datetime.now(timezone.utc).isoformat()
                write_backs.append(sheets_accounts.write_back(sheet_row_num, "in-sync", sync_dt, ""))
                inserted += 1
                logger.info(f"upsert_accounts: inserted entity=accounts natural_key={natural_key}")
            except (
                pg_errors.UniqueViolation,
                pg_errors.ForeignKeyViolation,
                pg_errors.CheckViolation,
                pg_errors.NotNullViolation,
            ) as e:
                conn.rollback()
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.error(f"upsert_accounts: create_failed entity=accounts natural_key={natural_key} error={e}")
                write_backs.append(sheets_accounts.write_back(sheet_row_num, "create-failed", sync_dt, _to_sync_notes(e)))
                failed += 1

        else:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE account_master SET
                            account_name        = %s,
                            account_type        = %s,
                            account_subtype     = %s,
                            currency_code       = %s,
                            opening_value       = %s,
                            account_description = %s,
                            record_status       = %s,
                            updated_at          = now()
                        WHERE account_id = %s
                        RETURNING id
                        """,
                        (
                            typed["account_name"],
                            typed["account_type"],
                            typed["account_subtype"],
                            typed["currency_code"],
                            typed["opening_value"],
                            typed["account_description"],
                            typed["record_status"],
                            typed["account_id"],
                        ),
                    )
                    row_result = cursor.fetchone()

                if row_result is None:
                    logger.warning(f"upsert_accounts: update_fallback_to_insert entity=accounts natural_key={natural_key}")
                    with conn.cursor() as cursor:
                        cursor.execute(
                            """
                            INSERT INTO account_master (
                                account_id, account_name, account_type, account_subtype,
                                currency_code, opening_value, account_description, record_status,
                                created_at, updated_at
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                            ON CONFLICT (account_id) DO UPDATE SET
                                account_name        = EXCLUDED.account_name,
                                account_type        = EXCLUDED.account_type,
                                account_subtype     = EXCLUDED.account_subtype,
                                currency_code       = EXCLUDED.currency_code,
                                opening_value       = EXCLUDED.opening_value,
                                account_description = EXCLUDED.account_description,
                                record_status       = EXCLUDED.record_status,
                                updated_at          = now()
                            RETURNING id
                            """,
                            (
                                typed["account_id"],
                                typed["account_name"],
                                typed["account_type"],
                                typed["account_subtype"],
                                typed["currency_code"],
                                typed["opening_value"],
                                typed["account_description"],
                                typed["record_status"],
                            ),
                        )
                        cursor.fetchone()

                conn.commit()
                sync_dt = datetime.now(timezone.utc).isoformat()
                write_backs.append(sheets_accounts.write_back(sheet_row_num, "in-sync", sync_dt, ""))
                updated += 1
                logger.info(f"upsert_accounts: updated entity=accounts natural_key={natural_key}")
            except (
                pg_errors.UniqueViolation,
                pg_errors.ForeignKeyViolation,
                pg_errors.CheckViolation,
                pg_errors.NotNullViolation,
            ) as e:
                conn.rollback()
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.error(f"upsert_accounts: update_failed entity=accounts natural_key={natural_key} error={e}")
                write_backs.append(sheets_accounts.write_back(sheet_row_num, "update-failed", sync_dt, _to_sync_notes(e)))
                failed += 1

    logger.info(f"upsert_accounts: batch_done entity=accounts inserted={inserted} updated={updated} failed={failed}")
    sheets_accounts.flush(sheets_client, _SHEET_NAME, write_backs)
