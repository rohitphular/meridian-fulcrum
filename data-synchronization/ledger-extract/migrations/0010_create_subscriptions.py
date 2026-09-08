from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS subscription_master (
                id                              UUID        NOT NULL DEFAULT gen_random_uuid(),
                subscription_id                 TEXT        NOT NULL,
                name                            TEXT        NOT NULL,
                counterparty_id                 UUID,
                amount_local                    BIGINT      NOT NULL,
                frequency                       TEXT        NOT NULL,
                day_of_month                    INTEGER,
                day_of_week                     INTEGER,
                account_id                      UUID        NOT NULL,
                category_id                     UUID        NOT NULL,
                description                     TEXT,
                subscription_start_date_local   TIMESTAMPTZ NOT NULL,
                subscription_end_date_local     TIMESTAMPTZ,
                subscription_timezone_local     TEXT,
                record_status                   TEXT        NOT NULL,
                created_at                      TIMESTAMPTZ NOT NULL,
                updated_at                      TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_sm                    PRIMARY KEY (id),
                CONSTRAINT uq_sm_subscription_id    UNIQUE (subscription_id),
                CONSTRAINT fk_sm_account            FOREIGN KEY (account_id) REFERENCES account_master(id),
                CONSTRAINT fk_sm_category           FOREIGN KEY (category_id) REFERENCES category_master(id),
                CONSTRAINT fk_sm_counterparty       FOREIGN KEY (counterparty_id) REFERENCES counterparty_master(id),
                CONSTRAINT chk_sm_frequency         CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'annual')),
                CONSTRAINT chk_sm_record_status     CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
                CONSTRAINT chk_sm_amount_positive   CHECK (amount_local > 0),
                CONSTRAINT chk_sm_day_of_month      CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)),
                CONSTRAINT chk_sm_day_of_week       CHECK (day_of_week IS NULL OR (day_of_week >= 1 AND day_of_week <= 7)),
                CONSTRAINT chk_sm_date_range        CHECK (subscription_end_date_local IS NULL OR subscription_end_date_local >= subscription_start_date_local)
            );
        """)

    client.commit()
