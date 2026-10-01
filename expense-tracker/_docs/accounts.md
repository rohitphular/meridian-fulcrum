# Accounts

The set of pools of money tracked in the app. Every transaction row references exactly one account (via `account_id`). A transfer between two accounts produces two linked rows — one per account. Account balances are computed at read time by `_buildAccountNetMap` in `account-core.gs`, which scans the `transaction_master` sheet on every `listAccounts` call and returns `current_value_local = opening_value_local + net`. No balance value is written back to the `account_master` sheet during transaction operations.

Schema reference: [data-model.md § Account](data-model.md#account).

## Capabilities

- Create, edit, deactivate, soft-delete, restore, and lock accounts using the available Sheet-owned type/subtype pairs
- Net Worth summary: Total Assets, Total Liabilities, Net Worth, Liquid Cash — always unfiltered (deleted accounts excluded; inactive and locked accounts included)
- Filter panel: Type / Sub-type / Currency / Search / Record status — deferred model ([Search] applies)
- Currency dropdown sourced from the rates table — no free-text currency entry
- `local_timezone` auto-detected from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) — never a user-typed input

## Rules

### Required fields

| Field | Applies to | Rule |
|---|---|---|
| `account_name` | All | Non-empty |
| `type` | All | Group key of an available `account_types` row |
| `sub_type` | All | Required for all accounts; valid values depend on type |
| `account_currency_local` | create | Must exist in `rates` |
| `account_opening_date_local` | create | Required; non-empty datetime string in local time (no UTC conversion) |
| `opening_value_local` | create | Required; must be a finite number |

### opening_value_local

`opening_value_local` is required on create. If omitted, the backend returns `missing_opening_value_local`. Values must be finite decimal numbers or decimal/scientific-decimal strings; booleans, arrays and hexadecimal/binary/octal notation return `invalid_opening_value_local`. CSV/API decimal text is preserved instead of being converted through a JavaScript Number before storage. Signed asset/investment opening values are supported for overdrafts and net short positions. For liability accounts, the backend negates the absolute value on write so liabilities are stored as negative numbers (balance logic applies the sign convention described below). `current_value_local` is never written at create time — it is computed at read time by `_buildAccountNetMap`.

### Tracking start date

`account_opening_date_local` is the real-world account opening date. `tracking_start_date_local` is the optional timestamp of the opening balance snapshot. Transactions before that timestamp are excluded from current balance calculation; transactions at or after it are included. Blank keeps all-history behavior. The field is available on create and is read-only afterwards.

### Liability balance convention

| Layer | Value | Example |
|---|---|---|
| User input | Positive — enter what you owe | `400` |
| Stored (`opening_value_local`) | Negative — store negates on save | `−400` |
| UI display | `abs(current_value_local)` with a negative prefix or "owed" label | `−400` / `400 owed` |

Liabilities are stored as negative values. The UI displays `abs(current_value_local)` — user always inputs and sees a positive number, accompanied by a `−` prefix or an "owed" label to indicate the direction. This follows standard double-entry convention: liabilities cancel against assets in a single `SUM(all current_value_local)` to produce Net Worth.

### Account sub-types

Account subtype choices and labels come from active or locked rows in the `account_types` Sheet, managed in [Configure → Account Types](account-types.md) and exposed by `get_account_schema`. The existing 16-row catalog is imported from its CSV; code contains no default subtype list and Configure cannot add new classifications. Detail eligibility comes from each row's `detail_sheet` value. Classification keys use hyphens; column names such as `sub_type` retain underscores.

### Immutable after creation

`id`, `type`, `account_currency_local`, `local_timezone`, `legal_entity_name`, `account_opening_date_local`, `opening_value_local`, `current_value_local`, `tracking_start_date_local`, `created_at`. Attempting to update any of these returns `{ ok: false, error: 'field_not_editable', field: '<field_key>' }` — the immutable field name is carried in the separate `field` property, not embedded in the error code string.

`sub_type`, `account_name`, `account_closing_date_local`, `description`, `record_status` are all editable post-creation.

`account_closing_date_local` is populated via `update_account` when an account is closed — set alongside `record_status: inactive`.

Opening, closing and tracking dates accept valid ISO local dates/datetimes without a UTC offset, with up to six fractional-second digits. Invalid calendar dates and time rollovers are rejected; closing cannot precede the recorded opening date. Text is preserved without UTC conversion. `local_timezone` remains optional. When supplied, the backend validates the IANA zone and rejects ambiguous/nonexistent local times before writing; accepted aliases/casing are stored canonically for ledger-extract. Native Sheet date cells are returned using the spreadsheet's displayed wall time, without an unintended JSON UTC shift.

`record_status` can be changed to `active`, `inactive`, or `locked` via `update_account`. Setting it to `deleted` via `update_account` is rejected with `invalid_record_status` — the `deleted` state is set only via `delete_account`; restoring from `deleted` requires `restore_account`.

### current_value_local is computed, not stored

There is no API to write `current_value_local` directly and no transaction operation writes it to the `account_master` sheet. The column does exist in the sheet (created by the schema for column-position ordering) but is always blank in the sheet — it is never written via `create_account` or `update_account`. `listAccounts` injects the computed value at read time as `opening_value_local + sum(eligible non-deleted transactions)` via `_buildAccountNetMap`. To correct a discrepancy between the computed balance and reality, record an `Adjustments / Balance correction` transaction (`money-in` to credit, `money-out` to debit). See [balance-lifecycle.md](balance-lifecycle.md) for the full computation model.

### Deletion semantics

- **FK-guarded.** Before soft-deleting, the store counts transactions where `account_id == account.id`. If that count is `> 0`, the delete is refused with `{ ok: false, error: 'account_in_use', referenced_count: N }`. The user's recovery path is to **deactivate** the account instead (`record_status → inactive`) — the UI offers a one-click "Deactivate instead" button.
- **Soft-delete.** When permitted (no transactions reference the account), `delete_account` sets `record_status → deleted` — the row stays in the sheet and remains visible in the accounts list (dimmed). It does not disappear from the table.
- **Restore.** Deleted accounts can be restored via the dedicated `restore_account` POST action. The backend verifies the record is in `deleted` state before restoring and sets `record_status → active`.
- **Locked accounts** cannot be edited or deleted. The context menu shows View only for locked rows.

### Sync lifecycle

On create, `sync_status` defaults to `create-pending`. Updates, imports, delete and restore operations clear stale sync date/notes and preserve the original creation timestamp. Direct Sheet business/lifecycle edits, including the tracking timestamp after the audit columns, also queue affected rows and refresh `updated_at`; audit-only edits do not requeue. The trigger writes only sync/audit cells. The Python ledger-extract job transitions the account to `in-sync` once the record is confirmed persisted externally. If synchronisation fails, the status is set to `create-failed` or `update-failed`. The full set of valid values is: `create-pending | update-pending | in-sync | create-failed | update-failed`.

### Deactivate (record_status = inactive)

Setting `record_status = inactive` removes the account from transaction form dropdowns but keeps it visible in the accounts list and its balance counted in the Net Worth summary. Use when you stop using an account but want to preserve its history without breaking past transactions.

## Net Worth summary

Four cards above the table, computed by `list_accounts_view` (`summary.cards`) in the selected quote currency and always unfiltered (the filter panel does not affect these totals). Deleted accounts are excluded from all four cards; inactive and locked accounts are included. The same net-worth definition is used on Home, in Insights and by the advisor; see [calculations](calculations.md#net-worth-assets-and-liabilities). A missing rate excludes that account and adds a `missing_rate` warning.

| Card | Calculation (server, `ldgNetWorth`) |
|---|---|
| **Total Assets** | Current balance converted to the quote currency, summed over all non-deleted `asset` and `investment` accounts |
| **Total Liabilities** | The same over all non-deleted `liability` accounts (negative = owed; the UI shows the magnitude) |
| **Net Worth** | Assets + liabilities. Negative renders in ember/red. |
| **Liquid Cash** | The same over non-deleted `asset` accounts whose account type maps to the `account_deposit` detail sheet |

The account list itself (filters, sort, paging, group totals, display signs, labels, `allowed_actions`) is also returned by `list_accounts_view`; the browser only renders it.

## API surface

| Operation | Behaviour |
|---|---|
| `list_accounts_view` | GET view model for the Accounts tab: summary cards, groups with totals, rows with native and quote balances, facets; params `type`, `sub_type`, `currency`, `search`, `statuses`, `sort`, `dir`, `page`, `page_size` |
| `get_account_form_options` | GET add / edit / import form choices (types, subtypes, currencies, statuses, editable fields of `id`) |
| `export_accounts` | GET every account (all statuses, filters ignored) in the 13 `account_master` import columns, stored values only; the Export button downloads it as CSV / JSON |
| `list_accounts` | Raw rows (kept for `scripts/factory-reset.sh`); the app does not call it |
| `create_account` | Validate required fields (including `opening_value_local`, `account_opening_date_local`); negate value for liabilities; assign UUID `id` (supplied IDs must be valid UUIDs; new values are written lowercase and an existing UUID returns `account_id_exists`); store the validated canonical `local_timezone` from the frontend (captured from browser); store `account_opening_date_local` as-is (no UTC conversion); write `opening_value_local` to sheet; stamp `created_at`, `sync_status = create-pending`; append. `current_value_local` is NOT written at create time — it is computed at read time by `_buildAccountNetMap`. Returns `{ ok: true, id: '<uuid>' }`. |
| `create_accounts_bulk` | Accept `accounts[]`; validate and insert or replace each row by `id`; match supplied UUIDs case-insensitively; preserve the existing UUID spelling, `created_at`, and omitted lifecycle status on replacement; advance `sync_status`. Existing duplicate UUIDs fail before row writes. Return `{ ok, created, updated, failed, results }` with result entries `{ key, ok, action?, error? }` |
| `update_account` | Validate editable fields only; locked guard → `record_locked`; renaming to another non-deleted account's `account_name` → `duplicate_account` (unchanged names are not checked, so existing shared names stay editable); advance `sync_status`; stamp `updated_at`. Editable fields: `account_name`, `sub_type`, `account_closing_date_local`, `description`, `record_status`. Valid `record_status` values for update: `active`, `inactive`, `locked` only — `deleted` is rejected with `invalid_record_status`. |
| `delete_account` | Locked guard; FK check → `account_in_use`; soft-delete (`record_status → deleted`) |
| `restore_account` | Verifies record is in `deleted` state; sets `record_status → active` |
| `get_account_schema` | Return the type taxonomy and all sub-type enums. Response shape: `{ types: { value, label, group }[], asset_sub_types: string[], investment_sub_types: string[], liability_sub_types: string[], subtypes_by_type: { [type]: string[] }, subtype_labels: { [subtype]: string }, type_labels: { [type]: string } }` — no longer used by the app (forms use `get_account_form_options`; schemas arrive in `get_app_context`) |

## Error codes

| Code | Triggered by | Meaning |
|---|---|---|
| `missing_account_name` | create, update | `account_name` is blank |
| `missing_local_currency` | create | `account_currency_local` not provided |
| `missing_sub_type` | create | `sub_type` not provided for a type that requires one |
| `missing_opening_date_local` | create | `account_opening_date_local` is absent or empty |
| `invalid_sub_type` | create, update | `sub_type` is not valid for the given account type |
| `invalid_account_type` | create, import | Account type is blank or not a family key in the `account_types` Sheet |
| `unknown_currency` | create | `account_currency_local` is not present in the rates store (currency is immutable post-create) |
| `missing_opening_value_local` | create | `opening_value_local` is absent or null |
| `invalid_opening_value_local` | create/import | Opening value is not a finite decimal number/string |
| `invalid_id` | create/import | Supplied account ID is not a valid UUID |
| `account_id_exists` | create | The UUID already exists; use the ID-based bulk import for replacement |
| `duplicate_account_id` | bulk import | Existing Sheet rows share the same UUID, including differing letter casing |
| `invalid_local_currency` | create/import | Currency code is not three ASCII letters |
| `invalid_account_opening_date_local` | create/import | Opening date is not a valid ISO local date/datetime |
| `invalid_account_closing_date_local` | create/import/update | Closing value is invalid or earlier than opening |
| `invalid_tracking_start_date_local` | create/import | Tracking value is not a valid ISO local date/datetime |
| `invalid_local_timezone` | create/import/update | Supplied timezone is not a recognized IANA zone |
| `ambiguous_local_time`, `nonexistent_local_time` | create/import/update | Date falls inside a DST fold/gap; `field` identifies the date |
| `stale_record` | update/delete/restore | `expected_id` differs from the UUID now at that row; reload before retrying |
| `duplicate_account` | update | A rename matches another non-deleted account's `account_name`; an unchanged name is never rejected |
| `invalid_record_status` | create, update, import | `record_status` is not an allowed lifecycle value for the operation (`deleted` is never accepted on update) |
| `missing_row_num` | update, delete, restore | `row_num` not provided |
| `invalid_row` | update, delete, restore | `row_num` is out of bounds |
| `record_locked` | update, delete | Account is locked |
| `not_deleted` | restore | Account is not in `deleted` state |
| `account_in_use` | delete | Account has linked transactions and cannot be soft-deleted |
| `missing_accounts` | bulk create | `body.accounts` is missing or is not a non-empty array |
| `field_not_editable` | update | Attempted to change an immutable field. Response shape: `{ ok: false, error: 'field_not_editable', field: '<field_key>' }` — the field name is a separate property, not embedded in the error string. |

## Form behaviour

- The add and edit forms do no validation of their own. They submit what was entered; `validateAccountCreate` / `validateAccountUpdate` enforce every required field and value rule. Account validators do not yet return `message`, so the form shows its own copy for the returned code.
- Currency dropdown is populated from the rates table — adding a new currency requires adding it to `rates` first.
- Sub-type dropdown updates to the valid values for the selected type. `sub_type` is editable in the edit form.
- `local_timezone` is NOT a form input — it is auto-detected from `Intl.DateTimeFormat().resolvedOptions().timeZone` in the browser and sent silently with the create payload. It is displayed as a disabled field in view/edit.
- `account_opening_date_local` is a required datetime-local input in the add form. It is displayed as read-only text in view/edit.
- `account_closing_date_local` is not shown on the add form (the account is not yet closed). In edit mode it is an optional datetime-local input; in view mode it is read-only.
- `legal_entity_name` is an optional text input in the add form; shown as read-only (disabled) in view and edit (immutable after creation).
- Edit mode disables all immutable fields (greyed, not submitted).
- `record_status` edit dropdown offers only `active`, `inactive`, `locked`. `deleted` is not a selectable option; deletion is handled via the Delete action and restoration via Restore.
- Locked accounts: View only — Edit and Delete suppressed in the context menu.
- Deleted accounts: View + Restore in the context menu — Edit and Delete suppressed.

## Column positions

The sheet stores 19 columns in this order:

| # | Field | Notes |
|---|-------|-------|
| 1 | `id` | UUID; set once on create; unique per account; never changed |
| 2 | `account_name` | Editable |
| 3 | `legal_entity_name` | Set on create; immutable — represents the institution |
| 4 | `type` | Immutable after create |
| 5 | `sub_type` | Editable |
| 6 | `account_currency_local` | Immutable after create |
| 7 | `local_timezone` | Set on create from browser `Intl.DateTimeFormat`; immutable; never a user-typed field |
| 8 | `account_opening_date_local` | Set on create; stored in local time (no UTC conversion); immutable |
| 9 | `account_closing_date_local` | Optional; set via update when account is closed; editable |
| 10 | `opening_value_local` | Immutable after create; stored negative for liabilities |
| 11 | `current_value_local` | Virtual — header created by schema for column ordering only; always blank in sheet; injected at read time by `_buildAccountNetMap` |
| 12 | `description` | Editable |
| 13 | `record_status` | Editable |
| 14 | `sync_status` | Backend-stamped |
| 15 | `sync_date` | Backend-stamped |
| 16 | `sync_notes` | Backend-stamped |
| 17 | `created_at` | Backend-stamped |
| 18 | `updated_at` | Backend-stamped |
| 19 | `tracking_start_date_local` | Optional opening snapshot timestamp; immutable after creation |

Column positions are append-only — never change an existing position.

## CSV import

The Accounts import panel requires a file type and a CSV file. It sends the raw file text as `{ file_type, csv }` to `import_account_data`; the server (`importAccountDataCsv` in `account-import.gs`) parses, validates and imports it. The browser does no parsing, preview or validation. See [account-imports.md](account-imports.md) for the request/response contract, all supported types and detail-tab schemas.

For `account_master`, these columns are supported:

| Column | Required | Notes |
|---|---|---|
| `id` | No | Valid UUID; matches existing UUIDs case-insensitively. New IDs are lowercase; existing spelling is preserved to retain source references. A missing ID creates a new UUID. |
| `account_name` | Yes | Display label; import matches IDs, not names. |
| `legal_entity_name` | No | Institution name. |
| `type`, `sub_type` | Yes | Must match the account taxonomy. |
| `account_currency_local` | Yes | Normalised to uppercase; must exist in rates. |
| `local_timezone` | No | IANA timezone context. |
| `account_opening_date_local` | Yes | Real-world opening date/time. |
| `account_closing_date_local` | No | Real-world closing date/time. |
| `tracking_start_date_local` | No | Opening balance snapshot timestamp. |
| `opening_value_local` | Yes | Finite decimal amount. Signed asset/investment values are retained; liabilities become negative magnitudes. Decimal strings retain precision. |
| `record_status` | No | Supplied valid status is retained. Omitted/blank means `active` for new IDs and preserves the current status on replacement. |
| `description` | No | Notes. |

IDs are validated before account writes. A single create cannot append an existing UUID; bulk import rejects ambiguous duplicate identities already present in the Sheet. A CSV that repeats an `id` (case-insensitive) is rejected with `duplicate_id` before anything is written; rows without an `id` are not compared. Audit fields are managed by the backend. `current_value_local` is computed and is never imported. Replacements may update name, subtype, closing date, description and lifecycle. They cannot change the legal entity, type, currency, timezone, opening date/value or an existing tracking timestamp: those fields are immutable in PostgreSQL too. Semantically equal decimal/date forms and timezone aliases preserve the original stored value. Omitted optional immutable fields retain their previous value; a previously blank tracking timestamp may be initialized once. A mismatch returns `field_not_editable` with the field name before the row is written. Existing locked rows return `record_locked`; import never unlocks them.

Format errors (UUID syntax, required fields, decimal/date/timezone/status syntax, currency shape, duplicate ids) reject the whole file with `invalid_csv_rows` and `errors: ['Row N: <code>']`; nothing is written. Rows that pass then go through full account validation (taxonomy, known currency, immutable fields, locked rows), which may fail individual rows while the others are saved. Results: `N created · M updated · K failed`. Each result contains `{ line, key, ok, action?, error?, field? }`, where `line` is the row's physical line in the CSV. The panel lists failed lines; correct the file and import it again (re-importing is safe because rows match by `id`). Keep IDs stable for repeat imports; omitting IDs creates new records.
