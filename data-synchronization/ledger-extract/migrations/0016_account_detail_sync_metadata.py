"""Accept source lifecycle status without inventing values for historical rows."""

from typing import Any

_NEW_STATUS_TABLES = (
    "account_deposit_details",
    "account_revolving_credit_details",
    "account_installment_loan_details",
    "account_property_details",
)


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        for table in _NEW_STATUS_TABLES:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS record_status TEXT")
        for table in (*_NEW_STATUS_TABLES, "account_market_investment_details"):
            constraint = f"chk_{table}_record_status"
            cursor.execute("SELECT 1 FROM pg_constraint WHERE conrelid=%s::regclass AND conname=%s", (table, constraint))
            if cursor.fetchone() is None:
                cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT {constraint} CHECK (record_status IN ('active','inactive','deleted','locked'))")
    client.commit()
