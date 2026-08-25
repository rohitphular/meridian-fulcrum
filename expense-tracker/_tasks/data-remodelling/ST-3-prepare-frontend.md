# ST-3 — Prepare frontend changes (do NOT deploy yet)

**Type:** Code only — no deploy
**Depends on:** ST-1 deployed
**Deploy trigger:** ST-5 (sheet migration) + ST-2 deployed first
**File:** `app/sections/transactions.js`

---

## Context

Prepare all frontend changes while waiting for the sheet migration. Deploy only after ST-5 and the GAS deploy from ST-2 are both confirmed live.

---

## 1. Rename field references throughout the file

Find and replace (exact string, case-sensitive):

| Find | Replace |
|------|---------|
| `tx_location_area` | `user_location_area` |
| `tx_location_city` | `user_location_city` |
| `tx_location_country` | `user_location_country` |
| `.tags` | `.tx_tags` |
| `body.tags` | `body.tx_tags` |
| `f.tags` | `f.tx_tags` |
| `row.tags` | `row.tx_tags` |
| `s.tags` | `s.tx_tags` |
| `tx.tags` | `tx.tx_tags` |

**Do NOT rename** `state.metadata?.tags` — the metadata API response key is `tags` (not the schema field name), and ST-2 Part C explicitly keeps that key as `tags`. Renaming it here would break tag datalist suggestions.

The dot-access rename rules above will NOT catch bare key literals in object literals. Find and fix these two manually:
- In the `tx-copy` action handler (~line 42): change `tags: tx.tags || ''` → `tx_tags: tx.tx_tags || ''`
- In the `tx-mark-sub` action handler (~line 65): change `tags: tx.tags || ''` → `tx_tags: tx.tx_tags || ''`

After replacing, grep for `tx_location_` and `\.tags\b` to confirm no occurrences remain. Tags appears in datalist references too (e.g. `dlAfTags`, `dlEditTags`, `dlFTag` — these are element IDs, not field names; leave them unchanged).

Also rename filter state keys:
- `state.filters.tx_location_country` → `state.filters.user_location_country`
- `state.filters.tx_location_city` → `state.filters.user_location_city`
- `state.filters.tx_location_area` → `state.filters.user_location_area`

And the `bindText` registrations (lines ~2046–2048):
```js
bindText('filterCountry', 'user_location_country');
bindText('filterCity',    'user_location_city');
bindText('filterArea',    'user_location_area');
```

And the filter state reset (line ~2059):
```js
state.filters = { ..., user_location_country:'', user_location_city:'', user_location_area:'', ... }
```

---

## 2. Remove fx_rate from the UI

### Remove from the create form HTML (~line 582)
Delete the entire `afFxRateWrap` div:
```html
<div class="field form-grid-full" id="afFxRateWrap" style="display:none">
  <label for="afFxRate">FX rate</label>
  <input type="number" id="afFxRate" ...>
  ...
</div>
```

### Remove from the edit form HTML (~line 1117)
Delete the entire `txEditFxRateWrap` div and its label/input.

### Remove `_checkRule6` function (~line 913)
Delete the entire function.

### Remove fx_rate from the create submit handler (~line 936–980)
- Remove `const fx_rate = el('afFxRate')?.value || '';`
- Remove `const rule6Error = _checkRule6(...); if (rule6Error) {...}`
- Remove `fx_rate: fx_rate ? parseFloat(fx_rate) : ''` from the API payload
- Remove `const fxRate = parseFloat(el('afFxRate')?.value) || 0;` (~line 823) if it's inside an event handler

### Remove fx_rate from the edit submit handler (~line 1295–1392)
- Remove `const fx_rate = el('txEditFxRate')?.value || '';`
- Remove `const rule6ErrorEdit = _checkRule6(...); if (rule6ErrorEdit) {...}`
- Remove `fx_rate: fx_rate ? parseFloat(fx_rate) : ''` from the update API payload
- **Simplify the credit-card target check block (~lines 1350–1385)**: This block computes `newCredited` and `oldCredited` using `fx_rate`. After removing `fx_rate`, simplify:
  - Replace `const newFxRate = ...; const newCredited = newFxRate > 0 ? parseFloat(amount) * newFxRate : parseFloat(amount);` with `const newCredited = parseFloat(amount);`
  - Replace `const oldFx = Number(oldTx.fx_rate) || 0; const oldCredited = oldFx > 0 ? Number(oldTx.amount) * oldFx : Number(oldTx.amount);` with `const oldCredited = Number(oldTx.amount);`
  - Keep the surrounding comparison logic (`if (newCredited !== oldCredited)` etc.) unchanged.

### Remove fx_rate from state initialisation and prefill
- Remove `fx_rate: tx.fx_rate || ''` from the `tx-copy` prefill object (~line 44). Note: line 65 is `tags: tx.tags || ''` in the `tx-mark-sub` block — there is NO `fx_rate` there; do not touch it.
- Remove `fx_rate: ''` from the suggestion prefill object inside the `sugg-add` handler (~line 505).
- Remove the `fx_rate` prefill block in `_prefillAddForm` (~line 666): `if (p.fx_rate !== undefined) { const f = el('afFxRate'); if (f) { f.value = p.fx_rate; _afUpdateFxPreview(); } }`
- Remove `fx_rate: fxRate || undefined` from the bulk import row mapping (~line 1816) and the `fxRate` variable above it (~line 1799)

### Remove fx_rate event listeners and dead handlers
- Remove `el('afFxRate')?.addEventListener('input', _afUpdateFxPreview)` (~line 714)
- Remove `el('afAmount')?.addEventListener('input', _afUpdateFxPreview)` (~line 715) — also dead after `afFxPreview` element is removed
- Remove `el('txEditFxRate')?.addEventListener('input', _updateFxPreview)` (~line 1277)
- Delete the `_afUpdateFxPreview` function entirely (it only updates `afFxPreview` / `afFxDirection`, which will no longer exist)

### Remove fx_rate from the form reset list (~line 719)
Remove `'afFxRate'` from the array of field IDs that get cleared on reset.

### Remove fx_rate show/hide logic

Make these surgical removals — do NOT delete the containing functions wholesale:

- **`afType` change handler (~line 688)**: Remove the line that sets `fxWrap.style.display = 'none'` (or similar) and any `const fxWrap = ...` declaration used only by that line.
- **`afReset` click handler (~line 730)**: Same — remove the fxWrap hide line.
- **`_afRefreshFxRateVis` function (~lines 796–816)**: Delete the entire function body AND all calls to `_afRefreshFxRateVis(...)` in `_afRefreshToAccountField` and `_attachAddFormEvents`. This function exists only to manage FX rate visibility.
- **`_refreshFieldVis` inside `_attachTxEditCascadeEvents` (~lines 1201–1230)**: Do NOT delete this function — it also manages the target account disabled state. Remove only the FX-specific lines:
  - The `fxWrap.style.display = ...` show/hide block (~lines 1215–1216)
  - `el('txEditFxRate').value = ''` clear (~line 1225)
  - Any `const fxWrap = ...` declaration used only by the removed lines

### Update `fmtBase` calls
Lines ~375 and ~1023: `fmtBase(tx.amount, tx.currency, tx.fx_rate)` → `fmtBase(tx.amount, tx.currency)` (drop the third argument; `toBase` falls back to the live rate map, which is the correct behaviour going forward).

### Remove fx_rate display row in card (~line 1031)
Delete: `${tx.fx_rate && parseFloat(tx.fx_rate) > 0 ? f('FX rate', esc(String(tx.fx_rate))) : ''}`

### Remove stale text in the delete confirmation (~line 1165)
The delete confirmation panel contains the text "Account balance will be adjusted." — remove this line since the auto-balance workflow is gone after ST-1.

---

## 3. Add new fields to the create and edit forms

### `tx_timezone` — add near `tx_date_time` in the core group

Create form:
```html
<div class="field">
  <label for="afTimezone">Timezone <span class="optional">optional</span></label>
  <input type="text" id="afTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off">
</div>
```

Edit form:
```html
<div class="field">
  <label for="txEditTimezone">Timezone <span class="optional">optional</span></label>
  <input type="text" id="txEditTimezone" placeholder="e.g. Asia/Kolkata" autocomplete="off" value="${esc(tx.tx_timezone || '')}">
</div>
```

Add to create payload: `tx_timezone: el('afTimezone')?.value.trim() || ''`
Add to update payload: `tx_timezone: el('txEditTimezone')?.value.trim() || ''`
Prefill on edit: `if (el('txEditTimezone')) el('txEditTimezone').value = tx.tx_timezone || '';`
Clear on reset: add `'afTimezone'` to the reset field list.

### `user_location_latitude` / `user_location_longitude` — add in location group with geolocation button

Add after the country field in both create and edit forms:

```html
<div class="field" style="grid-column: span 2">
  <label>Coordinates <span class="optional">optional</span></label>
  <div style="display:flex;gap:8px;align-items:center">
    <input type="number" id="afLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90">
    <input type="number" id="afLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180">
    <button type="button" id="afDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
  </div>
</div>
```

Wire the detect button:
```js
el('afDetectLocation')?.addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = el('afLatitude');
    const lon = el('afLongitude');
    if (lat) lat.value = pos.coords.latitude.toFixed(6);
    if (lon) lon.value = pos.coords.longitude.toFixed(6);
  });
});
```

Use element IDs `afLatitude`/`afLongitude` for the create form and `txEditLatitude`/`txEditLongitude` for the edit form (same pattern, separate button ID `txEditDetectLocation`).

Add to create payload:
```js
user_location_latitude:  el('afLatitude')?.value  !== '' ? Number(el('afLatitude')?.value)  : '',
user_location_longitude: el('afLongitude')?.value !== '' ? Number(el('afLongitude')?.value) : '',
```

Add to update payload: same pattern with `txEditLatitude`/`txEditLongitude`.

Prefill on edit:
```js
if (el('txEditLatitude'))  el('txEditLatitude').value  = tx.user_location_latitude  ?? '';
if (el('txEditLongitude')) el('txEditLongitude').value = tx.user_location_longitude ?? '';
```

Clear on reset: add `'afLatitude'`, `'afLongitude'` to the reset field list.

### `beneficiaries` — add in categorisation group

Create form:
```html
<div class="field form-grid-full">
  <label for="afBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
  <input type="text" id="afBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off">
</div>
```

Edit form: same with `id="txEditBeneficiaries"` and `value="${esc(tx.beneficiaries || '')}"`.

Add to create payload: `beneficiaries: el('afBeneficiaries')?.value.trim() || ''`
Add to update payload: `beneficiaries: el('txEditBeneficiaries')?.value.trim() || ''`
Prefill on edit.
Clear on reset: add `'afBeneficiaries'` to reset list.

---

## 4. Add `sync_status` badge to transaction cards

In the transaction card render function, after the date/amount row, add:

```js
${tx.sync_status ? `<span class="badge badge-${_syncBadgeClass(tx.sync_status)}">${esc(tx.sync_status)}</span>` : ''}
${tx.sync_status === 'sync-failure' && tx.sync_notes ? `<div class="sync-notes">${esc(tx.sync_notes)}</div>` : ''}
```

Add helper:
```js
function _syncBadgeClass(status) {
  if (status === 'in-sync')     return 'success';
  if (status === 'sync-failure') return 'danger';
  return 'muted';
}
```

Neither `sync_status` nor `sync_notes` appear in the edit form.

---

## 5. Update bulk import column hint (~line 1734)

```html
<div class="field-hint">Columns: id, tx_date_time, tx_timezone, tx_type, source_account, target_account, user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude, amount, currency, major_category, minor_category, description, counterparty_name, tx_tags, beneficiaries, sync_status, sync_notes</div>
```

---

## Do not deploy

Stage this file. Deploy only after ST-5 (sheet migration) is confirmed complete AND ST-2 GAS changes are live.
