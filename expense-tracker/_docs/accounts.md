# Accounts

The set of pools of money tracked in the app. Every transaction references one or two accounts; account balances are kept in sync by the transaction lifecycle.

Schema reference: [data-model.md § Account](data-model.md#account).

## Capabilities

- Create, edit, deactivate, soft-delete, restore, and lock accounts (3 types — asset, investment, liability — with mandatory sub-types)
- Net Worth summary: Total Assets, Total Liabilities, Net Worth, Liquid Cash (current + savings + cash) — always unfiltered
- Filter panel: Type / Sub-type / Currency / Search / Record status — deferred model ([Search] applies)
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

The stored value is negative; the UI renders it directly with a `−` prefix so the display reads `−£400`. This follows standard double-entry convention: liabilities cancel against assets in a single `SUM(all current_value)` to produce Net Worth.

### Immutable after creation

`id`, `type`, `currency`, `opening_value`, `current_value`, `created_at`. Attempting to update any of these returns a `field_not_editable:<name>` error.

`sub_type` IS editable post-creation — it is purely a classification label with no side effects on balance arithmetic or validation.

### current_value is system-managed

There is no API to write `current_value` directly. It changes only via the transaction lifecycle (see [balance-lifecycle.md](balance-lifecycle.md)). To correct a discrepancy between the recorded balance and reality, record an `Adjustments / Balance correction` transaction (`money-in` to credit, `money-out` to debit).

### Deletion semantics

- **FK-guarded.** Before soft-deleting, the store counts transactions where `source_account == account.id` OR `target_account == account.id`. If that count is `> 0`, the delete is refused with `{ ok: false, error: 'account_in_use', referenced_count: N }`. The user's recovery path is to **deactivate** the account instead (`record_status → inactive`) — the UI offers a one-click "Deactivate instead" button.
- **Soft-delete.** When permitted (no transactions reference the account), `delete_account` sets `record_status → deleted` — the row stays in the sheet and remains visible in the accounts list (dimmed). It does not disappear from the table.
- **Restore.** Deleted accounts can be restored via `update_account` with `record_status: active`. The backend runs a duplicate name check before restoring.
- **Locked accounts** cannot be edited or deleted. The context menu shows View only for locked rows.

### Deactivate (record_status = inactive)

Setting `record_status = inactive` removes the account from transaction form dropdowns but keeps it visible in the accounts list and its balance counted in the Net Worth summary. Use when you stop using an account but want to preserve its history without breaking past transactions.

## Net Worth summary

Four cards above the table, always in base currency and always unfiltered (filter panel does not affect these totals):

| Card | Calculation |
|---|---|
| **Total Assets** | Sum of `toBase(current_value, currency)` over all non-deleted `asset` and `investment` accounts |
| **Total Liabilities** | Sum of `abs(toBase(current_value, currency))` over all non-deleted `liability` accounts |
| **Net Worth** | `Total Assets − Total Liabilities`. Negative renders in ember/red. |
| **Liquid Cash** | Sum of `toBase(current_value)` over non-deleted accounts where `type = asset AND sub_type ∈ {current, savings, cash}` |

## API surface

| Operation | Behaviour |
|---|---|
| `list_accounts` | Return all rows; no defaults seeded |
| `create_account` | Validate required fields; duplicate name check → `duplicate_account`; negate value for liabilities; assign `id`; stamp `created_at`, `sync_status = create-pending`; append |
| `create_accounts_bulk` | Accept `accounts[]`; call `create_account` for each; return `{ created, skipped, failed, results }` — duplicates go in `skipped` |
| `update_account` | Validate editable fields only; locked guard → `record_locked`; duplicate name check → `duplicate_account`; advance `sync_status`; stamp `updated_at` |
| `delete_account` | Locked guard; FK check → `account_in_use`; soft-delete (`record_status → deleted`) |
| `restore_account` | Duplicate name check; sets `record_status → active` |
| `get_account_schema` | Return the type taxonomy (3 types with sub-type enums) — frontend uses this to drive forms without hard-coding |

## Form behaviour

- Currency dropdown is populated from the rates table — adding a new currency requires adding it to `rates` first.
- Sub-type dropdown updates to the valid values for the selected type.
- For liability accounts, a hint is shown explaining the positive-input convention.
- Edit mode disables all immutable fields (greyed, not submitted).
- Locked accounts: View only — Edit and Delete suppressed in the context menu.
- Deleted accounts: View + Restore in the context menu — Edit and Delete suppressed.
