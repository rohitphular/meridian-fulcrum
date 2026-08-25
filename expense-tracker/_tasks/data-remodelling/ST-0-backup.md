# ST-0 — Take a backup before any changes

**Type:** User action (no code)
**Must complete before:** ST-1
**Blocks:** Everything

---

## What to do

Before touching any code or the sheet, capture the current state of live data so there is a recovery path if anything goes wrong.

### 1. Duplicate the transactions sheet tab

In the live Google Sheet (prod):
- Right-click the `transactions` tab → **Duplicate**
- Rename the copy to `transactions_backup_YYYYMMDD` (use today's date)
- Move it to the rightmost position so it does not interfere with the app

This is the fastest rollback path — if the sheet migration (ST-5) corrupts the live tab, the backup tab contains the original data in the original column order.

### 2. Export a CSV snapshot

In the live `transactions` tab:
- File → Download → Comma-separated values (.csv)
- Save it locally as `transactions_backup_YYYYMMDD.csv`

This gives an offline copy that survives even if the Google Sheet itself is accidentally deleted.

---

## Done when

- A duplicate tab exists in the sheet named `transactions_backup_YYYYMMDD`
- A CSV file is saved locally

Do not proceed to ST-1 until both are done.
