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
    calls.write(json.dumps({"module": module, "script": os.environ["FAKE_SCRIPT"], "args": args, "stdin": stdin, "venv": os.environ.get("VIRTUAL_ENV")}) + "\\n")
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
    for module in ("currency-database-load", "ledger-sheet-load", "ledger-sheet-extract"):
        launcher = data_sync / module / "cicd" / "start-up.sh"
        launcher.parent.mkdir(parents=True)
        launcher.write_text(_fake_launcher("start-up"))
        (launcher.parent / "check.sh").write_text(_fake_launcher("check"))
        (launcher.parent / "fake_module.py").write_text(_FAKE_MODULE)
    behaviour = tmp_path / "behaviour.json"
    behaviour.write_text(json.dumps({"ledger-sheet-load": {"credentials": "gas-pin-totp"}}))
    calls = tmp_path / "calls.jsonl"
    config = tmp_path / "pipeline.json"
    config.write_text(
        json.dumps(
            {
                "env": "dev",
                "stages": [
                    {"module": "ledger-sheet-load", "mode": "sheet-sync"},
                    {"module": "currency-database-load", "mode": "daily"},
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
        ("currency-database-load", "check", ["--config", config, "--stage", "2"]),
        ("ledger-sheet-extract", "check", ["--config", config, "--stage", "3"]),
        ("ledger-sheet-load", "start-up", ["--config", config, "--stage", "1", "--sign-in-only"]),
        ("ledger-sheet-load", "start-up", ["--config", config, "--stage", "1", "--skip-sign-in"]),
        ("currency-database-load", "start-up", ["--config", config, "--stage", "2"]),
        ("ledger-sheet-extract", "start-up", ["--config", config, "--stage", "3"]),
    ]
    # Credentials travel on stdin only: PIN + code to sign in, then the PIN alone.
    assert calls[3]["stdin"] == f"{_PIN}\n{_CODE}\n"
    assert calls[4]["stdin"] == f"{_PIN}\n"
    assert all(call["stdin"] == "" for index, call in enumerate(calls) if index not in (3, 4))
    assert all(_PIN not in " ".join(call["args"]) and _CODE not in " ".join(call["args"]) for call in calls)


def test_pipeline_without_credential_stages_never_prompts(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    repository["config"].write_text(json.dumps({"env": "dev", "stages": [{"module": "currency-database-load", "mode": "daily"}]}))
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
    _set_behaviour(repository, {"currency-database-load": {"run": 3}})
    assert _main() == 1
    runs = [call["module"] for call in _calls(repository) if call["script"] == "start-up" and "--sign-in-only" not in call["args"]]
    assert runs == ["ledger-sheet-load", "currency-database-load"]
    output = capsys.readouterr().out
    assert "failed (exit 3)" in output and "not run" in output
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=stage_failed:stage=2:currency-database-load")


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
    _set_behaviour(repository, {"currency-database-load": {"credentials": "something-else"}})
    assert _main() == 1
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=unsupported_credentials:stage=2:currency-database-load")


def test_the_pin_and_code_never_reach_the_log(repository: dict) -> None:
    assert _main() is None
    logged = " ".join(str(call) for call in repository["logger"].mock_calls)
    assert _PIN not in logged and _CODE not in logged


def test_stages_do_not_inherit_the_pipeline_virtualenv(repository: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIRTUAL_ENV", "/consolidated-pipeline/.venv")
    assert _main() is None
    assert {call["venv"] for call in _calls(repository)} == {None}


def test_a_module_without_check_sh_is_rejected(repository: dict) -> None:
    (runner.config.DATA_SYNC_ROOT / "currency-database-load" / "cicd" / "check.sh").unlink()
    assert _main() == 1
    assert _calls(repository) == []
    repository["logger"].error.assert_called_once_with("pipeline: failed reason=unknown_module:stage=2:currency-database-load")
