"""Replicate the existing Sheet-owned classification catalog and its processing policies."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import psycopg2
from py_logging import get_logger

from database.account_details import validate_type_detail_policy
from database.progress import Progress
from sheets.account_types import flush
from transforms.account_types import transform

logger = get_logger(__name__)
_ACTIONABLE = {"create-pending", "create-failed", "update-pending", "update-failed"}


def _store(conn: Any, typed: dict[str, Any], synced_at: datetime) -> None:
    identity, group, subtype = typed["id"], typed["account_type_key"], typed["account_subtype_key"]
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT id, account_type_key, account_subtype_key, is_sheet_managed, detail_sheet, sync_notes FROM account_types
               WHERE id=%s OR (account_type_key=%s AND account_subtype_key=%s) ORDER BY id FOR UPDATE""",
            (identity, group, subtype),
        )
        matches = cursor.fetchall()
        existing = None
        for stored in matches:
            if str(stored[0]) == identity and stored[1:3] != (group, subtype):
                raise ValueError("account_types: immutable_classification_keys")
            if stored[1:3] == (group, subtype):
                existing = stored
        if existing is not None and str(existing[0]) != identity:
            if existing[3]:
                raise ValueError("account_types: classification_owned_by_another_id")
        if existing is not None and typed["record_status"] in {"inactive", "deleted"}:
            cursor.execute(
                """SELECT EXISTS (SELECT 1 FROM account_master WHERE account_type=%s AND account_subtype=%s)
                   OR EXISTS (SELECT 1 FROM category_source_account_types WHERE account_type_id=%s)
                   OR EXISTS (SELECT 1 FROM category_target_account_types WHERE account_type_id=%s)""",
                (group, subtype, existing[0], existing[0]),
            )
            if cursor.fetchone()[0]:
                raise ValueError("account_types: referenced_type_cannot_be_retired")
        if existing is None:
            raise ValueError("account_types: classification_not_in_existing_catalog")
        initializing_policy = existing[4] is None and (not existing[3] or existing[5] == "policy_source_sync_required")
        if existing[4] != typed["detail_sheet"] and not initializing_policy:
            cursor.execute("SELECT 1 FROM account_master WHERE account_type=%s AND account_subtype=%s LIMIT 1", (group, subtype))
            if cursor.fetchone() is not None:
                raise ValueError("account_types: detail_policy_frozen_by_existing_accounts")
        validate_type_detail_policy(conn, group, subtype, typed["detail_sheet"])
        cursor.execute(
            """UPDATE account_types SET id=%s, account_type_label=%s, account_subtype_label=%s, description=%s,
               record_status=%s, detail_sheet=%s, updated_at=now(), is_sheet_managed=TRUE,
               sync_status='in-sync', sync_date=%s, sync_notes='' WHERE id=%s""",
            (identity, typed["account_type_label"], typed["account_subtype_label"], typed["description"], typed["record_status"], typed["detail_sheet"], synced_at, existing[0]),
        )


def _validate_source_catalog(rows: list[dict[str, Any]]) -> None:
    labels: dict[str, str] = {}
    subtype_keys: set[str] = set()
    for row in rows:
        group = str(row.get("account_type_key") or "").strip()
        label = str(row.get("account_type_label") or "").strip()
        subtype = str(row.get("account_subtype_key") or "").strip()
        if group in labels and labels[group] != label:
            raise ValueError("account_type_labels_inconsistent")
        labels[group] = label
        if subtype in subtype_keys:
            raise ValueError("duplicate_account_subtype_key")
        subtype_keys.add(subtype)
    if subtype_keys.intersection(labels):
        raise ValueError("account_subtype_key_conflicts_with_type_key")


def upsert_account_types(conn: Any, sheets_client: Any, rows: list[dict[str, Any]], *, before_commit: Callable[[], None] | None = None) -> int:
    """Commit each actionable configuration row before queueing its acknowledgement."""
    _validate_source_catalog(rows)
    updates: list[tuple[int, str, str, str]] = []
    succeeded = failed = 0
    progress = Progress(logger, "upsert_account_types", len(rows))
    try:
        for index, row in enumerate(rows):
            number = int(row.get("_sheet_row_num", index + 2))
            status = str(row.get("sync_status") or "").strip()
            if status == "in-sync":
                progress.skip()
                continue
            if status not in _ACTIONABLE:
                raise ValueError("invalid_account_type_sync_status")
            checking_source = False
            synced_at = datetime.now(timezone.utc)
            try:
                _store(conn, transform(row), synced_at)
                if before_commit is not None:
                    checking_source = True
                    before_commit()
                    checking_source = False
                conn.commit()
            except (ValueError, psycopg2.IntegrityError, psycopg2.DataError) as error:
                conn.rollback()
                if checking_source:
                    raise
                code = str(error).removeprefix("account_types: ") if isinstance(error, ValueError) else "invalid_source_value_or_constraint"
                failed += 1
                progress.record(failed=1)
                logger.warning(f"upsert_account_types: row_failed row={number} error_type={type(error).__name__}")
                updates.append((number, "create-failed" if status.startswith("create-") else "update-failed", synced_at.isoformat(), code))
            except Exception:
                conn.rollback()
                raise
            else:
                succeeded += 1
                progress.record(succeeded=1)
                updates.append((number, "in-sync", synced_at.isoformat(), ""))
    finally:
        flush(sheets_client, updates)
        progress.done()
    return failed
