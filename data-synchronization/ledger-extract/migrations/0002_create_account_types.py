from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_types (
                id          UUID        NOT NULL DEFAULT gen_random_uuid(),
                type        TEXT        NOT NULL,
                sub_type    TEXT        NOT NULL,
                is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
                created_at  TIMESTAMPTZ NOT NULL,
                deleted_at  TIMESTAMPTZ,

                CONSTRAINT pk_account_types          PRIMARY KEY (id),
                CONSTRAINT uq_account_types_type_sub UNIQUE (type, sub_type)
            );
        """)
        cursor.execute("""
            INSERT INTO account_types (type, sub_type, created_at) VALUES
                ('asset',      'current',             now()),
                ('asset',      'savings',             now()),
                ('asset',      'cash',                now()),
                ('investment', 'stocks_shares',       now()),
                ('investment', 'isa',                 now()),
                ('investment', 'pension_sipp',        now()),
                ('investment', 'crypto',              now()),
                ('investment', 'fixed_deposit',       now()),
                ('investment', 'bonds',               now()),
                ('investment', 'property',            now()),
                ('investment', 'commodities',         now()),
                ('investment', 'p2p_lending',         now()),
                ('investment', 'other',               now()),
                ('liability',  'personal_loan',       now()),
                ('liability',  'credit_card',         now()),
                ('liability',  'mortgage',            now()),
                ('liability',  'auto_loan',           now()),
                ('liability',  'heloc',               now()),
                ('liability',  'student_loan',        now()),
                ('liability',  'medical_loan',        now()),
                ('liability',  'debt_consolidation',  now()),
                ('liability',  'overdraft',           now())
            ON CONFLICT (type, sub_type) DO NOTHING;
        """)
    client.commit()
