import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_ROOT = MODULE_ROOT.parent / "consolidated-pipeline"
_FAKE_UV = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ['LAUNCHER_CALLS_FILE'], 'a') as calls:
    calls.write(json.dumps({'argv': sys.argv[1:], 'url': os.environ.get('LSL_SCRIPT_URL'), 'sheet': os.environ.get('LSL_SPREADSHEET_ID'), 'log_root': os.environ.get('MERIDIAN_LOG_ROOT')}) + '\\n')
"""
_RUN = ["run", "--locked", "python", "-m", "core.runner"]


def _config_path(repository: Path, env: str = "prod") -> Path:
    return repository / "data-synchronization" / "consolidated-pipeline" / "config" / f"pipeline.{env}.json"


def _write_pipeline(repository: Path, settings: dict, env: str = "prod") -> Path:
    path = _config_path(repository, env)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings))
    return path


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    repository = tmp_path / "repository"
    cicd = repository / "data-synchronization" / "ledger-sheet-load" / "cicd"
    cicd.mkdir(parents=True)
    script = cicd / "start-up.sh"
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", script)
    shutil.copyfile(MODULE_ROOT / "cicd" / "check.sh", cicd / "check.sh")
    environments = {name: {"script_url": f"https://fixture/{name}/exec", "spreadsheet_id": f"fixture-{name}-sheet"} for name in ("dev", "prod")}
    (cicd / "envs.json").write_text(json.dumps({"_comment": "fixture", **environments}))
    pipeline = repository / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/read-stage.py", "core/pipeline_config.py"):
        (pipeline / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PIPELINE_ROOT / part, pipeline / part)
    _write_pipeline(repository, {"env": "prod", "stages": [{"module": "ledger-sheet-load", "mode": "sheet-sync"}]})
    infrastructure = repository / "infrastructure"
    infrastructure.mkdir()
    for name in ("dev", "prod"):
        (infrastructure / f".env.{name}").write_text("# Isolated test environment; no credentials.\nLSL_SCRIPT_URL=stale\n")
    binary_directory = tmp_path / "bin"
    binary_directory.mkdir()
    calls_file = tmp_path / "uv-calls.jsonl"
    fake_uv = binary_directory / "uv"
    fake_uv.write_text(_FAKE_UV)
    fake_uv.chmod(0o755)
    environment = {**os.environ, "PATH": f"{binary_directory}:{os.environ['PATH']}", "LAUNCHER_CALLS_FILE": str(calls_file)}
    return script, calls_file, environment


def _calls(calls_file: Path) -> list[dict]:
    return [json.loads(line) for line in calls_file.read_text().splitlines()]


def _run(script: Path, environment: dict[str, str], *arguments: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/bash", str(script), *arguments], env=environment, input=stdin, capture_output=True, text=True, timeout=15)


# ── Interactive (make data-sync / make run) ──────────────────────────────────


@pytest.mark.parametrize("environment_name", ["dev", "prod"])
@pytest.mark.parametrize("mode", ["sheet-rebuild", "sheet-sync"])
def test_interactive_runs_job_with_selected_env_and_mode_without_migrations(launcher: tuple[Path, Path, dict[str, str]], environment_name: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--interactive", environment_name, mode)
    assert completed.returncode == 0, completed.stderr
    calls = _calls(calls_file)
    assert [call["argv"] for call in calls] == [["sync", "--locked", "--quiet"], [*_RUN, "--env", environment_name, "--mode", mode, "--interactive"]]
    # envs.json wins over a stale value in the env file.
    assert calls[-1]["url"] == f"https://fixture/{environment_name}/exec"
    assert calls[-1]["sheet"] == f"fixture-{environment_name}-sheet"
    # Each module logs under its own folder of the shared log root.
    assert calls[-1]["log_root"] == f"{environment['MERIDIAN_LOG_ROOT']}/ledger-sheet-load"


@pytest.mark.parametrize("choice,mode", [("1", "sheet-rebuild"), ("2", "sheet-sync")])
def test_interactive_prompts_for_mode_when_not_given(launcher: tuple[Path, Path, dict[str, str]], choice: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--interactive", "dev", stdin=f"{choice}\n")
    assert completed.returncode == 0, completed.stderr
    assert "Select mode (1/2):" in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-3:] == ["--mode", mode, "--interactive"]


@pytest.mark.parametrize(
    "arguments",
    [
        ["--interactive"],
        ["--interactive", "unknown"],
        ["--interactive", "_comment"],
        ["--interactive", "dev", "rebuild"],
        ["--interactive", "dev", "sheet-sync", "extra"],
        ["--interactive", "dev", "sheet-sync", "--sign-in-only"],
        ["--interactive", "dev", "sheet-sync", "--config", "x.json"],
        ["--unknown-flag"],
        ["--check"],
    ],
)
def test_launcher_rejects_invalid_arguments_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, *arguments)
    assert completed.returncode != 0
    assert "unbound variable" not in completed.stderr
    assert not calls_file.exists()


@pytest.mark.parametrize("mode_input", ["3\n", "\n", ""])
def test_interactive_rejects_invalid_or_missing_mode_choice(launcher: tuple[Path, Path, dict[str, str]], mode_input: str) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--interactive", "dev", stdin=mode_input)
    assert completed.returncode != 0
    assert "Invalid choice" in completed.stdout
    assert not calls_file.exists()


def test_launcher_refuses_unconfigured_environment(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    (script.parent / "envs.json").write_text(json.dumps({"dev": {"script_url": "TODO", "spreadsheet_id": "fixture"}}))
    completed = _run(script, environment, "--interactive", "dev", "sheet-sync")
    assert completed.returncode != 0
    assert "must be configured" in completed.stdout
    assert not calls_file.exists()


def test_launcher_requires_a_log_root_before_running_commands(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    environment = {key: value for key, value in environment.items() if key != "MERIDIAN_LOG_ROOT"}
    completed = _run(script, environment, "--interactive", "dev", "sheet-sync")
    assert completed.returncode != 0
    assert "MERIDIAN_LOG_ROOT must be set" in completed.stderr
    assert not calls_file.exists()


# ── Unattended (default: the pipeline config) ────────────────────────────────


def test_default_reads_env_and_mode_from_the_pipeline_config(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--config", str(_config_path(script.parents[3])))
    assert completed.returncode == 0, completed.stderr
    calls = _calls(calls_file)
    assert calls[-1]["argv"] == [*_RUN, "--env", "prod", "--mode", "sheet-sync", "--confirm", ""]
    assert calls[-1]["url"] == "https://fixture/prod/exec"


def test_unattended_rebuild_passes_the_config_confirmation_and_sign_in_flag(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    config = tmp_path / "pipeline.dev.json"
    config.write_text(json.dumps({"env": "dev", "stages": [{"module": "currency-database-load", "mode": "daily"}, {"module": "ledger-sheet-load", "mode": "sheet-rebuild", "confirm": "dev"}]}))
    completed = _run(script, environment, "--config", str(config), "--stage", "2", "--skip-sign-in")
    assert completed.returncode == 0, completed.stderr
    assert _calls(calls_file)[-1]["argv"] == [*_RUN, "--env", "dev", "--mode", "sheet-rebuild", "--confirm", "dev", "--skip-sign-in"]


def test_check_sh_validates_and_declares_credentials_without_running_anything(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = _run(script.parent / "check.sh", environment, "--config", str(_config_path(script.parents[3])))
    assert completed.returncode == 0, completed.stderr
    assert "Check passed: ledger-sheet-load sheet-sync" in completed.stdout
    assert "credentials=gas-pin-totp" in completed.stdout.splitlines()
    assert "Loading env vars" not in completed.stdout
    assert not calls_file.exists()


@pytest.mark.parametrize(
    "arguments,settings,message",
    [
        (["dev", "sheet-sync"], None, "pass --interactive"),
        ([], None, "unattended runs need --config"),
        (["--stage", "1"], {"env": "prod", "stages": [{"module": "ledger-sheet-extract", "mode": "normal-sync"}]}, "stage_module_mismatch"),
        ([], {"env": "prod", "stages": [{"module": "ledger-sheet-extract", "mode": "normal-sync"}]}, "module_not_in_pipeline"),
        ([], {"env": "Dev!", "stages": [{"module": "ledger-sheet-load", "mode": "sheet-sync"}]}, "invalid_env"),
        ([], {"env": "dev", "stages": [{"module": "ledger-sheet-load", "mode": "sheet-sync"}]}, "env_does_not_match_file_name"),
        ([], {"env": "prod", "stages": [{"module": "ledger-sheet-load", "mode": "rebuild"}]}, "mode must be"),
        (["--config", "/nonexistent/pipeline.dev.json"], None, "config_not_found"),
        (["--config", "/tmp/settings.json"], None, "config_file_name_must_be_pipeline.<env>.json"),
    ],
)
def test_unattended_rejects_bad_config_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str], settings: dict | None, message: str) -> None:
    script, calls_file, environment = launcher
    if settings is not None:
        arguments = [*arguments, "--config", str(_write_pipeline(script.parents[3], settings))]
    completed = _run(script, environment, *arguments)
    assert completed.returncode != 0
    assert message in completed.stdout + completed.stderr
    assert not calls_file.exists()


def test_data_sync_menu_lists_module_and_hands_it_the_mode_choice(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    repository = script.parents[3]
    shutil.copyfile(MODULE_ROOT.parents[1] / "Makefile", repository / "Makefile")
    # The root Makefile's shared env picker and the env list it reads.
    shutil.copyfile(MODULE_ROOT.parents[1] / "infrastructure" / "select-env.sh", repository / "infrastructure" / "select-env.sh")
    (repository / "infrastructure" / "envs.json").write_text(json.dumps({"dev": {}, "prod": {}}))
    (repository / "data-synchronization" / "consolidated-pipeline" / "cicd" / "start-up.sh").write_text("exit 99\n")
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input="1\n1\n2\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "1) ledger-sheet-load" in completed.stdout
    assert "consolidated-pipeline" not in completed.stdout.split("Select module")[0]
    assert "[dev] Running ledger-sheet-load job (sheet-sync)..." in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-5:] == ["--env", "dev", "--mode", "sheet-sync", "--interactive"]


def test_repository_has_no_factory_reset_target_or_bash_scripts() -> None:
    repository = MODULE_ROOT.parents[1]
    makefile = (repository / "Makefile").read_text()
    assert "factory-reset" not in makefile
    assert not (repository / "expense-tracker" / "scripts").exists()


def test_start_up_always_runs_the_check_first_without_declaring_credentials(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--config", str(_config_path(script.parents[3])))
    assert completed.returncode == 0, completed.stderr
    lines = completed.stdout.splitlines()
    assert lines.index("[prod] Check passed: ledger-sheet-load sheet-sync") < lines.index("[prod] Loading env vars...")
    assert "credentials=gas-pin-totp" not in lines


def test_data_sync_env_variable_skips_the_env_question(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    repository = script.parents[3]
    shutil.copyfile(MODULE_ROOT.parents[1] / "Makefile", repository / "Makefile")
    shutil.copyfile(MODULE_ROOT.parents[1] / "infrastructure" / "select-env.sh", repository / "infrastructure" / "select-env.sh")
    (repository / "infrastructure" / "envs.json").write_text(json.dumps({"dev": {}, "prod": {}}))
    completed = subprocess.run(["make", "data-sync", "ENV=prod"], cwd=repository, env=environment, input="1\n2\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select environment" not in completed.stdout + completed.stderr
    assert _calls(calls_file)[-1]["argv"][-5:] == ["--env", "prod", "--mode", "sheet-sync", "--interactive"]
