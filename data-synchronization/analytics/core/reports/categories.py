"""Categories and tags: breakdowns, trends, top categories and drill-downs."""

from __future__ import annotations

from typing import Any

from core import payload as p
from core.mart import Flow
from core.periods import month_starts
from core.reports import report
from core.reports.common import OTHER, by_month, group, in_period, month_label, period_query_params, query, query_drill, row_query, start_of, top_with_other, total
from core.reports.context import ReportContext

UNTAGGED = "untagged"


def _majors(flows: list[Flow]) -> list[tuple[str, str, float, int]]:
    return group(flows, lambda flow: flow.major_key, lambda flow: flow.major_label)


@report("08-category-pie")
def category_pie(context: ReportContext) -> dict[str, Any]:
    period = context.period
    spend = in_period(context.mart, period, "spend")
    if not spend:
        return {"empty": {"text": "No spending in this period."}}
    whole = total(spend)
    majors = top_with_other(_majors(spend), 7)
    minors = group(spend, lambda flow: f"{flow.major_key}|{flow.minor_key}", lambda flow: f"{flow.major_label} › {flow.minor_label}")[:10]
    params = period_query_params(period)
    queries = [None if key == OTHER else query({**params, "major": key, "types": "money-out"}, "Transactions in this category") for key, *_ in majors]
    return {
        "stat_cards": [
            p.stat("total", "Spending", whole, "money"),
            p.stat("categories", "Categories", len(_majors(spend)), "count"),
            p.stat("top", "Largest category", majors[0][2] / whole * 100, "percent", sub=majors[0][1]),
        ],
        "charts": [
            p.chart(
                "categories",
                "donut",
                [label for _, label, *_ in majors],
                [p.series("spend", "Spending", [value for _, _, value, _ in majors], "palette")],
                drill=query_drill("major", [None if key == OTHER else key for key, *_ in majors], queries, "Open a category's transactions", "Other groups the smaller categories."),
            )
        ],
        "tables": [
            p.table(
                "majors",
                [p.column("category", "Category"), p.column("total", "Spending", "money"), p.column("share", "Share", "progress")],
                [p.row(key, {"category": label, "total": value, "share": value / whole * 100}) for key, label, value, _ in majors],
                title="By category",
            ),
            p.table(
                "minors",
                [p.column("category", "Sub-category"), p.column("count", "Transactions", "count"), p.column("total", "Spending", "money")],
                [
                    p.row(
                        key,
                        {"category": label, "count": count, "total": value},
                        drill=row_query("minor", key, {**params, "major": key.split("|")[0], "minor": key.split("|")[1]}, "Transactions in this sub-category"),
                    )
                    for key, label, value, count in minors
                ],
                title="Top sub-categories",
            ),
        ],
    }


@report("09-category-trend")
def category_trend(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    spend = in_period(mart, period, "spend")
    if not spend:
        return {"empty": {"text": "No spending in this period."}}
    months = month_starts(start_of(mart, period), period.end)
    majors = _majors(spend)
    series = []
    for index, (key, label, _, _) in enumerate(majors):
        monthly = by_month(flow for flow in spend if flow.major_key == key)
        series.append(p.series(key, label, [monthly.get(month, 0.0) for month in months], f"palette:{index}"))
    totals = by_month(spend)
    peak = max(months, key=lambda month: totals.get(month, 0.0))
    return {
        "stat_cards": [
            p.stat("total", "Spending", total(spend), "money"),
            p.stat("monthly", "Monthly average", total(spend) / len(months), "money"),
            p.stat("peak", "Peak month", totals.get(peak, 0.0), "money", sub=p.text("{0}", {"value": peak.isoformat()[:7], "format": "month"})),
            p.stat("categories", "Categories", len(majors), "count"),
        ],
        "charts": [p.chart("trend", "stacked", [month_label(month) for month in months], series)],
    }


@report("10-top-categories")
def top_categories(context: ReportContext) -> dict[str, Any]:
    mart, period, compare = context.mart, context.period, context.compare
    now = {
        key: (label, value)
        for key, label, value, _ in group(in_period(mart, period, "spend"), lambda flow: f"{flow.major_key}|{flow.minor_key}", lambda flow: f"{flow.major_label} › {flow.minor_label}")
    }
    before = (
        {}
        if compare is None
        else {
            key: (label, value)
            for key, label, value, _ in group(in_period(mart, compare, "spend"), lambda flow: f"{flow.major_key}|{flow.minor_key}", lambda flow: f"{flow.major_label} › {flow.minor_label}")
        }
    )
    if not now:
        return {"empty": {"text": "No spending in this period."}}
    keys = sorted(set(now) | set(before), key=lambda key: (-now.get(key, ("", 0.0))[1], key))[:10]
    labels = [(now.get(key) or before[key])[0] for key in keys]
    current = [now.get(key, ("", 0.0))[1] for key in keys]
    previous = [before.get(key, ("", 0.0))[1] for key in keys]
    rows = [p.row(key, {"category": label, "current": a, "previous": b, "change": a - b}, tone="negative" if a > b else "positive") for key, label, a, b in zip(keys, labels, current, previous)]
    return {
        "stat_cards": [p.stat("current", "This period", sum(value for _, value in now.values()), "money"), p.stat("previous", "Previous period", sum(value for _, value in before.values()), "money")],
        "charts": [p.chart("top", "hbar", labels, [p.series("current", "This period", current, "primary"), p.series("previous", "Previous period", previous, "compare")])],
        "tables": [
            p.table(
                "changes", [p.column("category", "Category"), p.column("current", "This period", "money"), p.column("previous", "Previous", "money"), p.column("change", "Change", "money_delta")], rows
            )
        ],
    }


def _drilldown_drills(context: ReportContext) -> list[str]:
    return [f"major:{key}" for key, *_ in _majors(in_period(context.mart, context.period, "spend"))]


@report("11-category-drilldown", drills=_drilldown_drills)
def category_drilldown(context: ReportContext) -> dict[str, Any]:
    period = context.period
    spend = in_period(context.mart, period, "spend")
    params = period_query_params(period)
    if context.drill:
        major = context.drill["major"]
        selected = [flow for flow in spend if flow.major_key == major]
        minors = group(selected, lambda flow: flow.minor_key, lambda flow: flow.minor_label)
        label = selected[0].major_label if selected else major
        return {
            "stat_cards": [p.stat("total", label, total(selected), "money")],
            "charts": [
                p.chart(
                    "minors",
                    "hbar",
                    [name for _, name, *_ in minors],
                    [p.series("spend", "Spending", [value for _, _, value, _ in minors], "expense")],
                    drill=query_drill(
                        "minor",
                        [key for key, *_ in minors],
                        [query({**params, "major": major, "minor": key}, "Transactions in this sub-category") for key, *_ in minors],
                        "Open a sub-category's transactions",
                    ),
                )
            ],
            "breadcrumbs": [{"label": "All categories", "drill": None}, {"label": label, "drill": {"major": major}}],
        }
    majors = _majors(spend)
    if not majors:
        return {"empty": {"text": "No spending in this period."}}
    return {
        "stat_cards": [p.stat("total", "Spending", total(spend), "money")],
        "charts": [
            p.chart(
                "majors",
                "hbar",
                [label for _, label, *_ in majors],
                [p.series("spend", "Spending", [value for _, _, value, _ in majors], "expense")],
                drill={"param": "major", "values": [key for key, *_ in majors], "mode": "replace", "hint": "Open a category"},
            )
        ],
        "breadcrumbs": [{"label": "All categories", "drill": None}],
    }


def _tag_shares(flows: list[Flow]) -> list[tuple[str, Flow, float]]:
    """(tag, flow, share of the amount): split equally across a row's tags."""
    out = []
    for flow in flows:
        for tag in flow.tags:
            out.append((tag, flow, flow.amount_xau / len(flow.tags)))
    return out


def _tag_groups(shares: list[tuple[str, Flow, float]]) -> list[tuple[str, float, int]]:
    totals: dict[str, list[Any]] = {}
    for tag, _, amount in shares:
        entry = totals.setdefault(tag, [0.0, 0])
        entry[0] += amount
        entry[1] += 1
    return sorted(((tag, value, count) for tag, (value, count) in totals.items()), key=lambda item: (-item[1], item[0]))


@report("12-tag-pie")
def tag_pie(context: ReportContext) -> dict[str, Any]:
    period = context.period
    spend = in_period(context.mart, period, "spend")
    shares = _tag_shares(spend)
    untagged = total(flow for flow in spend if not flow.tags)
    if not shares:
        return {"empty": {"text": "No tagged spending in this period."}, "stat_cards": [p.stat("untagged", "Untagged spending", untagged, "money")]}
    groups = _tag_groups(shares)
    top = groups[:7]
    if len(groups) - 7 >= 2:
        rest = groups[7:]
        top = [*top, (OTHER, sum(item[1] for item in rest), sum(item[2] for item in rest))]
    params = period_query_params(period)
    return {
        "stat_cards": [
            p.stat("tagged", "Tagged spending", sum(item[1] for item in groups), "money"),
            p.stat("untagged", "Untagged spending", untagged, "money"),
            p.stat("tags", "Tags", len(groups), "count"),
        ],
        "charts": [
            p.chart(
                "tags",
                "donut",
                [tag for tag, *_ in top],
                [p.series("spend", "Spending", [value for _, value, _ in top], "palette")],
                drill=query_drill(
                    "tag",
                    [None if tag == OTHER else tag for tag, *_ in top],
                    [None if tag == OTHER else query({**params, "tag": tag}, "Transactions with this tag") for tag, *_ in top],
                    "Open a tag's transactions",
                ),
            )
        ],
        "tables": [
            p.table(
                "tags",
                [p.column("tag", "Tag"), p.column("count", "Transactions", "count"), p.column("total", "Spending", "money"), p.column("average", "Average", "money")],
                [p.row(tag, {"tag": tag, "count": count, "total": value, "average": value / count}) for tag, value, count in groups],
            )
        ],
    }


def _tag_trend_drills(context: ReportContext) -> list[str]:
    spend = in_period(context.mart, context.period, "spend")
    months = month_starts(start_of(context.mart, context.period), context.period.end)
    return [f"tag:{tag}" for tag, *_ in _tag_groups(_tag_shares(spend))] + [f"month:{month.isoformat()[:7]}" for month in months]


@report("13-tag-trend", drills=_tag_trend_drills)
def tag_trend(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    spend = in_period(mart, period, "spend")
    shares = _tag_shares(spend)
    months = month_starts(start_of(mart, period), period.end)
    if context.drill and "tag" in context.drill:
        tag = context.drill["tag"]
        monthly: dict[Any, float] = {}
        for item_tag, flow, amount in shares:
            if item_tag == tag:
                monthly[flow.day.replace(day=1)] = monthly.get(flow.day.replace(day=1), 0.0) + amount
        return {
            "drill": {
                "title": tag,
                "charts": [p.chart("months", "bar", [month_label(month) for month in months], [p.series("spend", "Spending", [monthly.get(month, 0.0) for month in months], "expense")])],
                "query": query({**period_query_params(period), "tag": tag}, "Transactions with this tag"),
            }
        }
    if context.drill and "month" in context.drill:
        month = context.drill["month"]
        groups = _tag_groups([item for item in shares if item[1].day.isoformat()[:7] == month])
        return {
            "drill": {
                "title": month,
                "table": p.table(
                    "tags",
                    [p.column("tag", "Tag"), p.column("count", "Transactions", "count"), p.column("total", "Spending", "money")],
                    [p.row(tag, {"tag": tag, "count": count, "total": value}) for tag, value, count in groups],
                ),
            }
        }
    if not shares:
        return {"empty": {"text": "No tagged spending in this period."}}
    groups = _tag_groups(shares)
    series = []
    for index, (tag, _, _) in enumerate(groups):
        monthly = {}
        for item_tag, flow, amount in shares:
            if item_tag == tag:
                monthly[flow.day.replace(day=1)] = monthly.get(flow.day.replace(day=1), 0.0) + amount
        series.append(p.series(tag, tag, [monthly.get(month, 0.0) for month in months], f"palette:{index}", hidden=index >= 6))
    return {
        "stat_cards": [p.stat("tagged", "Tagged spending", sum(item[1] for item in groups), "money"), p.stat("tags", "Tags", len(groups), "count")],
        "charts": [
            p.chart(
                "trend",
                "line",
                [month_label(month) for month in months],
                series,
                drill={"param": "month", "series_param": "tag", "values": [month.isoformat()[:7] for month in months], "mode": "panel"},
            )
        ],
        "tables": [
            p.table(
                "tags",
                [p.column("tag", "Tag"), p.column("total", "Spending", "money")],
                [p.row(tag, {"tag": tag, "total": value}, drill={"param": "tag", "value": tag, "mode": "panel"}) for tag, value, _ in groups],
            )
        ],
    }
