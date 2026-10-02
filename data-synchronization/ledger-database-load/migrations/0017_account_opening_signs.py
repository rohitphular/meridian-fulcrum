from typing import Any


def upgrade(client: Any) -> None:
    """Preserve signed asset/investment snapshots allowed by the Sheet contract."""
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE account_master DROP CONSTRAINT chk_am_opening_value_sign")
        cursor.execute("ALTER TABLE account_master DROP CONSTRAINT chk_am_base_value_sign")
        cursor.execute("""
            ALTER TABLE account_master ADD CONSTRAINT chk_am_opening_value_sign CHECK (
                account_type <> 'liability' OR opening_amount_local_value <= 0
            )
        """)
        cursor.execute("""
            ALTER TABLE account_master ADD CONSTRAINT chk_am_base_value_sign CHECK (
                account_type <> 'liability' OR opening_amount_base_value <= 0
            )
        """)
    client.commit()
