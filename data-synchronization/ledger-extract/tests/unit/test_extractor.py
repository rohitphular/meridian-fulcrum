from copy import deepcopy
from unittest.mock import MagicMock

import pytest

import core.extractor as extractor
from core.account_detail_contracts import CONTRACTS, SYNC_DETAIL_SHEETS


def _job(monkeypatch: pytest.MonkeyPatch) -> tuple:
    conn, sheets = MagicMock(), MagicMock()
    sheets.assert_unchanged = MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(extractor, "get_client", lambda _: conn)
    monkeypatch.setattr(extractor, "SnapshotSheetsClient", lambda *args: sheets)
    bootstrap, checkpoint = MagicMock(), MagicMock()
    monkeypatch.setattr(extractor, "bootstrap_job_execution_details", bootstrap)
    monkeypatch.setattr(extractor, "upsert_job_execution_details", checkpoint)
    monkeypatch.setattr(extractor.LedgerExtractJob, "_recover_missing_rows", MagicMock())
    cfg = {"entities": {name: {"enabled": True} for name in ("category_master", "account_master", "transaction_master", "subscription_master")}}
    handlers = []
    for module, fn in (
        (extractor.categories_db, "upsert_categories"),
        (extractor.accounts_db, "upsert_accounts"),
        (extractor.transactions_db, "upsert_transactions"),
        (extractor.subscriptions_db, "upsert_subscriptions"),
    ):
        handler = MagicMock(return_value=0)
        monkeypatch.setattr(module, fn, handler)
        handlers.append(handler)
    monkeypatch.setattr(extractor.transactions_db, "load_account_map", lambda _: {})
    monkeypatch.setattr(extractor.transactions_db, "retire_unused_references", MagicMock())
    return extractor.LedgerExtractJob(None, "fixture", "fixture"), cfg, conn, sheets, checkpoint, handlers


def test_partial_failure_prevents_checkpoint_and_dependents(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    handlers[1].return_value = 1
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_master"):
        job.run(cfg)
    handlers[2].assert_not_called()
    checkpoint.assert_not_called()
    sheets.flush_pending.assert_called_once()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()


def test_writeback_failure_prevents_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, _ = _job(monkeypatch)
    sheets.flush_pending.side_effect = RuntimeError("source changed")
    with pytest.raises(RuntimeError):
        job.run(cfg)
    checkpoint.assert_not_called()
    conn.close.assert_called_once()


def test_success_processes_all_entities_then_checkpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    job.run(cfg)
    assert all(handler.call_count == 1 for handler in handlers)
    assert handlers[1].call_args.kwargs["before_commit"] is sheets.assert_unchanged
    assert handlers[2].call_args.kwargs["before_commit"] is sheets.assert_unchanged
    assert handlers[3].call_args.kwargs["before_commit"] is sheets.assert_unchanged
    sheets.capture.assert_called_once_with(["category_master", "account_master", "transaction_master", "subscription_master"])
    checkpoint.assert_called_once()
    conn.close.assert_called_once()


def test_concurrent_job_rejected_before_sheet_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, _ = _job(monkeypatch)
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (False,)
    with pytest.raises(RuntimeError, match="already_running"):
        job.run(cfg)
    sheets.capture.assert_not_called()
    checkpoint.assert_not_called()
    conn.close.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("reason", ["missing_enabled_sheet:account_deposit", "master_sheet_name_collision:account_master"])
def test_invalid_sheet_names_abort_before_entity_writes(monkeypatch: pytest.MonkeyPatch, reprocess: bool, reason: str) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    sheets.capture.side_effect = ValueError(reason)
    cfg["entities"]["account_deposit"] = {"enabled": True}
    with pytest.raises(ValueError, match=reason):
        job.run(cfg, reprocess=reprocess)
    for handler in handlers:
        handler.assert_not_called()
    extractor.bootstrap_job_execution_details.assert_not_called()
    checkpoint.assert_not_called()
    sheets.flush_pending.assert_not_called()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
def test_disabled_detail_tabs_are_not_read_even_during_hard_sync(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    job, cfg, _, sheets, checkpoint, _ = _job(monkeypatch)
    for name in CONTRACTS:
        cfg["entities"][name] = {"enabled": False}
    job.run(cfg, reprocess=reprocess)
    sheets.capture.assert_called_once_with(["category_master", "account_master", "transaction_master", "subscription_master"])
    assert {call.args[0] for call in sheets.snapshot_rows.call_args_list} == {"category_master", "account_master", "transaction_master", "subscription_master"}
    checkpoint.assert_called_once()


def test_false_string_config_is_rejected() -> None:
    with pytest.raises(ValueError, match="boolean"):
        extractor.entity_enabled("account_master", {"entities": {"account_master": {"enabled": "false"}}})


def test_reprocess_updates_in_sync_rows_without_editing_source_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, _, sheets, _, handlers = _job(monkeypatch)
    snapshots = [[{"sync_status": "in-sync"}] for _ in handlers]
    sheets.snapshot_rows.side_effect = snapshots
    job.run(cfg, reprocess=True)
    assert all(handler.call_args.args[2][0]["sync_status"] == "update-pending" for handler in handlers)


@pytest.mark.parametrize("entity,handler_index", [("transaction_master", 2), ("subscription_master", 3)])
def test_single_movement_master_dispatches_and_retires_unreferenced_registry_rows(monkeypatch: pytest.MonkeyPatch, entity: str, handler_index: int) -> None:
    job, cfg, _, sheets, _, handlers = _job(monkeypatch)
    for name in cfg["entities"]:
        cfg["entities"][name]["enabled"] = name == entity
    job.run(cfg)
    sheets.capture.assert_called_once_with([entity])
    handlers[handler_index].assert_called_once()
    for index, handler in enumerate(handlers):
        if index != handler_index:
            handler.assert_not_called()
    extractor.transactions_db.retire_unused_references.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
def test_sync_details_run_after_accounts_and_share_master_reprocessing_control(monkeypatch: pytest.MonkeyPatch, reprocess: bool, name: str) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    cfg["entities"][name] = {"enabled": True}
    calls = []
    handlers[1].side_effect = lambda *args, **kwargs: calls.append("account_master") or 0
    handlers[2].side_effect = lambda *args, **kwargs: calls.append("transaction_master") or 0
    detail_rows = [{"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "account_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sync_status": "in-sync"}]
    sheets.snapshot_rows.side_effect = lambda sheet_name: deepcopy(detail_rows) if sheet_name == name else []
    detail_writer = MagicMock(side_effect=lambda *args, **kwargs: calls.append("details") or 0)
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", detail_writer)
    job.run(cfg, reprocess=reprocess)
    assert calls == ["account_master", "details", "transaction_master"]
    received = detail_writer.call_args.args[3]
    assert received[0]["sync_status"] == ("update-pending" if reprocess else "in-sync")
    detail_writer.assert_called_once_with(conn, sheets, name, received, reprocess=reprocess, before_commit=sheets.assert_unchanged)
    assert detail_rows[0]["sync_status"] == "in-sync"
    checkpoint.assert_called_once()


def test_sync_detail_failure_count_prevents_dependents_and_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    cfg["entities"]["account_deposit"] = {"enabled": True}
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", MagicMock(return_value=2))
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_deposit"):
        job.run(cfg)
    handlers[2].assert_not_called()
    handlers[3].assert_not_called()
    checkpoint.assert_not_called()
    sheets.flush_pending.assert_called_once()
    conn.close.assert_called_once()


@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
def test_detail_recovery_requires_matching_source_provenance(name: str) -> None:
    conn = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    present_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    missing_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    pending_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    cursor.fetchall.return_value = [(present_id,)]
    rows = [
        {"id": present_id.upper(), "sync_status": "in-sync", "_sheet_row_num": 2},
        {"id": missing_id, "sync_status": "in-sync", "_sheet_row_num": 3},
        {"id": pending_id, "sync_status": "update-failed", "_sheet_row_num": 4},
    ]
    extractor.LedgerExtractJob._recover_missing_rows(conn, name, rows)
    cursor.execute.assert_called_once_with(f"SELECT id FROM {CONTRACTS[name].target_table} WHERE source_sheet = %s", (name,))
    assert [row["sync_status"] for row in rows] == ["in-sync", "create-pending", "update-failed"]


@pytest.mark.parametrize("reprocess", [False, True])
def test_missing_detail_is_recovered_before_normal_or_hard_wrapper_dispatch(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    recover = extractor.LedgerExtractJob._recover_missing_rows
    job, cfg, conn, sheets, checkpoint, _ = _job(monkeypatch)
    monkeypatch.setattr(extractor.LedgerExtractJob, "_recover_missing_rows", staticmethod(recover))
    for settings in cfg["entities"].values():
        settings["enabled"] = False
    cfg["entities"]["account_deposit"] = {"enabled": True}
    original = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sync_status": "in-sync", "_sheet_row_num": 2}
    sheets.snapshot_rows.return_value = [original.copy()]
    conn.cursor.return_value.__enter__.return_value.fetchall.return_value = []
    writer = MagicMock(return_value=0)
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", writer)
    job.run(cfg, reprocess=reprocess)
    assert writer.call_args.args[3][0]["sync_status"] == "create-pending"
    assert original["sync_status"] == "in-sync"
    checkpoint.assert_called_once()


def test_old_configs_do_not_implicitly_enable_details() -> None:
    assert extractor.entity_enabled("account_deposit", {"entities": {}}) is False
    with pytest.raises(ValueError, match="boolean"):
        extractor.entity_enabled("account_deposit", {"entities": {"account_deposit": {"enabled": "true"}}})


@pytest.mark.parametrize("reprocess", [False, True])
def test_account_types_sync_precedes_categories_and_accounts(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    cfg["entities"]["account_types"] = {"enabled": True}
    calls = []
    handlers[0].side_effect = lambda *args, **kwargs: calls.append("categories") or 0
    handlers[1].side_effect = lambda *args, **kwargs: calls.append("accounts") or 0
    writer = MagicMock(side_effect=lambda *args, **kwargs: calls.append("types") or 0)
    monkeypatch.setattr(extractor.account_types_db, "upsert_account_types", writer)
    sheets.snapshot_rows.side_effect = lambda name: [{"sync_status": "in-sync"}] if name == "account_types" else []
    job.run(cfg, reprocess=reprocess)
    assert calls == ["types", "categories", "accounts"]
    assert sheets.capture.call_args.args[0][0] == "account_types"
    assert writer.call_args.args[2][0]["sync_status"] == ("update-pending" if reprocess else "in-sync")
    assert writer.call_args.kwargs["before_commit"] is sheets.assert_unchanged
    checkpoint.assert_called_once()


def test_account_types_failure_stops_all_dependent_entities(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    cfg["entities"]["account_types"] = {"enabled": True}
    monkeypatch.setattr(extractor.account_types_db, "upsert_account_types", MagicMock(return_value=1))
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_types"):
        job.run(cfg)
    for handler in handlers:
        handler.assert_not_called()
    checkpoint.assert_not_called()
    sheets.flush_pending.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("entity,handler_index", [("transaction_master", 2), ("subscription_master", 3)])
def test_missing_movement_is_recovered_without_changing_existing_source_status(monkeypatch: pytest.MonkeyPatch, reprocess: bool, entity: str, handler_index: int) -> None:
    recover = extractor.LedgerExtractJob._recover_missing_rows
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    monkeypatch.setattr(extractor.LedgerExtractJob, "_recover_missing_rows", staticmethod(recover))
    for name, settings in cfg["entities"].items():
        settings["enabled"] = name == entity
    present = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sync_status": "in-sync", "_sheet_row_num": 9}
    missing = {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sync_status": "in-sync", "_sheet_row_num": 3}
    sheets.snapshot_rows.return_value = [present.copy(), missing.copy()]
    conn.cursor.return_value.__enter__.return_value.fetchall.return_value = [(present["id"],)]
    job.run(cfg, reprocess=reprocess)
    received = handlers[handler_index].call_args.args[2]
    assert [row["sync_status"] for row in received] == ["update-pending" if reprocess else "in-sync", "create-pending"]
    assert [row["_sheet_row_num"] for row in received] == [9, 3]
    assert present["sync_status"] == missing["sync_status"] == "in-sync"
    assert handlers[handler_index].call_args.kwargs["before_commit"] is sheets.assert_unchanged
    checkpoint.assert_called_once()


def test_transaction_source_change_stops_dependents_and_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    sheets.assert_unchanged.side_effect = RuntimeError("sheet_changed_before_acknowledgement:transaction_master")
    handlers[2].side_effect = lambda *args, **kwargs: kwargs["before_commit"]()
    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement:transaction_master"):
        job.run(cfg)
    handlers[3].assert_not_called()
    checkpoint.assert_not_called()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()


def test_subscription_source_change_prevents_cleanup_and_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, conn, sheets, checkpoint, handlers = _job(monkeypatch)
    sheets.assert_unchanged.side_effect = RuntimeError("sheet_changed_before_acknowledgement:subscription_master")
    handlers[3].side_effect = lambda *args, **kwargs: kwargs["before_commit"]()
    with pytest.raises(RuntimeError, match="sheet_changed_before_acknowledgement:subscription_master"):
        job.run(cfg)
    extractor.transactions_db.retire_unused_references.assert_not_called()
    checkpoint.assert_not_called()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()
