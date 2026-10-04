"""The mart: the ledger as facts in XAU (grams of gold) and UTC dates, read once per build.

Read inside the build's REPEATABLE READ snapshot and kept in memory (a personal ledger is
small), so every report of a run sees exactly the same data. Rules:

- **Flows** (income / spending): non-deleted transactions, without own-account transfer
  legs (a child leg, or a parent with a live child). Dated by the UTC date of
  `tx_date_time_base`. XAU is the stored `tx_amount_base` (valued at the rate on the
  transaction date); local amounts in major units of the account currency.
- **Tags**: lower-cased, trimmed and de-duplicated; a row's amount is split equally
  across its tags.
- **Balances**: per account, the opening amount plus every non-deleted movement
  (transfer legs included) at or after the tracking start. Future-dated movements count
  in the current balance (as the app always did) but not in a balance on an earlier day.
  XAU = local balance / the currency's rate on that day (latest rate on or before it);
  no rate → no XAU value and the currency is reported missing.
- **Tracking start** is the account's local wall time in its timezone (blank = Europe/London),
  converted to UTC with zoneinfo; a DST gap resolves forward (zoneinfo's rule), never dropped.
  An unreadable date or timezone is a data warning, never a failed build.
"""

from __future__ import annotations

import bisect
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from py_logging import get_logger

from core import places
from core.context import BuildContext

logger = get_logger(__name__)

DEFAULT_TIMEZONE = "Europe/London"
_LOCAL_DATETIME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$")
_NANOGRAMS = Decimal(1_000_000_000)


@dataclass(frozen=True)
class Account:
    id: str
    name: str
    type: str  # asset | investment | liability
    subtype: str
    type_label: str
    subtype_label: str
    detail_sheet: str
    currency: str
    record_status: str
    tracking_start: datetime | None  # UTC
    start_date: date | None  # first day the balance exists
    opening_local: Decimal


@dataclass(frozen=True)
class Flow:
    tx_id: str
    day: date  # UTC date
    account_id: str
    currency: str
    tx_type: str  # money-in | money-out
    amount_local: Decimal
    amount_xau: float  # grams
    major_key: str
    major_label: str
    minor_key: str
    minor_label: str
    subscription_eligible: bool
    payee: str
    country: str
    city: str
    tags: tuple[str, ...]

    @property
    def kind(self) -> str:
        return "income" if self.tx_type == "money-in" else "spend"


@dataclass
class Mart:
    anchor: date
    accounts: dict[str, Account]
    flows: list[Flow]
    categories: list[dict[str, Any]]
    # Money-out transfer legs into a liability (loan / card repayments): not income or
    # spending, but recurring payments. payee = the payee, or the liability's name.
    repayments: list[Flow] = field(default_factory=list)
    # account id → sorted (UTC day, signed local amount) of every counted movement (transfer legs included)
    movements: dict[str, list[tuple[date, Decimal]]] = field(default_factory=dict)
    # account id → (sorted UTC dates, cumulative local balance after that date, including opening)
    _balance_steps: dict[str, tuple[list[date], list[Decimal]]] = field(default_factory=dict)
    _current_local: dict[str, Decimal] = field(default_factory=dict)
    # currency → (sorted rate dates, rates in units per gram)
    _rates: dict[str, tuple[list[date], list[float]]] = field(default_factory=dict)
    missing_currencies: set[str] = field(default_factory=set)
    warnings: Counter[str] = field(default_factory=Counter)
    rows_not_loaded: int = 0

    # ── Rates ─────────────────────────────────────────────────────────────────

    def rate(self, currency: str, day: date) -> float | None:
        """Units of the currency per gram of XAU on that day (latest rate on or before it)."""
        if currency == "XAU":
            return 1.0
        series = self._rates.get(currency)
        if series is None:
            return None
        index = bisect.bisect_right(series[0], day) - 1
        return series[1][index] if index >= 0 else None

    def to_xau(self, amount_local: Decimal, currency: str, day: date) -> float | None:
        rate = self.rate(currency, day)
        if rate is None or rate <= 0:
            self.missing_currencies.add(currency)
            return None
        return float(amount_local) / rate

    # ── Balances ──────────────────────────────────────────────────────────────

    def balance_local(self, account_id: str, day: date) -> Decimal | None:
        """Balance at the end of a UTC day, or None before the account's balance starts."""
        account = self.accounts[account_id]
        if account.start_date is None or day < account.start_date:
            return None
        dates, totals = self._balance_steps.get(account_id, ([], []))
        index = bisect.bisect_right(dates, day) - 1
        return totals[index] if index >= 0 else account.opening_local

    def balance_xau(self, account_id: str, day: date) -> float | None:
        local = self.balance_local(account_id, day)
        return None if local is None else self.to_xau(local, self.accounts[account_id].currency, day)

    def current_local(self, account_id: str) -> Decimal:
        """Opening plus every counted movement, future-dated ones included."""
        return self._current_local.get(account_id, self.accounts[account_id].opening_local)

    def current_xau(self, account_id: str) -> float | None:
        return self.to_xau(self.current_local(account_id), self.accounts[account_id].currency, self.anchor)

    def live_accounts(self) -> list[Account]:
        """Every non-deleted account (net worth counts active, inactive and locked ones)."""
        return [account for account in self.accounts.values() if account.record_status != "deleted"]


# ── Reading the ledger ────────────────────────────────────────────────────────

_ACCOUNTS = """
SELECT a.id::text, a.account_name, a.account_type, a.account_subtype, coalesce(t.account_type_label, a.account_type),
       coalesce(t.account_subtype_label, a.account_subtype), coalesce(t.detail_sheet, ''), a.local_currency, a.record_status,
       a.tracking_start_date_local, a.opening_date_local, a.local_timezone, a.opening_amount_local_value, coalesce(c.decimal_places, 2)
FROM account_master a
LEFT JOIN account_types t ON t.account_type_key = a.account_type AND t.account_subtype_key = a.account_subtype
LEFT JOIN currency_master c ON c.currency_code = a.local_currency
"""

_TRANSACTIONS = """
SELECT t.transaction_id, t.parent_tx_id, t.record_status, t.tx_date_time_base, t.account_id::text, t.local_currency,
       t.tx_amount_local, t.tx_amount_base, coalesce(c.decimal_places, 2), cat.tx_type_key, cat.major_category_key,
       cat.major_category_label, cat.minor_category_key, cat.minor_category_label, coalesce(cat.is_subscription_eligible, false),
       coalesce(cp.counterparty_label, ''), t.user_location_country, t.user_location_city, coalesce(t.tx_tags, '')
FROM transaction_master t
LEFT JOIN category_master cat ON cat.id = t.category_id
LEFT JOIN counterparty_master cp ON cp.id = t.counterparty_id
LEFT JOIN currency_master c ON c.currency_code = t.local_currency
ORDER BY t.tx_date_time_base, t.transaction_id
"""

_CATEGORIES = """
SELECT tx_type_key, major_category_key, major_category_label, minor_category_key, minor_category_label,
       is_subscription_eligible, record_status
FROM category_master ORDER BY tx_type_key, major_category_label, minor_category_label
"""

_RATES = "SELECT quote_currency_code, rate_date, rate_value FROM currency_rates WHERE quote_currency_code = ANY(%s) ORDER BY 1, 2"

_ROWS_NOT_LOADED = """
SELECT count(*) FROM stg_sheet_rows
WHERE run_id = (SELECT run_id FROM stg_runs ORDER BY captured_at DESC, run_id DESC LIMIT 1)
  AND outcome_status IN ('create-failed', 'update-failed')
"""


def _local_datetime(text: str | None) -> datetime | None:
    match = _LOCAL_DATETIME.match((text or "").strip())
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(part) if part else 0 for part in match.groups())
    try:
        return datetime(year, month, day, hour, minute, second)
    except ValueError:
        return None


def _zone(name: str | None, warnings: Counter[str]) -> ZoneInfo:
    try:
        return ZoneInfo((name or "").strip() or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        warnings["invalid_timezone"] += 1
        return ZoneInfo(DEFAULT_TIMEZONE)


def _major(minor_units: int, decimal_places: int) -> Decimal:
    return Decimal(minor_units).scaleb(-int(decimal_places))


def _tags(text: str) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for part in text.split(";"):
        tag = part.strip().lower()
        if tag:
            seen[tag] = None
    return tuple(seen)


def load(conn: Any, anchor: date) -> Mart:
    warnings: Counter[str] = Counter()
    with conn.cursor() as cursor:
        cursor.execute(_ACCOUNTS)
        account_rows = cursor.fetchall()
        cursor.execute(_TRANSACTIONS)
        transaction_rows = cursor.fetchall()
        cursor.execute(_CATEGORIES)
        categories = [
            {"tx_type": tx_type, "major_key": major, "major_label": major_label, "minor_key": minor, "minor_label": minor_label, "subscription_eligible": bool(eligible), "record_status": status}
            for tx_type, major, major_label, minor, minor_label, eligible, status in cursor.fetchall()
        ]
        cursor.execute(_ROWS_NOT_LOADED)
        rows_not_loaded = int(cursor.fetchone()[0])

    accounts: dict[str, Account] = {}
    for identity, name, account_type, subtype, type_label, subtype_label, detail_sheet, currency, status, tracking, opening, zone_name, opening_minor, places_dp in account_rows:
        zone = _zone(zone_name, warnings)
        tracking_local = _local_datetime(tracking)
        if (tracking or "").strip() and tracking_local is None:
            warnings["invalid_tracking_start"] += 1
        tracking_utc = None if tracking_local is None else tracking_local.replace(tzinfo=zone).astimezone(timezone.utc)
        opening_local = _local_datetime(opening)
        accounts[identity] = Account(
            id=identity,
            name=name,
            type=account_type,
            subtype=subtype,
            type_label=type_label,
            subtype_label=subtype_label,
            detail_sheet=detail_sheet,
            currency=(currency or "").strip(),
            record_status=status,
            tracking_start=tracking_utc,
            start_date=tracking_utc.date() if tracking_utc else (opening_local.date() if opening_local else None),
            opening_local=_major(opening_minor or 0, places_dp),
        )

    # Own-account transfer legs: a child, or a parent with a live child.
    parents_with_live_child = {parent for _, parent, status, *_ in transaction_rows if parent and status != "deleted"}
    child_account = {row[1]: row[4] for row in transaction_rows if row[1] and row[2] != "deleted"}
    repayments: list[Flow] = []
    flows: list[Flow] = []
    movements: dict[str, list[tuple[date, Decimal]]] = {}
    for (
        tx_id,
        parent,
        status,
        when,
        account_id,
        currency,
        amount_minor,
        base_minor,
        places_dp,
        tx_type,
        major,
        major_label,
        minor,
        minor_label,
        eligible,
        payee,
        country,
        city,
        tags,
    ) in transaction_rows:
        if status == "deleted":
            continue
        if tx_type not in ("money-in", "money-out"):
            warnings["transaction_without_category"] += 1
            continue
        amount_local = _major(amount_minor, places_dp)
        account = accounts.get(account_id)
        if account is not None and (account.tracking_start is None or when >= account.tracking_start):
            movements.setdefault(account_id, []).append((when.astimezone(timezone.utc).date(), amount_local if tx_type == "money-in" else -amount_local))
        record = Flow(
            tx_id=tx_id,
            day=when.astimezone(timezone.utc).date(),
            account_id=account_id,
            currency=(currency or "").strip(),
            tx_type=tx_type,
            amount_local=amount_local,
            amount_xau=float(Decimal(base_minor) / _NANOGRAMS),
            major_key=major or "",
            major_label=major_label or major or "",
            minor_key=minor or "",
            minor_label=minor_label or minor or "",
            subscription_eligible=bool(eligible),
            payee=(payee or "").strip(),
            country=places.country(country),
            city=places.city(city),
            tags=_tags(tags),
        )
        if parent or tx_id in parents_with_live_child:
            target = accounts.get(child_account.get(tx_id, ""))
            if tx_type == "money-out" and not parent and target is not None and target.type == "liability":
                repayments.append(Flow(**{**record.__dict__, "payee": record.payee or target.name}))
            continue
        flows.append(record)

    mart = Mart(anchor=anchor, accounts=accounts, flows=flows, categories=categories, repayments=repayments, warnings=warnings, rows_not_loaded=rows_not_loaded)
    for account_id, account in accounts.items():
        changes = sorted(movements.get(account_id, []))
        mart.movements[account_id] = changes
        dates: list[date] = []
        totals: list[Decimal] = []
        running = account.opening_local
        for day, amount in changes:
            running += amount
            if dates and dates[-1] == day:
                totals[-1] = running
            else:
                dates.append(day)
                totals.append(running)
        mart._current_local[account_id] = running
        # A balance before any future-dated movement: cut the steps at the anchor for history.
        mart._balance_steps[account_id] = (dates, totals)
        if account.start_date is None and changes:
            mart.accounts[account_id] = Account(**{**account.__dict__, "start_date": changes[0][0]})

    currencies = sorted({account.currency for account in accounts.values() if account.currency and account.currency != "XAU"} | {flow.currency for flow in flows if flow.currency != "XAU"})
    with conn.cursor() as cursor:
        cursor.execute(_RATES, (currencies,))
        for currency, rate_date, rate_value in cursor.fetchall():
            series = mart._rates.setdefault(currency.strip(), ([], []))
            series[0].append(rate_date)
            series[1].append(float(rate_value))
    return mart


def step(conn: Any, context: BuildContext) -> None:
    """Build step: read the mart into the context for the report builders."""
    mart = load(conn, context.anchor_date)
    context.mart = mart
    context.rows_not_loaded = mart.rows_not_loaded
    for account in mart.live_accounts():
        mart.current_xau(account.id)  # records currencies without a rate
    context.missing_currencies |= mart.missing_currencies
    warnings = " ".join(f"{name}={count}" for name, count in sorted(mart.warnings.items())) or "none"
    logger.info(f"mart: accounts={len(mart.accounts)} flows={len(mart.flows)} rows_not_loaded={mart.rows_not_loaded} missing_currencies={len(mart.missing_currencies)} warnings={warnings}")
