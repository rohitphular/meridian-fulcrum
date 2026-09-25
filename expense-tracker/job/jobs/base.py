from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sheets_client import SheetsClient


class BaseJob(ABC):
    name: str = ""  # overridden by each job
    description: str = ""  # overridden by each job
    source_contract: str | None = None

    def __init__(self, sheets: SheetsClient, config: dict) -> None:
        self.sheets = sheets
        self.config = config

    @classmethod
    def validate_source_contract(cls, source_contract: str | None) -> None:
        if cls.source_contract is not None and cls.source_contract != source_contract:
            raise ValueError(
                "unsupported_insights_source_contract: this job requires the legacy dual-leg schema; "
                "current expense-tracker uses transaction_master with single account movements. "
                "Use the app Insights screen. Port and validate the job before publishing computed insights; "
                "see expense-tracker/job/README.md."
            )

    @abstractmethod
    def run(self) -> None:
        raise NotImplementedError
