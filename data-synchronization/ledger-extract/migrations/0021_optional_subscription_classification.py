"""Preserve optional source classification without inventing a category."""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("""ALTER TABLE subscription_master
                ALTER COLUMN category_id DROP NOT NULL,
                ADD COLUMN tx_type TEXT,
                ADD COLUMN major_category TEXT,
                ADD COLUMN minor_category TEXT,
                ADD CONSTRAINT chk_sm_tx_type CHECK (tx_type IN ('money-in', 'money-out'))
            """)
            # Existing rows always had a resolved category. Recover their known
            # classification while retaining IDs, FKs and ingestion audit times.
            cursor.execute("""UPDATE subscription_master s
                SET tx_type=c.tx_type_key, major_category=c.major_category_key,
                    minor_category=c.minor_category_key
                FROM category_master c WHERE c.id=s.category_id
            """)
        client.commit()
    except Exception:
        client.rollback()
        raise
