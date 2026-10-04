"""analytics.run bookkeeping: the job lock, one row per run, what the run read, and pruning.

The run row is committed on its own before the build starts, so a failed or killed
build is still visible (status running or failed) for the monitor and the next run.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

# Session advisory lock: one analytics run at a time. ledger-database-load uses (73421, 1),
# ledger-sheet-extract (73421, 2); this job never takes theirs, so it never blocks a load.
LOCK_KEY = (73421, 3)

# What a build read, so a publish can tell whether anything changed since the last one.
_WATERMARK = """
SELECT json_build_object(
    'transactions', (SELECT json_build_object('rows', count(*), 'updated_at', max(updated_at)) FROM transaction_master),
    'accounts', (SELECT json_build_object('rows', count(*), 'updated_at', max(updated_at)) FROM account_master),
    'categories', (SELECT json_build_object('rows', count(*), 'updated_at', max(updated_at)) FROM category_master),
    'subscriptions', (SELECT json_build_object('rows', count(*), 'updated_at', max(updated_at)) FROM subscription_master),
    'reports', (SELECT json_build_object('rows', count(*), 'updated_at', max(updated_at)) FROM report_master),
    'rates', (SELECT json_build_object('rows', count(*), 'rate_date', max(rate_date)) FROM currency_rates)
)
"""


# Tables the job reads, owned by the modules that load them. A build on a database
# those modules have not migrated yet fails with the missing table's name.
REQUIRED_TABLES = ("currency_rates", "currency_master", "account_master", "account_types", "category_master", "transaction_master", "subscription_master", "report_master", "stg_runs")


def require_source_tables(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("SELECT name FROM unnest(%s::text[]) AS name WHERE to_regclass('public.' || name) IS NULL", (list(REQUIRED_TABLES),))
        missing = [name for (name,) in cursor.fetchall()]
    conn.rollback()
    if missing:
        raise RuntimeError(f"source_table_missing:{missing[0]}")


def take_lock(conn: Any) -> None:
    with conn.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s, %s)", LOCK_KEY)
        if not cursor.fetchone()[0]:
            raise RuntimeError("analytics_already_running")
    conn.commit()


def start(conn: Any, generation_id: str, mode: str, anchor_date: date, contract_version: int) -> None:
    with conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO analytics.run (generation_id, mode, status, anchor_date, contract_version) VALUES (%s, %s, 'running', %s, %s)",
            (generation_id, mode, anchor_date, contract_version),
        )
    conn.commit()


def source_watermark(conn: Any) -> dict[str, Any]:
    with conn.cursor() as cursor:
        cursor.execute(_WATERMARK)
        return cursor.fetchone()[0]


def finish(conn: Any, generation_id: str, watermark: dict[str, Any], counts: dict[str, Any]) -> None:
    """Marks the run built in the caller's transaction (committed with the build's writes)."""
    with conn.cursor() as cursor:
        cursor.execute(
            """UPDATE analytics.run SET status = 'built', finished_at = now(), source_watermark = %s,
                   reports_ok = %s, reports_failed = %s, rows_not_loaded = %s, missing_currencies = %s
               WHERE generation_id = %s""",
            (json.dumps(watermark, default=str), counts["reports_ok"], counts["reports_failed"], counts["rows_not_loaded"], sorted(counts["missing_currencies"]), generation_id),
        )


def fail(conn: Any, generation_id: str, error_code: str) -> None:
    with conn.cursor() as cursor:
        cursor.execute("UPDATE analytics.run SET status = 'failed', finished_at = now(), error_code = %s WHERE generation_id = %s", (error_code, generation_id))
    conn.commit()


def prune(conn: Any, keep: int) -> int:
    """Keeps the newest `keep` runs and the newest published one; their outputs go with them."""
    with conn.cursor() as cursor:
        cursor.execute(
            """DELETE FROM analytics.run WHERE status <> 'running' AND generation_id NOT IN (
                   SELECT generation_id FROM analytics.run ORDER BY started_at DESC LIMIT %s)
               AND generation_id IS DISTINCT FROM (
                   SELECT generation_id FROM analytics.run WHERE status = 'published' ORDER BY published_at DESC LIMIT 1)""",
            (keep,),
        )
        removed = cursor.rowcount
    conn.commit()
    return removed


_RUN_COLUMNS = "generation_id::text, status, anchor_date, contract_version, source_watermark, reports_ok, reports_failed, rows_not_loaded, missing_currencies"


def _run(row: tuple | None) -> dict[str, Any] | None:
    if row is None:
        return None
    keys = ("generation_id", "status", "anchor_date", "contract_version", "source_watermark", "reports_ok", "reports_failed", "rows_not_loaded", "missing_currencies")
    return dict(zip(keys, row))


def latest_good(conn: Any) -> dict[str, Any] | None:
    """The newest run that finished building (built or already published)."""
    with conn.cursor() as cursor:
        cursor.execute(f"SELECT {_RUN_COLUMNS} FROM analytics.run WHERE status IN ('built', 'published') ORDER BY started_at DESC LIMIT 1")
        return _run(cursor.fetchone())


def get(conn: Any, generation_id: str) -> dict[str, Any] | None:
    with conn.cursor() as cursor:
        cursor.execute(f"SELECT {_RUN_COLUMNS} FROM analytics.run WHERE generation_id::text = %s", (generation_id,))
        return _run(cursor.fetchone())


def mark_published(conn: Any, generation_id: str, published_at: str) -> None:
    with conn.cursor() as cursor:
        cursor.execute("UPDATE analytics.run SET status = 'published', published_at = %s WHERE generation_id = %s", (published_at, generation_id))
    conn.commit()
