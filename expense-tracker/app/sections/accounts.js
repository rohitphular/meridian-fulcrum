import { state } from '../core/state.js';
import {
  el, esc, getSymbol, toBase, fmtBase, exportAccounts,
  openContextMenu, closeContextMenu, recordStatusIcon, syncStatusIcon,
} from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Module-level holding area for the current import session's parsed rows.
let _importParsed = null;
let _accMenuKey   = null;

// ── Schema accessors ──────────────────────────────────────────────────────────
// Schema is loaded at boot into state.accountSchema — no hardcoded constants here.
function _sch()              { return state.accountSchema || {}; }
function _accountTypes()     { return _sch().types || []; }
function _assetSubTypes()    { return _sch().asset_sub_types        || []; }
function _invSubTypes()      { return _sch().investment_sub_types   || []; }
function _liabSubTypes()     { return _sch().liability_sub_types    || []; }
function _loanSubSet()       { return new Set(_sch().loan_sub_types || []); }
function _validTypes()       { return new Set(_accountTypes().map(t => t.value)); }

function _isLiability(a)     { return a.type === 'liability'; }
function _isLoan(a)          { return a.type === 'liability' && _loanSubSet().has(a.sub_type); }

// Convert snake_case sub_type value to a readable label.
function _subTypeLabel(v) {
  if (!v) return '—';
  if (v === 'stocks_shares') return 'Stocks & Shares';
  if (v === 'p2p_lending')   return 'P2P Lending';
  if (v === 'pension_sipp')  return 'Pension / SIPP';
  if (v === 'fixed_deposit') return 'Fixed Deposit';
  if (v === 'isa')           return 'ISA';
  return v.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _fmtBal(n) {
  return Math.abs(parseFloat(n || 0)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _balanceCell(a) {
  const val     = parseFloat(a.current_value || 0);
  const sym     = getSymbol(a.currency);
  const foreign = a.currency !== state.quoteCurrency;
  const baseTag = foreign
    ? ` <span class="td-base-amt">/ ${esc(fmtBase(Math.abs(val), a.currency, null))}</span>`
    : '';

  if (_isLiability(a)) {
    return `<span class="acc-bal-owed">−${sym}${_fmtBal(Math.abs(val))}</span>${baseTag}`;
  }
  const cls = val < 0 ? 'negative acc-bal-mono' : 'acc-bal-mono';
  return `<span class="${cls}">${val < 0 ? '−' : ''}${sym}${_fmtBal(val)}</span>${baseTag}`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderAccounts() {
  _accMenuKey = null;
  const viewAcc    = state.accViewRow !== null ? state.accounts.find(a => a._row === state.accViewRow) : null;
  const editAcc    = state.accEditRow !== null ? state.accounts.find(a => a._row === state.accEditRow) : null;
  const anyAddOpen = state.accAddOpen || viewAcc !== null || editAcc !== null;

  el('accountsContent').innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="accImportBtn">${state.accImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="accExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="accAddBtn">${anyAddOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.accImportOpen ? _renderImportPanel()              : ''}
    ${state.accAddOpen    ? _renderAccountForm(null,    'add')  : ''}
    ${viewAcc             ? _renderAccountForm(viewAcc, 'view') : ''}
    ${editAcc             ? _renderAccountForm(editAcc, 'edit') : ''}
    ${_renderNetWorth()}
    ${_renderTable()}
  `;
  _attachEvents();
}

// ── Net worth summary ─────────────────────────────────────────────────────────

function _renderNetWorth() {
  if (!state.accounts.length) return '';
  const sym = getSymbol(state.quoteCurrency);
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const LIQUID_SUB_TYPES = new Set(['current', 'savings', 'cash']);

  const totalAssets = state.accounts
    .filter(a => a.record_status !== 'deleted' && (a.type === 'asset' || a.type === 'investment'))
    .reduce((s, a) => s + toBase(parseFloat(a.current_value || 0), a.currency, null), 0);

  const totalLiab = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'liability')
    .reduce((s, a) => s + Math.abs(toBase(parseFloat(a.current_value || 0), a.currency, null)), 0);

  const liquidCash = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'asset' && LIQUID_SUB_TYPES.has(a.sub_type))
    .reduce((s, a) => s + toBase(parseFloat(a.current_value || 0), a.currency, null), 0);

  const netWorth = totalAssets - totalLiab;

  return `
    <div class="summary-grid" style="margin-bottom:20px">
      <div class="summary-card">
        <div class="summary-card-label">Total Assets</div>
        <div class="summary-card-value positive">${fmt(totalAssets)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Total Liabilities</div>
        <div class="summary-card-value negative">${fmt(totalLiab)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Net Worth</div>
        <div class="summary-card-value ${netWorth >= 0 ? 'positive' : 'negative'}">${netWorth < 0 ? '−' : ''}${fmt(netWorth)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Liquid Cash</div>
        <div class="summary-card-value ${liquidCash >= 0 ? 'positive' : 'negative'}">${liquidCash < 0 ? '−' : ''}${fmt(liquidCash)}</div>
      </div>
    </div>`;
}

// ── Sub-type dropdown options ─────────────────────────────────────────────────

function _subTypeOptsHtml(type, selected) {
  const opts = type === 'asset'      ? _assetSubTypes()
             : type === 'investment' ? _invSubTypes()
             : type === 'liability'  ? _liabSubTypes()
             : [];
  return `<option value="">— select —</option>` +
    opts.map(v =>
      `<option value="${esc(v)}" ${selected === v ? 'selected' : ''}>${esc(_subTypeLabel(v))}</option>`
    ).join('');
}

// ── Type dropdown (3 flat options) ────────────────────────────────────────────

function _typeOptsHtml(selected) {
  return _accountTypes().map(t =>
    `<option value="${esc(t.value)}" ${selected === t.value ? 'selected' : ''}>${esc(t.label)}</option>`
  ).join('');
}

// ── CSV import panel ──────────────────────────────────────────────────────────

function _renderImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import accounts from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="accImportFile">CSV file</label>
        <input type="file" id="accImportFile" accept=".csv">
        <div class="field-hint">Required: name, type, sub_type, currency. Optional: opening_value, current_value, record_status, description</div>
      </div>
    </div>
    <div id="accImportStatus"></div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="accImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="accImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="accImportError"></div>
  </div>`;
}

function _parseCsvRow(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

function _parseAccountsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { accounts: [], errors: ['File is empty.'] };

  const headers  = _parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const accounts = [];
  const errors   = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = _parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });

    if (!row.name)     { errors.push(`Row ${i + 1}: missing name`);     continue; }
    if (!row.type)     { errors.push(`Row ${i + 1}: missing type`);     continue; }
    if (!row.sub_type) { errors.push(`Row ${i + 1}: missing sub_type`); continue; }
    if (!row.currency) { errors.push(`Row ${i + 1}: missing currency`); continue; }

    const openingVal = row.opening_value ? parseFloat(row.opening_value) : 0;
    const currentVal = row.current_value ? parseFloat(row.current_value) : undefined;

    accounts.push({
      name:          row.name,
      type:          row.type,
      sub_type:      row.sub_type,
      currency:      row.currency.toUpperCase(),
      opening_value: row.type === 'liability' ? -(Math.abs(openingVal)) : openingVal,
      current_value: currentVal !== undefined
        ? (row.type === 'liability' ? -(Math.abs(currentVal)) : currentVal)
        : undefined,
      record_status: ['active', 'inactive', 'deleted', 'locked'].includes(row.record_status) ? row.record_status : 'active',
      description:   row.description || '',
    });
  }

  return { accounts, errors };
}

function _renderImportStatus(parsed) {
  const { accounts, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (!accounts.length) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${accounts.length} account${accounts.length !== 1 ? 's' : ''} ready to import</p>`;
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _renderAccountForm(a, mode) {
  const isAdd  = mode === 'add';
  const isView = mode === 'view';
  const dis    = isView ? ' disabled' : '';
  const pfx    = isAdd  ? 'accNew' : 'accEdit';

  const type = isAdd ? '' : (a.type || '');

  const v = val => esc(String(val || ''));

  const currencyOpts = state.rates.map(r =>
    `<option value="${esc(r.currency)}" ${(!isAdd && a.currency === r.currency) ? 'selected' : ''}>${esc(r.currency)}</option>`
  ).join('');

  const header = (!isAdd) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} — <strong>${esc(a.name)}</strong>
    </div>` : '';

  const typeField = isAdd
    ? `<select id="accNewType"><option value="">— select —</option>${_typeOptsHtml('')}</select>`
    : `<input type="text" id="accEditType" value="${esc(type)}" disabled>`;

  const subTypeField = isAdd
    ? `<select id="accNewSubType"><option value="">— select —</option></select>`
    : `<input type="text" id="accEditSubType" value="${esc(_subTypeLabel(a.sub_type || ''))}" disabled>`;

  const sym = isAdd ? '' : getSymbol(a.currency);

  const recordStatusField = !isAdd ? `
      <div class="field">
        <label for="accEditRecordStatus">Record status</label>
        <select id="accEditRecordStatus"${dis}>
          <option value="active"   ${a.record_status === 'active'   ? 'selected' : ''}>Active</option>
          <option value="inactive" ${a.record_status === 'inactive' ? 'selected' : ''}>Inactive</option>
          <option value="locked"   ${a.record_status === 'locked'   ? 'selected' : ''}>Locked</option>
          <option value="deleted"  ${a.record_status === 'deleted'  ? 'selected' : ''}>Deleted</option>
        </select>
      </div>` : '';

  const syncStatusLine = isView ? `
    <div class="field-hint" style="margin-top:8px">
      Sync: ${syncStatusIcon(a.sync_status)} ${esc(a.sync_notes || '')}
    </div>` : '';

  return `
  <div class="card" style="margin-bottom:20px">
    ${header}

    <div class="form-grid" style="margin-bottom:16px">
      <div class="field">
        <label for="${pfx}Name">Name *</label>
        <input type="text" id="${pfx}Name"
               value="${isAdd ? '' : v(a.name)}"
               ${isAdd ? 'placeholder="e.g. Barclays Current"' : ''}${dis}>
      </div>
      <div class="field">
        <label for="${pfx}Currency">Currency${isAdd ? ' *' : ''}</label>
        ${isAdd
          ? `<select id="accNewCurrency">${currencyOpts}</select>`
          : `<input type="text" id="accEditCurrency" value="${v(a.currency)}" disabled>`}
      </div>
      <div class="field">
        <label for="${pfx}Type">Type${isAdd ? ' *' : ''}</label>
        ${typeField}
      </div>
      <div class="field">
        <label for="${pfx}SubType">Sub-type${isAdd ? ' *' : ''}</label>
        ${subTypeField}
      </div>
      ${recordStatusField}
    </div>

    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      ${isAdd ? `
      <div class="field">
        <label for="accNewOpeningValue">Opening value</label>
        <input type="number" id="accNewOpeningValue" step="0.01" placeholder="0.00">
      </div>` : `
      <div class="field">
        <label>Opening value</label>
        <input type="text" value="${_isLiability(a) ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.opening_value || 0)))) : v(sym + _fmtBal(parseFloat(a.opening_value || 0)))}" disabled>
      </div>
      <div class="field">
        <label>Current value</label>
        <input type="text" value="${_isLiability(a)
          ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.current_value || 0))))
          : v(sym + _fmtBal(parseFloat(a.current_value || 0)))}" disabled>
      </div>`}
      <div class="field">
        <label for="${pfx}Description">Notes</label>
        <input type="text" id="${pfx}Description"
               value="${isAdd ? '' : v(a.description || '')}"
               ${isAdd ? 'placeholder="Optional notes"' : ''}${dis}>
      </div>
    </div>

    ${syncStatusLine}

    <div class="form-actions" style="margin-top:${isAdd ? '20' : '16'}px">
      ${isView
        ? `<button class="btn btn-secondary" id="accCancelView">Close</button>
           ${a.record_status === 'deleted' ? `<button class="btn btn-primary" id="accViewRestore" data-row="${a._row}">Restore</button>` : ''}
           ${a.record_status !== 'locked' && a.record_status !== 'deleted' ? `<button class="btn btn-primary" id="accViewToEdit" data-row="${a._row}">Edit</button>` : ''}`
        : `<button class="btn btn-primary" id="${isAdd ? 'accSaveNew' : 'accSaveEdit'}">Save</button>
           <button class="btn btn-secondary" id="${isAdd ? 'accCancelNew' : 'accCancelEdit'}">Cancel</button>`}
    </div>
    ${!isView ? `<div class="pin-error" id="${isAdd ? 'accAddError' : 'accEditError'}"></div>` : ''}
  </div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function _renderAccountRow(a) {
  const rowStyle = a.record_status === 'deleted'  ? ' style="opacity:0.5"'
                 : a.record_status === 'inactive' ? ' style="opacity:0.5"'
                 : a.record_status === 'locked'   ? ' style="opacity:0.7"'
                 : '';

  if (state.accDeleteRow === a._row) {
    if (state.accDeleteBlocked) {
      const n    = state.accDeleteBlocked.referenced_count || 0;
      const noun = n === 1 ? 'transaction refers' : 'transactions refer';
      return `<tr${rowStyle}>
        <td colspan="5">
          <span class="confirm-text">Cannot delete <strong>${esc(a.name)}</strong> — <strong>${n}</strong> ${noun} to this account.</span>
          <div style="color:var(--muted);font-size:var(--text-sm);margin-top:4px">
            Delete or reassign those transactions first, or deactivate the account instead.
          </div>
        </td>
        <td><div class="row-actions">
          <button class="btn-link" data-action="acc-deactivate" data-row="${a._row}">Deactivate instead</button>
          <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
        </div></td>
      </tr>`;
    }
    return `<tr${rowStyle}>
      <td colspan="5"><span class="confirm-text">Delete <strong>${esc(a.name)}</strong>? This marks the account as deleted.</span></td>
      <td><div class="row-actions">
        <button class="btn-link danger" data-action="acc-confirm-delete" data-row="${a._row}">Yes, delete</button>
        <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
      </div></td>
    </tr>`;
  }

  return `<tr${rowStyle}>
    <td class="td-mono" style="color:var(--muted);font-size:11px">${esc(a.id)}</td>
    <td>${esc(a.name)}${a.description ? `<span class="info-icon-wrap"><span style="cursor:help;color:var(--teal);font-size:13px">ⓘ</span><span class="info-tooltip">${esc(a.description)}</span></span>` : ''}</td>
    <td style="color:var(--muted);font-size:12px">${esc(_subTypeLabel(a.sub_type || ''))}</td>
    <td>${esc(a.currency)}</td>
    <td>${_balanceCell(a)}</td>
    <td><div style="display:flex;align-items:center;justify-content:flex-end;gap:5px">
      ${recordStatusIcon(a.record_status)}${syncStatusIcon(a.sync_status)}
      <button class="tx-menu-trigger" data-action="acc-menu" data-row="${a._row}" title="Actions">⋮</button>
    </div></td>
  </tr>`;
}

function _groupHeader(label, total, sym, isLiab) {
  const sign = isLiab ? '−' : '';
  return `<tr class="acc-group-header">
    <td colspan="6" style="background:var(--canvas);padding:10px 12px 4px;font-size:11px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:none">
      ${label}
      <span style="float:right;font-weight:600;color:${isLiab ? 'var(--ember)' : 'var(--teal)'}">${sign}${sym}${Math.abs(total).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
    </td>
  </tr>`;
}

const TABLE_GROUPS = [
  { key: 'asset',      label: 'Assets',      isLiab: false },
  { key: 'investment', label: 'Investments', isLiab: false },
  { key: 'liability',  label: 'Liabilities', isLiab: true  },
];

function _renderTable() {
  if (!state.accounts.length) {
    return `<p class="placeholder">No accounts yet. Use &ldquo;+ Add&rdquo; to create one.</p>`;
  }

  const sym    = getSymbol(state.quoteCurrency);
  const byGroup = {};
  state.accounts.forEach(a => {
    (byGroup[a.type] = byGroup[a.type] || []).push(a);
  });

  const bodyRows = TABLE_GROUPS.flatMap(g => {
    const accs = byGroup[g.key];
    if (!accs || !accs.length) return [];
    const total = g.isLiab
      ? accs.reduce((s, a) => s + Math.abs(toBase(parseFloat(a.current_value || 0), a.currency, null)), 0)
      : accs.reduce((s, a) => s + toBase(parseFloat(a.current_value || 0), a.currency, null), 0);
    return [_groupHeader(g.label, total, sym, g.isLiab), ...accs.map(_renderAccountRow)];
  }).join('');

  const hasActiveAccRow = state.accDeleteRow !== null;

  const cardSections = TABLE_GROUPS.flatMap(g => {
    const accs = byGroup[g.key];
    if (!accs || !accs.length) return [];
    return [
      `<div class="acc-card-group">${g.label}</div>`,
      ...accs.map(a => {
        if (state.accDeleteRow === a._row) return '';
        const cardStyle = a.record_status === 'deleted'  ? ' style="opacity:0.5"'
                        : a.record_status === 'inactive' ? ' style="opacity:0.5"'
                        : a.record_status === 'locked'   ? ' style="opacity:0.7"'
                        : '';
        return `<div class="acc-card"${cardStyle}>
          <div class="acc-card-body">
            <div class="acc-card-name">${esc(a.name)}</div>
            <div class="acc-card-meta">${esc(_subTypeLabel(a.sub_type))} · ${esc(a.currency)}</div>
          </div>
          <div class="acc-card-bal">${_balanceCell(a)}</div>
          <div style="display:flex;align-items:center;gap:6px">
            ${recordStatusIcon(a.record_status)} ${syncStatusIcon(a.sync_status)}
            <button class="tx-menu-trigger acc-card-menu" data-action="acc-menu" data-row="${a._row}" title="Actions">⋮</button>
          </div>
        </div>`;
      })
    ];
  }).join('');

  return `
    <div class="table-wrap acc-table-wrap${hasActiveAccRow ? ' acc-has-active' : ''}">
      <table class="acc-table">
        <thead><tr>
          <th style="width:90px">ID</th>
          <th style="width:160px">Name</th>
          <th style="width:160px">Sub-type</th>
          <th style="width:70px">CCY</th>
          <th style="width:160px">Balance</th>
          <th style="width:64px"></th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="acc-cards">${cardSections}</div>`;
}

// ── Type-change handler: repopulate sub_type dropdown (Add form) ──────────────

function _refreshAddTypeUI() {
  const typeEl = el('accNewType');
  const type   = typeEl ? typeEl.value : '';
  const subSel = el('accNewSubType');
  if (subSel) subSel.innerHTML = _subTypeOptsHtml(type, '');
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachEvents() {
  el('accImportBtn').addEventListener('click', () => {
    if (state.accImportOpen) {
      state.accImportOpen = false;
      _importParsed = null;
    } else {
      state.accImportOpen = true;
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    }
    renderAccounts();
  });

  el('accAddBtn').addEventListener('click', () => {
    if (state.accAddOpen || state.accViewRow !== null || state.accEditRow !== null) {
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    } else {
      state.accAddOpen = true;
      state.accImportOpen = false;
      _importParsed = null;
    }
    renderAccounts();
  });

  if (state.accImportOpen) {
    el('accImportFile').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const parsed = _parseAccountsCsv(ev.target.result);
        _importParsed = parsed.accounts.length ? parsed.accounts : null;
        el('accImportStatus').innerHTML = _renderImportStatus(parsed);
        el('accImportConfirm').disabled = !_importParsed;
      };
      reader.readAsText(file);
    });

    el('accImportConfirm').addEventListener('click', () => {
      if (_importParsed) _submitImport(_importParsed);
    });

    el('accImportCancel').addEventListener('click', () => {
      state.accImportOpen = false;
      _importParsed = null;
      renderAccounts();
    });
  }

  if (state.accAddOpen) {
    el('accSaveNew').addEventListener('click', _saveNew);
    el('accCancelNew').addEventListener('click', () => { state.accAddOpen = false; renderAccounts(); });
    el('accNewType').addEventListener('change', _refreshAddTypeUI);
    _refreshAddTypeUI();
  }

  if (state.accEditRow !== null) {
    el('accSaveEdit').addEventListener('click', _saveEdit);
    el('accCancelEdit').addEventListener('click', () => { state.accEditRow = null; renderAccounts(); });
  }

  if (state.accViewRow !== null) {
    el('accCancelView').addEventListener('click', () => { state.accViewRow = null; renderAccounts(); });
    const viewToEditEl = el('accViewToEdit');
    if (viewToEditEl) viewToEditEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.accViewRow = null;
      state.accEditRow = row;
      renderAccounts();
    });
    const viewRestoreEl = el('accViewRestore');
    if (viewRestoreEl) viewRestoreEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.accViewRow = null;
      _restoreAccount(row);
    });
  }

  const handleAccAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;
    if (action === 'acc-menu') {
      if (_accMenuKey === row) { closeContextMenu(); _accMenuKey = null; return; }
      _accMenuKey = row;
      const menuAcc   = state.accounts.find(a => a._row === row);
      const isLocked  = menuAcc && menuAcc.record_status === 'locked';
      const isDeleted = menuAcc && menuAcc.record_status === 'deleted';
      const menuItems = [
        { key: 'acc-view', label: 'View', cls: '' },
        ...(!isLocked && !isDeleted ? [{ key: 'acc-edit',    label: 'Edit',    cls: ''       }] : []),
        { key: 'acc-txs', label: 'Transactions', cls: '' },
        ...(isDeleted               ? [{ key: 'acc-restore', label: 'Restore', cls: ''       }] : []),
        ...(!isLocked && !isDeleted ? [{ key: 'acc-delete',  label: 'Delete',  cls: 'danger' }] : []),
      ];
      openContextMenu(btn, menuItems, key => {
        _accMenuKey = null;
        if (key === 'acc-view')    { state.accViewRow = row; state.accEditRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); }
        if (key === 'acc-edit')    { state.accEditRow = row; state.accViewRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); }
        if (key === 'acc-delete')  { state.accDeleteRow = row; state.accViewRow = null; state.accEditRow = null; state.accDeleteBlocked = null; renderAccounts(); }
        if (key === 'acc-restore') { _restoreAccount(row); }
        if (key === 'acc-txs') {
          const acc = state.accounts.find(a => a._row === row);
          if (acc) {
            state.filters = { types: [], accounts: [acc.id], major: [], minor: [], tx_location_country: '', tag: '', search: '' };
            document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
          }
        }
      });
      return;
    }
    if (action === 'acc-view')   { state.accViewRow = row; state.accEditRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); return; }
    if (action === 'acc-edit') {
      const editAcc = state.accounts.find(a => a._row === row);
      if (editAcc && (editAcc.record_status === 'locked' || editAcc.record_status === 'deleted')) return;
      state.accEditRow = row; state.accViewRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); return;
    }
    if (action === 'acc-delete') {
      const delAcc = state.accounts.find(a => a._row === row);
      if (delAcc && (delAcc.record_status === 'locked' || delAcc.record_status === 'deleted')) return;
      state.accDeleteRow = row; state.accViewRow = null; state.accEditRow = null; state.accDeleteBlocked = null; renderAccounts();
    }
    if (action === 'acc-cancel-delete')  { state.accDeleteRow = null; state.accDeleteBlocked = null; renderAccounts(); }
    if (action === 'acc-confirm-delete') { _confirmDelete(row); }
    if (action === 'acc-deactivate')     { _deactivateAccount(row); }
  };

  const tableWrap = el('accountsContent').querySelector('.acc-table-wrap');
  if (tableWrap) tableWrap.addEventListener('click', handleAccAction);
  const cards = el('accountsContent').querySelector('.acc-cards');
  if (cards) cards.addEventListener('click', handleAccAction);

  el('accExportBtn').addEventListener('click', () => {
    if (!state.accounts.length) { showMsg('No accounts to export.', 'warn'); return; }
    openContextMenu(el('accExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => exportAccounts(key, state.accounts));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _v(id)  { return el(id).value; }
function _n(id)  { const v = _v(id); return v === '' ? undefined : parseFloat(v); }

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNew() {
  const name        = _v('accNewName').trim();
  const currency    = _v('accNewCurrency');
  const type        = _v('accNewType');
  const sub_type    = _v('accNewSubType');
  const description = _v('accNewDescription').trim();
  const errEl       = el('accAddError');

  if (!name)                              { errEl.textContent = 'Name is required.';     return; }
  if (!type || !_validTypes().has(type))  { errEl.textContent = 'Type is required.';     return; }
  if (!sub_type)                          { errEl.textContent = 'Sub-type is required.'; return; }
  if (!currency || !(currency in state.rateMap)) { errEl.textContent = 'Currency is required.'; return; }
  errEl.textContent = '';

  const openingVal = parseFloat(_v('accNewOpeningValue')) || 0;

  const payload = {
    name,
    currency,
    type,
    sub_type,
    description,
    opening_value: type === 'liability' ? -(Math.abs(openingVal)) : openingVal,
  };

  const btn = el('accSaveNew');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createAccount(payload);
    if (res.ok) {
      showMsg('Account added.');
      state.accAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _saveNew failed:', res.error);
      const msg = res.error === 'duplicate_account'
        ? 'An account with this name already exists.'
        : 'Error: ' + (res.error || 'unknown');
      errEl.textContent = msg;
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveNew failed:', _);
    errEl.textContent = 'Connection error.';
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveEdit() {
  const rowNum = state.accEditRow;
  if (!rowNum) return;

  const name  = el('accEditName').value.trim();
  const errEl = el('accEditError');
  if (!name) { errEl.textContent = 'Name is required.'; return; }

  errEl.textContent = '';

  const acc = state.accounts.find(a => a._row === rowNum);
  const payload = {
    row_num:       rowNum,
    name,
    record_status: el('accEditRecordStatus').value,
    description:   el('accEditDescription').value.trim() || '',
  };

  const btn = el('accSaveEdit');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount(payload);
    if (res.ok) {
      showMsg('Account updated.');
      state.accEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _saveEdit failed:', res.error);
      errEl.textContent = res.error === 'record_locked'
        ? 'This account is locked and cannot be edited.'
        : res.error === 'duplicate_account'
          ? 'An account with this name already exists.'
          : 'Update failed: ' + (res.error || 'unknown');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveEdit failed:', _);
    errEl.textContent = 'Connection error.';
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _confirmDelete(rowNum) {
  showLoading();
  try {
    const res = await ExpenseAPI.deleteAccount({ row_num: rowNum });
    if (res.ok) {
      showMsg('Account marked as deleted.');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else if (res.error === 'record_locked') {
      showMsg('This account is locked and cannot be deleted.', 'warn');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      renderAccounts();
    } else if (res.error === 'account_in_use') {
      // Backend refused because transactions reference this account.
      // Keep the row in delete-confirm state, switch to the blocked variant
      // which offers a "Deactivate instead" CTA.
      state.accDeleteBlocked = { referenced_count: res.referenced_count || 0 };
      renderAccounts();
    } else {
      console.warn('[accounts] _confirmDelete failed:', res.error);
      showMsg('Delete failed: ' + (res.error || 'unknown'), 'warn');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _confirmDelete failed:', _);
    showMsg('Connection error.', 'warn');
    state.accDeleteRow = null;
    state.accDeleteBlocked = null;
    renderAccounts();
  } finally {
    hideLoading();
  }
}

// Deactivate (record_status = inactive) — invoked from the blocked-deletion CTA.
async function _deactivateAccount(rowNum) {
  const acc = state.accounts.find(a => a._row === rowNum);
  if (!acc) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount({
      row_num:       rowNum,
      name:          acc.name || '',
      record_status: 'inactive',
      description:   acc.description || '',
    });
    if (res.ok) {
      showMsg('Account deactivated.');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _deactivateAccount failed:', res.error);
      showMsg('Deactivate failed: ' + (res.error || 'unknown'), 'warn');
      state.accDeleteBlocked = null;
      state.accDeleteRow = null;
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _deactivateAccount failed:', _);
    showMsg('Connection error.', 'warn');
    state.accDeleteBlocked = null;
    state.accDeleteRow = null;
    renderAccounts();
  } finally {
    hideLoading();
  }
}

async function _restoreAccount(rowNum) {
  const acc = state.accounts.find(a => a._row === rowNum);
  if (!acc) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount({
      row_num:       rowNum,
      name:          acc.name || '',
      record_status: 'active',
      description:   acc.description || '',
    });
    if (res.ok) {
      showMsg('Account restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _restoreAccount failed:', res.error);
      const msg = res.error === 'duplicate_account'
        ? 'Cannot restore: an account with this name already exists.'
        : 'Restore failed: ' + (res.error || 'unknown');
      showMsg(msg, 'warn');
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _restoreAccount failed:', _);
    showMsg('Connection error.', 'warn');
    renderAccounts();
  } finally {
    hideLoading();
  }
}

async function _submitImport(accounts) {
  if (!accounts || !accounts.length) {
    showMsg('No accounts to import.', 'warn');
    return;
  }
  const btn   = el('accImportConfirm');
  const errEl = el('accImportError');
  if (btn)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createAccountsBulk({ accounts });

    if (!res.ok && !res.results) {
      console.warn('[accounts] _submitImport failed:', res.error);
      if (errEl) errEl.textContent = 'Error: ' + (res.error || 'unknown');
      if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }

    const created = res.created || 0;
    const skipped = res.skipped || 0;
    const failed  = res.failed  || 0;

    if (failed === 0) {
      _importParsed = null;
      state.accImportOpen = false;
      const msg = [
        created ? `${created} account${created !== 1 ? 's' : ''} imported` : '',
        skipped ? `${skipped} already existed` : '',
      ].filter(Boolean).join(' · ');
      showMsg(msg || 'Nothing to import.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      const resultRows = (res.results || []).map(r => `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${r.ok
            ? `<span class="badge badge-et-in">created</span>`
            : r.error === 'duplicate_account'
              ? `<span class="badge" style="color:var(--muted)">already exists</span>`
              : `<span class="badge badge-et-out">${esc(r.error || 'unknown')}</span>`}
          </td>
        </tr>`).join('');
      el('accImportStatus').innerHTML = `
        <div style="margin-bottom:8px;font-size:13px">${created} created${skipped ? ` · ${skipped} already existed` : ''} · <span style="color:var(--ember)">${failed} failed</span></div>
        <div class="table-wrap" style="margin-bottom:8px">
          <table class="acc-table">
            <thead><tr><th>Name</th><th>Result</th></tr></thead>
            <tbody>${resultRows}</tbody>
          </table>
        </div>`;
      _importParsed = null;
      if (btn) { btn.disabled = true; btn.textContent = 'Import'; }
      if (created > 0) { document.dispatchEvent(new CustomEvent('et:reload')); }
      showMsg(`${created} imported · ${skipped} skipped · ${failed} failed`, 'warn');
    }
  } catch (_) {
    console.error('[accounts] _submitImport failed:', _);
    if (errEl) errEl.textContent = 'Connection error.';
    if (btn)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}
