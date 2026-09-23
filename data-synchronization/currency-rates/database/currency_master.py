from __future__ import annotations

from datetime import date
from typing import Any

from py_logging import get_logger

from database.models.currency_master import TABLE

logger = get_logger(__name__)

_GET_CURRENCIES_SQL = f"""
SELECT currency_code
FROM {TABLE}
WHERE currency_type = %s
  AND is_tracked = TRUE
ORDER BY last_fetched_date ASC NULLS FIRST, currency_rank ASC NULLS LAST;
"""

_UPDATE_LAST_FETCHED_SQL = f"""
UPDATE {TABLE}
SET last_fetched_date = GREATEST(last_fetched_date, %s)
WHERE currency_code = %s;
"""


def get_currencies(client: Any, currency_type: str) -> list[str]:
    """Return tracked codes ordered by oldest source date (null first), then rank."""
    with client.cursor() as cursor:
        cursor.execute(_GET_CURRENCIES_SQL, (currency_type,))
        return [row[0].strip() for row in cursor.fetchall()]


def update_last_fetched(client: Any, updates: dict[str, date]) -> None:
    """Advance source-date watermarks without regressing them on historical imports."""
    with client.cursor() as cursor:
        for code, last_date in updates.items():
            cursor.execute(_UPDATE_LAST_FETCHED_SQL, (last_date, code))
    logger.info(f"update_last_fetched: currencies={sorted(updates.keys())}")
