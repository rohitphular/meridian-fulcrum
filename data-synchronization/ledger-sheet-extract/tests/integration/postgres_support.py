"""Migration loading and PostgreSQL discovery for isolated integration tests."""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path
from typing import Any

import pytest

MODULE_ROOT = Path(__file__).resolve().parents[2]


def _postgres_binary(name: str) -> str:
    binary = shutil.which(name)
    if binary is not None:
        return binary
    candidate = Path("/opt/homebrew/bin") / name
    if candidate.is_file():
        return str(candidate)
    pytest.skip(f"PostgreSQL integration checks require local {name}; install PostgreSQL to run them")


def migration(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(f"integration_{path.parent.parent.name}_{path.stem}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply_migrations(client: Any, ledger_version: int | None = None) -> None:
    for module_root in (MODULE_ROOT.parent / "currency-rates", MODULE_ROOT):
        for path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
            if module_root == MODULE_ROOT and ledger_version is not None and int(path.name[:4]) > ledger_version:
                continue
            migration(path).upgrade(client)


def configure_test_account_types(client: Any) -> None:
    """Synthetic fixture policy, deliberately kept out of application runtime code."""
    fixture_policies = {
        "current": "account_deposit",
        "savings": "account_deposit",
        "cash": "account_deposit",
        "credit-card": "account_liability_credit_card",
        "mortgage": "account_liability_mortgage",
        "personal-loan": "account_liability_personal_loan",
        "property": "account_investment_property",
        "stocks-shares": "account_investment_stocks",
    }
    with client.cursor() as cursor:
        cursor.execute("UPDATE account_types SET is_sheet_managed=TRUE,sync_status='in-sync'")
        for subtype, sheet in fixture_policies.items():
            cursor.execute("UPDATE account_types SET detail_sheet=%s WHERE account_subtype_key=%s", (sheet, subtype))
    client.commit()


def subtype_for_detail(client: Any, sheet: str) -> str:
    with client.cursor() as cursor:
        cursor.execute("SELECT account_subtype_key FROM account_types WHERE detail_sheet=%s ORDER BY account_subtype_key LIMIT 1", (sheet,))
        selected = cursor.fetchone()
    assert selected is not None
    return selected[0]
