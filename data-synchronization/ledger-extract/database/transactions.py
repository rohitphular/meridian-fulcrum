from __future__ import annotations

from decimal import Decimal
from typing import Any

from py_logging import get_logger

import database.ledger_data_checksums as hashes_db
from transforms import transactions as transactions_transform

logger = get_logger(__name__)


def load_account_name_map(conn: Any) -> dict[str, Any]:
    """Preload account_name → account_master.id for all non-deleted accounts. Called once at job startup."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT account_name, id FROM account_master WHERE account_status != 'deleted'")
        return {row[0]: row[1] for row in cursor.fetchall()}


def _resolve_account_id(name: str | None, account_name_map: dict[str, Any], field: str, transaction_id: str) -> Any:
    if name is None:
        return None
    account_id = account_name_map.get(name)
    if account_id is None:
        logger.warning(f"upsert_transactions: account_not_found entity=transactions transaction_id={transaction_id} field={field} account_name={name!r}")
    return account_id


def _resolve_category_id(conn: Any, tx_type: str, major_category: str | None, minor_category: str | None, transaction_id: str) -> Any:
    if major_category is None or minor_category is None:
        return None
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM category_master WHERE tx_type = %s AND major_category = %s AND minor_category = %s AND is_deleted = FALSE",
            (tx_type, major_category, minor_category),
        )
        row = cursor.fetchone()
    if row is None:
        logger.warning(
            f"upsert_transactions: category_not_found entity=transactions transaction_id={transaction_id} tx_type={tx_type!r} major_category={major_category!r} minor_category={minor_category!r}"
        )
        return None
    return row[0]


def _resolve_currency_rate(conn: Any, tx_currency_local: str, tx_date_time_local: Any, tx_amount_local: Decimal, transaction_id: str) -> tuple[Decimal | None, str | None, Any]:
    """Resolve GBP-equivalent amount and currency_rates FK for a non-GBP transaction.

    Returns (tx_amount_base, tx_currency_base, local_to_base_currency_rate_ref).
    For GBP transactions returns (tx_amount_local, 'GBP', None) directly.
    Logs a warning and returns (None, None, None) if no rate is found for the transaction date.
    """
    if tx_currency_local == "GBP":
        return tx_amount_local, "GBP", None

    rate_date = tx_date_time_local.date()

    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT cr_local.id, cr_gbp.rate_value / cr_local.rate_value AS rate_to_gbp
            FROM currency_rates cr_local
            JOIN currency_rates cr_gbp
                ON cr_gbp.quote_currency_code = 'GBP'
                AND cr_gbp.rate_date = cr_local.rate_date
            WHERE cr_local.quote_currency_code = %s
            AND cr_local.rate_date = %s
            """,
            (tx_currency_local, rate_date),
        )
        row = cursor.fetchone()

    if row is None:
        logger.warning(f"upsert_transactions: currency_rate_not_found entity=transactions transaction_id={transaction_id} tx_currency_local={tx_currency_local!r} rate_date={rate_date}")
        return None, None, None

    currency_rate_id, rate_to_gbp = row
    return (tx_amount_local * Decimal(str(rate_to_gbp))).quantize(Decimal("0.000001")), "GBP", currency_rate_id


def upsert_transactions(conn: Any, rows: list[dict[str, Any]], account_name_map: dict[str, Any]) -> None:
    seen_keys: set[str] = set()

    # --- Per-row pass ---
    for row in rows:
        typed = transactions_transform.transform(row)

        natural_key = typed["natural_key"]
        if natural_key in seen_keys:
            logger.warning(f"upsert_transactions: duplicate_natural_key entity=transactions natural_key={natural_key} — skipping second occurrence; fix the sheet")
            continue
        seen_keys.add(natural_key)

        existing = hashes_db.get_hash(conn, "transactions", natural_key)

        # Hash match — unchanged row
        if existing is not None and existing["row_hash"] == typed["row_hash"]:
            hashes_db.update_last_seen(conn, "transactions", natural_key)
            logger.info(f"upsert_transactions: unchanged entity=transactions natural_key={natural_key}")
            continue

        source_account_id = _resolve_account_id(typed["source_account_name"], account_name_map, "source_account_id", natural_key)
        target_account_id = _resolve_account_id(typed["target_account_name"], account_name_map, "target_account_id", natural_key)
        category_id = _resolve_category_id(conn, typed["tx_type"], typed["major_category"], typed["minor_category"], natural_key)
        tx_amount_base, tx_currency_base, local_to_base_currency_rate_ref = _resolve_currency_rate(conn, typed["tx_currency_local"], typed["tx_date_time_local"], typed["tx_amount_local"], natural_key)

        # New row
        if existing is None:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO transactions (
                            transaction_id,
                            tx_date_time_base, tx_date_time_local,
                            tx_day_of_week_base, tx_day_of_week_local,
                            tx_type,
                            source_account_id, target_account_id,
                            tx_amount_base, tx_amount_local,
                            tx_currency_base, tx_currency_local,
                            local_to_base_currency_rate_ref,
                            user_location_area, user_location_city, user_location_country,
                            counterparty_name,
                            counterparty_location_area, counterparty_location_city, counterparty_location_country,
                            tx_tags, tx_description,
                            category_id, row_hash,
                            is_deleted, created_at, updated_at
                        ) VALUES (
                            %s,
                            %s, %s,
                            %s, %s,
                            %s,
                            %s, %s,
                            %s, %s,
                            %s, %s,
                            %s,
                            %s, %s, %s,
                            %s,
                            %s, %s, %s,
                            %s, %s,
                            %s, %s,
                            FALSE, now(), now()
                        )
                        ON CONFLICT (transaction_id) DO UPDATE SET
                            is_deleted = FALSE,
                            deleted_at = NULL,
                            tx_date_time_base = EXCLUDED.tx_date_time_base,
                            tx_date_time_local = EXCLUDED.tx_date_time_local,
                            tx_day_of_week_base = EXCLUDED.tx_day_of_week_base,
                            tx_day_of_week_local = EXCLUDED.tx_day_of_week_local,
                            tx_type = EXCLUDED.tx_type,
                            source_account_id = EXCLUDED.source_account_id,
                            target_account_id = EXCLUDED.target_account_id,
                            tx_amount_base = EXCLUDED.tx_amount_base,
                            tx_amount_local = EXCLUDED.tx_amount_local,
                            tx_currency_base = EXCLUDED.tx_currency_base,
                            tx_currency_local = EXCLUDED.tx_currency_local,
                            local_to_base_currency_rate_ref = EXCLUDED.local_to_base_currency_rate_ref,
                            user_location_area = EXCLUDED.user_location_area,
                            user_location_city = EXCLUDED.user_location_city,
                            user_location_country = EXCLUDED.user_location_country,
                            counterparty_name = EXCLUDED.counterparty_name,
                            counterparty_location_area = EXCLUDED.counterparty_location_area,
                            counterparty_location_city = EXCLUDED.counterparty_location_city,
                            counterparty_location_country = EXCLUDED.counterparty_location_country,
                            tx_tags = EXCLUDED.tx_tags,
                            tx_description = EXCLUDED.tx_description,
                            category_id = EXCLUDED.category_id,
                            row_hash = EXCLUDED.row_hash,
                            updated_at = now()
                        """,
                        (
                            typed["transaction_id"],
                            typed["tx_date_time_base"],
                            typed["tx_date_time_local"],
                            typed["tx_day_of_week_base"],
                            typed["tx_day_of_week_local"],
                            typed["tx_type"],
                            source_account_id,
                            target_account_id,
                            tx_amount_base,
                            typed["tx_amount_local"],
                            tx_currency_base,
                            typed["tx_currency_local"],
                            local_to_base_currency_rate_ref,
                            typed["user_location_area"],
                            typed["user_location_city"],
                            typed["user_location_country"],
                            typed["counterparty_name"],
                            typed["counterparty_location_area"],
                            typed["counterparty_location_city"],
                            typed["counterparty_location_country"],
                            typed["tx_tags"],
                            typed["tx_description"],
                            category_id,
                            typed["row_hash"],
                        ),
                    )

                hashes_db.insert_hash(conn, "transactions", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_transactions: inserted entity=transactions natural_key={natural_key} category_id={category_id}")
            except Exception:
                conn.rollback()
                raise

        # Changed row
        else:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE transactions SET
                            tx_date_time_base = %s,
                            tx_date_time_local = %s,
                            tx_day_of_week_base = %s,
                            tx_day_of_week_local = %s,
                            tx_type = %s,
                            source_account_id = %s,
                            target_account_id = %s,
                            tx_amount_base = %s,
                            tx_amount_local = %s,
                            tx_currency_base = %s,
                            tx_currency_local = %s,
                            local_to_base_currency_rate_ref = %s,
                            user_location_area = %s,
                            user_location_city = %s,
                            user_location_country = %s,
                            counterparty_name = %s,
                            counterparty_location_area = %s,
                            counterparty_location_city = %s,
                            counterparty_location_country = %s,
                            tx_tags = %s,
                            tx_description = %s,
                            category_id = %s,
                            row_hash = %s,
                            updated_at = now()
                        WHERE transaction_id = %s
                        RETURNING id
                        """,
                        (
                            typed["tx_date_time_base"],
                            typed["tx_date_time_local"],
                            typed["tx_day_of_week_base"],
                            typed["tx_day_of_week_local"],
                            typed["tx_type"],
                            source_account_id,
                            target_account_id,
                            tx_amount_base,
                            typed["tx_amount_local"],
                            tx_currency_base,
                            typed["tx_currency_local"],
                            local_to_base_currency_rate_ref,
                            typed["user_location_area"],
                            typed["user_location_city"],
                            typed["user_location_country"],
                            typed["counterparty_name"],
                            typed["counterparty_location_area"],
                            typed["counterparty_location_city"],
                            typed["counterparty_location_country"],
                            typed["tx_tags"],
                            typed["tx_description"],
                            category_id,
                            typed["row_hash"],
                            typed["transaction_id"],
                        ),
                    )
                    row_result = cursor.fetchone()

                if row_result is None:
                    logger.error(f"upsert_transactions: update_returned_no_rows entity=transactions natural_key={natural_key}")
                    conn.rollback()
                    continue

                hashes_db.update_hash(conn, "transactions", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_transactions: updated entity=transactions natural_key={natural_key} category_id={category_id}")
            except Exception:
                conn.rollback()
                raise

    # --- Soft-delete pass ---
    db_keys = hashes_db.get_all_keys(conn, "transactions")
    stale_keys = db_keys - seen_keys

    for natural_key in stale_keys:
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE transactions SET
                        is_deleted = TRUE,
                        deleted_at = now(),
                        updated_at = now()
                    WHERE transaction_id = %s
                    RETURNING id
                    """,
                    (natural_key,),
                )
                row_result = cursor.fetchone()

            if row_result is None:
                logger.error(f"upsert_transactions: soft_delete_returned_no_rows entity=transactions natural_key={natural_key}")
                conn.rollback()
                continue

            hashes_db.delete_hash(conn, "transactions", natural_key)
            conn.commit()
            logger.info(f"upsert_transactions: soft_deleted entity=transactions natural_key={natural_key}")
        except Exception:
            conn.rollback()
            raise
