from unittest.mock import MagicMock

import pytest

import core.config as config
import core.runner as runner
from core.errors import error_code


@pytest.mark.parametrize(
    "error,code",
    [
        (RuntimeError("analytics_already_running"), "analytics_already_running"),
        (ValueError("missing_environment_variable:ANA_SERVICE_ACCOUNT_FILE"), "missing_environment_variable:ANA_SERVICE_ACCOUNT_FILE"),
        (RuntimeError("mart_rate_missing:GBP"), "mart_rate_missing:GBP"),
        (RuntimeError("Mart failed for £12.50"), "see_module_logs"),
        (ValueError("invalid literal for int() with base 10: 'private value'"), "see_module_logs"),
        (KeyboardInterrupt(), "interrupted"),
    ],
)
def test_only_codes_and_names_reach_the_log(error: BaseException, code: str) -> None:
    assert error_code(error) == code


@pytest.mark.parametrize("mode,built,published,checked", [("build", 1, 0, 0), ("publish", 0, 1, 0), ("refresh", 1, 1, 0), ("check", 0, 0, 1)])
def test_each_mode_runs_its_steps(monkeypatch: pytest.MonkeyPatch, mode: str, built: int, published: int, checked: int) -> None:
    calls = {name: MagicMock() for name in ("build", "publish", "check")}
    for name, mock in calls.items():
        monkeypatch.setattr(runner, name, mock)
    monkeypatch.setattr(runner.sys, "argv", ["analytics", "--mode", mode])
    monkeypatch.setattr(config, "db_config", lambda: None)
    monkeypatch.setattr(config, "spreadsheet_id", lambda: "sheet")
    monkeypatch.setattr(config, "service_account_file", lambda: "/keys/sa.json")
    runner.main()
    assert [calls["build"].call_count, calls["publish"].call_count, calls["check"].call_count] == [built, published, checked]


def test_a_failure_logs_a_safe_code_and_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = MagicMock()
    monkeypatch.setattr(runner, "logger", logger)
    monkeypatch.setattr(runner, "build", MagicMock(side_effect=RuntimeError("analytics_already_running")))
    monkeypatch.setattr(runner.sys, "argv", ["analytics", "--mode", "build"])
    monkeypatch.setattr(config, "db_config", lambda: None)
    with pytest.raises(SystemExit):
        runner.main()
    logger.error.assert_called_once_with("runner: job_failed error=RuntimeError reason=analytics_already_running")


def test_keep_generations_must_be_a_positive_integer() -> None:
    assert config.keep_generations(config.load_config()) == 5
    for value in (0, -1, True, "5", None):
        with pytest.raises(ValueError, match="^invalid_keep_generations$"):
            config.keep_generations({"keep_generations": value})


def test_the_contract_files_are_readable_and_agree_on_the_version() -> None:
    versions = {config.contract(name)["contract_version"] for name in ("report-definition", "predefined-reports", "sheet-tabs")}
    assert len(versions) == 1
