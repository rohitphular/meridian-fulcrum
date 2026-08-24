from typing import Any

_SEED = [
    ("XAU", "nanogram"),
    ("USD", "cent"),
    ("EUR", "cent"),
    ("GBP", "pence"),
    ("INR", "paisa"),
    ("JPY", "yen"),
    ("CNY", "fen"),
    ("AUD", "cent"),
    ("CAD", "cent"),
    ("CHF", "centime"),
    ("SGD", "cent"),
    ("AED", "fils"),
    ("HKD", "cent"),
    ("BRL", "centavo"),
    ("KRW", "won"),
    ("BTC", "satoshi"),
    ("ETH", "szabo"),
    ("SOL", "microsol"),
]


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE currency_master ADD COLUMN IF NOT EXISTS minor_unit_name TEXT")
        cursor.executemany(
            "UPDATE currency_master SET minor_unit_name = %s WHERE currency_code = %s",
            [(minor_unit_name, currency_code) for currency_code, minor_unit_name in _SEED],
        )
        cursor.execute("SELECT COUNT(*) FROM currency_master WHERE minor_unit_name IS NULL")
        null_count = cursor.fetchone()[0]
        if null_count > 0:
            raise RuntimeError(f"upgrade: minor_unit_name_not_seeded null_count={null_count}")
        cursor.execute("ALTER TABLE currency_master ALTER COLUMN minor_unit_name SET NOT NULL")
    client.commit()
