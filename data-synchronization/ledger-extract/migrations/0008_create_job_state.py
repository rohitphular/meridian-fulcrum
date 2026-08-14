from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS job_state (
                job_name               TEXT        NOT NULL,
                last_sheet_modified_at TIMESTAMPTZ,
                ran_at                 TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_job_state PRIMARY KEY (job_name)
            );
        """)
    client.commit()
