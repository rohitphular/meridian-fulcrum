from typing import Any
from unittest.mock import MagicMock

import pytest

import core.jobs as jobs
import database.staging as staging

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
HEADERS = ["id", "name", "amount", "sync_status", "sync_date", "sync_notes", "updated_at"]


def _cells(**values: Any) -> dict:
    cells = {"id": IDENTITY, "name": "Rent", "amount": 12, "sync_status": "update-pending", "sync_date": "", "sync_notes": "", "updated_at": "t1"}
    cells.update(values)
    return cells


@pytest.mark.parametrize(
    "current,same",
    [
        ({}, True),
        ({"sync_status": "in-sync", "sync_date": "x", "sync_notes": "y"}, True),
        ({"name": "Rent 2"}, False),
        ({"updated_at": "t2"}, False),
        ({"amount": 12.0}, False),
        ({"amount": True}, False),
        ({"extra": "new column"}, False),
        ({"extra": ""}, True),
        ({"extra": None}, True),
    ],
)
def test_same_cells_ignores_only_the_sync_cells_and_compares_types(current: dict, same: bool) -> None:
    assert jobs._same_cells(_cells(), {**_cells(**current), "_sheet_row_num": 7}) is same


def test_same_cells_treats_a_removed_column_as_an_edit() -> None:
    current = _cells()
    del current["name"]
    assert jobs._same_cells(_cells(), current) is False


def test_acknowledge_refuses_to_run_while_a_load_holds_its_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (False,)
    monkeypatch.setattr(jobs, "get_client", lambda _config: conn)
    monkeypatch.setattr(jobs.staging, "take_lock", lambda _conn: None)
    latest = MagicMock()
    monkeypatch.setattr(jobs.staging, "latest_loaded_run", latest)
    with pytest.raises(RuntimeError, match="ledger_database_load_running"):
        jobs.acknowledge(None, "sheet", "key")
    latest.assert_not_called()
    conn.close.assert_called_once()


class FakeClient:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.written: list[dict] = []

    def read_tabs(self, names: list[str]) -> dict:
        return {name: (HEADERS, [dict(row) for row in self.rows]) for name in names}

    def write_with_retry(self, plan: Any) -> None:
        self.written.extend(plan())


def _run_acknowledge(monkeypatch: pytest.MonkeyPatch, sheet_rows: list[dict], outcomes: list[staging.StagedRow]) -> tuple[FakeClient, MagicMock]:
    client = FakeClient(sheet_rows)
    marked = MagicMock()
    monkeypatch.setattr(jobs, "get_client", lambda _config: MagicMock())
    monkeypatch.setattr(jobs, "SnapshotSheetsClient", lambda *_args: client)
    monkeypatch.setattr(jobs.staging, "take_lock", lambda _conn: None)
    monkeypatch.setattr(jobs.staging, "latest_loaded_run", lambda _conn: "run-1")
    monkeypatch.setattr(jobs.staging, "pending_outcomes", lambda _conn, _run: outcomes)
    monkeypatch.setattr(jobs.staging, "mark_acknowledged", marked)
    jobs.acknowledge(None, "sheet", "key")
    return client, marked


def _staged(row: int, source_id: str = IDENTITY, outcome: tuple = ("in-sync", "now", ""), **cells: Any) -> staging.StagedRow:
    return staging.StagedRow("subscription_master", row, source_id, _cells(id=source_id, **cells), outcome)


def test_outcome_lands_on_the_rows_current_position_found_by_id(monkeypatch: pytest.MonkeyPatch) -> None:
    # A row was inserted above it since the snapshot: staged row 2 is now row 3.
    sheet = [{**_cells(id=OTHER, name="New"), "_sheet_row_num": 2}, {**_cells(), "_sheet_row_num": 3}]
    client, marked = _run_acknowledge(monkeypatch, sheet, [_staged(2)])
    assert [(cell["range"], cell["values"]) for cell in client.written] == [
        ("'subscription_master'!D3", [["in-sync"]]),
        ("'subscription_master'!E3", [["now"]]),
        ("'subscription_master'!F3", [[""]]),
    ]
    assert [row.sheet_row_num for row in marked.call_args.args[2]] == [2]


def test_row_edited_since_the_snapshot_is_left_pending(monkeypatch: pytest.MonkeyPatch) -> None:
    sheet = [{**_cells(name="Edited after the snapshot"), "_sheet_row_num": 2}]
    client, marked = _run_acknowledge(monkeypatch, sheet, [_staged(2)])
    assert client.written == []
    assert marked.call_args.args[2] == []


def test_failure_outcome_writes_status_and_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    sheet = [{**_cells(), "_sheet_row_num": 2}]
    client, _ = _run_acknowledge(monkeypatch, sheet, [_staged(2, outcome=("update-failed", "now", "accounts: immutable fields differ"))])
    assert [cell["values"][0][0] for cell in client.written] == ["update-failed", "now", "accounts: immutable fields differ"]


@pytest.mark.parametrize("sheet", [[], "duplicate"])
def test_row_missing_or_duplicated_by_id_is_skipped(monkeypatch: pytest.MonkeyPatch, sheet: Any) -> None:
    rows = [] if sheet == [] else [{**_cells(), "_sheet_row_num": 2}, {**_cells(), "_sheet_row_num": 5}]
    client, marked = _run_acknowledge(monkeypatch, rows, [_staged(2)])
    assert client.written == []
    assert marked.call_args.args[2] == []


def test_uuid_spelling_in_the_sheet_still_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    sheet = [{**_cells(id=IDENTITY.upper()), "_sheet_row_num": 2}]
    client, _ = _run_acknowledge(monkeypatch, sheet, [staging.StagedRow("subscription_master", 2, IDENTITY, _cells(id=IDENTITY.upper()), ("in-sync", "now", ""))])
    assert len(client.written) == 3


def test_nothing_to_acknowledge_when_the_newest_run_is_not_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "get_client", lambda _config: MagicMock())
    monkeypatch.setattr(jobs.staging, "take_lock", lambda _conn: None)
    monkeypatch.setattr(jobs.staging, "latest_loaded_run", lambda _conn: None)
    client_factory = MagicMock()
    monkeypatch.setattr(jobs, "SnapshotSheetsClient", client_factory)
    jobs.acknowledge(None, "sheet", "key")
    client_factory.assert_not_called()


def test_extract_with_no_enabled_tabs_reads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    connect = MagicMock()
    monkeypatch.setattr(jobs, "get_client", connect)
    jobs.extract(None, "sheet", "key", [])
    connect.assert_not_called()
