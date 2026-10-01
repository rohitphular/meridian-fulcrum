import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]
_FAKE_UV = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ['LAUNCHER_CALLS_FILE'], 'a') as calls:
    calls.write(json.dumps({'argv': sys.argv[1:], 'url': os.environ.get('LSL_SCRIPT_URL'), 'sheet': os.environ.get('LSL_SPREADSHEET_ID')}) + '\\n')
"""


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    repository = tmp_path / "repository"
    cicd = repository / "data-synchronization" / "ledger-sheet-load" / "cicd"
    cicd.mkdir(parents=True)
    script = cicd / "start-up.sh"
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", script)
    (cicd / "envs.json").write_text(
        json.dumps({"_comment": "fixture", **{name: {"script_url": f"https://fixture/{name}/exec", "spreadsheet_id": f"fixture-{name}-sheet"} for name in ("dev", "prod")}})
    )
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


@pytest.mark.parametrize("environment_name", ["dev", "prod"])
@pytest.mark.parametrize("mode", ["sheet-rebuild", "sheet-sync"])
def test_launcher_runs_job_with_selected_env_and_mode_without_migrations(launcher: tuple[Path, Path, dict[str, str]], environment_name: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), environment_name, mode], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    calls = _calls(calls_file)
    assert [call["argv"] for call in calls] == [["sync", "--locked", "--quiet"], ["run", "--locked", "python", "-m", "core.runner", "--env", environment_name, "--mode", mode]]
    # envs.json wins over a stale value in the env file.
    assert calls[-1]["url"] == f"https://fixture/{environment_name}/exec"
    assert calls[-1]["sheet"] == f"fixture-{environment_name}-sheet"


@pytest.mark.parametrize("choice,mode", [("1", "sheet-rebuild"), ("2", "sheet-sync")])
def test_launcher_prompts_for_mode_when_not_given(launcher: tuple[Path, Path, dict[str, str]], choice: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "dev"], env=environment, input=f"{choice}\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select mode (1/2):" in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-1] == mode


@pytest.mark.parametrize("arguments", [[], ["unknown"], ["_comment"], ["dev", "rebuild"], ["dev", "sync"], ["dev", "sheet-sync", "extra"]])
def test_launcher_rejects_invalid_arguments_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), *arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "unbound variable" not in completed.stderr
    assert not calls_file.exists()


@pytest.mark.parametrize("mode_input", ["3\n", "\n", ""])
def test_launcher_rejects_invalid_or_missing_mode_choice(launcher: tuple[Path, Path, dict[str, str]], mode_input: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "dev"], env=environment, input=mode_input, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "Invalid choice" in completed.stdout
    assert not calls_file.exists()


def test_launcher_refuses_unconfigured_environment(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    (script.parent / "envs.json").write_text(json.dumps({"dev": {"script_url": "TODO", "spreadsheet_id": "fixture"}}))
    completed = subprocess.run(["/bin/bash", str(script), "dev", "sheet-sync"], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "must be configured" in completed.stdout
    assert not calls_file.exists()


def test_data_sync_menu_lists_module_and_hands_it_the_mode_choice(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    repository = script.parents[3]
    shutil.copyfile(MODULE_ROOT.parents[1] / "Makefile", repository / "Makefile")
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input="1\n1\n2\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "1) ledger-sheet-load" in completed.stdout
    assert "[dev] Running ledger-sheet-load job (sheet-sync)..." in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-4:] == ["--env", "dev", "--mode", "sheet-sync"]


def test_repository_has_no_factory_reset_target_or_bash_scripts() -> None:
    repository = MODULE_ROOT.parents[1]
    makefile = (repository / "Makefile").read_text()
    assert "factory-reset" not in makefile
    assert not (repository / "expense-tracker" / "scripts").exists()
