"""Net worth, balances, liabilities, loans and debt to income (balances valued in XAU on their day)."""

from __future__ import annotations

import math
from datetime import date
from decimal import Decimal
from typing import Any

from core import payload as p
from core.mart import Account, Mart
from core.periods import Period, add_months
from core.reports import report
from core.reports.common import (
    by_month,
    current_net_worth,
    day_label,
    dti_status,
    first_flow_day,
    flows,
    month_ends,
    month_label,
    net_worth_on,
    query,
)
from core.reports.context import ReportContext
from core.reports.overview import _TONES

MAX_VISIBLE_LINES = 6
PROJECTION_POINTS = 3
DTI_THRESHOLD = 36


def _tone(value: float | None) -> str:
    return "neutral" if value is None else ("negative" if value < 0 else "positive")


def _tracked_from(mart: Mart, accounts: list[Account]) -> date | None:
    return min((account.start_date for account in accounts if account.start_date), default=None)


def _points(mart: Mart, period: Period | None, tracked: date | None) -> list[date]:
    """Month-end sample days of the period (clipped to its end); a period without a start begins at the tracked-from month."""
    end = mart.anchor if period is None else min(period.end, mart.anchor)
    start = None if period is None else period.start
    if start is None:
        start = min(tracked, end) if tracked else end.replace(day=1)
    return month_ends(start, end)


def _worth_series(mart: Mart, days: list[date]) -> list[tuple[float | None, float | None, float | None]]:
    return [net_worth_on(mart, day) for day in days]


def _tracked_note(tracked: date | None, values: list[float | None]) -> dict[str, Any] | None:
    if tracked is None or not values or values[0] is not None:
        return None
    return p.text("Tracked from {0}; earlier points are blank.", {"value": tracked.isoformat(), "format": "date"})


def _first(values: list[float | None]) -> float | None:
    return next((value for value in values if value is not None), None)


def _last(values: list[float | None]) -> float | None:
    return next((value for value in reversed(values) if value is not None), None)


def _empty(text: str) -> dict[str, Any]:
    return {"empty": {"text": text}}


# ── 14 Net worth trend ────────────────────────────────────────────────────────


def _trend_points(context: ReportContext) -> tuple[list[date], list[float | None]]:
    mart = context.mart
    points = _points(mart, context.period, _tracked_from(mart, mart.live_accounts()))
    return points, [worth for _, _, worth in _worth_series(mart, points)]


def _trend_drills(context: ReportContext) -> list[str]:
    points, values = _trend_points(context)
    return [f"date:{day.isoformat()}" for day, value in zip(points, values) if value is not None]


def _balances_drill(mart: Mart, day: date) -> dict[str, Any]:
    rows = []
    for account in mart.live_accounts():
        local = mart.balance_local(account.id, day)
        if local is None:
            continue
        rows.append((account, float(local), mart.to_xau(local, account.currency, day)))
    rows.sort(key=lambda item: (item[2] is None, -abs(item[2] or 0.0), item[0].name.lower()))
    _, _, worth = net_worth_on(mart, day)
    return {
        "title": p.text("Account balances on {0}", {"value": day.isoformat(), "format": "date"}),
        "subtitle": p.text("{0} accounts", {"value": len(rows), "format": "count"}),
        "table": p.table(
            "balances",
            [p.column("account", "Account"), p.column("type", "Type"), p.column("currency", "Currency"), p.column("balance_local", "Balance", "local"), p.column("balance", "Value", "money")],
            [
                p.row(
                    account.id,
                    {"account": account.name, "type": account.type_label, "currency": account.currency, "balance_local": local, "balance": value},
                    tone="warn" if value is None else _tone(value),
                )
                for account, local, value in rows
            ],
            total_row={"cells": {"account": "Net worth", "type": "", "currency": "", "balance": worth}},
        ),
    }


@report("14-networth-trend", drills=_trend_drills)
def networth_trend(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    if not mart.live_accounts():
        return _empty("No accounts found.")
    points, values = _trend_points(context)
    if context.drill:
        day = date.fromisoformat(context.drill["date"])
        return {"drill": _balances_drill(mart, day)}
    _, _, now = current_net_worth(mart)
    previous_end = date.fromordinal(mart.anchor.replace(day=1).toordinal() - 1)
    year_end = date.fromordinal(add_months(mart.anchor.replace(day=1), -11).toordinal() - 1)
    _, _, previous = net_worth_on(mart, previous_end)
    _, _, year = net_worth_on(mart, year_end)
    month_delta = None if previous is None else now - previous
    year_delta = None if year is None else now - year
    if year is None:
        year_sub = p.text("not tracked on {0}", {"value": year_end.isoformat(), "format": "date"})
    else:
        year_sub = p.text("{0} vs {1}", {"value": year_delta / abs(year) * 100 if year else None, "format": "percent_delta"}, {"value": year_end.isoformat(), "format": "date"})
    notes = [note for note in [_tracked_note(_tracked_from(mart, mart.live_accounts()), values)] if note]
    last = _last(values)
    if context.period and context.period.end >= mart.anchor and last is not None and abs(last - now) > 1e-6:
        notes.append(p.text("Net worth now includes future-dated transactions; the chart shows balances as of each date."))
    return {
        "stat_cards": [
            p.stat("net_worth", "Net worth", now, "money", sub=p.text("all accounts, now"), tone=_tone(now)),
            p.stat("month_change", "Change this month", month_delta, "money_delta", sub=p.text("since {0}", {"value": previous_end.isoformat(), "format": "date"}), tone=_tone(month_delta)),
            p.stat("year_change", "vs 12 months ago", year_delta, "money_delta", sub=year_sub, tone=_tone(year_delta)),
        ],
        "charts": [
            p.chart(
                "net_worth",
                "line",
                [month_label(day) for day in points],
                [p.series("net_worth", "Net worth", values, "primary", fill="signed")],
                drill={
                    "param": "date",
                    "values": [day.isoformat() if value is not None else None for day, value in zip(points, values)],
                    "mode": "panel",
                    "hint": "Tap a point to see account balances on that date",
                },
            )
        ],
        "notes": notes,
    }


# ── 15 Account balances ───────────────────────────────────────────────────────


@report("15-account-balances")
def account_balances(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    accounts = mart.live_accounts()
    if not accounts:
        return _empty("No accounts found.")
    valued = [(account, mart.current_xau(account.id)) for account in accounts]
    valued = [(account, value) for account, value in valued if value is not None]

    def pick(kind: str, reverse: bool) -> list[tuple[Account, float]]:
        return sorted([item for item in valued if item[0].type == kind], key=lambda item: ((-item[1] if reverse else item[1]), item[0].name.lower()))

    assets, investments, liabilities = pick("asset", True), pick("investment", True), pick("liability", False)
    _, owed, worth = current_net_worth(mart)

    def section(chart_id: str, title: str, items: list[tuple[Account, float]], style: str, label: str, sign: int, empty_text: str) -> dict[str, Any]:
        return p.chart(chart_id, "hbar", [account.name for account, _ in items], [p.series("balance", label, [sign * value for _, value in items], style)], title=title, empty_text=empty_text)

    def count(items: list[Any]) -> dict[str, Any]:
        return p.text("{0} accounts", {"value": len(items), "format": "count"})

    charts = [
        section("assets", "Assets", assets, "asset", "Balance", 1, "No asset accounts."),
        section("liabilities", "Liabilities (owed)", liabilities, "liability", "Owed", -1, "No liability accounts."),
    ]
    if investments:
        charts.append(section("investments", "Investments", investments, "compare", "Value", 1, ""))
    return {
        "stat_cards": [
            p.stat("assets", "Assets", sum(value for _, value in assets), "money", sub=count(assets), tone="positive"),
            p.stat("liabilities", "Liabilities", owed, "money", sub=count(liabilities), tone="negative"),
            p.stat("investments", "Investments", sum(value for _, value in investments), "money", sub=count(investments)),
            p.stat("net_worth", "Net worth", worth, "money", sub=p.text("assets + investments − liabilities"), tone=_tone(worth)),
        ],
        "charts": charts,
    }


# ── 16 Assets vs liabilities ──────────────────────────────────────────────────


@report("16-asset-vs-liability")
def asset_vs_liability(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    accounts = mart.live_accounts()
    if not accounts:
        return _empty("No accounts found.")
    tracked = _tracked_from(mart, accounts)
    points = _points(mart, context.period, tracked)
    series = _worth_series(mart, points)
    assets = [item[0] for item in series]
    owed = [item[1] for item in series]
    nets = [item[2] for item in series]
    total_assets, total_owed, worth = current_net_worth(mart)
    ends_today = context.period is None or context.period.end >= mart.anchor
    end_net = worth if ends_today else _last(nets)
    start_net = _first(nets)
    change = None if end_net is None or start_net is None else end_net - start_net
    first_index = next((index for index, value in enumerate(nets) if value is not None), None)
    notes = [note for note in [_tracked_note(tracked, nets)] if note]
    return {
        "stat_cards": [
            p.stat("total_assets", "Total assets", total_assets, "money", sub=p.text("now"), tone="positive"),
            p.stat("total_liabilities", "Total liabilities", total_owed, "money", sub=p.text("now"), tone="negative"),
            p.stat("net_worth", "Net worth", worth, "money", sub=p.text("now"), tone=_tone(worth)),
            p.stat(
                "period_change",
                "Period change in net worth",
                change,
                "money_delta",
                sub=None if first_index is None else p.text("since {0}", {"value": points[first_index].isoformat(), "format": "date"}),
                tone=_tone(change),
            ),
        ],
        "charts": [
            p.chart(
                "assets_liabilities",
                "area",
                [month_label(day) for day in points],
                [p.series("assets", "Total assets", assets, "asset", fill="origin"), p.series("liabilities", "Total liabilities", owed, "liability", fill="origin", dashed=True)],
            )
        ],
        "notes": notes,
    }


# ── 17 Liability paydown ──────────────────────────────────────────────────────


def project_payoff(values: list[float | None]) -> int | None:
    """Months to clear the last value at the mean of the positive reductions over the last points."""
    known = [value for value in values if value is not None]
    if len(known) < 2:
        return None
    reductions = [known[index] - known[index + 1] for index in range(max(0, len(known) - PROJECTION_POINTS), len(known) - 1)]
    positive = [value for value in reductions if value > 0]
    if not positive:
        return None
    if known[-1] <= 0:
        return 0
    return math.ceil(known[-1] / (sum(positive) / len(positive)))


def _at_anchor(mart: Mart, account: Account, local: Decimal | float | None) -> float | None:
    """A local amount valued at the anchor's rate: paydown compares owed amounts at one rate, so gold moves are not repayments."""
    return None if local is None else mart.to_xau(Decimal(str(local)), account.currency, mart.anchor)


def _owed_local_now(mart: Mart, account: Account) -> float:
    return -float(mart.current_local(account.id))


def _owed_local_opening(account: Account) -> float | None:
    return None if account.start_date is None else -float(account.opening_local)


def _liabilities(mart: Mart) -> list[Account]:
    return sorted([account for account in mart.live_accounts() if account.type == "liability"], key=lambda account: account.name.lower())


def _payoff_month(mart: Mart, months: int) -> dict[str, Any]:
    return {"value": add_months(mart.anchor.replace(day=1), months).isoformat()[:7], "format": "month"}


@report("17-liability-paydown")
def liability_paydown(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    liabilities = _liabilities(mart)
    if not liabilities:
        return _empty("No liability accounts found.")
    points = _points(mart, context.period, _tracked_from(mart, liabilities))
    rows = []
    for account in liabilities:
        series, local_series = [], []
        for day in points:
            value, local = mart.balance_xau(account.id, day), mart.balance_local(account.id, day)
            series.append(None if value is None else -value)
            local_series.append(None if local is None else -float(local))
        owed_local, opening_local = _owed_local_now(mart, account), _owed_local_opening(account)
        rows.append((account, _at_anchor(mart, account, owed_local), _at_anchor(mart, account, opening_local), series, owed_local, opening_local, local_series))
    known = [row for row in rows if row[1] is not None]
    outstanding = max(0.0, sum(row[1] for row in known))
    started = sum(row[2] or 0.0 for row in known)
    overall = max(0.0, min(100.0, (1 - outstanding / started) * 100)) if started > 0 else None
    table_rows = []
    for account, owed, _, _, owed_local, opening_local, local_series in known:
        paid = max(0.0, min(100.0, (1 - owed_local / opening_local) * 100)) if opening_local and opening_local > 0 else None
        tone = None
        if owed_local <= 0:
            projection, tone = "Fully paid off", "positive"
        else:
            months = project_payoff(local_series)
            projection = "—" if not months else p.text("~{0} months ({1})", {"value": months, "format": "count"}, _payoff_month(mart, months))
        table_rows.append(p.row(account.id, {"account": account.name, "outstanding": owed, "paid": paid, "projection": projection}, tone=tone))
    return {
        "stat_cards": [
            p.stat("outstanding", "Outstanding", outstanding, "money", tone="negative"),
            p.stat("started_with", "Started with", started if started > 0 else None, "money", sub=p.text("owed at tracking start")),
            p.stat("overall_paid", "Overall paid", overall, "percent", tone=None if overall is None else "positive"),
            p.stat("accounts", "Accounts", len(rows), "count"),
        ],
        "charts": [
            p.chart(
                "paydown",
                "line",
                [month_label(day) for day in points],
                [p.series(account.id, account.name, series, f"palette:{index}", hidden=index >= MAX_VISIBLE_LINES) for index, (account, _, _, series, *_) in enumerate(rows)],
            )
        ],
        "tables": [
            p.table(
                "progress",
                [p.column("account", "Account"), p.column("outstanding", "Outstanding", "money"), p.column("paid", "Paid", "progress"), p.column("projection", "Projected clear", "text", "right")],
                table_rows,
                title="Paydown progress",
                empty_text="No liability balances to show.",
            )
        ],
    }


# ── 26 Loan progress ──────────────────────────────────────────────────────────


def _months_since(anchor: date, start: date | None) -> int:
    if start is None:
        return 1
    return max(1, (anchor.year - start.year) * 12 + anchor.month - start.month)


def _repayments(mart: Mart, account: Account) -> list[tuple[date, float]]:
    """Credits into the liability up to the anchor (transfer legs included), valued at the anchor's rate like the balances they reduce."""
    out = []
    for day, amount in mart.movements.get(account.id, []):
        if day > mart.anchor or amount <= 0:
            continue
        value = _at_anchor(mart, account, amount)
        if value is not None:
            out.append((day, value))
    return out


def _loans(mart: Mart) -> list[dict[str, Any]]:
    loans = []
    for account in _liabilities(mart):
        owed_local = _owed_local_now(mart, account)
        owed = _at_anchor(mart, account, owed_local)
        if owed is None:
            continue
        original_local = _owed_local_opening(account) or 0.0
        repaid_local = max(0.0, original_local - owed_local)
        repayments = _repayments(mart, account)
        start = account.start_date or (repayments[0][0] if repayments else None)
        months = _months_since(mart.anchor, start)
        paid_off = owed_local <= 0
        average_local = repaid_local / months if repaid_local > 0 and not paid_off else 0.0
        loans.append(
            {
                "account": account,
                "owed": owed,
                "original": _at_anchor(mart, account, original_local) or 0.0,
                "has_opening": original_local > 0,
                "repaid": _at_anchor(mart, account, repaid_local) or 0.0,
                "paid": 100.0 if paid_off else (min(100.0, repaid_local / original_local * 100) if original_local > 0 else None),
                "start": start,
                "average": _at_anchor(mart, account, average_local) or 0.0,
                "months_to_payoff": math.ceil(owed_local / average_local) if average_local > 0 and owed_local > 0 else None,
                "paid_off": paid_off,
                "increased": original_local > 0 and owed_local > original_local,
                "repayments": repayments,
            }
        )
    return loans


def _loan_drills(context: ReportContext) -> list[str]:
    return [f"account:{loan['account'].id}" for loan in _loans(context.mart)]


def _loan_drill(mart: Mart, loan: dict[str, Any]) -> dict[str, Any]:
    account = loan["account"]
    repayments = loan["repayments"]
    running, cumulative = 0.0, []
    for _, value in repayments:
        running += value
        cumulative.append(running)
    params = {"account_ids": account.id, "types": "money-in", "range": "custom", "from": loan["start"].isoformat() if loan["start"] else "", "to": mart.anchor.isoformat()}
    charts = []
    if repayments:
        charts.append(
            p.chart(
                "cumulative",
                "line",
                [day_label(day) for day, _ in repayments],
                [p.series("repaid", "Cumulative repaid", cumulative, "income", fill="origin")],
                title="Cumulative repaid",
                y_min=0,
                ref_lines=[{"value": p.grams(loan["original"]), "label": "Original balance", "tone": "muted"}] if loan["has_opening"] else [],
            )
        )
    return {
        "title": account.name,
        "subtitle": p.text("{0} repayments", {"value": len(repayments), "format": "count"}),
        "charts": charts,
        "query": query(params, "Credits into this account"),
    }


@report("26-loan-progress", drills=_loan_drills)
def loan_progress(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    loans = _loans(mart)
    if not loans:
        return _empty("No liability accounts found.")
    if context.drill:
        chosen = next((loan for loan in loans if loan["account"].id == context.drill["account"]), None)
        if chosen is None:
            raise ValueError("invalid_drill")
        return {"drill": _loan_drill(mart, chosen)}
    with_payoff = [loan for loan in loans if loan["months_to_payoff"] is not None and not loan["paid_off"]]
    earliest = min(with_payoff, key=lambda loan: loan["months_to_payoff"], default=None)
    rows = []
    for loan in loans:
        account = loan["account"]
        tone = None
        if loan["paid_off"]:
            payoff, tone = "Paid off", "positive"
        elif loan["increased"]:
            payoff, tone = "Balance increased", "warn"
        elif loan["months_to_payoff"] is not None:
            payoff = p.text("{0} (~{1} months)", _payoff_month(mart, loan["months_to_payoff"]), {"value": loan["months_to_payoff"], "format": "count"})
        else:
            payoff = "No paydown yet"
        rows.append(
            p.row(
                account.id,
                {
                    "loan": account.name,
                    "type": f"{account.subtype_label or 'Liability'} · {account.currency}",
                    "remaining": loan["owed"],
                    "original": loan["original"] if loan["has_opening"] else None,
                    "paid": loan["paid"],
                    "avg_monthly": loan["average"],
                    "payoff": payoff,
                },
                tone=tone,
                drill={"param": "account", "value": account.id, "mode": "panel"},
            )
        )
    return {
        "stat_cards": [
            p.stat("total_debt", "Total debt", max(0.0, sum(loan["owed"] for loan in loans)), "money", tone="negative"),
            p.stat("total_repaid", "Total repaid", sum(loan["repaid"] for loan in loans), "money", sub=p.text("since tracking start"), tone="positive"),
            p.stat("monthly_burden", "Monthly paydown", sum(loan["average"] for loan in loans), "money", sub=p.text("average across loans")),
            p.stat(
                "earliest_payoff",
                "Earliest payoff",
                None if earliest is None else earliest["account"].name,
                "text",
                sub=None if earliest is None else p.text("{0}", _payoff_month(mart, earliest["months_to_payoff"])),
            ),
        ],
        "tables": [
            p.table(
                "loans",
                [
                    p.column("loan", "Loan"),
                    p.column("type", "Type"),
                    p.column("remaining", "Remaining", "money"),
                    p.column("original", "Original", "money"),
                    p.column("paid", "Paid", "progress"),
                    p.column("avg_monthly", "Avg / month", "money2"),
                    p.column("payoff", "Projected payoff", "text", "right"),
                ],
                rows,
                title="Loans",
            )
        ],
        "notes": [p.text("Paydown = owed at tracking start − owed now, averaged per month since tracking start. Tap a loan for its repayments.")],
    }


# ── 27 Debt to income ─────────────────────────────────────────────────────────


def _dti(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    period = context.period
    end = min(period.end, mart.anchor)
    first = first_flow_day(mart)
    first_month = first.replace(day=1) if first else None
    start = period.start
    if start is None:
        start = first_month or mart.anchor.replace(month=1, day=1)
    elif first_month and first_month > start:
        start = first_month
    if start > end:
        start = end.replace(day=1)
    income = by_month(flows(mart, start, end, "income"))
    months = []
    current = start.replace(day=1)
    while current <= end:
        months.append(current)
        current = add_months(current, 1)
    values = [income.get(month, 0.0) for month in months]
    complete = [index for index, month in enumerate(months) if month != mart.anchor.replace(day=1)]
    counted = complete or list(range(len(months)))
    average = sum(values[index] for index in counted) / len(counted) if counted else 0.0
    annual = average * 12
    _, owed, _ = current_net_worth(mart)
    debt = max(0.0, owed)
    ratio = debt / annual * 100 if annual > 0 else None
    status, label = dti_status(ratio, debt, annual > 0)
    return {
        "start": start,
        "end": end,
        "months": months,
        "income": values,
        "average": average,
        "annual": annual,
        "complete": len(complete),
        "debt": debt,
        "ratio": ratio,
        "status": status,
        "label": label,
    }


def _range(dti: dict[str, Any]) -> dict[str, Any]:
    return p.text("{0} to {1}", {"value": dti["start"].isoformat(), "format": "date"}, {"value": dti["end"].isoformat(), "format": "date"})


@report("27-debt-to-income")
def debt_to_income(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    dti = _dti(context)
    labels = [month_label(month) for month in dti["months"]]
    if context.tab != "accounts":
        values = dti["income"]
        peak = max(range(len(values)), key=lambda index: values[index]) if values else None
        return {
            "stat_cards": [
                p.stat("total_income", "Total income", sum(values), "money", sub=_range(dti), tone="positive"),
                p.stat(
                    "avg_monthly",
                    "Avg monthly",
                    dti["average"],
                    "money",
                    sub=p.text("{0} complete months", {"value": dti["complete"], "format": "count"}) if dti["complete"] else p.text("current month only"),
                ),
                p.stat("annualised", "Annualised", dti["annual"], "money"),
                p.stat("peak_month", "Peak month", None if peak is None else dti["months"][peak].isoformat()[:7], "month", sub=None if peak is None else p.text("{0}", p.money(values[peak]))),
            ],
            "charts": [p.chart("income", "bar", labels, [p.series("income", "Income", values, "income")], y_min=0)],
        }
    liabilities = _liabilities(mart)
    tracked = _tracked_from(mart, liabilities)
    trend: list[float | None] = []
    for month in dti["months"]:
        day = min(month_ends(month, month)[0], dti["end"])
        if dti["annual"] <= 0:
            trend.append(None)
        elif not liabilities:
            trend.append(0.0)
        elif tracked and day < tracked:
            trend.append(None)
        else:
            values = [mart.balance_xau(account.id, day) for account in liabilities]
            trend.append(max(0.0, -sum(value for value in values if value is not None)) / dti["annual"] * 100)
    tone = _TONES[dti["status"]]
    notes = []
    if dti["ratio"] is None:
        notes.append(p.text("No income in the period, so the ratio is not available."))
    tracked_note = _tracked_note(tracked, trend) if dti["annual"] > 0 else None
    if tracked_note:
        notes.append(tracked_note)
    return {
        "stat_cards": [
            p.stat("total_debt", "Total debt", dti["debt"], "money", sub=p.text("owed now"), tone="negative"),
            p.stat("monthly_income", "Monthly income (avg)", dti["average"] if dti["average"] > 0 else None, "money", sub=_range(dti)),
            p.stat("annualised_income", "Annualised income", dti["annual"] if dti["annual"] > 0 else None, "money"),
            p.stat("dti_ratio", "DTI ratio", dti["ratio"], "percent", sub=p.text(dti["label"]), tone=tone),
        ],
        "charts": [
            p.chart(
                "gauge",
                "gauge",
                [],
                [],
                y_format="percent",
                gauge={"value": None if dti["ratio"] is None else min(dti["ratio"], 100.0), "max": 100, "status": dti["status"], "label": dti["label"], "tone": tone},
            ),
            p.chart(
                "trend",
                "line",
                labels,
                [p.series("dti", "DTI %", trend, "compare", fill="origin")],
                y_format="percent",
                y_min=0,
                ref_lines=[{"value": DTI_THRESHOLD, "label": "healthy threshold", "tone": "warn"}],
            ),
        ],
        "notes": notes,
    }
