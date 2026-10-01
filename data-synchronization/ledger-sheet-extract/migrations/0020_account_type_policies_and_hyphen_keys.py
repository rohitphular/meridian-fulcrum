"""Preserve classification identity while migrating key values and adding source policy."""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("LOCK TABLE account_types, account_master IN ACCESS EXCLUSIVE MODE")
            cursor.execute("""
                SELECT EXISTS (SELECT 1 FROM account_types GROUP BY replace(account_subtype_key,'_','-') HAVING count(*)>1)
                OR EXISTS (SELECT 1 FROM account_types
                    WHERE replace(account_type_key,'_','-') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
                    OR replace(account_subtype_key,'_','-') !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
                OR EXISTS (SELECT 1 FROM account_types s JOIN account_types t
                    ON replace(s.account_subtype_key,'_','-')=replace(t.account_type_key,'_','-'))
            """)
            if cursor.fetchone()[0]:
                raise ValueError("account_type_hyphen_keys_require_reconciliation")
            cursor.execute("ALTER TABLE account_master DROP CONSTRAINT fk_am_account_type_subtype")
            cursor.execute("""ALTER TABLE account_master ADD CONSTRAINT fk_am_account_type_subtype
                FOREIGN KEY (account_type,account_subtype) REFERENCES account_types(account_type_key,account_subtype_key) ON UPDATE CASCADE""")
            cursor.execute("""ALTER TABLE account_types
                DROP CONSTRAINT chk_account_types_type_key,
                DROP CONSTRAINT chk_account_types_subtype_key,
                ADD COLUMN is_loan BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN detail_sheet TEXT,
                ADD CONSTRAINT chk_account_types_detail_sheet CHECK (detail_sheet IS NULL OR detail_sheet IN
                    ('account_deposit','account_investment_property','account_investment_stocks',
                     'account_liability_credit_card','account_liability_mortgage','account_liability_personal_loan'))""")
            cursor.execute("""UPDATE account_types SET account_type_key=replace(account_type_key,'_','-'),
                account_subtype_key=replace(account_subtype_key,'_','-'), sync_status=NULL, sync_date=NULL,
                sync_notes='policy_source_sync_required'""")
            cursor.execute("""ALTER TABLE account_types
                ADD CONSTRAINT chk_account_types_type_key CHECK (account_type_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
                ADD CONSTRAINT chk_account_types_subtype_key CHECK (account_subtype_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')""")
            # Ownership is preserved: new policy fields do not authorize another UUID adoption.
        client.commit()
    except Exception:
        client.rollback()
        raise
