from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from typing import Any
from zoneinfo import ZoneInfo

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.transactions as sheets_transactions
import transforms.transactions as transactions_transform
from transforms.financial import to_minor_units

logger = get_logger(__name__)

_SHEET_NAME = "transactions"
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}
_BASE_CURRENCY = "XAU"
_XAU_DECIMAL_PLACES = 9
_DAY_NAMES = ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY")


def load_decimal_places(conn: Any) -> dict[str, int]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT currency_code, decimal_places FROM currency_master")
        rows = cursor.fetchall()
    return {row[0].strip(): row[1] for row in rows}


def load_account_map(conn: Any) -> dict[str, tuple[Any, str, str]]:
    """Include historical accounts: source lifecycle changes must remain extractable."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT id, local_currency, account_subtype FROM account_master")
        rows = cursor.fetchall()
    return {str(row[0]): (row[0], row[1].strip(), row[2]) for row in rows}


def lookup_category(conn: Any, tx_type: str, major_category: str, minor_category: str) -> Any | None:
    # Historical transactions may still reference inactive/deleted categories.
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id FROM category_master
            WHERE tx_type_key = %s AND major_category_key = %s AND minor_category_key = %s
            """,
            (tx_type, major_category, minor_category),
        )
        row = cursor.fetchone()
    return None if row is None else row[0]


def resolve_counterparty(conn: Any, counterparty_name: str | None, transaction_id: str) -> Any | None:
    if counterparty_name is None:
        return None
    # Preserve Unicode names while retaining the existing English key convention.
    cleaned = "".join(character for character in counterparty_name if character.isalnum() or character.isspace()).strip().upper()
    counterparty_key = re.sub(r"\s+", "_", cleaned)
    if not counterparty_key:
        raise ValueError("counterparty_name_not_representable")
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO counterparty_master (counterparty_key, counterparty_label, record_status, created_at, updated_at)
            VALUES (%s, %s, 'active', now(), now())
            ON CONFLICT (counterparty_key) DO UPDATE SET
                counterparty_label = EXCLUDED.counterparty_label,
                record_status = 'active', updated_at = now()
            RETURNING id
            """,
            (counterparty_key, counterparty_name),
        )
        counterparty = cursor.fetchone()
    if counterparty is None:
        raise RuntimeError("counterparty_upsert_returned_no_id")
    return counterparty[0]


def _parse_beneficiaries(raw_beneficiaries: str | None) -> list[tuple[str, Decimal]]:
    """Validate all allocations before any database writes; stored shares total exactly 100."""
    if raw_beneficiaries is None:
        return []
    entries = [entry.strip() for entry in raw_beneficiaries.split(";")]
    if any(not entry for entry in entries):
        raise ValueError("transactions: beneficiary_empty_name")
    has_percentage = [":" in entry for entry in entries]
    if any(has_percentage) and not all(has_percentage):
        raise ValueError("transactions: beneficiary_inconsistent_percentage_format")
    names = []
    percentages = []
    if all(has_percentage):
        for entry in entries:
            name, percentage_raw = (part.strip() for part in entry.split(":", 1))
            if not name:
                raise ValueError("transactions: beneficiary_empty_name")
            try:
                percentage = Decimal(percentage_raw)
                if not percentage.is_finite() or not 0 < percentage <= 100:
                    raise ValueError("transactions: beneficiary_invalid_percentage")
                percentage = percentage.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
            except InvalidOperation as error:
                raise ValueError("transactions: beneficiary_invalid_percentage") from error
            if percentage <= 0:
                raise ValueError("transactions: beneficiary_percentage_rounds_to_zero")
            names.append(name)
            percentages.append(percentage)
        if sum(percentages) != Decimal("100"):
            raise ValueError("transactions: beneficiary_percentages_do_not_sum_to_100")
    else:
        names = entries
        percentage = (Decimal("100") / len(names)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        percentages = [percentage] * (len(names) - 1) + [Decimal("100") - percentage * (len(names) - 1)]
        if min(percentages) <= 0:
            raise ValueError("transactions: too_many_beneficiaries")
    if len(set(names)) != len(names):
        raise ValueError("transactions: duplicate_beneficiary")
    return list(zip(names, percentages))


def _replace_beneficiaries(conn: Any, beneficiaries: list[tuple[str, Decimal]], transaction_ref: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("DELETE FROM transaction_beneficiaries WHERE transaction_ref = %s", (transaction_ref,))
        for name, percentage in beneficiaries:
            cursor.execute(
                """
                INSERT INTO beneficiaries_master (beneficiary_name, record_status, created_at, updated_at)
                VALUES (%s, 'active', now(), now())
                ON CONFLICT (beneficiary_name) DO UPDATE SET record_status = 'active', updated_at = now()
                RETURNING id
                """,
                (name,),
            )
            beneficiary = cursor.fetchone()
            if beneficiary is None:
                raise RuntimeError("beneficiary_upsert_returned_no_id")
            cursor.execute(
                """
                INSERT INTO transaction_beneficiaries (transaction_ref, beneficiary_id, split_percentage, created_at)
                VALUES (%s, %s, %s, now())
                """,
                (transaction_ref, beneficiary[0], percentage),
            )


def _resolve_amount(conn: Any, tx_amount: Decimal, local_currency: str, tx_date: Any, currency_decimal_places: dict[str, int]) -> tuple[int, int, Any | None, Decimal]:
    """Use the exact UTC transaction date and integer minor units, with one HALF_UP rounding."""
    if local_currency not in currency_decimal_places:
        raise ValueError("transactions: currency_not_found")
    if currency_decimal_places.get(_BASE_CURRENCY) != _XAU_DECIMAL_PLACES:
        raise ValueError("transactions: invalid_xau_decimal_places")
    local_dp = currency_decimal_places[local_currency]
    tx_amount_local = to_minor_units(tx_amount, local_dp, "transactions: tx_amount_local")
    if tx_amount_local <= 0:
        raise ValueError("transactions: amount_rounds_to_zero_in_minor_units")
    if local_currency == _BASE_CURRENCY:
        return tx_amount_local, tx_amount_local, None, Decimal(1)
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, rate_value FROM currency_rates
            WHERE quote_currency_code = %s AND rate_date = %s AND base_currency_code = 'XAU'
            """,
            (local_currency, tx_date),
        )
        rate_row = cursor.fetchone()
    if rate_row is None:
        raise ValueError(f"transactions: currency_rate_not_found currency={local_currency} date={tx_date}")
    rate_id, rate_value = rate_row
    if not isinstance(rate_value, Decimal) or not rate_value.is_finite() or rate_value <= 0:
        raise ValueError("transactions: invalid_currency_rate")
    with localcontext() as context:
        context.prec = 64
        amount_base = Decimal(tx_amount_local).scaleb(-local_dp) / rate_value
        tx_amount_base = to_minor_units(amount_base, _XAU_DECIMAL_PLACES, "transactions: tx_amount_base")
    if tx_amount_base <= 0:
        raise ValueError("transactions: amount_rounds_to_zero_in_base_units")
    return tx_amount_local, tx_amount_base, rate_id, rate_value


def _extract_datetime_fields(tx_date_time_base: datetime, tx_timezone_local: str) -> tuple[datetime, str, str]:
    tx_date_time_local = tx_date_time_base.astimezone(ZoneInfo(tx_timezone_local)).replace(tzinfo=None)
    return tx_date_time_local, _DAY_NAMES[tx_date_time_base.weekday()], _DAY_NAMES[tx_date_time_local.weekday()]


def _to_sync_notes(error: Exception) -> str:
    if isinstance(error, ValueError):
        return str(error).removeprefix("transactions: ")
    if isinstance(error, pg_errors.IntegrityError):
        return f"database_constraint_violation constraint={error.diag.constraint_name or 'unknown'}"
    if isinstance(error, pg_errors.DataError):
        return "database_value_out_of_range_or_invalid"
    raise TypeError(f"unhandled_row_error type={type(error).__name__}")


def _validate_parent(conn: Any, typed: dict[str, Any], account_id: Any) -> None:
    if typed["parent_tx_id"] is None:
        return
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT tm.parent_tx_id, tm.account_id, cm.tx_type_key, tm.record_status
            FROM transaction_master tm JOIN category_master cm ON cm.id = tm.category_id
            WHERE tm.transaction_id = %s
            """,
            (typed["parent_tx_id"],),
        )
        parent = cursor.fetchone()
    if parent is None:
        raise ValueError("transactions: parent_tx_not_found")
    if parent[0] is not None:
        raise ValueError("transactions: nested_parent_reference")
    # Deleted child rows are tombstones and may reflect a former relationship.
    if typed["record_status"] != "deleted":
        if str(parent[1]) == str(account_id) or parent[2] == typed["tx_type"]:
            raise ValueError("transactions: invalid_transfer_pair")
        if parent[3] == "deleted":
            raise ValueError("transactions: parent_transaction_deleted")


def _validate_stored_relationships(conn: Any, transaction_ids: list[str]) -> None:
    """Validate the final pair state, including unchanged siblings of edited parents."""
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT 1
            FROM transaction_master child
            JOIN transaction_master parent ON parent.transaction_id = child.parent_tx_id
            JOIN category_master child_category ON child_category.id = child.category_id
            JOIN category_master parent_category ON parent_category.id = parent.category_id
            WHERE child.record_status != 'deleted'
              AND (child.transaction_id = ANY(%s) OR parent.transaction_id = ANY(%s))
              AND (parent.parent_tx_id IS NOT NULL OR parent.record_status = 'deleted'
                   OR child.account_id = parent.account_id OR child_category.tx_type_key = parent_category.tx_type_key)
            LIMIT 1
            """,
            (transaction_ids, transaction_ids),
        )
        if cursor.fetchone() is not None:
            raise ValueError("transactions: invalid_transfer_pair")
        cursor.execute(
            """
            SELECT child.parent_tx_id
            FROM transaction_master child
            WHERE child.parent_tx_id IS NOT NULL AND child.record_status != 'deleted'
              AND (child.parent_tx_id = ANY(%s) OR child.parent_tx_id IN (
                  SELECT changed.parent_tx_id FROM transaction_master changed WHERE changed.transaction_id = ANY(%s)
              ))
            GROUP BY child.parent_tx_id HAVING count(*) > 1
            LIMIT 1
            """,
            (transaction_ids, transaction_ids),
        )
        if cursor.fetchone() is not None:
            raise ValueError("transactions: multiple_live_transfer_children")


def _upsert_row(conn: Any, typed: dict[str, Any], account_map: dict[str, tuple[Any, str, str]], decimal_places: dict[str, int]) -> tuple[Any, Any]:
    account = account_map.get(typed["account_id_sheet"])
    if account is None:
        raise ValueError("transactions: account_not_found")
    account_id, local_currency, _account_subtype = account
    beneficiaries = _parse_beneficiaries(typed["beneficiaries_raw"])
    _validate_parent(conn, typed, account_id)
    amount_local, amount_base, currency_rate_id, applied_rate_value = _resolve_amount(conn, typed["tx_amount_local"], local_currency, typed["tx_date_time_base"].date(), decimal_places)
    category_id = lookup_category(conn, typed["tx_type"], typed["major_category"], typed["minor_category"])
    if category_id is None:
        raise ValueError("transactions: category_not_found")
    counterparty_id = resolve_counterparty(conn, typed["counterparty_name"], typed["transaction_id"])
    local_datetime, base_day, local_day = _extract_datetime_fields(typed["tx_date_time_base"], typed["tx_timezone_local"])
    with conn.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO transaction_master (
                transaction_id, parent_tx_id, tx_date_time_base, tx_date_time_local,
                tx_timezone_base, tx_timezone_local, tx_day_of_week_base, tx_day_of_week_local,
                category_id, account_id, tx_amount_local, tx_amount_base, local_currency, base_currency,
                currency_rate_id, applied_rate_value, tx_description, counterparty_id, tx_tags,
                user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude,
                record_status, created_at, updated_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'XAU',
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now()
            ) ON CONFLICT (transaction_id) DO UPDATE SET
                parent_tx_id = EXCLUDED.parent_tx_id,
                tx_date_time_base = EXCLUDED.tx_date_time_base, tx_date_time_local = EXCLUDED.tx_date_time_local,
                tx_timezone_base = EXCLUDED.tx_timezone_base, tx_timezone_local = EXCLUDED.tx_timezone_local,
                tx_day_of_week_base = EXCLUDED.tx_day_of_week_base, tx_day_of_week_local = EXCLUDED.tx_day_of_week_local,
                category_id = EXCLUDED.category_id, account_id = EXCLUDED.account_id,
                tx_amount_local = EXCLUDED.tx_amount_local, tx_amount_base = EXCLUDED.tx_amount_base,
                local_currency = EXCLUDED.local_currency, base_currency = EXCLUDED.base_currency,
                currency_rate_id = EXCLUDED.currency_rate_id, applied_rate_value = EXCLUDED.applied_rate_value, tx_description = EXCLUDED.tx_description,
                counterparty_id = EXCLUDED.counterparty_id, tx_tags = EXCLUDED.tx_tags,
                user_location_area = EXCLUDED.user_location_area, user_location_city = EXCLUDED.user_location_city,
                user_location_country = EXCLUDED.user_location_country,
                user_location_latitude = EXCLUDED.user_location_latitude, user_location_longitude = EXCLUDED.user_location_longitude,
                record_status = EXCLUDED.record_status, updated_at = now()
            RETURNING id, created_at
            """,
            (
                typed["transaction_id"],
                typed["parent_tx_id"],
                typed["tx_date_time_base"],
                local_datetime,
                typed["tx_timezone_base"],
                typed["tx_timezone_local"],
                base_day,
                local_day,
                category_id,
                account_id,
                amount_local,
                amount_base,
                local_currency,
                currency_rate_id,
                applied_rate_value,
                typed["tx_description"],
                counterparty_id,
                typed["tx_tags"],
                typed["user_location_area"],
                typed["user_location_city"],
                typed["user_location_country"],
                typed["user_location_latitude"],
                typed["user_location_longitude"],
                typed["record_status"],
            ),
        )
        transaction = cursor.fetchone()
    if transaction is None:
        raise RuntimeError("transaction_upsert_returned_no_id")
    _replace_beneficiaries(conn, beneficiaries, transaction[0])
    return transaction[0], transaction[1]


def _group_rows(rows: list[dict[str, Any]]) -> list[list[tuple[int, dict[str, Any]]]]:
    """Keep physical row numbers while grouping transfers and ordering parents first."""
    row_by_id = {}
    for index, row in enumerate(rows):
        identity = str(row.get("id") or "").strip()
        if identity:
            if identity in row_by_id:
                raise ValueError("transactions: duplicate_source_id")
            row_by_id[identity] = (int(row.get("_sheet_row_num", index + 2)), row)
    groups: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for index, row in enumerate(rows):
        identity = str(row.get("id") or "").strip()
        if not identity and not any(value is not None and str(value).strip() for key, value in row.items() if not key.startswith("_")):
            continue
        root = identity or f"missing-id-row-{index}"
        seen = {root}
        parent = str(row.get("parent_tx_id") or "").strip()
        while parent:
            if parent in seen:
                raise ValueError("transactions: cyclic_parent_reference")
            seen.add(parent)
            root = parent
            parent_row = row_by_id.get(parent)
            parent = str(parent_row[1].get("parent_tx_id") or "").strip() if parent_row is not None else ""
        groups.setdefault(root, []).append((int(row.get("_sheet_row_num", index + 2)), row))
    return [sorted(group, key=lambda entry: bool(str(entry[1].get("parent_tx_id") or "").strip())) for group in groups.values()]


def retire_unused_references(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            UPDATE counterparty_master cp SET record_status = 'deleted', updated_at = now()
            WHERE cp.record_status = 'active'
              AND NOT EXISTS (SELECT 1 FROM transaction_master tm WHERE tm.counterparty_id = cp.id AND tm.record_status != 'deleted')
              AND NOT EXISTS (SELECT 1 FROM subscription_master sm WHERE sm.counterparty_id = cp.id AND sm.record_status != 'deleted')
            """
        )
        cursor.execute(
            """
            UPDATE beneficiaries_master bm SET record_status = 'deleted', updated_at = now()
            WHERE bm.record_status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM transaction_beneficiaries tb JOIN transaction_master tm ON tm.id = tb.transaction_ref
                WHERE tb.beneficiary_id = bm.id AND tm.record_status != 'deleted'
              )
            """
        )
    conn.commit()


def upsert_transactions(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], account_map: dict[str, tuple[Any, str, str]]) -> int:
    """Persist each standalone transaction/transfer atomically; return failed source rows."""
    groups = _group_rows(rows)
    decimal_places = load_decimal_places(conn)
    write_backs = []
    succeeded = failed = 0
    logger.info(f"upsert_transactions: start total={len(rows)}")
    try:
        for group in groups:
            actionable = [(number, row) for number, row in group if str(row.get("sync_status") or "").strip() != "in-sync"]
            if not actionable:
                continue
            try:
                typed_rows = []
                for number, row in actionable:
                    if str(row.get("sync_status") or "").strip() not in _ACTIONABLE:
                        raise ValueError("transactions: invalid_sync_status")
                    typed_rows.append((number, transactions_transform.transform(row)))
                stored = [(number, _upsert_row(conn, typed, account_map, decimal_places)) for number, typed in typed_rows]
                _validate_stored_relationships(conn, [typed["transaction_id"] for _number, typed in typed_rows])
                conn.commit()
            except (ValueError, pg_errors.IntegrityError, pg_errors.DataError) as error:
                conn.rollback()
                failed += len(actionable)
                sync_date = datetime.now(timezone.utc).isoformat()
                for number, row in actionable:
                    status = "update-failed" if str(row.get("sync_status") or "").startswith("update-") else "create-failed"
                    write_backs.append(sheets_transactions.write_back_failure(number, status, sync_date, _to_sync_notes(error)))
                logger.warning(f"upsert_transactions: group_failed rows={len(actionable)} error_type={type(error).__name__}")
                continue
            except Exception:
                conn.rollback()
                raise
            sync_date = datetime.now(timezone.utc).isoformat()
            for number, (_identity, created_at) in stored:
                write_backs.append(sheets_transactions.write_back_success(number, "in-sync", sync_date, "", created_at.isoformat(), sync_date))
            succeeded += len(stored)
    finally:
        logger.info(f"upsert_transactions: done succeeded={succeeded} failed={failed}")
        sheets_transactions.flush(sheets_client, _SHEET_NAME, write_backs)
    return failed
