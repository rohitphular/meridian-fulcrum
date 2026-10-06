from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.datasets import Dataset
from core.gas_client import GasClient


@dataclass(frozen=True)
class LoadContext:
    client: GasClient
    data_dir: Path
    datasets: list[Dataset]
    spreadsheet_id: str
    settings: dict[str, Any]
