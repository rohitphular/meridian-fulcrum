"""Upgrade the deployed extension schema without replacing supported records."""

from typing import Any
from uuid import uuid4

import psycopg2
import pytest

from tests.integration.postgres_support import MODULE_ROOT, migration

_MIGRATION = MODULE_ROOT / "migrations/0018_align_account_detail_tables.py"
_DESTINATIONS = {
    "account_deposit": ("account_deposit_details", "current"),
    "account_liability_credit_card": ("account_revolving_credit_details", "credit_card"),
    "account_investment_property": ("account_property_details", "property"),
    "account_investment_stocks": ("account_market_investment_details", "stocks_shares"),
    "account_liability_mortgage": ("account_installment_loan_details", "mortgage"),
    "account_liability_personal_loan": ("account_installment_loan_details", "personal_loan"),
}


def _seed_detail(conn: Any, table: str, subtype: str, source: str | None) -> tuple[str, str, tuple]:
    owner, identity = str(uuid4()), str(uuid4())
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_master (id,account_name,account_type,account_subtype,local_currency,base_currency,
               opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
               SELECT %s,'Migration fixture',account_type_key,account_subtype_key,'XAU','XAU',0,0,'active',now(),now()
               FROM account_types WHERE account_subtype_key=%s""",
            (owner, subtype),
        )
        assert cursor.rowcount == 1
        cursor.execute(
            f"""INSERT INTO {table} (id,account_master_id,local_currency,base_currency,source_sheet,created_at,updated_at)
               VALUES (%s,%s,'XAU','XAU',%s,'2020-01-01','2020-02-02') RETURNING *""",
            (identity, owner, source),
        )
        original = cursor.fetchone()
    conn.commit()
    return identity, owner, original


def _exists(conn: Any, table: str) -> bool:
    with conn.cursor() as cursor:
        cursor.execute("SELECT to_regclass(%s) IS NOT NULL", (table,))
        return cursor.fetchone()[0]


@pytest.mark.parametrize("database_client", [17], indirect=True)
def test_rename_and_split_preserve_every_supported_column_and_remove_retired_details(database_client: Any) -> None:
    originals = {}
    for table, (previous, subtype) in _DESTINATIONS.items():
        for source in (None, table):
            identity, owner, original = _seed_detail(database_client, previous, subtype, source)
            originals[(table, identity)] = (owner, original)
    retired_owners = []
    for table, subtype, source in (
        ("account_fixed_income_details", "bonds", "account_investment_fixed_income"),
        ("account_p2p_lending_details", "p2p_lending", "account_investment_p2p_lending"),
    ):
        _, owner, _ = _seed_detail(database_client, table, subtype, source)
        retired_owners.append(owner)
    migration(_MIGRATION).upgrade(database_client)
    with database_client.cursor() as cursor:
        for (table, identity), (owner, original) in originals.items():
            cursor.execute(f"SELECT * FROM {table} WHERE id=%s", (identity,))
            assert cursor.fetchone() == original
        for owner in retired_owners:
            cursor.execute("SELECT id FROM account_master WHERE id=%s", (owner,))
            assert cursor.fetchone() == (owner,)
        for table in ("account_liability_mortgage", "account_liability_personal_loan"):
            cursor.execute("SELECT count(*) FROM pg_constraint WHERE conrelid=%s::regclass AND contype='f'", (table,))
            assert cursor.fetchone() == (3,)  # Owner, rate, and retained property link.
            cursor.execute("SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename=%s", (table,))
            assert cursor.fetchone() == (4,)  # PK, effective-time uniqueness, current row, provenance.
    for previous in {old for old, _ in _DESTINATIONS.values()} | {"account_fixed_income_details", "account_p2p_lending_details"}:
        assert not _exists(database_client, previous)


@pytest.mark.parametrize("database_client", [17], indirect=True)
@pytest.mark.parametrize("subtype,source", [("auto_loan", None), ("mortgage", "account_liability_personal_loan")])
def test_ambiguous_loan_classification_rolls_back_entire_migration(database_client: Any, subtype: str, source: str | None) -> None:
    identity, _, original = _seed_detail(database_client, "account_installment_loan_details", subtype, source)
    with pytest.raises(ValueError, match="account_detail_loan_classification_requires_reconciliation"):
        migration(_MIGRATION).upgrade(database_client)
    with database_client.cursor() as cursor:
        cursor.execute("SELECT * FROM account_installment_loan_details WHERE id=%s", (identity,))
        assert cursor.fetchone() == original
    for table, (previous, _) in _DESTINATIONS.items():
        assert not _exists(database_client, table)
        assert _exists(database_client, previous)
    assert _exists(database_client, "account_fixed_income_details")


@pytest.mark.parametrize("database_client", [17], indirect=True)
@pytest.mark.parametrize("dependency", ["account_installment_loan_details", "account_p2p_lending_details"])
def test_unknown_dependent_view_blocks_drop_and_rolls_back_renames(database_client: Any, dependency: str) -> None:
    with database_client.cursor() as cursor:
        cursor.execute(f"CREATE VIEW external_detail_report AS SELECT id FROM {dependency}")
    database_client.commit()
    with pytest.raises(psycopg2.errors.DependentObjectsStillExist):
        migration(_MIGRATION).upgrade(database_client)
    for table, (previous, _) in _DESTINATIONS.items():
        assert not _exists(database_client, table)
        assert _exists(database_client, previous)
    assert _exists(database_client, "external_detail_report")
    assert _exists(database_client, "account_fixed_income_details")
    assert _exists(database_client, "account_p2p_lending_details")


@pytest.mark.parametrize("table,other", [("account_liability_mortgage", "account_liability_personal_loan"), ("account_liability_personal_loan", "account_liability_mortgage")])
def test_split_tables_enforce_foreign_keys_and_independent_source_provenance(database_client: Any, table: str, other: str) -> None:
    with pytest.raises(psycopg2.errors.ForeignKeyViolation), database_client.cursor() as cursor:
        cursor.execute(f"INSERT INTO {table} (account_master_id,local_currency,base_currency) VALUES (%s,'XAU','XAU')", (str(uuid4()),))
    database_client.rollback()
    _, subtype = _DESTINATIONS[table]
    identity, _, _ = _seed_detail(database_client, table, subtype.replace("_", "-"), table)
    with pytest.raises(psycopg2.errors.CheckViolation), database_client.cursor() as cursor:
        cursor.execute(f"UPDATE {table} SET source_sheet=%s WHERE id=%s", (other, identity))
    database_client.rollback()
