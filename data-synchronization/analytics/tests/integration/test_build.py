"""The build lifecycle against PostgreSQL: run rows, one snapshot, failure, lock and pruning."""

from __future__ import annotations

from datetime import date
from typing import Any

import psycopg2
import pytest

import core.build as build_module
from core.build import BuildContext, build, check


@pytest.fixture
def job(database: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> tuple[Any, dict[str, Any]]:
    connection, params = database
    monkeypatch.setattr(build_module, "get_client", lambda _config: psycopg2.connect(**params))
    monkeypatch.setattr(build_module, "BUILD_STEPS", [])
    return connection, params


def _runs(connection: Any) -> list[tuple]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT generation_id::text, status, anchor_date, error_code, source_watermark FROM analytics.run ORDER BY started_at")
        rows = cursor.fetchall()
    connection.rollback()
    return rows


def test_a_build_with_no_steps_records_a_built_run_with_what_it_read(job: tuple[Any, dict[str, Any]]) -> None:
    connection, _ = job
    generation = build(None, anchor_date=date(2026, 10, 4), keep=5)
    [(identity, status, anchor, error, watermark)] = _runs(connection)
    assert (identity, status, anchor, error) == (generation, "built", date(2026, 10, 4), None)
    assert set(watermark) == {"transactions", "accounts", "categories", "subscriptions", "reports", "rates"}
    assert watermark["transactions"]["rows"] == 0


def test_every_step_reads_the_same_snapshot_while_a_load_commits(job: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    connection, params = job
    seen: list[int] = []

    def count(conn: Any, context: BuildContext) -> None:
        with conn.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM currency_rates")
            seen.append(cursor.fetchone()[0])

    def concurrent_load(conn: Any, context: BuildContext) -> None:
        other = psycopg2.connect(**params)
        try:
            with other.cursor() as cursor:
                cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('GBP', '2026-10-03', 77, 'test')")
            other.commit()
        finally:
            other.close()

    monkeypatch.setattr(build_module, "BUILD_STEPS", [("count", count), ("load", concurrent_load), ("count again", count)])
    build(None, anchor_date=date(2026, 10, 4), keep=5)
    assert seen[0] == seen[1], "a row committed during the build is not seen by later steps"


def test_a_failing_step_marks_the_run_failed_and_keeps_none_of_its_writes(job: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    connection, _ = job

    def writes_then_fails(conn: Any, context: BuildContext) -> None:
        with conn.cursor() as cursor:
            cursor.execute("INSERT INTO analytics.report_output (generation_id, report_id, variant_key, payload) VALUES (%s, gen_random_uuid(), '', '{}')", (context.generation_id,))
        raise RuntimeError("mart_rate_missing:GBP")

    monkeypatch.setattr(build_module, "BUILD_STEPS", [("broken", writes_then_fails)])
    with pytest.raises(RuntimeError, match="mart_rate_missing"):
        build(None, anchor_date=date(2026, 10, 4), keep=5)
    [(_, status, _, error, _)] = _runs(connection)
    assert (status, error) == ("failed", "mart_rate_missing:GBP")
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM analytics.report_output")
        assert cursor.fetchone()[0] == 0


def test_a_second_run_is_refused_while_one_holds_the_lock(job: tuple[Any, dict[str, Any]]) -> None:
    connection, params = job
    holder = psycopg2.connect(**params)
    try:
        with holder.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_lock(73421, 3)")
        with pytest.raises(RuntimeError, match="^analytics_already_running$"):
            build(None, anchor_date=date(2026, 10, 4), keep=5)
    finally:
        holder.close()
    assert _runs(connection) == []


def test_old_generations_are_pruned_but_the_last_published_one_stays(job: tuple[Any, dict[str, Any]]) -> None:
    connection, _ = job
    first = build(None, anchor_date=date(2026, 10, 1), keep=2)
    with connection.cursor() as cursor:
        cursor.execute("UPDATE analytics.run SET status = 'published', published_at = now() WHERE generation_id = %s", (first,))
    connection.commit()
    later = [build(None, anchor_date=date(2026, 10, day), keep=2) for day in (2, 3, 4)]
    remaining = [identity for identity, *_ in _runs(connection)]
    assert remaining == [first, *later[-2:]]


def test_check_reads_only(job: tuple[Any, dict[str, Any]]) -> None:
    connection, _ = job
    assert check(None) == {"runs": 0, "report_master": {}}
    assert _runs(connection) == []


def test_a_database_without_the_loaded_tables_fails_with_the_table_name(job: tuple[Any, dict[str, Any]]) -> None:
    connection, _ = job
    with connection.cursor() as cursor:
        cursor.execute("DROP TABLE report_master")
    connection.commit()
    with pytest.raises(RuntimeError, match="^source_table_missing:report_master$"):
        build(None, anchor_date=date(2026, 10, 4), keep=5)
    assert _runs(connection) == [], "nothing is recorded before the sources are there"
