"""Disposable PostgreSQL for staging tests; never connects to a configured database.

The cluster machinery is ledger-database-load's (loaded by path), so both modules
start PostgreSQL the same way.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

psycopg2 = pytest.importorskip("psycopg2", reason="Database integration checks require the postgres dependency extra")
pg_sql = pytest.importorskip("psycopg2.sql")

MODULE_ROOT = Path(__file__).resolve().parents[2]
DATA_SYNC = MODULE_ROOT.parent
LOAD_ROOT = DATA_SYNC / "ledger-database-load"
PORT = 55434


def _load(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply_migrations(client: Any) -> None:
    """Currency and ledger tables (so a real load can run), then this module's staging tables."""
    for module_root in (DATA_SYNC / "forex-database-load", LOAD_ROOT, MODULE_ROOT):
        for path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
            _load(path, f"staging_test_{module_root.name.replace('-', '_')}_{path.stem}").upgrade(client)


@pytest.fixture(scope="session")
def postgres_cluster() -> Iterator[dict[str, Any]]:
    support = _load(LOAD_ROOT / "tests" / "integration" / "postgres_support.py", "staging_test_postgres_support")
    initdb, pg_ctl = support._postgres_binary("initdb"), support._postgres_binary("pg_ctl")
    if os.geteuid() == 0:
        pytest.skip("initdb requires a non-root user")
    with tempfile.TemporaryDirectory(prefix="staging-pg-", dir="/tmp") as directory, pytest.MonkeyPatch.context() as environment:
        for name in tuple(os.environ):
            if name.startswith("PG"):
                environment.delenv(name)
        root = Path(directory)
        socket_dir = root / "socket"
        socket_dir.mkdir(mode=0o700)
        command_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"}
        subprocess.run([initdb, "-D", str(root / "data"), "-U", "ledger_test", "--auth=trust", "--encoding=UTF8", "--no-locale"], check=True, capture_output=True, text=True, env=command_env)
        options = f"-c listen_addresses='' -k {socket_dir} -p {PORT} -c fsync=off"
        connection = dict(host=str(socket_dir), port=PORT, user="ledger_test", password="", sslmode="disable", connect_timeout=5)
        started = False
        try:
            subprocess.run([pg_ctl, "-D", str(root / "data"), "-l", str(root / "postgres.log"), "-o", options, "-w", "start"], check=True, capture_output=True, text=True, env=command_env)
            started = True
            admin = psycopg2.connect(**connection, dbname="postgres")
            try:
                admin.autocommit = True
                with admin.cursor() as cursor:
                    cursor.execute("CREATE DATABASE staging_template")
            finally:
                admin.close()
            template = psycopg2.connect(**connection, dbname="staging_template")
            try:
                apply_migrations(template)
            finally:
                template.close()
            yield connection
        finally:
            if started:
                subprocess.run([pg_ctl, "-D", str(root / "data"), "-m", "immediate", "-w", "stop"], check=True, capture_output=True, text=True, env=command_env)


@pytest.fixture
def database(postgres_cluster: dict[str, Any]) -> Iterator[tuple[Any, dict[str, Any]]]:
    name = f"staging_test_{uuid4().hex}"
    admin = psycopg2.connect(**postgres_cluster, dbname="postgres")
    admin.autocommit = True
    connection = None
    try:
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("CREATE DATABASE {} TEMPLATE staging_template").format(pg_sql.Identifier(name)))
        connection = psycopg2.connect(**postgres_cluster, dbname=name)
        yield connection, {**postgres_cluster, "dbname": name}
    finally:
        if connection is not None:
            connection.close()
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("DROP DATABASE IF EXISTS {}").format(pg_sql.Identifier(name)))
        admin.close()
