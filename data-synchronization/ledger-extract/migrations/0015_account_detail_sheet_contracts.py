"""Retain legacy detail families and add lossless current Sheet fields."""

import re
from typing import Any

_TABLES = {
    "account_deposit_details": "is_interest_paid BOOLEAN",
    "account_market_investment_details": """instrument_symbol TEXT, instrument_name TEXT, instrument_type TEXT,
        instrument_currency_local TEXT, holding_intent TEXT, position_side TEXT,
        avg_cost_price_local NUMERIC(38,18), current_price_local NUMERIC(38,18), price_asof_date TEXT,
        evaluation_currency_rate_id UUID REFERENCES currency_rates(id), underlying_symbol TEXT, option_type TEXT,
        strike_price_local NUMERIC(38,18), expiry_date TEXT, contract_multiplier NUMERIC(38,18), opening_date TEXT, record_status TEXT""",
    "account_fixed_income_details": """start_date_local TEXT, maturity_date_local TEXT, current_value_evaluation_date TEXT,
        evaluation_currency_rate_id UUID REFERENCES currency_rates(id), record_status TEXT""",
    "account_property_details": """acquisition_type TEXT, acquisition_date_local TEXT, is_rented BOOLEAN,
        rent_frequency TEXT, rent_day INTEGER, rent_month INTEGER, property_ownership_percentage NUMERIC(38,18),
        rent_amount_local_value BIGINT, rent_amount_base_value BIGINT, rent_ownership_percentage NUMERIC(38,18),
        property_service_charge_frequency TEXT, property_service_charge_amount_local_value BIGINT,
        property_service_charge_amount_base_value BIGINT, current_value_evaluation_date TEXT,
        evaluation_currency_rate_id UUID REFERENCES currency_rates(id)""",
    "account_p2p_lending_details": """current_value_evaluation_date TEXT,
        evaluation_currency_rate_id UUID REFERENCES currency_rates(id), record_status TEXT""",
    "account_revolving_credit_details": "interest_rate NUMERIC(38,18)",
    "account_installment_loan_details": "linked_property_account_id UUID REFERENCES account_master(id), maturity_date_local TEXT",
}

_SOURCES = {
    "account_deposit_details": ("account_deposit",),
    "account_market_investment_details": ("account_investment_stocks",),
    "account_fixed_income_details": ("account_investment_fixed_income",),
    "account_property_details": ("account_investment_property",),
    "account_p2p_lending_details": ("account_investment_p2p_lending",),
    "account_revolving_credit_details": ("account_liability_credit_card",),
    "account_installment_loan_details": ("account_liability_mortgage", "account_liability_personal_loan"),
}


def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        for table, additions in _TABLES.items():
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN source_sheet TEXT, ADD COLUMN source_account_name TEXT, ADD COLUMN created_at TIMESTAMPTZ, ADD COLUMN updated_at TIMESTAMPTZ")
            # Adding defaults separately preserves NULL for unknown legacy audit dates.
            cursor.execute(f"ALTER TABLE {table} ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN effective_from_dt DROP NOT NULL")
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN applied_rate_value NUMERIC(19,8)")
            # Commas inside NUMERIC typmods must not split a column declaration.
            for column in re.split(r",(?![^()]*\))", additions):
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column.strip()}")
            cursor.execute(
                """SELECT column_name, data_type FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=%s""",
                (table,),
            )
            for column, data_type in cursor.fetchall():
                if column.endswith(("_local_value", "_base_value")) or column in {"interest_rate", "rate_type", "term_months", "start_date", "end_date", "maturity_date", "is_rental"}:
                    cursor.execute(f"ALTER TABLE {table} ALTER COLUMN {column} DROP NOT NULL")
                if column in {"interest_rate", "annual_percentage_rate", "units_held"} and data_type == "numeric":
                    cursor.execute(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE NUMERIC(38,18)")
            if table == "account_property_details":
                cursor.execute(f"ALTER TABLE {table} ALTER COLUMN is_rental DROP DEFAULT")
            cursor.execute(f"DROP INDEX idx_{table}_current")
            cursor.execute(f"CREATE UNIQUE INDEX idx_{table}_current ON {table}(account_master_id) WHERE effective_to_dt IS NULL AND source_sheet IS NULL")
            cursor.execute("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=%s::regclass AND contype='c'", (table,))
            for name, definition in cursor.fetchall():
                relax = "consistency" in name or "rate_ref_required" in name or "frequency_requires_rate" in name or "coupon_frequency" in name
                if table == "account_market_investment_details":
                    relax = relax or any(part in name for part in ("units_held", "current_value", "cost_basis"))
                elif table == "account_revolving_credit_details":
                    relax = relax or "credit_limit" in name
                elif table == "account_fixed_income_details":
                    relax = relax or "purchase_price" in name
                elif table == "account_installment_loan_details":
                    relax = relax or "monthly_payment" in name
                elif table == "account_property_details":
                    relax = relax or "current_value" in name
                if relax:
                    cursor.execute(f"ALTER TABLE {table} DROP CONSTRAINT {name}")
                    cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK (source_sheet IS NOT NULL OR {definition.removeprefix('CHECK ')})")
                elif "interest_frequency" in name:
                    cursor.execute(f"ALTER TABLE {table} DROP CONSTRAINT {name}")
                    cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK (interest_payment_frequency IN ('monthly','quarterly','semi_annual','annual','annually','at_maturity'))")
            cursor.execute(
                f"""ALTER TABLE {table} ADD CONSTRAINT chk_{table}_applied_rate CHECK (
                    applied_rate_value IS NULL OR (applied_rate_value > 0 AND applied_rate_value::text NOT IN ('NaN','Infinity','-Infinity')))"""
            )
            cursor.execute(f"CREATE INDEX idx_{table}_source ON {table}(source_sheet)")
            cursor.execute(f"ALTER TABLE {table} ADD CONSTRAINT chk_{table}_source_sheet CHECK (source_sheet IS NULL OR source_sheet IN %s)", (_SOURCES[table],))
    client.commit()
