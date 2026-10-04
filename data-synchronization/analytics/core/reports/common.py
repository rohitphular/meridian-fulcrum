"""Shared calculations for the pre-built reports: flow selection, buckets, rankings, balances.

All money is XAU grams (the mart's dated base values for flows; balances valued on their day).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable
from datetime import date, timedelta
from typing import Any

from core.mart import Flow, Mart
from core.periods import Period, add_months, month_end

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
OTHER = "Other"
DTI_BANDS = ((20, "excellent", "Excellent"), (36, "good", "Good"), (50, "caution", "Caution"))


def flows(mart: Mart, start: date | None, end: date, kind: str | None = None, *, exclude_subscription: bool = False) -> list[Flow]:
    return [
        flow for flow in mart.flows if (start is None or flow.day >= start) and flow.day <= end and (kind is None or flow.kind == kind) and not (exclude_subscription and flow.subscription_eligible)
    ]


def in_period(mart: Mart, period: Period, kind: str | None = None, **options: Any) -> list[Flow]:
    return flows(mart, period.start, period.end, kind, **options)


def total(items: Iterable[Flow]) -> float:
    return sum(flow.amount_xau for flow in items)


def first_flow_day(mart: Mart) -> date | None:
    return min((flow.day for flow in mart.flows), default=None)


def start_of(mart: Mart, period: Period) -> date:
    """The period start, or the first flow (or the anchor) for `all`."""
    return period.start or first_flow_day(mart) or period.end


def by_day(items: Iterable[Flow]) -> dict[date, float]:
    out: dict[date, float] = defaultdict(float)
    for flow in items:
        out[flow.day] += flow.amount_xau
    return out


def by_month(items: Iterable[Flow]) -> dict[date, float]:
    out: dict[date, float] = defaultdict(float)
    for flow in items:
        out[flow.day.replace(day=1)] += flow.amount_xau
    return out


def by_week(items: Iterable[Flow]) -> dict[date, float]:
    out: dict[date, float] = defaultdict(float)
    for flow in items:
        out[flow.day - timedelta(days=flow.day.weekday())] += flow.amount_xau
    return out


def group(items: Iterable[Flow], key: Callable[[Flow], str], label: Callable[[Flow], str] | None = None) -> list[tuple[str, str, float, int]]:
    """(key, label, total, count) sorted by total desc, then label."""
    totals: dict[str, list[Any]] = {}
    for flow in items:
        entry = totals.setdefault(key(flow), [label(flow) if label else key(flow), 0.0, 0])
        entry[1] += flow.amount_xau
        entry[2] += 1
    return sorted(((name, entry[0], entry[1], entry[2]) for name, entry in totals.items()), key=lambda item: (-item[2], item[1]))


def top_with_other(groups: list[tuple[str, str, float, int]], limit: int, minimum_to_merge: int = 2) -> list[tuple[str, str, float, int]]:
    """The first `limit` groups, the rest merged as Other (only when at least `minimum_to_merge` are merged)."""
    if len(groups) <= limit or len(groups) - limit < minimum_to_merge:
        return groups
    rest = groups[limit:]
    return [*groups[:limit], (OTHER, OTHER, sum(item[2] for item in rest), sum(item[3] for item in rest))]


def day_label(day: date) -> str:
    return f"{day.day} {MONTHS[day.month - 1]}"


def month_label(day: date) -> str:
    return f"{MONTHS[day.month - 1]} {str(day.year)[2:]}"


def month_ends(start: date, end: date) -> list[date]:
    """Month-end dates from start's month to end's month; the last one is `end` itself."""
    out, current = [], start.replace(day=1)
    while current <= end:
        out.append(min(month_end(current), end))
        current = add_months(current, 1)
    return out


def assets_on(mart: Mart, day: date, types: tuple[str, ...] = ("asset", "investment")) -> float | None:
    """Total XAU of the accounts of these types on a day; None when none of them has a balance yet."""
    values = [mart.balance_xau(account.id, day) for account in mart.live_accounts() if account.type in types]
    present = [value for value in values if value is not None]
    return sum(present) if present else None


def net_worth_on(mart: Mart, day: date) -> tuple[float | None, float | None, float | None]:
    """(assets, liabilities as a positive amount owed, net worth) on a day."""
    assets = assets_on(mart, day)
    liabilities = assets_on(mart, day, ("liability",))
    if assets is None and liabilities is None:
        return None, None, None
    owed = -(liabilities or 0.0)
    return assets or 0.0, owed, (assets or 0.0) - owed


def current_net_worth(mart: Mart) -> tuple[float, float, float]:
    """(assets, liabilities owed, net worth) from current balances (future-dated rows included)."""
    assets = owed = 0.0
    for account in mart.live_accounts():
        value = mart.current_xau(account.id)
        if value is None:
            continue
        if account.type == "liability":
            owed -= value
        else:
            assets += value
    return assets, owed, assets - owed


def dti_status(ratio: float | None, debt: float, has_income: bool) -> tuple[str, str]:
    if not has_income:
        return "na", "No income yet"
    if debt <= 0:
        return "debt_free", "Debt free"
    for limit, status, label in DTI_BANDS:
        if ratio is not None and ratio < limit:
            return status, label
    return "high_risk", "High risk"


def monthly_income_average(mart: Mart, start: date, end: date) -> tuple[float, int]:
    """Average monthly income over complete months (the end's month excluded), or all months when none is complete."""
    income = by_month(flows(mart, start, end, "income"))
    months = []
    current = start.replace(day=1)
    while current <= end:
        months.append(current)
        current = add_months(current, 1)
    complete = [month for month in months if month_end(month) <= end and month != end.replace(day=1)] or months
    if not complete:
        return 0.0, 0
    return sum(income.get(month, 0.0) for month in complete) / len(complete), len(complete)


def query(params: dict[str, Any], note: str) -> dict[str, Any]:
    """A drill that opens Transactions with these filters (rows are never part of a payload)."""
    return {"action": "list_transactions_view", "params": params, "note": note}


def period_query_params(period: Period) -> dict[str, Any]:
    """Transactions filters for a period: a custom range, or every row up to the end for `all`."""
    if period.start is None:
        return {"range": "all"}
    return {"range": "custom", "from": period.start.isoformat(), "to": period.end.isoformat()}


def query_drill(param: str, values: list[Any], queries: list[dict[str, Any] | None], hint: str, null_text: str | None = None) -> dict[str, Any]:
    """A chart drill that opens Transactions: queries[i] holds the filters for values[i] (None = not drillable)."""
    drill: dict[str, Any] = {"param": param, "values": values, "mode": "query", "queries": queries, "hint": hint}
    if null_text:
        drill["null_text"] = null_text
    return drill


def row_query(param: str, value: str, params: dict[str, Any], note: str) -> dict[str, Any]:
    return {"param": param, "value": value, "mode": "query", "query": query(params, note)}
