# Categories

The two-level taxonomy used to classify income and expense transactions. Every `money-in` and `money-out` requires a `(major, minor)` pair; `money-transfer` does not.

Schema reference: [data-model.md § Category](data-model.md#category).

## Capabilities

- CRUD on category rows (`type`, `major`, `minor`, `description`, `tag_keywords`, `is_active`, account-type hints)
- Filter list by transaction type
- Archive without delete (`is_active = false` hides from transaction forms)
- Auto-seed a default category list on first run when the store is empty
- Declare per-category account-type hints that the transaction layer enforces
- CSV bulk import — upload a CSV file in the import panel; preview before committing

## Rules

| Rule | Detail |
|---|---|
| `transaction_type` | Required; must be `money-in`, `money-out`, or `money-transfer` |
| `major_category`, `minor_category` | Both required; non-empty strings |
| `description`, `tag_keywords` | Optional |
| `tag_keywords` storage | Lowercased on save; stored as a comma-separated string |
| Uniqueness | Enforced on `(transaction_type, major_category, minor_category)`. Duplicate on individual create → `duplicate_category`. Duplicate on bulk import → counted as `skipped`, not `failed`. |
| Delete cascade | None. Deleting a category does not modify any existing transactions — their stored `major`/`minor` strings remain. The category simply stops appearing in dropdowns. |
| Archive | `is_active = false` keeps the row but excludes it from transaction form dropdowns. Archived categories still appear (greyed/disabled) in the dropdowns so historical references stay interpretable. |

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

Examples from the default seed:
- `money-out / Debt & finance / Loan repayment`: target mandatory; target type ∈ {7 loan types}
- `money-transfer / Card payment / Pay credit card`: source ∈ {current, savings}; target = credit_card

Categories without hints have no account-type constraints.

## Default seed

On the first `list_categories` call, if the store is empty, the server appends a comprehensive default category set covering common income, expense, and transfer scenarios. The seed includes:

- ~25 `money-in` (major, minor) combinations
- ~70 `money-out` (major, minor) combinations
- ~15 `money-transfer` (major, minor) combinations

The list is not authoritative — users freely edit, archive, or delete any seeded row, and add their own.

## API surface

| Operation | Behaviour |
|---|---|
| `list_categories` | Return all rows; seed defaults if empty |
| `create_category` | Validate required fields; duplicate check → `duplicate_category`; append |
| `create_categories_bulk` | Accept `categories[]`; dedup within batch and against sheet; return `{ created, skipped, failed, results }` |
| `update_category` | Validate required fields; overwrite the row |
| `delete_category` | Delete the row by identity (no transaction-side effects) |

## CSV import

The import panel (accessible via the **Import** button in the section header) accepts a CSV with these columns:

| Column | Required | Notes |
|---|---|---|
| `transaction_type` | Yes | `money-in`, `money-out`, or `money-transfer` |
| `major_category` | Yes | |
| `minor_category` | Yes | |
| `description` | No | |
| `tag_keywords` | No | Comma-separated |
| `source_account_types` | No | Comma-separated sub-types |
| `target_account_types` | No | Comma-separated sub-types |
| `source_account_mandatory` | No | `true` / `false` |
| `target_account_mandatory` | No | `true` / `false` |
| `workflow_type` | No | e.g. `debt-repayment` |
| `sort_order` | No | Integer |

Preview is shown before submission. Results summary: `N imported · M skipped (already exist) · K failed`.

## Form behaviour

- Filter bar offers `All` / `money-in` / `money-out` / `money-transfer` with a live count of matching rows.
- Add / Edit form has fields for: type, major, minor, description, keywords, account-type hints, `is_active`.
- Switching the filter resets any open Edit / Delete row.
