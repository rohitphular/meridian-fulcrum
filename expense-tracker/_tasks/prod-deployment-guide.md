# Expense Tracker — Production Deployment Guide

---

## Categories

### 1. Deploy backend
```bash
make api-deploy   # pick prod
```

### 2. Update CSV
Column 8 changed from `is_active` (boolean) to `record_status` (enum).
In `local/files/categories_current_v2.csv`:
- Rename column header `is_active` → `record_status`
- Replace all `TRUE` → `active`, `FALSE` → `inactive`

### 3. Migrate sheet
1. Open prod Google Sheet → delete the **Categories** tab
2. Navigate to Categories section in the prod app — fresh 17-column tab is created automatically
3. Categories → **↑ Import** → upload updated `local/files/categories_current_v2.csv`

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
