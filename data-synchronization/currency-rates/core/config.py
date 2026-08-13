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


def source_enabled(source: str) -> bool:
    cfg = load_config()
    return bool(cfg.get("sources", {}).get(source, {}).get("enabled", False))


def historical_csv_dir() -> str:
    return os.environ["CR_HISTORICAL_CSV_DIR"]


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["CR_DB_HOST"],
        port=int(os.environ.get("CR_DB_PORT", "5432")),
        user=os.environ["CR_DB_USER"],
        password=os.environ["CR_DB_PASSWORD"],
        connect_database=os.environ["CR_DB_NAME"],
    )
