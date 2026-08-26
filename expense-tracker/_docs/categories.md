# Categories

The two-level taxonomy used to classify income and expense transactions. Every `money-in` and `money-out` requires a `(major, minor)` pair.

Schema reference: [data-model.md § Category](data-model.md#category).

## Capabilities

- CRUD on category rows (`type`, `major`, `minor`, `description`, `tag_keywords`, `counterparty_examples`, account-type hints, `is_subscription_eligible`)
- Filter list by type, major, minor, search, account hint flags, subscription eligibility, record status
- Soft-delete (`record_status → deleted`) with restore; lock (`record_status → locked`) prevents any further edits or deletes
- Auto-seed a default category list on first run when the store is empty
- Declare per-category account-type hints that the transaction layer enforces
- CSV bulk import — upload a CSV file in the import panel; preview before committing

## Rules

| Rule | Detail |
|---|---|
| `tx_type_key` | Required; must be `money-in` or `money-out` |
| `major_category_label`, `minor_category_label` | Both required; non-empty strings |
| `description`, `tag_keywords`, `counterparty_examples` | Optional |
| `tag_keywords` storage | Lowercased on save; stored as a comma-separated string |
| Uniqueness | Enforced on `(tx_type_key, major_category_key, minor_category_key)`. Duplicate on individual create → `duplicate_category`. Duplicate on bulk import → counted as `updated` in results. |
| Soft-delete | `delete_category` sets `record_status → deleted`; the row stays in the sheet. Transactions retain their stored `major`/`minor` strings — no cascade. |
| Restore | `restore_category` sets `record_status → active`; runs duplicate check before restoring. |
| Lock | `record_status = locked` blocks edits and deletes at the backend. Locked rows appear in the UI with View only — all mutation options are hidden. |

## Account-type hints (optional per-row)

A category row may carry four extra columns that the transaction layer enforces:

| Column | Type | Meaning |
|---|---|---|
| `source_account_mandatory` | boolean | If true, transactions of this category MUST specify a source account |
| `source_account_types` | string | Comma-separated allowed source account types (e.g. `current,savings`) |
| `target_account_mandatory` | boolean | If true, transactions of this category MUST specify a target account |
| `target_account_types` | string | Comma-separated allowed target account types |

When a category with these hints is used on a transaction:

1. The transaction layer rejects submissions where a mandatory account is missing.
2. The transaction layer rejects submissions where the chosen account's type is not in the allowed list.
3. The transaction form pre-filters the account dropdowns to the allowed types so the user cannot easily pick a forbidden combination.

Example from the default seed:
- `money-out / Debt & finance / Loan repayment`: target mandatory; target type ∈ {7 loan types}

Categories without hints have no account-type constraints.

## Default seed

On the first `list_categories` call, if the store is empty, the server appends a comprehensive default category set covering common income and expense scenarios. The seed includes:

- ~25 `money-in` (major, minor) combinations
- ~70 `money-out` (major, minor) combinations

The list is not authoritative — users freely edit, delete, or restore any seeded row, and add their own.

## API surface

| Operation | Behaviour |
|---|---|
| `list_categories` | Return all rows; seed defaults if empty |
| `create_category` | Validate required fields; duplicate check → `duplicate_category`; append; stamps `created_at`, `updated_at`, `sync_status = create-pending` |
| `create_categories_bulk` | Accept `categories[]`; dedup within batch and against sheet; return `{ created, updated, failed, results }` |
| `update_category` | Validate required fields; locked guard; overwrite the row; stamps `updated_at` |
| `delete_category` | Locked guard; soft-delete (`record_status → deleted`); stamps `updated_at` |
| `restore_category` | Duplicate check; sets `record_status → active`; stamps `updated_at` |

## CSV import

The import panel (accessible via the **Import** button in the section header) accepts a CSV with these columns:

| Column | Required | Notes |
|---|---|---|
| `tx_type_key` | Yes | `money-in` or `money-out` |
| `major_category_label` | Yes | |
| `minor_category_label` | Yes | |
| `description` | No | |
| `tag_keywords` | No | Comma-separated; lowercased on save |
| `counterparty_examples` | No | Comma-separated |
| `source_account_types` | No | Comma-separated sub-types |
| `target_account_types` | No | Comma-separated sub-types |
| `source_account_mandatory` | No | `true` / `false` |
| `target_account_mandatory` | No | `true` / `false` |
| `is_subscription_eligible` | No | `true` / `false` |
| `record_status` | No | `active` / `inactive` — defaults to `active` if omitted or unrecognised |

Audit columns (`sync_status`, `sync_date_time`, `sync_notes`, `created_at`, `updated_at`) are stamped by the backend on import and must not be present in the CSV.

Preview is shown before submission. Results summary: `N imported · M updated · K failed`.

## Form behaviour

- Filter bar: Type / Major / Minor / Search / Source account mandatory / Target account mandatory / Subscription eligible / Record status — all custom dropdowns; deferred model ([Search] applies pending selections).
- Add / Edit form has fields for: type, major, minor, description, tag keywords, counterparty examples, account-type hints, subscription eligible, record status.
- Locked categories: View only — Edit and Delete suppressed in the context menu.
- Deleted categories: View + Restore — Edit and Delete suppressed; restore runs a duplicate check.
