# Expense Tracker — Production Deployment Guide

---

## Categories

### Changed files

| Layer    | File                          | What changed                                                                                      |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Backend  | `api/category-schema.gs`      | 20-col schema; cols 8–14 shifted; `record_status` → col 15; `sync_date_time` (col 17), `created_at` (col 19), `updated_at` (col 20) added |
| Backend  | `api/category-core.gs`        | Soft-delete; locked guard on update/delete; `sync_status` advanced on every mutation; `created_at`/`updated_at` stamped on create/update/delete |
| Backend  | `api/sync-utils.gs`           | `VALID_RECORD_STATUSES = ['active','inactive','deleted','locked']`; `computeSyncStatus()` added   |
| Frontend | `app/sections/categories.js`  | `record_status` / sync icons; locked/deleted menu guards; restore flow                            |
| Frontend | `app/core/utils.js`           | `recordStatusIcon` / `syncStatusIcon` — fixed-size 16×16 inline-flex; `CAT_COLS` excludes sync   |
| Data     | `local/files/categories_new.csv` | `is_active` → `record_status`; `TRUE` → `active`, `FALSE` → `inactive`                        |

### 1. Deploy backend

```bash
make api-deploy   # pick prod
```

Files: `category-schema.gs`, `category-core.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet

1. Open prod Google Sheet → delete the **Categories** tab
2. Navigate to Categories in the prod app — `getOrCreateSheet` auto-creates a fresh 20-column tab
   (cols 1–14: core/classification/account-hints/subscription; col 15: `record_status`; col 16: `sync_status`; col 17: `sync_date_time`; col 18: `sync_notes`; col 19: `created_at`; col 20: `updated_at`)
3. Categories → **↑ Import** → upload `local/files/categories_new.csv`

### 3. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/categories.js`, `app/core/utils.js`

### 4. Verify

- [ ] 94 categories load; money-in / money-out / transfer filters work
- [ ] Each row shows record status icon and sync status icon — both 16×16, aligned
- [ ] Add form shows `record_status` dropdown defaulting to Active
- [ ] View mode shows sync status line below the form fields
- [ ] Create a category → sheet col 15 = `active`, col 16 = `create-pending`, col 17 blank, col 18 blank, col 19 = `created_at` ISO timestamp, col 20 = `updated_at` ISO timestamp
- [ ] Edit a synced category → `sync_status = update-pending`; `updated_at` refreshed
- [ ] Edit a `create-pending` category → `sync_status` stays `create-pending`; `updated_at` refreshed
- [ ] Delete a category → row stays in sheet with `record_status = deleted`; `updated_at` refreshed; table shows it dimmed with 🗑️
- [ ] Locked category → context menu shows View only; edit/delete blocked at backend
- [ ] Restore deleted category → dup check runs; `record_status = active` on success
- [ ] Export CSV — no `sync_status` or `sync_notes` columns; `record_status` present

---

## Accounts

### Changed files

| Layer    | File                            | What changed                                                                                                         |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Backend  | `api/account-schema.gs`         | 14-col schema; `description` → col 8, `record_status` → col 9, `sync_status` → col 10, `sync_date_time` (col 11) added, `sync_notes` → col 12, `created_at` → col 13, `updated_at` (col 14) added; `sub_type.editable = true` |
| Backend  | `api/account-core.gs`           | `createAccount` stamps `sync_date_time` + `updated_at`; `updateAccount` writes `sub_type` + locked guard + dup name check + stamps `updated_at`; `deleteAccount` soft-delete + locked guard + stamps `updated_at` |
| Backend  | `api/account-validation.gs`     | `validateAccountUpdate` validates `sub_type` value against allowed set for the account's type                        |
| Backend  | `api/sync-utils.gs`             | `VALID_RECORD_STATUSES` includes `locked`                                                                            |
| Frontend | `app/sections/accounts.js`      | `record_status` / sync icons; locked/deleted menu guards; restore flow; deactivate-instead flow; filter panel (type / sub-type / currency / search / status); base-amount `/` removed from JS (now CSS `::before`) |
| Frontend | `app/sections/transactions.js`  | Account dropdowns filter by `record_status === 'active'` (was `is_active === true`)                                  |
| Frontend | `app/core/utils.js`             | `ACC_COLS` — `description` before `record_status`; `recordStatusIcon` / `syncStatusIcon` fixed-size inline-flex      |
| Frontend | `app/core/state.js`             | `accFilterOpen` + `accFilters` (`type`, `subType`, `currency`, `search`, `recordStatuses`) added                     |
| Frontend | `app/style/expense-tracker.css` | `.td-base-amt::before` injects `/ ` on web; `.acc-card-bal .td-base-amt` hidden on mobile cards                     |
| Data     | `local/files/accounts_new.csv`  | `is_active` → `record_status`; `true` → `active`, `false` → `inactive`; Finio split into Finio-1 / Finio-2          |

### 1. Deploy backend

```bash
make api-deploy   # pick prod
```

Files: `account-schema.gs`, `account-core.gs`, `account-validation.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet

1. Open prod Google Sheet → delete the **Accounts** tab
2. Navigate to Accounts in the prod app — `getOrCreateSheet` auto-creates a fresh 14-column tab
   (cols: `id`, `name`, `type`, `sub_type`, `currency`, `opening_value`, `current_value`, `description`, `record_status`, `sync_status`, `sync_date_time`, `sync_notes`, `created_at`, `updated_at`)
3. Accounts → **↑ Import** → upload `local/files/accounts_new.csv`

The CSV is already prepared: 20 accounts, `is_active` renamed to `record_status`, Finio split.

### 3. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/accounts.js`, `app/sections/transactions.js`, `app/core/utils.js`, `app/core/state.js`, `app/style/expense-tracker.css`

### 4. Verify

**Accounts section**

- [ ] 20 accounts load; Assets / Investments / Liabilities group headers render with totals
- [ ] Each row shows record status icon (● green / ● grey / 🗑️ / 🔒) and sync status icon — both 16×16, aligned
- [ ] Inactive dimmed at 0.5; deleted dimmed at 0.5; locked dimmed at 0.7
- [ ] Net worth summary excludes deleted accounts from totals
- [ ] View form — sync status line shown; Edit absent for locked and deleted; Restore present for deleted
- [ ] Context menu — locked: View + Transactions only; deleted: View + Transactions + Restore; others: full menu
- [ ] Create → sheet col 9 = `active`, col 10 = `create-pending`, col 11 blank, col 12 blank, col 13 = `created_at` ISO, col 14 = `updated_at` ISO
- [ ] Edit (rename to existing name) → `duplicate_account` error shown in form
- [ ] Edit — `sub_type` is editable; changing to an invalid value for the account's type returns `invalid_sub_type`
- [ ] Edit synced account → `sync_status = update-pending`; `sync_notes = ''`; `updated_at` refreshed
- [ ] Edit `create-pending` account → `sync_status` stays `create-pending`; `updated_at` refreshed
- [ ] Delete account with no transactions → `record_status = deleted`; dimmed with 🗑️; `updated_at` refreshed
- [ ] Delete account with transactions → blocked; "Deactivate instead" button shown
- [ ] Deactivate instead → `record_status = inactive`; account visible, dimmed
- [ ] Restore deleted account → dup name check runs; `record_status = active` on success
- [ ] Restore where name conflicts → "Cannot restore: an account with this name already exists."
- [ ] Export CSV — columns: `name, type, sub_type, currency, opening_value, current_value, description, record_status`; no sync cols
- [ ] Web UI balance: foreign-currency accounts show `−₹200,000.00 / £1,904.76` inline; base-currency accounts show primary value only
- [ ] Mobile UI balance: primary value only (no grey converted value, no `/`)

**Filter panel**

- [ ] Filter toggle opens/closes panel positioned below net worth summary cards
- [ ] Filter badge `(N)` appears on toggle button when any filter deviates from default
- [ ] Type filter (Asset / Investment / Liability) narrows table to matching group(s) only
- [ ] Sub-type trigger is disabled (greyed out) until a Type is selected; options repopulate based on selected type
- [ ] Currency dropdown lists only currencies present in loaded accounts
- [ ] Search matches against account name and notes fields (case-insensitive substring)
- [ ] Status filter — all 4 checked by default; unchecking a status hides those accounts from the table
- [ ] Net worth summary cards remain unfiltered regardless of active filter selections
- [ ] "No accounts match the current filters." placeholder shown when filtered list is empty
- [ ] Clear button resets all filters and re-renders with full list; Search applies pending selections
- [ ] Selecting options then clicking Search applies them correctly; re-opening panel shows applied values; further changes work without requiring panel close/reopen

**Transactions regression**

- [ ] Add Transaction — source account dropdown shows only `active` accounts
- [ ] Edit Transaction — source/target account dropdowns show only `active` accounts
- [ ] Inactive and deleted accounts do NOT appear in any transaction dropdown

---

## Transactions

### Changed files

| Layer    | File                              | What changed                                                                                                                   |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Backend  | `api/transaction-schema.gs`       | 24-col schema; `parent_tx_id` added (col 4); `account_id` replaces `source_account`+`target_account` (col 6); `tx_amount` replaces `source_amount`+`target_amount` (col 12); currency no longer stored |
| Backend  | `api/transaction-core.gs`         | Full rewrite: create maps source/target body → 1 row (non-transfer) or 2 linked rows (transfer); `_writeSingleTransaction` uses `account_id`/`tx_amount`; `updateTransaction` takes `account_id`/`tx_amount`; `_checkDuplicate` on (tx_date_time, tx_type, account_id, tx_amount) |
| Backend  | `api/transaction-validation.gs`   | `validateTransactionUpdate` checks `account_id`/`tx_amount`; `_validateFinancialRules` checks `account_id` on update path    |
| Backend  | `api/account-core.gs`             | `_countTransactionsReferencingAccount` uses `account_id` (not source/target)                                                  |
| Backend  | `api/transaction-suggestions.gs`  | `outTx` augmentation uses `account_id`/`tx_amount`; suggestion output emits `account_id`                                      |
| Backend  | `api/advisor-core.gs`             | `_buildSnapshot` + `_fetchRequestedData` use `tx_amount`/`account_id`                                                         |
| Backend  | `api/rate-core.gs`                | `_countTransactionsWithCurrency` always returns 0 (currency no longer in transactions)                                         |
| Frontend | `app/sections/transactions.js`    | Table display uses `account_id`/`tx_amount`/sibling map for transfer arrows; edit form is single-row (one account, one amount); balance rules use post-reversal `account_id`; copy prefill reconstructs source/target from sibling; delete/view forms updated |
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
| 21  | `sync_date_time`          |
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
- [ ] Add `money-out` transaction → single account dropdown, single amount; creates 1 row in sheet (col 6 = `account_id`, col 12 = `tx_amount`)
- [ ] Add `money-in` transaction → single account dropdown; creates 1 row
- [ ] Add transfer (category with both accounts mandatory) → both account dropdowns shown; creates 2 rows linked by `parent_tx_id` (col 4); money-out row is parent, money-in row has `parent_tx_id = parent.id`
- [ ] Transfer display → table shows "SourceAcc → TargetAcc" for both rows
- [ ] Edit transaction → form shows single `account_id` dropdown and single `tx_amount`; transfer note shown if linked
- [ ] Edit submit → sends `account_id`/`tx_amount` (not source/target); sheet updated correctly
- [ ] Delete transaction → row stays with `record_status = deleted`; `updated_at` refreshed
- [ ] Restore deleted → `record_status = active`; `updated_at` refreshed
- [ ] Copy a transfer row → add form opens with source/target reconstructed from sibling
- [ ] Export CSV → file has 18 cols in source/target format; transfer pairs merged into 1 CSV row
- [ ] Import CSV → transfer rows split into 2 sheet rows; money-out/money-in linked via `parent_tx_id`
- [ ] Rate delete blocked → still works (currency check via accounts, not transactions)
- [ ] Account filter (in filter bar) → `account_id` filter matches correctly
- [ ] `_checkDuplicate` skips deleted rows; key = (tx_date_time, tx_type, account_id, tx_amount)
