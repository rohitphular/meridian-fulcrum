"""Policy comes from source configuration; key migration preserves relational identity."""

from typing import Any
from uuid import uuid4

import psycopg2
import pytest

from database import account_details, account_types, accounts, categories
from tests.integration.postgres_support import MODULE_ROOT, migration
from tests.integration.test_account_types import RecordingSheets, _one, _references, _register, _row


@pytest.mark.parametrize("database_client", [19], indirect=True)
def test_hyphen_policy_migration_preserves_ids_references_audits_and_ownership(database_client: Any) -> None:
    _references(database_client, account=True, source=True, target=True)
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE account_types SET is_sheet_managed=TRUE,sync_status='in-sync',sync_date=now() WHERE account_subtype_key='current'")
        cursor.execute("""INSERT INTO account_master(id,account_name,account_type,account_subtype,local_currency,base_currency,
            opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
            VALUES(gen_random_uuid(),'Loan','liability','credit_card','XAU','XAU',0,0,'active',now(),now())""")
        cursor.execute("SELECT id,account_type_key,account_subtype_key,created_at,updated_at,is_sheet_managed FROM account_types ORDER BY id")
        before = cursor.fetchall()
        cursor.execute("SELECT id,created_at,updated_at FROM account_master ORDER BY id")
        accounts_before = cursor.fetchall()
    database_client.commit()
    migration(MODULE_ROOT / "migrations/0020_account_type_policies_and_hyphen_keys.py").upgrade(database_client)
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id,account_type_key,account_subtype_key,created_at,updated_at,is_sheet_managed FROM account_types ORDER BY id")
        assert cursor.fetchall() == [(identity, group.replace("_", "-"), subtype.replace("_", "-"), created, updated, managed) for identity, group, subtype, created, updated, managed in before]
        cursor.execute("SELECT id,created_at,updated_at FROM account_master ORDER BY id")
        assert cursor.fetchall() == accounts_before
    assert _one(database_client, "SELECT account_subtype FROM account_master WHERE account_name='Loan'") == ("credit-card",)
    assert _one(database_client, "SELECT count(*) FROM account_types WHERE is_loan=FALSE AND detail_sheet IS NULL AND sync_status IS NULL AND sync_notes='policy_source_sync_required'") == (
        len(before),
    )
    current_id = _one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='current'")[0]
    for table in ("category_source_account_types", "category_target_account_types"):
        assert _one(database_client, f"SELECT account_type_id FROM {table}") == (current_id,)
    # A policy refresh does not authorize a second identity adoption.
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [_row()]) == 1
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [_row(id=str(current_id))]) == 0
    assert _one(database_client, "SELECT id,detail_sheet,sync_status FROM account_types WHERE account_subtype_key='current'") == (current_id, "account_deposit", "in-sync")


@pytest.mark.parametrize("database_client", [19], indirect=True)
def test_hyphen_collision_aborts_without_partial_schema_or_data_changes(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("ALTER TABLE account_types DROP CONSTRAINT chk_account_types_subtype_key")
        cursor.execute("""INSERT INTO account_types(account_type_key,account_type_label,account_subtype_key,account_subtype_label,created_at,updated_at)
            VALUES('asset','Asset','collision_key','One',now(),now()),('asset','Asset','collision-key','Two',now(),now())""")
        cursor.execute("SELECT id,account_subtype_key FROM account_types ORDER BY id")
        before = cursor.fetchall()
    database_client.commit()
    with pytest.raises(ValueError, match="account_type_hyphen_keys_require_reconciliation"):
        migration(MODULE_ROOT / "migrations/0020_account_type_policies_and_hyphen_keys.py").upgrade(database_client)
    with database_client.cursor() as cursor:
        cursor.execute("SELECT id,account_subtype_key FROM account_types ORDER BY id")
        assert cursor.fetchall() == before
    assert _one(database_client, "SELECT count(*) FROM information_schema.columns WHERE table_name='account_types' AND column_name='is_loan'") == (0,)


def test_new_classifications_cannot_be_created_by_extraction(database_client: Any) -> None:
    source = _row(account_subtype_key="not-in-current-catalog")
    sheets = RecordingSheets()
    assert account_types.upsert_account_types(database_client, sheets, [source]) == 1
    assert sheets.updates[0][1][2][2] == "classification_not_in_existing_catalog"
    assert _one(database_client, "SELECT count(*) FROM account_types WHERE id=%s", (source["id"],)) == (0,)


def _master(type_row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "account_name": "Configured account",
        "type": type_row["account_type_key"],
        "sub_type": type_row["account_subtype_key"],
        "account_currency_local": "XAU",
        "opening_value_local": "0",
        "record_status": "active",
        "sync_status": "create-pending",
    }


def test_unmanaged_and_uninitialized_configuration_cannot_supply_options_or_accounts(database_client: Any) -> None:
    for managed in (False, True):
        with database_client.cursor() as cursor:
            cursor.execute("UPDATE account_types SET is_sheet_managed=%s WHERE account_subtype_key='current'", (managed,))
        database_client.commit()
        with pytest.raises(ValueError, match="sync account_types first"):
            categories._resolve_account_types(database_client, "current")
        database_client.rollback()
        sheets = RecordingSheets()
        assert accounts.upsert_accounts(database_client, sheets, [_master(_row())], 1) == 1
        assert "sync account_types first" in sheets.updates[0][1][2][2]
    assert _one(database_client, "SELECT count(*) FROM account_master") == (0,)
    with pytest.raises(ValueError, match="sync account_types first"):
        categories._resolve_account_types(database_client, "investment")
    database_client.rollback()


def test_detail_eligibility_follows_existing_custom_catalog_policy_and_freezes_with_accounts(database_client: Any) -> None:
    source = _row(account_subtype_key="configured-reserve", account_subtype_label="Configured reserve")
    _register(database_client, source)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [source]) == 0
    master = _master(source)
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [master], 1) == 0
    # A configured mapping freezes even before the first extension row exists.
    changed = RecordingSheets()
    assert account_types.upsert_account_types(database_client, changed, [{**source, "detail_sheet": "", "sync_status": "update-pending"}]) == 1
    assert changed.updates[0][1][2][2] == "detail_policy_frozen_by_existing_accounts"
    detail = {"id": str(uuid4()), "account_id": master["id"], "record_status": "active", "interest_rate": "3.5"}
    assert account_details.sync_details(database_client, "account_deposit", [detail])["created"] == 1
    with pytest.raises(ValueError, match="account_detail_policy_mismatch"):
        account_details.sync_details(database_client, "account_liability_credit_card", [{**detail, "credit_limit_local": "0"}])
    # The retired loan flag is gone after all migrations; the detail policy is unaffected.
    assert _one(database_client, "SELECT count(*) FROM information_schema.columns WHERE table_name='account_types' AND column_name='is_loan'") == (0,)
    assert _one(database_client, "SELECT detail_sheet FROM account_types WHERE id=%s", (source["id"],)) == ("account_deposit",)


def test_detail_commit_locks_configuration_policy_against_concurrent_edits(database_client: Any) -> None:
    source = _row()
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [source]) == 0
    master = _master(source)
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [master], 1) == 0
    peer = psycopg2.connect(database_client.dsn)
    try:

        def attempted_policy_edit() -> None:
            with peer.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='50ms'")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    cursor.execute("UPDATE account_types SET detail_sheet=NULL WHERE id=%s", (source["id"],))
            peer.rollback()

        detail = {"id": str(uuid4()), "account_id": master["id"], "record_status": "active"}
        assert account_details.sync_details(database_client, "account_deposit", [detail], before_commit=attempted_policy_edit)["created"] == 1
    finally:
        peer.close()


def test_initial_policy_cannot_orphan_retained_detail_rows(database_client: Any) -> None:
    _references(database_client, account=True)
    with database_client.cursor() as cursor:
        cursor.execute("""INSERT INTO account_deposit(account_master_id,local_currency,base_currency)
            SELECT id,'XAU','XAU' FROM account_master""")
    database_client.commit()
    before = _one(database_client, "SELECT id,is_sheet_managed,sync_status FROM account_types WHERE account_subtype_key='current'")
    sheets = RecordingSheets()
    assert account_types.upsert_account_types(database_client, sheets, [_row(detail_sheet="")]) == 1
    assert sheets.updates[0][1][2][2] == "detail_policy_conflicts_with_existing_details"
    assert _one(database_client, "SELECT id,is_sheet_managed,sync_status FROM account_types WHERE account_subtype_key='current'") == before
