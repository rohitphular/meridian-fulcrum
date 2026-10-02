from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timezone
from decimal import Decimal, localcontext
from typing import Any

import psycopg2.errors as pg_errors
from py_google_workspace.gsheets import SheetsClient
from py_logging import get_logger

import sheets.accounts as sheets_accounts
import transforms.accounts as accounts_transform
from database.account_details import validate_account_change
from database.progress import Progress
from transforms.financial import to_minor_units

logger = get_logger(__name__)

_SHEET_NAME = "account_master"
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}
_BASE_CURRENCY = "XAU"
_XAU_DECIMAL_PLACES = 9
_IMMUTABLE_FIELDS = ("legal_entity_name", "account_type", "local_timezone", "opening_date_local", "tracking_start_date_local", "opening_amount_local_value", "local_currency")


def _load_decimal_places(conn: Any) -> dict[str, int]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT currency_code, decimal_places FROM currency_master ORDER BY currency_code FOR SHARE")
        return {row[0].strip(): row[1] for row in cursor.fetchall()}


def _lookup_rate(conn: Any, local_currency: str, base_currency: str, snapshot_date: date) -> tuple[Any, Decimal] | None:
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, rate_value FROM currency_rates
            WHERE quote_currency_code = %s AND base_currency_code = %s AND rate_date <= %s
            ORDER BY rate_date DESC LIMIT 1 FOR SHARE
            """,
            (local_currency, base_currency, snapshot_date),
        )
        rate_row = cursor.fetchone()
    if rate_row is None:
        return None
    if not isinstance(rate_row[1], Decimal):
        raise TypeError("_lookup_rate: database rate_value must be Decimal")
    if not rate_row[1].is_finite() or rate_row[1] <= 0:
        raise ValueError("accounts: currency rate must be positive and finite")
    return rate_row[0], rate_row[1]


def _to_sync_notes(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return str(exc).removeprefix("accounts: ")
    if isinstance(exc, pg_errors.UniqueViolation):
        return "Duplicate account ID in database"
    if isinstance(exc, pg_errors.ForeignKeyViolation):
        return "Invalid account type/subtype or currency rate reference"
    if isinstance(exc, pg_errors.CheckViolation):
        return f"Database constraint failed: {exc.diag.constraint_name}"
    if isinstance(exc, pg_errors.NotNullViolation):
        return f"Required database field is null: {exc.diag.column_name}"
    raise TypeError(f"_to_sync_notes: unhandled exception type {type(exc).__name__}")


def _compute_minor_units(
    opening_amount_local_value: Decimal,
    local_currency: str,
    local_decimal_places: int,
    rate_lookup: tuple[Any, Decimal] | None,
) -> tuple[int, int, Any]:
    if local_currency == _BASE_CURRENCY and local_decimal_places != _XAU_DECIMAL_PLACES:
        raise ValueError(f"accounts: currency_master.decimal_places for XAU must be {_XAU_DECIMAL_PLACES}")
    local_minor = to_minor_units(opening_amount_local_value, local_decimal_places, "opening_value_local")
    if local_currency == _BASE_CURRENCY:
        return local_minor, local_minor, None
    if opening_amount_local_value == 0:
        return 0, 0, None
    if rate_lookup is None:
        raise ValueError("accounts: a currency rate is required for a nonzero foreign opening balance")
    currency_rate_id, rate_value = rate_lookup
    if not rate_value.is_finite() or rate_value <= 0:
        raise ValueError("accounts: currency rate must be positive and finite")
    # Convert the stored local amount, so local and base values represent the same money.
    with localcontext() as context:
        context.prec = 80
        local_major = Decimal(local_minor).scaleb(-local_decimal_places)
        base_minor = to_minor_units(local_major / rate_value, _XAU_DECIMAL_PLACES, "opening_amount_base_value")
    return local_minor, base_minor, currency_rate_id


def _store_account(conn: Any, typed: dict[str, Any], decimal_places: dict[str, int]) -> None:
    currency = typed["local_currency"]
    if currency not in decimal_places:
        raise ValueError(f"accounts: currency {currency} missing from currency_master")
    places = decimal_places[currency]
    if currency == _BASE_CURRENCY and places != _XAU_DECIMAL_PLACES:
        raise ValueError("accounts: currency_master.decimal_places for XAU must be 9")
    local_minor = to_minor_units(typed["opening_amount_local_value"], places, "opening_value_local")
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM account_types WHERE account_type_key = %s AND account_subtype_key = %s AND is_sheet_managed AND sync_status='in-sync' AND record_status IN ('active','locked') FOR SHARE",
            (typed["account_type"], typed["account_subtype"]),
        )
        if cursor.fetchone() is None:
            raise ValueError("accounts: unknown, inactive, or unsynced type/sub_type; sync account_types first")
        cursor.execute(
            """SELECT legal_entity_name, account_type, local_timezone, opening_date_local,
                      tracking_start_date_local, opening_amount_local_value, local_currency
               FROM account_master WHERE id = %s FOR UPDATE""",
            (typed["id"],),
        )
        existing = cursor.fetchone()
        if existing is not None:
            proposed = {**typed, "opening_amount_local_value": local_minor}
            changed = []
            for field, value in zip(_IMMUTABLE_FIELDS, existing, strict=True):
                incoming = proposed[field]
                # The new migration cannot reconstruct tracking dates from old rows.
                # Populate an absent value once from the authoritative source snapshot.
                if field == "tracking_start_date_local" and value is None:
                    continue
                if field in {"opening_date_local", "tracking_start_date_local"} and value is not None and incoming is not None:
                    value = datetime.fromisoformat(value)
                    incoming = datetime.fromisoformat(incoming)
                if value != incoming:
                    changed.append(field)
            if changed:
                raise ValueError(f"accounts: immutable fields differ from database: {', '.join(changed)}; reconcile explicitly before retrying")
    rate_lookup = None
    if currency != _BASE_CURRENCY and typed["opening_amount_local_value"] != 0:
        snapshot_value = typed["tracking_start_date_local"] or typed["opening_date_local"]
        if snapshot_value is None:
            raise ValueError("accounts: set tracking_start_date_local (or legacy account_opening_date_local) to date the nonzero opening balance")
        snapshot_date = datetime.fromisoformat(snapshot_value).date()
        rate_lookup = _lookup_rate(conn, currency, _BASE_CURRENCY, snapshot_date)
        if rate_lookup is None:
            raise ValueError(f"accounts: no {currency}/XAU rate on or before {snapshot_date}; load historical currency rates first")
    local_minor, base_minor, rate_id = _compute_minor_units(typed["opening_amount_local_value"], currency, places, rate_lookup)
    applied_rate_value = Decimal(1) if currency == _BASE_CURRENCY else (rate_lookup[1] if rate_lookup is not None else None)
    with conn.cursor() as cursor:
        if existing is not None:
            validate_account_change(conn, typed["id"], typed["account_subtype"])
            cursor.execute(
                """UPDATE account_master SET account_name = %s, account_subtype = %s,
                   closing_date_local = %s, account_description = %s, record_status = %s,
                   tracking_start_date_local = %s, opening_amount_base_value = %s,
                   currency_rate_id = %s, applied_rate_value = %s, base_currency = %s,
                   updated_at = now() WHERE id = %s""",
                (
                    typed["account_name"],
                    typed["account_subtype"],
                    typed["closing_date_local"],
                    typed["account_description"],
                    typed["record_status"],
                    typed["tracking_start_date_local"],
                    base_minor,
                    rate_id,
                    applied_rate_value,
                    _BASE_CURRENCY,
                    typed["id"],
                ),
            )
            return
        cursor.execute(
            """INSERT INTO account_master (
                 id, account_name, legal_entity_name, account_type, account_subtype, local_timezone,
                 opening_date_local, closing_date_local, tracking_start_date_local,
                 opening_amount_local_value, opening_amount_base_value, local_currency,
                 base_currency, currency_rate_id, applied_rate_value, account_description, record_status, created_at, updated_at
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
               ON CONFLICT (id) DO NOTHING RETURNING id""",
            (
                typed["id"],
                typed["account_name"],
                typed["legal_entity_name"],
                typed["account_type"],
                typed["account_subtype"],
                typed["local_timezone"],
                typed["opening_date_local"],
                typed["closing_date_local"],
                typed["tracking_start_date_local"],
                local_minor,
                base_minor,
                currency,
                _BASE_CURRENCY,
                rate_id,
                applied_rate_value,
                typed["account_description"],
                typed["record_status"],
            ),
        )
        if cursor.fetchone() is None:
            raise ValueError("accounts: account was inserted concurrently; retry after reconciling its immutable fields")


def upsert_accounts(conn: Any, sheets_client: SheetsClient, rows: list[dict[str, Any]], row_start: int, *, before_commit: Callable[[], None] | None = None) -> int:
    """Persist each row atomically; return failure count so the job cannot claim success."""
    write_backs: list[sheets_accounts.WriteBack] = []
    succeeded = failed = 0
    progress = Progress(logger, "upsert_accounts", len(rows))
    try:
        for row_index, row in enumerate(rows):
            sheet_row_num = row.get("_sheet_row_num", row_start + row_index + 1)
            sync_status = str(row.get("sync_status") or "").strip()
            if sync_status == "in-sync":
                progress.skip()
                continue
            if sync_status not in _ACTIONABLE:
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_accounts: invalid_sync_status row={sheet_row_num}")
                continue
            failed_status = "create-failed" if sync_status.startswith("create-") else "update-failed"
            checking_source = False
            try:
                typed = accounts_transform.transform(row)
                # Each prior row commits and releases reference locks. Reload
                # precision under a fresh lock for this row's valuation.
                decimal_places = _load_decimal_places(conn)
                _store_account(conn, typed, decimal_places)
                if before_commit is not None:
                    checking_source = True
                    before_commit()
                    checking_source = False
                conn.commit()
            except (ValueError, pg_errors.UniqueViolation, pg_errors.ForeignKeyViolation, pg_errors.CheckViolation, pg_errors.NotNullViolation) as exc:
                conn.rollback()
                # Snapshot/header failures invalidate the run, not this account.
                # Preserve their exception and never queue a stale acknowledgement.
                if checking_source:
                    raise
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_accounts: row_failed row={sheet_row_num} error_type={type(exc).__name__}")
                write_backs.append(sheets_accounts.write_back(sheet_row_num, failed_status, datetime.now(timezone.utc).isoformat(), _to_sync_notes(exc)))
            except Exception:
                conn.rollback()
                raise
            else:
                succeeded += 1
                progress.record(succeeded=1)
                write_backs.append(sheets_accounts.write_back(sheet_row_num, "in-sync", datetime.now(timezone.utc).isoformat(), ""))
    finally:
        sheets_accounts.flush(sheets_client, _SHEET_NAME, write_backs)
        progress.done()
    return failed
