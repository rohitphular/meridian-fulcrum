# Forge — Shared Utilities

> **Scope**: The `forge/_shared/` layer — code and assets shared across ALL Forge modules. This document is the canonical catalog of what exists, what is planned, and how to extend it.

---

## What `_shared/` is

`forge/_shared/` holds frontend code (JS + CSS) that every module uses. It is loaded by `index.html` before the module's own scripts. Modules never copy from it — they import or `<script src>` it.

There is no equivalent build step. Changes to `_shared/` take effect immediately for every module that loads from that path.

Backend (GAS) has no import system — BE shared code follows a copy-and-own model described at the end of this document.

---

## Current `_shared/` inventory

```
forge/_shared/
├── style-tokens.css    ← design tokens (colours, fonts, type scale)
├── sheets-client.js    ← HTTP layer — SheetsClient global
├── auth.js             ← auth factory — createAuthModule()
├── ui.js               ← loading overlay + toast banner
└── utils.js            ← pure utility functions
```

---

## `style-tokens.css`

CSS custom properties consumed by all module stylesheets. Never edit per-module — if a new token is needed, add it here.

Full token reference: **UX-DESIGN.md § Design Tokens**.

---

## `sheets-client.js`

Non-module global script. Exposes `SheetsClient` — the HTTP abstraction for all backend calls.

```js
SheetsClient.init({ scriptUrl, pin, meta });
SheetsClient.get({ action: 'list_accounts' })              // HTTP GET
SheetsClient.post({ action: 'create_account', ...fields }) // HTTP POST
```

`Content-Type: text/plain` on POST requests — prevents CORS preflight that Apps Script cannot handle.

---

## `auth.js`

Factory function. Each module calls it once in `core/auth.js` with its own session key and reload event.

```js
import { createAuthModule } from '../../../_shared/auth.js';

export const { writeSession, readSession, clearSession,
               showPinGate, hidePinGate, submitPin, fetchGeo } =
  createAuthModule({
    sessionKey:  '<slug>_session',
    legacyKeys:  ['<slug>_pin'],
    verifyFn:    totp => MyAPI.verify(totp),
    reloadEvent: '<slug>:reload',
  });
```

Session TTL: 6 hours. `readSession()` returns `null` if expired or absent. `fetchGeo()` fetches `{ ip, city, country, ua }` from ipapi.co — included in every request body for server-side audit.

Full auth spec: **APP-AUTH.md**.

---

## `ui.js`

Loading overlay and toast banner. Import via the module's `core/ui.js` re-export.

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

## `utils.js` — function catalog

Pure utility functions. No DOM side effects except `exportData`. Modules re-export them from `core/utils.js`, optionally wrapping state-aware versions.

### DOM helpers

| Function | Signature | What it does |
|---|---|---|
| `el(id)` | `(id: string) → Element` | `document.getElementById(id)`. Use everywhere instead of the long form. |
| `esc(s)` | `(s: any) → string` | HTML-escapes a value. Use on ALL user-supplied values inserted into `innerHTML`. |

### Date utilities

| Function | Signature | What it does |
|---|---|---|
| `fmtDate(v)` | `(v: string\|Date) → string` | Format as `15 Jul 2025` |
| `fmtDateTime(v)` | `(v: string\|Date) → string` | Format as `15 Jul 2025 · 14:30` |
| `parseLocalDate(s)` | `(s: string) → Date` | Parse `YYYY-MM-DD` without timezone shift |
| `toDateInputVal(v)` | `(v: any) → string` | Convert any date string to `YYYY-MM-DD` for `<input type="date">` |
| `todayISO()` | `() → string` | Today as `YYYY-MM-DD` |
| `nowLocalISO()` | `() → string` | Now as `YYYY-MM-DDTHH:MM` for datetime-local inputs |

### Money / currency utilities

| Function | Signature | What it does |
|---|---|---|
| `getSymbol(currency, rates)` | `(currency: string, rates: Rate[]) → string` | Currency symbol (£, ₹, $) from the rates array |
| `toBase(amount, from, rowFxRate, rateMap, quoteCurrency)` | → `number` | Convert amount to quote currency using row-level rate or global rate map |
| `fmtBase(amount, from, rowFxRate, rateMap, quoteCurrency)` | → `string` | `toBase` + formatted, e.g. `£12.50` |
| `fmtNative(amount, currency, rates)` | → `string` | Formatted in source currency, e.g. `₹1,050.00` |

The module's `core/utils.js` wraps these as state-aware versions that hide the `state.rateMap` / `state.rates` / `state.quoteCurrency` arguments:

```js
// In core/utils.js — state-aware wrappers
export const fmtBase   = (a, c, r) => _fmtBase(a, c, r, state.rateMap, state.quoteCurrency);
export const fmtNative = (a, c)    => _fmtNative(a, c, state.rates);
export const getSymbol = (c)       => _getSymbol(c, state.rates);
```

### Export utilities

| Function | Signature | What it does |
|---|---|---|
| `exportData(format, rows, filename, cols)` | `('csv'\|'json', rows, filename, cols?) → void` | Downloads rows as CSV or JSON. `cols` is an optional array of column keys to include. Triggers browser download. |

### String utilities

| Function | Signature | What it does |
|---|---|---|
| `splitToList(str)` | `(str: string) → string[]` | Split comma-separated string into trimmed, non-empty array |

---

## `insight-utils.js` — insight computation helpers

Module-scoped utility library for the insight section. Lives at `sections/insights/insight-utils.js` (not in `_shared/` — it is expense-tracker specific).

All monetary computation uses the state-aware wrappers from `core/utils.js` (`fmtBase`, `fmtNative`, `getSymbol`) — these automatically read `state.rateMap`, `state.rates`, and `state.quoteCurrency`.

| Function | Signature | Returns |
|---|---|---|
| `getPeriodBounds(period, customFrom, customTo)` | period string + optional custom date strings | `{ from: Date, to: Date, compareFrom: Date, compareTo: Date }` |
| `filterTxByRange(txs, from, to)` | txs array, Date bounds | filtered array |
| `groupByDay(txs, from, to)` | filtered txs, range | `Map<'YYYY-MM-DD', tx[]>` |
| `groupByWeek(txs, from, to)` | | `Map<'YYYY-WNN', tx[]>` |
| `groupByMonth(txs, from, to)` | | `Map<'YYYY-MM', tx[]>` |
| `groupByQuarter(txs, from, to)` | | `Map<'YYYY-QN', tx[]>` |
| `sumAmountBase(txs)` | txs array | number — sum in quote currency via `toBase` |
| `cumulativeByDay(txs, from, to)` | | `{ labels: string[], values: number[] }` |
| `accountBalanceByMonth(accounts, txs, months)` | | `Map<'YYYY-MM', { [accountId]: number }>` |
| `splitTags(txs)` | | `{ tag: string, tx: object }[]` — one entry per tag per tx |
| `parsePeriodLabel(period)` | period string | human-readable label e.g. `"Jul 2026"` |

These functions are pure (except for `toBase` reading `state` via the wrapper) and can be unit-tested in isolation by passing explicit `rateMap`/`quoteCurrency` to the underlying `toBase` call.

---

## Planned utility modules

These do not yet exist as separate files. When a second module needs them, extract into dedicated files rather than duplicating:

### `date-utils.js`

Extract from `utils.js` when date functions grow beyond the current set. Candidates to add:

| Function | What it does |
|---|---|
| `startOfMonth(date)` | First day of the month containing `date` |
| `endOfMonth(date)` | Last day of the month containing `date` |
| `addDays(date, n)` | Add `n` days, return new Date |
| `isSameDay(a, b)` | Compare two dates ignoring time |
| `formatRelative(date)` | `'today'`, `'yesterday'`, `'3 days ago'`, etc. |

### `money-utils.js`

Extract from `utils.js` when currency functions grow. Candidates to add:

| Function | What it does |
|---|---|
| `parseMoney(str)` | Parse a user-typed money string to a number — handles `£1,200.50`, `1200`, `1,200` |
| `roundMoney(n, places?)` | Round to 2 decimal places (or `places`) using banker's rounding |
| `isLiabilitySign(amount, accountType)` | Returns `true` if amount represents a liability (negative stored) |

### `string-utils.js`

Extract from `utils.js` and standardise. Candidates:

| Function | What it does |
|---|---|
| `truncate(str, max)` | Truncate with ellipsis: `'long text...'` |
| `slugify(str)` | `'My Account'` → `'my-account'` |
| `normaliseTags(str)` | Split on `,` or `;`, deduplicate, rejoin with `;` (currently BE-only in `app-utils.gs`) |
| `capitalise(str)` | Capitalise first letter only |

### `storage-utils.js`

Namespaced wrapper around `localStorage` and `sessionStorage`. Prevents key collisions across modules:

```js
// Proposed API
const store = createStore('et');       // creates a namespaced store for slug 'et'
store.local.set('theme', 'dark');      // writes 'et_theme'
store.local.get('theme');             // reads 'et_theme'
store.session.set('session', blob);   // writes 'et_session'
store.session.clear();                // removes all 'et_*' keys
```

### `export-utils.js`

Extract `exportData` from `utils.js` and expand:

| Function | What it does |
|---|---|
| `exportCsv(rows, filename, cols?)` | Download as CSV |
| `exportJson(rows, filename)` | Download as JSON array |
| `copyToClipboard(text)` | Write to clipboard, returns `Promise<void>` |

---

## Backend shared code — copy-and-own model

GAS has no module system. BE "shared" code is maintained as canonical source files and copied verbatim into each module's `api/` folder when the module is created.

### Canonical source files

| Source (canonical) | Destination per module | Notes |
|---|---|---|
| `expense-tracker/api/app-utils.gs` | `<module>/api/app-utils.gs` | Copy verbatim. Contains `getOrCreateSheet`, `sheetToObjects`, `checkPin`, `json`, `normaliseTags`, `getColIndex`, etc. |
| `expense-tracker/api/app-auth.gs` | `<module>/api/app-auth.gs` | Copy verbatim. Contains TOTP implementation, `checkLocked`, `recordAccess`. Do not modify auth logic. |

### Propagating changes

If a shared BE function is fixed or improved in one module, manually copy the update to all other modules. There is no automated sync. Keep a note in the commit message: `"sync app-utils.gs fix to all modules"`.

### What goes in `app-utils.gs` vs `<domain>-utils.gs`

| Lives in `app-utils.gs` | Lives in `<domain>-utils.gs` |
|---|---|
| Sheet I/O helpers (`getOrCreateSheet`, `sheetToObjects`) | ID generation (`generateAccountId`) |
| Auth helpers (`checkPin`) | Balance adjustment (`adjustAccountBalance`) |
| Response helper (`json`) | Domain-specific computed fields |
| String/tag helpers (`normaliseTags`, `splitToList`) | Loan/utilisation calculations |
| Schema indexing (`getColIndex`) | Any helper that reads the domain's own schema |

---

## Adding a new utility to `_shared/`

1. Write the function as a pure export in a new or existing `_shared/*.js` file.
2. Write it with zero dependencies on `state`, DOM, or GAS globals — pure input/output.
3. Document it in this file under the appropriate catalog section.
4. In the module's `core/utils.js`, import and (if needed) wrap it with state-aware arguments.
5. If the function replaces a module-local duplicate, remove the duplicate.

Rule: functions in `_shared/` must be **pure** (no side effects, no globals, no DOM) except for `ui.js` (DOM side effects are its job) and `sheets-client.js` (network is its job).
