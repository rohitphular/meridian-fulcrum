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
        return yaml.safe_load(f)


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["FULCRUM_DB_HOST"],
        port=int(os.environ["FULCRUM_DB_PORT"]),
        user=os.environ["FULCRUM_DB_USER"],
        password=os.environ["FULCRUM_DB_PASSWORD"],
        connect_database=os.environ["FULCRUM_DB_NAME"],
    )


def spreadsheet_id() -> str:
    return os.environ["LE_SPREADSHEET_ID"]


def service_account_file() -> str:
    return os.environ["LE_SERVICE_ACCOUNT_FILE"]
