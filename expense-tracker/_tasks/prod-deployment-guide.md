# Expense Tracker — Production Deployment Guide

---

## Categories

### Changed files

| Layer    | File                             | What changed                                                                                                                          |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Backend  | `api/category-schema.gs`         | 21-col schema; `id` added as col 1 (UUID, system-set, never editable); cols formerly 1–20 shifted to 2–21; `record_status` → col 16; `sync_status` → col 17; `sync_date` → col 18; `sync_notes` → col 19; `created_at` → col 20; `updated_at` → col 21 |
| Backend  | `api/category-core.gs`           | `createCategory` generates UUID via `Utilities.getUuid()` (uses caller-supplied `body.id` when present, e.g. seed import); writes `id` to col 1; returns `{ ok: true, id }`. Soft-delete; locked guard on update/delete; `sync_status` advanced on every mutation; `created_at`/`updated_at` stamped |
| Backend  | `api/sync-utils.gs`              | `VALID_RECORD_STATUSES = ['active','inactive','deleted','locked']`; `computeSyncStatus()` added                                        |
| Frontend | `app/sections/categories.js`     | `_parseCatCsv` passes `id` field through so seed CSVs with pre-assigned UUIDs flow into the bulk import API; import panel hint updated; `record_status` / sync icons; locked/deleted menu guards; restore flow |
| Frontend | `app/core/utils.js`              | `recordStatusIcon` / `syncStatusIcon` — fixed-size 16×16 inline-flex; `CAT_COLS` excludes sync                                        |
| Data     | `local/files/categories_new.csv` | 102 categories; `id` column added (pre-assigned UUIDs for cross-entity FK references); `record_status` column present                 |

### 1. Deploy backend

```bash
make api-deploy   # pick prod
```

Files: `category-schema.gs`, `category-core.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet

1. Open prod Google Sheet → delete the **Categories** tab if it exists
2. Navigate to Categories in the prod app — `getOrCreateSheet` auto-creates a fresh 21-column tab with this layout:

| Col | Field                     |
| --- | ------------------------- |
| 1   | `id`                      |
| 2   | `tx_type_key`             |
| 3   | `tx_type_label`           |
| 4   | `major_category_key`      |
| 5   | `major_category_label`    |
| 6   | `minor_category_key`      |
| 7   | `minor_category_label`    |
| 8   | `description`             |
| 9   | `tag_keywords`            |
| 10  | `counterparty_examples`   |
| 11  | `source_account_types`    |
| 12  | `target_account_types`    |
| 13  | `source_account_mandatory`|
| 14  | `target_account_mandatory`|
| 15  | `is_subscription_eligible`|
| 16  | `record_status`           |
| 17  | `sync_status`             |
| 18  | `sync_date`          |
| 19  | `sync_notes`              |
| 20  | `created_at`              |
| 21  | `updated_at`              |

3. Categories → **↑ Import** → upload `local/files/categories_new.csv`
   - The CSV has an `id` column with pre-assigned UUIDs — these are preserved in the sheet (no new UUIDs generated for seed rows)
   - Expect: 102 categories imported, 0 updated, 0 failed

### 3. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/categories.js`, `app/core/utils.js`

### 4. Verify

- [ ] 102 categories load; money-in / money-out filters work
- [ ] Sheet col 1 (`id`) is populated with a UUID for every row after import
- [ ] Each row shows record status icon and sync status icon — both 16×16, aligned
- [ ] Add form does **not** show an `id` field — user never sees or inputs `id`
- [ ] Edit form does **not** show an `id` field
- [ ] Add form shows `record_status` dropdown defaulting to Active
- [ ] View mode shows sync status line below the form fields
- [ ] Create a category → sheet col 1 = UUID (auto-generated), col 16 = `active`, col 17 = `create-pending`, col 18 blank, col 19 blank, col 20 = `created_at` ISO timestamp, col 21 = `updated_at` ISO timestamp
- [ ] API response for create returns `{ ok: true, id: '<uuid>' }`
- [ ] Edit a synced category → `sync_status = update-pending`; `updated_at` refreshed; `id` in col 1 unchanged
- [ ] Edit a `create-pending` category → `sync_status` stays `create-pending`; `updated_at` refreshed
- [ ] Delete a category → row stays in sheet with `record_status = deleted`; `updated_at` refreshed; table shows it dimmed with 🗑️; `id` unchanged
- [ ] Locked category → context menu shows View only; edit/delete blocked at backend
- [ ] Restore deleted category → dup check runs; `record_status = active` on success
- [ ] Export CSV — no `sync_status` or `sync_notes` columns; `record_status` present

---

## Accounts

### Changed files

| Layer    | File                            | What changed                                                                                                         |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Backend  | `api/account-schema.gs`         | Expanded from 14 to 18 cols; `name` → `account_name` (col 2); `legal_entity_name` added (col 3, editable: false); `type` → col 4; `sub_type` → col 5; `currency` → `local_currency` (col 6); `local_timezone` added (col 7, editable: false — system-set from browser); `opening_date_local` added (col 8, editable: false); `closing_date_local` added (col 9, editable: true); `opening_value_local` → col 10; `current_value_local` → col 11; `description` → col 12; `record_status` → col 13; `sync_status` → col 14; `sync_date` → col 15; `sync_notes` → col 16; `created_at` → col 17; `updated_at` → col 18 |
| Backend  | `api/account-core.gs`           | `createAccount`: `generateAccountId()` replaced with UUID logic (uses caller-supplied `body.id` when present — seed import path; otherwise `Utilities.getUuid()`); all new fields set (`legal_entity_name`, `local_timezone`, `opening_date_local`, `closing_date_local`); no UTC conversion on datetimes; `updateAccount` now writes `account_name`, `closing_date_local` |
| Backend  | `api/account-validation.gs`     | `body.name` → `body.account_name`, error `missing_name` → `missing_account_name`; `body.currency` → `body.local_currency`, error `missing_currency` → `missing_local_currency`; `opening_date_local` required on create → `missing_opening_date_local` |
| Frontend | `app/sections/accounts.js`      | All `a.currency` → `a.local_currency`; all `a.name` → `a.account_name`; `local_timezone` auto-detected via `Intl.DateTimeFormat().resolvedOptions().timeZone` (not a form field); `opening_date_local` datetime-local input in add form; `closing_date_local` datetime-local input in edit form; `legal_entity_name` text input in add form (read-only in view/edit); CSV parser updated for all new column names |
| Data     | `local/files/accounts_new.csv`  | `name` → `account_name`; `currency` → `local_currency`; `legal_entity_name` column added; `local_timezone` column added (GBP → `Europe/London`, INR → `Asia/Kolkata`); `opening_date` → `opening_date_local`; `closing_date` → `closing_date_local`; `id` column with pre-assigned UUIDs; 21 accounts |

### 1. Deploy backend

```bash
make api-deploy   # pick prod
```

Files: `account-schema.gs`, `account-core.gs`, `account-validation.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet

1. Open prod Google Sheet → delete the **Accounts** tab
2. Navigate to Accounts in the prod app — `getOrCreateSheet` auto-creates a fresh 18-column tab with this layout:

| Col | Field                |
| --- | -------------------- |
| 1   | `id`                 |
| 2   | `account_name`       |
| 3   | `legal_entity_name`  |
| 4   | `type`               |
| 5   | `sub_type`           |
| 6   | `local_currency`     |
| 7   | `local_timezone`     |
| 8   | `opening_date_local` |
| 9   | `closing_date_local` |
| 10  | `opening_value_local`      |
| 11  | `current_value_local`      |
| 12  | `description`        |
| 13  | `record_status`      |
| 14  | `sync_status`        |
| 15  | `sync_date`     |
| 16  | `sync_notes`         |
| 17  | `created_at`         |
| 18  | `updated_at`         |

3. Accounts → **↑ Import** → upload `local/files/accounts_new.csv`
   - The CSV has an `id` column with pre-assigned UUIDs — these are used as-is (no new UUIDs generated for seed rows)
   - `local_timezone` is populated in the CSV (`Europe/London` for GBP accounts, `Asia/Kolkata` for INR accounts)
   - Expect: 21 accounts imported, 0 skipped, 0 failed

### 3. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/accounts.js`

### 4. Verify

**Accounts section**

- [ ] 21 accounts load (20 active + 1 inactive Finio-1); Assets / Investments / Liabilities group headers render with totals
- [ ] Each row shows record status icon and sync status icon — both 16×16, aligned
- [ ] Sheet col 1 (`id`) is populated with a UUID for every row after import
- [ ] Sheet col 7 (`local_timezone`) is populated — GBP accounts have `Europe/London`, INR accounts have `Asia/Kolkata`
- [ ] Sheet col 8 (`opening_date_local`) is populated — all rows have `2026-07-24 00:00:00` (or `2026-08-17 11:40:00` for Finio-2)
- [ ] Sheet col 9 (`closing_date_local`) — Finio-1 has `2026-08-17 11:35:00`; all others blank
- [ ] Add form: shows `account_name`, `legal_entity_name`, `type`, `sub_type`, `local_currency`, `opening_date_local` (datetime-local input), `opening_value_local`, `description` — does NOT show `local_timezone` (auto-detected)
- [ ] Create an account → sheet col 1 = UUID (auto-generated), col 7 = browser timezone, col 8 = entered datetime (no UTC conversion), col 13 = `active`, col 14 = `create-pending`, col 17 = `created_at` ISO, col 18 = `updated_at` ISO
- [ ] View form: shows all fields including `local_timezone`, `opening_date_local`, `closing_date_local` (all read-only); `legal_entity_name` read-only
- [ ] Edit form: `account_name`, `sub_type`, `closing_date_local`, `description`, `record_status` are editable; all other fields are disabled
- [ ] Setting `closing_date_local` in edit form → stored as-is (no UTC conversion); col 9 updated in sheet
- [ ] Edit (rename to existing `account_name`) → `duplicate_account` error shown in form
- [ ] Edit — `sub_type` editable; invalid value for account's type returns `invalid_sub_type`
- [ ] Edit synced account → `sync_status = update-pending`; `sync_notes = ''`; `updated_at` refreshed
- [ ] Edit `create-pending` account → `sync_status` stays `create-pending`; `updated_at` refreshed
- [ ] Delete account with no transactions → `record_status = deleted`; dimmed with 🗑️; `updated_at` refreshed
- [ ] Delete account with transactions → blocked; "Deactivate instead" button shown
- [ ] Deactivate instead → `record_status = inactive`; account visible, dimmed
- [ ] Restore deleted account → dup `account_name` check runs; `record_status = active` on success
- [ ] API create returns `{ ok: true, id: '<uuid>' }`

**Filter panel**

- [ ] Filter toggle opens/closes panel
- [ ] Type filter narrows table to matching group(s)
- [ ] Sub-type trigger disabled until a Type is selected
- [ ] Currency dropdown lists only `local_currency` values present in loaded accounts
- [ ] Search matches against `account_name` and notes fields (case-insensitive substring)
- [ ] Status filter — all 4 checked by default
- [ ] Net worth summary cards remain unfiltered regardless of active filter selections
- [ ] Clear button resets all filters

**Transactions regression**

- [ ] Add Transaction — account dropdown shows only `active` accounts
- [ ] Inactive and deleted accounts do NOT appear in any transaction dropdown

---

## Transactions

### Changed files

| Layer    | File                              | What changed                                                                                                                   |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Backend  | `api/transaction-schema.gs`       | 24-col schema; `parent_tx_id` added (col 4); `account_id` replaces `source_account`+`target_account` (col 6); `tx_amount` replaces `source_amount`+`target_amount` (col 7); currency no longer stored; `tx_timezone` (col 3) marked `editable: false` — browser-detected, not a user input; `sync_date_time` renamed to `sync_date` (col 21) |
| Backend  | `api/transaction-core.gs`         | Full rewrite: create maps source/target body → 1 row (non-transfer) or 2 linked rows (transfer); `_writeSingleTransaction` uses `account_id`/`tx_amount`; `updateTransaction` takes `account_id`/`tx_amount`; `_checkDuplicate` on (tx_date_time, tx_type, account_id, tx_amount); `sync_date_time` → `sync_date` in `_writeSingleTransaction` and `createTransactionsBulk`; no UTC conversion — `tx_date_time` stored as local time (YYYY-MM-DD HH:MM) |
| Backend  | `api/transaction-validation.gs`   | `validateTransactionUpdate` checks `account_id`/`tx_amount`; `_validateFinancialRules` checks `account_id` on update path; rejects any `editable: false` field (including `tx_timezone`) if present in update body |
| Backend  | `api/account-core.gs`             | `_countTransactionsReferencingAccount` uses `account_id` (not source/target)                                                  |
| Backend  | `api/transaction-suggestions.gs`  | `outTx` augmentation uses `account_id`/`tx_amount`; suggestion output emits `account_id`; `getSuggestedTransactions` reads `acc.local_currency` (renamed from `acc.currency`) |
| Backend  | `api/advisor-core.gs`             | `_buildSnapshot` + `_fetchRequestedData` use `tx_amount`/`account_id`                                                         |
| Backend  | `api/rate-core.gs`                | `_countTransactionsWithCurrency` always returns 0 (currency no longer in transactions)                                         |
| Frontend | `app/sections/transactions.js`    | Table display uses `account_id`/`tx_amount`/sibling map for transfer arrows; edit form is single-row (one account, one amount); balance rules use post-reversal `account_id`; copy prefill reconstructs source/target from sibling; delete/view forms updated; UTC helpers (`localToUtcISO`, `utcToLocalInput`) removed — `tx_date_time` stored/read as local time directly; `tx_timezone` captured from `Intl.DateTimeFormat().resolvedOptions().timeZone` on create (not a form field); edit form shows `tx_timezone` as read-only div; account map fields renamed: `.name` → `.account_name`, `.currency` → `.local_currency`, `.current_value` → `.current_value_local` |
| Frontend | `app/core/utils.js`               | `exportData` reconstructs source/target pairs from `parent_tx_id` sibling links; skips child rows (exported via parent)       |
| Frontend | `app/core/daterange.js`           | Account filter uses `tx.account_id`; location/tag filter fields corrected to `user_location_*`/`tx_tags`                      |
| Frontend | `app/core/state.js`               | Filter keys `tx_location_*` renamed to `user_location_*` to match transaction schema                                          |

### Sheet migration — EXPORT → DROP → REIMPORT

The schema change (source/target → account_id, split transfer rows) cannot be done with column inserts. The safest migration is export-drop-reimport.

**Before starting:**

1. Open prod app → Transactions → **↓ Export → CSV** — save the file (this is the backup)
2. Verify the export has all rows and looks correct

**New 24-col schema:**

| Col | Name                      |
| --- | ------------------------- |
| 1   | `id`                      |
| 2   | `tx_date_time`            |
| 3   | `tx_timezone`             |
| 4   | `parent_tx_id`            |
| 5   | `tx_type`                 |
| 6   | `account_id`              |
| 7   | `tx_amount`               |
| 8   | `major_category`          |
| 9   | `minor_category`          |
| 10  | `description`             |
| 11  | `counterparty_name`       |
| 12  | `tx_tags`                 |
| 13  | `beneficiaries`           |
| 14  | `user_location_area`      |
| 15  | `user_location_city`      |
| 16  | `user_location_country`   |
| 17  | `user_location_latitude`  |
| 18  | `user_location_longitude` |
| 19  | `record_status`           |
| 20  | `sync_status`             |
| 21  | `sync_date`          |
| 22  | `sync_notes`              |
| 23  | `created_at`              |
| 24  | `updated_at`              |

**Migration steps:**

1. Export transactions to CSV (step above)
2. Open Google Sheet → **delete the Transactions tab**
3. Deploy the new backend (step 1 below) — `getOrCreateSheet` will auto-create a fresh 24-col tab on first request
4. Deploy the new frontend (step 2 below)
5. Navigate to Transactions in the app — the empty sheet creates with correct headers
6. Import the exported CSV in batches of ≤100 rows (import still processes row-by-row; batching avoids GAS timeout)
   - The backend `createTransactionsBulk` will split any transfer rows (those with both source_account and target_account set in the CSV) into 2 linked rows automatically

### 1. Deploy backend

```bash
make api-deploy   # pick dev/prod
```

Files: `transaction-schema.gs`, `transaction-core.gs`, `transaction-validation.gs`, `account-core.gs`, `transaction-suggestions.gs`, `advisor-core.gs`, `rate-core.gs`

### 2. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/transactions.js`, `app/core/utils.js`, `app/core/daterange.js`, `app/core/state.js`

### 3. Verify

- [ ] Transaction list loads; account column shows account name (single name, or "A → B" for transfers)
- [ ] Amount column shows `tx_amount`; transfers show correct per-leg amounts
- [ ] Add `money-out` transaction → single account dropdown, single amount; creates 1 row in sheet (col 6 = `account_id`, col 7 = `tx_amount`)
- [ ] Add `money-in` transaction → single account dropdown; creates 1 row
- [ ] Add transfer (category with both accounts mandatory) → both account dropdowns shown; creates 2 rows linked by `parent_tx_id` (col 4); money-out row is parent, money-in row has `parent_tx_id = parent.id`
- [ ] Transfer display → table shows "SourceAcc → TargetAcc" for both rows
- [ ] Add form does NOT show a timezone field — `tx_timezone` is captured silently from browser; col 3 in sheet is populated with the browser's IANA timezone after save
- [ ] `tx_date_time` (col 2) stored in local time as `YYYY-MM-DD HH:MM` — not UTC; verify directly in sheet that the value matches what was entered in the form
- [ ] Sheet col 21 header reads `sync_date` (not `sync_date_time`)
- [ ] Edit transaction → form shows single `account_id` dropdown and single `tx_amount`; transfer note shown if linked
- [ ] Edit form shows `Timezone` as a read-only text display (not an editable input); timezone cannot be changed on edit
- [ ] Edit submit → sends `account_id`/`tx_amount` (not source/target); sheet updated correctly; `tx_timezone` not sent in update body
- [ ] Delete transaction → row stays with `record_status = deleted`; `updated_at` refreshed
- [ ] Restore deleted → `record_status = active`; `updated_at` refreshed
- [ ] Copy a transfer row → add form opens with source/target reconstructed from sibling
- [ ] Export CSV → file has 18 cols in source/target format; transfer pairs merged into 1 CSV row
- [ ] Import CSV → transfer rows split into 2 sheet rows; money-out/money-in linked via `parent_tx_id`; `tx_date_time` stored as-is from CSV (no UTC conversion)
- [ ] Suggestions panel → currency symbol shown correctly (reads `local_currency` from account via suggestion object)
- [ ] Rate delete blocked → still works (currency check via accounts, not transactions)
- [ ] Account filter (in filter bar) → `account_id` filter matches correctly
- [ ] `_checkDuplicate` skips deleted rows; key = (tx_date_time, tx_type, account_id, tx_amount)
