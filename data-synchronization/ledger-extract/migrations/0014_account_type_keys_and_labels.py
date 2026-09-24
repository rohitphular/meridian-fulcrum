from typing import Any


def upgrade(client: Any) -> None:
    """Add readable labels while retaining reference UUIDs, keys and dependent links."""
    with client.cursor() as cursor:
        # PostgreSQL updates dependent foreign-key definitions when columns rename.
        cursor.execute("ALTER TABLE account_types RENAME COLUMN account_type TO account_type_key")
        cursor.execute("ALTER TABLE account_types RENAME COLUMN account_subtype TO account_subtype_key")
        cursor.execute("ALTER TABLE account_types ADD COLUMN account_type_label TEXT, ADD COLUMN account_subtype_label TEXT")
        # Match expense-tracker's type labels and _subTypeLabel special cases.
        # Preserve locally added reference rows by deriving labels from their keys.
        cursor.execute("""
            UPDATE account_types SET
                account_type_label = initcap(replace(account_type_key, '_', ' ')),
                account_subtype_label = CASE account_subtype_key
                    WHEN 'stocks_shares' THEN 'Stocks & Shares'
                    WHEN 'p2p_lending' THEN 'P2P Lending'
                    WHEN 'pension_sipp' THEN 'Pension / SIPP'
                    WHEN 'fixed_deposit' THEN 'Fixed Deposit'
                    WHEN 'isa' THEN 'ISA'
                    ELSE initcap(replace(account_subtype_key, '_', ' '))
                END,
                updated_at = now()
        """)
        cursor.execute("""
            ALTER TABLE account_types
                ALTER COLUMN account_type_label SET NOT NULL,
                ALTER COLUMN account_subtype_label SET NOT NULL
        """)
    client.commit()
