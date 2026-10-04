"""Pre-built report implementations, registered by predefined_key (contract/predefined-reports.json)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from core.reports.context import ReportContext

Implementation = Callable[[ReportContext], dict[str, Any]]
DrillValues = Callable[[ReportContext], list[str]]

REGISTRY: dict[str, Implementation] = {}
DRILLS: dict[str, DrillValues] = {}


def report(key: str, drills: DrillValues | None = None) -> Callable[[Implementation], Implementation]:
    """Registers an implementation; `drills` lists the aggregate drill values ("param:value") to precompute."""

    def register(function: Implementation) -> Implementation:
        if key in REGISTRY:
            raise ValueError(f"duplicate_report:{key}")
        REGISTRY[key] = function
        if drills is not None:
            DRILLS[key] = drills
        return function

    return register


def load_all() -> None:
    """Imports every implementation module so they register."""
    from core.reports import cashflow, categories, comparisons, networth, overview, payees_places  # noqa: F401
