# Expense Tracker — Production Deployment Guide

---

## Categories

### 1. Deploy backend
```bash
make api-deploy   # pick prod
```

### 2. Update CSV
Column 8 changed from `is_active` (boolean) to `record_status` (enum).
In `local/files/categories_new.csv`:
- Rename column header `is_active` → `record_status`
- Replace all `TRUE` → `active`, `FALSE` → `inactive`

### 3. Migrate sheet
1. Open prod Google Sheet → delete the **Categories** tab
2. Navigate to Categories section in the prod app — fresh 17-column tab is created automatically
3. Categories → **↑ Import** → upload updated `local/files/categories_new.csv`

### 4. Deploy frontend
```bash
git push origin main
```

### 5. Verify
- [ ] 94 categories load; money-in / money-out / transfer filters work
- [ ] Each row shows record status (●/✕) and sync status (○/↻/✓) icons in the last column
- [ ] Transfer category in Edit — source/target account type checkboxes pre-selected correctly
- [ ] Add form shows `record_status` dropdown defaulting to Active
- [ ] View mode shows sync status line below the form fields
- [ ] Create a category → sheet shows `record_status = active`, `sync_status = create-pending`
- [ ] Edit a synced category → `sync_status = update-pending`
- [ ] Edit a `create-pending` category → `sync_status` stays `create-pending`
- [ ] Delete a category → row stays in sheet with `record_status = deleted`; table shows it dimmed with red ✕
- [ ] Export CSV — no `sync_status` or `sync_notes` columns; `record_status` present

---

## Accounts

### Changed files
| Layer | File | What changed |
|---|---|---|
| Backend | `api/account-schema.gs` | `is_active` (col 8) → `record_status` enum; `sync_status` (col 11), `sync_notes` (col 12) added |
| Backend | `api/account-core.gs` | `createAccount` sets sync cols; `updateAccount` locks guard + dup name check + sync advance; `deleteAccount` soft-delete + locked guard; `createAccountsBulk` delegates to `createAccount` |
| Backend | `api/sync-utils.gs` | `VALID_RECORD_STATUSES` includes `locked` |
| Frontend | `app/sections/accounts.js` | Full rewrite — record_status/sync icons, locked/deleted menu guards, restore flow, deactivate-instead flow |
| Frontend | `app/sections/transactions.js` | Account dropdowns now filter by `record_status === 'active'` (was `is_active === true`) |
| Frontend | `app/core/utils.js` | `ACC_COLS` updated; `recordStatusIcon` / `syncStatusIcon` fixed-size inline-flex |
| Data | `local/files/accounts_new.csv` | `is_active` column renamed to `record_status`; `true` → `active`, `false` → `inactive` |

### 1. Deploy backend
```bash
make api-deploy   # pick prod
```
Files deployed: `account-schema.gs`, `account-core.gs`, `sync-utils.gs`, `app-router.gs`

### 2. Migrate sheet
1. Open prod Google Sheet → delete the **Accounts** tab
2. Navigate to the Accounts section in the prod app — `getOrCreateSheet` auto-creates a fresh 12-column tab with the new schema (cols: id, name, type, sub_type, currency, opening_value, current_value, record_status, description, created_at, sync_status, sync_notes)
3. Accounts → **↑ Import** → upload `local/files/accounts_new.csv`

The CSV at `local/files/accounts_new.csv` is already prepared:
- Column `is_active` renamed to `record_status`; `true` → `active`, `false` → `inactive`
- Finio split: Finio-1 (inactive) + Finio-2 (active)
- 20 accounts total

### 3. Deploy frontend
```bash
git push origin main
```
Files changed: `app/sections/accounts.js`, `app/sections/transactions.js`, `app/core/utils.js`

### 4. Verify
**Accounts section**
- [ ] 20 accounts load; Assets / Investments / Liabilities group headers render with totals
- [ ] Each row shows record status icon (● green / ● grey / 🗑️ / 🔒) and sync status icon (○ amber / ↻ blue / ✓ green) — both 16×16, aligned
- [ ] Inactive account (Finio-1) is dimmed (opacity 0.5); deleted account dimmed (opacity 0.5); locked dimmed (opacity 0.7)
- [ ] Net worth summary excludes deleted accounts from totals
- [ ] **View form** — shows sync status line below notes; Edit button absent for locked and deleted records; Restore button present for deleted records
- [ ] **Context menu** — locked: View + Transactions only; deleted: View + Transactions + Restore; active/inactive: full menu
- [ ] **Create** → sheet shows `record_status = active`, `sync_status = create-pending`, `sync_notes = ''`
- [ ] **Edit** (rename to existing name) → returns `duplicate_account` error shown in form
- [ ] **Edit** (any field on locked) → returns `record_locked`; FE shows error (menu should have blocked this)
- [ ] **Edit** synced account → `sync_status = update-pending`; `sync_notes = ''`
- [ ] **Edit** `create-pending` account → `sync_status` stays `create-pending`
- [ ] **Delete** account with no transactions → row stays in sheet with `record_status = deleted`; dimmed with 🗑️
- [ ] **Delete** account with transactions → "Cannot delete — N transactions refer…" with "Deactivate instead" button
- [ ] **Deactivate instead** → `record_status = inactive`; account stays visible, dimmed
- [ ] **Restore** deleted account → runs dup name check; on success `record_status = active`, `sync_status` advanced
- [ ] **Restore** deleted account whose name now conflicts → shows "Cannot restore: an account with this name already exists."
- [ ] Export CSV — columns are: name, type, sub_type, currency, opening_value, current_value, record_status, description — no `sync_status` or `sync_notes`
- [ ] Empty export guard: if no accounts, shows warn message instead of opening format picker

**Transactions section (regression)**
- [ ] Add Transaction form — source account dropdown shows only `active` accounts
- [ ] Edit Transaction form — source/target account dropdowns show only `active` accounts
- [ ] Inactive and deleted accounts do NOT appear in any transaction account dropdown

---
