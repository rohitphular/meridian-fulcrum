"""Account master source fidelity and retry checks in a disposable PostgreSQL DB."""

from typing import Any
from uuid import uuid4

import psycopg2
import pytest

import database.account_details as account_details
import database.accounts as accounts
from tests.integration.postgres_support import MODULE_ROOT, migration


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[tuple[str, list[tuple[int, int, list[str]]]]] = []

    def batch_update_rows(self, sheet_name: str, updates: list[tuple[int, int, list[str]]]) -> None:
        self.updates.append((sheet_name, list(updates)))


def _account_row(**changes: Any) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "account_name": "Reviewed account",
        "legal_entity_name": "Example bank",
        "type": "asset",
        "sub_type": "current",
        "account_currency_local": "GBP",
        "local_timezone": "Europe/London",
        "account_opening_date_local": "2020-01-01",
        "account_closing_date_local": "",
        "tracking_start_date_local": "2026-09-18 00:00:00",
        "opening_value_local": "0",
        "description": "Original description",
        "record_status": "active",
        "sync_status": "create-pending",
        "created_at": "2000-01-01T00:00:00Z",
        "updated_at": "2000-01-02T00:00:00Z",
        **changes,
    }


def _stored(client: Any, account_id: str) -> tuple[Any, ...] | None:
    with client.cursor() as cursor:
        cursor.execute(
            """SELECT id,account_name,account_type,account_subtype,local_currency,
                      opening_amount_local_value,opening_amount_base_value,
                      currency_rate_id,applied_rate_value,record_status,created_at,updated_at
               FROM account_master WHERE id=%s""",
            (account_id,),
        )
        return cursor.fetchone()


@pytest.mark.parametrize("account_type,subtype", [("asset", "current"), ("investment", "stocks-shares"), ("liability", "credit-card")])
def test_signed_opening_snapshot_rounds_once_and_retry_preserves_identity(database_client: Any, account_type: str, subtype: str) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code,rate_date,rate_value,rate_source) VALUES ('GBP','2026-09-18',100,'test') RETURNING id")
        rate_id = cursor.fetchone()[0]
    database_client.commit()
    row = _account_row(type=account_type, sub_type=subtype, opening_value_local="-10.005")
    sheets = RecordingSheets()
    assert accounts.upsert_accounts(database_client, sheets, [row], 1) == 0
    inserted = _stored(database_client, row["id"])
    assert inserted is not None
    assert inserted[5:9] == (-1001, -100100000, rate_id, 100)
    assert inserted[10].year != 2000
    assert accounts.upsert_accounts(database_client, sheets, [{**row, "sync_status": "create-failed"}], 1) == 0
    retried = _stored(database_client, row["id"])
    assert retried is not None and retried[:11] == inserted[:11]
    assert all(update[1] == 14 and len(update[2]) == 3 for _, batch in sheets.updates for update in batch)


@pytest.mark.parametrize("failure", [RuntimeError("sheet_changed_before_acknowledgement:account_master"), ValueError("sheet_header_mismatch:account_master")])
def test_changed_source_rolls_back_update_and_retry_retains_created_timestamp(database_client: Any, failure: Exception) -> None:
    row = _account_row()
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [row], 1) == 0
    original = _stored(database_client, row["id"])
    changed = {**row, "account_name": "Updated name", "record_status": "deleted", "sync_status": "update-pending"}
    sheets = RecordingSheets()

    def source_changed() -> None:
        raise failure

    with pytest.raises(type(failure), match=str(failure)):
        accounts.upsert_accounts(database_client, sheets, [changed], 1, before_commit=source_changed)
    assert sheets.updates == []
    assert _stored(database_client, row["id"]) == original
    assert accounts.upsert_accounts(database_client, sheets, [changed], 1, before_commit=lambda: None) == 0
    updated = _stored(database_client, row["id"])
    assert original is not None and updated is not None
    assert updated[1] == "Updated name" and updated[9] == "deleted"
    assert updated[10] == original[10]
    assert accounts.upsert_accounts(database_client, sheets, [{**row, "sync_status": "update-pending"}], 1, before_commit=lambda: None) == 0
    restored = _stored(database_client, row["id"])
    assert restored is not None and restored[:11] == original[:11]


def test_guard_failure_preserves_prior_committed_row_and_queues_no_failed_row_acknowledgement(database_client: Any) -> None:
    rows = [_account_row(_sheet_row_num=7), _account_row(_sheet_row_num=20)]
    sheets = RecordingSheets()
    guards = 0

    def source_guard() -> None:
        nonlocal guards
        guards += 1
        if guards == 2:
            raise RuntimeError("sheet_changed_before_acknowledgement:account_master")

    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement"):
        accounts.upsert_accounts(database_client, sheets, rows, 1, before_commit=source_guard)
    assert _stored(database_client, rows[0]["id"]) is not None
    assert _stored(database_client, rows[1]["id"]) is None
    assert len(sheets.updates) == 1
    assert len(sheets.updates[0][1]) == 1
    assert sheets.updates[0][1][0][0] == 7


def test_currency_change_cannot_reinterpret_existing_detail_values(database_client: Any) -> None:
    row = _account_row()
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [row], 1) == 0
    detail_id = str(uuid4())
    account_details.sync_details(database_client, "account_deposit", [{"id": detail_id, "account_id": row["id"], "interest_rate": "5", "record_status": "active"}])
    original = _stored(database_client, row["id"])
    sheets = RecordingSheets()
    assert accounts.upsert_accounts(database_client, sheets, [{**row, "account_currency_local": "EUR", "sync_status": "update-pending"}], 1) == 1
    assert _stored(database_client, row["id"]) == original
    assert sheets.updates[0][1][0][2][0] == "update-failed"
    assert "local_currency" in sheets.updates[0][1][0][2][2]
    with database_client.cursor() as cursor:
        cursor.execute("SELECT local_currency,interest_rate FROM account_deposit WHERE id=%s", (detail_id,))
        assert cursor.fetchone() == ("GBP", 5)


@pytest.mark.parametrize("database_client", [16], indirect=True)
def test_sign_migration_preserves_existing_values_and_keeps_both_liability_constraints(database_client: Any) -> None:
    def historical_account(group: str, subtype: str, value: int) -> str:
        identity = str(uuid4())
        with database_client.cursor() as cursor:
            cursor.execute(
                """INSERT INTO account_master(id,account_name,account_type,account_subtype,local_currency,base_currency,
                opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
                VALUES(%s,'Fixture',%s,%s,'XAU','XAU',%s,%s,'active',now(),now())""",
                (identity, group, subtype, value, value),
            )
        database_client.commit()
        return identity

    asset_id = historical_account("asset", "current", 10)
    liability = {"id": historical_account("liability", "credit_card", -10)}
    original = [_stored(database_client, identity) for identity in (asset_id, liability["id"])]
    with pytest.raises(psycopg2.errors.CheckViolation):
        historical_account("asset", "current", -10)
    database_client.rollback()
    migration(MODULE_ROOT / "migrations/0017_account_opening_signs.py").upgrade(database_client)
    assert [_stored(database_client, identity) for identity in (asset_id, liability["id"])] == original
    historical_account("asset", "current", -10)
    for column in ("opening_amount_local_value", "opening_amount_base_value"):
        with pytest.raises(psycopg2.errors.CheckViolation):
            with database_client.cursor() as cursor:
                cursor.execute(f"UPDATE account_master SET {column}=1 WHERE id=%s", (liability["id"],))
        database_client.rollback()
    assert _stored(database_client, liability["id"]) == original[1]
