from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transaction_beneficiaries (
                id                UUID            NOT NULL DEFAULT gen_random_uuid(),
                transaction_ref   UUID            NOT NULL,
                beneficiary_id    UUID            NOT NULL,
                split_percentage  NUMERIC(7, 4)   NOT NULL,
                created_at        TIMESTAMPTZ     NOT NULL,

                CONSTRAINT pk_transaction_beneficiaries             PRIMARY KEY (id),
                CONSTRAINT fk_transaction_beneficiaries_transaction FOREIGN KEY (transaction_ref) REFERENCES transaction_master(id),
                CONSTRAINT fk_transaction_beneficiaries_beneficiary FOREIGN KEY (beneficiary_id) REFERENCES beneficiaries_master(id),
                CONSTRAINT uq_transaction_beneficiaries_pair        UNIQUE (transaction_ref, beneficiary_id),
                CONSTRAINT chk_transaction_beneficiaries_split_pct  CHECK (split_percentage > 0 AND split_percentage <= 100)
            );
        """)

    client.commit()
