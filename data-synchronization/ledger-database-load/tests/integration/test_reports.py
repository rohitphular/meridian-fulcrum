"""Load report_master rows into PostgreSQL: outcomes, references from the ledger, and the table's rules."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from core import report_contract
from database.reports import upsert_reports

MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class RecordingSource:
    def __init__(self) -> None:
        self.updates: dict[int, list[str]] = {}

    def batch_update_rows(self, name: str, updates: list[tuple[int, int, list[str]]]) -> None:
        assert name == "report_master"
        sync_column = report_contract.columns().index("sync_status") + 1
        for row, column, values in updates:
            assert column == sync_column
            self.updates[row] = values


def _row(number: int, **values: Any) -> dict[str, Any]:
    row = dict.fromkeys(report_contract.columns(), "")
    row.update(
        id=MINE,
        report_type="user_defined",
        report_name="Monthly spend",
        measure="spend",
        period_preset="last_6",
        time_grain="month",
        group_by_1="category",
        chart_kind="stacked",
        record_status="active",
        sync_status="create-pending",
        updated_at="2026-10-04T10:00:00.000Z",
        _sheet_row_num=number,
    )
    row.update(values)
    return row


def _account(client: Any, status: str = "active") -> str:
    identity = str(uuid4())
    with client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_master (id, account_name, account_type, account_subtype, local_currency, base_currency,
                   opening_amount_local_value, opening_amount_base_value, record_status, created_at, updated_at)
               SELECT %s, 'Fixture', account_type_key, account_subtype_key, 'USD', 'XAU', 0, 0, %s, now(), now()
               FROM account_types ORDER BY account_subtype_key LIMIT 1""",
            (identity, status),
        )
    client.commit()
    return identity


def _stored(client: Any, identity: str = MINE) -> dict[str, Any] | None:
    with client.cursor() as cursor:
        # psycopg2 has no decoder for uuid[]: read the account filter as text[].
        cursor.execute("SELECT *, filter_account_ids::text[] AS account_ids FROM report_master WHERE id = %s", (identity,))
        record = cursor.fetchone()
        return None if record is None else dict(zip([column.name for column in cursor.description], record))


def test_pending_reports_load_and_report_in_sync_with_typed_columns(database_client: Any) -> None:
    account = _account(database_client)
    predefined = next(report for report in report_contract.predefined()["reports"] if report["key"] == "08-category-pie")
    rows = [
        _row(
            2,
            filter_account_ids=account.upper(),
            filter_tags="Holiday;work",
            filter_currencies="usd",
            period_preset="fixed",
            period_from="2026-01-01",
            period_to="2026-03-31",
            filter_amount_min="12.5",
        ),
        dict.fromkeys(report_contract.columns(), "")
        | {"id": predefined["id"], "report_type": "predefined", "predefined_key": predefined["key"], "record_status": "locked", "sync_status": "create-pending", "_sheet_row_num": 3},
    ]
    source = RecordingSource()
    assert upsert_reports(database_client, source, rows) == 0
    assert [values[0] for _, values in sorted(source.updates.items())] == ["in-sync", "in-sync"]
    stored = _stored(database_client)
    assert stored["account_ids"] == [account]
    assert stored["filter_tags"] == ["Holiday", "work"] and stored["filter_currencies"] == ["USD"]
    assert str(stored["period_from"]) == "2026-01-01" and str(stored["filter_amount_min"]) == "12.50000000"
    assert stored["top_n"] == 7 and stored["include_other"] is True
    assert stored["source_updated_at"] == "2026-10-04T10:00:00.000Z"
    pre = _stored(database_client, predefined["id"])
    assert (pre["report_name"], pre["record_status"], pre["measure"]) == ("Spending by category", "locked", None)


def test_invalid_rows_fail_with_code_and_column_without_stopping_the_others(database_client: Any) -> None:
    deleted_account = _account(database_client, status="deleted")
    rows = [
        _row(2, filter_account_ids=deleted_account),
        _row(3, id=str(uuid4()), report_name="Second", chart_kind="donut"),
        _row(4, id=str(uuid4()), report_name="Third", sync_status="update-pending"),
    ]
    source = RecordingSource()
    assert upsert_reports(database_client, source, rows) == 2
    assert source.updates[2][0] == "create-failed" and source.updates[2][2] == "unknown_filter_reference:filter_account_ids"
    assert source.updates[3][2] == "chart_not_allowed_for_shape:chart_kind"
    assert source.updates[4][0] == "in-sync"
    assert _stored(database_client) is None


def test_in_sync_rows_are_skipped_and_updates_overwrite_by_id(database_client: Any) -> None:
    source = RecordingSource()
    upsert_reports(database_client, source, [_row(2)])
    source = RecordingSource()
    assert upsert_reports(database_client, source, [_row(2, sync_status="in-sync", report_name="Changed but in-sync")]) == 0
    assert source.updates == {}
    assert _stored(database_client)["report_name"] == "Monthly spend"
    upsert_reports(database_client, RecordingSource(), [_row(2, sync_status="update-pending", period_preset="ytd", updated_at="2026-10-05T09:00:00.000Z")])
    stored = _stored(database_client)
    assert (stored["period_preset"], stored["source_updated_at"]) == ("ytd", "2026-10-05T09:00:00.000Z")


def test_names_are_unique_among_live_user_reports_and_types_never_change(database_client: Any) -> None:
    other = str(uuid4())
    upsert_reports(database_client, RecordingSource(), [_row(2)])
    source = RecordingSource()
    assert upsert_reports(database_client, source, [_row(3, id=other, report_name="MONTHLY SPEND")]) == 1
    assert source.updates[3][2] == "duplicate_report_name:report_name"
    upsert_reports(database_client, RecordingSource(), [_row(2, sync_status="update-pending", record_status="deleted")])
    assert upsert_reports(database_client, RecordingSource(), [_row(3, id=other, report_name="MONTHLY SPEND")]) == 0, "a deleted report frees its name"
    predefined = next(report for report in report_contract.predefined()["reports"] if report["key"] == "kpi-net-worth")
    upsert_reports(database_client, RecordingSource(), [_row(4, id=predefined["id"], report_name="Clash")])
    source = RecordingSource()
    retyped = dict.fromkeys(report_contract.columns(), "") | {
        "id": predefined["id"],
        "report_type": "predefined",
        "predefined_key": predefined["key"],
        "sync_status": "update-pending",
        "_sheet_row_num": 4,
    }
    assert upsert_reports(database_client, source, [retyped]) == 1
    assert source.updates[4][2] == "invalid_report_type:report_type"
