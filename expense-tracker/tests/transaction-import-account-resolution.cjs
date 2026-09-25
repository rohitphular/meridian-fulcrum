const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function load(file, globals, exports) {
  const source = fs.readFileSync(path.join(__dirname, '../app', file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext(globals);
  vm.runInContext(source + '\nglobalThis.testExports = {' + exports.join(',') + '};', context);
  return context.testExports;
}

const { parseCsvRecords } = load('core/utils.js', {}, ['parseCsvRecords']);
const bank = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_name: 'Bank', type: 'asset', sub_type: 'current', record_status: 'active' };
const property = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account_name: 'Shared name', type: 'investment', sub_type: 'property', record_status: 'active' };
const mortgage = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', account_name: 'Shared name', type: 'liability', sub_type: 'mortgage', record_status: 'active' };
const category = { tx_type_key: 'money-out', major_category_key: 'debt-repayment', minor_category_key: 'mortgage-repayment', source_account_types: 'current, savings', target_account_types: 'mortgage', record_status: 'active' };
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function csv(overrides = {}) {
  const row = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tx_date_local: '2026-09-01 21:20:00', tx_timezone_local: 'Europe/London', tx_type: 'money-out', source_account: 'Bank', target_account: 'Shared name', source_amount_local: '70000.00', target_amount_local: '70000.00', major_category: 'debt-repayment', minor_category: 'mortgage-repayment', ...overrides };
  return Object.keys(row).join(',') + '\n' + Object.values(row).map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',');
}

function fixture(overrides = {}) {
  const nodes = {};
  const submitted = [];
  const state = { accounts: [bank, property, mortgage], categories: [category], txImportOpen: true, ...overrides };
  const frontend = load('sections/transactions.js', {
    state, parseCsvRecords, esc,
    el: id => nodes[id] ??= { disabled: false, textContent: '', innerHTML: '' },
    showLoading() {}, hideLoading() {}, showMsg() {}, document: { dispatchEvent() {} }, CustomEvent: class {},
    ExpenseAPI: { async createTransactionsBulk(payload) {
      submitted.push(...payload.transactions);
      return { ok: true, results: payload.transactions.map(() => ({ ok: true, action: 'created' })) };
    } },
  }, ['_parseTxCsv', '_readTxImport', '_submitTxImport', '_acctOptsWithHints']);
  return { ...frontend, nodes, submitted };
}

test('duplicate target names resolve by category subtype and the bulk request receives that UUID', async () => {
  const frontend = fixture();
  const parsed = frontend._parseTxCsv(csv());
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.transactions[0].source_account, bank.id);
  assert.equal(parsed.transactions[0].target_account, mortgage.id);
  assert.equal(parsed.transactions[0].target_amount_local, '70000.00');
  await frontend._submitTxImport(parsed.transactions);
  assert.equal(frontend.submitted[0].target_account, mortgage.id);
});

test('source and target hints remain distinct for both transfer directions, including group hints', () => {
  const otherBank = { ...property, account_name: 'Bank' };
  for (const direction of ['money-out', 'money-in']) {
    const frontend = fixture({ accounts: [bank, otherBank, property, mortgage], categories: [
      { ...category, tx_type_key: direction, source_account_types: ' ASSET , ', target_account_types: ' MORTGAGE ' },
    ] });
    const parsed = frontend._parseTxCsv(csv({ tx_type: direction, source_account: ' bank ', target_account: ' SHARED NAME ' }));
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.transactions[0].source_account, bank.id);
    assert.equal(parsed.transactions[0].target_account, mortgage.id);
    const options = frontend._acctOptsWithHints([property, mortgage], ' MORTGAGE ');
    assert.match(options, new RegExp(mortgage.id));
    assert.ok(!options.includes(property.id));
  }
});

test('UUIDs take precedence over names and category hints, without changing identity', () => {
  const frontend = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another', account_name: property.id }] });
  const parsed = frontend._parseTxCsv(csv({ target_account: property.id.toUpperCase() }));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.transactions[0].target_account, property.id);
});

test('duplicate UUIDs cannot be narrowed by category hints', () => {
  const frontend = fixture({ accounts: [bank, property, { ...mortgage, id: property.id.toUpperCase() }] });
  const parsed = frontend._parseTxCsv(csv({ target_account: property.id }));
  assert.equal(parsed.transactions.length, 0);
  assert.match(parsed.errors[0], /ambiguous account/);
});

test('unique names and UUIDs continue to work without categories or with different hints', () => {
  for (const categories of [undefined, [], [category]]) {
    const frontend = fixture({ accounts: [bank, property], categories });
    const parsed = frontend._parseTxCsv(csv());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.transactions[0].target_account, property.id);
  }
});

test('only one active category with the complete exact key can disambiguate accounts', () => {
  for (const categories of [undefined, [], [category, category],
    [{ ...category, record_status: 'inactive' }], [{ ...category, record_status: 'locked' }],
    [{ ...category, tx_type_key: 'money-in' }], [{ ...category, major_category_key: 'other' }],
    [{ ...category, minor_category_key: 'other' }]]) {
    const parsed = fixture({ categories })._parseTxCsv(csv());
    assert.equal(parsed.transactions.length, 0);
    assert.match(parsed.errors[0], /ambiguous account: "Shared name" \(target_account\)/);
    assert.match(parsed.errors[0], /Use an account UUID/);
  }
  const parsed = fixture({ categories: [{ ...category, record_status: 'deleted' }, category] })._parseTxCsv(csv());
  assert.equal(parsed.transactions[0].target_account, mortgage.id);
});

test('empty, unmatched and broad hints never choose the first duplicate account', () => {
  for (const hint of [undefined, '', ' , ', 'unmatched', 'property, mortgage']) {
    const parsed = fixture({ categories: [{ ...category, target_account_types: hint }] })._parseTxCsv(csv());
    assert.equal(parsed.transactions.length, 0);
    assert.match(parsed.errors[0], /ambiguous account/);
  }
  const parsed = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another' }] })._parseTxCsv(csv());
  assert.equal(parsed.transactions.length, 0);
  assert.match(parsed.errors[0], /ambiguous account/);
});

test('historical inactive and locked accounts retain their identity during name resolution', () => {
  for (const status of ['inactive', 'locked']) {
    const parsed = fixture({ accounts: [bank, property, { ...mortgage, record_status: status }] })._parseTxCsv(csv());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.transactions[0].target_account, mortgage.id);
  }
});

test('unknown accounts identify the failing field and blank optional accounts stay blank', () => {
  const frontend = fixture();
  const unknown = frontend._parseTxCsv(csv({ source_account: 'Missing' }));
  assert.match(unknown.errors[0], /unknown account: "Missing" \(source_account\)/);
  const blank = frontend._parseTxCsv(csv({ target_account: '' }));
  assert.equal(blank.errors.length, 0);
  assert.equal(blank.transactions[0].target_account, '');
});

test('file preview enables import only once every duplicate name is resolved', async () => {
  const resolved = fixture();
  await resolved._readTxImport({ text: async () => csv() });
  assert.equal(resolved.nodes.txImportConfirm.disabled, false);
  const unresolved = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another' }] });
  await unresolved._readTxImport({ text: async () => csv() });
  assert.equal(unresolved.nodes.txImportConfirm.disabled, true);
  assert.match(unresolved.nodes.txImportStatus.innerHTML, /ambiguous account/);
  assert.equal(unresolved.submitted.length, 0);
});
