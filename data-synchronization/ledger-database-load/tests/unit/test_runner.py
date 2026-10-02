from unittest.mock import MagicMock

import pytest

import core.runner as runner


@pytest.mark.parametrize(
    "reason",
    [
        "account_detail_error:account_investment_stocks:row=4:valuation_rate_not_found",
        "account_detail_error:account_investment_property:row=7:invalid_source_value_or_constraint",
        "entity_rows_failed:account_deposit",
        "sheet_changed_before_acknowledgement:account_investment_property",
        "invalid_sheet_id:account_liability_mortgage:row=2",
        "entity_rows_failed:account_master",
        "entity_rows_failed:category_master",
        "entity_rows_failed:subscription_master",
        "entity_rows_failed:transaction_master",
        "missing_enabled_sheet:transaction_master",
        "missing_enabled_sheet:account_investment_stocks",
        "master_sheet_name_collision:account_master",
        "master_sheet_name_collision:category_master",
        "master_sheet_name_collision:subscription_master",
        "master_sheet_name_collision:transaction_master",
    ],
)
def test_runner_reports_actionable_account_detail_failures(reason: str, monkeypatch: pytest.MonkeyPatch) -> None:
    logger = MagicMock()
    monkeypatch.setattr(runner, "logger", logger)
    monkeypatch.setattr(runner.sys, "argv", ["ledger-sheet-extract"])
    monkeypatch.setattr(runner.config, "db_config", MagicMock(side_effect=ValueError(reason)))
    with pytest.raises(SystemExit) as error:
        runner.main()
    assert error.value.code == 1
    logger.error.assert_called_once_with(f"runner: job_failed error=ValueError reason={reason}")


@pytest.mark.parametrize(
    "reason",
    [
        "account_detail_error:private_account_name:row=4:valuation_rate_not_found",
        "account_detail_error:account_investment_stocks:row=4:balance=1234.56",
        "account_detail_error:account_investment_property:row=2:invalid_source_value\nprivate financial row",
        "invalid numeric value: private financial row",
        "DETAIL: Failing row contains (private, 1234.56)",
    ],
)
def test_runner_does_not_log_unstructured_detail_values(reason: str, monkeypatch: pytest.MonkeyPatch) -> None:
    logger = MagicMock()
    monkeypatch.setattr(runner, "logger", logger)
    monkeypatch.setattr(runner.sys, "argv", ["ledger-sheet-extract"])
    monkeypatch.setattr(runner.config, "db_config", MagicMock(side_effect=ValueError(reason)))
    with pytest.raises(SystemExit):
        runner.main()
    logger.error.assert_called_once_with("runner: job_failed error=ValueError reason=see_entity_logs")


def test_runner_exposes_transaction_structure_failure_without_source_values() -> None:
    assert runner._safe_failure_reason(ValueError("transactions: cyclic_parent_reference")) == "transaction_error:cyclic_parent_reference"
    assert runner._safe_failure_reason(ValueError("transactions: duplicate_source_id")) == "transaction_error:duplicate_source_id"
    assert runner._safe_failure_reason(ValueError("transactions: invalid_amount value=private")) == "see_entity_logs"


def test_runner_exposes_subscription_structure_failure_without_source_values() -> None:
    assert runner._safe_failure_reason(ValueError("subscriptions: duplicate_source_id")) == "subscription_error:duplicate_source_id"
    assert runner._safe_failure_reason(ValueError("subscriptions: invalid_amount value=private")) == "see_entity_logs"
