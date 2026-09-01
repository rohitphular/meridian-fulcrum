import { state } from '../core/state.js';
import { el, esc, openContextMenu, closeContextMenu, exportCategories, recordStatusIcon, syncStatusIcon, parseCsvRow } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Returns the error code string, or '[no error code]' if absent.
function _errMsg(code) {
  return (code !== undefined && code !== null) ? String(code) : '[no error code]';
}

let _catImportParsed = null;
let _catMenuKey      = null;
let _catDraft        = null;   // pending filter selections; copied to state.catFilters on Search
let _catDDCleanup    = null;   // cleanup fn for the currently open filter dropdown's outside-click listener

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
  if (state.categorySchema === null || state.categorySchema === undefined ||
      !Array.isArray(state.categorySchema.record_statuses)) {
    content.innerHTML = '<p class="placeholder">Category schema unavailable — please reload.</p>';
    return;
  }

  const filtered    = _applyFilters(state.categories);
  const activeCount = _activeFilterCount();
  const anyFormOpen = state.catAddOpen || state.catViewRow !== null || state.catEditRow !== null;
  const viewCat     = state.catViewRow !== null ? state.categories.find(c => c._row === state.catViewRow) : undefined;
  const editCat     = state.catEditRow !== null ? state.categories.find(c => c._row === state.catEditRow) : undefined;

  content.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="catImportBtn">${state.catImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="catExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="catAddBtn">${anyFormOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.catImportOpen ? _renderCatImportPanel() : ''}
    ${state.catAddOpen ? _renderForm({}, 'add') : ''}
    ${viewCat !== undefined ? _renderForm(viewCat, 'view') : ''}
    ${editCat !== undefined ? _renderForm(editCat, 'edit') : ''}
    ${_renderCatFilterBar(activeCount)}
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
  // CAT-M-7: derive status count from schema rather than hardcoding 4
  const ALL_STATUS_COUNT = state.categorySchema.record_statuses.length;
  return cats.filter(c => {
    if (f.type !== 'all' && c.tx_type_key !== f.type) return false;
    if (f.major !== 'all' && c.major_category_label !== f.major) return false;
    if (f.minor !== 'all' && c.minor_category_label !== f.minor) return false;
    if (f.search !== '') {
      const q   = f.search.toLowerCase();
      const hay = [c.major_category_label, c.minor_category_label, c.description, c.tag_keywords, c.counterparty_examples]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.sourceMandatory !== 'all' && c.source_account_mandatory !== (f.sourceMandatory === 'yes')) return false;
    if (f.targetMandatory !== 'all' && c.target_account_mandatory !== (f.targetMandatory === 'yes')) return false;
    if (f.subscriptionEligible !== 'all' && c.is_subscription_eligible !== (f.subscriptionEligible === 'yes')) return false;
    if (f.recordStatuses.length < ALL_STATUS_COUNT && !f.recordStatuses.includes(c.record_status)) return false;
    return true;
  });
}

function _activeFilterCount() {
  const f = state.catFilters;
  // CAT-M-7: derive status count from schema rather than hardcoding 4
  const ALL_STATUS_COUNT = state.categorySchema.record_statuses.length;
  let n = 0;
  if (f.type !== 'all')                              n++;
  if (f.major !== 'all')                             n++;
  if (f.minor !== 'all')                             n++;
  if (f.search !== '')                               n++;
  if (f.sourceMandatory !== 'all')                   n++;
  if (f.targetMandatory !== 'all')                   n++;
  if (f.subscriptionEligible !== 'all')              n++;
  if (f.recordStatuses.length < ALL_STATUS_COUNT)    n++;
  return n;
}

function _renderCatFilterBar(activeCount) {
  // CAT-L-5: activeCount is pre-computed by renderCategories() and passed in; no second call needed.
  const f = _catDraft !== null ? _catDraft : state.catFilters; // panel UI uses draft when available

  const majors = [];
  const seenM  = {};
  state.categories.filter(c => c.record_status === 'active').forEach(c => {
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
      .filter(c => c.major_category_label === f.major && c.record_status === 'active')
      .forEach(c => {
        if (!seenN[c.minor_category_label]) {
          seenN[c.minor_category_label] = true;
          minors.push(c.minor_category_label);
        }
      });
    minors.sort();
  }

  const rs = new Set(f.recordStatuses);

  const typeLabel   = f.type === 'money-in' ? 'Money In' : f.type === 'money-out' ? 'Money Out' : 'All types';
  const majorLabel  = f.major === 'all' ? 'All major' : esc(f.major);
  const minorLabel  = f.major === 'all' ? '— select major first —' : (f.minor === 'all' ? 'All minor' : esc(f.minor));
  const srcLabel    = f.sourceMandatory === 'yes' ? 'Required' : f.sourceMandatory === 'no' ? 'Optional' : 'All';
  const tgtLabel    = f.targetMandatory === 'yes' ? 'Required' : f.targetMandatory === 'no' ? 'Optional' : 'All';
  const subLabel    = f.subscriptionEligible === 'yes' ? 'Eligible' : f.subscriptionEligible === 'no' ? 'Not eligible' : 'All';
  const statusLabel = rs.size === state.categorySchema.record_statuses.length ? 'All' : rs.size === 0 ? 'None'
    : [...rs].map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');

  const trigStyle = 'width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none';
  const optStyle  = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

  const radioRows = (name, opts, cur) => opts.map(([val, lbl]) =>
    `<label style="${optStyle}"><input type="radio" name="${name}" value="${val}"${cur === val ? ' checked' : ''}> ${lbl}</label>`
  ).join('');

  const dd = (triggerId, labelId, menuId, curLabel, items, disabled) => `
    <div style="flex:1;position:relative">
      <button type="button" id="${triggerId}"${disabled ? ' disabled' : ''} style="${trigStyle}${disabled ? ';opacity:0.5;cursor:not-allowed' : ''}">
        <span id="${labelId}">${curLabel}</span>
        <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
      </button>
      <div id="${menuId}" style="display:none">${items}</div>
    </div>`;

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="catFilterToggle">
      Filters${activeCount > 0 ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.catFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.catFilterOpen ? '' : 'hidden'}" id="catFilterBody">
      <div class="filter-row">
        <label>Type</label>
        ${dd('catFTypeTrigger','catFTypeLabel','catFTypeMenu', typeLabel,
          radioRows('catFTypeR', [['all','All types'],['money-in','Money In'],['money-out','Money Out']], f.type))}
      </div>
      <div class="filter-row">
        <label>Major</label>
        ${dd('catFMajorTrigger','catFMajorLabel','catFMajorMenu', majorLabel,
          radioRows('catFMajorR', [['all','All major'], ...majors.map(m => [m, m])], f.major))}
      </div>
      <div class="filter-row">
        <label>Minor</label>
        ${dd('catFMinorTrigger','catFMinorLabel','catFMinorMenu', minorLabel,
          f.major === 'all' ? '' : radioRows('catFMinorR', [['all','All minor'], ...minors.map(n => [n, n])], f.minor),
          f.major === 'all')}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="catFSearch" placeholder="name, keywords…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-row">
        <label>Source acct</label>
        ${dd('catFSrcTrigger','catFSrcLabel','catFSrcMenu', srcLabel,
          radioRows('catFSrcR', [['all','All'],['yes','Required'],['no','Optional']], f.sourceMandatory))}
      </div>
      <div class="filter-row">
        <label>Target acct</label>
        ${dd('catFTgtTrigger','catFTgtLabel','catFTgtMenu', tgtLabel,
          radioRows('catFTgtR', [['all','All'],['yes','Required'],['no','Optional']], f.targetMandatory))}
      </div>
      <div class="filter-row">
        <label>Subscription</label>
        ${dd('catFSubTrigger','catFSubLabel','catFSubMenu', subLabel,
          radioRows('catFSubR', [['all','All'],['yes','Eligible'],['no','Not eligible']], f.subscriptionEligible))}
      </div>
      <div class="filter-row">
        <label>Status</label>
        ${dd('catFStatusTrigger','catFStatusLabel','catFStatusMenu', statusLabel,
          state.categorySchema.record_statuses.map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-cat-filter-rstat="${s}"${rs.has(s) ? ' checked' : ''}> ${s.charAt(0).toUpperCase() + s.slice(1)}</label>`
          ).join(''))}
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

  // CAT-M-6: build record_status options dynamically from schema
  const statuses = state.categorySchema.record_statuses;
  // Add mode: only active is allowed on create (CAT-NEW-H-1: backend always writes 'active')
  const allowedForAdd  = statuses.filter(s => s === 'active');
  // Edit/view mode: all statuses are available
  const allowedForEdit = statuses;
  const statusOptions  = (isEdit || isView ? allowedForEdit : allowedForAdd).map(s => {
    const isSelected = isEdit || isView
      ? (cat.record_status === s ? 'selected' : '')
      : (s === 'active' ? 'selected' : '');
    const label = s.charAt(0).toUpperCase() + s.slice(1);
    return `<option value="${esc(s)}" ${isSelected}>${esc(label)}</option>`;
  }).join('');

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
        <input type="text" id="${pfx}Major" placeholder="e.g. Food" ${cat.major_category_label !== undefined && cat.major_category_label !== null && cat.major_category_label !== '' ? `value="${esc(String(cat.major_category_label))}"` : ''}${dis}>
        <div class="field-hint">Top-level category group.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Minor *</label>
        <input type="text" id="${pfx}Minor" placeholder="e.g. Groceries" ${cat.minor_category_label !== undefined && cat.minor_category_label !== null && cat.minor_category_label !== '' ? `value="${esc(String(cat.minor_category_label))}"` : ''}${dis}>
        <div class="field-hint">Specific category name shown in dropdowns.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Description</label>
        <input type="text" id="${pfx}Desc" placeholder="Short description" ${cat.description !== undefined && cat.description !== null && cat.description !== '' ? `value="${esc(String(cat.description))}"` : ''}${dis}>
        <div class="field-hint">Shown in tooltips and reports.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Tag keywords</label>
        <input type="text" id="${pfx}Keywords" placeholder="tesco, sainsbury…" ${cat.tag_keywords !== undefined && cat.tag_keywords !== null && cat.tag_keywords !== '' ? `value="${esc(String(cat.tag_keywords))}"` : ''}${dis}>
        <div class="field-hint">Comma-and-space-separated, for auto-classification.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Counterparty examples</label>
        <input type="text" id="${pfx}Counterparty" placeholder="Tesco, Sainsbury's…" ${cat.counterparty_examples !== undefined && cat.counterparty_examples !== null && cat.counterparty_examples !== '' ? `value="${esc(String(cat.counterparty_examples))}"` : ''}${dis}>
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
      ${_renderAcctTypeCheckboxes(srcId, (cat.source_account_types !== undefined && cat.source_account_types !== null) ? cat.source_account_types : undefined, isView)}
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Target account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}TgtMandatory" ${cat.target_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(tgtId, (cat.target_account_types !== undefined && cat.target_account_types !== null) ? cat.target_account_types : undefined, isView)}
    </div>
    ${isEdit || isView ? `
    <div class="field" style="margin-top:14px">
      <label>Record status</label>
      <select id="${pfx}RecordStatus"${dis}>${statusOptions}</select>
    </div>` : `
    <div class="field" style="margin-top:14px">
      <label>Record status</label>
      <select id="${pfx}RecordStatus">${statusOptions}</select>
    </div>`}
    <label class="checkbox-label cat-mandatory-check" style="margin-top:8px">
      <input type="checkbox" id="${pfx}IsSubEligible" ${cat.is_subscription_eligible === true ? 'checked' : ''}${dis}> Subscription eligible
    </label>
    ${isView ? `
    <div style="margin-top:14px;font-size:12px;color:var(--muted)">
      Sync: ${syncStatusIcon((cat.sync_status !== undefined && cat.sync_status !== null) ? cat.sync_status : '')} ${esc((cat.sync_status !== undefined && cat.sync_status !== null) ? cat.sync_status : '—')}${(cat.sync_notes !== undefined && cat.sync_notes !== null && cat.sync_notes !== '') ? ' · ' + esc(cat.sync_notes) : ''}
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
  if (cats.length === 0) {
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
  const rawValue = (currentValue !== undefined && currentValue !== null) ? String(currentValue) : '';
  const selected = new Set(
    rawValue.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '')
  );
  const dis = disabled ? ' disabled' : '';

  const renderGroup = (label, types) =>
    `<div class="acct-type-group">
      <span class="acct-type-group-label">${label}</span>
      <div class="acct-type-checks">
        ${types.map(t =>
          `<label class="acct-type-check">
            <input type="checkbox" data-acct-type="${esc(t)}" ${selected.has(t) ? 'checked' : ''}${dis}> ${esc(ACCT_TYPE_LABELS[t] !== undefined ? ACCT_TYPE_LABELS[t] : t)}
          </label>`
        ).join('')}
      </div>
    </div>`;

  const { asset, credit, loan } = _acctTypeGroups();
  const idAttr = containerId !== '' ? ` id="${esc(containerId)}"` : '';
  return `<div class="account-type-checkboxes"${idAttr}>
    ${renderGroup('Assets', asset)}
    ${renderGroup('Credit', credit)}
    ${renderGroup('Loans',  loan)}
  </div>`;
}

function _getCheckedAccountTypes(containerId) {
  const container = el(containerId);
  if (container === null) return '';
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

function _parseCatCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return { categories: [], errors: ['File is empty.'] };

  const headers = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const categories = [], errors = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] !== undefined ? vals[idx].trim() : undefined; });

    if (row.tx_type_key === undefined || row.tx_type_key === null || row.tx_type_key === '') { errors.push(`Row ${i + 1}: missing tx_type_key`); continue; }
    if (!['money-in', 'money-out'].includes(row.tx_type_key)) {
      errors.push(`Row ${i + 1}: tx_type_key must be "money-in" or "money-out"`);
      continue;
    }
    if (row.major_category_label === '') { errors.push(`Row ${i + 1}: missing major_category_label`); continue; }
    if (row.minor_category_label === '') { errors.push(`Row ${i + 1}: missing minor_category_label`); continue; }

    categories.push({
      tx_type_key:               row.tx_type_key,
      tx_type_label:             row.tx_type_label,
      major_category_key:        row.major_category_key,
      major_category_label:      row.major_category_label,
      minor_category_key:        row.minor_category_key,
      minor_category_label:      row.minor_category_label,
      description:               row.description,
      record_status:             row.record_status,
      tag_keywords:              row.tag_keywords,
      counterparty_examples:     row.counterparty_examples,
      source_account_types:      row.source_account_types,
      target_account_types:      row.target_account_types,
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
  if (categories.length === 0) return errHtml + '<p class="pin-error" style="margin:0">No valid rows found — check the column headers match the expected format.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'} ready to import</p>`;
}

async function _submitCatImport(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    const errEl = el('catImportError');
    if (errEl) errEl.textContent = 'No valid rows to import.';
    return;
  }
  const btn   = el('catImportConfirm');
  const errEl = el('catImportError');
  if (btn !== null)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl !== null) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createCategoriesBulk({ categories });
    if (!res.ok && (res.results === undefined || res.results === null)) {
      console.warn('[categories] _submitCatImport failed:', res.error);
      if (errEl !== null) errEl.textContent = 'Error: ' + _errMsg(res.error);
      if (btn !== null)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }
    const created = res.created;
    const updated = res.updated;
    const failed  = res.failed;
    _catImportParsed = null;
    state.catImportOpen = false;
    const parts = [];
    if (created > 0) parts.push(`${created} imported`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (failed > 0)  parts.push(`${failed} failed`);
    const importMsg = parts.join(' · ');
    showMsg(importMsg !== '' ? importMsg : 'Nothing to import');
    document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (err) {
    console.error('[categories] _submitCatImport failed:', err);
    if (errEl !== null) errEl.textContent = 'Connection error.';
    if (btn !== null)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachCatEvents() {
  if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
  el('catExportBtn').addEventListener('click', () => {
    const rows = _applyFilters(state.categories);
    if (rows.length === 0) { showMsg('No categories to export.', 'warn'); return; }
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
      if (file === undefined || file === null) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const parsed = _parseCatCsv(ev.target.result);
        _catImportParsed = parsed.categories.length > 0 ? parsed.categories : null;
        const status = el('catImportStatus');
        if (status !== null) status.innerHTML = _renderCatImportStatus(parsed);
        const btn = el('catImportConfirm');
        if (btn !== null) btn.disabled = _catImportParsed === null;
      };
      reader.readAsText(file);
    });

    el('catImportConfirm').addEventListener('click', () => {
      if (_catImportParsed !== null) _submitCatImport(_catImportParsed);
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
    if (viewToEditEl !== null) viewToEditEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.catViewRow = null;
      state.catEditRow = row;
      renderCategories();
    });
    const viewRestoreEl = el('catViewRestore');
    if (viewRestoreEl !== null) viewRestoreEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.catViewRow = null;
      _restoreCat(row);
    });
  }

  el('catFilterToggle').addEventListener('click', () => {
    state.catFilterOpen = !state.catFilterOpen;
    if (state.catFilterOpen && _catDraft === null) {
      _catDraft = { ...state.catFilters, recordStatuses: [...state.catFilters.recordStatuses] };
    }
    renderCategories();
  });

  if (state.catFilterOpen) {
    if (_catDraft === null) {
      _catDraft = { ...state.catFilters, recordStatuses: [...state.catFilters.recordStatuses] };
    }

    const MENU_OPEN_STYLE = 'display:flex;flex-direction:column;gap:8px;position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.15)';
    const OPT_STYLE       = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

    const ALL_DD_MENUS = ['catFTypeMenu','catFMajorMenu','catFMinorMenu','catFSrcMenu','catFTgtMenu','catFSubMenu','catFStatusMenu'];

    const _openDD = (triggerId, menuId) => {
      ALL_DD_MENUS.filter(id => id !== menuId).forEach(id => {
        const m = el(id); if (m !== null && m.style.display !== 'none') m.style.cssText = 'display:none';
      });
      if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
      const menu = el(menuId);
      if (menu === null) return;
      if (menu.style.display === 'flex') { menu.style.cssText = 'display:none'; return; }
      const trig = el(triggerId);
      if (trig === null) return;
      const r = trig.getBoundingClientRect();
      menu.style.cssText = `${MENU_OPEN_STYLE};top:${r.bottom + 4}px;left:${r.left}px;width:${r.width}px`;
      const close = e => {
        if (trig.contains(e.target) || menu.contains(e.target)) return;
        menu.style.cssText = 'display:none';
        document.removeEventListener('click', close, true);
        _catDDCleanup = null;
      };
      document.addEventListener('click', close, true);
      _catDDCleanup = () => document.removeEventListener('click', close, true);
    };

    el('catFTypeTrigger').addEventListener('click',   () => _openDD('catFTypeTrigger',   'catFTypeMenu'));
    el('catFMajorTrigger').addEventListener('click',  () => _openDD('catFMajorTrigger',  'catFMajorMenu'));
    el('catFMinorTrigger').addEventListener('click',  () => {
      const trig = el('catFMinorTrigger');
      if (trig !== null && trig.disabled) return;
      _openDD('catFMinorTrigger', 'catFMinorMenu');
    });
    el('catFSrcTrigger').addEventListener('click',    () => _openDD('catFSrcTrigger',    'catFSrcMenu'));
    el('catFTgtTrigger').addEventListener('click',    () => _openDD('catFTgtTrigger',    'catFTgtMenu'));
    el('catFSubTrigger').addEventListener('click',    () => _openDD('catFSubTrigger',    'catFSubMenu'));
    el('catFStatusTrigger').addEventListener('click', () => _openDD('catFStatusTrigger', 'catFStatusMenu'));

    // Single-select radio menus — event delegation on the container
    const _delegateRadio = (menuId, draftKey, labelId, labelMap) => {
      const menu = el(menuId);
      if (menu === null) return;
      menu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_catDraft !== null) _catDraft[draftKey] = val;
        const lbl = el(labelId); if (lbl !== null) lbl.textContent = labelMap[val] !== undefined ? labelMap[val] : val;
        menu.style.cssText = 'display:none';
        if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
      });
    };
    _delegateRadio('catFTypeMenu',  'type',                'catFTypeLabel',  { all: 'All types', 'money-in': 'Money In', 'money-out': 'Money Out' });
    _delegateRadio('catFSrcMenu',   'sourceMandatory',      'catFSrcLabel',   { all: 'All', yes: 'Required', no: 'Optional' });
    _delegateRadio('catFTgtMenu',   'targetMandatory',      'catFTgtLabel',   { all: 'All', yes: 'Required', no: 'Optional' });
    _delegateRadio('catFSubMenu',   'subscriptionEligible', 'catFSubLabel',   { all: 'All', yes: 'Eligible', no: 'Not eligible' });

    // Major — delegation; also repopulates minor menu and updates minor trigger state
    const majorMenu = el('catFMajorMenu');
    if (majorMenu !== null) {
      majorMenu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_catDraft !== null) { _catDraft.major = val; _catDraft.minor = 'all'; }
        const lbl = el('catFMajorLabel'); if (lbl !== null) lbl.textContent = val === 'all' ? 'All major' : val;
        majorMenu.style.cssText = 'display:none';
        if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }

        const minTrig = el('catFMinorTrigger');
        const minMenu = el('catFMinorMenu');
        const minLbl  = el('catFMinorLabel');
        if (val === 'all') {
          if (minTrig !== null) { minTrig.disabled = true; minTrig.style.opacity = '0.5'; minTrig.style.cursor = 'not-allowed'; }
          if (minLbl !== null)  minLbl.textContent = '— select major first —';
          if (minMenu !== null) minMenu.innerHTML = '';
        } else {
          const mins = [], seen = {};
          state.categories.filter(c => c.major_category_label === val && c.record_status === 'active').forEach(c => {
            if (!seen[c.minor_category_label]) { seen[c.minor_category_label] = true; mins.push(c.minor_category_label); }
          });
          mins.sort();
          if (minTrig !== null) { minTrig.disabled = false; minTrig.style.opacity = ''; minTrig.style.cursor = ''; }
          if (minLbl !== null)  minLbl.textContent = 'All minor';
          if (minMenu !== null) minMenu.innerHTML = [['all','All minor'], ...mins.map(n => [n, n])].map(([v, l]) =>
            `<label style="${OPT_STYLE}"><input type="radio" name="catFMinorR" value="${v}"${v === 'all' ? ' checked' : ''}> ${esc(l)}</label>`
          ).join('');
        }
      });
    }

    // Minor — delegation (handles dynamically repopulated innerHTML)
    const minorMenu = el('catFMinorMenu');
    if (minorMenu !== null) {
      minorMenu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_catDraft !== null) _catDraft.minor = val;
        const lbl = el('catFMinorLabel'); if (lbl !== null) lbl.textContent = val === 'all' ? 'All minor' : val;
        minorMenu.style.cssText = 'display:none';
        if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
      });
    }

    // Status checkboxes — delegation; dropdown stays open while checking
    const statusMenu = el('catFStatusMenu');
    if (statusMenu !== null) {
      statusMenu.addEventListener('change', () => {
        if (_catDraft === null) return;
        const checked = Array.from(statusMenu.querySelectorAll('[data-cat-filter-rstat]:checked'))
          .map(c => c.dataset.catFilterRstat);
        _catDraft.recordStatuses = checked;
        const lbl = el('catFStatusLabel');
        if (lbl) lbl.textContent = checked.length === state.categorySchema.record_statuses.length ? 'All' : checked.length === 0 ? 'None'
          : checked.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
      });
    }

    // Apply draft → state on Search / Enter
    const _applyDraft = () => {
      if (_catDraft !== null) {
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
        recordStatuses: state.categorySchema.record_statuses.slice(),
      };
      renderCategories();
    });
  }

  const handleCatAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row !== undefined && btn.dataset.row !== '' ? Number(btn.dataset.row) : undefined;

    if (action === 'cat-menu') {
      if (_catMenuKey === row) { closeContextMenu(); _catMenuKey = null; return; }
      _catMenuKey = row;
      const menuCat   = state.categories.find(c => c._row === row);
      const isLocked  = menuCat !== undefined && menuCat !== null && menuCat.record_status === 'locked';
      const isDeleted = menuCat !== undefined && menuCat !== null && menuCat.record_status === 'deleted';
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
          if (cat !== undefined && cat !== null) {
            state.filters = { types: [], accounts: [], major: [cat.major_category_key], minor: [cat.minor_category_key], user_location_country: '', tag: '', search: '' };
            document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
          }
        }
      });
      return;
    }
    if (action === 'cat-view')   { state.catViewRow = row; state.catEditRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
    if (action === 'cat-edit') {
      const editCat = state.categories.find(c => c._row === row);
      if (editCat !== undefined && editCat !== null && (editCat.record_status === 'locked' || editCat.record_status === 'deleted')) return;
      state.catEditRow = row; state.catViewRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories();
    }
    if (action === 'cat-delete') {
      const delCat = state.categories.find(c => c._row === row);
      if (delCat !== undefined && delCat !== null && (delCat.record_status === 'locked' || delCat.record_status === 'deleted')) return;
      state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; renderCategories();
    }
    if (action === 'cat-cancel-delete')  { state.catDeleteRow = null; renderCategories(); }
    if (action === 'cat-confirm-delete') { _deleteCat(row); }
  };
  const tableWrap = el('categoriesContent').querySelector('.cat-table-wrap');
  if (tableWrap !== null) tableWrap.addEventListener('click', handleCatAction);
  const catCards = el('categoriesContent').querySelector('.cat-cards');
  if (catCards !== null) catCards.addEventListener('click', handleCatAction);
}

// ── Restore ───────────────────────────────────────────────────────────────────

async function _restoreCat(rowNum) {
  const cat = state.categories.find(c => c._row === rowNum);
  if (cat === undefined || cat === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num:                  rowNum,
      tx_type_key:              cat.tx_type_key,
      major_category_label:     cat.major_category_label,
      minor_category_label:     cat.minor_category_label,
      description:              cat.description,
      record_status:            'active',
      is_subscription_eligible: Boolean(cat.is_subscription_eligible),
      tag_keywords:             cat.tag_keywords,
      counterparty_examples:    cat.counterparty_examples,
      source_account_types:     cat.source_account_types,
      target_account_types:     cat.target_account_types,
      source_account_mandatory: Boolean(cat.source_account_mandatory),
      target_account_mandatory: Boolean(cat.target_account_mandatory),
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
          : 'Restore failed: ' + _errMsg(res.error);
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
  // CAT-M-8: record_status is NOT sent on create — backend always writes 'active' regardless.
  const is_subscription_eligible = el('catNewIsSubEligible').checked === true;
  const errEl                    = el('catAddError');

  if (major_category_label === '') { if (errEl !== null) errEl.textContent = 'Major category is required.'; return; }
  if (minor_category_label === '') { if (errEl !== null) errEl.textContent = 'Minor category is required.'; return; }
  if (errEl !== null) errEl.textContent = '';

  const btn = el('catSaveNew');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createCategory({
      tx_type_key, major_category_label, minor_category_label, description,
      is_subscription_eligible, tag_keywords, counterparty_examples,
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
        : 'Error: ' + _errMsg(res.error);
      if (errEl !== null) errEl.textContent = msg;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveNewCategory failed:', err);
    if (errEl !== null) errEl.textContent = 'Connection error.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveCatEdit() {
  const rowNum = state.catEditRow;
  if (rowNum === null || rowNum === undefined || rowNum < 2) return;

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

  if (major_category_label === '' || minor_category_label === '') {
    if (errEl !== null) errEl.textContent = 'Major and minor category are required.';
    return;
  }
  if (errEl !== null) errEl.textContent = '';

  const btn = el('catSaveEdit');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
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
          : 'Update failed: ' + _errMsg(res.error);
      if (errEl !== null) errEl.textContent = msg;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveCatEdit failed:', err);
    if (errEl !== null) errEl.textContent = 'Connection error.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
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
        : 'Delete failed: ' + _errMsg(res.error);
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

