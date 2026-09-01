from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_types (
                id             UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_type   TEXT        NOT NULL,
                account_subtype TEXT       NOT NULL,
                description    TEXT,
                record_status  TEXT        NOT NULL DEFAULT 'active',
                created_at     TIMESTAMPTZ NOT NULL,
                updated_at     TIMESTAMPTZ NOT NULL,

                CONSTRAINT pk_account_types                    PRIMARY KEY (id),
                CONSTRAINT uq_account_types_type_subtype       UNIQUE (account_type, account_subtype),
                CONSTRAINT chk_account_types_record_status     CHECK (record_status IN ('active', 'inactive', 'deleted'))
            );
        """)
        cursor.execute("""
            INSERT INTO account_types (account_type, account_subtype, created_at, updated_at) VALUES
                ('asset',      'current',            now(), now()),
                ('asset',      'savings',            now(), now()),
                ('asset',      'cash',               now(), now()),
                ('investment', 'stocks_shares',      now(), now()),
                ('investment', 'isa',                now(), now()),
                ('investment', 'pension_sipp',       now(), now()),
                ('investment', 'crypto',             now(), now()),
                ('investment', 'fixed_deposit',      now(), now()),
                ('investment', 'bonds',              now(), now()),
                ('investment', 'property',           now(), now()),
                ('investment', 'commodities',        now(), now()),
                ('investment', 'p2p_lending',        now(), now()),
                ('investment', 'other',              now(), now()),
                ('liability',  'personal_loan',      now(), now()),
                ('liability',  'credit_card',        now(), now()),
                ('liability',  'mortgage',           now(), now()),
                ('liability',  'auto_loan',          now(), now()),
                ('liability',  'heloc',              now(), now()),
                ('liability',  'student_loan',       now(), now()),
                ('liability',  'medical_loan',       now(), now()),
                ('liability',  'debt_consolidation', now(), now()),
                ('liability',  'overdraft',          now(), now())
            ON CONFLICT (account_type, account_subtype) DO NOTHING;
        """)
    client.commit()
