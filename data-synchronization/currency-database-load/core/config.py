from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

import yaml
from py_db_migrate.core.config import ConnectionConfig

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


def _required_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value.strip():
        raise ValueError(f"missing_environment_variable:{name}")
    return value


# py-logging consumes this before a job starts. Reject blank values too.
_MERIDIAN_LOG_ROOT: str = _required_env("MERIDIAN_LOG_ROOT")


def load_config() -> dict[str, Any]:
    with open(_CONFIG_PATH) as f:
        settings = yaml.safe_load(f)
    if not isinstance(settings, dict):
        raise ValueError("invalid_config_mapping")
    return settings


def source_enabled(source: str) -> bool:
    cfg = load_config()
    try:
        enabled = cfg["sources"][source]["enabled"]
    except (KeyError, TypeError) as error:
        raise ValueError("missing_source_configuration") from error
    if not isinstance(enabled, bool):
        raise ValueError("source_enabled_must_be_boolean")
    return enabled


def historical_csv_dir() -> Path:
    directory = Path(_required_env("CDL_HISTORICAL_CSV_DIR")).expanduser()
    if not directory.is_absolute() or not directory.is_dir():
        raise ValueError("historical_csv_directory_missing_or_not_absolute")
    return directory


def db_config() -> ConnectionConfig:
    try:
        port = int(os.environ.get("FULCRUM_DB_PORT", "5432"))
    except ValueError as error:
        raise ValueError("invalid_database_port") from error
    if not 1 <= port <= 65535:
        raise ValueError("invalid_database_port")
    return ConnectionConfig(
        host=_required_env("FULCRUM_DB_HOST"),
        port=port,
        user=_required_env("FULCRUM_DB_USER"),
        password=_required_env("FULCRUM_DB_PASSWORD"),
        connect_database=_required_env("FULCRUM_DB_NAME"),
    )


def validate_runtime(mode: str) -> None:
    """Offline startup checks, run before migrations touch the selected database."""
    if mode not in {"daily", "historical"}:
        raise ValueError("invalid_mode")
    db_config()
    source_enabled("yfinance")
    if mode == "historical":
        historical_csv_dir()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validate job configuration before database migrations")
    parser.add_argument("mode", choices=("daily", "historical"))
    arguments = parser.parse_args()
    try:
        validate_runtime(arguments.mode)
    except (ValueError, OSError, yaml.YAMLError) as error:
        # Only validation codes/path-free parser type; never print credentials.
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        parser.error(f"{reason}; check config.yaml and infrastructure/.env.<environment>")
