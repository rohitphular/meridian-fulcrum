# ST-5 — Deploy GAS immediately after sheet migration

**Type:** Deploy
**Depends on:** ST-4 (sheet migration verified)
**Must complete within minutes of ST-4**
**Files:** `api/transaction-schema.gs`, `api/transaction-core.gs` (prepared in ST-2)

---

## Context

This is the most time-sensitive step. The sheet now has 21 columns in the new order. The live GAS code still has the old 16-column schema. Every transaction created or edited in this window writes to wrong columns. Deploy immediately.

---

## Dev deploy

```bash
make api-deploy
# Select: dev
# Description: column restructure — 21-column schema
```

---

## Quick smoke test on dev

Before deploying to prod:

1. **Create a transaction** → open the sheet and verify:
   - Column 3 = `tx_timezone` has the submitted value (or blank)
   - Column 12 = `amount` has the correct amount (not in the old position)
   - Column 20 = `sync_status` is `create-pending`
   - Column 21 = `sync_notes` is blank
   - No other column has unexpected data

2. **Edit the transaction** → verify:
   - Column 20 = `sync_status` is now `update-pending`
   - Column 21 = `sync_notes` is blank (cleared)

3. **Delete the transaction** → verify it is removed cleanly.

4. **Read an existing transaction** → verify the data reads back correctly. Check that `major_category` (now at col 14) shows the right value for an existing row.

---

## Prod deploy (after dev is verified)

Repeat the sheet migration (ST-4) on the prod Google Sheet, then:

```bash
make api-deploy
# Select: prod
# Description: column restructure — 21-column schema
```

Run the same smoke test on prod.

---

## Done when

- Both dev and prod GAS deployments succeed
- Create / edit / delete verified on dev
- Prod sheet has 21 columns in correct order with GAS deployed
