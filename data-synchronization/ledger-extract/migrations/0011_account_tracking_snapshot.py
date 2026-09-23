from typing import Any


def upgrade(client: Any) -> None:
    """Retain the opening snapshot date separately from the real account open date."""
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE account_master ADD COLUMN IF NOT EXISTS tracking_start_date_local TEXT")
        cursor.execute("ALTER TABLE account_master DROP CONSTRAINT IF EXISTS chk_am_rate_ref_required")
        cursor.execute("""
            ALTER TABLE account_master ADD CONSTRAINT chk_am_rate_ref_required CHECK (
                local_currency = base_currency OR currency_rate_id IS NOT NULL OR
                (opening_amount_local_value = 0 AND opening_amount_base_value = 0)
            )
        """)
    client.commit()
