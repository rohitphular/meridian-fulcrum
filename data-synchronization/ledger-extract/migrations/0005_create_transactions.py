from __future__ import annotations

from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            DO $$ BEGIN
                CREATE TYPE day_of_week_enum AS ENUM (
                    'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'
                );
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """)

        cursor.execute("DROP TABLE IF EXISTS transactions")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transaction_master (
                id                      UUID             NOT NULL DEFAULT gen_random_uuid(),
                transaction_id          TEXT             NOT NULL,
                parent_tx_id            TEXT,
                tx_date_time_base       TIMESTAMPTZ      NOT NULL,
                tx_date_time_local      TIMESTAMP        NOT NULL,
                tx_timezone_base        TEXT             NOT NULL,
                tx_timezone_local       TEXT             NOT NULL,
                tx_day_of_week_base     day_of_week_enum NOT NULL,
                tx_day_of_week_local    day_of_week_enum NOT NULL,
                category_id             UUID             NOT NULL,
                account_id              UUID             NOT NULL,
                tx_amount_local         BIGINT           NOT NULL,
                tx_amount_base          BIGINT           NOT NULL,
                local_currency          TEXT             NOT NULL,
                base_currency           TEXT             NOT NULL,
                currency_rate_ref       UUID,
                tx_description          TEXT,
                counterparty_id         UUID,
                tx_tags                 TEXT,
                user_location_area      TEXT,
                user_location_city      TEXT,
                user_location_country   TEXT,
                user_location_latitude  NUMERIC(10, 6),
                user_location_longitude NUMERIC(10, 6),
                record_status           TEXT             NOT NULL DEFAULT 'active',
                created_at              TIMESTAMPTZ      NOT NULL,
                updated_at              TIMESTAMPTZ      NOT NULL,

                CONSTRAINT pk_tm                    PRIMARY KEY (id),
                CONSTRAINT uq_tm_transaction_id     UNIQUE (transaction_id),
                CONSTRAINT fk_tm_parent_tx          FOREIGN KEY (parent_tx_id) REFERENCES transaction_master(transaction_id),
                CONSTRAINT fk_tm_account            FOREIGN KEY (account_id) REFERENCES account_master(id),
                CONSTRAINT fk_tm_rate_ref           FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT fk_tm_category           FOREIGN KEY (category_id) REFERENCES category_master(id),
                CONSTRAINT chk_tm_record_status     CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
                CONSTRAINT chk_tm_tx_amount_base    CHECK (tx_amount_base > 0),
                CONSTRAINT chk_tm_tx_amount_local   CHECK (tx_amount_local > 0),
                CONSTRAINT chk_tm_base_currency     CHECK (base_currency = 'XAU'),
                CONSTRAINT chk_tm_local_currency    CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_tm_tx_timezone_base  CHECK (tx_timezone_base = 'UTC'),
                CONSTRAINT chk_tm_rate_ref_required CHECK (
                    (local_currency = 'XAU' AND currency_rate_ref IS NULL) OR
                    (local_currency != 'XAU' AND currency_rate_ref IS NOT NULL)
                ),
                CONSTRAINT chk_tm_location_pair     CHECK (
                    (user_location_latitude IS NULL AND user_location_longitude IS NULL) OR
                    (user_location_latitude IS NOT NULL AND user_location_longitude IS NOT NULL)
                ),
                CONSTRAINT chk_tm_location_lat      CHECK (user_location_latitude BETWEEN -90 AND 90),
                CONSTRAINT chk_tm_location_lon      CHECK (user_location_longitude BETWEEN -180 AND 180)
            );
        """)

    client.commit()
