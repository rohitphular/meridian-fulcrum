from __future__ import annotations

from typing import Any


def get_hash(conn: Any, entity: str, natural_key: str) -> dict | None:
    """Return {row_hash, last_seen_at} or None if not found."""
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT row_hash, last_seen_at FROM ledger_data_checksums WHERE entity = %s AND natural_key = %s",
            (entity, natural_key),
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return {"row_hash": row[0], "last_seen_at": row[1]}


def update_last_seen(conn: Any, entity: str, natural_key: str) -> None:
    """UPDATE last_seen_at = now() WHERE entity = %s AND natural_key = %s. Commits."""
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE ledger_data_checksums SET last_seen_at = now() WHERE entity = %s AND natural_key = %s",
            (entity, natural_key),
        )
    conn.commit()


def insert_hash(conn: Any, entity: str, natural_key: str, row_hash: str) -> None:
    """INSERT (entity, natural_key, row_hash, last_seen_at = now()). Does NOT commit — caller manages transaction."""
    with conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO ledger_data_checksums (entity, natural_key, row_hash, last_seen_at) VALUES (%s, %s, %s, now())",
            (entity, natural_key, row_hash),
        )


def update_hash(conn: Any, entity: str, natural_key: str, row_hash: str) -> None:
    """UPDATE row_hash = %s, last_seen_at = now(). Does NOT commit — caller manages transaction."""
    with conn.cursor() as cursor:
        cursor.execute(
            "UPDATE ledger_data_checksums SET row_hash = %s, last_seen_at = now() WHERE entity = %s AND natural_key = %s",
            (row_hash, entity, natural_key),
        )


def delete_hash(conn: Any, entity: str, natural_key: str) -> None:
    """DELETE WHERE entity = %s AND natural_key = %s. Does NOT commit — caller manages transaction."""
    with conn.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ledger_data_checksums WHERE entity = %s AND natural_key = %s",
            (entity, natural_key),
        )


def get_all_keys(conn: Any, entity: str) -> set[str]:
    """SELECT natural_key WHERE entity = %s. Returns set of all active natural keys."""
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT natural_key FROM ledger_data_checksums WHERE entity = %s",
            (entity,),
        )
        rows = cursor.fetchall()
    return {row[0] for row in rows}
