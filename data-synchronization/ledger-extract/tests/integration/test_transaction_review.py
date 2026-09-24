"""Transaction component/retry/concurrency checks against disposable PostgreSQL."""

from __future__ import annotations

from typing import Any

import psycopg2
import pytest

from database import transactions

ACCOUNT = "11111111-1111-4111-8111-111111111111"
TARGET = "22222222-2222-4222-8222-222222222222"
ROOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
TOMBSTONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[Any] = []

    def batch_update_rows(self, sheet_name: str, updates: list[Any]) -> None:
        assert sheet_name == "transaction_master"
        self.updates.extend(updates)


def scalar(conn: Any, query: str, parameters: tuple[Any, ...] = ()) -> Any:
    with conn.cursor() as cursor:
        cursor.execute(query, parameters)
        return cursor.fetchone()[0]


@pytest.fixture
def dependencies(database_client: Any) -> dict[str, Any]:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD', '2026-09-18', 100, 'yfinance')")
        for identity in (ACCOUNT, TARGET):
            cursor.execute(
                """INSERT INTO account_master (id,account_name,account_type,account_subtype,local_currency,base_currency,
                opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
                VALUES (%s,'Synthetic account','asset','current','USD','XAU',0,0,'active',now(),now())""",
                (identity,),
            )
        for direction in ("money-in", "money-out"):
            cursor.execute(
                """INSERT INTO category_master (id,tx_type_key,tx_type_label,major_category_key,major_category_label,
                minor_category_key,minor_category_label,source_account_mandatory,target_account_mandatory,
                is_subscription_eligible,record_status,created_at,updated_at)
                VALUES (gen_random_uuid(),%s,%s,'transfer','Transfer','test','Test',true,true,false,'active',now(),now())""",
                (direction, direction),
            )
    database_client.commit()
    return transactions.load_account_map(database_client)


def row(**changes: Any) -> dict[str, Any]:
    return {
        "id": ROOT,
        "tx_date_local": "2026-09-18 12:00:00",
        "tx_timezone_local": "Europe/London",
        "tx_type": "money-out",
        "account_id": ACCOUNT,
        "tx_amount_local": "10",
        "major_category": "transfer",
        "minor_category": "test",
        "record_status": "active",
        "sync_status": "update-pending",
        **changes,
    }


def child(**changes: Any) -> dict[str, Any]:
    return row(**{"id": CHILD, "parent_tx_id": ROOT, "tx_type": "money-in", "account_id": TARGET, **changes})


def read_rows(conn: Any) -> list[Any]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT transaction_id,id,parent_tx_id,account_id,tx_amount_local,record_status,created_at,updated_at FROM transaction_master ORDER BY transaction_id")
        return cursor.fetchall()


def test_reparenting_failure_rolls_back_old_and_new_groups(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), child(), row(id=OTHER)], dependencies) == 0
    before = read_rows(database_client)
    sheets.updates.clear()
    # The old parent is first in source order. It must not commit separately when
    # its former child is reparented into a failing replacement pair.
    pending = [row(tx_amount_local="20"), row(id=OTHER, tx_amount_local="30"), child(parent_tx_id=OTHER, beneficiaries="Repeated;Repeated")]
    assert transactions.upsert_transactions(database_client, sheets, pending, dependencies) == 3
    assert read_rows(database_client) == before
    assert len(sheets.updates) == 3


def test_reparenting_and_role_reversal_preserve_both_database_identities(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), child()], dependencies) == 0
    before = {record[0]: (record[1], record[6]) for record in read_rows(database_client)}
    # Re-importing a former child as the root reverses the relationship.
    assert transactions.upsert_transactions(database_client, sheets, [row(parent_tx_id=CHILD), child(parent_tx_id="")], dependencies) == 0
    after = read_rows(database_client)
    assert {record[0]: (record[1], record[6]) for record in after} == before
    assert {record[0]: record[2] for record in after} == {ROOT: CHILD, CHILD: None}


def test_deleted_historical_child_does_not_block_reparenting(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    historical = child(id=TOMBSTONE, record_status="deleted")
    assert transactions.upsert_transactions(database_client, sheets, [row(), child(), historical], dependencies) == 0
    assert transactions.upsert_transactions(database_client, sheets, [historical, row(parent_tx_id=CHILD), child(parent_tx_id="")], dependencies) == 0
    assert scalar(database_client, "SELECT parent_tx_id FROM transaction_master WHERE transaction_id=%s", (TOMBSTONE,)) == ROOT


def test_normal_sync_skips_existing_in_sync_sibling(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), child()], dependencies) == 0
    before_child = read_rows(database_client)[1]
    sheets.updates.clear()
    assert transactions.upsert_transactions(database_client, sheets, [child(sync_status="in-sync"), row(tx_amount_local="11", _sheet_row_num=9)], dependencies) == 0
    assert read_rows(database_client)[1] == before_child
    assert len(sheets.updates) == 1
    assert sheets.updates[0][0:2] == (9, 20)


def test_source_change_before_commit_rolls_back_whole_component_and_references(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()

    def source_changed() -> None:
        # The callback runs after staged writes, while rollback is still possible.
        assert scalar(database_client, "SELECT count(*) FROM transaction_master") == 2
        raise ValueError("sheet_changed_during_extraction")

    with pytest.raises(ValueError, match="sheet_changed_during_extraction"):
        transactions.upsert_transactions(database_client, sheets, [row(counterparty_name="Synthetic shop", beneficiaries="Synthetic person"), child()], dependencies, before_commit=source_changed)
    for table in ("transaction_master", "counterparty_master", "beneficiaries_master", "transaction_beneficiaries"):
        assert scalar(database_client, f"SELECT count(*) FROM {table}") == 0
    assert sheets.updates == []


def test_account_currency_comes_from_locked_database_reference(database_client: Any, dependencies: dict[str, Any]) -> None:
    # A caller cache cannot override the authoritative USD currency.
    stale = {ACCOUNT: (ACCOUNT, "XAU", "current")}
    assert transactions.upsert_transactions(database_client, RecordingSheets(), [row()], stale) == 0
    assert scalar(database_client, "SELECT local_currency FROM transaction_master") == "USD"
    assert scalar(database_client, "SELECT tx_amount_local FROM transaction_master") == 1000
    assert scalar(database_client, "SELECT tx_amount_base FROM transaction_master") == 100000000


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE currency_master SET decimal_places=decimal_places WHERE currency_code='USD'",
        "UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='USD' AND rate_date='2026-09-18'",
        f"UPDATE account_master SET account_name='Concurrent edit' WHERE id='{ACCOUNT}'",
        "UPDATE category_master SET tx_type_label='Concurrent edit' WHERE tx_type_key='money-out'",
        "DELETE FROM transaction_master",
    ],
)
def test_references_and_pair_state_are_locked_through_source_check(database_client: Any, dependencies: dict[str, Any], statement: str) -> None:
    with psycopg2.connect(database_client.dsn) as other:

        def verify_lock() -> None:
            with other.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='50ms'")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    cursor.execute(statement)
            other.rollback()

        assert transactions.upsert_transactions(database_client, RecordingSheets(), [row(), child()], dependencies, before_commit=verify_lock) == 0


@pytest.mark.parametrize("legacy_identity", [ROOT.upper(), ROOT.replace("-", ""), "{" + ROOT + "}", "urn:uuid:" + ROOT])
def test_old_database_uuid_spelling_requires_reconciliation(database_client: Any, dependencies: dict[str, Any], legacy_identity: str) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row()], dependencies) == 0
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE transaction_master SET transaction_id=%s", (legacy_identity,))
    database_client.commit()
    sheets.updates.clear()
    assert transactions.upsert_transactions(database_client, sheets, [row()], dependencies) == 1
    assert scalar(database_client, "SELECT count(*) FROM transaction_master") == 1
    assert "database_transaction_identity_requires_reconciliation" in sheets.updates[0][2][2]


def test_relationship_change_since_planning_aborts_before_any_write(database_client: Any, dependencies: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), child(), row(id=OTHER)], dependencies) == 0
    original_lock = transactions._lock_group

    def change_then_lock(conn: Any, rows: list[dict[str, Any]], **kwargs: Any) -> list[str]:
        with psycopg2.connect(conn.dsn) as other:
            with other.cursor() as cursor:
                cursor.execute("UPDATE transaction_master SET parent_tx_id=%s WHERE transaction_id=%s", (OTHER, CHILD))
        return original_lock(conn, rows, **kwargs)

    monkeypatch.setattr(transactions, "_lock_group", change_then_lock)
    sheets.updates.clear()
    with pytest.raises(RuntimeError, match="database_transfer_relationships_changed_retry"):
        transactions.upsert_transactions(database_client, sheets, [row(tx_amount_local="99"), child()], dependencies)
    assert scalar(database_client, "SELECT tx_amount_local FROM transaction_master WHERE transaction_id=%s", (ROOT,)) == 1000
    assert sheets.updates == []


def test_existing_canonical_and_alias_database_identities_fail_without_picking_one(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), row(id=OTHER)], dependencies) == 0
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE transaction_master SET transaction_id=%s WHERE transaction_id=%s", (ROOT.upper(), OTHER))
    database_client.commit()
    before = read_rows(database_client)
    sheets.updates.clear()
    assert transactions.upsert_transactions(database_client, sheets, [row(tx_amount_local="99")], dependencies) == 1
    assert read_rows(database_client) == before
    assert "database_transaction_identity_requires_reconciliation" in sheets.updates[0][2][2]


def test_mixed_source_uuid_case_replays_same_transfer_pair(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert transactions.upsert_transactions(database_client, sheets, [row(), child()], dependencies) == 0
    before = {record[0]: (record[1], record[6]) for record in read_rows(database_client)}
    assert transactions.upsert_transactions(database_client, sheets, [child(id=CHILD.upper(), parent_tx_id=ROOT.upper()), row()], dependencies) == 0
    assert {record[0]: (record[1], record[6]) for record in read_rows(database_client)} == before
