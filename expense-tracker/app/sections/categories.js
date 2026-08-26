import { state } from '../core/state.js';
import { el, esc, openContextMenu, closeContextMenu, exportCategories, recordStatusIcon, syncStatusIcon } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

let _catImportParsed = null;
let _catMenuKey      = null;
let _catDraft        = null;   // pending filter selections; copied to state.catFilters on Search

function _acctTypeGroups() {
  const schema = state.accountSchema;
  return {
    asset:  [...schema.asset_sub_types, 'investment'],
    credit: ['credit_card', 'overdraft'],
    loan:   schema.loan_sub_types,
  };
}

const ACCT_TYPE_LABELS = {
  current: 'Current', savings: 'Savings', cash: 'Cash', investment: 'Investment',
  credit_card: 'Credit Card', overdraft: 'Overdraft', mortgage: 'Mortgage',
  auto_loan: 'Auto Loan', heloc: 'HELOC', personal_loan: 'Personal Loan',
  student_loan: 'Student Loan', medical_loan: 'Medical Loan',
  debt_consolidation: 'Debt Consol.',
};

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderCategories() {
  closeContextMenu(); _catMenuKey = null;
  const content = el('categoriesContent');

  const filtered    = _applyFilters(state.categories);
  const activeCount = _activeFilterCount();
  const anyFormOpen = state.catAddOpen || state.catViewRow !== null || state.catEditRow !== null;
  const viewCat     = state.catViewRow !== null ? state.categories.find(c => c._row === state.catViewRow) : null;
  const editCat     = state.catEditRow !== null ? state.categories.find(c => c._row === state.catEditRow) : null;

  content.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="catExportBtn">↓ Export</button>
        <button class="btn btn-secondary btn-sm" id="catImportBtn">${state.catImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-primary btn-sm" id="catAddBtn">${anyFormOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.catImportOpen ? _renderCatImportPanel() : ''}
    ${state.catAddOpen ? _renderForm({}, 'add') : ''}
    ${viewCat          ? _renderForm(viewCat, 'view') : ''}
    ${editCat          ? _renderForm(editCat, 'edit') : ''}
    ${_renderCatFilterBar()}
    <div class="cat-count-bar">
      <span class="cat-count">${filtered.length} ${filtered.length === 1 ? 'category' : 'categories'}</span>
    </div>
    ${_renderCatTable(filtered)}
  `;

  _attachCatEvents();
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function _applyFilters(cats) {
  const f = state.catFilters;
  return cats.filter(c => {
    if (f.type !== 'all' && c.tx_type_key !== f.type) return false;
    if (f.major !== 'all' && c.major_category_label !== f.major) return false;
    if (f.minor !== 'all' && c.minor_category_label !== f.minor) return false;
    if (f.search) {
      const q   = f.search.toLowerCase();
      const hay = [c.major_category_label, c.minor_category_label, c.description, c.tag_keywords, c.counterparty_examples]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.sourceMandatory !== 'all' && c.source_account_mandatory !== (f.sourceMandatory === 'yes')) return false;
    if (f.targetMandatory !== 'all' && c.target_account_mandatory !== (f.targetMandatory === 'yes')) return false;
    if (f.subscriptionEligible !== 'all' && c.is_subscription_eligible !== (f.subscriptionEligible === 'yes')) return false;
    if (f.recordStatuses.length < 4 && !f.recordStatuses.includes(c.record_status)) return false;
    return true;
  });
}

function _activeFilterCount() {
  const f = state.catFilters;
  let n = 0;
  if (f.type !== 'all')                 n++;
  if (f.major !== 'all')                n++;
  if (f.minor !== 'all')                n++;
  if (f.search)                         n++;
  if (f.sourceMandatory !== 'all')      n++;
  if (f.targetMandatory !== 'all')      n++;
  if (f.subscriptionEligible !== 'all') n++;
  if (f.recordStatuses.length < 4)      n++;
  return n;
}

function _renderCatFilterBar() {
  const activeCount = _activeFilterCount();          // badge uses applied filter (state.catFilters)
  const f           = _catDraft || state.catFilters; // panel UI uses draft when available

  const majors = [];
  const seenM  = {};
  state.categories.forEach(c => {
    if (!seenM[c.major_category_label]) {
      seenM[c.major_category_label] = true;
      majors.push(c.major_category_label);
    }
  });
  majors.sort();

  const minors = [];
  if (f.major !== 'all') {
    const seenN = {};
    state.categories
      .filter(c => c.major_category_label === f.major)
      .forEach(c => {
        if (!seenN[c.minor_category_label]) {
          seenN[c.minor_category_label] = true;
          minors.push(c.minor_category_label);
        }
      });
    minors.sort();
  }

  const majorOpts = `<option value="all"${f.major === 'all' ? ' selected' : ''}>All major</option>` +
    majors.map(m => `<option value="${esc(m)}"${f.major === m ? ' selected' : ''}>${esc(m)}</option>`).join('');

  const minorOpts = f.major === 'all'
    ? `<option value="all">— select major first —</option>`
    : `<option value="all"${f.minor === 'all' ? ' selected' : ''}>All minor</option>` +
      minors.map(n => `<option value="${esc(n)}"${f.minor === n ? ' selected' : ''}>${esc(n)}</option>`).join('');

  const rs = new Set(f.recordStatuses);

  const tog = (val, label, attr, cur) =>
    `<button class="btn btn-sm ${cur === val ? 'btn-primary' : 'btn-secondary'}" data-${attr}="${val}">${label}</button>`;

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="catFilterToggle">
      Filters${activeCount ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.catFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.catFilterOpen ? '' : 'hidden'}" id="catFilterBody">
      <div class="filter-row">
        <label>Type</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tog('all',       'All',       'cat-filter-type', f.type)}
          ${tog('money-in',  'Money In',  'cat-filter-type', f.type)}
          ${tog('money-out', 'Money Out', 'cat-filter-type', f.type)}
        </div>
      </div>
      <div class="filter-row">
        <label>Major</label>
        <select id="catFMajor" style="flex:1">${majorOpts}</select>
      </div>
      <div class="filter-row">
        <label>Minor</label>
        <select id="catFMinor" style="flex:1"${f.major === 'all' ? ' disabled' : ''}>${minorOpts}</select>
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="catFSearch" placeholder="name, keywords…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-row">
        <label>Source acct</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tog('all', 'All',      'cat-filter-src', f.sourceMandatory)}
          ${tog('yes', 'Required', 'cat-filter-src', f.sourceMandatory)}
          ${tog('no',  'Optional', 'cat-filter-src', f.sourceMandatory)}
        </div>
      </div>
      <div class="filter-row">
        <label>Target acct</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tog('all', 'All',      'cat-filter-tgt', f.targetMandatory)}
          ${tog('yes', 'Required', 'cat-filter-tgt', f.targetMandatory)}
          ${tog('no',  'Optional', 'cat-filter-tgt', f.targetMandatory)}
        </div>
      </div>
      <div class="filter-row">
        <label>Subscription</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${tog('all', 'All',          'cat-filter-sub', f.subscriptionEligible)}
          ${tog('yes', 'Eligible',     'cat-filter-sub', f.subscriptionEligible)}
          ${tog('no',  'Not eligible', 'cat-filter-sub', f.subscriptionEligible)}
        </div>
      </div>
      <div class="filter-row">
        <label>Status</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${['active','inactive','deleted','locked'].map(s =>
            `<label class="checkbox-label"><input type="checkbox" data-cat-filter-rstat="${s}"${rs.has(s) ? ' checked' : ''}> ${s.charAt(0).toUpperCase() + s.slice(1)}</label>`
          ).join('')}
        </div>
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="catFClear">Clear</button>
        <button class="btn btn-primary btn-sm" id="catFSearchBtn">Search</button>
      </div>
    </div>
  </div>`;
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _renderForm(cat, mode) {
  const isView = mode === 'view';
  const isEdit = mode === 'edit';
  const dis    = isView ? ' disabled' : '';
  const pfx    = isEdit ? 'catEdit' : 'catNew';
  const srcId  = isView ? '' : `${pfx}Src`;
  const tgtId  = isView ? '' : `${pfx}Tgt`;

  const types = state.categorySchema.types;
  const typeOpts = types.map(t =>
    `<option value="${esc(t.value)}" ${cat.tx_type_key === t.value ? 'selected' : ''}>${esc(t.label)}</option>`
  ).join('');

  const header = (isView || isEdit) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} —
      <strong>${esc(cat.major_category_label)}</strong> / ${esc(cat.minor_category_label)}
    </div>` : '';

  return `
  <div class="card" style="margin-bottom:20px">
    ${header}
    <div class="form-grid form-grid-4" style="margin-bottom:12px">
      <div class="field">
        <label>Type *</label>
        <select id="${pfx}Type"${dis}>${typeOpts}</select>
        <div class="field-hint">money-in or money-out.</div>
      </div>
      <div class="field">
        <label>Major *</label>
        <input type="text" id="${pfx}Major" placeholder="e.g. Food" value="${esc(String(cat.major_category_label || ''))}"${dis}>
        <div class="field-hint">Top-level category group.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Minor *</label>
        <input type="text" id="${pfx}Minor" placeholder="e.g. Groceries" value="${esc(String(cat.minor_category_label || ''))}"${dis}>
        <div class="field-hint">Specific category name shown in dropdowns.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Description</label>
        <input type="text" id="${pfx}Desc" placeholder="Short description" value="${esc(String(cat.description || ''))}"${dis}>
        <div class="field-hint">Shown in tooltips and reports.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Tag keywords</label>
        <input type="text" id="${pfx}Keywords" placeholder="tesco, sainsbury…" value="${esc(String(cat.tag_keywords || ''))}"${dis}>
        <div class="field-hint">Comma-separated, for auto-classification.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Counterparty examples</label>
        <input type="text" id="${pfx}Counterparty" placeholder="Tesco, Sainsbury's…" value="${esc(String(cat.counterparty_examples || ''))}"${dis}>
        <div class="field-hint">Comma-separated merchant names.</div>
      </div>
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Source account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}SrcMandatory" ${cat.source_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(srcId, cat.source_account_types || '', isView)}
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Target account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}TgtMandatory" ${cat.target_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(tgtId, cat.target_account_types || '', isView)}
    </div>
    <div class="field" style="margin-top:14px">
      <label>Record status</label>
      <select id="${pfx}RecordStatus"${dis}>
        <option value="active"   ${(cat.record_status === 'active' || !cat.record_status) ? 'selected' : ''}>Active</option>
        <option value="inactive" ${cat.record_status === 'inactive' ? 'selected' : ''}>Inactive</option>
        <option value="locked"   ${cat.record_status === 'locked'   ? 'selected' : ''}>Locked</option>
        <option value="deleted"  ${cat.record_status === 'deleted'  ? 'selected' : ''}>Deleted</option>
      </select>
    </div>
    <label class="checkbox-label cat-mandatory-check" style="margin-top:8px">
      <input type="checkbox" id="${pfx}IsSubEligible" ${cat.is_subscription_eligible === true ? 'checked' : ''}${dis}> Subscription eligible
    </label>
    ${isView ? `
    <div style="margin-top:14px;font-size:12px;color:var(--muted)">
      Sync: ${syncStatusIcon(cat.sync_status || '')} ${esc(cat.sync_status || '—')}${cat.sync_notes ? ' · ' + esc(cat.sync_notes) : ''}
    </div>` : ''}
    ${isView ? `
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-secondary" id="catCancelView">Close</button>
      ${cat.record_status === 'deleted' ? `<button class="btn btn-primary" id="catViewRestore" data-row="${cat._row}">Restore</button>` : ''}
      ${cat.record_status !== 'locked' && cat.record_status !== 'deleted' ? `<button class="btn btn-primary" id="catViewToEdit" data-row="${cat._row}">Edit</button>` : ''}
    </div>
    ` : `
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="${isEdit ? 'catSaveEdit' : 'catSaveNew'}">Save</button>
      <button class="btn btn-secondary" id="${isEdit ? 'catCancelEdit' : 'catCancelNew'}">Cancel</button>
    </div>
    <div class="pin-error" id="${isEdit ? 'catEditError' : 'catAddError'}"></div>
    `}
  </div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function _renderCatTable(cats) {
  if (!cats.length) {
    return `<p class="placeholder">No categories for this filter. Use &ldquo;+ Add&rdquo; to create one.</p>`;
  }

  const hasActiveCatRow = state.catDeleteRow !== null;

  const rows = cats.map(cat => {
    const rowStyle = cat.record_status === 'deleted'  ? ' style="opacity:0.5"'
                   : cat.record_status === 'inactive' ? ' style="opacity:0.5"'
                   : cat.record_status === 'locked'   ? ' style="opacity:0.7"' : '';

    if (state.catDeleteRow === cat._row) {
      return `<tr>
        <td>${_catTypeBadge(cat.tx_type_key)}</td>
        <td colspan="2"><span class="confirm-text">Delete <strong>${esc(cat.major_category_label)} → ${esc(cat.minor_category_label)}</strong>?</span></td>
        <td><div class="row-actions">
          <button class="btn-link danger" data-action="cat-confirm-delete" data-row="${cat._row}">Yes, delete</button>
          <button class="btn-link muted"  data-action="cat-cancel-delete">Cancel</button>
        </div></td>
      </tr>`;
    }

    return `<tr${rowStyle}>
      <td>${_catTypeBadge(cat.tx_type_key)}</td>
      <td class="td-name">${esc(cat.major_category_label)}</td>
      <td>${esc(cat.minor_category_label)}</td>
      <td><div style="display:flex;align-items:center;justify-content:flex-end;gap:5px">
        ${recordStatusIcon(cat.record_status)}${syncStatusIcon(cat.sync_status)}
        <button class="tx-menu-trigger" data-action="cat-menu" data-row="${cat._row}">⋮</button>
      </div></td>
    </tr>`;
  }).join('');

  const cardRows = cats.map(cat => {
    if (state.catDeleteRow === cat._row) return '';
    const isArchived = cat.record_status !== 'active';
    return `<div class="cat-card${isArchived ? ' is-archived' : ''}">
      <div class="cat-card-top">
        <div class="cat-card-name">
          ${_catTypeDot(cat.tx_type_key)}
          <span class="cat-card-major">${esc(cat.major_category_label)}</span>
          <span class="cat-card-sep">›</span>
          <span class="cat-card-minor">${esc(cat.minor_category_label)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${recordStatusIcon(cat.record_status)} ${syncStatusIcon(cat.sync_status)}
          <button class="tx-menu-trigger" data-action="cat-menu" data-row="${cat._row}">⋮</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="table-wrap cat-table-wrap${hasActiveCatRow ? ' cat-has-active' : ''}">
      <table>
        <thead><tr>
          <th style="width:80px">Type</th>
          <th>Major</th>
          <th>Minor</th>
          <th style="width:64px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="cat-cards">${cardRows}</div>`;
}

// ── Account type multi-select ─────────────────────────────────────────────────

function _renderAcctTypeCheckboxes(containerId, currentValue, disabled = false) {
  const selected = new Set(
    String(currentValue || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  const dis = disabled ? ' disabled' : '';

  const renderGroup = (label, types) =>
    `<div class="acct-type-group">
      <span class="acct-type-group-label">${label}</span>
      <div class="acct-type-checks">
        ${types.map(t =>
          `<label class="acct-type-check">
            <input type="checkbox" data-acct-type="${esc(t)}" ${selected.has(t) ? 'checked' : ''}${dis}> ${esc(ACCT_TYPE_LABELS[t] || t)}
          </label>`
        ).join('')}
      </div>
    </div>`;

  const { asset, credit, loan } = _acctTypeGroups();
  const idAttr = containerId ? ` id="${esc(containerId)}"` : '';
  return `<div class="account-type-checkboxes"${idAttr}>
    ${renderGroup('Assets', asset)}
    ${renderGroup('Credit', credit)}
    ${renderGroup('Loans',  loan)}
  </div>`;
}

function _getCheckedAccountTypes(containerId) {
  const container = el(containerId);
  if (!container) return '';
  return Array.from(container.querySelectorAll('input[data-acct-type]:checked'))
    .map(cb => cb.dataset.acctType)
    .join(', ');
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function _catTypeBadge(type) {
  const cls   = type === 'money-in' ? 'badge-et-in' : 'badge-et-out';
  const label = type === 'money-in' ? 'in' : 'out';
  return `<span class="badge ${cls}">${label}</span>`;
}

function _catTypeDot(type) {
  const cls = type === 'money-in' ? 'tx-dot-in' : 'tx-dot-out';
  return `<span class="tx-type-dot ${cls}">●</span>`;
}


// ── CSV import ────────────────────────────────────────────────────────────────

function _renderCatImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import categories from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="catImportFile">CSV file</label>
        <input type="file" id="catImportFile" accept=".csv">
        <div class="field-hint">Required: tx_type_key, major_category_label, minor_category_label. Optional: description, record_status, tag_keywords, counterparty_examples, source_account_types, target_account_types, source_account_mandatory, target_account_mandatory, is_subscription_eligible</div>
      </div>
    </div>
    <div id="catImportStatus"></div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="catImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="catImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="catImportError"></div>
  </div>`;
}

function _parseCatCsvRow(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

function _parseCatCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { categories: [], errors: ['File is empty.'] };

  const headers = _parseCatCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const categories = [], errors = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = _parseCatCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    if (!row.tx_type_key)          { errors.push(`Row ${i + 1}: missing tx_type_key`);          continue; }
    if (!row.major_category_label) { errors.push(`Row ${i + 1}: missing major_category_label`); continue; }
    if (!row.minor_category_label) { errors.push(`Row ${i + 1}: missing minor_category_label`); continue; }

    categories.push({
      tx_type_key:               row.tx_type_key,
      tx_type_label:             row.tx_type_label             || '',
      major_category_key:        row.major_category_key        || '',
      major_category_label:      row.major_category_label,
      minor_category_key:        row.minor_category_key        || '',
      minor_category_label:      row.minor_category_label,
      description:               row.description               || '',
      record_status:             ['active', 'inactive', 'deleted', 'locked'].includes(row.record_status) ? row.record_status : 'active',
      tag_keywords:              row.tag_keywords              || '',
      counterparty_examples:     row.counterparty_examples     || '',
      source_account_types:      row.source_account_types      || '',
      target_account_types:      row.target_account_types      || '',
      source_account_mandatory:  row.source_account_mandatory === 'TRUE' || row.source_account_mandatory === 'true',
      target_account_mandatory:  row.target_account_mandatory === 'TRUE' || row.target_account_mandatory === 'true',
      is_subscription_eligible:  row.is_subscription_eligible === 'TRUE' || row.is_subscription_eligible === 'true',
    });
  }
  return { categories, errors };
}

function _renderCatImportStatus(parsed) {
  const { categories, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (!categories.length) return errHtml + '<p class="pin-error" style="margin:0">No valid rows found — check the column headers match the expected format.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'} ready to import</p>`;
}

async function _submitCatImport(categories) {
  if (!categories || !categories.length) {
    const errEl = el('catImportError');
    if (errEl) errEl.textContent = 'No valid rows to import.';
    return;
  }
  const btn   = el('catImportConfirm');
  const errEl = el('catImportError');
  if (btn)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createCategoriesBulk({ categories });
    if (!res.ok && !res.results) {
      console.warn('[categories] _submitCatImport failed:', res.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
      if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }
    const created = res.created || 0;
    const updated = res.updated || 0;
    const failed  = res.failed  || 0;
    _catImportParsed = null;
    state.catImportOpen = false;
    const parts = [];
    if (created) parts.push(`${created} imported`);
    if (updated) parts.push(`${updated} updated`);
    if (failed)  parts.push(`${failed} failed`);
    showMsg(parts.join(' · ') || 'Nothing to import');
    document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (err) {
    console.error('[categories] _submitCatImport failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachCatEvents() {
  el('catExportBtn').addEventListener('click', () => {
    const rows = _applyFilters(state.categories);
    if (!rows.length) { showMsg('No categories to export.', 'warn'); return; }
    openContextMenu(el('catExportBtn'), [
      { key: 'csv',  label: '↓ CSV'  },
      { key: 'json', label: '↓ JSON' },
    ], key => exportCategories(key, rows));
  });

  el('catImportBtn').addEventListener('click', () => {
    if (state.catImportOpen) {
      state.catImportOpen = false;
      _catImportParsed = null;
    } else {
      state.catImportOpen = true;
      state.catAddOpen = false;
      state.catViewRow = null;
      state.catEditRow = null;
    }
    renderCategories();
  });

  if (state.catImportOpen) {
    el('catImportFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const parsed = _parseCatCsv(ev.target.result);
        _catImportParsed = parsed.categories.length ? parsed.categories : null;
        const status = el('catImportStatus');
        if (status) status.innerHTML = _renderCatImportStatus(parsed);
        const btn = el('catImportConfirm');
        if (btn) btn.disabled = !_catImportParsed;
      };
      reader.readAsText(file);
    });

    el('catImportConfirm').addEventListener('click', () => {
      if (_catImportParsed) _submitCatImport(_catImportParsed);
    });

    el('catImportCancel').addEventListener('click', () => {
      state.catImportOpen = false;
      _catImportParsed = null;
      renderCategories();
    });
  }

  el('catAddBtn').addEventListener('click', () => {
    if (state.catAddOpen || state.catViewRow !== null || state.catEditRow !== null) {
      state.catAddOpen = false;
      state.catViewRow = null;
      state.catEditRow = null;
    } else {
      state.catAddOpen = true;
    }
    renderCategories();
  });

  // Add form
  if (state.catAddOpen) {
    el('catSaveNew').addEventListener('click', _saveNewCategory);
    el('catCancelNew').addEventListener('click', () => { state.catAddOpen = false; renderCategories(); });
  }

  // Edit form
  if (state.catEditRow !== null) {
    el('catSaveEdit').addEventListener('click', _saveCatEdit);
    el('catCancelEdit').addEventListener('click', () => { state.catEditRow = null; renderCategories(); });
  }

  // View form
  if (state.catViewRow !== null) {
    el('catCancelView').addEventListener('click', () => { state.catViewRow = null; renderCategories(); });
    const viewToEditEl = el('catViewToEdit');
    if (viewToEditEl) viewToEditEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.catViewRow = null;
      state.catEditRow = row;
      renderCategories();
    });
    const viewRestoreEl = el('catViewRestore');
    if (viewRestoreEl) viewRestoreEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.catViewRow = null;
      _restoreCat(row);
    });
  }

  el('catFilterToggle').addEventListener('click', () => {
    state.catFilterOpen = !state.catFilterOpen;
    if (state.catFilterOpen && !_catDraft) {
      _catDraft = { ...state.catFilters, recordStatuses: [...state.catFilters.recordStatuses] };
    }
    renderCategories();
  });

  if (state.catFilterOpen) {
    const content = el('categoriesContent');

    // Toggle button groups — update draft + flip classes in-place (no re-render)
    const _togGroup = (attr, draftKey) => {
      content.querySelectorAll(`[data-${attr}]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
          if (_catDraft) _catDraft[draftKey] = val;
          content.querySelectorAll(`[data-${attr}]`).forEach(b => {
            b.className = `btn btn-sm ${b.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === val ? 'btn-primary' : 'btn-secondary'}`;
          });
        });
      });
    };
    _togGroup('cat-filter-type', 'type');
    _togGroup('cat-filter-src',  'sourceMandatory');
    _togGroup('cat-filter-tgt',  'targetMandatory');
    _togGroup('cat-filter-sub',  'subscriptionEligible');

    // Major — update draft + repopulate minor dropdown in-place
    el('catFMajor').addEventListener('change', () => {
      const newMajor = el('catFMajor').value;
      if (_catDraft) { _catDraft.major = newMajor; _catDraft.minor = 'all'; }
      const minorEl = el('catFMinor');
      if (!minorEl) return;
      if (newMajor === 'all') {
        minorEl.disabled = true;
        minorEl.innerHTML = `<option value="all">— select major first —</option>`;
      } else {
        const mins = [], seen = {};
        state.categories.filter(c => c.major_category_label === newMajor).forEach(c => {
          if (!seen[c.minor_category_label]) { seen[c.minor_category_label] = true; mins.push(c.minor_category_label); }
        });
        mins.sort();
        minorEl.disabled = false;
        minorEl.innerHTML = `<option value="all" selected>All minor</option>` +
          mins.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      }
    });

    // Minor — update draft only
    el('catFMinor').addEventListener('change', () => {
      if (_catDraft) _catDraft.minor = el('catFMinor').value;
    });

    // Record status checkboxes — update draft only
    content.querySelectorAll('[data-cat-filter-rstat]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (!_catDraft) return;
        _catDraft.recordStatuses = Array.from(
          content.querySelectorAll('[data-cat-filter-rstat]:checked')
        ).map(c => c.dataset.catFilterRstat);
      });
    });

    // Apply draft → state on Search / Enter
    const _applyDraft = () => {
      if (_catDraft) {
        _catDraft.search = el('catFSearch').value.trim();
        state.catFilters = { ..._catDraft, recordStatuses: [..._catDraft.recordStatuses] };
        _catDraft = null;
      }
      renderCategories();
    };
    el('catFSearchBtn').addEventListener('click', _applyDraft);
    el('catFSearch').addEventListener('keydown', e => { if (e.key === 'Enter') _applyDraft(); });

    // Clear — reset both draft and applied
    el('catFClear').addEventListener('click', () => {
      _catDraft = null;
      state.catFilters = {
        type: 'all', major: 'all', minor: 'all', search: '',
        sourceMandatory: 'all', targetMandatory: 'all', subscriptionEligible: 'all',
        recordStatuses: ['active', 'inactive', 'deleted', 'locked'],
      };
      renderCategories();
    });
  }

  const handleCatAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;

    if (action === 'cat-menu') {
      if (_catMenuKey === row) { closeContextMenu(); _catMenuKey = null; return; }
      _catMenuKey = row;
      const menuCat   = state.categories.find(c => c._row === row);
      const isLocked  = menuCat && menuCat.record_status === 'locked';
      const isDeleted = menuCat && menuCat.record_status === 'deleted';
      const menuItems = [
        { key: 'cat-view', label: 'View', cls: '' },
        ...(!isLocked && !isDeleted ? [{ key: 'cat-edit',    label: 'Edit',    cls: ''       }] : []),
        { key: 'cat-txs', label: 'Transactions', cls: '' },
        ...(isDeleted               ? [{ key: 'cat-restore', label: 'Restore', cls: ''       }] : []),
        ...(!isLocked && !isDeleted ? [{ key: 'cat-delete',  label: 'Delete',  cls: 'danger' }] : []),
      ];
      openContextMenu(btn, menuItems, key => {
        _catMenuKey = null;
        if (key === 'cat-view')    { state.catViewRow = row; state.catEditRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
        if (key === 'cat-edit')    { state.catEditRow = row; state.catViewRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
        if (key === 'cat-delete')  { state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; renderCategories(); }
        if (key === 'cat-restore') { _restoreCat(row); }
        if (key === 'cat-txs') {
          const cat = state.categories.find(c => c._row === row);
          if (cat) {
            state.filters = { types: [], accounts: [], major: [cat.major_category_label], minor: [cat.minor_category_label], tx_location_country: '', tag: '', search: '' };
            document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
          }
        }
      });
      return;
    }
    if (action === 'cat-view')   { state.catViewRow = row; state.catEditRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
    if (action === 'cat-edit') {
      const editCat = state.categories.find(c => c._row === row);
      if (editCat && (editCat.record_status === 'locked' || editCat.record_status === 'deleted')) return;
      state.catEditRow = row; state.catViewRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories();
    }
    if (action === 'cat-delete') {
      const delCat = state.categories.find(c => c._row === row);
      if (delCat && (delCat.record_status === 'locked' || delCat.record_status === 'deleted')) return;
      state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; renderCategories();
    }
    if (action === 'cat-cancel-delete')  { state.catDeleteRow = null; renderCategories(); }
    if (action === 'cat-confirm-delete') { _deleteCat(row); }
  };
  const tableWrap = el('categoriesContent').querySelector('.cat-table-wrap');
  if (tableWrap) tableWrap.addEventListener('click', handleCatAction);
  const catCards = el('categoriesContent').querySelector('.cat-cards');
  if (catCards) catCards.addEventListener('click', handleCatAction);
}

// ── Restore ───────────────────────────────────────────────────────────────────

async function _restoreCat(rowNum) {
  const cat = state.categories.find(c => c._row === rowNum);
  if (!cat) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num:                  rowNum,
      tx_type_key:              cat.tx_type_key,
      major_category_label:     cat.major_category_label,
      minor_category_label:     cat.minor_category_label,
      description:              cat.description || '',
      record_status:            'active',
      is_subscription_eligible: cat.is_subscription_eligible || false,
      tag_keywords:             cat.tag_keywords || '',
      counterparty_examples:    cat.counterparty_examples || '',
      source_account_types:     cat.source_account_types || '',
      target_account_types:     cat.target_account_types || '',
      source_account_mandatory: cat.source_account_mandatory || false,
      target_account_mandatory: cat.target_account_mandatory || false,
    });
    if (res.ok) {
      showMsg('Category restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _restoreCat failed:', res.error);
      const msg = res.error === 'duplicate_category'
        ? 'Cannot restore: this category already exists.'
        : res.error === 'record_locked'
          ? 'This category is locked.'
          : 'Restore failed: ' + (res.error || 'unknown');
      showMsg(msg, 'warn');
      renderCategories();
    }
  } catch (err) {
    console.error('[categories] _restoreCat failed:', err);
    showMsg('Connection error.', 'warn');
    renderCategories();
  } finally {
    hideLoading();
  }
}

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNewCategory() {
  const tx_type_key           = el('catNewType').value;
  const major_category_label  = el('catNewMajor').value.trim();
  const minor_category_label  = el('catNewMinor').value.trim();
  const description           = el('catNewDesc').value.trim();
  const tag_keywords          = el('catNewKeywords').value.trim();
  const counterparty_examples = el('catNewCounterparty').value.trim();
  const source_account_types  = _getCheckedAccountTypes('catNewSrc');
  const target_account_types  = _getCheckedAccountTypes('catNewTgt');
  const source_account_mandatory = el('catNewSrcMandatory').checked === true;
  const target_account_mandatory = el('catNewTgtMandatory').checked === true;
  const record_status            = el('catNewRecordStatus').value;
  const is_subscription_eligible = el('catNewIsSubEligible').checked === true;
  const errEl                    = el('catAddError');

  if (!major_category_label) { if (errEl) errEl.textContent = 'Major category is required.'; return; }
  if (!minor_category_label) { if (errEl) errEl.textContent = 'Minor category is required.'; return; }
  if (errEl) errEl.textContent = '';

  const btn = el('catSaveNew');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createCategory({
      tx_type_key, major_category_label, minor_category_label, description,
      record_status, is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory,
    });
    if (res.ok) {
      showMsg('Category added.');
      state.catAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveNewCategory failed:', res.error);
      const msg = res.error === 'duplicate_category'
        ? 'This category already exists.'
        : 'Error: ' + (res.error || 'unknown');
      if (errEl) errEl.textContent = msg;
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveNewCategory failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveCatEdit() {
  const rowNum = state.catEditRow;
  if (!rowNum) return;

  const tx_type_key           = el('catEditType').value;
  const major_category_label  = el('catEditMajor').value.trim();
  const minor_category_label  = el('catEditMinor').value.trim();
  const description           = el('catEditDesc').value.trim();
  const tag_keywords          = el('catEditKeywords').value.trim();
  const counterparty_examples = el('catEditCounterparty').value.trim();
  const source_account_types  = _getCheckedAccountTypes('catEditSrc');
  const target_account_types  = _getCheckedAccountTypes('catEditTgt');
  const source_account_mandatory = el('catEditSrcMandatory').checked === true;
  const target_account_mandatory = el('catEditTgtMandatory').checked === true;
  const record_status            = el('catEditRecordStatus').value;
  const is_subscription_eligible = el('catEditIsSubEligible').checked === true;
  const errEl                    = el('catEditError');

  if (!major_category_label || !minor_category_label) {
    if (errEl) errEl.textContent = 'Major and minor category are required.';
    return;
  }
  if (errEl) errEl.textContent = '';

  const btn = el('catSaveEdit');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num: rowNum, tx_type_key, major_category_label, minor_category_label, description,
      record_status, is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory,
    });
    if (res.ok) {
      showMsg('Category updated.');
      state.catEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveCatEdit failed:', res.error);
      const msg = res.error === 'duplicate_category'
        ? 'This category already exists.'
        : res.error === 'record_locked'
          ? 'This category is locked and cannot be edited.'
          : 'Update failed: ' + (res.error || 'unknown');
      if (errEl) errEl.textContent = msg;
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveCatEdit failed:', err);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _deleteCat(rowNum) {
  showLoading();
  try {
    const res = await ExpenseAPI.deleteCategory({ row_num: rowNum });
    if (res.ok) {
      showMsg('Category marked as deleted.');
      state.catDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _deleteCat failed:', res.error);
      const msg = res.error === 'record_locked'
        ? 'This category is locked and cannot be deleted.'
        : 'Delete failed: ' + (res.error || 'unknown');
      showMsg(msg, 'warn');
      state.catDeleteRow = null;
      renderCategories();
    }
  } catch (err) {
    console.error('[categories] _deleteCat failed:', err);
    showMsg('Connection error.', 'warn');
    state.catDeleteRow = null;
    renderCategories();
  } finally {
    hideLoading();
  }
}

