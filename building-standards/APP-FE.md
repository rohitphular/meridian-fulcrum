# Forge Frontend — Coding Guide

> **Audience**: LLMs and developers creating new Forge module frontends.
> **Stack**: Vanilla JS ES modules · no framework · no build step · Google Sheets backend via GAS

---

## What a Forge frontend is

Each module's `app/` folder is a static single-page app. There is no bundler, no transpiler, no `node_modules`. The files you write are exactly the files that run in the browser. Open `index.html` and it works.

The frontend talks to one endpoint: the Google Apps Script `/exec` URL configured in `config.js`. Every backend call is an HTTP request routed by `action` parameter.

---

## File structure

```
app/
├── index.html              HTML shell — auth overlay, header, tab nav, section mounts
├── main.js                 Boot: theme, auth, load data, wire tab nav and global events
├── config.js               Sets window.CONFIG.SCRIPT_URL (committed, auto-picks dev/prod)
│
├── core/                   Cross-cutting modules, imported by sections
│   ├── state.js              Single mutable state object — the only source of truth
│   ├── api.js                Typed wrappers over SheetsClient (one fn per backend action)
│   ├── auth.js               PIN + TOTP gate, session management
│   ├── schema.js             Loads backend entity schemas and caches them in localStorage
│   ├── nav.js                showSection(name) — swaps visible tab + calls render fn
│   ├── daterange.js          getRangeBounds() / filteredTx() — date filter logic
│   ├── utils.js              Re-exports from _shared/utils.js, adds state-aware wrappers
│   └── ui.js                 Re-exports showLoading / hideLoading / showMsg from _shared
│
├── sections/               One file per tab; each exports a single render<Name>() fn
│   ├── insights.js
│   ├── transactions.js
│   ├── accounts.js
│   ├── categories.js
│   ├── rates.js
│   └── advisor.js
│
└── style/
    └── <module-name>.css   All module styles — light + dark themes
```

The `_shared/` folder (at `forge/_shared/`) holds code shared across ALL modules. Do not copy-paste from it — import from it.

---

## config.js — the backend URL

`config.js` is the one file that wires the frontend to its backend. It is committed to git and sets `window.CONFIG`:

```js
window.CONFIG = (() => {
  const isHosted = location.hostname.endsWith('.github.io');
  const DEV_SCRIPT_URL  = 'https://script.google.com/macros/s/<dev-id>/exec';
  const PROD_SCRIPT_URL = 'https://script.google.com/macros/s/<prod-id>/exec';
  return { SCRIPT_URL: isHosted ? PROD_SCRIPT_URL : DEV_SCRIPT_URL };
})();
```

Rules:
- `file://` or `localhost` → uses `DEV_SCRIPT_URL`.
- `*.github.io` → uses `PROD_SCRIPT_URL`.
- Never put secrets here — these are public URLs.
- Do not gitignore `config.js`. It contains public IDs, not credentials.
- `index.html` loads it with `onerror="window.__configMissing=true"` so `main.js` can show a setup banner when it's missing.

---

## How the app boots

1. `index.html` loads in this order:
   - Google Fonts
   - `../../_shared/style-tokens.css` (design tokens — CSS variables)
   - `style/<module>.css` (module styles)
   - `../../_shared/sheets-client.js` (HTTP layer, non-module script)
   - `config.js` (sets `window.CONFIG`, non-module script)
   - Chart.js CDN (if needed)
   - `main.js` as `type="module"` (boot entry point)

2. `main.js` runs `init()` on `DOMContentLoaded`:
   - Applies saved theme (or prefers-color-scheme).
   - Reads `readSession()` from `sessionStorage`.
   - If no session → `showPinGate()`. If session → `hidePinGate()` + `loadAll()`.

3. `loadAll()` fetches all data in parallel (`Promise.all`), populates `state`, then calls `showSection(activeSection)`.

4. `showSection(name)` hides all other `<section>` elements, activates the matching tab button, and calls the section's `renderXxx()`.

5. On any data mutation, the section dispatches `document.dispatchEvent(new CustomEvent('<module>:reload'))`. `main.js` listens on this event and re-runs `loadAll()`.

---

## The _shared layer

These files live at `forge/_shared/` and are loaded by every module. Never copy their code — always import or load them via `<script src>`.

### `_shared/sheets-client.js`

Non-module script. Exposes the global `SheetsClient` object — the HTTP layer. All backend calls go through it.

```js
SheetsClient.init({ scriptUrl: window.CONFIG.SCRIPT_URL, pin: session.pin, meta });
// meta = { ip, city, country, ua } — included in every request for server-side audit logging

// READ (HTTP GET — sends pin + meta as query params)
SheetsClient.get({ action: 'list_transactions' })

// WRITE (HTTP POST — body is JSON, Content-Type: text/plain to skip CORS preflight)
SheetsClient.post({ action: 'create_transaction', amount: 50, ... })
```

`Content-Type: text/plain` is intentional — Apps Script can't handle `application/json` preflight.

### `_shared/auth.js`

Exports `createAuthModule(config)` — call it once in `core/auth.js` to get PIN/TOTP gate functions:

```js
// core/auth.js
import { createAuthModule } from '../../../_shared/auth.js';
import { ExpenseAPI } from './api.js';

export const { writeSession, readSession, clearSession, showPinGate, hidePinGate, submitPin, fetchGeo } =
  createAuthModule({
    sessionKey:  'et_session',        // sessionStorage key
    legacyKeys:  ['et_pin'],          // old keys to clear on logout
    verifyFn:    totp => ExpenseAPI.verify(totp),  // backend verify call
    reloadEvent: 'et:reload',         // event name fired after successful login
  });
```

Session TTL is 6 hours. `readSession()` returns null if expired or missing. `fetchGeo()` hits ipapi.co for IP/city/country used in server-side audit logging.

### `_shared/ui.js`

Loading overlay + toast. Import via `core/ui.js`:

```js
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
```

- `showLoading()` / `hideLoading()` — reference-counted; nested calls are safe.
- `showMsg(text, type?)` — shows `#msgBanner` for 4.5s. `type` is `'success'` (default) or `'warn'`.
- `showMsg` uses `textContent`, never `innerHTML` — safe for user-supplied strings.

### `_shared/utils.js`

Pure utility functions. The module's `core/utils.js` re-exports them and adds state-aware currency wrappers:

| Function | What it does |
|---|---|
| `el(id)` | `document.getElementById(id)` — use everywhere instead of the long form |
| `esc(s)` | HTML-escape a string — use on ALL user-supplied values inserted into innerHTML |
| `fmtDate(v)` | Format a date string as `15 Jul 2025` |
| `fmtDateTime(v)` | Format as `15 Jul 2025 · 14:30` |
| `fmtDateTimeCompact(v)` | Shorter: `15 Jul · 14:30` (defined in `core/utils.js`) |
| `parseLocalDate(s)` | Parse `YYYY-MM-DD` string to a local Date without timezone shift |
| `toDateInputVal(v)` | Convert any date string to `YYYY-MM-DD` for `<input type="date">` |
| `todayISO()` | `YYYY-MM-DD` for today |
| `nowLocalISO()` | `YYYY-MM-DDTHH:MM` for datetime-local inputs |
| `getSymbol(currency, rates)` | Currency symbol from the rates array |
| `toBase(amount, from, rowFxRate, rateMap, quoteCurrency)` | Convert amount to quote currency |
| `fmtBase(...)` | Formatted base-currency string, e.g. `£12.50` |
| `fmtNative(amount, currency, rates)` | Formatted in the source currency, e.g. `₹1,050.00` |
| `exportData(format, rows, filename, cols)` | Download rows as CSV or JSON |

The state-aware wrappers in `core/utils.js` hide the `state.rateMap` / `state.rates` / `state.quoteCurrency` arguments so call sites are clean:

```js
// In a section — no need to pass rateMap etc.
fmtBase(tx.amount, tx.currency, tx.fx_rate)
fmtNative(tx.amount, tx.currency)
getSymbol(a.currency)
```

---

## core/state.js — the state object

A single exported `state` object. No reactive proxy, no Redux, no events. Sections read and write it directly, then call their own `renderXxx()` to repaint.

```js
export const state = {
  // Data
  transactions: [],
  accounts:     [],
  accountMap:   {},       // { 'acc-001': account } — keyed by id, built in loadAll
  categories:   [],
  rates:        [],
  rateMap:      {},       // { 'GBP': 1, 'INR': 105 } — built in loadAll
  quoteCurrency: 'GBP',

  // Schemas (loaded from backend, cached in localStorage)
  accountSchema:     null,
  transactionSchema: null,
  categorySchema:    null,

  // Insight date filter
  dateRange:  'this_month',
  customFrom: '',
  customTo:   '',

  // Transaction filter bar state
  filters: { types: [], accounts: [], major: [], minor: [], search: '', ... },
  txSort:    { col: 'transaction_date_utc', dir: 'desc' },
  txPage:    1,
  txPerPage: 50,

  // Per-section UI state (same pattern for each entity)
  txAddOpen:    false,    // add form is open
  txViewRow:    null,     // _row number of the row being viewed
  txEditRow:    null,     // _row number of the row being edited
  txDeleteRow:  null,     // _row number of the inline delete confirmation

  accAddOpen:   false,
  accViewRow:   null,
  accEditRow:   null,
  accDeleteRow: null,
  accDeleteBlocked: null, // { referenced_count: N } when delete is refused

  // ... same shape for categories, rates, etc.
};
```

Rules:
- Add new state keys when you add a new section — don't invent local module variables for UI state.
- `accountMap` and `rateMap` are always derived from `accounts` and `rates` respectively, rebuilt in `loadAll`.
- `xxxDeleteBlocked` pattern: when the backend refuses a delete (e.g. account has transactions), store the error here and read it in `renderXxx()` to show a blocked message. Set to `null` to dismiss.

---

## core/api.js — backend action wrappers

One function per backend action. Uses `SheetsClient.get()` for reads, `SheetsClient.post()` for writes.

```js
export const ExpenseAPI = {
  listTransactions:   ()  => SheetsClient.get({ action: 'list_transactions' }),
  createTransaction:  f   => SheetsClient.post({ action: 'create_transaction', ...f }),
  updateTransaction:  f   => SheetsClient.post({ action: 'update_transaction', ...f }),
  deleteTransaction:  f   => SheetsClient.post({ action: 'delete_transaction', ...f }),
  getTransactionSchema: () => SheetsClient.get({ action: 'get_transaction_schema' }),
  // ... one entry per backend action
};
```

All responses have shape `{ ok: boolean, data?: any, error?: string }`. Always check `.ok` before reading `.data`.

---

## core/schema.js — schema loading and caching

Schemas are fetched once per browser session and cached in `localStorage`. Sections read them from `state.accountSchema` / `state.transactionSchema` / `state.categorySchema` — never call `ExpenseAPI.getXxxSchema()` directly from a section.

```js
// Schema cache keys are versioned (e.g. 'et_account_schema_v1'). Bump the version
// when the backend schema shape changes to bust stale caches.
```

If a schema fetch fails, it returns `null`. Sections must handle `null` gracefully by falling back to hardcoded defaults where possible.

---

## core/daterange.js — date filtering

Two exports used by sections that filter by date:

- `getRangeBounds()` — returns `{ from: Date, to: Date }` based on `state.dateRange` / `state.customFrom` / `state.customTo`.
- `filteredTx()` — filters `state.transactions` by date range AND all active `state.filters`. Returns the filtered array.

Date range values: `this_month`, `last_month`, `last_3`, `last_6`, `last_12`, `ytd`, `all`, `custom`.

---

## The section pattern

Every section file exports one function: `renderXxx()`. It does two things:

1. Sets `innerHTML` of the section's content element.
2. Attaches all event listeners.

```js
export function renderTransactions() {
  const txEl = el('transactionsContent');
  txEl.innerHTML = `...`;        // build HTML string
  _attachEvents();               // bind all listeners synchronously
}
```

### HTML structure

Every section follows the same visual layout:

```
┌─ sec-head ──────────────────────────────────┐
│  <h2>Section Title</h2>    [+ Add / × Close]│
├─────────────────────────────────────────────┤
│  Add form    — visible when xxxAddOpen       │
│  View card   — visible when xxxViewRow       │
│  Edit form   — visible when xxxEditRow       │
├─────────────────────────────────────────────┤
│  Summary row (optional)                      │
│  Table (desktop)                             │
│  Card list (mobile, <640px)                  │
└─────────────────────────────────────────────┘
```

The add/view/edit cards render ABOVE the table. There is no inline row expansion. Delete confirmation is the exception — it replaces the row inline as a one-line confirm strip.

### Opening/closing cards

State drives what renders. To open a form, set state and re-render:

```js
// Open add form
state.txAddOpen = true;
renderTransactions();

// Open edit form for a specific row
state.txEditRow = tx._row;
renderTransactions();

// Close everything
state.txAddOpen = false;
state.txViewRow = null;
state.txEditRow = null;
state.txDeleteRow = null;
renderTransactions();
```

The + Add button text should toggle between `+ Add` and `× Close` based on whether `anyFormOpen` is true.

### Event delegation

Action buttons carry `data-action` and `data-row` attributes. Use a single delegated listener on the content element:

```js
txEl.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const row    = parseInt(btn.dataset.row, 10);

  if (action === 'tx-edit')   { state.txEditRow   = row; renderTransactions(); }
  if (action === 'tx-view')   { state.txViewRow   = row; renderTransactions(); }
  if (action === 'tx-delete') { state.txDeleteRow = row; renderTransactions(); }
  if (action === 'tx-delete-confirm') { _deleteTransaction(row); }
  if (action === 'tx-delete-cancel')  { state.txDeleteRow = null; renderTransactions(); }
});
```

Do not use `querySelectorAll` + individual `addEventListener` for action buttons. Delegation is safer — it works even if the element is replaced by a re-render mid-interaction.

### Saving data (create / update)

```js
async function _saveTransaction(form) {
  showLoading();
  const res = await ExpenseAPI.createTransaction({ ...form });
  hideLoading();
  if (!res.ok) {
    showMsg('Save failed: ' + (res.error || 'unknown'), 'warn');
    return;
  }
  state.txAddOpen = false;
  document.dispatchEvent(new CustomEvent('et:reload'));  // triggers loadAll + re-render
}
```

Always dispatch `<module>:reload` after a successful mutation — never call `loadAll()` or `renderXxx()` directly after a save.

### Insight sub-sections

The insight section (`sections/insights.js`) is a coordinator — it owns the selector, period picker, and tab strip, and delegates rendering to one of 28 sub-modules in `sections/insights/`.

Each sub-module exports a single function:

```js
// sections/insights/08-category-pie.js
export function render(containerId, options) {
  const container = el(containerId);
  container.innerHTML = _buildHtml(options);  // set innerHTML first
  _attachEvents(containerId, options);         // then attach events
  return _buildChart(containerId, options);   // then create chart; return instance
}
```

`insights.js` calls `render()` and stores the returned instance in `state.dashChartInstance`. Before every render, it calls `state.dashChartInstance.destroy()` to avoid canvas context leaks.

**Chart.js color values** must be read from CSS at runtime via `getComputedStyle(document.documentElement).getPropertyValue('--teal').trim()`. CSS `var(--token)` strings cannot be passed directly to Chart.js dataset properties.

**Dark mode**: when the theme changes, re-render the active insight so Chart.js picks up the new CSS variable values. Wire this in the existing `setTheme()` call in `main.js`.

State keys for the insight section (add to `core/state.js`):

```js
dashId:            '01-mom-cumulative',
dashPeriod:        'this_month',
dashCustomFrom:    '',
dashCustomTo:      '',
dashTab:           'transactions',
dashChartInstance: null,
```

---

### Pagination

Pagination state lives in `state` (`txPage`, `txPerPage`). Calculate `start` / `end` indices inside the render function:

```js
const pages = Math.max(1, Math.ceil(sorted.length / state.txPerPage));
if (state.txPage > pages) state.txPage = 1;
const paged = sorted.slice((state.txPage - 1) * state.txPerPage, state.txPage * state.txPerPage);
```

Attach page-change listeners in the same `_attachEvents()` pass that attaches action listeners.

### Sorting

Sort state: `{ col: 'field_name', dir: 'asc' | 'desc' }`. Column headers carry `data-sort="field_name"`. Toggling the same column flips `dir`; clicking a different column resets to `asc`.

---

## index.html structure

Key element IDs used by core modules — these must be present in any Forge module's `index.html`:

| Element ID | Purpose |
|---|---|
| `#pinOverlay` | Auth overlay shown before login |
| `#appShell` | Main app container, hidden until authenticated |
| `#pinInput` | PIN password input |
| `#totpInput` | TOTP 6-digit input |
| `#pinSubmit` | Sign-in button |
| `#pinError` | Error message area on the PIN card |
| `#tabNav` | Container for tab buttons |
| `#msgBanner` | Toast banner (managed by `showMsg`) |
| `#msgText` | Text node inside the toast banner |
| `#msgIco` | Icon inside the toast banner |
| `#themeToggle` | Dark/light toggle button |
| `#<sectionName>` | `<section class="app-section">` for each tab |
| `#<sectionName>Content` | Inner div where `renderXxx()` sets innerHTML |

Tab buttons use `data-section="<name>"` to match the section's `id`.

Each `<section>` except the first starts with `class="app-section hidden"`. `showSection` removes/adds `hidden`.

Script loading order in `<body>` (before `</body>`):
1. `../../_shared/sheets-client.js` — non-module, must come first (no import)
2. `config.js` — non-module, sets `window.CONFIG`
3. Any CDN scripts (Chart.js, etc.)
4. `main.js` as `type="module"` — last

---

## Design system

Design tokens live in `_shared/style-tokens.css`. Never define raw pixel sizes or hex colours in module CSS — always use tokens.

### Colour tokens

| Token | Use |
|---|---|
| `--ink` | Primary text |
| `--canvas` | Page background |
| `--panel` | Card / panel background |
| `--ember` | Brand accent (orange-red) — CTA buttons, highlights |
| `--ember-soft` | Soft ember background for badges, chips |
| `--teal` | Secondary accent — success, positive values |
| `--teal-soft` | Soft teal background |
| `--muted` | Secondary / de-emphasised text |
| `--hair` | Subtle divider lines |
| `--hair-strong` | Stronger divider |
| `--row-hover` | Table row hover background |

All tokens remap under `[data-theme="dark"]` — no per-rule dark mode overrides needed.

### Type scale tokens

| Token | Size |
|---|---|
| `--text-2xs` | 10px |
| `--text-xs` | 11px |
| `--text-sm` | 12px |
| `--text-base` | 13.5px |
| `--text-md` | 14px |
| `--text-lg` | 15px |
| `--text-xl` | 18px |
| `--text-2xl` | 20px |
| `--text-3xl` | 22px |

Never use `font-size: 14px`. Use `font-size: var(--text-md)`.

### Typography tokens

| Token | Font |
|---|---|
| `--grotesk` | Space Grotesk (sans) |
| `--mono` | IBM Plex Mono |

### Brand wordmark

The module name uses a two-span pattern:

```html
<h1><span class="brand-dim">Expense</span> <span class="brand-ember">Tracker</span></h1>
```

First word: muted, weight 400. Second word: ember colour. Use this whenever the app name appears in a heading.

### Dark mode

Toggle with `document.documentElement.setAttribute('data-theme', 'dark' | 'light')`. Persist to `localStorage`. Re-render the active section when the theme changes (chart colours depend on CSS variables).

### Standard CSS classes

These are defined in module CSS but follow a consistent naming convention:

| Class | Element |
|---|---|
| `.btn .btn-primary` | Primary action button (ember fill) |
| `.btn .btn-secondary` | Secondary button (outline) |
| `.btn-sm` | Small variant |
| `.btn-link` | Inline text link button |
| `.btn-link.danger` | Red destructive link button |
| `.btn-link.muted` | Muted secondary link button |
| `.badge` | Inline badge chip |
| `.badge-in` / `.badge-out` / `.badge-transfer` | Transaction type colours |
| `.badge-warn` | Warning indicator |
| `.card` | Content card (add/view/edit forms) |
| `.sec-head` | Section header row with title + action button |
| `.app-section` | Each tab's `<section>` |
| `.table-wrap` | Overflow-x scroll wrapper for tables |
| `.td-mono` | Monospace table cell (amounts, IDs) |
| `.td-nowrap` | No-wrap cell |
| `.td-truncate` | Truncate with ellipsis |
| `.row-actions` | Inline View / Edit / Delete button group |
| `.hidden` | `display: none` — toggled by JS, not CSS classes |

---

## Coding guidelines

> Naming conventions (variables, functions, CSS classes, state keys, storage keys, custom events) are in **APP-CONVENTIONS.md**.
> Logging standards (format, what to log, what not to log) are in **APP-LOGGING.md**.
> Shared utility catalog and how to extend `_shared/` are in **APP-SHARED-UTILS.md**.

### Always escape user data

Any value that came from the backend — account names, categories, transaction notes — could contain HTML special characters. Always wrap in `esc()` before putting into a template literal.

```js
// Wrong
`<td>${tx.counterparty}</td>`

// Correct
`<td>${esc(tx.counterparty)}</td>`
```

### Build HTML with template literals, attach events after

Set `innerHTML` in one block, then attach listeners in a separate function. Do not interleave HTML construction with `addEventListener` calls.

```js
// Correct
el('content').innerHTML = `<button id="saveBtn">Save</button>`;
el('saveBtn').addEventListener('click', handleSave);

// Wrong — element doesn't exist when addEventListener is called
el('content').innerHTML = `<button id="saveBtn">Save</button>`;
el('saveBtn').addEventListener('click', handleSave); // only works by chance
```

### No setTimeout for event binding

Events are always bound synchronously after `innerHTML` is set. Never use `setTimeout(0)` to defer binding.

### Use `el()` not `document.getElementById`

```js
// Correct
el('saveBtn').addEventListener(...)

// Wrong
document.getElementById('saveBtn').addEventListener(...)
```

### Schema-driven dropdowns

Do not hardcode enum values in section HTML. Read them from `state.accountSchema`, `state.transactionSchema`, `state.categorySchema`. These are loaded from the backend at boot. If the schema is null (loading failed), fall back to a small hardcoded default.

```js
// Correct — schema-driven
const types = state.transactionSchema?.types || [
  { value: 'money-in', label: 'Money In' },
  { value: 'money-out', label: 'Money Out' },
];
const opts = types.map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('');

// Wrong — hardcoded
`<option value="money-in">Money In</option>`
```

### Row identity is `_row`

Rows from the backend include `_row` (the 1-based sheet row number, added by `sheetToObjectsWithRow`). This is the identity to send in update and delete requests. Store it in `data-row` attributes on action buttons.

### `accountMap` for name lookups

```js
// Correct
const name = state.accountMap[tx.source_account]?.name || '—';

// Wrong — O(n) scan inside a render loop
const account = state.accounts.find(a => a.id === tx.source_account);
```

### Formatting numbers

- For source-currency display: `fmtNative(amount, currency)` — e.g. `₹1,050.00`
- For quote-currency equivalent: `fmtBase(amount, currency, fxRate)` — e.g. `£9.99`
- For balance display: `Math.abs(balance).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` — liabilities are stored negative, display as positive

---

## File length guidelines

| File | Typical size | Notes |
|---|---|---|
| `index.html` | 100–150 lines | Grows linearly with sections |
| `main.js` | 150–200 lines | Fixed shape; adds ~15 lines per section |
| `config.js` | 10–15 lines | Always minimal |
| `core/state.js` | 50–80 lines | Grows with section count |
| `core/api.js` | 25–50 lines | One line per backend action |
| `core/auth.js` | 10–15 lines | Just the `createAuthModule` call |
| `core/schema.js` | 30–50 lines | One load function per schema |
| `core/utils.js` | 30–50 lines | Re-exports + state-aware wrappers |
| `core/nav.js` | 25–35 lines | Grows with section count |
| `core/daterange.js` | 50–70 lines | Fixed |
| `sections/<name>.js` | 150–1200 lines | Depends on entity complexity; transactions is largest |
| `style/<module>.css` | 300–800 lines | Single file for all module styles |

Split a section file only if a large private helper function (e.g. a form renderer or a table renderer) can be cleanly isolated. The public export `renderXxx()` always stays in `sections/<name>.js`.

---

## Adding a new section — checklist

1. **State** — add `xxxAddOpen`, `xxxViewRow`, `xxxEditRow`, `xxxDeleteRow` keys to `core/state.js`.
2. **API** — add `listXxx`, `createXxx`, `updateXxx`, `deleteXxx`, `getXxxSchema` to `core/api.js`.
3. **Schema** — add `loadXxxSchema()` to `core/schema.js` with a localStorage cache key.
4. **Section file** — create `sections/<name>.js` exporting `renderXxx()`.
5. **nav.js** — import `renderXxx` and add it to `showSection`'s dispatch.
6. **main.js** — import `renderXxx`, add it to `loadAll`'s `Promise.all`, and handle the schema result on `state`.
7. **index.html** — add a `<button class="tab-btn" data-section="<name>">Label</button>` to `#tabNav`, and a `<section class="app-section hidden" id="<name>"><div id="<name>Content"></div></section>` to `<main>`.
8. **Styles** — add section-specific CSS to `style/<module>.css` using existing tokens.

---

## Running locally

```bash
# HTTP server required — file:// is blocked at the HTML level
make app-start
# → http://localhost:8000/expense-tracker/app/
# Serves from forge/ so ../../_shared/ paths resolve correctly
```

Frontend changes do NOT go through `cicd/deploy.sh` — that script is backend-only. To publish frontend changes, commit and push to the main branch. GitHub Pages serves from main automatically.
