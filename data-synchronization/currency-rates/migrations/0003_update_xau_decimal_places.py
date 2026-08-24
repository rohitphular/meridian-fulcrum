from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE currency_master DROP CONSTRAINT IF EXISTS chk_cm_decimal_places")
        cursor.execute("ALTER TABLE currency_master ADD CONSTRAINT chk_cm_decimal_places CHECK (decimal_places BETWEEN 0 AND 9)")
        cursor.execute("UPDATE currency_master SET decimal_places = 9, updated_at = NOW() WHERE currency_code = 'XAU'")
        cursor.execute("ALTER TABLE currency_master ADD CONSTRAINT chk_cm_xau_dp_pinned CHECK (currency_code != 'XAU' OR decimal_places = 9)")
    client.commit()
