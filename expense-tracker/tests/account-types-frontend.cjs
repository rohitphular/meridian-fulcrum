const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');
const app = path.join(__dirname, '../app');
const columns = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const identity = '12345678-1234-4234-8234-123456789abc';
const row = extra => ({ id: identity, account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'current', account_subtype_label: 'Current', description: '', detail_sheet: 'account_deposit', record_status: 'active', sync_status: 'in-sync', sync_date: '', sync_notes: '', created_at: '', updated_at: '', row_num: 2, ...extra });
const schema = {
  columns, types: [{ value: 'asset', label: 'Asset' }, { value: 'investment', label: 'Investment' }, { value: 'liability', label: 'Liability' }],
  detail_sheets: ['account_deposit'],
  record_statuses: ['active', 'inactive', 'deleted', 'locked'],
  fields: columns.map(key => ({ key, label: key, type: 'string', editable: ['account_subtype_label', 'description', 'detail_sheet', 'record_status'].includes(key), required: key.endsWith('_key') })),
};
function load(file, globals, names) {
  const source = fs.readFileSync(path.join(app, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ ...importResultHelpers(), console, ...globals });
  vm.runInContext(source + '\n globalThis.exports = {' + names.join(',') + '};', context);
  return context.exports;
}
function fixture(extra = {}) {
  const state = { accountTypeSchema: schema, accountTypes: [row()], accountTypesOpen: true, accountTypeFilterOpen: false, accountTypeFilterType: 'all', accountTypeFilterDraft: null, accountTypePanel: null, accountTypeDraft: {}, accountTypeSearch: '', accountTypeStatus: 'all', accountTypeImport: null, accountTypeBusy: false, ...extra };
  const elements = Object.fromEntries(['configureContent', 'accountTypeFilters', 'accountTypeError', 'accountTypeFile', 'accountTypeImportBtn'].map(id => [id, { innerHTML: '', textContent: '', disabled: false, files: [], querySelectorAll: () => [] }]));
  const messages = [], reloads = [], requests = [], exported = [];
  const api = {};
  for (const name of ['createAccountType', 'updateAccountType', 'deleteAccountType', 'restoreAccountType', 'createAccountTypesBulk']) {
    api[name] = async payload => { requests.push([name, payload]); return { ok: true }; };
  }
  const exports = load('sections/configure.js', {
    state, ExpenseAPI: api, el: id => elements[id] ?? null,
    esc: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    recordStatusIcon: () => '', syncStatusIcon: () => '', closeContextMenu() {}, openContextMenu() {},
    showLoading() {}, hideLoading() {}, showMsg: text => messages.push(text), exportAccountTypes: rows => exported.push(rows),
    fmtDateTime: value => `dt:${value}`, todayISO: () => '2026-09-29',
    document: { dispatchEvent: event => reloads.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
  }, ['_saveType', '_submitImport', '_mutate', 'renderConfigure', '_menuItems', '_action']);
  return { ...exports, state, elements, messages, reloads, requests, api, exported };
}
test('editing preserves row identity and queues a reload without sending source audit fields', async () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row({ account_subtype_label: 'Daily banking' }) });
  await context._saveType();
  const [action, payload] = context.requests[0];
  assert.equal(action, 'updateAccountType');
  assert.equal(payload.id, identity);
  assert.equal(payload.row_num, 2);
  assert.equal(payload.account_subtype_label, 'Daily banking');
  assert.equal(payload.created_at, undefined);
  assert.equal(payload.sync_status, undefined);
  assert.deepEqual(context.reloads, ['et:reload']);
  assert.equal(context.state.accountTypePanel, null);
});

test('dependency rejection retains the draft and never signals a successful refresh', async () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row({ record_status: 'inactive' }) });
  context.api.updateAccountType = async () => ({ ok: false, error: 'account_type_in_use', referenced_count: 3 });
  await context._saveType();
  assert.equal(context.reloads.length, 0);
  assert.equal(context.state.accountTypePanel, 'edit');
  assert.equal(context.state.accountTypeDraft.record_status, 'inactive');
  assert.match(context.elements.accountTypeError.textContent, /used by accounts or categories/);
  assert.equal(context.state.accountTypeBusy, false);
});

test('Configure escapes source labels and supports view, edit, delete, restore and export', () => {
  const context = fixture({ accountTypes: [row({ account_subtype_label: '<img src=x onerror=alert(1)>', description: '<script>bad()</script>' }), row({ id: 'deleted', record_status: 'deleted' })] });
  context.renderConfigure();
  const html = context.elements.configureContent.innerHTML;
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img src/);
  for (const action of ['at-toggle', 'at-menu', 'at-export', 'at-import']) assert.ok(html.includes(`data-action="${action}"`));
  assert.doesNotMatch(html, /at-add|Add type/);
  assert.deepEqual(Array.from(context._menuItems(row()), item => item.key), ['at-view', 'at-edit', 'at-delete']);
  assert.deepEqual(Array.from(context._menuItems(row({ record_status: 'deleted' })), item => item.key), ['at-view', 'at-restore']);
});

test('account type export includes the complete schema and existing UUIDs', () => {
  const { exportAccountTypes } = load('core/utils.js', { state: { accountTypeSchema: schema }, _exportData: (format, rows, filename, cols) => ({ format, rows, filename, cols }) }, ['exportAccountTypes']);
  const output = exportAccountTypes([row()]);
  assert.equal(output.filename, 'account_types');
  assert.equal(output.rows[0].id, identity);
  assert.deepEqual(output.cols.slice(-6), ['record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at']);
});

test('locked account types expose unlock without offering deletion or editable descriptions', () => {
  const locked = row({ record_status: 'locked' });
  const context = fixture({ accountTypes: [locked], accountTypePanel: 'edit', accountTypeDraft: locked });
  context.renderConfigure();
  const html = context.elements.configureContent.innerHTML;
  assert.ok(context._menuItems(locked).some(item => item.label === 'Unlock'));
  assert.equal(context._menuItems(locked).some(item => item.key === 'at-delete'), false);
  assert.doesNotMatch(html, /data-action="at-delete"/);
  assert.match(html, /name="description" disabled/);
  const statusOptions = html.match(/id="at-record_status"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.doesNotMatch(statusOptions, /value="deleted"/);
  assert.match(statusOptions, /value="active"/);
});

test('account and category schemas refresh after configuration changes instead of using persistent cached choices', async () => {
  let label = 'First';
  const data = () => ({ ok: true, data: { types: [{ value: 'asset', label }] } });
  const api = { getAccountSchema: async () => data(), getCategorySchema: async () => data() };
  const context = load('core/schema.js', { ExpenseAPI: api, localStorage: { getItem: () => JSON.stringify({ types: [{ label: 'stale' }] }) } }, ['loadAccountSchema', 'loadCategorySchema']);
  assert.equal((await context.loadAccountSchema()).types[0].label, 'First');
  label = 'Changed';
  assert.equal((await context.loadAccountSchema()).types[0].label, 'Changed');
  assert.equal((await context.loadCategorySchema()).types[0].label, 'Changed');
});


test('collapsing the module retains edit and filter drafts, and new creation is unavailable', async () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row({ description: 'unsaved' }), accountTypeFilterDraft: { search: 'draft', status: 'active', type: 'asset' } });
  context._action('at-toggle');
  assert.equal(context.state.accountTypesOpen, false);
  assert.match(context.elements.configureContent.innerHTML, /id="accountTypesBody" class="add-form-body hidden"/);
  assert.equal(context.state.accountTypeDraft.description, 'unsaved');
  context._action('at-toggle');
  assert.equal(context.state.accountTypeFilterDraft.search, 'draft');
  context.state.accountTypePanel = 'new';
  await context._saveType();
  assert.equal(context.requests.length, 0);
});

test('account choices, grouping and labels use the supplied schema without catalog fallbacks', () => {
  const state = { accountSchema: { types: [{ value: 'custom-family', label: '<Custom>' }], subtypes_by_type: { 'custom-family': ['custom-key'] }, type_labels: { 'custom-family': '<Custom>' }, subtype_labels: { 'custom-key': 'Configured label' } }, categorySchema: { account_type_hints: [{ value: 'custom-key', label: 'Configured label' }] } };
  const account = load('sections/accounts.js', { state }, ['_subTypesForType', '_subTypeLabel']);
  assert.deepEqual(Array.from(account._subTypesForType('custom-family')), ['custom-key']);
  assert.equal(account._subTypeLabel('custom-key'), 'Configured label');
  assert.equal(account._subTypeLabel('unknown'), 'unknown');
  const category = load('sections/categories.js', { state }, ['_acctTypeGroups']);
  assert.equal(category._acctTypeGroups()[0].label, '<Custom>');
  assert.deepEqual(Array.from(category._acctTypeGroups()[0].keys), ['custom-key']);
});

test('edit payloads carry no retired loan policy', async () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row() });
  context.renderConfigure();
  assert.doesNotMatch(context.elements.configureContent.innerHTML, /type="checkbox"|is_loan/);
  await context._saveType();
  assert.equal('is_loan' in context.requests[0][1], false);
});


test('detail mapping is read-only once an account uses the classification', () => {
  const context = fixture({ accounts: [{ type: 'asset', sub_type: 'current' }], accountTypePanel: 'edit', accountTypeDraft: row() });
  context.renderConfigure();
  assert.match(context.elements.configureContent.innerHTML, /name="detail_sheet" disabled/);
});


test('subtype column shows labels only and view panel is a read-only summary', () => {
  const context = fixture({ accountTypes: [row({ account_subtype_key: 'current-key' })] });
  context.renderConfigure();
  assert.doesNotMatch(context.elements.configureContent.innerHTML, /current-key/);
  context._action('at-view', identity);
  const html = context.elements.configureContent.innerHTML;
  assert.match(html, /configure-view-grid/);
  assert.doesNotMatch(html, /id="accountTypeForm"/);
  assert.match(html, /data-action="at-edit" data-id="12345678/);
});

test('edit form shows only editable fields and never exposes identity keys as inputs', () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row() });
  context.renderConfigure();
  const html = context.elements.configureContent.innerHTML;
  for (const key of ['id', 'account_type_key', 'account_subtype_key', 'sync_status', 'created_at']) assert.doesNotMatch(html, new RegExp(`name="${key}"`));
  for (const key of ['account_subtype_label', 'description', 'detail_sheet', 'record_status']) assert.match(html, new RegExp(`name="${key}"`));
  assert.match(html, /<textarea id="at-description"/);
});

test('export opens a panel and downloads the complete unfiltered catalog in import format', () => {
  const deleted = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_subtype_key: 'savings', record_status: 'deleted' });
  const context = fixture({ accountTypes: [row(), deleted], accountTypeStatus: 'active' });
  context._action('at-export');
  assert.equal(context.state.accountTypePanel, 'export');
  assert.match(context.elements.configureContent.innerHTML, /account_types-2026-09-29\.csv · 2 records · 13 columns/);
  assert.equal(context.exported.length, 0);
  context._action('at-export-confirm');
  assert.equal(context.exported[0].length, 2);
  assert.equal(context.state.accountTypePanel, null);
});

test('export warns that a legacy-key catalog download cannot be re-imported', () => {
  const context = fixture({ accountTypeSchema: { ...schema, requires_migration: true }, accountTypePanel: 'export' });
  context.renderConfigure();
  assert.match(context.elements.configureContent.innerHTML, /reference copy only and cannot be re-imported/);
});

test('import uploads the raw file text once and renders the server summary', async () => {
  const context = fixture({ accountTypePanel: 'import' });
  const text = '﻿id,account_type_key\r\n"x","y"';
  context.elements.accountTypeFile.files = [{ name: 'account_types.csv', text: async () => text }];
  let finish;
  context.api.createAccountTypesBulk = payload => { context.requests.push(payload); return new Promise(resolve => { finish = resolve; }); };
  const pending = context._submitImport();
  await context._submitImport();
  await new Promise(resolve => setImmediate(resolve));
  await context._submitImport();
  assert.equal(context.requests.length, 1);
  assert.equal(context.state.accountTypeBusy, true);
  assert.deepEqual(Object.keys(context.requests[0]), ['csv']);
  assert.equal(context.requests[0].csv, text);
  finish({ ok: true, rows: 16, created: 16, updated: 0, failed: 0, results: [{ ok: true, id: identity, line: 2, action: 'created' }] });
  await pending;
  assert.deepEqual(context.reloads, ['et:reload']);
  assert.equal(context.state.accountTypeBusy, false);
  assert.equal(context.state.accountTypePanel, 'import');
  assert.match(context.elements.configureContent.innerHTML, /account_types\.csv · 16 created · 0 updated · 0 failed/);
  assert.doesNotMatch(context.elements.configureContent.innerHTML, /<table><thead><tr><th>CSV line/);
});

test('import renders line-numbered file errors escaped and does not reload', async () => {
  const context = fixture({ accountTypePanel: 'import' });
  context.elements.accountTypeFile.files = [{ name: '<bad>.csv', text: async () => 'csv' }];
  context.api.createAccountTypesBulk = async () => ({ ok: false, error: 'invalid_csv_rows', errors: ['Row 3: a valid UUID is required.', 'Row 7: <script>x</script>'] });
  await context._submitImport();
  const html = context.elements.configureContent.innerHTML;
  assert.match(html, /<li>Row 3: a valid UUID is required\.<\/li>/);
  assert.match(html, /<li>Row 7: &lt;script&gt;/);
  assert.match(html, /&lt;bad&gt;\.csv · .*Nothing was saved\./);
  assert.doesNotMatch(html, /Nothing was imported/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(context.reloads.length, 0);
});

test('import renders per-row failures as a line table and whole-batch errors with their field', async () => {
  const context = fixture({ accountTypePanel: 'import' });
  context.elements.accountTypeFile.files = [{ name: 'a.csv', text: async () => 'csv' }];
  context.api.createAccountTypesBulk = async () => ({ ok: true, created: 1, updated: 0, failed: 1, results: [{ ok: true, line: 2 }, { ok: false, line: 5, error: 'field_not_editable', field: 'account_subtype_key' }] });
  await context._submitImport();
  let html = context.elements.configureContent.innerHTML;
  assert.match(html, /1 created · 0 updated · 1 failed/);
  assert.match(html, /<td class="td-mono">5<\/td><td class="import-result-reason">Existing UUIDs and classification keys cannot be changed/);
  assert.match(html, /field_not_editable<\/div><\/td><td>account_subtype_key<\/td>/);
  context.api.createAccountTypesBulk = async () => ({ ok: false, error: 'field_not_editable', field: 'account_subtype_key', rows: 16 });
  await context._submitImport();
  html = context.elements.configureContent.innerHTML;
  assert.match(html, /classification keys cannot be changed by an import\. \(account_subtype_key\)/);
});

test('import without a chosen file sends nothing and the panel has no preview or client validation', async () => {
  const context = fixture({ accountTypePanel: 'import' });
  await context._submitImport();
  assert.equal(context.requests.length, 0);
  context.renderConfigure();
  const html = context.elements.configureContent.innerHTML;
  assert.match(html, /id="accountTypeImportBtn" data-action="at-import-confirm" disabled/);
  assert.doesNotMatch(html, /configure-preview|Retry/);
});
