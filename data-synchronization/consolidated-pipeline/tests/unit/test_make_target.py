import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = MODULE_ROOT.parents[1]
_RECORDER = 'printf "%s\\n" "{name}:$*" >> "$CALLS_FILE"\n'


@pytest.fixture
def repository(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """A copy of the root Makefile and env picker, with stand-ins for infra-up and the pipeline."""
    repository = tmp_path / "repository"
    infrastructure = repository / "infrastructure"
    infrastructure.mkdir(parents=True)
    shutil.copyfile(REPOSITORY_ROOT / "Makefile", repository / "Makefile")
    shutil.copyfile(REPOSITORY_ROOT / "infrastructure" / "select-env.sh", infrastructure / "select-env.sh")
    (infrastructure / "envs.json").write_text(json.dumps({"_comment": "fixture", "dev": {}, "prod": {}}))
    (infrastructure / "start-services.sh").write_text(_RECORDER.format(name="infra-up"))
    pipeline = repository / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/read-stage.py", "core/pipeline_config.py"):
        (pipeline / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MODULE_ROOT / part, pipeline / part)
    (pipeline / "cicd" / "start-up.sh").write_text(_RECORDER.format(name="pipeline"))
    calls = tmp_path / "calls.txt"
    environment = {key: value for key, value in os.environ.items() if key not in ("ENV", "MAKEFLAGS", "MAKELEVEL")}
    environment["CALLS_FILE"] = str(calls)
    return repository, calls, environment


def _make(repository: Path, environment: dict[str, str], *arguments: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(["make", "consolidated-pipeline", *arguments], cwd=repository, env=environment, input=stdin, capture_output=True, text=True, timeout=30)


@pytest.mark.parametrize("choice,env", [("1", "dev"), ("2", "prod")])
def test_one_env_question_starts_infra_then_runs_the_pipeline(repository: tuple[Path, Path, dict[str, str]], choice: str, env: str) -> None:
    root, calls, environment = repository
    completed = _make(root, environment, stdin=f"{choice}\n")
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr.count("Select environment") == 1
    assert calls.read_text().splitlines() == [f"infra-up:{env}", f"pipeline:--env {env}"]


def test_env_variable_skips_the_question(repository: tuple[Path, Path, dict[str, str]]) -> None:
    root, calls, environment = repository
    completed = _make(root, environment, "ENV=prod")
    assert completed.returncode == 0, completed.stderr
    assert "Select environment" not in completed.stderr
    assert calls.read_text().splitlines() == ["infra-up:prod", "pipeline:--env prod"]


def test_config_path_supplies_the_env(repository: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    root, calls, environment = repository
    config = tmp_path / "pipeline.prod.json"
    config.write_text(json.dumps({"env": "prod", "stages": [{"module": "a", "mode": "b"}]}))
    completed = _make(root, environment, f"CONFIG={config}")
    assert completed.returncode == 0, completed.stderr
    assert calls.read_text().splitlines() == ["infra-up:prod", f"pipeline:--config {config}"]


@pytest.mark.parametrize("arguments,stdin", [(["ENV=qa"], ""), ([], "7\n"), ([], "")])
def test_unknown_env_or_bad_choice_runs_nothing(repository: tuple[Path, Path, dict[str, str]], arguments: list[str], stdin: str) -> None:
    root, calls, environment = repository
    completed = _make(root, environment, *arguments, stdin=stdin)
    assert completed.returncode != 0
    assert not calls.exists()


def test_a_failed_infra_up_stops_before_the_pipeline(repository: tuple[Path, Path, dict[str, str]]) -> None:
    root, calls, environment = repository
    (root / "infrastructure" / "start-services.sh").write_text(_RECORDER.format(name="infra-up") + "exit 1\n")
    completed = _make(root, environment, "ENV=dev")
    assert completed.returncode != 0
    assert calls.read_text().splitlines() == ["infra-up:dev"]
