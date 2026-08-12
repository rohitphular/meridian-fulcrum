from __future__ import annotations

from datetime import date
from typing import Any

from py_logging import get_logger

logger = get_logger(__name__)

_GET_FIAT_SQL = """
SELECT currency_code
FROM currency_master
WHERE currency_type = 'fiat'
  AND is_tracked = TRUE
ORDER BY data_last_fetched ASC NULLS FIRST, currency_rank ASC NULLS LAST;
"""

_UPDATE_LAST_FETCHED_SQL = """
UPDATE currency_master
SET data_last_fetched = %s
WHERE currency_code = %s;
"""


def get_fiat_currencies(client: Any) -> list[str]:
    """Return tracked fiat currency codes ordered by fetch priority.

    Never-fetched (NULL data_last_fetched) come first so they hit the API
    before any rate limit. Within the same staleness tier, currency_rank
    determines order.
    """
    with client.cursor() as cursor:
        cursor.execute(_GET_FIAT_SQL)
        return [row[0].strip() for row in cursor.fetchall()]


def update_last_fetched(client: Any, updates: dict[str, date]) -> None:
    """Set data_last_fetched to the max date fetched for each currency."""
    with client.cursor() as cursor:
        for code, last_date in updates.items():
            cursor.execute(_UPDATE_LAST_FETCHED_SQL, (last_date, code))
    client.commit()
    logger.info(f"update_last_fetched: currencies={sorted(updates.keys())}")
