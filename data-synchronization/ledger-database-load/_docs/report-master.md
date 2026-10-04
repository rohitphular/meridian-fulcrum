# Report master

The source is the expense-tracker `report_master` tab: report configuration from the app's Reports section, pre-built and user-defined in one tab. Its columns and every rule come from the [report contract](../../analytics/contract/README.md) (`report-definition.json`); the same file drives the app's validator and the analytics job, which reads this table to compute reports. Nothing is computed here.

## Rows

| Source | Rule |
|---|---|
| Pre-built (`report_type = predefined`) | `id` and `predefined_key` must match the catalogue (`predefined-reports.json`). Name and description always come from the catalogue; `record_status` is always `locked`; every definition column is NULL / empty. |
| User-defined (`user_defined`) | Validated like the app does ([transforms/reports.py](../transforms/reports.py), kept identical to `report-validation.gs` by a test that runs both on the same cases). Filters must refer to non-deleted accounts, their currencies and non-deleted category keys **in PostgreSQL**. A deleted report skips that reference check. |

`in-sync` rows are skipped; pending and failed rows are upserted by source UUID, one commit per row. A failure stores `create-failed` / `update-failed` with `sync_notes` = `<code>:<column>` (the contract's error code), which the app shows as **Invalid**. **A failed report row does not fail the load** (unlike other tabs): the report is the user's to fix and must not hold back the other reports. A row cannot switch between pre-built and user-defined (`invalid_report_type`).

## Columns

| Source column | Database column | Notes |
|---|---|---|
| `id` | `id` UUID PK | Source UUID |
| `report_type`, `predefined_key` | same | `predefined_key` set exactly when pre-built (unique) |
| `report_name`, `report_description` | same | ≤ 60 / ≤ 140 characters; names unique (ignoring case) among live user reports |
| `measure`, `period_preset`, `compare_mode`, `time_grain`, `group_by_1`, `group_by_2`, `chart_kind` | same, TEXT | Contract keys |
| `period_from`, `period_to` | DATE | Only for `fixed` (a Sheets date serial is read as its date) |
| `top_n`, `include_other` | SMALLINT, BOOLEAN | Defaults from the contract when a breakdown is set |
| `filter_account_ids` | UUID[] | `;`-separated in the Sheet |
| `filter_categories`, `filter_tags`, `filter_payees`, `filter_currencies`, `filter_countries`, `filter_tx_types` | TEXT[] | `;`-separated in the Sheet; currencies upper-cased |
| `filter_amount_min`, `filter_amount_max` | NUMERIC(20,8) | In the account's own currency |
| `record_status` | same | active, inactive, deleted, locked |
| `created_at`, `updated_at` | `source_created_at`, `source_updated_at` TEXT | The Sheet text, unchanged: the analytics job reports each result against `source_updated_at` |
| `sync_status`, `sync_date`, `sync_notes` | not persisted | Outcome via staging and acknowledge |
| — | `created_at`, `updated_at` TIMESTAMPTZ | Database audit times |

Migration `0024_create_report_master.py` creates the table.
