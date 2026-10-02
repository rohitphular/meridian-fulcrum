"""Track Sheet ownership and preserve category links when adopting legacy seed UUIDs."""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM account_types WHERE account_type_key NOT IN ('asset','investment','liability')
                    OR account_subtype_key IN ('asset','investment','liability')
                    OR account_subtype_key !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
                ) OR EXISTS (SELECT 1 FROM account_types GROUP BY account_subtype_key HAVING count(*) > 1)
            """)
            if cursor.fetchone()[0]:
                raise ValueError("account_types_existing_keys_require_reconciliation")
            cursor.execute("""
                ALTER TABLE account_types
                    ADD COLUMN is_sheet_managed BOOLEAN NOT NULL DEFAULT FALSE,
                    ADD COLUMN sync_status TEXT,
                    ADD COLUMN sync_date TIMESTAMPTZ,
                    ADD COLUMN sync_notes TEXT,
                    DROP CONSTRAINT chk_account_types_record_status,
                    ADD CONSTRAINT chk_account_types_record_status CHECK (record_status IN ('active','inactive','deleted','locked')),
                    ADD CONSTRAINT chk_account_types_sync_status CHECK (sync_status IN ('in-sync','create-pending','create-failed','update-pending','update-failed')),
                    ADD CONSTRAINT uq_account_types_subtype_key UNIQUE (account_subtype_key),
                    ADD CONSTRAINT chk_account_types_type_key CHECK (account_type_key IN ('asset','investment','liability')),
                    ADD CONSTRAINT chk_account_types_subtype_key CHECK (
                        account_subtype_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND account_subtype_key NOT IN ('asset','investment','liability'))
            """)
            for table, constraint in (("category_source_account_types", "fk_csat_account_type"), ("category_target_account_types", "fk_ctat_account_type")):
                cursor.execute(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}")
                cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT {constraint} FOREIGN KEY (account_type_id) REFERENCES account_types(id) ON UPDATE CASCADE")
        client.commit()
    except Exception:
        client.rollback()
        raise
