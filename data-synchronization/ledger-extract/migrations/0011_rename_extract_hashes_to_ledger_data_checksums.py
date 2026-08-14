from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("ALTER TABLE extract_hashes RENAME TO ledger_data_checksums;")
        cursor.execute("ALTER TABLE ledger_data_checksums RENAME CONSTRAINT pk_extract_hashes TO pk_ledger_data_checksums;")
    client.commit()
