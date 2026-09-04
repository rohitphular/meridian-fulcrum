from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.transactions as sheets_transactions
from transforms import transactions as transactions_transform

logger = get_logger(__name__)

_SHEET_NAME = "transactions"
_VALID_SYNC_STATUSES = {"create-pending", "create-failed", "update-pending", "update-failed", "in-sync"}
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}
_BASE_CURRENCY = "XAU"
_XAU_DECIMAL_PLACES = 9
_DAY_NAMES = {
    0: "MONDAY",
    1: "TUESDAY",
    2: "WEDNESDAY",
    3: "THURSDAY",
    4: "FRIDAY",
    5: "SATURDAY",
    6: "SUNDAY",
}


def _load_decimal_places(conn: Any) -> dict[str, int]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT currency_code, decimal_places FROM currency_master")
        rows = cursor.fetchall()
    return {row[0]: row[1] for row in rows}


def load_account_map(conn: Any) -> dict[str, tuple[Any, str]]:
    """Return mapping of account natural key → (surrogate UUID id, local_currency)."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT account_id, id, local_currency FROM account_master WHERE record_status NOT IN ('deleted', 'locked')")
        rows = cursor.fetchall()
    return {row[0]: (row[1], row[2]) for row in rows}


def _lookup_category(conn: Any, tx_type: str, major_category: str, minor_category: str) -> Any | None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id FROM category_master
            WHERE tx_type_key = %s AND major_category_key = %s AND minor_category_key = %s
              AND record_status = 'active'
            """,
            (tx_type, major_category, minor_category),
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return row[0]


def _resolve_counterparty(conn: Any, counterparty_name: str | None, transaction_id: str) -> Any | None:
    if counterparty_name is None:
        return None

    cleaned = re.sub(r"[^a-zA-Z0-9 ]", "", counterparty_name)
    cleaned = cleaned.strip().upper()
    cleaned = re.sub(r" +", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)

    if cleaned == "":
        logger.warning(
            f"_resolve_counterparty: empty_key_after_normalisation entity=transactions transaction_id={transaction_id!r} counterparty_name={counterparty_name!r} — setting counterparty_id=NULL"
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
    logger.info(f"_resolve_counterparty: upserted entity=transactions transaction_id={transaction_id!r} counterparty_id={pk_row[0]} counterparty_key={counterparty_key!r}")
    return pk_row[0]


def _resolve_beneficiaries(
    conn: Any,
    raw_beneficiaries: str,
    transaction_ref: Any,
    transaction_id: str,
) -> None:
    entries = [e.strip() for e in raw_beneficiaries.split(";")]

    for entry in entries:
        if entry == "":
            raise ValueError(f"transactions: beneficiary_empty_name in beneficiaries field for transaction_id={transaction_id!r}")

    has_percentage = [":" in e for e in entries]
    if any(has_percentage) and not all(has_percentage):
        raise ValueError(f"transactions: beneficiary_inconsistent_percentage_format for transaction_id={transaction_id!r} — all entries must have a percentage or none")

    names: list[str]
    percentages: list[Decimal]

    if all(has_percentage):
        names = []
        percentages = []
        for entry in entries:
            parts = entry.split(":", 1)
            name = parts[0].strip()
            pct_raw = parts[1].strip()
            if name == "":
                raise ValueError(f"transactions: beneficiary_empty_name in beneficiaries field for transaction_id={transaction_id!r}")
            try:
                pct = Decimal(pct_raw)
            except Exception as e:
                logger.warning(f"_resolve_beneficiaries: invalid_percentage value={pct_raw!r} transaction_id={transaction_id!r} error={e}")
                raise ValueError(f"transactions: beneficiary_invalid_percentage value={pct_raw!r} for transaction_id={transaction_id!r}") from e
            if pct <= 0 or pct > 100:
                raise ValueError(f"transactions: beneficiary_invalid_percentage value={pct} for transaction_id={transaction_id!r} — must be > 0 and <= 100")
            names.append(name)
            percentages.append(pct)

        total = sum(percentages)
        if abs(total - Decimal("100")) > Decimal("0.01"):
            raise ValueError(f"transactions: beneficiary_percentages_do_not_sum_to_100 total={total} for transaction_id={transaction_id!r}")
    else:
        names = list(entries)
        count = len(names)
        base_pct = (Decimal("100") / Decimal(count)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        remainder = Decimal("100.0000") - base_pct * (count - 1)
        percentages = [base_pct] * (count - 1) + [remainder]

    for name, pct in zip(names, percentages):
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO beneficiaries_master (beneficiary_name, record_status, created_at, updated_at)
                VALUES (%s, 'active', now(), now())
                ON CONFLICT (beneficiary_name) DO UPDATE SET
                    record_status = 'active',
                    updated_at    = now()
                RETURNING id
                """,
                (name,),
            )
            bm_row = cursor.fetchone()
        if bm_row is None:
            raise RuntimeError(f"beneficiaries_master upsert returned no id for name={name!r}")
        beneficiary_id = bm_row[0]

        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO transaction_beneficiaries (transaction_ref, beneficiary_id, split_percentage, created_at)
                VALUES (%s, %s, %s, now())
                """,
                (transaction_ref, beneficiary_id, pct),
            )
    logger.info(f"_resolve_beneficiaries: resolved entity=transactions transaction_id={transaction_id!r} count={len(names)}")


def _resolve_amount(
    conn: Any,
    tx_amount: Decimal,
    local_currency: str,
    tx_date: Any,
    currency_decimal_places: dict[str, int],
) -> tuple[int, int, Any | None]:
    """Compute (tx_amount_local, tx_amount_base, currency_rate_ref)."""
    if local_currency not in currency_decimal_places:
        raise ValueError(f"transactions: currency {local_currency!r} not found in currency_master")

    local_dp = currency_decimal_places[local_currency]
    tx_amount_local = int((tx_amount * Decimal(10) ** local_dp).to_integral_value(ROUND_HALF_UP))

    if tx_amount_local == 0:
        raise ValueError(f"transactions: amount_rounds_to_zero_in_minor_units for currency={local_currency!r}")

    if local_currency == _BASE_CURRENCY:
        return tx_amount_local, tx_amount_local, None

    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, rate_value FROM currency_rates
            WHERE quote_currency_code = %s
              AND rate_date = %s
              AND base_currency_code = 'XAU'
            """,
            (local_currency, tx_date),
        )
        rate_row = cursor.fetchone()

    if rate_row is None:
        raise ValueError(f"transactions: currency_rate_not_found: {local_currency} on {tx_date}")

    rate_id = rate_row[0]
    rate_value = rate_row[1]

    xau_dp = currency_decimal_places[_BASE_CURRENCY]
    if xau_dp != _XAU_DECIMAL_PLACES:
        raise ValueError(f"currency_master.decimal_places for XAU is {xau_dp}, expected {_XAU_DECIMAL_PLACES}")
    if not isinstance(rate_value, Decimal):
        raise TypeError(f"_resolve_currency_rate: expected Decimal from psycopg2, got {type(rate_value).__name__}")

    tx_amount_base = int((Decimal(tx_amount_local) * Decimal(10) ** xau_dp / (rate_value * Decimal(10) ** local_dp)).to_integral_value(ROUND_HALF_UP))

    return tx_amount_local, tx_amount_base, rate_id


def _extract_datetime_fields(tx_date_time_base: Any, tx_timezone_local: str) -> tuple[Any, str, str]:
    """Return (tx_date_time_local, tx_day_of_week_base, tx_day_of_week_local)."""
    tx_date_time_local = tx_date_time_base.astimezone(ZoneInfo(tx_timezone_local)).replace(tzinfo=None)
    tx_day_of_week_base = _DAY_NAMES[tx_date_time_base.weekday()]
    tx_day_of_week_local = _DAY_NAMES[tx_date_time_local.weekday()]
    return tx_date_time_local, tx_day_of_week_base, tx_day_of_week_local


def _to_sync_notes(e: Exception) -> str:
    if isinstance(e, ValueError):
        return str(e).removeprefix("transactions: ")
    if isinstance(e, pg_errors.UniqueViolation):
        return "Duplicate transaction_id — already exists in DB"
    if isinstance(e, pg_errors.ForeignKeyViolation):
        constraint = e.diag.constraint_name
        if constraint == "fk_tm_parent_tx":
            return "parent_tx_id references a transaction that does not exist in DB — sync the parent row first"
        if constraint == "fk_tm_account":
            return "account_id references an account that no longer exists"
        if constraint == "fk_tm_rate_ref":
            return "Currency rate reference no longer exists in currency_rates"
        if constraint == "fk_tm_counterparty":
            return "counterparty_id references a counterparty that no longer exists"
        if constraint == "fk_tm_category":
            return "category_id references a category that no longer exists"
        return f"DB FK violation: {constraint}"
    if isinstance(e, pg_errors.CheckViolation):
        constraint = e.diag.constraint_name
        if constraint == "chk_tm_record_status":
            return "Invalid record_status — must be active, inactive, deleted, or locked"
        if constraint == "chk_tm_tx_amount_local":
            return "tx_amount_local must be > 0 — indicates a code bug; file a bug report"
        if constraint == "chk_tm_tx_amount_base":
            return "tx_amount_base must be > 0 — indicates a code bug; file a bug report"
        if constraint == "chk_tm_base_currency":
            return "base_currency must be XAU — indicates a code bug; file a bug report"
        if constraint == "chk_tm_local_currency":
            return "local_currency must be a 3-character uppercase ISO code — indicates a code bug; file a bug report"
        if constraint == "chk_tm_tx_timezone_base":
            return "tx_timezone_base must be UTC — indicates a code bug; file a bug report"
        if constraint == "chk_tm_rate_ref_required":
            return "currency_rate_ref constraint violated — indicates a code bug in the extract job; file a bug report"
        return f"DB constraint violation: {constraint}"
    if isinstance(e, pg_errors.NotNullViolation):
        return f"Required field is null: {e.diag.column_name} — indicates a code bug; file a bug report"
    raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")


def _do_insert(
    conn: Any,
    typed: dict[str, Any],
    account_surrogate_id: Any,
    local_currency: str,
    tx_amount_local: int,
    tx_amount_base: int,
    currency_rate_ref: Any | None,
    category_id: Any,
    counterparty_id: Any | None,
    tx_date_time_local: Any,
    tx_day_of_week_base: str,
    tx_day_of_week_local: str,
    created_at_override: str | None,
) -> Any:
    """Execute transaction_master INSERT and return the surrogate UUID.

    When created_at_override is None the DB uses now() for created_at.
    When provided (re-insert on update-pending or UNIQUE fallthrough) the override value is bound directly.
    """
    if created_at_override is not None:
        sql = """
            INSERT INTO transaction_master (
                transaction_id, parent_tx_id,
                tx_date_time_base, tx_date_time_local,
                tx_timezone_base, tx_timezone_local,
                tx_day_of_week_base, tx_day_of_week_local,
                category_id, account_id,
                tx_amount_local, tx_amount_base,
                local_currency, base_currency,
                currency_rate_ref,
                tx_description, counterparty_id, tx_tags,
                user_location_area, user_location_city, user_location_country,
                user_location_latitude, user_location_longitude,
                record_status,
                created_at, updated_at
            ) VALUES (
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s,
                %s, now()
            )
            RETURNING id
        """
        params: tuple[Any, ...] = (
            typed["transaction_id"],
            typed["parent_tx_id"],
            typed["tx_date_time_base"],
            tx_date_time_local,
            typed["tx_timezone_base"],
            typed["tx_timezone_local"],
            tx_day_of_week_base,
            tx_day_of_week_local,
            category_id,
            account_surrogate_id,
            tx_amount_local,
            tx_amount_base,
            local_currency,
            _BASE_CURRENCY,
            currency_rate_ref,
            typed["tx_description"],
            counterparty_id,
            typed["tx_tags"],
            typed["user_location_area"],
            typed["user_location_city"],
            typed["user_location_country"],
            typed["user_location_latitude"],
            typed["user_location_longitude"],
            typed["record_status"],
            created_at_override,
        )
    else:
        sql = """
            INSERT INTO transaction_master (
                transaction_id, parent_tx_id,
                tx_date_time_base, tx_date_time_local,
                tx_timezone_base, tx_timezone_local,
                tx_day_of_week_base, tx_day_of_week_local,
                category_id, account_id,
                tx_amount_local, tx_amount_base,
                local_currency, base_currency,
                currency_rate_ref,
                tx_description, counterparty_id, tx_tags,
                user_location_area, user_location_city, user_location_country,
                user_location_latitude, user_location_longitude,
                record_status,
                created_at, updated_at
            ) VALUES (
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s, %s,
                %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s,
                %s,
                now(), now()
            )
            RETURNING id
        """
        params = (
            typed["transaction_id"],
            typed["parent_tx_id"],
            typed["tx_date_time_base"],
            tx_date_time_local,
            typed["tx_timezone_base"],
            typed["tx_timezone_local"],
            tx_day_of_week_base,
            tx_day_of_week_local,
            category_id,
            account_surrogate_id,
            tx_amount_local,
            tx_amount_base,
            local_currency,
            _BASE_CURRENCY,
            currency_rate_ref,
            typed["tx_description"],
            counterparty_id,
            typed["tx_tags"],
            typed["user_location_area"],
            typed["user_location_city"],
            typed["user_location_country"],
            typed["user_location_latitude"],
            typed["user_location_longitude"],
            typed["record_status"],
        )

    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        pk_row = cursor.fetchone()

    if pk_row is None:
        raise RuntimeError(f"INSERT returned no id for transaction_id={typed['transaction_id']!r}")
    return pk_row[0]


def _run_insert_steps(
    conn: Any,
    typed: dict[str, Any],
    transaction_id: str,
    sheet_row_num: int,
    account_surrogate_id: Any,
    local_currency: str,
    currency_decimal_places: dict[str, int],
    write_backs: list[sheets_transactions.WriteBack],
    created_at_override: str | None,
    failed_status: str,
) -> str | None:
    """Execute steps 3–10 of the create path (shared by create-pending and UNIQUE fallthrough).

    Returns 'ok' on success, or writes a failure write_back and returns None.
    On return of None, conn has been rolled back already.
    """
    # Step 3 — validate parent_tx_id
    parent_tx_id = typed["parent_tx_id"]
    if parent_tx_id is not None:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM transaction_master WHERE transaction_id = %s",
                (parent_tx_id,),
            )
            if cursor.fetchone() is None:
                conn.rollback()
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.warning(f"upsert_transactions: parent_tx_not_found entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} parent_tx_id={parent_tx_id!r}")
                write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, failed_status, sync_dt, "parent_tx_not_found"))
                return None

    # Step 4 — resolve amounts
    try:
        tx_amount_local, tx_amount_base, currency_rate_ref = _resolve_amount(
            conn,
            typed["tx_amount"],
            local_currency,
            typed["tx_date_time_base"].date(),
            currency_decimal_places,
        )
    except ValueError as e:
        conn.rollback()
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(f"upsert_transactions: amount_error entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
        return None

    logger.info(
        f"_run_insert_steps: amount_resolved entity=transactions transaction_id={transaction_id!r}"
        f" local_currency={local_currency} tx_amount_local={tx_amount_local} tx_amount_base={tx_amount_base} rate_ref={currency_rate_ref}"
    )

    # Step 5 — resolve counterparty
    counterparty_id = _resolve_counterparty(conn, typed["counterparty_name"], transaction_id)

    # Step 6 — resolve category
    category_id = _lookup_category(conn, typed["tx_type"], typed["major_category"], typed["minor_category"])
    if category_id is None:
        conn.rollback()
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(
            f"upsert_transactions: category_not_found entity=transactions"
            f" row={sheet_row_num} transaction_id={transaction_id!r}"
            f" tx_type={typed['tx_type']!r} major={typed['major_category']!r} minor={typed['minor_category']!r}"
        )
        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, failed_status, sync_dt, "category_not_found"))
        return None

    logger.info(f"_run_insert_steps: category_resolved entity=transactions transaction_id={transaction_id!r} category_id={category_id}")

    tx_date_time_local, tx_day_of_week_base, tx_day_of_week_local = _extract_datetime_fields(typed["tx_date_time_base"], typed["tx_timezone_local"])

    # Step 7 — INSERT transaction_master
    surrogate_id = _do_insert(
        conn=conn,
        typed=typed,
        account_surrogate_id=account_surrogate_id,
        local_currency=local_currency,
        tx_amount_local=tx_amount_local,
        tx_amount_base=tx_amount_base,
        currency_rate_ref=currency_rate_ref,
        category_id=category_id,
        counterparty_id=counterparty_id,
        tx_date_time_local=tx_date_time_local,
        tx_day_of_week_base=tx_day_of_week_base,
        tx_day_of_week_local=tx_day_of_week_local,
        created_at_override=created_at_override,
    )
    logger.info(f"_run_insert_steps: tx_inserted entity=transactions transaction_id={transaction_id!r} id={surrogate_id}")

    # Step 8 — resolve beneficiaries
    try:
        _resolve_beneficiaries(conn, typed["beneficiaries_raw"], surrogate_id, transaction_id)
    except ValueError as e:
        conn.rollback()
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.warning(f"upsert_transactions: beneficiary_error entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
        return None

    return "ok"


def upsert_transactions(
    conn: Any,
    sheets_client: SheetsClient,
    rows: list[dict[str, Any]],
    account_map: dict[str, tuple[Any, str]],
) -> None:
    """Process all transaction rows and write sync results back to the sheet."""
    in_sync_count = sum(1 for row in rows if row.get("sync_status") == "in-sync")
    actionable_count = sum(1 for row in rows if row.get("sync_status") in _ACTIONABLE)
    logger.info(f"upsert_transactions: start entity=transactions total={len(rows)} in_sync={in_sync_count} actionable={actionable_count}")

    currency_decimal_places = _load_decimal_places(conn)

    write_backs: list[sheets_transactions.WriteBack] = []
    inserted = 0
    updated = 0
    failed = 0

    try:
        for row_index, row in enumerate(rows):
            sheet_row_num = row_index + 2  # row 1 is the header

            raw_id = row.get("id")
            if raw_id is None or str(raw_id).strip() == "":
                logger.warning(f"upsert_transactions: blank_id entity=transactions row={sheet_row_num} — skipping")
                continue

            raw_sync_status = row.get("sync_status")
            if raw_sync_status is None or str(raw_sync_status).strip() == "":
                logger.warning(f"upsert_transactions: missing_sync_status entity=transactions row={sheet_row_num} — skipping")
                continue
            sync_status = str(raw_sync_status).strip()

            if sync_status in ("in-sync", "sync-failure"):
                continue
            if sync_status not in _VALID_SYNC_STATUSES:
                logger.warning(f"upsert_transactions: unknown_sync_status entity=transactions row={sheet_row_num} sync_status={sync_status!r} — skipping")
                continue

            transaction_id = str(raw_id).strip()
            failed_status = "create-failed" if sync_status in ("create-pending", "create-failed") else "update-failed"

            try:
                typed = transactions_transform.transform(row)
            except ValueError as e:
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.warning(f"upsert_transactions: transform_error entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
                write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, failed_status, sync_dt, _to_sync_notes(e)))
                failed += 1
                continue

            account_id_natural_key = typed["account_id_natural_key"]
            if account_id_natural_key not in account_map:
                sync_dt = datetime.now(timezone.utc).isoformat()
                logger.warning(f"upsert_transactions: account_not_found entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} account_id={account_id_natural_key!r}")
                write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "sync-failure", sync_dt, "account_not_found"))
                failed += 1
                continue

            account_surrogate_id, local_currency = account_map[account_id_natural_key]

            if sync_status in ("create-pending", "create-failed"):
                try:
                    with conn.cursor() as cursor:
                        cursor.execute("SAVEPOINT before_tx_insert")

                    try:
                        step_outcome = _run_insert_steps(
                            conn=conn,
                            typed=typed,
                            transaction_id=transaction_id,
                            sheet_row_num=sheet_row_num,
                            account_surrogate_id=account_surrogate_id,
                            local_currency=local_currency,
                            currency_decimal_places=currency_decimal_places,
                            write_backs=write_backs,
                            created_at_override=None,
                            failed_status="create-failed",
                        )
                    except pg_errors.UniqueViolation:
                        with conn.cursor() as cursor:
                            cursor.execute("ROLLBACK TO SAVEPOINT before_tx_insert")
                        logger.info(f"upsert_transactions: unique_fallthrough entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} — re-inserting via update path")
                        step_outcome = _run_fallthrough_update(
                            conn=conn,
                            typed=typed,
                            transaction_id=transaction_id,
                            sheet_row_num=sheet_row_num,
                            account_surrogate_id=account_surrogate_id,
                            local_currency=local_currency,
                            currency_decimal_places=currency_decimal_places,
                            write_backs=write_backs,
                        )
                        if step_outcome is not None:
                            inserted += 1
                        else:
                            failed += 1
                        continue

                    if step_outcome is None:
                        failed += 1
                        continue

                    conn.commit()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    write_backs.append(sheets_transactions.write_back_success(sheet_row_num, "in-sync", sync_dt, "", sync_dt, sync_dt))
                    inserted += 1
                    logger.info(f"upsert_transactions: inserted entity=transactions transaction_id={transaction_id!r}")

                except (
                    pg_errors.ForeignKeyViolation,
                    pg_errors.CheckViolation,
                    pg_errors.NotNullViolation,
                ) as e:
                    conn.rollback()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    logger.error(f"upsert_transactions: create_failed entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
                    write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "create-failed", sync_dt, _to_sync_notes(e)))
                    failed += 1
                except Exception:
                    conn.rollback()
                    raise

            elif sync_status in ("update-pending", "update-failed"):
                try:
                    with conn.cursor() as cursor:
                        cursor.execute(
                            "SELECT id, record_status, created_at FROM transaction_master WHERE transaction_id = %s",
                            (transaction_id,),
                        )
                        existing = cursor.fetchone()

                    if existing is None:
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        logger.warning(f"upsert_transactions: transaction_not_found entity=transactions row={sheet_row_num} transaction_id={transaction_id!r}")
                        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "sync-failure", sync_dt, "transaction_not_found"))
                        failed += 1
                        continue

                    existing_surrogate_id, existing_record_status, existing_created_at = existing

                    if existing_record_status == "locked":
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        logger.warning(f"upsert_transactions: transaction_locked entity=transactions row={sheet_row_num} transaction_id={transaction_id!r}")
                        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "sync-failure", sync_dt, "transaction_locked"))
                        failed += 1
                        continue

                    if existing_record_status == "deleted":
                        sync_dt = datetime.now(timezone.utc).isoformat()
                        logger.warning(f"upsert_transactions: transaction_deleted entity=transactions row={sheet_row_num} transaction_id={transaction_id!r}")
                        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "sync-failure", sync_dt, "transaction_deleted"))
                        failed += 1
                        continue

                    created_at_override = existing_created_at.isoformat() if hasattr(existing_created_at, "isoformat") else str(existing_created_at)

                    # Step 2 — delete beneficiary junction rows
                    with conn.cursor() as cursor:
                        cursor.execute(
                            "DELETE FROM transaction_beneficiaries WHERE transaction_ref = %s",
                            (existing_surrogate_id,),
                        )

                    # Step 3 — delete the transaction row
                    with conn.cursor() as cursor:
                        cursor.execute(
                            "DELETE FROM transaction_master WHERE transaction_id = %s",
                            (transaction_id,),
                        )

                    # Step 4 — re-insert via the shared insert steps
                    step_outcome = _run_insert_steps(
                        conn=conn,
                        typed=typed,
                        transaction_id=transaction_id,
                        sheet_row_num=sheet_row_num,
                        account_surrogate_id=account_surrogate_id,
                        local_currency=local_currency,
                        currency_decimal_places=currency_decimal_places,
                        write_backs=write_backs,
                        created_at_override=created_at_override,
                        failed_status="update-failed",
                    )

                    if step_outcome is None:
                        failed += 1
                        continue

                    conn.commit()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    write_backs.append(sheets_transactions.write_back_success(sheet_row_num, "in-sync", sync_dt, "", created_at_override, sync_dt))
                    updated += 1
                    logger.info(f"upsert_transactions: updated entity=transactions transaction_id={transaction_id!r}")

                except ValueError as e:
                    conn.rollback()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    logger.warning(f"upsert_transactions: update_failed entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
                    write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "update-failed", sync_dt, _to_sync_notes(e)))
                    failed += 1
                except (
                    pg_errors.ForeignKeyViolation,
                    pg_errors.CheckViolation,
                    pg_errors.NotNullViolation,
                    pg_errors.UniqueViolation,
                ) as e:
                    conn.rollback()
                    sync_dt = datetime.now(timezone.utc).isoformat()
                    logger.error(f"upsert_transactions: update_failed entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
                    write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "update-failed", sync_dt, _to_sync_notes(e)))
                    failed += 1
                except Exception:
                    conn.rollback()
                    raise

    finally:
        logger.info(f"upsert_transactions: done entity=transactions inserted={inserted} updated={updated} failed={failed}")
        sheets_transactions.flush(sheets_client, _SHEET_NAME, write_backs)

    # Post-row soft-delete pass — counterparty_master
    with conn.cursor() as cursor:
        cursor.execute(
            """
            UPDATE counterparty_master SET record_status = 'deleted', updated_at = now()
            WHERE id NOT IN (
                SELECT DISTINCT counterparty_id FROM transaction_master
                WHERE record_status = 'active' AND counterparty_id IS NOT NULL
            )
            AND record_status = 'active'
            """
        )
        counterparty_deleted = cursor.rowcount
    conn.commit()
    logger.info(f"upsert_transactions: counterparty_soft_delete entity=transactions deleted={counterparty_deleted}")

    # Post-row soft-delete pass — beneficiaries_master
    with conn.cursor() as cursor:
        cursor.execute(
            """
            UPDATE beneficiaries_master SET record_status = 'deleted', updated_at = now()
            WHERE id NOT IN (
                SELECT DISTINCT tb.beneficiary_id
                FROM transaction_beneficiaries tb
                JOIN transaction_master tm ON tm.id = tb.transaction_ref
                WHERE tm.record_status = 'active'
            )
            AND record_status = 'active'
            """
        )
        beneficiary_deleted = cursor.rowcount
    conn.commit()
    logger.info(f"upsert_transactions: beneficiary_soft_delete entity=transactions deleted={beneficiary_deleted}")


def _run_fallthrough_update(
    conn: Any,
    typed: dict[str, Any],
    transaction_id: str,
    sheet_row_num: int,
    account_surrogate_id: Any,
    local_currency: str,
    currency_decimal_places: dict[str, int],
    write_backs: list[sheets_transactions.WriteBack],
) -> str | None:
    """Handle the UNIQUE fallthrough: fetch existing created_at, delete, then re-insert.

    Returns 'ok' on success, None on controlled failure (write_back already appended).
    Raises on unexpected exceptions after rollback.
    """
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, created_at FROM transaction_master WHERE transaction_id = %s",
                (transaction_id,),
            )
            existing = cursor.fetchone()

        if existing is None:
            raise RuntimeError(f"UNIQUE fallthrough: expected existing row for transaction_id={transaction_id!r} but found none")

        existing_surrogate_id, existing_created_at = existing
        created_at_override = existing_created_at.isoformat() if hasattr(existing_created_at, "isoformat") else str(existing_created_at)

        with conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM transaction_beneficiaries WHERE transaction_ref = %s",
                (existing_surrogate_id,),
            )

        with conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM transaction_master WHERE transaction_id = %s",
                (transaction_id,),
            )

        step_outcome = _run_insert_steps(
            conn=conn,
            typed=typed,
            transaction_id=transaction_id,
            sheet_row_num=sheet_row_num,
            account_surrogate_id=account_surrogate_id,
            local_currency=local_currency,
            currency_decimal_places=currency_decimal_places,
            write_backs=write_backs,
            created_at_override=created_at_override,
            failed_status="create-failed",
        )

        if step_outcome is None:
            return None

        conn.commit()
        sync_dt = datetime.now(timezone.utc).isoformat()
        write_backs.append(sheets_transactions.write_back_success(sheet_row_num, "in-sync", sync_dt, "", created_at_override, sync_dt))
        logger.info(f"upsert_transactions: fallthrough_inserted entity=transactions transaction_id={transaction_id!r}")
        return "ok"

    except (
        pg_errors.ForeignKeyViolation,
        pg_errors.CheckViolation,
        pg_errors.NotNullViolation,
        pg_errors.UniqueViolation,
    ) as e:
        conn.rollback()
        sync_dt = datetime.now(timezone.utc).isoformat()
        logger.error(f"upsert_transactions: fallthrough_failed entity=transactions row={sheet_row_num} transaction_id={transaction_id!r} error={e}")
        write_backs.append(sheets_transactions.write_back_failure(sheet_row_num, "create-failed", sync_dt, _to_sync_notes(e)))
        return None
    except Exception:
        conn.rollback()
        raise
