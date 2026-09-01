from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.categories as sheets_categories
from transforms import categories as categories_transform

logger = get_logger(__name__)

_SHEET_NAME = "categories"
_VALID_SYNC_STATUSES = {"create-pending", "create-failed", "update-pending", "update-failed", "in-sync"}
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}


def _to_sync_notes(e: Exception) -> str:
    if isinstance(e, ValueError):
        return str(e).removeprefix("categories: ")
    if isinstance(e, pg_errors.UniqueViolation):
        return "Duplicate record — a category with this tx_type / major / minor key combination already exists"
    if isinstance(e, pg_errors.ForeignKeyViolation):
        return "Invalid account subtype — one or more values in source_account_types or target_account_types do not exist"
    if isinstance(e, pg_errors.CheckViolation):
        return "Value failed a database constraint — verify field values match allowed options"
    if isinstance(e, pg_errors.NotNullViolation):
        return "A required field is missing a value"
    return "Unexpected error — check job logs for details"


def _expand_account_types(conn: Any, category_id: str, raw_field: str | None, table_name: str, natural_key: str) -> int:
    """Expand comma-separated account subtype tokens into join table rows.

    Runs inside the caller's transaction — does not commit or rollback.
    Returns count of rows inserted (ON CONFLICT DO NOTHING skips are not counted).
    """
    if raw_field is None or str(raw_field).strip() == "":
        return 0

    tokens = [t.strip() for t in str(raw_field).split(",") if t.strip() != ""]
    inserted = 0

    with conn.cursor() as cursor:
        for token in tokens:
            cursor.execute(
                "SELECT id FROM account_types WHERE account_subtype = %s AND record_status = 'active'",
                (token,),
            )
            matched = cursor.fetchall()
            if not matched:
                logger.warning(f"upsert_categories: unknown_account_subtype entity=categories natural_key={natural_key} token={token!r}")
                continue
            for (account_type_id,) in matched:
                cursor.execute(
                    f"INSERT INTO {table_name} (category_id, account_type_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (category_id, account_type_id),
                )
                inserted += cursor.rowcount

    return inserted


def _insert_category(conn: Any, typed: dict[str, Any]) -> str:
    """INSERT OR UPDATE via ON CONFLICT. Returns the category_master UUID."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO category_master (
                tx_type_key, tx_type_label,
                major_category_key, major_category_label,
                minor_category_key, minor_category_label,
                description, tag_keywords, counterparty_examples,
                source_account_mandatory, target_account_mandatory,
                is_subscription_eligible, record_status,
                created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            ON CONFLICT (tx_type_key, major_category_key, minor_category_key) DO UPDATE SET
                tx_type_label            = EXCLUDED.tx_type_label,
                major_category_label     = EXCLUDED.major_category_label,
                minor_category_label     = EXCLUDED.minor_category_label,
                description              = EXCLUDED.description,
                tag_keywords             = EXCLUDED.tag_keywords,
                counterparty_examples    = EXCLUDED.counterparty_examples,
                source_account_mandatory = EXCLUDED.source_account_mandatory,
                target_account_mandatory = EXCLUDED.target_account_mandatory,
                is_subscription_eligible = EXCLUDED.is_subscription_eligible,
                record_status            = EXCLUDED.record_status,
                updated_at               = now()
            RETURNING id
            """,
            (
                typed["tx_type_key"],
                typed["tx_type_label"],
                typed["major_category_key"],
                typed["major_category_label"],
                typed["minor_category_key"],
                typed["minor_category_label"],
                typed["description"],
                typed["tag_keywords"],
                typed["counterparty_examples"],
                typed["source_account_mandatory"],
                typed["target_account_mandatory"],
                typed["is_subscription_eligible"],
                typed["record_status"],
            ),
        )
        return cursor.fetchone()[0]


def _rebuild_join_rows(conn: Any, category_id: str, raw_source: str | None, raw_target: str | None, natural_key: str) -> tuple[int, int]:
    """Delete all existing join rows for this category and re-insert from raw field values.

    Runs inside the caller's transaction. Returns (src_count, tgt_count) inserted.
    """
    with conn.cursor() as cursor:
        cursor.execute("DELETE FROM category_source_account_types WHERE category_id = %s", (category_id,))
        cursor.execute("DELETE FROM category_target_account_types WHERE category_id = %s", (category_id,))

    src_count = _expand_account_types(conn, category_id, raw_source, "category_source_account_types", natural_key)
    tgt_count = _expand_account_types(conn, category_id, raw_target, "category_target_account_types", natural_key)
    return src_count, tgt_count


def upsert_categories(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], row_start: int) -> None:
    """Process a batch of category rows and write all sync column updates back in one API call.

    row_start is the 1-indexed data row number of the first row in this batch
    (1 = first row after header). Sheet row = row_start + row_index + 1.
    """
    in_sync_count = sum(1 for row in rows if str(row.get("sync_status", "")).strip() == "in-sync")
    actionable_count = sum(1 for row in rows if str(row.get("sync_status", "")).strip() in _ACTIONABLE)
    logger.info(f"upsert_categories: batch_start entity=categories row_start={row_start} total={len(rows)} in_sync={in_sync_count} actionable={actionable_count}")

    write_backs: list[sheets_categories.WriteBack] = []
    inserted = 0
    updated = 0
    failed = 0

    for row_index, row in enumerate(rows):
        sheet_row_num = row_start + row_index + 1

        raw_sync_status = row.get("sync_status")
        if raw_sync_status is None or str(raw_sync_status).strip() == "":
            logger.warning(f"upsert_categories: missing_sync_status entity=categories row={sheet_row_num} — skipping")
            continue
        sync_status = str(raw_sync_status).strip()
        if sync_status == "in-sync":
            continue
        if sync_status not in _VALID_SYNC_STATUSES:
            logger.warning(f"upsert_categories: unknown_sync_status entity=categories row={sheet_row_num} sync_status={sync_status!r} — skipping")
            continue

        failed_status = "create-failed" if sync_status in ("create-pending", "create-failed") else "update-failed"

        try:
            typed = categories_transform.transform(row)
        except ValueError as e:
            sync_dt = datetime.now(timezone.utc).isoformat()
            logger.warning(f"upsert_categories: transform_error entity=categories row={sheet_row_num} sync_status={failed_status} error={e}")
            write_backs.append(sheets_categories.write_back(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
            failed += 1
            continue

        natural_key = typed["natural_key"]
        raw_source = row.get("source_account_types")
        raw_target = row.get("target_account_types")

        if sync_status in ("create-pending", "create-failed"):
            try:
                category_id = _insert_category(conn, typed)
                src_count, tgt_count = _rebuild_join_rows(conn, category_id, raw_source, raw_target, natural_key)
                conn.commit()
                sync_dt = datetime.now(timezone.utc).isoformat()
                write_backs.append(sheets_categories.write_back(sheet_row_num, "in-sync", sync_dt, ""))
                inserted += 1
                logger.info(f"upsert_categories: inserted entity=categories natural_key={natural_key} src_account_types={src_count} tgt_account_types={tgt_count}")
            except (
                pg_errors.UniqueViolation,
                pg_errors.ForeignKeyViolation,
                pg_errors.CheckViolation,
                pg_errors.NotNullViolation,
            ) as e:
                conn.rollback()
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.error(f"upsert_categories: create_failed entity=categories natural_key={natural_key} error={e}")
                write_backs.append(sheets_categories.write_back(sheet_row_num, "create-failed", sync_dt, _to_sync_notes(e)))
                failed += 1

        else:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE category_master SET
                            tx_type_label            = %s,
                            major_category_label     = %s,
                            minor_category_label     = %s,
                            description              = %s,
                            tag_keywords             = %s,
                            counterparty_examples    = %s,
                            source_account_mandatory = %s,
                            target_account_mandatory = %s,
                            is_subscription_eligible = %s,
                            record_status            = %s,
                            updated_at               = now()
                        WHERE tx_type_key = %s AND major_category_key = %s AND minor_category_key = %s
                        RETURNING id
                        """,
                        (
                            typed["tx_type_label"],
                            typed["major_category_label"],
                            typed["minor_category_label"],
                            typed["description"],
                            typed["tag_keywords"],
                            typed["counterparty_examples"],
                            typed["source_account_mandatory"],
                            typed["target_account_mandatory"],
                            typed["is_subscription_eligible"],
                            typed["record_status"],
                            typed["tx_type_key"],
                            typed["major_category_key"],
                            typed["minor_category_key"],
                        ),
                    )
                    row_result = cursor.fetchone()

                if row_result is None:
                    logger.warning(f"upsert_categories: update_fallback_to_insert entity=categories natural_key={natural_key}")
                    category_id = _insert_category(conn, typed)
                else:
                    category_id = row_result[0]

                src_count, tgt_count = _rebuild_join_rows(conn, category_id, raw_source, raw_target, natural_key)
                conn.commit()
                sync_dt = datetime.now(timezone.utc).isoformat()
                write_backs.append(sheets_categories.write_back(sheet_row_num, "in-sync", sync_dt, ""))
                updated += 1
                logger.info(f"upsert_categories: updated entity=categories natural_key={natural_key} src_account_types={src_count} tgt_account_types={tgt_count}")
            except (
                pg_errors.UniqueViolation,
                pg_errors.ForeignKeyViolation,
                pg_errors.CheckViolation,
                pg_errors.NotNullViolation,
            ) as e:
                conn.rollback()
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.error(f"upsert_categories: update_failed entity=categories natural_key={natural_key} error={e}")
                write_backs.append(sheets_categories.write_back(sheet_row_num, "update-failed", sync_dt, _to_sync_notes(e)))
                failed += 1

    logger.info(f"upsert_categories: batch_done entity=categories inserted={inserted} updated={updated} failed={failed}")
    sheets_categories.flush(sheets_client, _SHEET_NAME, write_backs)
