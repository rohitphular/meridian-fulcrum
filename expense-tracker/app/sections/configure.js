import { state } from '../core/state.js';
import { ExpenseAPI } from '../core/api.js';
import { el, esc, exportAccountTypes, recordStatusIcon, syncStatusIcon, openContextMenu, closeContextMenu } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';

const SYSTEM_FIELDS = new Set(['id', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at']);
let _importSequence = 0;

function _closePanel() {
  state.accountTypePanel = null;
  state.accountTypeDraft = {};
  state.accountTypeViewId = null;
  state.accountTypeDeleteId = null;
  state.accountTypeImport = null;
  _importSequence++;
}

function _options(options, selected) {
  return options.map(option => {
    const value = typeof option === 'string' ? option : option.value;
    const label = typeof option === 'string' ? option : option.label;
    return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function _formHtml(row, view = false) {
  const locked = row.record_status === 'locked';
  const hasAccounts = (state.accounts ?? []).some(account => account.type === row.account_type_key && account.sub_type === row.account_subtype_key);
  const schema = state.accountTypeSchema;
  const fields = schema.fields.filter(field => view || !SYSTEM_FIELDS.has(field.key));
  return `<form class="card configure-panel" id="accountTypeForm">
    <div class="cat-form-header">${view ? 'Viewing' : 'Editing'} — <strong>${esc(row.account_subtype_label)}</strong></div>
    ${locked && !view ? '<p class="field-hint">Unlock this type by changing its status before editing its details.</p>' : ''}
    <div class="form-grid form-grid-4">${fields.map(field => {
      const key = field.key;
      const value = String(row[key] ?? '');
      const readonly = view || field.editable === false || (locked && key !== 'record_status') || (key === 'detail_sheet' && hasAccounts);
      const attributes = `id="at-${esc(key)}" name="${esc(key)}"${readonly ? ' disabled' : ''}${field.required && field.type !== 'boolean' ? ' required' : ''}`;
      let input;
      if (key === 'record_status') {
        input = `<select ${attributes}>${_options(schema.record_statuses.filter(status => !locked || status !== 'deleted'), value)}</select>`;
      } else if (field.type === 'boolean' && value !== '') {
        input = `<input type="checkbox" ${attributes}${value.toLowerCase() === 'true' ? ' checked' : ''}>`;
      } else if (key === 'detail_sheet') {
        input = `<select ${attributes}>${_options([{ value: '', label: 'None' }, ...(schema.detail_sheets ?? [])], value)}</select>`;
      } else {
        input = `<input type="text" ${attributes} value="${esc(value)}">`;
      }
      return `<div class="field${key === 'description' || key === 'sync_notes' || key === 'id' ? ' form-grid-span-2' : ''}"><label for="at-${esc(key)}">${esc(field.label)}${field.required && field.type !== 'boolean' ? ' *' : ''}</label>${input}</div>`;
    }).join('')}</div>
    <div class="form-actions">
      ${view ? '' : '<button class="btn btn-primary" type="submit">Save</button>'}
      <button class="btn btn-secondary" type="button" data-action="at-close">${view ? 'Close' : 'Cancel'}</button>
    </div><p class="pin-error" id="accountTypeError" role="alert"></p>
  </form>`;
}

function _importHtml() {
  const parsed = state.accountTypeImport;
  const preview = parsed?.rows.slice(0, 5) ?? [];
  return `<div class="card configure-panel">
    <div class="cat-form-header">Import account types</div>
    <p class="field-hint">Import the account_types CSV to update the existing catalog. On first setup, import the supplied CSV. UUIDs are preserved.</p>
    <div class="field"><label for="accountTypeFile">CSV file</label><input id="accountTypeFile" type="file" accept=".csv,text/csv"></div>
    ${parsed === null ? '' : `<p class="cat-count">${esc(parsed.filename)} · ${parsed.rows.length} records</p>`}
    ${preview.length === 0 ? '' : `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Subtype key</th><th>Label</th><th>Status</th></tr></thead><tbody>${preview.map(row => `<tr><td>${esc(row.account_type_label)}</td><td class="td-mono">${esc(row.account_subtype_key)}</td><td>${esc(row.account_subtype_label)}</td><td>${esc(row.record_status)}</td></tr>`).join('')}</tbody></table></div>`}
    <div class="form-actions"><button class="btn btn-primary" data-action="at-import-confirm"${parsed === null || parsed.rows.length === 0 || parsed.errors.length > 0 ? ' disabled' : ''}>Import</button><button class="btn btn-secondary" data-action="at-close">Cancel</button></div>
    <p class="pin-error" id="accountTypeError" role="alert">${esc(parsed?.errors.join(' ') ?? '')}</p>
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

function _tableHtml(rows) {
  if (rows.length === 0) {
    return `<p class="placeholder">${state.accountTypes.length === 0 ? 'Import the account_types CSV to configure the existing classifications.' : 'No account types for this filter.'}</p>`;
  }
  const tableRows = rows.map(row => state.accountTypeDeleteId === row.id
    ? `<tr><td colspan="4">${_deleteHtml(row)}</td></tr>`
    : `<tr${row.record_status === 'active' ? '' : ' class="configure-archived"'}>
      <td>${esc(row.account_type_label)}</td><td class="td-name">${esc(row.account_subtype_label)}<div class="td-mono td-muted">${esc(row.account_subtype_key)}</div></td>
      <td class="configure-description">${esc(row.description)}</td><td>${_rowControls(row)}</td></tr>`).join('');
  const cards = rows.map(row => `<div class="cat-card${row.record_status === 'active' ? '' : ' is-archived'}">${state.accountTypeDeleteId === row.id
    ? _deleteHtml(row)
    : `<div class="cat-card-top"><div class="cat-card-name"><span class="cat-card-major">${esc(row.account_type_label)}</span><span class="cat-card-sep">›</span><span class="cat-card-minor">${esc(row.account_subtype_label)}</span></div>${_rowControls(row)}</div><div class="cat-keywords">${esc(row.account_subtype_key)}</div>`}</div>`).join('');
  return `<div class="table-wrap cat-table-wrap"><table><thead><tr><th>Type</th><th>Subtype</th><th>Description</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="cat-cards">${cards}</div>`;
}

function _filtersHtml() {
  const draft = state.accountTypeFilterDraft ?? { search: state.accountTypeSearch, status: state.accountTypeStatus, type: state.accountTypeFilterType };
  const count = [state.accountTypeSearch !== '', state.accountTypeStatus !== 'all', state.accountTypeFilterType !== 'all'].filter(Boolean).length;
  return `<div class="filter-bar"><button class="filter-toggle" data-action="at-filter-toggle" aria-expanded="${state.accountTypeFilterOpen}">Filters${count > 0 ? ` (${count})` : ''}<span class="filter-arrow">${state.accountTypeFilterOpen ? '▲' : '▼'}</span></button>
    <form class="filter-body${state.accountTypeFilterOpen ? '' : ' hidden'}" id="accountTypeFilters">
      <div class="filter-row"><label for="accountTypeFilterType">Type</label><select id="accountTypeFilterType">${_options([{ value: 'all', label: 'All types' }, ...state.accountTypeSchema.types], draft.type)}</select></div>
      <div class="filter-row"><label for="accountTypeSearch">Search</label><input id="accountTypeSearch" type="text" value="${esc(draft.search)}" placeholder="label, key, description…"></div>
      <div class="filter-row"><label for="accountTypeStatus">Status</label><select id="accountTypeStatus">${_options([{ value: 'all', label: 'All statuses' }, ...state.accountTypeSchema.record_statuses], draft.status)}</select></div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Search</button><button class="btn btn-secondary btn-sm" type="button" data-action="at-filter-clear">Clear</button></div>
    </form></div>`;
}

export function renderConfigure() {
  closeContextMenu();
  const content = el('configureContent');
  if (state.accountTypeSchema === null) {
    content.innerHTML = '<p class="placeholder">Account type configuration unavailable. Reload to try again.</p>';
    return;
  }
  const query = state.accountTypeSearch.trim().toLowerCase();
  const rows = state.accountTypes.filter(row => (state.accountTypeStatus === 'all' || row.record_status === state.accountTypeStatus)
    && (state.accountTypeFilterType === 'all' || row.account_type_key === state.accountTypeFilterType)
    && [row.account_type_key, row.account_type_label, row.account_subtype_key, row.account_subtype_label, row.description].some(value => String(value ?? '').toLowerCase().includes(query)))
    .slice().sort((a, b) => a.account_type_key.localeCompare(b.account_type_key) || a.account_subtype_label.localeCompare(b.account_subtype_label));
  const view = state.accountTypes.find(row => row.id === state.accountTypeViewId);
  content.innerHTML = `<div class="add-form-wrap configure-module">
    <button class="add-form-toggle" data-action="at-toggle" aria-expanded="${state.accountTypesOpen}" aria-controls="accountTypesBody">Account Types <span class="plus-icon">${state.accountTypesOpen ? '−' : '+'}</span></button>
    <div id="accountTypesBody" class="add-form-body${state.accountTypesOpen ? '' : ' hidden'}">
      <div class="sec-head"><div class="configure-actions"><button class="btn btn-secondary btn-sm" data-action="at-import">${state.accountTypePanel === 'import' ? '× Close' : '↑ Import'}</button><button class="btn btn-secondary btn-sm" data-action="at-export">↓ Export</button></div></div>
      ${state.accountTypeSchema.requires_migration ? '<p class="field-hint">Import the updated account_types CSV to upgrade this configuration and its linked account and category keys.</p>' : ''}
      ${state.accountTypePanel === 'edit' ? _formHtml(state.accountTypeDraft) : ''}
      ${state.accountTypePanel === 'view' && view !== undefined ? _formHtml(view, true) : ''}
      ${state.accountTypePanel === 'import' ? _importHtml() : ''}
      ${_filtersHtml()}
      <div class="cat-count-bar"><span class="cat-count">${rows.length} account ${rows.length === 1 ? 'type' : 'types'}</span></div>
      ${_tableHtml(rows)}
    </div></div>`;
  _attachEvents(content);
}

function _menuItems(row) {
  if (state.accountTypeSchema.requires_migration) return [{ key: 'at-view', label: 'View', cls: '' }];
  return [
    { key: 'at-view', label: 'View', cls: '' },
    ...(row.record_status === 'deleted' ? [{ key: 'at-restore', label: 'Restore', cls: '' }] : [{ key: 'at-edit', label: row.record_status === 'locked' ? 'Unlock' : 'Edit', cls: '' }]),
    ...(['locked', 'deleted'].includes(row.record_status) ? [] : [{ key: 'at-delete', label: 'Delete', cls: 'danger' }]),
  ];
}

function _action(action, id, button) {
  if (state.accountTypeBusy) return;
  const row = state.accountTypes.find(item => item.id === id);
  if (action === 'at-menu' && row !== undefined) {
    openContextMenu(button, _menuItems(row), key => _action(key, id));
    return;
  }
  if (action === 'at-toggle') state.accountTypesOpen = !state.accountTypesOpen;
  else if (action === 'at-close') _closePanel();
  else if (action === 'at-export') { exportAccountTypes(state.accountTypes); return; }
  else if (action === 'at-filter-toggle') state.accountTypeFilterOpen = !state.accountTypeFilterOpen;
  else if (action === 'at-filter-clear') {
    state.accountTypeSearch = ''; state.accountTypeStatus = 'all'; state.accountTypeFilterType = 'all'; state.accountTypeFilterDraft = null;
  } else if (action === 'at-edit' && row !== undefined && row.record_status !== 'deleted') { _closePanel(); state.accountTypePanel = 'edit'; state.accountTypeDraft = { ...row }; }
  else if (action === 'at-view' && row !== undefined) { _closePanel(); state.accountTypePanel = 'view'; state.accountTypeViewId = id; }
  else if (action === 'at-import') { const close = state.accountTypePanel === 'import'; _closePanel(); if (!close) state.accountTypePanel = 'import'; }
  else if (action === 'at-delete' && row !== undefined && !['locked', 'deleted'].includes(row.record_status)) { _closePanel(); state.accountTypeDeleteId = id; }
  else if (action === 'at-cancel-delete') state.accountTypeDeleteId = null;
  else if (action === 'at-confirm-delete' && row !== undefined) { _mutate(() => ExpenseAPI.deleteAccountType({ id: row.id, row_num: row.row_num }), 'Account type deleted.'); return; }
  else if (action === 'at-restore' && row !== undefined) { _mutate(() => ExpenseAPI.restoreAccountType({ id: row.id, row_num: row.row_num }), 'Account type restored.'); return; }
  else if (action === 'at-import-confirm') { _submitImport(); return; }
  else return;
  renderConfigure();
}

function _attachEvents(content) {
  content.onclick = event => {
    const button = event.target.closest('[data-action]');
    if (button !== null) _action(button.dataset.action, button.dataset.id, button);
  };
  const filters = el('accountTypeFilters');
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
    renderConfigure();
  };
  const form = el('accountTypeForm');
  if (form !== null) {
    form.oninput = () => {
      state.accountTypeSchema.fields.forEach(field => {
        const input = el('at-' + field.key);
        if (input !== null && !input.disabled) state.accountTypeDraft[field.key] = field.type === 'boolean' ? input.checked : input.value;
      });
    };
    form.onsubmit = event => { event.preventDefault(); form.oninput(); _saveType(); };
  }
  const file = el('accountTypeFile');
  if (file !== null) file.onchange = () => _readImport(file.files[0]);
}

async function _mutate(request, success) {
  if (state.accountTypeBusy) return;
  state.accountTypeBusy = true;
  const controls = Array.from(el('configureContent').querySelectorAll('button,input,select,textarea'));
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  showLoading();
  try {
    const result = await request();
    if (result?.ok !== true) {
      const detail = result?.error?.includes('in_use') ? 'This type is used by accounts or categories. Keep it available until those references are reconciled.' : result?.error ?? 'invalid_response';
      const message = result?.row_num === undefined ? detail : `Row ${result.row_num}: ${detail}`;
      if (el('accountTypeError') !== null) el('accountTypeError').textContent = message;
      showMsg(message, 'warn');
      return;
    }
    _closePanel();
    showMsg(success);
    document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (_) {
    showMsg('Could not save account types. Check the connection and retry.', 'warn');
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
  const payload = Object.fromEntries(fields.map(field => [field.key, field.type === 'boolean' ? String(draft[field.key]).toLowerCase() === 'true' : String(draft[field.key] ?? '').trim()]));
  payload.id = draft.id; payload.row_num = draft.row_num;
  return _mutate(() => ExpenseAPI.updateAccountType(payload), 'Account type saved.');
}

async function _readImport(file) {
  const sequence = ++_importSequence;
  state.accountTypeImport = null;
  if (file === undefined) { renderConfigure(); return; }
  try {
    const parsed = _parseAccountTypesCsv(await file.text());
    if (sequence !== _importSequence || state.accountTypePanel !== 'import') return;
    state.accountTypeImport = { ...parsed, filename: file.name };
  } catch (_) {
    if (sequence !== _importSequence || state.accountTypePanel !== 'import') return;
    state.accountTypeImport = { rows: [], errors: ['Unable to read this CSV file.'], filename: file.name };
  }
  renderConfigure();
}

function _submitImport() {
  const parsed = state.accountTypeImport;
  if (parsed === null || parsed.errors.length > 0 || parsed.rows.length === 0) return;
  return _mutate(() => ExpenseAPI.createAccountTypesBulk({ account_types: parsed.rows }), `${parsed.rows.length} account types imported.`);
}

// RFC-style quoted fields, embedded newlines and escaped double quotes. Keep IDs
// and values as text so export/import never changes source identity or precision.
function _parseAccountTypesCsv(source) {
  const text = source.replace(/^\uFEFF/, '');
  const records = [];
  let record = [], value = '', quoted = false, closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      record.push(value); value = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        if (record.some(cell => cell.trim() !== '')) records.push(record);
        record = [];
      }
    } else if (closed || char === '"') return { rows: [], errors: ['Invalid characters after a quoted CSV field.'] };
    else value += char;
  }
  if (quoted) return { rows: [], errors: ['A quoted CSV field is not closed.'] };
  record.push(value);
  if (record.some(cell => cell.trim() !== '')) records.push(record);
  if (records.length < 2) return { rows: [], errors: ['The CSV must contain headers and at least one record.'] };
  const headers = records.shift().map(header => header.trim());
  const columns = state.accountTypeSchema.columns;
  if (new Set(headers).size !== headers.length || headers.length !== columns.length || columns.some(column => !headers.includes(column))) {
    return { rows: [], errors: ['CSV headers must match the account_types export, including the six sync and audit columns.'] };
  }
  const rows = [], errors = [], ids = new Set(), keys = new Set(), families = new Map();
  const existing = new Map(state.accountTypes.map(row => [row.id.toLowerCase(), row]));
  const keyPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  records.forEach((cells, index) => {
    if (cells.length !== headers.length) { errors.push(`Row ${index + 2}: incorrect column count.`); return; }
    const row = Object.fromEntries(headers.map((header, column) => [header, cells[column].trim()]));
    const id = row.id.toLowerCase();
    const key = row.account_subtype_key;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) errors.push(`Row ${index + 2}: a valid UUID is required.`);
    if (ids.has(id) || keys.has(key)) errors.push(`Row ${index + 2}: duplicate UUID or type/subtype key.`);
    if (!keyPattern.test(row.account_type_key) || row.account_type_label === '') errors.push(`Row ${index + 2}: a hyphenated type key and label are required.`);
    if (!keyPattern.test(row.account_subtype_key) || row.account_subtype_label === '') errors.push(`Row ${index + 2}: a hyphenated subtype key and label are required.`);
    if (families.has(row.account_type_key) && families.get(row.account_type_key) !== row.account_type_label) errors.push(`Row ${index + 2}: conflicting labels for the same type.`);
    families.set(row.account_type_key, row.account_type_label);
    if (!['true', 'false'].includes(row.is_loan.toLowerCase())) errors.push(`Row ${index + 2}: is_loan must be true or false.`);
    if (row.detail_sheet !== '' && !(state.accountTypeSchema.detail_sheets ?? []).some(option => (typeof option === 'string' ? option : option.value) === row.detail_sheet)) errors.push(`Row ${index + 2}: unsupported detail sheet.`);
    if (existing.size > 0) {
      const previous = existing.get(id);
      if (previous === undefined) errors.push(`Row ${index + 2}: only existing account types can be imported.`);
      else if (previous.account_type_key.replaceAll('_', '-') !== row.account_type_key || previous.account_subtype_key.replaceAll('_', '-') !== row.account_subtype_key) errors.push(`Row ${index + 2}: existing classification keys cannot be changed.`);
    }
    if (!state.accountTypeSchema.record_statuses.includes(row.record_status)) errors.push(`Row ${index + 2}: invalid record status.`);
    ids.add(id); keys.add(key); rows.push({ ...row, id });
  });
  if (rows.some(row => families.has(row.account_subtype_key))) errors.push('Subtype keys must differ from type keys.');
  return { rows, errors };
}
