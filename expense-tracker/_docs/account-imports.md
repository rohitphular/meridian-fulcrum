# Account CSV imports

The Accounts import panel sends `import_account_data` with `{ file_type, csv }`, where `csv` is the raw file text. Select the file type explicitly. This is a header-based import; keep the exact names below.

## Request and response

`importAccountDataCsv` (`api/account-import.gs`) owns parsing and format validation; the browser only uploads the file and renders the outcome.

1. `file_type` is checked first: blank returns `missing_file_type`, anything outside the registry returns `unknown_file_type`.
2. The CSV is parsed by the shared `parseCsvImport`: headers are trimmed, lowercased and spaces become underscores; quoted fields may contain commas, quotes and newlines; blank lines are skipped. Blank or duplicate headers return `invalid_csv_headers`; a header-only file returns `csv_has_no_rows`; malformed quoting returns `invalid_csv`; rows with the wrong column count return `invalid_csv_rows`. Cells stay trimmed text, so IDs and decimal amounts are never reinterpreted.
3. Every row is format-checked without reading any Sheet: detail rows use the importer's own row preparation (required fields, UUIDs, enums, numbers, booleans, dates and ranges below); `account_master` rows use the Sheet-free part of account validation (UUID, required fields, decimal opening value, dates and DST wall times, timezone, `record_status`, three-letter currency). A non-blank `id` repeated in the file (case-insensitive) is `duplicate_id`. Any failure returns `{ ok: false, error: 'invalid_csv_rows', errors: ['Row <line>: <code>'] }` and nothing is written.
4. `dry_run: true` stops here and returns `{ ok: true, dry_run: true, file_type, rows }`. It never reads or writes a Sheet.
5. Otherwise the rows (keyed by header, exactly as in the file) go to `importAccountData`, which runs the Sheet-dependent checks below and upserts by `id`. Its response is returned with `rows: <n>` added and every `results[i].line` set to that row's physical CSV line.

`account_master` delegates to account validation and ID-based replacement; see [accounts.md](accounts.md#csv-import). The Accounts dropdown and backend support the master and six detail types. These tables give the exact Sheet column order. Detail CSVs hold the columns through `record_status` only, like the other master CSVs: the **System** columns are server-owned, not part of the file, and ignored if an older file still has them. All detail types include a lifecycle/sync/audit block; stocks already had `record_status` and appends only the remaining five columns. Property removes its retired rate-reference column through the explicit migration below.

Every detail `id` and `account_id` must be a hyphenated UUID. Optional `linked_property_account_id` on mortgages and `evaluation_currency_rate_id` on stocks must also be UUIDs when supplied. The importer trims surrounding whitespace and writes lowercase UUIDs, preserving their identity. It never generates a new detail ID. The extraction mapping keeps the same UUID in the database.

Account eligibility is configured by `account_types.detail_sheet`: the account's type/subtype row must name the selected detail tab. A blank mapping permits no detail import. The current 16-row catalog and its policy values live in the `account_types` Sheet, initially imported from `../../_do-not-touch`; they are not duplicated in importer code or the tables below. Hyphens apply to classification key values only; these Sheet/tab identifiers keep underscores.

## `account_deposit`

Tab: `account_deposit`. Eligible accounts are selected by the catalog's matching `detail_sheet` value.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `account_name` | No |  |
| `is_interest_paid` | No |  |
| `rate_type` | No | `fixed`, `variable` |
| `interest_payment_frequency` | No | `monthly`, `quarterly`, `annually`, `at_maturity` |
| `interest_rate` | No | Finite number when supplied |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## `account_liability_credit_card`

Tab: `account_liability_credit_card`. Eligible accounts are selected by the catalog's matching `detail_sheet` value.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `account_name` | No |  |
| `credit_limit_local` | Yes | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `payment_month_day` | No | Finite number when supplied |
| `statement_month_day` | No | Finite number when supplied |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## `account_liability_mortgage`

Tab: `account_liability_mortgage`. Eligible accounts are selected by the catalog's matching `detail_sheet` value.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `account_name` | No |  |
| `linked_property_account_id` | No | UUID of an existing property account when supplied |
| `original_principal_local` | Yes | Finite number when supplied |
| `monthly_payment_local` | No | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `rate_type` | No | `fixed`, `variable` |
| `term_months` | Yes | Finite number when supplied |
| `maturity_date_local` | No |  |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## `account_liability_personal_loan`

Tab: `account_liability_personal_loan`. Eligible accounts are selected by the catalog's matching `detail_sheet` value.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `account_name` | No |  |
| `original_principal_local` | Yes | Finite number when supplied |
| `monthly_payment_local` | No | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `term_months` | Yes | Finite number when supplied |
| `maturity_date_local` | No |  |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## `account_investment_property`

Tab: `account_investment_property`. Eligible accounts are selected by the catalog's matching `detail_sheet` value. Current valuation uses `current_value_evaluation_date` and the latest eligible existing currency rate on or before that date. Property has no source rate-reference field; an old CSV `evaluation_currency_rate_id` key is ignored and never persisted.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `account_name` | No |  |
| `acquisition_type` | Yes | `PURCHASED`, `INHERITED`, `GIFTED` |
| `acquisition_date_local` | No |  |
| `is_rented` | No |  |
| `rent_frequency` | No | `MONTHLY`, `YEARLY` |
| `rent_day` | No | Finite number when supplied |
| `rent_month` | No | Finite number when supplied |
| `current_value_local` | No | Finite number when supplied |
| `property_ownership_percentage` | No | Finite number when supplied |
| `rent_amount_local` | No | Finite number when supplied |
| `rent_ownership_percentage` | No | Finite number when supplied |
| `property_service_charge_frequency` | No | `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `property_service_charge_amount_local` | No | Finite number when supplied |
| `current_value_evaluation_date` | No |  |
| `property_address` | No |  |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## `account_investment_stocks`

Tab: `account_investment_stocks`. Eligible accounts are selected by the catalog's matching `detail_sheet` value.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes | Stable UUID supplied by the source |
| `account_id` | Yes | UUID of an existing account of an allowed subtype |
| `instrument_symbol` | No |  |
| `instrument_name` | No |  |
| `instrument_type` | Yes | `EQUITY`, `ETF`, `MUTUAL_FUND`, `OPTION`, `FUTURE`, `CASH` |
| `instrument_currency_local` | No |  |
| `holding_intent` | No | `LONG_TERM`, `SHORT_TERM`, `TRADING` |
| `position_side` | No | `LONG`, `SHORT` |
| `quantity` | No | Finite number when supplied |
| `avg_cost_price_local` | No | Finite number when supplied |
| `cost_basis_local` | No | Finite number when supplied |
| `current_price_local` | No | Finite number when supplied |
| `current_value_local` | No | Finite number when supplied |
| `price_asof_date` | No |  |
| `evaluation_currency_rate_id` | No | UUID when supplied; rate existence is checked by ledger-database-load |
| `underlying_symbol` | No |  |
| `option_type` | No | `CALL`, `PUT` |
| `strike_price_local` | No | Finite number when supplied |
| `expiry_date` | No |  |
| `contract_multiplier` | No | Finite number when supplied |
| `opening_date` | No |  |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked`; defaults active on create, preserves existing value if omitted/blank on update |
| `sync_status` | System | Importer-owned pending state; CSV value ignored |
| `sync_date` | System | Cleared on import; extractor records acknowledgement date |
| `sync_notes` | System | Cleared on import; extractor records sync outcome |
| `created_at` | System | Creation timestamp on insert; preserved on replacement; CSV value ignored |
| `updated_at` | System | Refreshed on import or direct business/lifecycle edits; CSV value ignored |

## Replacement and validation

Detail rows require their own `id` and an `account_id`. A matching detail ID replaces the source business values; omitted optional business columns become blank. Omitted/blank `record_status` preserves the current value on replacement and defaults to `active` on creation. Sync/audit fields are system-owned regardless of CSV values. Unknown columns are not persisted. A CSV that repeats a detail ID, including with different UUID letter casing, is rejected with `duplicate_id` before any write; the internal `importAccountData` still treats a repeat in one batch as a replacement. Existing duplicate IDs in the destination tab cause `duplicate_detail_id` before any detail rows are written; resolve the duplicate rows before retrying. Import the account master before its detail rows. An existing detail UUID cannot move to a different `account_id`; the importer returns `detail_account_move_rejected` before replacing that row, matching the database identity rule.

All supplied rows are checked for required fields, UUID format, enumerations, and finite numeric values before Sheets are opened. Numeric strings must use decimal or scientific-decimal notation (for example `123.45` or `1.2345e2`); hexadecimal, binary and octal notation are rejected. Valid decimal strings retain their source precision when written. Through the CSV endpoint any format-invalid row rejects the whole file before Sheets are opened; the internal `importAccountData` still accepts partial batches and, when every row is invalid, does not access or create Sheets. Valid rows additionally check account existence/subtype and linked-property references before the detail target tab is opened, upgraded or written. A batch whose rows all fail those reference checks does not mutate target headers, metadata or financial values. Reference and replacement checks allow partial success: a failing row has a failure result while the other rows can be saved. Field-level boolean, date, integer-bound, sign and percentage constraints are validated as described below; cross-field completeness (for example rent details when `is_rented` is true) is not, and ledger-database-load applies its own database validation. The GAS importer checks the format of an evaluation-rate UUID but does not call the database or synchronize rates.

Response: `{ ok, file_type, rows, created, updated, skipped, failed, results }`; `skipped` counts rows identical to the stored row (`action: 'unchanged'`), which are not rewritten. Each result has `{ line, key, ok, action?, error?, field? }`; `ok` is true only if no row failed. File-level failures return `{ ok: false, error, errors? }` as described in [Request and response](#request-and-response); other request-level failures return `{ ok: false, error }`. Errors include `missing_file_type`, `unknown_file_type`, `missing_csv`, `invalid_csv`, `csv_has_no_rows`, `invalid_csv_headers`, `invalid_csv_rows`, `duplicate_id`, `missing_rows`, `invalid_row`, `duplicate_detail_id`, `unknown_account`, `sub_type_mismatch`, `invalid_linked_property`, `detail_account_move_rejected`, and field-specific `missing_*` / `invalid_*` codes, including `invalid_id`, `invalid_account_id`, `invalid_linked_property_account_id`, and `invalid_evaluation_currency_rate_id`.

## Sync metadata and existing-tab upgrade

All six detail tabs have a trailing block in this exact order: `record_status`, `sync_status`, `sync_date`, `sync_notes`, `created_at`, `updated_at`. Stock `record_status` remains in its original position immediately before the five newly appended fields.

New rows get `create-pending`, blank sync date/notes, and the current UTC ISO timestamp in both audit columns. A replacement whose values all equal the stored row (ignoring the sync and audit columns) is left untouched and counted as unchanged (`skipped`), so an `in-sync` row stays `in-sync`. Other replacements preserve `created_at`, refresh `updated_at`, clear stale sync date/notes, and use `computeSyncStatus`: `create-pending`, `create-failed` or blank stays/becomes `create-pending`; other states become `update-pending`. Supplying `in-sync`, arbitrary sync notes or historical audit timestamps in CSV cannot bypass this behavior. Replacing an existing locked detail or account-master row returns `record_locked` without changing it; importing a new row already marked locked remains supported. Supplied valid `record_status` is retained, including `deleted` or `locked`.

If the property tab still contains `evaluation_currency_rate_id`, complete the property migration below first. After deploying the updated GAS code, run `migrateAccountDetailMetadata()` in the Apps Script editor before extracting existing tabs that have not been re-imported. This helper scans only the six supported tabs already present; it does not create absent tabs. It validates every selected tab's existing header prefix before any column append or backfill, then appends missing trailing columns and initializes rows under a script lock. Optional `migrateAccountDetailMetadata('account_deposit')` restricts the operation to one existing tab. Header renames/reordering require an explicit correction first. This code change does not run the helper or modify any live Sheet.

Migration fills blank `record_status` with `active` and blank `sync_status` with `create-pending`. Existing nonblank lifecycle/sync values and existing sync date/notes are retained. Unknown legacy `created_at` stays blank; `updated_at` is stamped only when metadata is initialized. Re-running the helper changes no initialized rows. The normal importer also initializes metadata on its selected target tab after row/reference preflight, and preserves unknown creation timestamps on replacement.

Direct edits or multirow pastes into business/lifecycle columns of these six tabs run the shared `onEdit` hook. It queues the affected nonempty rows through `computeSyncStatus`, clears stale sync date/notes and refreshes `updated_at`, without rewriting financial cells or `created_at`. Header-only and sync/audit-only edits do not queue rows. Programmatic writes by the importer or extractor do not trigger this simple Sheet event.

## Property rate-reference retirement

Property source columns now total 23 (17 business fields plus six metadata fields). Stocks retain their source `evaluation_currency_rate_id` field. The existing property database column is retained for legacy values and is not used by new property valuations.

For an existing property Sheet, deploy this code and run `migrateAccountPropertyRateColumn()` once in the Apps Script editor. The helper only acts on an existing `account_investment_property` tab and accepts four exact known header layouts: old 18/24-column layouts with the retired field, or new 17/23-column layouts without it. Unknown/reordered/partial layouts fail before any writes. It runs under a script lock and never creates a missing tab.

For old layouts, it initializes missing metadata, queues all nonempty property rows while the old fields are still aligned, and removes physical column 17 (`evaluation_currency_rate_id`). Property address, other business fields, lifecycle status and known creation timestamps retain their values after the shift. Sync status becomes pending according to `computeSyncStatus`, stale sync date/notes are cleared, and `updated_at` is refreshed. Queuing happens before column deletion so an interrupted deletion remains safely retryable. Unknown creation timestamps remain blank. Re-running against an initialized new 23-column layout performs no writes; a new 17-column layout only receives the metadata upgrade.

Run ledger-database-load with **hard-sync once after this migration** to refresh property valuations under the date-based rate policy. Pending status alone does not guarantee recalculation because the database writer may recognize unchanged mapped source values and preserve earlier derived values during normal sync. Subsequent normal sync uses the usual pending/in-sync protocol.

Imports never remove a Sheet column implicitly. An unmigrated property tab fails the positional header check, and `migrateAccountDetailMetadata()` explicitly directs you to the property helper first. No live Sheet migration is run by changing these files.

## Extraction boundary

Each of the six detail tabs maps to a database table with exactly the same name:

| Sheet tab / database table |
|---|
| `account_deposit` |
| `account_liability_credit_card` |
| `account_liability_mortgage` |
| `account_liability_personal_loan` |
| `account_investment_property` |
| `account_investment_stocks` |

Mortgage and personal-loan details are stored separately. All detail tabs use their pending/failed/in-sync protocol. Stocks are instrument positions, so several rows can reference one account. Fixed-income and P2P detail imports and extraction have been removed; requests for those retired import types return `unknown_file_type` before any Sheet access. Their account-master classifications (`bonds`, `p2p-lending`) were also removed from the catalog on 2026-09-29; historical rows in the Sheet catalog with no detail mapping. See the [ledger-database-load detail mappings](../../data-synchronization/ledger-database-load/_docs/account-details.md) for transformations, database prerequisites, lifecycle rules, and validation. Currency-rate synchronization belongs exclusively to the forex-database-load module.

Master storage names and the one-time legacy tab rename are documented in [master-sheet-names.md](master-sheet-names.md). The Accounts importer accepts `account_master`, matching `account_master.csv`, its Sheet tab and the database table.

The importer validates the same field constraints as ledger-database-load before writing: recognized boolean spellings (`true/false`, `yes/no`, `1/0`), valid local ISO calendar dates, integer day/month/term bounds, positive loan principals and contract multipliers, nonnegative applicable balances/rates, and ownership percentages in 0–100. Non-money prices, quantities, rates and percentages must fit `NUMERIC(38,18)` exactly. Stock instrument currencies must be three ASCII letters. Invalid rows report `invalid_<field>` and make no row write; optional blank values remain blank. These checks do not invent missing financial data or validate database-only FX reference existence.
