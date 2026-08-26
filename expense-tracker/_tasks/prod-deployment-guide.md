# Expense Tracker — Production Deployment Guide

---

## Categories

### Changed files

| Layer    | File                          | What changed                                                                                      |
| -------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Backend  | `api/category-schema.gs`      | `record_status` enum includes `locked`; `sync_status` (col 16), `sync_notes` (col 17) added      |
| Backend  | `api/category-core.gs`        | Soft-delete; locked guard on update/delete; `sync_status` advanced on every mutation              |
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
2. Navigate to Categories in the prod app — `getOrCreateSheet` auto-creates a fresh 17-column tab
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
- [ ] Create a category → sheet: `record_status = active`, `sync_status = create-pending`
- [ ] Edit a synced category → `sync_status = update-pending`
- [ ] Edit a `create-pending` category → `sync_status` stays `create-pending`
- [ ] Delete a category → row stays in sheet with `record_status = deleted`; table shows it dimmed with 🗑️
- [ ] Locked category → context menu shows View only; edit/delete blocked at backend
- [ ] Restore deleted category → dup check runs; `record_status = active` on success
- [ ] Export CSV — no `sync_status` or `sync_notes` columns; `record_status` present

---

## Accounts

### Changed files

| Layer    | File                            | What changed                                                                                                         |
| -------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Backend  | `api/account-schema.gs`         | `is_active` (col 8) → `record_status` enum; `sync_status` (col 11), `sync_notes` (col 12) added                    |
| Backend  | `api/account-core.gs`           | `createAccount` sets sync cols; `updateAccount` locked guard + dup name check + sync advance; `deleteAccount` soft-delete + locked guard |
| Backend  | `api/sync-utils.gs`             | `VALID_RECORD_STATUSES` includes `locked`                                                                            |
| Frontend | `app/sections/accounts.js`      | `record_status` / sync icons; locked/deleted menu guards; restore flow; deactivate-instead flow                      |
| Frontend | `app/sections/transactions.js`  | Account dropdowns filter by `record_status === 'active'` (was `is_active === true`)                                  |
| Frontend | `app/core/utils.js`             | `ACC_COLS` updated; `recordStatusIcon` / `syncStatusIcon` fixed-size inline-flex                                     |
| Data     | `local/files/accounts_new.csv`  | `is_active` → `record_status`; `true` → `active`, `false` → `inactive`; Finio split into Finio-1 / Finio-2          |

### 1. Deploy backend

```bash
make api-deploy   # pick prod
```

Files: `account-schema.gs`, `account-core.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet

1. Open prod Google Sheet → delete the **Accounts** tab
2. Navigate to Accounts in the prod app — `getOrCreateSheet` auto-creates a fresh 12-column tab
   (cols: `id`, `name`, `type`, `sub_type`, `currency`, `opening_value`, `current_value`, `record_status`, `description`, `created_at`, `sync_status`, `sync_notes`)
3. Accounts → **↑ Import** → upload `local/files/accounts_new.csv`

The CSV is already prepared: 20 accounts, `is_active` renamed to `record_status`, Finio split.

### 3. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/accounts.js`, `app/sections/transactions.js`, `app/core/utils.js`

### 4. Verify

**Accounts section**

- [ ] 20 accounts load; Assets / Investments / Liabilities group headers render with totals
- [ ] Each row shows record status icon (● green / ● grey / 🗑️ / 🔒) and sync status icon — both 16×16, aligned
- [ ] Inactive dimmed at 0.5; deleted dimmed at 0.5; locked dimmed at 0.7
- [ ] Net worth summary excludes deleted accounts from totals
- [ ] View form — sync status line shown; Edit absent for locked and deleted; Restore present for deleted
- [ ] Context menu — locked: View + Transactions only; deleted: View + Transactions + Restore; others: full menu
- [ ] Create → sheet: `record_status = active`, `sync_status = create-pending`, `sync_notes = ''`
- [ ] Edit (rename to existing name) → `duplicate_account` error shown in form
- [ ] Edit synced account → `sync_status = update-pending`; `sync_notes = ''`
- [ ] Edit `create-pending` account → `sync_status` stays `create-pending`
- [ ] Delete account with no transactions → `record_status = deleted`; dimmed with 🗑️
- [ ] Delete account with transactions → blocked; "Deactivate instead" button shown
- [ ] Deactivate instead → `record_status = inactive`; account visible, dimmed
- [ ] Restore deleted account → dup name check runs; `record_status = active` on success
- [ ] Restore where name conflicts → "Cannot restore: an account with this name already exists."
- [ ] Export CSV — columns: `name, type, sub_type, currency, opening_value, current_value, record_status, description`; no sync cols

**Transactions regression**

- [ ] Add Transaction — source account dropdown shows only `active` accounts
- [ ] Edit Transaction — source/target account dropdowns show only `active` accounts
- [ ] Inactive and deleted accounts do NOT appear in any transaction dropdown

---

## Transactions

### Changed files

| Layer    | File                              | What changed                                                                                                                    |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Backend  | `api/transaction-schema.gs`       | 21-column schema; `tx_timezone` (col 3), location cols (7–11), `beneficiaries` (col 19), `sync_status` (col 20), `sync_notes` (col 21) |
| Backend  | `api/transaction-core.gs`         | Writes all new fields; sets `sync_status = 'create-pending'` on create, advances via `computeSyncStatus` on update             |
| Backend  | `api/transaction-validation.gs`   | Fixed `_findCategoryHints`: stale `catColIndex` keys renamed; `workflow_type` lookup removed                                    |
| Backend  | `api/transaction-utils.gs`        | Removed dead `applyFxNote` function                                                                                             |
| Frontend | `app/sections/transactions.js`    | Fixed category dropdowns (`is_active` → `record_status`); removed all `?.` optional chaining (122 occurrences)                 |

### Sheet migration — MANUAL STEP (dev first, then prod)

The Transactions tab **cannot be dropped and recreated** — it holds live data. Columns must be inserted manually in Google Sheets.

**Target schema — 21 columns:**

| Col | Name                    | Action vs old sheet                         |
| --- | ----------------------- | ------------------------------------------- |
| 1   | `id`                    | no change                                   |
| 2   | `tx_date_time`          | no change                                   |
| 3   | `tx_timezone`           | **INSERT** — blank for existing rows        |
| 4   | `tx_type`               | was col 3                                   |
| 5   | `source_account`        | was col 4                                   |
| 6   | `target_account`        | was col 5                                   |
| 7   | `user_location_area`    | **INSERT** — blank                          |
| 8   | `user_location_city`    | **INSERT** — blank                          |
| 9   | `user_location_country` | **INSERT** — blank                          |
| 10  | `user_location_latitude`| **INSERT** — blank                          |
| 11  | `user_location_longitude`| **INSERT** — blank                         |
| 12  | `amount`                | was col 6                                   |
| 13  | `currency`              | was col 7                                   |
| 14  | `major_category`        | was col 8                                   |
| 15  | `minor_category`        | was col 9                                   |
| 16  | `description`           | was col 10                                  |
| 17  | `counterparty_name`     | was col 11                                  |
| 18  | `tx_tags`               | was col 12                                  |
| 19  | `beneficiaries`         | was col 13 (if present) or **INSERT** blank |
| 20  | `sync_status`           | **INSERT** — blank for existing rows        |
| 21  | `sync_notes`            | **INSERT** — blank                          |

**Steps:**

1. Open Google Sheet → Transactions tab
2. Right-click col C header → "Insert 1 column left" → set C1 = `tx_timezone`; leave data rows blank
3. Right-click col G header → "Insert 5 columns left" → set G1–K1 = `user_location_area`, `user_location_city`, `user_location_country`, `user_location_latitude`, `user_location_longitude`; leave data rows blank
4. Confirm `beneficiaries` is now col S (19); if it didn't exist, insert a blank column at S with that header
5. Set T1 = `sync_status`, U1 = `sync_notes`; leave data rows blank
6. Row 1 should now read: `id | tx_date_time | tx_timezone | tx_type | source_account | target_account | user_location_area | … | sync_notes`
7. Spot-check 3 data rows — confirm amounts, categories, and accounts are still in the correct columns

### 1. Deploy backend

```bash
make api-deploy   # pick dev/prod
```

Files: `transaction-schema.gs`, `transaction-core.gs`, `transaction-validation.gs`, `transaction-utils.gs`, `app-router.gs`

### 2. Deploy frontend

```bash
git push origin main
```

Files: `app/sections/transactions.js`

### 3. Verify

- [ ] Transaction list loads; existing transactions display correctly (amounts, categories, dates)
- [ ] Add transaction — major/minor category dropdowns populate (was broken by `is_active` bug)
- [ ] Add transaction — form submits without error (was broken by `catColIndex` crash)
- [ ] Add transaction — source account dropdown shows only `active` accounts
- [ ] New transaction in sheet: col 3 = timezone, cols 7–11 = location, col 20 = `sync_status = create-pending`, col 21 blank
- [ ] Edit transaction → `sync_status` advances to `update-pending`
- [ ] `tx_timezone`, location fields, `beneficiaries` save correctly for new transactions
- [ ] Existing rows with blank location/timezone cols display without error
- [ ] View, delete, filter by account / category / type all unaffected
