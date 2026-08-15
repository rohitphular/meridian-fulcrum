from __future__ import annotations

from typing import Any

from py_logging import get_logger

import database.ledger_data_checksums as hashes_db
from transforms import accounts as accounts_transform

logger = get_logger(__name__)

_EXTENSION_TABLES: dict[str, str] = {
    "deposit": "account_deposit_details",
    "market_investment": "account_market_investment_details",
    "fixed_income": "account_fixed_income_details",
    "property": "account_property_details",
    "p2p_lending": "account_p2p_lending_details",
    "revolving_credit": "account_revolving_credit_details",
    "installment_loan": "account_installment_loan_details",
}


def load_structure_type_map(conn: Any) -> dict[tuple[str, str], str]:
    """Preload (account_type, sub_type) → structure_type from account_types. Called once at job startup."""
    with conn.cursor() as cursor:
        cursor.execute("SELECT account_type, sub_type, structure_type FROM account_types WHERE is_deleted = FALSE")
        return {(row[0], row[1]): row[2] for row in cursor.fetchall()}


def _close_extension_row(conn: Any, structure_type: str, account_master_id: Any) -> None:
    table = _EXTENSION_TABLES[structure_type]
    with conn.cursor() as cursor:
        cursor.execute(
            f"UPDATE {table} SET effective_to_dt = now() WHERE account_master_id = %s AND effective_to_dt IS NULL",
            (account_master_id,),
        )


def _insert_extension_row(conn: Any, structure_type: str, account_master_id: Any, typed: dict[str, Any], natural_key: str) -> None:
    if structure_type == "deposit":
        current_balance = typed["balance"]
        if current_balance is None:
            raise ValueError(f"upsert_accounts: deposit_missing_balance entity=accounts natural_key={natural_key} — field=balance is required for deposit accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_deposit_details (
                    account_master_id, current_balance, interest_rate, rate_type,
                    interest_payment_frequency, effective_from_dt, effective_to_dt,
                    entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    current_balance,
                    typed["interest_rate"],
                    typed["rate_type"],
                    typed["interest_payment_frequency"],
                ),
            )

    elif structure_type == "market_investment":
        current_value = typed["current_value"]
        if current_value is None:
            raise ValueError(f"upsert_accounts: market_investment_missing_current_value entity=accounts natural_key={natural_key} — field=current_value is required for market_investment accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_market_investment_details (
                    account_master_id, current_value, cost_basis, units_held, unit_value,
                    unit_type, effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    current_value,
                    typed["cost_basis"],
                    typed["units_held"],
                    typed["unit_value"],
                    typed["unit_type"],
                ),
            )

    elif structure_type == "fixed_income":
        face_value = typed["face_value"]
        purchase_price = typed["purchase_price"]
        interest_rate = typed["interest_rate"]
        rate_type = typed["rate_type"]
        start_date = typed["start_date"]
        maturity_date = typed["maturity_date"]
        current_value = typed["current_value"]
        for field, value in [
            ("face_value", face_value),
            ("purchase_price", purchase_price),
            ("interest_rate", interest_rate),
            ("rate_type", rate_type),
            ("start_date", start_date),
            ("maturity_date", maturity_date),
            ("current_value", current_value),
        ]:
            if value is None:
                raise ValueError(f"upsert_accounts: fixed_income_missing_field entity=accounts natural_key={natural_key} — field={field} is required for fixed_income accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_fixed_income_details (
                    account_master_id, face_value, purchase_price, interest_rate, rate_type,
                    interest_payment_frequency, start_date, maturity_date, current_value,
                    effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    face_value,
                    purchase_price,
                    interest_rate,
                    rate_type,
                    typed["interest_payment_frequency"],
                    start_date,
                    maturity_date,
                    current_value,
                ),
            )

    elif structure_type == "property":
        purchase_price = typed["purchase_price"]
        current_value = typed["current_value"]
        for field, value in [("purchase_price", purchase_price), ("current_value", current_value)]:
            if value is None:
                raise ValueError(f"upsert_accounts: property_missing_field entity=accounts natural_key={natural_key} — field={field} is required for property accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_property_details (
                    account_master_id, purchase_price, current_value, purchase_date,
                    property_address, is_rental, monthly_rental_income,
                    effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    purchase_price,
                    current_value,
                    typed["purchase_date"],
                    typed["property_address"],
                    typed["is_rental"],
                    typed["monthly_rental_income"],
                ),
            )

    elif structure_type == "p2p_lending":
        principal_lent = typed["principal_lent"]
        current_value = typed["current_value"]
        for field, value in [("principal_lent", principal_lent), ("current_value", current_value)]:
            if value is None:
                raise ValueError(f"upsert_accounts: p2p_lending_missing_field entity=accounts natural_key={natural_key} — field={field} is required for p2p_lending accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_p2p_lending_details (
                    account_master_id, principal_lent, current_value, interest_rate, rate_type,
                    effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    principal_lent,
                    current_value,
                    typed["interest_rate"],
                    typed["rate_type"],
                ),
            )

    elif structure_type == "revolving_credit":
        credit_limit = typed["credit_limit"]
        current_balance = typed["balance"]
        for field, value in [("credit_limit", credit_limit), ("balance", current_balance)]:
            if value is None:
                raise ValueError(f"upsert_accounts: revolving_credit_missing_field entity=accounts natural_key={natural_key} — field={field} is required for revolving_credit accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_revolving_credit_details (
                    account_master_id, credit_limit, current_balance, annual_percentage_rate,
                    rate_type, minimum_payment, payment_due_day, statement_day,
                    effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    credit_limit,
                    current_balance,
                    typed["annual_percentage_rate"],
                    typed["rate_type"],
                    typed["minimum_payment"],
                    typed["payment_due_day"],
                    typed["statement_day"],
                ),
            )

    elif structure_type == "installment_loan":
        original_principal_amount = typed["original_principal_amount"]
        outstanding_balance = typed["outstanding_balance"]
        interest_rate = typed["interest_rate"]
        rate_type = typed["rate_type"]
        term_months = typed["term_months"]
        monthly_payment = typed["monthly_payment"]
        start_date = typed["start_date"]
        end_date = typed["end_date"]
        for field, value in [
            ("original_principal_amount", original_principal_amount),
            ("outstanding_balance", outstanding_balance),
            ("interest_rate", interest_rate),
            ("rate_type", rate_type),
            ("term_months", term_months),
            ("monthly_payment", monthly_payment),
            ("start_date", start_date),
            ("end_date", end_date),
        ]:
            if value is None:
                raise ValueError(f"upsert_accounts: installment_loan_missing_field entity=accounts natural_key={natural_key} — field={field} is required for installment_loan accounts")
        with conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO account_installment_loan_details (
                    account_master_id, original_principal_amount, outstanding_balance,
                    interest_rate, rate_type, term_months, monthly_payment,
                    start_date, end_date,
                    effective_from_dt, effective_to_dt, entity_type, entity_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now(), NULL, NULL, NULL)
                """,
                (
                    account_master_id,
                    original_principal_amount,
                    outstanding_balance,
                    interest_rate,
                    rate_type,
                    term_months,
                    monthly_payment,
                    start_date,
                    end_date,
                ),
            )

    else:
        raise ValueError(f"upsert_accounts: unknown_structure_type entity=accounts natural_key={natural_key} structure_type={structure_type!r}")


def upsert_accounts(conn: Any, rows: list[dict[str, Any]], structure_type_map: dict[tuple[str, str], str]) -> None:
    seen_keys: set[str] = set()

    # --- Per-row pass ---
    for row in rows:
        typed = accounts_transform.transform(row)

        natural_key = typed["natural_key"]
        if natural_key in seen_keys:
            logger.warning(f"upsert_accounts: duplicate_natural_key entity=accounts natural_key={natural_key} — skipping second occurrence; fix the sheet")
            continue
        seen_keys.add(natural_key)

        # Resolve structure_type — hard error if combo not found
        key = (typed["account_type"], typed["sub_type"])
        structure_type = structure_type_map.get(key)
        if structure_type is None:
            raise ValueError(
                f"upsert_accounts: unknown_account_type entity=accounts"
                f" natural_key={natural_key} account_type={typed['account_type']!r}"
                f" sub_type={typed['sub_type']!r} — combo not found in account_types"
            )

        existing = hashes_db.get_hash(conn, "accounts", natural_key)

        # Hash match — unchanged row
        if existing is not None and existing["row_hash"] == typed["row_hash"]:
            hashes_db.update_last_seen(conn, "accounts", natural_key)
            logger.info(f"upsert_accounts: unchanged entity=accounts natural_key={natural_key}")
            continue

        # New row
        if existing is None:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO account_master (
                            account_id, account_name, institution_name, account_type, sub_type,
                            currency_code, account_description,
                            row_hash, created_at, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                        ON CONFLICT (account_id) DO UPDATE SET
                            account_status = 'active',
                            deleted_at = NULL,
                            account_name = EXCLUDED.account_name,
                            institution_name = EXCLUDED.institution_name,
                            account_type = EXCLUDED.account_type,
                            sub_type = EXCLUDED.sub_type,
                            currency_code = EXCLUDED.currency_code,
                            account_description = EXCLUDED.account_description,
                            row_hash = EXCLUDED.row_hash,
                            updated_at = now()
                        RETURNING id
                        """,
                        (
                            typed["account_id"],
                            typed["account_name"],
                            typed["institution_name"],
                            typed["account_type"],
                            typed["sub_type"],
                            typed["currency_code"],
                            typed["account_description"],
                            typed["row_hash"],
                        ),
                    )
                    account_master_id = cursor.fetchone()[0]

                # Idempotent close guards against a stale open row left by a failed prior soft-delete
                _close_extension_row(conn, structure_type, account_master_id)
                _insert_extension_row(conn, structure_type, account_master_id, typed, natural_key)
                hashes_db.insert_hash(conn, "accounts", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_accounts: inserted entity=accounts natural_key={natural_key} structure_type={structure_type}")
            except Exception:
                conn.rollback()
                raise

        # Changed row
        else:
            try:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE account_master SET
                            account_name = %s,
                            institution_name = %s,
                            account_type = %s,
                            sub_type = %s,
                            currency_code = %s,
                            account_description = %s,
                            row_hash = %s,
                            updated_at = now()
                        WHERE account_id = %s
                        RETURNING id
                        """,
                        (
                            typed["account_name"],
                            typed["institution_name"],
                            typed["account_type"],
                            typed["sub_type"],
                            typed["currency_code"],
                            typed["account_description"],
                            typed["row_hash"],
                            typed["account_id"],
                        ),
                    )
                    row_result = cursor.fetchone()

                if row_result is None:
                    logger.error(f"upsert_accounts: update_returned_no_rows entity=accounts natural_key={natural_key}")
                    conn.rollback()
                    continue

                account_master_id = row_result[0]
                _close_extension_row(conn, structure_type, account_master_id)
                _insert_extension_row(conn, structure_type, account_master_id, typed, natural_key)
                hashes_db.update_hash(conn, "accounts", natural_key, typed["row_hash"])
                conn.commit()
                logger.info(f"upsert_accounts: updated entity=accounts natural_key={natural_key} structure_type={structure_type}")
            except Exception:
                conn.rollback()
                raise

    # --- Soft-delete pass ---
    db_keys = hashes_db.get_all_keys(conn, "accounts")
    stale_keys = db_keys - seen_keys

    for natural_key in stale_keys:
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE account_master SET
                        account_status = 'deleted',
                        deleted_at = now(),
                        updated_at = now()
                    WHERE account_id = %s
                    RETURNING id, account_type, sub_type
                    """,
                    (natural_key,),
                )
                row_result = cursor.fetchone()

            if row_result is None:
                logger.error(f"upsert_accounts: soft_delete_returned_no_rows entity=accounts natural_key={natural_key}")
                conn.rollback()
                continue

            account_master_id, account_type, sub_type = row_result
            structure_type = structure_type_map.get((account_type, sub_type))
            if structure_type is None:
                logger.error(f"upsert_accounts: soft_delete_unknown_structure_type entity=accounts natural_key={natural_key} account_type={account_type!r} sub_type={sub_type!r}")
                conn.rollback()
                continue

            _close_extension_row(conn, structure_type, account_master_id)
            hashes_db.delete_hash(conn, "accounts", natural_key)
            conn.commit()
            logger.info(f"upsert_accounts: soft_deleted entity=accounts natural_key={natural_key}")
        except Exception:
            conn.rollback()
            raise
