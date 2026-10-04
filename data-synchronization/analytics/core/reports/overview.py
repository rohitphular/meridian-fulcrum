"""Overview: the Home numbers (single values), the Home panels and the Accounts datasets."""

from __future__ import annotations

import math
from datetime import timedelta
from typing import Any

from core import payload as p
from core.mart import Mart
from core.periods import add_months, resolve
from core.reports import report
from core.reports.common import (
    by_month,
    current_net_worth,
    dti_status,
    first_flow_day,
    flows,
    month_label,
    monthly_income_average,
    net_worth_on,
    total,
)
from core.reports.context import ReportContext
from core.reports.payees_places import recurring_payments

LIQUID_DETAIL_SHEET = "account_deposit"


def _number(value: Any, fmt: str, label: str, sub: Any = None, tone: str | None = None) -> dict[str, Any]:
    return {"stat_cards": [p.stat("value", label, value, fmt, sub=sub, tone=tone)]}


def _income_summary(mart: Mart) -> tuple[float, int, float]:
    """(average monthly income over complete months, months counted, annualised)."""
    first = first_flow_day(mart) or mart.anchor.replace(month=1, day=1)
    average, months = monthly_income_average(mart, first, mart.anchor)
    return average, months, average * 12


def _dti(mart: Mart) -> tuple[float | None, float, str, str, bool]:
    _, owed, _ = current_net_worth(mart)
    debt = max(0.0, owed)
    _, _, annual = _income_summary(mart)
    has_income = annual > 0
    ratio = debt / annual * 100 if has_income else None
    status, label = dti_status(ratio, debt, has_income)
    return ratio, debt, status, label, has_income


_TONES = {"excellent": "positive", "good": "positive", "debt_free": "positive", "caution": "warn", "high_risk": "negative", "na": "muted"}


# ── Home numbers ──────────────────────────────────────────────────────────────


@report("kpi-net-worth")
def kpi_net_worth(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    _, _, worth = current_net_worth(mart)
    month_start = mart.anchor.replace(day=1)
    _, _, before = net_worth_on(mart, month_start - timedelta(days=1))
    sub = None if before is None else p.text("{0} this month", p.money(worth - before, "money_delta"))
    return _number(worth, "money", "Net worth", sub, "positive" if worth >= 0 else "negative")


@report("kpi-total-assets")
def kpi_assets(context: ReportContext) -> dict[str, Any]:
    assets, _, _ = current_net_worth(context.mart)
    return _number(assets, "money", "Total assets")


@report("kpi-total-liabilities")
def kpi_liabilities(context: ReportContext) -> dict[str, Any]:
    _, owed, _ = current_net_worth(context.mart)
    return _number(owed, "money", "Total liabilities", p.text("owed across liability accounts"))


@report("kpi-total-debt")
def kpi_debt(context: ReportContext) -> dict[str, Any]:
    _, owed, _ = current_net_worth(context.mart)
    return _number(max(0.0, owed), "money", "Total debt")


@report("kpi-monthly-income")
def kpi_monthly_income(context: ReportContext) -> dict[str, Any]:
    average, months, _ = _income_summary(context.mart)
    return _number(average, "money", "Monthly income", p.text("average of {0} months", {"value": months, "format": "count"}))


@report("kpi-annualised-income")
def kpi_annual_income(context: ReportContext) -> dict[str, Any]:
    _, _, annual = _income_summary(context.mart)
    return _number(annual, "money", "Annualised income")


@report("kpi-spend-this-month")
def kpi_spend_month(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    period = resolve("this_month", mart.anchor)
    now = total(flows(mart, period.start, period.end, "spend"))
    before = total(flows(mart, period.compare_start, period.compare_end, "spend"))
    sub = p.text("{0} vs the same days last month", {"value": (now - before) / before * 100 if before else None, "format": "percent_delta"})
    return _number(now, "money", "Spending this month", sub, "positive" if now <= before else "warn")


@report("kpi-savings-rate-this-month")
def kpi_savings_rate(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    period = resolve("this_month", mart.anchor)
    income = total(flows(mart, period.start, period.end, "income"))
    spend = total(flows(mart, period.start, period.end, "spend"))
    rate = (income - spend) / income * 100 if income > 0 else None
    return _number(rate, "percent", "Savings rate this month", tone=None if rate is None else ("positive" if rate >= 0 else "negative"))


@report("kpi-debt-to-income")
def kpi_dti(context: ReportContext) -> dict[str, Any]:
    ratio, _, status, label, _ = _dti(context.mart)
    return _number(ratio, "percent", "Debt to income", p.text(label), _TONES[status])


@report("kpi-liquid-cash")
def kpi_liquid(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    liquid = [account for account in mart.live_accounts() if account.type == "asset" and account.detail_sheet == LIQUID_DETAIL_SHEET]
    value = sum(mart.current_xau(account.id) or 0.0 for account in liquid)
    return _number(value, "money", "Liquid cash", p.text("{0} accounts", {"value": len(liquid), "format": "count"}))


def debt_free_months(mart: Mart) -> tuple[int | None, float]:
    """Months to clear today's debt at the average monthly reduction since the first flow month."""
    _, owed_now, _ = current_net_worth(mart)
    if owed_now <= 0:
        return 0, 0.0
    first = first_flow_day(mart)
    if first is None:
        return None, 0.0
    first_month = first.replace(day=1)
    months = (mart.anchor.year - first_month.year) * 12 + mart.anchor.month - first_month.month + 1
    if months < 2:
        return None, 0.0
    # Owed then, valued at today's rate like owed now, so a gold move is not counted as paydown.
    owed_then = 0.0
    for account in mart.live_accounts():
        if account.type != "liability":
            continue
        local = mart.balance_local(account.id, first_month)
        value = None if local is None else mart.to_xau(local, account.currency, mart.anchor)
        owed_then -= value or 0.0
    reduction = (owed_then - owed_now) / months
    return (math.ceil(owed_now / reduction), reduction) if reduction > 0 else (None, reduction)


@report("kpi-debt-free")
def kpi_debt_free(context: ReportContext) -> dict[str, Any]:
    months, reduction = debt_free_months(context.mart)
    if months == 0:
        return _number(0, "count", "Debt-free in", p.text("debt free"), "positive")
    sub = p.text("at {0} a month", p.money(reduction)) if months else p.text("debt is not going down yet")
    return _number(months, "count", "Debt-free in (months)", sub)


@report("kpi-recurring-monthly")
def kpi_recurring(context: ReportContext) -> dict[str, Any]:
    items = recurring_payments(context.mart)
    return _number(sum(item.monthly for item in items), "money", "Recurring payments per month", p.text("{0} payees", {"value": len(items), "format": "count"}))


# ── Home panels ───────────────────────────────────────────────────────────────


@report("home-income-trend")
def income_trend(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    first = (first_flow_day(mart) or mart.anchor.replace(month=1, day=1)).replace(day=1)
    months = []
    current = first
    while current <= mart.anchor:
        months.append(current)
        current = add_months(current, 1)
    income = by_month(flows(mart, None, mart.anchor, "income"))
    spend = by_month(flows(mart, None, mart.anchor, "spend"))
    values = [income.get(month, 0.0) for month in months]
    if not any(values):
        return {"empty": {"text": "No income yet."}}
    peak = max(range(len(values)), key=lambda index: values[index])
    average, counted, annual = _income_summary(mart)
    return {
        "stat_cards": [
            p.stat("total", "Total income", sum(values), "money"),
            p.stat("monthly", "Monthly average", average, "money", sub=p.text("{0} complete months", {"value": counted, "format": "count"})),
            p.stat("annual", "Annualised", annual, "money"),
            p.stat("peak", "Peak month", values[peak], "money", sub=p.text("{0}", {"value": months[peak].isoformat()[:7], "format": "month"})),
        ],
        "charts": [
            p.chart(
                "income",
                "bar",
                [month_label(month) for month in months],
                [
                    p.series("income", "Income", values, "income", point_tones=["highlight" if index == peak else "neutral" for index in range(len(values))]),
                    p.series("expense", "Spending", [spend.get(month, 0.0) for month in months], "expense", hidden=True),
                ],
            )
        ],
    }


@report("home-debt-to-income")
def dti_panel(context: ReportContext) -> dict[str, Any]:
    ratio, debt, status, label, has_income = _dti(context.mart)
    _, _, annual = _income_summary(context.mart)
    gauge_value = None if ratio is None else min(ratio, 100.0)
    return {
        "stat_cards": [
            p.stat("ratio", "Debt to income", ratio, "percent", tone=_TONES[status]),
            p.stat("debt", "Total debt", debt, "money"),
            p.stat("income", "Annualised income", annual, "money"),
            p.stat("status", "Status", label, "text", tone=_TONES[status]),
        ],
        "charts": [
            p.chart(
                "gauge",
                "gauge",
                [],
                [],
                y_format="percent",
                gauge={"value": gauge_value, "max": 100, "status": status, "label": label, "sub": "of annual income" if has_income else "no income yet"},
                ref_lines=[{"value": 20, "label": "Excellent", "tone": "positive"}, {"value": 36, "label": "Good", "tone": "neutral"}, {"value": 50, "label": "Caution", "tone": "warn"}],
            )
        ],
    }


# ── Accounts datasets ─────────────────────────────────────────────────────────


@report("dataset-accounts-summary")
def accounts_summary(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    assets, owed, worth = current_net_worth(mart)
    liquid = sum(mart.current_xau(account.id) or 0.0 for account in mart.live_accounts() if account.type == "asset" and account.detail_sheet == LIQUID_DETAIL_SHEET)
    types: dict[str, list[Any]] = {}
    for account in mart.live_accounts():
        entry = types.setdefault(account.type, [account.type_label, 0.0, 0])
        entry[1] += mart.current_xau(account.id) or 0.0
        entry[2] += 1
    return {
        "stat_cards": [
            p.stat("total_assets", "Total assets", assets, "money"),
            p.stat("total_liabilities", "Total liabilities", owed, "money"),
            p.stat("net_worth", "Net worth", worth, "money", tone="positive" if worth >= 0 else "negative"),
            p.stat("liquid_cash", "Liquid cash", liquid, "money"),
        ],
        "tables": [
            p.table(
                "types",
                [p.column("type", "Type"), p.column("label", "Label"), p.column("accounts", "Accounts", "count"), p.column("total", "Total", "money")],
                [p.row(key, {"type": key, "label": label, "accounts": count, "total": value}) for key, (label, value, count) in sorted(types.items())],
            )
        ],
    }


@report("dataset-account-balances")
def account_balances(context: ReportContext) -> dict[str, Any]:
    mart = context.mart
    columns = [
        p.column("account_id", "Account id"),
        p.column("name", "Account"),
        p.column("type", "Type"),
        p.column("subtype", "Subtype"),
        p.column("currency", "Currency"),
        p.column("record_status", "Status"),
        p.column("balance_local", "Balance", "local"),
        p.column("balance", "Value", "money"),
    ]
    rows = []
    for account in sorted(mart.accounts.values(), key=lambda item: (item.type, item.name.lower())):
        value = mart.current_xau(account.id)
        rows.append(
            p.row(
                account.id,
                {
                    "account_id": account.id,
                    "name": account.name,
                    "type": account.type,
                    "subtype": account.subtype_label,
                    "currency": account.currency,
                    "record_status": account.record_status,
                    "balance_local": float(mart.current_local(account.id)),
                    "balance": value,
                },
                tone="warn" if value is None else None,
            )
        )
    return {"tables": [p.table("balances", columns, rows)]}
