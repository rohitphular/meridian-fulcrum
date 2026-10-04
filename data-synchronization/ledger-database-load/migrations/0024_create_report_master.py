"""Report configuration from the expense-tracker report_master tab (pre-built and user-defined).

Definitions follow data-synchronization/analytics/contract/report-definition.json; the
analytics job reads them from here. source_updated_at keeps the Sheet's updated_at text
exactly, because the job reports each result against the definition it computed.
"""

from typing import Any

_REPORT_MASTER = """
CREATE TABLE IF NOT EXISTS report_master (
    id                 UUID PRIMARY KEY,
    report_type        TEXT NOT NULL CHECK (report_type IN ('predefined', 'user_defined')),
    predefined_key     TEXT,
    report_name        TEXT NOT NULL CHECK (char_length(report_name) BETWEEN 1 AND 60),
    report_description TEXT NOT NULL DEFAULT '' CHECK (char_length(report_description) <= 140),
    measure            TEXT,
    period_preset      TEXT,
    period_from        DATE,
    period_to          DATE,
    compare_mode       TEXT,
    time_grain         TEXT,
    group_by_1         TEXT,
    group_by_2         TEXT,
    top_n              SMALLINT,
    include_other      BOOLEAN,
    filter_account_ids UUID[] NOT NULL DEFAULT '{}',
    filter_categories  TEXT[] NOT NULL DEFAULT '{}',
    filter_tags        TEXT[] NOT NULL DEFAULT '{}',
    filter_payees      TEXT[] NOT NULL DEFAULT '{}',
    filter_currencies  TEXT[] NOT NULL DEFAULT '{}',
    filter_countries   TEXT[] NOT NULL DEFAULT '{}',
    filter_tx_types    TEXT[] NOT NULL DEFAULT '{}',
    filter_amount_min  NUMERIC(20, 8) CHECK (filter_amount_min >= 0),
    filter_amount_max  NUMERIC(20, 8) CHECK (filter_amount_max >= 0),
    chart_kind         TEXT,
    record_status      TEXT NOT NULL CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
    source_created_at  TEXT NOT NULL DEFAULT '',
    source_updated_at  TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_report_master_predefined_key CHECK ((report_type = 'predefined') = (predefined_key IS NOT NULL)),
    CONSTRAINT ck_report_master_definition CHECK (
        report_type = 'predefined'
        OR (measure IS NOT NULL AND period_preset IS NOT NULL AND compare_mode IS NOT NULL
            AND time_grain IS NOT NULL AND include_other IS NOT NULL AND chart_kind IS NOT NULL)
    ),
    CONSTRAINT ck_report_master_fixed_period CHECK ((period_preset = 'fixed') = (period_from IS NOT NULL AND period_to IS NOT NULL) OR period_preset IS NULL),
    CONSTRAINT ck_report_master_period_order CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
)
"""


def upgrade(client: Any) -> None:
    try:
        with client.cursor() as cursor:
            cursor.execute(_REPORT_MASTER)
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_report_master_predefined_key ON report_master (predefined_key) WHERE predefined_key IS NOT NULL")
            # Names are unique among the user's live reports (the app enforces the same rule).
            cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_report_master_user_name ON report_master (lower(report_name)) WHERE report_type = 'user_defined' AND record_status <> 'deleted'")
        client.commit()
    except Exception:
        client.rollback()
        raise
