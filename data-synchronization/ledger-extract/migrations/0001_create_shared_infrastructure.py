from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ledger_data_checksums (
                entity        TEXT        NOT NULL,
                natural_key   TEXT        NOT NULL,
                row_hash      TEXT        NOT NULL,
                last_seen_at  TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_ledger_data_checksums PRIMARY KEY (entity, natural_key)
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS job_execution_details (
                job_name               TEXT        NOT NULL,
                last_sheet_modified_at TIMESTAMPTZ,
                ran_at                 TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_job_execution_details PRIMARY KEY (job_name)
            );
        """)
    client.commit()
