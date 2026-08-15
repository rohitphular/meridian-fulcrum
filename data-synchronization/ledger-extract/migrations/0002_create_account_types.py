from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS account_types (
                id             UUID        NOT NULL DEFAULT gen_random_uuid(),
                account_type   TEXT        NOT NULL,
                sub_type       TEXT        NOT NULL,
                structure_type TEXT        NOT NULL,
                is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE,
                created_at     TIMESTAMPTZ NOT NULL,
                deleted_at     TIMESTAMPTZ,

                CONSTRAINT pk_account_types              PRIMARY KEY (id),
                CONSTRAINT uq_account_types_type_sub     UNIQUE (account_type, sub_type),
                CONSTRAINT chk_account_types_account_type CHECK (account_type IN ('asset', 'investment', 'liability')),
                CONSTRAINT chk_account_types_structure_type CHECK (
                    structure_type IN (
                        'deposit', 'market_investment', 'fixed_income', 'property',
                        'p2p_lending', 'revolving_credit', 'installment_loan'
                    )
                )
            );
        """)
        cursor.execute("""
            INSERT INTO account_types (account_type, sub_type, structure_type, created_at) VALUES
                ('asset',      'current',            'deposit',            now()),
                ('asset',      'savings',            'deposit',            now()),
                ('asset',      'cash',               'deposit',            now()),
                ('investment', 'stocks_shares',      'market_investment',  now()),
                ('investment', 'isa',                'market_investment',  now()),
                ('investment', 'pension_sipp',       'market_investment',  now()),
                ('investment', 'crypto',             'market_investment',  now()),
                ('investment', 'commodities',        'market_investment',  now()),
                ('investment', 'other',              'market_investment',  now()),
                ('investment', 'fixed_deposit',      'fixed_income',       now()),
                ('investment', 'bonds',              'fixed_income',       now()),
                ('investment', 'property',           'property',           now()),
                ('investment', 'p2p_lending',        'p2p_lending',        now()),
                ('liability',  'credit_card',        'revolving_credit',   now()),
                ('liability',  'heloc',              'revolving_credit',   now()),
                ('liability',  'overdraft',          'revolving_credit',   now()),
                ('liability',  'personal_loan',      'installment_loan',   now()),
                ('liability',  'auto_loan',          'installment_loan',   now()),
                ('liability',  'mortgage',           'installment_loan',   now()),
                ('liability',  'student_loan',       'installment_loan',   now()),
                ('liability',  'medical_loan',       'installment_loan',   now()),
                ('liability',  'debt_consolidation', 'installment_loan',   now())
            ON CONFLICT (account_type, sub_type) DO NOTHING;
        """)
    client.commit()
