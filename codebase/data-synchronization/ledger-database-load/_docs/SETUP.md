# Load structure and operational database mapping

The [mapping index](README.md) links the current entity contracts. These documents describe the current expense-tracker source and the final ledger schema after migrations 0001–0023. [Usage](../_runbooks/USAGE-INSTRUCTIONS.md) covers credentials, execution and recovery.

## Structure

```text
ledger-database-load/
  README.md
  _docs/
    README.md
    account-master.md
    account-details.md      common detail contract and index
    account-*.md           six detail-type mappings
    category-master.md
    transaction-master.md
    subscription-master.md
    SETUP.md
    implementation-learning.md
  _runbooks/               execution, review and verification instructions
  core/                   configuration, job orchestration, CLI, source contracts and
                          the staged-snapshot reader (staging_source.py)
  transforms/             validated values, Decimal money and local dates
  database/               relational writes and run progress
  outcomes/               per-entity sync outcomes stored in staging
  migrations/             ordered PostgreSQL DDL
  tests/unit/             fixture-only checks
  tests/integration/      disposable PostgreSQL checks
```

## Data flow

Enabled tabs are staged by ledger-sheet-extract (`stg_runs`, `stg_sheet_headers`, `stg_sheet_rows`); this job reads the newest staged snapshot from those tables, validates it and processes it in dependency order: account_types → category_master → account_master → six detail tabs → transaction_master → subscription_master. `account_types` and `currency_master` reference data must already exist; foreign monetary values require the documented historical rates. Detail tabs use atomic tab writes; all six use pending/in-sync metadata. Each tab is opt-in.

Entity documents distinguish direct fields, renamed fields, resolved foreign keys, computed values, database-generated metadata and fields not persisted. More database columns can arise from one source value; for example, transaction local timestamp plus timezone produces UTC/local timestamps and two day-of-week fields. Other source fields expand into related tables or have no database destination.

## Operational tables

There are none: every ledger table maps a source tab. Migration `0023` dropped the former `job_execution_details` (it only recorded the Drive modified time after a successful run, never a skip gate) and the never-used `ledger_data_checksums`, both created by `0001`. Migration CLI tracking tables belong to the shared migration tool; they are not business-sheet mappings.

## Source metadata which is not copied

All four master tabs have `sync_status`, `sync_date`, and `sync_notes`. They are read/control/writeback fields only; no corresponding per-entity database columns exist. This job stores each row's outcome in staging; `ledger-sheet-extract acknowledge` later writes the three fields, matching rows by UUID and skipping rows edited since the snapshot. Sheet `created_at` and `updated_at` remain source-owned and are not copied to the identically named ingestion columns.

The six upgraded detail tabs carry the same six lifecycle/sync/audit columns as other entities. Only record_status is persisted; sync metadata stays in Sheets and source audit timestamps stay separate from DB ingestion time. Successful/failed acknowledgements affect only the three sync cells. Each atomic detail-tab commit uses the staged snapshot; the Sheet is not re-read.

`_sheet_row_num` is the physical Sheet row a staged row was read from (stored in `stg_sheet_rows`), kept for logs and sync notes. It has no Sheet header and no database column. Acknowledgement does not rely on it: ledger-sheet-extract finds each row by its UUID in a fresh read. Header-only empty tabs do not delete database records. Physically removed rows are not inferred as deleted; an explicit source tombstone is required.

`account_types` additionally stores its successful ingestion sync state and a database-only `is_sheet_managed` marker. Its source audit timestamps remain separate from database audit timestamps. See [account types](account-types.md).

## Runtime and schema prerequisites

This job needs no spreadsheet or Google credentials (`cicd/envs.json` only lists `dev` and `prod`); database credentials and the log root come from `infrastructure/.env.<env>`. Runtime uses the committed lockfile. Currency migrations run in the separate forex-database-load module and must precede ledger migration 0004 and other rate-dependent objects.

Ledger migrations 0011–0013 add `account_master.tracking_start_date_local`, optional subscription start dates and applied-rate snapshots. Old account/transaction `applied_rate_value` remains NULL until deliberate replay; the migration cannot reconstruct which mutable rate was used historically. Migration 0009 retains old constraint names but standardises the rate-reference **column** name to `currency_rate_id`.

Migration 0014 renames account-type reference keys and adds display labels, preserving existing UUIDs and foreign keys. Account/category lookups require this migration; `account_master.account_type` and `account_master.account_subtype` keep their existing names and reference the renamed keys.

Migration 0015 added the source fields while preserving legacy rows and leaving unprovided economic facts NULL. The account writer uses its source metadata when guarding subtype changes, so apply it even if details are disabled.

Migration 0016 adds lifecycle status columns/checks for the six metadata-bearing detail sources without guessing historical statuses. Upgrade existing source tabs using the expense-tracker helper before enabling them.

Migration 0017 aligns account opening-sign constraints with expense-tracker: asset/investment snapshots may be signed, while liabilities remain nonpositive in both local and base amounts. Existing UUIDs and balances are unchanged.

Migration 0018 gives each supported extension table the exact Sheet name and splits the former shared loan table. Supported rows and UUIDs survive unchanged. The fixed-income/P2P extension tables are dropped, and their import/extractor contracts are removed. Account master subtypes are unchanged. See [detail migration and recovery](account-details.md#legacy-compatibility).

Migration 0019 adds the `account_types` Sheet extraction contract, lifecycle/sync fields and safe one-time adoption of existing unmanaged catalog UUIDs with category links retained. Initialize this source from the current CSV in Configure → Account Types before running the enabled extractor; no runtime seed is supplied.

Migration 0020 converts account-type/subtype key values to hyphens, preserves UUIDs/FKs and appends source-owned `is_loan`/`detail_sheet` policy. It clears database type sync state to require a source refresh. Migration 0022 then drops the unused `is_loan` column; delete it from the `account_types` Sheet tab too. Initial normal-sync performs that refresh even for source in-sync rows. Dependent account/category/detail lookups require Sheet ownership and completed policy sync; enable `account_types` in older configs before this initial run. New classifications are rejected; extraction only manages existing database catalog pairs.

Upgrade the source separately: deploy expense-tracker and import the complete current `account_types.csv` in Configure before retrying category import or extraction. A legacy twelve-column tab raises `account_types_migration_required` before entity writes. Database migration does not alter the Sheet. Categories rejected by the UI have not reached the source tab and cannot be recovered by hard-sync; complete their source import first.

Migration 0021 permits subscriptions without a category and retains their optional source classification fields. It preserves existing identities and relationships; see [subscriptions](subscription-master.md).

Migration 0022 drops the unused `account_types.is_loan` column. Delete the matching column from the `account_types` Sheet tab; the load stops with `account_types_is_loan_column_present` while it remains.

Current commands from the module directory:

```bash
make lint
make test-unit
make test-integration
make run ENV=dev MODE=normal-sync
bash cicd/start-up.sh --interactive dev hard-sync
```

A live run writes PostgreSQL and the staged row outcomes only; the Sheet is updated afterwards by `ledger-sheet-extract acknowledge`. Documentation validation does not require a live run. See [implementation notes](implementation-learning.md) for remaining mapping decisions.

## Generated model caveat

`database/models/` is incomplete and several models are stale; `account_types.py` reflects migrations through 0022. Runtime writers do not consume these models. The model-generation config lists only ledger migrations, but a fresh schema also needs currency migrations before ledger rate foreign keys can be created. Current mapping inventories are checked against migrations and runtime SQL. Resolve the prerequisite build order before relying on `make generate-models`.

The source master tabs and the entity toggles (in ledger-sheet-extract's `config.yaml`) now use `account_master`, `category_master`, `transaction_master` and `subscription_master`. PostgreSQL already uses those names. Run the [GAS master-tab rename helper](../../../expense-tracker/_docs/master-sheet-names.md) for legacy tabs before running ledger-sheet-extract against them.
