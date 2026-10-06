from pathlib import Path
from typing import Any

import pytest

import core.config as config
import steps.fill_ids as fill_ids
from core.context import LoadContext
from core.datasets import Dataset, collect_datasets
from core.gas_client import GasError

_BOM_CRLF = '﻿id,name\r\n,"a, b"\r\n2,c\r\n'


class FillClient:
    def __init__(self, replies: dict[str, dict[str, Any]]) -> None:
        self.replies = replies
        self.sent: dict[str, str] = {}

    def post(self, action: str, **body: Any) -> dict[str, Any]:
        assert action == "fill_csv_ids"
        name = next(name for name, reply in self.replies.items() if reply.get("_source") == body["csv"])
        self.sent[name] = body["csv"]
        reply = dict(self.replies[name])
        reply.pop("_source")
        return reply


def _context(client: Any, data_dir: Path, files: list[str]) -> LoadContext:
    return LoadContext(client, data_dir, [Dataset(name, "x") for name in files], "sheet-id", {})


def test_fill_ids_sends_exact_bytes_backs_up_and_rewrites_only_changed_files(tmp_path: Path) -> None:
    (tmp_path / "a.csv").write_bytes(_BOM_CRLF.encode("utf-8"))
    (tmp_path / "b.csv").write_bytes(b"id\n9\n")
    filled = _BOM_CRLF.replace("\r\n,", "\r\nnew-uuid,", 1)
    client = FillClient({"a.csv": {"_source": _BOM_CRLF, "ok": True, "csv": filled, "filled": 1}, "b.csv": {"_source": "id\n9\n", "ok": True, "csv": "id\n9\n", "filled": 0}})
    backup = fill_ids.run(_context(client, tmp_path, ["a.csv", "b.csv"]))
    # BOM and CRLF reach the server unchanged, and come back unchanged.
    assert client.sent["a.csv"] == _BOM_CRLF
    assert (tmp_path / "a.csv").read_bytes() == filled.encode("utf-8")
    assert backup is not None and backup.parent == tmp_path / ".backup"
    assert (backup / "a.csv").read_bytes() == _BOM_CRLF.encode("utf-8")
    assert not (backup / "b.csv").exists()
    assert (tmp_path / "b.csv").read_bytes() == b"id\n9\n"
    assert not list(tmp_path.glob("*.tmp"))


def test_fill_ids_without_blank_ids_makes_no_backup(tmp_path: Path) -> None:
    (tmp_path / "a.csv").write_text("id\n1\n")
    client = FillClient({"a.csv": {"_source": "id\n1\n", "ok": True, "csv": "id\n1\n", "filled": 0}})
    assert fill_ids.run(_context(client, tmp_path, ["a.csv"])) is None
    assert not (tmp_path / ".backup").exists()


def test_fill_ids_failure_leaves_the_file_untouched(tmp_path: Path) -> None:
    (tmp_path / "a.csv").write_text('id\n"open\n')
    client = FillClient({"a.csv": {"_source": 'id\n"open\n', "ok": False, "error": "invalid_csv"}})
    with pytest.raises(GasError, match="^invalid_csv:fill_ids:a.csv$"):
        fill_ids.run(_context(client, tmp_path, ["a.csv"]))
    assert (tmp_path / "a.csv").read_text() == 'id\n"open\n'
    assert not (tmp_path / ".backup").exists()


def test_collect_datasets_requires_every_fixed_file_and_a_transaction_file(tmp_path: Path) -> None:
    settings = config.load_config()
    with pytest.raises(FileNotFoundError, match="^missing_file:account_types.csv$"):
        collect_datasets(settings, tmp_path)
    for entry in settings["datasets"]:
        (tmp_path / entry["file"]).write_text("id\n")
    with pytest.raises(FileNotFoundError, match="^missing_transaction_files$"):
        collect_datasets(settings, tmp_path)


def test_data_dir_defaults_to_repository_local_files_and_honours_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    settings = config.load_config()
    monkeypatch.delenv("LSL_DATA_DIR", raising=False)
    assert config.data_dir(settings) == Path(__file__).resolve().parents[5] / "local" / "files"
    monkeypatch.setenv("LSL_DATA_DIR", str(tmp_path))
    assert config.data_dir(settings) == tmp_path
