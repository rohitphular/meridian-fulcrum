# Forge Design System

Living reference for building consistent Fulcrum Forge modules. All modules share the same visual language. Update this document as the system evolves — it is the source of truth.

---

## Project Structure

Every Forge module lives at `forge/<module-name>/app/` alongside the shared layer:

```
forge/
  _shared/
    style-tokens.css       ← design tokens (colors, fonts) — never edit per-module
    sheets-client.js       ← SheetsClient global loaded before your script
  <module-name>/
    app/
      index.html           ← shell, loads shared CSS → module CSS → <script type="module">
      main.js              ← ES module entry point
      config.js            ← SCRIPT_URL (gitignored)
      style/
        <module-name>.css  ← module-specific styles only
      core/
        state.js           ← exported state object + any shared setters
        api.js             ← API wrapper (wraps SheetsClient)
        utils.js           ← el, esc, fmtDate, fmtAmount, etc.
        ui.js              ← showLoading, hideLoading, showMsg
        auth.js            ← showPinGate, hidePinGate, submitPin
        nav.js             ← showSection (multi-tab modules only)
      sections/
        <section>.js       ← one file per tab/section, exports render<Section>
```

Single-page modules (no tabs) omit `nav.js` and `sections/`. Put render logic directly in `main.js` or alongside it.

---

## Design Tokens

Defined in `_shared/style-tokens.css`. Reference by variable name — never use raw hex values.

| Token | Role |
|---|---|
| `--canvas` | Page background |
| `--panel` | Card / surface background |
| `--ink` | Primary text |
| `--muted` | Secondary / placeholder text |
| `--hair` | Subtle border (light) |
| `--hair-strong` | Prominent border |
| `--ember` | Brand accent — primary CTA, focus ring, error states |
| `--ember-soft` | Focus ring glow (rgba ember at low opacity) |
| `--teal` | Positive / action links |
| `--teal-soft` | Teal badge border |
| `--grotesk` | UI font — Space Grotesk |
| `--mono` | Monospace font — IBM Plex Mono |
| `--row-hover` | Table row hover background |

Dark mode swaps these variables under `[data-theme="dark"]` in `style-tokens.css`. Module CSS only needs `[data-theme="dark"]` overrides for module-specific rules.

---

## Typography

| Use | Element / Class | Size | Font |
|---|---|---|---|
| App title | `h1` | 26px | `--grotesk`, 700 |
| Section heading | `h2` | 17px | `--grotesk`, 600 |
| Body text | default | 13.5px | `--grotesk` |
| Eyebrow label | `.eyebrow` | 10px, uppercase, 0.2em spacing | `--mono` |
| Field label | `label` inside `.field` | 10px, uppercase, 0.1em spacing | `--mono` |
| Inline code / amounts | `.td-mono` or `font-family:var(--mono)` | 12px | `--mono` |
| Muted helper text | `.sub`, `.sec-sub`, `color:var(--muted)` | 13.5px | `--grotesk` |
| Field hint | `.field-hint` | 11px | `--grotesk` |

---

## Layout

### Page wrap

```html
<div class="wrap">…</div>
```

`max-width: 900px; margin: 0 auto; padding: 32px 20px 80px`

### Multi-tab app shell

```html
<header class="app-header">
  <div class="app-header-inner">…brand + controls…</div>
  <nav class="tab-nav" id="tabNav">
    <button class="tab-btn" data-section="insight">Insight</button>
    …
  </nav>
</header>
<main class="app-main">
  <section class="app-section" id="insight"><div id="insightContent"></div></section>
  <section class="app-section hidden" id="…">…</section>
</main>
```

### Section heading

```html
<div class="sec-head">
  <div class="sec-head-left"><h2>Section Title</h2></div>
  <button class="btn btn-primary btn-sm" id="addBtn">+ Add item</button>
</div>
```

`sec-head` uses flexbox with `align-items: baseline`. Keep the right-side element (button or text) short.

---

## Loading Bar

```html
<div class="loading-bar hidden" id="loadingBar"></div>
```

```js
function showLoading() { el('loadingBar').classList.remove('hidden'); }
function hideLoading() { el('loadingBar').classList.add('hidden'); }
```

Implemented via `::after` pseudo-element + `barSlide` keyframe (a sliding block, not an opacity fade). Always wrap API calls in `try/finally { hideLoading() }`.

---

## Auth Gate

```html
<div class="overlay" id="pinOverlay">
  <div class="pin-card">
    <div class="pin-eyebrow">forge · <module-name></div>
    <h2>Sign in</h2>
    <p>Enter your PIN and the 6-digit code from your authenticator app.</p>
    <div class="pin-field-label">PIN</div>
    <div class="pin-input-wrap">
      <input type="password" id="pinInput" inputmode="numeric" …>
    </div>
    <div class="pin-field-label">Authenticator code</div>
    <div class="pin-input-wrap">
      <input type="text" id="totpInput" inputmode="numeric" …>
    </div>
    <div class="pin-error" id="pinError"></div>
    <button class="btn btn-primary pin-submit" id="pinSubmit">Unlock</button>
  </div>
</div>
```

On success: store PIN in `sessionStorage` with a module-prefixed key (e.g. `<slug>_pin`), call `hidePinGate()`, then load data. On lock/auth error: clear the `sessionStorage` key, call `showPinGate()`.

---

## Message Banner

```html
<div class="banner hidden" id="msgBanner">
  <span class="ico" id="msgIco">›</span>
  <div id="msgText"></div>
</div>
```

```js
function showMsg(text, type = 'success') {
  const b = el('msgBanner');
  el('msgText').innerHTML = text;
  el('msgIco').textContent = type === 'warn' ? '!' : '›';
  b.className = `banner ${type === 'warn' ? 'warn' : 'success'}`;
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => b.classList.add('hidden'), 4500);
}
```

Two variants: `.banner.success` (teal left border) and `.banner.warn` (ember left border).

---

## Buttons

### Button hierarchy — follow this strictly

| Situation | Class(es) | Use for |
|---|---|---|
| Primary CTA | `.btn.btn-primary` | Save, Add, Submit (form submit buttons) |
| Secondary action | `.btn.btn-secondary` | Cancel, Close (next to a primary btn) |
| Small header action | `.btn.btn-primary.btn-sm` or `.btn.btn-secondary.btn-sm` | "Add item" header buttons |
| Destructive standalone | `.btn.btn-danger` | Rare — standalone destructive actions only |
| Row action (all) | `.btn-link` | Edit, Delete, Save, Cancel inside table rows |
| Destructive row action | `.btn-link.danger` | "Delete", "Yes, delete" inside table rows |

**Rule**: `.btn-link` for everything inside a table row — including Save and Cancel in inline-edit rows and Yes/Cancel in confirm-delete rows. `.btn` variants are for standalone form actions only.

### Button HTML

```html
<!-- Standalone form buttons -->
<button class="btn btn-primary" id="saveBtn">Save Item</button>
<button class="btn btn-secondary" id="cancelBtn">Cancel</button>

<!-- Small header action -->
<button class="btn btn-primary btn-sm" id="addBtn">+ Add Item</button>

<!-- Table row actions -->
<div class="row-actions">
  <button class="btn-link" data-action="edit" data-id="…">Edit</button>
  <button class="btn-link danger" data-action="delete" data-id="…">Delete</button>
</div>

<!-- Inline edit row -->
<div class="row-actions">
  <button class="btn-link" data-action="save-edit" data-id="…">Save</button>
  <button class="btn-link" data-action="cancel-edit">Cancel</button>
</div>

<!-- Confirm delete row -->
<span class="confirm-text">Delete <strong>Name</strong>?</span>
<div class="row-actions">
  <button class="btn-link danger" data-action="confirm-delete" data-id="…">Yes, delete</button>
  <button class="btn-link" data-action="cancel-delete">Cancel</button>
</div>
```

---

## Event Delegation Pattern

All table row buttons use `data-action` attributes. Never attach per-button listeners. Use a single delegated listener on the `tbody` or table wrapper:

```js
el('tableBody').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'edit')           startEdit(id);
  if (action === 'delete')         startDelete(id);
  if (action === 'confirm-delete') confirmDelete();
  if (action === 'cancel-delete')  cancelDelete();
});
```

---

## Cards

```html
<div class="card">…content…</div>
```

`background: var(--panel); border: 1px solid var(--hair); border-radius: 14px; padding: 20px 22px`

Dark mode: `border-color: var(--hair-strong)` (add `[data-theme="dark"] .card { border-color: var(--hair-strong); }` in module CSS).

---

## Forms

```html
<div class="form-grid">
  <div class="field" id="fieldNameWrap">
    <label for="fieldName">Name *</label>
    <input type="text" id="fieldName" placeholder="…">
    <div class="err-msg">Name is required.</div>
  </div>
  <div class="field form-grid-full">   <!-- spans full width -->
    <label for="fieldNotes">Notes</label>
    <textarea id="fieldNotes"></textarea>
    <div class="field-hint">Optional helper text below the field.</div>
  </div>
</div>
<div class="form-actions">
  <button class="btn btn-primary" id="submitBtn">Save Item</button>
  <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
  <span class="hidden" id="formSpinner"><span class="spinner"></span>Saving…</span>
</div>
```

Validation pattern:
```js
if (!name) { el('fieldNameWrap').classList.add('error'); valid = false; }
else        el('fieldNameWrap').classList.remove('error');
```

`.field.error` triggers `display: block` on `.err-msg` and red border on the input.

Inline checkboxes:
```html
<div class="field-check">
  <input type="checkbox" id="fieldActive">
  <label for="fieldActive">Active</label>
</div>
```

---

## Tables

```html
<div class="table-wrap">
  <table>
    <thead><tr>
      <th>Name</th>
      <th>Status</th>
      <th style="width:110px">Actions</th>
    </tr></thead>
    <tbody id="tableBody">…rows…</tbody>
  </table>
</div>
```

`.table-wrap` handles `overflow-x: auto` and the card-like border+background. Use `.td-name` for primary text columns, `.td-mono` for dates/codes, `.td-muted` for secondary text, `.td-amount` for right-aligned numbers.

Empty state row:
```html
<tr class="empty-row"><td colspan="5">No items yet — add one above.</td></tr>
```

---

## Badges

```html
<span class="badge badge-active">active</span>
<span class="badge badge-inactive">inactive</span>
```

All badges: `font-family: var(--mono); font-size: 10px; uppercase; padding: 3px 8px; border-radius: 6px; border: 1px solid`.

Add module-specific badge colors in the module's CSS. Prefix class names to avoid collisions: e.g. `.badge-<type>`.

---

## Inline Edit Rows

Replace the normal row with an edit row containing `<input>` and `<select>` elements. Use `data-action` for Save/Cancel:

```js
function renderEditRow(item) {
  const r = item.id;
  return `<tr>
    <td><input class="edit-input" id="editName-${r}" value="${esc(item.name)}"></td>
    <td><select class="edit-select" id="editStatus-${r}">…</select></td>
    <td><div class="row-actions">
      <button class="btn-link" data-action="save-edit" data-id="${r}">Save</button>
      <button class="btn-link" data-action="cancel-edit">Cancel</button>
    </div></td>
  </tr>`;
}
```

`.edit-input` — compact text/number field that fits inside a table cell.
`.edit-select` — compact select that fits inside a table cell.

---

## Confirm Delete Pattern

Replace the row with a confirm prompt. Re-render on cancel, call the delete API on confirm:

```js
// In row HTML function:
if (deletingId === item.id) {
  return `<tr>
    <td class="td-name">${esc(item.name)}</td>
    <td colspan="3">
      <span class="confirm-text">Delete <strong>${esc(item.name)}</strong>?</span>
    </td>
    <td><div class="row-actions">
      <button class="btn-link danger" data-action="confirm-delete">Yes, delete</button>
      <button class="btn-link" data-action="cancel-delete">Cancel</button>
    </div></td>
  </tr>`;
}
```

---

## Dark Mode

1. Tokens in `style-tokens.css` handle most of the heavy lifting automatically.
2. In module CSS, group dark-mode overrides at the bottom under `[data-theme="dark"]`.
3. Only override what tokens cannot: image sources, custom gradients, third-party component colors (e.g. Chart.js).

```css
[data-theme="dark"] .my-custom-element { background: var(--panel); border-color: var(--hair-strong); }
```

Theme toggle:
```js
el('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('<slug>_theme', theme);
  el('themeToggle').textContent = theme === 'dark' ? '☀' : '☽';
}
```

---

## Spinner (inline saving indicator)

```html
<span class="hidden" id="formSpinner"><span class="spinner"></span>Saving…</span>
```

Show/hide alongside disabling the submit button:
```js
el('submitBtn').disabled = true;
el('formSpinner').classList.remove('hidden');
// ... in finally:
el('submitBtn').disabled = false;
el('formSpinner').classList.add('hidden');
```

---

## Storage Key Conventions

Prefix all keys with a 2–3 character module slug to avoid collisions across modules loaded in the same browser:

| Storage | Key pattern | Example |
|---|---|---|
| `localStorage` | `<slug>_<key>` | `et_theme`, `dt_theme` |
| `sessionStorage` | `<slug>_<key>` | `et_pin`, `et_section` |

Common keys: `<slug>_theme`, `<slug>_pin`, `<slug>_section`.

---

## ES Module Structure

`index.html` loads the module script as:
```html
<script src="../../_shared/sheets-client.js"></script>
<script src="config.js" onerror="window.__configMissing=true"></script>
<script type="module" src="main.js"></script>
```

`SheetsClient` (from `sheets-client.js`) and `Chart` (from a CDN `<script>` tag when needed) are globals — do not import them. `main.js` references them directly.

**Circular dependency avoidance** — sections that need to trigger a full data reload dispatch a DOM event instead of importing `loadAll` from `main.js`:

```js
// In a section module (e.g. after a successful save):
document.dispatchEvent(new CustomEvent('<slug>:reload'));

// In main.js:
document.addEventListener('<slug>:reload', loadAll);
```

Similarly for navigating to another section from inside a section module:
```js
document.dispatchEvent(new CustomEvent('<slug>:show-section', { detail: 'items' }));
// main.js: document.addEventListener('<slug>:show-section', e => showSection(e.detail));
```

---

## Config / Setup Banner

```html
<div class="banner warn hidden" id="setupBanner">
  <span class="ico">!</span>
  <div>
    <strong>config.js not found.</strong> Copy <code>config.example.js</code> → <code>config.js</code>
    and fill in your Apps Script URL.
  </div>
</div>
```

Init guard:
```js
if (window.__configMissing || !window.CONFIG?.SCRIPT_URL) {
  el('setupBanner').classList.remove('hidden');
  el('pinOverlay').classList.add('hidden');
  return;
}
```

---

## Insight & Chart patterns

### Chart.js integration

Chart.js is loaded as a UMD global via CDN — it is not imported as an ES module.

```html
<!-- index.html — after config.js, before main.js -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

Access it as `window.Chart` from within ES module files.

### CSS token reading for chart colors

Chart.js dataset `backgroundColor` and `borderColor` values **cannot use `var(--token)` strings** — they must be read from CSS at runtime via `getComputedStyle`. Do this at the top of every `render()` call so dark-mode changes are picked up automatically.

```js
const style = getComputedStyle(document.documentElement);
const C = {
  teal:   style.getPropertyValue('--teal').trim(),
  ember:  style.getPropertyValue('--ember').trim(),
  muted:  style.getPropertyValue('--muted').trim(),
  ink:    style.getPropertyValue('--ink').trim(),
};

// Pass C.teal to borderColor, C.ember to error states, etc.
```

Re-run this block before recreating the chart when the theme changes.

### Chart.js global defaults (set once in the insight section entry point)

```js
if (window.Chart) {
  const style = getComputedStyle(document.documentElement);
  window.Chart.defaults.font.family = style.getPropertyValue('--grotesk').trim() || 'inherit';
  window.Chart.defaults.font.size   = 12;
  window.Chart.defaults.color       = style.getPropertyValue('--ink').trim();
}
```

### Canvas container markup

```html
<div class="chart-container">
  <canvas id="dashCanvas"></canvas>
</div>
```

```css
.chart-container {
  position: relative;
  width: 100%;
  height: 260px;          /* mobile default */
}

@media (min-width: 481px) {
  .chart-container { height: 340px; }
}
```

`responsive: true` and `maintainAspectRatio: false` must be set on every chart.

### Canvas lifecycle

Always destroy an existing chart before recreating it (switching insights, period changes, theme changes):

```js
if (state.dashChartInstance) {
  state.dashChartInstance.destroy();
  state.dashChartInstance = null;
}
el('insightContent').innerHTML = '';
// ... then create new chart and store in state.dashChartInstance
```

Failing to call `destroy()` causes Chart.js to leak canvas contexts and throw `"Canvas is already in use"` errors.

### Mobile chart constraints (mandatory on all charts)

| Constraint | Value |
|---|---|
| `responsive` | `true` |
| `maintainAspectRatio` | `false` |
| Tooltip mode | `'nearest'` with `intersect: false` |
| Legend position | `'bottom'` (never `'right'`) |
| X-axis `maxRotation` | `0` |
| Tick font size | `12` |
| Legend font size | `13` |
| Tap target minimum | `44 × 44px` |
| Horizontal bars | Required for > 5 labelled items |
| Line point radius | `3` desktop, `5` mobile |

### Insight section CSS classes

| Class | Purpose |
|---|---|
| `.chart-container` | Canvas wrapper — sets height, position: relative |
| `.dash-tabs` | Tab strip flexbox row |
| `.dash-tab` | Individual tab button — 44px min height |
| `.dash-tab.active` | Active tab — ember underline or fill |
| `.dash-period-picker` | Period select + custom date inputs wrapper |
| `.stat-cards` | Grid of summary stat cards |
| `.stat-card` | Individual stat card — label + value |
| `.stat-card-value` | Large number in a stat card |
| `.dash-table` | HTML table below a chart (category breakdown, etc.) |

Stat cards grid:

```css
.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

@media (max-width: 480px) {
  .stat-cards { grid-template-columns: repeat(2, 1fr); }
}
```

---

## HTML Shell Template

Minimal multi-tab shell:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Module Name — Fulcrum</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../_shared/style-tokens.css">
<link rel="stylesheet" href="style/<module-name>.css">
</head>
<body>

<div class="loading-bar hidden" id="loadingBar"></div>

<div class="overlay" id="pinOverlay">
  <div class="pin-card">
    <div class="pin-eyebrow">forge · <module-name></div>
    <h2>Sign in</h2>
    <p>Enter your PIN and the 6-digit code from your authenticator app.</p>
    <div class="pin-field-label">PIN</div>
    <div class="pin-input-wrap">
      <input type="password" id="pinInput" inputmode="numeric" autocomplete="current-password" placeholder="••••••" maxlength="12">
    </div>
    <div class="pin-field-label">Authenticator code</div>
    <div class="pin-input-wrap">
      <input type="text" id="totpInput" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="6">
    </div>
    <div class="pin-error" id="pinError"></div>
    <button class="btn btn-primary pin-submit" id="pinSubmit">Unlock</button>
  </div>
</div>

<div class="app-shell" id="appShell">
  <header class="app-header">
    <div class="app-header-inner">
      <div class="app-brand">
        <p class="eyebrow">forge · <module-name></p>
        <h1>Module Name</h1>
      </div>
      <div class="header-controls">
        <button class="theme-btn" id="themeToggle" aria-label="Toggle colour theme">☽</button>
      </div>
    </div>
    <nav class="tab-nav" id="tabNav">
      <button class="tab-btn" data-section="insight">Insight</button>
    </nav>
  </header>

  <div class="notices-area">
    <div class="banner warn hidden" id="setupBanner">…</div>
    <div class="banner hidden" id="msgBanner">
      <span class="ico" id="msgIco">›</span>
      <div id="msgText"></div>
    </div>
  </div>

  <main class="app-main">
    <section class="app-section" id="insight">
      <div id="insightContent"></div>
    </section>
  </main>
</div>

<script src="../../_shared/sheets-client.js"></script>
<script src="config.js" onerror="window.__configMissing=true"></script>
<script type="module" src="main.js"></script>
</body>
</html>
```
