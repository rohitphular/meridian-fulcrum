"""Migration loading and PostgreSQL discovery for isolated integration tests."""

from __future__ import annotations

import importlib.util
import shutil
import sys
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


EXTRACT_ROOT = MODULE_ROOT.parent / "ledger-sheet-extract"


def apply_migrations(client: Any, ledger_version: int | None = None) -> None:
    # Currency tables, this module's ledger tables, and the staging tables that
    # ledger-sheet-extract owns and this module reads.
    for module_root in (MODULE_ROOT.parent / "forex-database-load", MODULE_ROOT, EXTRACT_ROOT):
        for path in sorted((module_root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.py")):
            if module_root == MODULE_ROOT and ledger_version is not None and int(path.name[:4]) > ledger_version:
                continue
            migration(path).upgrade(client)


def _extract_staging() -> Any:
    """ledger-sheet-extract's own staging writer (loaded by path: both modules have a `database` package)."""
    name = "integration_extract_staging"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, EXTRACT_ROOT / "database" / "staging.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve their module through sys.modules
    spec.loader.exec_module(module)
    return module


def stage(client: Any, source: dict[str, list[dict[str, Any]]], headers: dict[str, Any]) -> str:
    """Stage fixture rows exactly as ledger-sheet-extract does; returns the run id."""
    snapshots = {name: (list(headers[name]), [row.copy() for row in rows]) for name, rows in source.items()}
    return _extract_staging().store_snapshot(client, snapshots)


def acknowledge(client: Any, source: dict[str, list[dict[str, Any]]]) -> list[str]:
    """Apply the loaded run's outcomes to the fixture rows, as the acknowledge step would.

    Returns the tabs that received outcomes, sorted (like the former Sheet writes).
    """
    staging = _extract_staging()
    run_id = staging.latest_loaded_run(client)
    if run_id is None:
        return []
    outcomes = staging.pending_outcomes(client, run_id)
    for outcome in outcomes:
        row = next(row for row in source[outcome.tab] if row["_sheet_row_num"] == outcome.sheet_row_num)
        row["sync_status"], row["sync_date"], row["sync_notes"] = outcome.outcome
    staging.mark_acknowledged(client, run_id, outcomes)
    return sorted({outcome.tab for outcome in outcomes})


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
