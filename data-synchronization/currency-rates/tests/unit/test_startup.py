from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]


def test_invalid_mode_and_extra_arguments_never_reach_environment_or_migrations() -> None:
    for arguments in [["dev", "invalid"], ["dev", "daily", "unexpected"]]:
        result = subprocess.run(["/bin/bash", str(MODULE_ROOT / "cicd" / "start-up.sh"), *arguments], capture_output=True, text=True, check=False)
        assert result.returncode == 1
        assert "Loading env vars" not in result.stdout
        assert "Running migrations" not in result.stdout


def test_configuration_preflight_failure_stops_before_migrations(tmp_path: Path) -> None:
    module = tmp_path / "repo" / "data-synchronization" / "currency-rates"
    scripts = module / "cicd"
    scripts.mkdir(parents=True)
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", scripts / "start-up.sh")
    (scripts / "envs.json").write_text('{"dev":{}}')
    infrastructure = tmp_path / "repo" / "infrastructure"
    infrastructure.mkdir()
    (infrastructure / ".env.dev").write_text("MERIDIAN_LOG_ROOT=/tmp/currency-startup-test\n")
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    capture = tmp_path / "commands"
    fake_uv = binary_dir / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CURRENCY_TEST_COMMANDS"\ncase "$*" in *core.config*) exit 2;; esac\n')
    fake_uv.chmod(0o700)
    environment = {**os.environ, "PATH": f"{binary_dir}:/usr/bin:/bin", "CURRENCY_TEST_COMMANDS": str(capture)}
    result = subprocess.run(["/bin/bash", str(scripts / "start-up.sh"), "dev", "historical"], capture_output=True, text=True, env=environment, check=False)
    assert result.returncode == 2
    assert capture.read_text().splitlines() == ["sync --locked --quiet", "run --locked python -m core.config historical"]
    assert "Running migrations" not in result.stdout


@pytest.mark.parametrize(("configured_port", "expected_port"), [(None, "5432"), ("6543", "6543")])
def test_startup_exports_the_same_database_port_to_preflight_migrations_and_job(tmp_path: Path, configured_port: str | None, expected_port: str) -> None:
    module = tmp_path / "repo" / "data-synchronization" / "currency-rates"
    scripts = module / "cicd"
    scripts.mkdir(parents=True)
    shutil.copyfile(MODULE_ROOT / "cicd" / "start-up.sh", scripts / "start-up.sh")
    (scripts / "envs.json").write_text('{"dev":{}}')
    infrastructure = tmp_path / "repo" / "infrastructure"
    infrastructure.mkdir()
    (infrastructure / ".env.dev").write_text("" if configured_port is None else f"FULCRUM_DB_PORT={configured_port}\n")
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    capture = tmp_path / "commands"
    fake_uv = binary_dir / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf "%s|%s\\n" "$*" "${FULCRUM_DB_PORT-unset}" >> "$CURRENCY_TEST_COMMANDS"\n')
    fake_uv.chmod(0o700)
    environment = {key: value for key, value in os.environ.items() if key != "FULCRUM_DB_PORT"}
    environment.update(PATH=f"{binary_dir}:/usr/bin:/bin", CURRENCY_TEST_COMMANDS=str(capture))
    result = subprocess.run(["/bin/bash", str(scripts / "start-up.sh"), "dev", "daily"], capture_output=True, text=True, env=environment, check=False)
    assert result.returncode == 0
    assert capture.read_text().splitlines() == [
        f"sync --locked --quiet|{expected_port}",
        f"run --locked python -m core.config daily|{expected_port}",
        f"run --locked py-db-migrate run --db postgres|{expected_port}",
        f"run --locked python -m core.runner|{expected_port}",
    ]
