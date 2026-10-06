from typing import Any

import database.staging as staging

IDENTITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
HEADERS = ["id", "name", "amount", "rate", "flag", "zero", "blank", "note", "sync_status", "sync_date", "sync_notes"]


def _row(row_number: int = 2, **values: Any) -> dict:
    row = {
        "id": IDENTITY.upper(),
        "name": "Rent",
        "amount": 1475,
        "rate": 0.30000000000000004,
        "flag": True,
        "zero": 0,
        "blank": "",
        "note": "Café ☕",
        "sync_status": "create-pending",
        "sync_date": "",
        "sync_notes": "",
    }
    row.update(values, _sheet_row_num=row_number)
    return row


def _status(conn: Any, run_id: str) -> str:
    with conn.cursor() as cursor:
        cursor.execute("SELECT status FROM stg_runs WHERE run_id = %s", (run_id,))
        return cursor.fetchone()[0]


def test_staged_cells_round_trip_with_their_python_types(database: tuple) -> None:
    conn, _ = database
    run_id = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    with conn.cursor() as cursor:
        cursor.execute("SELECT source_id, cells, sheet_row_num FROM stg_sheet_rows WHERE run_id = %s", (run_id,))
        source_id, cells, row_number = cursor.fetchone()
        cursor.execute("SELECT headers, (SELECT enabled_tabs FROM stg_runs WHERE run_id = %s) FROM stg_sheet_headers WHERE run_id = %s", (run_id, run_id))
        headers, tabs = cursor.fetchone()
    expected = {key: value for key, value in _row().items() if key != "_sheet_row_num"}
    assert cells == expected
    # Equal is not enough: an int must not come back as a float, nor True as 1.
    assert {key: type(value) for key, value in cells.items()} == {key: type(value) for key, value in expected.items()}
    assert (source_id, row_number, headers, tabs) == (IDENTITY, 2, HEADERS, ["account_master"])


def test_a_new_extract_supersedes_unfinished_runs_and_only_the_newest_is_loaded(database: tuple) -> None:
    conn, _ = database
    first = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    with conn.cursor() as cursor:
        cursor.execute("UPDATE stg_runs SET status = 'loaded' WHERE run_id = %s", (first,))
    conn.commit()
    assert staging.latest_loaded_run(conn) == first
    second = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    assert _status(conn, first) == "superseded"
    assert _status(conn, second) == "extracted"
    # The newest run is not loaded yet, so there is nothing to acknowledge.
    assert staging.latest_loaded_run(conn) is None


def test_outcomes_are_acknowledged_once_and_the_run_is_finished(database: tuple) -> None:
    conn, _ = database
    run_id = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row(2), _row(3, id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")])})
    with conn.cursor() as cursor:
        cursor.execute("UPDATE stg_sheet_rows SET outcome_status = 'in-sync', outcome_date = 'now' WHERE run_id = %s AND sheet_row_num = 2", (run_id,))
        cursor.execute("UPDATE stg_runs SET status = 'loaded' WHERE run_id = %s", (run_id,))
    conn.commit()
    outcomes = staging.pending_outcomes(conn, run_id)
    assert [(row.sheet_row_num, row.outcome) for row in outcomes] == [(2, ("in-sync", "now", ""))]
    staging.mark_acknowledged(conn, run_id, outcomes)
    assert staging.pending_outcomes(conn, run_id) == []
    assert _status(conn, run_id) == "acknowledged"
    assert staging.latest_loaded_run(conn) is None


def test_runs_past_retention_are_pruned_but_not_the_newest_or_unfinished_ones(database: tuple) -> None:
    conn, _ = database
    old_finished = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    with conn.cursor() as cursor:
        cursor.execute("UPDATE stg_runs SET status = 'acknowledged', captured_at = now() - interval '7 months' WHERE run_id = %s", (old_finished,))
    conn.commit()
    recent_finished = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    with conn.cursor() as cursor:
        cursor.execute("UPDATE stg_runs SET status = 'acknowledged', captured_at = now() - interval '5 months' WHERE run_id = %s", (recent_finished,))
    conn.commit()
    newest = staging.store_snapshot(conn, {"account_master": (HEADERS, [_row()])})
    with conn.cursor() as cursor:
        cursor.execute("SELECT run_id::text FROM stg_runs ORDER BY captured_at")
        remaining = [record[0] for record in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) FROM stg_sheet_rows WHERE run_id = %s", (old_finished,))
        assert cursor.fetchone() == (0,), "pruned rows go with their run"
    assert remaining == [recent_finished, newest]
