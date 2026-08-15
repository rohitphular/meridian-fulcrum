from __future__ import annotations

from typing import Any

from py_logging import get_logger

import database.ledger_data_checksums as hashes_db
from transforms import categories as categories_transform

logger = get_logger(__name__)


def _expand_account_types(conn: Any, category_id: str, raw_field: str | None, table_name: str, natural_key: str) -> int:
    """Insert join rows for account type tokens. Runs inside caller's transaction. Returns count inserted."""
    if raw_field is None or raw_field.strip() == "":
        return 0

    tokens = [t.strip() for t in raw_field.split(",") if t.strip()]
    inserted = 0

    with conn.cursor() as cursor:
        for token in tokens:
            cursor.execute(
                "SELECT id FROM account_types WHERE account_type = %s AND is_deleted = FALSE",
                (token,),
            )
            matched = cursor.fetchall()
            if not matched:
                logger.warning(f"upsert_categories: unknown_account_type entity=categories natural_key={natural_key} token={token}")
                continue
            for (account_type_id,) in matched:
                cursor.execute(
                    f"INSERT INTO {table_name} (category_id, account_type_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (category_id, account_type_id),
                )
                inserted += cursor.rowcount

    return inserted


def upsert_categories(conn: Any, rows: list[dict[str, Any]]) -> None:
    seen_keys: set[str] = set()

    # --- Per-row pass ---
    for row in rows:
        typed = categories_transform.transform(row)

        natural_key = typed["natural_key"]
        if natural_key in seen_keys:
            logger.warning(f"upsert_categories: duplicate_natural_key entity=categories natural_key={natural_key} — skipping second occurrence; fix the sheet")
            continue
        seen_keys.add(natural_key)

        existing = hashes_db.get_hash(conn, "categories", natural_key)

        # Hash match — unchanged row (per-row step 2, hash-matches sub-path)
        if existing is not None and existing["row_hash"] == typed["row_hash"]:
            hashes_db.update_last_seen(conn, "categories", natural_key)
            logger.info(f"upsert_categories: unchanged entity=categories natural_key={natural_key}")
            continue

        # New row (per-row step 2, not-found sub-path)
        if existing is None:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO category_master (
                            tx_type, major_category, minor_category, description,
                            is_active, tag_keywords, counterparty_examples,
                            source_account_mandatory, target_account_mandatory,
                            workflow_type, is_subscription_eligible, row_hash,
                            is_deleted, created_at, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, now(), now())
                        ON CONFLICT (tx_type, major_category, minor_category) DO UPDATE SET
                            is_deleted = FALSE,
                            deleted_at = NULL,
                            description = EXCLUDED.description,
                            is_active = EXCLUDED.is_active,
                            tag_keywords = EXCLUDED.tag_keywords,
                            counterparty_examples = EXCLUDED.counterparty_examples,
                            source_account_mandatory = EXCLUDED.source_account_mandatory,
                            target_account_mandatory = EXCLUDED.target_account_mandatory,
                            workflow_type = EXCLUDED.workflow_type,
                            is_subscription_eligible = EXCLUDED.is_subscription_eligible,
                            row_hash = EXCLUDED.row_hash,
                            updated_at = now()
                        RETURNING id
                        """,
                        (
                            typed["tx_type"],
                            typed["major_category"],
                            typed["minor_category"],
                            typed["description"],
                            typed["is_active"],
                            typed["tag_keywords"],
                            typed["counterparty_examples"],
                            typed["source_account_mandatory"],
                            typed["target_account_mandatory"],
                            typed["workflow_type"],
                            typed["is_subscription_eligible"],
                            typed["row_hash"],
                        ),
                    )
                    category_id = cursor.fetchone()[0]

                    cursor.execute("DELETE FROM category_source_account_types WHERE category_id = %s", (category_id,))
                    cursor.execute("DELETE FROM category_target_account_types WHERE category_id = %s", (category_id,))

                src_count = _expand_account_types(conn, category_id, typed["source_account_types"], "category_source_account_types", natural_key)
                tgt_count = _expand_account_types(conn, category_id, typed["target_account_types"], "category_target_account_types", natural_key)

                hashes_db.insert_hash(conn, "categories", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_categories: inserted entity=categories natural_key={natural_key} src_account_types={src_count} tgt_account_types={tgt_count}")
            except Exception:
                conn.rollback()
                raise

        # Changed row (per-row step 2, hash-differs sub-path)
        else:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE category_master SET
                            description = %s,
                            is_active = %s,
                            tag_keywords = %s,
                            counterparty_examples = %s,
                            source_account_mandatory = %s,
                            target_account_mandatory = %s,
                            workflow_type = %s,
                            is_subscription_eligible = %s,
                            row_hash = %s,
                            updated_at = now()
                        WHERE tx_type = %s AND major_category = %s AND minor_category = %s
                        RETURNING id
                        """,
                        (
                            typed["description"],
                            typed["is_active"],
                            typed["tag_keywords"],
                            typed["counterparty_examples"],
                            typed["source_account_mandatory"],
                            typed["target_account_mandatory"],
                            typed["workflow_type"],
                            typed["is_subscription_eligible"],
                            typed["row_hash"],
                            typed["tx_type"],
                            typed["major_category"],
                            typed["minor_category"],
                        ),
                    )
                    row = cursor.fetchone()

                if row is None:
                    logger.error(f"upsert_categories: update_returned_no_rows entity=categories natural_key={natural_key}")
                    conn.rollback()
                    continue

                category_id = row[0]

                with conn.cursor() as cursor:
                    cursor.execute("DELETE FROM category_source_account_types WHERE category_id = %s", (category_id,))
                    cursor.execute("DELETE FROM category_target_account_types WHERE category_id = %s", (category_id,))

                src_count = _expand_account_types(conn, category_id, typed["source_account_types"], "category_source_account_types", natural_key)
                tgt_count = _expand_account_types(conn, category_id, typed["target_account_types"], "category_target_account_types", natural_key)

                hashes_db.update_hash(conn, "categories", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_categories: updated entity=categories natural_key={natural_key} src_account_types={src_count} tgt_account_types={tgt_count}")
            except Exception:
                conn.rollback()
                raise

    # --- Soft-delete pass ---
    db_keys = hashes_db.get_all_keys(conn, "categories")
    stale_keys = db_keys - seen_keys

    for natural_key in stale_keys:
        parts = natural_key.split("|", 2)
        tx_type, major_category, minor_category = parts[0], parts[1], parts[2]

        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE category_master SET
                        is_deleted = TRUE,
                        deleted_at = now(),
                        updated_at = now()
                    WHERE tx_type = %s AND major_category = %s AND minor_category = %s
                    RETURNING id
                    """,
                    (tx_type, major_category, minor_category),
                )
                row = cursor.fetchone()

            if row is None:
                logger.error(f"upsert_categories: soft_delete_returned_no_rows entity=categories natural_key={natural_key}")
                conn.rollback()
                continue

            category_id = row[0]

            with conn.cursor() as cursor:
                cursor.execute("DELETE FROM category_source_account_types WHERE category_id = %s", (category_id,))
                cursor.execute("DELETE FROM category_target_account_types WHERE category_id = %s", (category_id,))

            hashes_db.delete_hash(conn, "categories", natural_key)
            conn.commit()
            logger.info(f"upsert_categories: soft_deleted entity=categories natural_key={natural_key}")
        except Exception:
            conn.rollback()
            raise
