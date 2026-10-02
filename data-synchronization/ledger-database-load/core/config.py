from __future__ import annotations

import os

from py_db_migrate.core.config import ConnectionConfig

# Consumed by py-logging at import time; asserted here so a missing var raises KeyError
# from config at startup rather than producing a silently mis-configured logger.
_MERIDIAN_LOG_ROOT: str = os.environ["MERIDIAN_LOG_ROOT"]


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["FULCRUM_DB_HOST"],
        port=int(os.environ["FULCRUM_DB_PORT"]),
        user=os.environ["FULCRUM_DB_USER"],
        password=os.environ["FULCRUM_DB_PASSWORD"],
        connect_database=os.environ["FULCRUM_DB_NAME"],
    )
