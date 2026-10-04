"""Report periods, anchored to the run's UTC date (inclusive of it).

The same rules the app used (expense-tracker ledgerPeriodBounds), in UTC: last_N days end
today; weeks start on Monday; last_N months are N calendar months ending with the current
month to date; to-date periods compare with the same number of elapsed days of the period
before; a fixed range compares with the equal span just before it; `all` has no compare.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta

LABELS = {
    "this_week": "This week",
    "last_week": "Last week",
    "last_7": "Last 7 days",
    "last_30": "Last 30 days",
    "last_60": "Last 60 days",
    "last_90": "Last 90 days",
    "this_month": "This month",
    "last_month": "Last month",
    "last_3": "Last 3 months",
    "last_6": "Last 6 months",
    "last_12": "Last 12 months",
    "this_quarter": "This quarter",
    "last_quarter": "Last quarter",
    "ytd": "Year to date",
    "last_year": "Last year",
    "all": "All time",
    "fixed": "Fixed dates",
}
_DAY_WINDOWS = {"last_7": 7, "last_30": 30, "last_60": 60, "last_90": 90}
_MONTH_WINDOWS = {"last_3": 3, "last_6": 6, "last_12": 12}


@dataclass(frozen=True)
class Period:
    key: str
    label: str
    start: date | None  # None = from the beginning (all)
    end: date
    compare_start: date | None
    compare_end: date | None

    @property
    def days(self) -> int | None:
        return None if self.start is None else (self.end - self.start).days + 1

    def contains(self, day: date) -> bool:
        return (self.start is None or day >= self.start) and day <= self.end

    def as_payload(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "from": _iso(self.start),
            "to": self.end.isoformat(),
            "days": self.days,
            "compare_from": _iso(self.compare_start),
            "compare_to": _iso(self.compare_end),
        }


def _iso(value: date | None) -> str | None:
    return None if value is None else value.isoformat()


def add_months(day: date, months: int) -> date:
    """The first of the month `months` away from `day`'s month."""
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def month_end(day: date) -> date:
    return date(day.year, day.month, calendar.monthrange(day.year, day.month)[1])


def shift_year(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # 29 Feb → 28 Feb
        return day.replace(year=day.year + years, day=28)


def _same_elapsed(compare_start: date, days: int, limit: date) -> date:
    return min(compare_start + timedelta(days=days - 1), limit)


def resolve(key: str, anchor: date, fixed_from: date | None = None, fixed_to: date | None = None) -> Period:
    if key not in LABELS:
        raise ValueError(f"unknown_period:{key}")
    start: date | None = None
    end = anchor
    compare_start: date | None = None
    compare_end: date | None = None
    if key in _DAY_WINDOWS:
        start = anchor - timedelta(days=_DAY_WINDOWS[key] - 1)
    elif key in ("this_week", "last_week"):
        monday = anchor - timedelta(days=anchor.weekday())
        start, end = (monday, anchor) if key == "this_week" else (monday - timedelta(days=7), monday - timedelta(days=1))
        compare_start, compare_end = start - timedelta(days=7), end - timedelta(days=7)
    elif key in ("this_month", "last_month"):
        start = add_months(anchor, 0 if key == "this_month" else -1)
        end = anchor if key == "this_month" else month_end(start)
        compare_start = add_months(start, -1)
        compare_end = _same_elapsed(compare_start, (end - start).days + 1, month_end(compare_start)) if key == "this_month" else month_end(compare_start)
    elif key in _MONTH_WINDOWS:
        months = _MONTH_WINDOWS[key]
        start = add_months(anchor, -(months - 1))
        compare_start, compare_end = add_months(start, -months), start - timedelta(days=1)
    elif key in ("this_quarter", "last_quarter"):
        quarter_start = add_months(anchor, -((anchor.month - 1) % 3))
        start, end = (quarter_start, anchor) if key == "this_quarter" else (add_months(quarter_start, -3), quarter_start - timedelta(days=1))
        compare_start = add_months(start, -3)
        compare_end = _same_elapsed(compare_start, (end - start).days + 1, start - timedelta(days=1)) if key == "this_quarter" else start - timedelta(days=1)
    elif key in ("ytd", "last_year"):
        year = anchor.year if key == "ytd" else anchor.year - 1
        start = date(year, 1, 1)
        end = anchor if key == "ytd" else date(year, 12, 31)
        compare_start = date(year - 1, 1, 1)
        compare_end = _same_elapsed(compare_start, (end - start).days + 1, date(year - 1, 12, 31)) if key == "ytd" else date(year - 1, 12, 31)
    elif key == "fixed":
        if fixed_from is None or fixed_to is None or fixed_from > fixed_to:
            raise ValueError("invalid_period_dates")
        start, end = fixed_from, fixed_to
    if start is not None and compare_start is None:
        days = (end - start).days + 1
        compare_end = start - timedelta(days=1)
        compare_start = compare_end - timedelta(days=days - 1)
    return Period(key, LABELS[key], start, end, compare_start, compare_end)


def compared(period: Period, mode: str) -> Period | None:
    """The period to compare with: previous (the period's own compare range), last_year, or none."""
    if mode == "none" or period.start is None:
        return None
    if mode == "previous":
        assert period.compare_start is not None and period.compare_end is not None
        return Period(period.key, "Previous period", period.compare_start, period.compare_end, None, None)
    if mode == "last_year":
        return Period(period.key, "Same period last year", shift_year(period.start, -1), shift_year(period.end, -1), None, None)
    raise ValueError(f"invalid_compare_mode:{mode}")


def days(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def month_starts(start: date, end: date) -> list[date]:
    out, current = [], add_months(start, 0)
    while current <= end:
        out.append(current)
        current = add_months(current, 1)
    return out


def week_starts(start: date, end: date) -> list[date]:
    current = start - timedelta(days=start.weekday())
    out = []
    while current <= end:
        out.append(current)
        current += timedelta(days=7)
    return out
