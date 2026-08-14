from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS category_master (
                id                          UUID         NOT NULL DEFAULT gen_random_uuid(),
                tx_type                     TEXT         NOT NULL,
                major_category              TEXT         NOT NULL,
                minor_category              TEXT         NOT NULL,
                description                 TEXT,
                is_active                   BOOLEAN      NOT NULL,
                tag_keywords                TEXT,
                counterparty_examples       TEXT,
                source_account_mandatory    BOOLEAN      NOT NULL,
                target_account_mandatory    BOOLEAN      NOT NULL,
                workflow_type               VARCHAR(100) NOT NULL,
                is_subscription_eligible    BOOLEAN      NOT NULL DEFAULT FALSE,
                row_hash                    TEXT         NOT NULL,
                is_deleted                  BOOLEAN      NOT NULL DEFAULT FALSE,
                created_at                  TIMESTAMPTZ  NOT NULL,
                updated_at                  TIMESTAMPTZ  NOT NULL,
                deleted_at                  TIMESTAMPTZ,

                CONSTRAINT pk_category_master         PRIMARY KEY (id),
                CONSTRAINT uq_category_master_nat_key UNIQUE (tx_type, major_category, minor_category),
                CONSTRAINT chk_cm_account_mandatory   CHECK (source_account_mandatory = TRUE OR target_account_mandatory = TRUE),
                CONSTRAINT chk_cm_tx_workflow_combo   CHECK (
                    (tx_type = 'money-in'       AND workflow_type = 'account-credit') OR
                    (tx_type = 'money-out'      AND workflow_type IN ('account-debit', 'debt-repayment')) OR
                    (tx_type = 'money-transfer' AND workflow_type IN ('funds-transfer', 'forex-transfer', 'debt-repayment'))
                )
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS category_source_account_types (
                category_id     UUID NOT NULL,
                account_type_id UUID NOT NULL,

                CONSTRAINT pk_cat_src_acct_types PRIMARY KEY (category_id, account_type_id),
                CONSTRAINT fk_csat_category      FOREIGN KEY (category_id)     REFERENCES category_master(id),
                CONSTRAINT fk_csat_account_type  FOREIGN KEY (account_type_id) REFERENCES account_types(id)
            );
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS category_target_account_types (
                category_id     UUID NOT NULL,
                account_type_id UUID NOT NULL,

                CONSTRAINT pk_cat_tgt_acct_types PRIMARY KEY (category_id, account_type_id),
                CONSTRAINT fk_ctat_category      FOREIGN KEY (category_id)     REFERENCES category_master(id),
                CONSTRAINT fk_ctat_account_type  FOREIGN KEY (account_type_id) REFERENCES account_types(id)
            );
        """)
    client.commit()
