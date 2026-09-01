# Accounts

The set of pools of money tracked in the app. Every transaction row references exactly one account (via `account_id`). A transfer between two accounts produces two linked rows — one per account. Account balances are computed at read time by `_buildAccountNetMap` in `account-core.gs`, which scans the transactions sheet on every `listAccounts` call and returns `current_value = opening_value + net`. No balance value is written back to the accounts sheet during transaction operations.

Schema reference: [data-model.md § Account](data-model.md#account).

## Capabilities

- Create, edit, deactivate, soft-delete, restore, and lock accounts (3 types — asset, investment, liability — with mandatory sub-types)
- Net Worth summary: Total Assets, Total Liabilities, Net Worth, Liquid Cash (current + savings + cash) — always unfiltered (deleted accounts excluded; inactive and locked accounts included)
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
| `opening_value` | create | Required; must be a finite number |

### opening_value

`opening_value` is required on create. If omitted, the backend returns `missing_opening_value`. If the provided value is not a finite number, the backend returns `invalid_opening_value`. For liability accounts, the backend negates the absolute value on write so liabilities are stored as negative numbers (balance logic applies the sign convention described below). `current_value` is never written at create time — it is computed at read time by `_buildAccountNetMap`.

### Liability balance convention

| Layer | Value | Example |
|---|---|---|
| User input | Positive — enter what you owe | `400` |
| Stored (`opening_value`) | Negative — store negates on save | `−400` |
| UI display | `abs(current_value)` with a negative prefix or "owed" label | `−400` / `400 owed` |

Liabilities are stored as negative values. The UI displays `abs(current_value)` — user always inputs and sees a positive number, accompanied by a `−` prefix or an "owed" label to indicate the direction. This follows standard double-entry convention: liabilities cancel against assets in a single `SUM(all current_value)` to produce Net Worth.

### Account sub-types and loan_sub_types

Each account type has a fixed set of valid sub-types driven by `get_account_schema`. `loan_sub_types` is a subset of liability sub-types that also qualify as loans (personal loan, mortgage, auto loan, heloc, student loan, medical loan, debt consolidation). These are surfaced separately so the UI and analytics can distinguish loan-type liabilities (where repayment transfers apply) from pure liabilities such as credit cards. All `loan_sub_types` values are also present in `liability_sub_types` — the split is a classification aid, not a separate type hierarchy.

### Immutable after creation

`id`, `type`, `currency`, `opening_value`, `current_value`, `created_at`. Attempting to update any of these returns `{ ok: false, error: 'field_not_editable', field: '<field_key>' }` — the immutable field name is carried in the separate `field` property, not embedded in the error code string.

`sub_type` IS editable post-creation — it is purely a classification label with no side effects on balance arithmetic or validation.

`record_status` can be changed to `active`, `inactive`, or `locked` via `update_account`. Setting it to `deleted` via `update_account` is rejected with `invalid_record_status` — the `deleted` state is set only via `delete_account`; restoring from `deleted` requires `restore_account`.

### current_value is computed, not stored

There is no API to write `current_value` directly and no transaction operation writes it to the accounts sheet. The column does exist in the sheet (created by the schema for column-position ordering) but is always blank in the sheet — it is never written via `create_account` or `update_account`. `listAccounts` injects the computed value at read time as `opening_value + sum(non-deleted transactions)` via `_buildAccountNetMap`. To correct a discrepancy between the computed balance and reality, record an `Adjustments / Balance correction` transaction (`money-in` to credit, `money-out` to debit). See [balance-lifecycle.md](balance-lifecycle.md) for the full computation model.

### Deletion semantics

- **FK-guarded.** Before soft-deleting, the store counts transactions where `account_id == account.id`. If that count is `> 0`, the delete is refused with `{ ok: false, error: 'account_in_use', referenced_count: N }`. The user's recovery path is to **deactivate** the account instead (`record_status → inactive`) — the UI offers a one-click "Deactivate instead" button.
- **Soft-delete.** When permitted (no transactions reference the account), `delete_account` sets `record_status → deleted` — the row stays in the sheet and remains visible in the accounts list (dimmed). It does not disappear from the table.
- **Restore.** Deleted accounts can be restored via the dedicated `restore_account` POST action. The backend verifies the record is in `deleted` state before restoring and sets `record_status → active`.
- **Locked accounts** cannot be edited or deleted. The context menu shows View only for locked rows.

### Sync lifecycle

On create, `sync_status` defaults to `create-pending`. The Python FX sync job (or a manual sync trigger) transitions the account to `in-sync` once the record is confirmed persisted externally. If synchronisation fails, the status is set to `create-failed` or `update-failed`. The full set of valid values is: `create-pending | update-pending | in-sync | create-failed | update-failed`.

### Deactivate (record_status = inactive)

Setting `record_status = inactive` removes the account from transaction form dropdowns but keeps it visible in the accounts list and its balance counted in the Net Worth summary. Use when you stop using an account but want to preserve its history without breaking past transactions.

## Net Worth summary

Four cards above the table, always in base currency and always unfiltered (filter panel does not affect these totals). Deleted accounts are excluded from all four cards; inactive and locked accounts are included.

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
| `create_account` | Validate required fields (including `opening_value`); duplicate name check → `duplicate_account`; negate value for liabilities; assign `id`; write `opening_value` to sheet; stamp `created_at`, `sync_status = create-pending`; append. `current_value` is NOT written at create time — it is computed at read time by `_buildAccountNetMap`. |
| `create_accounts_bulk` | Accept `accounts[]`; call `create_account` for each; return `{ created, skipped, failed, results }` — duplicates go in `skipped`. Each element of `results[]` has shape `{ name, ok, error?, id? }`: `error` is present only on failed rows; `id` is present only on successful rows |
| `update_account` | Validate editable fields only; locked guard → `record_locked`; duplicate name check → `duplicate_account` (deleted accounts excluded from the collision check); advance `sync_status`; stamp `updated_at`. Valid `record_status` values for update: `active`, `inactive`, `locked` only — `deleted` is rejected with `invalid_record_status`. |
| `delete_account` | Locked guard; FK check → `account_in_use`; soft-delete (`record_status → deleted`) |
| `restore_account` | Verifies record is in `deleted` state; sets `record_status → active` |
| `get_account_schema` | Return the type taxonomy and all sub-type enums. Response shape: `{ types: { value, label, group }[], asset_sub_types: string[], investment_sub_types: string[], liability_sub_types: string[], loan_sub_types: string[] }` — frontend uses this to drive forms without hard-coding |

## Error codes

| Code | Triggered by | Meaning |
|---|---|---|
| `missing_name` | create, update | `name` is blank |
| `missing_currency` | create | `currency` not provided |
| `missing_sub_type` | create | `sub_type` not provided for a type that requires one |
| `invalid_sub_type` | create, update | `sub_type` is not valid for the given account type |
| `invalid_account_type` | create | Account type is not one of `asset`, `investment`, `liability` |
| `unknown_currency` | create | `currency` is not present in the rates store (currency is immutable post-create) |
| `missing_opening_value` | create | `opening_value` is absent or null |
| `invalid_opening_value` | create | `opening_value` is present but not a finite number |
| `duplicate_account` | create, update | Another non-deleted account already has the same name (deleted accounts are excluded from the collision check) |
| `invalid_record_status` | update | `record_status` is not one of `active`, `inactive`, `locked` |
| `missing_row_num` | update, delete, restore | `row_num` not provided |
| `invalid_row` | update, delete, restore | `row_num` is out of bounds |
| `record_locked` | update, delete | Account is locked |
| `not_deleted` | restore | Account is not in `deleted` state |
| `account_in_use` | delete | Account has linked transactions and cannot be soft-deleted |
| `missing_accounts` | bulk create | `body.accounts` is missing or is not a non-empty array |
| `field_not_editable` | update | Attempted to change an immutable field. Response shape: `{ ok: false, error: 'field_not_editable', field: '<field_key>' }` — the field name is a separate property, not embedded in the error string. |

## Form behaviour

- Currency dropdown is populated from the rates table — adding a new currency requires adding it to `rates` first.
- Sub-type dropdown updates to the valid values for the selected type. `sub_type` is editable in the edit form.
- Edit mode disables all immutable fields (greyed, not submitted).
- `record_status` edit dropdown offers only `active`, `inactive`, `locked`. `deleted` is not a selectable option; deletion is handled via the Delete action and restoration via Restore.
- Locked accounts: View only — Edit and Delete suppressed in the context menu.
- Deleted accounts: View + Restore in the context menu — Edit and Delete suppressed.
