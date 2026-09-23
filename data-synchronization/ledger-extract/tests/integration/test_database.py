"""Actual PostgreSQL lifecycle checks using an isolated socket-only test cluster.

No Google APIs or configured databases are accessed. Each test gets its own
database cloned from the migrated template, including tests whose code commits.
Requires local initdb and pg_ctl; skips explicitly if either is unavailable.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from database import accounts, categories, subscriptions, transactions

psycopg2 = pytest.importorskip("psycopg2", reason="Database integration checks require the postgres dependency extra")
pg_sql = pytest.importorskip("psycopg2.sql")

MODULE_ROOT = Path(__file__).resolve().parents[2]
ACCOUNT_ID = "10000000-0000-0000-0000-000000000001"
CATEGORY_ID = "20000000-0000-0000-0000-000000000001"
TRANSACTION_ID = "30000000-0000-0000-0000-000000000001"
CHILD_ID = "30000000-0000-0000-0000-000000000002"
TARGET_ACCOUNT_ID = "10000000-0000-0000-0000-000000000002"
SUBSCRIPTION_ID = "40000000-0000-0000-0000-000000000001"


def _postgres_binary(name: str) -> str:
    binary = shutil.which(name)
    if binary is not None:
        return binary
    candidate = Path("/opt/homebrew/bin") / name
    if candidate.is_file():
        return str(candidate)
    pytest.skip(f"PostgreSQL integration checks require local {name}; install PostgreSQL to run them")


def _migration(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(f"integration_{path.parent.parent.name}_{path.stem}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def postgres_cluster() -> Iterator[dict[str, Any]]:
    initdb = _postgres_binary("initdb")
    pg_ctl = _postgres_binary("pg_ctl")
    if os.geteuid() == 0:
        pytest.skip("initdb requires a non-root user")
    with tempfile.TemporaryDirectory(prefix="ledger-pg-", dir="/tmp") as directory, pytest.MonkeyPatch.context() as environment:
        # Ignore libpq service/host/option environment settings from the shell.
        for name in tuple(os.environ):
            if name.startswith("PG"):
                environment.delenv(name)
        cluster_root = Path(directory)
        cluster_data = cluster_root / "data"
        socket_dir = cluster_root / "socket"
        socket_dir.mkdir(mode=0o700)
        command_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"}
        subprocess.run([initdb, "-D", str(cluster_data), "-U", "ledger_test", "--auth=trust", "--encoding=UTF8", "--no-locale"], check=True, capture_output=True, text=True, env=command_env)
        options = f"-c listen_addresses='' -k {socket_dir} -p 55433 -c fsync=off"
        password_file = cluster_root / "empty.pgpass"
        password_file.touch(mode=0o600)
        connection = dict(host=str(socket_dir), port=55433, user="ledger_test", password="", sslmode="disable", passfile=str(password_file), connect_timeout=5)
        started = False
        try:
            subprocess.run([pg_ctl, "-D", str(cluster_data), "-l", str(cluster_root / "postgres.log"), "-o", options, "-w", "start"], check=True, capture_output=True, text=True, env=command_env)
            started = True
            admin = psycopg2.connect(**connection, dbname="postgres")
            try:
                admin.autocommit = True
                with admin.cursor() as cursor:
                    cursor.execute("CREATE DATABASE ledger_template")
            finally:
                admin.close()
            template = psycopg2.connect(**connection, dbname="ledger_template")
            try:
                for module_root in (MODULE_ROOT.parent / "currency-rates", MODULE_ROOT):
                    for path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
                        _migration(path).upgrade(template)
            finally:
                template.close()
            yield connection
        finally:
            if started:
                subprocess.run([pg_ctl, "-D", str(cluster_data), "-m", "immediate", "-w", "stop"], check=True, capture_output=True, text=True, env=command_env)


@pytest.fixture
def database_client(postgres_cluster: dict[str, Any]) -> Iterator[Any]:
    database_name = f"ledger_test_{uuid4().hex}"
    admin = psycopg2.connect(**postgres_cluster, dbname="postgres")
    admin.autocommit = True
    connection = None
    try:
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("CREATE DATABASE {} TEMPLATE ledger_template").format(pg_sql.Identifier(database_name)))
        connection = psycopg2.connect(**postgres_cluster, dbname=database_name)
        yield connection
    finally:
        if connection is not None:
            connection.close()
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("DROP DATABASE IF EXISTS {}").format(pg_sql.Identifier(database_name)))
        admin.close()


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[tuple[str, list[tuple[int, int, list[str]]]]] = []

    def batch_update_rows(self, sheet_name: str, updates: list[tuple[int, int, list[str]]]) -> None:
        self.updates.append((sheet_name, list(updates)))


def _one(client: Any, sql: str, params: tuple[Any, ...] = ()) -> tuple[Any, ...]:
    with client.cursor() as cursor:
        cursor.execute(sql, params)
        result = cursor.fetchone()
    assert result is not None
    return result


def _seed_dependencies(client: Any, currency: str = "USD") -> dict[str, tuple[Any, str, str]]:
    with client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance') RETURNING id")
        rate_id = cursor.fetchone()[0]
        cursor.execute(
            """INSERT INTO account_master (
                id, account_name, account_type, account_subtype, local_currency, base_currency,
                opening_amount_local_value, opening_amount_base_value, currency_rate_id, record_status, created_at, updated_at
            ) VALUES (%s, 'Test account', 'asset', 'current', %s, 'XAU', 100000, 10000000000, %s, 'active', now(), now())""",
            (ACCOUNT_ID, currency, None if currency == "XAU" else rate_id),
        )
        cursor.execute(
            """INSERT INTO category_master (
                id, tx_type_key, tx_type_label, major_category_key, major_category_label,
                minor_category_key, minor_category_label, source_account_mandatory, target_account_mandatory,
                is_subscription_eligible, record_status, created_at, updated_at
            ) VALUES (%s, 'money-out', 'Money out', 'living', 'Living', 'food', 'Food', true, false, true, 'active', now(), now())""",
            (CATEGORY_ID,),
        )
    client.commit()
    return transactions.load_account_map(client)


def _transaction(**updates: Any) -> dict[str, Any]:
    return {
        "id": TRANSACTION_ID,
        "tx_date_local": "2026-09-18 12:00:00",
        "tx_timezone_local": "Europe/London",
        "tx_type": "money-out",
        "account_id": ACCOUNT_ID,
        "tx_amount_local": "10.015",
        "major_category": "living",
        "minor_category": "food",
        "record_status": "active",
        "sync_status": "create-pending",
        **updates,
    }


def _category(**updates: Any) -> dict[str, Any]:
    return {
        "id": CATEGORY_ID,
        "tx_type_key": "money-out",
        "tx_type_label": "Money out",
        "major_category_key": "living",
        "major_category_label": "Living",
        "minor_category_key": "food",
        "minor_category_label": "Food",
        "record_status": "active",
        "source_account_types": "current,savings",
        "source_account_mandatory": True,
        "target_account_mandatory": False,
        "sync_status": "create-pending",
        **updates,
    }


def _account(**updates: Any) -> dict[str, Any]:
    return {
        "id": ACCOUNT_ID,
        "account_name": "Test account",
        "type": "asset",
        "sub_type": "current",
        "account_currency_local": "USD",
        "local_timezone": "Europe/London",
        "account_opening_date_local": "2020-01-01 00:00:00",
        "tracking_start_date_local": "2026-09-18 12:00:00",
        "opening_value_local": "123.455",
        "record_status": "active",
        "sync_status": "create-pending",
        **updates,
    }


def _subscription(**updates: Any) -> dict[str, Any]:
    return {
        "id": SUBSCRIPTION_ID,
        "subscription_name": "Test subscription",
        "subscription_amount_local": "10.015",
        "frequency": "monthly",
        "day_of_month": "20",
        "source_account": ACCOUNT_ID,
        "tx_type": "money-out",
        "major_category": "living",
        "minor_category": "food",
        "subscription_start_date_local": "2026-09-18 12:00:00",
        "subscription_timezone_local": "Europe/London",
        "record_status": "active",
        "sync_status": "create-pending",
        **updates,
    }


def test_account_uses_current_source_fields_and_snapshot_date_rate(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance'), ('USD', '2026-09-19', 200, 'yfinance')")
    database_client.commit()
    sheets = RecordingSheets()
    assert accounts.upsert_accounts(database_client, sheets, [_account()], 1) == 0
    row = _one(database_client, "SELECT opening_amount_local_value, opening_amount_base_value, tracking_start_date_local, created_at FROM account_master WHERE id=%s", (ACCOUNT_ID,))
    assert row[:3] == (12346, 1234600000, "2026-09-18 12:00:00")
    assert accounts.upsert_accounts(database_client, sheets, [_account(sync_status="create-failed")], 1) == 0
    assert _one(database_client, "SELECT COUNT(*), MIN(created_at) FROM account_master") == (1, row[3])


def test_account_delete_and_restore_keeps_identity(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance')")
    database_client.commit()
    sheets = RecordingSheets()
    assert accounts.upsert_accounts(database_client, sheets, [_account()], 1) == 0
    for status in ("deleted", "active", "locked", "active"):
        assert accounts.upsert_accounts(database_client, sheets, [_account(record_status=status, sync_status="update-pending")], 1) == 0
        assert _one(database_client, "SELECT record_status FROM account_master WHERE id=%s", (ACCOUNT_ID,)) == (status,)


def test_account_retains_applied_rate_until_explicit_reprocessing(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance')")
    database_client.commit()
    sheets = RecordingSheets()
    assert accounts.upsert_accounts(database_client, sheets, [_account()], 1) == 0
    query = "SELECT id, created_at, opening_amount_local_value, opening_amount_base_value, applied_rate_value, currency_rate_id FROM account_master"
    original = _one(database_client, query)
    assert original[2:5] == (12346, 1234600000, Decimal("100.00000000"))
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='USD' AND rate_date='2026-09-18'")
    database_client.commit()
    assert _one(database_client, query) == original
    assert accounts.upsert_accounts(database_client, sheets, [_account(sync_status="in-sync")], 1) == 0
    assert _one(database_client, query) == original
    assert accounts.upsert_accounts(database_client, sheets, [_account(sync_status="update-pending")], 1) == 0
    corrected = _one(database_client, query)
    assert corrected[:2] == original[:2]
    assert corrected[2:5] == (12346, 617300000, Decimal("200.00000000"))
    assert corrected[5] == original[5]


def test_category_repeated_sync_preserves_sheet_uuid_and_account_type_ids(database_client: Any) -> None:
    sheets = RecordingSheets()
    with database_client.cursor() as cursor:
        cursor.execute("SELECT account_subtype, id FROM account_types ORDER BY account_subtype")
        original_types = cursor.fetchall()
    type_ids = dict(original_types)
    expected_source = sorted([(CATEGORY_ID, type_ids["current"]), (CATEGORY_ID, type_ids["savings"])])
    expected_target = [(CATEGORY_ID, type_ids["cash"])]
    original_created_at = None

    for sync_status in ("create-pending", "create-failed", "update-pending", "update-failed"):
        _migration(MODULE_ROOT / "migrations/0002_create_account_types.py").upgrade(database_client)
        row = _category(target_account_types="cash", minor_category_label=sync_status, sync_status=sync_status)
        assert categories.upsert_categories(database_client, sheets, [row], 1) == 0
        with database_client.cursor() as cursor:
            cursor.execute("SELECT id, minor_category_label, created_at FROM category_master")
            stored_categories = cursor.fetchall()
            assert len(stored_categories) == 1
            category_id, label, created_at = stored_categories[0]
            assert (category_id, label) == (CATEGORY_ID, sync_status)
            if original_created_at is None:
                original_created_at = created_at
            assert created_at == original_created_at
            cursor.execute("SELECT account_subtype, id FROM account_types ORDER BY account_subtype")
            assert cursor.fetchall() == original_types
            cursor.execute("SELECT category_id, account_type_id FROM category_source_account_types ORDER BY category_id, account_type_id")
            assert cursor.fetchall() == expected_source
            cursor.execute("SELECT category_id, account_type_id FROM category_target_account_types ORDER BY category_id, account_type_id")
            assert cursor.fetchall() == expected_target


def test_category_identity_and_junction_changes_are_atomic(database_client: Any) -> None:
    sheets = RecordingSheets()
    assert categories.upsert_categories(database_client, sheets, [_category()], 1) == 0
    assert categories.upsert_categories(database_client, sheets, [_category(minor_category_label="Bad change", source_account_types="current,not-a-subtype", sync_status="update-pending")], 1) == 1
    assert _one(database_client, "SELECT minor_category_label FROM category_master WHERE id=%s", (CATEGORY_ID,)) == ("Food",)
    assert _one(database_client, "SELECT COUNT(*) FROM category_source_account_types WHERE category_id=%s", (CATEGORY_ID,)) == (2,)
    assert categories.upsert_categories(database_client, sheets, [_category(id=str(uuid4()), minor_category_label="Wrong identity")], 1) == 1
    assert _one(database_client, "SELECT COUNT(*), MIN(minor_category_label) FROM category_master") == (1, "Food")


def test_category_rename_delete_and_restore_preserve_uuid(database_client: Any) -> None:
    sheets = RecordingSheets()
    assert categories.upsert_categories(database_client, sheets, [_category()], 1) == 0
    for status in ("deleted", "active", "locked", "active"):
        assert categories.upsert_categories(database_client, sheets, [_category(minor_category_key="groceries", record_status=status, sync_status="update-pending")], 1) == 0
        assert _one(database_client, "SELECT minor_category_key, record_status FROM category_master WHERE id=%s", (CATEGORY_ID,)) == ("groceries", status)


@pytest.mark.parametrize("entity", ["transactions", "subscriptions"])
@pytest.mark.parametrize("status", ["active", "deleted"])
def test_referenced_category_keys_require_reconciliation_but_labels_can_change(database_client: Any, entity: str, status: str) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    if entity == "transactions":
        assert transactions.upsert_transactions(database_client, sheets, [_transaction(record_status=status)], account_map) == 0
    else:
        assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription(record_status=status)], account_map) == 0
    assert categories.upsert_categories(database_client, sheets, [_category(minor_category_key="groceries", sync_status="update-pending")], 1) == 1
    assert _one(database_client, "SELECT minor_category_key, minor_category_label FROM category_master WHERE id=%s", (CATEGORY_ID,)) == ("food", "Food")
    assert categories.upsert_categories(database_client, sheets, [_category(minor_category_label="Groceries", sync_status="update-pending")], 1) == 0
    assert _one(database_client, "SELECT minor_category_key, minor_category_label FROM category_master WHERE id=%s", (CATEGORY_ID,)) == ("food", "Groceries")


def test_transaction_retry_and_update_preserve_uuid_and_exact_amount(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    row = _transaction(beneficiaries="Alice;Bob;Carol")
    assert transactions.upsert_transactions(database_client, sheets, [row], account_map) == 0
    original = _one(database_client, "SELECT id, created_at, tx_amount_local, tx_amount_base, tx_date_time_base FROM transaction_master")
    assert original[2:] == (1002, 100200000, datetime(2026, 9, 18, 11, tzinfo=timezone.utc))
    assert transactions.upsert_transactions(database_client, sheets, [row], account_map) == 0
    assert _one(database_client, "SELECT COUNT(*), MIN(created_at) FROM transaction_master") == (1, original[1])
    assert _one(database_client, "SELECT COUNT(*), SUM(split_percentage) FROM transaction_beneficiaries") == (3, Decimal("100.0000"))
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(tx_amount_local="20", beneficiaries="Alice:25;Bob:75", sync_status="update-pending")], account_map) == 0
    assert _one(database_client, "SELECT id, created_at, tx_amount_local FROM transaction_master") == (original[0], original[1], 2000)
    assert _one(database_client, "SELECT COUNT(*), SUM(split_percentage) FROM transaction_beneficiaries") == (2, Decimal("100.0000"))


def test_transaction_retains_applied_rate_until_explicit_reprocessing(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [_transaction()], account_map) == 0
    query = "SELECT id, created_at, tx_amount_local, tx_amount_base, applied_rate_value, currency_rate_id FROM transaction_master"
    original = _one(database_client, query)
    assert original[2:5] == (1002, 100200000, Decimal("100.00000000"))
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='USD' AND rate_date='2026-09-18'")
    database_client.commit()
    assert _one(database_client, query) == original
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(sync_status="in-sync")], account_map) == 0
    assert _one(database_client, query) == original
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(sync_status="update-pending")], account_map) == 0
    corrected = _one(database_client, query)
    assert corrected[:2] == original[:2]
    assert corrected[2:5] == (1002, 50100000, Decimal("200.00000000"))
    assert corrected[5] == original[5]


def test_applied_rate_migration_leaves_unknown_historical_rates_null(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    assert transactions.upsert_transactions(database_client, RecordingSheets(), [_transaction()], account_map) == 0
    original = _one(database_client, "SELECT id, tx_amount_local, tx_amount_base, currency_rate_id FROM transaction_master")
    # Reconstruct the previous schema, containing valued records but no record of
    # which historical rate value was used; migration must not guess from the FK.
    with database_client.cursor() as cursor:
        cursor.execute("ALTER TABLE account_master DROP COLUMN applied_rate_value")
        cursor.execute("ALTER TABLE transaction_master DROP COLUMN applied_rate_value")
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='USD' AND rate_date='2026-09-18'")
    database_client.commit()
    paths = list((MODULE_ROOT / "migrations").glob("0013_*.py"))
    assert len(paths) == 1
    _migration(paths[0]).upgrade(database_client)
    assert _one(database_client, "SELECT applied_rate_value FROM account_master") == (None,)
    assert _one(database_client, "SELECT applied_rate_value FROM transaction_master") == (None,)
    assert _one(database_client, "SELECT id, tx_amount_local, tx_amount_base, currency_rate_id FROM transaction_master") == original


def _seed_transfer_dependencies(database_client: Any) -> dict[str, tuple[Any, str, str]]:
    _seed_dependencies(database_client)
    with database_client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_master (
                id, account_name, account_type, account_subtype, local_currency, base_currency,
                opening_amount_local_value, opening_amount_base_value, currency_rate_id, record_status, created_at, updated_at
            ) SELECT %s, 'Transfer target', account_type, account_subtype, local_currency, base_currency,
                opening_amount_local_value, opening_amount_base_value, currency_rate_id, record_status, now(), now()
              FROM account_master WHERE id=%s""",
            (TARGET_ACCOUNT_ID, ACCOUNT_ID),
        )
        cursor.execute(
            """INSERT INTO category_master (
                id, tx_type_key, tx_type_label, major_category_key, major_category_label,
                minor_category_key, minor_category_label, source_account_mandatory, target_account_mandatory,
                is_subscription_eligible, record_status, created_at, updated_at
            ) SELECT gen_random_uuid(), 'money-in', 'Money in', major_category_key, major_category_label,
                minor_category_key, minor_category_label, false, true, false, record_status, now(), now()
              FROM category_master WHERE id=%s""",
            (CATEGORY_ID,),
        )
    database_client.commit()
    return transactions.load_account_map(database_client)


def test_transfer_child_before_parent_then_parent_update_preserves_child(database_client: Any) -> None:
    account_map = _seed_transfer_dependencies(database_client)
    sheets = RecordingSheets()
    parent = _transaction(_sheet_row_num=12)
    child = _transaction(id=CHILD_ID, parent_tx_id=TRANSACTION_ID, account_id=TARGET_ACCOUNT_ID, tx_type="money-in", _sheet_row_num=11)
    assert transactions.upsert_transactions(database_client, sheets, [child, parent], account_map) == 0
    before = _one(database_client, "SELECT id, created_at, parent_tx_id FROM transaction_master WHERE transaction_id=%s", (CHILD_ID,))
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(tx_amount_local="20", sync_status="update-pending")], account_map) == 0
    assert _one(database_client, "SELECT id, created_at, parent_tx_id FROM transaction_master WHERE transaction_id=%s", (CHILD_ID,)) == before
    assert _one(database_client, "SELECT COUNT(*) FROM transaction_master") == (2,)
    assert {update[0] for update in sheets.updates[0][1]} == {11, 12}


def test_transfer_child_failure_rolls_back_both_legs_and_references(database_client: Any) -> None:
    account_map = _seed_transfer_dependencies(database_client)
    sheets = RecordingSheets()
    parent = _transaction(counterparty_name="Transient party", beneficiaries="Transient person")
    child = _transaction(id=CHILD_ID, parent_tx_id=TRANSACTION_ID, account_id=TARGET_ACCOUNT_ID, tx_type="money-in", beneficiaries="Repeated;Repeated")
    assert transactions.upsert_transactions(database_client, sheets, [child, parent], account_map) == 2
    for table in ("transaction_master", "counterparty_master", "beneficiaries_master", "transaction_beneficiaries"):
        assert _one(database_client, f"SELECT COUNT(*) FROM {table}") == (0,)
    assert len(sheets.updates[0][1]) == 2


def test_transfer_pair_delete_and_restore_preserve_both_identities(database_client: Any) -> None:
    account_map = _seed_transfer_dependencies(database_client)
    sheets = RecordingSheets()
    parent = _transaction()
    child = _transaction(id=CHILD_ID, parent_tx_id=TRANSACTION_ID, account_id=TARGET_ACCOUNT_ID, tx_type="money-in")
    assert transactions.upsert_transactions(database_client, sheets, [parent, child], account_map) == 0
    identities = _one(database_client, "SELECT ARRAY_AGG(id ORDER BY transaction_id) FROM transaction_master")
    for status in ("deleted", "active"):
        rows = [{**row, "record_status": status, "sync_status": "update-pending"} for row in (child, parent)]
        assert transactions.upsert_transactions(database_client, sheets, rows, account_map) == 0
        assert _one(database_client, "SELECT ARRAY_AGG(id ORDER BY transaction_id) FROM transaction_master") == identities
        assert _one(database_client, "SELECT COUNT(*) FROM transaction_master WHERE record_status=%s", (status,)) == (2,)


@pytest.mark.parametrize("changes", [{"account_id": TARGET_ACCOUNT_ID}, {"tx_type": "money-in"}, {"record_status": "deleted"}])
def test_parent_only_edit_cannot_invalidate_existing_transfer_child(database_client: Any, changes: dict[str, Any]) -> None:
    account_map = _seed_transfer_dependencies(database_client)
    sheets = RecordingSheets()
    child = _transaction(id=CHILD_ID, parent_tx_id=TRANSACTION_ID, account_id=TARGET_ACCOUNT_ID, tx_type="money-in")
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(), child], account_map) == 0
    original = _one(database_client, "SELECT id, account_id, category_id, record_status FROM transaction_master WHERE transaction_id=%s", (TRANSACTION_ID,))
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(sync_status="update-pending", **changes)], account_map) == 1
    assert _one(database_client, "SELECT id, account_id, category_id, record_status FROM transaction_master WHERE transaction_id=%s", (TRANSACTION_ID,)) == original


def test_transfer_rejects_second_live_child(database_client: Any) -> None:
    account_map = _seed_transfer_dependencies(database_client)
    sheets = RecordingSheets()
    child = _transaction(id=CHILD_ID, parent_tx_id=TRANSACTION_ID, account_id=TARGET_ACCOUNT_ID, tx_type="money-in")
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(), child], account_map) == 0
    assert transactions.upsert_transactions(database_client, sheets, [{**child, "id": str(uuid4())}], account_map) == 1
    assert _one(database_client, "SELECT COUNT(*) FROM transaction_master") == (2,)


def test_transaction_update_failure_rolls_back_master_and_beneficiary_changes(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [_transaction(beneficiaries="Alice;Bob")], account_map) == 0
    original = _one(database_client, "SELECT id, tx_amount_local, updated_at FROM transaction_master")
    with database_client.cursor() as cursor:
        cursor.execute("ALTER TABLE transaction_beneficiaries ADD CONSTRAINT reject_large_test_split CHECK (split_percentage < 75) NOT VALID")
    database_client.commit()
    assert (
        transactions.upsert_transactions(
            database_client, sheets, [_transaction(tx_amount_local="50", beneficiaries="Carol", counterparty_name="Transient party", sync_status="update-pending")], account_map
        )
        == 1
    )
    assert _one(database_client, "SELECT id, tx_amount_local, updated_at FROM transaction_master") == original
    assert _one(database_client, "SELECT COUNT(*), SUM(split_percentage) FROM transaction_beneficiaries") == (2, Decimal("100.0000"))
    assert _one(database_client, "SELECT COUNT(*) FROM beneficiaries_master WHERE beneficiary_name='Carol'") == (0,)
    assert _one(database_client, "SELECT COUNT(*) FROM counterparty_master") == (0,)


def test_transaction_replay_and_tombstone_do_not_increment_account_details(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    with database_client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_deposit_details (
                account_master_id, current_balance_local_value, current_balance_base_value, local_currency, base_currency, currency_rate_id, effective_from_dt
            ) SELECT id, 100000, 10000000000, local_currency, base_currency, currency_rate_id, '2026-09-18 00:00:00Z' FROM account_master WHERE id=%s""",
            (ACCOUNT_ID,),
        )
    database_client.commit()
    original = _one(database_client, "SELECT id, current_balance_local_value, current_balance_base_value, effective_to_dt FROM account_deposit_details")
    sheets = RecordingSheets()
    for status in ("active", "deleted", "active", "locked", "active"):
        assert transactions.upsert_transactions(database_client, sheets, [_transaction(record_status=status, sync_status="update-pending")], account_map) == 0
        assert _one(database_client, "SELECT record_status FROM transaction_master") == (status,)
        assert _one(database_client, "SELECT id, current_balance_local_value, current_balance_base_value, effective_to_dt FROM account_deposit_details") == original
        assert _one(database_client, "SELECT COUNT(*) FROM account_deposit_details") == (1,)


@pytest.mark.parametrize("changes", [{"account_id": "missing"}, {"minor_category": "missing"}, {"tx_date_local": "2026-09-19 12:00:00"}])
def test_missing_transaction_dependency_writes_no_partial_data(database_client: Any, changes: dict[str, Any]) -> None:
    account_map = _seed_dependencies(database_client)
    assert transactions.upsert_transactions(database_client, RecordingSheets(), [_transaction(counterparty_name="Transient party", beneficiaries="Transient person", **changes)], account_map) == 1
    for table in ("transaction_master", "counterparty_master", "beneficiaries_master", "transaction_beneficiaries"):
        assert _one(database_client, f"SELECT COUNT(*) FROM {table}") == (0,)


def test_subscription_retry_lifecycle_and_timezone_are_preserved(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription()], account_map) == 0
    original = _one(database_client, "SELECT id, created_at, amount_local, subscription_start_date_local FROM subscription_master")
    assert original[2:] == (1002, datetime(2026, 9, 18, 11, tzinfo=timezone.utc))
    assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription(sync_status="create-failed")], account_map) == 0
    for status in ("deleted", "active", "locked", "active"):
        assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription(record_status=status, sync_status="update-pending")], account_map) == 0
        assert _one(database_client, "SELECT id, created_at, record_status FROM subscription_master") == (original[0], original[1], status)


def test_subscription_without_optional_start_date_is_supported(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    assert subscriptions.upsert_subscriptions(database_client, RecordingSheets(), [_subscription(subscription_start_date_local="")], account_map) == 0
    assert _one(database_client, "SELECT subscription_start_date_local FROM subscription_master") == (None,)


def test_full_job_recovers_missing_in_sync_rows_and_reruns_idempotently(database_client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import core.extractor as extractor

    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance')")
    database_client.commit()
    source = {
        "categories": [_category(is_subscription_eligible=True, sync_status="in-sync", _sheet_row_num=2)],
        "accounts": [_account(sync_status="in-sync", _sheet_row_num=2)],
        "transactions": [_transaction(sync_status="in-sync", _sheet_row_num=2)],
        "subscriptions": [_subscription(sync_status="in-sync", _sheet_row_num=2)],
    }
    source_modified_at = datetime(2026, 9, 18, 13, tzinfo=timezone.utc)

    class SnapshotFake(RecordingSheets):
        def __init__(self) -> None:
            super().__init__()
            self.flush_count = 0

        def capture(self, entities: list[str]) -> None:
            assert entities == list(source)

        def snapshot_rows(self, entity: str) -> list[dict[str, Any]]:
            return [row.copy() for row in source[entity]]

        def get_modified_time(self) -> datetime:
            return source_modified_at

        def flush_pending(self) -> None:
            self.flush_count += 1

    sheets = SnapshotFake()
    monkeypatch.setattr(extractor, "SnapshotSheetsClient", lambda *_args: sheets)
    # Only the connection factory is replaced; every SQL operation hits PostgreSQL.
    monkeypatch.setattr(extractor, "get_client", lambda _config: psycopg2.connect(database_client.dsn))
    job = extractor.LedgerExtractJob(None, "test-spreadsheet", "not-a-credential-file")
    config = {"entities": {entity: {"enabled": True} for entity in source}}
    job.run(config)
    identity_before = _one(database_client, "SELECT id, created_at, updated_at FROM transaction_master")
    for table in ("category_master", "account_master", "transaction_master", "subscription_master"):
        assert _one(database_client, f"SELECT COUNT(*) FROM {table}") == (1,)
    assert _one(database_client, "SELECT last_sheet_modified_at FROM job_execution_details WHERE job_name='ledger-extract'") == (source_modified_at,)
    job.run(config)
    assert _one(database_client, "SELECT id, created_at, updated_at FROM transaction_master") == identity_before
    assert sheets.flush_count == 2
    assert len(sheets.updates) == 4  # Recovery acknowledgements only, none on the clean rerun.


def test_legacy_transaction_migration_refuses_to_discard_history(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("CREATE TABLE transactions (legacy_id INTEGER)")
        cursor.execute("INSERT INTO transactions VALUES (42)")
    database_client.commit()
    with pytest.raises(psycopg2.Error, match="Legacy transactions contains data"):
        _migration(MODULE_ROOT / "migrations/0005_create_transactions.py").upgrade(database_client)
    database_client.rollback()
    assert _one(database_client, "SELECT legacy_id FROM transactions") == (42,)


def test_legacy_transaction_migration_removes_only_empty_legacy_table(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("CREATE TABLE transactions (legacy_id INTEGER)")
    database_client.commit()
    _migration(MODULE_ROOT / "migrations/0005_create_transactions.py").upgrade(database_client)
    assert _one(database_client, "SELECT to_regclass('public.transactions')") == (None,)
