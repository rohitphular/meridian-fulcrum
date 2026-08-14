from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE job_state RENAME TO job_execution_details;")
        cursor.execute("ALTER TABLE job_execution_details RENAME CONSTRAINT pk_job_state TO pk_job_execution_details;")
    client.commit()
