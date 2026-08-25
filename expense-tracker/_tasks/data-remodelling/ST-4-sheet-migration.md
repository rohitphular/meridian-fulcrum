# ST-4 — Manually migrate the sheet

**Type:** User action (no code)
**Depends on:** ST-0 (backup done), ST-1 (balance workflow removed + deployed), ST-2 and ST-3 code prepared and ready to deploy immediately
**Blocks:** ST-5 deploy

---

## Pre-flight checklist

Before touching the sheet:

- [ ] ST-0 backup exists (duplicate tab + CSV export)
- [ ] ST-1 is deployed to both dev and prod (balance workflow removed)
- [ ] ST-2 and ST-3 code changes are written and staged — ready to deploy the moment this migration is complete
- [ ] **Do not create or edit any transactions after this point until the new GAS code is live.** Between the last step below and the GAS deploy in ST-5, the live GAS code runs against the new column positions and will write to wrong columns. Treat the app as read-only during this window.

---

## Perform on dev sheet first

Complete the full sequence on the dev Google Sheet. Verify in the dev app before touching prod.

---

## Migration steps — do in this exact order

Track your position after each step before moving to the next.

**Starting state: 16 columns** — id, tx_date_time, tx_type, source_account, target_account, tx_location_area, tx_location_city, tx_location_country, amount, currency, fx_rate, major_category, minor_category, tags, counterparty_name, description

---

**Step 1 — Insert `tx_timezone` column**
- Right-click the header of column C (`tx_type`) → Insert 1 column to the left
- Set the new column C header to `tx_timezone`
- Leave all data rows blank

State after: 17 columns. Column positions: ..., 2=tx_date_time, **3=tx_timezone**, 4=tx_type, ..., 12=fx_rate, ..., 17=description

---

**Steps 2–4 — Rename location column headers**
- Column G: rename `tx_location_area` → `user_location_area`
- Column H: rename `tx_location_city` → `user_location_city`
- Column I: rename `tx_location_country` → `user_location_country`

State after: 17 columns, same positions.

---

**Step 5 — Insert `user_location_latitude` column**
- Right-click the header of column J (currently `amount`) → Insert 1 column to the left
- Set header to `user_location_latitude`
- Leave data rows blank

State after: 18 columns. 10=user_location_latitude, 11=amount, 12=currency, 13=fx_rate, ...

---

**Step 6 — Insert `user_location_longitude` column**
- Right-click the header of column K (currently `amount`) → Insert 1 column to the left
- Set header to `user_location_longitude`
- Leave data rows blank

State after: 19 columns. 10=user_location_latitude, 11=user_location_longitude, 12=amount, 13=currency, **14=fx_rate**, ...

---

**Step 7 — Delete `fx_rate` column**
- `fx_rate` is now at column N (position 14)
- Right-click column N header → Delete column
- **This is irreversible. Verify the backup exists before doing this.**

State after: 18 columns. ..., 13=currency, 14=major_category, 15=minor_category, 16=tags, 17=counterparty_name, 18=description

---

**Step 8 — Move `description` to position 16**
- `description` is at column R (position 18)
- Select column R → cut (Ctrl+X) → right-click column P header (minor_category, position 15) → Insert cut cells
- `description` should now be at position 16, immediately after `minor_category`

State after: 18 columns. ..., 14=major_category, 15=minor_category, 16=description, 17=tags, 18=counterparty_name

---

**Step 9 — Move `counterparty_name` to position 17**
- `counterparty_name` is at column R (position 18)
- Select column R → cut → right-click column Q header (tags, position 17) → Insert cut cells
- `counterparty_name` should now be at position 17, immediately after `description`

State after: 18 columns. ..., 16=description, 17=counterparty_name, 18=tags

---

**Step 10 — Rename `tags` → `tx_tags`**
- Column R (position 18): rename header `tags` → `tx_tags`

---

**Step 11 — Append `beneficiaries` at position 19**
- Click the first empty column header after `tx_tags` → type `beneficiaries`
- Leave data rows blank

---

**Step 12 — Append `sync_status` at position 20**
- Next empty column → header `sync_status`
- Leave data rows blank

---

**Step 13 — Append `sync_notes` at position 21**
- Next empty column → header `sync_notes`
- Leave data rows blank

---

## Verify the final state

Count columns — must be exactly 21. Read the header row and confirm this exact order:

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
|---|---|---|---|---|---|---|---|---|----|----|----|----|----|----|----|----|----|----|----|-----|
| id | tx_date_time | tx_timezone | tx_type | source_account | target_account | user_location_area | user_location_city | user_location_country | user_location_latitude | user_location_longitude | amount | currency | major_category | minor_category | description | counterparty_name | tx_tags | beneficiaries | sync_status | sync_notes |

---

## Immediately after verifying

Proceed directly to ST-5. Do not leave the app in an inconsistent state overnight.
