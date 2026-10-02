# Categories

The two-level taxonomy used to classify income and expense transactions. Every `money-in` and `money-out` requires a `(major, minor)` pair.

Schema reference: [data-model.md § Category](data-model.md#category).

## Capabilities

- CRUD on category rows (`type`, `major`, `minor`, `description`, `tag_keywords`, `counterparty_examples`, account-type hints, `is_subscription_eligible`)
- Filter list by type, major, minor, search, account hint flags, subscription eligibility, record status
- Soft-delete (`record_status → deleted`) with restore; lock (`record_status → locked`) prevents any further edits or deletes
- Declare per-category account-type hints used by the transaction form
- CSV bulk import — upload a CSV file in the import panel; the server parses, validates and imports it and returns per-line results

## Rules

| Rule | Detail |
|---|---|
| `tx_type_key` | Required; must be `money-in` or `money-out` |
| `major_category_label`, `minor_category_label` | Both required; non-empty strings |
| `description`, `tag_keywords`, `counterparty_examples` | Optional |
| `tag_keywords` storage | Lowercased on save; stored as a comma-and-space-separated string (e.g. `'tag1, tag2, tag3'` via `join(', ')`) |
| Uniqueness | Enforced on the three-part composite key `(tx_type_key, major_category_key, minor_category_key)` — not just major+minor. Duplicate on individual create → `duplicate_category`. Bulk imports match supplied `id` values and insert or replace that row. They do not match by composite key, but the key remains unique across UUIDs, including deleted history and the current batch. |
| Soft-delete | `delete_category` sets `record_status → deleted`; the row stays in the sheet. Transactions retain their stored `major`/`minor` strings — no cascade. |
| Restore | Done via `update_category` by passing `record_status: 'active'`. There is no separate `restore_category` action. |
| Lock | `record_status = locked` blocks edits and deletes at the backend. Locked rows appear in the UI with View only — all mutation options are hidden. |

## Account-type hints (optional per-row)

A category row may carry four extra columns used for required-account validation and UI filtering:

| Column | Type | Meaning |
|---|---|---|
| `source_account_mandatory` | boolean | If true, transactions of this category MUST specify a source account |
| `source_account_types` | string | Comma-and-space-separated allowed source subtype keys from the `account_types` Sheet; key values use hyphens |
| `target_account_mandatory` | boolean | If true, transactions of this category MUST specify a target account |
| `target_account_types` | string | Comma-and-space-separated allowed target subtype keys from the same Sheet catalog |

When a category with these hints is used on a transaction:

1. The transaction layer rejects submissions where a mandatory account is missing.
2. Account subtype hints are not enforced server-side.
3. The transaction form pre-filters the account dropdowns to the allowed types so the user cannot easily pick a forbidden combination.

Example from `local/files/category_master.csv`:
- `money-out / Debt repayment / Loan repayment`: target mandatory; target type ∈ {`auto-loan`, `heloc`, `personal-loan`, `debt-consolidation`}

Categories without hints have no account-type constraints.

## Seeding

No automatic seeding exists. Categories must be populated via the bulk CSV import panel or the Add Category form.

## API surface

| Operation | Behaviour |
|---|---|
| `list_categories_view` | GET view model for the Categories tab: server filter (type, major, minor, search, statuses), sort, paging, display labels, `allowed_actions`, `transactions_filter` and facets. Export downloads it with `page_size=all`. |
| `get_category_form_options` | GET tx types and account-type hint groups for the add / edit forms. |
| `list_categories` | Raw rows (kept for the ledger-sheet-load job's sheet-rebuild mode); the app does not call it |
| `create_category` | Validate required fields; duplicate check → `duplicate_category`; append; stamps `created_at`, `updated_at`, `sync_status = create-pending`, and a UUID `id`. If `body.id` is provided (e.g. from a seeded CSV import), that value is used; otherwise a UUID is generated. `record_status` is always written as `active` on create — passing any other value (including `'inactive'`) returns `invalid_record_status`. The add form therefore only offers `active` as a choice. Returns `{ ok: true, id: '<uuid>' }`. |
| `create_categories_bulk` | Accept `{ csv, dry_run? }` — the raw `category_master.csv` text — via `importCategoriesCsv` (`api/category-import.gs`). Parse and format-validate the whole file (see [CSV import](#csv-import)); any format error returns `{ ok: false, error: 'invalid_csv_rows', errors: ['Row N: …'] }` and writes nothing. `dry_run: true` stops after format validation, reads no Sheet, and returns `{ ok: true, dry_run: true, rows }`. Otherwise the shaped rows go to the internal `createCategoriesBulk({ categories })`, which validates and matches UUIDs case-insensitively, generates a UUID when absent, preserves lifecycle and existing `created_at`, queues sync status, and accepts only an identical retry for locked rows. Returns `{ ok, created, updated, skipped, failed, results, rows }`; each result also carries its CSV `line` and `label` (`major → minor`). |
| `update_category` | Validate required fields (including optional `record_status` if present); locked guard; FK check if composite key is changing (see below); overwrite the row; stamps `updated_at`. `record_status` is written only if present in the request body — if absent, the existing status is preserved. To restore a deleted category, pass `record_status: 'active'` via this action. Referenced key changes cannot be forced; update dependencies through an explicit migration. |
| `delete_category` | Locked guard; soft-delete (`record_status → deleted`); stamps `updated_at` |

### `update_category` — FK check on key-changing edits

When `tx_type_key`, `major_category_label`, or `minor_category_label` changes such that the composite key `(tx_type_key, major_category_key, minor_category_key)` changes, the backend scans the `transaction_master` sheet and `subscription_master` sheet for rows that reference the old key (matching on `tx_type`, `major_category`, `minor_category`).

- If any dependent rows exist, the update is rejected: `{ ok: false, error: 'category_key_change_has_dependents', count: N }` where `N` is the total number of matching rows across both sheets.
- The rename proceeds only when no dependent rows exist. A supplied `force` value does not bypass this check; the backend does not cascade the rename.
- If the composite key is not changing (only non-key fields are edited), no scan is performed.

### `update_category` — `record_status` validation

If `record_status` is present in the request body, it is validated against the allowed set `['active', 'inactive', 'deleted', 'locked']`. An unrecognised value returns `{ ok: false, error: 'invalid_record_status' }`. If `record_status` is absent from the body, validation passes and the existing status is preserved.

**Asymmetry with `create_category`:** `create_category` only accepts `'active'` — any other value returns `invalid_record_status`. `update_category` accepts the full set.

### `create_categories_bulk` — prerequisites, retries, and diagnostics

The backend reads and validates `account_types` once before a hinted import. A missing or empty catalog returns `account_types_missing`; a legacy 12-column catalog or underscore classification keys returns `account_types_migration_required`. Neither condition creates or changes `category_master`. Deploy the current backend and import the complete 13-column `account_types.csv` through **Configure → Account Types** before retrying categories. See [Account Types migration](account-types.md). Invalid catalog headers, policies, or identities return `invalid_account_types`.

Hints must resolve to active or locked catalog subtypes, or the existing broad `investment` hint. A legacy CSV token such as `credit_card` becomes `credit-card` only when that canonical value exists in the eligible Sheet catalog. Unknown or unavailable tokens are rejected, never silently removed. Both individual investment subtypes and the broad investment hint retain their meaning.

The complete batch is validated before writes begin. Valid rows can import while invalid rows are reported. Every row result contains zero-based `index`, UUID `key`, and `ok`; an integer `csv_row_num` supplied by the caller is echoed. The CSV endpoint also adds the physical CSV `line` and the category `label`. Successful results have `action: created`, `updated`, or `unchanged`. Failures contain an error code, `field`, `reason`, and `invalid_values` where applicable. For example:

```json
{"index":4,"csv_row_num":9,"line":9,"label":"Portfolio → Fund return","key":"<uuid>","ok":false,"error":"invalid_target_account_types","field":"target_account_types","invalid_values":["unknown-subtype"],"reason":"invalid_target_account_types"}
```

Imports preserve valid `record_status` values (`active`, `inactive`, `deleted`, `locked`); blank or omitted status retains an existing row's status and defaults a new row to active. Imported audit and sync values are ignored: creation uses server timestamps, replacement preserves `created_at`, and every write queues sync and clears the previous sync date/notes; identical re-imports are not rewritten (see [unchanged re-imports](data-model.md#unchanged-re-imports)). An identical locked retry is counted in `skipped` and makes no write; any modification of a locked row is rejected. Duplicate UUIDs within the same upload are rejected for every duplicate occurrence. Replacements recheck the physical row's UUID immediately before writing. Duplicate composite keys across UUIDs are rejected before their rows are written; an already-ambiguous Sheet fails the whole import preflight.

Changing an existing category's derived composite key is rejected when transactions or subscriptions reference it. Neither the interactive endpoint nor bulk import permits a `force` override. Each write failure is reported as `category_write_failed`; successfully imported rows remain saved. Retry the same UUID-bearing file to complete remaining rows without creating duplicate identities.

## Error codes

`create_category` / `update_category` validation failures also carry `field` (`tx_type_key`, `major_category_label`, `minor_category_label`, `record_status`, or the hint field) and a human `message`. The add and edit forms show the message and highlight that input; they do no validation of their own. `duplicate_category` and `record_locked` come from the core without a message; the form falls back to its own text.

| Error code | Returned by | Condition |
|---|---|---|
| `invalid_transaction_type` | `create_category`, `update_category` | `tx_type_key` is not `money-in` or `money-out` |
| `missing_major_category` | `create_category`, `update_category` | `major_category_label` is absent or empty |
| `missing_minor_category` | `create_category`, `update_category` | `minor_category_label` is absent or empty |
| `invalid_category_label` | `create_category`, `update_category` | `major_category_label` or `minor_category_label` slugifies to an empty string (e.g. a label consisting solely of `&` or `/`) |
| `missing_row_num` | `update_category`, `delete_category` | `row_num` is absent |
| `invalid_row` | `update_category`, `delete_category` | `row_num` is out of sheet bounds or not a finite number |
| `invalid_record_status` | `create_category`, `update_category` | `record_status` is present but not in the allowed set. For `create_category` only `'active'` is accepted; for `update_category` the full set `['active', 'inactive', 'deleted', 'locked']` is accepted. |
| `duplicate_category` | create, update, bulk import | Composite key `(tx_type_key, major_category_key, minor_category_key)` already exists on a different row |
| `record_locked` | `update_category`, `delete_category` | The target row has `record_status = locked` |
| `category_key_change_has_dependents` | `update_category` | Composite key is changing and `count` dependent rows exist across transactions and subscriptions. Response includes `count: N`. |
| `fk_scan_error` | `update_category` | An unexpected exception occurred while scanning the `transaction_master`/`subscription_master` sheets for dependent rows during a composite-key-changing edit |
| `missing_categories` | `create_categories_bulk` | `body.categories` is absent or empty |
| `account_types_missing` | Category validation / bulk import | Hints were supplied but the Account Types catalog is absent or empty; import it through Configure first |
| `account_types_migration_required` | Category validation / bulk import | Account Types still has 12 columns or legacy underscore keys; deploy and import the complete current catalog |
| `invalid_account_types` | Category validation / bulk import | Catalog header, identity, or policy validation failed |
| `invalid_source_account_types`, `invalid_target_account_types` | Category validation / bulk import | `field` and `invalid_values` identify unrecognised or unavailable hints |
| `invalid_id`, `duplicate_id_in_import` | create/import as applicable | Supplied UUID is malformed, or appears more than once in the batch |
| `invalid_boolean` | Bulk import | Named boolean field contains a value other than true, false, or blank |
| `invalid_existing_category_id`, `duplicate_existing_category_key` | Bulk import | Existing category UUIDs or composite keys are malformed/duplicated; response identifies the Sheet row |
| `category_id_exists` | create | Supplied UUID already exists; use an ID-based replacement import |
| `stale_row`, `category_write_failed` | Bulk import | Row identity changed after validation, or the Sheet write failed; retry after resolving the reported cause |
| `missing_csv`, `invalid_csv`, `csv_has_no_rows`, `invalid_csv_headers`, `invalid_csv_rows` | CSV import | The uploaded file is empty, malformed, has bad headers, or has invalid rows; `errors[]` lists `Row N: …` messages and nothing is written |

## CSV import

The import panel (accessible via the **Import** button in the section header) accepts a CSV with these columns:

| Column | Required | Notes |
|---|---|---|
| `id` | No | UUID identifying the row to insert or replace. Omit to create a new UUID. |
| `tx_type_key` | Yes | Must match a transaction type from the category schema. Invalid values reject the file before any write. |
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
| `record_status` | No | Any status allowed by the category schema. Blank or omitted retains an existing row's status and defaults new rows to active. |

An `id` column is optional in the CSV. When present, the value is used as the UUID for newly created rows, allowing pre-assigned UUIDs from seed files to be preserved (useful for cross-entity FK references in seed data). A matching `id` selects the replacement row. Re-imports without IDs cannot replace existing rows; an existing composite key returns `duplicate_category`. Keep IDs in repeat imports. Audit columns (`sync_status`, `sync_date`, `sync_notes`, `created_at`, `updated_at`) are accepted in exported CSVs but ignored on import; the backend manages these values and preserves an existing row's `created_at`.

Derived columns (`tx_type_label`, `major_category_key`, `minor_category_key`) are computed by the backend from the label fields via `slugify` and `TX_TYPE_LABEL_MAP` — they are never read from the CSV. If present in the file (e.g. exported CSVs that include all sheet columns), they are silently ignored by the server.

The browser only reads the file and sends its raw text; parsing and validation run on the server (`importCategoriesCsv`, using the shared `parseCsvImport` in `api/csv-import.gs`). Quoted commas, escaped quotes, multiline fields and a UTF-8 BOM are supported, and errors identify physical CSV line numbers. Header names are trimmed, lowercased, and spaces become underscores. The whole file is rejected, with nothing written, when:

- the file is empty or has no data rows (`missing_csv`, `csv_has_no_rows`), or quoting is malformed (`invalid_csv`);
- a header is blank or duplicated, or `tx_type_key`, `major_category_label` or `minor_category_label` is missing (`invalid_csv_headers`);
- any row has the wrong column count, a blank required field, an unknown `tx_type_key` or `record_status`, a malformed `id`, a boolean other than `true`/`false` (case-insensitive) or blank, or an `id` that repeats an earlier row case-insensitively (`invalid_csv_rows`, one `Row N: …` message per bad row).

Only `id` (lowercased), the three required fields, `description`, `record_status`, `tag_keywords`, `counterparty_examples`, `source_account_types` and `target_account_types` are forwarded, plus the three booleans as real booleans. Blank `record_status` and blank booleans are omitted so server defaults apply.

Account-type hints are checked against the `account_types` Sheet only in a real run. A hinted import returns `account_types_missing` or `account_types_migration_required` before any write when the catalog is absent or not upgraded. In that case, import the complete updated `local/files/account_types.csv` through **Configure → Account Types**, then import `local/files/category_master.csv`. Matching UUIDs update the rows already imported and preserve identity.

After submission, the panel stays open with created, updated, unchanged and failed counts. Every rejected row appears with its CSV line, category, field, explanation and backend error code. A rejected file shows the server's `Row N: …` messages as a list. There is no preview and no failed-rows-only retry. Fix the file and import it again; UUID-bearing rows that were already saved update in place. Successful mutations dispatch `et:reload`, and the report survives that refresh. A connection failure, a malformed response or a `request_failed` answer (the server handler threw part-way) leaves the outcome uncertain: the app reloads, and the message says some rows may have been saved. Choosing another file or closing the panel clears the previous report.

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

Direct Sheet edits to category business/lifecycle fields queue pending sync, clear old sync date/notes and advance `updated_at`; metadata-only edits do not requeue. The trigger preserves business cells and does not infer new slugs from edited labels.

Each category row carries a UUID `id` in column 1, set once on creation and never changed. Interactive create/update checks the composite key `(tx_type_key, major_category_key, minor_category_key)` for duplicates; bulk replacement uses `id`. All update and delete operations locate the target row by `row_num` (the row's position in the sheet), which the frontend receives from `list_categories` and must pass back on mutations. `list_categories` returns `id` in each row object alongside `_row`.

## Form behaviour

- Filter bar: Type / Major / Minor / Search / Source account mandatory / Target account mandatory / Subscription eligible / Record status — all custom dropdowns; deferred model ([Search] applies pending selections).
- Add form has fields for: type, major, minor, description, tag keywords, counterparty examples, account-type hints, subscription eligible, record status. The `record_status` dropdown in the add form offers only `active` — the backend always creates rows as `active` and rejects any other value on `create_category`.
- Edit form has the same fields as the add form, with `record_status` offering all four options: `active`, `inactive`, `locked`, `deleted`.
- Locked categories: View only — Edit and Delete suppressed in the context menu.
- Deleted categories: View + Restore — Edit and Delete suppressed; restore uses `update_category` to set `record_status: active`.
