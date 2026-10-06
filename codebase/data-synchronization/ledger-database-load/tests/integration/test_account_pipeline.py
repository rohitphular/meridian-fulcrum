"""Load staged account/detail snapshots against PostgreSQL and acknowledge their outcomes."""

from typing import Any
from uuid import uuid4

import psycopg2
import pytest

import core.loader as loader
from core.account_detail_contracts import CONTRACTS, SYNC_DETAIL_SHEETS
from core.source_contracts import HEADERS
from tests.integration.postgres_support import acknowledge, stage, subtype_for_detail


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
    monkeypatch.setattr(loader, "get_client", lambda _config: psycopg2.connect(database_client.dsn))
    job = loader.LedgerDatabaseLoadJob(None)

    def run(*, reprocess: bool = False) -> list[str]:
        """Extract (stage the fixture rows), load, then acknowledge; returns the acknowledged tabs."""
        stage(database_client, source, HEADERS)
        job.run(reprocess=reprocess)
        return acknowledge(database_client, source)

    return run, source, job


def test_full_account_pipeline_skips_revalues_and_recovers_without_changing_source_identity(database_client: Any, account_pipeline: tuple) -> None:
    run, source, _ = account_pipeline
    assert set(run()) == {"account_master", *SYNC_DETAIL_SHEETS}
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id, created_at, current_value_local_value, current_value_base_value FROM account_investment_property")
        property_before = cursor.fetchone()
        assert property_before[2:] == (12534, 1253400000)
        cursor.execute("SELECT units_held, current_value_local_value, current_value_base_value FROM account_investment_stocks")
        assert cursor.fetchone() == (None, None, None)
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='GBP'")
    database_client.commit()
    # Every row is in-sync now: nothing is loaded or acknowledged.
    assert run() == []
    with database_client.cursor() as cursor:
        cursor.execute("SELECT current_value_base_value FROM account_investment_property")
        assert cursor.fetchone() == (property_before[3],)
    run(reprocess=True)
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id, created_at, current_value_local_value, current_value_base_value FROM account_investment_property")
        assert cursor.fetchone() == (*property_before[:3], 626700000)
        cursor.execute("DELETE FROM account_investment_stocks")
        cursor.execute("DELETE FROM account_master WHERE id=%s", (source["account_investment_stocks"][0]["account_id"],))
    database_client.commit()
    assert set(run()) == {"account_master", "account_investment_stocks"}
    for name in ("account_master", *SYNC_DETAIL_SHEETS):
        for row in source[name]:
            assert row["sync_status"] == "in-sync"
            assert row["created_at"] == "2020-01-01T00:00:00Z"
            assert row["updated_at"] == "2020-02-01T00:00:00Z"


def test_unacknowledged_load_replays_all_account_families_safely(database_client: Any, account_pipeline: tuple) -> None:
    run, source, job = account_pipeline
    # Load without acknowledging (the acknowledge step failed): the Sheet stays pending.
    stage(database_client, source, HEADERS)
    job.run()
    before = {}
    with database_client.cursor() as cursor:
        for name, spec in CONTRACTS.items():
            cursor.execute(f"SELECT id, created_at FROM {spec.target_table} WHERE source_sheet=%s", (name,))
            before[name] = cursor.fetchone()
            assert before[name][0] == source[name][0]["id"]
    assert set(run()) == {"account_master", *SYNC_DETAIL_SHEETS}
    with database_client.cursor() as cursor:
        for name, spec in CONTRACTS.items():
            cursor.execute(f"SELECT id, created_at FROM {spec.target_table} WHERE source_sheet=%s", (name,))
            assert cursor.fetchone() == before[name]


@pytest.mark.parametrize("account_pipeline", [23], indirect=True)
def test_twenty_three_accounts_load_from_staging_in_normal_and_hard_sync(database_client: Any, account_pipeline: tuple) -> None:
    run, source, _ = account_pipeline
    for reprocess in (False, True):
        assert set(run(reprocess=reprocess)) == {"account_master", *SYNC_DETAIL_SHEETS}
        assert all(row["sync_status"] == "in-sync" for row in source["account_master"])
    with database_client.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM account_master")
        assert cursor.fetchone() == (23,)


def test_hard_sync_reloads_an_acknowledged_snapshot_for_a_fresh_acknowledge(database_client: Any, account_pipeline: tuple) -> None:
    run, source, job = account_pipeline
    assert set(run()) == {"account_master", *SYNC_DETAIL_SHEETS}
    # No new extract: normal-sync has nothing to load, hard-sync re-loads the same run.
    job.run()
    assert acknowledge(database_client, source) == []
    job.run(reprocess=True)
    assert set(acknowledge(database_client, source)) == {"account_master", *SYNC_DETAIL_SHEETS}
    with database_client.cursor() as cursor:
        cursor.execute("SELECT status, load_mode, acknowledged_at IS NOT NULL FROM stg_runs ORDER BY captured_at DESC LIMIT 1")
        assert cursor.fetchone() == ("acknowledged", "hard-sync", True)
