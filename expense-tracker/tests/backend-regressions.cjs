const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const api = path.join(__dirname, '../api');
function runtime(files, globals = {}) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, ...globals });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(api, file), 'utf8'), ctx);
  return ctx;
}
class Sheet {
  constructor(rows) { this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  getLastRow() { return this.rows.length; }
  appendRow(row) { this.rows.push(row.slice()); this.writes++; }
  getRange(start, column, count, width) {
    assert.ok(Number.isInteger(start));
    return {
      setValues: rows => { this.writes++; rows.forEach((row, i) => { this.rows[start - 1 + i] = row.slice(); }); },
      clearContent: () => { this.writes++; this.rows.splice(start - 1, count); },
    };
  }
}
function transactions() {
  let id = 0;
  const ctx = runtime(['app-utils.gs', 'transaction-schema.gs', 'transaction-utils.gs', 'transaction-validation.gs', 'transaction-core.gs'], {
    TRANSACTIONS_SHEET: 'transactions', SYNC_STATUS_CREATE_PENDING: 'create-pending',
    Utilities: { getUuid: () => 'generated-' + ++id }, computeSyncStatus: status => status === 'create-pending' ? status : 'update-pending',
  });
  const sheet = new Sheet([ctx.getTransactionSheetColumns()]);
  ctx.getOrCreateSheet = () => sheet;
  ctx._buildCategoryMap = () => ({
    'money-out|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-out|expense|food': { source_account_mandatory: true, target_account_mandatory: false },
  });
  ctx._loadAccountMap = () => ({ a: { account_currency_local: 'GBP' }, b: { account_currency_local: 'GBP' } });
  const transfer = { id: 'one', tx_type: 'money-out', tx_date_local: '2026-09-23 09:00:00', major_category: 'transfer', minor_category: 'bank', source_account: 'a', target_account: 'b', source_amount_local: 10, target_amount_local: 12 };
  return { ctx, sheet, transfer };
}
test('unset PIN fails closed', () => {
  const ctx = runtime(['app-utils.gs'], { PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } });
  assert.equal(ctx.checkPin(undefined), false);
  assert.equal(ctx.checkPin(''), false);
});
test('POST shape guard and lock release on dispatch exception', () => {
  let released = 0;
  const ctx = runtime(['app-router.gs'], {
    json: value => value, extractMeta: () => ({ ip: 'test' }), checkLocked: () => false, checkPin: () => true, recordAccess() {},
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) },
    createTransaction() { throw new Error('sheet failure'); },
  });
  assert.equal(ctx.doPost({ postData: { contents: 'null' } }).error, 'invalid_request');
  assert.equal(ctx.doPost({ postData: { contents: '{"action":"create_transaction"}' } }).error, 'request_failed');
  assert.equal(released, 1);
});
test('incorrect TOTP records failed access', () => {
  const attempts = [];
  const ctx = runtime(['app-router.gs'], { json: value => value, extractMeta: () => ({ ip: 'test' }), checkLocked: () => false, checkPin: () => true, verifyTotp: () => false, recordAccess: (_, success) => attempts.push(success) });
  assert.equal(ctx.doGet({ parameter: { action: 'verify' } }).error, 'totp_invalid');
  assert.deepEqual(attempts, [false]);
});
test('same CSV ID twice does not create duplicate transfer legs', () => {
  const { ctx, sheet, transfer } = transactions();
  const result = ctx.createTransactionsBulk({ transactions: [transfer, transfer] });
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].error, 'duplicate_id_in_batch');
  assert.equal(sheet.rows.length, 3);
});
test('reimport preserves transfer child ID and creation timestamp', () => {
  const { ctx, sheet, transfer } = transactions();
  ctx.createTransactionsBulk({ transactions: [transfer] });
  const child = sheet.rows[2].slice();
  ctx.createTransactionsBulk({ transactions: [{ ...transfer, target_amount_local: 20 }] });
  assert.equal(sheet.rows[2][ctx.txColIndex('id')], child[ctx.txColIndex('id')]);
  assert.equal(sheet.rows[2][ctx.txColIndex('created_at')], child[ctx.txColIndex('created_at')]);
  assert.equal(sheet.rows[2][ctx.txColIndex('tx_amount_local')], 20);
});
test('explicit malformed target amounts fail without sheet writes; missing target defaults', () => {
  for (const amount of ['bad', 0, -2, Infinity]) {
    const { ctx, sheet, transfer } = transactions();
    const result = ctx.createTransactionsBulk({ transactions: [{ ...transfer, target_amount_local: amount }] });
    assert.equal(result.failed, 1);
    assert.equal(sheet.writes, 0);
  }
  const { ctx, transfer } = transactions();
  assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, target_amount_local: '' }] }).ok, true);
});
test('malformed import row reports row error', () => {
  const { ctx, sheet } = transactions();
  assert.equal(ctx.createTransactionsBulk({ transactions: [null] }).results[0].error, 'invalid_row');
  assert.equal(sheet.writes, 0);
});
test('balance includes cutoff timestamp and skips corrupt amount and earlier history', () => {
  const sheet = new Sheet([
    ['account_id', 'tx_amount_local', 'tx_type', 'record_status', 'tx_date_local'],
    ['a', 100, 'money-in', 'active', '2026-01-01 00:00:00'],
    ['a', 20, 'money-in', 'active', '2026-02-01 00:00:00'],
    ['a', 'bad', 'money-out', 'active', '2026-02-02 00:00:00'],
    ['a', 3, 'money-out', 'deleted', '2026-02-02 00:00:00'],
  ]);
  const ctx = runtime(['app-utils.gs', 'account-core.gs'], { TRANSACTIONS_SHEET: 'transactions', getTransactionSheetColumns: () => sheet.rows[0], txColIndex: name => sheet.rows[0].indexOf(name) });
  ctx.getOrCreateSheet = () => sheet;
  assert.equal(ctx._buildAccountNetMap([{ id: 'a', tracking_start_date_local: '2026-02-01 00:00:00' }]).a, 20);
  assert.equal(ctx._buildAccountNetMap([{ id: 'a', tracking_start_date_local: '' }]).a, 120);
});
test('fractional account row rejected before reading data or writing', () => {
  const ctx = runtime(['account-core.gs'], { ACCOUNTS_SHEET: 'accounts', getAccountSheetColumns: () => [], getOrCreateSheet: () => ({ getLastRow: () => 10 }) });
  for (const action of ['updateAccount', 'deleteAccount', 'restoreAccount']) assert.equal(ctx[action]({ row_num: 2.5 }).error, 'invalid_row');
});
test('subscription amount must be finite', () => {
  const ctx = runtime(['subscription-validation.gs']);
  assert.equal(ctx.validateSubscriptionCreate({ subscription_name: 'Example', subscription_amount_local: Infinity }).error, 'invalid_subscription_amount_local');
});
test('registry keys exclude prototype and detail rows normalize stored IDs', () => {
  const ctx = runtime(['app-config.gs', 'import-registry.gs', 'import-core.gs']);
  assert.equal(ctx.getImportSpec('constructor'), null);
  const spec = ctx.getImportSpec('account_deposit');
  const sheet = new Sheet([spec.columns]);
  const lookup = Object.create(null), values = sheet.rows.slice();
  assert.equal(ctx._importRow(sheet, spec, null, {}, lookup, values).error, 'invalid_row');
  assert.equal(ctx._importRow(sheet, spec, { id: ' detail ', account_id: ' a ' }, { a: 'cash' }, lookup, values).ok, true);
  assert.equal(sheet.rows[1][0], 'detail');
  assert.equal(sheet.rows[1][1], 'a');
});

test('transfer converted to single preserves removed child as sync tombstone', () => {
  const { ctx, sheet, transfer } = transactions();
  ctx.createTransactionsBulk({ transactions: [transfer] });
  const childId = sheet.rows[2][ctx.txColIndex('id')];
  sheet.rows[2][ctx.txColIndex('sync_status')] = 'synced';
  ctx.createTransactionsBulk({ transactions: [{ ...transfer, major_category: 'expense', minor_category: 'food' }] });
  const child = sheet.rows.find(row => row[ctx.txColIndex('id')] === childId);
  assert.equal(child[ctx.txColIndex('record_status')], 'deleted');
  assert.equal(child[ctx.txColIndex('sync_status')], 'update-pending');
});
test('interactive transfer writes both legs in one call', () => {
  const { ctx, sheet, transfer } = transactions();
  assert.equal(ctx.createTransaction(transfer).ok, true);
  assert.equal(sheet.writes, 1);
  assert.equal(sheet.rows.length, 3);
  assert.equal(sheet.rows[2][ctx.txColIndex('parent_tx_id')], sheet.rows[1][ctx.txColIndex('id')]);
});
test('importing transfer child as parent is rejected without changing pair', () => {
  const { ctx, sheet, transfer } = transactions();
  ctx.createTransactionsBulk({ transactions: [transfer] });
  const snapshot = JSON.stringify(sheet.rows);
  const childId = sheet.rows[2][ctx.txColIndex('id')];
  assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, id: childId }] }).results[0].error, 'transfer_child_id_requires_parent');
  assert.equal(JSON.stringify(sheet.rows), snapshot);
});
test('detail numeric validation rejects malformed values before writes', () => {
  const ctx = runtime(['app-config.gs', 'import-registry.gs', 'import-core.gs']);
  const spec = ctx.getImportSpec('account_liability_credit_card');
  const sheet = new Sheet([spec.columns]);
  const result = ctx._importRow(sheet, spec, { id: 'card', account_id: 'a', credit_limit_local: 'not-a-number' }, { a: 'credit_card' }, Object.create(null), sheet.rows.slice());
  assert.equal(result.error, 'invalid_credit_limit_local');
  assert.equal(sheet.writes, 0);
});
test('native Sheets dates retain timestamp for cutoff comparisons', () => {
  const ctx = runtime(['app-utils.gs']);
  const date = new Date('2026-09-01T12:30:00Z');
  assert.equal(ctx.sheetDateTimeToDate(date).getTime(), date.getTime());
});
test('advisor uses renamed fields and converts mixed currency flows to XAU', () => {
  const now = new Date().toISOString();
  const ctx = runtime(['app-utils.gs', 'advisor-core.gs'], {
    listAccounts: () => [
      { id: 'a', account_name: 'A', account_currency_local: 'GBP', current_value_local: 100, record_status: 'active', type: 'asset' },
      { id: 'b', account_name: 'B', account_currency_local: 'INR', current_value_local: 200, record_status: 'active', type: 'asset' },
    ],
    listRates: () => [{ currency: 'GBP', rate: 100 }, { currency: 'INR', rate: 200 }],
    isLiabilityType: () => false, TRANSACTIONS_SHEET: 'transactions', getTransactionSheetColumns: () => [],
  });
  ctx.getOrCreateSheet = () => ({});
  ctx.sheetToObjects = () => [
    { account_id: 'a', tx_date_local: now, tx_type: 'money-out', tx_amount_local: 100, record_status: 'active' },
    { account_id: 'b', tx_date_local: now, tx_type: 'money-out', tx_amount_local: 200, record_status: 'active' },
    { account_id: 'b', tx_date_local: now, tx_type: 'money-out', tx_amount_local: 999, record_status: 'deleted' },
    { account_id: 'b', tx_date_local: now, tx_type: 'money-out', tx_amount_local: 'bad', record_status: 'active' },
  ];
  const snapshot = ctx._buildSnapshot();
  assert.equal(snapshot.net_worth_xau, 2);
  assert.equal(snapshot.accounts[0].name, 'A');
  assert.equal(snapshot.last_3_months.total_expense, 2);
  assert.equal(snapshot.last_3_months.currency, 'XAU');
  assert.equal(snapshot.omitted_transactions, 2);
});
test('legacy sheet layout fails before any header write', () => {
  const sheet = { getLastColumn: () => 2, getRange: () => ({ getValues: () => [['id', 'old_currency']] }) };
  const ctx = runtime(['app-utils.gs'], { SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) } });
  assert.throws(() => ctx.getOrCreateSheet('accounts', ['id', 'account_currency_local']), /sheet_header_mismatch/);
});

test('cross-currency transfer requires target amount in interactive and bulk paths', () => {
  for (const bulk of [false, true]) {
    const { ctx, sheet, transfer } = transactions();
    ctx._loadAccountMap = () => ({ a: { account_currency_local: 'GBP' }, b: { account_currency_local: 'INR' } });
    const tx = { ...transfer, target_amount_local: '' };
    const result = bulk ? ctx.createTransactionsBulk({ transactions: [tx] }) : ctx.createTransaction(tx);
    assert.equal(bulk ? result.results[0].error : result.error, 'missing_target_amount');
    assert.equal(sheet.writes, 0);
  }
});
test('category with neither mandatory flag still validates the selected target leg', () => {
  for (const bulk of [false, true]) {
    const { ctx, sheet, transfer } = transactions();
    ctx._buildCategoryMap = () => ({ 'money-out|transfer|bank': { source_account_mandatory: false, target_account_mandatory: false } });
    const tx = { ...transfer, target_account: undefined, target_amount_local: undefined };
    const result = bulk ? ctx.createTransactionsBulk({ transactions: [tx] }) : ctx.createTransaction(tx);
    assert.equal(bulk ? result.results[0].error : result.error, 'missing_target_account');
    assert.equal(sheet.writes, 0);
  }
});
