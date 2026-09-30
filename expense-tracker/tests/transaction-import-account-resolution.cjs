// Account resolution in importTransactionsCsv: UUID first, then name, with
// category hints used only to break ties between identically named accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');

const bank = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_name: 'Bank', type: 'asset', sub_type: 'current', record_status: 'active' };
const property = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', account_name: 'Shared name', type: 'investment', sub_type: 'property', record_status: 'active' };
const mortgage = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', account_name: 'Shared name', type: 'liability', sub_type: 'mortgage', record_status: 'active' };
const category = { tx_type_key: 'money-out', major_category_key: 'debt-repayment', minor_category_key: 'mortgage-repayment', source_account_types: 'current, savings', target_account_types: 'mortgage', record_status: 'active' };

function csv(overrides = {}) {
  const row = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tx_date_local: '2026-09-01 21:20:00', tx_timezone_local: 'Europe/London', tx_type: 'money-out', source_account: 'Bank', target_account: 'Shared name', source_amount_local: '70000.00', target_amount_local: '70000.00', major_category: 'debt-repayment', minor_category: 'mortgage-repayment', ...overrides };
  return Object.keys(row).join(',') + '\n' + Object.values(row).map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',');
}

function fixture(options = {}) {
  const accounts = options.accounts ?? [bank, property, mortgage];
  const categories = Object.hasOwn(options, 'categories') ? options.categories : [category];
  const submitted = [];
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  for (const file of ['app-utils.gs', 'sync-utils.gs', 'csv-import.gs', 'transaction-schema.gs', 'transaction-core.gs', 'transaction-import.gs']) {
    vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  }
  ctx.listAccounts = () => accounts;
  ctx.listCategories = () => categories === undefined ? [] : categories;
  ctx.createTransactionsBulk = body => {
    submitted.push(...JSON.parse(JSON.stringify(body.transactions)));
    return { ok: true, created: body.transactions.length, updated: 0, failed: 0, results: body.transactions.map(tx => ({ key: tx.id, ok: true, action: 'created' })) };
  };
  const run = source => JSON.parse(JSON.stringify(ctx.importTransactionsCsv({ csv: source })));
  return { run, submitted };
}

test('duplicate target names resolve by category subtype and the bulk request receives that UUID', () => {
  const frontend = fixture();
  const result = frontend.run(csv());
  assert.equal(result.ok, true);
  assert.equal(frontend.submitted[0].source_account, bank.id);
  assert.equal(frontend.submitted[0].target_account, mortgage.id);
  assert.equal(frontend.submitted[0].target_amount_local, '70000.00');
});

test('source and target hints remain distinct for both transfer directions, including group hints', () => {
  const otherBank = { ...property, account_name: 'Bank' };
  for (const direction of ['money-out', 'money-in']) {
    const f = fixture({ accounts: [bank, otherBank, property, mortgage], categories: [
      { ...category, tx_type_key: direction, source_account_types: ' ASSET , ', target_account_types: ' MORTGAGE ' },
    ] });
    assert.equal(f.run(csv({ tx_type: direction, source_account: ' bank ', target_account: ' SHARED NAME ' })).ok, true);
    assert.equal(f.submitted[0].source_account, bank.id);
    assert.equal(f.submitted[0].target_account, mortgage.id);
  }
});

test('hints match trimmed, case-insensitive account type or sub_type values', () => {
  const f = fixture({ accounts: [bank, { ...property, sub_type: ' Property ' }, { ...mortgage, type: ' LIABILITY ', sub_type: undefined }],
    categories: [{ ...category, target_account_types: 'liability' }] });
  assert.equal(f.run(csv()).ok, true);
  assert.equal(f.submitted[0].target_account, mortgage.id);
});

test('UUIDs take precedence over names and category hints, without changing identity', () => {
  const f = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another', account_name: property.id }] });
  assert.equal(f.run(csv({ target_account: property.id.toUpperCase() })).ok, true);
  assert.equal(f.submitted[0].target_account, property.id);
});

test('duplicate UUIDs cannot be narrowed by category hints', () => {
  const f = fixture({ accounts: [bank, property, { ...mortgage, id: property.id.toUpperCase() }] });
  const result = f.run(csv({ target_account: property.id }));
  assert.equal(result.error, 'invalid_csv_rows');
  assert.match(result.errors[0], /ambiguous account/);
  assert.equal(f.submitted.length, 0);
});

test('unique names and UUIDs continue to work without categories or with different hints', () => {
  for (const categories of [undefined, [], [category]]) {
    const f = fixture({ accounts: [bank, property], categories });
    assert.equal(f.run(csv()).ok, true);
    assert.equal(f.submitted[0].target_account, property.id);
  }
});

test('only one active category with the complete exact key can disambiguate accounts', () => {
  for (const categories of [undefined, [], [category, category],
    [{ ...category, record_status: 'inactive' }], [{ ...category, record_status: 'locked' }],
    [{ ...category, tx_type_key: 'money-in' }], [{ ...category, major_category_key: 'other' }],
    [{ ...category, minor_category_key: 'other' }]]) {
    const f = fixture({ categories });
    const result = f.run(csv());
    assert.equal(f.submitted.length, 0);
    assert.match(result.errors[0], /^Row 2: ambiguous account: "Shared name" \(target_account\)/);
    assert.match(result.errors[0], /Use an account UUID/);
  }
  const f = fixture({ categories: [{ ...category, record_status: 'deleted' }, category] });
  assert.equal(f.run(csv()).ok, true);
  assert.equal(f.submitted[0].target_account, mortgage.id);
});

test('empty, unmatched and broad hints never choose the first duplicate account', () => {
  for (const hint of [undefined, '', ' , ', 'unmatched', 'property, mortgage']) {
    const result = fixture({ categories: [{ ...category, target_account_types: hint }] }).run(csv());
    assert.match(result.errors[0], /ambiguous account/);
  }
  const result = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another' }] }).run(csv());
  assert.match(result.errors[0], /ambiguous account/);
});

test('historical inactive and locked accounts retain their identity during name resolution', () => {
  for (const status of ['inactive', 'locked']) {
    const f = fixture({ accounts: [bank, property, { ...mortgage, record_status: status }] });
    assert.equal(f.run(csv()).ok, true);
    assert.equal(f.submitted[0].target_account, mortgage.id);
  }
});

test('deleted accounts are not candidates: they neither match nor make a name ambiguous', () => {
  const unique = fixture({ accounts: [bank, { ...property, record_status: 'deleted' }, mortgage], categories: [] });
  assert.equal(unique.run(csv()).ok, true);
  assert.equal(unique.submitted[0].target_account, mortgage.id);
  const gone = fixture({ accounts: [bank, { ...mortgage, record_status: 'deleted' }] });
  assert.match(gone.run(csv({ target_account: mortgage.id })).errors[0], /unknown account: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" \(target_account\)/);
});

test('unknown accounts identify the failing field and blank optional accounts stay blank', () => {
  const f = fixture();
  assert.match(f.run(csv({ source_account: 'Missing' })).errors[0], /unknown account: "Missing" \(source_account\)/);
  assert.equal(f.run(csv({ target_account: '' })).ok, true);
  assert.equal(f.submitted[0].target_account, '');
});

test('an unresolved name anywhere blocks the whole file before the bulk write', () => {
  const f = fixture({ accounts: [bank, property, mortgage, { ...mortgage, id: 'another' }] });
  const good = csv({ target_account: bank.id }).split('\n')[1].replace('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  const result = f.run(csv() + '\n' + good);
  assert.equal(result.error, 'invalid_csv_rows');
  assert.equal(result.errors.length, 1);
  assert.equal(f.submitted.length, 0);
});

test('the add-form account dropdown applies the same hint rule as CSV resolution', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/sections/transactions.js'), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ esc: value => String(value) });
  vm.runInContext(source + '\nglobalThis.testExports = { _acctOptsWithHints };', context);
  const options = context.testExports._acctOptsWithHints([property, mortgage], ' MORTGAGE ');
  assert.match(options, new RegExp(mortgage.id));
  assert.ok(!options.includes(property.id));
});
