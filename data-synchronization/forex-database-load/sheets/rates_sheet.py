"""The app's rates tab, written through the Sheets API with the shared paced requests."""

from __future__ import annotations

from typing import Any

from gspread.exceptions import WorksheetNotFound
from py_google_workspace import SheetsClient, SheetsRequests
from py_logging import get_logger

logger = get_logger(__name__)

RATES_TAB = "rates"
# Same order as the GAS rate schema (expense-tracker/api/rate-schema.gs).
COLUMNS = ("currency", "rate", "symbol", "updated_at", "rate_date")


class RatesSheet(SheetsClient):
    """Rewrites the rates tab in one write: header and every rate, then clears any older rows below."""

    def __init__(self, service_account_file: str, spreadsheet_id: str) -> None:
        self._requests = SheetsRequests()
        # Opening the spreadsheet also consumes a Sheets request.
        self._requests.call(lambda: super(RatesSheet, self).__init__(service_account_file, spreadsheet_id, is_readonly=False))

    def publish(self, rows: list[list[Any]]) -> None:
        values = [list(COLUMNS), *rows]
        try:
            sheet = self._requests.call(lambda: self._ss.worksheet(RATES_TAB))
        except WorksheetNotFound:
            sheet = self._requests.call(lambda: self._ss.add_worksheet(title=RATES_TAB, rows=len(values) + 10, cols=len(COLUMNS)))
            logger.info("publish: tab_created=true")
        last = f"E{len(values)}"
        # RAW: rates stay numbers and dates stay text (no locale parsing).
        self._requests.call(lambda: sheet.update(values=values, range_name=f"A1:{last}", value_input_option="RAW"))
        if sheet.row_count > len(values):
            self._requests.call(lambda: sheet.batch_clear([f"A{len(values) + 1}:E{sheet.row_count}"]))
