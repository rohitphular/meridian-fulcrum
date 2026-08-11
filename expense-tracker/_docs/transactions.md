# Transactions

The core ledger. Every money movement is one row.

Schema reference: [data-model.md § Transaction](data-model.md#transaction). Balance arithmetic: [balance-lifecycle.md](balance-lifecycle.md). Hard-block rules: [financial-rules.md](financial-rules.md).

## Capabilities

- Create, edit, delete transactions across three types: `money-in`, `money-out`, `money-transfer`
- Cascading category dropdowns (type → major → minor)
- FX rate field on cross-currency transfers (and on `money-out` with a target account in a different currency)
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
| `money-in` | target only | yes | n/a | `+amount` |
| `money-out` | source; target optional (for repayments) | yes | `−amount` | `+credited` if target set |
| `money-transfer` | source AND target | no | `−amount` | `+credited` |

Where `credited = amount × fx_rate` when source/target currencies differ and `fx_rate > 0`; otherwise `credited = amount`.

## Required fields

| Field | Required when |
|---|---|
| `transaction_date_utc` | Always |
| `transaction_type` | Always; must be one of the three sanctioned values |
| `amount` | Always; must be > 0 |
| `source_account` | When type ≠ `money-in` |
| `target_account` | When type = `money-in`, `money-transfer`, or when a `money-out` is a repayment to an owned account |
| `major_category`, `minor_category` | When type ∈ {`money-in`, `money-out`} |
| `fx_rate` | When `money-transfer` (or `money-out` with target) AND source/target currencies differ — must be > 0 |

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
3. Archived categories appear greyed-out and disabled in the dropdown (kept visible so historical references remain interpretable).
4. Changing the type clears both major and minor.

The cascade applies identically in both the add form and the edit form.

## FX rate handling

| Path | Behaviour |
|---|---|
| Same-currency transfer | FX field hidden; rate stored as blank; credited = amount |
| Cross-currency transfer | FX field shown and required (> 0); stored on the row; credited = amount × fx_rate |
| Cross-currency `money-out` with target | Same as cross-currency transfer |
| Display in the table | Base-currency conversion uses the row's stored `fx_rate` if present, else the global rate from `rates`. A `†` marker indicates row-level rate; a `?` badge indicates missing rate in the global table. |

The row-level `fx_rate` is preserved indefinitely. Reversing an edit or delete uses the same stored rate, so balance arithmetic remains exact even if the global rates table is later edited.

### Inline conversion-rate record (notes)

On every save, when the transaction is cross-currency, the backend appends a marker to the `notes` field of the form:

```
[FX: {amount} {fromCcy} <-> {credited} {toCcy}]
```

Example for a £100 → ₹10,500 transfer at rate 105: `[FX: 100 GBP <-> 10500 INR]`. The ratio between the two amounts is the rate used. The marker is regenerated on every save — if the user changes `fx_rate` on an edit, the stale marker is stripped and a fresh one appended. This makes the rate-at-time-of-transaction visible when inspecting the underlying sheet directly, not just inside the app.

## Filtering and sorting

### Filter dimensions (AND-combined)

| Filter | Type | Behaviour |
|---|---|---|
| Type | Multi-select | Match any selected `transaction_type` |
| Account | Single-select | Match `source_account` |
| Major category | Single-select | Match `major_category` |
| Minor category | Single-select | Match `minor_category` |
| Country | Substring | Case-insensitive contains on `country` |
| Tag | Substring | Case-insensitive contains on any element of the `;`-split `tags` |
| Search | Substring | Case-insensitive contains across `counterparty`, `notes`, and the source account name |
| Method | Single-select | Reserved — `payment_method` is not currently populated |

Date range is applied first (shared with the insight section), then the filter set.

### Active filters as chips

Each active filter renders as a chip below the filter bar with an `×` to remove that one filter without opening the panel. A badge on the **Filters** button shows the active-filter count.

### Sortable columns

Date, Type, Account (by source account name), Category (by major). Default sort: `transaction_date_utc` descending. Click a header to sort ascending; click again to flip.

## Pagination

Client-side, default 50 rows per page (selectable: 10 / 25 / 50). Resets to page 1 whenever any filter, sort, or date range changes.

## Malformed rows

Rows missing `id`, `transaction_date_utc`, or with an invalid `transaction_type` are diverted into a collapsed warning section. They:

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
| `list_transactions` | Return all rows |
| `create_transaction` | Validate; duplicate check on `(date, type, amount, source, target)` → `duplicate_transaction`; assign `id`; append; apply balance adjustments |
| `create_transactions_bulk` | Accept `transactions[]`; call `create_transaction` for each; return `{ created, skipped, failed, results }` — duplicates go in `skipped` |
| `update_transaction` | Validate; reverse old row's balance effects (Phase 1); apply new row's effects (Phase 2); overwrite the row |
| `delete_transaction` | Reverse balance effects; delete the row |

## CSV import

The import panel accepts a CSV file. Canonical column names (no aliases):

| Column | Required | Notes |
|---|---|---|
| `tx_date_time` | Yes | ISO date/time of the transaction |
| `transaction_type` | Yes | `money-in`, `money-out`, `money-transfer` |
| `amount` | Yes | Positive number |
| `source_account` | Conditional | Account name; required when type ≠ `money-in` |
| `target_account` | Conditional | Account name; required when type = `money-in` or `money-transfer` |
| `major_category` | Conditional | Required when type ∈ {`money-in`, `money-out`} |
| `minor_category` | Conditional | Required when type ∈ {`money-in`, `money-out`} |
| `counterparty_name` | No | Maps to `counterparty` |
| `tx_location_country` | No | Maps to `country` |
| `fx_rate` | Conditional | Required on cross-currency transfers |
| `tags` | No | Semicolon-separated |
| `notes` | No | |

Preview is shown before submission. Duplicate rows (matched on date + type + amount + source + target) are shown with an "already exists" badge and counted in `skipped`, not `failed`. Results summary: `N imported · M already existed`.

## Add / edit form layout

- All three transaction types share one form template, with conditional fields:
  - **money-in / money-out**: Type, Major, Minor, Source/Target account (single account), Date, Counterparty, Amount, Country, Tags, Notes.
  - **money-transfer**: Type, Source account, Target account, FX rate (when cross-currency), Date, Amount, Tags, Notes. Categorisation fields hidden.
- The Edit form renders **above** the table, not inline within a table row. Delete confirmation stays inline (one-row confirmation).
- On mobile, the table is replaced by stacked cards using the same data. View/Edit cards still render above.
