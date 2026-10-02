from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS beneficiaries_master (
                id                   UUID            NOT NULL DEFAULT gen_random_uuid(),
                beneficiary_name     TEXT            NOT NULL,
                beneficiary_details  TEXT,
                record_status        TEXT            NOT NULL DEFAULT 'active',
                created_at           TIMESTAMPTZ     NOT NULL,
                updated_at           TIMESTAMPTZ     NOT NULL,

                CONSTRAINT pk_beneficiaries_master         PRIMARY KEY (id),
                CONSTRAINT uq_beneficiaries_master_name    UNIQUE (beneficiary_name),
                CONSTRAINT chk_beneficiaries_master_status CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))
            );
        """)

    client.commit()
