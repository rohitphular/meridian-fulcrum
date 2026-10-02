"""The GAS sheet contract this module checks staged tabs against (moved from the Sheet client)."""

import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.account_detail_contracts import SYNC_DETAIL_SHEETS
from core.source_contracts import DETAIL_HEADERS, HEADERS, validate_headers
from core.staging_source import StagingRun, StagingSource

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
API = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"


def _row(sheet: str, **values: object) -> dict:
    record = dict.fromkeys(HEADERS[sheet], "")
    record.update(id=IDENTITY, sync_status="create-pending", _sheet_row_num=2)
    record.update(values)
    return record


def _source(snapshots: dict) -> StagingSource:
    source = StagingSource(MagicMock(), StagingRun("00000000-0000-4000-8000-000000000001", "extracted", tuple(snapshots)))
    source._snapshots = snapshots
    return source


def test_contract_matches_current_gas_schemas() -> None:
    for plural, singular in (("category_master", "category"), ("account_master", "account"), ("transaction_master", "transaction"), ("subscription_master", "subscription")):
        fields = re.findall(r"sheet_column_name:\s*'([^']+)'\s*,\s*sheet_column_position:\s*(\d+)", (API / f"{singular}-schema.gs").read_text())
        assert tuple(field for field, _ in sorted(fields, key=lambda pair: int(pair[1]))) == HEADERS[plural]


def test_detail_headers_match_current_import_registry() -> None:
    source = (API / "import-registry.gs").read_text()
    for name, headers in DETAIL_HEADERS.items():
        declaration = re.search(rf"\b{re.escape(name)}:\s*\{{([\s\S]*?)\n  \}},", source)
        assert declaration is not None, name
        columns = re.search(r"\bcolumns:\s*\[([^\]]+)\]", declaration.group(1))
        assert columns is not None, name
        assert tuple(re.findall(r"'([^']+)'", columns.group(1))) == headers, name


def test_account_type_headers_match_dynamic_gas_schema_registry() -> None:
    fields = re.findall(r"^\s+\['([^']+)',", (API / "account-type-schema.gs").read_text(), re.MULTILINE)
    assert tuple(fields) == HEADERS["account_types"]


def test_property_tab_rejects_unmigrated_rate_reference_header() -> None:
    name = "account_investment_property"
    headers = list(HEADERS[name])
    assert len(headers) == 23
    assert headers[16] == "property_address"
    headers.insert(16, "evaluation_currency_rate_id")
    with pytest.raises(ValueError, match="sheet_header_mismatch:account_investment_property"):
        validate_headers(name, headers)


def test_legacy_account_type_tab_requires_explicit_source_upgrade() -> None:
    legacy = [field for field in HEADERS["account_types"] if field != "detail_sheet"]
    with pytest.raises(ValueError, match="^account_types_migration_required$"):
        validate_headers("account_types", legacy)
    # An unrelated malformed schema must not be diagnosed as the known migration.
    with pytest.raises(ValueError, match="^sheet_header_mismatch:account_types$"):
        validate_headers("account_types", legacy[:-1])


def test_retired_is_loan_column_requires_sheet_cleanup() -> None:
    headers = list(HEADERS["account_types"])
    headers.insert(headers.index("detail_sheet"), "is_loan")
    with pytest.raises(ValueError, match="^account_types_is_loan_column_present$"):
        validate_headers("account_types", headers)


def test_reordered_headers_are_accepted_but_missing_or_duplicate_ones_are_not() -> None:
    validate_headers("subscription_master", list(reversed(HEADERS["subscription_master"])))
    with pytest.raises(ValueError, match="sheet_header_mismatch"):
        validate_headers("subscription_master", ["id", "sync_status"])
    with pytest.raises(ValueError, match="sheet_header_mismatch"):
        validate_headers("subscription_master", [*HEADERS["subscription_master"], "id"])


def test_uuid_normalisation_preserves_transfer_groups_without_mutating_the_snapshot() -> None:
    original = _row("transaction_master", id=IDENTITY.upper(), parent_tx_id="{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}")
    source = _source({"transaction_master": [original]})
    canonical = source.snapshot_rows("transaction_master")[0]
    assert canonical["id"] == IDENTITY
    assert canonical["parent_tx_id"] == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    assert original["id"] == IDENTITY.upper()


def test_same_uuid_in_the_two_loan_tabs_is_allowed() -> None:
    source = _source({name: [_row(name)] for name in ("account_liability_mortgage", "account_liability_personal_loan")})
    assert source.snapshot_rows("account_liability_mortgage")[0]["id"] == IDENTITY
    assert source.snapshot_rows("account_liability_personal_loan")[0]["id"] == IDENTITY


@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
@pytest.mark.parametrize("field", ["record_status", "created_at", "updated_at"])
def test_outcomes_touch_only_the_sync_cells(name: str, field: str) -> None:
    source = _source({name: [_row(name)]})
    with pytest.raises(ValueError, match="writeback_must_only_touch_sync_fields"):
        source.batch_update_rows(name, [(2, HEADERS[name].index(field) + 1, ["overwrite"])])
    source.batch_update_rows(name, [(2, HEADERS[name].index("sync_status") + 1, ["in-sync", "now", ""])])
    assert source._pending == {(name, 2): ["in-sync", "now", ""]}


def test_outcome_for_a_row_outside_the_snapshot_is_rejected() -> None:
    source = _source({"account_master": [_row("account_master")]})
    with pytest.raises(ValueError, match="writeback_row_outside_snapshot"):
        source.batch_update_rows("account_master", [(9, HEADERS["account_master"].index("sync_status") + 1, ["in-sync", "now", ""])])
