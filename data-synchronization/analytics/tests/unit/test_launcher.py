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
    cicd = repository / "data-synchronization" / "analytics" / "cicd"
    cicd.mkdir(parents=True)
    script = cicd / "start-up.sh"
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", script)
    shutil.copyfile(MODULE_ROOT / "cicd" / "check.sh", cicd / "check.sh")
    (cicd / "envs.json").write_text(json.dumps({name: {"spreadsheet_id": f"fixture-{name}-sheet"} for name in ("dev", "prod")}))
    pipeline = repository / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/read-stage.py", "core/pipeline_config.py"):
        (pipeline / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PIPELINE_ROOT / part, pipeline / part)
    (pipeline / "config").mkdir()
    (pipeline / "config" / "pipeline.prod.json").write_text(json.dumps({"env": "prod", "stages": [{"module": "analytics", "mode": "build"}]}))
    infrastructure = repository / "infrastructure"
    infrastructure.mkdir()
    for name in ("dev", "prod"):
        (infrastructure / f".env.{name}").write_text("ANA_SERVICE_ACCOUNT_FILE=/keys/sa.json\nMERIDIAN_FULCRUM_PIN=1234\nMERIDIAN_FULCRUM_SECRET=ABC\n")
    binary_directory = tmp_path / "bin"
    binary_directory.mkdir()
    calls_file = tmp_path / "uv-calls.jsonl"
    fake_uv = binary_directory / "uv"
    fake_uv.write_text("#!/usr/bin/env python3\nimport json, os, sys\nwith open(os.environ['LAUNCHER_CALLS_FILE'], 'a') as calls:\n    calls.write(json.dumps(sys.argv[1:]) + '\\n')\n")
    fake_uv.chmod(0o755)
    environment = {**os.environ, "PATH": f"{binary_directory}:{os.environ['PATH']}", "LAUNCHER_CALLS_FILE": str(calls_file), "MERIDIAN_LOG_ROOT": str(tmp_path / "logs")}
    return script, calls_file, environment


def _config(script: Path) -> Path:
    return script.parents[2] / "consolidated-pipeline" / "config" / "pipeline.prod.json"


_MIGRATE_CALLS = [["sync", "--locked", "--quiet"], ["run", "--locked", "py-db-migrate", "run", "--db", "postgres"]]


@pytest.mark.parametrize("mode", ["refresh", "build", "publish", "check"])
def test_launcher_runs_migrations_then_the_mode(launcher: tuple[Path, Path, dict[str, str]], mode: str) -> None:
    script, calls_file, environment = launcher
    # /bin/bash is macOS's Bash 3.2; an empty array under nounset fails there.
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev", mode], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert [json.loads(line) for line in calls_file.read_text().splitlines()] == [*_MIGRATE_CALLS, ["run", "--locked", "python", "-m", "core.runner", "--mode", mode]]


@pytest.mark.parametrize("choice,mode", [("1", "refresh"), ("2", "build"), ("3", "publish"), ("4", "check")])
def test_launcher_prompts_for_mode_when_not_given(launcher: tuple[Path, Path, dict[str, str]], choice: str, mode: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "dev"], env=environment, input=f"{choice}\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert json.loads(calls_file.read_text().splitlines()[-1]) == ["run", "--locked", "python", "-m", "core.runner", "--mode", mode]


@pytest.mark.parametrize(
    "arguments",
    [
        ["--interactive"],
        ["--interactive", "unknown"],
        ["--interactive", "dev", "extract"],
        ["--interactive", "dev", "build", "extra"],
        ["--interactive", "dev", "build", "--stage", "1"],
        ["dev", "build"],
    ],
)
def test_launcher_rejects_invalid_arguments_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), *arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "unbound variable" not in completed.stderr
    assert not calls_file.exists()


@pytest.mark.parametrize("mode,needs_key", [("refresh", True), ("publish", True), ("build", False), ("check", False)])
def test_publishing_modes_need_the_service_account_key(launcher: tuple[Path, Path, dict[str, str]], mode: str, needs_key: bool) -> None:
    script, calls_file, environment = launcher
    (script.parents[3] / "infrastructure" / ".env.dev").write_text("# no key\n")
    completed = subprocess.run(["/bin/bash", str(script.parent / "check.sh"), "--interactive", "dev", mode], env=environment, capture_output=True, text=True, timeout=15)
    assert (completed.returncode != 0) is needs_key
    assert ("ANA_SERVICE_ACCOUNT_FILE is not set" in completed.stdout) is needs_key


def test_the_job_gets_its_log_folder_and_spreadsheet_but_never_the_pin(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    fake_uv = Path(environment["PATH"].split(":")[0]) / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf \'%s|%s|%s\\n\' "$MERIDIAN_LOG_ROOT" "$ANA_SPREADSHEET_ID" "${MERIDIAN_FULCRUM_PIN:-none}" >> "$LAUNCHER_CALLS_FILE"\n')
    completed = subprocess.run(["/bin/bash", str(script), "--interactive", "prod", "build"], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert set(calls_file.read_text().splitlines()) == {f"{environment['MERIDIAN_LOG_ROOT']}/analytics|fixture-prod-sheet|none"}


def test_default_reads_env_and_mode_from_the_pipeline_config_and_check_runs_nothing(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    checked = subprocess.run(["/bin/bash", str(script.parent / "check.sh"), "--config", str(_config(script)), "--stage", "1"], env=environment, capture_output=True, text=True, timeout=15)
    assert checked.returncode == 0, checked.stderr
    assert "Check passed: analytics build" in checked.stdout and "credentials=" not in checked.stdout
    assert not calls_file.exists()
    completed = subprocess.run(["/bin/bash", str(script), "--config", str(_config(script))], env=environment, capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
    assert completed.returncode == 0, completed.stderr
    assert "[prod] Running analytics job (build)..." in completed.stdout
