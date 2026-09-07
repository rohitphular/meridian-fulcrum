from typing import Any


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'account_master' AND column_name = 'currency_rate_ref'
                ) THEN
                    ALTER TABLE account_master RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_deposit_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_market_investment_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_fixed_income_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_property_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_p2p_lending_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_revolving_credit_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE account_installment_loan_details RENAME COLUMN currency_rate_ref TO currency_rate_id;
                    ALTER TABLE transaction_master RENAME COLUMN currency_rate_ref TO currency_rate_id;
                END IF;
            END $$;
        """)
    client.commit()
