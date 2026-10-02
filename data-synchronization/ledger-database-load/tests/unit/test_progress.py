from unittest.mock import MagicMock

from database.progress import Progress


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _lines(logger: MagicMock) -> list[str]:
    return [call.args[0] for call in logger.info.call_args_list]


def test_logs_start_every_25_handled_rows_and_done_with_counts() -> None:
    logger, clock = MagicMock(), Clock()
    progress = Progress(logger, "upsert_transactions", 60, clock=clock)
    for index in range(55):
        clock.now += 1
        progress.record(succeeded=1) if index != 7 else progress.record(failed=1)
    progress.skip(5)
    progress.done()
    assert _lines(logger) == [
        "upsert_transactions: start total=60",
        "upsert_transactions: progress processed=25/60 succeeded=24 failed=1 skipped=0 elapsed_s=25",
        "upsert_transactions: progress processed=50/60 succeeded=49 failed=1 skipped=0 elapsed_s=50",
        "upsert_transactions: done processed=60/60 succeeded=54 failed=1 skipped=5 elapsed_s=55",
    ]


def test_slow_rows_log_at_least_every_30_seconds() -> None:
    logger, clock = MagicMock(), Clock()
    progress = Progress(logger, "upsert_categories", 10, clock=clock)
    for _ in range(3):
        clock.now += 31
        progress.record(succeeded=1)
    assert [line for line in _lines(logger) if ": progress " in line] == [
        "upsert_categories: progress processed=1/10 succeeded=1 failed=0 skipped=0 elapsed_s=31",
        "upsert_categories: progress processed=2/10 succeeded=2 failed=0 skipped=0 elapsed_s=62",
        "upsert_categories: progress processed=3/10 succeeded=3 failed=0 skipped=0 elapsed_s=93",
    ]


def test_skipped_in_sync_rows_never_trigger_a_progress_line() -> None:
    logger = MagicMock()
    progress = Progress(logger, "upsert_accounts", 500)
    progress.skip(500)
    progress.done()
    assert len(_lines(logger)) == 2
    assert _lines(logger)[-1].startswith("upsert_accounts: done processed=500/500 succeeded=0 failed=0 skipped=500")
