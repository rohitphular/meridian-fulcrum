const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../app/sections/categories.js'), 'utf8')
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
const RAW = '﻿id,tx_type_key,major_category_label,minor_category_label\r\n,money-out,"Group, ""A""",Item\r\n';
function fixture() {
  const state = { catImportOpen: true, catImportReport: null, catImportBusy: false };
  const elements = Object.fromEntries(['catImportChosen', 'catImportReport', 'catImportError', 'catImportConfirm', 'catImportFile', 'catImportCancel', 'catImportBtn', 'catAddBtn'].map(id => [id, { innerHTML: '', textContent: '', disabled: false }]));
  const requests = [], reloads = [], messages = [];
  const api = { createCategoriesBulk: async payload => { requests.push(payload); return { ok: true, created: 1, updated: 0, skipped: 0, failed: 0, rows: 1, results: [{ index: 0, ok: true, action: 'created', line: 2 }] }; } };
  let loading = 0;
  const ctx = importResultHelpers.context({
    state, ExpenseAPI: api, el: id => elements[id] ?? null, console: { log() {}, warn() {}, error() {} },
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    showLoading: () => loading++, hideLoading: () => loading--, showMsg: (message, kind) => messages.push({ message, kind }),
    document: { dispatchEvent: event => reloads.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(source + '\nthis.exposed = {_selectCatImportFile,_submitCatImport,_renderCatImportPanel,_renderCatImportReport,chosen:()=>_catImportFile};', ctx);
  return { ...ctx.exposed, state, elements, requests, reloads, messages, api, loading: () => loading };
}
const file = (text = RAW, name = 'category_master.csv') => ({ name, text: async () => text });

test('panel sends the raw CSV text unparsed and has no preview, retry or client validation', async () => {
  const context = fixture();
  assert.match(context._renderCatImportPanel(), /id="catImportConfirm" disabled/);
  context._selectCatImportFile(file());
  assert.equal(context.elements.catImportConfirm.disabled, false);
  assert.match(context.elements.catImportChosen.innerHTML, /category_master\.csv/);
  await context._submitCatImport();
  assert.equal(context.requests.length, 1);
  assert.deepEqual(Object.keys(context.requests[0]), ['csv']);
  assert.equal(context.requests[0].csv, RAW);
  assert.match(context.elements.catImportReport.innerHTML, /1 created · 0 updated · 0 failed/);
  assert.deepEqual(context.reloads, ['et:reload']);
  assert.equal(context.loading(), 0);
  assert.doesNotMatch(source, /_parseCatCsv|_categoryCsvRecords|Retry failed rows|catImportPreview|_categoryImportPrerequisite/);
});

test('partial import renders every failure with its CSV line, label, field and mapped reason', async () => {
  const context = fixture();
  context.api.createCategoriesBulk = async payload => {
    context.requests.push(payload);
    return { ok: false, created: 29, updated: 0, skipped: 0, failed: 73, rows: 102, results: Array.from({ length: 102 }, (_, index) => index < 29
      ? { ok: true, index, action: 'created', line: index + 2, label: 'Group → Item ' + index }
      : { ok: false, index, error: 'invalid_source_account_types', field: 'source_account_types', invalid_values: ['old_key'], line: index + 2, label: 'Group → Item ' + index }) };
  };
  context._selectCatImportFile(file());
  await context._submitCatImport();
  assert.equal(context.state.catImportReport.failures.length, 73);
  const html = context.elements.catImportReport.innerHTML;
  assert.match(html, /29 created · 0 updated · 73 failed/);
  assert.match(html, /<td class="td-mono">31<\/td>.*<td>Group → Item 29 · source_account_types · old_key<\/td>/);
  assert.match(html, /Source account-type hints are not available[^<]*Values: old_key\./);
  assert.equal((html.match(/<tr>/g) ?? []).length, 74);
  assert.doesNotMatch(context._renderCatImportPanel(), /Retry/);
  assert.deepEqual(context.reloads, ['et:reload']);
  assert.equal(context.messages.at(-1).kind, 'warn');
});

test('invalid-file responses render the server error list; nothing reloads', async () => {
  const context = fixture();
  context.api.createCategoriesBulk = async () => ({ ok: false, error: 'invalid_csv_rows', errors: ['Row 3: id must be a UUID.', 'Row 7: invalid tx_type_key: <b>x</b>.'] });
  context._selectCatImportFile(file());
  await context._submitCatImport();
  const html = context.elements.catImportReport.innerHTML;
  assert.match(html, /Nothing was imported/);
  assert.match(html, /<li>Row 3: id must be a UUID\.<\/li>/);
  assert.match(html, /<li>Row 7: invalid tx_type_key: &lt;b(&gt;|>)x&lt;\/b(&gt;|>)\.<\/li>/);
  assert.equal(context.reloads.length, 0);
});

test('server prerequisite failures with empty results keep their actionable reason', async () => {
  const context = fixture();
  context.api.createCategoriesBulk = async () => ({ ok: false, error: 'account_types_migration_required', results: [], created: 0, updated: 0, failed: 0, rows: 1 });
  context._selectCatImportFile(file());
  await context._submitCatImport();
  assert.equal(context.state.catImportReport.globalError.error, 'account_types_migration_required');
  assert.match(context.elements.catImportReport.innerHTML, /Account Types still uses the old Sheet layout/);
  assert.equal(context.reloads.length, 0);
  context.api.createCategoriesBulk = async () => ({ ok: false, error: 'missing_categories' });
  await context._submitCatImport();
  assert.match(context.elements.catImportReport.innerHTML, /Deploy the updated backend/);
});

test('duplicate clicks cannot submit twice and transport failures report connection_error', async () => {
  const context = fixture();
  context._selectCatImportFile(file());
  let fail;
  context.api.createCategoriesBulk = payload => { context.requests.push(payload); return new Promise((_, reject) => { fail = reject; }); };
  const pending = context._submitCatImport();
  await context._submitCatImport();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.requests.length, 1);
  assert.equal(context.elements.catImportCancel.disabled, true);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  fail(new Error('network'));
  await pending;
  assert.equal(context.state.catImportReport.globalError.error, 'connection_error');
  assert.equal(context.state.catImportBusy, false);
  assert.equal(context.loading(), 0);
});

test('malformed server results never masquerade as success', async () => {
  const context = fixture();
  context._selectCatImportFile(file());
  context.api.createCategoriesBulk = async () => ({ ok: true, created: 1, results: [] });
  await context._submitCatImport();
  assert.equal(context.state.catImportReport.globalError.error, 'invalid_response');
  context.api.createCategoriesBulk = async () => ({ ok: true, created: 1, results: [{ action: 'created' }] });
  await context._submitCatImport();
  assert.equal(context.state.catImportReport.globalError.error, 'invalid_response');
  assert.equal(context.messages.at(-1).kind, 'warn');
});

test('errors escape labels, fields, codes and invalid values before insertion into HTML', () => {
  const context = fixture();
  const html = context._renderCatImportReport({ created: 0, updated: 0, skipped: 0, globalError: null, failures: [{ line: 2, label: '<script>bad()</script>', field: '<img src=x>', error: '<svg onload=bad()>', invalid_values: ['<b>bad</b>'] }] });
  assert.doesNotMatch(html, /<script>|<img|<svg|<b>/);
  assert.match(html, /&lt;script(&gt;|>)/);
  context._selectCatImportFile(file(RAW, '<img src=x>.csv'));
  assert.doesNotMatch(context.elements.catImportChosen.innerHTML, /<img/);
});

test('clearing the file selection disables Import and clears the previous report', async () => {
  const context = fixture();
  context._selectCatImportFile(file());
  await context._submitCatImport();
  context._selectCatImportFile(undefined);
  assert.equal(context.chosen(), null);
  assert.equal(context.state.catImportReport, null);
  assert.equal(context.elements.catImportConfirm.disabled, true);
  await context._submitCatImport();
  assert.equal(context.requests.length, 1);
});

// validateCategoryCreate/Update own the label rules (form-validation-backend.cjs):
// the form submits blank labels and renders the server message on the field.
test('category add and edit forms submit without browser checks and render the server field error', async () => {
  assert.doesNotMatch(source, /Major category is required|Major and minor category are required/);
  const classes = {};
  const values = { catNewType: 'money-out', catNewMajor: '', catNewMinor: 'Trains', catNewDesc: '', catNewKeywords: '', catNewCounterparty: '',
    catEditType: 'money-out', catEditMajor: 'Travel', catEditMinor: '', catEditDesc: '', catEditKeywords: '', catEditCounterparty: '', catEditRecordStatus: 'active' };
  const elements = { catAddError: { textContent: '' }, catEditError: { textContent: '' }, catSaveNew: { disabled: false, textContent: 'Save' }, catSaveEdit: { disabled: false, textContent: 'Save' } };
  Object.entries(values).forEach(([id, value]) => {
    classes[id] = new Set();
    elements[id] = { value, closest: selector => (selector === '.field' ? { classList: { add: name => classes[id].add(name) } } : null) };
  });
  ['catNewSrcMandatory', 'catNewTgtMandatory', 'catNewIsSubEligible', 'catEditSrcMandatory', 'catEditTgtMandatory', 'catEditIsSubEligible'].forEach(id => { elements[id] = { checked: false }; });
  const requests = [];
  const responses = [
    { ok: false, error: 'missing_major_category', field: 'major_category_label', message: 'Major category is required.' },
    { ok: false, error: 'missing_minor_category', field: 'minor_category_label', message: 'Minor category is required.' },
  ];
  let loading = 0;
  const ctx = importResultHelpers.context({
    state: { catEditRow: 'c4', catAddOpen: true, views: { list_categories_view: { ok: true, data: { rows: [{ id: 'c4', _row: 4, updated_at: 'u' }] } } } }, el: id => elements[id] ?? null, console: { log() {}, warn() {}, error() {} },
    showLoading: () => loading++, hideLoading: () => loading--, showMsg() {},
    document: { dispatchEvent() { throw new Error('no reload on failure'); } }, CustomEvent: class {},
    ExpenseAPI: { createCategory: async body => { requests.push(body); return responses.shift(); }, updateCategory: async body => { requests.push(body); return responses.shift(); } },
  });
  // Account-type checkboxes are not under test here.
  vm.runInContext(source + '\n_getCheckedAccountTypes = () => [];\nthis.exposed = {_saveNewCategory,_saveCatEdit};', ctx);
  await ctx.exposed._saveNewCategory();
  assert.equal(requests[0].major_category_label, '');
  assert.equal(elements.catAddError.textContent, 'Major category is required.');
  assert.equal(classes.catNewMajor.has('error'), true);
  assert.equal(elements.catSaveNew.disabled, false);
  await ctx.exposed._saveCatEdit();
  assert.equal(requests[1].row_num, 4);
  assert.equal(requests[1].minor_category_label, '');
  assert.equal(elements.catEditError.textContent, 'Minor category is required.');
  assert.equal(classes.catEditMinor.has('error'), true);
  assert.equal(loading, 0);
});
