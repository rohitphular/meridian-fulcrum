"""The two-slot publisher against a fake Sheets client: slots, chunks, the switch written last, skips and a crash mid-publish."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import psycopg2
import pytest

import core.build as build_module
import core.publish as publish_module
from core.build import build
from core.publish import payload_rows, publish
from tests.integration.ledger import Ledger


class FakeSheets:
    """Tabs as lists of rows; `fail_on` = (title, n) raises on the n-th write to that tab."""

    def __init__(self, fail_on: tuple[str, int] | None = None) -> None:
        self.tabs: dict[str, list[list[Any]]] = {}
        self.requests = 0
        self.writes: list[str] = []
        self.fail_on = fail_on

    def read_values(self, title: str) -> list[list[str]] | None:
        self.requests += 1
        rows = self.tabs.get(title)
        return None if rows is None else [["" if value is None else str(value) for value in row] for row in rows]

    def prepare(self, title: str, rows: int, cols: int) -> None:
        self.requests += 1
        current = self.tabs.setdefault(title, [])
        del current[rows:]
        current.extend([[None] * cols for _ in range(rows - len(current))])

    def write(self, title: str, start_row: int, values: list[list[Any]]) -> None:
        self.requests += 1
        self.writes.append(title)
        if self.fail_on and self.fail_on[0] == title and self.writes.count(title) == self.fail_on[1]:
            raise RuntimeError("sheets_write_failed")
        rows = self.tabs[title]
        for offset, row in enumerate(values):
            rows[start_row - 1 + offset] = list(row)

    def request_count(self) -> int:
        return self.requests

    def meta(self) -> dict[str, str]:
        header, row = self.read_values("report_meta")
        return dict(zip(header, row))

    def payloads(self, slot: str) -> dict[tuple[str, str], dict[str, Any]]:
        """What the app would read: the index rows, then each payload's chunks joined in order."""
        _, *index = self.tabs[f"report_index_{slot}"]
        data = self.tabs[f"report_data_{slot}"]
        out = {}
        for report_id, variant_key, first_row, row_count, _ in index:
            chunks = data[first_row - 1 : first_row - 1 + row_count]
            assert [row[2] for row in chunks] == list(range(1, row_count + 1))
            out[(report_id, variant_key)] = json.loads("".join(row[3] for row in chunks))
        return out


@pytest.fixture
def job(database: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Ledger]:
    connection, params = database
    monkeypatch.setattr(build_module, "get_client", lambda _config: psycopg2.connect(**params))
    monkeypatch.setattr(publish_module, "get_client", lambda _config: psycopg2.connect(**params))
    book = Ledger(connection)
    book.rate("GBP", date(2026, 1, 1), 100.0)
    bank = book.account("Bank", opening=5000, tracking_start="2026-01-01 00:00:00")
    book.tx(bank, "2026-09-01T09:00:00", 3000, 30, tx_type="money-in", major="salary", minor="pay")
    book.tx(bank, "2026-09-05T09:00:00", 100, 1, payee="Tesco")
    return connection, book


def _run_status(connection: Any, generation: str) -> str:
    with connection.cursor() as cursor:
        cursor.execute("SELECT status FROM analytics.run WHERE generation_id = %s", (generation,))
        status = cursor.fetchone()[0]
    connection.rollback()
    return status


def _outputs(connection: Any, generation: str) -> dict[tuple[str, str], dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT report_id::text, variant_key, payload FROM analytics.report_output WHERE generation_id = %s", (generation,))
        rows = cursor.fetchall()
    connection.rollback()
    return {(report_id, variant): payload for report_id, variant, payload in rows}


def test_a_publish_fills_the_inactive_slot_then_switches_to_it(job: tuple[Any, Ledger]) -> None:
    connection, _ = job
    sheets = FakeSheets()
    first = build(None, anchor_date=date(2026, 10, 4), keep=5)
    assert publish(None, "sheet", "key", sheets=sheets) == first
    meta = sheets.meta()
    assert (meta["active_slot"], meta["generation_id"], meta["anchor_date"]) == ("a", first, "2026-10-04")
    assert sheets.payloads("a") == _outputs(connection, first)
    assert sheets.writes[-1] == "report_meta", "the switch is the last write"
    _, *status = sheets.tabs["report_status"]
    assert len(status) == 46 and {row[2] for row in status} == {"ready"} and status[0][4] == meta["published_at"]
    assert _run_status(connection, first) == "published"

    second = build(None, anchor_date=date(2026, 10, 5), keep=5)
    slot_a = [list(row) for row in sheets.tabs["report_data_a"]]
    assert publish(None, "sheet", "key", sheets=sheets) == second
    assert (sheets.meta()["active_slot"], sheets.meta()["generation_id"]) == ("b", second)
    assert sheets.tabs["report_data_a"] == slot_a, "the slot the app was reading is untouched"


def test_refresh_skips_a_generation_that_read_the_same_data_but_publish_resends_it(job: tuple[Any, Ledger]) -> None:
    _, _ = job
    sheets = FakeSheets()
    first = build(None, anchor_date=date(2026, 10, 4), keep=5)
    publish(None, "sheet", "key", sheets=sheets, force=False)
    build(None, anchor_date=date(2026, 10, 4), keep=5)
    writes = len(sheets.writes)
    assert publish(None, "sheet", "key", sheets=sheets, force=False) is None
    assert len(sheets.writes) == writes and sheets.meta()["generation_id"] == first
    assert publish(None, "sheet", "key", sheets=sheets, force=True) is not None


def test_a_new_transaction_or_a_new_day_is_published_by_refresh(job: tuple[Any, Ledger]) -> None:
    _, book = job
    sheets = FakeSheets()
    build(None, anchor_date=date(2026, 10, 4), keep=5)
    publish(None, "sheet", "key", sheets=sheets, force=False)
    book.tx(next(iter(_accounts(book))), "2026-10-03T09:00:00", 50, 0.5)
    changed = build(None, anchor_date=date(2026, 10, 4), keep=5)
    assert publish(None, "sheet", "key", sheets=sheets, force=False) == changed
    next_day = build(None, anchor_date=date(2026, 10, 5), keep=5)
    assert publish(None, "sheet", "key", sheets=sheets, force=False) == next_day


def _accounts(book: Ledger) -> list[str]:
    with book.conn.cursor() as cursor:
        cursor.execute("SELECT id::text FROM account_master")
        rows = [row[0] for row in cursor.fetchall()]
    book.conn.rollback()
    return rows


@pytest.mark.parametrize("failing_tab", ["report_data_b", "report_index_b", "report_status"])
def test_a_publish_killed_before_the_switch_leaves_the_previous_generation_live(job: tuple[Any, Ledger], failing_tab: str) -> None:
    connection, _ = job
    sheets = FakeSheets()
    first = build(None, anchor_date=date(2026, 10, 4), keep=5)
    publish(None, "sheet", "key", sheets=sheets)
    before = sheets.payloads("a")
    second = build(None, anchor_date=date(2026, 10, 5), keep=5)
    sheets.fail_on = (failing_tab, sheets.writes.count(failing_tab) + 1)
    with pytest.raises(RuntimeError, match="sheets_write_failed"):
        publish(None, "sheet", "key", sheets=sheets)
    assert (sheets.meta()["active_slot"], sheets.meta()["generation_id"]) == ("a", first)
    assert sheets.payloads("a") == before
    assert _run_status(connection, second) == "built"
    sheets.fail_on = None
    assert publish(None, "sheet", "key", sheets=sheets) == second, "the next publish completes it"


def test_payloads_are_cut_into_chunks_that_join_back_exactly() -> None:
    payload = {"title": "x" * 25, "values": list(range(10))}
    data, index, characters = payload_rows([("r1", "", payload), ("r2", "period=ytd", {"a": 1})], 10)
    text = json.dumps(payload, separators=(",", ":"))
    assert characters == len(text) + len('{"a":1}')
    assert index[0][:4] == ["r1", "", 2, -(-len(text) // 10)] and index[1][:4] == ["r2", "period=ytd", 2 + index[0][3], 1]
    assert "".join(row[3] for row in data[: index[0][3]]) == text
    assert all(len(row[3]) <= 10 for row in data)


def test_nothing_built_yet_fails_clearly(job: tuple[Any, Ledger]) -> None:
    with pytest.raises(RuntimeError, match="^nothing_to_publish$"):
        publish(None, "sheet", "key", sheets=FakeSheets())
