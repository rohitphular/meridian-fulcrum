import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]
_FAKE_UV = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["LAUNCHER_CALLS_FILE"], "a") as calls:
    calls.write(json.dumps({"argv": sys.argv[1:], "log_root": os.environ["MERIDIAN_LOG_ROOT"]}) + "\\n")
"""


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    module = tmp_path / "repository" / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/start-up.sh", "cicd/read-stage.py", "core/pipeline_config.py"):
        (module / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MODULE_ROOT / part, module / part)
    (module / "pipeline.json").write_text(json.dumps({"env": "prod", "stages": [{"module": "a", "mode": "b"}]}))
    infrastructure = tmp_path / "repository" / "infrastructure"
    infrastructure.mkdir()
    for name in ("dev", "prod"):
        (infrastructure / f".env.{name}").write_text(f"MERIDIAN_LOG_ROOT={tmp_path / 'logs'}\n")
    binary_directory = tmp_path / "bin"
    binary_directory.mkdir()
    calls_file = tmp_path / "uv-calls.jsonl"
    fake_uv = binary_directory / "uv"
    fake_uv.write_text(_FAKE_UV)
    fake_uv.chmod(0o755)
    environment = {**os.environ, "PATH": f"{binary_directory}:{os.environ['PATH']}", "LAUNCHER_CALLS_FILE": str(calls_file)}
    return module / "cicd" / "start-up.sh", calls_file, environment


def _calls(calls_file: Path) -> list[dict]:
    return [json.loads(line) for line in calls_file.read_text().splitlines()]


def test_launcher_runs_the_default_config_with_its_env_log_root(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script)], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    calls = _calls(calls_file)
    assert calls[-1]["argv"] == ["run", "--locked", "python", "-m", "core.runner", "--config", str(script.parents[1] / "pipeline.json")]
    assert calls[-1]["log_root"] == str(tmp_path / "logs" / "consolidated-pipeline")


def test_relative_config_paths_resolve_from_the_callers_directory(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    (tmp_path / "nightly.json").write_text(json.dumps({"env": "dev", "stages": [{"module": "a", "mode": "b"}]}))
    completed = subprocess.run(["/bin/bash", str(script), "--config", "nightly.json"], cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert _calls(calls_file)[-1]["argv"][-1] == str((tmp_path / "nightly.json").resolve())
    assert "[dev] Running pipeline" in completed.stdout


@pytest.mark.parametrize("arguments,message", [(["--config", "/nonexistent.json"], "config_not_found"), (["--interactive"], "Usage"), (["--config"], "Usage")])
def test_launcher_rejects_bad_arguments_or_config_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str], message: str) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), *arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert message in completed.stdout + completed.stderr
    assert not calls_file.exists()


def test_pipeline_config_is_gitignored_and_example_is_valid() -> None:
    repository = MODULE_ROOT.parents[1]
    ignored = subprocess.run(["git", "check-ignore", "-q", "data-synchronization/consolidated-pipeline/pipeline.json"], cwd=repository)
    assert ignored.returncode == 0
    example = subprocess.run(["python3", str(MODULE_ROOT / "cicd" / "read-stage.py"), str(MODULE_ROOT / "pipeline.example.json"), "ledger-sheet-load"], capture_output=True, text=True)
    assert example.returncode == 0, example.stderr
