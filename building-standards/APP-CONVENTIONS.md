# Forge — Naming & Code Conventions

> **Scope**: All Forge modules — backend (GAS) and frontend (vanilla JS). These rules apply everywhere; individual docs (APP-BE.md, APP-FE.md) reference this as the source of truth.

---

## JavaScript style

| Rule | Standard |
|---|---|
| Declarations | `const` by default; `let` when the variable is reassigned; never `var` at module level |
| Quotes | Single quotes `'...'` for strings. Template literals for interpolation. |
| Semicolons | Always |
| Braces | Always for `if`/`for`/`while` bodies, even one-liners in module-level code |
| Line length | Soft limit 120 chars; align related assignments with spaces where it aids reading |
| ES version | V8 (GAS) / modern evergreen browsers — arrow functions, destructuring, spread, `for…of`, optional chaining `?.`, nullish coalescing `??` are all available |

---

## Backend (GAS) naming

### Variables

`camelCase` for all variables.

```js
const accountId = 'ACC-20240115-001';
let rowNum = Number(body.row_num);
const lastRow = sheet.getLastRow();
```

### Functions

| Visibility | Convention | Examples |
|---|---|---|
| Public (callable cross-file) | `camelCase` | `createTransaction`, `listAccounts`, `adjustAccountBalance` |
| Private (file-internal) | `_camelCase` (leading underscore) | `_validateFinancialRules`, `_countTransactionsReferencingAccount`, `_callClaude` |

Factory functions (return a structured object/closure) use `camelCase` matching the returned concept: `createAuthModule`, `getOrCreateSheet`.

### Constants and schema objects

`UPPER_SNAKE_CASE` for module-level constants and all schema objects:

```js
const TRANSACTIONS_SHEET = 'transactions';
const MAX_FAILURES       = 3;
const TRANSACTION_SCHEMA = { id: { ... }, amount: { ... } };
const VALID_ACCOUNT_TYPES = ['current', 'savings', 'credit_card', ...];
const AUDIT_COLUMNS = ['ip', 'city', ...];
```

Enum allow-lists follow the `VALID_*` prefix: `VALID_ACCOUNT_TYPES`, `VALID_TRANSACTION_TYPES`.

### File names

`<domain>-<role>.gs` pattern. Role is always one of: `schema`, `core`, `validation`, `utils`, `seed`.

```
account-schema.gs
account-core.gs
account-validation.gs
account-utils.gs
account-seed.gs      ← optional
```

App-wide files use the `app-` prefix:

```
app-config.gs
app-router.gs
app-utils.gs
app-auth.gs
```

### Sheet names (in `app-config.gs`)

Plural, `snake_case`, lowercase:

```js
const TRANSACTIONS_SHEET = 'transactions';
const AUDIT_SHEET        = 'audit_access';   // compound name — underscore separator
```

### Field names (in schema objects)

`snake_case` throughout. Apply these suffixes consistently:

| Pattern | Rule | Examples |
|---|---|---|
| Booleans | `is_` prefix | `is_active`, `is_locked`, `is_loan_type` |
| Timestamps | `_at` suffix | `created_at`, `locked_at`, `last_failed_at` |
| Date-only | `_date` suffix | `transaction_date_utc`, `next_payment_date` |
| FK / reference | `_id` suffix, or bare entity name when unambiguous | `category_id`, `source_account` (not `source_account_id` when context is clear) |
| Count | `_count` suffix | `failure_count`, `referenced_count` |

The entity's own primary key is always just `id`, not `account_id` or `transaction_id`.

### Action names (router dispatch)

`verb_noun` format, `snake_case`. Verb is always one of: `list`, `get`, `create`, `update`, `delete`. Schema-fetch actions use `get_<domain>_schema`.

```
list_transactions
create_transaction
update_transaction
delete_transaction
get_transaction_schema
verify                  ← special login handshake; no noun suffix
```

### Error codes

`snake_case`, returned as the `error` field in `{ ok: false, error: '...' }` responses. Describe the condition, not the HTTP verb:

```
auth                    ← PIN incorrect
locked                  ← IP locked
invalid_json            ← malformed POST body
invalid_row             ← row_num out of bounds
missing_row_num         ← required field absent
account_in_use          ← FK constraint blocked delete
field_not_editable:id   ← colon separator for parameterised codes
```

### ID formats

Two patterns — pick based on entity type:

| Entity type | Pattern | Example |
|---|---|---|
| Event / journal (date matters) | `YYYY-MM-DD-NNN` | `2024-01-15-001` |
| Resource / entity (stable identifier) | `PREFIX-YYYYMMDD-NNN` | `ACC-20240115-001` |

`NNN` is a 3-digit zero-padded sequence, reset per date prefix, scanned from the existing sheet column. New entity types follow the resource pattern: pick a 2–4 letter uppercase prefix (`INV`, `PLN`, `CAT`).

---

## Frontend (JS) naming

### Variables and functions

`camelCase` for all variables and public functions. `_camelCase` for module-private helpers.

```js
const txEl = el('transactionsContent');
function renderTransactions() { ... }
function _attachEvents() { ... }
async function _saveTransaction(form) { ... }
```

### Constants

`UPPER_SNAKE_CASE`:

```js
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
```

### File names

`kebab-case` for all `.js` and `.css` files:

```
core/state.js
core/date-utils.js
sections/transactions.js
style/expense-tracker.css
```

### CSS class names

`kebab-case`. Shared design system classes (`.btn`, `.card`, `.table-wrap`) have no prefix. Module-specific badge or colour variants are prefixed with the module slug:

```css
/* Shared — no prefix */
.btn-primary
.table-wrap
.badge

/* Module-specific */
.badge-et-in         /* et = expense tracker slug */
.badge-et-out
```

Do not invent new utility-style classes (`.mt-4`, `.flex`) — use the existing token-based CSS.

### Element IDs

`camelCase` in HTML and JS:

```html
<div id="msgBanner">
<input id="pinInput">
<button id="themeToggle">
```

Sections use a `<sectionName>Content` pattern: `insightContent`, `transactionsContent`.

### `data-*` attributes

`kebab-case` for attribute names; values match the action vocabulary (`snake_case` verbs or camelCase section names):

```html
<button data-action="tx-edit" data-row="42">
<button data-section="transactions">
```

### State keys

`camelCase`. UI-state keys follow a `<domain><Verb>` pattern:

```js
state.txAddOpen    // boolean — add form visible
state.txViewRow    // number | null — row being viewed
state.txEditRow    // number | null — row being edited
state.txDeleteRow  // number | null — inline delete confirm
state.txDeleteBlocked  // { referenced_count: N } | null

// Insight section — domain prefix: insight
state.insightId           // string — active insight slug
state.insightPeriod       // string — active period preset
state.insightCustomFrom   // string — custom range start (YYYY-MM-DD)
state.insightCustomTo     // string — custom range end (YYYY-MM-DD)
state.insightTab          // string — 'transactions' | 'accounts'
state.insightChartInstance // Chart | null — active Chart.js instance
```

**Domain prefix register** — one prefix per section/concept:

| Prefix | Section |
|---|---|
| `tx` | Transactions |
| `acc` | Accounts |
| `cat` | Categories |
| `rate` | Rates |
| `insight` | Insight |

Map lookups are `<domain>Map`: `accountMap`, `rateMap`.

### Storage keys

`<slug>_<key>` — always prefixed with the 2–3 char module slug to avoid collisions:

| Storage | Key pattern | Examples |
|---|---|---|
| `localStorage` | `<slug>_<name>` | `et_theme`, `et_account_schema_v1` |
| `sessionStorage` | `<slug>_<name>` | `et_session` |

Schema cache keys are versioned: `et_account_schema_v1`. Bump the version suffix when the backend schema shape changes.

### Custom events

`<slug>:<verb>` format:

```js
document.dispatchEvent(new CustomEvent('et:reload'));
document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'accounts' }));
```

### Module slug

A 2–3 character lowercase abbreviation, unique across Forge modules. Used as a prefix for storage keys and custom events. Pick it when creating a new module and document it in `app/config.js`.

| Module | Slug |
|---|---|
| Expense Tracker | `et` |

---

## Cross-cutting rules

### Never abbreviate field names

Write `transaction_date_utc`, not `tx_date` or `txDate`. Abbreviations save a few characters in the source but cost far more in readability and cross-team understanding.

The only sanctioned abbreviations are:
- `ua` — `user_agent` (in the geo meta object: `{ ip, city, country, ua }`)
- Module slugs in storage/event keys (e.g. `et_session`)
- DOM shorthand helpers (`el`, `esc`) — these are established conventions

### Boolean fields use `is_` or `has_` prefix

`is_active`, `is_locked`, `is_loan_type`. Prefer `is_` unless the field describes possession: `has_overdraft` is clearer than `is_overdraft`.

### Plurals for collections

Arrays and sheet names are plural: `accounts`, `transactions`, `AUDIT_COLUMNS`, `state.categories`.
Objects and single entities are singular: `account`, `schema`, `TRANSACTION_SCHEMA`.

### Don't use generic names

`data`, `info`, `result`, `item`, `obj`, `temp` are banned as standalone variable names. Name by what the value represents: `account`, `transactionRow`, `validationResult`, `categoryList`.
