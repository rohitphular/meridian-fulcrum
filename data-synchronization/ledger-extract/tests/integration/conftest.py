"""Shared disposable PostgreSQL fixtures; never connect to configured databases."""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from tests.integration.postgres_support import _postgres_binary, apply_migrations, configure_test_account_types

psycopg2 = pytest.importorskip("psycopg2", reason="Database integration checks require the postgres dependency extra")
pg_sql = pytest.importorskip("psycopg2.sql")


@pytest.fixture(scope="session")
def postgres_cluster() -> Iterator[dict[str, Any]]:
    initdb = _postgres_binary("initdb")
    pg_ctl = _postgres_binary("pg_ctl")
    if os.geteuid() == 0:
        pytest.skip("initdb requires a non-root user")
    with tempfile.TemporaryDirectory(prefix="ledger-pg-", dir="/tmp") as directory, pytest.MonkeyPatch.context() as environment:
        # Ignore libpq service/host/option environment settings from the shell.
        for name in tuple(os.environ):
            if name.startswith("PG"):
                environment.delenv(name)
        cluster_root = Path(directory)
        cluster_data = cluster_root / "data"
        socket_dir = cluster_root / "socket"
        socket_dir.mkdir(mode=0o700)
        command_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"}
        subprocess.run([initdb, "-D", str(cluster_data), "-U", "ledger_test", "--auth=trust", "--encoding=UTF8", "--no-locale"], check=True, capture_output=True, text=True, env=command_env)
        options = f"-c listen_addresses='' -k {socket_dir} -p 55433 -c fsync=off"
        password_file = cluster_root / "empty.pgpass"
        password_file.touch(mode=0o600)
        connection = dict(host=str(socket_dir), port=55433, user="ledger_test", password="", sslmode="disable", passfile=str(password_file), connect_timeout=5)
        started = False
        try:
            subprocess.run([pg_ctl, "-D", str(cluster_data), "-l", str(cluster_root / "postgres.log"), "-o", options, "-w", "start"], check=True, capture_output=True, text=True, env=command_env)
            started = True
            admin = psycopg2.connect(**connection, dbname="postgres")
            try:
                admin.autocommit = True
                with admin.cursor() as cursor:
                    cursor.execute("CREATE DATABASE ledger_template")
            finally:
                admin.close()
            template = psycopg2.connect(**connection, dbname="ledger_template")
            try:
                apply_migrations(template)
            finally:
                template.close()
            yield connection
        finally:
            if started:
                subprocess.run([pg_ctl, "-D", str(cluster_data), "-m", "immediate", "-w", "stop"], check=True, capture_output=True, text=True, env=command_env)


@pytest.fixture
def database_client(postgres_cluster: dict[str, Any], request: pytest.FixtureRequest) -> Iterator[Any]:
    database_name = f"ledger_test_{uuid4().hex}"
    ledger_version = getattr(request, "param", None)
    template_name = "ledger_template" if ledger_version is None else "template0"
    admin = psycopg2.connect(**postgres_cluster, dbname="postgres")
    admin.autocommit = True
    connection = None
    try:
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(pg_sql.Identifier(database_name), pg_sql.Identifier(template_name)))
        connection = psycopg2.connect(**postgres_cluster, dbname=database_name)
        if ledger_version is not None:
            apply_migrations(connection, ledger_version)
        if ledger_version is None and request.module.__name__.split(".")[-1] not in {"test_account_types", "test_account_type_policies"}:
            configure_test_account_types(connection)
        yield connection
    finally:
        if connection is not None:
            connection.close()
        with admin.cursor() as cursor:
            cursor.execute(pg_sql.SQL("DROP DATABASE IF EXISTS {}").format(pg_sql.Identifier(database_name)))
        admin.close()
