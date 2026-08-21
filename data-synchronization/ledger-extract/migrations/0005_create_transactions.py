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

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id                                  UUID            NOT NULL DEFAULT gen_random_uuid(),
                transaction_id                      TEXT            NOT NULL,
                tx_date_time_base                   TIMESTAMPTZ     NOT NULL,
                tx_date_time_local                  TIMESTAMP       NOT NULL,
                tx_day_of_week_base                day_of_week_enum NOT NULL,
                tx_day_of_week_local               day_of_week_enum NOT NULL,
                tx_type                             TEXT            NOT NULL,
                source_account_id                   UUID,
                target_account_id                   UUID,
                tx_amount_base                      NUMERIC(19,6),
                tx_amount_local                     NUMERIC(19,6)   NOT NULL,
                tx_currency_base                    TEXT,
                tx_currency_local                   TEXT            NOT NULL,
                local_to_base_currency_rate_ref     UUID,
                user_location_area                  TEXT,
                user_location_city                  TEXT,
                user_location_country               TEXT,
                counterparty_name                   TEXT,
                counterparty_location_area          TEXT,
                counterparty_location_city          TEXT,
                counterparty_location_country       TEXT,
                tx_tags                             TEXT,
                tx_description                      TEXT,
                category_id                         UUID,
                row_hash                            TEXT            NOT NULL,
                is_deleted                          BOOLEAN         NOT NULL DEFAULT FALSE,
                created_at                          TIMESTAMPTZ     NOT NULL,
                updated_at                          TIMESTAMPTZ     NOT NULL,
                deleted_at                          TIMESTAMPTZ,

                CONSTRAINT pk_transactions                              PRIMARY KEY (id),
                CONSTRAINT uq_transactions_transaction_id               UNIQUE (transaction_id),
                CONSTRAINT fk_transactions_source_account               FOREIGN KEY (source_account_id) REFERENCES account_master(id),
                CONSTRAINT fk_transactions_target_account               FOREIGN KEY (target_account_id) REFERENCES account_master(id),
                CONSTRAINT fk_transactions_category                     FOREIGN KEY (category_id) REFERENCES category_master(id),
                CONSTRAINT fk_transactions_currency_rate                FOREIGN KEY (local_to_base_currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT chk_transactions_tx_type                     CHECK (tx_type IN ('money-in', 'money-out', 'money-transfer')),
                CONSTRAINT chk_transactions_tx_amount_local             CHECK (tx_amount_local > 0),
                CONSTRAINT chk_transactions_tx_amount_base              CHECK (tx_amount_base IS NULL OR tx_amount_base > 0),
                CONSTRAINT chk_transactions_tx_currency_local           CHECK (char_length(tx_currency_local) = 3 AND tx_currency_local = upper(tx_currency_local)),
                CONSTRAINT chk_transactions_tx_currency_base            CHECK (tx_currency_base IS NULL OR (char_length(tx_currency_base) = 3 AND tx_currency_base = upper(tx_currency_base))),
                CONSTRAINT chk_transactions_base_consistency            CHECK (
                    (tx_amount_base IS NULL AND tx_currency_base IS NULL) OR
                    (tx_amount_base IS NOT NULL AND tx_currency_base IS NOT NULL)
                ),
                CONSTRAINT chk_transactions_soft_delete                 CHECK (
                    (is_deleted = FALSE AND deleted_at IS NULL) OR
                    (is_deleted = TRUE  AND deleted_at IS NOT NULL)
                )
            );
        """)

    client.commit()
