# Transactions

The core ledger. Every money movement is one row.

Schema reference: [data-model.md § Transaction](data-model.md#transaction). Balance arithmetic: [balance-lifecycle.md](balance-lifecycle.md). Hard-block rules: [financial-rules.md](financial-rules.md).

## Capabilities

- Create, edit, soft-delete, restore, and lock transactions across two types: `money-in`, `money-out`
- Transfers (moving money between owned accounts) are two linked rows sharing the same `parent_tx_id` — not a third `tx_type`
- Cascading category dropdowns (type → major → minor)
- Cross-currency transfers: the two linked rows carry amounts in their respective account currencies; the ratio is the effective exchange rate
- Ten independent filter dimensions, combined with AND (date range, type, account, major category, minor category, country, city, area, tag, free-text search)
- Active-filter chips with one-click removal
- Sortable, paginated table; mobile uses card layout
- Date-range scoping (shared with the insight section)
- CSV / JSON export of the **currently filtered rows** (both date-range and active filter dimensions apply)
- CSV bulk import — upload, preview, then submit; duplicates shown as "already exists" badges and counted separately
- Warning banner separating malformed rows from the main table

## Transaction types

| Type | Meaning | Effect on account |
|---|---|---|
| `money-in` | Money enters `account_id` | `account.current_value += tx_amount` |
| `money-out` | Money leaves `account_id` | `account.current_value -= tx_amount` |

There is no `money-transfer` type. **Transfers** (moving money between owned accounts) are represented as two separate rows that share a `parent_tx_id`:

- **money-out row**: `account_id` = source account, `tx_amount` = amount leaving in the source account's currency.
- **money-in row**: `account_id` = target account, `tx_amount` = amount arriving in the target account's currency.

Both rows are created together and linked via `parent_tx_id`. If the two accounts share a currency, both `tx_amount` values are equal. If they differ, the ratio `money-in.tx_amount ÷ money-out.tx_amount` is the effective exchange rate — no explicit FX marker or column is stored.

## Required fields

| Field | Required when |
|---|---|
| `tx_date_time` | Always |
| `tx_type` | Always; must be `money-in` or `money-out` |
| `account_id` | Always; the single account this row affects |
| `tx_amount` | Always; must be > 0 |
| `major_category`, `minor_category` | Always (both types are categorised) |
| `parent_tx_id` | Not accepted in CSV import — the backend auto-generates the parent-child transfer relationship. Present in the data model for linked transfer rows but not user-supplied. |

For a transfer, **two rows are required** — one money-out and one money-in. Both must be submitted together. Only the child (derived) row carries the parent's `id` as its `parent_tx_id`; the parent row's `parent_tx_id` is empty.

The currency of any row is derived at runtime from the linked account (`account_id → account.currency`). It is not user-input and is not stored on the transaction row.

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
2. Frontend filters the account dropdowns to the allowed types and shows hints indicating the expected account type. Account type constraints are not enforced server-side.

Examples from the default seed:
- *Credit card payment*: source account must be `current` or `savings`; target account must be `credit_card`.
- *Loan repayment*: source account must be `current`/`savings`; target account must be one of the 7 loan sub-types.

## Hard-block rules

See [financial-rules.md](financial-rules.md). The rules cover: insufficient asset balance, credit limit exceeded (currently unenforced), no money-out from a loan, and incomplete cross-currency transfer pairs.

## Cascading category dropdowns

1. Type selected → major dropdown enabled, populated with all majors for that type.
2. Major selected → minor dropdown enabled, populated with minors for that type + major.
3. Inactive and locked categories appear greyed-out and disabled in the dropdown (kept visible so historical references remain interpretable). Only `active` categories are valid FK targets in `_buildCategoryMap` — inactive and locked categories are excluded from the map used by FK validation, so they cannot be used in new or updated transactions.
4. Changing the type clears both major and minor.

The cascade applies identically in both the add form and the edit form.

## FX / cross-currency handling

| Path | Behaviour |
|---|---|
| Same-currency standalone | `tx_amount` debits or credits the account; no second row needed |
| Same-currency transfer | Two rows with equal `tx_amount` values; both carry the same `parent_tx_id` |
| Cross-currency transfer | Two rows with different `tx_amount` values (each in their account's currency); effective rate = money-in `tx_amount` ÷ money-out `tx_amount` |
| Display in the table | Base-currency conversion uses the global rate from `rates` for each account's currency; a `†` marker indicates a row-level implied rate differs from the current global rate |

The `tx_amount` values on the two transfer legs are preserved indefinitely. Reversing an edit or delete uses the same stored amounts, so balance arithmetic remains exact even if the global rates table is later edited.

No `[FX: …]` marker is appended to `description` — the effective exchange rate is fully recoverable from the two stored `tx_amount` values.

## Filtering and sorting

### Filter dimensions (AND-combined)

| Filter | Type | Behaviour |
|---|---|---|
| Date range | Preset / custom | Bound `tx_date_time` to the selected period; applied before all other filters |
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

Date range is applied first (shared with the insight section), then the filter set. All filter dimensions are combined with AND.

### Active filters as chips

Active filters are shown as a count badge on the Filters button. Individual filter chips are not yet implemented.

### Sortable columns

Date, Type, Account (by account name), Category (by major). Default sort: `tx_date_time` descending. Click a column header to sort ascending; click again to flip to descending. Clicking a different column resets to ascending.

## Pagination

Client-side, default 50 rows per page (selectable: 10 / 25 / 50). Resets to page 1 whenever any filter, sort, or date range changes.

## Malformed rows

Rows missing `id`, `tx_date_time`, or with an invalid `tx_type` are diverted into a collapsed warning section. They:

- Do NOT participate in insight totals
- Do NOT affect account balances (their balance-effect would already have been applied at creation time)
- ARE visible by clicking the `⚠ N rows have warnings` banner
- ARE only fixable by editing the underlying store directly — the app surfaces them as a diagnostic only

## Export

| Format | Contents |
|---|---|
| CSV | All visible columns of the currently filtered row set; one row per transaction |
| JSON | Array of objects; full field set (including reserved/unused fields) |

The export operates on the **currently filtered rows** — the same set visible in the table. All active filter dimensions (date range, type, account, category, location, tag, search) are reflected in the export. This is "what's currently shown," not "all rows in the period."

## API surface

| Operation | Behaviour |
|---|---|
| `list_transactions` | Return all rows (including soft-deleted) |
| `create_transaction` | Validate (`tx_amount` validated unconditionally, regardless of category flags); duplicate check on `(tx_date_time, tx_type, account_id, tx_amount)` skipping deleted rows → `duplicate_transaction`; assign `id`; stamp `record_status = active`, `created_at`, `updated_at`; append. For transfers, both legs are duplicate-checked BEFORE any row is written — see Transfer atomicity below. |
| `create_transactions_bulk` | Accept `transactions[]`; validate all rows (including unconditional `tx_amount` check), generate IDs, and write them in a single `sheet.setValues()` call — per-row `create_transaction` is NOT called; return `{ ok, created, failed, results }` |
| `update_transaction` | Locked guard → `record_locked`; deleted guard → `transaction_deleted`; validate; duplicate check on `(tx_date_time, tx_type, account_id, tx_amount)` excluding the current row (via `excludeRowNum` parameter on `_checkDuplicate`) → `duplicate_transaction`; validates `major_category` / `minor_category` FK when those fields are present in the update body (returns `unknown_category` if the composite key `(tx_type, major_category, minor_category)` is not found); overwrite editable fields in a single batch write; stamp `updated_at`; advance `sync_status` |
| `delete_transaction` | Already-deleted guard → `transaction_already_deleted`; locked guard → `record_locked`; soft-delete (`record_status → deleted`) in a single `setValues()` write; stamp `updated_at` |
| `restore_transaction` | Check `record_status = deleted`; set `record_status → active` in a single `setValues()` write; stamp `updated_at` |

### Transfer atomicity

For transfers (`create_transaction` where both a source and target account are required by the category), both the parent leg and the child leg are duplicate-checked BEFORE any row is written to the sheet. If either leg would be a duplicate, the entire transfer is rejected and no rows are written. This eliminates the orphan risk that existed previously, where the parent leg could be written before the child validation ran.

### Amount validation

`tx_amount` (and the equivalent `source_amount` / `target_amount` fields on the create path) is validated unconditionally before any category-conditional checks run. A category where both `source_account_mandatory` and `target_account_mandatory` are `false` does NOT bypass amount validation — at least one of `source_amount` or `target_amount` must be a finite positive number for any create call to succeed.

The internal `_writeSingleTransaction` function also guards against a non-finite `tx_amount` immediately before the sheet write, returning `invalid_tx_amount` as a safety net.

### Duplicate check (`_checkDuplicate`)

`_checkDuplicate(sheet, body, excludeRowNum)` scans existing rows for a matching `(tx_date_time, tx_type, account_id, tx_amount)` tuple, skipping deleted rows. The optional `excludeRowNum` parameter (1-based sheet row number) causes that row to be skipped during the scan — used by `updateTransaction` to prevent the current row from matching itself as a duplicate.

### Transaction ID format

Sequential IDs generated by `create_transaction` (single-row path) use the format `YYYY-MM-DD-NNN` where `NNN` is a zero-padded 3-digit decimal sequence number. Bulk IDs generated by `create_transactions_bulk` use the format `YYYY-MM-DD-XXXXXXXX` where the suffix is 8 hex characters from a UUID. The sequential scanner in `generateTransactionId` ignores any ID that does not match the `YYYY-MM-DD-NNN` pattern — hex-suffix bulk IDs are skipped when computing the next sequential number, preventing them from corrupting the sequence counter.

## Error codes

Error code strings carry no embedded values. Where additional context is needed it is returned as a separate property in the response body.

| Code | Triggered by | Meaning | Extra properties |
|---|---|---|---|
| `missing_date` | create, update | `tx_date_time` not provided | — |
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
| `duplicate_transaction` | create, update | Row with same `(tx_date_time, tx_type, account_id, tx_amount)` already exists (non-deleted) | — |
| `missing_row_num` | update, delete, restore | `row_num` not provided | — |
| `invalid_row` | update, delete, restore | `row_num` is out of bounds | — |
| `record_locked` | update, delete | Transaction is locked | — |
| `transaction_deleted` | update | Attempted to update a soft-deleted transaction | — |
| `invalid_amount` | update | `tx_amount` is not a positive finite number | — |
| `missing_account_id` | update | `account_id` not provided | — |
| `field_not_editable` | update | Attempted to change an immutable field | `field: '<field_key>'` |
| `not_deleted` | restore | Transaction is not in `deleted` state | — |
| `missing_transactions` | bulk create | `transactions[]` array missing or empty | — |
| `transaction_already_deleted` | delete | Attempted to soft-delete a transaction that is already in `deleted` state | — |
| `invalid_tx_amount` | create, bulk create | `tx_amount` resolved to a non-finite number before the sheet write (`_writeSingleTransaction` guard) | — |

## CSV import

The import panel accepts a CSV file. Canonical column names (no aliases):

| Column | Required | Notes |
|---|---|---|
| `id` | No | If omitted, assigned on import |
| `tx_date_time` | Yes | ISO-8601 UTC date/time of the transaction |
| `tx_timezone` | No | IANA timezone string |
| `tx_type` | Yes | `money-in` or `money-out` |
| `source_account` | Yes | Account name (not ID). Resolved to account ID at import time. |
| `target_account` | Conditional | Required for transfer rows. Target account name (resolved to account ID at import time). |
| `source_amount` | Yes | Positive number in the source account's currency |
| `target_amount` | Conditional | Required for transfer rows. Amount arriving in the target account's currency. |
| `major_category` | Yes | |
| `minor_category` | Yes | |
| `description` | No | |
| `counterparty_name` | No | |
| `tx_tags` | No | Semicolon-separated |
| `beneficiaries` | No | Semicolon-separated |
| `user_location_area` | No | |
| `user_location_city` | No | |
| `user_location_country` | No | |
| `user_location_latitude` | No | |
| `user_location_longitude` | No | |
| `record_status` | No | System field — accepted in header but silently ignored on import |
| `sync_status` | No | System field — accepted in header but silently ignored on import |
| `sync_date_time` | No | System field — accepted in header but silently ignored on import |
| `sync_notes` | No | System field — accepted in header but silently ignored on import |
| `created_at` | No | System field — accepted in header but silently ignored on import |
| `updated_at` | No | System field — accepted in header but silently ignored on import |

The system fields (`id`, `record_status`, `sync_status`, `sync_date_time`, `sync_notes`, `created_at`, `updated_at`) are accepted in the CSV header row but are silently ignored on import — the backend always assigns its own values for system fields.

`parent_tx_id` is not accepted as a CSV column. The backend auto-generates the parent-child transfer relationship from the `source_account` and `target_account` columns — do not include it in the CSV file.

Preview is shown before submission. Duplicate rows (matched on `tx_date_time` + `tx_type` + `account_id` + `tx_amount`) are shown with an "already exists" badge and counted in `skipped`, not `failed`. Results summary: `N imported · M already existed`.

## Add / edit form layout

Both transaction types share one form template:

- **Standalone money-in or money-out**: Type, Major, Minor, Account (single `account_id` field), Date, Timezone, Counterparty, Amount (`tx_amount`), Location fields, Tags, Beneficiaries, Description.
- **Transfer**: same fields as above for the primary leg, plus a sibling-amount field (the partner leg's `tx_amount`) so the user can enter what arrives in the target account. The UI creates both rows on submit.

The Edit form renders **above** the table, not inline within a table row. Delete confirmation stays inline (one-row confirmation).

On mobile, the table is replaced by stacked cards using the same data. View/Edit cards still render above.
