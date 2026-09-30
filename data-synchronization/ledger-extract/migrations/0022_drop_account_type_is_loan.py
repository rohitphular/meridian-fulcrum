"""Retire the unused account-type loan flag; the Sheet no longer supplies it."""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("ALTER TABLE account_types DROP COLUMN IF EXISTS is_loan")
        client.commit()
    except Exception:
        client.rollback()
        raise
