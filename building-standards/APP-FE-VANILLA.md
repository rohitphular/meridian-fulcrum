# Frontend Coding Guide — Vanilla JS

> **Audience**: LLMs and developers building frontend modules in this codebase.
> **Stack**: Vanilla JS ES modules · no framework · no build step · REST/JSON backend
> **Architecture contract**: `APP-FE-PATTERNS.md` — read that first for the framework-agnostic frontend patterns this guide implements in vanilla JS.

---

## What this frontend is

Each module's `app/` folder is a static single-page app. There is no bundler, no transpiler, no `node_modules`. The files you write are exactly the files that run in the browser.

The frontend talks to a backend via HTTP. Every backend call is a typed function in `core/api.js` — sections never call `fetch` directly.

---

## File structure

```
app/
├── index.html              HTML shell — auth overlay, header, tab nav, section mounts
├── main.js                 Boot: theme, auth, load data, wire tab nav and global events
├── config.js               Sets window.CONFIG (backend URL, env detection — committed to git)
│
├── core/                   Cross-cutting modules, imported by sections
│   ├── state.js              Single mutable state object — the only source of truth
│   ├── api.js                Typed wrappers over fetch (one fn per backend action)
│   ├── auth.js               Auth gate and session management
│   ├── schema.js             Loads backend entity schemas and caches them in localStorage
│   ├── nav.js                showSection(name) — swaps visible tab + calls render fn
│   ├── utils.js              Pure utility functions (el, esc, date formatting, etc.)
│   └── ui.js                 showLoading / hideLoading / showMsg
│
├── sections/               One file per tab; each exports a single render<Name>() fn
│   └── <name>.js
│
└── style/
    └── <module-name>.css   All module styles — light + dark themes
```

---

## config.js — runtime configuration

`config.js` wires the frontend to its backend. It is **committed to git** and sets `window.CONFIG`:

```js
window.CONFIG = (() => {
  const isProd = location.hostname !== 'localhost' && !location.hostname.startsWith('127.');
  const DEV_API_URL  = 'https://api-dev.example.com';
  const PROD_API_URL = 'https://api.example.com';
  return { API_URL: isProd ? PROD_API_URL : DEV_API_URL };
})();
```

Rules:
- Detect environment at runtime via `location.hostname` — never bake the environment in at build time.
- Never put secrets here — these are public URLs and identifiers only.
- `index.html` loads it with `onerror="window.__configMissing=true"` so `main.js` can show a setup banner when it's missing.

---

## How the app boots

1. `index.html` loads scripts in order:
   - CSS (design tokens, then module styles)
   - `config.js` — non-module, sets `window.CONFIG`
   - Any CDN scripts (charts, etc.)
   - `main.js` as `type="module"` — last

2. `main.js` runs `init()` on `DOMContentLoaded`:
   - Applies saved theme (or `prefers-color-scheme`).
   - Reads session from `sessionStorage`.
   - If no session → show auth gate. If session → hide gate + `loadAll()`.

3. `loadAll()` fetches all data in parallel (`Promise.all`), populates `state`, then calls `showSection(activeSection)`.

4. `showSection(name)` hides all other `<section>` elements, activates the matching tab button, and calls the section's `renderXxx()`.

5. On any data mutation, the section dispatches a DOM custom event. `main.js` listens and re-runs `loadAll()`.

---

## core/state.js — the state object

A single exported `state` object. No reactive proxy, no framework. Sections read and write it directly, then call their own `renderXxx()` to repaint.

```js
export const state = {
  // Data (populated by loadAll)
  items:    [],
  itemMap:  {},   // { 'id-001': item } — keyed by id, rebuilt in loadAll

  // Schemas (loaded from backend, cached in localStorage)
  itemSchema: null,

  // Per-section UI state (same pattern for every entity)
  itemAddOpen:    false,   // add form is visible
  itemViewRow:    null,    // id of the row being viewed
  itemEditRow:    null,    // id of the row being edited
  itemDeleteRow:  null,    // id of the row pending inline delete confirmation
  itemDeleteBlocked: null, // { referenced_count: N } when backend refuses delete
};
```

Rules:
- All UI state lives in `state` — do not invent local module variables for form-open flags or selected rows.
- Map lookups (`itemMap`) are always derived from the data array, rebuilt in `loadAll`. Use them for O(1) lookups inside render loops.
- `xxxDeleteBlocked` pattern: when the backend refuses a delete (FK constraint), store the error here and read it in `renderXxx()` to show an informative message. Set to `null` to dismiss.

---

## core/api.js — backend action wrappers

One function per backend action. Uses HTTP GET for reads, POST for writes.

```js
export const AppAPI = {
  listItems:   ()  => apiFetch('GET',  '/items'),
  createItem:  f   => apiFetch('POST', '/items', f),
  updateItem:  f   => apiFetch('PUT',  `/items/${f.id}`, f),
  deleteItem:  id  => apiFetch('DELETE', `/items/${id}`),
  getItemSchema: () => apiFetch('GET', '/items/schema'),
  // ... one entry per backend action
};
```

All responses must have shape `{ ok: boolean, data?: any, error?: string }`. Always check `.ok` before reading `.data`.

---

## core/schema.js — schema loading and caching

Schemas are fetched once per browser session and cached in `localStorage`. Sections read them from `state.itemSchema` — never call `AppAPI.getItemSchema()` directly from a section.

Schema cache keys are versioned (e.g. `<slug>_item_schema_v1`). Bump the version suffix when the backend schema shape changes to bust stale caches.

If a schema fetch fails, it returns `null`. Sections must handle `null` gracefully by falling back to small hardcoded defaults.

---

## The section pattern

Every section file exports one function: `renderXxx()`. It does two things:

1. Sets `innerHTML` of the section's content element.
2. Attaches all event listeners.

```js
export function renderItems() {
  const el = el('itemsContent');
  el.innerHTML = _buildHtml();   // build full HTML string
  _attachEvents();                // bind all listeners synchronously after
}
```

### HTML structure

Every section follows the same visual layout:

```
┌─ sec-head ──────────────────────────────────┐
│  <h2>Section Title</h2>    [+ Add / × Close]│
├─────────────────────────────────────────────┤
│  Add form    — visible when itemAddOpen      │
│  View card   — visible when itemViewRow      │
│  Edit form   — visible when itemEditRow      │
├─────────────────────────────────────────────┤
│  Summary row (optional)                      │
│  Table (desktop)                             │
│  Card list (mobile, <640px)                  │
└─────────────────────────────────────────────┘
```

Add/view/edit cards render **above** the table. Delete confirmation is the exception — it replaces the row inline as a one-line confirm strip.

### Opening/closing cards

State drives what renders. To open a form, set state and re-render:

```js
// Open add form
state.itemAddOpen = true;
renderItems();

// Open edit for a specific row
state.itemEditRow = item.id;
renderItems();

// Close everything
state.itemAddOpen = false;
state.itemViewRow = null;
state.itemEditRow = null;
state.itemDeleteRow = null;
renderItems();
```

The + Add button text toggles between `+ Add` and `× Close` based on whether any form is open.

### Event delegation

Action buttons carry `data-action` and `data-id` attributes. Use a **single delegated listener** on the container:

```js
contentEl.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'item-edit')           { state.itemEditRow   = id; renderItems(); }
  if (action === 'item-view')           { state.itemViewRow   = id; renderItems(); }
  if (action === 'item-delete')         { state.itemDeleteRow = id; renderItems(); }
  if (action === 'item-delete-confirm') { _deleteItem(id); }
  if (action === 'item-delete-cancel')  { state.itemDeleteRow = null; renderItems(); }
});
```

Never use `querySelectorAll` + individual `addEventListener` for action buttons. Delegation survives re-renders.

### Saving data (create / update)

```js
async function _saveItem(form) {
  showLoading();
  const res = await AppAPI.createItem(form);
  hideLoading();
  if (!res.ok) {
    showMsg('Save failed: ' + (res.error || 'unknown'), 'warn');
    return;
  }
  state.itemAddOpen = false;
  document.dispatchEvent(new CustomEvent('<slug>:reload'));
}
```

Always dispatch `<slug>:reload` after a successful mutation — **never** call `loadAll()` or `renderXxx()` directly after a save. This keeps sections decoupled from `main.js`.

### Pagination

Pagination state lives in `state` (`itemPage`, `itemPerPage`). Calculate indices inside the render function:

```js
const pages = Math.max(1, Math.ceil(sorted.length / state.itemPerPage));
if (state.itemPage > pages) state.itemPage = 1;
const paged = sorted.slice((state.itemPage - 1) * state.itemPerPage, state.itemPage * state.itemPerPage);
```

Attach page-change listeners in the same `_attachEvents()` pass.

### Sorting

Sort state: `{ col: 'field_name', dir: 'asc' | 'desc' }`. Column headers carry `data-sort="field_name"`. Toggling the same column flips `dir`; clicking a different column resets to `asc`.

---

## index.html structure

Key element IDs required by core modules:

| Element ID | Purpose |
|---|---|
| `#authOverlay` | Auth overlay shown before login |
| `#appShell` | Main app container, hidden until authenticated |
| `#tabNav` | Container for tab buttons |
| `#msgBanner` | Toast banner (managed by `showMsg`) |
| `#msgText` | Text node inside the toast banner |
| `#themeToggle` | Dark/light toggle button |
| `#<sectionName>` | `<section class="app-section">` for each tab |
| `#<sectionName>Content` | Inner div where `renderXxx()` sets innerHTML |

Tab buttons use `data-section="<name>"` to match the section's `id`.

Each `<section>` except the first starts with `class="app-section hidden"`. `showSection` removes/adds `hidden`.

Script loading order in `<body>` (before `</body>`):
1. `config.js` — non-module, sets `window.CONFIG`
2. Any CDN scripts
3. `main.js` as `type="module"` — last

---

## Coding guidelines

> Naming conventions are in **APP-CONVENTIONS.md**.
> Logging standards are in **APP-LOGGING.md**.
> Shared utility patterns are in **APP-SHARED-CODE.md**.

### Always escape user data

Any value that came from the backend or user input could contain HTML special characters. Always wrap in `esc()` before inserting into `innerHTML`.

```js
// Wrong
`<td>${item.name}</td>`

// Correct
`<td>${esc(item.name)}</td>`
```

### Build HTML first, attach events after

Set `innerHTML` in one block, then attach listeners in a separate function. Never interleave.

```js
// Correct
el('content').innerHTML = `<button id="saveBtn">Save</button>`;
el('saveBtn').addEventListener('click', handleSave);

// Wrong — element may not exist yet
el('content').innerHTML += `...`;  // partial writes, addEventListener before innerHTML is complete
```

### No setTimeout for event binding

Events are always bound synchronously after `innerHTML` is set. Never use `setTimeout(0)` to defer binding.

### Use `el()` not `document.getElementById`

```js
// Correct
el('saveBtn').addEventListener('click', handleSave);

// Wrong
document.getElementById('saveBtn').addEventListener('click', handleSave);
```

### Schema-driven dropdowns

Do not hardcode enum values in section HTML. Read them from `state.itemSchema`. If the schema is null (loading failed), fall back to a small hardcoded default.

```js
// Correct — schema-driven
const types = state.itemSchema?.types || [
  { value: 'type_a', label: 'Type A' },
  { value: 'type_b', label: 'Type B' },
];
const opts = types.map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('');

// Wrong — hardcoded
`<option value="type_a">Type A</option>`
```

### Use maps for lookups inside render loops

```js
// Correct — O(1)
const name = state.itemMap[ref.item_id]?.name || '—';

// Wrong — O(n) inside a render loop
const item = state.items.find(i => i.id === ref.item_id);
```

### showMsg uses textContent, never innerHTML

`showMsg(text, type?)` sets `textContent` internally — safe for any server-sourced string, no XSS risk.

---

## Adding a new section — checklist

1. **State** — add `xxxAddOpen`, `xxxViewRow`, `xxxEditRow`, `xxxDeleteRow`, `xxxDeleteBlocked` keys to `core/state.js`.
2. **API** — add `listXxx`, `createXxx`, `updateXxx`, `deleteXxx`, `getXxxSchema` to `core/api.js`.
3. **Schema** — add `loadXxxSchema()` to `core/schema.js` with a versioned localStorage cache key.
4. **Section file** — create `sections/<name>.js` exporting `renderXxx()`.
5. **nav.js** — import `renderXxx` and add it to `showSection`'s dispatch table.
6. **main.js** — import `renderXxx`, add it to `loadAll`'s `Promise.all`, store schema result on `state`.
7. **index.html** — add a `<button class="tab-btn" data-section="<name>">Label</button>` to `#tabNav`, and a `<section class="app-section hidden" id="<name>"><div id="<name>Content"></div></section>` to `<main>`.
8. **Styles** — add section-specific CSS to `style/<module>.css` using design tokens.

---

## Running locally

An HTTP server is required — ES modules do not work over `file://`.

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .
```

Frontend changes deploy by committing and pushing — no separate deploy step if the host auto-publishes from the main branch (e.g. GitHub Pages, Netlify, Cloudflare Pages).
