#!/usr/bin/env python3
"""Create or merge Fulcrum database connections into DBeaver's data-sources.json.

Safe to run multiple times — existing connection IDs are left untouched.
Passwords are NOT written here; DBeaver stores them in its own encrypted secure
storage. You will be prompted once on first connect and DBeaver will save the
credential after that.

Run with DBeaver closed; if it is open the changes will only appear after restart.

Usage:
    python3 setup-dbeaver.py dev
    python3 setup-dbeaver.py prod
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _find_workspace() -> Path:
    """Return the .dbeaver config dir inside the latest DBeaver workspace."""
    dbeaver_data = Path.home() / "Library" / "DBeaverData"
    workspaces = sorted(
        dbeaver_data.glob("workspace*"),
        key=lambda p: int("".join(filter(str.isdigit, p.name)) or 0),
        reverse=True,
    )
    base = workspaces[0] if workspaces else dbeaver_data / "workspace6"
    return base / "General" / ".dbeaver"


_WORKSPACE = _find_workspace()
_DATASOURCES = _WORKSPACE / "data-sources.json"
_ROOT = Path(__file__).parent

_FOLDER = "fulcrum"

_CONNECTION_TYPE = {
    "dev": {
        "name": "Development",
        "color": "255,255,255",
        "colorDark": "255,255,255",
        "description": "Regular development database",
        "auto-commit": True,
        "confirm-execute": False,
        "confirm-data-change": False,
        "smart-commit": False,
        "smart-commit-recover": True,
        "auto-close-transactions": True,
        "close-transactions-period": 1800,
        "auto-close-connections": True,
        "close-connections-period": 14400,
    },
    "prod": {
        "name": "Production",
        "color": "255,200,200",
        "colorDark": "100,0,0",
        "description": "Production database — confirm before writes",
        "auto-commit": False,
        "confirm-execute": True,
        "confirm-data-change": True,
        "smart-commit": False,
        "smart-commit-recover": True,
        "auto-close-transactions": True,
        "close-transactions-period": 1800,
        "auto-close-connections": True,
        "close-connections-period": 14400,
    },
}

_LABEL = {
    "dev": "fulcrum-db-dev",
    "prod": "fulcrum-db-prod",
}


def _load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def _build_connections(env_name: str, env: dict[str, str]) -> dict:
    pg_host = env.get("FULCRUM_DB_HOST", "localhost")
    pg_port = env.get("FULCRUM_DB_PORT", "5432")
    pg_user = env.get("FULCRUM_DB_USER", "fulcrum")
    pg_db = env.get("FULCRUM_DB_NAME", "fulcrum_db")
    label = _LABEL[env_name]
    conn_id = f"postgresql-{label}"
    return {
        conn_id: {
            "provider": "postgresql",
            "driver": "postgresql",
            "name": label,
            "save-password": True,
            "configuration": {
                "host": pg_host,
                "port": pg_port,
                "database": pg_db,
                "url": f"jdbc:postgresql://{pg_host}:{pg_port}/{pg_db}",
                "configurationType": "MANUAL",
                "type": "dev",
                "closeIdleConnection": True,
                "auth-model": "native",
                "user": pg_user,
            },
        },
    }


def _dbeaver_running() -> bool:
    try:
        result = subprocess.run(["pgrep", "-x", "dbeaver"], capture_output=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def main() -> None:
    if len(sys.argv) < 2:
        print("ERROR: environment argument is required.")
        print("  Usage: python3 setup-dbeaver.py dev|prod")
        sys.exit(1)

    env_name = sys.argv[1]
    if env_name not in _LABEL:
        print(f"ERROR: unknown environment '{env_name}'. Valid: {', '.join(_LABEL)}")
        sys.exit(1)

    if _dbeaver_running():
        print("  WARNING: DBeaver is open. Close it and rerun, or restart DBeaver after setup.")

    env_file = _ROOT / f".env.{env_name}"
    env = _load_env(env_file)
    connections = _build_connections(env_name, env)

    _WORKSPACE.mkdir(parents=True, exist_ok=True)

    if _DATASOURCES.exists():
        try:
            data = json.loads(_DATASOURCES.read_text())
        except json.JSONDecodeError as e:
            print(f"  ERROR: {_DATASOURCES} contains invalid JSON: {e}")
            print("  Delete the file and rerun to start fresh.")
            sys.exit(1)
    else:
        data = {}

    data.setdefault("folders", {})
    data.setdefault("connections", {})
    data.setdefault("connection-types", {})

    for key, val in _CONNECTION_TYPE.items():
        data["connection-types"].setdefault(key, val)

    if _FOLDER not in data["folders"]:
        data["folders"][_FOLDER] = {"name": _FOLDER, "description": ""}
        print(f"  Created  folder '{_FOLDER}'")

    added = skipped = 0
    for conn_id, conn in connections.items():
        if conn_id in data["connections"]:
            print(f"  Skipped  {conn['name']} (already exists)")
            skipped += 1
        else:
            conn["folder"] = _FOLDER
            data["connections"][conn_id] = conn
            print(
                f"  Added    {conn['name']} → {_FOLDER}/ (postgresql {conn['configuration']['host']}:{conn['configuration']['port']}, db={conn['configuration']['database']}, user={conn['configuration']['user']})"
            )
            added += 1

    _DATASOURCES.write_text(json.dumps(data, indent=4))
    print(f"  {added} connection(s) added, {skipped} skipped — {_DATASOURCES}")
    if added:
        print(f"  NOTE: Enter the database password from .env.{env_name} on first connect — DBeaver saves it after that.")


if __name__ == "__main__":
    main()
