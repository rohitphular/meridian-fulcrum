"""Execute the GAS source builder and pass its rows through the real ETL transform."""

from __future__ import annotations

import json
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest

from sheets.contracts import HEADERS
from transforms.financial import to_minor_units
from transforms.subscriptions import transform


def test_source_subscription_rows_and_schema_match_extractor_contract() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to execute the expense-tracker GAS contract")
    api = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"
    source = "\n".join(
        (api / name).read_text() for name in ("app-config.gs", "app-utils.gs", "sync-utils.gs", "subscription-schema.gs", "subscription-utils.gs", "subscription-validation.gs", "subscription-core.gs")
    )
    source += """
const rows = [];
const schema = getSubscriptionSchemaForClient();
for (const frequency of schema.frequencies) {
  for (const status of schema.record_statuses) {
    const input = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      subscription_name: 'Synthetic obligation', subscription_amount_local: '90071992547409.925',
      frequency, day_of_month: frequency === 'weekly' ? '' : '31', day_of_week: frequency === 'weekly' ? '1' : '',
      source_account: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', record_status: status,
      tx_type: 'money-in', major_category: '', minor_category: 'partial-key',
      subscription_start_date_local: '2026-09-01 00:00:00.123456', subscription_timezone_local: 'europe/london'
    };
    const valid = validateSubscriptionCreate(input);
    if (!valid.ok) throw new Error(valid.error);
    rows.push(_subscriptionRowObject(_subscriptionBuildRow(input, input.id, null, '2026-09-01T00:00:00Z'), rows.length + 2));
  }
}
process.stdout.write(JSON.stringify({ columns: getSubscriptionSheetColumns(), rows }));
"""
    result = subprocess.run([node, "-e", source], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    contract = json.loads(result.stdout)
    assert tuple(contract["columns"]) == HEADERS["subscription_master"]
    assert len(contract["rows"]) == 16
    for row in contract["rows"]:
        typed = transform(row)
        assert typed["subscription_id"] == row["id"]
        assert typed["amount_local"] == Decimal("90071992547409.925")
        assert to_minor_units(typed["amount_local"], 2, "test") == 9007199254740993
        assert typed["record_status"] == row["record_status"]
        assert typed["subscription_timezone_local"] == "Europe/London"
        assert typed["subscription_start_date_local"].microsecond == 123456
        assert (typed["tx_type"], typed["major_category"], typed["minor_category"]) == ("money-in", None, "partial-key")
        assert not {"created_at", "updated_at", "sync_status", "sync_date", "sync_notes"}.intersection(typed)
