import { state } from '../core/state.js';
import { ExpenseAPI } from '../core/api.js';
import { el, esc, fmtDateTime, todayISO, downloadExport, recordStatusIcon, syncStatusIcon, openContextMenu, closeContextMenu, renderImportResult, importErrorText } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';

const SYSTEM_FIELDS = new Set(['id', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at']);

function _closePanel() {
  state.accountTypePanel = null;
  state.accountTypeDraft = {};
  state.accountTypeViewId = null;
  state.accountTypeDeleteId = null;
  state.accountTypeImport = null;
  state.accountTypeExport = null;
}

function _options(options, selected) {
  return options.map(option => {
    const value = typeof option === 'string' ? option : option.value;
    const label = typeof option === 'string' ? option : option.label;
    return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

// Edit layout: [field key, grid span]. Labels, types and choices come from the schema.
const EDIT_LAYOUT = [['account_type_label', 2], ['account_subtype_label', 2], ['description', 4], ['detail_sheet', 2], ['record_status', 2]];

function _field(key) {
  return state.accountTypeSchema.fields.find(field => field.key === key);
}

function _fieldLabel(key) {
  return _field(key)?.label ?? key;
}

// row: a list_account_types_view row (copied into state.accountTypeDraft), so
// readonly_fields / statuses_for_edit / has_accounts come from the server.
function _formHtml(row) {
  const locked = row.record_status === 'locked';
  const readonlyFields = row.readonly_fields ?? [];
  const schema = state.accountTypeSchema;
  const editable = schema.fields.filter(field => field.editable !== false && !SYSTEM_FIELDS.has(field.key));
  const layout = [...EDIT_LAYOUT.filter(([key]) => editable.some(field => field.key === key)),
    ...editable.filter(field => !EDIT_LAYOUT.some(([key]) => key === field.key)).map(field => [field.key, 1])];
  const fieldsHtml = layout.map(([key, span]) => {
    const field = _field(key);
    const value = String(row[key] ?? '');
    const readonly = readonlyFields.includes(key);
    const required = field.required;
    const attributes = `id="at-${esc(key)}" name="${esc(key)}"${readonly ? ' disabled' : ''}${required ? ' required' : ''}`;
    const spanClass = span === 4 ? ' form-grid-full' : span > 1 ? ` form-grid-span-${span}` : '';
    let input;
    if (key === 'record_status') {
      input = `<select ${attributes}>${_options(row.statuses_for_edit ?? [], value)}</select>`;
    } else if (key === 'detail_sheet') {
      input = `<select ${attributes}>${_options([{ value: '', label: 'None' }, ...(schema.detail_sheets ?? [])], value)}</select>`;
    } else if (key === 'description') {
      input = `<textarea ${attributes} rows="2">${esc(value)}</textarea>`;
    } else {
      input = `<input type="text" ${attributes} value="${esc(value)}">`;
    }
    const hint = key === 'detail_sheet' && row.has_accounts === true ? '<div class="field-hint">Fixed while accounts use this type.</div>' : '';
    return `<div class="field${spanClass}"><label for="at-${esc(key)}">${esc(field.label)}${required ? ' *' : ''}</label>${input}${hint}</div>`;
  }).join('');
  return `<form class="card configure-panel" id="accountTypeForm" novalidate>
    <div class="cat-form-header">Editing — <strong>${esc(row.account_type_label)} › ${esc(row.account_subtype_label)}</strong></div>
    ${locked ? '<p class="field-hint configure-hint">Unlock this type by changing its status before editing its details.</p>' : ''}
    <div class="form-grid form-grid-4 configure-form-grid">${fieldsHtml}</div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">Save</button>
      <button class="btn btn-secondary" type="button" data-action="at-close">Cancel</button>
    </div><p class="pin-error" id="accountTypeError" role="alert"></p>
  </form>`;
}

function _titleCase(value) {
  return value === '' ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function _viewItem(key, value, mono = false) {
  const text = value === '' ? '—' : value;
  return `<div class="acc-view-field"><span class="acc-view-label">${esc(_fieldLabel(key))}</span><span class="acc-view-val${mono ? ' configure-mono' : ''}">${esc(text)}</span></div>`;
}

function _viewHtml(row) {
  const next = _menuItems(row).find(item => item.key === 'at-edit' || item.key === 'at-restore');
  return `<div class="card configure-panel">
    <div class="cat-form-header configure-view-head"><span>Viewing — <strong>${esc(row.account_type_label)} › ${esc(row.account_subtype_label)}</strong></span>
      <span class="configure-row-actions">${recordStatusIcon(row.record_status)}${syncStatusIcon(row.sync_status)}</span></div>
    ${row.description === '' ? '' : `<p class="configure-view-desc">${esc(row.description)}</p>`}
    <div class="cat-section-divider">Classification</div>
    <div class="configure-view-grid">
      ${_viewItem('account_type_label', row.account_type_label)}
      ${_viewItem('account_subtype_label', row.account_subtype_label)}
      ${_viewItem('detail_sheet', row.detail_sheet === '' ? 'None' : row.detail_sheet, true)}
      ${_viewItem('record_status', row.record_status_label)}
    </div>
    <div class="cat-section-divider">Sync &amp; audit</div>
    <div class="configure-view-grid">
      ${_viewItem('sync_status', row.sync_status, true)}
      ${_viewItem('sync_date', row.sync_date === '' ? '' : fmtDateTime(row.sync_date))}
      ${_viewItem('created_at', row.created_at === '' ? '' : fmtDateTime(row.created_at))}
      ${_viewItem('updated_at', row.updated_at === '' ? '' : fmtDateTime(row.updated_at))}
      ${row.sync_notes === '' ? '' : `<div class="configure-view-span">${_viewItem('sync_notes', row.sync_notes)}</div>`}
      <div class="configure-view-span">${_viewItem('id', row.id, true)}</div>
    </div>
    <div class="form-actions">
      ${next === undefined ? '' : `<button class="btn btn-primary" type="button" data-action="${next.key}" data-id="${esc(row.id)}">${esc(next.label)}</button>`}
      <button class="btn btn-secondary" type="button" data-action="at-close">Close</button>
    </div>
  </div>`;
}

function _previewHtml(rows) {
  if (rows.length === 0) return '';
  return `<div class="table-wrap configure-preview"><table><thead><tr><th>Type</th><th>Subtype</th><th>Detail sheet</th><th>Status</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.account_type_label)}</td><td>${esc(row.account_subtype_label)}</td><td class="td-mono">${esc(row.detail_sheet === '' ? '—' : row.detail_sheet)}</td><td>${esc(_titleCase(row.record_status))}</td></tr>`).join('')}</tbody></table></div>`;
}

// state.accountTypeImport holds the last server outcome: { filename, result }.
function _importHtml() {
  return `<div class="card configure-panel">
    <div class="cat-form-header">Import account types</div>
    <p class="field-hint configure-hint">Import an account_types CSV — the supplied catalog on first setup, or a file from Export to restore. The server checks the whole file before saving anything. Rows are matched by UUID; classification keys cannot change.</p>
    <div class="field"><label for="accountTypeFile">CSV file</label><input id="accountTypeFile" type="file" accept=".csv,text/csv"></div>
    <div id="accountTypeImportResult" aria-live="polite">${_importResultHtml(state.accountTypeImport)}</div>
    <div class="form-actions"><button class="btn btn-primary" id="accountTypeImportBtn" data-action="at-import-confirm" disabled>Import</button><button class="btn btn-secondary" data-action="at-close">${state.accountTypeImport?.result.ok === true ? 'Close' : 'Cancel'}</button></div>
  </div>`;
}

// Export always covers the whole catalog, whatever the filters, so the file is a
// complete restore point. The rows, 13 columns and requires_migration flag come
// from export_account_types, fetched when the panel opens.
let _exportSeq = 0;

async function _loadExport() {
  const seq = ++_exportSeq;
  let response;
  try { response = await ExpenseAPI.view('export_account_types'); }
  catch (error) { console.error('[configure] export_account_types failed:', error); response = null; }
  if (seq !== _exportSeq || state.accountTypePanel !== 'export') return;
  state.accountTypeExport = response?.ok === true
    ? { data: response.data, error: '' }
    : { data: null, error: response?.message || 'The export could not be prepared. Check your connection and try again.' };
  _render();
}

function _exportHtml() {
  const loaded = state.accountTypeExport;
  const data = loaded?.data ?? null;
  const body = data === null
    ? `<p class="${loaded?.error ? 'pin-error' : 'field-hint configure-hint'}"${loaded?.error ? ' role="alert"' : ''}>${esc(loaded?.error || 'Preparing the export…')}</p>`
    : `<p class="field-hint configure-hint">${data.requires_migration
      ? 'This catalog still uses legacy underscore keys, so this download is a reference copy only and cannot be re-imported. Import the updated account_types CSV first, then export a restorable backup.'
      : `Downloads the complete catalog in the exact format Import accepts — every status, all ${data.columns.length} columns and existing UUIDs. Keep it as a backup and import it here to restore.`}</p>
    <p class="cat-count configure-file-meta">${esc(data.filename)}-${esc(todayISO())}.csv · ${data.count} ${data.count === 1 ? 'record' : 'records'} · ${data.columns.length} columns</p>
    ${_previewHtml(data.rows.slice(0, 5))}`;
  return `<div class="card configure-panel">
    <div class="cat-form-header">Export account types</div>
    ${body}
    <div class="form-actions"><button class="btn btn-primary" data-action="at-export-confirm"${data === null || data.count === 0 ? ' disabled' : ''}>↓ Download CSV</button><button class="btn btn-secondary" data-action="at-close">Cancel</button></div>
  </div>`;
}

function _rowControls(row) {
  return `<div class="configure-row-actions">${recordStatusIcon(row.record_status)}${syncStatusIcon(row.sync_status)}
    <button class="tx-menu-trigger" aria-label="Actions for ${esc(row.account_subtype_label)}" data-action="at-menu" data-id="${esc(row.id)}">⋮</button></div>`;
}

function _deleteHtml(row) {
  return `<span class="confirm-text">Delete <strong>${esc(row.account_subtype_label)}</strong>?</span>
    <div class="row-actions"><button class="btn-link danger" data-action="at-confirm-delete" data-id="${esc(row.id)}">Yes, delete</button><button class="btn-link muted" data-action="at-cancel-delete">Cancel</button></div>`;
}

function _tableHtml(rows, totalAll) {
  if (rows.length === 0) {
    return `<p class="placeholder">${totalAll === 0 ? 'Import the account_types CSV to configure the existing classifications.' : 'No account types for this filter.'}</p>`;
  }
  const tableRows = rows.map(row => state.accountTypeDeleteId === row.id
    ? `<tr><td colspan="4">${_deleteHtml(row)}</td></tr>`
    : `<tr${row.record_status === 'active' ? '' : ' class="configure-archived"'}>
      <td>${esc(row.account_type_label)}</td><td class="td-name">${esc(row.account_subtype_label)}</td>
      <td class="configure-description">${esc(row.description)}</td><td>${_rowControls(row)}</td></tr>`).join('');
  const cards = rows.map(row => `<div class="cat-card${row.record_status === 'active' ? '' : ' is-archived'}">${state.accountTypeDeleteId === row.id
    ? _deleteHtml(row)
    : `<div class="cat-card-top"><div class="cat-card-name"><span class="cat-card-major">${esc(row.account_type_label)}</span><span class="cat-card-sep">›</span><span class="cat-card-minor">${esc(row.account_subtype_label)}</span></div>${_rowControls(row)}</div>${row.description === '' ? '' : `<div class="configure-card-desc">${esc(row.description)}</div>`}`}</div>`).join('');
  return `<div class="table-wrap cat-table-wrap"><table><thead><tr><th>Type</th><th>Subtype</th><th>Description</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="cat-cards">${cards}</div>`;
}

function _filtersHtml(data) {
  const draft = state.accountTypeFilterDraft ?? { search: state.accountTypeSearch, status: state.accountTypeStatus, type: state.accountTypeFilterType };
  const count = data.active_filter_count;
  return `<div class="filter-bar"><button class="filter-toggle" data-action="at-filter-toggle" aria-expanded="${state.accountTypeFilterOpen}">Filters${count > 0 ? ` (${count})` : ''}<span class="filter-arrow">${state.accountTypeFilterOpen ? '▲' : '▼'}</span></button>
    <form class="filter-body${state.accountTypeFilterOpen ? '' : ' hidden'}" id="accountTypeFilters">
      <div class="filter-row"><label for="accountTypeFilterType">Type</label><select id="accountTypeFilterType">${_options([{ value: 'all', label: 'All types' }, ...data.facets.types], draft.type)}</select></div>
      <div class="filter-row"><label for="accountTypeSearch">Search</label><input id="accountTypeSearch" type="text" value="${esc(draft.search)}" placeholder="label, key, description…"></div>
      <div class="filter-row"><label for="accountTypeStatus">Status</label><select id="accountTypeStatus">${_options([{ value: 'all', label: 'All statuses' }, ...data.facets.statuses], draft.status)}</select></div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Apply</button><button class="btn btn-secondary btn-sm" type="button" data-action="at-filter-clear">Clear</button></div>
    </form></div>`;
}

// The server filters, sorts and flags the rows (list_account_types_view).
const LIST_VIEW = 'list_account_types_view';
let _viewSeq = 0;
let _viewError = '';
let _panelWaiting = false;

function _viewData() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true ? response.data : null;
}

function _viewRow(id) {
  return (_viewData()?.rows ?? []).find(row => row.id === id);
}

async function _loadView() {
  const seq = ++_viewSeq;
  let response;
  // Every list request (open, filter, sort, page) shows the loader, as on Transactions.
  showLoading();
  try {
    response = await ExpenseAPI.view(LIST_VIEW, {
      search: state.accountTypeSearch, status: state.accountTypeStatus === 'all' ? '' : state.accountTypeStatus,
      type: state.accountTypeFilterType === 'all' ? '' : state.accountTypeFilterType,
    });
  } catch (error) { console.error('[configure] list view failed:', error); response = null; }
  finally { hideLoading(); }
  if (seq !== _viewSeq) return;
  if (response?.ok !== true) _viewError = response?.message || 'Account types could not be loaded. Check your connection and refresh.';
  else { _viewError = ''; state.views[LIST_VIEW] = response; }
  // Only the list region re-renders, so a chosen import file or typed edits survive.
  if (_panelWaiting) _render(); else _renderList();
}

// Navigation and reloads: render the last payload, then refresh it.
export function renderConfigure() {
  if (state.views === undefined || state.views === null) state.views = {};
  _render();
  if (state.accountTypeSchema !== null) _loadView();
}

function _render() {
  closeContextMenu();
  const content = el('configureContent');
  if (state.accountTypeSchema === null) {
    content.innerHTML = '<p class="placeholder">Account type configuration unavailable. Reload to try again.</p>';
    return;
  }
  const view = _viewRow(state.accountTypeViewId);
  _panelWaiting = state.accountTypePanel === 'view' && view === undefined;
  content.innerHTML = `<div class="add-form-wrap configure-module">
    <button class="add-form-toggle" data-action="at-toggle" aria-expanded="${state.accountTypesOpen}" aria-controls="accountTypesBody">Account Types <span class="plus-icon">${state.accountTypesOpen ? '−' : '+'}</span></button>
    <div id="accountTypesBody" class="add-form-body${state.accountTypesOpen ? '' : ' hidden'}">
      <div class="sec-head"><div class="configure-actions"><button class="btn btn-secondary btn-sm" data-action="at-import">${state.accountTypePanel === 'import' ? '× Close' : '↑ Import'}</button><button class="btn btn-secondary btn-sm" data-action="at-export">${state.accountTypePanel === 'export' ? '× Close' : '↓ Export'}</button></div></div>
      ${state.accountTypeSchema.requires_migration ? '<p class="field-hint">Import the updated account_types CSV to upgrade this configuration and its linked account and category keys.</p>' : ''}
      ${state.accountTypePanel === 'edit' ? _formHtml(state.accountTypeDraft) : ''}
      ${state.accountTypePanel === 'view' && view !== undefined ? _viewHtml(view) : ''}
      ${state.accountTypePanel === 'import' ? _importHtml() : ''}
      ${state.accountTypePanel === 'export' ? _exportHtml() : ''}
      <div id="accountTypesList">${_listHtml()}</div>
    </div></div>`;
  _attachEvents(content);
}

function _listHtml() {
  const data = _viewData();
  if (data === null) return _viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : '<p class="placeholder">Loading account types…</p>';
  const rows = data.rows;
  return `${_viewError !== '' ? `<p class="pin-error" role="alert">${esc(_viewError)}</p>` : ''}${_filtersHtml(data)}
      <div class="cat-count-bar"><span class="cat-count">${rows.length} account ${rows.length === 1 ? 'type' : 'types'}</span></div>
      ${_tableHtml(rows, data.total_all)}`;
}

function _renderList() {
  const region = el('accountTypesList');
  if (region === null || region === undefined) { _render(); return; }
  closeContextMenu();
  region.innerHTML = _listHtml();
  _attachFilterEvents();
}

// Row menu from the server's allowed_actions (view / edit / unlock / restore / delete).
const _ACTION_ITEMS = {
  view: { key: 'at-view', label: 'View', cls: '' },
  edit: { key: 'at-edit', label: 'Edit', cls: '' },
  unlock: { key: 'at-edit', label: 'Unlock', cls: '' },
  restore: { key: 'at-restore', label: 'Restore', cls: '' },
  delete: { key: 'at-delete', label: 'Delete', cls: 'danger' },
};

function _menuItems(row) {
  return (row.allowed_actions ?? []).filter(action => _ACTION_ITEMS[action] !== undefined).map(action => ({ ..._ACTION_ITEMS[action] }));
}

function _allows(row, key) {
  return _menuItems(row).some(item => item.key === key);
}

function _action(action, id, button) {
  if (state.accountTypeBusy) return;
  const row = _viewRow(id);
  if (action === 'at-menu' && row !== undefined) {
    openContextMenu(button, _menuItems(row), key => _action(key, id));
    return;
  }
  if (action === 'at-toggle') state.accountTypesOpen = !state.accountTypesOpen;
  else if (action === 'at-close') _closePanel();
  else if (action === 'at-export') {
    const close = state.accountTypePanel === 'export';
    _closePanel();
    if (!close) { state.accountTypePanel = 'export'; _render(); _loadExport(); return; }
  }
  else if (action === 'at-export-confirm') {
    const data = state.accountTypeExport?.data;
    if (data && data.count > 0) downloadExport('csv', data);
    _closePanel();
  }
  else if (action === 'at-filter-toggle') state.accountTypeFilterOpen = !state.accountTypeFilterOpen;
  else if (action === 'at-filter-clear') {
    state.accountTypeSearch = ''; state.accountTypeStatus = 'all'; state.accountTypeFilterType = 'all'; state.accountTypeFilterDraft = null;
    _render(); _loadView(); return;
  } else if (action === 'at-edit' && row !== undefined && _allows(row, 'at-edit')) { _closePanel(); state.accountTypePanel = 'edit'; state.accountTypeDraft = { ...row }; }
  else if (action === 'at-view' && row !== undefined) { _closePanel(); state.accountTypePanel = 'view'; state.accountTypeViewId = id; }
  else if (action === 'at-import') { const close = state.accountTypePanel === 'import'; _closePanel(); if (!close) state.accountTypePanel = 'import'; }
  else if (action === 'at-delete' && row !== undefined && _allows(row, 'at-delete')) { _closePanel(); state.accountTypeDeleteId = id; }
  else if (action === 'at-cancel-delete') state.accountTypeDeleteId = null;
  else if (action === 'at-confirm-delete' && row !== undefined) { _mutate(() => ExpenseAPI.deleteAccountType({ id: row.id, updated_at: row.updated_at, row_num: row.row_num }), 'Account type deleted.'); return; }
  else if (action === 'at-restore' && row !== undefined) { _mutate(() => ExpenseAPI.restoreAccountType({ id: row.id, updated_at: row.updated_at, row_num: row.row_num }), 'Account type restored.'); return; }
  else if (action === 'at-import-confirm') { _submitImport(); return; }
  else return;
  _render();
}

function _attachEvents(content) {
  content.onclick = event => {
    const button = event.target.closest('[data-action]');
    if (button !== null) _action(button.dataset.action, button.dataset.id, button);
  };
  _attachFilterEvents();
  _attachFormEvents();
}

function _attachFilterEvents() {
  const filters = el('accountTypeFilters');
  if (filters === null || filters === undefined) return;
  filters.oninput = () => {
    state.accountTypeFilterDraft = { search: el('accountTypeSearch').value, status: el('accountTypeStatus').value, type: el('accountTypeFilterType').value };
  };
  filters.onsubmit = event => {
    event.preventDefault();
    if (state.accountTypeBusy) return;
    filters.oninput();
    state.accountTypeSearch = state.accountTypeFilterDraft.search.trim();
    state.accountTypeStatus = state.accountTypeFilterDraft.status;
    state.accountTypeFilterType = state.accountTypeFilterDraft.type;
    state.accountTypeFilterDraft = null;
    _renderList();
    _loadView();
  };
}

function _attachFormEvents() {
  const form = el('accountTypeForm');
  if (form !== null) {
    form.oninput = () => {
      state.accountTypeSchema.fields.forEach(field => {
        const input = el('at-' + field.key);
        if (input !== null && !input.disabled) state.accountTypeDraft[field.key] = input.value;
      });
    };
    form.onsubmit = event => { event.preventDefault(); form.oninput(); _saveType(); };
  }
  const file = el('accountTypeFile');
  if (file !== null) file.onchange = () => {
    // A new file clears the previous file's outcome, as in the other import panels.
    state.accountTypeImport = null;
    el('accountTypeImportResult').innerHTML = '';
    el('accountTypeImportBtn').disabled = file.files.length === 0;
  };
}

async function _mutate(request, success) {
  if (state.accountTypeBusy) return;
  state.accountTypeBusy = true;
  el('configureContent').querySelectorAll('.field.error').forEach(field => field.classList.remove('error'));
  const controls = Array.from(el('configureContent').querySelectorAll('button,input,select,textarea'));
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  showLoading();
  try {
    const result = await request();
    if (result?.ok !== true) {
      // The server's message wins; the local copy covers codes returned without one.
      const detail = typeof result?.message === 'string' && result.message !== '' ? result.message
        : result?.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.'
        : result?.error?.includes('in_use') ? 'This type is used by accounts or categories. Keep it available until those references are reconciled.' : result?.error ?? 'invalid_response';
      const message = result?.row_num === undefined ? detail : `Row ${result.row_num}: ${detail}`;
      if (el('accountTypeError') !== null) el('accountTypeError').textContent = message;
      const input = typeof result?.field === 'string' ? el('at-' + result.field) : null;
      input?.closest?.('.field')?.classList.add('error');
      showMsg(message, 'warn');
      return;
    }
    _closePanel();
    showMsg(success);
    document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (_) {
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
  } finally {
    state.accountTypeBusy = false;
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    hideLoading();
  }
}

function _saveType() {
  if (state.accountTypePanel !== 'edit') return;
  const draft = state.accountTypeDraft;
  const fields = state.accountTypeSchema.fields.filter(field => !SYSTEM_FIELDS.has(field.key));
  const payload = Object.fromEntries(fields.map(field => [field.key, String(draft[field.key] ?? '').trim()]));
  payload.id = draft.id; payload.row_num = draft.row_num;
  if (draft.updated_at !== undefined) payload.expected_updated_at = draft.updated_at;
  return _mutate(() => ExpenseAPI.updateAccountType(payload), 'Account type saved.');
}

// Server messages for import outcomes; row-level file errors arrive already worded.
const IMPORT_ERRORS = {
  missing_csv: 'Choose a CSV file to import.',
  invalid_csv: 'This file is not a valid CSV.',
  csv_has_no_rows: 'The CSV must contain headers and at least one record.',
  invalid_csv_headers: 'CSV headers must match the account_types export.',
  invalid_csv_rows: 'Correct these rows and import the file again. Nothing was saved.',
  account_type_creation_restricted: 'Only existing account types can be imported. Every UUID must already be in the catalog.',
  field_not_editable: 'Existing UUIDs and classification keys cannot be changed by an import.',
  complete_account_type_catalog_required: 'Upgrading legacy keys needs the complete catalog. Include every existing UUID.',
  record_locked: 'A locked account type would change. Unlock it before importing.',
  account_type_in_use: 'This import would retire or remap a type used by accounts or categories. Keep it available until those references are reconciled.',
  account_types_is_loan_column_present: 'Delete the retired is_loan column from the account_types Sheet, then retry.',
  account_type_import_failed: 'The import was interrupted. Import the complete CSV again.',
  busy_retry: 'Another change is in progress. Try again in a moment.',
  invalid_response: 'The server did not return a complete import result. Refresh and check before retrying.',
};

function _importResultHtml(outcome) {
  if (outcome === null) return '';
  return renderImportResult(outcome.result, { filename: outcome.filename, message: code => IMPORT_ERRORS[code] ?? importErrorText(code) });
}

// The browser only reads and uploads the file; the server parses, validates and reports.
async function _submitImport() {
  if (state.accountTypeBusy || state.accountTypePanel !== 'import') return;
  const file = el('accountTypeFile')?.files?.[0];
  if (file === undefined) return;
  state.accountTypeBusy = true;
  state.accountTypeImport = null;
  const controls = Array.from(el('configureContent').querySelectorAll('button,input,select,textarea'));
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  showLoading();
  try {
    let csv;
    try { csv = await file.text(); }
    catch (_) { state.accountTypeImport = { filename: file.name, result: { ok: false, error: 'invalid_csv' } }; return; }
    let result;
    try { result = await ExpenseAPI.createAccountTypesBulk({ csv }); }
    catch (_) { showMsg('Connection lost. The import may have completed. Refresh and check before retrying.', 'warn'); return; }
    if (result === null || typeof result !== 'object') result = { ok: false, error: 'invalid_response' };
    state.accountTypeImport = { filename: file.name, result };
    if (result.ok === true) {
      showMsg(`${result.created ?? 0} created · ${result.updated ?? 0} updated · ${result.skipped ?? 0} unchanged · ${result.failed ?? 0} failed`, result.failed > 0 ? 'warn' : 'success');
      if ((result.created ?? 0) + (result.updated ?? 0) > 0) document.dispatchEvent(new CustomEvent('et:reload'));
    } else showMsg(IMPORT_ERRORS[result.error] ?? result.error ?? 'Import failed.', 'warn');
  } finally {
    state.accountTypeBusy = false;
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    hideLoading();
    if (state.accountTypePanel === 'import') _render();
  }
}
