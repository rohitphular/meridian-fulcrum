from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from py_logging import get_logger

from database.models.currency_rates import TABLE

logger = get_logger(__name__)

_UPSERT_SQL = f"""
INSERT INTO {TABLE} (quote_currency_code, rate_date, rate_value, base_currency_code, rate_source)
VALUES (%s, %s, %s, 'XAU', %s)
ON CONFLICT (quote_currency_code, rate_date)
DO UPDATE SET rate_value = EXCLUDED.rate_value,
  rate_source = EXCLUDED.rate_source, updated_at = NOW();
"""

_FORWARD_FILL_SQL = f"""
WITH date_series AS (
    SELECT generate_series(%s::date, %s::date, '1 day'::interval)::date AS rate_date
), candidates AS (
    SELECT d.rate_date, c.currency_code AS quote_currency_code
    FROM date_series d
    CROSS JOIN public.currency_master c
    LEFT JOIN {TABLE} existing
      ON existing.quote_currency_code = c.currency_code AND existing.rate_date = d.rate_date
    WHERE c.currency_code = ANY(%s)
      AND c.is_tracked = TRUE AND c.currency_type = 'fiat'
      AND (existing.id IS NULL OR existing.rate_source = 'forward_fill')
), filled AS (
    SELECT candidates.*, previous.rate_value
    FROM candidates
    CROSS JOIN LATERAL (
        SELECT cr.rate_value FROM {TABLE} cr
        WHERE cr.quote_currency_code = candidates.quote_currency_code
          AND cr.rate_date < candidates.rate_date AND cr.rate_source != 'forward_fill'
        ORDER BY cr.rate_date DESC LIMIT 1
    ) previous
)
INSERT INTO {TABLE} (quote_currency_code, rate_date, rate_value, base_currency_code, rate_source)
SELECT quote_currency_code, rate_date, rate_value, 'XAU', 'forward_fill' FROM filled
ON CONFLICT (quote_currency_code, rate_date) DO UPDATE
SET rate_value = EXCLUDED.rate_value, updated_at = NOW()
WHERE {TABLE}.rate_source = 'forward_fill'
  AND {TABLE}.rate_value IS DISTINCT FROM EXCLUDED.rate_value;
"""


def upsert_rates(client: Any, rows: list[tuple[str, date, Decimal, str]]) -> None:
    """Validate the whole batch before writing. The caller owns the transaction."""
    validated = []
    for code, rate_date, rate, source in rows:
        if len(code) != 3 or not code.isascii() or not code.isalpha() or code != code.upper():
            raise ValueError("invalid_currency_code")
        if type(rate_date) is not date or source not in {"yfinance", "stooq", "synthetic"}:
            raise ValueError("invalid_rate_metadata")
        if not isinstance(rate, Decimal) or not rate.is_finite() or rate <= 0:
            raise ValueError("invalid_rate_value")
        try:
            rounded = rate.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
        except InvalidOperation as error:
            raise ValueError("rate_outside_storage_precision") from error
        if rounded <= 0 or rounded >= Decimal("100000000000"):
            raise ValueError("rate_outside_storage_precision")
        if code == "XAU" and rate != Decimal(1):
            raise ValueError("invalid_xau_identity_rate")
        validated.append((code, rate_date, rounded, source))
    if validated:
        with client.cursor() as cursor:
            cursor.executemany(_UPSERT_SQL, validated)


def forward_fill_rates(client: Any, from_date: date, to_date: date, currency_codes: list[str]) -> None:
    """Refresh derived fiat rates only; never fill crypto or overwrite real closes."""
    if from_date > to_date:
        raise ValueError("invalid_date_range")
    if not currency_codes:
        return
    with client.cursor() as cursor:
        cursor.execute(_FORWARD_FILL_SQL, (from_date, to_date, currency_codes))
        filled = cursor.rowcount
    logger.info(f"forward_fill_rates: from={from_date} to={to_date} rows_changed={filled}")
