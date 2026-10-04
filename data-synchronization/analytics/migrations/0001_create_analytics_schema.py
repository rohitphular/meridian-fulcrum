"""The analytics schema: one row per run, and every report payload the run computed.

The job owns this schema; other modules never read or write it. Runs are kept so a
publish can be retried on its own and two generations can be compared. Mart tables
(task 09) are added by later migrations in this schema.
"""

from typing import Any

_STATEMENTS = (
    "CREATE SCHEMA IF NOT EXISTS analytics",
    """
    CREATE TABLE IF NOT EXISTS analytics.run (
        generation_id      UUID PRIMARY KEY,
        mode               TEXT NOT NULL CHECK (mode IN ('build', 'refresh')),
        status             TEXT NOT NULL CHECK (status IN ('running', 'built', 'published', 'failed')),
        anchor_date        DATE NOT NULL,
        contract_version   INTEGER NOT NULL,
        source_watermark   JSONB NOT NULL DEFAULT '{}'::jsonb,
        reports_ok         INTEGER NOT NULL DEFAULT 0,
        reports_failed     INTEGER NOT NULL DEFAULT 0,
        rows_not_loaded    INTEGER NOT NULL DEFAULT 0,
        missing_currencies TEXT[] NOT NULL DEFAULT '{}',
        error_code         TEXT,
        started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at        TIMESTAMPTZ,
        published_at       TIMESTAMPTZ
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_analytics_run_started ON analytics.run (started_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS analytics.report_output (
        generation_id UUID NOT NULL REFERENCES analytics.run (generation_id) ON DELETE CASCADE,
        report_id     UUID NOT NULL,
        variant_key   TEXT NOT NULL,
        payload       JSONB NOT NULL,
        PRIMARY KEY (generation_id, report_id, variant_key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS analytics.report_result (
        generation_id         UUID NOT NULL REFERENCES analytics.run (generation_id) ON DELETE CASCADE,
        report_id             UUID NOT NULL,
        definition_updated_at TEXT NOT NULL DEFAULT '',
        status                TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
        error_code            TEXT,
        PRIMARY KEY (generation_id, report_id)
    )
    """,
)


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            for statement in _STATEMENTS:
                cursor.execute(statement)
        client.commit()
    except Exception:
        client.rollback()
        raise
