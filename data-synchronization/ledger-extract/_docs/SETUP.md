# Extraction structure and operational database mapping

The [mapping index](README.md) links the current entity contracts. These documents describe the current expense-tracker source and the final ledger schema after migrations 0001–0013. [Usage](../_runbooks/USAGE-INSTRUCTIONS.md) covers credentials, execution and recovery.

## Structure

```text
ledger-extract/
  README.md
  _docs/
    README.md
    accounts.md
    account-details.md
    categories.md
    transactions.md
    subscriptions.md
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

Enabled tabs are read and validated as snapshots, then processed in dependency order: categories → accounts → transactions → subscriptions. `account_types` and `currency_master` reference data must already exist; foreign monetary values require the documented historical rates. The account-detail tabs are not connected to this pipeline.

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

`_sheet_row_num` is temporary Python metadata for addressing the original physical row, including sparse pages. It has no Sheet header and no database column. Header-only empty tabs do not delete database records. Physically removed rows are not inferred as deleted; an explicit source tombstone is required.

## Runtime and schema prerequisites

The selected spreadsheet comes from `cicd/envs.json`; database credentials and service-account key path come from `infrastructure/.env.<env>`. Runtime uses the committed lockfile. Currency migrations run in the separate currency-rates module and must precede ledger migration 0004 and other rate-dependent objects.

Ledger migrations 0011–0013 add `account_master.tracking_start_date_local`, optional subscription start dates and applied-rate snapshots. Old account/transaction `applied_rate_value` remains NULL until deliberate replay; the migration cannot reconstruct which mutable rate was used historically. Migration 0009 retains old constraint names but standardises the rate-reference **column** name to `currency_rate_id`.

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

`database/models/` is stale and incomplete; runtime writers do not consume it. The model-generation config lists only ledger migrations, but a fresh schema also needs currency migrations before ledger rate foreign keys can be created. Current mapping inventories are checked against migrations and runtime SQL, not these generated files. Resolve the prerequisite build order before relying on `make generate-models`.
