from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from py_db_migrate.core.config import ConnectionConfig

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]


def load_config() -> dict[str, Any]:
    with open(_CONFIG_PATH) as f:
        settings = yaml.safe_load(f)
    if not isinstance(settings, dict):
        raise ValueError("invalid_config_mapping")
    return settings


def source_enabled(source: str) -> bool:
    cfg = load_config()
    enabled = cfg["sources"][source]["enabled"]
    if not isinstance(enabled, bool):
        raise ValueError("source_enabled_must_be_boolean")
    return enabled


def historical_csv_dir() -> str:
    return os.environ["CR_HISTORICAL_CSV_DIR"]


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["FULCRUM_DB_HOST"],
        port=int(os.environ.get("FULCRUM_DB_PORT", "5432")),
        user=os.environ["FULCRUM_DB_USER"],
        password=os.environ["FULCRUM_DB_PASSWORD"],
        connect_database=os.environ["FULCRUM_DB_NAME"],
    )
