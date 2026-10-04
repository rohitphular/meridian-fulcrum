"""report_master validation: the Python rules must give exactly the GAS validator's answers."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

import transforms.reports as reports
from core import report_contract

HSBC = "11111111-1111-4111-8111-111111111111"
OLD = "33333333-3333-4333-8333-333333333333"
REFS = reports.References(account_ids=frozenset({HSBC}), categories=frozenset({"groceries", "groceries|supermarket"}), currencies=frozenset({"GBP", "INR"}))
BASE = {"report_name": "Monthly spend by category", "measure": "spend", "period_preset": "last_6", "time_grain": "month", "group_by_1": "category", "chart_kind": "stacked"}

# Each case is a patch on BASE. Valid and invalid ones, every rule, plus Sheet cell types.
CASES: list[dict[str, Any]] = [
    {},
    {"report_name": "x" * 60},
    {"filter_account_ids": f" {HSBC.upper()} ; {HSBC}", "filter_currencies": "gbp;INR", "filter_categories": "groceries; groceries|supermarket", "filter_tags": "Holiday;holiday;work"},
    {"filter_amount_min": "10", "filter_amount_max": "250.50"},
    {"time_grain": "none", "group_by_1": "", "chart_kind": "number"},
    {"period_preset": "last_12", "time_grain": "day", "chart_kind": "line"},
    {"period_preset": "fixed", "period_from": "2026-01-01", "period_to": "2026-03-31", "compare_mode": "last_year"},
    {"top_n": 10, "include_other": False},
    {"report_name": ""},
    {"report_name": "ab"},
    {"report_name": "x" * 61},
    {"report_description": "x" * 141},
    {"measure": "profit"},
    {"period_preset": "last_2"},
    {"period_preset": "fixed", "period_from": "2026-02-30", "period_to": "2026-03-01"},
    {"period_preset": "fixed", "period_from": "2026-03-02", "period_to": "2026-03-01"},
    {"period_preset": "fixed", "period_from": "2010-01-01", "period_to": "2026-01-01"},
    {"period_from": "2026-01-01"},
    {"period_preset": "all", "compare_mode": "previous"},
    {"time_grain": "hour"},
    {"group_by_1": "", "group_by_2": "tag"},
    {"group_by_2": "category"},
    {"group_by_1": "merchant"},
    {"measure": "balance", "group_by_1": "category", "chart_kind": "line"},
    {"measure": "balance", "group_by_1": "account", "chart_kind": "line"},
    {"group_by_1": "", "chart_kind": "line", "top_n": "10"},
    {"group_by_1": "", "chart_kind": "line", "include_other": "true"},
    {"top_n": "8"},
    {"include_other": "maybe"},
    {"filter_account_ids": OLD},
    {"filter_account_ids": "not-a-uuid"},
    {"filter_categories": "travel"},
    {"filter_categories": "a|b|c"},
    {"filter_currencies": "USD"},
    {"filter_tx_types": "refund"},
    {"filter_tx_types": "money-in;money-out"},
    {"filter_amount_min": "-5"},
    {"filter_amount_min": "50", "filter_amount_max": "10"},
    {"filter_tags": ";".join(f"t{i}" for i in range(51))},
    {"measure": "net_worth", "group_by_1": "", "chart_kind": "line", "filter_tags": "x"},
    {"measure": "net_worth", "group_by_1": "", "chart_kind": "line", "filter_currencies": "GBP"},
    {"chart_kind": "radar"},
    {"chart_kind": "donut"},
    {"time_grain": "none", "measure": "average", "chart_kind": "donut"},
    {"measure": "savings_rate", "group_by_1": "", "chart_kind": "stacked"},
    {"time_grain": "none", "chart_kind": "number"},
    {"period_preset": "fixed", "period_from": "2024-01-01", "period_to": "2025-12-31", "time_grain": "day", "chart_kind": "line"},
]


def _python(case: dict[str, Any]) -> dict[str, Any]:
    try:
        values = reports.validate_definition({**BASE, **case}, REFS)
    except ValueError as error:
        code, column = str(error).removeprefix("reports: ").split(":")
        return {"ok": False, "error": code, "field": column}
    separator = report_contract.definition()["filter_rules"]["list_separator"]
    shown: dict[str, Any] = {}
    for key, value in values.items():
        if isinstance(value, list):
            value = separator.join(value)
        elif isinstance(value, date):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            value = str(value)
        elif value is None:
            value = ""
        shown[key] = value
    return {"ok": True, "values": shown}


@pytest.fixture(scope="module")
def gas_results() -> list[dict[str, Any]]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to run the GAS report validator")
    api = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"
    source = "\n".join((api / name).read_text() for name in ("report-contract.gs", "account-utils.gs", "report-schema.gs", "report-validation.gs"))
    refs = {"account_ids": dict.fromkeys(REFS.account_ids, True), "categories": dict.fromkeys(REFS.categories, True), "currencies": dict.fromkeys(REFS.currencies, True)}
    source += f"\nconst cases = {json.dumps([{**BASE, **case} for case in CASES])};\nconst refs = {json.dumps(refs)};"
    source += "\nprocess.stdout.write(JSON.stringify(cases.map(function(c) { return validateReportDefinition(c, refs); })));"
    result = subprocess.run([node, "-e", source], check=True, capture_output=True, text=True, timeout=15)
    return json.loads(result.stdout)


@pytest.mark.parametrize("index", range(len(CASES)))
def test_python_validation_matches_the_gas_validator(gas_results: list[dict[str, Any]], index: int) -> None:
    expected = gas_results[index]
    if expected["ok"]:
        expected = {"ok": True, "values": {key: "" if value is None else value for key, value in expected["values"].items()}}
    assert _python(CASES[index]) == expected, CASES[index]


def test_a_sheets_date_cell_and_numeric_cells_are_read_as_their_values() -> None:
    values = reports.validate_definition({**BASE, "period_preset": "fixed", "period_from": 46023, "period_to": 46053.0, "top_n": 10.0, "include_other": True}, REFS)
    assert (values["period_from"], values["period_to"], values["top_n"], values["include_other"]) == (date(2026, 1, 1), date(2026, 1, 31), 10, True)


def test_predefined_rows_come_from_the_catalogue_and_carry_no_definition() -> None:
    entry = next(report for report in report_contract.predefined()["reports"] if report["key"] == "14-networth-trend")
    row = {"id": entry["id"].upper(), "report_type": "predefined", "predefined_key": entry["key"], "report_name": "edited by hand", "record_status": "active", "updated_at": "2026-10-04T10:00:00.000Z"}
    typed = reports.transform(row, REFS)
    assert typed["report_name"] == "Net worth trend" and typed["record_status"] == "locked"
    assert typed["measure"] is None and typed["filter_account_ids"] == [] and typed["filter_amount_min"] is None
    assert typed["source_updated_at"] == "2026-10-04T10:00:00.000Z"
    for bad, message in ((dict(row, predefined_key="nope"), "invalid_predefined_key:predefined_key"), (dict(row, id=HSBC), "invalid_predefined_key:id")):
        with pytest.raises(ValueError, match=f"^reports: {message}$"):
            reports.transform(bad, REFS)


def test_user_rows_need_a_uuid_a_known_type_and_no_predefined_key() -> None:
    user = {**BASE, "id": HSBC, "report_type": "user_defined"}
    assert reports.transform(user, REFS)["predefined_key"] is None
    for bad, message in (
        (dict(user, id="nope"), "invalid_id:id"),
        (dict(user, report_type="shared"), "invalid_report_type:report_type"),
        (dict(user, predefined_key="08-category-pie"), "invalid_predefined_key:predefined_key"),
        (dict(user, record_status="archived"), "invalid_record_status:record_status"),
    ):
        with pytest.raises(ValueError, match=f"^reports: {message}$"):
            reports.transform(bad, REFS)


def test_a_deleted_report_keeps_a_filter_on_an_account_that_no_longer_exists() -> None:
    row = {**BASE, "id": HSBC, "report_type": "user_defined", "filter_account_ids": OLD}
    with pytest.raises(ValueError, match="unknown_filter_reference"):
        reports.transform(row, REFS)
    assert reports.transform(dict(row, record_status="deleted"), REFS)["filter_account_ids"] == [OLD]
