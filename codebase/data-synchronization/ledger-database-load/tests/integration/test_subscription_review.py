"""Subscription identity, rollback and reference safety in disposable PostgreSQL."""

from __future__ import annotations

from typing import Any

import psycopg2
import pytest

from database import subscriptions

ACCOUNT = "11111111-1111-4111-8111-111111111111"
SUBSCRIPTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[Any] = []

    def batch_update_rows(self, sheet_name: str, updates: list[Any]) -> None:
        assert sheet_name == "subscription_master"
        self.updates.extend(updates)


def scalar(conn: Any, query: str, parameters: tuple[Any, ...] = ()) -> Any:
    with conn.cursor() as cursor:
        cursor.execute(query, parameters)
        return cursor.fetchone()[0]


@pytest.fixture
def dependencies(database_client: Any) -> dict[str, Any]:
    with database_client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_master (id,account_name,account_type,account_subtype,local_currency,base_currency,
            opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
            VALUES (%s,'Synthetic account','asset','current','USD','XAU',0,0,'active',now(),now())""",
            (ACCOUNT,),
        )
        cursor.execute(
            """INSERT INTO category_master (id,tx_type_key,tx_type_label,major_category_key,major_category_label,
            minor_category_key,minor_category_label,source_account_mandatory,target_account_mandatory,
            is_subscription_eligible,record_status,created_at,updated_at)
            VALUES (gen_random_uuid(),'money-out','Money out','bills','Bills','test','Test',true,false,true,'active',now(),now())"""
        )
    database_client.commit()
    return subscriptions.load_account_map(database_client)


def row(**changes: Any) -> dict[str, Any]:
    return {
        "id": SUBSCRIPTION,
        "subscription_name": "Synthetic subscription",
        "subscription_amount_local": "10.015",
        "frequency": "monthly",
        "day_of_month": "31",
        "source_account": ACCOUNT,
        "tx_type": "money-out",
        "major_category": "bills",
        "minor_category": "test",
        "subscription_start_date_local": "2026-09-18 12:00:00",
        "subscription_timezone_local": "Europe/London",
        "record_status": "active",
        "sync_status": "update-pending",
        **changes,
    }


def identity(conn: Any) -> tuple[Any, ...]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT id,subscription_id,created_at FROM subscription_master ORDER BY subscription_id")
        return tuple(cursor.fetchall())


def test_uuid_case_replay_lifecycle_and_audit_identity(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row(id=SUBSCRIPTION.upper())], dependencies) == 0
    original = identity(database_client)
    assert original[0][1] == SUBSCRIPTION
    for status in ("deleted", "active", "locked", "inactive"):
        assert subscriptions.upsert_subscriptions(database_client, sheets, [row(record_status=status, created_at="source-audit-must-not-overwrite")], dependencies) == 0
        assert identity(database_client) == original
        assert scalar(database_client, "SELECT record_status FROM subscription_master") == status
    assert scalar(database_client, "SELECT amount_local FROM subscription_master") == 1002
    assert all(update[1] == 15 and len(update[2]) == 3 for update in sheets.updates)


def test_source_change_rolls_back_subscription_and_counterparty(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()

    def changed() -> None:
        assert scalar(database_client, "SELECT count(*) FROM subscription_master") == 1
        assert scalar(database_client, "SELECT count(*) FROM counterparty_master") == 1
        raise ValueError("sheet_changed_before_acknowledgement:subscription_master")

    with pytest.raises(ValueError, match="sheet_changed_before_acknowledgement"):
        subscriptions.upsert_subscriptions(database_client, sheets, [row(counterparty_name="Synthetic shop")], dependencies, before_commit=changed)
    assert scalar(database_client, "SELECT count(*) FROM subscription_master") == 0
    assert scalar(database_client, "SELECT count(*) FROM counterparty_master") == 0
    assert sheets.updates == []


def test_failed_acknowledgement_can_replay_without_duplicate_identity(database_client: Any, dependencies: dict[str, Any]) -> None:
    class FailedSheets:
        def batch_update_rows(self, *_args: Any) -> None:
            raise RuntimeError("writeback_unavailable")

    with pytest.raises(RuntimeError, match="writeback_unavailable"):
        subscriptions.upsert_subscriptions(database_client, FailedSheets(), [row()], dependencies)
    original = identity(database_client)
    assert subscriptions.upsert_subscriptions(database_client, RecordingSheets(), [row(sync_status="create-failed")], dependencies) == 0
    assert identity(database_client) == original


def test_normal_sync_preserves_physical_rows_and_skips_in_sync(database_client: Any, dependencies: dict[str, Any]) -> None:
    sheets = RecordingSheets()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row()], dependencies) == 0
    sheets.updates.clear()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row(sync_status="in-sync", subscription_amount_local="99"), {}, row(id=SECOND, _sheet_row_num=17)], dependencies) == 0
    assert scalar(database_client, "SELECT amount_local FROM subscription_master WHERE subscription_id=%s", (SUBSCRIPTION,)) == 1002
    assert len(sheets.updates) == 1 and sheets.updates[0][0] == 17


def test_constraint_failure_rolls_back_counterparty_and_continues(database_client: Any, dependencies: dict[str, Any]) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("ALTER TABLE subscription_master ADD CONSTRAINT fixture_amount_limit CHECK(amount_local < 2000)")
    database_client.commit()
    sheets = RecordingSheets()
    failures = subscriptions.upsert_subscriptions(
        database_client, sheets, [row(subscription_amount_local="20", counterparty_name="Rolled back shop"), row(id=SECOND, counterparty_name="Committed shop")], dependencies
    )
    assert failures == 1
    assert scalar(database_client, "SELECT count(*) FROM subscription_master") == 1
    assert scalar(database_client, "SELECT counterparty_label FROM counterparty_master") == "Committed shop"
    assert [update[2][0] for update in sheets.updates] == ["update-failed", "in-sync"]


def test_stale_account_cache_cannot_change_minor_unit_precision(database_client: Any, dependencies: dict[str, Any]) -> None:
    stale = {ACCOUNT: (ACCOUNT, "XAU", "current")}
    assert subscriptions.upsert_subscriptions(database_client, RecordingSheets(), [row()], stale) == 0
    assert scalar(database_client, "SELECT amount_local FROM subscription_master") == 1002


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE currency_master SET decimal_places=decimal_places WHERE currency_code='USD'",
        f"UPDATE account_master SET account_name='Concurrent edit' WHERE id='{ACCOUNT}'",
        "UPDATE category_master SET major_category_label='Concurrent edit' WHERE major_category_key='bills'",
        "DELETE FROM subscription_master",
    ],
)
def test_references_locked_through_commit(database_client: Any, dependencies: dict[str, Any], statement: str) -> None:
    with psycopg2.connect(database_client.dsn) as other:

        def verify_lock() -> None:
            with other.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='50ms'")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    cursor.execute(statement)
            other.rollback()

        # The second row verifies locks are reacquired after the first commit.
        assert subscriptions.upsert_subscriptions(database_client, RecordingSheets(), [row(), row(id=SECOND)], dependencies, before_commit=verify_lock) == 0


@pytest.mark.parametrize("legacy", [SUBSCRIPTION.upper(), SUBSCRIPTION.replace("-", ""), "{" + SUBSCRIPTION + "}", "urn:uuid:" + SUBSCRIPTION])
def test_legacy_uuid_spellings_do_not_create_duplicate_subscriptions(database_client: Any, dependencies: dict[str, Any], legacy: str) -> None:
    sheets = RecordingSheets()
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row()], dependencies) == 0
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE subscription_master SET subscription_id=%s", (legacy,))
    database_client.commit()
    original = identity(database_client)
    assert subscriptions.upsert_subscriptions(database_client, sheets, [row()], dependencies) == 1
    assert identity(database_client) == original
    assert "database_subscription_identity_requires_reconciliation" in sheets.updates[-1][2][2]
