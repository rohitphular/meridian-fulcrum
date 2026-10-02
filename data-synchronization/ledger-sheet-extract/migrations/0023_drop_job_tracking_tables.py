"""Drop the unused job tracking tables.

job_execution_details only recorded the Drive modified time after a successful run (never a
skip gate), and ledger_data_checksums was never read or written. Created by 0001.
"""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS job_execution_details")
            cursor.execute("DROP TABLE IF EXISTS ledger_data_checksums")
        client.commit()
    except Exception:
        client.rollback()
        raise
