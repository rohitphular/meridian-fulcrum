# Expense Tracker — Production Deployment Guide

---

## Categories

### 1. Deploy backend
```bash
make api-deploy   # pick prod
```

### 2. Migrate sheet
1. Open prod Google Sheet → delete the **Categories** tab
2. Navigate to Categories section in the prod app — fresh 17-column tab is created automatically
3. Categories → **↑ Import** → upload `local/files/categories_current_v2.csv`

### 3. Deploy frontend
```bash
git push origin main
```

### 4. Verify
- [ ] 94 categories load; money-in / money-out / transfer filters work
- [ ] Transfer category in Edit — source/target account type checkboxes pre-selected correctly
- [ ] Create a category → sheet shows `sync_status = create-pending`
- [ ] Edit a synced category → `sync_status = update-pending`
- [ ] Edit a `create-pending` category → `sync_status` stays `create-pending`
- [ ] Export CSV — no `sync_status` or `sync_notes` columns

---
