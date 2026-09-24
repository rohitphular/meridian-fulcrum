"""Pace sequential Sheets requests and recover from bounded quota failures."""

import random
import time
from collections.abc import Callable
from typing import TypeVar

from gspread.exceptions import APIError
from py_logging import get_logger

logger = get_logger(__name__)

_MIN_REQUEST_INTERVAL_SECONDS = 1.25
_MAX_ATTEMPTS = 6
_INITIAL_RETRY_SECONDS = 5.0
_MAX_RETRY_SECONDS = 60.0
_Response = TypeVar("_Response")


class SheetsRequests:
    """Use one limiter per quota (reads and writes are separate); not thread-safe.

    Request starts are spaced to leave headroom below the per-user minute quota.
    A 429 can still occur when another process uses the same service account, so
    bounded exponential backoff allows a minute quota to refill before failing.
    Only retry idempotent operations through this helper.
    """

    def __init__(self) -> None:
        self._next_request_at = 0.0

    def _wait_for_slot(self) -> None:
        remaining = self._next_request_at - time.monotonic()
        while remaining > 0:
            time.sleep(remaining)
            remaining = self._next_request_at - time.monotonic()
        self._next_request_at = time.monotonic() + _MIN_REQUEST_INTERVAL_SECONDS

    def call(self, request: Callable[[], _Response]) -> _Response:
        attempt = 0
        while True:
            attempt += 1
            self._wait_for_slot()
            try:
                return request()
            except APIError as error:
                if error.response.status_code != 429:
                    raise
                if attempt == _MAX_ATTEMPTS:
                    logger.error(f"call: status=429 attempts={attempt} reason=sheets_api_rate_limit_exhausted")
                    raise RuntimeError("sheets_api_rate_limit_exhausted") from error
                delay = min(_MAX_RETRY_SECONDS, _INITIAL_RETRY_SECONDS * 2 ** (attempt - 1) + random.uniform(0, 1))
                logger.warning(f"call: status=429 attempt={attempt}/{_MAX_ATTEMPTS} retry_in_seconds={delay:.3f}")
                time.sleep(delay)
