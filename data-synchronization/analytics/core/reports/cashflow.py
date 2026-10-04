"""Cash flow: income/expense/savings, waterfall, savings rate, income sources, daily spend."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from core import payload as p
from core.periods import days as day_range
from core.periods import month_starts
from core.reports import report
from core.reports.common import (
    OTHER,
    by_day,
    by_month,
    day_label,
    flows,
    group,
    in_period,
    month_label,
    net_worth_on,
    period_query_params,
    query,
    query_drill,
    row_query,
    start_of,
    top_with_other,
    total,
)
from core.reports.context import ReportContext


@report("00-earn-burn-rate")
def earn_burn(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    window = context.control("window")
    start, end = start_of(mart, period), min(period.end, mart.anchor)
    if start > end:
        return {"empty": {"text": "No data in this period."}}
    income = by_day(flows(mart, start - timedelta(days=window - 1), end, "income"))
    spend = by_day(flows(mart, start - timedelta(days=window - 1), end, "spend"))
    days = day_range(start, end)
    rolling = lambda daily, day: sum(daily.get(day - timedelta(days=offset), 0.0) for offset in range(window)) / window  # noqa: E731
    earn = [rolling(income, day) for day in days]
    burn = [rolling(spend, day) for day in days]
    save = [a - b for a, b in zip(earn, burn)]
    rate = save[-1] / earn[-1] * 100 if earn and earn[-1] > 0 else None
    return {
        "stat_cards": [
            p.stat("savings", "Savings / day", save[-1], "money2", tone="positive" if save[-1] >= 0 else "negative"),
            p.stat("income", "Income / day", earn[-1], "money2"),
            p.stat("expense", "Expense / day", burn[-1], "money2"),
            p.stat("rate", "Savings rate", rate, "percent"),
        ],
        "charts": [
            p.chart(
                "rates",
                "line",
                [day_label(day) for day in days],
                [
                    p.series("income", "Income", earn, "income"),
                    p.series("expense", "Expense", burn, "expense"),
                    p.series("savings", "Savings", save, "savings", fill="signed"),
                ],
                y_format="money2",
            )
        ],
        "notes": [p.text("Each point averages the {0} days up to that day.", {"value": window, "format": "days"})],
    }


@report("19-cashflow-waterfall")
def waterfall(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    start = start_of(mart, period)
    _, _, opening = net_worth_on(mart, start - timedelta(days=1))
    _, _, closing = net_worth_on(mart, period.end)
    opening = opening or 0.0
    closing = closing or 0.0
    income = total(in_period(mart, period, "income"))
    majors = top_with_other(group(in_period(mart, period, "spend"), lambda flow: flow.major_key, lambda flow: flow.major_label), 10)
    labels, data, tones, keys = ["Opening"], [[0.0, opening]], ["neutral"], [None]
    running = opening + income
    labels.append("Income")
    data.append([opening, running])
    tones.append("positive")
    keys.append(None)
    for key, label, value, _ in majors:
        labels.append(label)
        data.append([running, running - value])
        running -= value
        tones.append("negative")
        keys.append(None if key == OTHER else key)
    other = closing - running
    labels.append("Other movements")
    data.append([running, closing])
    tones.append("muted")
    keys.append(None)
    labels.append("Closing")
    data.append([0.0, closing])
    tones.append("primary")
    keys.append(None)
    return {
        "stat_cards": [
            p.stat("opening", "Opening net worth", opening, "money"),
            p.stat("income", "Income", income, "money"),
            p.stat("spend", "Spending", sum(item[2] for item in majors), "money"),
            p.stat("closing", "Closing net worth", closing, "money"),
        ],
        "charts": [
            p.chart(
                "waterfall",
                "waterfall",
                labels,
                [p.series("flow", "Cash flow", data, "palette", point_tones=tones)],
                drill=query_drill(
                    "major",
                    keys,
                    [None if key is None else query({**period_query_params(period), "major": key, "types": "money-out"}, "Transactions in this category") for key in keys],
                    "Open the transactions of a category",
                    "Totals have no transactions of their own.",
                ),
            )
        ],
        "notes": [p.text("Other movements ({0}) are transfers that change value between currencies and accounts that start tracking in the period.", p.money(other, "money_delta"))],
    }


@report("20-savings-rate")
def savings_rate(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    months = month_starts(start_of(mart, period), period.end)
    income = by_month(in_period(mart, period, "income"))
    spend = by_month(in_period(mart, period, "spend"))
    rates = [((income.get(month, 0.0) - spend.get(month, 0.0)) / income[month] * 100) if income.get(month, 0.0) > 0 else None for month in months]
    present = [(month, rate) for month, rate in zip(months, rates) if rate is not None]
    if not present:
        return {"empty": {"text": "No income in this period."}}
    best = max(present, key=lambda item: item[1])
    worst = min(present, key=lambda item: item[1])
    streak = 0
    for rate in reversed(rates):
        if rate is None or rate <= 0:
            break
        streak += 1
    labels = [month_label(month) for month in months]
    return {
        "stat_cards": [
            p.stat("average", "Average savings rate", sum(rate for _, rate in present) / len(present), "percent"),
            p.stat("best", "Best month", best[1], "percent", sub=p.text("{0}", {"value": best[0].isoformat()[:7], "format": "month"})),
            p.stat("worst", "Worst month", worst[1], "percent", sub=p.text("{0}", {"value": worst[0].isoformat()[:7], "format": "month"})),
            p.stat("streak", "Saving streak", streak, "count", sub=p.text("months in a row")),
        ],
        "charts": [
            p.chart(
                "rate",
                "mixed",
                labels,
                [
                    p.series("income", "Income", [income.get(month, 0.0) for month in months], "income", kind="bar"),
                    p.series("expense", "Spending", [spend.get(month, 0.0) for month in months], "expense", kind="bar"),
                    p.series("rate", "Savings rate", rates, "savings", kind="line", axis="y2"),
                ],
                y2_format="percent",
                ref_lines=[{"value": 0, "label": "", "tone": "muted", "axis": "y2"}],
            )
        ],
    }


def _source_key(flow: Any, tab: str) -> str:
    return (flow.payee or "Unknown source").lower() if tab == "source" else flow.major_key


@report("21-income-sources")
def income_sources(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    income = in_period(mart, period, "income")
    if not income:
        return {"empty": {"text": "No income in this period."}}
    if context.tab == "trend":
        months = month_starts(start_of(mart, period), period.end)
        monthly = by_month(income)
        return {
            "stat_cards": [p.stat("total", "Income", total(income), "money"), p.stat("monthly", "Monthly average", total(income) / len(months), "money")],
            "charts": [p.chart("trend", "line", [month_label(month) for month in months], [p.series("income", "Income", [monthly.get(month, 0.0) for month in months], "income")])],
        }
    tab = context.tab or "source"
    label = (lambda flow: flow.payee or "Unknown source") if tab == "source" else (lambda flow: flow.major_label)
    groups = top_with_other(group(income, lambda flow: _source_key(flow, tab), label), 8)
    whole = total(income)
    param = "source" if tab == "source" else "major"
    notes = []
    if groups and groups[0][2] / whole > 0.9:
        notes.append(p.text("{0} of income comes from one source.", {"value": groups[0][2] / whole * 100, "format": "percent"}) | {"tone": "warn"})
    return {
        "stat_cards": [p.stat("total", "Income", whole, "money"), p.stat("sources", "Sources", len(group(income, lambda flow: _source_key(flow, tab))), "count")],
        "charts": [p.chart("sources", "donut", [name for _, name, *_ in groups], [p.series("income", "Income", [value for _, _, value, _ in groups], "palette")])],
        "tables": [
            p.table(
                "sources",
                [p.column("name", "Source" if tab == "source" else "Category"), p.column("total", "Income", "money"), p.column("share", "Share", "progress")],
                [
                    p.row(
                        key,
                        {"name": name, "total": value, "share": value / whole * 100},
                        drill=None
                        if key == OTHER
                        else row_query(
                            param,
                            key,
                            {**period_query_params(period), "types": "money-in", ("counterparty" if tab == "source" else "major"): name if tab == "source" else key},
                            "Income from this source",
                        ),
                    )
                    for key, name, value, _ in groups
                ],
            )
        ],
        "notes": notes,
    }


def _daily(context: ReportContext, exclude_subscription: bool) -> dict[str, Any]:
    mart, period = context.mart, context.period
    start, end = start_of(mart, period), min(period.end, mart.anchor)
    days = day_range(start, end)
    spend = by_day(flows(mart, start, end, "spend", exclude_subscription=exclude_subscription))
    values = [spend.get(day, 0.0) for day in days]
    spend_days = [value for value in values if value > 0]
    if not spend_days:
        return {"empty": {"text": "No spending in this period."}}
    highest = max(range(len(values)), key=lambda index: values[index])
    params = period_query_params(period)
    return {
        "stat_cards": [
            p.stat("total", "Spending", sum(values), "money"),
            p.stat("days", "Days with spending", len(spend_days), "count"),
            p.stat("average", "Average per spending day", sum(values) / len(spend_days), "money"),
            p.stat("highest", "Highest day", values[highest], "money", sub=p.text("{0}", {"value": days[highest].isoformat(), "format": "date"})),
        ],
        "charts": [
            p.chart(
                "daily",
                "bar",
                [day_label(day) for day in days],
                [p.series("spend", "Spending", values, "expense", point_tones=["neutral" if value > 0 else "muted" for value in values])],
                drill=query_drill(
                    "date",
                    [day.isoformat() for day in days],
                    [
                        {**query({**params, "range": "custom", "from": day.isoformat(), "to": day.isoformat(), "types": "money-out"}, "That day's spending")} if values[index] > 0 else None
                        for index, day in enumerate(days)
                    ],
                    "Open that day's transactions",
                    "No spending that day.",
                ),
            )
        ],
    }


@report("29-daily-spend")
def daily_spend(context: ReportContext) -> dict[str, Any]:
    return _daily(context, False)


@report("30-daily-spend-no-payments")
def daily_spend_no_payments(context: ReportContext) -> dict[str, Any]:
    return _daily(context, True)
