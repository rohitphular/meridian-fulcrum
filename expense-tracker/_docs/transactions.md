# Transactions

The core ledger. Every money movement is one row in the `transaction_master` Sheet tab. Ledger-extract uses the same entity key and database table name. Existing `transactions` tabs use the [master-tab migration](master-sheet-names.md).

Schema reference: [data-model.md § Transaction](data-model.md#transaction). Balance arithmetic: [balance-lifecycle.md](balance-lifecycle.md). Hard-block rules: [financial-rules.md](financial-rules.md).

## Capabilities

- Create, edit, soft-delete, restore, and lock transactions across two types: `money-in`, `money-out`
- Transfers (moving money between owned accounts) are two linked rows whose child carries the parent's ID in `parent_tx_id` — not a third `tx_type`
- Cascading category dropdowns (type → major → minor)
- Cross-currency transfers: the two linked rows carry amounts in their respective account currencies; the ratio is the effective exchange rate
- Ten independent filter dimensions, combined with AND (date range, type, account, major category, minor category, country, city, area, tag, free-text search)
- Active-filter count on the Filters button
- Sortable, paginated table; mobile uses card layout
- Date-range scoping (shared with the insight section)
- CSV / JSON export of the **currently filtered rows** (both date-range and active filter dimensions apply)
- CSV bulk import — choose a file and import; the backend parses and validates it, then reports created/updated/failed counts and line-numbered failures. ID-based insert or replacement
- Warning banner separating malformed rows from the main table

## Transaction types

| Type | Meaning | Effect on account |
|---|---|---|
| `money-in` | Money enters `account_id` | `account.current_value_local += tx_amount_local` |
| `money-out` | Money leaves `account_id` | `account.current_value_local -= tx_amount_local` |

There is no `money-transfer` type. **Transfers** (moving money between owned accounts) are represented as two separate rows linked by the child's `parent_tx_id`:

- **money-out row**: `account_id` = source account, `tx_amount_local` = amount leaving in the source account's currency.
- **money-in row**: `account_id` = target account, `tx_amount_local` = amount arriving in the target account's currency.

Both rows are created together and linked via the child's `parent_tx_id`. Either direction may be the initiating parent. For same-currency transfers, a missing target amount uses the source amount; an explicit target amount is retained. If they differ, the ratio `money-in.tx_amount_local ÷ money-out.tx_amount_local` is the effective exchange rate — no explicit FX marker or column is stored.

## Required fields

| Field | Required when |
|---|---|
| `tx_date_local` | Always |
| `tx_type` | Always; must be `money-in` or `money-out` |
| `account_id` | Always; the single account this row affects |
| `tx_amount_local` | Always; must be > 0 |
| `major_category`, `minor_category` | Always (both types are categorised) |
| `parent_tx_id` | Not accepted in CSV import — the backend auto-generates the parent-child transfer relationship. Present in the data model for linked transfer rows but not user-supplied. |

For a transfer, **two Sheet rows are stored** — one money-out and one money-in. The UI or CSV submits one request row containing both accounts and amounts; the backend creates both legs together. Only the child carries the parent's `id` as its `parent_tx_id`; the parent link is empty. Either direction may be the parent, depending on the initiating type.

The currency of any row is derived at runtime from the linked account (`account_id → account.account_currency_local`). It is not user-input and is not stored on the transaction row.

## Category-driven account-type hints

A category row may declare:

```
source_account_mandatory   : boolean
source_account_types       : comma-separated allowed types
target_account_mandatory   : boolean
target_account_types       : comma-separated allowed types
```

When a category with these hints is selected:

1. Backend validates that the transfer legs are present (if `mandatory`).
2. `get_transaction_form_options` returns, per category, the eligible accounts for each leg (the server applies the account-type hints); the form only looks them up. Account type constraints are not enforced on write.

The category's stored hints determine eligible account choices. Hint values use the catalog's hyphenated subtype keys; `investment` is the shorthand for available investment rows. The `account_types` Sheet is authoritative; there is no default catalog seed in application code.

## Hard-block rules

See [financial-rules.md](financial-rules.md). Every rule, including the insufficient-balance check, is enforced by the backend on `create_transaction` / `update_transaction`. The add and edit forms do no validation of their own. They send what was entered and show the server's `message`, highlighting the input named by `field`. CSV import does not run the balance rule. Credit limits are not enforced.

## Cascading category dropdowns

1. Type selected → major dropdown enabled, populated with all majors for that type.
2. Major selected → minor dropdown enabled, populated with minors for that type + major.
3. Inactive and locked categories appear greyed-out and disabled in the dropdown (kept visible so historical references remain interpretable). Only `active` categories are valid FK targets in `_buildCategoryMap` — inactive and locked categories are excluded from the map used by FK validation, so they cannot be used in new or updated transactions.
4. Changing the type clears both major and minor.

The cascade applies identically in both the add form and the edit form.

## FX / cross-currency handling

| Path | Behaviour |
|---|---|
| Same-currency standalone | `tx_amount_local` debits or credits the account; no second row needed |
| Same-currency transfer | Two rows; a missing target amount uses the source amount. The child carries the parent ID; the parent link is blank |
| Cross-currency transfer | Two rows with different `tx_amount_local` values (each in their account's currency); effective rate = money-in `tx_amount_local` ÷ money-out `tx_amount_local` |
| Display in the table | Base-currency conversion uses the global rate from `rates` for each account's currency; a `†` marker indicates a row-level implied rate differs from the current global rate |

The `tx_amount_local` values on the two transfer legs are preserved indefinitely. Reversing an edit or delete uses the same stored amounts, so balance arithmetic remains exact even if the global rates table is later edited.

No `[FX: …]` marker is appended to `description` — the effective exchange rate is fully recoverable from the two stored `tx_amount_local` values.

## Filtering and sorting

### Filter dimensions (AND-combined)

| Filter | Type | Behaviour |
|---|---|---|
| Date range | Preset / custom | Bound `tx_date_local` to the selected period; applied before all other filters |
| Type | Multi-select (checkboxes) | Match any selected `tx_type` |
| Account type | Multi-select (checkboxes) | Pre-filter the account dropdown by account `type` (asset, investment, liability) |
| Account | Multi-select (checkboxes) | Match `account_id` |
| Major category | Multi-select (checkboxes) | Match `major_category` |
| Minor category | Multi-select (checkboxes) | Match `minor_category`; restricted to minors of selected major when a major filter is active |
| Country | Substring | Case-insensitive contains on `user_location_country` |
| City | Substring | Case-insensitive contains on `user_location_city` |
| Area | Substring | Case-insensitive contains on `user_location_area` |
| Tag | Substring | Case-insensitive contains on any element of the `;`-split `tx_tags` |
| Search | Substring | Case-insensitive contains across `counterparty_name`, `description`, and the linked account name |

Filtering runs on the server (`list_transactions_view`): the date range (recorded wall date, inclusive of today, see [calculations](calculations.md#periods-and-dates)) and every filter dimension are combined with AND. The filter bar's options come from `get_transaction_facets`, loaded once per data refresh; the draft is sent when you press Apply.

### Active filters as chips

Active filters are shown as a count badge on the Filters button. Individual filter chips are not yet implemented.

### Sortable columns

Date, Type, Account (by account name), Amount, Category (by major). Default sort: `tx_date_local` descending. Clicking a header sends `sort_col` / `sort_dir`; the server sorts the full filtered set.

## Pagination

Server-side (`page`, `page_size`), default 50 rows per page (selectable: 10 / 25 / 50). The view resets to page 1 whenever any filter, sort, or date range changes; the server clamps an out-of-range page.

## Malformed rows

Rows missing `id`, `tx_date_local`, or with an invalid `tx_type` are diverted into a collapsed warning section. They:

- Do NOT participate in list totals or insights (they come back in `warn_rows`)
- Balance aggregation independently excludes deleted rows, invalid dates, nonpositive/nonfinite amounts, unknown accounts and pre-tracking movements. A missing transaction ID alone is a UI warning and does not remove an otherwise valid movement from the balance.
- ARE visible by clicking the `⚠ N rows have warnings` banner
- ARE only fixable by editing the underlying store directly — the app surfaces them as a diagnostic only

## Export

| Format | Contents |
|---|---|
| CSV | `transaction_master` import columns, including UUID, exact decimal amounts and lifecycle status |
| JSON | The same reconstructed import rows with additional source fields |

The export (`export_transactions`, built on the server with the list filters) begins with the currently filtered transactions. A transfer is reconstructed once as a source/target pair, including its sibling from the full sheet when a filter shows only one leg. Standalone money-in amounts are exported on the target account. Transfer amount text is preserved separately for each currency.

This compact import contract has one set of shared metadata and one `record_status` for both legs. When the legs have different statuses or independently edited shared fields, or the transfer has historical deleted children, the app blocks export with an explanation. Export `transaction_master` directly from Google Sheets when the original separate rows and their history must be preserved; the compact app format is not a complete ledger backup.

Transaction CSV import is parsed and validated on the backend (`api/transaction-import.gs`); the browser only sends the file text. It accepts quoted multiline fields, rejects blank/duplicate headers and malformed rows, and preserves decimal text. If any row fails a format or account-resolution check, the whole file is rejected with `Row <line>: …` messages and nothing is written. Otherwise the file is written in one bulk call and the panel lists any failed rows with their CSV line and reason; fix those lines and import the file again (rows with ids are replaced, not duplicated). An interrupted request or incomplete result asks you to refresh/check what was saved; the client never automatically repeats a mutation. Import does not geocode locations; location enrichment in the add/edit form stops waiting after five seconds per lookup.

## API surface

| Operation | Behaviour |
|---|---|
| `list_transactions_view` | GET filtered / sorted / paged rows shaped for the table and `warn_rows` (no totals); every page, sort or filter request shows the loading overlay while it is pending; see [api/README.md](../api/README.md#view-gets) for params |
| `get_transaction_facets` | GET filter-bar options (types, account types, accounts, majors / minors, location and tag suggestions, ranges, sort columns, page sizes) |
| `get_transaction` / `get_transaction_form_options` / `get_transaction_prefill` | GET the view panel record with its counter leg; add / edit option trees; copy and mark-as-subscription prefill |
| `export_transactions` | GET compact import rows for the list filters (lossy transfers refused with `transfer_export_lossy`) |
| `list_transactions` | Raw rows including soft-deleted (kept for `scripts/factory-reset.sh`); the app does not call it |
| `create_transaction` | Validate (`tx_amount_local` validated unconditionally, regardless of category flags); interactive insufficient-balance rule (`insufficient_balance`, see [financial-rules.md](financial-rules.md#insufficient-balance)); duplicate check on `(tx_date_local, tx_type, account_id, tx_amount_local)` skipping deleted rows → `duplicate_transaction`; assign `id`; stamp `record_status = active`, `created_at`, `updated_at`; append. For transfers, both legs are duplicate-checked BEFORE any row is written — see Transfer atomicity below. |
| `create_transactions_bulk` | Accept `{ csv, dry_run? }` (`importTransactionsCsv`): parse and validate the file, resolve account names, then pass every row to `createTransactionsBulk` in one call, which inserts or replaces by supplied ID, preserves child identities and deletion tombstones, and rewrites the resulting data region. Returns `{ ok, created, updated, failed, results, rows, without_id }` with each `results[i].line` set to its CSV line, or `{ ok: false, error, errors[] }` when the file is invalid. `dry_run: true` runs only the format checks (no Sheet reads or writes) and returns `{ ok: true, dry_run: true, rows, without_id }` |
| `update_transaction` | Locked guard → `record_locked`; deleted guard → `transaction_deleted`; validate; duplicate check on `(tx_date_local, tx_type, account_id, tx_amount_local)` excluding the current row (via `excludeRowNum` parameter on `_checkDuplicate`) → `duplicate_transaction`; requires and validates the `major_category` / `minor_category` FK in the update body (returns `unknown_category` if the composite key `(tx_type, major_category, minor_category)` is not found); insufficient-balance rule on a money-out, after reversing the row's old movement on the same account; overwrite editable fields in a single batch write; stamp `updated_at`; advance `sync_status` |
| `delete_transaction` | Already-deleted guard → `transaction_already_deleted`; locked guard → `record_locked`; soft-delete (`record_status → deleted`) in a single `setValues()` write; stamp `updated_at` |
| `restore_transaction` | Check `record_status = deleted`; set `record_status → active` in a single `setValues()` write; stamp `updated_at` |

Every row-number update/delete/restore accepts `expected_id` and `expected_updated_at`, which the UI supplies from its snapshot. A different UUID now occupying that row or a newer edit to the same record returns `stale_record` with no mutation. This also covers rows moved by bulk import; reload before retrying.

### Source validation

Create, bulk import and update validate calendar dates, `YYYY-MM-DD HH:MM:SS` / `T` local timestamp syntax (up to six fractional digits), IANA timezone meaning and DST ambiguity before writing. A blank transaction zone keeps the legacy `Europe/London` default; supplied zones are stored canonically. Updates use the existing immutable timezone. Coordinates must be finite decimals, supplied as a pair, with latitude in −90…90 and longitude in −180…180. Native Sheet date cells are returned as their displayed wall time.

Amounts must use decimal syntax; booleans, arrays, numeric prefixes and non-finite values are rejected. Decimal text is preserved through all writers so extraction can apply the currency minor-unit rounding rule. Duplicate checks compare normalized decimal text exactly rather than rounding through JavaScript `Number`.

Beneficiaries are validated before create/import/update writes. Supply semicolon-separated names, or use `name:percentage` for every entry. Empty/duplicate names, mixed formats, invalid percentages and allocations whose four-decimal HALF_UP-rounded shares do not total exactly 100 are rejected. Each raw explicit percentage must be greater than zero and at most 100; a share that rounds to zero is rejected. Equal-name splits retain the extractor's residual allocation to the final beneficiary.

### Transfer atomicity

Transfers require distinct accounts and an active category with the same major/minor keys in the opposite direction. A missing reverse category returns `missing_reverse_transfer_category` before either the interactive or bulk path writes a transaction; no classification is invented for the child.

For interactive transfers, both the parent leg and the child leg are duplicate-checked BEFORE any row is written to the sheet. If either leg would be a duplicate, the entire transfer is rejected and no rows are written. Both built rows are written together in one `setValues` call. POST dispatch serializes mutations with a script lock; this is not a cross-request or cross-sheet database transaction.

Interactive update/delete/restore changes one selected leg and validates the resulting relationship before writing. A live child cannot reference a deleted root; same-account/direction pairs, nested roots and multiple live children are rejected. Delete the child before the parent; restore the parent before the child. `transfer_parent_deleted` or `invalid_transfer_pair` leaves both rows untouched. The API never silently deletes or restores another leg. See [the extraction contract](../../data-synchronization/ledger-extract/_docs/transaction-master.md#time-and-transfer-semantics).

### Bulk replacement and sync

A supplied CSV ID selects the standalone or parent row to replace. Existing child IDs and creation timestamps are retained. If a transfer becomes standalone, the displaced child remains as a `deleted` sync tombstone instead of disappearing from the sheet. Repeating a transaction ID within one batch returns `duplicate_id_in_batch`; addressing an existing child ID directly returns `transfer_child_id_requires_parent`.

UUID matching is case-insensitive. Newly supplied UUIDs are stored in lowercase; existing stored UUID spelling and parent links are preserved on a matching retry. Malformed incoming UUIDs fail their row. Malformed/duplicate existing UUIDs or multiple live children abort the rewrite before any data write. Existing deleted child tombstones do not replace the live child's identity when selecting a pair to update.

An omitted `record_status` retains each existing leg's status; new legs default to `active` or inherit the parent status. An explicit valid status applies to the complete imported pair. Existing locked parent or child rows reject replacement with `record_locked`. Imports cannot silently reactivate deleted/inactive transactions or overwrite `created_at`. Rebuilding a deleted parent with a still-live child returns `invalid_transfer_lifecycle`; explicitly apply the intended lifecycle to the pair before retrying.

API mutations clear old sync date/notes and advance pending status. Direct Sheet business/lifecycle edits now do the same through `onEdit`, including multirow pastes, while preserving business values and `created_at`. Metadata-only edits do not queue a row. The single-cell category cascade remains; pasted blocks keep their supplied category values. An old edit made before deploying this hook still requires hard-sync or an explicit pending status.

### Amount validation

Create and update failures keep their `error` code and add `field` (the request field, e.g. `source_amount_local`, `tx_amount_local`, `major_category`) and a human `message`. Forms render the message verbatim. `create_transactions_bulk` results keep bare codes.


`tx_amount_local` (and the equivalent `source_amount_local` / `target_amount_local` fields on the create path) is validated unconditionally before any category-conditional checks run. A category where both `source_account_mandatory` and `target_account_mandatory` are `false` does NOT bypass amount validation — at least one of `source_amount_local` or `target_amount_local` must be a finite positive number for any create call to succeed.

The internal `_writeSingleTransaction` function also guards against a non-finite `tx_amount_local` immediately before the sheet write, returning `invalid_tx_amount` as a safety net.

### Duplicate check (`_checkDuplicate`)

`_checkDuplicate(sheet, body, excludeRowNum)` scans existing rows for a matching `(tx_date_local, tx_type, account_id, tx_amount_local)` tuple, skipping deleted rows. The optional `excludeRowNum` parameter (1-based sheet row number) causes that row to be skipped during the scan — used by `updateTransaction` to prevent the current row from matching itself as a duplicate.

### Transaction ID format and uniqueness

Both the single-row path (`create_transaction`) and the bulk path (`create_transactions_bulk`) generate IDs using `Utilities.getUuid()` — a full UUID, no date prefix, no counter. The interactive writer uses the `generateTransactionId()` wrapper; bulk import preserves supplied valid UUIDs and generates only missing identities.

Each transaction row's `id` is globally unique by UUID collision-resistant generation. The `id` field is `editable: false` — it is set once on creation and never changed.

## Error codes

Error code strings carry no embedded values. Where additional context is needed it is returned as a separate property in the response body.

| Code | Triggered by | Meaning | Extra properties |
|---|---|---|---|
| `missing_date` | create, update | `tx_date_local` not provided | — |
| `invalid_transaction_type` | create, update | `tx_type` is not `money-in` or `money-out` | — |
| `missing_category` | create, update | `major_category` or `minor_category` is blank | — |
| `unknown_category` | create, update | `(tx_type, major_category, minor_category)` composite key not found in the category schema | — |
| `missing_source_account` | create | Source account required by category but not provided | — |
| `missing_source_amount` | create | Source amount required but missing or non-positive | — |
| `missing_target_account` | create | Target account required by category but not provided | — |
| `missing_target_amount` | create | Target amount required but missing or non-positive | — |
| `unknown_account_id` | create, update | `account_id` is not a known account | — |
| `unknown_source_account` | create | `source_account` is not a known account | — |
| `unknown_target_account` | create | `target_account` is not a known account | — |
| `duplicate_transaction` | create, update | Row with same `(tx_date_local, tx_type, account_id, tx_amount_local)` already exists (non-deleted) | — |
| `missing_row_num` | update, delete, restore | `row_num` not provided | — |
| `invalid_row` | update, delete, restore | `row_num` is out of bounds | — |
| `stale_record` | update, delete, restore | `expected_id` differs from the current row UUID; reload before retrying | — |
| `invalid_tx_date_local`, `invalid_tx_timezone_local` | create, import, update | Local datetime or timezone is invalid | — |
| `ambiguous_local_time`, `nonexistent_local_time` | create, import, update | Timestamp falls in a DST fold/gap | `field` |
| `incomplete_location_coordinates`, `latitude_out_of_range`, `longitude_out_of_range` | create, import, update | Coordinates are incomplete or out of geographic range | — |
| `transfer_parent_deleted`, `invalid_transfer_pair` | update, delete, restore | Proposed edit violates the transfer relationship | — |
| `record_locked` | update, delete, bulk create | Transaction or an existing imported transfer leg is locked | — |
| `transaction_deleted` | update | Attempted to update a soft-deleted transaction | — |
| `invalid_amount` | update | `tx_amount_local` is not a positive finite number | — |
| `missing_account_id` | update | `account_id` not provided | — |
| `field_not_editable` | update | Attempted to change an immutable field | `field: '<field_key>'` |
| `not_deleted` | restore | Transaction is not in `deleted` state | — |
| `missing_transactions` | bulk create | `transactions[]` array missing or empty | — |
| `transaction_already_deleted` | delete | Attempted to soft-delete a transaction that is already in `deleted` state | — |
| `missing_reverse_transfer_category` | create, bulk create | No active category exists for the child direction with the same major/minor keys | — |
| `same_transfer_account` | create, bulk create | Source and target identify the same account | — |
| `invalid_id` | bulk create | Supplied transaction ID is not a hyphenated UUID | — |
| `invalid_record_status` | bulk create | Lifecycle is not one of the transaction schema statuses | — |
| `invalid_transfer_lifecycle` | bulk create | A deleted imported parent would retain a live child, or a child's status is invalid | — |
| `invalid_existing_transaction_id`, `invalid_existing_parent_tx_id` | bulk create | Existing Sheet identity/reference is malformed; rewrite aborted | `row_num` |
| `duplicate_existing_transaction_id`, `multiple_live_transfer_children` | bulk create | Existing identities or transfer relationships are ambiguous; rewrite aborted | `row_num` |
| `duplicate_id_in_batch` | bulk create | The same UUID appears again in this request, including a case variant | — |
| `transfer_child_id_requires_parent` | bulk create | Import addresses an existing child; use the initiating parent's UUID | — |
| `invalid_tx_amount` | create, bulk create | `tx_amount_local` resolved to a non-finite or non-positive number before the sheet write (`_writeSingleTransaction` guard) | — |
| `duplicate_generated_transaction_id` | bulk create | A generated transfer-child UUID collided with an existing or in-batch id; retry the row | — |
| `beneficiary_empty_name`, `duplicate_beneficiary` | create, update, bulk create | A beneficiary entry has no name, or a name repeats | — |
| `beneficiary_inconsistent_percentage_format`, `beneficiary_invalid_percentage`, `beneficiary_percentage_rounds_to_zero`, `beneficiary_percentages_do_not_sum_to_100` | create, update, bulk create | Mixed `name` / `name:percentage` entries, an invalid or zero share, or explicit shares that do not total 100 | — |
| `too_many_beneficiaries` | create, update, bulk create | Too many names to give each a non-zero equal share | — |
| `unknown_account_id` | create, update | The account is missing or deleted; a new or moved row also needs an active account (an edit that keeps a closed account's row is allowed) | — |

## Suggested entries

Suggestions are optional drafts, never automatic payments. Their historical groups keep counterparty, full classification, account and currency together so native amounts from different currencies cannot share a median. Deleted, invalid, future and unavailable-account movements are excluded; a payment today suppresses only its matching group. Monthly recurrence respects its due-day window. Each card has a stable account-specific identity, and suggestion logs omit payee names.

## CSV import

The import panel accepts a CSV file. Canonical column names (no aliases):

| Column | Required | Notes |
|---|---|---|
| `id` | No | UUID. If supplied, identifies the standalone or parent row to insert or replace; otherwise a new UUID is generated. |
| `tx_date_local` | Yes | Date/time of the transaction in local time (e.g. `2026-08-12 14:30:00`). Stored as-is — no UTC conversion. |
| `tx_timezone_local` | No | IANA timezone string (e.g. `Europe/London`). When submitting via the UI form, this is auto-detected from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and sent silently — it is never a user-typed input. CSV import may supply it explicitly. Immutable after creation. |
| `tx_type` | Yes | `money-in` or `money-out` |
| `source_account` | Conditional | Account UUID or name. Required for `money-out` and transfer rows; empty for standalone `money-in` rows. Resolved to account UUID at import time. |
| `target_account` | Conditional | Account UUID or name. Required for `money-in` and transfer rows; empty for standalone `money-out` rows. Resolved to account UUID at import time. |
| `source_amount_local` | Conditional | Positive number in the source account's currency. At least one of `source_amount_local` or `target_amount_local` must be a finite positive number. Both are required for cross-currency transfers. |
| `target_amount_local` | Conditional | Amount arriving in the target account's currency. Required for cross-currency transfers; may be omitted for same-currency transfers (defaults to `source_amount_local`). |
| `major_category` | Yes | |
| `minor_category` | Yes | |
| `description` | No | |
| `counterparty_name` | No | |
| `tx_tags` | No | Semicolon-separated |
| `beneficiaries` | No | Semicolon-separated names, or `name:percentage` for every entry (e.g. `rohit:34;reena:33;aryan:33`); see [Source validation](#source-validation) |
| `user_location_area` | No | |
| `user_location_city` | No | |
| `user_location_country` | No | |
| `user_location_latitude` | No | |
| `user_location_longitude` | No | |
| `record_status` | No | Optional schema lifecycle (`active`, `inactive`, `deleted`, `locked`). Omitted preserves an existing row/leg status; explicit values apply to the complete imported pair. Existing locked legs cannot be overwritten. |
| `sync_status` | No | System field — accepted in header but silently ignored on import |
| `sync_date` | No | System field — accepted in header but silently ignored on import |
| `sync_notes` | No | System field — accepted in header but silently ignored on import |
| `created_at` | No | System field — accepted in header but silently ignored on import |
| `updated_at` | No | System field — accepted in header but silently ignored on import |

Account resolution checks UUID first, then trimmed names without case sensitivity. If several accounts share a name, the importer uses the matching active category's `source_account_types` or `target_account_types` for that side. A hint matches either `type` or `sub_type`, with the same Sheet-driven rules as the account dropdowns. Exactly one active category must match the complete `tx_type` / `major_category` / `minor_category` key, and its hints must leave exactly one account. Missing, blank, conflicting or insufficient hints reject the file (nothing is written) with a line- and field-specific error; an explicit UUID can identify the intended account. Hints never override an explicit UUID or a unique name, and account lifecycle validation remains on the backend. No account names or classifications are hardcoded into this lookup.

Sync/audit fields (`sync_status`, `sync_date`, `sync_notes`, `created_at`, `updated_at`) are accepted in the CSV header row but ignored as input. The backend preserves existing `created_at`, stamps `updated_at`, clears stale acknowledgements and queues sync. `record_status` is a validated optional lifecycle field; leaving it blank cannot reactivate a historical row.

Amount and coordinate fields must contain a complete finite decimal number. Decimal exponent notation is accepted; suffixes such as `12bad`, grouping commas such as `1,234.56`, hexadecimal values, and non-finite values fail their row instead of being partially parsed. Blank optional fields stay blank, and zero coordinates remain valid numeric values.

`parent_tx_id` is not accepted as a CSV column. The backend auto-generates the parent-child transfer relationship from the `source_account` and `target_account` columns — do not include it in the CSV file.

The backend checks, before anything is written:

- required headers: `tx_date_local`, `tx_type`, `major_category`, `minor_category`, and at least one of `source_amount_local` / `target_amount_local`
- required values on every row, including at least one amount; `tx_date_local` syntax (`YYYY-MM-DD HH:MM:SS`, optional fraction) and `tx_type` (`money-in` / `money-out`)
- `id`, when supplied, is a UUID and is not repeated anywhere in the file (case-insensitive; the error names the line of first use)
- amount and coordinate decimal syntax, and `record_status` against the transaction schema
- account names and UUIDs resolve to exactly one non-deleted account (real import only)

A `T` separator in `tx_date_local` is stored as a space. The remaining business rules (categories, account lifecycle, transfer pairing, timezone, beneficiaries, coordinates range) are applied per row by the bulk writer and reported as failed rows.

Bulk imports match by supplied `id`, not by the interactive duplicate tuple. Results distinguish created, updated, and failed rows. Rows without an `id` are always inserted as new transactions; the panel says how many there were after import. Retain IDs (export after importing) when re-importing to avoid creating duplicates.

## Add / edit form layout

Both transaction types share one form template:

- **Standalone money-in or money-out**: Type, Major, Minor, Account (single `account_id` field), Date, Counterparty, Amount (`tx_amount_local`), Location fields, Tags, Beneficiaries, Description.
- **Transfer**: same fields as above for the primary leg, plus a sibling-amount field (the partner leg's `tx_amount_local`) so the user can enter what arrives in the target account. The UI creates both rows on submit.
- `tx_timezone_local` is NOT a form input — it is auto-detected from `Intl.DateTimeFormat().resolvedOptions().timeZone` in the browser and sent silently with the create payload. It is displayed as a read-only field in the view and edit panels. It is immutable after creation (`editable: false` in the schema).
- `tx_date_local` is stored in local time as-is — no UTC conversion is applied. The corresponding `tx_timezone_local` captures the timezone context.

The Edit form renders **above** the table, not inline within a table row. Delete confirmation stays inline (one-row confirmation).

On mobile, the table is replaced by stacked cards using the same data. View/Edit cards still render above.
