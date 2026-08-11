from __future__ import annotations

import os

from py_db_migrate.core.config import ConnectionConfig


def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["CR_DB_HOST"],
        port=int(os.environ.get("CR_DB_PORT", "5432")),
        user=os.environ["CR_DB_USER"],
        password=os.environ["CR_DB_PASSWORD"],
        connect_database=os.environ["CR_DB_NAME"],
    )


def goldapi_key() -> str:
    key = os.environ.get("CR_GOLDAPI_KEY", "")
    if not key:
        raise EnvironmentError("CR_GOLDAPI_KEY is not set")
    return key
