import { state } from '../core/state.js';
import { el, esc, openContextMenu, closeContextMenu, exportCategories } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

let _catImportParsed = null;
let _catMenuKey = null;

function _acctTypeGroups() {
  const schema = state.accountSchema;
  return {
    asset:  schema?.asset_sub_types      ?? ['current', 'savings', 'cash'],
    credit: schema?.liability_sub_types  ?? ['credit_card', 'overdraft'],
    loan:   schema?.loan_sub_types       ?? ['personal_loan', 'mortgage', 'auto_loan', 'heloc', 'student_loan', 'medical_loan', 'debt_consolidation'],
  };
}

const WORKFLOW_TYPES = [
  { value: 'account-credit',  label: 'Account Credit — credit target' },
  { value: 'account-debit',   label: 'Account Debit — debit source' },
  { value: 'funds-transfer',  label: 'Funds Transfer — debit source, credit target' },
  { value: 'forex-transfer',  label: 'Forex Transfer — debit source, credit target (FX)' },
  { value: 'debt-repayment',  label: 'Debt Repayment — debit source, reduce liability' },
];

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

  const filtered = state.catFilter === 'all'
    ? state.categories
    : state.categories.filter(c => c.tx_type === state.catFilter);

  const CAT_FILTERS = [
    { key: 'all',            label: 'All' },
    { key: 'money-in',       label: 'Money In' },
    { key: 'money-out',      label: 'Money Out' },
    { key: 'money-transfer', label: 'Transfer' },
  ];
  const filterLabel = CAT_FILTERS.find(o => o.key === (state.catFilter || 'all'))?.label || 'All';
  const anyFormOpen = state.catAddOpen || state.catViewRow !== null || state.catEditRow !== null;
  const viewCat = state.catViewRow !== null ? state.categories.find(c => c._row === state.catViewRow) : null;
  const editCat = state.catEditRow !== null ? state.categories.find(c => c._row === state.catEditRow) : null;

  content.innerHTML = `
    <div class="sec-head" style="align-items:center;gap:8px">
      <button class="btn btn-secondary btn-sm" id="catFilterBtn">≡ ${esc(filterLabel)}</button>
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="catExportBtn">↓ Export</button>
        <button class="btn btn-secondary btn-sm" id="catImportBtn">${state.catImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-primary btn-sm" id="catAddBtn">${anyFormOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.catImportOpen ? _renderCatImportPanel() : ''}
    ${state.catAddOpen ? _renderForm(null,    'add')  : ''}
    ${viewCat          ? _renderForm(viewCat, 'view') : ''}
    ${editCat          ? _renderForm(editCat, 'edit') : ''}
    <div class="cat-count-bar">
      <span class="cat-count">${filtered.length} ${filtered.length === 1 ? 'category' : 'categories'}</span>
    </div>
    ${_renderCatTable(filtered)}
  `;

  _attachCatEvents();
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _renderForm(cat, mode) {
  const isView = mode === 'view';
  const isEdit = mode === 'edit';
  const dis    = isView ? ' disabled' : '';
  const pfx    = isEdit ? 'catEdit' : 'catNew';
  const srcId  = isView ? '' : `${pfx}Src`;
  const tgtId  = isView ? '' : `${pfx}Tgt`;

  const types = state.transactionSchema?.types ?? ['money-in', 'money-out', 'money-transfer'];
  const typeOpts = types.map(t => {
    const v = typeof t === 'string' ? t : t.value;
    return `<option value="${esc(v)}" ${cat?.tx_type === v ? 'selected' : ''}>${esc(v)}</option>`;
  }).join('');

  const wfTypeOpts = WORKFLOW_TYPES.map(w =>
    `<option value="${esc(w.value)}" ${cat?.workflow_type === w.value ? 'selected' : ''}>${esc(w.label)}</option>`
  ).join('');

  const header = (isView || isEdit) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} —
      <strong>${esc(cat.major_category)}</strong> / ${esc(cat.minor_category)}
    </div>` : '';

  return `
  <div class="card" style="margin-bottom:20px">
    ${header}
    <div class="form-grid form-grid-4" style="margin-bottom:12px">
      <div class="field">
        <label>Type *</label>
        <select id="${pfx}Type"${dis}>${typeOpts}</select>
        <div class="field-hint">money-in, money-out, or money-transfer.</div>
      </div>
      <div class="field">
        <label>Major *</label>
        <input type="text" id="${pfx}Major" placeholder="e.g. Food" value="${esc(String(cat?.major_category || ''))}"${dis}>
        <div class="field-hint">Top-level category group.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Minor *</label>
        <input type="text" id="${pfx}Minor" placeholder="e.g. Groceries" value="${esc(String(cat?.minor_category || ''))}"${dis}>
        <div class="field-hint">Specific category name shown in dropdowns.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Description</label>
        <input type="text" id="${pfx}Desc" placeholder="Short description" value="${esc(String(cat?.description || ''))}"${dis}>
        <div class="field-hint">Shown in tooltips and reports.</div>
      </div>
      <div class="field">
        <label>Workflow type *</label>
        <select id="${pfx}WorkflowType"${dis}>${wfTypeOpts}</select>
        <div class="field-hint">Balance steps executed on save.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Tag keywords</label>
        <input type="text" id="${pfx}Keywords" placeholder="tesco, sainsbury…" value="${esc(String(cat?.tag_keywords || ''))}"${dis}>
        <div class="field-hint">Comma-separated, for auto-classification.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Counterparty examples</label>
        <input type="text" id="${pfx}Counterparty" placeholder="Tesco, Sainsbury's…" value="${esc(String(cat?.counterparty_examples || ''))}"${dis}>
        <div class="field-hint">Comma-separated merchant names.</div>
      </div>
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Source account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}SrcMandatory" ${cat?.source_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(srcId, cat?.source_account_types || '', isView)}
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Target account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}TgtMandatory" ${cat?.target_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(tgtId, cat?.target_account_types || '', isView)}
    </div>
    ${(isEdit || isView) ? `
    <label class="checkbox-label cat-mandatory-check" style="margin-top:14px">
      <input type="checkbox" id="${pfx}IsActive" ${(cat?.is_active !== false) ? 'checked' : ''}${dis}> Active
    </label>` : ''}
    <label class="checkbox-label cat-mandatory-check" style="margin-top:8px">
      <input type="checkbox" id="${pfx}IsSubEligible" ${cat?.is_subscription_eligible === true ? 'checked' : ''}${dis}> Subscription eligible
    </label>
    ${isView ? `
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-secondary" id="catCancelView">Close</button>
      <button class="btn btn-primary" id="catViewToEdit" data-row="${cat?._row}">Edit</button>
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
    const isArchived = !cat.is_active;
    const rowStyle   = isArchived ? ' style="opacity:0.5"' : '';

    if (state.catDeleteRow === cat._row) {
      return `<tr>
        <td>${_catTypeBadge(cat.tx_type)}</td>
        <td colspan="2"><span class="confirm-text">Delete <strong>${esc(cat.major_category)} → ${esc(cat.minor_category)}</strong>?</span></td>
        <td><div class="row-actions">
          <button class="btn-link danger" data-action="cat-confirm-delete" data-row="${cat._row}">Yes, delete</button>
          <button class="btn-link muted"  data-action="cat-cancel-delete">Cancel</button>
        </div></td>
      </tr>`;
    }

    return `<tr${rowStyle}>
      <td>${_catTypeBadge(cat.tx_type)}</td>
      <td class="td-name">${esc(cat.major_category)}</td>
      <td>${esc(cat.minor_category)}</td>
      <td><button class="tx-menu-trigger" data-action="cat-menu" data-row="${cat._row}">⋮</button></td>
    </tr>`;
  }).join('');

  const cardRows = cats.map(cat => {
    const isArchived = !cat.is_active;
    if (state.catDeleteRow === cat._row) return '';
    return `<div class="cat-card${isArchived ? ' is-archived' : ''}">
      <div class="cat-card-top">
        <div class="cat-card-name">
          ${_catTypeDot(cat.tx_type)}
          <span class="cat-card-major">${esc(cat.major_category)}</span>
          <span class="cat-card-sep">›</span>
          <span class="cat-card-minor">${esc(cat.minor_category)}</span>
        </div>
        <button class="tx-menu-trigger" data-action="cat-menu" data-row="${cat._row}">⋮</button>
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
          <th style="width:40px"></th>
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
  const cls   = type === 'money-in' ? 'badge-et-in' : type === 'money-out' ? 'badge-et-out' : 'badge-et-transfer';
  const label = type === 'money-in' ? 'in'       : type === 'money-out' ? 'out'       : 'xfer';
  return `<span class="badge ${cls}">${label}</span>`;
}

function _catTypeDot(type) {
  const cls = type === 'money-in' ? 'tx-dot-in' : type === 'money-out' ? 'tx-dot-out' : 'tx-dot-transfer';
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
        <div class="field-hint">Columns: tx_type, major_category, minor_category, description, is_active, tag_keywords, counterparty_examples, source_account_types, target_account_types, source_account_mandatory, target_account_mandatory, workflow_type</div>
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

    if (!row.tx_type) { errors.push(`Row ${i + 1}: missing tx_type`); continue; }
    if (!row.major_category)   { errors.push(`Row ${i + 1}: missing major_category`);   continue; }
    if (!row.minor_category)   { errors.push(`Row ${i + 1}: missing minor_category`);   continue; }
    if (!row.workflow_type)    { errors.push(`Row ${i + 1}: missing workflow_type`);     continue; }

    categories.push({
      tx_type:                   row.tx_type,
      major_category:            row.major_category,
      minor_category:            row.minor_category,
      description:               row.description             || '',
      is_active:                 row.is_active !== 'FALSE' && row.is_active !== 'false',
      tag_keywords:              row.tag_keywords            || '',
      counterparty_examples:     row.counterparty_examples   || '',
      source_account_types:      row.source_account_types    || '',
      target_account_types:      row.target_account_types    || '',
      source_account_mandatory:  row.source_account_mandatory === 'TRUE' || row.source_account_mandatory === 'true',
      target_account_mandatory:  row.target_account_mandatory === 'TRUE' || row.target_account_mandatory === 'true',
      workflow_type:             row.workflow_type,
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
  if (!categories.length) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'} ready to import</p>`;
}

async function _submitCatImport(categories) {
  const btn   = el('catImportConfirm');
  const errEl = el('catImportError');
  if (btn)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createCategoriesBulk({ categories });
    if (!res.ok && !res.results) {
      console.warn('[categories] _submitCatImport failed:', res?.error);
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
  el('catExportBtn')?.addEventListener('click', () => {
    const rows = state.catFilter === 'all'
      ? state.categories
      : state.categories.filter(c => c.tx_type === state.catFilter);
    openContextMenu(el('catExportBtn'), [
      { key: 'csv',  label: '↓ CSV'  },
      { key: 'json', label: '↓ JSON' },
    ], key => exportCategories(key, rows));
  });

  el('catImportBtn')?.addEventListener('click', () => {
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

  el('catImportFile')?.addEventListener('change', e => {
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

  el('catImportConfirm')?.addEventListener('click', () => {
    if (_catImportParsed) _submitCatImport(_catImportParsed);
  });

  el('catImportCancel')?.addEventListener('click', () => {
    state.catImportOpen = false;
    _catImportParsed = null;
    renderCategories();
  });

  el('catAddBtn')?.addEventListener('click', () => {
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
  el('catSaveNew')?.addEventListener('click', _saveNewCategory);
  el('catCancelNew')?.addEventListener('click', () => { state.catAddOpen = false; renderCategories(); });

  // Edit form
  el('catSaveEdit')?.addEventListener('click', _saveCatEdit);
  el('catCancelEdit')?.addEventListener('click', () => { state.catEditRow = null; renderCategories(); });

  // View form
  el('catCancelView')?.addEventListener('click', () => { state.catViewRow = null; renderCategories(); });
  el('catViewToEdit')?.addEventListener('click', e => {
    const row = Number(e.currentTarget.dataset.row);
    state.catViewRow = null;
    state.catEditRow = row;
    renderCategories();
  });

  el('catFilterBtn')?.addEventListener('click', () => {
    openContextMenu(el('catFilterBtn'), [
      { key: 'all',            label: 'All' },
      { key: 'money-in',       label: 'Money In' },
      { key: 'money-out',      label: 'Money Out' },
      { key: 'money-transfer', label: 'Transfer' },
    ], key => {
      state.catFilter    = key;
      state.catAddOpen   = false;
      state.catViewRow   = null;
      state.catEditRow   = null;
      state.catDeleteRow = null;
      renderCategories();
    });
  });

  const handleCatAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;

    if (action === 'cat-menu') {
      if (_catMenuKey === row) { closeContextMenu(); _catMenuKey = null; return; }
      _catMenuKey = row;
      openContextMenu(btn, [
        { key: 'cat-view',   label: 'View',         cls: '' },
        { key: 'cat-edit',   label: 'Edit',         cls: '' },
        { key: 'cat-txs',    label: 'Transactions', cls: '' },
        { key: 'cat-delete', label: 'Delete',       cls: 'danger' },
      ], key => {
        _catMenuKey = null;
        if (key === 'cat-view')   { state.catViewRow = row; state.catEditRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
        if (key === 'cat-edit')   { state.catEditRow = row; state.catViewRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
        if (key === 'cat-delete') { state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; renderCategories(); }
        if (key === 'cat-txs') {
          const cat = state.categories.find(c => c._row === row);
          if (cat) {
            state.filters = { types: [], accounts: [], major: [cat.major_category], minor: [cat.minor_category], tx_location_country: '', tag: '', search: '' };
            document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
          }
        }
      });
      return;
    }
    if (action === 'cat-view')           { state.catViewRow = row; state.catEditRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
    if (action === 'cat-edit')           { state.catEditRow = row; state.catViewRow = null; state.catDeleteRow = null; state.catAddOpen = false; renderCategories(); }
    if (action === 'cat-delete')         { state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; renderCategories(); }
    if (action === 'cat-cancel-delete')  { state.catDeleteRow = null; renderCategories(); }
    if (action === 'cat-confirm-delete') { _deleteCat(row); }
  };
  el('categoriesContent')?.querySelector('.cat-table-wrap')?.addEventListener('click', handleCatAction);
  el('categoriesContent')?.querySelector('.cat-cards')?.addEventListener('click', handleCatAction);
}

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNewCategory() {
  const tx_type               = el('catNewType')?.value;
  const major_category        = el('catNewMajor')?.value.trim();
  const minor_category        = el('catNewMinor')?.value.trim();
  const description           = el('catNewDesc')?.value.trim();
  const tag_keywords          = el('catNewKeywords')?.value.trim();
  const counterparty_examples = el('catNewCounterparty')?.value.trim();
  const source_account_types  = _getCheckedAccountTypes('catNewSrc');
  const target_account_types  = _getCheckedAccountTypes('catNewTgt');
  const source_account_mandatory = el('catNewSrcMandatory')?.checked === true;
  const target_account_mandatory = el('catNewTgtMandatory')?.checked === true;
  const workflow_type            = el('catNewWorkflowType')?.value;
  const is_active                = true;
  const is_subscription_eligible = el('catNewIsSubEligible')?.checked === true;
  const errEl                    = el('catAddError');

  if (!major_category) { if (errEl) errEl.textContent = 'Major category is required.'; return; }
  if (!minor_category) { if (errEl) errEl.textContent = 'Minor category is required.'; return; }
  if (errEl) errEl.textContent = '';

  const btn = el('catSaveNew');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createCategory({
      tx_type, major_category, minor_category, description,
      is_active, is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory, workflow_type,
    });
    if (res.ok) {
      showMsg('Category added.');
      state.catAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveNewCategory failed:', res?.error);
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

  const tx_type               = el('catEditType')?.value;
  const major_category        = el('catEditMajor')?.value.trim();
  const minor_category        = el('catEditMinor')?.value.trim();
  const description           = el('catEditDesc')?.value.trim();
  const tag_keywords          = el('catEditKeywords')?.value.trim();
  const counterparty_examples = el('catEditCounterparty')?.value.trim();
  const source_account_types  = _getCheckedAccountTypes('catEditSrc');
  const target_account_types  = _getCheckedAccountTypes('catEditTgt');
  const source_account_mandatory = el('catEditSrcMandatory')?.checked === true;
  const target_account_mandatory = el('catEditTgtMandatory')?.checked === true;
  const workflow_type            = el('catEditWorkflowType')?.value;
  const is_active                = el('catEditIsActive')?.checked !== false;
  const is_subscription_eligible = el('catEditIsSubEligible')?.checked === true;
  const errEl                    = el('catEditError');

  if (!major_category || !minor_category) {
    if (errEl) errEl.textContent = 'Major and minor category are required.';
    return;
  }
  if (errEl) errEl.textContent = '';

  const btn = el('catSaveEdit');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num: rowNum, tx_type, major_category, minor_category, description,
      is_active, is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory, workflow_type,
    });
    if (res.ok) {
      showMsg('Category updated.');
      state.catEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveCatEdit failed:', res?.error);
      if (errEl) errEl.textContent = 'Update failed: ' + (res.error || 'unknown');
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
      showMsg('Category deleted.');
      state.catDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _deleteCat failed:', res?.error);
      showMsg('Delete failed: ' + (res.error || 'unknown'), 'warn');
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

