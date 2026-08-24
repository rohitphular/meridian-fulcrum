from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("DROP VIEW IF EXISTS v_rates_to_gbp")
        cursor.execute("DROP VIEW IF EXISTS v_latest_rates")
        cursor.execute("ALTER TABLE currency_rates ALTER COLUMN rate_value TYPE NUMERIC(19, 8)")
    client.commit()
