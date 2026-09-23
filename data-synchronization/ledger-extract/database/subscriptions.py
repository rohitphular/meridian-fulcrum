from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.subscriptions as sheets_subscriptions
import transforms.subscriptions as subscriptions_transform
from database.transactions import (
    load_account_map,  # noqa: F401 — same account identity contract
    load_decimal_places,
    lookup_category,
    resolve_counterparty,
)
from transforms.financial import to_minor_units

logger = get_logger(__name__)

_SHEET_NAME = "subscriptions"
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}


def _to_sync_notes(error: Exception) -> str:
    if isinstance(error, ValueError):
        return str(error).removeprefix("subscriptions: ")
    if isinstance(error, pg_errors.IntegrityError):
        return f"database_constraint_violation constraint={error.diag.constraint_name or 'unknown'}"
    if isinstance(error, pg_errors.DataError):
        return "database_value_out_of_range_or_invalid"
    raise TypeError(f"unhandled_row_error type={type(error).__name__}")


def _resolve_dependencies(conn: Any, typed: dict[str, Any], account_map: dict[str, tuple[Any, str, str]], currency_decimal_places: dict[str, int]) -> dict[str, Any]:
    account = account_map.get(typed["account_id_sheet"])
    if account is None:
        raise ValueError("subscriptions: account_not_found")
    account_id, currency, _subtype = account
    if currency not in currency_decimal_places:
        raise ValueError("subscriptions: currency_not_found")
    amount_local = to_minor_units(typed["amount_local"], currency_decimal_places[currency], "subscriptions: amount_local")
    if amount_local <= 0:
        raise ValueError("subscriptions: amount_rounds_to_zero")
    category_id = lookup_category(conn, typed["tx_type"], typed["major_category"], typed["minor_category"])
    if category_id is None:
        raise ValueError("subscriptions: category_not_found")
    counterparty_id = resolve_counterparty(conn, typed["counterparty_name"], typed["subscription_id"])
    return {"account_surrogate_id": account_id, "amount_local": amount_local, "category_id": category_id, "counterparty_id": counterparty_id}


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


def upsert_subscriptions(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], account_map: dict[str, tuple[Any, str, str]]) -> int:
    """Mirror source state, including restored/deleted rows, preserving DB identity on retry."""
    identities = [str(row.get("id") or "").strip() for row in rows if str(row.get("id") or "").strip()]
    if len(identities) != len(set(identities)):
        raise ValueError("subscriptions: duplicate_source_id")
    currency_decimal_places = load_decimal_places(conn)
    write_backs = []
    succeeded = failed = 0
    logger.info(f"upsert_subscriptions: start total={len(rows)}")
    try:
        for index, row in enumerate(rows):
            if not any(value is not None and str(value).strip() for key, value in row.items() if not key.startswith("_")):
                continue
            number = int(row.get("_sheet_row_num", index + 2))
            sync_status = str(row.get("sync_status") or "").strip()
            if sync_status == "in-sync":
                continue
            try:
                if sync_status not in _ACTIONABLE:
                    raise ValueError("subscriptions: invalid_sync_status")
                typed = subscriptions_transform.transform(row)
                dependencies = _resolve_dependencies(conn, typed, account_map, currency_decimal_places)
                _, created_at = _do_upsert(conn, typed, dependencies)
                conn.commit()
            except (ValueError, pg_errors.IntegrityError, pg_errors.DataError) as error:
                conn.rollback()
                failed += 1
                sync_date = datetime.now(timezone.utc).isoformat()
                failed_status = "update-failed" if sync_status.startswith("update-") else "create-failed"
                write_backs.append(sheets_subscriptions.write_back_failure(number, failed_status, sync_date, _to_sync_notes(error)))
                logger.warning(f"upsert_subscriptions: row_failed row={number} error_type={type(error).__name__}")
                continue
            except Exception:
                conn.rollback()
                raise
            sync_date = datetime.now(timezone.utc).isoformat()
            write_backs.append(sheets_subscriptions.write_back_success(number, created_at.isoformat(), "in-sync", sync_date, "", sync_date))
            succeeded += 1
    finally:
        logger.info(f"upsert_subscriptions: done succeeded={succeeded} failed={failed}")
        sheets_subscriptions.flush(sheets_client, _SHEET_NAME, write_backs)
    return failed
