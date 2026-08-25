# TASK — transaction sheet alignment for ledger-extract

**Status:** PENDING
**Required by:** `ledger-extract` transactions module — cannot run until the sheet has the correct 21-column structure
**Derives from:** `data-synchronization/ledger-extract/_tasks/TASK-transactions.md` — "Required changes to the sheet" and "Source schema" sections

---

## Context

The `ledger-extract` transactions module reads from the `transactions` sheet tab and writes sync results back to it. It expects a specific 21-column layout. The current sheet has 16 columns with different names and a different order.

This task aligns the expense-tracker (GAS backend + frontend) with that expected layout. It is purely structural — no business logic changes, no new features, no balance or workflow changes.

---

## Open questions

None — all design decisions confirmed below.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | `sync_status` — who sets it and to what on each operation | GAS sets `create-pending` on `createTransaction`; sets `update-pending` (and clears `sync_notes`) on `updateTransaction`. Read-only in the UI — not user-editable. The ledger-extract owns `in-sync` and `sync-failure` states. |
| Q2 | `deleteTransaction` — soft or hard delete | Retain the existing hard-delete (`sheet.deleteRow`). Transactions that were already synced (`in-sync`) and then deleted from the app remain in the DB with `tx_status = 'active'` until the archival process handles them. This is a known limitation — acceptable for now because the archival process is a future build. |
| Q3 | `sync_notes` on update | Cleared to `''` on every `updateTransaction` so stale failure notes from a previous run do not persist after the user fixes and resubmits. |
| Q4 | `beneficiaries` field validation in GAS | Optional at the GAS layer — accept any string, including blank. The ledger-extract validates and writes `sync-failure: beneficiary_required` if blank. No GAS-side enforcement. |
| Q5 | `tx_timezone` field validation in GAS | Optional at the GAS layer — accept any string. Blank means Europe/London (resolved by ledger-extract). No IANA validation in GAS. |
| Q6 | `sync_status` display in the UI | Show as a read-only badge on each transaction card (values: `create-pending`, `update-pending`, `in-sync`, `sync-failure`). Colour-coded: `in-sync` → success token; `sync-failure` → danger token; pending states → muted token. `sync_notes` shown as tooltip or sub-line on `sync-failure` rows. |
| Q7 | New columns that GAS never writes | `sync_status` is written by GAS on create/update. `sync_notes` is written by GAS on update (cleared only). `tx_timezone` and `beneficiaries` are written by the user via the UI. Ledger-extract writes `sync_status` and `sync_notes` directly via the Sheets API — GAS does not need to proxy these. |
| Q8 | `getOrCreateSheet` behaviour for new columns | `getOrCreateSheet` auto-appends missing headers but does not rename existing ones or reorder. The sheet migration (rename + reorder) must be done manually on the dev and prod Google Sheets before deploying the new GAS build. GAS deploy must happen only after the sheet is migrated. |

---

## Current schema vs target schema

Current: 16 columns. Target: 21 columns (`fx_rate` dropped; `tx_timezone`, `user_location_latitude`, `user_location_longitude`, `beneficiaries`, `sync_status`, `sync_notes` added).

| Position | Current column | Target column | Change |
|----------|---------------|---------------|--------|
| 1 | `id` | `id` | unchanged |
| 2 | `tx_date_time` | `tx_date_time` | unchanged |
| 3 | `tx_type` | `tx_timezone` | new column inserted |
| 4 | `source_account` | `tx_type` | shifted |
| 5 | `target_account` | `source_account` | shifted |
| 6 | `tx_location_area` | `target_account` | shifted |
| 7 | `tx_location_city` | `user_location_area` | shifted + renamed |
| 8 | `tx_location_country` | `user_location_city` | shifted + renamed |
| 9 | `amount` | `user_location_country` | shifted + renamed |
| 10 | `currency` | `user_location_latitude` | new column inserted |
| 11 | `fx_rate` | `user_location_longitude` | new column inserted; `fx_rate` dropped — delete the column |
| 12 | `major_category` | `amount` | shifted |
| 13 | `minor_category` | `currency` | shifted |
| 14 | `tags` | `major_category` | shifted |
| 15 | `counterparty_name` | `minor_category` | shifted |
| 16 | `description` | `description` | position unchanged (net shifts coincidentally cancel) |
| — | — | `counterparty_name` | moved to 17 |
| — | — | `tx_tags` | renamed from `tags`, at 18 |
| — | — | `beneficiaries` | new column at 19 |
| — | — | `sync_status` | new column at 20 |
| — | — | `sync_notes` | new column at 21 |

---

## What to build

### Step 0 — Manual sheet migration (before any GAS deploy)

Perform these changes directly on the Google Sheet (both dev and prod) before deploying the updated GAS code. GAS code is position-driven — if the sheet headers don't match `TRANSACTION_SCHEMA`, every read and write will land in the wrong column.

**Order matters — do in this sequence:**

1. Insert a new column at position 3 (after `tx_date_time`); set header `tx_timezone`
2. Rename column header `tx_location_area` → `user_location_area`
3. Rename column header `tx_location_city` → `user_location_city`
4. Rename column header `tx_location_country` → `user_location_country`
5. Insert a new column at position 10 (after `user_location_country`); set header `user_location_latitude`
6. Insert a new column at position 11 (after `user_location_latitude`); set header `user_location_longitude`
7. Delete the `fx_rate` column (after steps 1, 5, 6 it now sits at position 14)
8. Move the `description` column (after step 7 it sits at position 18) to position 16 — drag and drop it immediately after `minor_category`
9. Move the `counterparty_name` column (after step 8 it sits at position 18) to position 17 — drag and drop it immediately after `description`
10. Rename column header `tags` → `tx_tags` (after step 9 it sits at position 18)
11. Append a new column at position 19; set header `beneficiaries`
12. Append a new column at position 20; set header `sync_status`
13. Append a new column at position 21; set header `sync_notes`

After migration the sheet must have exactly 21 columns in the order shown in the schema table above.

For existing rows: leave `sync_status`, `sync_notes`, `tx_timezone`, `beneficiaries` blank — blank `sync_status` is not processed by ledger-extract (only `create-pending` and `update-pending` are). Existing synced data in the DB is unaffected.

---

### Step 1 — `api/transaction-schema.gs`

Rewrite `TRANSACTION_SCHEMA` to match the 21-column target layout. All `sheet_column_position` values must update. Field key renames must match the new sheet column names exactly — GAS uses these keys for both sheet writes and frontend serialisation.

**New schema (21 fields in column order):**

```js
const TRANSACTION_SCHEMA = {

  // ── Identity (column 1) ──────────────────────────────────────────────────
  id: {
    sheet_column_name: 'id',
    sheet_column_position: 1,
    ui_label: 'ID',
    type: 'string',
    group: 'system',
    editable: false,
  },

  // ── Core (columns 2–6) ───────────────────────────────────────────────────
  tx_date_time: {
    sheet_column_name: 'tx_date_time',
    sheet_column_position: 2,
    ui_label: 'Date/Time',
    type: 'date',
    group: 'core',
    editable: true,
  },
  tx_timezone: {
    sheet_column_name: 'tx_timezone',
    sheet_column_position: 3,
    ui_label: 'Timezone',
    type: 'string',
    group: 'core',
    editable: true,
    default_value: '',
  },
  tx_type: {
    sheet_column_name: 'tx_type',
    sheet_column_position: 4,
    ui_label: 'Type',
    type: 'enum',
    enum_values: VALID_TRANSACTION_TYPES,
    group: 'core',
    editable: true,
  },
  source_account: {
    sheet_column_name: 'source_account',
    sheet_column_position: 5,
    ui_label: 'Source Account',
    type: 'string',
    group: 'core',
    editable: true,
  },
  target_account: {
    sheet_column_name: 'target_account',
    sheet_column_position: 6,
    ui_label: 'Target Account',
    type: 'string',
    group: 'core',
    editable: true,
    default_value: '',
  },

  // ── Location (columns 7–11) ───────────────────────────────────────────────
  user_location_area: {
    sheet_column_name: 'user_location_area',
    sheet_column_position: 7,
    ui_label: 'Area',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_city: {
    sheet_column_name: 'user_location_city',
    sheet_column_position: 8,
    ui_label: 'City',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_country: {
    sheet_column_name: 'user_location_country',
    sheet_column_position: 9,
    ui_label: 'Country',
    type: 'string',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_latitude: {
    sheet_column_name: 'user_location_latitude',
    sheet_column_position: 10,
    ui_label: 'Latitude',
    type: 'number',
    group: 'location',
    editable: true,
    default_value: '',
  },
  user_location_longitude: {
    sheet_column_name: 'user_location_longitude',
    sheet_column_position: 11,
    ui_label: 'Longitude',
    type: 'number',
    group: 'location',
    editable: true,
    default_value: '',
  },

  // ── Financial (columns 12–13) ─────────────────────────────────────────────
  amount: {
    sheet_column_name: 'amount',
    sheet_column_position: 12,
    ui_label: 'Amount',
    type: 'number',
    group: 'core',
    editable: true,
  },
  currency: {
    sheet_column_name: 'currency',
    sheet_column_position: 13,
    ui_label: 'Currency',
    type: 'string',
    group: 'core',
    editable: true,
    default_value: '',
  },

  // ── Categorisation (columns 14–19) ───────────────────────────────────────
  major_category: {
    sheet_column_name: 'major_category',
    sheet_column_position: 14,
    ui_label: 'Category',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  minor_category: {
    sheet_column_name: 'minor_category',
    sheet_column_position: 15,
    ui_label: 'Sub-category',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  description: {
    sheet_column_name: 'description',
    sheet_column_position: 16,
    ui_label: 'Description',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },
  counterparty_name: {
    sheet_column_name: 'counterparty_name',
    sheet_column_position: 17,
    ui_label: 'Counterparty',
    type: 'string',
    group: 'categorisation',
    applies_to: ['money-in', 'money-out'],
    editable: true,
    default_value: '',
  },
  tx_tags: {
    sheet_column_name: 'tx_tags',
    sheet_column_position: 18,
    ui_label: 'Tags',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },
  beneficiaries: {
    sheet_column_name: 'beneficiaries',
    sheet_column_position: 19,
    ui_label: 'Beneficiaries',
    type: 'string',
    group: 'categorisation',
    editable: true,
    default_value: '',
  },

  // ── Sync metadata (columns 20–21) — written by ledger-extract and GAS, never by the user ──
  sync_status: {
    sheet_column_name: 'sync_status',
    sheet_column_position: 20,
    ui_label: 'Sync Status',
    type: 'string',
    group: 'system',
    editable: false,
  },
  sync_notes: {
    sheet_column_name: 'sync_notes',
    sheet_column_position: 21,
    ui_label: 'Sync Notes',
    type: 'string',
    group: 'system',
    editable: false,
  },
};
```

Remove the `enum_values: null`, `applies_to: null`, `required_for: null` fields from entries that don't use them — they add noise without value. Keep `applies_to` only where it restricts visibility (categorisation fields for money-in/money-out only).

No changes to `getTransactionSchemaForClient()`, `getTransactionSheetColumns()`, `getFieldsForTransactionType()`, `getTransactionSchemaField()`, or `txColIndex()` — these functions are schema-driven and will pick up the changes automatically.

---

### Step 2 — `api/transaction-core.gs`

**`createTransaction`:**
- Rename all `setCol('tx_location_area', ...)` → `setCol('user_location_area', ...)`
- Rename all `setCol('tx_location_city', ...)` → `setCol('user_location_city', ...)`
- Rename all `setCol('tx_location_country', ...)` → `setCol('user_location_country', ...)`
- Rename `setCol('tags', normaliseTags(body.tags))` → `setCol('tx_tags', normaliseTags(body.tx_tags))`
- Remove `setCol('fx_rate', ...)` — `fx_rate` no longer exists in the schema
- Add `setCol('sync_status', 'create-pending')` — write immediately at row creation
- Add `setCol('sync_notes', '')` — always blank on create
- Add `setCol('tx_timezone', body.tx_timezone || '')`
- Add `setCol('user_location_latitude', body.user_location_latitude ?? '')`
- Add `setCol('user_location_longitude', body.user_location_longitude ?? '')`
- Add `setCol('beneficiaries', body.beneficiaries || '')`

**`updateTransaction`:**
- Rename all `writeField('tx_location_area', ...)` → `writeField('user_location_area', ...)`
- Rename all `writeField('tx_location_city', ...)` → `writeField('user_location_city', ...)`
- Rename all `writeField('tx_location_country', ...)` → `writeField('user_location_country', ...)`
- Rename `writeField('tags', normaliseTags(body.tags))` → `writeField('tx_tags', normaliseTags(body.tx_tags))`
- Remove `writeField('fx_rate', ...)` — `fx_rate` no longer exists in the schema
- Add `writeField('sync_status', 'update-pending')` — the `editable: false` guard in `writeField` blocks this. Write it directly via `sheet.getRange(rowNum, txColIndex('sync_status') + 1).setValue('update-pending')` — or add a dedicated `_writeSyncStatus` helper that bypasses the editable check
- Add `sheet.getRange(rowNum, txColIndex('sync_notes') + 1).setValue('')` — clear sync_notes on update
- Add `writeField('tx_timezone', body.tx_timezone || '')`
- Add `writeField('user_location_latitude', body.user_location_latitude ?? '')`
- Add `writeField('user_location_longitude', body.user_location_longitude ?? '')`
- Add `writeField('beneficiaries', body.beneficiaries || '')`

Note: `sync_status` and `sync_notes` have `editable: false` in the schema (to prevent user edits via the standard update path). The `updateTransaction` function must write them via direct `getRange().setValue()` calls or a small helper — not via `writeField()`. Same pattern that is already used for the `id` field.

**`transaction-validation.gs` — fx_rate removal implications:**
The current validation file contains `validateFxRate`, which enforces that cross-currency transfers (source and target accounts denominated in different currencies) must supply an `fx_rate`. This guard exists because the balance workflow used the stored FX rate to convert amounts when calculating account balances. With `fx_rate` removed from the sheet, this validation call and the `applyFxNote` helper (which appends `[FX: x.xx]` to the description) must both be removed. The cross-currency balance computation in `_postReversalBalance` will also need revisiting — determine whether it still needs a live rate or whether balance tracking is being simplified to amount-only. This is a dependency that must be resolved before Step 2 is considered complete.

**`_checkDuplicate`:** No changes — duplicate detection uses `tx_date_time`, `tx_type`, `amount`, `source_account`, `target_account` only.

**`_postReversalBalance`:** Review required — currently reads `oldFxRate = Number(oldRow[txColIndex('fx_rate')])` from the sheet for cross-currency reversal. With `fx_rate` gone, this read will return `undefined`. Decide whether to drop fx_rate from reversal logic entirely or calculate it at runtime before this function runs.

---

### Step 3 — `app/sections/transactions.js`

This file has many references to the renamed fields. All must be updated.

**Renames — find and replace throughout the file:**

| Old | New |
|-----|-----|
| `tx_location_area` | `user_location_area` |
| `tx_location_city` | `user_location_city` |
| `tx_location_country` | `user_location_country` |
| `.tags` / `body.tags` / `f.tags` | `.tx_tags` / `body.tx_tags` / `f.tx_tags` |

Verify after replacing: search for `tx_location_` and `\.tags` to confirm no occurrences remain.

**New fields — add to create form, edit form, and filter panel:**

`tx_timezone`:
- Add an optional text input (placeholder: `e.g. Asia/Kolkata`) in the create and edit forms, in the core group near `tx_date_time`
- Read value in the create submit handler: `const tx_timezone = el('afTimezone')?.value.trim() || ''`
- Read value in the edit submit handler: `const tx_timezone = el('txEditTimezone')?.value.trim() || ''`
- Pass in the payload to both create and update API calls

`beneficiaries`:
- Add an optional text input (placeholder: `e.g. Alice:60;Bob:40 or Alice;Bob`) in the create and edit forms, in the categorisation group
- Read value in both submit handlers: `const beneficiaries = el('afBeneficiaries')?.value.trim() || ''`
- Pass in the payload to both create and update API calls

**`sync_status` display — read-only badge on transaction cards:**
- In the transaction card render function, add a small status badge next to the transaction ID or date
- Badge text = `tx.sync_status` if non-blank, else omit
- CSS classes: use existing status token colours — `in-sync` → success, `sync-failure` → danger, `create-pending` / `update-pending` → muted/warning
- `sync_notes` displayed as a sub-line or tooltip under the badge only when `sync_status === 'sync-failure'`
- Neither field appears in the edit form — display only

**Bulk import column hint (line ~1734):**
Update the column list hint string from the current 13-column list to the new 21-column order: `id, tx_date_time, tx_timezone, tx_type, source_account, target_account, user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude, amount, currency, major_category, minor_category, description, counterparty_name, tx_tags, beneficiaries, sync_status, sync_notes`

---

## Deploy order

1. Migrate the sheet (Step 0) — dev first, then prod
2. Deploy GAS backend (`make api-deploy`) — dev first
3. Smoke-test create + edit in dev app; verify `sync_status` column in the sheet gets set correctly
4. Deploy frontend (`git push main` → GitHub Pages)
5. Repeat for prod
