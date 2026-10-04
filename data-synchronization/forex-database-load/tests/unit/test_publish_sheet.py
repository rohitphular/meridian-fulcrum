"""publish-sheet: launcher checks, the rate rows and the single rates-tab write."""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.publish_sheet import latest_rates, sheet_rows

MODULE_ROOT = Path(__file__).resolve().parents[2]


def _launcher(tmp_path: Path, envs: str, env_file: str) -> tuple[subprocess.CompletedProcess[str], Path]:
    scripts = tmp_path / "repo" / "data-synchronization" / "forex-database-load" / "cicd"
    scripts.mkdir(parents=True)
    for script in ("start-up.sh", "check.sh"):
        shutil.copyfile(MODULE_ROOT / "cicd" / script, scripts / script)
    (scripts / "envs.json").write_text(envs)
    infrastructure = tmp_path / "repo" / "infrastructure"
    infrastructure.mkdir()
    (infrastructure / ".env.dev").write_text(f"MERIDIAN_LOG_ROOT={tmp_path / 'logs'}\n{env_file}")
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    capture = tmp_path / "commands"
    fake_uv = binary_dir / "uv"
    fake_uv.write_text('#!/bin/sh\nprintf "%s %s\\n" "$*" "${FDL_SPREADSHEET_ID:-}" >> "$CURRENCY_TEST_COMMANDS"\n')
    fake_uv.chmod(0o700)
    environment = {**os.environ, "PATH": f"{binary_dir}:/usr/bin:/bin", "CURRENCY_TEST_COMMANDS": str(capture)}
    result = subprocess.run(["/bin/bash", str(scripts / "start-up.sh"), "--interactive", "dev", "publish-sheet"], capture_output=True, text=True, env=environment, check=False)
    return result, capture


def test_publish_sheet_needs_the_spreadsheet_id(tmp_path: Path) -> None:
    result, capture = _launcher(tmp_path, '{"dev":{}}', "FDL_SERVICE_ACCOUNT_FILE=/keys/sa.json\n")
    assert result.returncode == 1
    assert "spreadsheet_id is not configured" in result.stdout
    assert not capture.exists()


def test_publish_sheet_needs_the_key_file_variable(tmp_path: Path) -> None:
    result, capture = _launcher(tmp_path, '{"dev":{"spreadsheet_id":"sheet-1"}}', "")
    assert result.returncode == 1
    assert "FDL_SERVICE_ACCOUNT_FILE is not set" in result.stdout
    assert not capture.exists()


def test_publish_sheet_runs_its_job_with_the_spreadsheet_id(tmp_path: Path) -> None:
    result, capture = _launcher(tmp_path, '{"dev":{"spreadsheet_id":"sheet-1"}}', "FDL_SERVICE_ACCOUNT_FILE=/keys/sa.json\n")
    assert result.returncode == 0, result.stdout + result.stderr
    assert capture.read_text().splitlines()[-1] == "run --locked python -m core.publish_sheet sheet-1"


def test_latest_rates_put_xau_first_then_rank_then_code() -> None:
    cursor = MagicMock()
    cursor.fetchall.return_value = [
        ("USD", Decimal("98.5"), "$", date(2026, 10, 3), 3),
        ("XAU", Decimal("1"), "⊕", date(2026, 10, 3), None),
        ("GBP", Decimal("76.9"), "£", date(2026, 10, 3), 1),
        ("BTC", Decimal("0.0000012"), "₿", date(2026, 10, 2), None),
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    assert [code for code, *_ in latest_rates(conn)] == ["XAU", "GBP", "USD", "BTC"]


def test_sheet_rows_are_numbers_and_text_in_the_rate_schema_order() -> None:
    now = datetime(2026, 10, 4, 6, 30, tzinfo=timezone.utc)
    rows = sheet_rows([("XAU", Decimal("1"), "⊕", date(2026, 10, 3)), ("GBP", Decimal("76.91234567"), "£", date(2026, 10, 3))], now)
    assert rows[1] == ["GBP", 76.91234567, "£", "2026-10-04T06:30:00Z", "2026-10-03"]
    with pytest.raises(RuntimeError, match="^no_rates_to_publish$"):
        sheet_rows([], now)
    with pytest.raises(RuntimeError, match="^missing_xau_rate$"):
        sheet_rows([("GBP", Decimal("76.9"), "£", date(2026, 10, 3))], now)


def test_the_tab_is_rewritten_in_one_write_and_older_rows_below_are_cleared() -> None:
    rates_sheet = pytest.importorskip("sheets.rates_sheet", reason="needs py-google-workspace with SheetsRequests (push meridian-common-libs, then make upgrade-libs)", exc_type=ImportError)
    client = object.__new__(rates_sheet.RatesSheet)
    client._requests = SimpleNamespace(call=lambda request: request())
    worksheet = MagicMock(row_count=12)
    client._ss = MagicMock()
    client._ss.worksheet.return_value = worksheet
    client.publish([["XAU", 1.0, "⊕", "2026-10-04T06:30:00Z", "2026-10-03"], ["GBP", 76.9, "£", "2026-10-04T06:30:00Z", "2026-10-03"]])
    worksheet.update.assert_called_once()
    kwargs = worksheet.update.call_args.kwargs
    assert kwargs["range_name"] == "A1:E3" and kwargs["value_input_option"] == "RAW"
    assert kwargs["values"][0] == ["currency", "rate", "symbol", "updated_at", "rate_date"]
    worksheet.batch_clear.assert_called_once_with(["A4:E12"])
