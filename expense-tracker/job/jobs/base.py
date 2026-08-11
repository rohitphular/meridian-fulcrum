from abc import ABC, abstractmethod
from sheets_client import SheetsClient


class BaseJob(ABC):
    name: str = ''          # overridden by each job
    description: str = ''  # overridden by each job

    def __init__(self, sheets: SheetsClient, config: dict):
        self.sheets = sheets
        self.config = config

    @abstractmethod
    def run(self) -> None:
        raise NotImplementedError
