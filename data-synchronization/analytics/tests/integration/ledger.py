"""Builds small ledgers in the disposable database: rates, accounts, categories, transactions.

Amounts are given in major units (and grams of XAU for the stored base value), so tests
read like the hand calculation they check.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4


class Ledger:
    def __init__(self, conn: Any) -> None:
        self.conn = conn
        self._counter = 0

    def _execute(self, sql: str, args: tuple = ()) -> Any:
        with self.conn.cursor() as cursor:
            cursor.execute(sql, args)
            row = cursor.fetchone() if cursor.description else None
        self.conn.commit()
        return row

    def rate(self, currency: str, day: date, value: float) -> None:
        self._execute(
            "INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES (%s, %s, %s, 'test') "
            "ON CONFLICT (quote_currency_code, rate_date) DO UPDATE SET rate_value = EXCLUDED.rate_value",
            (currency, day, value),
        )

    def account(
        self,
        name: str,
        account_type: str = "asset",
        currency: str = "GBP",
        opening: float = 0,
        tracking_start: str = "",
        opening_date: str = "2026-01-01 00:00:00",
        status: str = "active",
        timezone_name: str = "",
    ) -> str:
        identity = str(uuid4())
        decimals = self._execute("SELECT decimal_places FROM currency_master WHERE currency_code = %s", (currency,))[0]
        rate_id, applied = None, None
        if currency != "XAU":  # the schema requires the rate the opening amount was valued at
            found = self._execute("SELECT id, rate_value FROM currency_rates WHERE quote_currency_code = %s ORDER BY rate_date LIMIT 1", (currency,))
            if found is None:
                raise AssertionError(f"add a {currency} rate before an account in it")
            rate_id, applied = found
        self._execute(
            """INSERT INTO account_master (id, account_name, account_type, account_subtype, local_currency, base_currency, local_timezone,
                   opening_date_local, tracking_start_date_local, opening_amount_local_value, opening_amount_base_value, currency_rate_id, applied_rate_value,
                   record_status, created_at, updated_at)
               SELECT %s, %s, account_type_key, account_subtype_key, %s, 'XAU', %s, %s, %s, %s, 0, %s, %s, %s, now(), now()
               FROM account_types WHERE account_type_key = %s ORDER BY account_subtype_key LIMIT 1""",
            (identity, name, currency, timezone_name, opening_date, tracking_start or None, round(Decimal(str(opening)) * 10**decimals), rate_id, applied, status, account_type),
        )
        return identity

    def category(self, tx_type: str, major: str, minor: str, subscription_eligible: bool = False) -> str:
        found = self._execute("SELECT id::text FROM category_master WHERE tx_type_key = %s AND major_category_key = %s AND minor_category_key = %s", (tx_type, major, minor))
        if found:
            return found[0]
        identity = str(uuid4())
        self._execute(
            """INSERT INTO category_master (id, tx_type_key, tx_type_label, major_category_key, major_category_label, minor_category_key, minor_category_label,
                   source_account_mandatory, target_account_mandatory, is_subscription_eligible, record_status, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, false, false, %s, 'active', now(), now())""",
            (identity, tx_type, tx_type.title(), major, major.title(), minor, minor.title(), subscription_eligible),
        )
        return identity

    def payee(self, label: str) -> str:
        key = label.upper().replace(" ", "_")
        found = self._execute("SELECT id::text FROM counterparty_master WHERE counterparty_key = %s", (key,))
        if found:
            return found[0]
        return self._execute(
            "INSERT INTO counterparty_master (counterparty_key, counterparty_label, record_status, created_at, updated_at) VALUES (%s, %s, 'active', now(), now()) RETURNING id::text",
            (key, label),
        )[0]

    def tx(
        self,
        account: str,
        when: str | datetime,
        amount: float,
        xau: float,
        *,
        tx_type: str = "money-out",
        major: str = "groceries",
        minor: str = "supermarket",
        payee: str = "",
        country: str = "UK",
        city: str = "London",
        tags: str = "",
        parent: str | None = None,
        status: str = "active",
        subscription_eligible: bool = False,
    ) -> str:
        """amount in the account currency (major units); xau = the stored base value in grams."""
        self._counter += 1
        tx_id = f"tx-{self._counter:04d}"
        moment = when if isinstance(when, datetime) else datetime.fromisoformat(when).replace(tzinfo=timezone.utc)
        currency, decimals = self._execute("SELECT a.local_currency, c.decimal_places FROM account_master a JOIN currency_master c ON c.currency_code = a.local_currency WHERE a.id = %s", (account,))
        currency = currency.strip()
        rate_id = None
        if currency != "XAU":
            found = self._execute("SELECT id FROM currency_rates WHERE quote_currency_code = %s AND rate_date <= %s ORDER BY rate_date DESC LIMIT 1", (currency, moment.date()))
            rate_id = (
                found[0]
                if found
                else self._execute("INSERT INTO currency_rates (quote_currency_code, rate_date, rate_value, rate_source) VALUES (%s, %s, 1, 'test') RETURNING id", (currency, moment.date()))[0]
            )
        day = moment.strftime("%A").upper()
        self._execute(
            """INSERT INTO transaction_master (transaction_id, parent_tx_id, tx_date_time_base, tx_date_time_local, tx_timezone_base, tx_timezone_local,
                   tx_day_of_week_base, tx_day_of_week_local, category_id, account_id, tx_amount_local, tx_amount_base, local_currency, base_currency,
                   currency_rate_id, counterparty_id, tx_tags, user_location_city, user_location_country, record_status, created_at, updated_at)
               VALUES (%s, %s, %s, %s, 'UTC', 'Europe/London', %s, %s, %s, %s, %s, %s, %s, 'XAU', %s, %s, %s, %s, %s, %s, now(), now())""",
            (
                tx_id,
                parent,
                moment,
                moment.replace(tzinfo=None),
                day,
                day,
                self.category(tx_type, major, minor, subscription_eligible),
                account,
                round(Decimal(str(amount)) * 10**decimals),
                round(Decimal(str(xau)) * 10**9),
                currency,
                rate_id,
                self.payee(payee) if payee else None,
                tags or None,
                city,
                country,
                status,
            ),
        )
        return tx_id

    def transfer(self, source: str, target: str, when: str, amount: float, xau: float, target_amount: float | None = None) -> tuple[str, str]:
        """An own-account transfer: parent money-out on source, child money-in on target."""
        parent = self.tx(source, when, amount, xau, major="transfer", minor="own-account")
        child = self.tx(target, when, amount if target_amount is None else target_amount, xau, tx_type="money-in", major="transfer", minor="own-account", parent=parent)
        return parent, child

    def report(self, name: str, *, updated_at: str = "2026-10-01T10:00:00.000Z", status: str = "active", **fields: Any) -> str:
        """A user-defined report_master row; fields are report_master columns (lists as Python lists)."""
        identity = str(uuid4())
        row = {
            "measure": "spend",
            "period_preset": "last_12",
            "compare_mode": "none",
            "time_grain": "none",
            "include_other": False,
            "chart_kind": "number",
            **fields,
        }
        columns = ["id", "report_type", "report_name", "record_status", "source_updated_at", *row]
        values = [identity, "user_defined", name, status, updated_at, *row.values()]
        placeholders = ", ".join("%s::uuid[]" if column == "filter_account_ids" else "%s" for column in columns)
        self._execute(f"INSERT INTO report_master ({', '.join(columns)}) VALUES ({placeholders})", tuple(values))
        return identity
