const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app/sections/categories.js'), 'utf8')
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
const uuid = index => `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const category = index => ({ id: uuid(index), tx_type_key: 'money-out', major_category_label: 'Group', minor_category_label: 'Item ' + index, record_status: 'active', csv_row_num: index + 1 });
function fixture(overrides = {}) {
  const state = {
    catImportOpen: true, catImportPreview: null, catImportReport: null, catImportBusy: false,
    accountTypes: [{ account_type_key: 'asset', account_subtype_key: 'daily-wallet' }],
    accountTypeSchema: { columns: ['is_loan', 'detail_sheet'], requires_migration: false },
    categorySchema: { types: [{ value: 'money-in' }, { value: 'money-out' }], record_statuses: ['active', 'inactive', 'locked', 'deleted'] },
    ...overrides,
  };
  const elements = Object.fromEntries(['catImportStatus', 'catImportReport', 'catImportError', 'catImportConfirm', 'catImportFile', 'catImportCancel', 'catImportBtn', 'catAddBtn'].map(id => [id, { innerHTML: '', textContent: '', disabled: false }]));
  const requests = [], reloads = [], messages = [];
  const api = { createCategoriesBulk: async payload => { requests.push(payload); return { ok: true, results: payload.categories.map((row, index) => ({ index, key: row.id, ok: true, action: 'created' })) }; } };
  let loading = 0;
  const ctx = vm.createContext({
    state, ExpenseAPI: api, el: id => elements[id] ?? null, console: { log() {}, warn() {}, error() {} },
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    showLoading: () => loading++, hideLoading: () => loading--, showMsg: (message, kind) => messages.push({ message, kind }),
    document: { dispatchEvent: event => reloads.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(source + '\nthis.exposed = {_parseCatCsv,_readCatImport,_renderCatImportPanel,_renderCatImportReport,_submitCatImport,_categoryImportPrerequisite,pending:()=>_catImportParsed};', ctx);
  return { ...ctx.exposed, state, elements, requests, reloads, messages, api, loading: () => loading };
}
function csv(rows, columns = ['id', 'tx_type_key', 'major_category_label', 'minor_category_label', 'record_status']) {
  return columns.join(',') + '\r\n' + rows.map(row => columns.map(key => '"' + String(row[key] ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
}
async function select(context, rows) { await context._readCatImport({ name: 'category_master.csv', text: async () => csv(rows) }); }

test('current and exported CSVs preserve UUIDs and physical line numbers with multiline cells', () => {
  const context = fixture();
  const rows = [category(1), { ...category(2), description: 'Quoted, "description"\r\nsecond line', record_status: 'inactive' }, category(3)];
  const parsed = context._parseCatCsv('\uFEFF' + csv(rows, ['id', 'tx_type_key', 'major_category_label', 'minor_category_label', 'record_status', 'description', 'created_at']));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.categories.length, 3);
  assert.equal(parsed.categories[1].description, rows[1].description);
  assert.equal(parsed.categories[1].record_status, 'inactive');
  assert.deepEqual(Array.from(parsed.categories, row => row.csv_row_num), [2, 3, 5]);
  assert.equal(parsed.categories[1].created_at, undefined);
});

test('parser reports absent/duplicate headers, ragged rows and malformed quoting before import', async () => {
  const context = fixture();
  assert.match(context._parseCatCsv('tx_type_key\nmoney-out').errors.join(), /Missing required headers/);
  assert.match(context._parseCatCsv('tx_type_key,tx_type_key\nmoney-out,money-out').errors.join(), /duplicate column/);
  assert.match(context._parseCatCsv('tx_type_key,major_category_label,minor_category_label\nmoney-out,One').errors.join(), /expected 3 columns/);
  assert.match(context._parseCatCsv(csv([category(1)]) + '\n"unclosed').errors.join(), /not closed/);
  assert.match(context._parseCatCsv(csv([category(1)]) + '\n"quoted"tail').errors.join(), /invalid characters/);
  await context._readCatImport({ name: 'bad.csv', text: async () => csv([category(1)]) + '\nshort,row' });
  assert.equal(context.pending(), null);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  await context._submitCatImport(context.state.catImportPreview.categories);
  assert.equal(context.requests.length, 0);
});

test('booleans validate explicitly and omitted lifecycle/audit fields are not invented', () => {
  const context = fixture();
  const columns = ['tx_type_key', 'major_category_label', 'minor_category_label', 'source_account_mandatory'];
  const parsed = context._parseCatCsv(csv([{ ...category(1), source_account_mandatory: 'FALSE' }], columns));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.categories[0].source_account_mandatory, false);
  assert.equal(parsed.categories[0].record_status, undefined);
  assert.match(context._parseCatCsv(csv([{ ...category(1), source_account_mandatory: 'yes' }], columns)).errors.join(), /must be true or false/);
  assert.match(context._parseCatCsv(csv([{ ...category(1), id: 'bad' }])).errors.join(), /must be a UUID/);
});

test('partial import keeps every error visible across render and retries only failed CSV rows', async () => {
  const context = fixture();
  const rows = Array.from({ length: 102 }, (_, index) => category(index + 1));
  await select(context, rows);
  context.api.createCategoriesBulk = async payload => {
    context.requests.push(payload);
    return { ok: false, created: 29, updated: 0, failed: 73, results: payload.categories.map((row, index) => index < 29
      ? { ok: true, index, key: row.id, action: 'created' }
      : { ok: false, index, key: row.id, error: 'invalid_source_account_types', field: 'source_account_types', invalid_values: ['old_key'] }) };
  };
  await context._submitCatImport(context.pending());
  assert.equal(context.state.catImportOpen, true);
  assert.equal(context.state.catImportReport.failures.length, 73);
  assert.equal(context.pending().length, 73);
  assert.equal(context.pending()[0].csv_row_num, 31);
  assert.deepEqual(context.reloads, ['et:reload']);
  assert.equal(context.messages.at(-1).kind, 'warn');
  const html = context._renderCatImportPanel();
  assert.match(html, /73 failed/);
  assert.match(html, /Item 102/);
  assert.match(html, /old_key/);
  assert.match(html, /Retry failed rows/);
  context.api.createCategoriesBulk = async payload => { context.requests.push(payload); return { ok: true, results: payload.categories.map((row, index) => ({ index, ok: true, action: 'updated', key: row.id })) }; };
  await context._submitCatImport(context.pending());
  assert.equal(context.requests[1].categories.length, 73);
  assert.equal(context.requests[1].categories[0].id, rows[29].id);
  assert.equal(context.state.catImportReport.updated, 73);
  assert.equal(context.pending(), null);
  assert.equal(context.loading(), 0);
});

test('legacy backend per-row errors lacking indexes are retained with original file row numbers', async () => {
  const context = fixture();
  await select(context, [category(1), category(2)]);
  context.api.createCategoriesBulk = async () => ({ ok: false, created: 1, failed: 1, results: [{ key: uuid(1), ok: true, action: 'created' }, { key: uuid(2), ok: false, error: 'invalid_target_account_types' }] });
  await context._submitCatImport(context.pending());
  assert.equal(context.state.catImportReport.failures[0].csv_row_num, 3);
  assert.equal(context.pending()[0].id, uuid(2));
  assert.match(context._renderCatImportPanel(), /invalid_target_account_types/);
});

test('old catalog schema blocks import with one actionable upgrade message and no POST', async () => {
  const context = fixture({ accountTypeSchema: { columns: ['id'], requires_migration: false } });
  await select(context, [category(1)]);
  await context._submitCatImport(context.pending());
  assert.equal(context.requests.length, 0);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  assert.equal(context._categoryImportPrerequisite().error, 'account_types_backend_outdated');
  assert.match(context._renderCatImportPanel(), /Deploy the updated backend/);
  assert.match(context._renderCatImportPanel(), /Configure/);
  const missing = fixture({ accountTypes: [] });
  assert.equal(missing._categoryImportPrerequisite().error, 'account_types_missing');
});

test('server prerequisite failures retain their reason even with an empty results array', async () => {
  const context = fixture();
  await select(context, [category(1)]);
  context.api.createCategoriesBulk = async () => ({ ok: false, error: 'account_types_migration_required', results: [], created: 0, updated: 0, failed: 0 });
  await context._submitCatImport(context.pending());
  assert.equal(context.state.catImportReport.globalError.error, 'account_types_migration_required');
  assert.match(context._renderCatImportPanel(), /Account Types still uses the old Sheet layout/);
  assert.equal(context.reloads.length, 0);
});

test('upgraded backend with legacy Sheet explains the import prerequisite and unblocks after catalog refresh', async () => {
  const context = fixture({ accountTypeSchema: { columns: ['is_loan', 'detail_sheet'], requires_migration: true } });
  await select(context, [category(1)]);
  const panel = context._renderCatImportPanel();
  assert.match(panel, /1 valid CSV rows · Import blocked/);
  assert.doesNotMatch(panel, /ready to import|Deploy the updated backend/);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  context.state.accountTypeSchema.requires_migration = false;
  await select(context, [category(1)]);
  assert.equal(context.elements.catImportConfirm.disabled, false);
  assert.match(context._renderCatImportPanel(), /1 category ready to import/);
});

test('duplicate clicks cannot submit twice and uncertain transport outcomes require reload', async () => {
  const context = fixture();
  await select(context, [category(1)]);
  let fail;
  context.api.createCategoriesBulk = payload => { context.requests.push(payload); return new Promise((_, reject) => { fail = reject; }); };
  const pending = context._submitCatImport(context.pending());
  await context._submitCatImport(context.pending());
  assert.equal(context.requests.length, 1);
  assert.equal(context.elements.catImportCancel.disabled, true);
  fail(new Error('network'));
  await pending;
  assert.equal(context.state.catImportReport.globalError.error, 'connection_error');
  assert.equal(context.pending(), null);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  assert.equal(context.loading(), 0);
});

test('unparseable server results never masquerade as success or allow unsafe retries', async () => {
  const context = fixture();
  await select(context, [category(1)]);
  context.api.createCategoriesBulk = async () => ({ ok: true, created: 1, results: [] });
  await context._submitCatImport(context.pending());
  assert.equal(context.state.catImportReport.globalError.error, 'invalid_response');
  assert.equal(context.pending(), null);
  assert.equal(context.messages.at(-1).kind, 'warn');
});

test('errors escape labels, fields, codes and invalid values before insertion into HTML', () => {
  const context = fixture();
  const html = context._renderCatImportReport({ created: 0, updated: 0, skipped: 0, globalError: null, failures: [{ csv_row_num: 2, label: '<script>bad()</script>', field: '<img src=x>', error: '<svg onload=bad()>', invalid_values: ['<b>bad</b>'] }] });
  assert.doesNotMatch(html, /<script>|<img|<svg|<b>/);
  assert.match(html, /&lt;script>/);
});

test('latest file selection wins and blank file selection clears old import rows', async () => {
  const context = fixture();
  let finish;
  const first = context._readCatImport({ name: 'first.csv', text: () => new Promise(resolve => { finish = resolve; }) });
  await context._readCatImport({ name: 'second.csv', text: async () => csv([category(2)]) });
  finish(csv([category(1)]));
  await first;
  assert.equal(context.pending()[0].id, uuid(2));
  await context._readCatImport(undefined);
  assert.equal(context.pending(), null);
  assert.equal(context.elements.catImportConfirm.disabled, true);
});
