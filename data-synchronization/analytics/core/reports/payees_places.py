"""Payees and places: top payees, recurring payments, spend by country / city, foreign currency spend."""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date
from typing import Any

from core import payload as p
from core.mart import Flow, Mart
from core.periods import add_months
from core.reports import report
from core.reports.common import OTHER, by_month, group, in_period, month_label, period_query_params, query, query_drill, top_with_other, total
from core.reports.context import ReportContext

UNKNOWN_PAYEE = "Unknown payee"
_MONTHLY_EQUIVALENT = {"weekly": 52 / 12, "monthly": 1.0, "quarterly": 1 / 3}
_FREQUENCY_LABELS = {"weekly": "Weekly", "monthly": "Monthly", "quarterly": "Quarterly"}
# (mean gap in days: low, high, max standard deviation)
_FREQUENCIES = (("weekly", 5, 9, 2), ("monthly", 28, 35, 5), ("quarterly", 85, 95, 7))
_MAX_AMOUNT_CV = 0.15


def _payee(flow: Flow) -> str:
    return flow.payee or UNKNOWN_PAYEE


# ── Recurring payments ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Recurring:
    key: str
    payee: str
    category: str
    frequency: str
    amount: float  # average XAU per payment
    monthly: float  # monthly equivalent XAU
    last_date: date
    payments: tuple[Flow, ...]


def recurring_payments(mart: Mart) -> list[Recurring]:
    """Payees paid at a steady interval (weekly / monthly / quarterly) with steady amounts.

    Scans the whole history up to the anchor: spending plus repayments into liabilities.
    At least two payments; amount variation ≤ 15 % (local amounts when one currency).
    """
    groups: dict[str, list[Flow]] = {}
    for flow in [*mart.flows, *mart.repayments]:
        if flow.tx_type != "money-out" or flow.day > mart.anchor:
            continue
        groups.setdefault(_payee(flow).lower(), []).append(flow)
    out = []
    for key, payments in groups.items():
        payments.sort(key=lambda flow: flow.day)
        if len(payments) < 2:
            continue
        single_currency = len({flow.currency for flow in payments}) == 1
        amounts = [float(flow.amount_local) if single_currency else flow.amount_xau for flow in payments]
        mean_amount = statistics.fmean(amounts)
        if mean_amount <= 0 or (len(amounts) > 1 and statistics.pstdev(amounts) / mean_amount > _MAX_AMOUNT_CV):
            continue
        gaps = [(later.day - earlier.day).days for earlier, later in zip(payments, payments[1:])]
        mean_gap, deviation = statistics.fmean(gaps), statistics.pstdev(gaps) if len(gaps) > 1 else 0.0
        frequency = next((name for name, low, high, spread in _FREQUENCIES if low <= mean_gap <= high and deviation <= spread), None)
        if frequency is None:
            continue
        average = statistics.fmean(flow.amount_xau for flow in payments)
        categories: dict[str, int] = {}
        for flow in payments:
            categories[flow.major_label] = categories.get(flow.major_label, 0) + 1
        out.append(
            Recurring(key, _payee(payments[-1]), max(categories, key=lambda name: categories[name]), frequency, average, average * _MONTHLY_EQUIVALENT[frequency], payments[-1].day, tuple(payments))
        )
    return sorted(out, key=lambda item: (-item.monthly, item.payee))


def _recurring_in_period(context: ReportContext) -> list[Recurring]:
    period = context.period
    return [item for item in recurring_payments(context.mart) if period is None or any(period.contains(flow.day) for flow in item.payments)]


def _recurring_drills(context: ReportContext) -> list[str]:
    return [f"counterparty:{item.key}" for item in _recurring_in_period(context)]


_SORTS = {
    "counterparty": lambda item: item.payee.lower(),
    "category": lambda item: item.category.lower(),
    "frequency": lambda item: item.frequency,
    "amount": lambda item: item.monthly,
    "last_date": lambda item: item.last_date,
}


@report("23-recurring-payments", drills=_recurring_drills)
def recurring(context: ReportContext) -> dict[str, Any]:
    items = _recurring_in_period(context)
    if context.drill:
        item = next(entry for entry in items if entry.key == context.drill["counterparty"])
        months = by_month(item.payments)
        keys = sorted(months)
        return {
            "drill": {
                "title": item.payee,
                "subtitle": p.text("{0} · {1} a month", {"value": _FREQUENCY_LABELS[item.frequency], "format": "text"}, p.money(item.monthly)),
                "charts": [p.chart("history", "bar", [month_label(month) for month in keys], [p.series("paid", "Paid", [months[month] for month in keys], "expense")])],
                "query": query({"counterparty": item.payee}, "All payments to this payee"),
            }
        }
    if not items:
        return {"empty": {"text": "No recurring payments found in this period."}}
    sortable = context.entry["sortable"]
    default = sortable["default"]
    ordered = sorted(items, key=_SORTS[default["col"]], reverse=default["dir"] == "desc")
    period = context.period
    income = total(in_period(context.mart, period, "income")) if period else 0.0
    months = max(1, len({flow.day.replace(day=1) for flow in in_period(context.mart, period)})) if period else 1
    monthly_total = sum(item.monthly for item in items)
    share = monthly_total / (income / months) * 100 if income > 0 else None
    columns = [
        p.column("counterparty", "Payee"),
        p.column("category", "Category"),
        p.column("frequency", "Frequency"),
        p.column("amount", "Per month", "money"),
        p.column("last_date", "Last paid", "date"),
    ]
    rows = [
        p.row(
            item.key,
            {"counterparty": item.payee, "category": item.category, "frequency": _FREQUENCY_LABELS[item.frequency], "amount": item.monthly, "last_date": item.last_date.isoformat()},
            drill={"param": "counterparty", "value": item.key, "mode": "panel"},
        )
        for item in ordered
    ]
    top = ordered[:10]
    return {
        "stat_cards": [
            p.stat("monthly", "Recurring per month", monthly_total, "money"),
            p.stat("count", "Recurring payees", len(items), "count"),
            p.stat("share", "Share of income", share, "percent"),
            p.stat("yearly", "Per year", monthly_total * 12, "money"),
        ],
        "tables": [p.table("recurring", columns, rows, sortable=sortable["columns"], sort=default)],
        "charts": [p.chart("top", "hbar", [item.payee for item in top], [p.series("monthly", "Per month", [item.monthly for item in top], "expense")])],
    }


# ── Top payees ────────────────────────────────────────────────────────────────


def _payee_drills(context: ReportContext) -> list[str]:
    spend = in_period(context.mart, context.period, "spend")
    limit = max(context.entry["controls"][0]["values"])
    return [f"counterparty:{key}" for key, *_ in group(spend, lambda flow: _payee(flow).lower(), _payee)[:limit]]


@report("22-top-counterparties", drills=_payee_drills)
def top_payees(context: ReportContext) -> dict[str, Any]:
    mart, period = context.mart, context.period
    spend = in_period(mart, period, "spend")
    groups = group(spend, lambda flow: _payee(flow).lower(), _payee)
    if context.drill:
        key = context.drill["counterparty"]
        label = next(name for item_key, name, *_ in groups if item_key == key)
        start = add_months(mart.anchor, -5)
        recent = [flow for flow in mart.flows if flow.kind == "spend" and _payee(flow).lower() == key and flow.day >= start and flow.day <= mart.anchor]
        months = by_month(recent)
        keys = [add_months(start, offset) for offset in range(6)]
        compare = context.compare
        now = total(flow for flow in spend if _payee(flow).lower() == key)
        before = total(flow for flow in (in_period(mart, compare, "spend") if compare else []) if _payee(flow).lower() == key)
        return {
            "drill": {
                "title": label,
                "subtitle": p.text("{0} in this period", p.money(now)),
                "charts": [p.chart("months", "bar", [month_label(month) for month in keys], [p.series("spend", "Spending", [months.get(month, 0.0) for month in keys], "expense")])],
                "table": p.table(
                    "compare",
                    [p.column("label", "Period"), p.column("value", "Spending", "money")],
                    [p.row("now", {"label": "This period", "value": now}), p.row("before", {"label": "Previous period", "value": before})],
                ),
                "query": query({**period_query_params(period), "counterparty": label}, "Transactions with this payee"),
            }
        }
    if not groups:
        return {"empty": {"text": "No spending in this period."}}
    top = groups[: context.control("top_n")]
    return {
        "stat_cards": [
            p.stat("total", "Spending", total(spend), "money"),
            p.stat("payees", "Payees", len(groups), "count"),
            p.stat("top", "Top payee share", top[0][2] / total(spend) * 100 if total(spend) else None, "percent", sub=top[0][1]),
        ],
        "charts": [
            p.chart(
                "payees",
                "hbar",
                [label for _, label, *_ in top],
                [p.series("spend", "Spending", [value for _, _, value, _ in top], "expense")],
                drill={"param": "counterparty", "values": [key for key, *_ in top], "mode": "panel"},
            )
        ],
    }


# ── Countries and cities ──────────────────────────────────────────────────────


def _country_drills(context: ReportContext) -> list[str]:
    return [f"country:{key}" for key, *_ in top_with_other(group(in_period(context.mart, context.period, "spend"), lambda flow: flow.country), 15) if key != OTHER]


@report("24-spend-by-country", drills=_country_drills)
def by_country(context: ReportContext) -> dict[str, Any]:
    spend = in_period(context.mart, context.period, "spend")
    if context.drill:
        country = context.drill["country"]
        cities = group([flow for flow in spend if flow.country == country], lambda flow: flow.city)
        return {
            "drill": {
                "title": country,
                "subtitle": p.text("{0} in this period", p.money(sum(item[2] for item in cities))),
                "table": p.table(
                    "cities",
                    [p.column("city", "City"), p.column("count", "Transactions", "count"), p.column("total", "Spending", "money")],
                    [p.row(key, {"city": label, "count": count, "total": value}) for key, label, value, count in cities],
                ),
            }
        }
    if not spend:
        return {"empty": {"text": "No spending in this period."}}
    countries = top_with_other(group(spend, lambda flow: flow.country), 15)
    top_category: dict[str, dict[str, int]] = {}
    for flow in spend:
        counts = top_category.setdefault(flow.country, {})
        counts[flow.major_label] = counts.get(flow.major_label, 0) + 1
    rows = [
        p.row(
            key,
            {
                "country": label,
                "count": count,
                "total": value,
                "average": value / count if count else None,
                "category": max(top_category.get(key, {"": 0}), key=lambda name: top_category.get(key, {}).get(name, 0)) if key != OTHER else "",
            },
            drill=None if key == OTHER else {"param": "country", "value": key, "mode": "panel"},
        )
        for key, label, value, count in countries
    ]
    return {
        "stat_cards": [p.stat("total", "Spending", total(spend), "money"), p.stat("countries", "Countries", len(group(spend, lambda flow: flow.country)), "count")],
        "charts": [
            p.chart(
                "countries",
                "hbar",
                [label for _, label, *_ in countries],
                [p.series("spend", "Spending", [value for _, _, value, _ in countries], "expense")],
                drill={"param": "country", "values": [None if key == OTHER else key for key, *_ in countries], "mode": "panel", "null_text": "Other groups the smaller countries."},
            )
        ],
        "tables": [
            p.table(
                "countries",
                [
                    p.column("country", "Country"),
                    p.column("count", "Transactions", "count"),
                    p.column("total", "Spending", "money"),
                    p.column("average", "Average", "money"),
                    p.column("category", "Top category"),
                ],
                rows,
            )
        ],
    }


def _city_query(context: ReportContext, key: str) -> dict[str, Any] | None:
    """Transactions in a city ("City, Country" key); Other and unknown cities are not drillable."""
    city = key.rsplit(", ", 1)[0]
    if key == OTHER or city == "Unknown":
        return None
    return query({**period_query_params(context.period), "user_location_city": city, "types": "money-out"}, "Spending in this city")


@report("25-spend-by-city")
def by_city(context: ReportContext) -> dict[str, Any]:
    spend = in_period(context.mart, context.period, "spend")
    if not spend:
        return {"empty": {"text": "No spending in this period."}}
    home = context.home_country
    cities = top_with_other(group(spend, lambda flow: f"{flow.city}, {flow.country}"), 15)

    def split(key: str) -> tuple[float, float, float]:
        selected = [flow for flow in spend if f"{flow.city}, {flow.country}" == key] if key != OTHER else []
        if key == OTHER:
            named = {item[0] for item in cities if item[0] != OTHER}
            selected = [flow for flow in spend if f"{flow.city}, {flow.country}" not in named]
        domestic = total(flow for flow in selected if flow.country == home)
        unknown = total(flow for flow in selected if flow.country == "Unknown")
        return domestic, total(selected) - domestic - unknown, unknown

    parts = [split(key) for key, *_ in cities]
    labels = [label for _, label, *_ in cities]
    return {
        "stat_cards": [
            p.stat("total", "Spending", total(spend), "money"),
            p.stat("abroad", "Abroad", total(flow for flow in spend if flow.country not in (home, "Unknown")), "money", sub=p.text("home is {0}", {"value": home, "format": "text"})),
        ],
        "charts": [
            p.chart(
                "cities",
                "stacked_hbar",
                labels,
                [
                    p.series("domestic", "Home", [part[0] for part in parts], "palette:0"),
                    p.series("international", "Abroad", [part[1] for part in parts], "palette:1"),
                    p.series("unknown", "Unknown", [part[2] for part in parts], "muted"),
                ],
                drill=query_drill(
                    "city",
                    [None if key == OTHER else key for key, *_ in cities],
                    [_city_query(context, key) for key, *_ in cities],
                    "Open a city's spending",
                    "Other groups the smaller cities.",
                ),
            )
        ],
        "tables": [
            p.table(
                "cities",
                [p.column("city", "City"), p.column("count", "Transactions", "count"), p.column("total", "Spending", "money")],
                [p.row(key, {"city": label, "count": count, "total": value}) for key, label, value, count in cities],
            )
        ],
        "drill": None,
    }


@report("28-forex-spend")
def forex(context: ReportContext) -> dict[str, Any]:
    spend = in_period(context.mart, context.period, "spend")
    if not spend:
        return {"empty": {"text": "No spending in this period."}}
    home = context.home_currency
    currencies = group(spend, lambda flow: flow.currency)
    local = {key: sum(flow.amount_local for flow in spend if flow.currency == key) for key, *_ in currencies}
    foreign = total(flow for flow in spend if flow.currency != home)
    return {
        "stat_cards": [
            p.stat("total", "Spending", total(spend), "money"),
            p.stat("foreign", "Foreign currency", foreign, "money"),
            p.stat("share", "Foreign share", foreign / total(spend) * 100 if total(spend) else None, "percent"),
            p.stat("currencies", "Currencies", len(currencies), "count"),
        ],
        "charts": [p.chart("currencies", "donut", [key for key, *_ in currencies], [p.series("spend", "Spending", [value for _, _, value, _ in currencies], "palette")])],
        "tables": [
            p.table(
                "currencies",
                [p.column("currency", "Currency"), p.column("local", "In that currency", "local"), p.column("total", "Spending", "money"), p.column("count", "Transactions", "count")],
                [p.row(key, {"currency": key, "local": float(local[key]), "total": value, "count": count}, tone=None if key == home else "highlight") for key, _, value, count in currencies],
            )
        ],
    }
