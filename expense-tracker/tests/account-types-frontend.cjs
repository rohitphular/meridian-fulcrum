const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const app = path.join(__dirname, '../app');
const columns = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'is_loan', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const identity = '12345678-1234-4234-8234-123456789abc';
const row = extra => ({ id: identity, account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'current', account_subtype_label: 'Current', description: '', is_loan: false, detail_sheet: 'account_deposit', record_status: 'active', sync_status: 'in-sync', sync_date: '', sync_notes: '', created_at: '', updated_at: '', row_num: 2, ...extra });
const schema = {
  columns, types: [{ value: 'asset', label: 'Asset' }, { value: 'investment', label: 'Investment' }, { value: 'liability', label: 'Liability' }],
  detail_sheets: ['account_deposit'],
  record_statuses: ['active', 'inactive', 'deleted', 'locked'],
  fields: columns.map(key => ({ key, label: key, type: key === 'is_loan' ? 'boolean' : 'string', editable: ['account_subtype_label', 'description', 'is_loan', 'detail_sheet', 'record_status'].includes(key), required: key.endsWith('_key') })),
};
function load(file, globals, names) {
  const source = fs.readFileSync(path.join(app, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source + '\n globalThis.exports = {' + names.join(',') + '};', context);
  return context.exports;
}
function fixture(extra = {}) {
  const state = { accountTypeSchema: schema, accountTypes: [row()], accountTypesOpen: true, accountTypeFilterOpen: false, accountTypeFilterType: 'all', accountTypeFilterDraft: null, accountTypePanel: null, accountTypeDraft: {}, accountTypeSearch: '', accountTypeStatus: 'all', accountTypeImport: null, accountTypeBusy: false, ...extra };
  const elements = Object.fromEntries(['configureContent', 'accountTypeFilters', 'accountTypeError'].map(id => [id, { innerHTML: '', textContent: '', querySelectorAll: () => [] }]));
  const messages = [], reloads = [], requests = [];
  const api = {};
  for (const name of ['createAccountType', 'updateAccountType', 'deleteAccountType', 'restoreAccountType', 'createAccountTypesBulk']) {
    api[name] = async payload => { requests.push([name, payload]); return { ok: true }; };
  }
  const exports = load('sections/configure.js', {
    state, ExpenseAPI: api, el: id => elements[id] ?? null,
    esc: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    recordStatusIcon: () => '', syncStatusIcon: () => '', closeContextMenu() {}, openContextMenu() {},
    showLoading() {}, hideLoading() {}, showMsg: text => messages.push(text), exportAccountTypes() {},
    document: { dispatchEvent: event => reloads.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
  }, ['_parseAccountTypesCsv', '_saveType', '_submitImport', '_mutate', 'renderConfigure', '_menuItems', '_action', '_readImport']);
  return { ...exports, state, elements, messages, reloads, requests, api };
}
function csv(rows, headers = columns) {
  return '\uFEFF' + headers.join(',') + '\r\n' + rows.map(record => headers.map(key => '"' + String(record[key] ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

test('account type CSV preserves UUIDs, metadata and quoted multiline descriptions', () => {
  const context = fixture();
  const original = row({ id: identity.toUpperCase(), description: 'Bank, "daily"\nsecond line', created_at: '2026-09-24T10:00:00.123456Z' });
  const parsed = context._parseAccountTypesCsv(csv([original]));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows[0].id, identity);
  assert.equal(parsed.rows[0].description, original.description);
  assert.equal(parsed.rows[0].created_at, original.created_at);
  assert.equal(parsed.rows[0].sync_status, 'in-sync');
  const reordered = context._parseAccountTypesCsv(csv([original], columns.slice().reverse()));
  assert.equal(reordered.errors.length, 0);
  assert.equal(reordered.rows[0].id, identity);
});

test('account type CSV rejects duplicate identities, ambiguous keys, malformed fields and missing metadata headers', () => {
  const { _parseAccountTypesCsv: parse } = fixture();
  assert.match(parse(csv([row(), row({ id: identity.toUpperCase(), account_subtype_key: 'other' })])).errors.join(), /duplicate UUID/);
  assert.match(parse(csv([row(), row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_type_key: 'liability', account_type_label: 'Liability' })])).errors.join(), /duplicate UUID or type\/subtype key/);
  assert.match(parse(csv([row({ id: 'bad' })])).errors.join(), /valid UUID/);
  assert.match(parse(csv([row({ account_subtype_key: 'asset' })])).errors.join(), /Subtype keys must differ/);
  assert.match(parse(csv([row({ record_status: 'unknown' })])).errors.join(), /invalid record status/);
  assert.match(parse(csv([row()], columns.slice(0, 6))).errors.join(), /headers must match/);
  assert.match(parse(csv([row()]) + '\n"unclosed').errors.join(), /not closed/);
  assert.match(parse(csv([row()]) + '\n"closed"junk').errors.join(), /Invalid characters/);
});

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

test('import blocks invalid previews, preserves IDs and ignores repeated clicks during a request', async () => {
  const context = fixture({ accountTypePanel: 'import', accountTypeImport: { rows: [row()], errors: ['invalid'] } });
  await context._submitImport();
  assert.equal(context.requests.length, 0);
  context.state.accountTypeImport.errors = [];
  let finish;
  context.api.createAccountTypesBulk = payload => { context.requests.push(payload); return new Promise(resolve => { finish = resolve; }); };
  const pending = context._submitImport();
  await context._submitImport();
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].account_types[0].id, identity);
  finish({ ok: true });
  await pending;
  assert.deepEqual(context.reloads, ['et:reload']);
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


test('catalog import accepts hyphen migration and bootstrap but rejects additions and underscore keys', () => {
  const legacy = row({ account_subtype_key: 'daily_bank' });
  const context = fixture({ accountTypes: [legacy] });
  assert.equal(context._parseAccountTypesCsv(csv([{ ...legacy, account_subtype_key: 'daily-bank' }])).errors.length, 0);
  assert.match(context._parseAccountTypesCsv(csv([legacy])).errors.join(), /hyphenated subtype/);
  assert.match(context._parseAccountTypesCsv(csv([row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })])).errors.join(), /only existing/);
  const bootstrap = fixture({ accountTypes: [], accountTypeSchema: { ...schema, types: [] } });
  assert.equal(bootstrap._parseAccountTypesCsv(csv([row()])).errors.length, 0);
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

test('only the latest selected CSV can populate the import preview', async () => {
  const context = fixture({ accountTypePanel: 'import' });
  let finishFirst;
  const first = context._readImport({ name: 'first.csv', text: () => new Promise(resolve => { finishFirst = resolve; }) });
  await context._readImport({ name: 'second.csv', text: async () => csv([row({ description: 'second' })]) });
  finishFirst(csv([row({ description: 'first' })]));
  await first;
  assert.equal(context.state.accountTypeImport.filename, 'second.csv');
  assert.equal(context.state.accountTypeImport.rows[0].description, 'second');
});

test('account choices, grouping and labels use the supplied schema without catalog fallbacks', () => {
  const state = { accountSchema: { types: [{ value: 'custom-family', label: '<Custom>' }], subtypes_by_type: { 'custom-family': ['custom-key'] }, loan_sub_types: [], type_labels: { 'custom-family': '<Custom>' }, subtype_labels: { 'custom-key': 'Configured label' } }, categorySchema: { account_type_hints: [{ value: 'custom-key', label: 'Configured label' }] } };
  const account = load('sections/accounts.js', { state }, ['_subTypesForType', '_subTypeLabel']);
  assert.deepEqual(Array.from(account._subTypesForType('custom-family')), ['custom-key']);
  assert.equal(account._subTypeLabel('custom-key'), 'Configured label');
  assert.equal(account._subTypeLabel('unknown'), 'unknown');
  const category = load('sections/categories.js', { state }, ['_acctTypeGroups']);
  assert.equal(category._acctTypeGroups()[0].label, '<Custom>');
  assert.deepEqual(Array.from(category._acctTypeGroups()[0].keys), ['custom-key']);
});

test('false loan policy is valid in edit forms and preserved in mutation payloads', async () => {
  const context = fixture({ accountTypePanel: 'edit', accountTypeDraft: row() });
  context.renderConfigure();
  const input = context.elements.configureContent.innerHTML.match(/<input type="checkbox"[^>]*>/)[0];
  assert.doesNotMatch(input, /required|checked/);
  await context._saveType();
  assert.equal(context.requests[0][1].is_loan, false);
});


test('detail mapping is read-only once an account uses the classification', () => {
  const context = fixture({ accounts: [{ type: 'asset', sub_type: 'current' }], accountTypePanel: 'edit', accountTypeDraft: row() });
  context.renderConfigure();
  assert.match(context.elements.configureContent.innerHTML, /name="detail_sheet" disabled/);
});
