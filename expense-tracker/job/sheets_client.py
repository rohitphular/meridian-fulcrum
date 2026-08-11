from datetime import date, timedelta

import gspread
from google.oauth2.service_account import Credentials

_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
]


class SheetsClient:
    def __init__(self, service_account_file: str, spreadsheet_id: str):
        creds = Credentials.from_service_account_file(service_account_file, scopes=_SCOPES)
        self._gc     = gspread.authorize(creds)
        self._ss     = self._gc.open_by_key(spreadsheet_id)
        self._spread = spreadsheet_id

    def read_sheet(self, name: str) -> list[dict]:
        try:
            ws = self._ss.worksheet(name)
        except gspread.exceptions.WorksheetNotFound:
            print(f"  [sheets] sheet not found: {name!r} — returning empty")
            return []
        rows = ws.get_all_records(numericise_ignore=['all'])
        print(f"  [sheets] read {len(rows)} rows from {name!r}")
        return rows

    def write_sheet(self, name: str, headers: list[str], rows: list[list]) -> None:
        try:
            ws = self._ss.worksheet(name)
            ws.clear()
        except gspread.exceptions.WorksheetNotFound:
            ws = self._ss.add_worksheet(title=name, rows=max(len(rows) + 10, 100), cols=len(headers))

        ws.update([headers] + rows, value_input_option='RAW')
        print(f"  [sheets] wrote {len(rows)} rows to {name!r}")

    def replace_today_and_trim(self, name: str, headers: list[str], new_rows: list[list], retain_days: int = 30) -> None:
        """Idempotent write: drop today's rows and rows older than retain_days, then append new_rows."""
        today_str  = date.today().isoformat()
        cutoff_str = (date.today() - timedelta(days=retain_days)).isoformat()

        try:
            ws       = self._ss.worksheet(name)
            existing = ws.get_all_values()
        except gspread.exceptions.WorksheetNotFound:
            ws       = None
            existing = []

        if existing and existing[0]:
            try:
                ca_idx = existing[0].index('computed_at')
            except ValueError:
                ca_idx = 0
            surviving = [
                row for row in existing[1:]
                if row and len(row) > ca_idx
                and row[ca_idx][:10] != today_str
                and row[ca_idx][:10] >= cutoff_str
            ]
        else:
            surviving = []

        all_rows = surviving + new_rows

        if ws is None:
            ws = self._ss.add_worksheet(
                title=name,
                rows=max(len(all_rows) + 10, 100),
                cols=len(headers),
            )
        else:
            ws.clear()

        ws.update([headers] + all_rows, value_input_option='RAW')
        print(f"  [sheets] {name!r}: {len(surviving)} kept + {len(new_rows)} new = {len(all_rows)} rows")
