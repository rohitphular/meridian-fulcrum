"""publish-sheet: copy the latest rate of every currency to the app's rates tab.

The app converts XAU (grams of gold) to the display currency with these rates; the
analytics job publishes every amount in XAU. One row per currency in currency_master
that has a rate: its latest rate_value (units per gram), symbol and rate_date. XAU is 1.
Nothing in the app edits rates any more: this job owns the tab.
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

import core.config as config
from core.errors import failure_reason

logger = get_logger(__name__)

_LATEST_RATES = """
SELECT DISTINCT ON (r.quote_currency_code) r.quote_currency_code, r.rate_value, m.currency_symbol, r.rate_date, m.currency_rank
FROM currency_rates r
JOIN currency_master m ON m.currency_code = r.quote_currency_code
ORDER BY r.quote_currency_code, r.rate_date DESC
"""


def latest_rates(conn: Any) -> list[tuple[str, Decimal, str, date]]:
    """Latest rate per currency, XAU first, then by currency_rank and code."""
    with conn.cursor() as cursor:
        cursor.execute(_LATEST_RATES)
        records = cursor.fetchall()
    conn.rollback()
    records.sort(key=lambda record: (record[0] != "XAU", record[4] if record[4] is not None else 10**6, record[0]))
    return [(code, rate, symbol or "", rate_date) for code, rate, symbol, rate_date, _ in records]


def sheet_rows(rates: list[tuple[str, Decimal, str, date]], now: datetime) -> list[list[Any]]:
    if not rates:
        raise RuntimeError("no_rates_to_publish")
    if not any(code == "XAU" for code, *_ in rates):
        raise RuntimeError("missing_xau_rate")
    stamp = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return [[code, float(rate), symbol, stamp, rate_date.isoformat()] for code, rate, symbol, rate_date in rates]


def main() -> None:
    from sheets.rates_sheet import RatesSheet

    logger.info("publish_sheet: start=true")
    try:
        spreadsheet_id = os.environ["FDL_SPREADSHEET_ID"]
        key_file = os.environ.get("FDL_SERVICE_ACCOUNT_FILE", "")
        if not key_file.strip():
            raise ValueError("missing_environment_variable:FDL_SERVICE_ACCOUNT_FILE")
        conn = get_client(config.db_config())
        try:
            rates = latest_rates(conn)
        finally:
            conn.close()
        rows = sheet_rows(rates, datetime.now(timezone.utc))
        RatesSheet(key_file, spreadsheet_id).publish(rows)
    except Exception as error:
        logger.error(f"publish_sheet: job_failed error={type(error).__name__} reason={failure_reason(error)}")
        sys.exit(1)
    newest = max(row[4] for row in rows)
    logger.info(f"publish_sheet: complete currencies={len(rows)} newest_rate_date={newest}")


if __name__ == "__main__":
    main()
