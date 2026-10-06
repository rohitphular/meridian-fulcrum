import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import core.runner as runner

_PIN = "9731"
_CODE = "246810"

# A stand-in module launcher: records its arguments and stdin, then behaves as the
# behaviour file says (exit codes per phase; whether check.sh declares credentials).
_FAKE_MODULE = """import json, os, sys
module, args = sys.argv[1], sys.argv[2:]
stdin = sys.stdin.read()
with open(os.environ["FAKE_CALLS"], "a") as calls:
    record = {"module": module, "script": os.environ["FAKE_SCRIPT"], "args": args, "stdin": stdin}
    record.update(venv=os.environ.get("VIRTUAL_ENV"), pin=os.environ.get("MERIDIAN_FULCRUM_PIN"))
    calls.write(json.dumps(record) + "\\n")
behaviour = json.load(open(os.environ["FAKE_BEHAVIOUR"])).get(module, {})
phase = "check" if os.environ["FAKE_SCRIPT"] == "check" else "sign_in" if "--sign-in-only" in args else "run"
if phase == "check" and behaviour.get("credentials"):
    print("credentials=" + behaviour["credentials"])
sys.exit(behaviour.get(phase, 0))
"""


# The script is a file (not a heredoc) so the launcher's stdin stays the caller's.
def _fake_launcher(script: str) -> str:
    return f'FAKE_SCRIPT={script} exec python3 "$(dirname "$0")/fake_module.py" "$(basename "$(cd "$(dirname "$0")/.." && pwd)")" "$@"\n'


@pytest.fixture
def repository(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    data_sync = tmp_path / "data-synchronization"
    for module in ("forex-database-load", "ledger-sheet-load", "ledger-sheet-extract"):
        launcher = data_sync / module / "cicd" / "start-up.sh"
        launcher.parent.mkdir(parents=True)
        launcher.write_text(_fake_launcher("start-up"))
        (launcher.parent / "check.sh").write_text(_fake_launcher("check"))
        (launcher.parent / "fake_module.py").write_text(_FAKE_MODULE)
    behaviour = tmp_path / "behaviour.json"
    behaviour.write_text(json.dumps({"ledger-sheet-load": {"credentials": "gas-pin-totp"}}))
    calls = tmp_path / "calls.jsonl"
    config = tmp_path / "pipeline.dev.json"
    config.write_text(
        json.dumps(
            {
                "env": "dev",
                "stages": [
                    {"module": "ledger-sheet-load", "mode": "sheet-sync"},
                    {"module": "forex-database-load", "mode": "daily"},
                    {"module": "ledger-sheet-extract", "mode": "normal-sync"},
                ],
            }
        )
    )
    monkeypatch.setattr(runner.config, "DATA_SYNC_ROOT", data_sync)
    monkeypatch.setenv("FAKE_CALLS", str(calls))
    monkeypatch.setenv("FAKE_BEHAVIOUR", str(behaviour))
    monkeypatch.setattr(runner.sys, "argv", ["consolidated-pipeline", "--config", str(config)])
    monkeypatch.setattr(runner.getpass, "getpass", lambda prompt: _PIN)
    monkeypatch.setattr("builtins.input", lambda prompt: _CODE)
    logger = MagicMock()
    monkeypatch.setattr(runner, "logger", logger)
    return {"config": config, "calls": calls, "behaviour": behaviour, "logger": logger}


def _calls(repository: dict) -> list[dict]:
    if not repository["calls"].exists():
        return []
    return [json.loads(line) for line in repository["calls"].read_text().splitlines()]


def _main() -> int | None:
    try:
        runner.main()
    except SystemExit as exit_:
        return exit_.code  # type: ignore[return-value]
    return None


def _set_behaviour(repository: dict, behaviour: dict) -> None:
    repository["behaviour"].write_text(json.dumps({"ledger-sheet-load": {"credentials": "gas-pin-totp"}, **behaviour}))


def test_pipeline_checks_all_signs_in_once_then_runs_stages_in_order(repository: dict) -> None:
    assert _main() is None
    config = str(repository["config"])
    calls = _calls(repository)
    assert [(call["module"], call["script"], call["args"]) for call in calls] == [
        ("ledger-sheet-load", "check", ["--config", config, "--stage", "1"]),
        ("forex-database-load", "check", ["--config", config, "--stage", "2"]),
        ("ledger-sheet-extract", "check", ["--config", config, "--stage", "3"]),
        ("ledger-sheet-load", "start-up", ["--config", config, "--stage", "1", "--sign-in-only"]),
        ("ledger-sheet-load", "start-up", ["--config", config, "--stage", "1", "--skip-sign-in"]),
        ("forex-database-load", "start-up", ["--config", config, "--stage", "2"]),
        ("ledger-sheet-extract", "start-up", ["--config", config, "--stage", "3"]),
    ]
    # Credentials travel on stdin only: PIN + code to sign in, then the PIN alone.
    assert calls[3]["stdin"] == f"{_PIN}\n{_CODE}\n"
    assert calls[4]["stdin"] == f"{_PIN}\n"
    assert all(call["stdin"] == "" for index, call in enumerate(calls) if index not in (3, 4))
    assert all(_PIN not in " ".join(call["args"]) and _CODE not in " ".join(call["args"]) for call in calls)


def test_pipeline_without_credential_stages_never_prompts(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    repository["config"].write_text(json.dumps({"env": "dev", "stages": [{"module": "forex-database-load", "mode": "daily"}]}))
    monkeypatch.setattr(runner.getpass, "getpass", MagicMock(side_effect=AssertionError("no prompt expected")))
    assert _main() is None
    assert [call["script"] for call in _calls(repository)] == ["check", "start-up"]


def test_a_failed_preflight_runs_nothing_and_asks_for_nothing(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_behaviour(repository, {"ledger-sheet-extract": {"check": 1}})
    monkeypatch.setattr(runner.getpass, "getpass", MagicMock(side_effect=AssertionError("no prompt expected")))
    assert _main() == 1
    assert all(call["script"] == "check" for call in _calls(repository))
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=preflight_failed:stage=3:ledger-sheet-extract")


def test_a_failed_sign_in_runs_no_stage(repository: dict) -> None:
    _set_behaviour(repository, {"ledger-sheet-load": {"credentials": "gas-pin-totp", "sign_in": 1}})
    assert _main() == 1
    assert not any(call["script"] == "start-up" and "--sign-in-only" not in call["args"] for call in _calls(repository))
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=sign_in_failed:stage=1:ledger-sheet-load")


def test_the_run_stops_at_the_first_failed_stage(repository: dict, capsys: pytest.CaptureFixture[str]) -> None:
    _set_behaviour(repository, {"forex-database-load": {"run": 3}})
    assert _main() == 1
    runs = [call["module"] for call in _calls(repository) if call["script"] == "start-up" and "--sign-in-only" not in call["args"]]
    assert runs == ["ledger-sheet-load", "forex-database-load"]
    output = capsys.readouterr().out
    assert "failed (exit 3)" in output and "not run" in output
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=stage_failed:stage=2:forex-database-load")


@pytest.mark.parametrize("pin,code,reason", [("", _CODE, "pin_required"), (_PIN, "12", "invalid_authenticator_code")])
def test_bad_credentials_stop_before_sign_in(repository: dict, monkeypatch: pytest.MonkeyPatch, pin: str, code: str, reason: str) -> None:
    monkeypatch.setattr(runner.getpass, "getpass", lambda prompt: pin)
    monkeypatch.setattr("builtins.input", lambda prompt: code)
    assert _main() == 1
    assert all(call["script"] == "check" for call in _calls(repository))
    repository["logger"].error.assert_called_once_with(f"pipeline: failed reason={reason}")


@pytest.mark.parametrize("module,reason", [("consolidated-pipeline", "unknown_module:stage=1:consolidated-pipeline"), ("no-such-module", "unknown_module:stage=1:no-such-module")])
def test_unknown_modules_are_rejected_before_any_launcher_runs(repository: dict, module: str, reason: str) -> None:
    repository["config"].write_text(json.dumps({"env": "dev", "stages": [{"module": module, "mode": "x"}]}))
    assert _main() == 1
    assert _calls(repository) == []
    repository["logger"].error.assert_called_once_with(f"pipeline: failed reason={reason}")


def test_unsupported_credential_kinds_are_rejected(repository: dict) -> None:
    _set_behaviour(repository, {"forex-database-load": {"credentials": "something-else"}})
    assert _main() == 1
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=unsupported_credentials:stage=2:forex-database-load")


def test_the_pin_and_code_never_reach_the_log(repository: dict) -> None:
    assert _main() is None
    logged = " ".join(str(call) for call in repository["logger"].mock_calls)
    assert _PIN not in logged and _CODE not in logged


def test_stages_do_not_inherit_the_pipeline_virtualenv(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIRTUAL_ENV", "/consolidated-pipeline/.venv")
    assert _main() is None
    assert {call["venv"] for call in _calls(repository)} == {None}


def test_a_module_without_check_sh_is_rejected(repository: dict) -> None:
    (runner.config.DATA_SYNC_ROOT / "forex-database-load" / "cicd" / "check.sh").unlink()
    assert _main() == 1
    assert _calls(repository) == []
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=unknown_module:stage=2:forex-database-load")


def test_stored_credentials_mean_no_prompt_and_nothing_on_stdin(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MERIDIAN_FULCRUM_PIN", _PIN)
    monkeypatch.setenv("MERIDIAN_FULCRUM_SECRET", "GEZDGNBVGY3TQOJQ")
    monkeypatch.setattr(runner.getpass, "getpass", MagicMock(side_effect=AssertionError("no prompt expected")))
    assert _main() is None
    calls = _calls(repository)
    assert [call["args"][-1] for call in calls if call["script"] == "start-up" and call["module"] == "ledger-sheet-load"] == ["--sign-in-only", "--skip-sign-in"]
    assert all(call["stdin"] == "" for call in calls)


def test_stored_credentials_reach_only_the_stages_that_declare_them(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MERIDIAN_FULCRUM_PIN", _PIN)
    monkeypatch.setenv("MERIDIAN_FULCRUM_SECRET", "GEZDGNBVGY3TQOJQ")
    assert _main() is None
    with_pin = {(call["module"], call["script"]) for call in _calls(repository) if call["pin"] is not None}
    assert with_pin == {("ledger-sheet-load", "start-up")}


def test_a_stopped_pipeline_stops_its_stage_and_finishes_its_report(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    stopped = MagicMock()
    real_popen = runner.subprocess.Popen

    def popen(command, *args, **kwargs):
        if not command[1].endswith("start-up.sh") or "--sign-in-only" in command:
            return real_popen(command, *args, **kwargs)  # checks and sign-in run for real
        process = MagicMock()

        def output():
            yield "line\n"
            raise runner._Terminated("sigterm")  # the signal arrives while the stage runs

        process.stdout = output()
        process.poll.return_value = None
        stopped.process = process
        return process

    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    stop = MagicMock()
    monkeypatch.setattr(runner, "_stop_stage", stop)
    assert _main() == 1
    stop.assert_called_once_with(stopped.process)
    saved = _latest_report()
    assert saved["status"] == "interrupted" and saved["failure_reason"] == "signal:sigterm"
    assert saved["stages"][0]["status"] == "failed" and saved["stages"][1]["status"] == "not_run"


def test_an_unexpected_error_still_finishes_the_report(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner, "run_stages", MagicMock(side_effect=ValueError("boom")))
    with pytest.raises(ValueError):
        runner.main()
    saved = _latest_report()
    assert saved["status"] == "failed" and saved["failure_reason"] == "unexpected_error:ValueError"


@pytest.mark.parametrize("variable", ["MERIDIAN_FULCRUM_PIN", "MERIDIAN_FULCRUM_SECRET"])
def test_one_stored_variable_without_the_other_is_an_error(repository: dict, monkeypatch: pytest.MonkeyPatch, variable: str) -> None:
    monkeypatch.setenv(variable, "set")
    assert _main() == 1
    assert all(call["script"] == "check" for call in _calls(repository))
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=incomplete_stored_credentials")


def test_a_run_after_failure_stage_still_runs_after_an_earlier_failure(repository: dict, capsys: pytest.CaptureFixture[str]) -> None:
    repository["config"].write_text(
        json.dumps(
            {
                "env": "dev",
                "stages": [
                    {"module": "forex-database-load", "mode": "daily"},
                    {"module": "ledger-sheet-extract", "mode": "normal-sync"},
                    {"module": "forex-database-load", "mode": "daily"},
                    {"module": "ledger-sheet-load", "mode": "sheet-sync", "run_after_failure": True},
                ],
            }
        )
    )
    _set_behaviour(repository, {"ledger-sheet-extract": {"run": 1}})
    assert _main() == 1
    runs = [(call["module"], call["args"][3]) for call in _calls(repository) if call["script"] == "start-up" and "--sign-in-only" not in call["args"]]
    assert runs == [("forex-database-load", "1"), ("ledger-sheet-extract", "2"), ("ledger-sheet-load", "4")]
    output = capsys.readouterr().out
    assert output.count("not run") == 1
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=stage_failed:stage=2:ledger-sheet-extract")


def _latest_report() -> dict:
    files = sorted(path for path in runner.config.OUTPUT_DATA_DIR.glob("*.json") if path.name != "index.json")
    assert files, "the run wrote a report"
    return json.loads(files[-1].read_text())


def test_a_pipeline_run_writes_its_report_without_credentials(repository: dict) -> None:
    assert _main() is None
    saved = _latest_report()
    assert saved["status"] == "ok" and saved["credentials"] == "prompted"
    assert [entry["ok"] for entry in saved["preflight"]] == [True, True, True]
    assert saved["sign_in"]["ok"] is True and saved["sign_in"]["module"] == "ledger-sheet-load"
    assert [stage["status"] for stage in saved["stages"]] == ["ok", "ok", "ok"]
    assert _PIN not in json.dumps(saved) and _CODE not in json.dumps(saved)


def test_a_failed_preflight_is_reported(repository: dict) -> None:
    _set_behaviour(repository, {"ledger-sheet-extract": {"check": 1}})
    assert _main() == 1
    saved = _latest_report()
    assert saved["status"] == "preflight_failed"
    assert saved["failure_reason"] == "preflight_failed:stage=3:ledger-sheet-extract"
    assert [entry["ok"] for entry in saved["preflight"]] == [True, True, False]
    assert [stage["status"] for stage in saved["stages"]] == ["not_run", "not_run", "not_run"]


def test_a_signal_while_the_report_is_created_still_finishes_it_interrupted(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    import os
    import signal

    class SignalledReport(runner.RunReport):
        def __init__(self, *args, **kwargs) -> None:
            super().__init__(*args, **kwargs)
            os.kill(os.getpid(), signal.SIGTERM)  # deferred until the handlers are in place

    monkeypatch.setattr(runner, "RunReport", SignalledReport)
    saved = {signum: signal.getsignal(signum) for signum in runner._STOP_SIGNALS}
    assert _main() == 1
    assert {signum: signal.getsignal(signum) for signum in runner._STOP_SIGNALS} == saved, "handlers restored"
    report = _latest_report()
    assert report["status"] == "interrupted" and report["failure_reason"] == "signal:sigterm"
    assert _calls(repository) == []
