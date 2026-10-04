from copy import deepcopy
from unittest.mock import MagicMock

import pytest

import core.loader as extractor
from core.account_detail_contracts import CONTRACTS, SYNC_DETAIL_SHEETS


class Run:
    def __init__(self, tabs: list[str]) -> None:
        self.run_id = "00000000-0000-4000-8000-000000000001"
        self.status = "extracted"
        self.enabled_tabs = tabs


def _job(monkeypatch: pytest.MonkeyPatch) -> tuple:
    conn, source = MagicMock(), MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    monkeypatch.setattr(extractor, "get_client", lambda _: conn)
    tabs = ["category_master", "account_master", "transaction_master", "subscription_master"]
    monkeypatch.setattr(extractor, "latest_run", lambda _conn, **_kwargs: Run(tabs))
    monkeypatch.setattr(extractor, "StagingSource", lambda *args: source)
    monkeypatch.setattr(extractor.LedgerDatabaseLoadJob, "_recover_missing_rows", MagicMock())
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
    return extractor.LedgerDatabaseLoadJob(None), tabs, conn, source, handlers


def test_partial_failure_stops_dependents_and_rolls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    handlers[1].return_value = 1
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_master"):
        job.run()
    handlers[2].assert_not_called()
    source.flush_pending.assert_called_once()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()


def test_outcome_store_failure_fails_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, _ = _job(monkeypatch)
    source.flush_pending.side_effect = RuntimeError("staging unavailable")
    with pytest.raises(RuntimeError):
        job.run()
    conn.close.assert_called_once()


def test_an_outcome_store_failure_does_not_hide_the_load_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    handlers[1].return_value = 1
    source.flush_pending.side_effect = RuntimeError("staging unavailable")
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_master"):
        job.run()
    conn.close.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
def test_only_hard_sync_reloads_an_acknowledged_run(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    job, tabs, conn, source, _ = _job(monkeypatch)
    asked = MagicMock(return_value=None)
    monkeypatch.setattr(extractor, "latest_run", asked)
    job.run(reprocess=reprocess)
    asked.assert_called_once_with(conn, allow_acknowledged=reprocess)


def test_success_processes_all_entities(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    job.run()
    assert all(handler.call_count == 1 for handler in handlers)
    source.capture.assert_called_once_with(["category_master", "account_master", "transaction_master", "subscription_master"])
    conn.rollback.assert_not_called()
    conn.close.assert_called_once()


def test_concurrent_job_rejected_before_sheet_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, _ = _job(monkeypatch)
    conn.cursor.return_value.__enter__.return_value.fetchone.return_value = (False,)
    with pytest.raises(RuntimeError, match="already_running"):
        job.run()
    source.capture.assert_not_called()
    conn.close.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("reason", ["missing_enabled_sheet:account_deposit", "master_sheet_name_collision:account_master"])
def test_invalid_sheet_names_abort_before_entity_writes(monkeypatch: pytest.MonkeyPatch, reprocess: bool, reason: str) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    source.capture.side_effect = ValueError(reason)
    tabs.append("account_deposit")
    with pytest.raises(ValueError, match=reason):
        job.run(reprocess=reprocess)
    for handler in handlers:
        handler.assert_not_called()
    source.flush_pending.assert_not_called()
    conn.rollback.assert_called_once()
    conn.close.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
def test_disabled_detail_tabs_are_not_read_even_during_hard_sync(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    job, tabs, conn, source, _ = _job(monkeypatch)
    job.run(reprocess=reprocess)
    source.capture.assert_called_once_with(["category_master", "account_master", "transaction_master", "subscription_master"])
    assert {call.args[0] for call in source.snapshot_rows.call_args_list} == {"category_master", "account_master", "transaction_master", "subscription_master"}
    conn.rollback.assert_not_called()


def test_reprocess_updates_in_sync_rows_without_editing_source_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, _, source, handlers = _job(monkeypatch)
    snapshots = [[{"sync_status": "in-sync"}] for _ in handlers]
    source.snapshot_rows.side_effect = snapshots
    job.run(reprocess=True)
    assert all(handler.call_args.args[2][0]["sync_status"] == "update-pending" for handler in handlers)


@pytest.mark.parametrize("entity,handler_index", [("transaction_master", 2), ("subscription_master", 3)])
def test_single_movement_master_dispatches_and_retires_unreferenced_registry_rows(monkeypatch: pytest.MonkeyPatch, entity: str, handler_index: int) -> None:
    job, tabs, _, source, handlers = _job(monkeypatch)
    tabs[:] = [entity]
    job.run()
    source.capture.assert_called_once_with([entity])
    handlers[handler_index].assert_called_once()
    for index, handler in enumerate(handlers):
        if index != handler_index:
            handler.assert_not_called()
    extractor.transactions_db.retire_unused_references.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("name", sorted(SYNC_DETAIL_SHEETS))
def test_sync_details_run_after_accounts_and_share_master_reprocessing_control(monkeypatch: pytest.MonkeyPatch, reprocess: bool, name: str) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    tabs.append(name)
    calls = []
    handlers[1].side_effect = lambda *args, **kwargs: calls.append("account_master") or 0
    handlers[2].side_effect = lambda *args, **kwargs: calls.append("transaction_master") or 0
    detail_rows = [{"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "account_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sync_status": "in-sync"}]
    source.snapshot_rows.side_effect = lambda sheet_name: deepcopy(detail_rows) if sheet_name == name else []
    detail_writer = MagicMock(side_effect=lambda *args, **kwargs: calls.append("details") or 0)
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", detail_writer)
    job.run(reprocess=reprocess)
    assert calls == ["account_master", "details", "transaction_master"]
    received = detail_writer.call_args.args[3]
    assert received[0]["sync_status"] == ("update-pending" if reprocess else "in-sync")
    detail_writer.assert_called_once_with(conn, source, name, received, reprocess=reprocess)
    assert detail_rows[0]["sync_status"] == "in-sync"
    conn.rollback.assert_not_called()


def test_sync_detail_failure_count_prevents_dependents(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    tabs.append("account_deposit")
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", MagicMock(return_value=2))
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_deposit"):
        job.run()
    handlers[2].assert_not_called()
    handlers[3].assert_not_called()
    source.flush_pending.assert_called_once()
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
    extractor.LedgerDatabaseLoadJob._recover_missing_rows(conn, name, rows)
    cursor.execute.assert_called_once_with(f"SELECT id FROM {CONTRACTS[name].target_table} WHERE source_sheet = %s", (name,))
    assert [row["sync_status"] for row in rows] == ["in-sync", "create-pending", "update-failed"]


@pytest.mark.parametrize("reprocess", [False, True])
def test_missing_detail_is_recovered_before_normal_or_hard_wrapper_dispatch(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    recover = extractor.LedgerDatabaseLoadJob._recover_missing_rows
    job, tabs, conn, source, _ = _job(monkeypatch)
    monkeypatch.setattr(extractor.LedgerDatabaseLoadJob, "_recover_missing_rows", staticmethod(recover))
    tabs[:] = ["account_deposit"]
    original = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sync_status": "in-sync", "_sheet_row_num": 2}
    source.snapshot_rows.return_value = [original.copy()]
    conn.cursor.return_value.__enter__.return_value.fetchall.return_value = []
    writer = MagicMock(return_value=0)
    monkeypatch.setattr(extractor.account_details_db, "upsert_details", writer)
    job.run(reprocess=reprocess)
    assert writer.call_args.args[3][0]["sync_status"] == "create-pending"
    assert original["sync_status"] == "in-sync"
    conn.rollback.assert_not_called()


@pytest.mark.parametrize("reprocess", [False, True])
def test_account_types_sync_precedes_categories_and_accounts(monkeypatch: pytest.MonkeyPatch, reprocess: bool) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    tabs.append("account_types")
    calls = []
    handlers[0].side_effect = lambda *args, **kwargs: calls.append("categories") or 0
    handlers[1].side_effect = lambda *args, **kwargs: calls.append("accounts") or 0
    writer = MagicMock(side_effect=lambda *args, **kwargs: calls.append("types") or 0)
    monkeypatch.setattr(extractor.account_types_db, "upsert_account_types", writer)
    source.snapshot_rows.side_effect = lambda name: [{"sync_status": "in-sync"}] if name == "account_types" else []
    job.run(reprocess=reprocess)
    assert calls == ["types", "categories", "accounts"]
    assert source.capture.call_args.args[0][0] == "account_types"
    assert writer.call_args.args[2][0]["sync_status"] == ("update-pending" if reprocess else "in-sync")
    conn.rollback.assert_not_called()


def test_account_types_failure_stops_all_dependent_entities(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    tabs.append("account_types")
    monkeypatch.setattr(extractor.account_types_db, "upsert_account_types", MagicMock(return_value=1))
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_types"):
        job.run()
    for handler in handlers:
        handler.assert_not_called()
    source.flush_pending.assert_called_once()


@pytest.mark.parametrize("reprocess", [False, True])
@pytest.mark.parametrize("entity,handler_index", [("transaction_master", 2), ("subscription_master", 3)])
def test_missing_movement_is_recovered_without_changing_existing_source_status(monkeypatch: pytest.MonkeyPatch, reprocess: bool, entity: str, handler_index: int) -> None:
    recover = extractor.LedgerDatabaseLoadJob._recover_missing_rows
    job, tabs, conn, source, handlers = _job(monkeypatch)
    monkeypatch.setattr(extractor.LedgerDatabaseLoadJob, "_recover_missing_rows", staticmethod(recover))
    tabs[:] = [entity]
    present = {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sync_status": "in-sync", "_sheet_row_num": 9}
    missing = {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "sync_status": "in-sync", "_sheet_row_num": 3}
    source.snapshot_rows.return_value = [present.copy(), missing.copy()]
    conn.cursor.return_value.__enter__.return_value.fetchall.return_value = [(present["id"],)]
    job.run(reprocess=reprocess)
    received = handlers[handler_index].call_args.args[2]
    assert [row["sync_status"] for row in received] == ["update-pending" if reprocess else "in-sync", "create-pending"]
    assert [row["_sheet_row_num"] for row in received] == [9, 3]
    assert present["sync_status"] == missing["sync_status"] == "in-sync"
    conn.rollback.assert_not_called()


def test_writers_get_no_sheet_recheck_and_outcomes_are_stored_once(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    job.run()
    assert all("before_commit" not in handler.call_args.kwargs and "before_dependency_commit" not in handler.call_args.kwargs for handler in handlers)
    source.flush_pending.assert_called_once_with(mode="normal-sync")


def test_outcomes_are_stored_even_when_a_tab_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    handlers[1].return_value = 1
    with pytest.raises(RuntimeError, match="entity_rows_failed:account_master"):
        job.run(reprocess=True)
    source.flush_pending.assert_called_once_with(mode="hard-sync")


def test_nothing_to_load_when_the_newest_snapshot_is_already_acknowledged(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    monkeypatch.setattr(extractor, "latest_run", lambda _conn, **_kwargs: None)
    job.run()
    source.capture.assert_not_called()
    assert all(not handler.called for handler in handlers)
    conn.close.assert_called_once()


def test_unknown_staged_tab_fails_before_any_writer(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, handlers = _job(monkeypatch)
    tabs.append("acount_master")
    with pytest.raises(ValueError, match="^unknown_staged_tab:acount_master$"):
        job.run()
    assert all(not handler.called for handler in handlers)


@pytest.mark.parametrize("fails", [False, True])
def test_outcomes_are_stored_with_ctrl_c_ignored(monkeypatch: pytest.MonkeyPatch, fails: bool) -> None:
    import signal

    job, tabs, conn, source, handlers = _job(monkeypatch)
    if fails:
        handlers[1].side_effect = KeyboardInterrupt
    seen = []
    source.flush_pending.side_effect = lambda **_kwargs: seen.append((signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)))
    before = (signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM))
    if fails:
        with pytest.raises(KeyboardInterrupt):
            job.run()
        conn.rollback.assert_called_once()
    else:
        job.run()
    assert seen == [(signal.SIG_IGN, signal.SIG_IGN)]
    assert (signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)) == before


def test_invalid_reports_are_reported_on_their_rows_without_failing_the_load(monkeypatch: pytest.MonkeyPatch) -> None:
    job, tabs, conn, source, _ = _job(monkeypatch)
    tabs.append("report_master")
    upsert = MagicMock(return_value=2)
    monkeypatch.setattr(extractor.reports_db, "upsert_reports", upsert)
    job.run()
    upsert.assert_called_once()
    source.flush_pending.assert_called_once()
    conn.rollback.assert_not_called()
