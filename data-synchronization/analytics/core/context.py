"""What every build step receives: the run, its anchor date, the mart and the counts it adds to."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass
class BuildContext:
    generation_id: str
    anchor_date: date
    mart: Any = None
    reports_ok: int = 0
    reports_failed: int = 0
    rows_not_loaded: int = 0
    missing_currencies: set[str] = field(default_factory=set)

    def counts(self) -> dict[str, Any]:
        return {"reports_ok": self.reports_ok, "reports_failed": self.reports_failed, "rows_not_loaded": self.rows_not_loaded, "missing_currencies": self.missing_currencies}
