from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    """Capture the rate actually used; historical values cannot be inferred from mutable rates."""
    with client.cursor() as cursor:
        for table in ("account_master", "transaction_master"):
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN applied_rate_value NUMERIC(19,8)")
            cursor.execute(
                f"""
                ALTER TABLE {table} ADD CONSTRAINT chk_{table}_applied_rate_value CHECK (
                    applied_rate_value IS NULL OR (
                        applied_rate_value > 0 AND applied_rate_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
                    )
                )
                """
            )
    client.commit()
