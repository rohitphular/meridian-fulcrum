from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.subscriptions as sheets_subscriptions
from database.transactions import load_account_map  # noqa: F401 — re-exported for callers
from transforms import subscriptions as subscriptions_transform

logger = get_logger(__name__)

_SHEET_NAME = "subscriptions"
_VALID_SYNC_STATUSES = {"create-pending", "create-failed", "update-pending", "update-failed", "in-sync"}
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}


def _load_decimal_places(conn: Any) -> dict[str, int]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT currency_code, decimal_places FROM currency_master")
        rows = cursor.fetchall()
    return {row[0]: row[1] for row in rows}


def _lookup_category(conn: Any, tx_type: str, major_category: str, minor_category: str) -> Any | None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id FROM category_master
            WHERE tx_type_key = %s AND major_category_key = %s AND minor_category_key = %s
              AND record_status = 'active'
            LIMIT 1
            """,
            (tx_type, major_category, minor_category),
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return row[0]


def _resolve_counterparty(conn: Any, counterparty_name: str | None, subscription_id: str) -> Any | None:
    if counterparty_name is None:
        return None

    cleaned = re.sub(r"[^a-zA-Z0-9 ]", "", counterparty_name)
    cleaned = cleaned.strip().upper()
    cleaned = re.sub(r" +", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)

    if cleaned == "":
        logger.warning(
            f"_resolve_counterparty: empty_key_after_normalisation entity=subscriptions subscription_id={subscription_id!r} counterparty_name={counterparty_name!r} — setting counterparty_id=NULL"
        )
        return None

    counterparty_key = cleaned
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO counterparty_master (counterparty_key, counterparty_label, record_status, created_at, updated_at)
            VALUES (%s, %s, 'active', now(), now())
            ON CONFLICT (counterparty_key) DO UPDATE SET
                counterparty_label = EXCLUDED.counterparty_label,
                record_status      = 'active',
                updated_at         = now()
            RETURNING id
            """,
            (counterparty_key, counterparty_name),
        )
        pk_row = cursor.fetchone()
    if pk_row is None:
        raise RuntimeError(f"counterparty upsert returned no id for counterparty_key={counterparty_key!r}")
    logger.info(f"_resolve_counterparty: upserted entity=subscriptions subscription_id={subscription_id!r} counterparty_id={pk_row[0]} counterparty_key={counterparty_key!r}")
    return pk_row[0]


def _to_sync_notes(e: Exception) -> str:
    if isinstance(e, ValueError):
        return str(e).removeprefix("subscriptions: ")
    if isinstance(e, pg_errors.UniqueViolation):
        constraint = e.diag.constraint_name
        if constraint == "uq_sm_subscription_id":
            return "duplicate_subscription_id"
        raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")
    if isinstance(e, pg_errors.ForeignKeyViolation):
        constraint = e.diag.constraint_name
        if constraint == "fk_sm_account":
            return "account_fk_violation"
        if constraint == "fk_sm_category":
            return "category_fk_violation"
        if constraint == "fk_sm_counterparty":
            return "counterparty_fk_violation"
        raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")
    if isinstance(e, pg_errors.CheckViolation):
        constraint = e.diag.constraint_name
        if constraint == "chk_sm_frequency":
            return "invalid_frequency"
        if constraint == "chk_sm_record_status":
            return "invalid_record_status"
        if constraint == "chk_sm_amount_positive":
            return "amount_not_positive"
        if constraint == "chk_sm_day_of_month":
            return "invalid_day_of_month"
        if constraint == "chk_sm_day_of_week":
            return "invalid_day_of_week"
        if constraint == "chk_sm_date_range":
            return "end_before_start"
        raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")
    if isinstance(e, pg_errors.NotNullViolation):
        return "null_constraint_violation"
    raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")


def _resolve_dependencies(
    conn: Any,
    typed: dict[str, Any],
    subscription_id: str,
    sheet_row_num: int,
    account_map: dict[str, tuple[Any, str]],
    currency_decimal_places: dict[str, int],
    write_backs: list[sheets_subscriptions.WriteBack],
    failed_status: str,
) -> dict[str, Any] | None:
    """Execute dependency resolution steps 1–5.

    Returns a dict of resolved values on success, or None after appending a failure write-back.
    """
    # Step 1 — source_account → account_id
    account_id_sheet = typed["account_id_sheet"]
    if account_id_sheet not in account_map:
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(f"_resolve_dependencies: account_not_found entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} account_id={account_id_sheet!r}")
        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, failed_status, sync_dt, "account_not_found"))
        return None

    account_surrogate_id, local_currency = account_map[account_id_sheet]

    # Step 2 — local_currency → decimal_places
    if local_currency not in currency_decimal_places:
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(f"_resolve_dependencies: currency_not_found entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} currency={local_currency!r}")
        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, failed_status, sync_dt, "currency_not_found"))
        return None

    dp = currency_decimal_places[local_currency]

    # Step 3 — amount_local as BIGINT minor units
    amount_local = int((typed["amount_local"] * Decimal(10) ** dp).to_integral_value(ROUND_HALF_UP))
    if amount_local == 0:
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(f"_resolve_dependencies: amount_rounds_to_zero entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r}")
        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, failed_status, sync_dt, "amount_rounds_to_zero"))
        return None

    # Step 4 — category_id
    category_id = _lookup_category(conn, typed["tx_type"], typed["major_category"], typed["minor_category"])
    if category_id is None:
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(
            f"_resolve_dependencies: category_not_found entity=subscriptions"
            f" row={sheet_row_num} subscription_id={subscription_id!r}"
            f" tx_type={typed['tx_type']!r} major={typed['major_category']!r} minor={typed['minor_category']!r}"
        )
        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, failed_status, sync_dt, "category_not_found"))
        return None

    logger.info(f"_resolve_dependencies: category_resolved entity=subscriptions subscription_id={subscription_id!r} category_id={category_id}")

    # Step 5 — counterparty_id (never fails; returns None on empty key)
    counterparty_id = _resolve_counterparty(conn, typed["counterparty_name"], subscription_id)

    return {
        "account_surrogate_id": account_surrogate_id,
        "amount_local": amount_local,
        "category_id": category_id,
        "counterparty_id": counterparty_id,
    }


def _do_upsert(conn: Any, typed: dict[str, Any], deps: dict[str, Any]) -> tuple[Any, Any]:
    """Execute INSERT ... ON CONFLICT DO UPDATE and return (id, created_at)."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO subscription_master (
                subscription_id, name, counterparty_id, amount_local,
                frequency, day_of_month, day_of_week,
                account_id, category_id, description,
                subscription_start_date_local, subscription_end_date_local, subscription_timezone_local,
                record_status, created_at, updated_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            ON CONFLICT (subscription_id) DO UPDATE SET
                name                            = EXCLUDED.name,
                counterparty_id                 = EXCLUDED.counterparty_id,
                amount_local                    = EXCLUDED.amount_local,
                frequency                       = EXCLUDED.frequency,
                day_of_month                    = EXCLUDED.day_of_month,
                day_of_week                     = EXCLUDED.day_of_week,
                account_id                      = EXCLUDED.account_id,
                category_id                     = EXCLUDED.category_id,
                description                     = EXCLUDED.description,
                subscription_start_date_local   = EXCLUDED.subscription_start_date_local,
                subscription_end_date_local     = EXCLUDED.subscription_end_date_local,
                subscription_timezone_local     = EXCLUDED.subscription_timezone_local,
                record_status                   = EXCLUDED.record_status,
                updated_at                      = now()
            RETURNING id, created_at
            """,
            (
                typed["subscription_id"],
                typed["name"],
                deps["counterparty_id"],
                deps["amount_local"],
                typed["frequency"],
                typed["day_of_month"],
                typed["day_of_week"],
                deps["account_surrogate_id"],
                deps["category_id"],
                typed["description"],
                typed["subscription_start_date_local"],
                typed["subscription_end_date_local"],
                typed["subscription_timezone_local"],
                typed["record_status"],
            ),
        )
        pk_row = cursor.fetchone()
    if pk_row is None:
        raise RuntimeError(f"INSERT ON CONFLICT returned no row for subscription_id={typed['subscription_id']!r}")
    return pk_row[0], pk_row[1]


def upsert_subscriptions(
    conn: Any,
    sheets_client: SheetsClient,
    rows: list[dict[str, Any]],
    account_map: dict[str, tuple[Any, str]],
) -> None:
    """Process all subscription rows and write sync results back to the sheet."""
    in_sync_count = sum(1 for row in rows if row.get("sync_status") == "in-sync")
    actionable_count = sum(1 for row in rows if row.get("sync_status") in _ACTIONABLE)
    logger.info(f"upsert_subscriptions: start entity=subscriptions total={len(rows)} in_sync={in_sync_count} actionable={actionable_count}")

    currency_decimal_places = _load_decimal_places(conn)

    write_backs: list[sheets_subscriptions.WriteBack] = []
    inserted = 0
    updated = 0
    failed = 0

    try:
        for row_index, row in enumerate(rows):
            sheet_row_num = row_index + 2  # row 1 is the header

            raw_id = row.get("id")
            if raw_id is None or str(raw_id).strip() == "":
                logger.warning(f"upsert_subscriptions: blank_id entity=subscriptions row={sheet_row_num} — skipping")
                continue

            raw_sync_status = row.get("sync_status")
            if raw_sync_status is None or str(raw_sync_status).strip() == "":
                logger.warning(f"upsert_subscriptions: missing_sync_status entity=subscriptions row={sheet_row_num} — skipping")
                continue
            sync_status = str(raw_sync_status).strip()

            if sync_status == "in-sync":
                continue
            if sync_status not in _VALID_SYNC_STATUSES:
                logger.warning(f"upsert_subscriptions: unknown_sync_status entity=subscriptions row={sheet_row_num} sync_status={sync_status!r} — skipping")
                continue

            subscription_id = str(raw_id).strip()
            failed_status = "create-failed" if sync_status in ("create-pending", "create-failed") else "update-failed"

            try:
                typed = subscriptions_transform.transform(row)
            except ValueError as e:
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.warning(f"upsert_subscriptions: transform_error entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} error={e}")
                write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
                failed += 1
                continue

            if sync_status in ("create-pending", "create-failed"):
                try:
                    deps = _resolve_dependencies(
                        conn, typed, subscription_id, sheet_row_num,
                        account_map, currency_decimal_places, write_backs, "create-failed",
                    )
                    if deps is None:
                        failed += 1
                        continue

                    _, created_at_db = _do_upsert(conn, typed, deps)
                    conn.commit()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    created_at_str = created_at_db.isoformat()
                    write_backs.append(sheets_subscriptions.write_back_success(sheet_row_num, created_at_str, "in-sync", sync_dt, "", sync_dt))
                    inserted += 1
                    logger.info(f"upsert_subscriptions: inserted entity=subscriptions subscription_id={subscription_id!r}")

                except (
                    pg_errors.ForeignKeyViolation,
                    pg_errors.CheckViolation,
                    pg_errors.NotNullViolation,
                    pg_errors.UniqueViolation,
                ) as e:
                    conn.rollback()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    logger.error(f"upsert_subscriptions: create_failed entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} error={e}")
                    write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, "create-failed", sync_dt, _to_sync_notes(e)))
                    failed += 1
                except Exception as e:
                    conn.rollback()
                    logger.error(f"upsert_subscriptions: unexpected_error entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} error={e!r}")
                    raise

            elif sync_status in ("update-pending", "update-failed"):
                try:
                    deps = _resolve_dependencies(
                        conn, typed, subscription_id, sheet_row_num,
                        account_map, currency_decimal_places, write_backs, "update-failed",
                    )
                    if deps is None:
                        failed += 1
                        continue

                    with conn.cursor() as cursor:
                        cursor.execute(
                            "SELECT record_status, created_at FROM subscription_master WHERE subscription_id = %s",
                            (subscription_id,),
                        )
                        existing = cursor.fetchone()

                    if existing is None:
                        # Row not found — fall through to upsert (INSERT ON CONFLICT)
                        logger.info(f"upsert_subscriptions: subscription_not_found_fallthrough entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} — inserting via upsert")
                        _, created_at_db = _do_upsert(conn, typed, deps)
                        conn.commit()
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        created_at_str = created_at_db.isoformat()
                        write_backs.append(sheets_subscriptions.write_back_success(sheet_row_num, created_at_str, "in-sync", sync_dt, "", sync_dt))
                        updated += 1
                        logger.info(f"upsert_subscriptions: upserted entity=subscriptions subscription_id={subscription_id!r}")
                        continue

                    existing_record_status, existing_created_at = existing

                    if existing_record_status == "locked":
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        logger.warning(f"upsert_subscriptions: subscription_locked entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r}")
                        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, "update-failed", sync_dt, "subscription_locked"))
                        failed += 1
                        continue

                    if existing_record_status == "deleted":
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        logger.warning(f"upsert_subscriptions: subscription_deleted entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r}")
                        write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, "update-failed", sync_dt, "subscription_deleted"))
                        failed += 1
                        continue

                    # active or inactive — run UPDATE
                    with conn.cursor() as cursor:
                        cursor.execute(
                            """
                            UPDATE subscription_master SET
                                name                            = %s,
                                counterparty_id                 = %s,
                                amount_local                    = %s,
                                frequency                       = %s,
                                day_of_month                    = %s,
                                day_of_week                     = %s,
                                account_id                      = %s,
                                category_id                     = %s,
                                description                     = %s,
                                subscription_start_date_local   = %s,
                                subscription_end_date_local     = %s,
                                subscription_timezone_local     = %s,
                                record_status                   = %s,
                                updated_at                      = now()
                            WHERE subscription_id = %s
                            """,
                            (
                                typed["name"],
                                deps["counterparty_id"],
                                deps["amount_local"],
                                typed["frequency"],
                                typed["day_of_month"],
                                typed["day_of_week"],
                                deps["account_surrogate_id"],
                                deps["category_id"],
                                typed["description"],
                                typed["subscription_start_date_local"],
                                typed["subscription_end_date_local"],
                                typed["subscription_timezone_local"],
                                typed["record_status"],
                                subscription_id,
                            ),
                        )

                    conn.commit()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    created_at_str = existing_created_at.isoformat()
                    write_backs.append(sheets_subscriptions.write_back_success(sheet_row_num, created_at_str, "in-sync", sync_dt, "", sync_dt))
                    updated += 1
                    logger.info(f"upsert_subscriptions: updated entity=subscriptions subscription_id={subscription_id!r}")

                except (
                    pg_errors.ForeignKeyViolation,
                    pg_errors.CheckViolation,
                    pg_errors.NotNullViolation,
                    pg_errors.UniqueViolation,
                ) as e:
                    conn.rollback()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    logger.error(f"upsert_subscriptions: update_failed entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} error={e}")
                    write_backs.append(sheets_subscriptions.write_back_failure(sheet_row_num, "update-failed", sync_dt, _to_sync_notes(e)))
                    failed += 1
                except Exception as e:
                    conn.rollback()
                    logger.error(f"upsert_subscriptions: unexpected_error entity=subscriptions row={sheet_row_num} subscription_id={subscription_id!r} error={e!r}")
                    raise

    finally:
        logger.info(f"upsert_subscriptions: done entity=subscriptions inserted={inserted} updated={updated} failed={failed}")
        sheets_subscriptions.flush(sheets_client, _SHEET_NAME, write_backs)
