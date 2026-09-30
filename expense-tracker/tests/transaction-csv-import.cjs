// importTransactionsCsv: server-side parsing, format validation and the single
// bulk call. Converted from the retired browser parser (_parseTxCsv) tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');

const BANK = { id: 'a0000000-0000-4000-8000-000000000001', account_name: 'Bank', type: 'asset', sub_type: 'current', record_status: 'active' };
const WALLET = { id: 'a0000000-0000-4000-8000-000000000002', account_name: 'Wallet', type: 'asset', sub_type: 'current', record_status: 'active' };
const STATUSES = ['active', 'inactive', 'deleted', 'locked'];

// Stubs the Sheet readers and the bulk writer so format checks are isolated.
function runtime({ accounts = [BANK, WALLET], categories = [], bulk } = {}) {
  const calls = { bulk: [], accounts: 0, categories: 0 };
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  for (const file of ['app-utils.gs', 'sync-utils.gs', 'csv-import.gs', 'transaction-schema.gs', 'transaction-core.gs', 'transaction-import.gs']) {
    vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  }
  ctx.listAccounts = () => { calls.accounts++; return accounts; };
  ctx.listCategories = () => { calls.categories++; return categories; };
  ctx.getOrCreateSheet = () => { throw new Error('unexpected sheet access'); };
  ctx.createTransactionsBulk = body => {
    calls.bulk.push(JSON.parse(JSON.stringify(body.transactions)));
    if (bulk !== undefined) return bulk(body);
    return { ok: true, created: body.transactions.length, updated: 0, failed: 0, results: body.transactions.map(tx => ({ key: tx.id, ok: true, action: 'created' })) };
  };
  const run = (csv, extra = {}) => JSON.parse(JSON.stringify(ctx.importTransactionsCsv({ csv, ...extra })));
  return { ctx, calls, run };
}

const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const csv = (rows, columns = Object.keys(rows[0])) => columns.join(',') + '\r\n' + rows.map(row => columns.map(key => quote(row[key])).join(',')).join('\r\n');
const transaction = extra => ({
  tx_date_local: '2026-09-25 10:00:42.123456', tx_type: 'money-out', source_account: 'Bank', source_amount_local: '90071992547409.91',
  major_category: 'food', minor_category: 'groceries', description: 'Line one\r\nLine two, "quoted"', ...extra,
});
const headers = 'id,tx_date_local,tx_type,source_account,source_amount_local,major_category,minor_category';
const uuid = index => 'b0000000-0000-4000-8000-' + String(index).padStart(12, '0');
const csvRow = index => `${uuid(index)},2026-09-24 09:00:00,money-out,Bank,10,food,lunch`;

test('quoted multiline descriptions round-trip and amount text is kept exactly', () => {
  const { run, calls } = runtime();
  const result = run(csv([transaction()]));
  assert.equal(result.ok, true);
  assert.equal(calls.bulk[0][0].description, transaction().description);
  assert.equal(calls.bulk[0][0].source_amount_local, '90071992547409.91');
  assert.equal(calls.bulk[0][0].source_account, BANK.id);
});

test('header failures are actionable and nothing is written', () => {
  const { run, calls } = runtime();
  for (const source of ['id\na', 'tx_date_local,tx_date_local\none,two', 'id,\na,b']) {
    const result = run(source);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, source);
  }
  assert.match(run('id\na').errors[0], /Missing required headers: tx_date_local, tx_type, major_category, minor_category, source_amount_local or target_amount_local/);
  assert.equal(run('tx_date_local,tx_type,major_category,minor_category,target_amount_local\n2026-09-01 08:00:00,money-in,a,b,1').ok, true);
  assert.equal(run(headers).error, 'csv_has_no_rows');
  assert.equal(run('').error, 'missing_csv');
  assert.equal(calls.bulk.length, 1);
});

test('missing required values and amounts are reported per line, joined for the row', () => {
  const { run, calls } = runtime();
  const result = run(csv([transaction({ tx_date_local: '', tx_type: '', source_amount_local: '', major_category: '', minor_category: '' })], [...Object.keys(transaction()), 'target_amount_local']));
  assert.equal(result.error, 'invalid_csv_rows');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0], 'Row 2: missing tx_date_local; missing tx_type; missing amount (source_amount_local or target_amount_local); missing major_category; missing minor_category');
  assert.equal(calls.bulk.length, 0);
});

test('a repeated id anywhere in the file (case-insensitive) rejects the whole file with the first line', () => {
  const { run, calls } = runtime();
  const id = uuid(1);
  const rows = [transaction({ id }), transaction({ id: uuid(2) }), transaction({ id: ` ${id.toUpperCase()} ` }), transaction({ id: '' }), transaction({ id: '' })];
  const result = run(csv(rows));
  assert.equal(result.errors.length, 1, result.errors.join('; '));
  // Line 2 is the first data row; the multiline description makes every row two physical lines.
  assert.match(result.errors[0], /^Row 6: duplicate id: already used on row 2$/);
  assert.equal(calls.bulk.length, 0);
});

test('tx_date_local syntax and tx_type values are format errors found without Sheet reads', () => {
  const { run, calls } = runtime();
  for (const [date, type, message] of [
    ['2026-09-24', 'money-out', 'Row 2: invalid tx_date_local: expected YYYY-MM-DD HH:MM:SS'],
    ['2026-02-30 10:00:00', 'money-out', 'Row 2: invalid tx_date_local: expected YYYY-MM-DD HH:MM:SS'],
    ['2026-09-24 10:00:00', 'transfer', 'Row 2: invalid tx_type: "transfer" (expected money-in, money-out)'],
  ]) {
    assert.deepEqual(run(`${headers}\n${uuid(1)},${date},${type},Bank,10,food,lunch`, { dry_run: true }).errors, [message]);
  }
  assert.equal(calls.accounts + calls.categories + calls.bulk.length, 0);
});

test('a non-UUID id is a format error found without Sheet reads', () => {
  const { run, calls } = runtime();
  const result = run(headers + '\nnot-a-uuid,2026-09-24 09:00:00,money-out,Bank,10,food,lunch', { dry_run: true });
  assert.match(result.errors[0], /Row 2: invalid id: expected a UUID/);
  assert.equal(calls.accounts + calls.categories, 0);
});

test('rows without an id are counted so the UI can warn they insert again on every import', () => {
  const { run } = runtime();
  const rows = [transaction({ id: uuid(1) }), transaction({ id: '' }), transaction({ id: '' })];
  assert.equal(run(csv(rows)).without_id, 2);
  assert.equal(run(csv(rows), { dry_run: true }).without_id, 2);
  assert.equal(run(csv([transaction()])).without_id, 1);
});

test('dry_run checks format only: no account/category reads, no bulk call, unknown names pass', () => {
  const { run, calls } = runtime();
  const result = run(csv([transaction({ id: '', source_account: 'Nowhere' }), transaction({ id: uuid(3) })]), { dry_run: true });
  assert.deepEqual(result, { ok: true, dry_run: true, rows: 2, without_id: 1 });
  assert.equal(calls.accounts + calls.categories + calls.bulk.length, 0);
  assert.match(run(csv([transaction({ source_amount_local: '1,5' })]), { dry_run: true }).errors[0], /invalid source_amount_local/);
});

test('the whole file goes to createTransactionsBulk in one call and results carry their CSV line', () => {
  const { run, calls } = runtime({ bulk: body => ({ ok: false, created: body.transactions.length - 1, updated: 0, failed: 1,
    results: body.transactions.map((tx, index) => index === 1 ? { key: tx.id, ok: false, error: 'unknown_category' } : { key: tx.id, ok: true, action: 'created' }) }) });
  const source = headers + '\n' + Array.from({ length: 60 }, (_, index) => csvRow(index + 1)).join('\n');
  const result = run(source);
  assert.equal(calls.bulk.length, 1);
  assert.equal(calls.bulk[0].length, 60);
  assert.equal(result.rows, 60);
  assert.deepEqual(result.results.slice(0, 3).map(entry => entry.line), [2, 3, 4]);
  assert.equal(result.results[1].error, 'unknown_category');
  assert.equal(result.results[59].line, 61);
});

test('bulk failures without results pass through with rows and without_id', () => {
  const { run } = runtime({ bulk: () => ({ ok: false, error: 'invalid_existing_transaction_id', row_num: 7 }) });
  const result = run(headers + '\n' + csvRow(1));
  assert.deepEqual(result, { ok: false, error: 'invalid_existing_transaction_id', row_num: 7, rows: 1, without_id: 0 });
});

test('the shaped row matches the compact import contract; T becomes a space in tx_date_local', () => {
  const { run, calls } = runtime();
  run('id,tx_date_local,tx_timezone_local,tx_type,source_account,target_account,source_amount_local,target_amount_local,major_category,minor_category,description,counterparty_name,tx_tags,beneficiaries,user_location_area,user_location_city,user_location_country,user_location_latitude,user_location_longitude,sync_status,created_at\n'
    + `${uuid(1)},2026-09-24T10:00:00,Europe/London,money-out,Bank,wallet,10.50,10.5,transfer,bank,d,c,t1;t2,rohit:100,Area,City,UK,51.5,-0.1,in-sync,2020-01-01`);
  assert.deepEqual(calls.bulk[0][0], {
    id: uuid(1), tx_date_local: '2026-09-24 10:00:00', tx_type: 'money-out', source_account: BANK.id, target_account: WALLET.id,
    source_amount_local: '10.50', target_amount_local: '10.5', user_location_latitude: 51.5, user_location_longitude: -0.1,
    major_category: 'transfer', minor_category: 'bank', tx_timezone_local: 'Europe/London', user_location_area: 'Area', user_location_city: 'City',
    user_location_country: 'UK', description: 'd', counterparty_name: 'c', tx_tags: 't1;t2', beneficiaries: 'rohit:100',
  });
});

// ── Lifecycle (converted from transaction-import-lifecycle-frontend.cjs) ─────

test('every supplied lifecycle status reaches the bulk request, trimmed', () => {
  const { run, calls } = runtime();
  run(headers + ',record_status\n' + STATUSES.map((status, index) => csvRow(index) + ', ' + status + ' ').join('\n'));
  assert.deepEqual(calls.bulk[0].map(row => row.record_status), STATUSES);
});

test('omitted and blank lifecycle values are absent so an existing status survives', () => {
  const { run, calls } = runtime();
  run(headers + '\n' + csvRow(1));
  run(headers + ',record_status\n' + csvRow(2) + ',   ');
  assert.equal(calls.bulk.length, 2);
  assert.ok(calls.bulk.flat().every(row => !Object.hasOwn(row, 'record_status')));
});

test('invalid lifecycle values are reported against the transaction schema, never defaulted', () => {
  const { run, calls, ctx } = runtime();
  const result = run(headers + ',record_status\n' + csvRow(1) + ',archived');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0], 'Row 2: invalid record_status: "archived" (expected ' + STATUSES.join(', ') + ')');
  assert.equal(calls.bulk.length, 0);
  vm.runInContext("TRANSACTION_SCHEMA.record_status.enum_values = ['review'];", ctx);
  const narrowed = run(headers + ',record_status\n' + csvRow(1) + ',review\n' + csvRow(2) + ',active');
  assert.deepEqual(narrowed.errors, ['Row 3: invalid record_status: "active" (expected review)']);
});

// ── Numeric syntax (converted from transaction-import-lifecycle-frontend.cjs) ─

function numericCsv(overrides) {
  const row = {
    id: uuid(1), tx_date_local: '2026-09-24 09:00:00', tx_type: 'money-out', source_account: 'Bank', source_amount_local: '10', target_amount_local: '',
    major_category: 'food', minor_category: 'lunch', user_location_latitude: '', user_location_longitude: '', ...overrides,
  };
  return csv([row]);
}
const NUMERIC_FIELDS = ['source_amount_local', 'target_amount_local', 'user_location_latitude', 'user_location_longitude'];

test('amounts and coordinates reject malformed numeric text instead of importing a numeric prefix', () => {
  const { run, calls } = runtime();
  for (const field of NUMERIC_FIELDS) {
    for (const value of ['12bad', '1,234.56', '1,23', 'Infinity', '-Infinity', 'NaN', '0x10', '1e309', '1_000', '1e', '12 34']) {
      const result = run(numericCsv({ [field]: value }), { dry_run: true });
      assert.equal(result.errors.length, 1, field + ' must reject ' + value);
      assert.match(result.errors[0], new RegExp('Row 2: invalid ' + field + ': expected a finite decimal number without grouping separators'));
    }
  }
  assert.equal(calls.bulk.length, 0);
});

test('amounts and coordinates accept full finite decimals; amounts keep exact text, coordinates become numbers', () => {
  for (const field of NUMERIC_FIELDS) {
    for (const value of ['12.50', '.125', '12.', '+12.3', '-0.25', '1.2e-2', ' 10.25 ', '0']) {
      const { run, calls } = runtime();
      assert.equal(run(numericCsv({ [field]: value })).ok, true, field + ' must accept ' + value);
      assert.equal(calls.bulk[0][0][field], field.endsWith('_amount_local') ? value.trim() : Number(value));
    }
  }
});

test('blank numeric fields stay blank and zero coordinates stay zero', () => {
  const blank = runtime();
  blank.run(numericCsv({ source_amount_local: '', target_amount_local: '10' }));
  assert.equal(blank.calls.bulk[0][0].source_amount_local, '');
  assert.equal(blank.calls.bulk[0][0].user_location_latitude, '');
  assert.equal(blank.calls.bulk[0][0].user_location_longitude, '');
  const zero = runtime();
  zero.run(numericCsv({ user_location_latitude: '0', user_location_longitude: '0' }));
  assert.equal(zero.calls.bulk[0][0].user_location_latitude, 0);
  assert.equal(zero.calls.bulk[0][0].user_location_longitude, 0);
});

// ── Real createTransactionsBulk: compact transfer rows expand to two legs ────

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  getRange(start, column, count = 1, width = 1) {
    return {
      setValues: rows => { this.writes++; rows.forEach((row, offset) => { this.rows[start - 1 + offset] = row.slice(); }); },
      clearContent: () => { this.writes++; },
    };
  }
}

test('one compact transfer row becomes a parent and child through the existing bulk import', () => {
  let generated = 0;
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, TRANSACTIONS_SHEET: 'transaction_master',
    Utilities: { getUuid: () => 'f0000000-0000-4000-8000-' + String(++generated).padStart(12, '0') } });
  for (const file of ['app-utils.gs', 'sync-utils.gs', 'csv-import.gs', 'transaction-schema.gs', 'transaction-utils.gs', 'transaction-validation.gs', 'transaction-core.gs', 'transaction-import.gs']) {
    vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  }
  const sheet = new Sheet('transaction_master', [ctx.getTransactionSheetColumns()]);
  ctx.getOrCreateSheet = () => sheet;
  ctx.listAccounts = () => [BANK, WALLET];
  ctx.listCategories = () => [];
  ctx._buildCategoryMap = () => ({
    'money-out|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-in|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
  });
  ctx._loadAccountMap = () => ({ [BANK.id]: { account_currency_local: 'GBP' }, [WALLET.id]: { account_currency_local: 'GBP' } });
  const result = JSON.parse(JSON.stringify(ctx.importTransactionsCsv({ csv: 'id,tx_date_local,tx_timezone_local,tx_type,source_account,target_account,source_amount_local,target_amount_local,major_category,minor_category\n'
    + `${uuid(9)},2026-09-24 12:00:00,Europe/London,money-out,Bank,Wallet,10.25,10.25,transfer,bank` })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ key: uuid(9), ok: true, action: 'created', line: 2 }]);
  const col = key => ctx.txColIndex(key);
  assert.equal(sheet.rows.length, 3);
  assert.deepEqual(sheet.rows.slice(1).map(row => [row[col('tx_type')], row[col('account_id')], row[col('parent_tx_id')]]),
    [['money-out', BANK.id, ''], ['money-in', WALLET.id, uuid(9)]]);
});
