# ST-2 — Prepare code changes (do NOT deploy yet)

**Type:** Code only — no deploy
**Depends on:** ST-1 deployed
**Deploy trigger:** ST-5 (sheet migration) must complete first
**Files:** `api/transaction-schema.gs`, `api/transaction-core.gs`

---

## Context

The sheet migration (ST-5) and the GAS code changes must land as close together as possible. Between the moment the columns are restructured in the sheet and the moment the new GAS code is live, any transaction created or edited will write to the wrong columns. Prepare this code fully in advance; deploy it immediately after the sheet is migrated.

---

## Part A — `api/transaction-schema.gs`

Replace the entire `TRANSACTION_SCHEMA` constant and the comment on line 10. The new schema has 21 fields.

```js
// Schema — 21 fields in column-position order
const TRANSACTION_SCHEMA = {

  // ── Identity (column 1) ──────────────────────────────────────────────────
  id: {
    sheet_column_name: 'id',
    sheet_column_position: 1,
    ui_label: 'ID',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: null,
  },

  // ── Core (columns 2–6) ───────────────────────────────────────────────────
  tx_date_time: {
    sheet_column_name: 'tx_date_time',
    sheet_column_position: 2,
    ui_label: 'Date/Time',
    type: 'date',
    group: 'core',
    editable: true,
    default_value: null,
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
    default_value: null,
  },
  source_account: {
    sheet_column_name: 'source_account',
    sheet_column_position: 5,
    ui_label: 'Source Account',
    type: 'string',
    group: 'core',
    editable: true,
    default_value: null,
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
    default_value: null,
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

  // ── Sync metadata (columns 20–21) — written by GAS and ledger-extract; never by the user ──
  sync_status: {
    sheet_column_name: 'sync_status',
    sheet_column_position: 20,
    ui_label: 'Sync Status',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
  sync_notes: {
    sheet_column_name: 'sync_notes',
    sheet_column_position: 21,
    ui_label: 'Sync Notes',
    type: 'string',
    group: 'system',
    editable: false,
    default_value: '',
  },
};
```

No changes to `getTransactionSchemaForClient()`, `getTransactionSheetColumns()`, `getFieldsForTransactionType()`, `getTransactionSchemaField()`, or `txColIndex()` — all schema-driven.

---

## Part B — `api/transaction-core.gs`

### `createTransaction` — update `setCol` calls

After ST-1, the function body has only the `setCol` block. Replace the entire block:

```js
setCol('id',                     id);
setCol('tx_date_time',           body.tx_date_time);
setCol('tx_timezone',            body.tx_timezone            || '');
setCol('tx_type',                body.tx_type);
setCol('source_account',         body.source_account         || '');
setCol('target_account',         body.target_account         || '');
setCol('user_location_area',     body.user_location_area     || '');
setCol('user_location_city',     body.user_location_city     || '');
setCol('user_location_country',  body.user_location_country  || '');
setCol('user_location_latitude', body.user_location_latitude ?? '');
setCol('user_location_longitude',body.user_location_longitude ?? '');
setCol('amount',                 amount);
setCol('currency',               body.currency               || '');
setCol('major_category',         body.major_category         || '');
setCol('minor_category',         body.minor_category         || '');
setCol('description',            finalDescription);
setCol('counterparty_name',      body.counterparty_name      || '');
setCol('tx_tags',                normaliseTags(body.tx_tags));
setCol('beneficiaries',          body.beneficiaries          || '');
```

Do NOT include `sync_status` or `sync_notes` in the `setCol` block. Instead, call `appendRow(row)` first (which writes all 21 columns from the row array, with positions 20 and 21 as empty strings from the initial `fill('')`), then set `sync_status` via direct range:

```js
sheet.appendRow(row);
const newRow = sheet.getLastRow();
sheet.getRange(newRow, txColIndex('sync_status') + 1).setValue('create-pending');
```

Note: `setCol` does NOT check `editable` — it would write `sync_status` if you called it. The direct-range pattern is used here because `sync_status` must be written AFTER `appendRow` (the row is appended as a unit, then updated).

### `updateTransaction` — update `writeField` calls

Replace the `writeField` block:

```js
writeField('tx_date_time',           body.tx_date_time);
writeField('tx_timezone',            body.tx_timezone            || '');
writeField('tx_type',                body.tx_type);
writeField('source_account',         body.source_account         || '');
writeField('target_account',         body.target_account         || '');
writeField('user_location_area',     body.user_location_area     || '');
writeField('user_location_city',     body.user_location_city     || '');
writeField('user_location_country',  body.user_location_country  || '');
writeField('user_location_latitude', body.user_location_latitude ?? '');
writeField('user_location_longitude',body.user_location_longitude ?? '');
writeField('amount',                 newAmount);
writeField('currency',               body.currency               || '');
writeField('major_category',         body.major_category         || '');
writeField('minor_category',         body.minor_category         || '');
writeField('description',            finalDescription);
writeField('counterparty_name',      body.counterparty_name      || '');
writeField('tx_tags',                normaliseTags(body.tx_tags));
writeField('beneficiaries',          body.beneficiaries          || '');
sheet.getRange(rowNum, txColIndex('sync_status') + 1).setValue('update-pending');
sheet.getRange(rowNum, txColIndex('sync_notes')  + 1).setValue('');
```

`sync_status` and `sync_notes` are `editable: false`, so `writeField` won't write them. Write them directly via `getRange().setValue()` as shown above.

Note: `tx_type` is not currently in the `writeField` block (it's not editable in the current schema either — `editable: true` in new schema, so it CAN be updated). Confirm whether `tx_type` should be editable on update. If yes, add the `writeField('tx_type', ...)` line. If no, set `editable: false` on `tx_type` in the schema.

---

## Part C — `api/transaction-metadata.gs` (or wherever `get_transaction_metadata` lives)

After ST-4 renames the sheet column from `tags` to `tx_tags`, the metadata endpoint that reads distinct tag values must be updated to query the `tx_tags` column. Keep the JSON response key as `tags` (i.e., `{ ok: true, tags: [...] }`) — this way no frontend change is needed for the datalist suggestions. The change is purely the internal column name used in the sheet read.

---

## Schema key compatibility note

The new schema objects omit `enum_values`, `required_for`, and `required` keys that the current schema has (as `null` / `[]`). Before deploying, grep the codebase for reads of `field.enum_values`, `field.required_for`, and `field.required` to confirm nothing will receive `undefined` where it previously received `null` or `[]`. If any reader does, add `enum_values: null` (or the appropriate default) back to the affected field objects.

---

## Do not deploy

Stage both files. Deploy only immediately after ST-5 (sheet migration) is confirmed complete.
