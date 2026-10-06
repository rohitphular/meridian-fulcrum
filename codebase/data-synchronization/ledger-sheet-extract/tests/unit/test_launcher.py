import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_ROOT = MODULE_ROOT.parent / "consolidated-pipeline"


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    repository = tmp_path / "repository"
    cicd = repository / "codebase" / "data-synchronization" / "ledger-sheet-extract" / "cicd"
    cicd.mkdir(parents=True)
    script = cicd / "start-up.sh"
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", script)
    shutil.copyfile(MODULE_ROOT / "cicd" / "check.sh", cicd / "check.sh")
    (cicd / "envs.json").write_text(json.dumps({name: {"spreadsheet_id": f"fixture-{name}-sheet"} for name in ("dev", "prod")}))
    pipeline = repository / "codebase" / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/read-stage.py", "core/pipeline_config.py"):
        (pipeline / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PIPELINE_ROOT / part, pipeline / part)
    (pipeline / "config").mkdir()
    (pipeline / "config" / "pipeline.prod.json").write_text(json.dumps({"env": "prod", "stages": [{"module": "ledger-sheet-extract", "mode": "acknowledge"}]}))
    infrastructure = repository / "infrastructure"
    infrastructure.mkdir()
    for name in ("dev", "prod"):
        (infrastructure / f".env.{name}").write_text("# Isolated test environment; no credentials.\n")
    binary_directory = tmp_path / "bin"
    binary_directory.mkdir()
    calls_file = tmp_path / "uv-calls.jsonl"
    fake_uv = binary_directory / "uv"
    fake_uv.write_text("#!/usr/bin/env python3\nimport json, os, sys\nwith open(os.environ['LAUNCHER_CALLS_FILE'], 'a') as calls:\n    calls.write(json.dumps(sys.argv[1:]) + '\\n')\n")
    fake_uv.chmod(0o755)
    environment = {**os.environ, "PATH": f"{binary_directory}:{os.environ['PATH']}", "LAUNCHER_CALLS_FILE": str(calls_file)}
    return script, calls_file, environment


def _config(script: Path) -> Path:
    return script.parents[2] / "consolidated-pipeline" / "config" / "pipeline.prod.json"


_MIGRATE_CALLS = [["sync", "--locked", "--quiet"], ["run", "--locked", "py-db-migrate", "run", "--db", "postgres"]]


@pytest.mark.parametrize("mode", ["extract", "acknowledge"])
def test_launcher_runs_staging_migrations_then_the_mode(launcher: tuple[Path, Path, dict[str, str]], mode: str) -> None:
    script, calls_file, environment = launcher
    # /bin/bash is macOS's Bash 3.2; an empty array under nounset fails there.
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev", mode], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select mode" not in completed.stdout
    assert [json.loads(line) for line in calls_file.read_text().splitlines()] == [*_MIGRATE_CALLS, ["run", "--locked", "python", "-m", "core.runner", "--mode", mode]]


@pytest.mark.parametrize("choice,mode", [("1", "extract"), ("2", "acknowledge")])
def test_launcher_prompts_for_mode_when_not_given(launcher: tuple[Path, Path, dict[str, str]], choice: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev"], env=environment, input=f"{choice}\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "extract" in completed.stdout and "acknowledge" in completed.stdout
    assert json.loads(calls_file.read_text().splitlines()[-1]) == ["run", "--locked", "python", "-m", "core.runner", "--mode", mode]


@pytest.mark.parametrize(
    "arguments",
    [
        ["--interactive"],
        ["--interactive", "unknown"],
        ["--interactive", "dev", "--invalid"],
        ["--interactive", "dev", "--reprocess"],
        ["--interactive", "dev", "normal-sync"],
        ["--interactive", "dev", "extract", "extra"],
        ["--interactive", "dev", "extract", "--stage", "1"],
        ["--sign-in-only"],
        ["--check"],
        ["dev", "extract"],
    ],
)
def test_launcher_rejects_invalid_arguments_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), *arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "unbound variable" not in completed.stderr
    assert not calls_file.exists()


@pytest.mark.parametrize("mode_input", ["3\n", "\n", ""])
def test_launcher_rejects_invalid_or_missing_mode_choice(launcher: tuple[Path, Path, dict[str, str]], mode_input: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev"], env=environment, input=mode_input, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "Invalid choice" in completed.stdout
    assert not calls_file.exists()


def test_launcher_logs_under_the_module_folder_and_requires_a_log_root(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    fake_uv = Path(environment["PATH"].split(":")[0]) / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf \'%s\\n\' "$MERIDIAN_LOG_ROOT" >> "$LAUNCHER_CALLS_FILE"\n')
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev", "extract"], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert set(calls_file.read_text().splitlines()) == {f"{environment['MERIDIAN_LOG_ROOT']}/ledger-sheet-extract"}
    calls_file.unlink()
    unset = {key: value for key, value in environment.items() if key != "MERIDIAN_LOG_ROOT"}
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev", "extract"], env=unset, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0 and "MERIDIAN_LOG_ROOT must be set" in completed.stderr
    assert not calls_file.exists()


def test_default_reads_env_and_mode_from_the_pipeline_config(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "--config", str(_config(script))], env=environment, capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
    assert completed.returncode == 0, completed.stderr
    assert "[prod] Running ledger-sheet-extract job (acknowledge)..." in completed.stdout
    assert json.loads(calls_file.read_text().splitlines()[-1]) == ["run", "--locked", "python", "-m", "core.runner", "--mode", "acknowledge"]


def test_check_validates_the_stage_without_running_anything(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script.parent / "check.sh"), "--config", str(_config(script)), "--stage", "1"], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Check passed: ledger-sheet-extract acknowledge" in completed.stdout
    assert "credentials=" not in completed.stdout
    assert not calls_file.exists()


def test_unattended_rejects_a_config_mode_the_module_does_not_have(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    _config(script).write_text(json.dumps({"env": "prod", "stages": [{"module": "ledger-sheet-extract", "mode": "daily"}]}))
    completed = subprocess.run(["/bin/bash", str(script.parent / "check.sh"), "--config", str(_config(script))], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "mode must be extract or acknowledge" in completed.stdout
    assert not calls_file.exists()


@pytest.fixture
def sync_menu(launcher: tuple[Path, Path, dict[str, str]]) -> tuple[Path, Path, dict[str, str]]:
    script, calls_file, environment = launcher
    repository = script.parents[4]
    shutil.copyfile(MODULE_ROOT.parents[2] / "Makefile", repository / "Makefile")
    # The root Makefile's shared env picker and the env list it reads.
    shutil.copyfile(MODULE_ROOT.parents[2] / "infrastructure" / "select-env.sh", repository / "infrastructure" / "select-env.sh")
    (repository / "infrastructure" / "envs.json").write_text(json.dumps({"dev": {}, "prod": {}}))
    currency_cicd = repository / "codebase" / "data-synchronization" / "forex-database-load" / "cicd"
    currency_cicd.mkdir(parents=True)
    (currency_cicd / "start-up.sh").write_text('#!/usr/bin/env bash\nprintf "%s\\n" "forex-database-load:$*" >> "$LAUNCHER_CALLS_FILE"\n')
    return repository, calls_file, environment


@pytest.mark.parametrize("environment_choice", ["1", "2"])
@pytest.mark.parametrize("mode,selected_mode", [("1", "extract"), ("2", "acknowledge")])
def test_data_sync_menu_hands_mode_choice_to_module(sync_menu: tuple[Path, Path, dict[str, str]], environment_choice: str, mode: str, selected_mode: str) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input=f"2\n{environment_choice}\n{mode}\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select mode" in completed.stdout
    selected_environment = "dev" if environment_choice == "1" else "prod"
    assert f"[{selected_environment}] Running ledger-sheet-extract job ({selected_mode})..." in completed.stdout
    assert json.loads(calls_file.read_text().splitlines()[-1]) == ["run", "--locked", "python", "-m", "core.runner", "--mode", selected_mode]


@pytest.mark.parametrize("mode_input", ["3\n", "\n", ""])
def test_data_sync_menu_stops_on_invalid_mode_before_job_commands(sync_menu: tuple[Path, Path, dict[str, str]], mode_input: str) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input=f"2\n1\n{mode_input}", capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "Invalid choice" in completed.stdout
    assert not calls_file.exists()


def test_currency_menu_does_not_prompt_for_the_extract_mode(sync_menu: tuple[Path, Path, dict[str, str]]) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input="1\n1\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select mode" not in completed.stdout
    assert calls_file.read_text() == "forex-database-load:--interactive dev\n"


def test_the_selected_spreadsheet_is_exported_to_the_job(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    fake_uv = Path(environment["PATH"].split(":")[0]) / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf \'%s\\n\' "$LSE_SPREADSHEET_ID" >> "$LAUNCHER_CALLS_FILE"\n')
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "prod", "extract"], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert set(calls_file.read_text().splitlines()) == {"fixture-prod-sheet"}
