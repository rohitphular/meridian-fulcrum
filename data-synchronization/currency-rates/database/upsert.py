from __future__ import annotations

from datetime import date
from typing import Any

from py_logging import get_logger

logger = get_logger(__name__)

_UPSERT_SQL = """
INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, base_currency_code, rate_source)
VALUES (%s, %s, %s, 'XAU', %s)
ON CONFLICT (quote_currency_code, rate_date)
DO UPDATE SET
  rate_value  = EXCLUDED.rate_value,
  rate_source = EXCLUDED.rate_source,
  updated_at  = NOW();
"""


def upsert_rates(client: Any, rows: list[tuple[str, date, float, str]]) -> None:
    """Upsert (quote_currency_code, rate_date, rate_value, rate_source) rows into currency_rates."""
    with client.cursor() as cursor:
        cursor.executemany(_UPSERT_SQL, rows)
    client.commit()
