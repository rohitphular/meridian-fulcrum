"""Every pre-built report against one small ledger: valid payloads for every variant, key numbers by hand, failure isolation.

The ledger (GBP at £100 a gram, so grams = pounds / 100), anchor 4 Oct 2026:
- Bank (asset) opens at £5,000 on 1 Jan; salary £3,000 on the 1st of Jan…Oct; groceries £100 on the 5th of Jan…Sep
  and £50 on 2 Oct; a £100 card repayment on the 10th of Jan…Sep.
- Card (liability) opens at −£1,200 on 1 Jan; nine repayments of £100 leave £300 owed.
Bank = 5000 + 30000 − 900 − 50 − 900 = £33,150 (331.5 g); net worth = 331.5 − 3 = 328.5 g.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import psycopg2
import pytest

import core.build as build_module
from core import mart as mart_module
from core import predefined_step
from core.build import build
from core.config import contract
from core.context import BuildContext
from core.reports import REGISTRY, load_all
from tests.integration.ledger import Ledger

ANCHOR = date(2026, 10, 4)


@pytest.fixture
def ledger(database: tuple[Any, dict[str, Any]]) -> Ledger:
    connection, _ = database
    book = Ledger(connection)
    book.rate("GBP", date(2026, 1, 1), 100.0)
    bank = book.account("Bank", opening=5000, tracking_start="2026-01-01 00:00:00")
    card = book.account("Card", account_type="liability", opening=-1200, tracking_start="2026-01-01 00:00:00")
    for month in range(1, 11):
        book.tx(bank, f"2026-{month:02d}-01T09:00:00", 3000, 30, tx_type="money-in", major="salary", minor="pay", payee="Employer")
    for month in range(1, 10):
        book.tx(bank, f"2026-{month:02d}-05T12:00:00", 100, 1, payee="Tesco", tags="food", country="UK", city="London")
        book.transfer(bank, card, f"2026-{month:02d}-10T08:00:00", 100, 1)
    book.tx(bank, "2026-10-02T12:00:00", 50, 0.5, payee="Tesco", tags="food")
    return book


def _context(ledger: Ledger) -> BuildContext:
    load_all()
    context = BuildContext(generation_id="00000000-0000-0000-0000-000000000001", anchor_date=ANCHOR)
    context.mart = mart_module.load(ledger.conn, ANCHOR)
    return context


def _built(ledger: Ledger) -> dict[str, dict[str, dict[str, Any]]]:
    """predefined_key → variant_key → payload, for every catalogue entry."""
    context = _context(ledger)
    home = predefined_step._settings()
    return {entry["key"]: dict(predefined_step.build_entry(entry, context, home)) for entry in contract("predefined-reports")["reports"]}


def _stat(payload: dict[str, Any], key: str) -> Any:
    return next(card["value"] for card in payload["stat_cards"] if card["key"] == key)


@pytest.fixture
def built(ledger: Ledger) -> dict[str, dict[str, dict[str, Any]]]:
    return _built(ledger)


def test_every_catalogue_entry_is_implemented_and_every_variant_is_a_valid_payload(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    catalogue = contract("predefined-reports")["reports"]
    assert {entry["key"] for entry in catalogue} == set(REGISTRY)
    for entry in catalogue:
        variants = built[entry["key"]]
        assert "" in variants, f"{entry['key']} has a default variant"
        bases = [key for key in variants if "drill=" not in key]
        assert len(bases) == len(predefined_step.variants(entry)), entry["key"]
        for key, body in variants.items():
            assert body["variant_key"] == key and body["predefined_key"] == entry["key"] and body["anchor_date"] == "2026-10-04"
            json.dumps(body, allow_nan=False)


def test_home_numbers(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    assert _stat(built["kpi-net-worth"][""], "value") == pytest.approx(328.5)
    assert _stat(built["kpi-total-assets"][""], "value") == pytest.approx(331.5)
    assert _stat(built["kpi-total-liabilities"][""], "value") == pytest.approx(3)
    assert _stat(built["kpi-spend-this-month"][""], "value") == pytest.approx(0.5)
    assert _stat(built["kpi-monthly-income"][""], "value") == pytest.approx(30)  # Jan…Sep complete
    assert _stat(built["kpi-debt-to-income"][""], "value") == pytest.approx(3 / 360 * 100)


def test_comparisons_net_worth_and_loans(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    month = built["01-mom-cumulative"][""]
    assert _stat(month, "current") == pytest.approx(0.5) and _stat(month, "previous") == 0
    assert month["charts"][0]["datasets"][0]["data"][:5] == [0, 0.5, 0.5, 0.5, None]

    trend = built["14-networth-trend"][""]
    assert _stat(trend, "net_worth") == pytest.approx(328.5)
    assert trend["charts"][0]["datasets"][0]["data"][-1] == pytest.approx(328.5)
    drill = built["14-networth-trend"]["drill=date%3A2026-09-30"]["drill"]
    assert drill["table"]["total_row"]["cells"]["balance"] == pytest.approx(5000 / 100 + 27000 / 100 - 9 - 9 - (12 - 9))

    paydown = built["17-liability-paydown"][""]
    assert (_stat(paydown, "outstanding"), _stat(paydown, "started_with"), _stat(paydown, "overall_paid")) == pytest.approx((3, 12, 75))

    loans = built["26-loan-progress"][""]
    assert _stat(loans, "total_repaid") == pytest.approx(9)
    assert _stat(loans, "monthly_burden") == pytest.approx(1)  # 9 g over Jan → Oct (9 months)
    [loan_drill] = [body for key, body in built["26-loan-progress"].items() if key.startswith("drill=")]
    assert loan_drill["drill"]["charts"][0]["datasets"][0]["data"][-1] == pytest.approx(9)

    ratio = built["27-debt-to-income"]["tab=accounts"]
    assert _stat(ratio, "dti_ratio") == pytest.approx(3 / 360 * 100)


def test_a_failing_report_is_recorded_without_failing_the_run(ledger: Ledger, database: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    connection, params = database
    load_all()

    def broken(context: Any) -> dict[str, Any]:
        raise ValueError("invalid_payload:charts[0]:kind")

    monkeypatch.setitem(REGISTRY, "07-last-8-weeks", broken)
    monkeypatch.setattr(build_module, "get_client", lambda _config: psycopg2.connect(**params))
    generation = build(None, anchor_date=ANCHOR, keep=5)
    with connection.cursor() as cursor:
        cursor.execute("SELECT status, count(*) FROM analytics.report_result WHERE generation_id = %s GROUP BY status", (generation,))
        counts = dict(cursor.fetchall())
        cursor.execute(
            "SELECT r.error_code FROM analytics.report_result r WHERE r.generation_id = %s AND r.status = 'failed'",
            (generation,),
        )
        errors = [row[0] for row in cursor.fetchall()]
        cursor.execute("SELECT status FROM analytics.run WHERE generation_id = %s", (generation,))
        status = cursor.fetchone()[0]
    connection.rollback()
    total = len(contract("predefined-reports")["reports"])
    assert status == "built"
    assert counts == {"ready": total - 1, "failed": 1}
    assert errors == ["invalid_payload:charts[0]:kind"]


def test_cashflow_categories_and_payees(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    rates = built["20-savings-rate"][""]  # last 12 months: Jan…Sep save 29 of 30 g, Oct 29.5 of 30 g
    assert _stat(rates, "best") == pytest.approx(29.5 / 30 * 100) and _stat(rates, "worst") == pytest.approx(29 / 30 * 100)
    assert _stat(rates, "average") == pytest.approx((9 * 29 / 30 + 29.5 / 30) * 10)
    assert _stat(rates, "streak") == 10

    pie = built["08-category-pie"][""]  # this month: the £50 on 2 Oct
    assert (_stat(pie, "total"), _stat(pie, "categories"), _stat(pie, "top")) == pytest.approx((0.5, 1, 100))

    payees = built["22-top-counterparties"][""]  # last 3 months (Aug…Oct): Tesco 1 + 1 + 0.5; transfers are not spending
    assert (_stat(payees, "total"), _stat(payees, "payees")) == pytest.approx((2.5, 1))


def test_paydown_compares_owed_amounts_at_one_rate(database: tuple[Any, dict[str, Any]]) -> None:
    """Gold halves against GBP (£50 → £100 a gram), so the £1,200 owed falls from 24 g to 12 g with nothing repaid: nothing shows as repaid or paid down."""
    connection, _ = database
    book = Ledger(connection)
    book.rate("GBP", date(2026, 1, 1), 50.0)
    book.rate("GBP", date(2026, 10, 1), 100.0)
    book.account("Card", account_type="liability", opening=-1200, tracking_start="2026-01-01 00:00:00")
    bank = book.account("Bank", opening=0, tracking_start="2026-01-01 00:00:00")
    book.tx(bank, "2026-01-05T09:00:00", 3000, 30, tx_type="money-in", major="salary", minor="pay")  # a first flow month, so debt-free is computed
    built = _built(book)
    paydown = built["17-liability-paydown"][""]
    assert (_stat(paydown, "outstanding"), _stat(paydown, "started_with"), _stat(paydown, "overall_paid")) == pytest.approx((12, 12, 0))
    loans = built["26-loan-progress"][""]
    assert _stat(loans, "total_repaid") == 0 and _stat(loans, "monthly_burden") == 0
    assert loans["tables"][0]["rows"][0]["cells"]["paid"] == 0
    assert _stat(built["kpi-debt-free"][""], "value") is None


TRANSACTIONS_PARAMS = {
    "range",
    "from",
    "to",
    "types",
    "account_ids",
    "account_types",
    "major",
    "minor",
    "user_location_country",
    "user_location_city",
    "user_location_area",
    "tag",
    "counterparty",
    "search",
}


def _queries(value: Any) -> list[dict[str, Any]]:
    """Every Transactions query (chart queries[], row query, drill query) inside a payload."""
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if value.get("action") == "list_transactions_view":
            found.append(value["params"])
        for item in value.values():
            found.extend(_queries(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_queries(item))
    return found


def test_every_transactions_query_uses_list_transactions_view_params(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    queries = [query for variants in built.values() for body in variants.values() for query in _queries(body)]
    assert queries, "the fixture produces query drills"
    for params in queries:
        assert set(params) <= TRANSACTIONS_PARAMS, sorted(set(params) - TRANSACTIONS_PARAMS)
        if params.get("from") or params.get("to"):
            assert params.get("range") == "custom", params


def _drill_modes(value: Any) -> set[str]:
    modes: set[str] = set()
    if isinstance(value, dict):
        drill = value.get("drill")
        if isinstance(drill, dict) and drill.get("mode") in ("panel", "replace"):
            modes.add(drill["mode"])
        for key, item in value.items():
            if key != "drill":
                modes |= _drill_modes(item)
    elif isinstance(value, list):
        for item in value:
            modes |= _drill_modes(item)
    return modes


def test_every_panel_or_replace_drill_has_published_variants(built: dict[str, dict[str, dict[str, Any]]]) -> None:
    for key, variants in built.items():
        if _drill_modes(variants[""]):
            assert any("drill=" in variant for variant in variants), f"{key} offers a drill no variant answers"
