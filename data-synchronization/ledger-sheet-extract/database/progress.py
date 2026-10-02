from __future__ import annotations

import time
from collections.abc import Callable
from logging import Logger


class Progress:
    """Start, periodic progress and done log lines for a row-by-row entity loop.

    Rows commit one at a time (each after a source re-check), so long tabs take minutes.
    A progress line is logged every `every` handled rows or `interval_s` seconds,
    whichever comes first. Skipped (already in-sync) rows count but never trigger a line.
    """

    def __init__(self, logger: Logger, label: str, total: int, *, every: int = 25, interval_s: float = 30.0, clock: Callable[[], float] = time.monotonic) -> None:
        self._logger = logger
        self._label = label
        self._total = total
        self._every = every
        self._interval_s = interval_s
        self._clock = clock
        self._started = self._last = clock()
        self._handled_since_line = 0
        self.succeeded = self.failed = self.skipped = 0
        logger.info(f"{label}: start total={total}")

    def _counts(self) -> str:
        processed = self.succeeded + self.failed + self.skipped
        return f"processed={processed}/{self._total} succeeded={self.succeeded} failed={self.failed} skipped={self.skipped} elapsed_s={self._clock() - self._started:.0f}"

    def skip(self, rows: int = 1) -> None:
        self.skipped += rows

    def record(self, *, succeeded: int = 0, failed: int = 0) -> None:
        self.succeeded += succeeded
        self.failed += failed
        self._handled_since_line += succeeded + failed
        now = self._clock()
        if self._handled_since_line >= self._every or now - self._last >= self._interval_s:
            self._logger.info(f"{self._label}: progress {self._counts()}")
            self._handled_since_line = 0
            self._last = now

    def done(self) -> None:
        self._logger.info(f"{self._label}: done {self._counts()}")
