from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Dataset:
    file: str
    action: str
    file_type: str = ""

    def import_body(self, data_dir: Path, dry_run: bool) -> dict[str, Any]:
        body: dict[str, Any] = {"csv": read_csv(data_dir / self.file), "dry_run": dry_run}
        if self.file_type:
            body["file_type"] = self.file_type
        return body


def read_csv(path: Path) -> str:
    # Exact text: keeps a BOM and CRLF line endings so the server sees the file as written.
    return path.read_bytes().decode("utf-8")


def write_csv(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(text.encode("utf-8"))
    temporary.replace(path)


def collect_datasets(settings: dict[str, Any], data_dir: Path) -> list[Dataset]:
    """Every fixed file in load order, then each monthly transaction file by name."""
    datasets = [Dataset(entry["file"], entry["action"], entry.get("file_type", "")) for entry in settings["datasets"]]
    for dataset in datasets:
        if not (data_dir / dataset.file).is_file():
            raise FileNotFoundError(f"missing_file:{dataset.file}")
    transactions = settings["transaction_files"]
    files = sorted(path.name for path in data_dir.glob(transactions["pattern"]) if path.is_file())
    if not files:
        raise FileNotFoundError("missing_transaction_files")
    return datasets + [Dataset(name, transactions["action"]) for name in files]
