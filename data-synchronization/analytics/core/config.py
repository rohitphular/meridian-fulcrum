from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml
from py_db_migrate.core.config import ConnectionConfig

MODULE_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_DIR = MODULE_ROOT / "contract"
_CONFIG_PATH = MODULE_ROOT / "config.yaml"

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]


def load_config() -> dict[str, Any]:
    with open(_CONFIG_PATH) as f:
        settings = yaml.safe_load(f)
    if not isinstance(settings, dict):
        raise ValueError("invalid_config_mapping")
    return settings


def keep_generations(settings: dict[str, Any]) -> int:
    value = settings.get("keep_generations")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("invalid_keep_generations")
    return value


def contract(name: str) -> dict[str, Any]:
    """A contract file (report-definition, predefined-reports, sheet-tabs) as JSON."""
    return json.loads((CONTRACT_DIR / f"{name}.json").read_text())


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["FULCRUM_DB_HOST"],
        port=int(os.environ["FULCRUM_DB_PORT"]),
        user=os.environ["FULCRUM_DB_USER"],
        password=os.environ["FULCRUM_DB_PASSWORD"],
        connect_database=os.environ["FULCRUM_DB_NAME"],
    )


def spreadsheet_id() -> str:
    return os.environ["ANA_SPREADSHEET_ID"]


def service_account_file() -> str:
    value = os.environ.get("ANA_SERVICE_ACCOUNT_FILE", "")
    if not value.strip():
        raise ValueError("missing_environment_variable:ANA_SERVICE_ACCOUNT_FILE")
    return value
