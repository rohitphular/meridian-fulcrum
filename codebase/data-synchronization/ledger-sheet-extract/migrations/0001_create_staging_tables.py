"""Staging for Sheet snapshots: ledger-sheet-extract writes, ledger-database-load reads.

One generic row table (cells as JSONB keyed by header) so a new Sheet column needs no
staging migration. A run moves extracted → loaded → acknowledged; a newer extract
marks older unfinished runs superseded.
"""

from typing import Any


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS stg_runs (
                    run_id           UUID        NOT NULL,
                    captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                    status           TEXT        NOT NULL,
                    enabled_tabs     TEXT[]      NOT NULL,
                    loaded_at        TIMESTAMPTZ NULL,
                    load_mode        TEXT        NULL,
                    acknowledged_at  TIMESTAMPTZ NULL,
                    CONSTRAINT pk_stg_runs PRIMARY KEY (run_id),
                    CONSTRAINT chk_stg_runs_status CHECK (status IN ('extracted', 'loaded', 'acknowledged', 'superseded'))
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_stg_runs_captured_at ON stg_runs (captured_at DESC)")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS stg_sheet_headers (
                    run_id   UUID  NOT NULL REFERENCES stg_runs (run_id) ON DELETE CASCADE,
                    tab      TEXT  NOT NULL,
                    headers  JSONB NOT NULL,
                    CONSTRAINT pk_stg_sheet_headers PRIMARY KEY (run_id, tab)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS stg_sheet_rows (
                    run_id          UUID    NOT NULL,
                    tab             TEXT    NOT NULL,
                    sheet_row_num   INTEGER NOT NULL,
                    source_id       TEXT    NOT NULL,
                    cells           JSONB   NOT NULL,
                    outcome_status  TEXT    NULL,
                    outcome_date    TEXT    NULL,
                    outcome_notes   TEXT    NULL,
                    acknowledged    BOOLEAN NOT NULL DEFAULT false,
                    CONSTRAINT pk_stg_sheet_rows PRIMARY KEY (run_id, tab, sheet_row_num),
                    CONSTRAINT fk_stg_sheet_rows_headers FOREIGN KEY (run_id, tab) REFERENCES stg_sheet_headers (run_id, tab) ON DELETE CASCADE
                )
            """)
        client.commit()
    except Exception:
        client.rollback()
        raise
