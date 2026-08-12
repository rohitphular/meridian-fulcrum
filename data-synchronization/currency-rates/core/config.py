from __future__ import annotations

import os
from pathlib import Path

import yaml

from py_db_migrate.core.config import ConnectionConfig

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


def load_config() -> dict:
    with open(_CONFIG_PATH) as f:
        return yaml.safe_load(f)


def source_enabled(source: str) -> bool:
    cfg = load_config()
    return bool(cfg.get("sources", {}).get(source, {}).get("enabled", False))


def start_date() -> date:
    from datetime import date as _date
    cfg = load_config()
    return _date.fromisoformat(cfg["job"]["start_date"])


def historical_csv_dir() -> str:
    path = os.environ.get("CR_HISTORICAL_CSV_DIR", "")
    if not path:
        raise EnvironmentError("CR_HISTORICAL_CSV_DIR is not set")
    return path


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["CR_DB_HOST"],
        port=int(os.environ.get("CR_DB_PORT", "5432")),
        user=os.environ["CR_DB_USER"],
        password=os.environ["CR_DB_PASSWORD"],
        connect_database=os.environ["CR_DB_NAME"],
    )


