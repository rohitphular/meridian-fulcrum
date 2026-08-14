from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS extract_hashes (
                entity        TEXT        NOT NULL,
                natural_key   TEXT        NOT NULL,
                row_hash      TEXT        NOT NULL,
                last_seen_at  TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_extract_hashes PRIMARY KEY (entity, natural_key)
            );
        """)
    client.commit()
