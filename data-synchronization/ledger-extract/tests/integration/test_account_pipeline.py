"""Run account/detail orchestration and snapshot acknowledgements against PostgreSQL."""

from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import psycopg2
import pytest
from gspread.utils import a1_to_rowcol

import core.extractor as extractor
from core.account_detail_contracts import CONTRACTS, SYNC_DETAIL_SHEETS
from sheets.client import SnapshotSheetsClient
from sheets.contracts import HEADERS
from tests.integration.postgres_support import subtype_for_detail


@pytest.fixture
def account_pipeline(database_client: Any, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> tuple:
    with database_client.cursor() as cursor:
        cursor.execute("SELECT account_subtype_key, account_type_key FROM account_types")
        types = dict(cursor.fetchall())
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('GBP', '2026-09-18', 100, 'test')")
    database_client.commit()
    source: dict[str, list[dict[str, Any]]] = {"account_master": []}
    masters = {name: str(uuid4()) for name in CONTRACTS}
    examples = {
        "account_deposit": {"is_interest_paid": False, "interest_rate": "0"},
        "account_liability_credit_card": {"credit_limit_local": "0"},
        "account_liability_mortgage": {"original_principal_local": "100", "term_months": "12", "linked_property_account_id": masters["account_investment_property"]},
        "account_liability_personal_loan": {"original_principal_local": "100", "term_months": "12"},
        "account_investment_property": {"acquisition_type": "GIFTED", "current_value_local": "125.335", "current_value_evaluation_date": "2026-09-18"},
        "account_investment_stocks": {"instrument_type": "CASH", "instrument_symbol": "CASH", "instrument_name": "Cash (GBP)", "instrument_currency_local": "GBP"},
    }
    for name, spec in CONTRACTS.items():
        master = dict.fromkeys(HEADERS["account_master"], "")
        master.update(
            id=masters[name],
            account_name=name,
            type=types[subtype_for_detail(database_client, name)],
            sub_type=subtype_for_detail(database_client, name),
            account_currency_local="GBP",
            local_timezone="Europe/London",
            account_opening_date_local="2026-09-18",
            opening_value_local="0",
            record_status="active",
            sync_status="create-pending",
            created_at="2020-01-01T00:00:00Z",
            updated_at="2020-02-01T00:00:00Z",
            _sheet_row_num=len(source["account_master"]) + 2,
        )
        source["account_master"].append(master)
        row = dict.fromkeys(spec.headers, "")
        row.update(id=str(uuid4()), account_id=masters[name], record_status="active", _sheet_row_num=2, **examples[name])
        if name in SYNC_DETAIL_SHEETS:
            row.update(sync_status="create-pending", created_at="2020-01-01T00:00:00Z", updated_at="2020-02-01T00:00:00Z")
        source[name] = [row]

    for _ in range(getattr(request, "param", len(CONTRACTS)) - len(CONTRACTS)):
        source["account_master"].append({**source["account_master"][0], "id": str(uuid4()), "_sheet_row_num": len(source["account_master"]) + 2})
    spreadsheet = MagicMock()
    spreadsheet.fetch_sheet_metadata.return_value = {"sheets": [{"properties": {"title": name}} for name in source]}

    def read_ranges(ranges: list[str], *, params: dict) -> dict:
        assert params == {"majorDimension": "ROWS", "valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "FORMATTED_STRING"}
        value_ranges = []
        for requested in ranges:
            name = requested.strip("'")
            cells = [list(HEADERS[name])]
            for row in source[name]:
                while len(cells) < row["_sheet_row_num"] - 1:
                    cells.append([])
                cells.append([row[column] for column in HEADERS[name]])
            value_ranges.append({"range": requested, "values": deepcopy(cells)})
        return {"valueRanges": value_ranges}

    spreadsheet.values_batch_get.side_effect = read_ranges

    class FixtureSnapshot(SnapshotSheetsClient):
        def __init__(self, *_args: Any) -> None:
            self._snapshots = {}
            self._headers = {}
            self._pending = {}
            self._ss = spreadsheet
            self._read_requests = SimpleNamespace(call=lambda call: call())
            self._write_requests = SimpleNamespace(call=lambda call: call())

        def get_modified_time(self) -> datetime:
            return datetime(2026, 9, 18, 13, tzinfo=timezone.utc)

    writes = []

    def apply_acknowledgements(*, body: dict) -> None:
        # An independent connection can already see every account/detail commit
        # when the first Sheet acknowledgement reaches the network boundary.
        with database_client.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM account_master")
            assert cursor.fetchone() == (len(source["account_master"]),)
            for detail_name, spec in CONTRACTS.items():
                cursor.execute(f"SELECT id FROM {spec.target_table} WHERE source_sheet=%s", (detail_name,))
                assert cursor.fetchone() == (source[detail_name][0]["id"],)
        assert body["valueInputOption"] == "RAW"
        touched = set()
        for update in body["data"]:
            sheet_range, cell = update["range"].split("!")
            name = sheet_range.strip("'")
            row_number, column = a1_to_rowcol(cell)
            row = next(row for row in source[name] if row["_sheet_row_num"] == row_number)
            for offset, value in enumerate(update["values"][0]):
                field = HEADERS[name][column - 1 + offset]
                assert field in {"sync_status", "sync_date", "sync_notes"}
                row[field] = value
            touched.add(name)
        writes.extend(sorted(touched))

    monkeypatch.setattr(extractor, "SnapshotSheetsClient", FixtureSnapshot)
    monkeypatch.setattr(extractor, "get_client", lambda _config: psycopg2.connect(database_client.dsn))
    spreadsheet.values_batch_update.side_effect = apply_acknowledgements
    config = {"entities": {name: {"enabled": name in source} for name in ("category_master", "account_master", *CONTRACTS, "transaction_master", "subscription_master")}}
    job = extractor.LedgerExtractJob(None, "fixture", "fixture")
    return job, config, source, writes, spreadsheet


def test_full_account_pipeline_skips_revalues_and_recovers_without_changing_source_identity(database_client: Any, account_pipeline: tuple) -> None:
    job, config, source, writes, _ = account_pipeline
    job.run(config)
    assert set(writes) == {"account_master", *SYNC_DETAIL_SHEETS}
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id, created_at, current_value_local_value, current_value_base_value FROM account_investment_property")
        property_before = cursor.fetchone()
        assert property_before[2:] == (12534, 1253400000)
        cursor.execute("SELECT units_held, current_value_local_value, current_value_base_value FROM account_investment_stocks")
        assert cursor.fetchone() == (None, None, None)
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='GBP'")
    database_client.commit()
    writes.clear()
    job.run(config)
    assert writes == []
    with database_client.cursor() as cursor:
        cursor.execute("SELECT current_value_base_value FROM account_investment_property")
        assert cursor.fetchone() == (property_before[3],)
    job.run(config, reprocess=True)
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id, created_at, current_value_local_value, current_value_base_value FROM account_investment_property")
        assert cursor.fetchone() == (*property_before[:3], 626700000)
        cursor.execute("DELETE FROM account_investment_stocks")
        cursor.execute("DELETE FROM account_master WHERE id=%s", (source["account_investment_stocks"][0]["account_id"],))
    database_client.commit()
    writes.clear()
    job.run(config)
    assert set(writes) == {"account_master", "account_investment_stocks"}
    for name in ("account_master", *SYNC_DETAIL_SHEETS):
        for row in source[name]:
            assert row["sync_status"] == "in-sync"
            assert row["created_at"] == "2020-01-01T00:00:00Z"
            assert row["updated_at"] == "2020-02-01T00:00:00Z"


def test_failed_sheet_acknowledgement_replays_all_account_families_safely(database_client: Any, account_pipeline: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    job, config, source, writes, spreadsheet = account_pipeline
    apply_acknowledgements = spreadsheet.values_batch_update.side_effect

    def fail_write(**_kwargs: Any) -> None:
        raise RuntimeError("simulated_acknowledgement_failure")

    spreadsheet.values_batch_update.side_effect = fail_write
    with pytest.raises(RuntimeError, match="simulated_acknowledgement_failure"):
        job.run(config)
    assert writes == []
    before = {}
    with database_client.cursor() as cursor:
        for name, spec in CONTRACTS.items():
            cursor.execute(f"SELECT id, created_at FROM {spec.target_table} WHERE source_sheet=%s", (name,))
            before[name] = cursor.fetchone()
            assert before[name][0] == source[name][0]["id"]
        cursor.execute("SELECT last_sheet_modified_at FROM job_execution_details WHERE job_name='ledger-extract'")
        checkpoint = cursor.fetchone()
        assert checkpoint is None or checkpoint[0] is None
    spreadsheet.values_batch_update.side_effect = apply_acknowledgements
    job.run(config)
    assert set(writes) == {"account_master", *SYNC_DETAIL_SHEETS}
    with database_client.cursor() as cursor:
        for name, spec in CONTRACTS.items():
            cursor.execute(f"SELECT id, created_at FROM {spec.target_table} WHERE source_sheet=%s", (name,))
            assert cursor.fetchone() == before[name]


@pytest.mark.parametrize("account_pipeline", [23], indirect=True)
def test_twenty_three_accounts_use_one_batch_per_guard_in_normal_and_hard_sync(account_pipeline: tuple) -> None:
    job, config, source, writes, spreadsheet = account_pipeline
    for reprocess in (False, True):
        spreadsheet.reset_mock()
        writes.clear()
        job.run(config, reprocess=reprocess)
        # Capture + 23 account commits + six detail commits + acknowledgement.
        assert spreadsheet.values_batch_get.call_count == 31
        spreadsheet.fetch_sheet_metadata.assert_called_once()
        spreadsheet.values_batch_update.assert_called_once()
        spreadsheet.worksheet.assert_not_called()
        assert set(writes) == {"account_master", *SYNC_DETAIL_SHEETS}
        assert all(row["sync_status"] == "in-sync" for row in source["account_master"])
