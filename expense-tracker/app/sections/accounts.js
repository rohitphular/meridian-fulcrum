import { state } from '../core/state.js';
import {
  el, esc, getSymbol, toBase, fmtBase, exportAccounts,
  openContextMenu, closeContextMenu, recordStatusIcon, syncStatusIcon, parseCsvRow,
} from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Module-level holding area for the current import session's parsed rows.
let _importParsed  = null;
let _accMenuKey    = null;
let _accDraft      = null;   // pending filter selections; copied to state.accFilters on Search
let _accDDCleanup  = null;   // cleanup fn for the currently open filter dropdown's outside-click listener

// ── Schema accessors ──────────────────────────────────────────────────────────
// Schema is loaded at boot into state.accountSchema — no hardcoded constants here.
// All accessors assume schema is present; renderAccounts guards against absent schema.
function _accountTypes()     { return state.accountSchema.types; }
function _assetSubTypes()    { return state.accountSchema.asset_sub_types; }
function _invSubTypes()      { return state.accountSchema.investment_sub_types; }
function _liabSubTypes()     { return state.accountSchema.liability_sub_types; }
function _loanSubSet()       { return new Set(state.accountSchema.loan_sub_types); }
function _validTypes()       { return new Set(_accountTypes().map(t => t.value)); }

function _subTypesForType(type) {
  if (type === 'asset')      return _assetSubTypes();
  if (type === 'investment') return _invSubTypes();
  if (type === 'liability')  return _liabSubTypes();
  return [];
}

function _isLiability(a)     { return a.type === 'liability'; }
function _isLoan(a)          { return a.type === 'liability' && _loanSubSet().has(a.sub_type); }

// All record statuses — includes 'deleted' so the filter bar can show deleted accounts.
const ALL_RECORD_STATUSES = ['active', 'inactive', 'deleted', 'locked'];

// Convert snake_case sub_type value to a readable label.
function _subTypeLabel(v) {
  if (v === undefined || v === null || v === '') return '—';
  if (v === 'stocks_shares') return 'Stocks & Shares';
  if (v === 'p2p_lending')   return 'P2P Lending';
  if (v === 'pension_sipp')  return 'Pension / SIPP';
  if (v === 'fixed_deposit') return 'Fixed Deposit';
  if (v === 'isa')           return 'ISA';
  return v.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _fmtBal(n) {
  const v = Math.abs(parseFloat(n));
  if (Number.isFinite(v) === false) return '—';
  return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _balanceCell(a) {
  const val = parseFloat(a.current_value);
  if (Number.isFinite(val) === false) return '<span class="muted">—</span>';
  const sym     = getSymbol(a.currency);
  const foreign = a.currency !== state.quoteCurrency;
  const baseTag = foreign
    ? ` <span class="td-base-amt">${esc(fmtBase(Math.abs(val), a.currency, null))}</span>`
    : '';

  if (_isLiability(a)) {
    return `<span class="acc-bal-owed">−${sym}${_fmtBal(Math.abs(val))}</span>${baseTag}`;
  }
  const cls = val < 0 ? 'negative acc-bal-mono' : 'acc-bal-mono';
  return `<span class="${cls}">${val < 0 ? '−' : ''}${sym}${_fmtBal(val)}</span>${baseTag}`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderAccounts() {
  if (state.accountSchema === undefined || state.accountSchema === null) {
    el('accountsContent').innerHTML = '<p class="placeholder">Account schema not loaded. Please refresh.</p>';
    return;
  }
  if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
  _accMenuKey = null;
  const viewAcc    = state.accViewRow !== null ? state.accounts.find(a => a._row === state.accViewRow) : null;
  const editAcc    = state.accEditRow !== null ? state.accounts.find(a => a._row === state.accEditRow) : null;
  const anyAddOpen = state.accAddOpen || viewAcc !== null || editAcc !== null;
  const filtered   = _applyAccFilters(state.accounts);

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
    ${_renderAccFilterBar()}
    ${_renderNetWorth()}
    ${_renderTable(filtered)}
  `;
  _attachEvents();
}

// ── Net worth summary ─────────────────────────────────────────────────────────

function _renderNetWorth() {
  if (state.accounts.length === 0) return '';
  const sym = getSymbol(state.quoteCurrency);
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const LIQUID_SUB_TYPES = new Set(['current', 'savings', 'cash']);

  const totalAssets = state.accounts
    .filter(a => a.record_status !== 'deleted' && (a.type === 'asset' || a.type === 'investment'))
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value), a.currency, null); return Number.isFinite(v) ? s + v : s; }, 0);

  const totalLiab = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'liability')
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value), a.currency, null); return Number.isFinite(v) ? s + Math.abs(v) : s; }, 0);

  const liquidCash = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'asset' && LIQUID_SUB_TYPES.has(a.sub_type))
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value), a.currency, null); return Number.isFinite(v) ? s + v : s; }, 0);

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

// ── Filter helpers ────────────────────────────────────────────────────────────

function _accFilterCount() {
  const f = state.accFilters;
  let n = 0;
  if (f.type !== 'all') n++;
  if (f.subType !== 'all') n++;
  if (f.currency !== 'all') n++;
  if (f.search !== '') n++;
  if (f.recordStatuses.length < ALL_RECORD_STATUSES.length) n++;
  return n;
}

function _applyAccFilters(accounts) {
  const f = state.accFilters;
  return accounts.filter(a => {
    if (f.type !== 'all' && a.type !== f.type) return false;
    if (f.subType !== 'all' && a.sub_type !== f.subType) return false;
    if (f.currency !== 'all' && a.currency !== f.currency) return false;
    if (f.search !== '') {
      const q   = f.search.toLowerCase();
      const hay = (a.name + ' ' + a.description).toLowerCase();
      if (hay.includes(q) === false) return false;
    }
    if (f.recordStatuses.length < ALL_RECORD_STATUSES.length && f.recordStatuses.includes(a.record_status) === false) return false;
    return true;
  });
}

function _renderAccFilterBar() {
  const activeCount = _accFilterCount();
  const f           = _accDraft !== null ? _accDraft : state.accFilters;

  const currencies = [];
  const seenC = {};
  state.accounts.forEach(a => {
    if (seenC[a.currency] === undefined) { seenC[a.currency] = true; currencies.push(a.currency); }
  });
  currencies.sort();

  const subTypes = _subTypesForType(f.type);

  const rs = new Set(f.recordStatuses);

  const typeLabel    = f.type === 'all' ? 'All types' : f.type.charAt(0).toUpperCase() + f.type.slice(1);
  const subTypeLabel = f.type === 'all' ? '— select type first —' : (f.subType === 'all' ? 'All sub-types' : _subTypeLabel(f.subType));
  const currLabel    = f.currency === 'all' ? 'All' : f.currency;
  const statusLabel  = rs.size === ALL_RECORD_STATUSES.length ? 'All' : rs.size === 0 ? 'None'
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
    <button class="filter-toggle" id="accFilterToggle">
      Filters${activeCount ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.accFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.accFilterOpen ? '' : 'hidden'}" id="accFilterBody">
      <div class="filter-row">
        <label>Type</label>
        ${dd('accFTypeTrigger','accFTypeLabel','accFTypeMenu', typeLabel,
          radioRows('accFTypeR', [['all','All types'],['asset','Asset'],['investment','Investment'],['liability','Liability']], f.type))}
      </div>
      <div class="filter-row">
        <label>Sub-type</label>
        ${dd('accFSubTrigger','accFSubLabel','accFSubMenu', subTypeLabel,
          f.type === 'all' ? '' : radioRows('accFSubR', [['all','All sub-types'], ...subTypes.map(s => [s, _subTypeLabel(s)])], f.subType),
          f.type === 'all')}
      </div>
      <div class="filter-row">
        <label>Currency</label>
        ${dd('accFCurrTrigger','accFCurrLabel','accFCurrMenu', currLabel,
          radioRows('accFCurrR', [['all','All'], ...currencies.map(c => [c, c])], f.currency))}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="accFSearch" placeholder="name, notes…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-row">
        <label>Status</label>
        ${dd('accFStatusTrigger','accFStatusLabel','accFStatusMenu', statusLabel,
          ALL_RECORD_STATUSES.map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-acc-filter-rstat="${s}"${rs.has(s) ? ' checked' : ''}> ${s.charAt(0).toUpperCase() + s.slice(1)}</label>`
          ).join(''))}
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="accFClear">Clear</button>
        <button class="btn btn-primary btn-sm" id="accFSearchBtn">Search</button>
      </div>
    </div>
  </div>`;
}

// ── Sub-type dropdown options ─────────────────────────────────────────────────

function _subTypeOptsHtml(type, selected) {
  const opts = _subTypesForType(type);
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
        <div class="field-hint">Required: name, type, sub_type, currency. Optional: opening_value (defaults to 0), record_status, description</div>
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

function _parseAccountsCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { accounts: [], errors: ['File is empty.'] };

  const headers  = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const accounts = [];
  const errors   = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvRow(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] !== undefined && vals[idx] !== null ? String(vals[idx]).trim() : ''); });

    if (row.name === '')     { errors.push(`Row ${i + 1}: missing name`);     continue; }
    if (row.type === '')     { errors.push(`Row ${i + 1}: missing type`);     continue; }
    if (row.sub_type === '') { errors.push(`Row ${i + 1}: missing sub_type`); continue; }
    if (row.currency === '') { errors.push(`Row ${i + 1}: missing currency`); continue; }

    const openingVal = row.opening_value === '' ? 0 : parseFloat(row.opening_value);
    if (Number.isFinite(openingVal) === false) {
      errors.push(`Row ${i + 1}: invalid opening_value "${row.opening_value}"`); continue;
    }

    const rsRaw = (row.record_status !== undefined && row.record_status !== null ? String(row.record_status).trim() : '');
    if (rsRaw !== '' && ['active', 'inactive', 'deleted', 'locked'].indexOf(rsRaw) === -1) {
      errors.push(`Row ${i + 1}: invalid record_status "${rsRaw}"`); continue;
    }
    const resolvedStatus = rsRaw !== '' ? rsRaw : 'active';

    const descRaw = (row.description !== undefined && row.description !== null ? String(row.description).trim() : '');

    accounts.push({
      name:          row.name,
      type:          row.type,
      sub_type:      row.sub_type,
      currency:      row.currency.toUpperCase(),
      opening_value: openingVal,
      record_status: resolvedStatus,
      description:   descRaw,
    });
  }

  return { accounts, errors };
}

function _renderImportStatus(parsed) {
  const { accounts, errors } = parsed;
  const errHtml = errors.length
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (accounts.length === 0) return errHtml + '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${accounts.length} account${accounts.length !== 1 ? 's' : ''} ready to import</p>`;
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _renderAccountForm(a, mode) {
  const isAdd  = mode === 'add';
  const isView = mode === 'view';
  const dis    = isView ? ' disabled' : '';
  const pfx    = isAdd  ? 'accNew' : 'accEdit';

  const type = isAdd ? '' : a.type;

  const v = val => esc(String(val));

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
    : isView
      ? `<input type="text" id="accEditSubType" value="${esc(_subTypeLabel(a.sub_type))}" disabled>`
      : `<select id="accEditSubType">${_subTypeOptsHtml(a.type, a.sub_type)}</select>`;

  const sym = isAdd ? '' : getSymbol(a.currency);

  // 'deleted' is excluded from the edit form — deletion goes through delete_account, not update_account.
  const EDIT_RECORD_STATUSES = ['active', 'inactive', 'locked'];
  const recordStatusField = !isAdd ? `
      <div class="field">
        <label for="accEditRecordStatus">Record status</label>
        <select id="accEditRecordStatus"${dis}>
          ${EDIT_RECORD_STATUSES.map(s =>
            `<option value="${esc(s)}"${a.record_status === s ? ' selected' : ''}>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</option>`
          ).join('')}
        </select>
      </div>` : '';

  const syncStatusLine = isView ? `
    <div class="field-hint" style="margin-top:8px">
      Sync: ${syncStatusIcon(a.sync_status)} ${esc((a.sync_notes !== undefined && a.sync_notes !== null) ? a.sync_notes : '')}
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
        <label for="accNewOpeningValue">Opening value *</label>
        <input type="number" id="accNewOpeningValue" step="0.01" placeholder="e.g. 1000.00">
      </div>` : `
      <div class="field">
        <label>Opening value</label>
        <input type="text" value="${_isLiability(a) ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.opening_value)))) : v(sym + _fmtBal(parseFloat(a.opening_value)))}" disabled>
      </div>
      <div class="field">
        <label>Current value</label>
        <input type="text" value="${_isLiability(a)
          ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.current_value))))
          : v(sym + _fmtBal(parseFloat(a.current_value)))}" disabled>
      </div>`}
      <div class="field">
        <label for="${pfx}Description">Notes</label>
        <input type="text" id="${pfx}Description"
               value="${isAdd ? '' : v(a.description)}"
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
  const rowStyle = (a.record_status === 'deleted' || a.record_status === 'inactive') ? ' style="opacity:0.5"'
                 : a.record_status === 'locked' ? ' style="opacity:0.7"'
                 : '';

  if (state.accDeleteRow === a._row) {
    if (state.accDeleteBlocked) {
      const n    = state.accDeleteBlocked.referenced_count;
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
    <td>${esc(a.name)}${(a.description !== undefined && a.description !== null && a.description !== '') ? `<span class="info-icon-wrap"><span style="cursor:help;color:var(--teal);font-size:13px">ⓘ</span><span class="info-tooltip">${esc(a.description)}</span></span>` : ''}</td>
    <td style="color:var(--muted);font-size:12px">${esc(_subTypeLabel(a.sub_type))}</td>
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

function _renderTable(accounts) {
  if (accounts.length === 0) {
    if (state.accounts.length === 0) return `<p class="placeholder">No accounts yet. Use &ldquo;+ Add&rdquo; to create one.</p>`;
    return `<p class="placeholder">No accounts match the current filters.</p>`;
  }

  const sym    = getSymbol(state.quoteCurrency);
  const byGroup = {};
  accounts.forEach(a => {
    if (byGroup[a.type] === undefined) byGroup[a.type] = [];
    byGroup[a.type].push(a);
  });

  const bodyRows = TABLE_GROUPS.flatMap(g => {
    const accs = byGroup[g.key];
    if (accs === undefined || accs === null || accs.length === 0) return [];
    const countable = accs.filter(a => a.record_status !== 'deleted');
    const total = g.isLiab
      ? countable.reduce((s, a) => { const v = toBase(parseFloat(a.current_value), a.currency, null); return Number.isFinite(v) ? s + Math.abs(v) : s; }, 0)
      : countable.reduce((s, a) => { const v = toBase(parseFloat(a.current_value), a.currency, null); return Number.isFinite(v) ? s + v : s; }, 0);
    return [_groupHeader(g.label, total, sym, g.isLiab), ...accs.map(_renderAccountRow)];
  }).join('');

  const hasActiveAccRow = state.accDeleteRow !== null;

  const cardSections = TABLE_GROUPS.flatMap(g => {
    const accs = byGroup[g.key];
    if (accs === undefined || accs === null || accs.length === 0) return [];
    return [
      `<div class="acc-card-group">${g.label}</div>`,
      ...accs.map(a => {
        if (state.accDeleteRow === a._row) return '';
        const cardStyle = (a.record_status === 'deleted' || a.record_status === 'inactive') ? ' style="opacity:0.5"'
                        : a.record_status === 'locked' ? ' style="opacity:0.7"'
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
  if (subSel !== null) subSel.innerHTML = _subTypeOptsHtml(type, '');
}

// ── Events ────────────────────────────────────────────────────────────────────

function _attachEvents() {
  if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }

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
      if (file === undefined || file === null) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const parsed = _parseAccountsCsv(ev.target.result);
        _importParsed = parsed.accounts.length ? parsed.accounts : null;
        el('accImportStatus').innerHTML = _renderImportStatus(parsed);
        el('accImportConfirm').disabled = (_importParsed === null);
      };
      reader.readAsText(file);
    });

    el('accImportConfirm').addEventListener('click', () => {
      if (_importParsed !== null) _submitImport(_importParsed);
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
    if (viewToEditEl !== null) viewToEditEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.accViewRow = null;
      state.accEditRow = row;
      renderAccounts();
    });
    const viewRestoreEl = el('accViewRestore');
    if (viewRestoreEl !== null) viewRestoreEl.addEventListener('click', e => {
      const row = Number(e.currentTarget.dataset.row);
      state.accViewRow = null;
      _restoreAccount(row);
    });
  }

  const handleAccAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? Number(btn.dataset.row) : null;
    if (action === 'acc-menu') {
      if (_accMenuKey === row) { closeContextMenu(); _accMenuKey = null; return; }
      _accMenuKey = row;
      const menuAcc   = state.accounts.find(a => a._row === row);
      const isLocked  = menuAcc !== undefined && menuAcc.record_status === 'locked';
      const isDeleted = menuAcc !== undefined && menuAcc.record_status === 'deleted';
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
          if (acc !== undefined) {
            state.filters = { types: [], accounts: [acc.id], major: [], minor: [], user_location_country: '', tag: '', search: '' };
            document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
          }
        }
      });
      return;
    }
    if (action === 'acc-view')   { state.accViewRow = row; state.accEditRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); return; }
    if (action === 'acc-edit') {
      const editAcc = state.accounts.find(a => a._row === row);
      if (editAcc !== undefined && (editAcc.record_status === 'locked' || editAcc.record_status === 'deleted')) return;
      state.accEditRow = row; state.accViewRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; renderAccounts(); return;
    }
    if (action === 'acc-delete') {
      const delAcc = state.accounts.find(a => a._row === row);
      if (delAcc !== undefined && (delAcc.record_status === 'locked' || delAcc.record_status === 'deleted')) return;
      state.accDeleteRow = row; state.accViewRow = null; state.accEditRow = null; state.accDeleteBlocked = null; renderAccounts();
    }
    if (action === 'acc-cancel-delete')  { state.accDeleteRow = null; state.accDeleteBlocked = null; renderAccounts(); }
    if (action === 'acc-confirm-delete') { _confirmDelete(row); }
    if (action === 'acc-deactivate')     { _deactivateAccount(row); }
  };

  const tableWrap = el('accountsContent').querySelector('.acc-table-wrap');
  if (tableWrap !== null) tableWrap.addEventListener('click', handleAccAction);
  const cards = el('accountsContent').querySelector('.acc-cards');
  if (cards !== null) cards.addEventListener('click', handleAccAction);

  el('accExportBtn').addEventListener('click', () => {
    if (state.accounts.length === 0) { showMsg('No accounts to export.', 'warn'); return; }
    openContextMenu(el('accExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => exportAccounts(key, state.accounts));
  });

  // Filter toggle
  el('accFilterToggle').addEventListener('click', () => {
    state.accFilterOpen = !state.accFilterOpen;
    if (state.accFilterOpen && _accDraft === null) {
      _accDraft = { ...state.accFilters, recordStatuses: [...state.accFilters.recordStatuses] };
    }
    renderAccounts();
  });

  if (state.accFilterOpen) {
    if (_accDraft === null) {
      _accDraft = { ...state.accFilters, recordStatuses: [...state.accFilters.recordStatuses] };
    }

    const MENU_OPEN_STYLE = 'display:flex;flex-direction:column;gap:8px;position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.15)';
    const OPT_STYLE       = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

    const ALL_DD_MENUS = ['accFTypeMenu','accFSubMenu','accFCurrMenu','accFStatusMenu'];

    const _openDD = (triggerId, menuId) => {
      ALL_DD_MENUS.filter(id => id !== menuId).forEach(id => {
        const m = el(id); if (m !== null && m.style.display !== 'none') m.style.cssText = 'display:none';
      });
      if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
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
        _accDDCleanup = null;
      };
      document.addEventListener('click', close, true);
      _accDDCleanup = () => document.removeEventListener('click', close, true);
    };

    el('accFTypeTrigger').addEventListener('click',   () => _openDD('accFTypeTrigger',   'accFTypeMenu'));
    el('accFSubTrigger').addEventListener('click',    () => {
      const trig = el('accFSubTrigger');
      if (trig !== null && trig.disabled === true) return;
      _openDD('accFSubTrigger', 'accFSubMenu');
    });
    el('accFCurrTrigger').addEventListener('click',   () => _openDD('accFCurrTrigger',   'accFCurrMenu'));
    el('accFStatusTrigger').addEventListener('click', () => _openDD('accFStatusTrigger', 'accFStatusMenu'));

    // Type — delegation; also repopulates sub-type menu
    const typeMenu = el('accFTypeMenu');
    if (typeMenu !== null) {
      typeMenu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_accDraft !== null) { _accDraft.type = val; _accDraft.subType = 'all'; }
        const lbl = el('accFTypeLabel');
        if (lbl !== null) lbl.textContent = val === 'all' ? 'All types' : val.charAt(0).toUpperCase() + val.slice(1);
        typeMenu.style.cssText = 'display:none';
        if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }

        const subTrig = el('accFSubTrigger');
        const subMenu = el('accFSubMenu');
        const subLbl  = el('accFSubLabel');
        if (val === 'all') {
          if (subTrig !== null) { subTrig.disabled = true; subTrig.style.opacity = '0.5'; subTrig.style.cursor = 'not-allowed'; }
          if (subLbl !== null)  subLbl.textContent = '— select type first —';
          if (subMenu !== null) subMenu.innerHTML = '';
        } else {
          const subs = _subTypesForType(val);
          if (subTrig !== null) { subTrig.disabled = false; subTrig.style.opacity = ''; subTrig.style.cursor = ''; }
          if (subLbl !== null)  subLbl.textContent = 'All sub-types';
          if (subMenu !== null) subMenu.innerHTML = [['all','All sub-types'], ...subs.map(s => [s, _subTypeLabel(s)])].map(([v, l]) =>
            `<label style="${OPT_STYLE}"><input type="radio" name="accFSubR" value="${v}"${v === 'all' ? ' checked' : ''}> ${esc(l)}</label>`
          ).join('');
        }
      });
    }

    // Sub-type — delegation (handles dynamically repopulated innerHTML)
    const subMenu = el('accFSubMenu');
    if (subMenu !== null) {
      subMenu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_accDraft !== null) _accDraft.subType = val;
        const lbl = el('accFSubLabel');
        if (lbl !== null) lbl.textContent = val === 'all' ? 'All sub-types' : _subTypeLabel(val);
        subMenu.style.cssText = 'display:none';
        if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
      });
    }

    // Currency — delegation
    const currMenu = el('accFCurrMenu');
    if (currMenu !== null) {
      currMenu.addEventListener('change', e => {
        const radio = e.target.closest('input[type="radio"]');
        if (radio === null) return;
        const val = radio.value;
        if (_accDraft !== null) _accDraft.currency = val;
        const lbl = el('accFCurrLabel');
        if (lbl !== null) lbl.textContent = val === 'all' ? 'All' : val;
        currMenu.style.cssText = 'display:none';
        if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
      });
    }

    // Status checkboxes — delegation; dropdown stays open while checking
    const statusMenu = el('accFStatusMenu');
    if (statusMenu !== null) {
      statusMenu.addEventListener('change', () => {
        if (_accDraft === null) return;
        const checked = Array.from(statusMenu.querySelectorAll('[data-acc-filter-rstat]:checked'))
          .map(c => c.dataset.accFilterRstat);
        _accDraft.recordStatuses = checked;
        const lbl = el('accFStatusLabel');
        if (lbl !== null) lbl.textContent = checked.length === ALL_RECORD_STATUSES.length ? 'All' : checked.length === 0 ? 'None'
          : checked.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
      });
    }

    const _applyAccDraft = () => {
      if (_accDraft !== null) {
        _accDraft.search = el('accFSearch').value.trim();
        state.accFilters = { ..._accDraft, recordStatuses: [..._accDraft.recordStatuses] };
        _accDraft = null;
      }
      renderAccounts();
    };
    el('accFSearchBtn').addEventListener('click', _applyAccDraft);
    el('accFSearch').addEventListener('keydown', e => { if (e.key === 'Enter') _applyAccDraft(); });

    el('accFClear').addEventListener('click', () => {
      _accDraft = null;
      state.accFilters = {
        type: 'all', subType: 'all', currency: 'all', search: '',
        recordStatuses: [...ALL_RECORD_STATUSES],
      };
      renderAccounts();
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _v(id) {
  const domEl = el(id);
  if (domEl === null) throw new Error('[accounts] _v: element not found: ' + id);
  return domEl.value;
}

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNew() {
  const name        = _v('accNewName').trim();
  const currency    = _v('accNewCurrency');
  const type        = _v('accNewType');
  const sub_type    = _v('accNewSubType');
  const description = _v('accNewDescription').trim();
  const errEl       = el('accAddError');

  if (String(name).trim() === '')                                                                    { errEl.textContent = 'Name is required.';     return; }
  if (type === undefined || type === null || !_validTypes().has(type))                               { errEl.textContent = 'Type is required.';     return; }
  if (sub_type === undefined || sub_type === null || String(sub_type).trim() === '')                 { errEl.textContent = 'Sub-type is required.'; return; }
  if (currency === undefined || currency === null || String(currency).trim() === '' || !(currency in state.rateMap)) { errEl.textContent = 'Currency is required.'; return; }
  errEl.textContent = '';

  const ovStr = _v('accNewOpeningValue').trim();
  if (ovStr === '') { errEl.textContent = 'Opening value is required.'; return; }
  const rawOV = parseFloat(ovStr);
  if (Number.isFinite(rawOV) === false) { errEl.textContent = 'Opening value must be a finite number.'; return; }
  const openingVal = rawOV;

  const payload = {
    name,
    currency,
    type,
    sub_type,
    description,
    opening_value: openingVal,
  };

  const btn = el('accSaveNew');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createAccount(payload);
    if (res.ok) {
      showMsg('Account added.');
      state.accAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _saveNew failed:', res.error);
      const errCode = (res.error !== undefined && res.error !== null) ? res.error : 'unknown';
      const msg = errCode === 'duplicate_account'      ? 'An account with this name already exists.'
                : errCode === 'missing_opening_value'  ? 'Opening value is required.'
                : errCode === 'invalid_opening_value'  ? 'Opening value must be a finite number.'
                : 'Error: ' + errCode;
      errEl.textContent = msg;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveNew failed:', _);
    errEl.textContent = 'Connection error.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveEdit() {
  const rowNum = state.accEditRow;
  if (rowNum === null || rowNum === undefined) return;

  const name  = el('accEditName').value.trim();
  const errEl = el('accEditError');
  if (String(name).trim() === '') { errEl.textContent = 'Name is required.'; return; }

  errEl.textContent = '';

  const subTypeEl = el('accEditSubType');
  const payload = {
    row_num:       rowNum,
    name,
    record_status: el('accEditRecordStatus').value,
    description:   el('accEditDescription').value.trim(),
  };
  if (subTypeEl !== null && subTypeEl.tagName === 'SELECT' && subTypeEl.value !== '') {
    payload.sub_type = subTypeEl.value;
  }

  const btn = el('accSaveEdit');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount(payload);
    if (res.ok) {
      showMsg('Account updated.');
      state.accEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _saveEdit failed:', res.error);
      const editErrCode = (res.error !== undefined && res.error !== null) ? res.error : 'unknown';
      errEl.textContent = editErrCode === 'record_locked'
        ? 'This account is locked and cannot be edited.'
        : editErrCode === 'duplicate_account'
          ? 'An account with this name already exists.'
          : 'Update failed: ' + editErrCode;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveEdit failed:', _);
    errEl.textContent = 'Connection error.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
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
      state.accDeleteBlocked = { referenced_count: res.referenced_count };
      renderAccounts();
    } else {
      console.warn('[accounts] _confirmDelete failed:', res.error);
      showMsg('Delete failed: ' + ((res.error !== undefined && res.error !== null) ? res.error : 'unknown'), 'warn');
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
  if (acc === undefined) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount({
      row_num:       rowNum,
      name:          acc.name,
      record_status: 'inactive',
      description:   acc.description,
    });
    if (res.ok) {
      showMsg('Account deactivated.');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _deactivateAccount failed:', res.error);
      showMsg('Deactivate failed: ' + ((res.error !== undefined && res.error !== null) ? res.error : 'unknown'), 'warn');
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
  if (acc === undefined) return;
  showLoading();
  try {
    const res = await ExpenseAPI.restoreAccount({ row_num: rowNum });
    if (res.ok) {
      showMsg('Account restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[accounts] _restoreAccount failed:', res.error);
      const msg = res.error === 'missing_row_num' ? 'Invalid restore request.'
                : res.error === 'invalid_row'     ? 'Row not found.'
                : res.error === 'not_deleted'     ? 'Account is not deleted — cannot restore.'
                : 'Restore failed: ' + ((res.error !== undefined && res.error !== null) ? res.error : 'unknown');
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
  if ((accounts === undefined || accounts === null) || accounts.length === 0) {
    showMsg('No accounts to import.', 'warn');
    return;
  }
  const btn   = el('accImportConfirm');
  const errEl = el('accImportError');
  if (btn !== null)   { btn.disabled = true; btn.textContent = 'Importing…'; }
  if (errEl !== null) errEl.textContent = '';
  showLoading();
  try {
    const res = await ExpenseAPI.createAccountsBulk({ accounts });

    if (res.ok === false && (res.results === undefined || res.results === null)) {
      console.warn('[accounts] _submitImport failed:', res.error);
      if (errEl !== null) errEl.textContent = 'Error: ' + ((res.error !== undefined && res.error !== null) ? res.error : 'unknown');
      if (btn !== null)   { btn.disabled = false; btn.textContent = 'Import'; }
      return;
    }

    const created = res.created;
    const skipped = res.skipped;
    const failed  = res.failed;

    if (failed === 0) {
      _importParsed = null;
      state.accImportOpen = false;
      const msg = [
        created ? `${created} account${created !== 1 ? 's' : ''} imported` : '',
        skipped ? `${skipped} already existed` : '',
      ].filter(s => s !== '').join(' · ');
      showMsg(msg !== '' ? msg : 'Nothing to import.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      const resultRows = (res.results !== undefined && res.results !== null ? res.results : []).map(r => `
        <tr>
          <td>${esc(r.name)}</td>
          <td>${r.ok
            ? `<span class="badge badge-et-in">created</span>`
            : r.error === 'duplicate_account'
              ? `<span class="badge" style="color:var(--muted)">already exists</span>`
              : `<span class="badge badge-et-out">${esc((r.error !== undefined && r.error !== null) ? r.error : 'unknown')}</span>`}
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
      if (btn !== null) { btn.disabled = true; btn.textContent = 'Import'; }
      if (created > 0) { document.dispatchEvent(new CustomEvent('et:reload')); }
      showMsg(`${created} imported · ${skipped} skipped · ${failed} failed`, 'warn');
    }
  } catch (_) {
    console.error('[accounts] _submitImport failed:', _);
    if (errEl !== null) errEl.textContent = 'Connection error.';
    if (btn !== null)   { btn.disabled = false; btn.textContent = 'Import'; }
  } finally {
    hideLoading();
  }
}
