# Categories

The two-level taxonomy used to classify income and expense transactions. Every `money-in` and `money-out` requires a `(major, minor)` pair.

Schema reference: [data-model.md § Category](data-model.md#category).

## Capabilities

- CRUD on category rows (`type`, `major`, `minor`, `description`, `tag_keywords`, `counterparty_examples`, account-type hints, `is_subscription_eligible`)
- Filter list by type, major, minor, search, account hint flags, subscription eligibility, record status
- Soft-delete (`record_status → deleted`) with restore; lock (`record_status → locked`) prevents any further edits or deletes
- Declare per-category account-type hints used by the transaction form
- CSV bulk import — upload a CSV file in the import panel; preview before committing

## Rules

| Rule | Detail |
|---|---|
| `tx_type_key` | Required; must be `money-in` or `money-out` |
| `major_category_label`, `minor_category_label` | Both required; non-empty strings |
| `description`, `tag_keywords`, `counterparty_examples` | Optional |
| `tag_keywords` storage | Lowercased on save; stored as a comma-and-space-separated string (e.g. `'tag1, tag2, tag3'` via `join(', ')`) |
| Uniqueness | Enforced on the three-part composite key `(tx_type_key, major_category_key, minor_category_key)` — not just major+minor. Duplicate on individual create → `duplicate_category`. Bulk imports match supplied `id` values and insert or replace that row. They do not match by composite key. |
| Soft-delete | `delete_category` sets `record_status → deleted`; the row stays in the sheet. Transactions retain their stored `major`/`minor` strings — no cascade. |
| Restore | Done via `update_category` by passing `record_status: 'active'`. There is no separate `restore_category` action. |
| Lock | `record_status = locked` blocks edits and deletes at the backend. Locked rows appear in the UI with View only — all mutation options are hidden. |

## Account-type hints (optional per-row)

A category row may carry four extra columns used for required-account validation and UI filtering:

| Column | Type | Meaning |
|---|---|---|
| `source_account_mandatory` | boolean | If true, transactions of this category MUST specify a source account |
| `source_account_types` | string | Comma-and-space-separated allowed source account types (e.g. `current, savings`) |
| `target_account_mandatory` | boolean | If true, transactions of this category MUST specify a target account |
| `target_account_types` | string | Comma-and-space-separated allowed target account types |

When a category with these hints is used on a transaction:

1. The transaction layer rejects submissions where a mandatory account is missing.
2. Account subtype hints are not enforced server-side.
3. The transaction form pre-filters the account dropdowns to the allowed types so the user cannot easily pick a forbidden combination.

Example from the default seed:
- `money-out / Debt & finance / Loan repayment`: target mandatory; target type ∈ {7 loan types}

Categories without hints have no account-type constraints.

## Seeding

No automatic seeding exists. Categories must be populated via the bulk CSV import panel or the Add Category form.

## API surface

| Operation | Behaviour |
|---|---|
| `list_categories` | Return all rows |
| `create_category` | Validate required fields; duplicate check → `duplicate_category`; append; stamps `created_at`, `updated_at`, `sync_status = create-pending`, and a UUID `id`. If `body.id` is provided (e.g. from a seeded CSV import), that value is used; otherwise a UUID is generated. `record_status` is always written as `active` on create — passing any other value (including `'inactive'`) returns `invalid_record_status`. The add form therefore only offers `active` as a choice. Returns `{ ok: true, id: '<uuid>' }`. |
| `create_categories_bulk` | Accept `categories[]`; insert or replace by `id`, generating a UUID when absent; preserve `created_at` on replacement and advance sync status; return `{ ok, created, updated, failed, results }` |
| `update_category` | Validate required fields (including optional `record_status` if present); locked guard; FK check if composite key is changing (see below); overwrite the row; stamps `updated_at`. `record_status` is written only if present in the request body — if absent, the existing status is preserved. To restore a deleted category, pass `record_status: 'active'` via this action. Optional parameter: `force` (boolean). |
| `delete_category` | Locked guard; soft-delete (`record_status → deleted`); stamps `updated_at` |

### `update_category` — FK check on key-changing edits

When `tx_type_key`, `major_category_label`, or `minor_category_label` changes such that the composite key `(tx_type_key, major_category_key, minor_category_key)` changes, the backend scans the transactions sheet and subscriptions sheet for rows that reference the old key (matching on `tx_type`, `major_category`, `minor_category`).

- If any dependent rows exist and `body.force !== true`, the update is rejected: `{ ok: false, error: 'category_key_change_has_dependents', count: N }` where `N` is the total number of matching rows across both sheets.
- If `body.force: true` is passed, or no dependent rows are found, the rename proceeds normally. The caller accepts responsibility for updating dependent rows — the backend does not cascade the rename.
- If the composite key is not changing (only non-key fields are edited), no scan is performed.

### `update_category` — `record_status` validation

If `record_status` is present in the request body, it is validated against the allowed set `['active', 'inactive', 'deleted', 'locked']`. An unrecognised value returns `{ ok: false, error: 'invalid_record_status' }`. If `record_status` is absent from the body, validation passes and the existing status is preserved.

**Asymmetry with `create_category`:** `create_category` only accepts `'active'` — any other value returns `invalid_record_status`. `update_category` accepts the full set.

## Error codes

| Error code | Returned by | Condition |
|---|---|---|
| `invalid_transaction_type` | `create_category`, `update_category` | `tx_type_key` is not `money-in` or `money-out` |
| `missing_major_category` | `create_category`, `update_category` | `major_category_label` is absent or empty |
| `missing_minor_category` | `create_category`, `update_category` | `minor_category_label` is absent or empty |
| `invalid_category_label` | `create_category`, `update_category` | `major_category_label` or `minor_category_label` slugifies to an empty string (e.g. a label consisting solely of `&` or `/`) |
| `missing_row_num` | `update_category`, `delete_category` | `row_num` is absent |
| `invalid_row` | `update_category`, `delete_category` | `row_num` is out of sheet bounds or not a finite number |
| `invalid_record_status` | `create_category`, `update_category` | `record_status` is present but not in the allowed set. For `create_category` only `'active'` is accepted; for `update_category` the full set `['active', 'inactive', 'deleted', 'locked']` is accepted. |
| `duplicate_category` | `create_category`, `update_category` | Composite key `(tx_type_key, major_category_key, minor_category_key)` already exists on a different row |
| `record_locked` | `update_category`, `delete_category` | The target row has `record_status = locked` |
| `category_key_change_has_dependents` | `update_category` | Composite key is changing and `count` dependent rows exist across transactions and subscriptions; `force` is not true. Response includes `count: N`. |
| `fk_scan_error` | `update_category` | An unexpected exception occurred while scanning the transactions/subscriptions sheets for dependent rows during a composite-key-changing edit |
| `missing_categories` | `create_categories_bulk` | `body.categories` is absent or empty |

## CSV import

The import panel (accessible via the **Import** button in the section header) accepts a CSV with these columns:

| Column | Required | Notes |
|---|---|---|
| `id` | No | UUID identifying the row to insert or replace. Omit to create a new UUID. |
| `tx_type_key` | Yes | Must be exactly `money-in` or `money-out`. Invalid values are rejected as parse errors before submission — the row is skipped and reported in the preview error list. |
| `major_category_label` | Yes | |
| `minor_category_label` | Yes | |
| `description` | No | |
| `tag_keywords` | No | Comma-and-space-separated; lowercased on save |
| `counterparty_examples` | No | Comma-separated |
| `source_account_types` | No | Comma-separated sub-types |
| `target_account_types` | No | Comma-separated sub-types |
| `source_account_mandatory` | No | `true` / `false` |
| `target_account_mandatory` | No | `true` / `false` |
| `is_subscription_eligible` | No | `true` / `false` |
| `record_status` | No | Bulk validation uses the create contract: only `active` is accepted when supplied; accepted imports write `active`. |

An `id` column is optional in the CSV. When present, the value is used as the UUID for newly created rows, allowing pre-assigned UUIDs from seed files to be preserved (useful for cross-entity FK references in seed data). A matching `id` selects the replacement row. Re-imports without IDs create new rows. Audit columns (`sync_status`, `sync_date`, `sync_notes`, `created_at`, `updated_at`) are stamped by the backend on import and must not be present in the CSV.

Derived columns (`tx_type_label`, `major_category_key`, `minor_category_key`) are computed by the backend from the label fields via `slugify` and `TX_TYPE_LABEL_MAP` — they are never read from the CSV. If present in the file (e.g. exported CSVs that include all sheet columns), they are silently ignored by the parser.

Preview is shown before submission. Results summary: `N imported · M updated · K failed`.

## Column positions

The sheet stores 21 columns in this order:

| # | Field |
|---|---|
| 1 | `id` |
| 2 | `tx_type_key` |
| 3 | `tx_type_label` |
| 4 | `major_category_key` |
| 5 | `major_category_label` |
| 6 | `minor_category_key` |
| 7 | `minor_category_label` |
| 8 | `description` |
| 9 | `tag_keywords` |
| 10 | `counterparty_examples` |
| 11 | `source_account_types` |
| 12 | `target_account_types` |
| 13 | `source_account_mandatory` |
| 14 | `target_account_mandatory` |
| 15 | `is_subscription_eligible` |
| 16 | `record_status` |
| 17 | `sync_status` |
| 18 | `sync_date` |
| 19 | `sync_notes` |
| 20 | `created_at` |
| 21 | `updated_at` |

Column positions are append-only — never change an existing position.

## Identity and row addressing

Each category row carries a UUID `id` in column 1, set once on creation and never changed. Interactive create/update checks the composite key `(tx_type_key, major_category_key, minor_category_key)` for duplicates; bulk replacement uses `id`. All update and delete operations locate the target row by `row_num` (the row's position in the sheet), which the frontend receives from `list_categories` and must pass back on mutations. `list_categories` returns `id` in each row object alongside `_row`.

## Form behaviour

- Filter bar: Type / Major / Minor / Search / Source account mandatory / Target account mandatory / Subscription eligible / Record status — all custom dropdowns; deferred model ([Search] applies pending selections).
- Add form has fields for: type, major, minor, description, tag keywords, counterparty examples, account-type hints, subscription eligible, record status. The `record_status` dropdown in the add form offers only `active` — the backend always creates rows as `active` and rejects any other value on `create_category`.
- Edit form has the same fields as the add form, with `record_status` offering all four options: `active`, `inactive`, `locked`, `deleted`.
- Locked categories: View only — Edit and Delete suppressed in the context menu.
- Deleted categories: View + Restore — Edit and Delete suppressed; restore uses `update_category` to set `record_status: active`.
