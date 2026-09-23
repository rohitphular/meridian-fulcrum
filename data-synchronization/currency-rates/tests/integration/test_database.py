"""Real PostgreSQL checks in a disposable socket-only cluster; no user database.

Requires initdb and pg_ctl on PATH (or in /opt/homebrew/bin); skips if absent.
The cluster is created under /tmp, migrated once, and destroyed after this suite.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

import database.currency_master as currency_master
import database.upsert as upsert

psycopg2 = pytest.importorskip("psycopg2", reason="PostgreSQL integration checks require the postgres dependency extra")


def _postgres_binary(name: str) -> str:
    binary = shutil.which(name)
    if binary:
        return binary
    homebrew = Path("/opt/homebrew/bin") / name
    if homebrew.is_file():
        return str(homebrew)
    pytest.skip(f"PostgreSQL integration checks require local {name}; install PostgreSQL to run them")


@pytest.fixture(scope="module")
def postgres_cluster() -> Iterator[Any]:
    initdb = _postgres_binary("initdb")
    pg_ctl = _postgres_binary("pg_ctl")
    if os.geteuid() == 0:
        pytest.skip("initdb requires a non-root user")
    with tempfile.TemporaryDirectory(prefix="currency-pg-", dir="/tmp") as directory:
        cluster_root = Path(directory)
        cluster_data = cluster_root / "data"
        socket_dir = cluster_root / "socket"
        socket_dir.mkdir(mode=0o700)
        command_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"}
        subprocess.run([initdb, "-D", str(cluster_data), "-U", "currency_test", "--auth=trust", "--encoding=UTF8", "--no-locale"], check=True, capture_output=True, text=True, env=command_env)
        # No TCP listener. The trust-authenticated socket is inside a private 0700 dir.
        options = f"-c listen_addresses='' -k {socket_dir} -p 55432 -c fsync=off"
        client = None
        started = False
        try:
            subprocess.run([pg_ctl, "-D", str(cluster_data), "-l", str(cluster_root / "postgres.log"), "-o", options, "-w", "start"], check=True, capture_output=True, text=True, env=command_env)
            started = True
            client = psycopg2.connect(host=str(socket_dir), port=55432, user="currency_test", password="", dbname="postgres", sslmode="disable", passfile="/dev/null", connect_timeout=5)
            module_root = Path(__file__).resolve().parents[2]
            for migration_path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
                spec = importlib.util.spec_from_file_location(f"integration_{migration_path.stem}", migration_path)
                assert spec is not None and spec.loader is not None
                migration = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(migration)
                migration.upgrade(client)
            yield client
        finally:
            if client is not None:
                client.close()
            if started:
                subprocess.run([pg_ctl, "-D", str(cluster_data), "-m", "immediate", "-w", "stop"], check=True, capture_output=True, text=True, env=command_env)


@pytest.fixture
def database_client(postgres_cluster: Any) -> Iterator[Any]:
    # Each test starts at the committed migrated seed state and rolls back its writes.
    yield postgres_cluster
    postgres_cluster.rollback()


def _stored_rates(client: Any) -> dict[tuple[str, date], tuple[Decimal, str]]:
    with client.cursor() as cursor:
        cursor.execute("SELECT quote_currency_code, rate_date, rate_value, rate_source FROM currency_rates")
        return {(code.strip(), rate_date): (rate, source) for code, rate_date, rate, source in cursor.fetchall()}


def test_decimal_upsert_is_exact_and_updates_one_row(database_client: Any) -> None:
    rate_date = date(2026, 9, 18)
    upsert.upsert_rates(database_client, [("BTC", rate_date, Decimal("0.001234565"), "yfinance")])
    assert _stored_rates(database_client) == {("BTC", rate_date): (Decimal("0.00123457"), "yfinance")}
    upsert.upsert_rates(database_client, [("BTC", rate_date, Decimal("0.00123458"), "yfinance")])
    assert _stored_rates(database_client) == {("BTC", rate_date): (Decimal("0.00123458"), "yfinance")}


def test_forward_fill_refreshes_corrections_and_preserves_real_closes(database_client: Any) -> None:
    friday, saturday, sunday, monday = (date(2026, 9, day) for day in (18, 19, 20, 21))
    upsert.upsert_rates(database_client, [("USD", friday, Decimal("100"), "yfinance"), ("USD", sunday, Decimal("105"), "stooq")])
    upsert.forward_fill_rates(database_client, friday, monday, ["USD"])
    assert _stored_rates(database_client) == {
        ("USD", friday): (Decimal("100"), "yfinance"),
        ("USD", saturday): (Decimal("100"), "forward_fill"),
        ("USD", sunday): (Decimal("105"), "stooq"),
        ("USD", monday): (Decimal("105"), "forward_fill"),
    }
    upsert.upsert_rates(database_client, [("USD", friday, Decimal("110"), "yfinance")])
    upsert.forward_fill_rates(database_client, saturday, monday, ["USD"])
    rates = _stored_rates(database_client)
    assert rates[("USD", saturday)] == (Decimal("110"), "forward_fill")
    assert rates[("USD", sunday)] == (Decimal("105"), "stooq")
    assert rates[("USD", monday)] == (Decimal("105"), "forward_fill")


def test_forward_fill_scopes_tracked_fiat_and_never_uses_future_closes(database_client: Any) -> None:
    friday, saturday = date(2026, 9, 18), date(2026, 9, 19)
    upsert.upsert_rates(database_client, [(code, friday, Decimal("1"), "yfinance") for code in ["USD", "EUR", "GBP", "BTC", "XAU"]])
    with database_client.cursor() as cursor:
        cursor.execute("UPDATE currency_master SET is_tracked = FALSE WHERE currency_code = 'GBP'")
    upsert.forward_fill_rates(database_client, date(2026, 9, 17), saturday, ["USD", "GBP", "BTC", "XAU"])
    rates = _stored_rates(database_client)
    assert len(rates) == 6
    assert rates[("USD", saturday)] == (Decimal("1"), "forward_fill")
    assert not any(rate_date < friday for _, rate_date in rates)
    for code in ["EUR", "GBP", "BTC", "XAU"]:
        assert (code, saturday) not in rates


def test_watermark_advances_from_null_and_does_not_regress(database_client: Any) -> None:
    currency_master.update_last_fetched(database_client, {"USD": date(2026, 9, 20)})
    currency_master.update_last_fetched(database_client, {"USD": date(2026, 9, 18)})
    with database_client.cursor() as cursor:
        cursor.execute("SELECT last_fetched_date FROM currency_master WHERE currency_code='USD'")
        assert cursor.fetchone()[0] == date(2026, 9, 20)
    currency_master.update_last_fetched(database_client, {"USD": date(2026, 9, 21)})
    with database_client.cursor() as cursor:
        cursor.execute("SELECT last_fetched_date FROM currency_master WHERE currency_code='USD'")
        assert cursor.fetchone()[0] == date(2026, 9, 21)


def test_migrations_seed_expected_schema(database_client: Any) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("SELECT COUNT(*), COUNT(minor_unit_name) FROM currency_master")
        assert cursor.fetchone() == (18, 18)
        cursor.execute("SELECT decimal_places, minor_unit_name FROM currency_master WHERE currency_code='XAU'")
        assert cursor.fetchone() == (9, "nanogram")
        cursor.execute("SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name='currency_rates' AND column_name='rate_value'")
        assert cursor.fetchone() == (19, 8)
        cursor.execute("SELECT to_regclass('public.v_latest_rates'), to_regclass('public.v_rates_to_gbp')")
        assert cursor.fetchone() == (None, None)


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE currency_master SET decimal_places=8 WHERE currency_code='XAU'",
        "UPDATE currency_master SET decimal_places=10 WHERE currency_code='USD'",
        "UPDATE currency_master SET minor_unit_name=NULL WHERE currency_code='USD'",
        "INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('USD','2026-09-18',0,'test')",
        "INSERT INTO currency_rates (quote_currency_code, base_currency_code, rate_date, rate_value, rate_source) VALUES ('USD','GBP','2026-09-18',1,'test')",
        "INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES ('ZZZ','2026-09-18',1,'test')",
    ],
)
def test_migration_constraints_reject_invalid_rows(database_client: Any, statement: str) -> None:
    with pytest.raises(psycopg2.IntegrityError), database_client.cursor() as cursor:
        cursor.execute(statement)
