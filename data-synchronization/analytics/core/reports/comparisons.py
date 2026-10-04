"""Comparisons: month on month, year on year, week on week, quarter / year to date, last 12 months, last 8 weeks.

The transactions tab compares spending; the accounts tab compares the asset total
(asset + investment accounts) on each day.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from core import payload as p
from core.periods import add_months, month_end, shift_year
from core.periods import days as day_range
from core.reports import report
from core.reports.common import assets_on, by_day, by_month, by_week, flows, month_ends, month_label
from core.reports.context import ReportContext

_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _cumulative(values: list[float]) -> list[float]:
    out, running = [], 0.0
    for value in values:
        running += value
        out.append(running)
    return out


def _daily_spend(context: ReportContext, start: date, end: date) -> list[float]:
    spend = by_day(flows(context.mart, start, end, "spend"))
    return [spend.get(day, 0.0) for day in day_range(start, end)]


def _daily_assets(context: ReportContext, start: date, end: date) -> list[float | None]:
    return [assets_on(context.mart, day) if day <= context.anchor else None for day in day_range(start, end)]


def _stats(current: float, previous: float, extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
    change = current - previous
    return [
        p.stat("current", "This period", current, "money"),
        p.stat("previous", "Compared period", previous, "money"),
        p.stat("change", "Change", change, "money_delta", sub=p.text("{0}", {"value": change / previous * 100 if previous else None, "format": "percent_delta"})),
        *extra,
    ]


def _pair(context: ReportContext, a_start: date, a_end: date, b_start: date, b_end: date, labels: list[str], cumulative: bool, title_a: str, title_b: str) -> dict[str, Any]:
    """Two aligned daily series (A = this period, B = the compared one), spending or assets."""
    elapsed = min((min(a_end, context.anchor) - a_start).days + 1, (a_end - a_start).days + 1)
    if context.tab == "accounts":
        a = _daily_assets(context, a_start, a_end)
        b = _daily_assets(context, b_start, b_end)
        last_a = next((value for value in reversed(a[:elapsed]) if value is not None), 0.0)
        last_b = b[min(elapsed, len(b)) - 1] if b else 0.0
        stats = _stats(last_a or 0.0, last_b or 0.0, [p.stat("days", "Days in", elapsed, "days")])
    else:
        a_raw, b_raw = _daily_spend(context, a_start, a_end), _daily_spend(context, b_start, b_end)
        a = _cumulative(a_raw) if cumulative else a_raw
        b = _cumulative(b_raw) if cumulative else b_raw
        a = [value if index < elapsed else None for index, value in enumerate(a)]
        stats = _stats(sum(a_raw[:elapsed]), sum(b_raw[:elapsed]), [p.stat("days", "Days in", elapsed, "days")])
    length = len(labels)
    a = (a + [None] * length)[:length]
    b = (b + [None] * length)[:length]
    return {
        "stat_cards": stats,
        "charts": [p.chart("compare", "line", labels, [p.series("current", title_a, a, "primary"), p.series("previous", title_b, b, "compare", dashed=True)])],
    }


@report("01-mom-cumulative")
def month_on_month(context: ReportContext) -> dict[str, Any]:
    start = context.period.start
    end = month_end(start)
    previous = add_months(start, -1)
    length = max((end - start).days, (month_end(previous) - previous).days) + 1
    return _pair(context, start, end, previous, month_end(previous), [str(day) for day in range(1, length + 1)], True, month_label(start), month_label(previous))


@report("02-yoy-monthly")
def year_on_year(context: ReportContext) -> dict[str, Any]:
    period = context.period
    start, end = period.start, period.end
    if (end - start).days < 31 and start.month == end.month:
        last_year = shift_year(start, -1)
        days = (month_end(start) - start).days + 1
        return _pair(context, start, month_end(start), last_year, month_end(last_year), [str(day) for day in range(1, days + 1)], True, str(start.year), str(last_year.year))
    months = []
    current = start.replace(day=1)
    while current <= end:
        months.append(current)
        current = add_months(current, 1)
    labels = [month_label(month) for month in months]
    if context.tab == "accounts":
        now = [assets_on(context.mart, min(month_end(month), context.anchor)) if month <= context.anchor else None for month in months]
        before = [assets_on(context.mart, month_end(shift_year(month, -1))) for month in months]
        current_value = next((value for value in reversed(now) if value is not None), 0.0)
        previous_value = before[len([value for value in now if value is not None]) - 1] if any(value is not None for value in now) else 0.0
    else:
        spend = by_month(flows(context.mart, start, end, "spend"))
        prior = by_month(flows(context.mart, shift_year(start, -1), shift_year(end, -1), "spend"))
        now = [spend.get(month, 0.0) for month in months]
        before = [prior.get(shift_year(month, -1), 0.0) for month in months]
        current_value, previous_value = sum(now), sum(before)
    return {
        "stat_cards": _stats(current_value or 0.0, previous_value or 0.0, []),
        "charts": [
            p.chart(
                "compare", "bar" if context.tab != "accounts" else "line", labels, [p.series("current", str(start.year), now, "primary"), p.series("previous", str(start.year - 1), before, "compare")]
            )
        ],
    }


@report("03-wow-daily")
def week_on_week(context: ReportContext) -> dict[str, Any]:
    start = context.period.start
    labels = [_WEEKDAYS[(start + timedelta(days=offset)).weekday()] for offset in range(7)]
    return _pair(context, start, start + timedelta(days=6), start - timedelta(days=7), start - timedelta(days=1), labels, False, "This week", "Week before")


@report("04-qtd-comparison")
def quarter_to_date(context: ReportContext) -> dict[str, Any]:
    period = context.period
    start = period.start
    end = add_months(start, 3) - timedelta(days=1)
    previous = add_months(start, -3)
    length = (end - start).days + 1
    return _pair(context, start, end, previous, start - timedelta(days=1), [f"Day {day}" for day in range(1, length + 1)], True, "This quarter", "Previous quarter")


@report("05-ytd-comparison")
def year_to_date(context: ReportContext) -> dict[str, Any]:
    period = context.period
    year = period.start.year
    end_month = period.end.month
    months = [date(year, month, 1) for month in range(1, end_month + 1)]
    labels = [month_label(month)[:3] for month in months]
    if context.tab == "accounts":
        now = [assets_on(context.mart, min(month_end(month), context.anchor)) for month in months]
        before = [assets_on(context.mart, month_end(shift_year(month, -1))) for month in months]
        current_value, previous_value = (now[-1] or 0.0), (before[-1] or 0.0)
    else:
        spend = by_month(flows(context.mart, date(year, 1, 1), period.end, "spend"))
        prior = by_month(flows(context.mart, date(year - 1, 1, 1), shift_year(period.end, -1), "spend"))
        now = _cumulative([spend.get(month, 0.0) for month in months])
        before = _cumulative([prior.get(shift_year(month, -1), 0.0) for month in months])
        current_value, previous_value = now[-1], before[-1]
    return {
        "stat_cards": _stats(current_value, previous_value, []),
        "charts": [p.chart("compare", "line", labels, [p.series("current", str(year), now, "primary"), p.series("previous", str(year - 1), before, "compare", dashed=True)])],
    }


@report("06-last-12-months")
def last_12_months(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    start = add_months(mart.anchor, -11)
    months = [add_months(start, offset) for offset in range(12)]
    labels = [month_label(month) + ("*" if month == mart.anchor.replace(day=1) else "") for month in months]
    if context.tab == "accounts":
        subtypes: dict[str, str] = {}
        for account in mart.live_accounts():
            if account.type in ("asset", "investment"):
                subtypes[account.subtype] = account.subtype_label
        ends = month_ends(start, mart.anchor)
        series = []
        for index, (subtype, label) in enumerate(sorted(subtypes.items(), key=lambda item: item[1])):
            values = []
            for day in ends:
                present = [mart.balance_xau(account.id, day) for account in mart.live_accounts() if account.subtype == subtype and account.type in ("asset", "investment")]
                present = [value for value in present if value is not None]
                values.append(sum(present) if present else None)
            series.append(p.series(subtype, label, values, f"palette:{index}"))
        last = sum(item["data"][-1] or 0.0 for item in series)
        return {"stat_cards": [p.stat("assets", "Assets now", last, "money")], "charts": [p.chart("assets", "stacked", labels, series)], "notes": [p.text("* the current month, to date")]}
    income = by_month(flows(mart, start, mart.anchor, "income"))
    spend = by_month(flows(mart, start, mart.anchor, "spend"))
    inc = [income.get(month, 0.0) for month in months]
    exp = [spend.get(month, 0.0) for month in months]
    net = [a - b for a, b in zip(inc, exp)]
    return {
        "stat_cards": [
            p.stat("income", "Income", sum(inc), "money"),
            p.stat("expense", "Spending", sum(exp), "money"),
            p.stat("net", "Net", sum(net), "money_delta", tone="positive" if sum(net) >= 0 else "negative"),
            p.stat("average", "Average spend / month", sum(exp) / 12, "money"),
        ],
        "charts": [
            p.chart(
                "months",
                "mixed",
                labels,
                [
                    p.series("income", "Income", inc, "income", kind="bar"),
                    p.series("expense", "Spending", exp, "expense", kind="bar"),
                    p.series("net", "Net", net, "savings", kind="line"),
                ],
            )
        ],
        "notes": [p.text("* the current month, to date")],
    }


@report("07-last-8-weeks")
def last_8_weeks(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    monday = mart.anchor - timedelta(days=mart.anchor.weekday())
    weeks = [monday - timedelta(days=7 * offset) for offset in range(7, -1, -1)]
    income = by_week(flows(mart, weeks[0], mart.anchor, "income"))
    spend = by_week(flows(mart, weeks[0], mart.anchor, "spend"))
    inc = [income.get(week, 0.0) for week in weeks]
    exp = [spend.get(week, 0.0) for week in weeks]
    return {
        "stat_cards": [p.stat("income", "Income", sum(inc), "money"), p.stat("expense", "Spending", sum(exp), "money"), p.stat("average", "Average spend / week", sum(exp) / 8, "money")],
        "charts": [p.chart("weeks", "bar", [f"W{week.isocalendar().week}" for week in weeks], [p.series("income", "Income", inc, "income"), p.series("expense", "Spending", exp, "expense")])],
    }
