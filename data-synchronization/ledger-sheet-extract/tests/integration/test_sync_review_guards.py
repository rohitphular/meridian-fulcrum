"""Source and valuation guards across ordinary master and detail sync writes."""

from typing import Any
from uuid import uuid4

import psycopg2
import pytest

from database import account_details, accounts, categories


class RecordingSheets:
    def __init__(self) -> None:
        self.updates: list[Any] = []

    def batch_update_rows(self, name: str, updates: list[Any]) -> None:
        self.updates.extend(updates)


@pytest.mark.parametrize("existing", [False, True])
def test_category_source_change_rolls_back_master_and_both_hint_mappings(database_client: Any, existing: bool) -> None:
    row = {
        "id": str(uuid4()),
        "tx_type_key": "money-out",
        "tx_type_label": "Money out",
        "major_category_key": "living",
        "major_category_label": "Living",
        "minor_category_key": "food",
        "minor_category_label": "Food",
        "record_status": "active",
        "sync_status": "create-pending",
        "source_account_types": "current",
        "target_account_types": "savings",
    }
    if existing:
        assert categories.upsert_categories(database_client, RecordingSheets(), [row], 1) == 0
        row.update(sync_status="update-pending", minor_category_label="Updated", source_account_types="savings", target_account_types="current")
    sheets = RecordingSheets()

    def changed_source() -> None:
        raise RuntimeError("sheet_changed_before_acknowledgement:category_master")

    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement"):
        categories.upsert_categories(database_client, sheets, [row], 1, before_dependency_commit=changed_source)
    assert sheets.updates == []
    with database_client.cursor() as cursor:
        cursor.execute("SELECT minor_category_label FROM category_master WHERE id=%s", (row["id"],))
        assert cursor.fetchone() == (("Food",) if existing else None)
        for table, expected in (("category_source_account_types", "current"), ("category_target_account_types", "savings")):
            cursor.execute(f"SELECT t.account_subtype_key FROM {table} j JOIN account_types t ON t.id=j.account_type_id WHERE j.category_id=%s", (row["id"],))
            assert cursor.fetchall() == ([(expected,)] if existing else [])


@pytest.mark.parametrize("detail", [False, True])
@pytest.mark.parametrize("reference", ["rate", "precision"])
def test_account_and_detail_valuation_references_remain_locked_through_commit(database_client: Any, detail: bool, reference: str) -> None:
    with database_client.cursor() as cursor:
        cursor.execute("INSERT INTO currency_rates(quote_currency_code,rate_date,rate_value,rate_source) VALUES('GBP','2026-09-18',100,'test')")
    database_client.commit()
    account = {
        "id": str(uuid4()),
        "account_name": "Valuation fixture",
        "type": "investment",
        "sub_type": "property",
        "account_currency_local": "GBP",
        "opening_value_local": "100",
        "tracking_start_date_local": "2026-09-18",
        "record_status": "active",
        "sync_status": "create-pending",
    }
    if detail:
        assert accounts.upsert_accounts(database_client, RecordingSheets(), [account], 1) == 0
    peer = psycopg2.connect(database_client.dsn)
    try:

        def concurrent_edit() -> None:
            with peer.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout='50ms'")
                with pytest.raises(psycopg2.errors.LockNotAvailable):
                    if reference == "rate":
                        cursor.execute("UPDATE currency_rates SET rate_value=200 WHERE quote_currency_code='GBP'")
                    else:
                        cursor.execute("UPDATE currency_master SET decimal_places=3 WHERE currency_code='GBP'")
            peer.rollback()

        if detail:
            source = {
                "id": str(uuid4()),
                "account_id": account["id"],
                "acquisition_type": "PURCHASED",
                "current_value_local": "100",
                "current_value_evaluation_date": "2026-09-18",
                "record_status": "active",
            }
            assert account_details.sync_details(database_client, "account_investment_property", [source], before_commit=concurrent_edit)["created"] == 1
        else:
            assert accounts.upsert_accounts(database_client, RecordingSheets(), [account], 1, before_commit=concurrent_edit) == 0
    finally:
        peer.rollback()
        peer.close()
