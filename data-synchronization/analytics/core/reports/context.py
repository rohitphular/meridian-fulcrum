"""What a pre-built report implementation receives for one variant."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from core.mart import Mart
from core.periods import Period


@dataclass
class ReportContext:
    mart: Mart
    anchor: date
    entry: dict[str, Any]  # the catalogue entry
    period: Period | None
    compare: Period | None
    tab: str | None
    controls: dict[str, Any]
    drill: dict[str, str] | None
    home_country: str
    home_currency: str
    params: dict[str, Any] = field(default_factory=dict)  # the variant's parameters (for drill links)

    def control(self, name: str) -> Any:
        return self.controls[name]
