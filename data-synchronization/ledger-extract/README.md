# ledger-extract

Extracts the `categories`, `accounts`, `transactions`, and `subscriptions` tabs from the expense-tracker Google Sheet into PostgreSQL. The Sheet owns entity identity and lifecycle; PostgreSQL stores validated relational records and money in integer minor units. The job writes only `sync_status`, `sync_date`, and `sync_notes` back to the Sheet.

This is the current implementation contract as of 2026-09-23. [`_docs/`](_docs/README.md) contains the current column-by-column Sheet → database mappings, generated fields and explicit gaps. See [usage](./_runbooks/USAGE-INSTRUCTIONS.md) and the [review report](./_runbooks/REVIEW-2026-09-23.md).

## Extraction and failure handling

1. Validate the enabled-entity configuration and take a PostgreSQL session advisory lock. A second ledger-extract process against that database fails instead of racing the first.
2. Capture all enabled tabs before entity writes. Require the current GAS header set, unique UUIDs, and valid sync statuses. Headers may be reordered: acknowledgements resolve their actual positions. Missing tabs or headers fail; a valid header-only tab is empty and causes no entity deletion.
3. Read raw numeric cell values, preserving physical row numbers and blank gaps. Paging uses the worksheet grid size; a short or blank intermediate page is not treated as end-of-data. Formatted numeric text is not guessed or stripped of locale separators.
4. Process categories → accounts → transactions → subscriptions. Successful standalone rows commit individually; actionable legs belonging to the same transfer commit together. Row validation/integrity failures roll back their row/group, queue a failed status, and allow other independent rows in that entity to finish. Failed entities stop later dependent entities and make the job exit nonzero.
5. Queue acknowledgements only after database commit. Re-read the captured tabs before sending acknowledgements and fail if the source changed. Source `created_at` and `updated_at` are never overwritten; database audit timestamps describe ingestion.
6. Record the successful job checkpoint only after entity processing and acknowledgements succeed. Drive modification time is informational, not a skip gate: unchanged Sheets may still need retries after new rates, config changes, or database recovery.

`create-pending`, `create-failed`, `update-pending`, and `update-failed` are actionable. Existing `in-sync` rows normally skip. An `in-sync` source UUID missing from the database is automatically requeued in memory for creation. `--reprocess` also revalidates and updates existing in-sync rows after transformation or rate corrections without manually changing their Sheet status.

PostgreSQL and Sheets do not share a transaction. If acknowledgement fails after a commit, the source remains pending and a retry safely upserts the same stable identity. Earlier successful rows remain committed when later rows fail; the run is not globally atomic. Sheets has no atomic compare-and-swap for cell acknowledgements, so a narrow edit race remains between the final source check and write. Run during a quiet editing window. The job lock prevents competing extractors, not human edits or GAS writes.

## Stored entities

For every source and database column, see the [mapping index](_docs/README.md).

| Source | Database | Identity and important behaviour |
|---|---|---|
| categories | `category_master`, source/target account-type junctions | Sheet UUID is the master PK. Unreferenced classification changes and both mappings commit together; changing a classification already used by transactions/subscriptions fails for explicit reconciliation. A different UUID cannot take over an existing classification. Unknown account-type hints fail; `investment` expands to investment subtypes. |
| accounts | `account_master` | Sheet UUID is the PK. Current `account_currency_local`, `account_opening_date_local`, `account_closing_date_local`, and `tracking_start_date_local` map explicitly to database fields. Real opening and balance-tracking dates are separate. |
| transactions | `transaction_master`, `counterparty_master`, `beneficiaries_master`, `transaction_beneficiaries` | Sheet UUID is `transaction_id`; a separate stable database UUID is retained on update/retry. Transfer children reference the parent's source UUID. No delete-and-reinsert of master records. |
| subscriptions | `subscription_master`, `counterparty_master` | Sheet UUID is `subscription_id`; database UUID survives updates. Optional start/end dates stay NULL when blank; nonblank dates require their source timezone. |

All four supported source lifecycle values (`active`, `inactive`, `deleted`, `locked`) can be mirrored, including source restores/unlocks. Historical dependencies remain resolvable after accounts/categories are inactive or deleted. A physically removed Sheet row does not delete its database record: use source tombstones (`record_status=deleted`) and requeue the row. This job is replication, not an additional application permission or account-balance enforcement layer.

### Money and rates

The [currency-rates module](../currency-rates/README.md) owns rate fetching, synchronization and backfills. Ledger-extract only reads `currency_master` and `currency_rates` to convert ledger amounts; it does not synchronize the Sheet's rates tab or write currency reference/rate records.

- Sheet amounts are major units. `Decimal` arithmetic rounds HALF_UP to the currency's minor unit precision, then checks PostgreSQL BIGINT bounds. NaN, infinity, invalid amounts and out-of-range values fail before a financial write. Sheets numeric cells themselves can already have lost precision; the extractor cannot recover digits missing at the source.
- XAU means **one gram of gold**, stored as **nanograms** (`decimal_places=9`). A rate means local major units per gram. Base conversion uses the rounded, stored local amount, ensuring local/base values refer to the same money: `base_minor = round_half_up((local_minor / 10^local_dp) / rate × 10^9)`.
- Account opening balances preserve liability signs. The existing database policy requires nonpositive liabilities and nonnegative assets/investments. A valid source negative asset balance therefore needs an explicit policy/schema reconciliation; it is not silently coerced.
- Account valuation uses the tracking snapshot's local date, or the real opening date for legacy rows without a tracking date. The latest rate **on or before that date** is selected. There is currently no maximum carry-forward age. Nonzero foreign balances require a dated snapshot and a rate; zero foreign balances may have no rate reference.
- Ordinary account fields declared immutable are checked against the stored record; mismatches fail explicitly. The newly introduced tracking date can be populated once when the stored value is NULL. Replay recomputes base valuation at that same source snapshot date, so corrected rates can be applied with `--reprocess`.
- Transactions use the **UTC transaction date** and an exact-date XAU rate. Missing rates fail the row/group rather than using today's rate. Crypto rate gaps can therefore block crypto transactions; required backfills belong to the currency-rates module.
- New and replayed accounts/transactions store `applied_rate_value`, the exact rate used in their conversion, independently of the mutable `currency_rates` reference. A later provider correction cannot change this evidence. Old records keep NULL until an explicit replay; the migration never guesses historical rates. In-sync rows are not automatically revalued—use `--reprocess` when desired.
- Subscription amounts are local minor units; they are obligations, not posted transactions or balances.
- Beneficiary shares are validated and stored to four decimal places. Equal allocations distribute the rounding remainder so shares total exactly 100; explicit shares must total exactly 100 after rounding.

### Dates and timezones

Local wall timestamps are resolved against IANA zones; ambiguous or nonexistent daylight-saving times fail instead of guessing an offset. Transaction rows retain the existing documented Europe/London default when the timezone is blank. For subscriptions with dates, the timezone must be explicit. PostgreSQL subscription date columns retain their historical `_local` names but are `TIMESTAMPTZ`: the job now supplies timezone-aware values, preserving the instant regardless of database session timezone.

## Scope boundaries and existing data

The six current account-detail tabs are **not extracted**. The seven historical account-extension tables remain in the schema, but this job neither seeds them nor maintains derived balances/valuations. The old transaction-only extension mutation path was removed because it ignored edits/deletions/restores and confused cash flows with asset market values. Existing extension rows need a separately designed and tested rebuild before use as current balances.

`--reprocess` repairs supported records where source data and dependencies permit. It does not infer omitted/deleted source rows, repair historical timezone mistakes without sufficient source information, migrate conflicting immutable account fields, or clean up old extension history. `ledger_data_checksums` remains legacy unused schema; no checksum-based deletion or reconciliation is implemented.

No live Sheets or configured dev/prod databases were written during the September review. Code tests use fixture Sheets and disposable PostgreSQL; a live smoke run remains separate.

## Runtime and migrations

From this module directory:

```bash
make lint
make test-unit
make test-integration   # requires local PostgreSQL server binaries
make run ENV=dev
# Explicitly revalidate existing in-sync records:
bash cicd/start-up.sh dev --reprocess
```

The launcher selects the spreadsheet from `cicd/envs.json`, loads `../../infrastructure/.env.<env>`, syncs the committed lockfile, runs pending ledger migrations, then runs the job. It does not upgrade shared libraries on every run. `make upgrade-libs` is an explicit maintenance action.

Currency tables, their migrations and the required historical rates must exist first. Migrations 0011–0013 add account tracking metadata, permit blank subscription starts, and capture applied rates. Migration 0005 now refuses to drop a nonempty legacy `transactions` table; migrate legacy history explicitly before retrying. This guard cannot recover a legacy table already dropped by an earlier run.

Required environment variables: `FULCRUM_DB_HOST`, `FULCRUM_DB_PORT`, `FULCRUM_DB_USER`, `FULCRUM_DB_PASSWORD`, `FULCRUM_DB_NAME`, `LE_SERVICE_ACCOUNT_FILE`, and `MERIDIAN_LOG_ROOT`. Direct Python invocation also needs `LE_SPREADSHEET_ID`; the launcher sets it from the chosen environment registry. Never print credentials or service-account key contents.

## Code map

- `core/`: configuration, orchestration, CLI.
- `sheets/contracts.py`: current GAS header contract, tested against its source schema.
- `sheets/client.py`: raw reads, snapshots, pagination and guarded acknowledgements; adapter over the pinned shared Sheets library.
- `sheets/{entity}.py`: sync-only acknowledgement payloads.
- `transforms/`: field validation, Decimal/minor-unit conversion and local timestamp handling.
- `database/`: entity writes and successful-job bookkeeping.
- `migrations/`: ordered schema changes; `database/models/` contains legacy generated models.
- `tests/unit/`: offline source-boundary, transform and failure-path checks.
- `tests/integration/`: disposable PostgreSQL migrations, lifecycle and pipeline checks. Tests never use `.env` database credentials.
