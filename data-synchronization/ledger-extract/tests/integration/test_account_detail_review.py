"""Additional detail ETL boundary regressions against disposable PostgreSQL."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import uuid4

import psycopg2
import pytest

from database.account_details import sync_details, upsert_details, validate_account_change


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[tuple[str, list[tuple[int, int, list[str]]]]] = []

    def batch_update_rows(self, sheet_name: str, updates: list[tuple[int, int, list[str]]]) -> None:
        self.updates.append((sheet_name, updates))


def _one(conn: Any, statement: str, params: tuple[Any, ...] = ()) -> tuple[Any, ...]:
    with conn.cursor() as cursor:
        cursor.execute(statement, params)
        result = cursor.fetchone()
    assert result is not None
    return result


def _account(conn: Any, subtype: str) -> str:
    identity = str(uuid4())
    with conn.cursor() as cursor:
        cursor.execute(
            """INSERT INTO account_master (id,account_name,account_type,account_subtype,local_currency,base_currency,
                opening_amount_local_value,opening_amount_base_value,record_status,created_at,updated_at)
                SELECT %s,'Fixture account',account_type_key,account_subtype_key,'USD','XAU',0,0,'active',now(),now()
                FROM account_types WHERE account_subtype_key=%s""",
            (identity, subtype),
        )
        assert cursor.rowcount == 1
    conn.commit()
    return identity


def _stock(account_id: str, **changes: Any) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "account_id": account_id,
        "instrument_type": "EQUITY",
        "record_status": "active",
        "sync_status": "create-pending",
        "current_value_local": "10.015",
        "price_asof_date": "2026-09-24",
        **changes,
    }


@pytest.mark.parametrize("locked_reference", ["owner", "linked_property"])
def test_detail_validation_holds_account_subtype_until_commit(database_client: Any, locked_reference: str) -> None:
    mortgage_id = _account(database_client, "mortgage")
    property_id = _account(database_client, "property")
    row = {
        "id": str(uuid4()),
        "account_id": mortgage_id,
        "linked_property_account_id": property_id,
        "original_principal_local": "100",
        "term_months": "12",
        "record_status": "deleted",  # Retained tombstones still preserve references.
    }
    target_id, invalid_subtype = (mortgage_id, "personal-loan") if locked_reference == "owner" else (property_id, "bonds")
    peer = psycopg2.connect(database_client.dsn)
    try:

        def concurrent_account_update() -> None:
            with peer.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='100ms'")
                # FOR KEY SHARE (the FK's lock) cannot protect a subtype edit;
                # this must wait on the explicit reference lock through commit.
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    cursor.execute("UPDATE account_master SET account_subtype=%s WHERE id=%s", (invalid_subtype, target_id))
            peer.rollback()

        assert sync_details(database_client, "account_liability_mortgage", [row], before_commit=concurrent_account_update)["created"] == 1
        # Once the reference exists, the master writer's guard sees it under its
        # own FOR UPDATE lock and rejects a now-incompatible subtype change.
        with peer.cursor() as cursor:
            cursor.execute("SELECT id FROM account_master WHERE id=%s FOR UPDATE NOWAIT", (target_id,))
        with pytest.raises(ValueError, match="accounts: subtype_conflicts_with_"):
            validate_account_change(peer, target_id, invalid_subtype)
        peer.rollback()
        assert _one(database_client, "SELECT record_status FROM account_liability_mortgage WHERE id=%s", (row["id"],)) == ("deleted",)
    finally:
        peer.close()


@pytest.mark.parametrize("existing", [False, True])
def test_source_guard_value_error_rolls_back_without_any_acknowledgement(database_client: Any, existing: bool) -> None:
    account_id = _account(database_client, "current")
    row = {"id": str(uuid4()), "account_id": account_id, "record_status": "active", "sync_status": "create-pending", "interest_rate": "1"}
    if existing:
        sync_details(database_client, "account_deposit", [row])
        row.update(interest_rate="2", sync_status="update-pending")
    sheets = RecordingSheets()
    source_error = ValueError("sheet_header_mismatch")

    def changed_header() -> None:
        raise source_error

    with pytest.raises(ValueError) as caught:
        upsert_details(database_client, sheets, "account_deposit", [row], before_commit=changed_header)
    assert caught.value is source_error
    assert sheets.updates == []
    assert _one(database_client, "SELECT count(*),max(interest_rate) FROM account_deposit") == ((1, Decimal(1)) if existing else (0, None))


def test_late_base_overflow_rolls_back_earlier_rows_and_marks_whole_tab_failed(database_client: Any) -> None:
    account_id = _account(database_client, "stocks-shares")
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code,rate_date,rate_value,rate_source) VALUES ('USD','2026-09-24',1,'fixture')")
    database_client.commit()
    rows = [_stock(account_id, _sheet_row_num=7), _stock(account_id, current_value_local="100000000000", _sheet_row_num=90)]
    sheets = RecordingSheets()
    assert upsert_details(database_client, sheets, "account_investment_stocks", rows) == 2
    assert _one(database_client, "SELECT count(*) FROM account_investment_stocks") == (0,)
    notes = [(row, values[0], values[2]) for row, _, values in sheets.updates[0][1]]
    assert notes == [(7, "create-failed", "detail_tab_rolled_back"), (90, "create-failed", "invalid_source_value_or_constraint")]
    assert "100000000000" not in str(sheets.updates)


def test_invalid_corrected_rate_cannot_destroy_existing_snapshot_on_hard_retry(database_client: Any) -> None:
    account_id = _account(database_client, "stocks-shares")
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates (quote_currency_code,rate_date,rate_value,rate_source) VALUES ('USD','2026-09-24',100,'fixture')")
    database_client.commit()
    row = _stock(account_id)
    sync_details(database_client, "account_investment_stocks", [row])
    original = _one(database_client, "SELECT id,created_at,updated_at,current_value_local_value,current_value_base_value,applied_rate_value FROM account_investment_stocks")
    with database_client.cursor() as cursor:
        # PostgreSQL permits numeric NaN under its older rate_value > 0 check.
        cursor.execute("UPDATE currency_rates SET rate_value='NaN' WHERE quote_currency_code='USD'")
    database_client.commit()
    assert sync_details(database_client, "account_investment_stocks", [row])["unchanged"] == 1
    sheets = RecordingSheets()
    assert upsert_details(database_client, sheets, "account_investment_stocks", [{**row, "sync_status": "update-pending"}], reprocess=True) == 1
    assert sheets.updates[0][1][0][2][2] == "invalid_valuation_rate"
    assert _one(database_client, "SELECT id,created_at,updated_at,current_value_local_value,current_value_base_value,applied_rate_value FROM account_investment_stocks") == original
