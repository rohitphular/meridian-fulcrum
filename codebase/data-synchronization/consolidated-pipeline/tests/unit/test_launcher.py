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
_RUN = ["run", "--locked", "python", "-m", "core.runner", "--config"]


def _stages(env: str) -> str:
    return json.dumps({"env": env, "stages": [{"module": "a", "mode": "b"}]})


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    module = tmp_path / "repository" / "codebase" / "data-synchronization" / "consolidated-pipeline"
    for part in ("cicd/start-up.sh", "cicd/read-stage.py", "core/pipeline_config.py"):
        (module / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MODULE_ROOT / part, module / part)
    config = module / "config"
    config.mkdir()
    shutil.copyfile(MODULE_ROOT / "config" / "pipeline.example.json", config / "pipeline.example.json")
    for env in ("dev", "prod"):
        (config / f"pipeline.{env}.json").write_text(_stages(env))
    infrastructure = tmp_path / "repository" / "infrastructure"
    infrastructure.mkdir()
    for name in ("dev", "prod", "uat"):
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


def _run(script: Path, environment: dict[str, str], *arguments: str, stdin: str = "", cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    # /bin/bash is macOS's Bash 3.2.
    return subprocess.run(["/bin/bash", str(script), *arguments], env=environment, input=stdin, cwd=cwd, capture_output=True, text=True, timeout=15)


@pytest.mark.parametrize("choice,env", [("1", "dev"), ("2", "prod")])
def test_launcher_lists_envs_from_the_config_folder_and_runs_the_chosen_one(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path, choice: str, env: str) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, stdin=f"{choice}\n")
    assert completed.returncode == 0, completed.stderr
    menu = completed.stdout.split("Select environment")[0]
    assert "1) dev" in menu and "2) prod" in menu and "example" not in menu
    calls = _calls(calls_file)
    assert calls[-1]["argv"] == [*_RUN, str(script.parents[1] / "config" / f"pipeline.{env}.json")]
    assert calls[-1]["log_root"] == str(tmp_path / "logs" / "consolidated-pipeline")
    assert f"[{env}] Running pipeline" in completed.stdout


def test_a_new_config_file_adds_an_env_to_the_menu(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    (script.parents[1] / "config" / "pipeline.uat.json").write_text(_stages("uat"))
    completed = _run(script, environment, stdin="3\n")
    assert completed.returncode == 0, completed.stderr
    assert "3) uat" in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-1].endswith("config/pipeline.uat.json")


def test_env_flag_skips_the_menu(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, "--env", "prod")
    assert completed.returncode == 0, completed.stderr
    assert "Select environment" not in completed.stdout
    assert _calls(calls_file)[-1]["argv"][-1].endswith("config/pipeline.prod.json")


def test_relative_config_paths_resolve_from_the_callers_directory(launcher: tuple[Path, Path, dict[str, str]], tmp_path: Path) -> None:
    script, calls_file, environment = launcher
    (tmp_path / "pipeline.dev.json").write_text(_stages("dev"))
    completed = _run(script, environment, "--config", "pipeline.dev.json", cwd=tmp_path)
    assert completed.returncode == 0, completed.stderr
    assert _calls(calls_file)[-1]["argv"][-1] == str((tmp_path / "pipeline.dev.json").resolve())


@pytest.mark.parametrize(
    "arguments,stdin,message",
    [
        ([], "3\n", "Invalid choice '3'"),
        ([], "", "Invalid choice ''"),
        ([], "dev\n", "Invalid choice 'dev'"),
        (["--env", "qa"], "", "config_not_found"),
        (["--env", "../dev"], "", "config_file_name_must_be"),
        (["--config", "/nonexistent/pipeline.dev.json"], "", "config_not_found"),
        (["--env", "dev", "--config", "x"], "", "Usage"),
        (["--interactive"], "", "Usage"),
        (["--env"], "", "Usage"),
    ],
)
def test_launcher_rejects_bad_choices_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str], stdin: str, message: str) -> None:
    script, calls_file, environment = launcher
    completed = _run(script, environment, *arguments, stdin=stdin)
    assert completed.returncode != 0
    assert message in completed.stdout + completed.stderr
    assert not calls_file.exists()


def test_an_empty_config_folder_says_how_to_start(launcher: tuple[Path, Path, dict[str, str]]) -> None:
    script, calls_file, environment = launcher
    for env in ("dev", "prod"):
        (script.parents[1] / "config" / f"pipeline.{env}.json").unlink()
    completed = _run(script, environment)
    assert completed.returncode != 0
    assert "copy config/pipeline.example.json" in completed.stdout
    assert not calls_file.exists()


def test_env_configs_are_gitignored_and_the_template_is_tracked_and_valid() -> None:
    repository = MODULE_ROOT.parents[2]
    for name in ("pipeline.dev.json", "pipeline.prod.json", "pipeline.uat.json"):
        assert subprocess.run(["git", "check-ignore", "-q", f"codebase/data-synchronization/consolidated-pipeline/config/{name}"], cwd=repository).returncode == 0
    assert subprocess.run(["git", "check-ignore", "-q", "codebase/data-synchronization/consolidated-pipeline/config/pipeline.example.json"], cwd=repository).returncode == 1
    template = json.loads((MODULE_ROOT / "config" / "pipeline.example.json").read_text())
    from core.pipeline_config import parse

    assert parse(template).stages
