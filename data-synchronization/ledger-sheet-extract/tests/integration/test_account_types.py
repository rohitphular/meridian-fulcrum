"""Sheet ownership, seed adoption and dependency guards against disposable PostgreSQL."""

from copy import deepcopy
from typing import Any
from uuid import uuid4

import psycopg2
import pytest

import core.extractor as extractor
from database import account_types, accounts, categories
from sheets.contracts import HEADERS
from tests.integration.postgres_support import MODULE_ROOT, configure_test_account_types, migration


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list = []

    def batch_update_rows(self, name: str, updates: list) -> None:
        self.updates.extend((name, update) for update in updates)


def _row(**changes: Any) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "account_type_key": "asset",
        "account_type_label": "Asset",
        "account_subtype_key": "current",
        "account_subtype_label": "Current",
        "description": "Sheet description",
        "detail_sheet": "account_deposit",
        "record_status": "active",
        "sync_status": "create-pending",
        **changes,
    }


def _register(conn: Any, row: dict[str, Any]) -> None:
    """Register a synthetic existing catalog entry outside the ETL under test."""
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_types(account_type_key,account_type_label,account_subtype_key,account_subtype_label,created_at,updated_at)
            VALUES(%s,%s,%s,%s,now(),now())""",
            tuple(row[key] for key in ("account_type_key", "account_type_label", "account_subtype_key", "account_subtype_label")),
        )
    conn.commit()


def _one(conn: Any, sql: str, params: tuple = ()) -> tuple:
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        row = cursor.fetchone()
    assert row is not None
    return row


def _references(conn: Any, *, account: bool = False, source: bool = False, target: bool = False) -> None:
    with conn.cursor() as cursor:
        if account:
            cursor.execute("""INSERT INTO account_master (id,account_name,account_type,account_subtype,local_currency,base_currency,
                opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
                VALUES (gen_random_uuid(),'Fixture','asset','current','XAU','XAU',0,0,'deleted',now(),now())""")
        if source or target:
            cursor.execute("""INSERT INTO category_master (id,tx_type_key,tx_type_label,major_category_key,major_category_label,minor_category_key,
                minor_category_label,source_account_mandatory,target_account_mandatory,is_subscription_eligible,record_status,created_at,updated_at)
                VALUES (gen_random_uuid(),'money-out','Money Out','test','Test','fixture','Fixture',false,false,false,'deleted',now(),now()) RETURNING id""")
            category_id = cursor.fetchone()[0]
            for enabled, table in ((source, "category_source_account_types"), (target, "category_target_account_types")):
                if enabled:
                    cursor.execute(f"INSERT INTO {table} SELECT %s,id FROM account_types WHERE account_type_key='asset' AND account_subtype_key='current'", (category_id,))
    conn.commit()


@pytest.mark.parametrize("database_client", [18], indirect=True)
def test_sync_migration_preserves_existing_ids_audit_and_links(database_client: Any) -> None:
    _references(database_client, account=True, source=True, target=True)
    original = _one(database_client, "SELECT id,created_at,updated_at FROM account_types WHERE account_subtype_key='current'")
    migration(MODULE_ROOT / "migrations/0019_account_types_sheet_sync.py").upgrade(database_client)
    assert _one(database_client, "SELECT id,created_at,updated_at FROM account_types WHERE account_subtype_key='current'") == original
    assert _one(database_client, "SELECT count(*) FROM account_types WHERE NOT is_sheet_managed AND sync_status IS NULL AND sync_date IS NULL AND sync_notes IS NULL") == (22,)
    for table in ("category_source_account_types", "category_target_account_types"):
        assert _one(database_client, f"SELECT account_type_id FROM {table}") == (original[0],)
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE account_types SET record_status='locked' WHERE id=%s", (original[0],))
    database_client.commit()


def test_seed_uuid_adoption_preserves_account_and_category_references(database_client: Any) -> None:
    _references(database_client, account=True, source=True, target=True)
    old_id, created_at = _one(database_client, "SELECT id,created_at FROM account_types WHERE account_subtype_key='current'")
    row = _row(created_at="1900-01-01", updated_at="1900-01-02")
    sheet = RecordingSheets()

    def source_guard() -> None:
        # Another connection cannot see the new identity until commit.
        with psycopg2.connect(database_client.dsn) as observer:
            assert _one(observer, "SELECT id FROM account_types WHERE account_subtype_key='current'") == (old_id,)

    assert account_types.upsert_account_types(database_client, sheet, [row], before_commit=source_guard) == 0
    stored = _one(database_client, "SELECT id,created_at,is_sheet_managed,sync_status,sync_notes FROM account_types WHERE account_subtype_key='current'")
    assert stored == (row["id"], created_at, True, "in-sync", "")
    for table in ("category_source_account_types", "category_target_account_types"):
        assert _one(database_client, f"SELECT account_type_id FROM {table}") == (row["id"],)
    assert _one(database_client, "SELECT account_type,account_subtype FROM account_master") == ("asset", "current")
    assert sheet.updates[0][0] == "account_types"
    assert sheet.updates[0][1][1] == HEADERS["account_types"].index("sync_status") + 1
    assert sheet.updates[0][1][2][0] == "in-sync"
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [{**row, "account_subtype_label": "Edited", "sync_status": "update-pending"}]) == 0
    assert _one(database_client, "SELECT id,created_at,account_subtype_label FROM account_types WHERE id=%s", (row["id"],)) == (row["id"], created_at, "Edited")


def test_managed_identity_is_immutable_and_existing_custom_rows_can_be_adopted_once(database_client: Any) -> None:
    row = _row()
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [row]) == 0
    sheet = RecordingSheets()
    assert account_types.upsert_account_types(database_client, sheet, [_row()]) == 1
    assert sheet.updates[0][1][2][2] == "classification_owned_by_another_id"
    custom = _row(account_subtype_key="custom-existing")
    _register(database_client, custom)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [custom]) == 0
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [{**custom, "id": str(uuid4())}]) == 1


def test_source_id_cannot_take_over_another_classification(database_client: Any) -> None:
    other_id = _one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='savings'")[0]
    sheet = RecordingSheets()
    assert account_types.upsert_account_types(database_client, sheet, [_row(id=str(other_id))]) == 1
    assert sheet.updates[0][1][2][2] == "immutable_classification_keys"
    assert _one(database_client, "SELECT account_subtype_key,is_sheet_managed FROM account_types WHERE id=%s", (other_id,)) == ("savings", False)


@pytest.mark.parametrize("dependency", ["account", "source", "target"])
@pytest.mark.parametrize("status", ["inactive", "deleted"])
def test_retirement_rejects_all_existing_references(database_client: Any, dependency: str, status: str) -> None:
    _references(database_client, **{dependency: True})
    old_id = _one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='current'")[0]
    sheet = RecordingSheets()
    assert account_types.upsert_account_types(database_client, sheet, [_row(record_status=status)]) == 1
    assert sheet.updates[0][1][2][2] == "referenced_type_cannot_be_retired"
    assert _one(database_client, "SELECT record_status,is_sheet_managed FROM account_types WHERE id=%s", (old_id,)) == ("active", False)


@pytest.mark.parametrize("failure", [RuntimeError("sheet_changed_before_acknowledgement:account_types"), ValueError("sheet_header_mismatch:account_types")])
def test_source_guard_rolls_back_seed_adoption_and_cascaded_links(database_client: Any, failure: Exception) -> None:
    _references(database_client, source=True, target=True)
    old_id = _one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='current'")[0]

    def guard() -> None:
        raise failure

    sheet = RecordingSheets()
    with pytest.raises(type(failure), match=str(failure)):
        account_types.upsert_account_types(database_client, sheet, [_row()], before_commit=guard)
    assert _one(database_client, "SELECT id,is_sheet_managed FROM account_types WHERE account_subtype_key='current'") == (old_id, False)
    for table in ("category_source_account_types", "category_target_account_types"):
        assert _one(database_client, f"SELECT account_type_id FROM {table}") == (old_id,)
    assert not sheet.updates


def test_existing_catalog_policies_and_locked_references_work_but_retired_types_do_not(database_client: Any) -> None:
    row = _row(account_subtype_key="custom-reserve", record_status="locked")
    _register(database_client, row)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [row]) == 0
    assert categories._resolve_account_types(database_client, "custom-reserve") == [row["id"]]
    account = {
        "id": str(uuid4()),
        "account_name": "Dynamic",
        "type": "asset",
        "sub_type": "custom-reserve",
        "account_currency_local": "XAU",
        "opening_value_local": "0",
        "record_status": "active",
        "sync_status": "create-pending",
    }
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [account], 1) == 0
    unreferenced = _row(account_subtype_key="retired-custom", record_status="inactive")
    _register(database_client, unreferenced)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [unreferenced]) == 0
    with pytest.raises(ValueError, match="unknown, inactive, or unsynced"):
        categories._resolve_account_types(database_client, "retired-custom")
    database_client.rollback()
    assert accounts.upsert_accounts(database_client, RecordingSheets(), [{**account, "id": str(uuid4()), "sub_type": "retired-custom"}], 1) == 1


def test_normal_hard_sync_recovery_and_acknowledgement_retry_keep_one_identity(database_client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    seed_id = str(_one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='current'")[0])
    source = _row(id=seed_id, sync_status="in-sync", _sheet_row_num=2)

    class Source(RecordingSheets):
        fail_ack = False

        def capture(self, names: list[str]) -> None:
            assert names == ["account_types"]

        def snapshot_rows(self, name: str) -> list[dict[str, Any]]:
            return [deepcopy(source)]

        def assert_unchanged(self) -> None:
            pass

        def flush_pending(self) -> None:
            if self.fail_ack:
                raise RuntimeError("fixture_acknowledgement_failure")
            if self.updates:
                for name, (number, column, values) in self.updates:
                    for offset, value in enumerate(values):
                        source[HEADERS[name][column - 1 + offset]] = value
                self.updates.clear()

    sheets = Source()
    monkeypatch.setattr(extractor, "SnapshotSheetsClient", lambda *_args: sheets)
    monkeypatch.setattr(extractor, "get_client", lambda _: psycopg2.connect(database_client.dsn))
    cfg = {"entities": {name: {"enabled": name == "account_types"} for name in extractor._ENTITIES}}
    job = extractor.LedgerExtractJob(None, "fixture", "fixture")
    job.run(cfg)
    original = _one(database_client, "SELECT id,created_at,updated_at,is_sheet_managed FROM account_types WHERE id=%s", (seed_id,))
    assert original[3] is True
    assert _one(database_client, "SELECT detail_sheet,sync_status FROM account_types WHERE id=%s", (seed_id,)) == ("account_deposit", "in-sync")
    source["account_subtype_label"] = "Committed despite missing acknowledgement"
    source["sync_status"] = "update-pending"
    sheets.fail_ack = True
    with pytest.raises(RuntimeError, match="fixture_acknowledgement_failure"):
        job.run(cfg)
    assert source["sync_status"] == "update-pending"
    assert _one(database_client, "SELECT id FROM account_types WHERE account_subtype_key='current'") == (seed_id,)
    sheets.fail_ack = False
    sheets.updates.clear()
    job.run(cfg)
    original = _one(database_client, "SELECT id,created_at,updated_at,is_sheet_managed FROM account_types WHERE id=%s", (seed_id,))
    source["account_subtype_label"] = "Edited source"
    job.run(cfg)
    assert _one(database_client, "SELECT id,created_at,updated_at,is_sheet_managed FROM account_types WHERE id=%s", (seed_id,)) == original
    job.run(cfg, reprocess=True)
    assert _one(database_client, "SELECT id,account_subtype_label FROM account_types WHERE id=%s", (seed_id,)) == (seed_id, "Edited source")
    with database_client.cursor() as cursor:
        cursor.execute("DELETE FROM account_types WHERE id=%s", (seed_id,))
    database_client.commit()
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_types"):
        job.run(cfg)
    assert source["sync_status"] == "create-failed"
    assert source["sync_notes"] == "classification_not_in_existing_catalog"


@pytest.mark.parametrize("database_client", [18], indirect=True)
@pytest.mark.parametrize("group,subtype", [("asset", "investment"), ("asset", "Not_Snake"), ("investment", "current")])
def test_migration_rejects_ambiguous_or_reserved_existing_keys_atomically(database_client: Any, group: str, subtype: str) -> None:
    with database_client.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_types(account_type_key,account_type_label,account_subtype_key,account_subtype_label,created_at,updated_at)
            VALUES(%s,'Legacy group',%s,'Legacy subtype',now(),now()) RETURNING id""",
            (group, subtype),
        )
        identity = cursor.fetchone()[0]
    database_client.commit()
    with pytest.raises(ValueError, match="account_types_existing_keys_require_reconciliation"):
        migration(MODULE_ROOT / "migrations/0019_account_types_sheet_sync.py").upgrade(database_client)
    assert _one(database_client, "SELECT id FROM account_types WHERE id=%s", (identity,)) == (identity,)
    assert _one(database_client, "SELECT count(*) FROM information_schema.columns WHERE table_name='account_types' AND column_name='is_sheet_managed'") == (0,)


def test_duplicate_subtype_across_groups_is_rejected_without_inserting(database_client: Any) -> None:
    row = _row(account_subtype_key="custom-unique")
    _register(database_client, row)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [row]) == 0
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [_row(account_type_key="investment", account_type_label="Investment", account_subtype_key="custom-unique")]) == 1
    assert _one(database_client, "SELECT count(*) FROM account_types WHERE account_subtype_key='custom-unique'") == (1,)


def test_account_type_references_are_locked_until_dependency_commit(database_client: Any) -> None:
    configure_test_account_types(database_client)
    assert categories._resolve_account_types(database_client, "current")
    with psycopg2.connect(database_client.dsn) as competing:
        with competing.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout='50ms'")
            with pytest.raises(psycopg2.errors.LockNotAvailable):
                cursor.execute("SELECT id FROM account_types WHERE account_subtype_key='current' FOR UPDATE")
        competing.rollback()
    database_client.rollback()


@pytest.mark.parametrize("hint_field,table", [("source_account_types", "category_source_account_types"), ("target_account_types", "category_target_account_types")])
def test_normal_category_sync_refreshes_only_changed_investment_groups(database_client: Any, hint_field: str, table: str) -> None:
    configure_test_account_types(database_client)
    category = {
        "id": str(uuid4()),
        "tx_type_key": "money-out",
        "tx_type_label": "Money Out",
        "major_category_key": "investing",
        "major_category_label": "Investing",
        "minor_category_key": "funds",
        "minor_category_label": "Funds",
        "record_status": "active",
        "sync_status": "create-pending",
        hint_field: "investment",
    }
    assert categories.upsert_categories(database_client, RecordingSheets(), [category], 1) == 0
    category["sync_status"] = "in-sync"
    original = _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],))
    quiet = RecordingSheets()
    assert categories.upsert_categories(database_client, quiet, [category], 1) == 0
    assert quiet.updates == []
    assert _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],)) == original
    new_type = _row(account_type_key="investment", account_type_label="Investment", account_subtype_key="new-investment")
    _register(database_client, new_type)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [new_type]) == 0
    refreshed = RecordingSheets()
    assert categories.upsert_categories(database_client, refreshed, [category], 1) == 0
    assert refreshed.updates[0][1][2][0] == "in-sync"
    assert category["sync_status"] == "in-sync"
    assert _one(database_client, f"SELECT account_type_id FROM {table} WHERE category_id=%s AND account_type_id=%s", (category["id"], new_type["id"])) == (new_type["id"],)
    after_refresh = _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],))
    again = RecordingSheets()
    assert categories.upsert_categories(database_client, again, [category], 1) == 0
    assert not again.updates
    assert _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],)) == after_refresh
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [{**new_type, "record_status": "inactive", "sync_status": "update-pending"}]) == 1


def test_source_change_rolls_back_category_dependency_refresh_without_acknowledgement(database_client: Any) -> None:
    configure_test_account_types(database_client)
    category = {
        "id": str(uuid4()),
        "tx_type_key": "money-out",
        "tx_type_label": "Money Out",
        "major_category_key": "investing",
        "major_category_label": "Investing",
        "minor_category_key": "funds",
        "minor_category_label": "Funds",
        "record_status": "active",
        "sync_status": "create-pending",
        "source_account_types": "investment",
    }
    assert categories.upsert_categories(database_client, RecordingSheets(), [category], 1) == 0
    category["sync_status"] = "in-sync"
    new_type = _row(account_type_key="investment", account_type_label="Investment", account_subtype_key="new-investment")
    _register(database_client, new_type)
    assert account_types.upsert_account_types(database_client, RecordingSheets(), [new_type]) == 0
    before = _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],))

    def guard() -> None:
        raise ValueError("sheet_changed_before_acknowledgement:category_master")

    sheets = RecordingSheets()
    with pytest.raises(ValueError, match="sheet_changed_before_acknowledgement:category_master"):
        categories.upsert_categories(database_client, sheets, [category], 1, before_dependency_commit=guard)
    assert not sheets.updates
    assert _one(database_client, "SELECT count(*) FROM category_source_account_types WHERE account_type_id=%s", (new_type["id"],)) == (0,)
    assert _one(database_client, "SELECT updated_at FROM category_master WHERE id=%s", (category["id"],)) == before
