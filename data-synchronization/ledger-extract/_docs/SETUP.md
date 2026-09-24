# Extraction structure and operational database mapping

The [mapping index](README.md) links the current entity contracts. These documents describe the current expense-tracker source and the final ledger schema after migrations 0001–0021. [Usage](../_runbooks/USAGE-INSTRUCTIONS.md) covers credentials, execution and recovery.

## Structure

```text
ledger-extract/
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
  core/                   configuration, job orchestration and CLI
  sheets/                 current headers, snapshot reads, sync acknowledgements
  transforms/             validated values, Decimal money and local dates
  database/               relational writes and successful-run metadata
  migrations/             ordered PostgreSQL DDL
  tests/unit/             fixture-only checks
  tests/integration/      disposable PostgreSQL checks
```

## Data flow

Enabled tabs are read and validated as snapshots, then processed in dependency order: account_types → category_master → account_master → six detail tabs → transaction_master → subscription_master. `account_types` and `currency_master` reference data must already exist; foreign monetary values require the documented historical rates. Detail tabs use atomic tab writes; all six use pending/in-sync metadata. Each tab is opt-in.

Entity documents distinguish direct fields, renamed fields, resolved foreign keys, computed values, database-generated metadata and fields not persisted. More database columns can arise from one source value; for example, transaction local timestamp plus timezone produces UTC/local timestamps and two day-of-week fields. Other source fields expand into related tables or have no database destination.

## Complete operational-table column mapping

These tables do not correspond to source tab rows.

| Sheet/source input | Database column | Type | Transformation / current use |
|---|---|---|---|
| No Sheet column — job constant | `job_execution_details.job_name` | TEXT NOT NULL, PK | Literal `ledger-extract`. One job row per database. |
| No cell — Drive spreadsheet `modifiedTime` | `job_execution_details.last_sheet_modified_at` | TIMESTAMPTZ NULL | Timestamp read after snapshot capture and saved on full successful completion; informational, not an early-exit gate. NULL after first bootstrap until successful completion. |
| No Sheet column — database clock | `job_execution_details.ran_at` | TIMESTAMPTZ NOT NULL | Bootstrap sentinel `1970-01-01T00:00:00Z`; subsequently `now()` on successful completion, not on each failed attempt. It is not a per-row source edit timestamp. |
| None — unused legacy design | `ledger_data_checksums.entity` | TEXT NOT NULL | No current writer; part of the legacy composite PK. |
| None — unused legacy design | `ledger_data_checksums.natural_key` | TEXT NOT NULL | No current writer; other part of composite PK. |
| None — unused legacy design | `ledger_data_checksums.row_hash` | TEXT NOT NULL | No hash comparison is implemented. |
| None — unused legacy design | `ledger_data_checksums.last_seen_at` | TIMESTAMPTZ NOT NULL | Not populated by the current job. Does not drive deletion detection. |

Sources: [migration 0001](../migrations/0001_create_shared_infrastructure.py), [job metadata writer](../database/job_execution_details.py), [orchestrator](../core/extractor.py). Migration CLI tracking tables belong to the shared migration tool; they are not business-sheet mappings.

## Source metadata which is not copied

All four master tabs have `sync_status`, `sync_date`, and `sync_notes`. They are read/control/writeback fields only; no corresponding per-entity database columns exist. The job writes these three fields after PostgreSQL commit and after checking that the captured source has not changed. Sheet `created_at` and `updated_at` remain source-owned and are not copied to the identically named ingestion columns.

The six upgraded detail tabs carry the same six lifecycle/sync/audit columns as other entities. Only record_status is persisted; sync metadata stays in Sheets and source audit timestamps stay separate from DB ingestion time. Successful/failed acknowledgements affect only the three sync cells. Source content is rechecked before each atomic detail-tab commit.

`_sheet_row_num` is temporary Python metadata for addressing the original physical row, including sparse gaps in a whole-tab batch read. It has no Sheet header and no database column. Header-only empty tabs do not delete database records. Physically removed rows are not inferred as deleted; an explicit source tombstone is required.

`account_types` additionally stores its successful ingestion sync state and a database-only `is_sheet_managed` marker. Its source audit timestamps remain separate from database audit timestamps. See [account types](account-types.md).

## Runtime and schema prerequisites

The selected spreadsheet comes from `cicd/envs.json`; database credentials and service-account key path come from `infrastructure/.env.<env>`. Runtime uses the committed lockfile. Currency migrations run in the separate currency-rates module and must precede ledger migration 0004 and other rate-dependent objects.

Ledger migrations 0011–0013 add `account_master.tracking_start_date_local`, optional subscription start dates and applied-rate snapshots. Old account/transaction `applied_rate_value` remains NULL until deliberate replay; the migration cannot reconstruct which mutable rate was used historically. Migration 0009 retains old constraint names but standardises the rate-reference **column** name to `currency_rate_id`.

Migration 0014 renames account-type reference keys and adds display labels, preserving existing UUIDs and foreign keys. Account/category lookups require this migration; `account_master.account_type` and `account_master.account_subtype` keep their existing names and reference the renamed keys.

Migration 0015 added the source fields while preserving legacy rows and leaving unprovided economic facts NULL. The account writer uses its source metadata when guarding subtype changes, so apply it even if details are disabled.

Migration 0016 adds lifecycle status columns/checks for the six metadata-bearing detail sources without guessing historical statuses. Upgrade existing source tabs using the expense-tracker helper before enabling them.

Migration 0017 aligns account opening-sign constraints with expense-tracker: asset/investment snapshots may be signed, while liabilities remain nonpositive in both local and base amounts. Existing UUIDs and balances are unchanged.

Migration 0018 gives each supported extension table the exact Sheet name and splits the former shared loan table. Supported rows and UUIDs survive unchanged. The fixed-income/P2P extension tables are dropped, and their import/extractor contracts are removed. Account master subtypes are unchanged. See [detail migration and recovery](account-details.md#legacy-compatibility).

Migration 0019 adds the `account_types` Sheet extraction contract, lifecycle/sync fields and safe one-time adoption of existing unmanaged catalog UUIDs with category links retained. Initialize this source from the current CSV in Configure → Account Types before running the enabled extractor; no runtime seed is supplied.

Migration 0020 converts account-type/subtype key values to hyphens, preserves UUIDs/FKs and appends source-owned `is_loan`/`detail_sheet` policy. It clears database type sync state to require a fourteen-column source refresh. Initial normal-sync performs that refresh even for source in-sync rows. Dependent account/category/detail lookups require Sheet ownership and completed policy sync; enable `account_types` in older configs before this initial run. New classifications are rejected; extraction only manages existing database catalog pairs.

Upgrade the source separately: deploy expense-tracker and import the complete current `account_types.csv` in Configure before retrying category import or extraction. A legacy twelve-column tab raises `account_types_migration_required` before entity writes. Database migration does not alter the Sheet. Categories rejected by the UI have not reached the source tab and cannot be recovered by hard-sync; complete their source import first.

Migration 0021 permits subscriptions without a category and retains their optional source classification fields. It preserves existing identities and relationships; see [subscriptions](subscription-master.md).

Current commands from the module directory:

```bash
make lint
make test-unit
make test-integration
make run ENV=dev
bash cicd/start-up.sh dev --reprocess
```

A live run writes both PostgreSQL and Sheet sync metadata. Documentation validation does not require a live run. Run during a quiet editing window: there is no distributed transaction or atomic conditional Sheet acknowledgement. See [implementation notes](implementation-learning.md) for remaining mapping decisions.

## Generated model caveat

`database/models/` is incomplete and several models are stale; `account_types.py` has been regenerated through migration 0020. Runtime writers do not consume these models. The model-generation config lists only ledger migrations, but a fresh schema also needs currency migrations before ledger rate foreign keys can be created. Current mapping inventories are checked against migrations and runtime SQL. Resolve the prerequisite build order before relying on `make generate-models`.

The source master tabs and entity toggles now use `account_master`, `category_master`, `transaction_master` and `subscription_master`. PostgreSQL already uses those names. Run the [GAS master-tab rename helper](../../../expense-tracker/_docs/master-sheet-names.md) for legacy tabs before starting the renamed extractor.
