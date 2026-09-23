from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    """Match GAS subscriptions: start dates are optional, never invented by the extract."""
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE subscription_master ALTER COLUMN subscription_start_date_local DROP NOT NULL")
    client.commit()
