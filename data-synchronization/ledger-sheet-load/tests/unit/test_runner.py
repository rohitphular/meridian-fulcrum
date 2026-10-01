import io
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import core.runner as runner

_PIN = "9731"


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, MagicMock]:
    logger = MagicMock()
    job = MagicMock()
    monkeypatch.setattr(runner, "logger", logger)
    monkeypatch.setattr(runner.config, "data_dir", lambda settings: tmp_path)
    monkeypatch.setattr(runner, "collect_datasets", lambda settings, data_dir: [])
    monkeypatch.setattr(runner.config, "spreadsheet_id", lambda: "sheet-id")
    monkeypatch.setattr(runner.config, "script_url", lambda: "https://fixture/exec")
    monkeypatch.setattr(runner, "read_credentials", lambda: (_PIN, "123456"))
    monkeypatch.setattr(runner, "LedgerSheetLoadJob", job)
    return {"logger": logger, "job": job}


def _run(monkeypatch: pytest.MonkeyPatch, mode: str, answer: str, *extra: str) -> int | None:
    monkeypatch.setattr(runner.sys, "argv", ["ledger-sheet-load", "--env", "dev", "--mode", mode, *(extra or ("--interactive",))])
    monkeypatch.setattr("builtins.input", lambda prompt: answer)
    try:
        runner.main()
    except SystemExit as exit_:
        return exit_.code  # type: ignore[return-value]
    return None


@pytest.mark.parametrize("mode,answer", [("sheet-rebuild", "dev"), ("sheet-sync", "y")])
def test_runner_runs_job_after_confirmation(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock], mode: str, answer: str) -> None:
    assert _run(monkeypatch, mode, answer) is None
    wired["job"].return_value.run.assert_called_once_with(mode, "123456")


@pytest.mark.parametrize("mode,answer", [("sheet-rebuild", "prod"), ("sheet-rebuild", "y"), ("sheet-sync", ""), ("sheet-sync", "n")])
def test_runner_changes_nothing_without_confirmation(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock], mode: str, answer: str) -> None:
    assert _run(monkeypatch, mode, answer) == 1
    wired["job"].assert_not_called()


def test_runner_never_logs_the_pin(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock]) -> None:
    wired["job"].return_value.run.side_effect = RuntimeError(f"boom {_PIN}")
    assert _run(monkeypatch, "sheet-sync", "y") == 1
    logged = " ".join(str(call) for call in wired["logger"].mock_calls)
    assert _PIN not in logged
    wired["logger"].error.assert_called_once_with("runner: job_failed error=RuntimeError reason=unexpected_error")


@pytest.mark.parametrize("reason", ["invalid_csv_rows:load:transaction_master_2026_01.csv", "http_error:verify:500", "missing_transaction_files", "rows_failed:check:account_types.csv"])
def test_runner_reports_structured_reasons(reason: str) -> None:
    assert runner._safe_failure_reason(RuntimeError(reason)) == reason


@pytest.mark.parametrize("reason", ["Row 3: private value", "https://script.google.com/exec?pin=1", "invalid csv: 1234.56 GBP"])
def test_runner_hides_unstructured_reasons(reason: str) -> None:
    assert runner._safe_failure_reason(RuntimeError(reason)) == "unexpected_error"


# ── Unattended ───────────────────────────────────────────────────────────────


def _unattended(monkeypatch: pytest.MonkeyPatch, stdin: str, *arguments: str) -> int | None:
    monkeypatch.setattr(runner.sys, "argv", ["ledger-sheet-load", "--env", "dev", *arguments])
    monkeypatch.setattr(runner.sys, "stdin", io.StringIO(stdin))
    monkeypatch.setattr("builtins.input", MagicMock(side_effect=AssertionError("unattended runs never prompt")))
    try:
        runner.main()
    except SystemExit as exit_:
        return exit_.code  # type: ignore[return-value]
    return None


def test_unattended_reads_pin_and_code_from_stdin_and_runs(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock]) -> None:
    monkeypatch.setattr(runner, "read_credentials", MagicMock(side_effect=AssertionError("no prompts")))
    assert _unattended(monkeypatch, f"{_PIN}\n123456\n", "--mode", "sheet-sync") is None
    wired["job"].return_value.run.assert_called_once_with("sheet-sync", "123456")


def test_skip_sign_in_reads_only_the_pin_and_runs_without_verify(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock]) -> None:
    assert _unattended(monkeypatch, f"{_PIN}\n", "--mode", "sheet-sync", "--skip-sign-in") is None
    wired["job"].return_value.run.assert_called_once_with("sheet-sync", None)


def test_sign_in_only_verifies_and_stops(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock]) -> None:
    assert _unattended(monkeypatch, f"{_PIN}\n654321\n", "--mode", "sheet-sync", "--sign-in-only") is None
    wired["job"].return_value.sign_in.assert_called_once_with("654321")
    wired["job"].return_value.run.assert_not_called()


@pytest.mark.parametrize("confirm", ["", "prod"])
def test_unattended_rebuild_requires_the_config_confirmation(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock], confirm: str) -> None:
    assert _unattended(monkeypatch, f"{_PIN}\n123456\n", "--mode", "sheet-rebuild", "--confirm", confirm) == 1
    wired["job"].assert_not_called()
    wired["logger"].error.assert_called_once_with("runner: job_failed error=ValueError reason=rebuild_not_confirmed")


def test_unattended_rebuild_runs_when_confirmed(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock]) -> None:
    assert _unattended(monkeypatch, f"{_PIN}\n123456\n", "--mode", "sheet-rebuild", "--confirm", "dev") is None
    wired["job"].return_value.run.assert_called_once_with("sheet-rebuild", "123456")


@pytest.mark.parametrize("stdin,reason", [("", "pin_required"), (f"{_PIN}\n12\n", "invalid_authenticator_code")])
def test_unattended_rejects_missing_or_bad_credentials(monkeypatch: pytest.MonkeyPatch, wired: dict[str, MagicMock], stdin: str, reason: str) -> None:
    assert _unattended(monkeypatch, stdin, "--mode", "sheet-sync") == 1
    wired["job"].assert_not_called()
    wired["logger"].error.assert_called_once_with(f"runner: job_failed error=ValueError reason={reason}")
