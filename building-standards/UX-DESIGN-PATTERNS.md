# Design System — Guide

> Living reference for building consistent UI across modules. All modules share the same visual language through a shared design token layer. Update this document as the system evolves — it is the source of truth.

---

## Design Tokens

Define all colors, fonts, and spacing as CSS custom properties in a shared token file (e.g. `_shared/style-tokens.css`). **Never use raw hex values or pixel sizes in component CSS — always reference tokens.**

### Token categories

| Category | Purpose | Example token names |
|---|---|---|
| Surface / background | Page background, card background | `--canvas`, `--panel` |
| Text | Primary text, secondary / muted text | `--ink`, `--muted` |
| Borders | Subtle dividers, strong borders, row hover | `--hair`, `--hair-strong`, `--row-hover` |
| Primary accent | CTA buttons, focus ring, error states | `--accent`, `--accent-soft` |
| Secondary accent | Positive values, action links, success | `--positive`, `--positive-soft` |
| Typography — families | UI sans-serif, monospace | `--font-ui`, `--font-mono` |
| Typography — scale | Font sizes from smallest to largest | `--text-xs` … `--text-3xl` |

Dark mode remaps these variables under `[data-theme="dark"]` in the token file. Module CSS needs `[data-theme="dark"]` overrides only for module-specific rules that tokens can't handle.

---

## Typography

Map semantic roles to token scale values — never write `font-size: 14px` directly in component CSS.

| Use | Element / Class | Token | Weight |
|---|---|---|---|
| App title | `h1` | `--text-3xl` | 700 |
| Section heading | `h2` | `--text-xl` | 600 |
| Body text | default | `--text-base` | 400 |
| Eyebrow / caption label | `.eyebrow` | `--text-2xs`, uppercase, letter-spacing | `--font-mono` |
| Field label | `label` inside `.field` | `--text-2xs`, uppercase | `--font-mono` |
| Inline code / amounts | `.td-mono` | `--text-sm` | `--font-mono` |
| Muted helper text | `.sub`, `color:var(--muted)` | `--text-base` | 400 |
| Field hint | `.field-hint` | `--text-xs` | 400 |

---

## Layout

### Page wrap

```html
<div class="wrap">…</div>
```

Constrain content width, center horizontally, add vertical padding. Adjust `max-width` to suit the module's content density.

### Multi-tab app shell

```html
<header class="app-header">
  <div class="app-header-inner">…brand + controls…</div>
  <nav class="tab-nav" id="tabNav">
    <button class="tab-btn" data-section="items">Items</button>
    …
  </nav>
</header>
<main class="app-main">
  <section class="app-section" id="items"><div id="itemsContent"></div></section>
  <section class="app-section hidden" id="…">…</section>
</main>
```

Each `<section>` except the first starts `class="app-section hidden"`. The nav controller removes/adds `hidden` on tab switch.

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

Implemented via `::after` pseudo-element + CSS keyframe animation (sliding block, not opacity fade). Always wrap API calls in `try/finally { hideLoading() }`. Use reference counting if calls can be nested.

---

## Auth Gate

The auth overlay is a full-screen overlay shown before the user authenticates. Structure depends on the auth method (password, PIN, TOTP, SSO). Minimal generic structure:

```html
<div class="overlay" id="authOverlay">
  <div class="auth-card">
    <p class="eyebrow"><brand> · <module-name></p>
    <h2>Sign in</h2>
    <!-- auth fields here -->
    <div class="auth-error" id="authError"></div>
    <button class="btn btn-primary" id="authSubmit">Unlock</button>
  </div>
</div>
```

On success: hide the overlay, show `#appShell`, load data. On error: show error message inside `#authError`. See `APP-AUTH-PIN-TOTP.md` for the full auth flow specification.

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
  el('msgText').textContent = text;   // textContent — never innerHTML; safe for any string
  el('msgIco').textContent = type === 'warn' ? '!' : '›';
  b.className = `banner ${type === 'warn' ? 'warn' : 'success'}`;
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => b.classList.add('hidden'), 4500);
}
```

Two variants: `.banner.success` (positive-accent left border) and `.banner.warn` (primary-accent left border).

**`textContent` is required** — `innerHTML` would allow server-sourced error strings to inject HTML into the DOM.

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

```css
.card {
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: 14px;
  padding: 20px 22px;
}
[data-theme="dark"] .card { border-color: var(--hair-strong); }
```

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

`.field.error` triggers `display: block` on `.err-msg` and an error-state border on the input.

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

`.table-wrap` handles `overflow-x: auto` and the card-like border and background. Cell variants:

| Class | Use |
|---|---|
| `.td-name` | Primary text column |
| `.td-mono` | Dates, codes, amounts — monospace font |
| `.td-muted` | Secondary / de-emphasised text |
| `.td-amount` | Right-aligned numbers |
| `.td-nowrap` | Prevent line wrapping |
| `.td-truncate` | Truncate with ellipsis |

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

Base badge style: `font-family: var(--font-mono); font-size: var(--text-2xs); text-transform: uppercase; padding: 3px 8px; border-radius: 6px; border: 1px solid`.

Add module-specific badge colors in the module's CSS. Prefix class names to avoid collisions: `.badge-<type>`.

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

1. Design tokens in the shared token file handle most dark mode automatically.
2. In module CSS, group all dark overrides at the bottom under `[data-theme="dark"]`.
3. Only add dark overrides for what tokens cannot handle: image sources, custom gradients, third-party component colors.

```css
[data-theme="dark"] .my-custom-element {
  background: var(--panel);
  border-color: var(--hair-strong);
}
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
| `localStorage` | `<slug>_<key>` | `<slug>_theme`, `<slug>_section` |
| `sessionStorage` | `<slug>_<key>` | `<slug>_session` |

Common keys: `<slug>_theme`, `<slug>_session`, `<slug>_section`.

---

## ES Module Structure

`index.html` loads scripts in this order:

```html
<!-- Non-module globals first (if any shared client scripts) -->
<script src="shared/client.js"></script>
<!-- Runtime config -->
<script src="config.js" onerror="window.__configMissing=true"></script>
<!-- ES module entry point last -->
<script type="module" src="main.js"></script>
```

**Circular dependency avoidance** — sections that need to trigger a full data reload dispatch a DOM event instead of importing `loadAll` from `main.js`:

```js
// In a section module (after a successful save):
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

Show this banner when `config.js` is missing or the backend URL is not configured:

```html
<div class="banner warn hidden" id="setupBanner">
  <span class="ico">!</span>
  <div>
    <strong>config.js not found.</strong> Copy <code>config.example.js</code> → <code>config.js</code>
    and fill in your backend URL.
  </div>
</div>
```

Init guard in `main.js`:
```js
if (window.__configMissing || !window.CONFIG?.BACKEND_URL) {
  el('setupBanner').classList.remove('hidden');
  el('authOverlay').classList.add('hidden');
  return;
}
```

---

## HTML Shell Template

Minimal multi-tab shell. Replace `<brand>`, `<module-name>`, and section names with real values.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Module Name</title>
<link rel="stylesheet" href="shared/style-tokens.css">
<link rel="stylesheet" href="style/<module-name>.css">
</head>
<body>

<div class="loading-bar hidden" id="loadingBar"></div>

<div class="overlay" id="authOverlay">
  <div class="auth-card">
    <p class="eyebrow"><brand> · <module-name></p>
    <h2>Sign in</h2>
    <!-- auth fields — see APP-AUTH-PIN-TOTP.md -->
    <div class="auth-error" id="authError"></div>
    <button class="btn btn-primary" id="authSubmit">Unlock</button>
  </div>
</div>

<div class="app-shell" id="appShell">
  <header class="app-header">
    <div class="app-header-inner">
      <div class="app-brand">
        <p class="eyebrow"><brand> · <module-name></p>
        <h1>Module Name</h1>
      </div>
      <div class="header-controls">
        <button class="theme-btn" id="themeToggle" aria-label="Toggle colour theme" title="Toggle dark/light mode">☽</button>
      </div>
    </div>
    <nav class="tab-nav" id="tabNav">
      <button class="tab-btn" data-section="items">Items</button>
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
    <section class="app-section" id="items">
      <div id="itemsContent"></div>
    </section>
  </main>
</div>

<script src="shared/client.js"></script>
<script src="config.js" onerror="window.__configMissing=true"></script>
<script type="module" src="main.js"></script>
</body>
</html>
```

**Expected element IDs** — the shared JS layer (`ui.js`, `auth.js`, `nav.js`) expects these IDs to be present:

| ID | Purpose |
|---|---|
| `loadingBar` | Loading progress bar |
| `authOverlay` | Auth gate overlay |
| `appShell` | Main app container (hidden until authenticated) |
| `authError` | Error message area on the auth card |
| `authSubmit` | Submit button on the auth card |
| `tabNav` | Tab navigation container |
| `msgBanner` | Toast banner |
| `msgText` | Text node inside the toast |
| `msgIco` | Icon node inside the toast |
| `themeToggle` | Dark/light toggle button |
| `<sectionName>` | `<section class="app-section">` per tab |
| `<sectionName>Content` | Inner div where `renderXxx()` sets innerHTML |
