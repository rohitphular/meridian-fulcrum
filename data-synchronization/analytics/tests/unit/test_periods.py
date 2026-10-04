from datetime import date

import pytest

from core.periods import compared, resolve

ANCHOR = date(2026, 10, 4)  # a Sunday


@pytest.mark.parametrize(
    "key,start,end,compare_start,compare_end",
    [
        ("last_7", "2026-09-28", "2026-10-04", "2026-09-21", "2026-09-27"),
        ("last_30", "2026-09-05", "2026-10-04", "2026-08-06", "2026-09-04"),
        ("this_week", "2026-09-28", "2026-10-04", "2026-09-21", "2026-09-27"),
        ("last_week", "2026-09-21", "2026-09-27", "2026-09-14", "2026-09-20"),
        ("this_month", "2026-10-01", "2026-10-04", "2026-09-01", "2026-09-04"),
        ("last_month", "2026-09-01", "2026-09-30", "2026-08-01", "2026-08-31"),
        ("last_3", "2026-08-01", "2026-10-04", "2026-05-01", "2026-07-31"),
        ("last_12", "2025-11-01", "2026-10-04", "2024-11-01", "2025-10-31"),
        ("this_quarter", "2026-10-01", "2026-10-04", "2026-07-01", "2026-07-04"),
        ("last_quarter", "2026-07-01", "2026-09-30", "2026-04-01", "2026-06-30"),
        ("ytd", "2026-01-01", "2026-10-04", "2025-01-01", "2025-10-04"),
        ("last_year", "2025-01-01", "2025-12-31", "2024-01-01", "2024-12-31"),
    ],
)
def test_presets_are_inclusive_of_the_anchor_and_compare_like_the_app(key: str, start: str, end: str, compare_start: str, compare_end: str) -> None:
    period = resolve(key, ANCHOR)
    assert [period.start.isoformat(), period.end.isoformat(), period.compare_start.isoformat(), period.compare_end.isoformat()] == [start, end, compare_start, compare_end]


def test_all_has_no_start_and_no_compare() -> None:
    period = resolve("all", ANCHOR)
    assert (period.start, period.days, compared(period, "previous")) == (None, None, None)


def test_fixed_ranges_compare_with_the_equal_span_before_and_last_year() -> None:
    period = resolve("fixed", ANCHOR, date(2026, 3, 1), date(2026, 3, 10))
    assert (period.compare_start, period.compare_end) == (date(2026, 2, 19), date(2026, 2, 28))
    assert compared(period, "last_year").start == date(2025, 3, 1)
    with pytest.raises(ValueError, match="invalid_period_dates"):
        resolve("fixed", ANCHOR, date(2026, 3, 10), date(2026, 3, 1))


def test_leap_day_last_year_falls_back_to_the_28th() -> None:
    period = resolve("fixed", ANCHOR, date(2024, 2, 29), date(2024, 2, 29))
    assert compared(period, "last_year").start == date(2023, 2, 28)
