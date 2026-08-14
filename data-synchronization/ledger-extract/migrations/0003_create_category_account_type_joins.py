from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
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
