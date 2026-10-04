"""The report contract (data-synchronization/analytics/contract), read from the repository.

The same JSON files drive the GAS validator (through the generated report-contract.gs) and
the analytics job, so a definition the app accepts is accepted here and computed there.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

CONTRACT_DIR = Path(__file__).resolve().parents[2] / "analytics" / "contract"


@cache
def definition() -> dict[str, Any]:
    return json.loads((CONTRACT_DIR / "report-definition.json").read_text())


@cache
def predefined() -> dict[str, Any]:
    return json.loads((CONTRACT_DIR / "predefined-reports.json").read_text())


def columns() -> tuple[str, ...]:
    return tuple(definition()["columns"])
