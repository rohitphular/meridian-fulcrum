# Shared Code Organization — Guide

> **Scope**: All modules — patterns for organizing, cataloging, and consuming shared code across frontend and backend.

---

## What shared code is

Shared code is any code used by more than one module. It lives in a designated shared location. Modules import or load from it; they never copy-paste from it.

There are two distinct shared layers by stack:

| Layer | Location | Consumption model |
|---|---|---|
| Frontend (JS + CSS) | `_shared/` folder | Import or `<script src>` — no build step |
| Backend (Python) | `meridian-common-libs` packages | `pyproject.toml` git source dependency |
| Backend (no module system) | Canonical source files | Copy-and-own — manually synced |

---

## Frontend shared layer

A `_shared/` (or `shared/`) folder at a level above all module `app/` folders holds JS and CSS that every module loads. `index.html` loads it before the module's own scripts.

There is no build step. Changes to `_shared/` take effect immediately for every module that loads from that path.

### Standard shared files

| File | What it provides |
|---|---|
| `style-tokens.css` | Design tokens (colours, fonts, type scale) — never edit per-module |
| `http-client.js` | HTTP abstraction — one global object for all backend calls |
| `auth.js` | Auth factory — `createAuthModule(config)` |
| `ui.js` | Loading overlay + toast banner |
| `utils.js` | Pure utility functions (DOM, date, string, export) |

---

## Frontend utility catalog

### DOM helpers

| Function | Signature | What it does |
|---|---|---|
| `el(id)` | `(id: string) → Element` | `document.getElementById(id)` — use everywhere instead of the long form |
| `esc(s)` | `(s: any) → string` | HTML-escapes a value — use on ALL user-supplied values inserted into `innerHTML` |

### Date utilities

| Function | Signature | What it does |
|---|---|---|
| `fmtDate(v)` | `(v: string\|Date) → string` | Human-readable short date, e.g. `15 Jul 2025` |
| `fmtDateTime(v)` | `(v: string\|Date) → string` | Date + time, e.g. `15 Jul 2025 · 14:30` |
| `parseLocalDate(s)` | `(s: string) → Date` | Parse `YYYY-MM-DD` without timezone shift |
| `toDateInputVal(v)` | `(v: any) → string` | Convert any date value to `YYYY-MM-DD` for `<input type="date">` |
| `todayISO()` | `() → string` | Today as `YYYY-MM-DD` |
| `nowLocalISO()` | `() → string` | Now as `YYYY-MM-DDTHH:MM` for datetime-local inputs |

Planned additions (extract into `date-utils.js` when a second module needs them):

| Function | What it does |
|---|---|
| `startOfMonth(date)` | First day of the month containing `date` |
| `endOfMonth(date)` | Last day of the month containing `date` |
| `addDays(date, n)` | Add `n` days, return new Date |
| `isSameDay(a, b)` | Compare two dates ignoring time |
| `formatRelative(date)` | `'today'`, `'yesterday'`, `'3 days ago'`, etc. |

### Number / money utilities

| Function | Signature | What it does |
|---|---|---|
| `fmtNumber(n, decimals?)` | `(n: number, decimals?: number) → string` | Format number with locale separators |
| `fmtCurrency(n, currency)` | `(n: number, currency: string) → string` | Format as a currency string, e.g. `£12.50` |

Planned additions (extract into `money-utils.js` when needed):

| Function | What it does |
|---|---|
| `parseMoney(str)` | Parse a user-typed money string — handles `£1,200.50`, `1200`, `1,200` |
| `roundMoney(n, places?)` | Round to 2 decimal places using banker's rounding |

### String utilities

| Function | Signature | What it does |
|---|---|---|
| `truncate(str, max)` | `(str: string, max: number) → string` | Truncate with ellipsis: `'long text...'` |
| `slugify(str)` | `(str: string) → string` | `'My Item'` → `'my-item'` |
| `splitToList(str)` | `(str: string) → string[]` | Split delimiter-separated string into trimmed, non-empty array |
| `capitalise(str)` | `(str: string) → string` | Capitalise first letter only |
| `normaliseTags(str)` | `(str: string) → string` | Split on `,` or `;`, deduplicate, rejoin with `;` |

### Storage utilities

Namespaced wrapper around `localStorage` and `sessionStorage`. Prevents key collisions across modules loaded in the same browser:

```js
const store = createStore('<slug>');      // namespaced store for this module
store.local.set('theme', 'dark');         // writes '<slug>_theme'
store.local.get('theme');                 // reads '<slug>_theme'
store.session.set('session', blob);       // writes '<slug>_session'
store.session.clear();                    // removes all '<slug>_*' keys
```

### Export utilities

| Function | What it does |
|---|---|
| `exportCsv(rows, filename, cols?)` | Download rows as CSV. `cols` limits which keys to include. |
| `exportJson(rows, filename)` | Download rows as a JSON array. |
| `copyToClipboard(text)` | Write to clipboard — returns `Promise<void>`. |

### UI utilities (`ui.js`)

Loading overlay and toast banner. Import via the module's `core/ui.js` re-export:

```js
import { showLoading, hideLoading, showMsg } from '../core/ui.js';

showLoading();
try {
  const res = await API.createItem(form);
} finally {
  hideLoading();
}
showMsg('Item saved');
showMsg('Save failed: ' + res.error, 'warn');
```

- `showLoading` / `hideLoading` are reference-counted — nested calls are safe.
- `showMsg(text, type?)` — `type` is `'success'` (default) or `'warn'`. Auto-dismisses after 4.5s.
- Uses `textContent` internally — safe for user-supplied strings, no XSS risk.

---

## Backend shared code — library model (Python)

Python modules consume shared code as packages from `meridian-common-libs` via git source in `pyproject.toml`:

```toml
[tool.uv.sources]
py-logging    = { git = "git+ssh://git@github.com/rohitphular/meridian-common-libs.git", subdirectory = "py-logging" }
py-db-migrate = { git = "git+ssh://git@github.com/rohitphular/meridian-common-libs.git", subdirectory = "py-db-migrate" }
```

See `APP-BE-PYTHON.md § Shared libraries` for the full catalog and usage patterns.

---

## Backend shared code — copy-and-own model

When the backend runtime has no module system (e.g. a script environment where all files share one global scope), shared code is maintained as canonical source files and copied verbatim into each module at creation time.

### Rules

- Never modify a copy in a module directly — fix the canonical source, then propagate.
- Propagating changes: manually copy the updated file to all modules. Commit message convention: `"sync <filename> fix to all modules"`.
- There is no automated sync — discipline in commit messages is the only audit trail.

### What goes in shared vs domain helpers

| Shared (cross-domain) | Domain-specific |
|---|---|
| I/O layer helpers (data access, HTTP response wrapper) | ID generation |
| Auth helpers | Balance / computed field adjustment |
| String / tag normalisation | Domain-specific computed fields |
| Schema indexing utilities | Any helper that reads a specific entity's schema |

---

## What goes in shared vs module-specific

| Put in `_shared/` | Keep in module |
|---|---|
| Pure utility functions (no side effects, no state) | Business logic and entity rules |
| Design tokens and base CSS | Module-specific styles |
| Auth factory (config-driven) | Module's configured auth instance |
| HTTP client abstraction | Module-specific API wrappers |
| Generic UI primitives (loading, toast) | Section-specific UI components |

---

## Adding a new utility to `_shared/`

1. Write the function as a pure export in a new or existing `_shared/*.js` file.
2. Write it with zero dependencies on module state, DOM globals, or any module-specific config — pure input/output.
3. Document it in this file under the appropriate catalog section.
4. In the consuming module's `core/utils.js`, import and (if needed) wrap it with state-aware arguments.
5. If the function replaces a module-local duplicate, remove the duplicate.

**Rule**: functions in `_shared/` must be pure (no side effects, no globals, no DOM access) except for designated side-effect files (`ui.js` for DOM, `http-client.js` for network). This keeps shared utilities testable without a DOM environment.

---

## Planned extraction pattern

Do not extract into a dedicated file prematurely. Extract when a second module needs the same set of functions:

1. Move the functions from `utils.js` into the new focused file (e.g. `date-utils.js`).
2. Re-export them from `utils.js` so existing imports don't break.
3. Update this catalog — mark the planned module as shipped.
