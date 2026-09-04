from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS counterparty_master (
                id                    UUID            NOT NULL DEFAULT gen_random_uuid(),
                counterparty_key      TEXT            NOT NULL,
                counterparty_label    TEXT            NOT NULL,
                location_area         TEXT,
                location_city         TEXT,
                location_country      TEXT,
                location_latitude     NUMERIC(10, 6),
                location_longitude    NUMERIC(10, 6),
                record_status         TEXT            NOT NULL DEFAULT 'active',
                created_at            TIMESTAMPTZ     NOT NULL,
                updated_at            TIMESTAMPTZ     NOT NULL,

                CONSTRAINT pk_counterparty_master              PRIMARY KEY (id),
                CONSTRAINT uq_counterparty_master_key          UNIQUE (counterparty_key),
                CONSTRAINT chk_counterparty_master_status      CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
                CONSTRAINT chk_counterparty_master_location_lat  CHECK (location_latitude BETWEEN -90 AND 90),
                CONSTRAINT chk_counterparty_master_location_lon  CHECK (location_longitude BETWEEN -180 AND 180),
                CONSTRAINT chk_counterparty_master_location_pair CHECK (
                    (location_latitude IS NULL AND location_longitude IS NULL) OR
                    (location_latitude IS NOT NULL AND location_longitude IS NOT NULL)
                )
            );
        """)

        cursor.execute("""
            ALTER TABLE transaction_master
                ADD CONSTRAINT fk_tm_counterparty
                FOREIGN KEY (counterparty_id) REFERENCES counterparty_master(id);
        """)

    client.commit()
