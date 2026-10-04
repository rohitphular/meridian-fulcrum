"""User-defined reports: every contract-valid shape computes, hand-computed numbers, limits, and the build step.

The ledger (GBP at £100 a gram, so grams = pounds / 100), anchor 4 Oct 2026, all on Bank:
salary 30 g on the 1st of Jan…Oct; spending (money-out), by category:
rent 10 g × 9 (Jan…Sep), groceries 1 g × 9 (Jan…Sep), dining 2 g × 3 (Jul…Sep, tag fun),
utilities 1.5 g × 4 (Jun…Sep), gifts 3 g × 1 (Sep), transport 0.5 g × 4 (Jun…Sep), books 0.25 g × 2 (Sep, Oct).
"""

from __future__ import annotations

import itertools
from datetime import date
from decimal import Decimal
from typing import Any

import psycopg2
import pytest

import core.build as build_module
from core import mart as mart_module
from core import payload as p
from core.build import build
from core.config import contract
from core.reports import load_all
from core.user_defined import Compiler, Definition, ReportError, build_payload, chart_error
from tests.integration.ledger import Ledger

ANCHOR = date(2026, 10, 4)
SPEND = [  # (major, months, grams, tags)
    ("rent", range(1, 10), 10, ""),
    ("groceries", range(1, 10), 1, ""),
    ("dining", range(7, 10), 2, "fun"),
    ("utilities", range(6, 10), 1.5, ""),
    ("gifts", range(9, 10), 3, "family"),
    ("transport", range(6, 10), 0.5, ""),
    ("books", range(9, 11), 0.25, ""),
]


@pytest.fixture
def ledger(database: tuple[Any, dict[str, Any]]) -> Ledger:
    connection, _ = database
    book = Ledger(connection)
    book.rate("GBP", date(2026, 1, 1), 100.0)
    bank = book.account("Bank", opening=5000, tracking_start="2026-01-01 00:00:00")
    for month in range(1, 11):
        book.tx(bank, f"2026-{month:02d}-01T09:00:00", 3000, 30, tx_type="money-in", major="salary", minor="pay", payee="Employer")
    for major, months, grams, tags in SPEND:
        for month in months:
            book.tx(bank, f"2026-{month:02d}-0{3 if month == 10 else 6}T12:00:00", grams * 100, grams, major=major, minor="general", payee=major.title(), tags=tags)
    return book


@pytest.fixture
def compiler(ledger: Ledger) -> Compiler:
    return Compiler(mart_module.load(ledger.conn, ANCHOR), contract("report-definition"), ANCHOR)


def _definition(**fields: Any) -> Definition:
    base: dict[str, Any] = {
        "id": "00000000-0000-0000-0000-0000000000aa",
        "name": "My report",
        "description": "",
        "measure": "spend",
        "period_preset": "last_12",
        "period_from": None,
        "period_to": None,
        "compare_mode": "none",
        "time_grain": "none",
        "groups": (),
        "top_n": None,
        "include_other": False,
        "filters": {},
        "amount_min": None,
        "amount_max": None,
        "chart_kind": "number",
    }
    base.update(fields)
    if base["groups"] and base["top_n"] is None:
        base["top_n"] = 7
    return Definition(**base)


def _stat(payload: dict[str, Any], key: str) -> Any:
    return next(card["value"] for card in payload["stat_cards"] if card["key"] == key)


def test_every_contract_valid_shape_computes_a_valid_payload(compiler: Compiler) -> None:
    spec = compiler.spec
    computed = 0
    for measure in spec["measures"]:
        allowed = [item["key"] for item in spec["group_by"]] if measure["group_by"] == "all" else measure["group_by"]
        group_sets = [(), *[(key,) for key in allowed], *itertools.permutations(allowed[:3], 2)]
        for grain in [item["key"] for item in spec["time_grains"]]:
            for groups in group_sets:
                for chart in spec["chart_kinds"]:
                    if chart_error(chart, measure, grain, len(groups)):
                        continue
                    for compare in ("none", "previous"):
                        definition = _definition(measure=measure["key"], time_grain=grain, groups=groups, chart_kind=chart["key"], compare_mode=compare, include_other=bool(groups))
                        try:
                            payload = build_payload(definition, compiler)
                        except ReportError as error:
                            assert str(error) in ("too_many_rows",), (definition, error)
                            continue
                        assert p.validate(payload) == []
                        assert payload["empty"] is None, definition
                        computed += 1
    assert computed > 500


def test_spend_by_category_ranks_the_top_n_and_merges_the_rest_into_other(compiler: Compiler) -> None:
    payload = build_payload(_definition(groups=("category",), top_n=5, include_other=True, chart_kind="hbar"), compiler)
    chart = payload["charts"][0]
    assert chart["labels"] == ["Rent", "Groceries", "Dining", "Utilities", "Gifts", "Other"]
    assert chart["datasets"][0]["data"] == pytest.approx([90, 9, 6, 6, 3, 2.5])
    assert _stat(payload, "value") == pytest.approx(116.5)


def test_the_average_of_other_comes_from_sums_and_counts_not_averages(compiler: Compiler) -> None:
    definition = _definition(measure="average", groups=("category",), top_n=5, include_other=True, chart_kind="bar", filters={"tx_types": ["money-out"]})
    chart = build_payload(definition, compiler)["charts"][0]
    assert chart["labels"] == ["Rent", "Gifts", "Dining", "Utilities", "Groceries", "Other"]
    assert chart["datasets"][0]["data"][-1] == pytest.approx((4 * 0.5 + 2 * 0.25) / 6)
    assert chart["y_format"] == "money"


def test_compare_lines_up_bucket_by_bucket(compiler: Compiler) -> None:
    payload = build_payload(_definition(period_preset="last_3", time_grain="month", compare_mode="previous", chart_kind="line"), compiler)
    chart = payload["charts"][0]
    assert chart["labels"] == ["Aug 26", "Sep 26", "Oct 26"]
    assert chart["datasets"][0]["data"] == pytest.approx([11 + 2 + 1.5 + 0.5, 11 + 2 + 1.5 + 3 + 0.5 + 0.25, 0.25])  # Aug, Sep, Oct
    assert chart["datasets"][1]["key"] == "compare" and chart["datasets"][1]["data"] == pytest.approx([11, 11 + 1.5 + 0.5, 11 + 2 + 1.5 + 0.5])  # May, Jun, Jul
    assert _stat(payload, "compare") == pytest.approx(11 + 13 + 15)


def test_a_net_worth_number_matches_the_pre_built_tile_and_counts_are_not_money(compiler: Compiler, ledger: Ledger) -> None:
    from core import predefined_step
    from core.context import BuildContext

    load_all()
    worth = build_payload(_definition(measure="net_worth"), compiler)
    context = BuildContext(generation_id="g", anchor_date=ANCHOR, mart=compiler.mart)
    entry = next(item for item in contract("predefined-reports")["reports"] if item["key"] == "kpi-net-worth")
    [(_, tile)] = predefined_step.build_entry(entry, context, ("United Kingdom", "GBP"))
    assert _stat(worth, "value") == pytest.approx(_stat(tile, "value"))
    count = build_payload(_definition(measure="count", filters={"categories": ["rent"]}), compiler)
    assert count["stat_cards"][0] == {"key": "value", "label": "Number of transactions", "value": 9, "format": "count"}
    rate = build_payload(_definition(measure="savings_rate", period_preset="last_month"), compiler)  # Sep: 30 in, 18.25 out
    assert _stat(rate, "value") == pytest.approx((30 - 18.25) / 30 * 100)


def test_filters(compiler: Compiler) -> None:
    def total(**filters: Any) -> float:
        amounts = {key: filters.pop(key) for key in ("amount_min", "amount_max") if key in filters}
        return _stat(build_payload(_definition(filters=filters, **amounts), compiler), "value")

    assert total(tags=["FUN"]) == pytest.approx(6)
    assert total(payees=["rent"]) == pytest.approx(90)
    assert total(categories=["books|general", "gifts"]) == pytest.approx(3.5)
    assert total(countries=["UK"]) == pytest.approx(116.5)  # aliases resolve like the mart's
    assert total(amount_min=Decimal("150"), amount_max=Decimal("300")) == pytest.approx(6 + 6 + 3)  # £150…£300 in the account currency
    assert build_payload(_definition(filters={"tags": ["nothing"]}), compiler)["empty"] == {"text": "No transactions match this report in this period."}


def test_limits(compiler: Compiler, ledger: Ledger, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ReportError, match="^too_many_rows$"):
        build_payload(_definition(period_preset="last_90", time_grain="day", groups=("category",), chart_kind="table"), compiler)
    with pytest.raises(ReportError, match="^too_many_points$"):  # checked before computing: 366 days of a fixed range is fine, 3,660 is not
        build_payload(_definition(period_preset="fixed", period_from=date(2017, 1, 1), period_to=date(2026, 10, 1), time_grain="day", chart_kind="line"), compiler)
    bank = next(iter(compiler.mart.accounts))
    ledger.tx(bank, "2024-01-01T09:00:00", 100, 1)  # `all` now spans more than 400 days
    early = Compiler(mart_module.load(ledger.conn, ANCHOR), compiler.spec, ANCHOR)
    with pytest.raises(ReportError, match="^too_many_points$"):
        build_payload(_definition(period_preset="all", time_grain="day", chart_kind="line"), early)
    limits = {**compiler.spec["limits"], "max_series": 2}
    monkeypatch.setitem(compiler.spec, "limits", limits)
    with pytest.raises(ReportError, match="^too_many_series$"):
        build_payload(_definition(time_grain="month", groups=("category",), chart_kind="line"), Compiler(compiler.mart, compiler.spec, ANCHOR))


def test_a_definition_that_breaks_the_contract_is_rejected_again(compiler: Compiler) -> None:
    with pytest.raises(ReportError, match="^chart_not_allowed_for_measure$"):
        build_payload(_definition(measure="net", groups=("category",), chart_kind="donut"), compiler)
    with pytest.raises(ReportError, match="^filter_not_allowed_for_measure$"):
        build_payload(_definition(measure="balance", filters={"tags": ["fun"]}), compiler)


def test_the_build_records_each_report_against_the_definition_it_computed(ledger: Ledger, database: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    connection, params = database
    good = ledger.report("Rent by month", updated_at="2026-10-02T08:00:00.000Z", measure="spend", time_grain="month", chart_kind="bar", filter_categories=["rent"])
    broken = ledger.report("Hand edited", measure="net", group_by_1="category", top_n=7, include_other=True, chart_kind="donut")
    ledger.report("Switched off", status="inactive")
    monkeypatch.setattr(build_module, "get_client", lambda _config: psycopg2.connect(**params))
    generation = build(None, anchor_date=ANCHOR, keep=5)
    with connection.cursor() as cursor:
        cursor.execute("SELECT report_id::text, definition_updated_at, status, error_code FROM analytics.report_result WHERE generation_id = %s AND definition_updated_at <> ''", (generation,))
        results = {row[0]: row[1:] for row in cursor.fetchall()}
        cursor.execute("SELECT payload FROM analytics.report_output WHERE generation_id = %s AND report_id = %s", (generation, good))
        [(payload,)] = cursor.fetchall()
    connection.rollback()
    assert results == {good: ("2026-10-02T08:00:00.000Z", "ready", None), broken: ("2026-10-01T10:00:00.000Z", "failed", "chart_not_allowed_for_measure")}
    assert payload["title"] == "Rent by month" and payload["predefined_key"] is None
    assert payload["charts"][0]["datasets"][0]["data"][-2:] == [10, 0]  # Sep, Oct
