"""Actual PostgreSQL lifecycle checks using an isolated socket-only test cluster.

No Google APIs or configured databases are accessed. Each test gets its own
database cloned from the migrated template, including tests whose code commits.
Requires local initdb and pg_ctl; skips explicitly if either is unavailable.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

import pytest

from core.account_detail_contracts import CONTRACTS
from database import account_details, accounts, categories, subscriptions, transactions
from tests.integration.postgres_support import MODULE_ROOT, configure_test_account_types, subtype_for_detail
from tests.integration.postgres_support import migration as _migration

psycopg2 = pytest.importorskip("psycopg2", reason="Database integration checks require the postgres dependency extra")

ACCOUNT_ID = "10000000-0000-0000-0000-000000000001"
CATEGORY_ID = "20000000-0000-0000-0000-000000000001"
TRANSACTION_ID = "30000000-0000-0000-0000-000000000001"
CHILD_ID = "30000000-0000-0000-0000-000000000002"
TARGET_ACCOUNT_ID = "10000000-0000-0000-0000-000000000002"
SUBSCRIPTION_ID = "40000000-0000-0000-0000-000000000001"


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


@pytest.mark.parametrize("database_client", [13], indirect=True)
def test_account_type_key_label_migration_preserves_existing_identities_and_links(database_client: Any) -> None:
    _seed_dependencies(database_client)
    with database_client.cursor() as cursor:
        cursor.execute(
            "INSERT INTO category_source_account_types SELECT %s, id FROM account_types WHERE account_subtype = 'current'",
            (CATEGORY_ID,),
        )
        cursor.execute(
            "INSERT INTO category_target_account_types SELECT %s, id FROM account_types WHERE account_subtype = 'cash'",
            (CATEGORY_ID,),
        )
        cursor.execute("""
            INSERT INTO account_types (account_type, account_subtype, description, record_status, created_at, updated_at)
            VALUES ('asset', 'custom_savings', 'Keep custom metadata', 'inactive', '2020-01-01 UTC', '2020-01-01 UTC')
        """)
        cursor.execute("SELECT id, account_type, account_subtype, description, record_status, created_at FROM account_types ORDER BY id")
        original_types = cursor.fetchall()
        cursor.execute("SELECT category_id, account_type_id FROM category_source_account_types UNION ALL SELECT category_id, account_type_id FROM category_target_account_types ORDER BY 2")
        original_links = cursor.fetchall()
    database_client.commit()

    _migration(MODULE_ROOT / "migrations/0014_account_type_keys_and_labels.py").upgrade(database_client)

    with database_client.cursor() as cursor:
        cursor.execute("SELECT id, account_type_key, account_subtype_key, description, record_status, created_at FROM account_types ORDER BY id")
        assert cursor.fetchall() == original_types
        cursor.execute("SELECT category_id, account_type_id FROM category_source_account_types UNION ALL SELECT category_id, account_type_id FROM category_target_account_types ORDER BY 2")
        assert cursor.fetchall() == original_links
        cursor.execute("SELECT DISTINCT account_type_key, account_type_label FROM account_types ORDER BY account_type_key")
        assert cursor.fetchall() == [("asset", "Asset"), ("investment", "Investment"), ("liability", "Liability")]
        cursor.execute("SELECT account_subtype_key, account_subtype_label FROM account_types")
        labels = dict(cursor.fetchall())
        assert {key: labels[key] for key in ("stocks_shares", "p2p_lending", "pension_sipp", "fixed_deposit", "isa", "custom_savings")} == {
            "stocks_shares": "Stocks & Shares",
            "p2p_lending": "P2P Lending",
            "pension_sipp": "Pension / SIPP",
            "fixed_deposit": "Fixed Deposit",
            "isa": "ISA",
            "custom_savings": "Custom Savings",
        }
        cursor.execute("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account_types'")
        columns = dict(cursor.fetchall())
        assert set(columns) == {"id", "account_type_key", "account_subtype_key", "account_type_label", "account_subtype_label", "description", "record_status", "created_at", "updated_at"}
        assert columns["account_type_label"] == columns["account_subtype_label"] == "NO"
        cursor.execute("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'fk_am_account_type_subtype'")
        assert "REFERENCES account_types(account_type_key, account_subtype_key)" in cursor.fetchone()[0]
    assert _one(database_client, "SELECT id, account_type, account_subtype FROM account_master") == (ACCOUNT_ID, "asset", "current")
    with pytest.raises(psycopg2.errors.ForeignKeyViolation), database_client.cursor() as cursor:
        cursor.execute("UPDATE account_master SET account_subtype = 'missing' WHERE id = %s", (ACCOUNT_ID,))
    database_client.rollback()
    with pytest.raises(psycopg2.errors.UniqueViolation), database_client.cursor() as cursor:
        cursor.execute("""
            INSERT INTO account_types (account_type_key, account_subtype_key, account_type_label, account_subtype_label, created_at, updated_at)
            VALUES ('asset', 'current', 'Asset', 'Current', now(), now())
        """)
    database_client.rollback()


def test_account_and_category_sync_resolve_keys_independently_of_labels(database_client: Any) -> None:
    sheets = RecordingSheets()
    original_type_id = _one(database_client, "SELECT id FROM account_types WHERE account_type_key = 'asset' AND account_subtype_key = 'current'")[0]
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE account_types SET account_type_label = 'Custom type label', account_subtype_label = 'Custom subtype label' WHERE id = %s", (original_type_id,))
    database_client.commit()
    assert accounts.upsert_accounts(database_client, sheets, [_account(account_currency_local="XAU", opening_value_local="0")], 1) == 0
    assert categories.upsert_categories(database_client, sheets, [_category(source_account_types="current,investment")], 1) == 0
    assert _one(database_client, "SELECT COUNT(*) FROM category_source_account_types WHERE category_id = %s", (CATEGORY_ID,)) == (11,)
    assert _one(database_client, "SELECT category_id FROM category_source_account_types WHERE account_type_id = %s", (original_type_id,)) == (CATEGORY_ID,)
    assert _one(database_client, "SELECT id, account_type_label, account_subtype_label FROM account_types WHERE id = %s", (original_type_id,)) == (
        original_type_id,
        "Custom type label",
        "Custom subtype label",
    )


def test_account_type_model_matches_migrated_schema(database_client: Any) -> None:
    from database.models.account_types import COLS, Row

    with database_client.cursor() as cursor:
        cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account_types' ORDER BY ordinal_position")
        assert COLS == [column[0] for column in cursor.fetchall()]
    assert set(Row.__annotations__) == set(COLS)


def test_category_repeated_sync_preserves_sheet_uuid_and_account_type_ids(database_client: Any) -> None:
    sheets = RecordingSheets()
    with database_client.cursor() as cursor:
        cursor.execute("SELECT account_subtype_key, id FROM account_types ORDER BY account_subtype_key")
        original_types = cursor.fetchall()
    type_ids = dict(original_types)
    expected_source = sorted([(CATEGORY_ID, type_ids["current"]), (CATEGORY_ID, type_ids["savings"])])
    expected_target = [(CATEGORY_ID, type_ids["cash"])]
    original_created_at = None

    for sync_status in ("create-pending", "create-failed", "update-pending", "update-failed"):
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
            cursor.execute("SELECT account_subtype_key, id FROM account_types ORDER BY account_subtype_key")
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


@pytest.mark.parametrize("entity", ["transaction_master", "subscription_master"])
@pytest.mark.parametrize("status", ["active", "deleted"])
def test_referenced_category_keys_require_reconciliation_but_labels_can_change(database_client: Any, entity: str, status: str) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    if entity == "transaction_master":
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
            """INSERT INTO account_deposit (
                account_master_id, current_balance_local_value, current_balance_base_value, local_currency, base_currency, currency_rate_id, effective_from_dt
            ) SELECT id, 100000, 10000000000, local_currency, base_currency, currency_rate_id, '2026-09-18 00:00:00Z' FROM account_master WHERE id=%s""",
            (ACCOUNT_ID,),
        )
    database_client.commit()
    original = _one(database_client, "SELECT id, current_balance_local_value, current_balance_base_value, effective_to_dt FROM account_deposit")
    sheets = RecordingSheets()
    for status in ("active", "deleted", "active", "locked", "active"):
        assert transactions.upsert_transactions(database_client, sheets, [_transaction(record_status=status, sync_status="update-pending")], account_map) == 0
        assert _one(database_client, "SELECT record_status FROM transaction_master") == (status,)
        assert _one(database_client, "SELECT id, current_balance_local_value, current_balance_base_value, effective_to_dt FROM account_deposit") == original
        assert _one(database_client, "SELECT COUNT(*) FROM account_deposit") == (1,)


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
        "category_master": [_category(is_subscription_eligible=True, sync_status="in-sync", _sheet_row_num=2)],
        "account_master": [_account(sync_status="in-sync", _sheet_row_num=2)],
        "transaction_master": [_transaction(sync_status="in-sync", _sheet_row_num=2)],
        "subscription_master": [_subscription(sync_status="in-sync", _sheet_row_num=2)],
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

        def assert_unchanged(self) -> None:
            pass

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
    assert [name for name, _updates in sheets.updates] == ["category_master", "account_master", "transaction_master", "subscription_master"]


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


def _detail_account(client: Any, subtype: str, currency: str = "USD") -> str:
    identity = str(uuid4())
    with client.cursor() as cursor:
        cursor.execute("SELECT account_type_key FROM account_types WHERE account_subtype_key=%s", (subtype,))
        registered = cursor.fetchone()
        if registered is None:
            subtype = subtype.replace("-", "_")  # Historical migration fixtures predate key conversion.
            cursor.execute("SELECT account_type_key FROM account_types WHERE account_subtype_key=%s", (subtype,))
            registered = cursor.fetchone()
        account_type = registered[0]
        cursor.execute(
            """INSERT INTO account_master (id, account_name, account_type, account_subtype, opening_amount_local_value,
               opening_amount_base_value, local_currency, base_currency, record_status, created_at, updated_at)
               VALUES (%s,'Detail account',%s,%s,0,0,%s,'XAU','active',now(),now())""",
            (identity, account_type, subtype, currency),
        )
    client.commit()
    return identity


def _detail_row(sheet: str, account_id: str, **changes: Any) -> dict[str, Any]:
    examples = {
        "account_deposit": {"is_interest_paid": True, "interest_rate": "125.123456789012345678", "rate_type": "fixed", "interest_payment_frequency": "annually"},
        "account_liability_credit_card": {"credit_limit_local": "0", "interest_rate": "110", "payment_month_day": 15, "statement_month_day": 31},
        "account_liability_mortgage": {"original_principal_local": "150.335", "monthly_payment_local": "0", "term_months": 24, "maturity_date_local": "2028-09-18"},
        "account_liability_personal_loan": {"original_principal_local": "100", "term_months": 12},
        "account_investment_property": {"acquisition_type": "INHERITED", "current_value_local": "0", "is_rented": False, "property_ownership_percentage": "50", "rent_amount_local": "0"},
        "account_investment_stocks": {
            "instrument_type": "OPTION",
            "instrument_name": "Precise option",
            "position_side": "SHORT",
            "quantity": "-0.000000000000000001",
            "cost_basis_local": "-2.345",
            "current_value_local": "-12.345",
            "avg_cost_price_local": "-10.000000000000000001",
            "current_price_local": "-0.001234567890123456",
            "strike_price_local": "-0.00001",
            "contract_multiplier": "100",
        },
    }
    metadata = {}
    if "sync_status" in CONTRACTS[sheet].headers:
        metadata = {"record_status": "active", "sync_status": "create-pending", "created_at": "2000-01-01T00:00:00Z", "updated_at": "2000-01-02T00:00:00Z"}
    return {"id": str(uuid4()), "account_id": account_id, "account_name": "Source display label", **examples[sheet], **metadata, **changes}


@pytest.mark.parametrize("sheet", list(CONTRACTS))
def test_all_detail_contracts_insert_retry_hard_sync_and_clear_optional_values(database_client: Any, sheet: str) -> None:
    spec = CONTRACTS[sheet]
    account_id = _detail_account(database_client, subtype_for_detail(database_client, sheet))
    row = _detail_row(sheet, account_id)
    assert account_details.sync_details(database_client, sheet, [row]) == {"created": 1, "updated": 0, "unchanged": 0}
    original = _one(database_client, f"SELECT id, created_at, updated_at, source_sheet, effective_from_dt, effective_to_dt FROM {spec.target_table}")
    assert original[0] == row["id"]
    assert original[3:] == (sheet, None, None)
    assert account_details.sync_details(database_client, sheet, [row]) == {"created": 0, "updated": 0, "unchanged": 1}
    assert _one(database_client, f"SELECT id, created_at, updated_at, source_sheet, effective_from_dt, effective_to_dt FROM {spec.target_table}") == original
    assert account_details.sync_details(database_client, sheet, [row], reprocess=True) == {"created": 0, "updated": 1, "unchanged": 0}
    assert _one(database_client, f"SELECT id, created_at FROM {spec.target_table}") == original[:2]
    optional = "instrument_name" if sheet == "account_investment_stocks" else "account_name"
    row[optional] = ""
    assert account_details.sync_details(database_client, sheet, [row])["updated"] == 1
    assert _one(database_client, f"SELECT {spec.field_map[optional]} FROM {spec.target_table}") == (None,)


def test_detail_multiple_positions_and_separate_loan_tables_keep_source_ids(database_client: Any) -> None:
    account_id = _detail_account(database_client, "stocks-shares")
    rows = [_detail_row("account_investment_stocks", account_id) for _ in range(2)]
    assert account_details.sync_details(database_client, "account_investment_stocks", rows)["created"] == 2
    assert _one(database_client, "SELECT COUNT(*), MIN(units_held), MIN(avg_cost_price_local), MIN(current_value_local_value), MIN(cost_basis_base_value) FROM account_investment_stocks") == (
        2,
        Decimal("-0.000000000000000001"),
        Decimal("-10.000000000000000001"),
        -1235,
        None,
    )
    for sheet in ("account_liability_mortgage", "account_liability_personal_loan"):
        master = _detail_account(database_client, subtype_for_detail(database_client, sheet))
        account_details.sync_details(database_client, sheet, [_detail_row(sheet, master)])
        assert _one(database_client, f"SELECT COUNT(*), COUNT(DISTINCT source_sheet), COUNT(outstanding_balance_local_value), COUNT(start_date) FROM {sheet}") == (1, 1, 0, 0)


def test_detail_retry_is_unchanged_with_native_uuid_database_codec(database_client: Any) -> None:
    from psycopg2.extras import register_uuid

    register_uuid(conn_or_curs=database_client)
    master = _detail_account(database_client, "current")
    row = _detail_row("account_deposit", master)
    assert account_details.sync_details(database_client, "account_deposit", [row])["created"] == 1
    assert account_details.sync_details(database_client, "account_deposit", [row])["unchanged"] == 1


def test_property_values_are_not_multiplied_by_ownership_or_rental_shares(database_client: Any) -> None:
    master = _detail_account(database_client, "property", "XAU")
    row = _detail_row("account_investment_property", master, current_value_local="100", property_ownership_percentage="25", rent_amount_local="20", rent_ownership_percentage="50")
    account_details.sync_details(database_client, "account_investment_property", [row])
    assert _one(database_client, "SELECT current_value_local_value,rent_amount_local_value,purchase_price_local_value,monthly_rental_income_local_value FROM account_investment_property") == (
        100000000000,
        20000000000,
        None,
        None,
    )


def test_detail_rate_values_apply_only_to_dated_current_marks(database_client: Any) -> None:
    master = _detail_account(database_client, "stocks-shares", "GBP")
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD','2026-09-18',100,'yfinance'),('USD','2026-09-19',200,'yfinance')")
    database_client.commit()
    row = _detail_row("account_investment_stocks", master, instrument_currency_local="USD", current_value_local="10.015", cost_basis_local="8", price_asof_date="2026-09-18")
    account_details.sync_details(database_client, "account_investment_stocks", [row])
    assert _one(
        database_client,
        "SELECT local_currency, instrument_currency_local, current_value_local_value, current_value_base_value, cost_basis_base_value, applied_rate_value FROM account_investment_stocks",
    ) == (
        "USD",
        "USD",
        1002,
        100200000,
        None,
        Decimal("100"),
    )
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='USD' AND rate_date='2026-09-18'")
    database_client.commit()
    assert account_details.sync_details(database_client, "account_investment_stocks", [row])["unchanged"] == 1
    assert _one(database_client, "SELECT current_value_base_value,applied_rate_value FROM account_investment_stocks") == (100200000, Decimal("100"))
    assert account_details.sync_details(database_client, "account_investment_stocks", [row], reprocess=True)["updated"] == 1
    assert _one(database_client, "SELECT current_value_base_value,applied_rate_value FROM account_investment_stocks") == (50100000, Decimal("200"))
    row["price_asof_date"] = ""
    account_details.sync_details(database_client, "account_investment_stocks", [row])
    assert _one(database_client, "SELECT current_value_base_value,currency_rate_id,applied_rate_value FROM account_investment_stocks") == (None, None, None)


def test_property_valuation_uses_date_and_preserves_retired_database_rate_reference(database_client: Any) -> None:
    sheet = "account_investment_property"
    master = _detail_account(database_client, "property")
    rate_ids = [str(uuid4()) for _ in range(3)]
    with database_client.cursor() as cursor:
        for rate_id, date, rate in zip(rate_ids, ("2026-09-16", "2026-09-17", "2026-09-19"), (50, 100, 200), strict=True):
            cursor.execute("INSERT INTO currency_rates (id,quote_currency_code,rate_date,rate_value,rate_source) VALUES (%s,'USD',%s,%s,'test')", (rate_id, date, rate))
    database_client.commit()
    row = _detail_row(sheet, master, current_value_local="100", evaluation_currency_rate_id=rate_ids[0], current_value_evaluation_date="2026-09-18")
    assert account_details.sync_details(database_client, sheet, [row])["created"] == 1
    assert _one(database_client, "SELECT evaluation_currency_rate_id,currency_rate_id,applied_rate_value,current_value_base_value FROM account_investment_property") == (
        None,
        rate_ids[1],
        Decimal(100),
        1000000000,
    )
    # Retired references from older imports remain historical values and cannot
    # override the current source's dated valuation, including during replay.
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE account_investment_property SET evaluation_currency_rate_id=%s WHERE id=%s", (rate_ids[2], row["id"]))
    database_client.commit()
    assert account_details.sync_details(database_client, sheet, [{**row, "evaluation_currency_rate_id": "invalid-retired-id"}], reprocess=True)["updated"] == 1
    assert _one(database_client, "SELECT evaluation_currency_rate_id,currency_rate_id,applied_rate_value,current_value_base_value FROM account_investment_property") == (
        rate_ids[2],
        rate_ids[1],
        Decimal(100),
        1000000000,
    )
    # Without a date, neither a stale extra source column nor the retained DB
    # reference supplies a current foreign-currency valuation.
    assert account_details.sync_details(database_client, sheet, [{**row, "current_value_evaluation_date": ""}])["updated"] == 1
    assert _one(database_client, "SELECT evaluation_currency_rate_id,currency_rate_id,applied_rate_value,current_value_base_value FROM account_investment_property") == (
        rate_ids[2],
        None,
        None,
        None,
    )


def test_detail_xau_money_uses_identity_without_inventing_a_rate_reference(database_client: Any) -> None:
    master = _detail_account(database_client, "stocks-shares", "XAU")
    row = _detail_row("account_investment_stocks", master, current_value_local="-0.000000001", cost_basis_local="2")
    account_details.sync_details(database_client, "account_investment_stocks", [row])
    assert _one(database_client, "SELECT current_value_local_value,current_value_base_value,cost_basis_base_value,currency_rate_id,applied_rate_value FROM account_investment_stocks") == (
        -1,
        -1,
        2000000000,
        None,
        Decimal(1),
    )


def test_detail_whole_tab_rolls_back_invalid_row_and_source_edit(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    row = _detail_row("account_deposit", master)
    account_details.sync_details(database_client, "account_deposit", [row])
    original = _one(database_client, "SELECT id,interest_rate,updated_at FROM account_deposit")
    changed = {**row, "interest_rate": "8"}
    invalid = _detail_row("account_deposit", master, _sheet_row_num=20, interest_rate="NaN")
    with pytest.raises(ValueError, match="account_detail_error:account_deposit:row=20:"):
        account_details.sync_details(database_client, "account_deposit", [changed, invalid])
    assert _one(database_client, "SELECT id,interest_rate,updated_at FROM account_deposit") == original

    def source_changed() -> None:
        raise RuntimeError("sheet_changed_before_commit")

    with pytest.raises(RuntimeError, match="sheet_changed_before_commit"):
        account_details.sync_details(database_client, "account_deposit", [changed], before_commit=source_changed)
    assert _one(database_client, "SELECT id,interest_rate,updated_at FROM account_deposit") == original


def test_detail_collisions_and_master_subtype_guards_preserve_previous_records(database_client: Any) -> None:
    master = _detail_account(database_client, "mortgage")
    property_id = _detail_account(database_client, "property")
    mortgage = _detail_row("account_liability_mortgage", master, linked_property_account_id=property_id)
    account_details.sync_details(database_client, "account_liability_mortgage", [mortgage])
    other_master = _detail_account(database_client, "personal-loan")
    assert account_details.sync_details(database_client, "account_liability_personal_loan", [_detail_row("account_liability_personal_loan", other_master, id=mortgage["id"])])["created"] == 1
    another_mortgage = _detail_account(database_client, "mortgage")
    with pytest.raises(ValueError, match="detail_account_move_rejected"):
        account_details.sync_details(database_client, "account_liability_mortgage", [{**mortgage, "account_id": another_mortgage}])
    with pytest.raises(ValueError, match="subtype_conflicts_with_account_details"):
        account_details.validate_account_change(database_client, master, "personal-loan")
    with pytest.raises(ValueError, match="subtype_conflicts_with_linked_property"):
        account_details.validate_account_change(database_client, property_id, "stocks-shares")
    assert _one(database_client, "SELECT account_master_id,linked_property_account_id FROM account_liability_mortgage") == (master, property_id)


@pytest.mark.parametrize(
    ("sheet", "field"),
    [("account_liability_mortgage", "original_principal_local"), ("account_liability_personal_loan", "original_principal_local")],
)
def test_detail_required_positive_amount_cannot_round_to_zero(database_client: Any, sheet: str, field: str) -> None:
    master = _detail_account(database_client, subtype_for_detail(database_client, sheet))
    with pytest.raises(ValueError, match="positive_amount_rounds_to_zero"):
        account_details.sync_details(database_client, sheet, [_detail_row(sheet, master, **{field: "0.001"})])
    assert _one(database_client, f"SELECT COUNT(*) FROM {CONTRACTS[sheet].target_table}") == (0,)


@pytest.mark.parametrize("problem", ["missing", "wrong_currency", "future"])
@pytest.mark.parametrize("sheet", ["account_investment_stocks"])
def test_detail_explicit_valuation_rate_is_validated_before_any_write(database_client: Any, sheet: str, problem: str) -> None:
    master = _detail_account(database_client, subtype_for_detail(database_client, sheet))
    rate_id = str(uuid4())
    if problem != "missing":
        with database_client.cursor() as cursor:
            cursor.execute(
                "INSERT INTO currency_rates (id,quote_currency_code,rate_date,rate_value,rate_source) VALUES (%s,%s,%s,100,'test')",
                (rate_id, "EUR" if problem == "wrong_currency" else "USD", "2026-09-19"),
            )
        database_client.commit()
    date_field = "price_asof_date" if sheet == "account_investment_stocks" else "current_value_evaluation_date"
    row = _detail_row(sheet, master, current_value_local="100", evaluation_currency_rate_id=rate_id, **{date_field: "2026-09-18"})
    with pytest.raises(ValueError, match="evaluation_rate_"):
        account_details.sync_details(database_client, sheet, [row])
    assert _one(database_client, f"SELECT COUNT(*) FROM {CONTRACTS[sheet].target_table}") == (0,)


def test_detail_migrations_preserve_supported_legacy_columns(database_client: Any) -> None:
    # This database belongs exclusively to this test. Build the pre-0015 schema.
    with database_client.cursor() as cursor:
        cursor.execute("DROP SCHEMA public CASCADE")
        cursor.execute("CREATE SCHEMA public")
    database_client.commit()
    for module_root in (MODULE_ROOT.parent / "currency-rates", MODULE_ROOT):
        for path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
            if module_root == MODULE_ROOT and int(path.name[:4]) >= 15:
                continue
            _migration(path).upgrade(database_client)
    master = _detail_account(database_client, "current")
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code,rate_date,rate_value,rate_source) VALUES ('USD','2026-09-18',100,'test') RETURNING id")
        rate_id = cursor.fetchone()[0]
    old_rows = {}
    destinations = {
        "account_deposit_details": ("account_deposit", "current"),
        "account_market_investment_details": ("account_investment_stocks", "stocks-shares"),
        "account_property_details": ("account_investment_property", "property"),
        "account_revolving_credit_details": ("account_liability_credit_card", "credit-card"),
        "account_installment_loan_details": ("account_liability_mortgage", "mortgage"),
    }
    tables = sorted(destinations)
    for table in tables:
        owner = master if destinations[table][1] == "current" else _detail_account(database_client, destinations[table][1])
        with database_client.cursor() as cursor:
            cursor.execute("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=%s AND is_nullable='NO' ORDER BY ordinal_position", (table,))
            values = {}
            for column, data_type in cursor.fetchall():
                if column == "id":
                    values[column] = str(uuid4())
                elif column == "account_master_id":
                    values[column] = owner
                elif column == "local_currency":
                    values[column] = "USD"
                elif column == "base_currency":
                    values[column] = "XAU"
                elif data_type == "bigint":
                    values[column] = 1000
                elif column == "rate_type":
                    values[column] = "fixed"
                elif data_type == "numeric":
                    values[column] = Decimal("2.5")
                elif data_type == "integer":
                    values[column] = 120
                elif data_type == "boolean":
                    values[column] = False
                elif data_type == "date":
                    values[column] = "2020-01-01" if column == "start_date" else "2030-01-01"
                elif column == "effective_from_dt":
                    values[column] = "2020-01-01T00:00:00Z"
                else:
                    raise AssertionError(f"Unhandled legacy test field: {table}.{column}")
            values["currency_rate_id"] = rate_id
            cursor.execute(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join(['%s'] * len(values))})", tuple(values.values()))
            cursor.execute(f"SELECT * FROM {table}")
            old_rows[table] = ([column.name for column in cursor.description], cursor.fetchone())
    database_client.commit()
    _migration(MODULE_ROOT / "migrations/0015_account_detail_sheet_contracts.py").upgrade(database_client)
    _migration(MODULE_ROOT / "migrations/0016_account_detail_sync_metadata.py").upgrade(database_client)
    _migration(MODULE_ROOT / "migrations/0017_account_opening_signs.py").upgrade(database_client)
    _migration(MODULE_ROOT / "migrations/0018_align_account_detail_tables.py").upgrade(database_client)
    for old_table, (columns, original) in old_rows.items():
        table = destinations[old_table][0]
        assert _one(database_client, f"SELECT {','.join(columns)} FROM {table}") == original
        assert _one(database_client, f"SELECT source_sheet,created_at,updated_at FROM {table}") == (None, None, None)
    deposit_id = old_rows["account_deposit_details"][1][0]
    _migration(MODULE_ROOT / "migrations/0019_account_types_sheet_sync.py").upgrade(database_client)
    _migration(MODULE_ROOT / "migrations/0020_account_type_policies_and_hyphen_keys.py").upgrade(database_client)
    configure_test_account_types(database_client)
    with pytest.raises(ValueError, match="legacy_id_collision"):
        account_details.sync_details(database_client, "account_deposit", [_detail_row("account_deposit", master, id=deposit_id)])
    assert account_details.sync_details(database_client, "account_deposit", [_detail_row("account_deposit", master)])["created"] == 1
    assert _one(database_client, "SELECT COUNT(*) FROM account_deposit") == (2,)


@pytest.mark.parametrize(
    "sheet",
    ["account_deposit", "account_liability_credit_card", "account_liability_mortgage", "account_liability_personal_loan", "account_investment_property", "account_investment_stocks"],
)
def test_managed_details_acknowledge_pending_rows_only_and_preserve_source_audit_fields(database_client: Any, sheet: str) -> None:
    spec = CONTRACTS[sheet]
    master = _detail_account(database_client, subtype_for_detail(database_client, sheet))
    row = _detail_row(sheet, master, _sheet_row_num=15)
    sheets = RecordingSheets()
    assert account_details.upsert_details(database_client, sheets, sheet, [row]) == 0
    original = _one(database_client, f"SELECT id,record_status,created_at,updated_at FROM {spec.target_table}")
    assert original[0:2] == (row["id"], "active")
    assert original[2] != datetime(2000, 1, 1, tzinfo=timezone.utc)
    name, updates = sheets.updates[-1]
    assert name == sheet
    assert len(updates) == 1
    number, column, values = updates[0]
    assert number == 15
    assert spec.headers[column - 1 : column + 2] == ("sync_status", "sync_date", "sync_notes")
    assert values[0] == "in-sync" and values[2] == "" and len(values) == 3
    # Source ingestion/audit metadata changes alone must not rewrite the DB row.
    assert account_details.upsert_details(database_client, sheets, sheet, [{**row, "sync_status": "create-failed", "updated_at": "2026-09-24T12:00:00Z"}]) == 0
    assert _one(database_client, f"SELECT id,record_status,created_at,updated_at FROM {spec.target_table}") == original
    ack_count = len(sheets.updates)
    assert account_details.upsert_details(database_client, sheets, sheet, [{**row, "sync_status": "in-sync", "record_status": "deleted"}]) == 0
    assert len(sheets.updates) == ack_count
    assert _one(database_client, f"SELECT record_status FROM {spec.target_table}") == ("active",)


def test_managed_detail_lifecycle_transitions_preserve_identity_and_ingestion_creation(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    row = _detail_row("account_deposit", master)
    sheets = RecordingSheets()
    assert account_details.upsert_details(database_client, sheets, "account_deposit", [row]) == 0
    original = _one(database_client, "SELECT id,created_at FROM account_deposit")
    for status in ("inactive", "deleted", "active", "locked", "active"):
        changed = {**row, "record_status": status, "sync_status": "update-pending"}
        assert account_details.upsert_details(database_client, sheets, "account_deposit", [changed]) == 0
        assert _one(database_client, "SELECT id,created_at,record_status FROM account_deposit") == (*original, status)


def test_managed_detail_failed_tab_marks_every_selected_row_without_partial_commit(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    row = _detail_row("account_deposit", master, _sheet_row_num=15)
    sheets = RecordingSheets()
    account_details.upsert_details(database_client, sheets, "account_deposit", [row])
    original = _one(database_client, "SELECT id,interest_rate,record_status,updated_at FROM account_deposit")
    changed = {**row, "interest_rate": "9", "record_status": "deleted", "sync_status": "update-pending"}
    invalid = _detail_row("account_deposit", master, interest_rate="NaN", _sheet_row_num=40)
    assert account_details.upsert_details(database_client, sheets, "account_deposit", [changed, invalid]) == 2
    assert _one(database_client, "SELECT id,interest_rate,record_status,updated_at FROM account_deposit") == original
    updates = sheets.updates[-1][1]
    assert [(number, values[0], values[2]) for number, _column, values in updates] == [
        (15, "update-failed", "detail_tab_rolled_back"),
        (40, "create-failed", "invalid_source_value_or_constraint"),
    ]


def test_managed_detail_acknowledgement_failure_retries_committed_uuid_safely(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    row = _detail_row("account_deposit", master)

    class FailedAcknowledgement(RecordingSheets):
        def batch_update_rows(self, sheet_name: str, updates: list[tuple[int, int, list[str]]]) -> None:
            raise RuntimeError("sheet_acknowledgement_unavailable")

    with pytest.raises(RuntimeError, match="sheet_acknowledgement_unavailable"):
        account_details.upsert_details(database_client, FailedAcknowledgement(), "account_deposit", [row])
    original = _one(database_client, "SELECT id,created_at,updated_at FROM account_deposit")
    sheets = RecordingSheets()
    assert account_details.upsert_details(database_client, sheets, "account_deposit", [row]) == 0
    assert _one(database_client, "SELECT id,created_at,updated_at FROM account_deposit") == original
    assert _one(database_client, "SELECT COUNT(*) FROM account_deposit") == (1,)
    assert sheets.updates[-1][1][0][2][0] == "in-sync"


def test_managed_detail_source_change_prevents_commit_and_acknowledgement(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    sheets = RecordingSheets()

    def changed_source() -> None:
        raise RuntimeError("sheet_changed_before_commit")

    with pytest.raises(RuntimeError, match="sheet_changed_before_commit"):
        account_details.upsert_details(database_client, sheets, "account_deposit", [_detail_row("account_deposit", master)], before_commit=changed_source)
    assert sheets.updates == []
    assert _one(database_client, "SELECT COUNT(*) FROM account_deposit") == (0,)


def test_detail_lifecycle_migration_retains_unknown_legacy_status(database_client: Any) -> None:
    master = _detail_account(database_client, "current")
    with database_client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_deposit (account_master_id,local_currency,base_currency)
               VALUES (%s,'XAU','XAU') RETURNING id,record_status""",
            (master,),
        )
        identity, status = cursor.fetchone()
        assert status is None
    database_client.commit()
    assert _one(database_client, "SELECT record_status FROM account_deposit WHERE id=%s", (identity,)) == (None,)
    with pytest.raises(psycopg2.IntegrityError), database_client.cursor() as cursor:
        cursor.execute("UPDATE account_deposit SET record_status='unknown' WHERE id=%s", (identity,))


@pytest.mark.parametrize(
    "classification",
    [
        {"tx_type": "", "major_category": "", "minor_category": ""},
        {"tx_type": "money-in", "major_category": "", "minor_category": ""},
        {"tx_type": "", "major_category": "living", "minor_category": "food"},
    ],
)
def test_optional_classification_can_be_set_and_cleared_without_identity_change(database_client: Any, classification: dict[str, str]) -> None:
    account_map = _seed_dependencies(database_client)
    sheets = RecordingSheets()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription()], account_map) == 0
    identity = _one(database_client, "SELECT id, created_at FROM subscription_master")
    row = _subscription(**classification, sync_status="update-pending")
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row], account_map) == 0
    assert _one(database_client, "SELECT id, created_at FROM subscription_master") == identity
    assert _one(database_client, "SELECT category_id, tx_type, major_category, minor_category FROM subscription_master") == (
        None,
        classification["tx_type"] or None,
        classification["major_category"] or None,
        classification["minor_category"] or None,
    )
    assert subscriptions.upsert_subscriptions(database_client, sheets, [_subscription(sync_status="update-pending")], account_map) == 0
    assert _one(database_client, "SELECT id, created_at FROM subscription_master") == identity
    assert str(_one(database_client, "SELECT category_id FROM subscription_master")[0]) == CATEGORY_ID


def test_migration_backfills_existing_classification_and_preserves_identity(database_client: Any) -> None:
    account_map = _seed_dependencies(database_client)
    assert subscriptions.upsert_subscriptions(database_client, RecordingSheets(), [_subscription()], account_map) == 0
    original = _one(database_client, "SELECT id, created_at, updated_at, category_id FROM subscription_master")
    with database_client.cursor() as cursor:
        cursor.execute("ALTER TABLE subscription_master DROP COLUMN tx_type, DROP COLUMN major_category, DROP COLUMN minor_category, ALTER COLUMN category_id SET NOT NULL")
    database_client.commit()
    path = MODULE_ROOT / "migrations" / "0021_optional_subscription_classification.py"
    _migration(path).upgrade(database_client)
    assert _one(database_client, "SELECT id, created_at, updated_at, category_id FROM subscription_master") == original
    assert _one(database_client, "SELECT tx_type, major_category, minor_category FROM subscription_master") == ("money-out", "living", "food")
