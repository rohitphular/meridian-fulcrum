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
  const context = vm.createContext({ ...globals });
  vm.runInContext(source + '\nglobalThis.testExports = {' + exports.join(',') + '};', context);
  return context.testExports;
}

const { parseCsvRecords } = load('core/utils.js', {}, ['parseCsvRecords']);
const headers = 'id,tx_date_local,tx_type,source_account,source_amount_local,major_category,minor_category';
const csvRow = index => `transaction-${index},2026-09-24,money-out,Bank,10,food,lunch`;
const statuses = ['active', 'inactive', 'deleted', 'locked'];

function fixture(transactionSchema = { record_statuses: statuses }) {
  const submitted = [];
  const parser = load('sections/transactions.js', {
    state: { accounts: [{ id: 'bank-id', account_name: 'Bank' }], transactionSchema },
    parseCsvRecords,
    el: () => null,
    showLoading() {}, hideLoading() {}, showMsg() {},
    document: { dispatchEvent() {} }, CustomEvent: class {},
    ExpenseAPI: {
      async createTransactionsBulk(payload) {
        submitted.push(...payload.transactions);
        return { ok: true, created: 0, updated: payload.transactions.length, failed: 0, results: payload.transactions.map(row => ({ ok: true, action: 'updated', key: row.id })) };
      },
    },
  }, ['_parseTxCsv', '_submitTxImport']);
  return { ...parser, submitted };
}

test('transaction CSV forwards every supplied lifecycle status through the bulk request', async () => {
  const frontend = fixture();
  const csv = headers + ',record_status\n' + statuses.map((status, index) => csvRow(index) + ', ' + status + ' ').join('\n');
  const parsed = frontend._parseTxCsv(csv);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(Array.from(parsed.transactions, row => row.record_status), statuses);
  await frontend._submitTxImport(parsed.transactions);
  assert.deepEqual(frontend.submitted.map(row => row.record_status), statuses);
});

test('omitted and blank CSV lifecycle values are absent from the request so existing status survives', async () => {
  const frontend = fixture();
  for (const csv of [headers + '\n' + csvRow(1), headers + ',record_status\n' + csvRow(2) + ',   ']) {
    const parsed = frontend._parseTxCsv(csv);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.transactions.length, 1);
    assert.equal(Object.hasOwn(parsed.transactions[0], 'record_status'), false);
    await frontend._submitTxImport(parsed.transactions);
  }
  assert.equal(frontend.submitted.length, 2);
  assert.ok(frontend.submitted.every(row => !Object.hasOwn(row, 'record_status')));
});

test('invalid lifecycle values are reported and excluded rather than defaulted to active', () => {
  const frontend = fixture();
  const parsed = frontend._parseTxCsv(headers + ',record_status\n' + csvRow(1) + ',archived');
  assert.equal(parsed.transactions.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /Row 2: invalid record_status: "archived"/);
});

test('CSV lifecycle validation follows the returned transaction schema', () => {
  const frontend = fixture({ record_statuses: ['review'] });
  const parsed = frontend._parseTxCsv(headers + ',record_status\n' + csvRow(1) + ',review\n' + csvRow(2) + ',active');
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].record_status, 'review');
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /Row 3: invalid record_status: "active" \(expected review\)/);
});

test('missing lifecycle schema fails supplied statuses explicitly while preserving omitted statuses', () => {
  const frontend = fixture({});
  const parsed = frontend._parseTxCsv(headers + ',record_status\n' + csvRow(1) + ',deleted');
  assert.equal(parsed.transactions.length, 0);
  assert.match(parsed.errors[0], /transaction status schema is unavailable/);
  const omitted = frontend._parseTxCsv(headers + '\n' + csvRow(2));
  assert.equal(omitted.errors.length, 0);
  assert.equal(Object.hasOwn(omitted.transactions[0], 'record_status'), false);
});

function numericCsv(overrides) {
  const row = {
    id: 'transaction-1', tx_date_local: '2026-09-24', tx_type: 'money-out',
    source_account: 'Bank', source_amount_local: '10', target_amount_local: '',
    major_category: 'food', minor_category: 'lunch', user_location_latitude: '', user_location_longitude: '',
    ...overrides,
  };
  const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
  return Object.keys(row).join(',') + '\n' + Object.values(row).map(quote).join(',');
}

test('CSV amounts and coordinates reject malformed numeric text instead of importing a numeric prefix', () => {
  const frontend = fixture();
  for (const field of ['source_amount_local', 'target_amount_local', 'user_location_latitude', 'user_location_longitude']) {
    for (const value of ['12bad', '1,234.56', '1,23', 'Infinity', '-Infinity', 'NaN', '0x10', '1e309', '1_000', '1e', '12 34']) {
      const parsed = frontend._parseTxCsv(numericCsv({ [field]: value }));
      assert.equal(parsed.transactions.length, 0, field + ' must reject ' + value);
      assert.equal(parsed.errors.length, 1);
      assert.match(parsed.errors[0], new RegExp('Row 2: invalid ' + field + ': expected a finite decimal number'));
    }
  }
});

test('CSV amounts and coordinates accept full finite decimal strings with exact amount text', () => {
  const frontend = fixture();
  for (const field of ['source_amount_local', 'target_amount_local', 'user_location_latitude', 'user_location_longitude']) {
    for (const value of ['12.50', '.125', '12.', '+12.3', '-0.25', '1.2e-2', ' 10.25 ', '0']) {
      const parsed = frontend._parseTxCsv(numericCsv({ [field]: value }));
      assert.equal(parsed.errors.length, 0, field + ' must accept ' + value);
      assert.equal(parsed.transactions[0][field], field.endsWith('_amount_local') ? value.trim() : Number(value));
    }
  }
});

test('CSV numeric fields retain blank values and zero coordinates distinctly', () => {
  const frontend = fixture();
  const blank = frontend._parseTxCsv(numericCsv({ source_amount_local: '', target_amount_local: '10' }));
  assert.equal(blank.errors.length, 0);
  assert.equal(blank.transactions[0].source_amount_local, '');
  assert.equal(blank.transactions[0].user_location_latitude, '');
  assert.equal(blank.transactions[0].user_location_longitude, '');
  const zero = frontend._parseTxCsv(numericCsv({ user_location_latitude: '0', user_location_longitude: '0' }));
  assert.equal(zero.errors.length, 0);
  assert.equal(zero.transactions[0].user_location_latitude, 0);
  assert.equal(zero.transactions[0].user_location_longitude, 0);
});
