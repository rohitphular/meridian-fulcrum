# Account details: extraction contract

Ledger-extract supports **six Sheet detail tabs, each with a database table of exactly the same name**. Mortgage and personal loans have separate tables. Migration `0018` renames the four other supported tables, splits legacy loan records, and drops the retired fixed-income/P2P detail tables. Each imported row uses its Sheet `id` as the database primary key; retries and hard-sync preserve that UUID. Re-import cannot move an existing detail UUID to another account.

The [account master mapping](account-master.md) remains separate. Account details are source snapshots, not a replay of transactions or an automatically maintained balance history.

## One mapping document per detail type

Each document accounts for every source column, derived database column and retained legacy column.

| Document | Source tab(s) | Source columns | Database table |
|---|---|---:|---|
| [Deposit](account-deposit.md) | `account_deposit` | 13 | `account_deposit` |
| [Revolving credit](account-revolving-credit.md) | `account_liability_credit_card` | 13 | `account_liability_credit_card` |
| [Mortgage](account-mortgage.md) | `account_liability_mortgage` | 16 | `account_liability_mortgage` |
| [Personal loan](account-personal-loan.md) | `account_liability_personal_loan` | 14 | `account_liability_personal_loan` |
| [Market investment](account-market-investment.md) | `account_investment_stocks` | 27 | `account_investment_stocks` |
| [Property](account-property.md) | `account_investment_property` | 23 | `account_investment_property` |

The six tabs contain **106 source columns**. The Accounts importer exposes master plus these six detail choices; see the [import guide](../../../expense-tracker/_docs/account-imports.md). The six listed CSVs under `local/files/` now match their expanded contracts. Existing fields and values are preserved; new status fields start as `active` and `create-pending`, and unknown audit/sync timestamps stay blank. `account_deposit_details.csv` imports through `file_type=account_deposit` into the `account_deposit` tab. Stocks already had `record_status`; only five columns were appended there.

## Identity, relationships and cardinality

- `id` and `account_id` are required UUIDs; UUID casing is normalized. `account_id` resolves `account_master.id`, with a check that its synchronized `account_types.detail_sheet` equals the selected tab. Initialize and sync the current account-type catalog before accounts or details; see [account types](account-types.md).
- Multiple distinct detail IDs can reference one account, including multiple stock positions. Each tab has its own primary-key namespace. The same UUID in the two loan tabs identifies separate rows; neither can be reassigned to another account.
- `account_name` is retained as `source_account_name` where supplied. It never updates the account master name. Stocks has no such source column.
- Optional mortgage property links resolve an existing account whose synchronized policy selects `account_investment_property`. Account master subtype changes that would invalidate retained details or incoming property links are rejected.
- A new source ID colliding with a legacy database row fails for explicit reconciliation. The writer never adopts or overwrites an old generated-ID history row by matching account or name.

## Normal-sync, hard-sync and failures

The deposit, credit-card, mortgage, personal-loan, property and stocks tabs end with this metadata block:

```text
record_status, sync_status, sync_date, sync_notes, created_at, updated_at
```

The new fields append to existing headers without moving business columns. Stocks keeps its existing `record_status` position and appends the remaining five fields. `record_status` is persisted to the detail table; the three sync fields are Sheet control/acknowledgement data only. Sheet audit timestamps stay source-owned, separate from identically named DB ingestion timestamps.

Enable each desired tab explicitly in `config.yaml`; an omitted detail toggle remains disabled. Hard-sync honors the same enabled scope as normal-sync. Missing enabled tabs fail before entity writes; they are never silently treated as empty. When account extraction is disabled, referenced masters must already exist in the database. Existing tabs must be upgraded before enabling extraction; see the deployment sequence below.

For these six tabs, normal-sync processes `create-pending`, `create-failed`, `update-pending` and `update-failed`, and skips existing `in-sync` rows. An in-sync UUID missing from the matching source's DB rows is requeued for creation. Hard-sync (`--reprocess`) also processes existing in-sync rows and refreshes supported valuations. Pending rows whose mapped content already matches the database can be acknowledged without advancing DB `updated_at`; rate-only corrections require hard-sync. IDs and DB `created_at` remain stable.

All enabled tabs are captured before entity writes. Processing order is account_types → category_master → account_master → detail tabs → transaction_master → subscription_master. Selected detail rows commit atomically per tab after a source-snapshot check. A validation error rolls back that tab's selected rows and stops later entities. For the six metadata tabs, all selected rows receive their matching create/update-failed state, a UTC attempt timestamp and a safe row error or rollback note; none is acknowledged successful after rollback. Earlier committed tabs/master rows remain committed. Source/header check failures propagate without being relabelled as row failures or queuing stale failure acknowledgements. Unexpected dependency errors also abort without success acknowledgements. Logs never include raw financial rows.

On success, the extractor queues only `sync_status=in-sync`, UTC `sync_date`, and empty `sync_notes`, then rechecks source snapshots before writeback. It never modifies source `record_status`, `created_at` or `updated_at`. PostgreSQL and Sheets still do not share a transaction: a failed acknowledgement leaves the row pending, and retry safely reuses its UUID.

All six metadata tabs require a valid source lifecycle value (`active`, `inactive`, `deleted`, `locked`) at extraction. The importer defaults new rows to active and preserves an existing status when a replacement omits it. Deletion and restoration mirror the explicit lifecycle value after queuing a sync. Physical row removal and header-only tabs never delete DB records. Legacy database statuses remain NULL where unknown until source replay supplies them.

## Existing tabs and CSV imports

Deploy the updated expense-tracker GAS backend before importing the expanded CSVs. The importer owns sync/audit metadata regardless of values supplied in a CSV: a new row becomes create-pending with new creation/update timestamps; replacement preserves creation time, advances the existing sync state, refreshes update time and clears stale sync date/notes. UUIDs are preserved. Direct Sheet business/lifecycle edits must queue the row through the detail edit handler; extractor sync-cell writes do not requeue it.

If the existing property tab still contains `evaluation_currency_rate_id`, first run `migrateAccountPropertyRateColumn()`. The helper removes only the retired Sheet column, preserving address and metadata alignment. After completing the remaining upgrades below, perform one hard-sync to refresh existing property valuations using their date. Normal-sync may skip recalculation when the remaining mapped fields are identical.

Run `migrateAccountDetailMetadata()` in the Apps Script editor (or pass one supported file type to limit scope), as described in the [account import guide](../../../expense-tracker/_docs/account-imports.md) for existing detail tabs before running extraction. It scans existing tabs only, appends missing trailing headers, initializes absent lifecycle/sync state, preserves creation time and refreshes update time only for initialized rows. It does not invent a historical creation time. An incompatible header layout or invalid existing metadata needs explicit correction; it is not silently reordered.

Apply ledger migrations through `0020` and sync the fourteen-column `account_types` source (normal startup handles pending migrations), then enable the upgraded tabs. Use hard-sync once after the property-column migration; otherwise use normal-sync. No live deployment, Sheet migration or configured-database write was performed by this code change.

## Money, dates and missing values

Blank optional fields become NULL and can clear previously supplied values. Zero and false remain values. Numeric text uses ASCII decimal notation with optional sign/exponent; underscores, locale separators and non-ASCII digits fail. Rates are percentage points (5 means 5%); ownership is constrained to 0–100. Interest rates must be nonnegative and have no artificial 100% ceiling. Integer schedules/terms, enums, UUIDs, booleans, finite numbers and source-local dates are validated. Source/import validation and Python validation are separate layers; the importer is not a substitute for the extraction checks.

Totals are Decimal major units converted to BIGINT minor units using `currency_master.decimal_places`, HALF_UP rounding and overflow checks. Stock quantity and per-unit prices use `NUMERIC(38,18)`; they are not rounded to currency cents. Signed stock values are preserved independently of `position_side`. The writer never computes totals from quantity, applies an option multiplier, allocates ownership, annualizes payments, or substitutes account opening balances for missing details.

Currency comes from the account master, except a supplied stock `instrument_currency_local` selects its own registered currency. `base_currency` is XAU, one gram represented as nanograms. For foreign currency, property requires a current-value valuation date; stocks also permit an explicit evaluation-rate UUID. These inputs provide the basis for current-value base conversion. A date selects the latest rate on or before that local calendar date; there is no maximum carry-forward age. An explicit rate must exist, have the correct currency pair and a positive finite value, and cannot postdate a supplied valuation date. Missing eligible rates fail; missing valuation evidence leaves base value/rate NULL. Historical cost, principal, rent and payment base amounts stay NULL because their dates are not supplied. For XAU itself, corresponding base/local totals are identical and the applied rate is 1.

Where the source exposes `evaluation_currency_rate_id` (stocks), it is preserved separately from derived `currency_rate_id`; `applied_rate_value` captures the numeric rate used. Property no longer exposes that source field. Its old DB column is retained as unused historical data; new rows leave it NULL. Rate data is read from the currency-rates module's tables only. This job performs no rate synchronization.

Detail dates remain validated ISO local text, without inventing a timezone, UTC instant or midnight history boundary. In particular, valuation dates do not become `effective_from_dt`, and acquisition dates do not automatically populate old `purchase_date` fields.

## Legacy compatibility

Migration `0018` preserves all columns and records from supported detail tables. Legacy loans with no source provenance are classified by their owner subtype (`mortgage` or `personal_loan`); any other subtype or conflicting provenance aborts the migration atomically as `account_detail_loan_classification_requires_reconciliation`. Unknown dependent views/FKs also block destructive changes instead of being cascaded away. Fixed-income/P2P extension tables and their contents are removed; their account-master records and subtype definitions remain available. Historical migration files retain the prior schema solely for upgrades. Retained legacy rows have `source_sheet IS NULL`; new imported rows record the exact source tab. Legacy rows and their financial fields are retained, and newly introduced audit fields remain NULL for existing history because its ingestion dates are unknown. The old unique-current-row indexes apply only to legacy rows; imported rows support many source IDs per account.

Imported rows leave unsupported legacy fields NULL: these include SCD `effective_from_dt`/`effective_to_dt`, transaction `entity_type`/`entity_id`, and balances or dates absent from the source. The migration permits those omissions instead of inventing economic values. Each family document lists the exact fields. New `created_at`/`updated_at` describe ingestion, not source creation or financial effective dates.

Account and linked-property rows are locked for shared access through the detail commit. The master writer locks its row for update before validating retained detail policy, so concurrent subtype edits cannot invalidate a just-validated detail relationship. Unknown or mismatched stored source provenance fails with a reconciliation error.

Consumers combining old and imported rows must filter by `source_sheet` and avoid counting both as one balance series. No automatic reconciliation, deletion, historical rebuild or transaction-driven detail mutation is performed.

Implementation: [contracts](../core/account_detail_contracts.py), [transform](../transforms/account_details.py), [writer](../database/account_details.py), [table migration](../migrations/0018_align_account_detail_tables.py), [lifecycle migration](../migrations/0016_account_detail_sync_metadata.py), [unit checks](../tests/unit/test_account_details.py), and [PostgreSQL checks](../tests/integration/test_database.py).
