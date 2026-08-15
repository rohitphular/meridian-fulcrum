from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        # Base table — common columns shared by every account
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_master (
                id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_id          TEXT        NOT NULL,
                account_name        TEXT        NOT NULL,
                institution_name    TEXT,
                account_type        TEXT        NOT NULL,
                sub_type            TEXT        NOT NULL,
                currency_code       TEXT        NOT NULL,
                account_status      TEXT        NOT NULL DEFAULT 'active',
                account_opening_date DATE,
                account_description TEXT,
                row_hash            TEXT        NOT NULL,
                created_at          TIMESTAMPTZ NOT NULL,
                updated_at          TIMESTAMPTZ NOT NULL,
                deleted_at          TIMESTAMPTZ,

                CONSTRAINT pk_account_master                PRIMARY KEY (id),
                CONSTRAINT uq_account_master_account_id     UNIQUE (account_id),
                CONSTRAINT fk_account_master_account_types  FOREIGN KEY (account_type, sub_type) REFERENCES account_types(account_type, sub_type),
                CONSTRAINT chk_account_master_currency      CHECK (char_length(currency_code) = 3 AND currency_code = upper(currency_code)),
                CONSTRAINT chk_account_master_status        CHECK (account_status IN ('active', 'in_active', 'closed', 'deleted')),
                CONSTRAINT chk_account_master_deleted_at    CHECK (account_status = 'deleted' OR deleted_at IS NULL)
            );
        """)

        # SCD Type 2 extension table — deposit (asset: current, savings, cash)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_deposit_details (
                id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id   UUID          NOT NULL,
                entity_type         TEXT,
                entity_id           UUID,
                current_balance     NUMERIC(19,6) NOT NULL,
                interest_rate       NUMERIC(8,4),
                rate_type           TEXT,
                interest_payment_frequency TEXT,
                effective_from_dt   TIMESTAMPTZ   NOT NULL,
                effective_to_dt     TIMESTAMPTZ,

                CONSTRAINT pk_account_deposit_details           PRIMARY KEY (id),
                CONSTRAINT fk_add_account_master                FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_add_account_effective_from        UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_add_entity_consistency           CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_add_entity_type                  CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_add_rate_type                    CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_add_rate_consistency             CHECK (
                    (interest_rate IS NULL AND rate_type IS NULL) OR
                    (interest_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_add_interest_frequency           CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
                CONSTRAINT chk_add_frequency_requires_rate      CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL),
                CONSTRAINT chk_add_interest_rate                CHECK (interest_rate >= 0),
                CONSTRAINT chk_add_current_balance              CHECK (current_balance >= 0),
                CONSTRAINT chk_add_effective_dt_order           CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deposit_details_current
                ON account_deposit_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — market_investment (investment: stocks_shares, isa, pension_sipp, crypto, commodities, other)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_market_investment_details (
                id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id   UUID          NOT NULL,
                entity_type         TEXT,
                entity_id           UUID,
                current_value       NUMERIC(19,6) NOT NULL,
                cost_basis          NUMERIC(19,6),
                units_held          NUMERIC(19,6),
                unit_value          NUMERIC(19,6),
                unit_type           TEXT,
                effective_from_dt   TIMESTAMPTZ   NOT NULL,
                effective_to_dt     TIMESTAMPTZ,

                CONSTRAINT pk_account_market_investment_details     PRIMARY KEY (id),
                CONSTRAINT fk_amid_account_master                   FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_amid_account_effective_from           UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_amid_entity_consistency              CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_amid_entity_type                     CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_amid_units_consistency               CHECK (
                    (units_held IS NULL AND unit_value IS NULL AND unit_type IS NULL) OR
                    (units_held IS NOT NULL AND unit_value IS NOT NULL AND unit_type IS NOT NULL)
                ),
                CONSTRAINT chk_amid_units_held                      CHECK (units_held > 0),
                CONSTRAINT chk_amid_unit_value                      CHECK (unit_value >= 0),
                CONSTRAINT chk_amid_current_value                   CHECK (current_value >= 0),
                CONSTRAINT chk_amid_cost_basis                      CHECK (cost_basis >= 0),
                CONSTRAINT chk_amid_effective_dt_order              CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_market_investment_details_current
                ON account_market_investment_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — fixed_income (investment: fixed_deposit, bonds)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_fixed_income_details (
                id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id   UUID          NOT NULL,
                entity_type         TEXT,
                entity_id           UUID,
                face_value          NUMERIC(19,6) NOT NULL,
                purchase_price      NUMERIC(19,6) NOT NULL,
                interest_rate       NUMERIC(8,4)  NOT NULL,
                rate_type           TEXT          NOT NULL,
                interest_payment_frequency TEXT,
                start_date          DATE          NOT NULL,
                maturity_date       DATE          NOT NULL,
                current_value       NUMERIC(19,6) NOT NULL,
                effective_from_dt   TIMESTAMPTZ   NOT NULL,
                effective_to_dt     TIMESTAMPTZ,

                CONSTRAINT pk_account_fixed_income_details          PRIMARY KEY (id),
                CONSTRAINT fk_afid_account_master                   FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_afid_account_effective_from           UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_afid_entity_consistency              CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_afid_entity_type                     CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_afid_rate_type                       CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_afid_interest_frequency              CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
                CONSTRAINT chk_afid_date_order                      CHECK (maturity_date > start_date),
                CONSTRAINT chk_afid_face_value                      CHECK (face_value > 0),
                CONSTRAINT chk_afid_purchase_price                  CHECK (purchase_price > 0),
                CONSTRAINT chk_afid_interest_rate                   CHECK (interest_rate >= 0),
                CONSTRAINT chk_afid_current_value                   CHECK (current_value >= 0),
                CONSTRAINT chk_afid_coupon_frequency                CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL),
                CONSTRAINT chk_afid_effective_dt_order              CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_fixed_income_details_current
                ON account_fixed_income_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — property (investment: property)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_property_details (
                id                      UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id       UUID          NOT NULL,
                entity_type             TEXT,
                entity_id               UUID,
                purchase_price          NUMERIC(19,6) NOT NULL,
                current_value           NUMERIC(19,6) NOT NULL,
                purchase_date           DATE,
                property_address        TEXT,
                is_rental               BOOLEAN       NOT NULL DEFAULT FALSE,
                monthly_rental_income   NUMERIC(19,6),
                effective_from_dt       TIMESTAMPTZ   NOT NULL,
                effective_to_dt         TIMESTAMPTZ,

                CONSTRAINT pk_account_property_details              PRIMARY KEY (id),
                CONSTRAINT fk_apd_account_master                    FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_apd_account_effective_from            UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_apd_entity_consistency               CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_apd_entity_type                      CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_apd_rental_consistency               CHECK (is_rental = TRUE OR monthly_rental_income IS NULL),
                CONSTRAINT chk_apd_monthly_rental_income            CHECK (monthly_rental_income > 0),
                CONSTRAINT chk_apd_purchase_price                   CHECK (purchase_price > 0),
                CONSTRAINT chk_apd_current_value                    CHECK (current_value > 0),
                CONSTRAINT chk_apd_effective_dt_order               CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_property_details_current
                ON account_property_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — p2p_lending (investment: p2p_lending)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_p2p_lending_details (
                id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id   UUID          NOT NULL,
                entity_type         TEXT,
                entity_id           UUID,
                principal_lent      NUMERIC(19,6) NOT NULL,
                current_value       NUMERIC(19,6) NOT NULL,
                interest_rate       NUMERIC(8,4),
                rate_type           TEXT,
                effective_from_dt   TIMESTAMPTZ   NOT NULL,
                effective_to_dt     TIMESTAMPTZ,

                CONSTRAINT pk_account_p2p_lending_details           PRIMARY KEY (id),
                CONSTRAINT fk_apld_account_master                   FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_apld_account_effective_from           UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_apld_entity_consistency              CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_apld_entity_type                     CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_apld_rate_type                       CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_apld_rate_consistency                CHECK (
                    (interest_rate IS NULL AND rate_type IS NULL) OR
                    (interest_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_apld_principal_lent                  CHECK (principal_lent > 0),
                CONSTRAINT chk_apld_current_value                   CHECK (current_value >= 0),
                CONSTRAINT chk_apld_interest_rate                   CHECK (interest_rate >= 0),
                CONSTRAINT chk_apld_effective_dt_order              CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_p2p_lending_details_current
                ON account_p2p_lending_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — revolving_credit (liability: credit_card, heloc, overdraft)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_revolving_credit_details (
                id                      UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id       UUID          NOT NULL,
                entity_type             TEXT,
                entity_id               UUID,
                credit_limit            NUMERIC(19,6) NOT NULL,
                current_balance         NUMERIC(19,6) NOT NULL,
                annual_percentage_rate  NUMERIC(8,4),
                rate_type               TEXT,
                minimum_payment         NUMERIC(19,6),
                payment_due_day         INTEGER,
                statement_day           INTEGER,
                effective_from_dt       TIMESTAMPTZ   NOT NULL,
                effective_to_dt         TIMESTAMPTZ,

                CONSTRAINT pk_account_revolving_credit_details      PRIMARY KEY (id),
                CONSTRAINT fk_arcd_account_master                   FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_arcd_account_effective_from           UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_arcd_entity_consistency              CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_arcd_entity_type                     CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_arcd_rate_type                       CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_arcd_rate_consistency                CHECK (
                    (annual_percentage_rate IS NULL AND rate_type IS NULL) OR
                    (annual_percentage_rate IS NOT NULL AND rate_type IS NOT NULL)
                ),
                CONSTRAINT chk_arcd_payment_due_day                 CHECK (payment_due_day BETWEEN 1 AND 31),
                CONSTRAINT chk_arcd_statement_day                   CHECK (statement_day BETWEEN 1 AND 31),
                CONSTRAINT chk_arcd_credit_limit                    CHECK (credit_limit > 0),
                CONSTRAINT chk_arcd_current_balance                 CHECK (current_balance >= 0),
                CONSTRAINT chk_arcd_apr                             CHECK (annual_percentage_rate >= 0),
                CONSTRAINT chk_arcd_minimum_payment                 CHECK (minimum_payment >= 0),
                CONSTRAINT chk_arcd_effective_dt_order              CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_revolving_credit_details_current
                ON account_revolving_credit_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

        # SCD Type 2 extension table — installment_loan (liability: personal_loan, auto_loan, mortgage, student_loan, medical_loan, debt_consolidation)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_installment_loan_details (
                id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
                account_master_id   UUID          NOT NULL,
                entity_type         TEXT,
                entity_id           UUID,
                original_principal_amount NUMERIC(19,6) NOT NULL,
                outstanding_balance NUMERIC(19,6) NOT NULL,
                interest_rate       NUMERIC(8,4)  NOT NULL,
                rate_type           TEXT          NOT NULL,
                term_months         INTEGER       NOT NULL,
                monthly_payment     NUMERIC(19,6) NOT NULL,
                start_date          DATE          NOT NULL,
                end_date            DATE          NOT NULL,
                effective_from_dt   TIMESTAMPTZ   NOT NULL,
                effective_to_dt     TIMESTAMPTZ,

                CONSTRAINT pk_account_installment_loan_details      PRIMARY KEY (id),
                CONSTRAINT fk_aild_account_master                   FOREIGN KEY (account_master_id) REFERENCES account_master(id),
                CONSTRAINT uq_aild_account_effective_from           UNIQUE (account_master_id, effective_from_dt),
                CONSTRAINT chk_aild_entity_consistency              CHECK (
                    (entity_type IS NULL AND entity_id IS NULL) OR
                    (entity_type IS NOT NULL AND entity_id IS NOT NULL)
                ),
                CONSTRAINT chk_aild_entity_type                     CHECK (entity_type IN ('transaction')),
                CONSTRAINT chk_aild_rate_type                       CHECK (rate_type IN ('fixed', 'variable', 'tracker')),
                CONSTRAINT chk_aild_date_order                      CHECK (end_date > start_date),
                CONSTRAINT chk_aild_original_principal              CHECK (original_principal_amount > 0),
                CONSTRAINT chk_aild_outstanding_balance             CHECK (outstanding_balance >= 0),
                CONSTRAINT chk_aild_monthly_payment                 CHECK (monthly_payment > 0),
                CONSTRAINT chk_aild_term_months                     CHECK (term_months > 0),
                CONSTRAINT chk_aild_interest_rate                   CHECK (interest_rate >= 0),
                CONSTRAINT chk_aild_effective_dt_order              CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)
            );
        """)
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_installment_loan_details_current
                ON account_installment_loan_details (account_master_id)
                WHERE effective_to_dt IS NULL;
        """)

    client.commit()
