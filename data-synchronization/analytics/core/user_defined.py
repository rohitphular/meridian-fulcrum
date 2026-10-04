"""Build step: the user's own reports (report_master, report_type user_defined), from the in-memory mart.

Each active definition is validated again against contract/report-definition.json (the
loader already did; a hand edit or a contract change is caught here), then computed:
filters → measure per bucket and group → top N + Other → the payload for its chart kind.
Results are recorded against the definition's source_updated_at, so an edited report is
recomputed and its status describes the definition the user sees. A report that fails is
recorded as failed with a code; it never fails the run. Nothing a user typed becomes SQL.

Shapes (two group-bys):
- with a time grain, series are (group 1, group 2) pairs ranked once, top N + Other;
- ranked bars without a grain: group 1 = the bars, group 2 = the stacked segments;
- table: one row per bucket × group pair (at most limits.max_table_rows).
Compare: groups are ranked on the current period; the compared period uses the same keys
(everything else is Other). A compare line is drawn only for a chart without groups.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from psycopg2.extras import execute_values
from py_logging import get_logger

import core.config as config
from core import payload as p
from core import periods, places
from core.context import BuildContext
from core.errors import error_code
from core.mart import Account, Flow, Mart
from core.reports.common import OTHER, day_label, month_label

logger = get_logger(__name__)

_SQL = """
SELECT id::text, report_name, report_description, measure, period_preset, period_from, period_to, compare_mode, time_grain,
       group_by_1, group_by_2, top_n, include_other, filter_account_ids::text[], filter_categories, filter_tags, filter_payees,
       filter_currencies, filter_countries, filter_tx_types, filter_amount_min, filter_amount_max, chart_kind, source_updated_at
FROM report_master
WHERE report_type = 'user_defined' AND record_status = 'active'
ORDER BY lower(report_name), id
"""
_FILTER_COLUMNS = ("account_ids", "categories", "tags", "payees", "currencies", "countries", "tx_types")
UNTAGGED, NO_PAYEE = "Untagged", "No payee"


class ReportError(ValueError):
    """A definition the job cannot compute; the message is the contract error code."""


@dataclass(frozen=True)
class Definition:
    id: str
    name: str
    description: str
    measure: str
    period_preset: str
    period_from: date | None
    period_to: date | None
    compare_mode: str
    time_grain: str
    groups: tuple[str, ...]
    top_n: int | None
    include_other: bool
    filters: dict[str, list[str]]
    amount_min: Decimal | None
    amount_max: Decimal | None
    chart_kind: str
    updated_at: str = ""


def read(conn: Any) -> list[Definition]:
    with conn.cursor() as cursor:
        cursor.execute(_SQL)
        rows = cursor.fetchall()
    out = []
    for row in rows:
        (identity, name, description, measure, preset, start, end, compare, grain, group_1, group_2, top_n, include_other, *lists) = row[:20]
        amount_min, amount_max, chart_kind, updated_at = row[20:]
        out.append(
            Definition(
                id=identity,
                name=name,
                description=description or "",
                measure=measure,
                period_preset=preset,
                period_from=start,
                period_to=end,
                compare_mode=compare or "none",
                time_grain=grain or "none",
                groups=tuple(key for key in (group_1, group_2) if key),
                top_n=top_n,
                include_other=bool(include_other),
                filters={key: list(values or []) for key, values in zip(_FILTER_COLUMNS, lists)},
                amount_min=amount_min,
                amount_max=amount_max,
                chart_kind=chart_kind,
                updated_at=updated_at or "",
            )
        )
    return out


# ── Validation (the contract rules, on typed values) ──────────────────────────


def _by_key(items: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    return next((item for item in items if item["key"] == key), None)


def chart_error(chart: dict[str, Any], measure: dict[str, Any], grain: str, group_count: int) -> str:
    allowed = chart["measures"]
    if not (allowed == "all" or (allowed == "additive" and measure["additive"]) or (isinstance(allowed, list) and measure["key"] in allowed)):
        return "chart_not_allowed_for_measure"
    for mode in chart["modes"]:
        grain_ok = mode["time_grain"] == "any" or (mode["time_grain"] == "required") == (grain != "none")
        if grain_ok and mode["group_by_min"] <= group_count <= mode["group_by_max"]:
            return ""
    return "chart_not_allowed_for_shape"


def validate(definition: Definition, spec: dict[str, Any]) -> None:
    def fail(code: str) -> None:
        raise ReportError(code)

    name = definition.name.strip()
    if not name:
        fail("missing_report_name")
    if len(name) < spec["name"]["min_length"]:
        fail("report_name_too_short")
    if len(name) > spec["name"]["max_length"]:
        fail("report_name_too_long")
    if len(definition.description) > spec["description"]["max_length"]:
        fail("report_description_too_long")
    measure = _by_key(spec["measures"], definition.measure)
    if measure is None:
        fail("invalid_measure")
    preset = _by_key(spec["period_presets"], definition.period_preset)
    if preset is None:
        fail("invalid_period_preset")
    span = preset["max_days"]
    if preset["key"] == "fixed":
        if definition.period_from is None or definition.period_to is None or definition.period_to < definition.period_from:
            fail("invalid_period_dates")
        span = (definition.period_to - definition.period_from).days + 1
        if span > spec["limits"]["fixed_period_max_days"]:
            fail("fixed_period_too_long")
    elif definition.period_from is not None or definition.period_to is not None:
        fail("period_dates_not_allowed")
    if _by_key(spec["compare_modes"], definition.compare_mode) is None:
        fail("invalid_compare_mode")
    if definition.compare_mode != "none" and preset["key"] in spec["compare_rules"]["not_with_periods"]:
        fail("compare_not_allowed")
    if _by_key(spec["time_grains"], definition.time_grain) is None:
        fail("invalid_time_grain")
    for key in definition.groups:
        if _by_key(spec["group_by"], key) is None:
            fail("invalid_group_by")
        if measure["group_by"] != "all" and key not in measure["group_by"]:
            fail("group_by_not_allowed_for_measure")
    if len(definition.groups) == 2 and definition.groups[0] == definition.groups[1]:
        fail("duplicate_group_by")
    if definition.groups:
        if definition.top_n not in spec["group_by_rules"]["top_n_values"]:
            fail("invalid_top_n")
    elif definition.top_n is not None or definition.include_other:
        fail("top_n_without_group_by")
    for item in spec["filters"]:
        if item["key"] in definition.filters and len(definition.filters[item["key"]]) > item["max_values"]:
            fail("too_many_filter_values")
    used = [key for key, values in definition.filters.items() if values] + [key for key, value in (("amount_min", definition.amount_min), ("amount_max", definition.amount_max)) if value is not None]
    if measure["kind"] == "stock" and set(used) & set(spec["filter_rules"]["transaction_only"]):
        fail("filter_not_allowed_for_measure")
    if definition.amount_min is not None and definition.amount_max is not None and definition.amount_min > definition.amount_max:
        fail("invalid_amount_range")
    chart = _by_key(spec["chart_kinds"], definition.chart_kind)
    if chart is None:
        fail("invalid_chart_kind")
    error = chart_error(chart, measure, definition.time_grain, len(definition.groups))
    if error:
        fail(error)
    if definition.time_grain != "none" and span is not None and -(-span // spec["time_grain_days"][definition.time_grain]) > spec["limits"]["max_points"]:
        fail("too_many_points")


# ── Selection and grouping ────────────────────────────────────────────────────


def _lower(values: Iterable[str]) -> set[str]:
    return {value.strip().lower() for value in values}


def select_flows(mart: Mart, definition: Definition) -> list[Flow]:
    """The flows the definition's filters keep (any period)."""
    filters = definition.filters
    accounts = _lower(filters.get("account_ids", []))
    categories = {value.strip() for value in filters.get("categories", [])}
    tags = _lower(filters.get("tags", []))
    payees = _lower(filters.get("payees", []))
    currencies = {value.strip().upper() for value in filters.get("currencies", [])}
    countries = _lower(places.country(value) for value in filters.get("countries", []))
    tx_types = set(filters.get("tx_types", []))
    kinds = {"spend": "spend", "income": "income"}.get(definition.measure)
    out = []
    for flow in mart.flows:
        if kinds and flow.kind != kinds:
            continue
        if accounts and flow.account_id.lower() not in accounts:
            continue
        if categories and flow.major_key not in categories and f"{flow.major_key}|{flow.minor_key}" not in categories:
            continue
        if tags and not tags & set(flow.tags):
            continue
        if payees and flow.payee.lower() not in payees:
            continue
        if currencies and flow.currency.upper() not in currencies:
            continue
        if countries and flow.country.lower() not in countries:
            continue
        if tx_types and flow.tx_type not in tx_types:
            continue
        if definition.amount_min is not None and flow.amount_local < definition.amount_min:
            continue
        if definition.amount_max is not None and flow.amount_local > definition.amount_max:
            continue
        out.append(flow)
    return out


def select_accounts(mart: Mart, definition: Definition) -> list[Account]:
    accounts = _lower(definition.filters.get("account_ids", []))
    currencies = {value.strip().upper() for value in definition.filters.get("currencies", [])}
    return [account for account in mart.live_accounts() if (not accounts or account.id.lower() in accounts) and (not currencies or account.currency.upper() in currencies)]


def flow_keys(flow: Flow, group: str, mart: Mart) -> list[tuple[str, str]]:
    """(key, label) of each group a flow belongs to (a flow with two tags is in both)."""
    if group == "category":
        return [(flow.major_key, flow.major_label)]
    if group == "sub_category":
        return [(f"{flow.major_key}|{flow.minor_key}", f"{flow.major_label} / {flow.minor_label}")]
    if group == "tag":
        return [(tag, tag) for tag in flow.tags] or [("", UNTAGGED)]
    if group == "payee":
        return [(flow.payee.lower(), flow.payee or NO_PAYEE)]
    if group in ("account", "account_type"):
        account = mart.accounts.get(flow.account_id)
        if account is None:
            return [(flow.account_id, flow.account_id)]
        return [(account.id, account.name)] if group == "account" else [(account.type, account.type_label)]
    if group == "currency":
        return [(flow.currency, flow.currency)]
    if group == "country":
        return [(flow.country, flow.country)]
    return [(flow.city, flow.city)]


def account_key(account: Account, group: str) -> tuple[str, str]:
    if group == "account":
        return account.id, account.name
    if group == "account_type":
        return account.type, account.type_label
    return account.currency, account.currency


# ── Measures ──────────────────────────────────────────────────────────────────


def measure_format(measure: str) -> str:
    return {"count": "count", "savings_rate": "percent"}.get(measure, "money")


def flow_value(measure: str, items: Iterable[Flow]) -> float | None:
    """The measure over a set of flows, from sums and counts (never an average of averages)."""
    income = spend = amount = 0.0
    count = 0
    seen: set[str] = set()
    for flow in items:
        if flow.tx_id in seen:  # a flow can reach Other through two tags
            continue
        seen.add(flow.tx_id)
        count += 1
        amount += flow.amount_xau
        if flow.kind == "income":
            income += flow.amount_xau
        else:
            spend += flow.amount_xau
    if measure == "spend":
        return spend
    if measure == "income":
        return income
    if measure == "net":
        return income - spend
    if measure == "count":
        return count
    if measure == "average":
        return amount / count if count else None
    return (income - spend) / income * 100 if income > 0 else None  # savings_rate


def stock_value(mart: Mart, accounts: Iterable[Account], day: date) -> float | None:
    """Total value on a day; on or after the anchor, current balances (as the pre-built net worth uses)."""
    values = [mart.current_xau(account.id) if day >= mart.anchor else mart.balance_xau(account.id, day) for account in accounts]
    present = [value for value in values if value is not None]
    return sum(present) if present else None


# ── Time buckets ──────────────────────────────────────────────────────────────


def bucket_start(day: date, grain: str) -> date:
    if grain == "day":
        return day
    if grain == "week":
        return day - timedelta(days=day.weekday())
    if grain == "month":
        return day.replace(day=1)
    if grain == "quarter":
        return date(day.year, (day.month - 1) // 3 * 3 + 1, 1)
    return date(day.year, 1, 1)


def _next_bucket(start: date, grain: str) -> date:
    if grain == "day":
        return start + timedelta(days=1)
    if grain == "week":
        return start + timedelta(days=7)
    return periods.add_months(start, {"month": 1, "quarter": 3, "year": 12}[grain])


def buckets(start: date, end: date, grain: str) -> list[tuple[date, date]]:
    """(first day, last day) of each bucket overlapping start…end, clipped to it."""
    out, current = [], bucket_start(start, grain)
    while current <= end:
        following = _next_bucket(current, grain)
        out.append((max(current, start), min(following - timedelta(days=1), end)))
        current = following
    return out


def bucket_label(start: date, grain: str, anchor: date) -> str:
    if grain in ("day", "week"):
        return day_label(start) if start.year == anchor.year else f"{day_label(start)} {str(start.year)[2:]}"
    if grain == "month":
        return month_label(start)
    if grain == "quarter":
        return f"Q{(start.month - 1) // 3 + 1} {str(start.year)[2:]}"
    return str(start.year)


# ── Compute ───────────────────────────────────────────────────────────────────


@dataclass
class Shape:
    """What a definition computes to before it becomes a payload."""

    labels: list[str] = field(default_factory=list)  # buckets, or groups without a grain
    series: list[tuple[str, str, list[float | None]]] = field(default_factory=list)  # (key, label, values)
    compare: list[float | None] | None = None
    total: float | None = None
    compare_total: float | None = None
    rows: list[dict[str, Any]] = field(default_factory=list)
    stacked_segments: bool = False


def _rank(groups: dict[str, tuple[str, list[Any]]], score: Callable[[list[Any]], float | None], top_n: int, include_other: bool) -> list[tuple[str, str]]:
    """(key, label) of the top N groups by |score| (then label); the rest become Other, or are dropped."""
    ranked = sorted(groups.items(), key=lambda item: (-abs(score(item[1][1]) or 0.0), item[1][0].lower()))
    kept = [(key, label) for key, (label, _) in ranked[:top_n]]
    if include_other and len(ranked) > top_n:
        kept.append((OTHER, OTHER))
    return kept


class Compiler:
    def __init__(self, mart: Mart, spec: dict[str, Any], anchor: date) -> None:
        self.mart = mart
        self.spec = spec
        self.anchor = anchor
        self.limits = spec["limits"]

    def period(self, definition: Definition, first_day: date | None) -> tuple[periods.Period, date, date] | None:
        period = periods.resolve(definition.period_preset, self.anchor, definition.period_from, definition.period_to)
        start = period.start or first_day
        end = min(period.end, self.anchor)
        if start is None or start > end:
            return None
        return period, start, end

    def compute(self, definition: Definition) -> dict[str, Any]:
        measure = _by_key(self.spec["measures"], definition.measure)
        stock = measure["kind"] == "stock"
        if stock:
            accounts = select_accounts(self.mart, definition)
            first = min((account.start_date for account in accounts if account.start_date), default=None)
            if not accounts:
                return {"empty": {"text": "No accounts match this report."}}
        else:
            flows = select_flows(self.mart, definition)
            first = min((flow.day for flow in flows), default=None)
        resolved = self.period(definition, first)
        if resolved is None:
            return {"empty": {"text": "Nothing to show for this period yet."}}
        period, start, end = resolved
        compare = periods.compared(period, definition.compare_mode)
        grain = definition.time_grain
        spans = buckets(start, end, grain) if grain != "none" else [(start, end)]
        if len(spans) > self.limits["max_points"]:
            raise ReportError("too_many_points")
        compare_spans = None
        if compare is not None:
            compare_end = min(compare.end, self.anchor)
            compare_spans = buckets(compare.start, compare_end, grain) if grain != "none" else [(compare.start, compare_end)]
        if stock:
            shape = self._stock(definition, accounts, spans, compare_spans)
        else:
            in_period = [flow for flow in flows if start <= flow.day <= end]
            if not in_period:
                return {"empty": {"text": "No transactions match this report in this period."}}
            shape = self._flows(definition, flows, in_period, spans, compare_spans)
        return self._payload(definition, period, compare, shape)

    # A group's members are flows (flow measures) or accounts (stock measures).

    def _groups_of(self, definition: Definition, members: list[Any], key_of: Callable[[Any, str], list[tuple[str, str]]]) -> dict[str, tuple[str, list[Any]]]:
        out: dict[str, tuple[str, list[Any]]] = {}
        for member in members:
            keys = [key_of(member, group) for group in definition.groups]
            combos = keys[0] if len(keys) == 1 else [(f"{a[0]}\x1f{b[0]}", f"{a[1]} · {b[1]}") for a in keys[0] for b in keys[1]]
            for key, label in combos:
                out.setdefault(key, (label, []))[1].append(member)
        return out

    def _flows(self, definition: Definition, flows: list[Flow], in_period: list[Flow], spans: list[tuple[date, date]], compare_spans: list[tuple[date, date]] | None) -> Shape:
        measure = definition.measure

        def value(items: Iterable[Flow], span: tuple[date, date]) -> float | None:
            return flow_value(measure, (flow for flow in items if span[0] <= flow.day <= span[1]))

        def key_of(flow: Flow, group: str) -> list[tuple[str, str]]:
            return flow_keys(flow, group, self.mart)

        return self._shape(definition, flows, in_period, spans, compare_spans, value, key_of, lambda items: flow_value(measure, items))

    def _stock(self, definition: Definition, accounts: list[Account], spans: list[tuple[date, date]], compare_spans: list[tuple[date, date]] | None) -> Shape:
        def value(items: Iterable[Account], span: tuple[date, date]) -> float | None:
            return stock_value(self.mart, items, span[1])

        def key_of(account: Account, group: str) -> list[tuple[str, str]]:
            return [account_key(account, group)]

        end = spans[-1][1]
        return self._shape(definition, accounts, accounts, spans, compare_spans, value, key_of, lambda items: stock_value(self.mart, items, end))

    def _shape(self, definition, members, in_period, spans, compare_spans, value, key_of, score) -> Shape:  # noqa: ANN001
        grain = definition.time_grain
        whole = (spans[0][0], spans[-1][1])
        compare_whole = (compare_spans[0][0], compare_spans[-1][1]) if compare_spans else None
        shape = Shape(total=value(members, whole), compare_total=value(members, compare_whole) if compare_whole else None)
        if not definition.groups:
            if grain != "none":
                shape.labels = [bucket_label(span[0], grain, self.anchor) for span in spans]
                shape.series = [("value", definition.name, [value(members, span) for span in spans])]
                if compare_spans is not None:
                    values = [value(members, span) for span in compare_spans]
                    shape.compare = (values + [None] * len(spans))[: len(spans)]
                shape.rows = [{"key": label, "cells": {"bucket": label, "value": val}} for label, val in zip(shape.labels, shape.series[0][2])]
            return shape
        in_period_set = {id(member) for member in in_period}
        groups = self._groups_of(definition, [member for member in members if id(member) in in_period_set], key_of)
        top_n = definition.top_n or len(groups)
        segmented = grain == "none" and len(definition.groups) == 2 and definition.chart_kind == "hbar"
        if segmented:
            return self._segmented(definition, members, in_period_set, whole, value, key_of, score, shape, top_n)
        ranked = _rank(groups, score, top_n, definition.include_other)
        all_groups = self._groups_of(definition, members, key_of)
        kept_keys = {key for key, _ in ranked if key != OTHER}

        def members_for(key: str) -> list[Any]:
            if key != OTHER:
                return all_groups.get(key, ("", []))[1]
            return [item for other, (_, items) in all_groups.items() if other not in kept_keys for item in items]

        if grain != "none":
            if len(ranked) > self.limits["max_series"]:
                raise ReportError("too_many_series")
            shape.labels = [bucket_label(span[0], grain, self.anchor) for span in spans]
            for key, label in ranked:
                items = members_for(key)
                shape.series.append((key, label, [value(items, span) for span in spans]))
            shape.rows = [
                {"key": f"{span_label}\x1f{key}", "cells": {"bucket": span_label, "group": label, "value": values[index]}}
                for index, span_label in enumerate(shape.labels)
                for key, label, values in shape.series
            ]
        else:
            shape.labels = [label for _, label in ranked]
            values = [value(members_for(key), whole) for key, _ in ranked]
            shape.series = [("value", definition.name, values)]
            compared = [value(members_for(key), compare_whole) for key, _ in ranked] if compare_whole else None
            shape.compare = compared
            shape.rows = []
            for index, (key, label) in enumerate(ranked):
                cells: dict[str, Any] = {"group": label, "value": values[index]}
                if compared is not None:
                    cells["compare"] = compared[index]
                    cells["change"] = None if values[index] is None or compared[index] is None else values[index] - compared[index]
                shape.rows.append({"key": key, "cells": cells})
        return shape

    def _segmented(self, definition, members, in_period_set, whole, value, key_of, score, shape, top_n) -> Shape:  # noqa: ANN001
        """Ranked bars by group 1, stacked segments by group 2 (each ranked on its own, top N + Other)."""
        first, second = definition.groups

        def single(group: str) -> Callable[[Any, str], list[tuple[str, str]]]:
            return lambda member, _: key_of(member, group)

        one = Definition(**{**definition.__dict__, "groups": (first,)})
        two = Definition(**{**definition.__dict__, "groups": (second,)})
        current = [member for member in members if id(member) in in_period_set]
        bars = _rank(self._groups_of(one, current, single(first)), score, top_n, definition.include_other)
        segments = _rank(self._groups_of(two, current, single(second)), score, top_n, definition.include_other)
        if len(segments) > self.limits["max_series"]:
            raise ReportError("too_many_series")
        bar_keys = {key for key, _ in bars if key != OTHER}
        segment_keys = {key for key, _ in segments if key != OTHER}

        def in_bucket(member: Any, group: str, key: str, kept: set[str]) -> bool:
            keys = {item[0] for item in key_of(member, group)}
            return bool(keys - kept) if key == OTHER else key in keys

        shape.labels = [label for _, label in bars]
        for segment_key, segment_label in segments:
            values = []
            for bar_key, _ in bars:
                items = [member for member in members if in_bucket(member, first, bar_key, bar_keys) and in_bucket(member, second, segment_key, segment_keys)]
                values.append(value(items, whole))
            shape.series.append((segment_key, segment_label, values))
        shape.stacked_segments = True
        return shape

    # ── Payload ───────────────────────────────────────────────────────────────

    def _payload(self, definition: Definition, period: periods.Period, compare: periods.Period | None, shape: Shape) -> dict[str, Any]:
        fmt = measure_format(definition.measure)
        delta_fmt = {"money": "money_delta", "percent": "percent_delta"}.get(fmt, "count")
        measure_label = _by_key(self.spec["measures"], definition.measure)["label"]
        cards = [p.stat("value", measure_label, shape.total, fmt)]
        if compare is not None:
            change = None if shape.total is None or shape.compare_total is None else shape.total - shape.compare_total
            relative = change / abs(shape.compare_total) * 100 if change is not None and shape.compare_total else None
            cards[0]["sub"] = p.text("{0} vs {1}", {"value": relative, "format": "percent_delta"}, {"value": compare.label, "format": "text"})
            cards.append(p.stat("compare", compare.label, shape.compare_total, fmt))
            cards.append(p.stat("change", "Change", change, delta_fmt, tone=None if change is None else ("positive" if change >= 0 else "negative")))
        kind = definition.chart_kind
        if kind == "number":
            return {"stat_cards": cards}
        body: dict[str, Any] = {"stat_cards": cards}
        if kind == "table":
            body["tables"] = [self._table(definition, shape, fmt, delta_fmt)]
            return body
        datasets = [p.series(key, label, values, f"palette:{index}" if len(shape.series) > 1 else "primary") for index, (key, label, values) in enumerate(shape.series)]
        if shape.compare is not None and not definition.groups and definition.time_grain != "none":
            datasets.append(p.series("compare", compare.label if compare else "", shape.compare, "compare", dashed=True))
        chart_kind = {"hbar": "stacked_hbar" if shape.stacked_segments else "hbar"}.get(kind, kind)
        body["charts"] = [p.chart("report", chart_kind, shape.labels, datasets, y_format=fmt)]
        return body

    def _table(self, definition: Definition, shape: Shape, fmt: str, delta_fmt: str) -> dict[str, Any]:
        columns = []
        if definition.time_grain != "none":
            columns.append(p.column("bucket", "Period"))
        if definition.groups:
            labels = [_by_key(self.spec["group_by"], key)["label"] for key in definition.groups]
            columns.append(p.column("group", " · ".join(labels)))
        columns.append(p.column("value", _by_key(self.spec["measures"], definition.measure)["label"], fmt))
        if any("compare" in row["cells"] for row in shape.rows):
            columns.append(p.column("compare", "Compared", fmt))
            columns.append(p.column("change", "Change", delta_fmt))
        if not shape.rows:
            shape.rows = [{"key": "total", "cells": {"value": shape.total}}]
        if len(shape.rows) > self.limits["max_table_rows"]:
            raise ReportError("too_many_rows")
        return p.table("report", columns, [p.row(row["key"], row["cells"]) for row in shape.rows])


def build_payload(definition: Definition, compiler: Compiler) -> dict[str, Any]:
    validate(definition, compiler.spec)
    body = compiler.compute(definition)
    period = periods.resolve(definition.period_preset, compiler.anchor, definition.period_from, definition.period_to)
    compare = periods.compared(period, definition.compare_mode)
    result = p.empty_payload(
        report_id=definition.id,
        variant_key="",
        anchor_date=compiler.anchor.isoformat(),
        title=definition.name,
        description=definition.description,
        period=period.as_payload(),
        compare=None if compare is None else {"mode": definition.compare_mode, "from": compare.start.isoformat(), "to": compare.end.isoformat(), "label": compare.label},
    )
    result.update(body)
    missing = sorted(compiler.mart.missing_currencies)
    if missing:
        result["warnings"].append({"code": "missing_rate", "currencies": missing})
    problems = p.validate(result)
    if problems:
        raise ValueError(f"invalid_payload:{problems[0]}")
    return result


def step(conn: Any, context: BuildContext) -> None:
    spec = config.contract("report-definition")
    definitions = read(conn)
    compiler = Compiler(context.mart, spec, context.anchor_date)
    rows: list[tuple[str, str, str, str]] = []
    results: list[tuple[str, str, str, str, str | None]] = []
    for definition in definitions:
        started = time.monotonic()
        try:
            body = build_payload(definition, compiler)
        except Exception as error:  # one report must not fail the run
            code = str(error) if isinstance(error, ReportError) else error_code(error)
            logger.warning(f"user_defined: report_id={definition.id} failed=true error={type(error).__name__} reason={code[:120]}")
            results.append((context.generation_id, definition.id, definition.updated_at, "failed", code[:200]))
            context.reports_failed += 1
            continue
        rows.append((context.generation_id, definition.id, "", json.dumps(body, separators=(",", ":"), allow_nan=False)))
        results.append((context.generation_id, definition.id, definition.updated_at, "ready", None))
        context.reports_ok += 1
        logger.info(f"user_defined: report_id={definition.id} measure={definition.measure} chart_kind={definition.chart_kind} seconds={time.monotonic() - started:.2f}")
    with conn.cursor() as cursor:
        if rows:
            execute_values(cursor, "INSERT INTO analytics.report_output (generation_id, report_id, variant_key, payload) VALUES %s", rows, template="(%s, %s, %s, %s::jsonb)")
        if results:
            execute_values(cursor, "INSERT INTO analytics.report_result (generation_id, report_id, definition_updated_at, status, error_code) VALUES %s", results)
    logger.info(f"user_defined: reports={len(results)} ready={len(rows)} failed={len(results) - len(rows)} total_chars={sum(len(row[3]) for row in rows)}")
