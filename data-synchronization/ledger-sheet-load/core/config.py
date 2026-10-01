from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

_MODULE_ROOT = Path(__file__).parent.parent
_REPOSITORY_ROOT = _MODULE_ROOT.parent.parent
_CONFIG_PATH = _MODULE_ROOT / "config.yaml"

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]


def load_config() -> dict[str, Any]:
    with open(_CONFIG_PATH) as f:
        settings = yaml.safe_load(f)
    if not isinstance(settings, dict):
        raise ValueError("invalid_config_mapping")
    return settings


def data_dir(settings: dict[str, Any]) -> Path:
    override = os.environ.get("LSL_DATA_DIR", "")
    return Path(override) if override else _REPOSITORY_ROOT / settings["data_dir"]


def script_url() -> str:
    return os.environ["LSL_SCRIPT_URL"]


def spreadsheet_id() -> str:
    return os.environ["LSL_SPREADSHEET_ID"]
