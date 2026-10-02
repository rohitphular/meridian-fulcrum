"""Match the six supported Sheet names and retire fixed-income/P2P details.

Historical migrations remain unchanged for databases that already applied them.
Supported rows, including legacy history, keep every column and their UUIDs.
"""

from typing import Any

from psycopg2 import sql

_RENAMES = {
    "account_deposit_details": "account_deposit",
    "account_revolving_credit_details": "account_liability_credit_card",
    "account_property_details": "account_investment_property",
    "account_market_investment_details": "account_investment_stocks",
}
_LOANS = {"account_liability_mortgage": "mortgage", "account_liability_personal_loan": "personal_loan"}
_OLD_LOANS = "account_installment_loan_details"
_RETIRED = ("account_fixed_income_details", "account_p2p_lending_details")


def _rename_schema_objects(cursor: Any, table: str, previous: str) -> None:
    cursor.execute("SELECT conname FROM pg_constraint WHERE conrelid=%s::regclass", (table,))
    for (constraint,) in cursor.fetchall():
        if previous in constraint:
            cursor.execute(sql.SQL("ALTER TABLE {} RENAME CONSTRAINT {} TO {}").format(sql.Identifier(table), sql.Identifier(constraint), sql.Identifier(constraint.replace(previous, table))))
    cursor.execute("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename=%s", (table,))
    for (index,) in cursor.fetchall():
        if previous in index:
            cursor.execute(sql.SQL("ALTER INDEX {} RENAME TO {}").format(sql.Identifier(index), sql.Identifier(index.replace(previous, table))))


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            # Hold account subtypes and all detail rows stable throughout the split.
            cursor.execute("LOCK TABLE account_master IN SHARE MODE")
            tables = (*_RENAMES, _OLD_LOANS, *_RETIRED)
            cursor.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(sql.SQL(", ").join(map(sql.Identifier, tables))))
            cursor.execute(
                """SELECT 1 FROM account_installment_loan_details detail
                   JOIN account_master account ON account.id=detail.account_master_id
                   WHERE account.account_subtype NOT IN ('mortgage','personal_loan')
                      OR (detail.source_sheet IS NOT NULL AND detail.source_sheet <>
                          CASE account.account_subtype WHEN 'mortgage' THEN 'account_liability_mortgage'
                               WHEN 'personal_loan' THEN 'account_liability_personal_loan' END)
                   LIMIT 1"""
            )
            if cursor.fetchone() is not None:
                raise ValueError("account_detail_loan_classification_requires_reconciliation")

            cursor.execute("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=%s::regclass AND contype='f'", (_OLD_LOANS,))
            foreign_keys = cursor.fetchall()
            for table, subtype in _LOANS.items():
                # LIKE copies all columns/defaults, checks and indexes, but not FKs.
                cursor.execute(sql.SQL("CREATE TABLE {} (LIKE {} INCLUDING ALL)").format(sql.Identifier(table), sql.Identifier(_OLD_LOANS)))
                for name, definition in foreign_keys:
                    cursor.execute(sql.SQL("ALTER TABLE {} ADD CONSTRAINT {} {}").format(sql.Identifier(table), sql.Identifier(name.replace(_OLD_LOANS, table)), sql.SQL(definition)))
                cursor.execute(sql.SQL("ALTER TABLE {} DROP CONSTRAINT {}").format(sql.Identifier(table), sql.Identifier(f"chk_{_OLD_LOANS}_source_sheet")))
                cursor.execute(
                    sql.SQL("ALTER TABLE {} ADD CONSTRAINT {} CHECK (source_sheet IS NULL OR source_sheet = %s)").format(sql.Identifier(table), sql.Identifier(f"chk_{table}_source_sheet")), (table,)
                )
                cursor.execute(
                    sql.SQL("INSERT INTO {} SELECT detail.* FROM {} detail JOIN account_master account ON account.id=detail.account_master_id WHERE account.account_subtype=%s").format(
                        sql.Identifier(table), sql.Identifier(_OLD_LOANS)
                    ),
                    (subtype,),
                )
                _rename_schema_objects(cursor, table, _OLD_LOANS)
            # RESTRICT is deliberate: unknown dependent views/FKs require an
            # explicit migration instead of silently losing their dependencies.
            cursor.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(_OLD_LOANS)))
            for previous, table in _RENAMES.items():
                cursor.execute(sql.SQL("ALTER TABLE {} RENAME TO {}").format(sql.Identifier(previous), sql.Identifier(table)))
                _rename_schema_objects(cursor, table, previous)
            for table in _RETIRED:
                cursor.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(table)))
        client.commit()
    except Exception:
        client.rollback()
        raise
