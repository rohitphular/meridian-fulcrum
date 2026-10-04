"""The job-owned report tabs, written through the Sheets API with the shared paced requests.

The publisher (core/publish.py) talks to this through four calls, so tests use a fake:
read_values, prepare (create or resize a tab to an exact grid), write (RAW values from a
row) and request_count. Nothing here decides what is written or in which order.
"""

from __future__ import annotations

from typing import Any

from py_google_workspace import SheetsClient
from py_logging import get_logger

logger = get_logger(__name__)


class ReportSheets(SheetsClient):
    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None:
        from py_google_workspace import SheetsRequests  # needs py-google-workspace with the paced client (make upgrade-libs)

        self._requests = SheetsRequests()
        self._count = 0
        self._call(lambda: super(ReportSheets, self).__init__(service_account_file, spreadsheet_id, is_readonly=False))
        self._tabs: dict[str, Any] = {sheet.title: sheet for sheet in self._call(lambda: self._ss.worksheets())}

    def _call(self, request: Any) -> Any:
        self._count += 1
        return self._requests.call(request)

    def request_count(self) -> int:
        return self._count

    def read_values(self, title: str) -> list[list[str]] | None:
        sheet = self._tabs.get(title)
        return None if sheet is None else self._call(lambda: sheet.get_all_values())

    def prepare(self, title: str, rows: int, cols: int) -> None:
        """The tab with exactly rows × cols cells (rows beyond go: no stale chunk survives)."""
        sheet = self._tabs.get(title)
        if sheet is None:
            self._tabs[title] = self._call(lambda: self._ss.add_worksheet(title=title, rows=rows, cols=cols))
            logger.info(f"prepare: tab={title} created=true")
            return
        self._call(lambda: sheet.resize(rows=rows, cols=cols))

    def write(self, title: str, start_row: int, values: list[list[Any]]) -> None:
        sheet = self._tabs[title]
        # RAW: chunks stay text exactly as written (no formula or number parsing).
        self._call(lambda: sheet.update(values=values, range_name=f"A{start_row}", value_input_option="RAW"))
