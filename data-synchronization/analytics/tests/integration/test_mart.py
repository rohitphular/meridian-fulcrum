"""The mart against hand-computed numbers: flows, transfers, tags, balances, rates, tracking start."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

import pytest

from core import mart as mart_module
from tests.integration.ledger import Ledger

ANCHOR = date(2026, 10, 4)


@pytest.fixture
def ledger(database: tuple[Any, dict[str, Any]]) -> Ledger:
    connection, _ = database
    book = Ledger(connection)
    book.rate("GBP", date(2026, 9, 1), 80.0)  # £80 per gram
    book.rate("GBP", date(2026, 9, 15), 100.0)
    book.rate("INR", date(2026, 9, 1), 8000.0)
    return book


def _load(ledger: Ledger) -> mart_module.Mart:
    return mart_module.load(ledger.conn, ANCHOR)


def test_flows_exclude_deleted_rows_and_both_legs_of_own_account_transfers(ledger: Ledger) -> None:
    bank = ledger.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")
    savings = ledger.account("Savings", opening=0, tracking_start="2026-09-01 00:00:00")
    ledger.tx(bank, "2026-09-02T10:00:00", 40, 0.5, payee="Tesco", tags="Food; weekly;food")
    ledger.tx(bank, "2026-09-03T10:00:00", 2000, 25, tx_type="money-in", major="salary", minor="pay", payee="Employer")
    ledger.tx(bank, "2026-09-04T10:00:00", 99, 1.2, status="deleted")
    ledger.transfer(bank, savings, "2026-09-05T10:00:00", 300, 3.75)
    data = _load(ledger)
    assert [(flow.kind, flow.amount_local, flow.amount_xau, flow.payee) for flow in data.flows] == [
        ("spend", Decimal("40.00"), 0.5, "Tesco"),
        ("income", Decimal("2000.00"), 25.0, "Employer"),
    ]
    assert data.flows[0].tags == ("food", "weekly")
    assert data.flows[0].country == "United Kingdom" and data.flows[0].day == date(2026, 9, 2)


def test_balances_count_transfer_legs_and_value_each_day_at_that_days_rate(ledger: Ledger) -> None:
    bank = ledger.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")
    savings = ledger.account("Savings", opening=0, tracking_start="2026-09-01 00:00:00")
    ledger.tx(bank, "2026-09-02T10:00:00", 40, 0.5)
    ledger.transfer(bank, savings, "2026-09-05T10:00:00", 300, 3.75)
    data = _load(ledger)
    # Tracking starts 1 Sep 00:00 London time = 31 Aug 23:00 UTC: the balance exists from 31 Aug (UTC).
    assert data.balance_local(bank, date(2026, 8, 30)) is None, "no balance before the tracking start"
    assert data.balance_local(bank, date(2026, 8, 31)) == Decimal("1000.00")
    assert data.balance_local(bank, date(2026, 9, 10)) == Decimal("660.00")
    assert data.balance_local(savings, date(2026, 9, 10)) == Decimal("300.00")
    assert data.balance_xau(bank, date(2026, 9, 10)) == pytest.approx(660 / 80)
    assert data.balance_xau(bank, date(2026, 9, 20)) == pytest.approx(660 / 100), "valued at the rate on that day"


def test_future_rows_count_in_the_current_balance_not_in_history(ledger: Ledger) -> None:
    bank = ledger.account("Bank", opening=100, tracking_start="2026-09-01 00:00:00")
    ledger.tx(bank, "2026-09-02T10:00:00", 10, 0.1)
    ledger.tx(bank, "2026-12-25T10:00:00", 50, 0.5)
    data = _load(ledger)
    assert data.balance_local(bank, ANCHOR) == Decimal("90.00")
    assert data.current_local(bank) == Decimal("40.00")
    assert data.current_xau(bank) == pytest.approx(40 / 100)


def test_movements_before_the_tracking_start_are_left_out(ledger: Ledger) -> None:
    # 2026-09-10 00:30 in London (BST, UTC+1) is 2026-09-09 23:30 UTC.
    bank = ledger.account("Bank", opening=500, tracking_start="2026-09-10 00:30:00", timezone_name="Europe/London")
    ledger.tx(bank, datetime(2026, 9, 9, 23, 0, tzinfo=timezone.utc), 10, 0.1)
    ledger.tx(bank, datetime(2026, 9, 9, 23, 45, tzinfo=timezone.utc), 20, 0.2)
    data = _load(ledger)
    assert data.accounts[bank].tracking_start == datetime(2026, 9, 9, 23, 30, tzinfo=timezone.utc)
    assert data.current_local(bank) == Decimal("480.00")


def test_a_currency_without_a_rate_by_the_day_is_reported_missing_not_converted_one_to_one(ledger: Ledger) -> None:
    ledger.rate("USD", date(2026, 12, 1), 95.0)  # only a rate after the anchor date
    usd = ledger.account("Dollars", currency="USD", opening=100, tracking_start="2026-09-01 00:00:00")
    data = _load(ledger)
    assert data.balance_xau(usd, ANCHOR) is None
    assert data.missing_currencies == {"USD"}


def test_unreadable_dates_and_timezones_are_warnings_not_failures(ledger: Ledger) -> None:
    ledger.account("Odd", tracking_start="not a date", timezone_name="Mars/Base")
    data = _load(ledger)
    assert data.warnings == {"invalid_tracking_start": 1, "invalid_timezone": 1}


def test_tag_split_and_rows_not_loaded_from_the_newest_staging_run(ledger: Ledger) -> None:
    connection = ledger.conn
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO stg_runs (run_id, status, enabled_tabs) VALUES (gen_random_uuid(), 'loaded', '{transaction_master}') RETURNING run_id")
        run_id = cursor.fetchone()[0]
        cursor.execute("INSERT INTO stg_sheet_headers (run_id, tab, headers) VALUES (%s, 'transaction_master', '[]')", (run_id,))
        for row, status in ((2, "create-failed"), (3, "in-sync"), (4, "update-failed")):
            cursor.execute(
                "INSERT INTO stg_sheet_rows (run_id, tab, sheet_row_num, source_id, cells, outcome_status) VALUES (%s, 'transaction_master', %s, gen_random_uuid()::text, '{}', %s)",
                (run_id, row, status),
            )
    connection.commit()
    assert _load(ledger).rows_not_loaded == 2


def test_transfers_into_a_liability_are_kept_as_repayments_only(ledger: Ledger) -> None:
    bank = ledger.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")
    card = ledger.account("Card", account_type="liability", opening=-500, tracking_start="2026-09-01 00:00:00")
    savings = ledger.account("Savings", tracking_start="2026-09-01 00:00:00")
    ledger.transfer(bank, card, "2026-09-05T10:00:00", 200, 2.5)
    ledger.transfer(bank, savings, "2026-09-06T10:00:00", 100, 1.25)
    data = _load(ledger)
    assert data.flows == []
    assert [(item.payee, item.amount_local) for item in data.repayments] == [("Card", Decimal("200.00"))]
    assert data.current_local(card) == Decimal("-300.00")
