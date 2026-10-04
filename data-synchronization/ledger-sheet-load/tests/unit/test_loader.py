from pathlib import Path
from typing import Any

import pytest

import core.config as config
from core.context import LoadContext
from core.datasets import collect_datasets
from core.gas_client import GasError
from core.loader import LedgerSheetLoadJob

_FIXED_FILES = [entry["file"] for entry in config.load_config()["datasets"]]


class FakeClient:
    """Records calls and answers like the GAS endpoints; `replies` overrides by action."""

    def __init__(self, replies: dict[str, dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.replies = replies or {}

    def get(self, action: str, **params: str) -> dict[str, Any]:
        self.calls.append(("GET", action, params))
        return self.replies.get(action, {"ok": True})

    def post(self, action: str, **body: Any) -> dict[str, Any]:
        self.calls.append(("POST", action, body))
        if action in self.replies:
            return self.replies[action]
        if action == "fill_csv_ids":
            return {"ok": True, "csv": body["csv"], "filled": 0}
        if action == "factory_reset_delete_sheets":
            return {"ok": True, "deleted": ["account_types"]}
        return {"ok": True, "rows": 1, "created": 1, "updated": 0, "failed": 0}


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    for name in [*_FIXED_FILES, "transaction_master_2026_02.csv", "transaction_master_2026_01.csv"]:
        (tmp_path / name).write_text("id,name\n1,x\n")
    return tmp_path


def _context(client: FakeClient, data_dir: Path) -> LoadContext:
    settings = config.load_config()
    return LoadContext(client, data_dir, collect_datasets(settings, data_dir), "sheet-id", settings)  # type: ignore[arg-type]


def _steps(client: FakeClient) -> list[str]:
    """Collapses consecutive calls of the same action, e.g. one per file, to one entry."""
    names: list[str] = []
    for _, action, body in client.calls:
        name = action if action in ("verify", "fill_csv_ids", "factory_reset_delete_sheets", "arrange_sheet_tabs") or action.startswith("list_") else f"import(dry_run={body['dry_run']})"
        if not names or names[-1] != name:
            names.append(name)
    return names


def test_sheet_sync_never_deletes_tabs(data_dir: Path) -> None:
    client = FakeClient()
    LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-sync", "123456")
    assert _steps(client) == ["verify", "fill_csv_ids", "import(dry_run=True)", "import(dry_run=False)", "arrange_sheet_tabs"]
    assert client.calls[0] == ("GET", "verify", {"totp": "123456"})


def test_sheet_rebuild_deletes_and_recreates_tabs_after_the_check(data_dir: Path) -> None:
    client = FakeClient()
    LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-rebuild", "123456")
    assert _steps(client) == [
        "verify",
        "fill_csv_ids",
        "import(dry_run=True)",
        "factory_reset_delete_sheets",
        "list_transactions",
        "list_categories",
        "list_accounts",
        "list_subscriptions",
        "import(dry_run=False)",
        "arrange_sheet_tabs",
    ]
    delete = next(body for _, action, body in client.calls if action == "factory_reset_delete_sheets")
    assert delete == {"confirm": "factory-reset", "spreadsheet_id": "sheet-id"}


def test_files_load_in_dependency_order_with_transactions_last_by_name(data_dir: Path) -> None:
    client = FakeClient()
    LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-sync", "123456")
    loads = [(action, body.get("file_type", "")) for _, action, body in client.calls if body.get("dry_run") is False]
    assert loads[0] == ("create_account_types_bulk", "")
    assert loads[1] == ("create_categories_bulk", "")
    assert loads[2] == ("import_account_data", "account_master")
    assert loads[9] == ("create_subscriptions_bulk", "")
    # Report configuration after the accounts and categories its filters refer to.
    assert loads[10:12] == [("create_reports_bulk", ""), ("import_dashboard_layout", "")]
    assert loads[12:] == [("create_transactions_bulk", ""), ("create_transactions_bulk", "")]
    assert len(loads) == len(_FIXED_FILES) + 2


def test_failed_check_stops_before_any_sheet_change(data_dir: Path) -> None:
    client = FakeClient({"create_categories_bulk": {"ok": False, "error": "invalid_csv_rows", "errors": ["Row 2: bad"]}})
    with pytest.raises(GasError, match="^invalid_csv_rows:check:category_master.csv$"):
        LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-rebuild", "123456")
    actions = [action for _, action, _ in client.calls]
    assert "factory_reset_delete_sheets" not in actions and "arrange_sheet_tabs" not in actions
    assert not any(body.get("dry_run") is False for _, _, body in client.calls)


def test_failed_sign_in_stops_before_files_are_sent(data_dir: Path) -> None:
    client = FakeClient({"verify": {"ok": False, "error": "invalid_totp"}})
    with pytest.raises(GasError, match="^invalid_totp:sign_in$"):
        LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-sync", "000000")
    assert [action for _, action, _ in client.calls] == ["verify"]


def test_partial_row_failures_stop_the_load(data_dir: Path) -> None:
    client = FakeClient({"create_account_types_bulk": {"ok": True, "failed": 1, "rows": 1}})
    with pytest.raises(GasError, match="^rows_failed:check:account_types.csv$"):
        LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-sync", "123456")


def test_unknown_mode_is_rejected_before_any_call(data_dir: Path) -> None:
    client = FakeClient()
    with pytest.raises(ValueError, match="invalid_mode"):
        LedgerSheetLoadJob(_context(client, data_dir)).run("rebuild", "123456")
    assert client.calls == []


def test_run_without_a_code_skips_sign_in_after_a_pipeline_sign_in(data_dir: Path) -> None:
    client = FakeClient()
    LedgerSheetLoadJob(_context(client, data_dir)).run("sheet-sync", None)
    assert _steps(client) == ["fill_csv_ids", "import(dry_run=True)", "import(dry_run=False)", "arrange_sheet_tabs"]


def test_sign_in_alone_only_calls_verify(data_dir: Path) -> None:
    client = FakeClient()
    LedgerSheetLoadJob(_context(client, data_dir)).sign_in("123456")
    assert client.calls == [("GET", "verify", {"totp": "123456"})]
