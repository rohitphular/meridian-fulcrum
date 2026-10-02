# ledger-database-load

Transforms the latest staged snapshot of the expense-tracker Sheet and loads it into PostgreSQL: `account_types`, the `category_master`, `account_master`, `transaction_master` and `subscription_master` tabs, and six account-detail tabs. It reads only PostgreSQL. [ledger-sheet-extract](../ledger-sheet-extract/README.md) stages the Sheet first (`extract`) and afterwards writes this job's per-row outcomes to the Sheet's `sync_status`, `sync_date` and `sync_notes` cells (`acknowledge`). The Sheet owns entity identity and lifecycle; PostgreSQL stores validated relational records and money in integer minor units.

This is the current implementation contract as of 2026-10-02. [`_docs/`](_docs/README.md) contains the current column-by-column Sheet → database mappings, generated fields and explicit gaps. See [usage](./_runbooks/USAGE-INSTRUCTIONS.md) and the [review report](./_runbooks/REVIEW-2026-09-23.md).

Account-type configuration is managed in expense-tracker under **Configure → Account Types**. Initialize/import its Sheet tab before enabling its tab. Migrations 0019–0020 preserve existing category links and UUID ownership, convert key values to hyphens, and require a source policy refresh (migration 0022 later drops the unused `is_loan` flag) before dependent synchronization. No runtime seed or subtype catalog is supplied; see [account types](_docs/account-types.md).

The category import's UI diagnostics and failed-row retry queue belong to expense-tracker; extraction consumes only rows successfully saved in the Sheet. Both modules resolve legacy underscore category hints only when the corresponding hyphenated subtype exists in the eligible catalog. Invalid hints fail explicitly. Deploy the current app, import the complete `account_types.csv` in Configure, then import categories before running extraction. A legacy twelve-column Account Types tab fails snapshot capture with `account_types_migration_required` and an upgrade instruction, before any entity writes; database migrations do not upgrade Sheet headers.

## Load and failure handling

Master CSVs, staged tab names and database tables use `account_master`, `category_master`, `transaction_master` and `subscription_master`. Existing spreadsheets must run the expense-tracker `migrateMasterSheetNames()` helper first; see the [rename procedure](../../expense-tracker/_docs/master-sheet-names.md). PostgreSQL already has these names; no database migration is required for this rename.

1. Take a PostgreSQL session advisory lock; a second load against that database fails with `ledger_database_load_already_running` instead of racing the first.
2. Pick the newest staging run. If it is already acknowledged there is nothing new to load (the run logs `nothing_to_load` and succeeds). An older snapshot is never loaded: a newer extract supersedes it. Re-running the load on the same (newest, not yet acknowledged) snapshot is allowed. Rows it handles again get new outcomes; other rows keep their earlier outcome, which is still true because committed database writes persist (a normal-sync reload does not wipe what a hard-sync stored for in-sync rows). Hard-sync (`--reprocess`) also re-loads the newest snapshot after it was acknowledged: the run becomes `loaded` again (`acknowledged_at` cleared) and the rows it handles are marked not acknowledged, so run `ledger-sheet-extract acknowledge` afterwards (a hard-sync pipeline config should end with it).
3. Check every staged tab's headers against the current GAS sheet contract (`core/source_contracts.py`, tested against the GAS schemas). Headers may be reordered. The legacy twelve-column Account Types layout fails with `account_types_migration_required`, the retired `is_loan` column with `account_types_is_loan_column_present`, anything else with `sheet_header_mismatch:<tab>`; a staged tab with no contract fails with `unknown_staged_tab:<tab>`. A valid header-only tab is empty and causes no entity deletion.
4. Process account_types → category_master → account_master → detail tabs → transaction_master → subscription_master. Successful standalone rows commit individually; actionable transaction legs connected by old or new parent links commit together, including reparenting and transfer reversals. Row validation/integrity failures roll back their row/group, record a failed outcome, and allow other independent rows in that entity to finish. Failed entities stop later dependent entities and make the job exit nonzero.
5. Each detail tab validates and commits atomically; a failure rolls back that tab and stops later entities. For metadata-bearing detail tabs, a validation failure marks every selected row create/update-failed with a safe error or rollback note.
6. Every handled row's outcome (`in-sync`, or `create-failed`/`update-failed` with `sync_notes`) is stored with the staged row — also when a later row fails — and the run is marked loaded, so ledger-sheet-extract's acknowledge step can still report successes and failures. Storing the outcomes runs with SIGINT and SIGTERM ignored, so a second Ctrl-C or SIGTERM cannot cut it short (SIGKILL still can, such as the consolidated pipeline's after 10 s). SIGTERM (kill, a scheduler) and SIGHUP (a closed terminal) unwind like Ctrl-C, and only the first signal counts: a load stopped while processing entities still stores the outcomes of the rows it handled, and the runner logs `runner: job_failed reason=interrupted` and exits 1. Source `created_at` and `updated_at` are never changed; database audit timestamps describe ingestion. There is no last-run checkpoint: rows stay pending until acknowledged, so unchanged Sheets still get retries after new rates, config changes or database recovery.

`create-pending`, `create-failed`, `update-pending`, and `update-failed` are actionable. Existing `in-sync` rows normally skip. An `in-sync` source UUID missing from the database is automatically requeued in memory for creation. Account types are the exception to insertion: initial ownership or policy refresh requeues an existing catalog pair, while a physically missing classification fails for explicit reconciliation. `--reprocess` also revalidates and updates existing in-sync rows after transformation or rate corrections without manually changing their Sheet status.

The six metadata-bearing detail tabs follow the same pending/failed/in-sync selection rules; identical pending content is marked in-sync without rewriting DB values. Hard-sync updates enabled rows and refreshes supported valuations. See [detail sync semantics](_docs/account-details.md).

Transaction groups hold a table write lock plus shared locks on their valuation/classification references until their commit. Reads remain available; competing transaction writers wait. Normal-sync skips existing in-sync legs and validates any unchanged stored siblings against the resulting pair. Source/parent UUIDs are canonicalized; a conflicting legacy database spelling fails for reconciliation instead of inserting another identity. Subscriptions use the same reference-lock discipline for each row, preserving source UUIDs, optional classification and explicit date/timezone semantics. See [transaction mapping and recovery](_docs/transaction-master.md) and [subscription mapping](_docs/subscription-master.md).

PostgreSQL and the Sheet do not share a transaction. If the acknowledge step does not run, or a row was edited after the snapshot, that Sheet row stays pending and the next run safely upserts the same stable identity. Earlier successful rows remain committed when later rows fail; the run is not globally atomic. The Sheet itself is never read here, so mid-run Sheet edits cannot stop a load.

## Stored entities

For every source and database column, see the [mapping index](_docs/README.md).

| Source | Database | Identity and important behaviour |
|---|---|---|
| `account_types` | `account_types` | Source UUID claims an existing unmanaged classification once; managed identities and keys are immutable. Labels, lifecycle and explicit `detail_sheet` policy come from the thirteen-column Sheet. Unknown classifications fail. |
| `category_master` | `category_master`, source/target account-type junctions | Sheet UUID is the master PK. Unreferenced classification changes and both mappings commit together; changing a classification already used by transactions/subscriptions fails for explicit reconciliation. A different UUID cannot take over an existing classification. Unknown account-type hints fail; `investment` expands to investment subtypes. |
| `account_master` | `account_master` | Sheet UUID is the PK. Current `account_currency_local`, `account_opening_date_local`, `account_closing_date_local`, and `tracking_start_date_local` map explicitly to database fields. Real opening and balance-tracking dates are separate. |
| account detail tabs | Six tables named exactly like their Sheet tabs | Sheet UUID is the PK. All source fields are mapped; multiple IDs per account are supported. Mortgage and personal loans have separate tables. [Six detail mappings](_docs/account-details.md). |
| `transaction_master` | `transaction_master`, `counterparty_master`, `beneficiaries_master`, `transaction_beneficiaries` | Sheet UUID is `transaction_id`; a separate stable database UUID is retained on update/retry. Transfer children reference the parent's source UUID. No delete-and-reinsert of master records. |
| `subscription_master` | `subscription_master`, `counterparty_master` | Sheet UUID is `subscription_id`; database UUID survives updates. Weekly/monthly start/end dates stay NULL when blank; quarterly/annual require a start anchor. All nonblank dates require their source timezone. |

All four supported source lifecycle values (`active`, `inactive`, `deleted`, `locked`) can be mirrored, including source restores/unlocks. Historical dependencies remain resolvable after accounts/categories are inactive or deleted. A physically removed Sheet row does not delete its database record: use source tombstones (`record_status=deleted`) where supported, and requeue master rows. All six detail tabs require lifecycle fields. Requeue a metadata-bearing detail row after changing its lifecycle state. This job is replication, not an additional application permission or account-balance enforcement layer.

### Money and rates

The [forex-database-load module](../forex-database-load/README.md) owns rate fetching, synchronization and backfills. ledger-database-load only reads `currency_master` and `currency_rates` to convert ledger amounts; it does not synchronize the Sheet's rates tab or write currency reference/rate records.

- Sheet amounts are major units. `Decimal` arithmetic rounds HALF_UP to the currency's minor unit precision, then checks PostgreSQL BIGINT bounds. NaN, infinity, invalid amounts and out-of-range values fail before a financial write. Sheets numeric cells themselves can already have lost precision; the load cannot recover digits missing at the source.
- XAU means **one gram of gold**, stored as **nanograms** (`decimal_places=9`). A rate means local major units per gram. Base conversion uses the rounded, stored local amount, ensuring local/base values refer to the same money: `base_minor = round_half_up((local_minor / 10^local_dp) / rate × 10^9)`.
- Account opening balances preserve source signs: assets/investments may be positive or negative, including overdrawn accounts; liabilities remain nonpositive. Migration `0017` aligns both local and base constraints with the source contract without rewriting existing balances.
- Account valuation uses the tracking snapshot's local date, or the real opening date for legacy rows without a tracking date. The latest rate **on or before that date** is selected. There is currently no maximum carry-forward age. Nonzero foreign balances require a dated snapshot and a rate; zero foreign balances may have no rate reference.
- Ordinary account fields declared immutable are checked against the stored record; mismatches fail explicitly. The newly introduced tracking date can be populated once when the stored value is NULL. Replay recomputes base valuation at that same source snapshot date, so corrected rates can be applied with `--reprocess`.
- Transactions use the **UTC transaction date** and an exact-date XAU rate. Missing rates fail the row/group rather than using today's rate. Crypto rate gaps can therefore block crypto transactions; required backfills belong to the forex-database-load module.
- New and replayed accounts/transactions store `applied_rate_value`, the exact rate used in their conversion, independently of the mutable `currency_rates` reference. A later provider correction cannot change this evidence. Old records keep NULL until an explicit replay; the migration never guesses historical rates. In-sync rows are not automatically revalued—use `--reprocess` when desired.
- Account and detail valuations retain shared locks on currency precision and the selected rate until commit, matching transaction/subscription reference protection. Account precision is reloaded for every row after prior commits release locks.
- Detail monetary totals use the same minor-unit conversion. Signed stock quantities/per-unit prices retain `NUMERIC(38,18)` precision. Foreign property current values use their evaluation date only; stocks may also specify a rate ID; historical costs/principals/payments with no matching valuation date retain NULL base amounts. The six [detail mappings](_docs/account-details.md) specify these omissions and XAU identity conversion.
- Subscription amounts are local minor units; they are obligations, not posted transactions or balances.
- Beneficiary shares are validated and stored to four decimal places. Equal allocations distribute the rounding remainder so shares total exactly 100; explicit shares must total exactly 100 after rounding.

### Dates and timezones

Local wall timestamps are resolved against IANA zones; ambiguous or nonexistent daylight-saving times fail instead of guessing an offset. Transaction rows retain the existing documented Europe/London default when the timezone is blank. For subscriptions with dates, the timezone must be explicit. PostgreSQL subscription date columns retain their historical `_local` names but are `TIMESTAMPTZ`: the job now supplies timezone-aware values, preserving the instant regardless of database session timezone.

## Scope boundaries and existing data

The six supported detail tabs each use a table of the same name. Migration `0018` renames four supported tables, splits mortgage and personal-loan history into separate tables, and drops the fixed-income/P2P detail tables and their contents. Supported rows retain their UUIDs, values and audit timestamps. Migration `0015` marks imported rows by `source_sheet`, permits absent legacy financial fields, and keeps old history intact. Imported rows mirror source snapshots; transactions do not mutate their balances or append history. Legacy rows (`source_sheet IS NULL`) need explicit reconciliation before combining them with imported rows in reports. Missing financial facts are never filled from unrelated master balances or dates.

`--reprocess` repairs supported records where source data and dependencies permit. It does not infer omitted/deleted source rows, repair historical timezone mistakes without sufficient source information, migrate conflicting immutable account fields, or clean up old extension history. No checksum-based deletion or reconciliation is implemented (the unused `ledger_data_checksums` table was dropped by migration `0023`).

Code tests use staged fixture rows and disposable PostgreSQL; a live smoke run remains separate.

## Runtime and migrations

The load requires ledger migrations through `0023` (`0023` drops the unused job tracking tables) and ledger-sheet-extract's staging tables. Its launcher applies pending ledger migrations automatically before loading: `0018` aligns detail tables, `0019–0020` add Sheet-owned Account Types and policies, `0021` preserves optional subscription classification, and `0022` drops the unused `account_types.is_loan` column. Existing databases receive the table renames, loan split and requested fixed-income/P2P table drops from `0018`. Historical migrations remain unchanged so deployed databases and fresh installs converge to the same schema. The migration tracking table keeps its original name, `schema_migrations_ledger_extract`.

From this module directory:

```bash
make lint
make test-unit
make test-integration   # requires local PostgreSQL server binaries
make run ENV=dev MODE=normal-sync
# Explicitly revalidate existing in-sync records (runs the job with --reprocess):
bash cicd/start-up.sh --interactive dev hard-sync
```

The launcher reads env and mode from the [pipeline config](../consolidated-pipeline/README.md) by default; `--interactive dev|prod [normal-sync|hard-sync]` takes them as arguments (and asks for a missing mode). It runs `cicd/check.sh` first, loads `../../infrastructure/.env.<env>`, syncs the committed lockfile, runs pending ledger migrations, then runs the job. It does not upgrade shared libraries on every run. `make upgrade-libs` is an explicit maintenance action. Run ledger-sheet-extract `extract` first; with no staged snapshot the load fails with `no_staged_snapshot`.

Currency tables, their migrations and the required historical rates must exist first. Migrations 0011–0013 add account tracking metadata, permit blank subscription starts, and capture applied rates. Migration 0005 now refuses to drop a nonempty legacy `transactions` table; migrate legacy history explicitly before retrying. This guard cannot recover a legacy table already dropped by an earlier run.

Migration 0014 gives `account_types` explicit `account_type_key`, `account_type_label`, `account_subtype_key` and `account_subtype_label` fields. It preserves existing UUIDs and relationships and fills labels from the current account taxonomy. Apply it before running the updated account/category lookups; normal startup runs pending migrations automatically.

Migration 0015 is required by the updated account/detail writers even when detail toggles are disabled. It preserves legacy records, adds the source fields and audit/rate metadata, and scopes legacy current-row uniqueness to legacy rows. Create/import each source tab before enabling it in ledger-sheet-extract's `config.yaml`; the load processes exactly the tabs that were staged, and hard-sync includes in-sync rows only in those. A missing enabled tab fails at extract with `missing_enabled_sheet:<tab>`. Hiding an import option in expense-tracker does not change the toggle.

Migration 0016 adds/checks detail lifecycle status while preserving unknown legacy statuses as NULL. Deploy the new expense-tracker backend, complete the property-column migration below if needed, then run `migrateAccountDetailMetadata()` in its Apps Script editor to upgrade existing six-tab metadata, or import into the updated schema. The helper visits existing tabs only, preserves IDs and financial fields, and does not invent historical creation times. See the [upgrade procedure](_docs/account-details.md#existing-tabs-and-csv-imports).

Migration 0017 permits signed asset/investment opening snapshots while retaining nonpositive liability checks. Normal startup applies it; previously failed negative asset/investment rows can then retry with their original UUIDs and signs. The source importer canonicalizes UUIDs, preserves an existing lifecycle status when omitted, retains decimal text, and queues direct account business/lifecycle edits through `onEdit`.

Property source schema no longer has `evaluation_currency_rate_id`. Upgrade an existing property tab with `migrateAccountPropertyRateColumn()`, then run one hard-sync to revalue existing records by evaluation date. Historical values in the retired database column remain untouched and are never used for current property valuation. Fixed-income/P2P extension contracts and import support have been removed.

Required environment variables: `FULCRUM_DB_HOST`, `FULCRUM_DB_PORT`, `FULCRUM_DB_USER`, `FULCRUM_DB_PASSWORD`, `FULCRUM_DB_NAME` and `MERIDIAN_LOG_ROOT`. No Google credentials: this job never talks to Google. Never print credentials.

## Code map

- `core/loader.py`: picks the newest staged run and runs the entity writers in dependency order; `core/runner.py`: CLI and safe failure reasons.
- `core/staging_source.py`: reads a staged snapshot (canonical UUIDs) and stores each row's outcome for the acknowledge step.
- `core/source_contracts.py`: current GAS header contract, tested against its source schema; `core/account_detail_contracts.py`: the six detail tabs.
- `transforms/`: field validation, Decimal/minor-unit conversion and local timestamp handling.
- `database/`: entity writes, and per-entity progress logging (`database/progress.py`).
- `outcomes/`: the per-entity sync outcome (status, date, notes) recorded for each handled row.
- `migrations/`: ordered schema changes; `database/models/` contains legacy generated models.
- `tests/unit/`: offline transform, writer, staging-source and failure-path checks.
- `tests/integration/`: disposable PostgreSQL migrations, lifecycle and staged-load checks. Tests never use `.env` database credentials.
