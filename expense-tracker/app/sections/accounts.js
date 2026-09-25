import { state } from '../core/state.js';
import {
  el, esc, getSymbol, toBase, fmtBase, exportAccounts,
  openContextMenu, closeContextMenu, recordStatusIcon, syncStatusIcon, parseCsvRecords,
} from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Module-level holding area for the current import session's parsed rows.
let _importParsed  = null;   // array of plain objects (header → cell value) or null
let _importReadSequence = 0;
let _importBusy = false;
let _importResult = '';
let _importRetry = false;
let _importType    = '';     // selected file_type for the current import session
let _accMenuKey    = null;
let _accDraft      = null;   // pending filter selections; copied to state.accFilters on Search
let _accDDCleanup  = null;   // cleanup fn for the currently open filter dropdown's outside-click listener

// ── Schema accessors ──────────────────────────────────────────────────────────
// Schema is loaded at boot into state.accountSchema — no hardcoded constants here.
// All accessors assume schema is present; renderAccounts guards against absent schema.
function _accountTypes()     { return state.accountSchema.types; }
function _loanSubSet()       { return new Set(state.accountSchema.loan_sub_types); }
function _validTypes()       { return new Set(_accountTypes().map(t => t.value)); }

function _subTypesForType(type) {
  return state.accountSchema.subtypes_by_type[type] ?? [];
}

function _isLiability(a)     { return a.type === 'liability'; }
function _isLoan(a)          { return a.type === 'liability' && _loanSubSet().has(a.sub_type); }

// All record statuses — includes 'deleted' so the filter bar can show deleted accounts.
const ALL_RECORD_STATUSES = ['active', 'inactive', 'deleted', 'locked'];

// Import file types — [label, value]. Value is the backend file_type target table.
const IMPORT_FILE_TYPES = [
  ['Accounts (master)',   'account_master'],
  ['Deposit',             'account_deposit'],
  ['Credit card',         'account_liability_credit_card'],
  ['Mortgage',            'account_liability_mortgage'],
  ['Personal loan',       'account_liability_personal_loan'],
  ['Property',            'account_investment_property'],
  ['Stock holdings',      'account_investment_stocks'],
];

// Labels are owned by the configuration Sheet, including retired classifications.
function _subTypeLabel(value) {
  if (value === undefined || value === null || value === '') return '—';
  return state.accountSchema.subtype_labels[value] ?? value;
}

function _fmtDateDisplay(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return '—';
  return String(raw).replace('T', ' ').substring(0, 16);
}

function _fmtBal(n) {
  const v = Math.abs(parseFloat(n));
  if (Number.isFinite(v) === false) return '—';
  return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _balanceCell(a) {
  const val = parseFloat(a.current_value_local);
  if (Number.isFinite(val) === false) return '<span class="muted">—</span>';
  const sym     = getSymbol(a.account_currency_local);
  const foreign = a.account_currency_local !== state.quoteCurrency;
  const baseTag = foreign
    ? ` <span class="td-base-amt">${esc(fmtBase(Math.abs(val), a.account_currency_local, null))}</span>`
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

  const liquidSubTypes = new Set(state.accountTypes.filter(type => type.detail_sheet === 'account_deposit').map(type => type.account_subtype_key));

  const totalAssets = state.accounts
    .filter(a => a.record_status !== 'deleted' && (a.type === 'asset' || a.type === 'investment'))
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value_local), a.account_currency_local, null); return Number.isFinite(v) ? s + v : s; }, 0);

  const totalLiab = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'liability')
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value_local), a.account_currency_local, null); return Number.isFinite(v) ? s + Math.abs(v) : s; }, 0);

  const liquidCash = state.accounts
    .filter(a => a.record_status !== 'deleted' && a.type === 'asset' && liquidSubTypes.has(a.sub_type))
    .reduce((s, a) => { const v = toBase(parseFloat(a.current_value_local), a.account_currency_local, null); return Number.isFinite(v) ? s + v : s; }, 0);

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
    if (f.currency !== 'all' && a.account_currency_local !== f.currency) return false;
    if (f.search !== '') {
      const q   = f.search.toLowerCase();
      const hay = (a.account_name + ' ' + a.description).toLowerCase();
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
    if (seenC[a.account_currency_local] === undefined) { seenC[a.account_currency_local] = true; currencies.push(a.account_currency_local); }
  });
  currencies.sort();

  const subTypes = _subTypesForType(f.type);

  const rs = new Set(f.recordStatuses);

  const typeLabel    = f.type === 'all' ? 'All types' : (state.accountSchema.type_labels[f.type] ?? f.type);
  const subTypeLabel = f.type === 'all' ? '— select type first —' : (f.subType === 'all' ? 'All sub-types' : _subTypeLabel(f.subType));
  const currLabel    = f.currency === 'all' ? 'All' : f.currency;
  const statusLabel  = rs.size === ALL_RECORD_STATUSES.length ? 'All' : rs.size === 0 ? 'None'
    : [...rs].map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');

  const trigStyle = 'width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none';
  const optStyle  = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

  const radioRows = (name, opts, cur) => opts.map(([val, lbl]) =>
    `<label style="${optStyle}"><input type="radio" name="${name}" value="${esc(val)}"${cur === val ? ' checked' : ''}> ${esc(lbl)}</label>`
  ).join('');

  const dd = (triggerId, labelId, menuId, curLabel, items, disabled) => `
    <div style="flex:1;position:relative">
      <button type="button" id="${triggerId}"${disabled ? ' disabled' : ''} style="${trigStyle}${disabled ? ';opacity:0.5;cursor:not-allowed' : ''}">
        <span id="${labelId}">${esc(curLabel)}</span>
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
          radioRows('accFTypeR', [['all','All types'], ..._accountTypes().map(type => [type.value, type.label])], f.type))}
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
  const typeOpts = IMPORT_FILE_TYPES.map(([label, value]) =>
    `<option value="${esc(value)}"${_importType === value ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');

  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import account data from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field">
        <label for="accImportType">File type *</label>
        <select id="accImportType">
          <option value="">— select file type —</option>
          ${typeOpts}
        </select>
      </div>
      <div class="field form-grid-span-2">
        <label for="accImportFile">CSV file</label>
        <input type="file" id="accImportFile" accept=".csv">
        <div class="field-hint">Required columns depend on the selected file type — the header row must match the target table's columns. Import account (master) rows before any detail rows, as detail rows reference accounts by account_id.</div>
      </div>
    </div>
    <div id="accImportStatus">${_importResult}</div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="accImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="accImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="accImportError"></div>
  </div>`;
}

// Generic CSV parser: header row (normalized to snake_case) → array of plain
// objects keyed by column name. The backend is the single source of validation;
// the only FE parse errors surfaced are structural (empty file, missing header,
// column-count mismatch).
function _parseGenericCsv(text) {
  const decoded = parseCsvRecords(text);
  if (decoded.errors.length > 0) return { rows: [], errors: decoded.errors };
  const records = decoded.records;
  if (records.length === 0) return { rows: [], errors: ['File is empty.'] };
  if (records.length === 1) return { rows: [], errors: ['No data rows found — the file has only a header row.'] };

  const headers = records[0].values.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (headers.includes('') || new Set(headers).size !== headers.length) return { rows: [], errors: ['CSV has blank or duplicate column headers.'] };
  const rows    = [];
  const errors  = [];

  for (let i = 1; i < records.length; i++) {
    const vals = records[i].values;
    if (vals.length !== headers.length) {
      errors.push(`Row ${records[i].line}: expected ${headers.length} column${headers.length !== 1 ? 's' : ''}, found ${vals.length}`);
      continue;
    }
    const row = {};
    headers.forEach((h, idx) => {
      const cell = vals[idx];
      row[h] = (cell === undefined || cell === null) ? '' : String(cell).trim();
    });
    rows.push(row);
  }

  return { rows, errors };
}

function _renderImportStatus(parsed) {
  const { rows, errors } = parsed;
  const errHtml = errors.length !== 0
    ? `<div class="pin-error" style="margin-bottom:8px">${errors.map(e => esc(e)).join('<br>')}</div>`
    : '';
  if (errors.length > 0) return errHtml + '<p class="placeholder">Correct the errors before importing.</p>';
  if (rows.length === 0) return '<p class="placeholder">No valid rows found.</p>';
  return `${errHtml}<p style="font-size:13px;color:var(--muted);margin:0">${rows.length} row${rows.length !== 1 ? 's' : ''} ready to import</p>`;
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
    `<option value="${esc(r.currency)}" ${(!isAdd && a.account_currency_local === r.currency) ? 'selected' : ''}>${esc(r.currency)}</option>`
  ).join('');

  const header = (!isAdd) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} — <strong>${esc(a.account_name)}</strong>
    </div>` : '';

  const typeDisplay = (type !== '') ? type.charAt(0).toUpperCase() + type.slice(1) : '';

  const typeField = isAdd
    ? `<select id="accNewType"><option value="">— select —</option>${_typeOptsHtml('')}</select>`
    : `<input type="text" id="accEditType" value="${esc(typeDisplay)}" disabled>`;

  const subTypeField = isAdd
    ? `<select id="accNewSubType"><option value="">— select —</option></select>`
    : isView
      ? `<input type="text" id="accEditSubType" value="${esc(_subTypeLabel(a.sub_type))}" disabled>`
      : `<select id="accEditSubType">${_subTypeOptsHtml(a.type, a.sub_type)}</select>`;

  const sym = isAdd ? '' : getSymbol(a.account_currency_local);

  // 'deleted' is excluded from the edit form — deletion goes through delete_account, not update_account.
  const EDIT_RECORD_STATUSES = ['active', 'inactive', 'locked'];
  const recordStatusField = !isAdd ? `
      <div class="field">
        <label for="accEditRecordStatus">Record status</label>
        ${isView
          ? `<input type="text" value="${esc(a.record_status.charAt(0).toUpperCase() + a.record_status.slice(1))}" disabled>`
          : `<select id="accEditRecordStatus">
          ${EDIT_RECORD_STATUSES.map(s =>
            `<option value="${esc(s)}"${a.record_status === s ? ' selected' : ''}>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</option>`
          ).join('')}
        </select>`}
      </div>` : '';

  // Opening date: editable datetime-local on add, read-only text on view/edit
  const openingDateField = isAdd
    ? `<div class="field">
         <label for="accNewOpeningDate">Opening date *</label>
         <input type="datetime-local" id="accNewOpeningDate">
       </div>`
    : `<div class="field">
         <label>Opening date</label>
         <input type="text" value="${v(_fmtDateDisplay(a.account_opening_date_local))}" disabled>
       </div>`;

  // Closing date: not shown on add; read-only in view, editable in edit
  const closingDateField = !isAdd ? `
    <div class="field">
      <label for="${pfx}ClosingDate">Closing date</label>
      ${isView
        ? `<input type="text" value="${v(_fmtDateDisplay(a.account_closing_date_local))}" disabled>`
        : `<input type="datetime-local" id="accEditClosingDate" value="${esc(a.account_closing_date_local ? String(a.account_closing_date_local).replace(' ', 'T').substring(0, 16) : '')}">`}
    </div>` : '';

  // Timezone: not shown on add (auto-detected from browser); read-only in view/edit
  const timezoneField = !isAdd ? `
    <div class="field">
      <label>Timezone</label>
      <input type="text" value="${v(a.local_timezone !== undefined && a.local_timezone !== null ? a.local_timezone : '')}" disabled>
    </div>` : '';

  const syncStatusLine = isView ? `
    <div class="field-hint" style="margin-top:8px">
      Sync: ${syncStatusIcon(a.sync_status)} ${esc((a.sync_notes !== undefined && a.sync_notes !== null) ? a.sync_notes : '')}
    </div>` : '';

  return `
  <div class="card" style="margin-bottom:20px">
    ${header}

    <div class="form-grid form-grid-3" style="margin-bottom:16px">

      <div class="field">
        <label for="${pfx}Name">Account name${isAdd ? ' *' : ''}</label>
        <input type="text" id="${pfx}Name"
               value="${isAdd ? '' : v(a.account_name)}"
               ${isAdd ? 'placeholder="e.g. Barclays Current"' : ''}${dis}>
      </div>
      <div class="field">
        <label for="${pfx}LegalEntity">Legal entity</label>
        <input type="text" id="${pfx}LegalEntity"
               value="${isAdd ? '' : v(a.legal_entity_name !== undefined && a.legal_entity_name !== null ? a.legal_entity_name : '')}"
               ${isAdd ? 'placeholder="e.g. Barclays Bank UK"' : ' disabled'}>
      </div>
      <div class="field">
        <label for="${pfx}Description">Notes</label>
        <input type="text" id="${pfx}Description"
               value="${isAdd ? '' : v(a.description)}"
               ${isAdd ? 'placeholder="Optional notes"' : ''}${dis}>
      </div>

      <div class="field">
        <label for="${pfx}Type">Type${isAdd ? ' *' : ''}</label>
        ${typeField}
      </div>
      <div class="field">
        <label for="${pfx}SubType">Sub-type${isAdd ? ' *' : ''}</label>
        ${subTypeField}
      </div>
      ${openingDateField}
      <div class="field">
        <label for="${pfx}TrackingStart">Tracking start date</label>
        ${isAdd
          ? '<input type="datetime-local" id="accNewTrackingStart"><div class="field-hint">Opening value applies from this time. Earlier transactions remain in history but do not affect balances. Leave blank to include all history.</div>'
          : `<input type="text" id="accEditTrackingStart" value="${v(_fmtDateDisplay(a.tracking_start_date_local))}" disabled>`}
      </div>

      ${isAdd ? `
      <div class="field">
        <label for="accNewOpeningValue">Opening value *</label>
        <input type="number" id="accNewOpeningValue" step="0.01" placeholder="e.g. 1000.00">
      </div>
      <div class="field">
        <label for="accNewCurrency">Currency *</label>
        <select id="accNewCurrency">${currencyOpts}</select>
      </div>` : `
      <div class="field">
        <label>Currency</label>
        <input type="text" id="accEditCurrency" value="${v(a.account_currency_local)}" disabled>
      </div>
      ${timezoneField}
      ${closingDateField}
      <div class="field">
        <label>Opening value</label>
        <input type="text" value="${_isLiability(a) ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.opening_value_local)))) : v(sym + _fmtBal(parseFloat(a.opening_value_local)))}" disabled>
      </div>
      <div class="field">
        <label>Current value</label>
        <input type="text" value="${_isLiability(a)
          ? v('−' + sym + _fmtBal(Math.abs(parseFloat(a.current_value_local))))
          : v(sym + _fmtBal(parseFloat(a.current_value_local)))}" disabled>
      </div>
      ${recordStatusField}`}

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

function _renderAccountDelete(a) {
    if (state.accDeleteBlocked) {
      const n    = state.accDeleteBlocked.referenced_count;
      const noun = n === 1 ? 'transaction refers' : 'transactions refer';
      return `
          <span class="confirm-text">Cannot delete <strong>${esc(a.account_name)}</strong> — <strong>${n}</strong> ${noun} to this account.</span>
          <div style="color:var(--muted);font-size:var(--text-sm);margin-top:4px">
            Delete or reassign those transactions first, or deactivate the account instead.
          </div>
        <div class="row-actions">
          <button class="btn-link" data-action="acc-deactivate" data-row="${a._row}">Deactivate instead</button>
          <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
        </div>`;
    }
    return `<span class="confirm-text">Delete <strong>${esc(a.account_name)}</strong>? This marks the account as deleted.</span>
      <div class="row-actions">
        <button class="btn-link danger" data-action="acc-confirm-delete" data-row="${a._row}">Yes, delete</button>
        <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
      </div>`;
}

function _renderAccountRow(a) {
  const rowStyle = (a.record_status === 'deleted' || a.record_status === 'inactive') ? ' style="opacity:0.5"'
                 : a.record_status === 'locked' ? ' style="opacity:0.7"'
                 : '';
  if (state.accDeleteRow === a._row) {
    return `<tr${rowStyle}><td colspan="5">${_renderAccountDelete(a)}</td></tr>`;
  }

  return `<tr${rowStyle}>
    <td>${esc(a.account_name)}${(a.description !== undefined && a.description !== null && a.description !== '') ? `<span class="info-icon-wrap"><span style="cursor:help;color:var(--teal);font-size:13px">ⓘ</span><span class="info-tooltip">${esc(a.description)}</span></span>` : ''}</td>
    <td style="color:var(--muted);font-size:12px">${esc(_subTypeLabel(a.sub_type))}</td>
    <td>${esc(a.account_currency_local)}</td>
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
    <td colspan="5" style="background:var(--canvas);padding:10px 12px 4px;font-size:11px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:none">
      ${esc(label)}
      <span style="float:right;font-weight:600;color:${isLiab ? 'var(--ember)' : 'var(--teal)'}">${sign}${sym}${Math.abs(total).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
    </td>
  </tr>`;
}

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

  const groups = Object.keys(byGroup).map(key => ({ key, label: state.accountSchema.type_labels[key] ?? key, isLiab: _isLiability({ type: key }) }));
  const bodyRows = groups.flatMap(g => {
    const accs = byGroup[g.key];
    if (accs === undefined || accs === null || accs.length === 0) return [];
    const countable = accs.filter(a => a.record_status !== 'deleted');
    const total = g.isLiab
      ? countable.reduce((s, a) => { const v = toBase(parseFloat(a.current_value_local), a.account_currency_local, null); return Number.isFinite(v) ? s + Math.abs(v) : s; }, 0)
      : countable.reduce((s, a) => { const v = toBase(parseFloat(a.current_value_local), a.account_currency_local, null); return Number.isFinite(v) ? s + v : s; }, 0);
    return [_groupHeader(g.label, total, sym, g.isLiab), ...accs.map(_renderAccountRow)];
  }).join('');

  const cardSections = groups.flatMap(g => {
    const accs = byGroup[g.key];
    if (accs === undefined || accs === null || accs.length === 0) return [];
    return [
      `<div class="acc-card-group">${esc(g.label)}</div>`,
      ...accs.map(a => {
        if (state.accDeleteRow === a._row) return `<div class="card record-confirm-card">${_renderAccountDelete(a)}</div>`;
        const cardStyle = (a.record_status === 'deleted' || a.record_status === 'inactive') ? ' style="opacity:0.5"'
                        : a.record_status === 'locked' ? ' style="opacity:0.7"'
                        : '';
        return `<div class="acc-card"${cardStyle}>
          <div class="acc-card-body">
            <div class="acc-card-name">${esc(a.account_name)}</div>
            <div class="acc-card-meta">${esc(_subTypeLabel(a.sub_type))} · ${esc(a.account_currency_local)}</div>
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
    <div class="table-wrap acc-table-wrap">
      <table class="acc-table">
        <thead><tr>
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
    if (_importBusy) return;
    _importReadSequence++;
    if (state.accImportOpen) {
      state.accImportOpen = false;
      _importParsed = null;
      _importType   = '';
      _importResult = '';
      _importRetry = false;
    } else {
      state.accImportOpen = true;
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    }
    renderAccounts();
  });

  el('accAddBtn').addEventListener('click', () => {
    if (_importBusy) return;
    _importReadSequence++;
    if (state.accAddOpen || state.accViewRow !== null || state.accEditRow !== null) {
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    } else {
      state.accAddOpen = true;
      state.accImportOpen = false;
      _importParsed = null;
      _importType   = '';
      _importResult = '';
      _importRetry = false;
    }
    renderAccounts();
  });

  if (state.accImportOpen) {
    el('accImportType').addEventListener('change', e => {
      _importType = e.target.value;
      _updateImportConfirmState();
    });

    el('accImportFile').addEventListener('change', e => _readAccountImport(e.target.files[0]));
    el('accImportConfirm').addEventListener('click', () => {
      if (_importParsed !== null && _importType !== '') _submitImport(_importType, _importParsed);
    });

    _updateImportConfirmState();
    el('accImportCancel').addEventListener('click', () => {
      if (_importBusy) return;
      _importReadSequence++;
      state.accImportOpen = false;
      _importParsed = null;
      _importType   = '';
      _importResult = '';
      _importRetry = false;
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
        if (lbl !== null) lbl.textContent = val === 'all' ? 'All types' : (state.accountSchema.type_labels[val] ?? val);
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
            `<label style="${OPT_STYLE}"><input type="radio" name="accFSubR" value="${esc(v)}"${v === 'all' ? ' checked' : ''}> ${esc(l)}</label>`
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
  const account_name   = _v('accNewName').trim();
  const legal_entity   = _v('accNewLegalEntity').trim();
  const account_currency_local = _v('accNewCurrency');
  const type           = _v('accNewType');
  const sub_type       = _v('accNewSubType');
  const description    = _v('accNewDescription').trim();
  const opening_date_raw = _v('accNewOpeningDate').trim();
  const errEl          = el('accAddError');

  if (account_name === '')                                                                                                   { errEl.textContent = 'Account name is required.';  return; }
  if (type === undefined || type === null || !_validTypes().has(type))                                                       { errEl.textContent = 'Type is required.';            return; }
  if (sub_type === undefined || sub_type === null || String(sub_type).trim() === '')                                         { errEl.textContent = 'Sub-type is required.';        return; }
  if (account_currency_local === undefined || account_currency_local === null || String(account_currency_local).trim() === '' || !(account_currency_local in state.rateMap)) { errEl.textContent = 'Currency is required.';  return; }
  if (opening_date_raw === '')                                                                                                { errEl.textContent = 'Opening date is required.';   return; }
  errEl.textContent = '';

  const ovStr = _v('accNewOpeningValue').trim();
  if (ovStr === '') { errEl.textContent = 'Opening value is required.'; return; }
  const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (decimalPattern.test(ovStr) === false || Number.isFinite(Number(ovStr)) === false) {
    errEl.textContent = 'Opening value must be a finite number.';
    return;
  }

  // Capture browser timezone automatically — not a user input field.
  const local_timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Convert datetime-local format (YYYY-MM-DDTHH:MM) to stored format (YYYY-MM-DD HH:MM).
  const account_opening_date_local = opening_date_raw.replace('T', ' ');

  const payload = {
    account_name,
    legal_entity_name:  legal_entity,
    account_currency_local,
    local_timezone,
    type,
    sub_type,
    account_opening_date_local,
    tracking_start_date_local: _v('accNewTrackingStart').trim().replace('T', ' '),
    description,
    // Keep the decimal text intact for the backend and ledger minor-unit conversion.
    opening_value_local: ovStr,
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
      const errCode = (res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown';
      const msg = errCode === 'duplicate_account'           ? 'An account with this name already exists.'
                : errCode === 'missing_opening_value_local'       ? 'Opening value is required.'
                : errCode === 'invalid_opening_value_local'       ? 'Opening value must be a finite number.'
                : errCode === 'missing_opening_date_local'  ? 'Opening date is required.'
                : 'Error: ' + errCode;
      errEl.textContent = msg;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveNew failed:', _);
    errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveEdit() {
  const rowNum = state.accEditRow;
  if (rowNum === null || rowNum === undefined) return;

  const account_name = el('accEditName').value.trim();
  const errEl        = el('accEditError');
  if (account_name === '') { errEl.textContent = 'Account name is required.'; return; }

  errEl.textContent = '';

  const subTypeEl      = el('accEditSubType');
  const closingDateEl  = el('accEditClosingDate');
  const payload = {
    row_num:       rowNum,
    account_name,
    record_status: el('accEditRecordStatus').value,
    description:   el('accEditDescription').value.trim(),
  };
  if (subTypeEl !== null && subTypeEl.tagName === 'SELECT' && subTypeEl.value !== '') {
    payload.sub_type = subTypeEl.value;
  }
  if (closingDateEl !== null && closingDateEl.value !== '') {
    payload.account_closing_date_local = closingDateEl.value.replace('T', ' ');
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
      const editErrCode = (res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown';
      errEl.textContent = editErrCode === 'record_locked'
        ? 'This account is locked and cannot be edited.'
        : editErrCode === 'duplicate_account'
          ? 'An account with this name already exists.'
          : 'Update failed: ' + editErrCode;
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (_) {
    console.error('[accounts] _saveEdit failed:', _);
    errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
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
      showMsg('Delete failed: ' + ((res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown'), 'warn');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _confirmDelete failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
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
      account_name:  acc.account_name,
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
      showMsg('Deactivate failed: ' + ((res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown'), 'warn');
      state.accDeleteBlocked = null;
      state.accDeleteRow = null;
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _deactivateAccount failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
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
                : 'Restore failed: ' + ((res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown');
      showMsg(msg, 'warn');
      renderAccounts();
    }
  } catch (_) {
    console.error('[accounts] _restoreAccount failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    renderAccounts();
  } finally {
    hideLoading();
  }
}

// Enable the Import button only when BOTH a file_type is chosen AND rows parsed.
function _updateImportConfirmState() {
  const button = el('accImportConfirm');
  if (button !== null) {
    button.disabled = _importBusy || _importParsed === null || _importType === '';
    button.textContent = _importBusy ? 'Importing…' : _importRetry ? 'Retry failed rows' : 'Import';
  }
  for (const id of ['accImportFile', 'accImportType', 'accImportCancel', 'accImportBtn', 'accAddBtn']) {
    const control = el(id);
    if (control !== null) control.disabled = _importBusy;
  }
}

async function _readAccountImport(file) {
  if (_importBusy) return;
  const sequence = ++_importReadSequence;
  _importParsed = null;
  _importResult = '';
  _importRetry = false;
  const status = el('accImportStatus');
  if (status !== null) status.innerHTML = '';
  _updateImportConfirmState();
  if (file === undefined) return;
  try {
    const text = await file.text();
    if (sequence !== _importReadSequence || !state.accImportOpen) return;
    const parsed = _parseGenericCsv(text);
    _importParsed = parsed.errors.length === 0 && parsed.rows.length > 0 ? parsed.rows : null;
    _importResult = _renderImportStatus(parsed);
  } catch (_) {
    if (sequence !== _importReadSequence || !state.accImportOpen) return;
    _importResult = '<p class="pin-error">Could not read this CSV. Choose the file again.</p>';
  } finally {
    if (sequence === _importReadSequence && state.accImportOpen) {
      el('accImportStatus').innerHTML = _importResult;
      _updateImportConfirmState();
    }
  }
}

async function _submitImport(fileType, rows) {
  if (_importBusy) return;
  if (fileType === '') { showMsg('Select a file type first.', 'warn'); return; }
  if (!Array.isArray(rows) || rows.length === 0) { showMsg('No rows to import.', 'warn'); return; }
  _importBusy = true;
  _updateImportConfirmState();
  showLoading();
  let changed = false;
  let uncertain = false;
  try {
    const response = await ExpenseAPI.importAccountData({ file_type: fileType, rows });
    if (!Array.isArray(response?.results) || response.results.length !== rows.length
        || !response.results.every(result => typeof result?.ok === 'boolean')) {
      throw new Error(response?.error ?? 'incomplete_import_response');
    }
    const succeeded = response.results.filter(result => result.ok);
    const failures = response.results.map((result, index) => ({ ...result, row: rows[index] })).filter(result => !result.ok);
    const created = succeeded.filter(result => result.action === 'created').length;
    const updated = succeeded.length - created;
    changed = succeeded.length > 0;
    if (failures.length === 0) {
      _importParsed = null; _importType = ''; _importResult = ''; _importRetry = false;
      state.accImportOpen = false;
      showMsg(`${created} created · ${updated} updated`);
    } else {
      _importParsed = failures.map(result => result.row);
      _importType = fileType;
      _importRetry = true;
      _importResult = `<p>${created} created · ${updated} updated · ${failures.length} failed</p>
        <div class="table-wrap"><table><thead><tr><th>Key</th><th>Reason</th></tr></thead><tbody>${failures.map(result =>
          `<tr><td>${esc(result.key ?? result.row.id ?? '—')}</td><td>${esc(result.error ?? 'unknown')}</td></tr>`
        ).join('')}</tbody></table></div>`;
      showMsg(`${failures.length} account rows failed. Review their reasons and retry only those rows.`, 'warn');
    }
  } catch (error) {
    uncertain = true;
    _importParsed = null;
    _importRetry = false;
    const message = `Import stopped: ${error?.message ?? 'connection_error'}. Some rows may have been saved. Refresh and check before choosing the file again.`;
    _importResult = `<p class="pin-error" role="alert">${esc(message)}</p>`;
    showMsg(message, 'warn');
  } finally {
    _importBusy = false;
    const status = el('accImportStatus');
    if (status !== null) status.innerHTML = _importResult;
    _updateImportConfirmState();
    if (changed || uncertain) document.dispatchEvent(new CustomEvent('et:reload'));
    hideLoading();
  }
}
