# ST-6 — Deploy frontend

**Type:** Deploy
**Depends on:** ST-5 (GAS deployed and verified on dev), ST-3 (frontend code prepared)
**File:** `app/sections/transactions.js`

---

## Deploy

Frontend auto-deploys via GitHub Pages on push to `main`:

```bash
git add app/sections/transactions.js
git push
```

Wait for GitHub Actions to complete (usually under 2 minutes). Then verify on the live URL.

---

## Smoke test

### Create form
- fx_rate input is gone
- Timezone input is present and optional
- Latitude / Longitude inputs are present with a Detect button
- Clicking Detect fills both coordinates (requires location permission in browser)
- Beneficiaries input is present and optional
- Submit creates a transaction; check the sheet — all 21 columns populated correctly

### Edit form
- Same field checks as create
- After saving, sheet column 20 = `update-pending`, column 21 = blank

### Transaction cards
- `sync_status` badge appears on each card (value: `create-pending`)
- No `sync-failure` badge yet (expected — ledger-extract hasn't run)

### Bulk import
- Column hint shows the new 21-column list

### Filter panel
- Country / City / Area filters still work (now bound to `user_location_country`, `user_location_city`, `user_location_area`)

### Regression check
- Tags field still filters correctly (now `tx_tags`)
- Location fields display correctly on existing transaction cards (renamed from `tx_location_*`)
- Existing transactions with `tx_location_area/city/country` data show correctly (field rename is purely in GAS + frontend; data in the sheet headers was renamed in ST-4)

---

## Done when

- Frontend is live on GitHub Pages
- All smoke test items above pass
- No console errors in the browser for any transaction operation
