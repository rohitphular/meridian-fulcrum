# Transactions

The core ledger. Every money movement is one row.

Schema reference: [data-model.md § Transaction](data-model.md#transaction). Balance arithmetic: [balance-lifecycle.md](balance-lifecycle.md). Hard-block rules: [financial-rules.md](financial-rules.md).

## Capabilities

- Create, edit, soft-delete, restore, and lock transactions across two types: `money-in`, `money-out`
- Transfers (moving money between owned accounts) are modelled via category flags, not a third tx_type
- Cascading category dropdowns (type → major → minor)
- FX `target_amount` field on cross-currency transactions where source/target currencies differ
- Eight independent filter dimensions, combined with AND
- Active-filter chips with one-click removal
- Sortable, paginated table; mobile uses card layout
- Date-range scoping (shared with the insight section)
- CSV / JSON export of the date-range-filtered set
- CSV bulk import — upload, preview, then submit; duplicates shown as "already exists" badges and counted separately
- Warning banner separating malformed rows from the main table

## Transaction types

| Type | Required accounts | Categorised | Sign on source | Sign on target |
|---|---|---|---|---|
| `money-in` | target only | yes | n/a | `+source_amount` |
| `money-out` | source; target optional (for repayments) | yes | `−source_amount` | `+target_amount` if target set |

**Transfers** (moving money between owned accounts) are `money-out` transactions whose category declares `source_account_mandatory = true` and `target_account_mandatory = true`. They behave identically to money-out with a target account: debit source, credit target. When source/target currencies differ, `target_amount` stores the credited amount explicitly.

## Required fields

| Field | Required when |
|---|---|
| `tx_date_time` | Always |
| `tx_type` | Always; must be `money-in` or `money-out` |
| `source_amount` | Always; must be > 0 |
| `source_account` | When type = `money-out`, or when category declares `source_account_mandatory = true` |
| `target_account` | When type = `money-in`, or when category declares `target_account_mandatory = true` |
| `major_category`, `minor_category` | Always (both types are categorised) |
| `target_amount` | When source and target accounts have different currencies — stores the credited amount in the target currency |

The currency of the transaction is derived at save time from the relevant account (`target_account` for `money-in`, `source_account` otherwise). It is not user-input.

## Category-driven account-type hints

A category row may declare:

```
source_account_mandatory   : boolean
source_account_types       : comma-separated allowed types
target_account_mandatory   : boolean
target_account_types       : comma-separated allowed types
```

When a category with these hints is selected:

1. Backend validates that the selected source/target account is present (if `mandatory`).
2. Backend validates that the selected account's `type` **or** `sub_type` is in the allowed list (if specified). The values in `source_account_types`/`target_account_types` may be top-level types (`asset`, `liability`) or sub-types (`current`, `credit_card`) — either will match.
3. Frontend filters the source/target dropdowns to the allowed types.

Examples from the default seed:
- *Credit card payment* (money-transfer): source must be `current` or `savings`; target must be `credit_card`.
- *Loan repayment* (money-out with target): source must be `current`/`savings`; target must be one of the 7 loan types.

Mismatched submissions are rejected with `source_account_type_mismatch` or `target_account_type_mismatch`.

## Hard-block rules

See [financial-rules.md](financial-rules.md). The six rules: insufficient asset balance, credit limit exceeded, no money-out from a loan, FX rate required on cross-currency transfers, plus their analogues for credit-card targets.

## Cascading category dropdowns

1. Type selected → major dropdown enabled, populated with all majors for that type.
2. Major selected → minor dropdown enabled, populated with minors for that type + major.
3. Inactive categories (`record_status = inactive`) appear greyed-out and disabled in the dropdown (kept visible so historical references remain interpretable).
4. Changing the type clears both major and minor.

The cascade applies identically in both the add form and the edit form.

## FX / cross-currency handling

| Path | Behaviour |
|---|---|
| Same-currency transaction | `target_amount` blank; balance credited = `source_amount` |
| Cross-currency `money-out` with target | `target_amount` required (> 0); target account credited by `target_amount` |
| Cross-currency `money-in` | `target_amount` required; target account credited by `target_amount` |
| Display in the table | Base-currency conversion uses the row-level amounts if present, else the global rate from `rates`. A `†` marker indicates row-level rate was used. |

The two stored amounts (`source_amount`, `target_amount`) are preserved indefinitely. Reversing an edit or delete uses the same stored amounts, so balance arithmetic remains exact even if the global rates table is later edited.

### Inline conversion-rate record (description)

On every save, when the transaction is cross-currency, the backend appends a marker to the `description` field of the form:

```
[FX: {source_amount} {fromCcy} <-> {target_amount} {toCcy}]
```

Example for a £100 → ₹10,500 payment: `[FX: 100 GBP <-> 10500 INR]`. The marker is regenerated on every save — if the user changes amounts on an edit, the stale marker is stripped and a fresh one appended.

## Filtering and sorting

### Filter dimensions (AND-combined)

| Filter | Type | Behaviour |
|---|---|---|
| Type | Multi-select | Match any selected `tx_type` |
| Account | Single-select | Match `source_account` |
| Major category | Single-select | Match `major_category` |
| Minor category | Single-select | Match `minor_category` |
| Country | Substring | Case-insensitive contains on `user_location_country` |
| Tag | Substring | Case-insensitive contains on any element of the `;`-split `tx_tags` |
| Search | Substring | Case-insensitive contains across `counterparty_name`, `description`, and the source account name |
| Method | Single-select | Reserved — `payment_method` is not currently populated |

Date range is applied first (shared with the insight section), then the filter set.

### Active filters as chips

Each active filter renders as a chip below the filter bar with an `×` to remove that one filter without opening the panel. A badge on the **Filters** button shows the active-filter count.

### Sortable columns

Date, Type, Account (by source account name), Category (by major). Default sort: `transaction_date_utc` descending. Click a header to sort ascending; click again to flip.

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
| CSV | All visible columns of the date-range-filtered set; one row per transaction |
| JSON | Array of objects; full field set (including reserved/unused fields) |

Filter chips on the panel do NOT affect the export — only the date range does. The export is "what's in the period," not "what's currently shown."

## API surface

| Operation | Behaviour |
|---|---|
| `list_transactions` | Return all rows (including soft-deleted) |
| `create_transaction` | Validate; duplicate check on `(tx_date_time, tx_type, source_amount, source_account, target_account)` skipping deleted rows → `duplicate_transaction`; assign `id`; stamp `record_status = active`, `created_at`, `updated_at`; append |
| `create_transactions_bulk` | Accept `transactions[]`; call `create_transaction` for each; return `{ created, skipped, failed, results }` — duplicates go in `skipped` |
| `update_transaction` | Locked guard → `record_locked`; validate; overwrite editable fields; stamp `updated_at`; advance `sync_status` |
| `delete_transaction` | Locked guard; soft-delete (`record_status → deleted`); stamp `updated_at` |
| `restore_transaction` | Check `record_status = deleted`; set `record_status → active`; stamp `updated_at` |

## CSV import

The import panel accepts a CSV file. Canonical column names (no aliases):

| Column | Required | Notes |
|---|---|---|
| `tx_date_time` | Yes | ISO date/time of the transaction |
| `tx_type` | Yes | `money-in` or `money-out` |
| `source_amount` | Yes | Positive number |
| `target_amount` | Conditional | Required when source/target currencies differ |
| `source_account` | Conditional | Account name; required for `money-out` or when category mandates it |
| `target_account` | Conditional | Account name; required for `money-in` or when category mandates it |
| `major_category` | Yes | |
| `minor_category` | Yes | |
| `counterparty_name` | No | |
| `user_location_country` | No | |
| `tx_tags` | No | Semicolon-separated |
| `description` | No | |

Preview is shown before submission. Duplicate rows (matched on date + type + amount + source + target) are shown with an "already exists" badge and counted in `skipped`, not `failed`. Results summary: `N imported · M already existed`.

## Add / edit form layout

- Both transaction types share one form template, with conditional fields:
  - **money-in**: Type, Major, Minor, Target account, Date, Counterparty, Source Amount, Target Amount (when cross-currency), Country, Tags, Description.
  - **money-out**: Type, Major, Minor, Source account, Target account (optional), Date, Counterparty, Source Amount, Target Amount (when target + cross-currency), Country, Tags, Description.
  - Transfer categories (source + target both mandatory) show both account fields regardless of type.
- The Edit form renders **above** the table, not inline within a table row. Delete confirmation stays inline (one-row confirmation).
- On mobile, the table is replaced by stacked cards using the same data. View/Edit cards still render above.
