"""Atomic source-UUID replication into matching account-extension database tables."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from typing import Any

import psycopg2

import sheets.account_details as sheets_details
from core.account_detail_contracts import CONTRACTS
from transforms.account_details import transform
from transforms.financial import to_minor_units


class _RowError(ValueError):
    """Safe error codes without financial values or raw source text."""


def _account(conn: Any, account_id: str) -> tuple[str, str | None]:
    with conn.cursor() as cursor:
        # Keep ownership/subtype validation true through the tab commit. The
        # master writer takes FOR UPDATE before checking retained detail rows.
        cursor.execute(
            """SELECT a.local_currency,t.detail_sheet FROM account_master a JOIN account_types t
               ON (a.account_type,a.account_subtype)=(t.account_type_key,t.account_subtype_key)
               WHERE a.id=%s AND t.is_sheet_managed AND t.sync_status='in-sync' AND t.record_status IN ('active','locked') FOR SHARE OF a,t""",
            (account_id,),
        )
        account = cursor.fetchone()
    if account is None:
        raise _RowError("account_missing_or_account_type_configuration_requires_sync")
    return account[0].strip(), account[1]


def _valuation_rate(conn: Any, currency: str, source: dict[str, Any]) -> tuple[Any, Decimal] | None:
    reference = source.get("evaluation_currency_rate_id")
    raw_date = source.get("current_value_evaluation_date") or source.get("price_asof_date")
    valuation_date = datetime.fromisoformat(raw_date).date() if raw_date is not None else None
    rate = None
    with conn.cursor() as cursor:
        if reference is not None:
            cursor.execute("SELECT id, quote_currency_code, base_currency_code, rate_value, rate_date FROM currency_rates WHERE id=%s FOR SHARE", (reference,))
            rate = cursor.fetchone()
            if rate is None:
                raise _RowError("evaluation_rate_not_found")
            if rate[1].strip() != currency or rate[2].strip() != "XAU":
                raise _RowError("evaluation_rate_currency_mismatch")
            if valuation_date is not None and rate[4] > valuation_date:
                raise _RowError("evaluation_rate_after_valuation_date")
        elif valuation_date is not None and currency != "XAU":
            cursor.execute(
                """SELECT id, quote_currency_code, base_currency_code, rate_value, rate_date FROM currency_rates
                   WHERE quote_currency_code=%s AND base_currency_code='XAU' AND rate_date<=%s ORDER BY rate_date DESC LIMIT 1 FOR SHARE""",
                (currency, valuation_date),
            )
            rate = cursor.fetchone()
            if rate is None:
                raise _RowError("valuation_rate_not_found")
    if rate is not None and (not isinstance(rate[3], Decimal) or not rate[3].is_finite() or rate[3] <= 0):
        raise _RowError("invalid_valuation_rate")
    if currency == "XAU":
        return None, Decimal(1)
    return None if rate is None else (rate[0], rate[3])


def _prepare(conn: Any, sheet_name: str, row: dict[str, Any]) -> tuple[dict[str, Any], int]:
    spec = CONTRACTS[sheet_name]
    result = transform(sheet_name, row)
    account_currency, configured_sheet = _account(conn, result["account_master_id"])
    if configured_sheet != sheet_name:
        raise _RowError("account_detail_policy_mismatch")
    currency = result.get("instrument_currency_local") or account_currency
    with conn.cursor() as cursor:
        cursor.execute("SELECT decimal_places FROM currency_master WHERE currency_code=%s FOR SHARE", (currency,))
        metadata = cursor.fetchone()
    if metadata is None:
        raise _RowError("currency_not_found")
    decimal_places = metadata[0]
    if currency == "XAU" and decimal_places != 9:
        raise _RowError("invalid_xau_precision")
    linked_property = result.get("linked_property_account_id")
    if linked_property is not None and _account(conn, linked_property)[1] != "account_investment_property":
        raise _RowError("linked_account_not_property")
    result.update(source_sheet=sheet_name, local_currency=currency, base_currency="XAU")
    for field, target in spec.money_fields.items():
        amount = result.get(target)
        local_minor = None if amount is None else to_minor_units(amount, decimal_places, "account_detail_amount")
        if field in spec.positive_fields and local_minor is not None and local_minor <= 0:
            raise _RowError("positive_amount_rounds_to_zero")
        result[target] = local_minor
    return result, decimal_places


def _apply_valuation(conn: Any, sheet_name: str, result: dict[str, Any], decimal_places: int) -> None:
    currency = result["local_currency"]
    valuation = _valuation_rate(conn, currency, result)
    result["currency_rate_id"] = valuation[0] if valuation is not None else None
    result["applied_rate_value"] = valuation[1] if valuation is not None else None
    for target in CONTRACTS[sheet_name].money_fields.values():
        local_minor = result[target]
        base_target = target.removesuffix("_local_value") + "_base_value"
        base_minor = None
        if local_minor is not None:
            if currency == "XAU":
                base_minor = local_minor
            elif target == "current_value_local_value" and valuation is not None:
                with localcontext() as context:
                    context.prec = 80
                    major = Decimal(local_minor).scaleb(-decimal_places)
                    base_minor = to_minor_units(major / valuation[1], 9, "account_detail_base_amount")
        result[base_target] = base_minor


def sync_details(
    conn: Any,
    sheet_name: str,
    rows: list[dict[str, Any]],
    *,
    reprocess: bool = False,
    before_commit: Callable[[], None] | None = None,
) -> dict[str, int]:
    """Commit one complete tab, preserving IDs and source-only optional values.

    Absent source rows are retained. No Sheet cells or legacy SCD rows are changed.
    """
    if sheet_name not in CONTRACTS:
        raise ValueError("unknown_account_detail_sheet")
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    physical_row = 0
    checking_source = False
    try:
        prepared = []
        identities = set()
        for index, row in enumerate(rows):
            physical_row = int(row.get("_sheet_row_num", index + 2))
            values, decimal_places = _prepare(conn, sheet_name, row)
            if values["id"] in identities:
                raise _RowError("duplicate_source_id")
            identities.add(values["id"])
            prepared.append((physical_row, values, decimal_places))
        table = CONTRACTS[sheet_name].target_table
        for physical_row, values, decimal_places in prepared:
            columns = list(values)
            with conn.cursor() as cursor:
                cursor.execute(f"SELECT {', '.join(columns)} FROM {table} WHERE id=%s FOR UPDATE", (values["id"],))
                stored = cursor.fetchone()
                if stored is not None:
                    current = dict(zip(columns, stored, strict=True))
                    for field in CONTRACTS[sheet_name].uuid_fields:
                        column = CONTRACTS[sheet_name].field_map[field]
                        if current[column] is not None:
                            current[column] = str(current[column])
                    if current["source_sheet"] is None:
                        raise _RowError("legacy_id_collision")
                    if current["source_sheet"] != sheet_name:
                        raise _RowError("cross_sheet_id_collision")
                    if str(current["account_master_id"]) != str(values["account_master_id"]):
                        raise _RowError("detail_account_move_rejected")
                    if not reprocess and current == values:
                        counts["unchanged"] += 1
                        continue
                    _apply_valuation(conn, sheet_name, values, decimal_places)
                    columns = list(values)
                    mutable = [column for column in columns if column != "id"]
                    cursor.execute(
                        f"UPDATE {table} SET {', '.join(f'{column}=%s' for column in mutable)}, updated_at=now() WHERE id=%s",
                        tuple(values[column] for column in mutable) + (values["id"],),
                    )
                    counts["updated"] += 1
                else:
                    _apply_valuation(conn, sheet_name, values, decimal_places)
                    columns = list(values)
                    cursor.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})", tuple(values.values()))
                    counts["created"] += 1
        if before_commit is not None:
            checking_source = True
            before_commit()
            checking_source = False
        conn.commit()
        return counts
    except (_RowError, ValueError, psycopg2.IntegrityError, psycopg2.DataError) as error:
        conn.rollback()
        # A source/header/dependency check invalidates this snapshot; it is not
        # a row validation failure and must never queue stale acknowledgements.
        if checking_source:
            raise
        code = str(error) if isinstance(error, _RowError) else "invalid_source_value_or_constraint"
        raise ValueError(f"account_detail_error:{sheet_name}:row={physical_row}:{code}") from error
    except Exception:
        conn.rollback()
        raise


def validate_type_detail_policy(conn: Any, group: str, subtype: str, detail_sheet: str | None) -> None:
    """Prevent configuration changes from orphaning existing extension/property links."""
    with conn.cursor() as cursor:
        for table in CONTRACTS:
            if table == detail_sheet:
                continue
            cursor.execute(
                f"""SELECT 1 FROM {table} d JOIN account_master a ON a.id=d.account_master_id
                    WHERE a.account_type=%s AND a.account_subtype=%s LIMIT 1""",
                (group, subtype),
            )
            if cursor.fetchone() is not None:
                raise ValueError("account_types: detail_policy_conflicts_with_existing_details")
        if detail_sheet != "account_investment_property":
            for table in ("account_liability_mortgage", "account_liability_personal_loan"):
                cursor.execute(
                    f"""SELECT 1 FROM {table} d JOIN account_master a ON a.id=d.linked_property_account_id
                        WHERE a.account_type=%s AND a.account_subtype=%s LIMIT 1""",
                    (group, subtype),
                )
                if cursor.fetchone() is not None:
                    raise ValueError("account_types: detail_policy_conflicts_with_linked_property")


def validate_account_change(conn: Any, account_id: str, new_subtype: str) -> None:
    """Retained extension records must fit the target subtype's source policy."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT detail_sheet FROM account_types WHERE account_subtype_key=%s AND is_sheet_managed AND sync_status='in-sync' FOR SHARE", (new_subtype,))
        configured = cursor.fetchone()
        if configured is None:
            raise ValueError("accounts: account_type_configuration_requires_sync")
        detail_sheet = configured[0]
        for table in CONTRACTS:
            cursor.execute(f"SELECT DISTINCT source_sheet FROM {table} WHERE account_master_id=%s", (account_id,))
            for (source_sheet,) in cursor.fetchall():
                if source_sheet is not None and source_sheet != table:
                    raise ValueError("accounts: unknown_account_detail_source_requires_reconciliation")
                if detail_sheet != table:
                    raise ValueError("accounts: subtype_conflicts_with_account_details")
        if detail_sheet != "account_investment_property":
            for table in ("account_liability_mortgage", "account_liability_personal_loan"):
                cursor.execute(f"SELECT 1 FROM {table} WHERE linked_property_account_id=%s LIMIT 1", (account_id,))
                if cursor.fetchone() is not None:
                    raise ValueError("accounts: subtype_conflicts_with_linked_property")


def upsert_details(
    conn: Any,
    sheets_client: Any,
    sheet_name: str,
    rows: list[dict[str, Any]],
    *,
    reprocess: bool = False,
    before_commit: Callable[[], None] | None = None,
) -> int:
    """Apply one metadata-managed tab atomically, acknowledging only committed rows."""
    if sheet_name not in CONTRACTS:
        raise ValueError("unknown_account_detail_sheet")
    actionable = {"create-pending", "create-failed", "update-pending", "update-failed"}
    selected = []
    for index, row in enumerate(rows):
        status = str(row.get("sync_status") or "").strip()
        if status == "in-sync":
            continue
        if status not in actionable:
            raise ValueError("invalid_account_detail_sync_status")
        selected.append({**row, "_sheet_row_num": int(row.get("_sheet_row_num", index + 2))})
    if not selected:
        return 0
    try:
        sync_details(conn, sheet_name, selected, reprocess=reprocess, before_commit=before_commit)
    except ValueError as error:
        # sync_details exposes only validated codes and physical row numbers.
        failure = re.fullmatch(rf"account_detail_error:{re.escape(sheet_name)}:row=(\d+):([a-z_]+)", str(error))
        if failure is None:
            raise
        culprit_row, code = int(failure[1]), failure[2]
        sync_date = datetime.now(timezone.utc).isoformat()
        acknowledgements = []
        for row in selected:
            status = "update-failed" if str(row["sync_status"]).strip().startswith("update-") else "create-failed"
            notes = code if row["_sheet_row_num"] == culprit_row else "detail_tab_rolled_back"
            acknowledgements.append((row["_sheet_row_num"], status, sync_date, notes))
        sheets_details.flush(sheets_client, sheet_name, acknowledgements)
        return len(selected)
    sync_date = datetime.now(timezone.utc).isoformat()
    sheets_details.flush(sheets_client, sheet_name, [(row["_sheet_row_num"], "in-sync", sync_date, "") for row in selected])
    return 0
