"""extract → ledger-database-load → acknowledge against one disposable database.

Extract and acknowledge run in-process against a fake spreadsheet; the load runs as
ledger-database-load's real job in its own environment (a subprocess), as the
pipeline runs it.
"""

import json
import os
import subprocess
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import psycopg2
import pytest
from gspread.utils import a1_to_rowcol

import core.jobs as jobs
from sheets.client import SnapshotSheetsClient
from tests.integration.conftest import LOAD_ROOT

FIRST, SECOND, THIRD, INSERTED = (f"{digit * 8}-{digit * 4}-4{digit * 3}-8{digit * 3}-{digit * 12}" for digit in "abcd")


def _load_contract_headers() -> list[str]:
    """The category headers ledger-database-load checks staged tabs against (its single copy)."""
    code = "import json; from core.source_contracts import HEADERS; print(json.dumps(HEADERS['category_master']))"
    completed = subprocess.run(["uv", "run", "--locked", "python", "-c", code], cwd=LOAD_ROOT, capture_output=True, text=True, check=True, env={**os.environ, "VIRTUAL_ENV": ""})
    return json.loads(completed.stdout)


def _category(identity: str, minor: str, **values: Any) -> dict:
    return {
        "id": identity,
        "tx_type_key": "money-out",
        "tx_type_label": "Money out",
        "major_category_key": "living",
        "major_category_label": "Living",
        "minor_category_key": minor,
        "minor_category_label": minor.title(),
        "record_status": "active",
        "source_account_mandatory": True,
        "target_account_mandatory": False,
        "is_subscription_eligible": False,
        "sync_status": "create-pending",
        **values,
    }


class Sheet:
    """A one-tab spreadsheet: reads return the grid, writes update it."""

    def __init__(self, headers: list[str], rows: list[dict]) -> None:
        self.headers = headers
        self.rows = rows

    def values(self) -> list[list]:
        return [self.headers, *[[row.get(field, "") for field in self.headers] for row in self.rows]]

    def apply(self, *, body: dict) -> None:
        assert body["valueInputOption"] == "RAW"
        for update in body["data"]:
            row_number, column = a1_to_rowcol(update["range"].split("!")[1])
            field = self.headers[column - 1]
            assert field in {"sync_status", "sync_date", "sync_notes"}, "only sync cells are written"
            self.rows[row_number - 2][field] = update["values"][0][0]


def _fake_client(sheet: Sheet) -> type:
    spreadsheet = MagicMock()
    spreadsheet.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": "category_master"}}]}
    spreadsheet.values_batch_get.side_effect = lambda ranges, params: {"valueRanges": [{"values": sheet.values()} for _ in ranges]}
    spreadsheet.values_batch_update.side_effect = sheet.apply

    class FakeClient(SnapshotSheetsClient):
        def __init__(self, *_args: Any) -> None:
            self._snapshots, self._headers, self._ss = {}, {}, spreadsheet
            self._read_requests = SimpleNamespace(call=lambda call: call())
            self._write_requests = SimpleNamespace(call=lambda call: call())

    return FakeClient


def _run_load(connection: dict) -> subprocess.CompletedProcess:
    environment = {
        **os.environ,
        "VIRTUAL_ENV": "",
        "MERIDIAN_LOG_ROOT": "/tmp/ledger-sheet-extract-e2e-logs",
        "FULCRUM_DB_HOST": connection["host"],
        "FULCRUM_DB_PORT": str(connection["port"]),
        "FULCRUM_DB_USER": connection["user"],
        "FULCRUM_DB_PASSWORD": "",
        "FULCRUM_DB_NAME": connection["dbname"],
    }
    return subprocess.run(["uv", "run", "--locked", "python", "-m", "core.runner"], cwd=LOAD_ROOT, env=environment, capture_output=True, text=True, timeout=180)


def test_extract_load_acknowledge_by_id_leaves_edited_rows_pending_and_reports_failures(database: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, connection = database
    sheet = Sheet(_load_contract_headers(), [_category(FIRST, "food"), _category(SECOND, "rent", tx_type_key="not-a-type"), _category(THIRD, "fuel")])
    monkeypatch.setattr(jobs, "SnapshotSheetsClient", _fake_client(sheet))
    monkeypatch.setattr(jobs, "get_client", lambda _config: psycopg2.connect(**connection))

    jobs.extract(None, "sheet", "key", ["category_master"])

    # Between the snapshot and the acknowledgement: a row is inserted above, and one row is edited.
    sheet.rows.insert(0, _category(INSERTED, "travel"))
    sheet.rows[3]["minor_category_label"] = "Fuel (edited after the snapshot)"

    loaded = _run_load(connection)
    assert loaded.returncode == 1, loaded.stdout + loaded.stderr  # the invalid row fails the load
    assert "entity_rows_failed:category_master" in loaded.stdout + loaded.stderr

    jobs.acknowledge(None, "sheet", "key")
    by_id = {row["id"]: row for row in sheet.rows}
    assert by_id[FIRST]["sync_status"] == "in-sync", "found by id although it moved down a row"
    assert by_id[SECOND]["sync_status"] == "create-failed" and by_id[SECOND]["sync_notes"] != ""
    assert by_id[THIRD]["sync_status"] == "create-pending", "edited since the snapshot: left for the next run"
    assert by_id[INSERTED]["sync_status"] == "create-pending", "not in the snapshot"
    with conn.cursor() as cursor:
        cursor.execute("SELECT id::text FROM category_master ORDER BY minor_category_key")
        assert [record[0] for record in cursor.fetchall()] == [FIRST, THIRD], "committed rows stay committed"
        cursor.execute("SELECT status FROM stg_runs")
        assert cursor.fetchall() == [("acknowledged",)]
