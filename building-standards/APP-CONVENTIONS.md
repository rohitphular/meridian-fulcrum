# Naming & Code Conventions

> **Scope**: All modules and services in this codebase — backend, frontend, and data pipelines. These rules apply everywhere; individual docs (APP-BE-PYTHON.md, etc.) reference this as the source of truth.

---

## JavaScript style

| Rule | Standard |
|---|---|
| Declarations | `const` by default; `let` when the variable is reassigned; never `var` at module level |
| Quotes | Single quotes `'...'` for strings. Template literals for interpolation. |
| Semicolons | Always |
| Braces | Always for `if`/`for`/`while` bodies, even one-liners in module-level code |
| Line length | Soft limit 120 chars; align related assignments with spaces where it aids reading |
| ES version | Modern ESNext — arrow functions, destructuring, spread, `for…of`, optional chaining `?.`, nullish coalescing `??` are all available |

---

## Frontend (JS) naming

### Variables and functions

`camelCase` for all variables and public functions. `_camelCase` for module-private helpers.

```js
const userList = el('userList');
function renderUsers() { ... }
function _attachEvents() { ... }
async function _saveUser(form) { ... }
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
components/user-list.js
style/app.css
```

### CSS class names

`kebab-case`. Shared design system classes (`.btn`, `.card`, `.table-wrap`) have no prefix. Feature- or module-specific variants are prefixed with the feature slug:

```css
/* Shared — no prefix */
.btn-primary
.table-wrap
.badge

/* Feature-specific */
.badge-success
.badge-warning
.badge-error
```

Do not invent new utility-style classes (`.mt-4`, `.flex`) — use the existing token-based CSS.

### `data-*` attributes

`kebab-case` for attribute names; values use `snake_case` verbs or identifiers:

```html
<button data-action="edit" data-id="42">
<button data-action="delete" data-id="42">
```

### API action names

`verb_noun` format, `snake_case`. Verb is always one of: `list`, `get`, `create`, `update`, `delete`. Schema-fetch actions use `get_<entity>_schema`. Applies to any REST/RPC-style API.

```
list_users
create_user
update_user
delete_user
get_user_schema
```

### Error codes

`snake_case`, returned as the `error` field in `{ ok: false, error: '...' }` responses. Describe the condition, not the HTTP verb:

```
invalid_input
missing_field
not_found
already_exists
field_not_editable
```

---

## Python naming

### Variables, functions, parameters

`snake_case` for everything.

```python
currency_code = 'GBP'
rate_vs_usd   = 1.0
def fetch_latest(api_key: str) -> float: ...
def _convert_to_base(amount, from_currency): ...
```

Private helpers: leading underscore `_snake_case`. Do not use double-underscore `__name` (dunder prefix is for Python magic methods only).

### Classes

`PascalCase`. One class per source concept — no utility-dump classes.

```python
class CurrencyRatesJob: ...
class ConnectionConfig: ...
```

### Constants

Public module-level constants: `UPPER_SNAKE_CASE`.

```python
AED_PER_USD     = 3.6725
TROY_OZ_TO_GRAM = 31.1035
CURRENCIES      = ['EUR', 'GBP', 'JPY']
```

Private module-level constants (not intended for import outside the module): `_UPPER_SNAKE_CASE` — leading underscore applied to the UPPER_SNAKE_CASE form.

```python
_HEADERS       = {"User-Agent": "Mozilla/5.0 ..."}
_UPSERT_SQL    = "INSERT INTO records ..."
_GET_SQL       = "SELECT id FROM ..."
```

The leading underscore signals the constant is an implementation detail of the module. It is never re-exported from a package and never imported by name from outside.

### File and folder names

`snake_case` for all `.py` files. Folder names describe their role, not the package they contain:

```
my-job/
  fetcher.py
  config.py
  runner.py
  sources/
    source_a.py
    source_b.py
  database/
    upsert.py
  migrations/
    0001_create_records.py
```

**No `__init__.py` files.** Python 3.3+ namespace packages make directories importable without them. Import explicitly by module path:

```python
# Correct — explicit, readable
import sources.source_a as source_a
from database.upsert import upsert_records

# Wrong — relies on __init__.py re-exports
from sources import source_a
```

Never create `__init__.py` just to make a directory importable.

### Type annotations

Always annotate function signatures. Omit from local variables where the type is obvious.

```python
def fetch_latest(api_key: str) -> dict[str, float]: ...
def run(self) -> None: ...
```

### Migration files

`NNNN_description.py` — four-digit zero-padded sequence, `snake_case` description, single `upgrade(client)` function.

```
0001_create_records.py
0002_add_index_on_date.py
```

---

## PostgreSQL naming

### Tables

Plural, `snake_case`, lowercase. Prefix with domain when there are many tables:

```sql
currency_master
currency_rates
sync_log
```

### Columns

`snake_case`. Apply these suffix conventions consistently:

| Pattern | Examples |
|---|---|
| Booleans: `is_` prefix | `is_active`, `is_locked` |
| Timestamps: `_at` suffix | `created_at`, `updated_at`, `rate_date` |
| FK references: `_id` suffix | `currency_id` |
| Count: `_count` suffix | `failure_count` |

Primary key is always just `id` (serial or UUID). Never `table_name_id`.

### Indexes

`idx_{table}_{columns}`:

```sql
CREATE INDEX idx_currency_rates_code_date ON currency_rates (currency_code, rate_date);
```

### Constraints

`{type}_{table}_{columns}`:

```sql
CONSTRAINT pk_currency_rates PRIMARY KEY (id)
CONSTRAINT uq_currency_rates_code_date UNIQUE (currency_code, rate_date)
CONSTRAINT fk_currency_rates_master FOREIGN KEY (currency_code) REFERENCES currency_master (code)
```

### Views

`v_{description}` — lowercase:

```sql
v_latest_rates
v_rates_to_base
```

### Functions and triggers

`snake_case`:

```sql
fn_set_updated_at()
trg_records_updated_at
```

---

## Cross-cutting rules

### Never abbreviate field names

Write `transaction_date_utc`, not `tx_date` or `txDate`. Abbreviations save a few characters in the source but cost far more in readability and cross-team understanding.

The only sanctioned abbreviations are well-established shorthand in the specific domain (e.g. `id`, `url`, `api`, `db`) or DOM shorthand helpers (`el`, `esc`) that are established conventions in the codebase.

### Boolean fields use `is_` or `has_` prefix

`is_active`, `is_locked`, `is_active`. Prefer `is_` unless the field describes possession: `has_overdraft` is clearer than `is_overdraft`.

### Plurals for collections

Arrays and table names are plural: `accounts`, `transactions`, `AUDIT_COLUMNS`.
Objects and single entities are singular: `account`, `schema`, `TRANSACTION_SCHEMA`.

### Don't use generic names

`data`, `info`, `result`, `item`, `obj`, `temp` are banned as standalone variable names. Name by what the value represents: `account`, `transactionRow`, `validationResult`, `categoryList`.
