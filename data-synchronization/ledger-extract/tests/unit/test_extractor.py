from unittest.mock import MagicMock

import pytest

import core.extractor as extractor


def _job(monkeypatch: pytest.MonkeyPatch) -> tuple:
    conn, sheets = MagicMock(), MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(extractor, "get_client", lambda _: conn)
    monkeypatch.setattr(extractor, "SnapshotSheetsClient", lambda *args: sheets)
    bootstrap, checkpoint = MagicMock(), MagicMock()
    monkeypatch.setattr(extractor, "bootstrap_job_execution_details", bootstrap)
    monkeypatch.setattr(extractor, "upsert_job_execution_details", checkpoint)
    monkeypatch.setattr(extractor.LedgerExtractJob, "_recover_missing_rows", MagicMock())
    cfg = {"entities": {name: {"enabled": True} for name in ("categories", "accounts", "transactions", "subscriptions")}}
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
    with pytest.raises(RuntimeError, match="entity_rows_failed:accounts"):
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
    sheets.capture.assert_called_once_with(["categories", "accounts", "transactions", "subscriptions"])
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


def test_false_string_config_is_rejected() -> None:
    with pytest.raises(ValueError, match="boolean"):
        extractor.entity_enabled("accounts", {"entities": {"accounts": {"enabled": "false"}}})


def test_reprocess_updates_in_sync_rows_without_editing_source_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, _, sheets, _, handlers = _job(monkeypatch)
    snapshots = [[{"sync_status": "in-sync"}] for _ in handlers]
    sheets.snapshot_rows.side_effect = snapshots
    job.run(cfg, reprocess=True)
    assert all(handler.call_args.args[2][0]["sync_status"] == "update-pending" for handler in handlers)


def test_subscription_only_run_retires_unreferenced_registry_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    job, cfg, _, _, _, _ = _job(monkeypatch)
    for name in ("categories", "accounts", "transactions"):
        cfg["entities"][name]["enabled"] = False
    job.run(cfg)
    extractor.transactions_db.retire_unused_references.assert_called_once()
