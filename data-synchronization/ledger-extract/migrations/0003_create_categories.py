from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS category_master (
                id                       UUID        NOT NULL DEFAULT gen_random_uuid(),
                tx_type_key              TEXT        NOT NULL,
                tx_type_label            TEXT        NOT NULL,
                major_category_key       TEXT        NOT NULL,
                major_category_label     TEXT        NOT NULL,
                minor_category_key       TEXT        NOT NULL,
                minor_category_label     TEXT        NOT NULL,
                description              TEXT,
                tag_keywords             TEXT,
                counterparty_examples    TEXT,
                source_account_mandatory BOOLEAN     NOT NULL,
                target_account_mandatory BOOLEAN     NOT NULL,
                is_subscription_eligible BOOLEAN     NOT NULL DEFAULT FALSE,
                record_status            TEXT        NOT NULL,
                created_at               TIMESTAMPTZ NOT NULL,
                updated_at               TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_category_master                  PRIMARY KEY (id),
                CONSTRAINT uq_category_master_nat_key          UNIQUE (tx_type_key, major_category_key, minor_category_key),
                CONSTRAINT chk_category_master_tx_type         CHECK (tx_type_key IN ('money-in', 'money-out')),
                CONSTRAINT chk_category_master_record_status   CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))
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
