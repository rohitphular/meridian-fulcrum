# Forge Backend — Coding Guide

> **Audience**: LLMs and developers creating new Forge module backends.
> **Stack**: Google Apps Script (GAS) V8 runtime · Google Sheets as datastore · `clasp` for local dev

---

## What a Forge backend is

Each Forge module backend is a set of `.gs` files deployed to a Google Apps Script project. That project exposes a single HTTPS endpoint (`/exec`). The frontend calls this endpoint with `?action=some_action&pin=…` (GET) or a JSON body `{ action: "some_action", pin: "…", ...data }` (POST). GAS routes the call, runs business logic, reads/writes the Google Sheet, and returns JSON.

There is no database, no server process, and no runtime state. Every request is stateless. The Google Sheet is the single source of truth.

---

## Two config files

### `api/.clasp.json`

Tells `clasp` which GAS project this folder belongs to and which files to push.

```json
{
  "scriptId": "${SCRIPT_ID_PLACEHOLDER}",
  "rootDir": ".",
  "scriptExtensions": [".js", ".gs"]
}
```

`scriptId` is a placeholder committed to git. The deploy script (`cicd/script-deployment.sh`) fills it in at deploy time, then restores the placeholder on exit. **Never commit a real script ID here.**

### `api/appsscript.json`

GAS project manifest. Every module has the same structure:

```json
{
  "timeZone": "Europe/London",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

Key settings:
- `runtimeVersion: "V8"` — modern JS (let/const/arrow functions/destructuring). Always set this.
- `executeAs: "USER_DEPLOYING"` — the script runs as the Sheet owner.
- `access: "ANYONE_ANONYMOUS"` — the endpoint is public. Auth is enforced inside the code, not by GAS.
- `oauthScopes` — `spreadsheets` for Sheet access, `external_request` for outbound HTTP (`UrlFetchApp`).

---

## Script Properties (server-side secrets)

Script Properties are the equivalent of environment variables in GAS. They are set once per environment in the Apps Script editor under **Project Settings → Script Properties**. They are never committed to git.

| Property | Required | Purpose |
|---|---|---|
| `PIN_SECRET` | Yes | The PIN users enter at login. `checkPin` reads this via `PropertiesService`. |
| `TOTP_SECRET` | When TOTP enabled | Base32-encoded RFC 6238 secret — same value entered into an authenticator app. |
| `TOTP_ENABLED` | No (default `false`) | `"true"` to enforce TOTP; any other value skips it. |
| `OPENAI_API_KEY` | Only for advisor | API key for `UrlFetchApp` calls to the OpenAI endpoint in `advisor-core.gs`. |

Read a property at runtime with:

```js
PropertiesService.getScriptProperties().getProperty('PIN_SECRET');
```

---

## File structure

A module's `api/` folder contains:

```
api/
├── .clasp.json              ← clasp config (placeholder scriptId)
├── appsscript.json          ← GAS manifest
│
├── app-router.gs            ← HTTP entry points: doGet + doPost
├── app-config.gs            ← Sheet name constants, app-wide config
├── app-auth.gs              ← TOTP (RFC 6238) + IP audit log
├── app-utils.gs             ← Shared helpers used across all domains
│
├── <domain>-schema.gs       ← Column definitions, enum values, helper fns
├── <domain>-core.gs         ← CRUD: list / create / update / delete
├── <domain>-validation.gs   ← Input validation functions
├── <domain>-utils.gs        ← Domain-specific helpers (ID gen, balance adj, etc.)
│
└── <domain>-seed.gs         ← (Optional) Default data seeded on first use
```

Repeat the `<domain>-*.gs` quartet for each entity (e.g. `transaction`, `account`, `category`, `rate`). Simple domains (like `rate`) may skip the utils file.

**Important**: GAS loads all `.gs` files into a single global scope in alphabetical order. There is no `import`/`require`. Every function and `const` is globally accessible from every other file.

---

## app-config.gs — constants

Defines sheet name constants and module-level config values. Nothing else.

```js
const TRANSACTIONS_SHEET = 'transactions';
const CATEGORIES_SHEET   = 'categories';
const ACCOUNTS_SHEET     = 'accounts';
const RATES_SHEET        = 'rates';
const AUDIT_SHEET        = 'audit_access';   // ← exact name; do not change
const ADVISOR_SHEET      = 'advisor_chat';
const MAX_FAILURES       = 3;

const AUDIT_COLUMNS = [
  'ip', 'city', 'country', 'user_agent',
  'first_seen', 'last_seen',
  'total_attempts', 'success_count', 'failure_count', 'last_failed_at',
  'is_locked', 'locked_at'
];
```

Rules:
- Every sheet name is a constant here. Never use a raw string like `'transactions'` in a core file.
- Column definitions that belong to a domain (e.g. `TRANSACTION_COLUMNS`) live in that domain's schema file, not here.
- Comments mark removed constants so collaborators know where they moved.

---

## app-auth.gs — TOTP + audit

Handles the TOTP second factor and the IP-based audit log. PIN checking (`checkPin`) lives in `app-utils.gs` because it is called on every single request before dispatch.

Functions exposed globally:

| Function | Called by | What it does |
|---|---|---|
| `verifyTotp(token)` | router `verify` action | Validates 6-digit code via RFC 6238 HMAC-SHA1 ±1 window. Returns `true` if `TOTP_ENABLED ≠ "true"`. |
| `checkLocked(ip)` | router, before PIN check | Returns `true` if this IP has `is_locked = true` in `audit_access`. |
| `recordAccess(meta, success)` | router, after every auth attempt | Upserts the IP row: increments counters, sets `is_locked = true` after `MAX_FAILURES` consecutive failures. |

Audit row layout (12 columns matching `AUDIT_COLUMNS`):

```
ip | city | country | user_agent | first_seen | last_seen |
total_attempts | success_count | failure_count | last_failed_at | is_locked | locked_at
```

Manual unlock: edit the `audit_access` sheet directly and set `is_locked` to `FALSE` for the IP. Or delete the row entirely.

Do not modify `app-auth.gs` when adding a new module — copy it verbatim. See `APP-AUTH.md` for the full auth specification.

---

## app-utils.gs — shared helpers

These functions are available in every `.gs` file. Know them before writing domain code.

### `getOrCreateSheet(name, columns)`

Gets the sheet by name. If missing: creates it, appends the header row, freezes row 1. If present: appends any columns from `columns` that are not yet in the header. This is the **sheet migration primitive** — it handles new schema fields being added without manual Sheet edits.

Always call it at the start of any function that reads or writes a sheet:

```js
const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, getTransactionSheetColumns());
```

Never call `SpreadsheetApp.getActiveSpreadsheet().getSheetByName(...)` directly — it returns `null` if the sheet doesn't exist and the next call throws.

### `sheetToObjects(sheet)`

Reads all data rows (skips header). Returns an array of plain objects keyed by header values. Use for read-only operations where row number is not needed.

### `sheetToObjectsWithRow(sheet)`

Same as `sheetToObjects` but adds `_row: i + 2` (1-based sheet row number accounting for the header) to each object. The `_row` value is sent to the frontend and returned in update/delete requests as `body.row_num`.

### `extractMeta(source)`

Pulls `{ ip, city, country, ua }` from a query-string parameter object or a POST body object. Called in both `doGet` and `doPost` before auth checks.

### `checkPin(pin)`

Constant-time comparison of `pin` against `PIN_SECRET` from Script Properties. Returns `true` if correct, `false` otherwise. Timing-safe: always iterates the full length of the longer string to prevent timing-based PIN inference.

### `json(obj)`

```js
return ContentService
  .createTextOutput(JSON.stringify(obj))
  .setMimeType(ContentService.MimeType.JSON);
```

All return paths from `doGet`/`doPost` must go through this. Never return a raw object.

### `splitToList(str)`

Splits a comma-separated string into a trimmed, non-empty array. Used for multi-value fields like account type hints.

### `normaliseTags(str)`

Splits on `,` or `;`, trims, deduplicates, and rejoins with `;`. Tags are always stored semicolon-separated. Note: the separator is **semicolons**, not commas.

### `getColIndex(schema, name)`

Returns the 0-based array index for a field in a raw row array: `schema[name].sheet_column_position - 1`. **Throws `Error: Unknown column: <name>`** if the field is not in the schema. This is intentional — a misspelled column name should fail loudly.

---

## app-router.gs — the entry point

`doGet` and `doPost` are the only functions GAS calls from outside. The router:

1. Parses the request.
2. Checks `checkLocked` **before** PIN (locked IPs are refused immediately, no PIN attempt recorded).
3. Checks PIN. On failure: `recordAccess(meta, false)` then return `auth` error.
4. On success: `recordAccess(meta, true)`.
5. Dispatches by `action` using `if`-chains (not `switch`).
6. Returns `json(result)`.

### `verify` action (special — GET only)

The `verify` action is the login handshake. It is the **only** action that also calls `verifyTotp`:

```js
if (action === 'verify') {
  if (!checkPin(e.parameter.pin)) {
    recordAccess(meta, false);
    return json({ ok: false, error: 'auth' });
  }
  if (!verifyTotp(e.parameter.totp)) {
    return json({ ok: false, error: 'totp_invalid' });
  }
  recordAccess(meta, true);
  return json({ ok: true });
}
```

All other actions validate PIN only. TOTP is verified once at login; the PIN in subsequent requests serves as the bearer credential.

### `doGet` pattern

```js
function doGet(e) {
  const meta   = extractMeta(e.parameter);
  const action = e.parameter.action || '';

  if (checkLocked(meta.ip)) return json({ ok: false, error: 'locked' });

  if (action === 'verify') { /* special case above */ }

  if (!checkPin(e.parameter.pin)) {
    recordAccess(meta, false);
    return json({ ok: false, error: 'auth' });
  }
  recordAccess(meta, true);

  if (action === 'list_transactions')  { migrateTransactionColumnHeaders(); return json({ ok: true, data: listTransactions() }); }
  if (action === 'list_categories')    { migrateCategoryMandatoryFlags();   return json({ ok: true, data: listCategories() }); }
  if (action === 'list_accounts')      return json({ ok: true, data: listAccounts() });
  if (action === 'list_rates')         return json({ ok: true, data: listRates() });
  if (action === 'get_account_schema')     return json({ ok: true, data: getAccountSchemaForClient() });
  if (action === 'get_transaction_schema') return json({ ok: true, data: getTransactionSchemaForClient() });
  if (action === 'get_category_schema')    return json({ ok: true, data: getCategorySchemaForClient() });

  return json({ ok: false, error: 'unknown_action' });
}
```

### `doPost` pattern

```js
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (_) { return json({ ok: false, error: 'invalid_json' }); }

  const meta = extractMeta(body);

  if (checkLocked(meta.ip)) return json({ ok: false, error: 'locked' });

  if (!checkPin(body.pin)) {
    recordAccess(meta, false);
    return json({ ok: false, error: 'auth' });
  }
  recordAccess(meta, true);

  if (body.action === 'create_transaction') return json(createTransaction(body));
  if (body.action === 'update_transaction') return json(updateTransaction(body));
  // …
  return json({ ok: false, error: 'unknown_action' });
}
```

Key rules:
- `JSON.parse` is always wrapped in try/catch; malformed bodies return `invalid_json`, not a 500.
- List actions that call migration functions do so **before** calling the list function: `migrateXxx(); return json({ ok: true, data: listXxx() });`
- Keep the router thin — no business logic here, only dispatch.

### Migration functions

Some list actions invoke a migration helper before returning data. These run lazily (on first load after a schema change) and are idempotent:

- `migrateTransactionColumnHeaders()` — called before `list_transactions`. Renames old column headers to current schema names when the Sheet was created before the schema was updated.
- `migrateCategoryMandatoryFlags()` — called before `list_categories`. Back-fills `source_account_mandatory` / `target_account_mandatory` on rows that predate those columns.

When adding new schema columns that require back-fill, add a migration function in the domain's core file and call it from the router's matching list action.

---

## `<domain>-schema.gs` — field registry

Single source of truth for every entity. It answers: what columns does this sheet have, in what order, what type, and which ones apply to which variants?

### Schema object structure

```js
const TRANSACTION_SCHEMA = {
  id: {
    sheet_column_name:     'id',
    sheet_column_position: 1,        // 1-based; drives column order in the sheet
    ui_label:              'ID',
    type:                  'string', // string | number | boolean | enum | date | datetime | multi-select
    enum_values:           null,     // array of allowed values, or null
    group:                 'core',   // used by frontend to group fields in forms
    applies_to:            null,     // null = all variants; array = restrict to these discriminant values
    required_for:          null,     // null = never required; [] = not required; ['money-out'] = required for that variant
    editable:              false,    // false = never sent in update requests; writeField() skips non-editable fields
    default_value:         null,
  },
  // ...
};
```

### Required helper functions — every schema file must have all of these

```js
// 1. Ordered column header array — passed to getOrCreateSheet()
function get<Domain>SheetColumns() {
  return Object.values(<DOMAIN>_SCHEMA)
    .sort((a, b) => a.sheet_column_position - b.sheet_column_position)
    .map(f => f.sheet_column_name);
}

// 2. 0-based column index for raw row arrays — throws on unknown name
function <domain>ColIndex(name) { return getColIndex(<DOMAIN>_SCHEMA, name); }

// 3. Direct field access by key
function get<Domain>SchemaField(key) { return <DOMAIN>_SCHEMA[key] || null; }

// 4. Fields applicable to a specific variant (e.g. account type)
function getFieldsFor<Domain>Type(type) {
  return Object.keys(<DOMAIN>_SCHEMA)
    .filter(key => {
      const f = <DOMAIN>_SCHEMA[key];
      return f.applies_to === null || f.applies_to.includes(type);
    })
    .map(key => Object.assign({ key }, <DOMAIN>_SCHEMA[key]));
}

// 5. Client-safe schema subset (enums, labels, groupings) — returned by get_<domain>_schema action
function get<Domain>SchemaForClient() { ... }
```

### Column position rules

- **Column positions are append-only.** Once data is in the sheet, never change an existing `sheet_column_position`. Doing so misaligns the schema against live data silently.
- **Add new fields at unused high position numbers** or fill gaps in the existing sequence.
- **`applies_to: null`** — field applies to all rows of this entity.
- **`applies_to: ['credit_card']`** — field only applies to rows where the discriminant field has this value.
- **`required_for: []`** — field is optional for every variant.
- **`required_for: ['mortgage']`** — field is required when creating an account of type `mortgage`.
- **`editable: false`** — the `writeField` helper in update functions skips this field. Use for IDs, creation timestamps, and type fields that cannot be changed after creation.

---

## `<domain>-core.gs` — CRUD

Business logic for one entity. Four standard functions:

```js
function list<Domain>s()          { ... }
function create<Domain>(body)     { ... }
function update<Domain>(body)     { ... }
function delete<Domain>(body)     { ... }
```

### list — seed on first use

```js
function listCategories() {
  const sheet = getOrCreateSheet(CATEGORIES_SHEET, getCategorySheetColumns());
  let rows    = sheetToObjectsWithRow(sheet);
  if (rows.length === 0) {
    seedCategories();
    rows = sheetToObjectsWithRow(sheet);
  }
  // Boolean coercion — Google Sheets returns TRUE/FALSE as booleans or "true"/"false" strings
  return rows.map(r => {
    const toBool = v => v === true || String(v).toLowerCase() === 'true';
    r.is_active                = toBool(r.is_active);
    r.source_account_mandatory = toBool(r.source_account_mandatory);
    r.target_account_mandatory = toBool(r.target_account_mandatory);
    return r;
  });
}
```

**Boolean coercion rule**: Google Sheets stores booleans inconsistently — checkbox cells return JS `true`/`false`, but cells written by `setValue(true)` in GAS sometimes come back as `"TRUE"` strings on re-read. Always coerce: `v === true || String(v).toLowerCase() === 'true'`. Do this in list functions, not in core create/update.

`listRates()` follows the same seed-on-empty pattern but without boolean coercion — it seeds `DEFAULT_RATES` (GBP, INR, USD, EUR, AED with approximate rates) when the sheet is empty.

### create — row building pattern

```js
function createTransaction(body) {
  // 1. Validate first — nothing is written if validation fails
  const v = validateTransactionCreate(body);
  if (!v.ok) return v;

  const cols  = getTransactionSheetColumns();
  const sheet = getOrCreateSheet(TRANSACTIONS_SHEET, cols);

  // 2. Build a blank row array — all cells default to empty string
  const row = new Array(cols.length).fill('');

  // 3. setCol helper — uses sheet_column_position, not magic numbers
  function setCol(key, value) {
    const field = TRANSACTION_SCHEMA[key];
    if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
  }
  // Note: setCol does NOT check field.editable — that check is only in update's writeField

  setCol('id',     generateTransactionId(sheet, body.transaction_date_utc));
  setCol('amount', Number(body.amount));
  // ... all other fields

  // 4. Append the row
  sheet.appendRow(row);

  // 5. Side effects last (e.g. balance adjustments)
  adjustAccountBalance(body.source_account, -Number(body.amount));

  return { ok: true, id: row[0] };
}
```

### update — writeField pattern

Update functions use `writeField` instead of `setCol`. The key difference: `writeField` checks `field.editable` and skips fields where `editable: false`.

```js
function updateAccount(body) {
  const cols    = getAccountSheetColumns();
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, cols);
  const rowNum  = Number(body.row_num);

  // Row bounds check — always do this before any read/write
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  // Read the current type before validation (needed for type-specific field checks)
  const typeColPos  = getAccountSchemaField('type').sheet_column_position;
  const currentType = sheet.getRange(rowNum, typeColPos).getValue();

  const v = validateAccountUpdate(body, currentType);
  if (!v.ok) return v;

  function writeField(key, value) {
    const field = getAccountSchemaField(key);
    if (!field || !field.editable) return;  // skip non-editable fields
    sheet.getRange(rowNum, field.sheet_column_position).setValue(value);
  }

  writeField('name',      String(body.name).trim());
  writeField('is_active', body.is_active === true || body.is_active === 'true');
  // ... type-specific fields

  return { ok: true };
}
```

Row and column arguments to `getRange` are 1-based. Schema `sheet_column_position` is 1-based — pass it directly.

### Two-phase update for entities with side effects (e.g. balance)

When a mutation affects computed state on another entity (like `current_balance` on accounts), use two-phase reversal:

```
Phase 1 — Reverse the old row's side effects
  Read the existing row values from the sheet
  Undo its impact (e.g. add back the old amount that was subtracted from the balance)

Phase 2 — Apply the new row
  Write the new field values
  Apply the new side effects (e.g. subtract the new amount from the balance)
```

All validation runs **before Phase 1**. If validation fails, neither phase executes.

Validation for updates receives `oldRow` so financial rules can project the post-reversal balance:

```js
const err = validateTransactionUpdate(body, oldRow);
if (!err.ok) return err;
// Phase 1
reverseTransactionEffects(oldRow);
// Phase 2
applyTransactionToRow(sheet, rowNum, body);
```

### delete — FK check pattern

Before deleting, check whether any related entity references this row. Return a blocked response with `referenced_count` instead of deleting. The frontend uses this to show an informative error rather than silently failing.

```js
function deleteAccount(body) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  const sheet   = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const rowNum  = Number(body.row_num);
  const lastRow = sheet.getLastRow();
  if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };

  const accountId = String(sheet.getRange(rowNum, getAccountSchemaField('id').sheet_column_position).getValue() || '');
  if (!accountId) return { ok: false, error: 'missing_account_id' };

  const refCount = _countTransactionsReferencingAccount(accountId);
  if (refCount > 0) {
    return {
      ok: false,
      error: 'account_in_use',
      referenced_count: refCount,
      hint: 'archive_instead',   // tell the frontend what to suggest
    };
  }

  sheet.deleteRow(rowNum);
  return { ok: true };
}
```

FK check helpers are private (`_countXxx`) and read raw sheet values — they do not call the other domain's core functions to avoid circular dependencies.

Similar pattern for rates: `deleteRate` refuses if any account or transaction uses that currency (`currency_in_use_by_accounts`, `currency_in_use_by_transactions`).

---

## `<domain>-validation.gs` — input validation

Two top-level functions per entity:

```js
function validate<Domain>Create(body) { ... }
function validate<Domain>Update(body, oldRow) { ... }
```

Return shape:
- Failure: `{ ok: false, error: 'snake_case_error_code' }` — optionally add `detail: '...'` for human-readable context.
- Success: `{ ok: true }`.

Validation order (always in this sequence):

1. **Required fields** — check presence before anything else.
2. **Enum values** — validate against the schema's `VALID_*` array.
3. **Numeric ranges** — positive amounts, valid percentages, valid day-of-month, etc.
4. **Date ordering** — e.g. end date after start date.
5. **Cross-field rules** — e.g. FX rate required for cross-currency transfer.
6. **Cross-entity rules** — e.g. account ID exists, currency is in the rates sheet.

Validation for updates receives the old row so financial rules can operate on the post-reversal projection:

```js
function validateTransactionUpdate(body, oldRow) {
  if (!body.row_num) return { ok: false, error: 'missing_row_num' };
  // ... same checks as create ...
  const finErr = _validateFinancialRules(body, oldRow || null);
  if (!finErr.ok) return finErr;
  return { ok: true };
}
```

For entities with type-specific required fields, drive the check from the schema instead of hardcoding:

```js
const fields = getFieldsForAccountType(type);
for (const field of fields) {
  if (!field.required_for?.includes(type)) continue;
  if (body[field.key] === undefined || body[field.key] === null || body[field.key] === '') {
    return { ok: false, error: 'missing_' + field.key };
  }
}
```

For update validation, also reject requests that send immutable fields (`editable: false`):

```js
for (const field of fields) {
  if (!field.editable && field.key !== 'row_num' && body[field.key] !== undefined) {
    return { ok: false, error: 'field_not_editable:' + field.key };
  }
}
```

---

## `<domain>-utils.gs` — domain helpers

Small, focused helpers that don't belong in core or validation. No sheet I/O in most of them — prefer pure computation.

### ID generation

Two patterns in use:

**Transaction ID** — date-prefixed, hyphen-separated, 3-digit sequence:
```
2024-01-15-001
2024-01-15-002
```

```js
function generateTransactionId(sheet, date) {
  const dateStr = String(date).slice(0, 10);  // 'YYYY-MM-DD'
  const values  = sheet.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < values.length; i++) {
    const rowId = String(values[i][0]);
    if (rowId.startsWith(dateStr + '-')) {
      const n = parseInt(rowId.slice(dateStr.length + 1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return dateStr + '-' + String(max + 1).padStart(3, '0');
}
```

**Account ID** — prefixed with entity type, compact date, 3-digit sequence:
```
ACC-20240115-001
ACC-20240115-002
```

```js
function generateAccountId(sheet) {
  const now    = new Date();
  const prefix = 'ACC-' + now.getUTCFullYear()
               + String(now.getUTCMonth() + 1).padStart(2, '0')
               + String(now.getUTCDate()).padStart(2, '0') + '-';
  // ... same scan-and-increment logic
}
```

Choose the pattern that fits the entity. Both scan the existing sheet column to find the highest existing sequence for the date prefix, then increment.

### Balance adjustment

```js
function adjustAccountBalance(accountId, delta) {
  const sheet          = getOrCreateSheet(ACCOUNTS_SHEET, getAccountSheetColumns());
  const values         = sheet.getDataRange().getValues();
  const accountIdIdx   = getAccountSchemaField('id').sheet_column_position - 1;
  const balanceColPos  = getAccountSchemaField('current_balance').sheet_column_position;
  const balanceIdx     = balanceColPos - 1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][accountIdIdx]) !== String(accountId)) continue;
    const current = Number(values[i][balanceIdx]) || 0;
    sheet.getRange(i + 1, balanceColPos).setValue(current + delta);
    return { ok: true };
  }
  console.log('adjustAccountBalance: account_not_found id=' + accountId + ' delta=' + delta);
  return { ok: false, error: 'account_not_found:' + accountId };
}
```

Note: this returns `{ ok, error }` rather than throwing. Old-row references during update reversal may point to accounts that no longer exist — callers tolerate a miss and log it.

---

## `<domain>-seed.gs` — default data (optional)

For entities that need rows pre-populated on first use (categories, default currencies).

```js
const CATEGORY_SEED = [
  // Each element is a full row array in sheet_column_position order
  ['money-in', 'Salary', 'Monthly pay', 'Regular monthly salary', true,
   'salary, wages', '', 'current, savings', '', false, true, 0],
  // ...
];

function seedCategories() {
  const sheet    = getOrCreateSheet(CATEGORIES_SHEET, getCategorySheetColumns());
  const existing = sheet.getDataRange().getValues();
  if (existing.length > 1) return;  // idempotent — do nothing if rows exist
  CATEGORY_SEED.forEach(row => sheet.appendRow(row));
}
```

The list function calls `seedCategories()` when the sheet returns zero data rows. The seed is idempotent — it checks for existing rows and exits if any are present.

---

## onEdit trigger (Google Sheets integration)

Category-core.gs contains an `onEdit(e)` function. This is a GAS installable trigger — Sheets calls it automatically when a user edits a cell directly in the spreadsheet (not via API).

Its purpose: maintain cascading dropdowns in the transactions sheet when a user edits transaction type or major category directly in the sheet.

```js
function onEdit(e) {
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== TRANSACTIONS_SHEET) return;
  // When transaction_type changes → rebuild major_category dropdown
  // When major_category changes → rebuild minor_category dropdown
  // Uses SpreadsheetApp.newDataValidation() to set list validation
}
```

Rules for `onEdit`:
- Always guard with `if (sheet.getName() !== ...)` — it fires on every edit in any sheet.
- Row 1 is the header — always `if (row <= 1) return`.
- Column numbers are hardcoded (1-based) for the trigger handler — this is acceptable because `onEdit` is tied to the physical sheet layout, which matches the schema positions.
- Do not add business logic (balance adjustments, validation) to `onEdit`. It is for UI convenience only.

---

## External HTTP calls (UrlFetchApp)

When a domain needs to call an external API (e.g. the advisor calling OpenAI), use `UrlFetchApp.fetch()`. GAS requires `external_request` in the `oauthScopes` manifest.

Pattern:

```js
const options = {
  method:             'post',
  contentType:        'application/json',
  headers:            { 'Authorization': 'Bearer ' + apiKey },
  payload:            JSON.stringify({ model: 'gpt-4o-mini', messages }),
  muteHttpExceptions: true,   // prevents GAS from throwing on non-2xx; lets you handle status codes yourself
};
try {
  const resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', options);
  const code = resp.getResponseCode();
  const data = JSON.parse(resp.getContentText());
  if (code !== 200) return { ok: false, error: data.error?.message || 'api_error_' + code };
  return { ok: true, content: data.choices[0].message.content };
} catch (e) {
  return { ok: false, error: 'fetch_error: ' + e.message };
}
```

Key rules:
- Always set `muteHttpExceptions: true`. Without it, GAS throws on any non-2xx response and the handler returns HTML, not JSON.
- Wrap in try/catch to handle network failures.
- Store the API key in Script Properties (`OPENAI_API_KEY`), not in code.
- Return `{ ok: false, error: '...' }` on failure — same shape as all other responses.

---

## Coding guidelines

> Naming conventions (variables, functions, files, field names, error codes, ID formats) are in **APP-CONVENTIONS.md**.
> Logging standards (format, what to log, what not to log, viewing logs) are in **APP-LOGGING.md**.

### Global namespace — name carefully

All `.gs` files share one global namespace. Prefix private helpers with `_` (e.g. `_validateFinancialRules`, `_countTransactionsReferencingAccount`). Public functions use plain camelCase: `createTransaction`, `listAccounts`.

### Use `const`/`let`, not `var` at module level

V8 GAS supports `const`, `let`, arrow functions, template literals, destructuring, spread, `for...of`. Use them. `var` is acceptable inside a nested function where you need function scope, but not at module level.

### Row building: `new Array(cols.length).fill('')`

Always initialise the row array with empty strings before calling `setCol`. This ensures every cell has a value and no column is accidentally left undefined.

```js
const row = new Array(cols.length).fill('');
function setCol(key, value) {
  const field = SCHEMA[key];
  if (field) row[field.sheet_column_position - 1] = (value === undefined || value === null) ? '' : value;
}
```

### `setCol` vs `writeField`

- **`setCol`** — used in create functions. Writes any field including non-editable ones. Skips silently if the key is not in the schema.
- **`writeField`** — used in update functions. Checks `field.editable` and returns without writing if `false`. This prevents clients from overwriting immutable fields (IDs, types, creation timestamps).

### Row bounds before update/delete

Before any update or delete, validate the row number is within the sheet:

```js
const lastRow = sheet.getLastRow();
if (rowNum < 2 || rowNum > lastRow) return { ok: false, error: 'invalid_row' };
```

`rowNum < 2` rejects the header row. `rowNum > lastRow` rejects stale row numbers from clients that haven't refreshed since a delete.

### Timestamps

Use `new Date().toISOString()` for `created_at` / `updated_at`. Store as string — Google Sheets must not interpret it as a date format.

### Return shape consistency

Every function that can fail: `{ ok: false, error: 'snake_case_code', detail?: '...' }`.
Every function that succeeds: `{ ok: true, ...data }`.
The router wraps all of these in `json()`.

### No thrown exceptions in handler paths

GAS surfaces unhandled exceptions as HTML 500 pages, not JSON. Validate defensively so exceptions are never reachable in normal operation. Wrap any code that can fail (sheet reads, `JSON.parse`, `UrlFetchApp`) in try/catch.

---

## Cross-domain dependencies

GAS loads files alphabetically and makes all globals available everywhere. Conceptual load order:

```
app-config.gs           (no deps)
app-utils.gs            (no deps)
app-auth.gs             (uses AUDIT_SHEET, AUDIT_COLUMNS, MAX_FAILURES from app-config)
<domain>-schema.gs      (uses getColIndex from app-utils)
<domain>-utils.gs       (uses schema helpers)
<domain>-validation.gs  (uses schema, utils, cross-domain schemas)
<domain>-core.gs        (uses all of the above)
app-router.gs           (uses everything)
```

When validation or core reads another entity's sheet (e.g. `transaction-validation.gs` reading the accounts sheet), it calls that domain's schema helpers and `getOrCreateSheet` directly — it does **not** call the other domain's core functions (e.g. `listAccounts()`). This avoids circular calls and unnecessary overhead.

---

## File length guidelines

| File | Typical size | Notes |
|---|---|---|
| `app-router.gs` | 60–80 lines | Thin dispatcher; grows ~2 lines per new action |
| `app-config.gs` | 20–35 lines | Constants only |
| `app-auth.gs` | 100–120 lines | Fixed; copy from existing module |
| `app-utils.gs` | 90–110 lines | Fixed; copy from existing module |
| `<domain>-schema.gs` | 100–600 lines | Scales with field count (accounts = 39 fields ≈ 590 lines) |
| `<domain>-core.gs` | 100–300 lines | Scales with business rule complexity |
| `<domain>-validation.gs` | 80–300 lines | Scales with rule count |
| `<domain>-utils.gs` | 40–100 lines | Usually small; pure computation |
| `<domain>-seed.gs` | 50–600 lines | Scales with seed data volume |

Split by domain, not by line count. If a core file exceeds ~400 lines, check whether financial-rule helpers belong in utils or validation instead.

---

## Adding a new domain — checklist

1. Add sheet name constant to `app-config.gs` (e.g. `const INVOICES_SHEET = 'invoices'`).
2. Create `<domain>-schema.gs` with the field registry and all five required helper functions.
3. Create `<domain>-validation.gs` with `validate<Domain>Create` and `validate<Domain>Update`.
4. Create `<domain>-utils.gs` with ID generation and any domain-specific helpers.
5. Create `<domain>-core.gs` with list / create / update / delete.
6. If the list function needs seed data, create `<domain>-seed.gs`.
7. If list needs a migration pass, add a `migrateXxx()` function in core and call it from the router before the list action returns.
8. Add `if`-chain cases to `app-router.gs` for every new action (reads in `doGet`, writes in `doPost`).
9. Add a `get_<domain>_schema` action in `doGet` — the frontend uses this to build forms without hardcoding enums.

---

## Deploy workflow

```bash
# Interactive (recommended)
bash forge/expense-tracker/cicd/deploy.sh   # pick env

# Direct
bash cicd/deploy.sh dev  "expense-tracker: add invoices domain"
bash cicd/deploy.sh prod "expense-tracker: add invoices domain"
```

The script:
1. Reads `cicd/envs.json` for the env's `script_id` and `deployment_id`.
2. Injects the real `script_id` into `api/.clasp.json`.
3. `clasp push --force` — uploads `.gs` files to the GAS draft.
4. `clasp deploy --deploymentId <id> --description <msg>` — promotes the draft to a live version on the env's `/exec` URL.
5. Restores `api/.clasp.json` to the placeholder via EXIT trap (fires on success, failure, and Ctrl-C).

Git operations are NOT performed by the script. Commit and push manually.

---

## Common pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| `getSheetByName()` directly | Returns `null` if sheet doesn't exist; next call throws | Always use `getOrCreateSheet` |
| `row[7]` instead of schema index | Breaks silently when columns are added | Use `<domain>ColIndex('field')` — it throws on typos |
| Changing an existing `sheet_column_position` | Live sheet data misaligns silently | Only append at high positions; never move existing ones |
| Exception thrown in a handler | GAS returns HTML 500, not JSON | Validate defensively; wrap risky calls in try/catch |
| Real `scriptId` in `.clasp.json` | Accidental pushes or committed secret | Always use the deploy script; it manages the ID and restores the placeholder |
| Side effects before validation | Sheet mutates on invalid input | Validate fully before any `appendRow` or `setValue` |
| Sheet name as a raw string | Typo causes silent miss | Use constants from `app-config.gs` |
| `getColIndex` called with wrong field name | Throws `Error: Unknown column: <name>` at runtime | Verify field names against the schema object |
| `normaliseTags` output separator | Using `,` to split tags on the frontend | Tags are stored and returned as `;`-separated; split on `;` |
| No `muteHttpExceptions` in `UrlFetchApp.fetch` | Non-2xx response throws and returns HTML | Always set `muteHttpExceptions: true` for external HTTP |
| Skipping boolean coercion on list | Sheets returns `"TRUE"` string, frontend gets a string not a boolean | Always coerce: `v === true \|\| String(v).toLowerCase() === 'true'` |
| Using `setCol` in update | Overwrites immutable fields (id, type, created_at) | Use `writeField` in update — it checks `field.editable` |
| Missing row bounds check | `getRange` on row 1 (header) or beyond `lastRow` corrupts data | Always check `rowNum >= 2 && rowNum <= sheet.getLastRow()` before update/delete |
