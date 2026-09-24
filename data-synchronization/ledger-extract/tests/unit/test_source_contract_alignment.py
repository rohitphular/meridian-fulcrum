"""Execute the source registry so renamed tabs and new import fields cannot drift."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from core.account_detail_contracts import CONTRACTS, DETAIL_SYNC_METADATA
from sheets.contracts import HEADERS
from transforms.account_details import transform as transform_detail
from transforms.account_types import transform as transform_account_type

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


@pytest.fixture(scope="module")
def gas_contract() -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is required to execute the expense-tracker GAS contract registry")
    api = Path(__file__).resolve().parents[4] / "expense-tracker" / "api"
    source = "\n".join((api / name).read_text() for name in ("app-config.gs", "import-registry.gs", "account-type-schema.gs"))
    source += "\nprocess.stdout.write(JSON.stringify({registry: IMPORT_REGISTRY, columns: getAccountTypeSheetColumns(), details: getAccountTypeDetailSheets(), statuses: ACCOUNT_TYPE_STATUSES}));"
    result = subprocess.run([node, "-e", source], check=True, capture_output=True, text=True, timeout=15)
    return json.loads(result.stdout)


def test_runtime_registry_has_exactly_the_supported_sources(gas_contract: dict[str, Any]) -> None:
    registry = gas_contract["registry"]
    assert set(registry) == {"account_master", *CONTRACTS}
    assert registry["account_master"]["sheet_name"] == "account_master"
    assert set(gas_contract["details"]) == set(CONTRACTS)
    assert tuple(gas_contract["columns"]) == HEADERS["account_types"]
    for sheet, contract in CONTRACTS.items():
        entry = registry[sheet]
        assert entry["sheet_name"] == contract.target_table == sheet
        assert tuple(entry["columns"]) == contract.headers
        assert tuple(entry["required"]) == contract.required
        assert entry["key_field"] == "id"
        assert {key: tuple(values) for key, values in entry["enums"].items()} == dict(contract.enums)
        assert set(entry["numeric_fields"]) == set(contract.decimal_fields) | set(contract.integer_fields)
        assert tuple(entry["columns"][-6:]) == DETAIL_SYNC_METADATA


@pytest.mark.parametrize("sheet", CONTRACTS)
@pytest.mark.parametrize("status", ["active", "inactive", "deleted", "locked"])
def test_source_detail_rows_preserve_identity_lifecycle_and_optional_blanks(gas_contract: dict[str, Any], sheet: str, status: str) -> None:
    spec = gas_contract["registry"][sheet]
    row = dict.fromkeys(spec["columns"], "")
    row.update(id=IDENTITY.upper(), account_id=ACCOUNT_ID.upper(), record_status=status)
    for field in spec["required"]:
        if field in spec["numeric_fields"]:
            row[field] = "1"
        elif field in spec["enums"]:
            row[field] = spec["enums"][field][0]
    row.update(sync_status="update-pending", sync_date="old source acknowledgement", sync_notes="source note", created_at="source audit", updated_at="source audit")
    result = transform_detail(spec["sheet_name"], row)
    assert result["id"] == IDENTITY
    assert result["account_master_id"] == ACCOUNT_ID
    assert result["record_status"] == status
    assert not set(DETAIL_SYNC_METADATA[1:]).intersection(result)
    for field, target in CONTRACTS[sheet].field_map.items():
        if row[field] == "":
            assert result[target] is None


@pytest.mark.parametrize("detail_sheet", [None, *CONTRACTS])
def test_catalog_policies_are_source_data_without_fixed_classification_keys(gas_contract: dict[str, Any], detail_sheet: str | None) -> None:
    for status in gas_contract["statuses"]:
        row = dict.fromkeys(gas_contract["columns"], "")
        row.update(
            id=IDENTITY.upper(),
            account_type_key="custom-family",
            account_type_label="Custom family",
            account_subtype_key="custom-subtype",
            account_subtype_label="Custom subtype",
            is_loan="TRUE",
            detail_sheet=detail_sheet,
            record_status=status,
        )
        result = transform_account_type(row)
        assert result["id"] == IDENTITY
        assert result["account_type_key"] == "custom-family"
        assert result["account_subtype_key"] == "custom-subtype"
        assert result["is_loan"] is True
        assert result["detail_sheet"] == detail_sheet
        assert result["record_status"] == status
        assert not set(DETAIL_SYNC_METADATA[1:]).intersection(result)
