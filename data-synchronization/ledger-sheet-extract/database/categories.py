from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.categories as sheets_categories
import transforms.categories as categories_transform
from database.progress import Progress

logger = get_logger(__name__)

_SHEET_NAME = "category_master"
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}
_JOIN_TABLES = {"category_source_account_types", "category_target_account_types"}


def _to_sync_notes(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return str(exc).removeprefix("categories: ")
    if isinstance(exc, pg_errors.UniqueViolation):
        return "Duplicate category classification belongs to another ID; reconcile the sheet and database IDs"
    if isinstance(exc, pg_errors.ForeignKeyViolation):
        return "Invalid category/account type reference"
    if isinstance(exc, pg_errors.CheckViolation):
        return f"Database constraint failed: {exc.diag.constraint_name}"
    if isinstance(exc, pg_errors.NotNullViolation):
        return f"Required database field is null: {exc.diag.column_name}"
    raise TypeError(f"_to_sync_notes: unhandled exception type {type(exc).__name__}")


def _resolve_account_types(conn: Any, raw_field: Any) -> list[Any]:
    """Resolve hints against eligible catalog rows, including GAS legacy-key aliases."""
    if raw_field is None or str(raw_field).strip() == "":
        return []
    tokens = dict.fromkeys(token.strip().lower() for token in str(raw_field).split(",") if token.strip())
    resolved: dict[Any, None] = {}
    with conn.cursor() as cursor:
        for token in tokens:
            if token == "investment":
                cursor.execute("SELECT id FROM account_types WHERE account_type_key = %s AND is_sheet_managed AND sync_status='in-sync' AND record_status IN ('active','locked') FOR SHARE", (token,))
            else:
                cursor.execute(
                    "SELECT id FROM account_types WHERE account_subtype_key = %s AND is_sheet_managed AND sync_status='in-sync' AND record_status IN ('active','locked') FOR SHARE", (token,)
                )
            matched = cursor.fetchall()
            # GAS accepts legacy CSV hints only if their canonical key exists in
            # the eligible Sheet catalog. Do not invent aliases for unknown keys.
            if not matched and "_" in token:
                cursor.execute(
                    "SELECT id FROM account_types WHERE account_subtype_key = %s AND is_sheet_managed AND sync_status='in-sync' AND record_status IN ('active','locked') FOR SHARE",
                    (token.replace("_", "-"),),
                )
                matched = cursor.fetchall()
            if token != "investment" and len(matched) > 1:
                raise ValueError("categories: ambiguous account subtype hint; use distinct subtype keys across groups")
            if not matched:
                raise ValueError(f"categories: unknown, inactive, or unsynced account type hint {token!r}; sync account_types first and check source_account_types/target_account_types")
            resolved.update((account_type_id, None) for (account_type_id,) in matched)
    return list(resolved)


def _insert_category(conn: Any, typed: dict[str, Any]) -> str:
    """Upsert only by stable source UUID; a different UUID cannot hijack a natural key."""
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT tx_type_key, major_category_key, minor_category_key FROM category_master WHERE id = %s FOR UPDATE",
            (typed["id"],),
        )
        existing = cursor.fetchone()
        proposed = tuple(typed[field] for field in ("tx_type_key", "major_category_key", "minor_category_key"))
        if existing is not None and tuple(existing) != proposed:
            cursor.execute(
                """SELECT EXISTS (SELECT 1 FROM transaction_master WHERE category_id = %s)
                       OR EXISTS (SELECT 1 FROM subscription_master WHERE category_id = %s)""",
                (typed["id"], typed["id"]),
            )
            if cursor.fetchone()[0]:
                raise ValueError("categories: classification keys have transaction/subscription references; reconcile dependent rows before changing keys")
        cursor.execute(
            """
            INSERT INTO category_master (
                id, tx_type_key, tx_type_label, major_category_key, major_category_label,
                minor_category_key, minor_category_label, description, tag_keywords,
                counterparty_examples, source_account_mandatory, target_account_mandatory,
                is_subscription_eligible, record_status, created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            ON CONFLICT (id) DO UPDATE SET
                tx_type_key = EXCLUDED.tx_type_key,
                tx_type_label = EXCLUDED.tx_type_label,
                major_category_key = EXCLUDED.major_category_key,
                major_category_label = EXCLUDED.major_category_label,
                minor_category_key = EXCLUDED.minor_category_key,
                minor_category_label = EXCLUDED.minor_category_label,
                description = EXCLUDED.description,
                tag_keywords = EXCLUDED.tag_keywords,
                counterparty_examples = EXCLUDED.counterparty_examples,
                source_account_mandatory = EXCLUDED.source_account_mandatory,
                target_account_mandatory = EXCLUDED.target_account_mandatory,
                is_subscription_eligible = EXCLUDED.is_subscription_eligible,
                record_status = EXCLUDED.record_status,
                updated_at = now()
            RETURNING id
            """,
            tuple(
                typed[field]
                for field in (
                    "id",
                    "tx_type_key",
                    "tx_type_label",
                    "major_category_key",
                    "major_category_label",
                    "minor_category_key",
                    "minor_category_label",
                    "description",
                    "tag_keywords",
                    "counterparty_examples",
                    "source_account_mandatory",
                    "target_account_mandatory",
                    "is_subscription_eligible",
                    "record_status",
                )
            ),
        )
        return cursor.fetchone()[0]


def _replace_join_rows(conn: Any, category_id: str, account_type_ids: list[Any], table_name: str) -> None:
    if table_name not in _JOIN_TABLES:
        raise ValueError("categories: unsupported join table")
    with conn.cursor() as cursor:
        cursor.execute(f"DELETE FROM {table_name} WHERE category_id = %s", (category_id,))
        for account_type_id in account_type_ids:
            cursor.execute(f"INSERT INTO {table_name} (category_id, account_type_id) VALUES (%s, %s)", (category_id, account_type_id))


def _investment_mapping_changed(conn: Any, row: dict[str, Any]) -> bool:
    """Compare only dynamic group hints; unchanged in-sync categories still skip."""
    for field, table in (("source_account_types", "category_source_account_types"), ("target_account_types", "category_target_account_types")):
        tokens = {token.strip().lower() for token in str(row.get(field) or "").split(",")}
        if "investment" not in tokens:
            continue
        expected = {str(identity) for identity in _resolve_account_types(conn, row[field])}
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT account_type_id FROM {table} WHERE category_id=%s", (row["id"],))
            stored = {str(identity) for (identity,) in cursor.fetchall()}
        if expected != stored:
            return True
    return False


def upsert_categories(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], row_start: int, *, before_dependency_commit: Callable[[], None] | None = None) -> int:
    """Commit master and both hint mappings together; report all failed rows."""
    write_backs: list[sheets_categories.WriteBack] = []
    succeeded = failed = 0
    progress = Progress(logger, "upsert_categories", len(rows))
    try:
        for row_index, row in enumerate(rows):
            sheet_row_num = row.get("_sheet_row_num", row_start + row_index + 1)
            sync_status = str(row.get("sync_status") or "").strip()
            dependency_refresh = sync_status == "in-sync"
            if not dependency_refresh and sync_status not in _ACTIONABLE:
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_categories: invalid_sync_status row={sheet_row_num}")
                continue
            failed_status = "create-failed" if sync_status.startswith("create-") else "update-failed"
            checking_source = False
            try:
                if dependency_refresh and not _investment_mapping_changed(conn, row):
                    conn.rollback()  # Release read locks from an unchanged dependency check.
                    progress.skip()
                    continue
                typed = categories_transform.transform(row)
                source_ids = _resolve_account_types(conn, row.get("source_account_types"))
                target_ids = _resolve_account_types(conn, row.get("target_account_types"))
                category_id = _insert_category(conn, typed)
                _replace_join_rows(conn, category_id, source_ids, "category_source_account_types")
                _replace_join_rows(conn, category_id, target_ids, "category_target_account_types")
                if before_dependency_commit is not None:
                    checking_source = True
                    before_dependency_commit()
                    checking_source = False
                conn.commit()
            except (ValueError, pg_errors.UniqueViolation, pg_errors.ForeignKeyViolation, pg_errors.CheckViolation, pg_errors.NotNullViolation) as exc:
                conn.rollback()
                if checking_source:
                    raise
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_categories: row_failed row={sheet_row_num} error_type={type(exc).__name__}")
                write_backs.append(sheets_categories.write_back(sheet_row_num, failed_status, datetime.now(timezone.utc).isoformat(), _to_sync_notes(exc)))
            except Exception:
                conn.rollback()
                raise
            else:
                succeeded += 1
                progress.record(succeeded=1)
                write_backs.append(sheets_categories.write_back(sheet_row_num, "in-sync", datetime.now(timezone.utc).isoformat(), ""))
    finally:
        sheets_categories.flush(sheets_client, _SHEET_NAME, write_backs)
        progress.done()
    return failed
