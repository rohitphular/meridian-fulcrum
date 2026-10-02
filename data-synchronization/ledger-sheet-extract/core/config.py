from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from py_db_migrate.core.config import ConnectionConfig

_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"
# Masters every config must list explicitly (enabled or not); other tabs are opt-in.
_REQUIRED_TABS = ("category_master", "account_master", "transaction_master", "subscription_master")

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]


def load_config() -> dict[str, Any]:
    with open(_CONFIG_PATH) as f:
        settings = yaml.safe_load(f)
    if not isinstance(settings, dict):
        raise ValueError("invalid_config_mapping")
    return settings


def enabled_tabs(settings: dict[str, Any]) -> list[str]:
    """The tabs to stage, in config order. Rejects misspelled switches instead of skipping data.

    A misspelled tab name fails as a missing tab when it is read; ledger-database-load
    rejects any staged tab it has no contract for.
    """
    entities = settings.get("entities") if isinstance(settings, dict) else None
    if not isinstance(entities, dict):
        raise ValueError("invalid_entities_configuration")
    for name in _REQUIRED_TABS:
        if name not in entities:
            raise ValueError(f"missing_entity_configuration:{name}")
    tabs = []
    for name, value in entities.items():
        if not isinstance(value, dict) or set(value) != {"enabled"}:
            raise ValueError(f"invalid_entity_configuration:{name}")
        if not isinstance(value["enabled"], bool):
            raise ValueError(f"entity_enabled_must_be_boolean:{name}")
        if value["enabled"]:
            tabs.append(name)
    return tabs


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["FULCRUM_DB_HOST"],
        port=int(os.environ["FULCRUM_DB_PORT"]),
        user=os.environ["FULCRUM_DB_USER"],
        password=os.environ["FULCRUM_DB_PASSWORD"],
        connect_database=os.environ["FULCRUM_DB_NAME"],
    )


def spreadsheet_id() -> str:
    return os.environ["LSE_SPREADSHEET_ID"]


def service_account_file() -> str:
    return os.environ["LSE_SERVICE_ACCOUNT_FILE"]
