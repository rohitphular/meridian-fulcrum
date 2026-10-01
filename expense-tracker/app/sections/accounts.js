import { state } from '../core/state.js';
import { el, esc, downloadExport, openContextMenu, closeContextMenu, recordStatusIcon, syncStatusIcon, renderImportResult } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// The server owns the list: list_accounts_view filters, sorts, pages, converts
// to the quote currency and computes the summary cards and group totals.
// get_account_form_options supplies the add / edit / import choices. This file
// renders those payloads and sends the user's inputs back as params.
const LIST_VIEW = 'list_accounts_view';
const FORM_OPTIONS = 'get_account_form_options';
const PAGE_SIZE = 50;

// Current import session. The server parses and validates the CSV; the browser
// only holds the chosen file and renders the server's outcome.
let _importFile    = null;   // File chosen in the import panel, or null
let _importBusy = false;
let _importResult = '';
let _importType    = '';     // selected file_type for the current import session
let _accMenuKey    = null;
let _accDraft      = null;   // pending filter selections; copied to state.accFilters on Apply
let _accDDCleanup  = null;   // cleanup fn for the currently open filter dropdown's outside-click listener
let _sort          = { col: 'sheet', dir: 'asc' };
let _page          = 1;
let _viewSeq       = 0;      // only the newest list response may render
let _viewError     = '';
let _optionsSeq    = 0;
let _optionsFresh  = false;  // false after a reload: the next form refetches options
let _panelWaiting  = false;  // a panel was requested but its data had not arrived

function _fmtDateDisplay(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return '—';
  return String(raw).replace('T', ' ').substring(0, 16);
}

function _fmtBal(n) {
  const v = Math.abs(parseFloat(n));
  if (Number.isFinite(v) === false) return '—';
  return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtWhole(n) {
  return Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Server display_sign → sign prefix and CSS class (presentation only).
function _signed(sign, symbol, value, fmt) {
  if (sign === 'owed') return `<span class="acc-bal-owed">−${esc(symbol)}${fmt(value)}</span>`;
  if (sign === 'negative') return `<span class="negative acc-bal-mono">−${esc(symbol)}${fmt(value)}</span>`;
  return `<span class="acc-bal-mono">${esc(symbol)}${fmt(value)}</span>`;
}

function _signedText(sign, symbol, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return (sign === 'owed' || sign === 'negative' ? '−' : '') + symbol + _fmtBal(value);
}

// ── View data ─────────────────────────────────────────────────────────────────

function _viewData() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true ? response.data : null;
}

function _viewRows() {
  const data = _viewData();
  return data === null ? [] : data.groups.flatMap(group => group.rows);
}

// Open panels / confirmations hold the account id (never a Sheet row number,
// which an import or a manual sort can move); mutations send the row_num and
// updated_at of the row found here, and the server's stale_record check stays.
function _rowById(id) {
  return typeof id === 'string' && id !== '' ? (_viewRows().find(row => row.id === id) ?? null) : null;
}

function _optionsData() {
  const response = state.views?.[FORM_OPTIONS];
  return response?.ok === true ? response.data : null;
}

// state.accFilters → list_accounts_view params. An empty status selection is
// sent as 'none' because the API client drops empty arrays.
function _listParams() {
  const f = state.accFilters;
  return {
    type: f.type === 'all' ? '' : f.type,
    sub_type: f.type === 'all' || f.subType === 'all' ? '' : f.subType,
    currency: f.currency === 'all' ? '' : f.currency,
    search: f.search,
    statuses: f.recordStatuses.length === 0 ? 'none' : f.recordStatuses,
    sort: _sort.col, dir: _sort.dir,
    page: _page, page_size: PAGE_SIZE,
  };
}

async function _loadView() {
  const seq = ++_viewSeq;
  let response;
  // Every list request (open, filter, sort, page) shows the loader, as on Transactions.
  showLoading();
  try { response = await ExpenseAPI.view(LIST_VIEW, _listParams()); }
  catch (error) {
    hideLoading();
    if (seq !== _viewSeq) return;
    console.error('[accounts] list view failed:', error);
    _viewError = 'Accounts could not be loaded. Check your connection and refresh.';
    _renderList();
    return;
  }
  hideLoading();
  if (seq !== _viewSeq) return;
  if (response?.ok !== true) {
    console.warn('[accounts] list view failed:', response?.error);
    _viewError = response?.message || ('Accounts could not be loaded: ' + (response?.error ?? 'invalid_response'));
    _renderList();
    return;
  }
  _viewError = '';
  state.views[LIST_VIEW] = response;
  // The server may clamp the page (e.g. after a filter shrank the list).
  _page = response.data.page;
  if (_panelWaiting) _render(); else _renderList();
}

async function _ensureOptions() {
  if (_optionsFresh) return;
  _optionsFresh = true;
  const seq = ++_optionsSeq;
  let response;
  try { response = await ExpenseAPI.view(FORM_OPTIONS, {}); }
  catch (error) { console.error('[accounts] form options failed:', error); response = null; }
  if (seq !== _optionsSeq) return;
  if (response?.ok !== true) {
    _optionsFresh = false;
    showMsg(response?.message || 'Account form choices could not be loaded. Refresh and try again.', 'warn');
    return;
  }
  state.views[FORM_OPTIONS] = response;
  if (_panelWaiting) _render();
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Called by navigation, quote-currency changes and every reload: renders the
// last payload at once, then refreshes it from the server.
export function renderAccounts() {
  if (state.views === undefined || state.views === null) state.views = {};
  _optionsFresh = false;
  _render();
  _loadView();
}

function _formsNeedOptions() {
  return state.accAddOpen || state.accImportOpen || state.accEditRow !== null;
}

// Full render: header, panels and the list region.
function _render() {
  if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
  _accMenuKey = null;
  const options    = _optionsData();
  const viewAcc    = state.accViewRow !== null ? _rowById(state.accViewRow) : null;
  const editAcc    = state.accEditRow !== null ? _rowById(state.accEditRow) : null;
  const anyAddOpen = state.accAddOpen || state.accViewRow !== null || state.accEditRow !== null;
  const needsOptions = _formsNeedOptions();
  _panelWaiting = (state.accViewRow !== null && viewAcc === null) || (state.accEditRow !== null && editAcc === null)
    || (needsOptions && options === null);
  if (needsOptions) _ensureOptions();
  const waiting = '<div class="card" style="margin-bottom:20px"><p class="placeholder">Loading…</p></div>';

  el('accountsContent').innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="accImportBtn">${state.accImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="accExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="accAddBtn">${anyAddOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.accImportOpen ? (options === null ? waiting : _renderImportPanel()) : ''}
    ${state.accAddOpen    ? (options === null ? waiting : _renderAccountForm(null, 'add')) : ''}
    ${state.accViewRow !== null ? (viewAcc === null ? waiting : _renderAccountForm(viewAcc, 'view')) : ''}
    ${state.accEditRow !== null ? (editAcc === null || options === null ? waiting : _renderAccountForm(editAcc, 'edit')) : ''}
    <div id="accListRegion">${_listHtml()}</div>
  `;
  _attachEvents();
  _attachListEvents();
}

// Re-renders only the filter bar, summary and table, so typed form input survives
// a list response landing.
function _renderList() {
  const region = el('accListRegion');
  if (region === null) { _render(); return; }
  if (_accDDCleanup !== null) { _accDDCleanup(); _accDDCleanup = null; }
  _accMenuKey = null;
  region.innerHTML = _listHtml();
  _attachListEvents();
}

function _listHtml() {
  const response = state.views?.[LIST_VIEW];
  if (response?.ok !== true) {
    return _viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : '<p class="placeholder">Loading accounts…</p>';
  }
  const data = response.data;
  return `
    ${_viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : ''}
    ${_renderAccFilterBar(data)}
    ${_renderWarnings(response)}
    ${_renderNetWorth(data.summary, response.quote)}
    ${_renderTable(data, response.quote)}
    ${_renderPager(data)}`;
}

// ── Net worth summary (server-computed cards) ─────────────────────────────────

function _renderNetWorth(summary, quote) {
  if (summary.all_count === 0) return '';
  const sym = quote?.symbol ?? '';
  return `
    <div class="summary-grid" style="margin-bottom:20px">
      ${summary.cards.map(card => `
      <div class="summary-card">
        <div class="summary-card-label">${esc(card.label)}</div>
        <div class="summary-card-value ${card.tone === 'negative' ? 'negative' : 'positive'}">${card.value < 0 ? '−' : ''}${esc(sym)}${_fmtWhole(card.value)}</div>
      </div>`).join('')}
    </div>`;
}

function _renderWarnings(response) {
  const missing = (response.warnings ?? []).filter(warning => warning.code === 'missing_rate').flatMap(warning => warning.currencies);
  if (missing.length === 0) return '';
  return `<p class="field-hint" style="margin:0 0 12px">No exchange rate for ${esc(missing.join(', '))} — those balances are left out of the ${esc(response.quote?.currency ?? '')} totals.</p>`;
}

// ── Filter bar (facets from the server) ───────────────────────────────────────

function _statusLabel(values, facets) {
  if (values.length === facets.statuses.length) return 'All';
  if (values.length === 0) return 'None';
  return facets.statuses.filter(status => values.includes(status.value)).map(status => status.label).join(', ');
}

function _renderAccFilterBar(data) {
  const facets      = data.facets;
  const activeCount = data.active_filter_count;
  const f           = _accDraft !== null ? _accDraft : state.accFilters;
  const subTypes    = f.type === 'all' ? [] : (facets.sub_types_by_type[f.type] ?? []);
  const rs          = new Set(f.recordStatuses);
  const typeLabel    = f.type === 'all' ? 'All types' : (facets.types.find(type => type.value === f.type)?.label ?? f.type);
  const subTypeLabel = f.type === 'all' ? '— select type first —' : (f.subType === 'all' ? 'All sub-types' : (subTypes.find(s => s.value === f.subType)?.label ?? f.subType));
  const currLabel    = f.currency === 'all' ? 'All' : f.currency;

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
          radioRows('accFTypeR', [['all','All types'], ...facets.types.map(type => [type.value, type.label])], f.type))}
      </div>
      <div class="filter-row">
        <label>Sub-type</label>
        ${dd('accFSubTrigger','accFSubLabel','accFSubMenu', subTypeLabel,
          f.type === 'all' ? '' : radioRows('accFSubR', [['all','All sub-types'], ...subTypes.map(s => [s.value, s.label])], f.subType),
          f.type === 'all')}
      </div>
      <div class="filter-row">
        <label>Currency</label>
        ${dd('accFCurrTrigger','accFCurrLabel','accFCurrMenu', currLabel,
          radioRows('accFCurrR', [['all','All'], ...facets.currencies.map(c => [c.value, c.label])], f.currency))}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="accFSearch" placeholder="name, notes…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-row">
        <label>Status</label>
        ${dd('accFStatusTrigger','accFStatusLabel','accFStatusMenu', _statusLabel(f.recordStatuses, facets),
          facets.statuses.map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-acc-filter-rstat="${esc(s.value)}"${rs.has(s.value) ? ' checked' : ''}> ${esc(s.label)}</label>`
          ).join(''))}
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="accFClear">Clear</button>
        <button class="btn btn-primary btn-sm" id="accFSearchBtn">Apply</button>
      </div>
    </div>
  </div>`;
}

// ── CSV import panel ──────────────────────────────────────────────────────────

function _renderImportPanel() {
  const fileTypes = _optionsData()?.import_file_types ?? [];
  const typeOpts = fileTypes.map(({ value, label }) =>
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

// Renders the server's import outcome: file-level errors as a list, otherwise a
// summary plus a table of failed CSV lines.
function _renderImportResponse(response) {
  return renderImportResult(response);
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _optionTags(options, selected) {
  return options.map(option =>
    `<option value="${esc(option.value)}"${selected === option.value ? ' selected' : ''}>${esc(option.label)}</option>`
  ).join('');
}

function _subTypeOptsHtml(type, selected) {
  const opts = type === '' ? [] : (_optionsData()?.sub_types_by_type?.[type] ?? []);
  return `<option value="">— select —</option>` + _optionTags(opts, selected);
}

// a: an AccountRow from list_accounts_view (null on add).
function _renderAccountForm(a, mode) {
  const isAdd  = mode === 'add';
  const isView = mode === 'view';
  const pfx    = isAdd  ? 'accNew' : 'accEdit';
  const options = _optionsData();
  const v = val => esc(String(val));
  // View: every field read-only. Edit: only the row's server-listed editable fields.
  const editable = key => !isView && (isAdd || a.editable_fields.includes(key));
  const dis = key => editable(key) ? '' : ' disabled';

  const header = (!isAdd) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} — <strong>${esc(a.account_name)}</strong>
    </div>` : '';

  const typeField = isAdd
    ? `<select id="accNewType"><option value="">— select —</option>${_optionTags(options.types, '')}</select>`
    : `<input type="text" id="accEditType" value="${v(a.type_label)}" disabled>`;

  const subTypeField = isAdd
    ? `<select id="accNewSubType"><option value="">— select —</option></select>`
    : editable('sub_type')
      ? `<select id="accEditSubType">${_subTypeOptsHtml(a.type, a.sub_type)}</select>`
      : `<input type="text" id="accEditSubType" value="${v(a.sub_type_label)}" disabled>`;

  const recordStatusField = !isAdd ? `
      <div class="field">
        <label for="accEditRecordStatus">Record status</label>
        ${editable('record_status')
          ? `<select id="accEditRecordStatus">${_optionTags(a.statuses_for_edit, a.record_status)}</select>`
          : `<input type="text" value="${v(a.record_status_label)}" disabled>`}
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

  // Closing date: not shown on add; editable only when the server allows it
  const closingDateField = !isAdd ? `
    <div class="field">
      <label for="${pfx}ClosingDate">Closing date</label>
      ${editable('account_closing_date_local')
        ? `<input type="datetime-local" id="accEditClosingDate" value="${esc(a.account_closing_date_local ? String(a.account_closing_date_local).replace(' ', 'T').substring(0, 16) : '')}">`
        : `<input type="text" value="${v(_fmtDateDisplay(a.account_closing_date_local))}" disabled>`}
    </div>` : '';

  // Timezone: not shown on add (auto-detected from browser); read-only in view/edit
  const timezoneField = !isAdd ? `
    <div class="field">
      <label>Timezone</label>
      <input type="text" value="${v(a.local_timezone)}" disabled>
    </div>` : '';

  const syncStatusLine = isView ? `
    <div class="field-hint" style="margin-top:8px">
      Sync: ${syncStatusIcon(a.sync_status)} ${esc(a.sync_notes)}
    </div>` : '';

  const actions = isAdd ? [] : a.allowed_actions;
  return `
  <div class="card" style="margin-bottom:20px">
    ${header}

    <div class="form-grid form-grid-3" style="margin-bottom:16px">

      <div class="field">
        <label for="${pfx}Name">Account name${isAdd ? ' *' : ''}</label>
        <input type="text" id="${pfx}Name"
               value="${isAdd ? '' : v(a.account_name)}"
               ${isAdd ? 'placeholder="e.g. Barclays Current"' : ''}${dis('account_name')}>
      </div>
      <div class="field">
        <label for="${pfx}LegalEntity">Legal entity</label>
        <input type="text" id="${pfx}LegalEntity"
               value="${isAdd ? '' : v(a.legal_entity_name)}"
               ${isAdd ? 'placeholder="e.g. Barclays Bank UK"' : ''}${dis('legal_entity_name')}>
      </div>
      <div class="field">
        <label for="${pfx}Description">Notes</label>
        <input type="text" id="${pfx}Description"
               value="${isAdd ? '' : v(a.description)}"
               ${isAdd ? 'placeholder="Optional notes"' : ''}${dis('description')}>
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
        <select id="accNewCurrency">${_optionTags(options.currencies, '')}</select>
      </div>` : `
      <div class="field">
        <label>Currency</label>
        <input type="text" id="accEditCurrency" value="${v(a.currency)}" disabled>
      </div>
      ${timezoneField}
      ${closingDateField}
      <div class="field">
        <label>Opening value</label>
        <input type="text" value="${v(_signedText(a.opening.display_sign, a.currency_symbol, a.opening.native))}" disabled>
      </div>
      <div class="field">
        <label>Current value</label>
        <input type="text" value="${v(_signedText(a.balance.display_sign, a.currency_symbol, a.balance.native))}" disabled>
      </div>
      ${recordStatusField}`}

    </div>

    ${syncStatusLine}

    <div class="form-actions" style="margin-top:${isAdd ? '20' : '16'}px">
      ${isView
        ? `<button class="btn btn-secondary" id="accCancelView">Close</button>
           ${actions.includes('restore') ? `<button class="btn btn-primary" id="accViewRestore" data-row="${esc(a.id)}">Restore</button>` : ''}
           ${actions.includes('edit') ? `<button class="btn btn-primary" id="accViewToEdit" data-row="${esc(a.id)}">Edit</button>` : ''}`
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
          <span class="confirm-text">Cannot delete <strong>${esc(a.account_name)}</strong> — <strong>${esc(n)}</strong> ${noun} to this account.</span>
          <div style="color:var(--muted);font-size:var(--text-sm);margin-top:4px">
            Delete or reassign those transactions first, or deactivate the account instead.
          </div>
        <div class="row-actions">
          <button class="btn-link" data-action="acc-deactivate" data-row="${esc(a.id)}">Deactivate instead</button>
          <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
        </div>`;
    }
    return `<span class="confirm-text">Delete <strong>${esc(a.account_name)}</strong>? This marks the account as deleted.</span>
      <div class="row-actions">
        <button class="btn-link danger" data-action="acc-confirm-delete" data-row="${esc(a.id)}">Yes, delete</button>
        <button class="btn-link" data-action="acc-cancel-delete">Cancel</button>
      </div>`;
}

function _rowStyle(a) {
  return (a.record_status === 'deleted' || a.record_status === 'inactive') ? ' style="opacity:0.5"'
       : a.record_status === 'locked' ? ' style="opacity:0.7"'
       : '';
}

// Native balance with the server's sign, plus the quote amount for foreign currencies.
function _balanceCell(a, quote) {
  const b = a.balance;
  if (b.native === null) return '<span class="muted">—</span>';
  const baseTag = b.is_foreign
    ? ` <span class="td-base-amt">${b.quote === null ? '—' : esc(quote?.symbol ?? '') + _fmtBal(b.quote)}</span>`
    : '';
  return _signed(b.display_sign, a.currency_symbol, b.native, _fmtBal) + baseTag;
}

function _renderAccountRow(a, quote) {
  if (state.accDeleteRow === a.id) {
    return `<tr${_rowStyle(a)}><td colspan="5">${_renderAccountDelete(a)}</td></tr>`;
  }
  return `<tr${_rowStyle(a)}>
    <td>${esc(a.account_name)}${a.description !== '' ? `<span class="info-icon-wrap"><span style="cursor:help;color:var(--teal);font-size:13px">ⓘ</span><span class="info-tooltip">${esc(a.description)}</span></span>` : ''}</td>
    <td style="color:var(--muted);font-size:12px">${esc(a.sub_type_label)}</td>
    <td>${esc(a.currency)}</td>
    <td>${_balanceCell(a, quote)}</td>
    <td><div style="display:flex;align-items:center;justify-content:flex-end;gap:5px">
      ${recordStatusIcon(a.record_status)}${syncStatusIcon(a.sync_status)}
      <button class="tx-menu-trigger" data-action="acc-menu" data-row="${esc(a.id)}" title="Actions">⋮</button>
    </div></td>
  </tr>`;
}

function _groupHeader(group, quote) {
  const total = group.total;
  const owed = total.display_sign === 'owed' || total.display_sign === 'negative';
  const missing = total.missing_currencies.length > 0 ? ` <span title="No rate for ${esc(total.missing_currencies.join(', '))}">*</span>` : '';
  return `<tr class="acc-group-header">
    <td colspan="5" style="background:var(--canvas);padding:10px 12px 4px;font-size:11px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:none">
      ${esc(group.label)}
      <span style="float:right;font-weight:600;color:${group.is_liability ? 'var(--ember)' : 'var(--teal)'}">${owed ? '−' : ''}${esc(quote?.symbol ?? '')}${_fmtWhole(total.quote)}${missing}</span>
    </td>
  </tr>`;
}

function _thSort(col, label, width) {
  const cls = _sort.col === col ? ` class="sort-${_sort.dir}"` : '';
  return `<th style="width:${width}px"${cls} data-acc-sort="${esc(col)}">${esc(label)}</th>`;
}

function _renderTable(data, quote) {
  if (data.total === 0) {
    if (data.summary.all_count === 0) return `<p class="placeholder">No accounts yet. Use &ldquo;+ Add&rdquo; to create one.</p>`;
    return `<p class="placeholder">No accounts match the current filters.</p>`;
  }

  const bodyRows = data.groups.map(group =>
    _groupHeader(group, quote) + group.rows.map(row => _renderAccountRow(row, quote)).join('')
  ).join('');

  const cardSections = data.groups.map(group => [
    `<div class="acc-card-group">${esc(group.label)}</div>`,
    ...group.rows.map(a => {
      if (state.accDeleteRow === a.id) return `<div class="card record-confirm-card">${_renderAccountDelete(a)}</div>`;
      return `<div class="acc-card"${_rowStyle(a)}>
        <div class="acc-card-body">
          <div class="acc-card-name">${esc(a.account_name)}</div>
          <div class="acc-card-meta">${esc(a.sub_type_label)} · ${esc(a.currency)}</div>
        </div>
        <div class="acc-card-bal">${_balanceCell(a, quote)}</div>
        <div style="display:flex;align-items:center;gap:6px">
          ${recordStatusIcon(a.record_status)} ${syncStatusIcon(a.sync_status)}
          <button class="tx-menu-trigger acc-card-menu" data-action="acc-menu" data-row="${esc(a.id)}" title="Actions">⋮</button>
        </div>
      </div>`;
    }),
  ].join('')).join('');

  return `
    <div class="table-wrap acc-table-wrap">
      <table class="acc-table">
        <thead><tr>
          ${_thSort('account_name', 'Name', 160)}
          ${_thSort('sub_type', 'Sub-type', 160)}
          ${_thSort('currency', 'CCY', 70)}
          ${_thSort('balance', 'Balance', 160)}
          <th style="width:64px"></th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="acc-cards">${cardSections}</div>`;
}

function _renderPager(data) {
  if (data.pages <= 1) return '';
  return `
    <div class="pagination">
      <button class="btn btn-secondary btn-sm" id="accPrevPage" ${data.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${esc(data.page)} of ${esc(data.pages)} (${esc(data.total)} accounts)</span>
      <button class="btn btn-secondary btn-sm" id="accNextPage" ${data.page >= data.pages ? 'disabled' : ''}>Next →</button>
    </div>`;
}

// ── Type-change handler: repopulate sub_type dropdown (Add form) ──────────────

function _refreshAddTypeUI() {
  const typeEl = el('accNewType');
  const type   = typeEl ? typeEl.value : '';
  const subSel = el('accNewSubType');
  if (subSel !== null) subSel.innerHTML = _subTypeOptsHtml(type, '');
}

// ── Events ────────────────────────────────────────────────────────────────────

const _MENU_LABELS = { view: 'View', edit: 'Edit', transactions: 'Transactions', restore: 'Restore', delete: 'Delete' };

function _openRow(key, row) {
  if (key === 'view')    { state.accViewRow = row; state.accEditRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; _render(); }
  if (key === 'edit')    { state.accEditRow = row; state.accViewRow = null; state.accDeleteRow = null; state.accDeleteBlocked = null; state.accAddOpen = false; _render(); }
  if (key === 'delete')  { state.accDeleteRow = row; state.accViewRow = null; state.accEditRow = null; state.accDeleteBlocked = null; _render(); }
  if (key === 'restore') { _restoreAccount(row); }
  if (key === 'transactions') {
    const acc = _rowById(row);
    if (acc !== null) {
      state.filters = { types: [], accounts: [acc.id], major: [], minor: [], user_location_country: '', tag: '', search: '' };
      document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
    }
  }
}

function _attachEvents() {
  el('accImportBtn').addEventListener('click', () => {
    if (_importBusy) return;
    if (state.accImportOpen) {
      state.accImportOpen = false;
      _resetImport();
    } else {
      state.accImportOpen = true;
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    }
    _render();
  });

  el('accAddBtn').addEventListener('click', () => {
    if (_importBusy) return;
    if (state.accAddOpen || state.accViewRow !== null || state.accEditRow !== null) {
      state.accAddOpen = false;
      state.accViewRow = null;
      state.accEditRow = null;
    } else {
      state.accAddOpen = true;
      state.accImportOpen = false;
      _resetImport();
    }
    _render();
  });

  if (state.accImportOpen && el('accImportType') !== null) {
    el('accImportType').addEventListener('change', e => {
      _importType = e.target.value;
      _updateImportConfirmState();
    });

    el('accImportFile').addEventListener('change', e => {
      _importFile = e.target.files[0] ?? null;
      _importResult = '';
      el('accImportStatus').innerHTML = '';
      _updateImportConfirmState();
    });
    el('accImportConfirm').addEventListener('click', () => {
      if (_importFile !== null && _importType !== '') _submitImport(_importType, _importFile);
    });

    _updateImportConfirmState();
    el('accImportCancel').addEventListener('click', () => {
      if (_importBusy) return;
      state.accImportOpen = false;
      _resetImport();
      _render();
    });
  }

  if (state.accAddOpen && el('accSaveNew') !== null) {
    el('accSaveNew').addEventListener('click', _saveNew);
    el('accCancelNew').addEventListener('click', () => { state.accAddOpen = false; _render(); });
    el('accNewType').addEventListener('change', _refreshAddTypeUI);
    _refreshAddTypeUI();
  }

  if (state.accEditRow !== null && el('accSaveEdit') !== null) {
    el('accSaveEdit').addEventListener('click', _saveEdit);
    el('accCancelEdit').addEventListener('click', () => { state.accEditRow = null; _render(); });
  }

  if (state.accViewRow !== null && el('accCancelView') !== null) {
    el('accCancelView').addEventListener('click', () => { state.accViewRow = null; _render(); });
    const viewToEditEl = el('accViewToEdit');
    if (viewToEditEl !== null) viewToEditEl.addEventListener('click', e => {
      const row = e.currentTarget.dataset.row;
      state.accViewRow = null;
      state.accEditRow = row;
      _render();
    });
    const viewRestoreEl = el('accViewRestore');
    if (viewRestoreEl !== null) viewRestoreEl.addEventListener('click', e => {
      const row = e.currentTarget.dataset.row;
      state.accViewRow = null;
      _restoreAccount(row);
    });
  }

  el('accExportBtn').addEventListener('click', () => {
    openContextMenu(el('accExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => { _exportAccounts(key); });
  });
}

// Every account, all statuses, in the account_master import columns
// (export_accounts); filters do not apply, so the file is a restore point.
async function _exportAccounts(format) {
  showLoading();
  try {
    const res = await ExpenseAPI.view('export_accounts');
    if (res?.ok !== true) { showMsg(res?.message || 'Export failed: ' + (res?.error ?? 'unknown_error'), 'warn'); return; }
    if (!Array.isArray(res.data?.rows) || res.data.rows.length === 0) { showMsg('No accounts to export.', 'warn'); return; }
    downloadExport(format, res.data);
  } catch (err) {
    console.error('[accounts] export failed:', err);
    showMsg('Connection error. The export could not be prepared.', 'warn');
  } finally {
    hideLoading();
  }
}

// List region events: row menus, sort headers, pager and the filter bar.
function _attachListEvents() {
  const region = el('accListRegion');
  const data = _viewData();
  if (region === null || data === null) return;

  const handleAccAction = e => {
    const btn    = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row ? btn.dataset.row : null;
    const acc    = row === null ? null : _rowById(row);
    if (action === 'acc-menu') {
      if (_accMenuKey === row) { closeContextMenu(); _accMenuKey = null; return; }
      if (acc === null) return;
      _accMenuKey = row;
      const menuItems = acc.allowed_actions.map(key => ({ key, label: _MENU_LABELS[key] ?? key, cls: key === 'delete' ? 'danger' : '' }));
      openContextMenu(btn, menuItems, key => { _accMenuKey = null; _openRow(key, row); });
      return;
    }
    if (action === 'acc-cancel-delete')  { state.accDeleteRow = null; state.accDeleteBlocked = null; _render(); }
    if (action === 'acc-confirm-delete') { _confirmDelete(row); }
    if (action === 'acc-deactivate')     { _deactivateAccount(row); }
  };

  const tableWrap = region.querySelector('.acc-table-wrap');
  if (tableWrap !== null) tableWrap.addEventListener('click', handleAccAction);
  const cards = region.querySelector('.acc-cards');
  if (cards !== null) cards.addEventListener('click', handleAccAction);

  region.querySelectorAll('th[data-acc-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.accSort;
      _sort = { col, dir: _sort.col === col && _sort.dir === 'asc' ? 'desc' : 'asc' };
      _page = 1;
      _renderList();
      _loadView();
    });
  });
  el('accPrevPage')?.addEventListener('click', () => { _page = Math.max(1, data.page - 1); _loadView(); });
  el('accNextPage')?.addEventListener('click', () => { _page = data.page + 1; _loadView(); });

  // Filter toggle
  el('accFilterToggle').addEventListener('click', () => {
    state.accFilterOpen = !state.accFilterOpen;
    if (state.accFilterOpen && _accDraft === null) {
      _accDraft = { ...state.accFilters, recordStatuses: [...state.accFilters.recordStatuses] };
    }
    _renderList();
  });

  if (!state.accFilterOpen) return;
  if (_accDraft === null) {
    _accDraft = { ...state.accFilters, recordStatuses: [...state.accFilters.recordStatuses] };
  }
  const facets = data.facets;

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

  // Type — delegation; also repopulates sub-type menu from the server facets
  const typeMenu = el('accFTypeMenu');
  if (typeMenu !== null) {
    typeMenu.addEventListener('change', e => {
      const radio = e.target.closest('input[type="radio"]');
      if (radio === null) return;
      const val = radio.value;
      if (_accDraft !== null) { _accDraft.type = val; _accDraft.subType = 'all'; }
      const lbl = el('accFTypeLabel');
      if (lbl !== null) lbl.textContent = val === 'all' ? 'All types' : (facets.types.find(type => type.value === val)?.label ?? val);
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
        const subs = facets.sub_types_by_type[val] ?? [];
        if (subTrig !== null) { subTrig.disabled = false; subTrig.style.opacity = ''; subTrig.style.cursor = ''; }
        if (subLbl !== null)  subLbl.textContent = 'All sub-types';
        if (subMenu !== null) subMenu.innerHTML = [['all','All sub-types'], ...subs.map(s => [s.value, s.label])].map(([v, l]) =>
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
      const subs = _accDraft === null ? [] : (facets.sub_types_by_type[_accDraft.type] ?? []);
      if (lbl !== null) lbl.textContent = val === 'all' ? 'All sub-types' : (subs.find(s => s.value === val)?.label ?? val);
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
      if (lbl !== null) lbl.textContent = _statusLabel(checked, facets);
    });
  }

  // Keep typed search text in the draft so a landing response cannot erase it.
  el('accFSearch').addEventListener('input', e => { if (_accDraft !== null) _accDraft.search = e.target.value; });

  const _applyAccDraft = () => {
    if (_accDraft !== null) {
      _accDraft.search = el('accFSearch').value.trim();
      state.accFilters = { ..._accDraft, recordStatuses: [..._accDraft.recordStatuses] };
      _accDraft = null;
    }
    _page = 1;
    _renderList();
    _loadView();
  };
  el('accFSearchBtn').addEventListener('click', _applyAccDraft);
  el('accFSearch').addEventListener('keydown', e => { if (e.key === 'Enter') _applyAccDraft(); });

  el('accFClear').addEventListener('click', () => {
    _accDraft = null;
    state.accFilters = {
      type: 'all', subType: 'all', currency: 'all', search: '',
      recordStatuses: facets.statuses.map(status => status.value),
    };
    _page = 1;
    _renderList();
    _loadView();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _v(id) {
  const domEl = el(id);
  if (domEl === null) throw new Error('[accounts] _v: element not found: ' + id);
  return domEl.value;
}

// ── Server errors ─────────────────────────────────────────────────────────────
// The server's `message` wins; this copy covers codes returned without one.
const _ACCOUNT_ERROR_TEXT = {
  stale_record: 'This record moved or changed. Refresh, then reopen it before trying again.',
  record_locked: 'This account is locked and cannot be edited.',
  duplicate_account: 'An account with this name already exists.',
  missing_account_name: 'Account name is required.',
  invalid_account_type: 'Type is required.',
  missing_sub_type: 'Sub-type is required.',
  invalid_sub_type: 'Choose a sub-type for this type.',
  missing_local_currency: 'Currency is required.',
  invalid_local_currency: 'Currency must be a three-letter code.',
  unknown_currency: 'Currency is not in Rates. Add it there first.',
  missing_opening_date_local: 'Opening date is required.',
  invalid_account_opening_date_local: 'Enter a valid opening date.',
  invalid_account_closing_date_local: 'Closing date must be a valid date on or after the opening date.',
  invalid_tracking_start_date_local: 'Enter a valid tracking start date.',
  missing_opening_value_local: 'Opening value is required.',
  invalid_opening_value_local: 'Opening value must be a finite number.',
};

function _accountErrorText(res, prefix) {
  if (typeof res?.message === 'string' && res.message !== '') return res.message;
  const code = res?.error ?? 'unknown';
  return _ACCOUNT_ERROR_TEXT[code] ?? prefix + code;
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

  // validateAccountCreate (server) checks every field; the form submits as entered.
  errEl.textContent = '';
  const ovStr = _v('accNewOpeningValue').trim();

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
      errEl.textContent = _accountErrorText(res, 'Error: ');
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
  const accountId = state.accEditRow;
  if (accountId === null || accountId === undefined) return;
  const acc = _rowById(accountId);
  if (acc === null) return;

  const account_name = el('accEditName').value.trim();
  const errEl        = el('accEditError');
  errEl.textContent = '';

  const subTypeEl      = el('accEditSubType');
  const closingDateEl  = el('accEditClosingDate');
  // id + updated_at bind the edit to the row on screen (server stale_record check).
  const payload = {
    id:            acc.id,
    updated_at:    acc.updated_at,
    row_num:       acc.row_num,
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
      errEl.textContent = _accountErrorText(res, 'Update failed: ');
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

async function _confirmDelete(accountId) {
  const acc = _rowById(accountId);
  if (acc === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.deleteAccount({ id: acc.id, updated_at: acc.updated_at, row_num: acc.row_num });
    if (res.ok) {
      showMsg('Account marked as deleted.');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else if (res.error === 'record_locked') {
      showMsg('This account is locked and cannot be deleted.', 'warn');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      _render();
    } else if (res.error === 'account_in_use') {
      // Backend refused because transactions reference this account.
      // Keep the row in delete-confirm state, switch to the blocked variant
      // which offers a "Deactivate instead" CTA.
      state.accDeleteBlocked = { referenced_count: res.referenced_count };
      _render();
    } else {
      console.warn('[accounts] _confirmDelete failed:', res.error);
      showMsg('Delete failed: ' + ((res.error !== undefined && res.error !== null) ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : 'unknown'), 'warn');
      state.accDeleteRow = null;
      state.accDeleteBlocked = null;
      _render();
    }
  } catch (_) {
    console.error('[accounts] _confirmDelete failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    state.accDeleteRow = null;
    state.accDeleteBlocked = null;
    _render();
  } finally {
    hideLoading();
  }
}

// Deactivate (record_status = inactive) — invoked from the blocked-deletion CTA.
async function _deactivateAccount(accountId) {
  const acc = _rowById(accountId);
  if (acc === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateAccount({
      id:            acc.id,
      updated_at:    acc.updated_at,
      row_num:       acc.row_num,
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
      _render();
    }
  } catch (_) {
    console.error('[accounts] _deactivateAccount failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    state.accDeleteBlocked = null;
    state.accDeleteRow = null;
    _render();
  } finally {
    hideLoading();
  }
}

async function _restoreAccount(accountId) {
  const acc = _rowById(accountId);
  if (acc === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.restoreAccount({ id: acc.id, updated_at: acc.updated_at, row_num: acc.row_num });
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
      _render();
    }
  } catch (_) {
    console.error('[accounts] _restoreAccount failed:', _);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    _render();
  } finally {
    hideLoading();
  }
}

function _resetImport() {
  _importFile   = null;
  _importType   = '';
  _importResult = '';
}

// Enable the Import button only when BOTH a file_type and a file are chosen.
function _updateImportConfirmState() {
  const button = el('accImportConfirm');
  if (button !== null) {
    button.disabled = _importBusy || _importFile === null || _importType === '';
    button.textContent = _importBusy ? 'Importing…' : 'Import';
  }
  for (const id of ['accImportFile', 'accImportType', 'accImportCancel', 'accImportBtn', 'accAddBtn']) {
    const control = el(id);
    if (control !== null) control.disabled = _importBusy;
  }
}

// Sends the raw file text; the server parses, validates and imports it.
async function _submitImport(fileType, file) {
  if (_importBusy) return;
  if (fileType === '') { showMsg('Select a file type first.', 'warn'); return; }
  if (file === null || file === undefined) { showMsg('Choose a CSV file first.', 'warn'); return; }
  _importBusy = true;
  _updateImportConfirmState();
  showLoading();
  let changed = false;
  let uncertain = false;
  try {
    let csv;
    try { csv = await file.text(); }
    catch (_) {
      _importResult = '<p class="pin-error" role="alert">Could not read this CSV. Choose the file again.</p>';
      return;
    }
    const response = await ExpenseAPI.importAccountData({ file_type: fileType, csv });
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      _importResult = _renderImportResponse(response);
      showMsg('The CSV has errors. Nothing was imported.', 'warn');
      return;
    }
    if (!Array.isArray(response?.results) || !response.results.every(result => typeof result?.ok === 'boolean')) {
      if (response?.ok === false && typeof response.error === 'string' && !Array.isArray(response.results)) {
        _importResult = `<p class="pin-error" role="alert">Import failed: ${esc(response.error)}. Nothing was imported.</p>`;
        showMsg(`Import failed: ${response.error}`, 'warn');
        return;
      }
      throw new Error(response?.error ?? 'incomplete_import_response');
    }
    const failures = response.results.filter(result => !result.ok);
    changed = failures.length < response.results.length;
    if (failures.length === 0) {
      _resetImport();
      state.accImportOpen = false;
      showMsg(`${response.created ?? 0} created · ${response.updated ?? 0} updated`);
    } else {
      _importResult = _renderImportResponse(response);
      showMsg(`${failures.length} account rows failed. Review the failed lines, correct the file and import it again.`, 'warn');
    }
  } catch (error) {
    uncertain = true;
    const message = `Import stopped: ${error?.message ?? 'connection_error'}. Some rows may have been saved. Refresh and check before importing the file again.`;
    _importResult = `<p class="pin-error" role="alert">${esc(message)}</p>`;
    showMsg(message, 'warn');
  } finally {
    _importBusy = false;
    // Every attempt re-reads a freshly chosen file; nothing from this one is retried.
    _importFile = null;
    const input = el('accImportFile');
    if (input !== null) input.value = '';
    const status = el('accImportStatus');
    if (status !== null) status.innerHTML = _importResult;
    _updateImportConfirmState();
    if (changed || uncertain) document.dispatchEvent(new CustomEvent('et:reload'));
    hideLoading();
  }
}
