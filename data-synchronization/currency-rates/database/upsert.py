from __future__ import annotations

from datetime import date
from typing import Any

from py_logging import get_logger

from database.models.currency_rates import TABLE

logger = get_logger(__name__)

_UPSERT_SQL = f"""
INSERT INTO {TABLE} (quote_currency_code, rate_date, rate_value, base_currency_code, rate_source)
VALUES (%s, %s, %s, 'XAU', %s)
ON CONFLICT (quote_currency_code, rate_date)
DO UPDATE SET
  rate_value  = EXCLUDED.rate_value,
  rate_source = EXCLUDED.rate_source,
  updated_at  = NOW();
"""

_FORWARD_FILL_SQL = f"""
WITH date_series AS (
    SELECT generate_series(%s::date, %s::date, '1 day'::interval)::date AS rate_date
),
gaps AS (
    SELECT d.rate_date, c.quote_currency_code
    FROM date_series d
    CROSS JOIN (SELECT DISTINCT quote_currency_code FROM {TABLE}) c
    WHERE NOT EXISTS (
        SELECT 1 FROM {TABLE} cr
        WHERE cr.quote_currency_code = c.quote_currency_code
          AND cr.rate_date = d.rate_date
    )
),
filled AS (
    SELECT
        g.rate_date,
        g.quote_currency_code,
        (
            SELECT cr.rate_value
            FROM {TABLE} cr
            WHERE cr.quote_currency_code = g.quote_currency_code
              AND cr.rate_date < g.rate_date
              AND cr.rate_source != 'forward_fill'
            ORDER BY cr.rate_date DESC
            LIMIT 1
        ) AS rate_value
    FROM gaps g
)
INSERT INTO {TABLE} (quote_currency_code, rate_date, rate_value, base_currency_code, rate_source)
SELECT quote_currency_code, rate_date, rate_value, 'XAU', 'forward_fill'
FROM filled
WHERE rate_value IS NOT NULL
ON CONFLICT (quote_currency_code, rate_date) DO NOTHING;
"""


def upsert_rates(client: Any, rows: list[tuple[str, date, float, str]]) -> None:
    with client.cursor() as cursor:
        cursor.executemany(_UPSERT_SQL, rows)
    client.commit()


def forward_fill_rates(client: Any, from_date: date, to_date: date) -> None:
    """Fill date gaps using last real close; skips dates that already have any row."""
    with client.cursor() as cursor:
        cursor.execute(_FORWARD_FILL_SQL, (from_date, to_date))
        filled = cursor.rowcount
    client.commit()
    logger.info(f"forward_fill_rates: from={from_date} to={to_date} rows_inserted={filled}")
