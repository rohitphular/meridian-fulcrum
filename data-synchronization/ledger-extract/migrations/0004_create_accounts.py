from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_master (
                id                         UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_id                 TEXT        NOT NULL,
                account_name               TEXT        NOT NULL,
                account_type               TEXT        NOT NULL,
                account_subtype            TEXT        NOT NULL,
                opening_amount_local_value BIGINT      NOT NULL,
                opening_amount_base_value  BIGINT      NOT NULL,
                local_currency             CHAR(3)     NOT NULL,
                base_currency              CHAR(3)     NOT NULL,
                currency_rate_ref          UUID,
                account_description        TEXT,
                record_status              TEXT        NOT NULL,
                created_at                 TIMESTAMPTZ NOT NULL,
                updated_at                 TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_am                      PRIMARY KEY (id),
                CONSTRAINT uq_am_account_id           UNIQUE (account_id),
                CONSTRAINT fk_am_account_type_subtype FOREIGN KEY (account_type, account_subtype) REFERENCES account_types(account_type, account_subtype),
                CONSTRAINT fk_am_rate_ref             FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT chk_am_account_type        CHECK (account_type IN ('asset', 'investment', 'liability')),
                CONSTRAINT chk_am_record_status       CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
                CONSTRAINT chk_am_local_currency      CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_am_base_currency       CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_am_opening_value_sign  CHECK (
                    (account_type IN ('asset', 'investment') AND opening_amount_local_value >= 0) OR
                    (account_type = 'liability' AND opening_amount_local_value <= 0)
                ),
                CONSTRAINT chk_am_base_value_sign     CHECK (
                    (account_type IN ('asset', 'investment') AND opening_amount_base_value >= 0) OR
                    (account_type = 'liability' AND opening_amount_base_value <= 0)
                ),
                CONSTRAINT chk_am_rate_ref_required   CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_deposit_details (
                id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id           UUID        NOT NULL,
                entity_type                 TEXT,
                entity_id                   UUID,
                current_balance_local_value BIGINT      NOT NULL,
                current_balance_base_value  BIGINT      NOT NULL,
                local_currency              CHAR(3)     NOT NULL,
                base_currency               CHAR(3)     NOT NULL,
                currency_rate_ref           UUID,
                interest_rate               NUMERIC(8,4),
                rate_type                   TEXT,
                interest_payment_frequency  TEXT,
                effective_from_dt           TIMESTAMPTZ NOT NULL,
                effective_to_dt             TIMESTAMPTZ,

                CONSTRAINT pk_account_deposit_details      PRIMARY KEY (id),
                CONSTRAINT fk_add_account_master           FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_add_rate_ref                 FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_add_account_effective_from   UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_add_entity_consistency      CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_add_entity_type             CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_add_local_currency          CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_add_base_currency           CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_add_rate_type               CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_add_rate_consistency        CHECK (
                    (interest_rate IS NULL AND rate_type IS NULL) OR
                    (interest_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_add_interest_frequency      CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
                CONSTRAINT chk_add_frequency_requires_rate CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL),
                CONSTRAINT chk_add_interest_rate           CHECK (interest_rate >= 0),
                CONSTRAINT chk_add_current_balance_local   CHECK (current_balance_local_value >= 0),
                CONSTRAINT chk_add_current_balance_base    CHECK (current_balance_base_value >= 0),
                CONSTRAINT chk_add_rate_ref_required       CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_add_effective_dt_order      CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deposit_details_current
                ON account_deposit_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_market_investment_details (
                id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id         UUID        NOT NULL,
                entity_type               TEXT,
                entity_id                 UUID,
                current_value_local_value BIGINT      NOT NULL,
                current_value_base_value  BIGINT      NOT NULL,
                cost_basis_local_value    BIGINT,
                cost_basis_base_value     BIGINT,
                units_held                NUMERIC(19,6),
                unit_value_local_value    BIGINT,
                unit_value_base_value     BIGINT,
                unit_type                 TEXT,
                local_currency            CHAR(3)     NOT NULL,
                base_currency             CHAR(3)     NOT NULL,
                currency_rate_ref         UUID,
                effective_from_dt         TIMESTAMPTZ NOT NULL,
                effective_to_dt           TIMESTAMPTZ,

                CONSTRAINT pk_account_market_investment_details  PRIMARY KEY (id),
                CONSTRAINT fk_amid_account_master                FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_amid_rate_ref                      FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_amid_account_effective_from        UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_amid_entity_consistency           CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_amid_entity_type                  CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_amid_local_currency               CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_amid_base_currency                CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_amid_units_consistency            CHECK (
                    (units_held IS NULL AND unit_value_local_value IS NULL AND unit_type IS NULL) OR
                    (units_held IS NOT NULL AND unit_value_local_value IS NOT NULL AND unit_type IS NOT NULL)
                ),
                CONSTRAINT chk_amid_cost_basis_consistency       CHECK (
                    (cost_basis_local_value IS NULL AND cost_basis_base_value IS NULL) OR
                    (cost_basis_local_value IS NOT NULL AND cost_basis_base_value IS NOT NULL)
                ),
                CONSTRAINT chk_amid_unit_value_consistency       CHECK (
                    (unit_value_local_value IS NULL AND unit_value_base_value IS NULL) OR
                    (unit_value_local_value IS NOT NULL AND unit_value_base_value IS NOT NULL)
                ),
                CONSTRAINT chk_amid_units_held                   CHECK (units_held >= 0),
                CONSTRAINT chk_amid_unit_value_local             CHECK (unit_value_local_value >= 0),
                CONSTRAINT chk_amid_unit_value_base              CHECK (unit_value_base_value >= 0),
                CONSTRAINT chk_amid_current_value_local          CHECK (current_value_local_value >= 0),
                CONSTRAINT chk_amid_current_value_base           CHECK (current_value_base_value >= 0),
                CONSTRAINT chk_amid_cost_basis_local             CHECK (cost_basis_local_value >= 0),
                CONSTRAINT chk_amid_cost_basis_base              CHECK (cost_basis_base_value >= 0),
                CONSTRAINT chk_amid_rate_ref_required            CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_amid_effective_dt_order           CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_market_investment_details_current
                ON account_market_investment_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_fixed_income_details (
                id                         UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id          UUID        NOT NULL,
                entity_type                TEXT,
                entity_id                  UUID,
                face_value_local_value     BIGINT      NOT NULL,
                face_value_base_value      BIGINT      NOT NULL,
                purchase_price_local_value BIGINT      NOT NULL,
                purchase_price_base_value  BIGINT      NOT NULL,
                current_value_local_value  BIGINT      NOT NULL,
                current_value_base_value   BIGINT      NOT NULL,
                local_currency             CHAR(3)     NOT NULL,
                base_currency              CHAR(3)     NOT NULL,
                currency_rate_ref          UUID,
                interest_rate              NUMERIC(8,4) NOT NULL,
                rate_type                  TEXT         NOT NULL,
                interest_payment_frequency TEXT,
                start_date                 DATE         NOT NULL,
                maturity_date              DATE         NOT NULL,
                effective_from_dt          TIMESTAMPTZ  NOT NULL,
                effective_to_dt            TIMESTAMPTZ,

                CONSTRAINT pk_account_fixed_income_details    PRIMARY KEY (id),
                CONSTRAINT fk_afid_account_master             FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_afid_rate_ref                   FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_afid_account_effective_from     UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_afid_entity_consistency        CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_afid_entity_type               CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_afid_local_currency            CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_afid_base_currency             CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_afid_rate_type                 CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_afid_interest_frequency        CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
                CONSTRAINT chk_afid_date_order                CHECK (maturity_date > start_date),
                CONSTRAINT chk_afid_face_value_local          CHECK (face_value_local_value > 0),
                CONSTRAINT chk_afid_face_value_base           CHECK (face_value_base_value > 0),
                CONSTRAINT chk_afid_purchase_price_local      CHECK (purchase_price_local_value > 0),
                CONSTRAINT chk_afid_purchase_price_base       CHECK (purchase_price_base_value > 0),
                CONSTRAINT chk_afid_interest_rate             CHECK (interest_rate >= 0),
                CONSTRAINT chk_afid_current_value_local       CHECK (current_value_local_value >= 0),
                CONSTRAINT chk_afid_current_value_base        CHECK (current_value_base_value >= 0),
                CONSTRAINT chk_afid_coupon_frequency          CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL),
                CONSTRAINT chk_afid_rate_ref_required         CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_afid_effective_dt_order        CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_fixed_income_details_current
                ON account_fixed_income_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_property_details (
                id                                UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id                 UUID        NOT NULL,
                entity_type                       TEXT,
                entity_id                         UUID,
                purchase_price_local_value        BIGINT      NOT NULL,
                purchase_price_base_value         BIGINT      NOT NULL,
                current_value_local_value         BIGINT      NOT NULL,
                current_value_base_value          BIGINT      NOT NULL,
                monthly_rental_income_local_value BIGINT,
                monthly_rental_income_base_value  BIGINT,
                local_currency                    CHAR(3)     NOT NULL,
                base_currency                     CHAR(3)     NOT NULL,
                currency_rate_ref                 UUID,
                purchase_date                     DATE,
                property_address                  TEXT,
                is_rental                         BOOLEAN     NOT NULL DEFAULT FALSE,
                effective_from_dt                 TIMESTAMPTZ NOT NULL,
                effective_to_dt                   TIMESTAMPTZ,

                CONSTRAINT pk_account_property_details           PRIMARY KEY (id),
                CONSTRAINT fk_apd_account_master                 FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_apd_rate_ref                       FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_apd_account_effective_from         UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_apd_entity_consistency            CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_apd_entity_type                   CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_apd_local_currency                CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_apd_base_currency                 CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_apd_rental_consistency            CHECK (is_rental = TRUE OR monthly_rental_income_local_value IS NULL),
                CONSTRAINT chk_apd_rental_income_consistency     CHECK (
                    (monthly_rental_income_local_value IS NULL AND monthly_rental_income_base_value IS NULL) OR
                    (monthly_rental_income_local_value IS NOT NULL AND monthly_rental_income_base_value IS NOT NULL)
                ),
                CONSTRAINT chk_apd_monthly_rental_income_local   CHECK (monthly_rental_income_local_value > 0),
                CONSTRAINT chk_apd_monthly_rental_income_base    CHECK (monthly_rental_income_base_value > 0),
                CONSTRAINT chk_apd_purchase_price_local          CHECK (purchase_price_local_value > 0),
                CONSTRAINT chk_apd_purchase_price_base           CHECK (purchase_price_base_value > 0),
                CONSTRAINT chk_apd_current_value_local           CHECK (current_value_local_value > 0),
                CONSTRAINT chk_apd_current_value_base            CHECK (current_value_base_value > 0),
                CONSTRAINT chk_apd_rate_ref_required             CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_apd_effective_dt_order            CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_property_details_current
                ON account_property_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_p2p_lending_details (
                id                         UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id          UUID        NOT NULL,
                entity_type                TEXT,
                entity_id                  UUID,
                principal_lent_local_value BIGINT      NOT NULL,
                principal_lent_base_value  BIGINT      NOT NULL,
                current_value_local_value  BIGINT      NOT NULL,
                current_value_base_value   BIGINT      NOT NULL,
                local_currency             CHAR(3)     NOT NULL,
                base_currency              CHAR(3)     NOT NULL,
                currency_rate_ref          UUID,
                interest_rate              NUMERIC(8,4),
                rate_type                  TEXT,
                effective_from_dt          TIMESTAMPTZ NOT NULL,
                effective_to_dt            TIMESTAMPTZ,

                CONSTRAINT pk_account_p2p_lending_details    PRIMARY KEY (id),
                CONSTRAINT fk_apld_account_master            FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_apld_rate_ref                  FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_apld_account_effective_from    UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_apld_entity_consistency       CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_apld_entity_type              CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_apld_local_currency           CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_apld_base_currency            CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_apld_rate_type                CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_apld_rate_consistency         CHECK (
                    (interest_rate IS NULL AND rate_type IS NULL) OR
                    (interest_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_apld_principal_lent_local     CHECK (principal_lent_local_value > 0),
                CONSTRAINT chk_apld_principal_lent_base      CHECK (principal_lent_base_value > 0),
                CONSTRAINT chk_apld_current_value_local      CHECK (current_value_local_value >= 0),
                CONSTRAINT chk_apld_current_value_base       CHECK (current_value_base_value >= 0),
                CONSTRAINT chk_apld_interest_rate            CHECK (interest_rate >= 0),
                CONSTRAINT chk_apld_rate_ref_required        CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_apld_effective_dt_order       CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_p2p_lending_details_current
                ON account_p2p_lending_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_revolving_credit_details (
                id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id           UUID        NOT NULL,
                entity_type                 TEXT,
                entity_id                   UUID,
                credit_limit_local_value    BIGINT      NOT NULL,
                credit_limit_base_value     BIGINT      NOT NULL,
                current_balance_local_value BIGINT      NOT NULL,
                current_balance_base_value  BIGINT      NOT NULL,
                minimum_payment_local_value BIGINT,
                minimum_payment_base_value  BIGINT,
                local_currency              CHAR(3)     NOT NULL,
                base_currency               CHAR(3)     NOT NULL,
                currency_rate_ref           UUID,
                annual_percentage_rate      NUMERIC(8,4),
                rate_type                   TEXT,
                payment_due_day             INTEGER,
                statement_day               INTEGER,
                effective_from_dt           TIMESTAMPTZ NOT NULL,
                effective_to_dt             TIMESTAMPTZ,

                CONSTRAINT pk_account_revolving_credit_details   PRIMARY KEY (id),
                CONSTRAINT fk_arcd_account_master                FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_arcd_rate_ref                      FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_arcd_account_effective_from        UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_arcd_entity_consistency           CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_arcd_entity_type                  CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_arcd_local_currency               CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_arcd_base_currency                CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_arcd_rate_type                    CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_arcd_rate_consistency             CHECK (
                    (annual_percentage_rate IS NULL AND rate_type IS NULL) OR
                    (annual_percentage_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_arcd_minimum_payment_consistency  CHECK (
                    (minimum_payment_local_value IS NULL AND minimum_payment_base_value IS NULL) OR
                    (minimum_payment_local_value IS NOT NULL AND minimum_payment_base_value IS NOT NULL)
                ),
                CONSTRAINT chk_arcd_payment_due_day              CHECK (payment_due_day BETWEEN 1 AND 31),
                CONSTRAINT chk_arcd_statement_day                CHECK (statement_day BETWEEN 1 AND 31),
                CONSTRAINT chk_arcd_credit_limit_local           CHECK (credit_limit_local_value > 0),
                CONSTRAINT chk_arcd_credit_limit_base            CHECK (credit_limit_base_value > 0),
                CONSTRAINT chk_arcd_current_balance_local        CHECK (current_balance_local_value >= 0),
                CONSTRAINT chk_arcd_current_balance_base         CHECK (current_balance_base_value >= 0),
                CONSTRAINT chk_arcd_apr                          CHECK (annual_percentage_rate >= 0),
                CONSTRAINT chk_arcd_minimum_payment_local        CHECK (minimum_payment_local_value >= 0),
                CONSTRAINT chk_arcd_minimum_payment_base         CHECK (minimum_payment_base_value >= 0),
                CONSTRAINT chk_arcd_rate_ref_required            CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_arcd_effective_dt_order           CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_revolving_credit_details_current
                ON account_revolving_credit_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_installment_loan_details (
                id                                    UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_master_id                     UUID        NOT NULL,
                entity_type                           TEXT,
                entity_id                             UUID,
                original_principal_amount_local_value BIGINT      NOT NULL,
                original_principal_amount_base_value  BIGINT      NOT NULL,
                outstanding_balance_local_value       BIGINT      NOT NULL,
                outstanding_balance_base_value        BIGINT      NOT NULL,
                monthly_payment_local_value           BIGINT      NOT NULL,
                monthly_payment_base_value            BIGINT      NOT NULL,
                local_currency                        CHAR(3)     NOT NULL,
                base_currency                         CHAR(3)     NOT NULL,
                currency_rate_ref                     UUID,
                interest_rate                         NUMERIC(8,4) NOT NULL,
                rate_type                             TEXT         NOT NULL,
                term_months                           INTEGER      NOT NULL,
                start_date                            DATE         NOT NULL,
                end_date                              DATE         NOT NULL,
                effective_from_dt                     TIMESTAMPTZ  NOT NULL,
                effective_to_dt                       TIMESTAMPTZ,

                CONSTRAINT pk_account_installment_loan_details  PRIMARY KEY (id),
                CONSTRAINT fk_aild_account_master               FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT fk_aild_rate_ref                     FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id),
                CONSTRAINT uq_aild_account_effective_from       UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_aild_entity_consistency          CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_aild_entity_type                 CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_aild_local_currency              CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency)),
                CONSTRAINT chk_aild_base_currency               CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency)),
                CONSTRAINT chk_aild_rate_type                   CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_aild_date_order                  CHECK (end_date > start_date),
                CONSTRAINT chk_aild_original_principal_local    CHECK (original_principal_amount_local_value > 0),
                CONSTRAINT chk_aild_original_principal_base     CHECK (original_principal_amount_base_value > 0),
                CONSTRAINT chk_aild_outstanding_balance_local   CHECK (outstanding_balance_local_value >= 0),
                CONSTRAINT chk_aild_outstanding_balance_base    CHECK (outstanding_balance_base_value >= 0),
                CONSTRAINT chk_aild_monthly_payment_local       CHECK (monthly_payment_local_value > 0),
                CONSTRAINT chk_aild_monthly_payment_base        CHECK (monthly_payment_base_value > 0),
                CONSTRAINT chk_aild_term_months                 CHECK (term_months > 0),
                CONSTRAINT chk_aild_interest_rate               CHECK (interest_rate >= 0),
                CONSTRAINT chk_aild_rate_ref_required           CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL),
                CONSTRAINT chk_aild_effective_dt_order          CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_installment_loan_details_current
                ON account_installment_loan_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

    client.commit()
