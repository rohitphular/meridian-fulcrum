import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def launcher(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    repository = tmp_path / "repository"
    cicd = repository / "data-synchronization" / "ledger-extract" / "cicd"
    cicd.mkdir(parents=True)
    script = cicd / "start-up.sh"
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", script)
    (cicd / "envs.json").write_text(json.dumps({name: {"spreadsheet_id": f"fixture-{name}-sheet"} for name in ("dev", "prod")}))
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


@pytest.mark.parametrize("extra_arguments", [[], ["--reprocess"]])
def test_launcher_forwards_only_requested_job_arguments(launcher: tuple[Path, Path, dict[str, str]], extra_arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    # /bin/bash is macOS's Bash 3.2; an empty array under nounset fails there.
    completed = subprocess.run(["/bin/bash", str(script), "dev", *extra_arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert [json.loads(line) for line in calls_file.read_text().splitlines()] == [
        ["sync", "--locked", "--quiet"],
        ["run", "--locked", "py-db-migrate", "run", "--db", "postgres"],
        ["run", "--locked", "python", "-m", "core.runner", *extra_arguments],
    ]


@pytest.mark.parametrize("arguments", [[], ["unknown"], ["dev", "--invalid"], ["dev", "--reprocess", "extra"]])
def test_launcher_rejects_invalid_arguments_before_running_commands(launcher: tuple[Path, Path, dict[str, str]], arguments: list[str]) -> None:
    script, calls_file, environment = launcher
    completed = subprocess.run(["/bin/bash", str(script), *arguments], env=environment, capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "unbound variable" not in completed.stderr
    assert not calls_file.exists()


@pytest.fixture
def sync_menu(launcher: tuple[Path, Path, dict[str, str]]) -> tuple[Path, Path, dict[str, str]]:
    script, calls_file, environment = launcher
    repository = script.parents[3]
    shutil.copyfile(MODULE_ROOT.parents[1] / "Makefile", repository / "Makefile")
    currency_cicd = repository / "data-synchronization" / "currency-rates" / "cicd"
    currency_cicd.mkdir(parents=True)
    (currency_cicd / "start-up.sh").write_text('#!/usr/bin/env bash\nprintf "%s\\n" "currency-rates:$*" >> "$LAUNCHER_CALLS_FILE"\n')
    return repository, calls_file, environment


@pytest.mark.parametrize("environment_choice", ["1", "2"])
@pytest.mark.parametrize("mode,extra_arguments", [("1", []), ("2", ["--reprocess"])])
def test_data_sync_menu_passes_flag_only_for_hard_sync(sync_menu: tuple[Path, Path, dict[str, str]], environment_choice: str, mode: str, extra_arguments: list[str]) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input=f"2\n{environment_choice}\n{mode}\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "normal-sync" in completed.stdout and "hard-sync" in completed.stdout
    assert "Select sync mode:" in completed.stdout
    selected_environment = "dev" if environment_choice == "1" else "prod"
    assert f"[{selected_environment}] Running ledger-extract job..." in completed.stdout
    assert json.loads(calls_file.read_text().splitlines()[-1]) == ["run", "--locked", "python", "-m", "core.runner", *extra_arguments]


@pytest.mark.parametrize("mode_input", ["3\n", "\n", ""])
def test_data_sync_menu_rejects_invalid_or_missing_mode_before_startup(sync_menu: tuple[Path, Path, dict[str, str]], mode_input: str) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input=f"2\n1\n{mode_input}", capture_output=True, text=True, timeout=15)
    assert completed.returncode != 0
    assert "Invalid choice" in completed.stdout
    assert not calls_file.exists()


def test_currency_rates_menu_does_not_prompt_for_ledger_sync_mode(sync_menu: tuple[Path, Path, dict[str, str]]) -> None:
    repository, calls_file, environment = sync_menu
    completed = subprocess.run(["make", "data-sync"], cwd=repository, env=environment, input="1\n1\n", capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    assert "Select sync mode:" not in completed.stdout
    assert calls_file.read_text() == "currency-rates:dev\n"
