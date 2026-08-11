# Accounts

The set of pools of money tracked in the app. Every transaction references one or two accounts; account balances are kept in sync by the transaction lifecycle.

Schema reference: [data-model.md § Account](data-model.md#account).

## Capabilities

- Create, edit, archive, delete accounts (3 types — asset, investment, liability — with mandatory sub-types)
- Net Worth summary: Total Assets, Total Liabilities, Net Worth, Liquid Cash (current + savings + cash)
- Currency dropdown sourced from the rates table — no free-text currency entry

## Rules

### Required fields

| Field | Applies to | Rule |
|---|---|---|
| `name` | All | Non-empty |
| `type` | All | Must be one of: `asset`, `investment`, `liability` |
| `sub_type` | All | Required for all accounts; valid values depend on type |
| `currency` | All | Must exist in `rates` |

### Liability balance convention

| Layer | Value | Example |
|---|---|---|
| User input | Positive — enter what you owe | `400` |
| Stored (`current_value`) | Negative — store negates on save | `−400` |
| UI display | `−` prefix on the raw (already-negative) stored value | `−£400` |

The stored value is negative; the UI renders it directly with a `−` prefix so the display reads `−£400`. This follows standard double-entry convention: liabilities cancel against assets in a single `SUM(all current_value)` to produce Net Worth. The edit form pre-fills the field with the `−` prefix so the user sees the owed amount at a glance.

### Immutable after creation

`id`, `type`, `currency`, `opening_value`, `current_value`, `created_at`. Attempting to update any of these returns a `field_not_editable:<name>` error.

`sub_type` IS editable post-creation — it is purely a classification label with no side effects on balance arithmetic or validation. Use cases: correcting an initial mis-classification.

### current_value is system-managed

There is no API to write `current_value` directly. It changes only via the transaction lifecycle (see [balance-lifecycle.md](balance-lifecycle.md)). To correct a discrepancy between the recorded balance and reality, record an `Adjustments / Balance correction` transaction (`money-in` to credit, `money-out` to debit).

### Deletion semantics

- **Deletion is FK-guarded.** Before removing the row, the store counts transactions where `source_account == account.id` OR `target_account == account.id`. If that count is `> 0`, the delete is refused with `{ ok: false, error: 'account_in_use', referenced_count: N, hint: 'archive_instead' }`.
- The user's recovery path is either to delete/reassign every referencing transaction, or to **archive** the account (set `is_active = false`) — see [Archive (soft delete)](#archive-soft-delete) below. The UI offers a one-click "Archive instead" button when the FK check refuses a deletion.
- Once a deletion is permitted (no transactions reference the account), the row is removed unconditionally and the account disappears from all dropdowns.

The previous design (unconditional delete + orphaned transaction references) led to silent balance drift when later edits hit the now-missing account. The FK guard plus the fail-closed behaviour of `adjust_balance` together close that loop.

### Archive (soft delete)

Setting `is_active = false` removes the account from transaction form dropdowns but keeps it visible in the accounts list and its balance counted in the Net Worth summary. Use archive when you stop using an account but want to preserve its history without breaking past transactions' lookups.

## Net Worth summary

Four cards above the table, always in base currency:

| Card | Calculation |
|---|---|
| **Total Assets** | Sum of `toBase(current_value, currency)` over all `asset` and `investment` accounts |
| **Total Liabilities** | Sum of `abs(toBase(current_value, currency))` over all `liability` accounts |
| **Net Worth** | `Total Assets − Total Liabilities`. Negative renders in ember/red. |
| **Liquid Cash** | Sum of `toBase(current_value)` over accounts where `type = asset AND sub_type ∈ {current, savings, cash}` |

## API surface

| Operation | Behaviour |
|---|---|
| `list_accounts` | Return all rows; no defaults seeded |
| `create_account` | Validate required fields; duplicate name check (case-insensitive) → `duplicate_account`; negate value for liabilities; assign `id` and `created_at`; append |
| `create_accounts_bulk` | Accept `accounts[]`; call `create_account` for each; return `{ created, skipped, failed, results }` — duplicates go in `skipped`, not `failed` |
| `update_account` | Validate editable fields only; reject `field_not_editable:<name>` for any locked field |
| `delete_account` | FK-guarded delete by row identity |
| `get_account_schema` | Return the type taxonomy (3 types with sub-type enums) — frontend uses this to drive forms without hard-coding |

## Form behaviour

- Currency dropdown is populated from the rates table — adding a new currency requires adding it to `rates` first.
- Sub-type dropdown updates to the valid values for the selected type.
- For liability accounts, a hint is shown explaining the positive-input convention.
- Edit mode disables all immutable fields (greyed, not submitted).
