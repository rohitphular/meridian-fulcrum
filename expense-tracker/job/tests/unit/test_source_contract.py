from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

JOB_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def job_modules(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any]:
    monkeypatch.syspath_prepend(str(JOB_ROOT))
    runner = importlib.import_module("runner")
    insights = importlib.import_module("jobs.insights.job")
    return runner, insights


@pytest.mark.parametrize("arguments", [[], ["--job", "insights"]])
def test_runner_refuses_current_contract_before_credentials_or_sheet_access(monkeypatch: pytest.MonkeyPatch, job_modules: tuple[Any, Any], arguments: list[str]) -> None:
    runner, _ = job_modules
    load = MagicMock(side_effect=AssertionError("credentials must not be loaded"))
    monkeypatch.setattr(runner.config, "load", load)
    monkeypatch.setattr(sys, "argv", ["runner", *arguments])
    with pytest.raises(SystemExit) as raised:
        runner.main()
    assert raised.value.code == 1
    load.assert_not_called()


def test_unknown_job_is_rejected_before_authentication(monkeypatch: pytest.MonkeyPatch, job_modules: tuple[Any, Any]) -> None:
    runner, _ = job_modules
    load = MagicMock(side_effect=AssertionError("credentials must not be loaded"))
    monkeypatch.setattr(runner.config, "load", load)
    monkeypatch.setattr(sys, "argv", ["runner", "--job", "missing"])
    with pytest.raises(SystemExit):
        runner.main()
    load.assert_not_called()


@pytest.mark.parametrize("contract", [None, "single-leg-master-v1", "unknown"])
def test_direct_insights_run_cannot_bypass_contract_check(job_modules: tuple[Any, Any], contract: str | None) -> None:
    _, insights = job_modules
    sheets = MagicMock()
    with pytest.raises(ValueError, match="unsupported_insights_source_contract"):
        insights.InsightsJob(sheets, {"source_contract": contract}).run()
    assert sheets.mock_calls == []


def _legacy_fixture(insights: Any) -> tuple[MagicMock, dict[str, Any]]:
    sheets = MagicMock()
    configuration = {"source_contract": "legacy-dual-leg-v1", "sheets": {name: name for name in ("transactions", "accounts", "categories", "rates")}, "quote_currency": "GBP"}
    headers = {
        "transactions": [value for key, value in vars(insights.TxField).items() if key.isupper()],
        "accounts": [value for key, value in vars(insights.AccountField).items() if key.isupper()],
        "categories": ["tx_type_key", "major_category_key", "minor_category_key"],
        "rates": ["currency", "rate"],
    }
    sheets.read_headers.side_effect = headers.__getitem__
    sheets.read_sheet.side_effect = lambda name: [{"currency": "GBP", "rate": "1"}] if name == "rates" else []
    return sheets, configuration


def test_current_sheet_headers_cannot_masquerade_as_legacy_data(job_modules: tuple[Any, Any]) -> None:
    _, insights = job_modules
    sheets, configuration = _legacy_fixture(insights)
    sheets.read_headers.side_effect = lambda name: ["id", "tx_date_local", "account_id", "tx_amount_local", "record_status"]
    with pytest.raises(ValueError, match="unsupported_insights_sheet_schema:transactions"):
        insights.InsightsJob(sheets, configuration).run()
    sheets.read_sheet.assert_not_called()
    sheets.replace_today_and_trim.assert_not_called()


def test_missing_required_sheet_is_an_error_instead_of_empty_financial_data(job_modules: tuple[Any, Any]) -> None:
    import gspread

    client_type = importlib.import_module("sheets_client").SheetsClient
    sheets = object.__new__(client_type)
    sheets._ss = MagicMock()
    sheets._ss.worksheet.side_effect = gspread.exceptions.WorksheetNotFound("not present")
    for reader in [sheets.read_sheet, sheets.read_headers]:
        with pytest.raises(ValueError, match="required_source_sheet_missing:transactions"):
            reader("transactions")
    sheets._ss.add_worksheet.assert_not_called()


def test_incomplete_insight_computation_preserves_previously_published_results(monkeypatch: pytest.MonkeyPatch, job_modules: tuple[Any, Any]) -> None:
    _, insights = job_modules
    sheets, configuration = _legacy_fixture(insights)

    class BrokenInsight:
        insight_id = "broken"
        periods = ["default"]
        derived_from = ["default"]
        chart_variants = [""]

        def __init__(self, *_: Any) -> None:
            pass

        def compute(self, *_: Any) -> dict[str, Any]:
            raise ValueError("calculation failed")

    monkeypatch.setattr(insights, "ALL_INSIGHTS", [BrokenInsight])
    with pytest.raises(RuntimeError, match="insight_computation_failed"):
        insights.InsightsJob(sheets, configuration).run()
    sheets.replace_today_and_trim.assert_not_called()
    sheets.write_sheet.assert_not_called()


def test_contract_guard_is_conditional_and_accepts_verified_legacy_sources(monkeypatch: pytest.MonkeyPatch, job_modules: tuple[Any, Any]) -> None:
    _, insights = job_modules
    sheets, configuration = _legacy_fixture(insights)

    class CompleteInsight:
        insight_id = "complete"
        periods = ["default"]
        derived_from = ["default"]
        chart_variants = [""]

        def __init__(self, *_: Any) -> None:
            pass

        def compute(self, *_: Any) -> dict[str, Any]:
            return {"stat_cards": [{"value": 0}], "chart": None}

    monkeypatch.setattr(insights, "ALL_INSIGHTS", [CompleteInsight])
    insights.InsightsJob(sheets, configuration).run()
    assert sheets.read_headers.call_count == 4
    assert sheets.read_sheet.call_count == 4
    sheets.replace_today_and_trim.assert_called_once()
