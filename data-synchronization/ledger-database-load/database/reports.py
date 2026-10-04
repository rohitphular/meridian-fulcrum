"""Load report_master rows (report configuration) into PostgreSQL, one commit per row.

Pending and failed rows are validated against the report contract (transforms/reports.py)
with references to accounts, categories and currencies from PostgreSQL, then upserted by
source UUID. Each row's outcome (in-sync, or create-/update-failed with "code:column" in
sync_notes) goes to staging for the acknowledge step. Nothing is computed here: the
analytics job reads this table.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import psycopg2.errors as pg_errors
from py_logging import get_logger

import outcomes.reports as outcomes_reports
import transforms.reports as reports_transform
from database.progress import Progress

logger = get_logger(__name__)

_SHEET_NAME = "report_master"
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}
_LIST_COLUMNS = ("filter_account_ids", "filter_categories", "filter_tags", "filter_payees", "filter_currencies", "filter_countries", "filter_tx_types")
_COLUMNS = (
    "id",
    "report_type",
    "predefined_key",
    "report_name",
    "report_description",
    "measure",
    "period_preset",
    "period_from",
    "period_to",
    "compare_mode",
    "time_grain",
    "group_by_1",
    "group_by_2",
    "top_n",
    "include_other",
    *_LIST_COLUMNS,
    "filter_amount_min",
    "filter_amount_max",
    "chart_kind",
    "record_status",
    "source_created_at",
    "source_updated_at",
)


def _to_sync_notes(exc: Exception) -> str:
    if isinstance(exc, ValueError):
        return str(exc).removeprefix("reports: ")
    if isinstance(exc, pg_errors.UniqueViolation):
        return "duplicate_report_name:report_name"
    if isinstance(exc, pg_errors.CheckViolation):
        return f"database_constraint:{exc.diag.constraint_name}"
    raise TypeError(f"_to_sync_notes: unhandled exception type {type(exc).__name__}")


def load_references(conn: Any) -> reports_transform.References:
    """What filters may point at: non-deleted accounts and their currencies, non-deleted category keys."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT id::text, upper(local_currency) FROM account_master WHERE record_status <> 'deleted'")
        accounts = cursor.fetchall()
        cursor.execute("SELECT major_category_key, minor_category_key FROM category_master WHERE record_status <> 'deleted'")
        categories = cursor.fetchall()
    keys: set[str] = set()
    for major, minor in categories:
        keys.add(major)
        if minor:
            keys.add(f"{major}|{minor}")
    return reports_transform.References(
        account_ids=frozenset(str(identity).lower() for identity, _ in accounts),
        categories=frozenset(keys),
        currencies=frozenset(currency for _, currency in accounts if currency),
    )


def _upsert(conn: Any, typed: dict[str, Any]) -> None:
    # psycopg2 sends Python lists as text[]; the account filter column is uuid[].
    placeholders = ", ".join("%s::uuid[]" if column == "filter_account_ids" else "%s" for column in _COLUMNS)
    updates = ", ".join(f"{column} = EXCLUDED.{column}" for column in _COLUMNS if column != "id")
    with conn.cursor() as cursor:
        cursor.execute("SELECT report_type FROM report_master WHERE id = %s FOR UPDATE", (typed["id"],))
        existing = cursor.fetchone()
        if existing is not None and existing[0] != typed["report_type"]:
            raise ValueError("reports: invalid_report_type:report_type")
        cursor.execute(
            f"INSERT INTO report_master ({', '.join(_COLUMNS)}) VALUES ({placeholders}) ON CONFLICT (id) DO UPDATE SET {updates}, updated_at = now()",
            tuple(typed[column] for column in _COLUMNS),
        )


def upsert_reports(conn: Any, source: Any, rows: list[dict[str, Any]]) -> int:
    """Commit each actionable row on its own; in-sync rows are skipped. Returns the failed count."""
    write_backs: list[outcomes_reports.WriteBack] = []
    failed = 0
    progress = Progress(logger, "upsert_reports", len(rows))
    refs = load_references(conn)
    conn.rollback()  # end the read transaction before row commits
    try:
        for row in rows:
            sheet_row_num = row["_sheet_row_num"]
            sync_status = str(row.get("sync_status") or "").strip()
            if sync_status == "in-sync":
                progress.skip()
                continue
            if sync_status not in _ACTIONABLE:
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_reports: invalid_sync_status row={sheet_row_num}")
                continue
            failed_status = "create-failed" if sync_status.startswith("create-") else "update-failed"
            try:
                _upsert(conn, reports_transform.transform(row, refs))
                conn.commit()
            except (ValueError, pg_errors.UniqueViolation, pg_errors.CheckViolation) as exc:
                conn.rollback()
                failed += 1
                progress.record(failed=1)
                notes = _to_sync_notes(exc)
                logger.warning(f"upsert_reports: row_failed row={sheet_row_num} reason={notes.split(':', 1)[0]}")
                write_backs.append(outcomes_reports.write_back(sheet_row_num, failed_status, datetime.now(timezone.utc).isoformat(), notes))
            except Exception:
                conn.rollback()
                raise
            else:
                progress.record(succeeded=1)
                write_backs.append(outcomes_reports.write_back(sheet_row_num, "in-sync", datetime.now(timezone.utc).isoformat(), ""))
    finally:
        outcomes_reports.flush(source, _SHEET_NAME, write_backs)
        progress.done()
    return failed
