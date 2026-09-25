from __future__ import annotations

from typing import Any

_JOB_LOCK_ID = 7348206526087654


def claim_job(client: Any) -> None:
    """Refuse overlapping daily/historical jobs; commit/rollback releases the lock."""
    with client.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", (_JOB_LOCK_ID,))
        acquired = cursor.fetchone()
    if acquired is None or acquired[0] is not True:
        raise RuntimeError("currency_rates_job_already_running")
