"""Golden numbers computed by hand (task 17): cross-currency, future-dated rows, UTC month
boundaries, deleted rows, tags, missing rates and an empty ledger, through whole reports.

Not the old GAS output: amounts are XAU (D2) and dates UTC (D3). Anchor Sunday 4 Oct 2026.
Rates: GBP £100 a gram; INR ₹8,000 a gram; USD only after the anchor.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import psycopg2
import pytest

import core.build as build_module
from core import mart as mart_module
from core import predefined_step
from core.build import build
from core.config import contract
from core.context import BuildContext
from core.reports import load_all
from tests.integration.ledger import Ledger

ANCHOR = date(2026, 10, 4)


@pytest.fixture
def book(database: tuple[Any, dict[str, Any]]) -> Ledger:
    connection, _ = database
    ledger = Ledger(connection)
    ledger.rate("GBP", date(2026, 1, 1), 100.0)
    ledger.rate("INR", date(2026, 1, 1), 8000.0)
    return ledger


def _reports(book: Ledger) -> dict[str, dict[str, Any]]:
    """predefined_key → default payload."""
    load_all()
    context = BuildContext(generation_id="g", anchor_date=ANCHOR, mart=mart_module.load(book.conn, ANCHOR))
    out = {}
    for entry in contract("predefined-reports")["reports"]:
        out[entry["key"]] = dict(predefined_step.build_entry(entry, context, ("United Kingdom", "GBP")))[""]
    return out


def _stat(payload: dict[str, Any], key: str) -> Any:
    return next(card["value"] for card in payload["stat_cards"] if card["key"] == key)


def test_cross_currency_future_rows_and_utc_month_boundaries(book: Ledger) -> None:
    bank = book.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")  # 10 g
    rupee = book.account("Rupee", currency="INR", opening=80000, tracking_start="2026-09-01 00:00:00")  # 10 g
    # 23:30 UTC on 30 Sep is 00:30 on 1 Oct in London: the job counts it in September (UTC).
    book.tx(bank, "2026-09-30T23:30:00", 200, 2, payee="Late")
    book.tx(rupee, "2026-10-02T10:00:00", 8000, 1, payee="Chai")  # ₹8,000 = 1 g at its stored base value
    book.tx(bank, "2026-10-03T10:00:00", 100, 1, payee="Gone", status="deleted")
    book.tx(bank, "2026-10-10T10:00:00", 300, 3, payee="Future")  # after the anchor
    reports = _reports(book)
    assert _stat(reports["kpi-spend-this-month"], "value") == pytest.approx(1)  # Chai only: Late is September, Future is after today
    last_month = dict(
        predefined_step.build_entry(
            next(e for e in contract("predefined-reports")["reports"] if e["key"] == "08-category-pie"),
            BuildContext(generation_id="g", anchor_date=ANCHOR, mart=mart_module.load(book.conn, ANCHOR)),
            ("United Kingdom", "GBP"),
        )
    )["period=last_month"]
    assert _stat(last_month, "total") == pytest.approx(2)
    # Net worth now counts the future row (current balance); the trend's last point does not.
    assert _stat(reports["kpi-net-worth"], "value") == pytest.approx((1000 - 200 - 300) / 100 + (80000 - 8000) / 8000)
    trend = reports["14-networth-trend"]
    assert trend["charts"][0]["datasets"][0]["data"][-1] == pytest.approx((1000 - 200) / 100 + 9)
    assert any("future-dated" in (note["text"] if isinstance(note, dict) else note) for note in trend["notes"])


def test_a_currency_without_a_rate_is_reported_never_converted_one_to_one(book: Ledger) -> None:
    book.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")
    book.rate("USD", date(2026, 12, 1), 120.0)  # the only USD rate is dated after the anchor
    book.account("Dollars", currency="USD", opening=500, tracking_start="2026-09-01 00:00:00")
    reports = _reports(book)
    assert _stat(reports["kpi-total-assets"], "value") == pytest.approx(10)  # Bank only
    assert {"code": "missing_rate", "currencies": ["USD"]} in reports["kpi-total-assets"]["warnings"]
    rows = {row["cells"]["name"]: row["cells"] for row in reports["dataset-account-balances"]["tables"][0]["rows"]}
    assert rows["Dollars"]["balance"] is None and rows["Dollars"]["balance_local"] == 500


def test_tags_split_a_row_across_its_tags_in_the_tag_pie(book: Ledger) -> None:
    bank = book.account("Bank", opening=1000, tracking_start="2026-09-01 00:00:00")
    book.tx(bank, "2026-10-02T10:00:00", 300, 3, tags="Holiday; food")
    book.tx(bank, "2026-10-03T10:00:00", 100, 1, tags="food")
    book.tx(bank, "2026-10-03T11:00:00", 50, 0.5)
    pie = _reports(book)["12-tag-pie"]
    assert (_stat(pie, "tagged"), _stat(pie, "untagged"), _stat(pie, "tags")) == pytest.approx((4, 0.5, 2))
    chart = pie["charts"][0]
    assert dict(zip(chart["labels"], chart["datasets"][0]["data"])) == pytest.approx({"food": 2.5, "holiday": 1.5})


def test_an_empty_ledger_builds_every_report(database: tuple[Any, dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    connection, params = database
    monkeypatch.setattr(build_module, "get_client", lambda _config: psycopg2.connect(**params))
    generation = build(None, anchor_date=ANCHOR, keep=5)
    with connection.cursor() as cursor:
        cursor.execute("SELECT status, count(*) FROM analytics.report_result WHERE generation_id = %s GROUP BY status", (generation,))
        counts = dict(cursor.fetchall())
    connection.rollback()
    assert counts == {"ready": len(contract("predefined-reports")["reports"])}
