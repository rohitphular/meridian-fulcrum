const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const api = path.join(__dirname, '../api');
const DETAIL_ID = 'a0000000-0000-4000-8000-000000000001';
const DETAIL_ACCOUNT_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPERTY_ACCOUNT_ID = 'c0000000-0000-4000-8000-000000000003';
const EVALUATION_RATE_ID = 'd0000000-0000-4000-8000-000000000004';
const DETAIL_METADATA_COLUMNS = ['record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const AUDITED_DETAIL_CASES = [
  ['account_deposit', 'cash', { interest_rate: 1.25 }, 7],
  ['account_liability_credit_card', 'credit-card', { credit_limit_local: 100 }, 7],
  ['account_liability_mortgage', 'mortgage', { original_principal_local: 100, term_months: 12 }, 10],
  ['account_liability_personal_loan', 'personal-loan', { original_principal_local: 100, term_months: 12 }, 8],
  ['account_investment_property', 'property', { acquisition_type: 'GIFTED' }, 17],
  ['account_investment_stocks', 'stocks-shares', { instrument_type: 'EQUITY' }, 22],
];
function runtime(files, globals = {}) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, getAvailableAccountTypes: () => [
    ['asset', 'cash', 'account_deposit'], ['asset', 'savings', 'account_deposit'], ['asset', 'current', 'account_deposit'],
    ['liability', 'credit-card', 'account_liability_credit_card'], ['liability', 'mortgage', 'account_liability_mortgage'],
    ['liability', 'personal-loan', 'account_liability_personal_loan'], ['investment', 'property', 'account_investment_property'],
    ['investment', 'stocks-shares', 'account_investment_stocks'],
  ].map(([account_type_key, account_subtype_key, detail_sheet]) => ({ account_type_key, account_subtype_key, detail_sheet, record_status: 'active' })), ...globals });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(api, file), 'utf8'), ctx);
  return ctx;
}
class Sheet {
  constructor(rows) { this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getName() { return this.name; }
  appendRow(row) { this.rows.push(row.slice()); this.writes++; }
  deleteColumn(column) {
    assert.ok(Number.isInteger(column) && column >= 1 && column <= this.getLastColumn());
    this.rows.forEach(row => row.splice(column - 1, 1));
    this.deletedColumns = [...(this.deletedColumns || []), column];
    this.writes++;
  }
  getRange(start, column, count, width) {
    assert.ok(Number.isInteger(start));
    const writeRows = rows => {
      this.writes++;
      rows.forEach((row, i) => {
        const destination = this.rows[start - 1 + i] || [];
        row.forEach((value, j) => { destination[column - 1 + j] = value; });
        this.rows[start - 1 + i] = destination;
      });
    };
    return {
      getValues: () => Array.from({ length: count ?? 1 }, (_, i) => Array.from({ length: width ?? 1 }, (_, j) => this.rows[start - 1 + i]?.[column - 1 + j] ?? '')),
      setValues: writeRows,
      setValue: value => writeRows([[value]]),
      clearContent: () => { this.writes++; this.rows.splice(start - 1, count); },
    };
  }
}
function transactions() {
  let id = 0;
  const ctx = runtime(['app-utils.gs', 'transaction-schema.gs', 'transaction-utils.gs', 'transaction-validation.gs', 'transaction-core.gs'], {
    TRANSACTIONS_SHEET: 'transaction_master', SYNC_STATUS_CREATE_PENDING: 'create-pending',
    Utilities: { getUuid: () => 'e0000000-0000-4000-8000-' + String(++id).padStart(12, '0') }, computeSyncStatus: status => status === 'create-pending' ? status : 'update-pending',
  });
  const sheet = new Sheet([ctx.getTransactionSheetColumns()]);
  ctx.getOrCreateSheet = () => sheet;
  ctx._buildCategoryMap = () => ({
    'money-out|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-in|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-out|expense|food': { source_account_mandatory: true, target_account_mandatory: false },
  });
  ctx._loadAccountMap = () => ({ a: { account_currency_local: 'GBP' }, b: { account_currency_local: 'GBP' } });
  const transfer = { id: 'f0000000-0000-4000-8000-000000000001', tx_type: 'money-out', tx_date_local: '2026-09-23 09:00:00', major_category: 'transfer', minor_category: 'bank', source_account: 'a', target_account: 'b', source_amount_local: 10, target_amount_local: 12 };
  return { ctx, sheet, transfer };
}
function detailImporter(fileType, subType, existingRows = []) {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  const spec = ctx.getImportSpec(fileType);
  const sheet = new Sheet([spec.columns, ...existingRows]);
  sheet.name = spec.sheet_name;
  const accounts = new Sheet([
    ['id', 'sub_type'],
    [DETAIL_ACCOUNT_ID.toUpperCase(), subType],
    [PROPERTY_ACCOUNT_ID, 'property'],
  ]);
  accounts.name = 'account_master';
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheets: () => [accounts, sheet] }) };
  ctx.getAccountSheetColumns = () => accounts.rows[0];
  ctx.getOrCreateSheet = name => {
    if (name === 'account_master') return accounts;
    assert.equal(name, spec.sheet_name);
    return sheet;
  };
  ctx.sheetToObjects = source => source.rows.slice(1).map(row => ({ id: row[0], sub_type: row[1] }));
  return { ctx, sheet, spec };
}
function detailMigrationRuntime(sheets) {
  let released = 0;
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'import-registry.gs', 'import-core.gs'], {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheets: () => sheets,
      getSheetByName: name => sheets.find(sheet => sheet.name === name),
      insertSheet: () => { throw new Error('migration must not create absent tabs'); },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) },
  });
  return { ctx, releases: () => released };
}
function accountImporter() {
  let generated = 0;
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'account-schema.gs', 'account-utils.gs', 'account-validation.gs', 'account-core.gs'], {
    listRates: () => [{ currency: 'GBP' }, { currency: 'XAU' }],
    Utilities: { getUuid: () => 'e0000000-0000-4000-8000-' + String(++generated).padStart(12, '0') },
  });
  const sheet = new Sheet([ctx.getAccountSheetColumns()]);
  sheet.name = 'account_master';
  ctx.getOrCreateSheet = name => { assert.equal(name, 'account_master'); return sheet; };
  ctx._countTransactionsReferencingAccount = () => 0;
  const account = { id: DETAIL_ACCOUNT_ID, account_name: 'Example bank', type: 'asset', sub_type: 'cash', account_currency_local: 'GBP', local_timezone: 'Europe/London', opening_value_local: '100.005', account_opening_date_local: '2026-01-01', tracking_start_date_local: '2026-01-01' };
  return { ctx, sheet, account };
}
function masterMigrationRuntime(names = ['accounts', 'categories', 'subscriptions', 'transactions']) {
  const sheets = [];
  const renames = [];
  let released = 0;
  const lock = { tryLock: () => true, releaseLock: () => released++ };
  const ctx = runtime(['app-config.gs', 'app-utils.gs', 'account-schema.gs', 'category-schema.gs', 'subscription-schema.gs', 'transaction-schema.gs', 'master-migration.gs'], {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheets: () => sheets,
      getSheetByName: name => sheets.find(sheet => sheet.name === name),
      insertSheet: () => { throw new Error('migration or guarded access created an empty tab'); },
    }) },
    LockService: { getScriptLock: () => lock },
  });
  const columnsByName = {
    accounts: ctx.getAccountSheetColumns(), categories: ctx.getCategorySheetColumns(), subscriptions: ctx.getSubscriptionSheetColumns(), transactions: ctx.getTransactionSheetColumns(),
    account_master: ctx.getAccountSheetColumns(), category_master: ctx.getCategorySheetColumns(), subscription_master: ctx.getSubscriptionSheetColumns(), transaction_master: ctx.getTransactionSheetColumns(),
  };
  names.forEach(name => {
    const columns = Array.from(columnsByName[name]);
    const sheet = new Sheet([columns, columns.map((column, index) => index === 0 ? DETAIL_ID : 'original-' + column)]);
    sheet.name = name;
    sheet.setName = canonical => { renames.push([sheet.name, canonical]); sheet.name = canonical; };
    sheets.push(sheet);
  });
  return { ctx, sheets, renames, lock, releases: () => released };
}
test('master tab migration renames in place and preserves every source cell on reruns', () => {
  const { ctx, sheets, renames, releases } = masterMigrationRuntime();
  const originalRows = sheets.map(sheet => JSON.stringify(sheet.rows));
  const migrated = ctx.migrateMasterSheetNames();
  assert.equal(migrated.ok, true);
  assert.deepEqual(Array.from(migrated.renamed), ['account_master', 'category_master', 'subscription_master', 'transaction_master']);
  assert.deepEqual(sheets.map(sheet => sheet.name), ['account_master', 'category_master', 'subscription_master', 'transaction_master']);
  assert.deepEqual(sheets.map(sheet => JSON.stringify(sheet.rows)), originalRows);
  for (const sheet of sheets) assert.equal(ctx.getOrCreateSheet(sheet.name, sheet.rows[0]), sheet);
  assert.equal(ctx.migrateMasterSheetNames().renamed.length, 0);
  assert.equal(renames.length, 4);
  assert.equal(releases(), 2);
  assert.equal(sheets.every(sheet => sheet.writes === 0), true);
});
test('master tab collision or invalid later header prevents every rename', () => {
  for (const isCollision of [false, true]) {
    const names = ['accounts', 'categories', 'subscriptions', 'transactions'];
    if (isCollision) names.push('transaction_master');
    const { ctx, sheets, renames, releases } = masterMigrationRuntime(names);
    if (!isCollision) sheets[3].rows[0][1] = 'unexpected_header';
    const migrated = ctx.migrateMasterSheetNames();
    assert.equal(migrated.ok, false);
    assert.equal(migrated.error, isCollision ? 'master_sheet_name_collision' : 'sheet_header_mismatch');
    assert.equal(migrated.sheet_name, 'transaction_master');
    assert.equal(renames.length, 0);
    assert.equal(sheets.every(sheet => sheet.writes === 0), true);
    assert.equal(releases(), 1);
  }
});
test('master migration renames transactions after the other three tabs are already canonical', () => {
  const { ctx, sheets, renames } = masterMigrationRuntime(['account_master', 'category_master', 'subscription_master', 'transactions']);
  const originalRows = sheets.map(sheet => JSON.stringify(sheet.rows));
  const migrated = ctx.migrateMasterSheetNames();
  assert.equal(migrated.ok, true);
  assert.deepEqual(Array.from(migrated.renamed), ['transaction_master']);
  assert.deepEqual(Array.from(migrated.already_current), ['account_master', 'category_master', 'subscription_master']);
  assert.deepEqual(sheets.map(sheet => JSON.stringify(sheet.rows)), originalRows);
  assert.equal(ctx.migrateMasterSheetNames().renamed.length, 0);
  assert.deepEqual(renames, [['transactions', 'transaction_master']]);
});
test('master tab migration leaves absent tabs absent and validates canonical tabs before renaming', () => {
  const { ctx, sheets, renames } = masterMigrationRuntime(['accounts', 'category_master']);
  sheets[1].rows[0][1] = 'unexpected_header';
  assert.equal(ctx.migrateMasterSheetNames().error, 'sheet_header_mismatch');
  assert.equal(renames.length, 0);
  sheets[1].rows[0] = Array.from(ctx.getCategorySheetColumns());
  const migrated = ctx.migrateMasterSheetNames();
  assert.equal(migrated.ok, true);
  assert.deepEqual(Array.from(migrated.absent), ['subscription_master', 'transaction_master']);
  assert.deepEqual(Array.from(migrated.already_current), ['category_master']);
  assert.equal(sheets.length, 2);
});
test('master tab migration safely resumes after a service failure and respects the script lock', () => {
  const { ctx, sheets, renames, lock, releases } = masterMigrationRuntime();
  lock.tryLock = () => false;
  assert.equal(ctx.migrateMasterSheetNames().error, 'busy_retry');
  assert.equal(renames.length, 0);
  assert.equal(releases(), 0);
  lock.tryLock = () => true;
  const renameCategory = sheets[1].setName;
  sheets[1].setName = () => { throw new Error('sensitive service response'); };
  const failed = ctx.migrateMasterSheetNames();
  assert.equal(failed.error, 'master_sheet_migration_failed');
  assert.deepEqual(Array.from(failed.renamed), ['account_master']);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
  sheets[1].setName = renameCategory;
  assert.equal(ctx.migrateMasterSheetNames().ok, true);
  assert.deepEqual(sheets.map(sheet => sheet.name), ['account_master', 'category_master', 'subscription_master', 'transaction_master']);
  assert.equal(releases(), 2);
});
test('regular master access rejects legacy tabs and name collisions before any write', () => {
  for (const [legacy, canonical] of [['accounts', 'account_master'], ['categories', 'category_master'], ['subscriptions', 'subscription_master'], ['transactions', 'transaction_master']]) {
    for (const isCollision of [false, true]) {
      const { ctx, sheets, renames } = masterMigrationRuntime(isCollision ? [legacy, canonical] : [legacy]);
      const error = isCollision ? /master_sheet_name_collision/ : /legacy_master_sheet_name/;
      assert.throws(() => ctx.getOrCreateSheet(canonical, ['id']), error);
      assert.equal(renames.length, 0);
      assert.equal(sheets.every(sheet => sheet.writes === 0), true);
    }
  }
});
test('transaction edit trigger rejects duplicate master names before changing category cells', () => {
  const { ctx, sheets } = masterMigrationRuntime(['category_master', 'transactions', 'transaction_master']);
  vm.runInContext(fs.readFileSync(path.join(api, 'category-core.gs'), 'utf8'), ctx);
  ctx.markAccountTypeEditPending = () => false;
  ctx.markAccountDetailEditPending = () => false;
  ctx.markAccountMasterEditPending = () => false;
  const event = { range: { getSheet: () => sheets[2], getRow: () => 2, getColumn: () => ctx.txColIndex('tx_type') + 1 } };
  assert.throws(() => ctx.onEdit(event), /master_sheet_name_collision/);
  assert.equal(sheets.every(sheet => sheet.writes === 0), true);
});
test('master naming errors expose the repair action through GET and POST', () => {
  for (const code of ['legacy_master_sheet_name', 'master_sheet_name_collision']) {
    let released = 0;
    const ctx = runtime(['app-router.gs'], {
      json: value => value, extractMeta: () => ({ ip: 'test' }), checkLocked: () => false, checkPin: () => true, recordAccess() {},
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) },
      listAccounts() { throw new Error(code); }, createAccount() { throw new Error(code); },
    });
    const failures = [ctx.doGet({ parameter: { action: 'list_accounts' } }), ctx.doPost({ postData: { contents: '{"action":"create_account"}' } })];
    for (const failure of failures) {
      assert.equal(failure.error, code);
      assert.match(failure.detail, /migrateMasterSheetNames/);
    }
    assert.equal(released, 1);
  }
});
test('account_master import delegates to the existing plural API contract', () => {
  const ctx = runtime(['app-config.gs', 'import-registry.gs', 'import-core.gs']);
  const rows = [{ id: DETAIL_ACCOUNT_ID }];
  ctx.createAccountsBulk = request => {
    assert.equal(request.accounts, rows);
    return { ok: true, created: 1, updated: 0, failed: 0, results: [] };
  };
  const imported = ctx.importAccountData({ file_type: 'account_master', rows });
  assert.equal(imported.ok, true);
  assert.equal(imported.file_type, 'account_master');
  assert.equal(ctx.importAccountData({ file_type: 'accounts_master', rows }).error, 'unknown_file_type');
});
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
  const ctx = runtime(['app-utils.gs', 'account-core.gs'], { TRANSACTIONS_SHEET: 'transaction_master', getTransactionSheetColumns: () => sheet.rows[0], txColIndex: name => sheet.rows[0].indexOf(name) });
  ctx.getOrCreateSheet = () => sheet;
  assert.equal(ctx._buildAccountNetMap([{ id: 'a', tracking_start_date_local: '2026-02-01 00:00:00' }]).a, 20);
  assert.equal(ctx._buildAccountNetMap([{ id: 'a', tracking_start_date_local: '' }]).a, 120);
});
test('fractional account row rejected before reading data or writing', () => {
  const ctx = runtime(['account-core.gs'], { ACCOUNTS_SHEET: 'account_master', getAccountSheetColumns: () => [], getOrCreateSheet: () => ({ getLastRow: () => 10 }) });
  for (const action of ['updateAccount', 'deleteAccount', 'restoreAccount']) assert.equal(ctx[action]({ row_num: 2.5 }).error, 'invalid_row');
});
test('subscription amount must be finite', () => {
  const ctx = runtime(['subscription-validation.gs']);
  assert.equal(ctx.validateSubscriptionCreate({ subscription_name: 'Example', subscription_amount_local: Infinity }).error, 'invalid_subscription_amount_local');
});
test('registry keys exclude prototype and detail rows normalize stored IDs', () => {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  assert.equal(ctx.getImportSpec('constructor'), null);
  const spec = ctx.getImportSpec('account_deposit');
  const sheet = new Sheet([spec.columns]);
  const lookup = Object.create(null), values = sheet.rows.slice();
  assert.equal(ctx._importRow(sheet, spec, null, {}, lookup, values).error, 'invalid_row');
  assert.equal(ctx._importRow(sheet, spec, { id: ' ' + DETAIL_ID.toUpperCase() + ' ', account_id: ' ' + DETAIL_ACCOUNT_ID + ' ' }, { [DETAIL_ACCOUNT_ID]: 'cash' }, lookup, values).ok, true);
  assert.equal(sheet.rows[1][0], DETAIL_ID);
  assert.equal(sheet.rows[1][1], DETAIL_ACCOUNT_ID);
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
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  const spec = ctx.getImportSpec('account_liability_credit_card');
  const sheet = new Sheet([spec.columns]);
  const result = ctx._importRow(sheet, spec, { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, credit_limit_local: 'not-a-number' }, { [DETAIL_ACCOUNT_ID]: 'credit-card' }, Object.create(null), sheet.rows.slice());
  assert.equal(result.error, 'invalid_credit_limit_local');
  assert.equal(sheet.writes, 0);
});
test('removed detail types are rejected before any Sheet access', () => {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  ctx.getOrCreateSheet = () => { throw new Error('removed import type reached Sheets'); };
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => { throw new Error('removed import type reached Sheets'); } };
  for (const fileType of ['account_investment_fixed_income', 'account_investment_p2p_lending']) {
    assert.equal(ctx.getImportSpec(fileType), null);
    const imported = ctx.importAccountData({ file_type: fileType, rows: [{ id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID }] });
    assert.equal(imported.ok, false);
    assert.equal(imported.error, 'unknown_file_type');
  }
});
test('loan detail contracts require principal and accept omitted optional fields', () => {
  for (const [fileType, subType] of [
    ['account_liability_mortgage', 'mortgage'],
    ['account_liability_personal_loan', 'personal-loan'],
  ]) {
    const { ctx, sheet, spec } = detailImporter(fileType, subType);
    const requiredField = 'original_principal_local';
    const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, term_months: 24 };
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [row] }).results[0].error, 'missing_' + requiredField);
    assert.equal(sheet.writes, 0);
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, [requiredField]: 0 }] }).ok, true);
    assert.equal(sheet.rows[1][spec.columns.indexOf(requiredField)], 0);
    assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], 'active');
    assert.equal(sheet.rows[1][spec.columns.indexOf('monthly_payment_local')], '');
  }
});
test('detail UUIDs are validated before any Sheet access', () => {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  ctx.getOrCreateSheet = () => { throw new Error('invalid UUID reached Sheets'); };
  for (const [fileType, base, fields] of [
    ['account_liability_mortgage', { original_principal_local: 1000, term_months: 24 }, ['id', 'account_id', 'linked_property_account_id']],
    ['account_investment_stocks', { instrument_type: 'CASH' }, ['evaluation_currency_rate_id']],
  ]) {
    for (const field of fields) {
      for (const value of ['not-a-uuid', 123, true]) {
        const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, ...base, [field]: value };
        const result = ctx.importAccountData({ file_type: fileType, rows: [row] });
        assert.equal(result.results[0].error, 'invalid_' + field);
        assert.equal(result.failed, 1);
        assert.equal(result.created, 0);
      }
    }
  }
});
test('uppercase detail UUID retries update the same row and normalize linked references', () => {
  const fileType = 'account_liability_mortgage';
  const { ctx, sheet, spec } = detailImporter(fileType, 'mortgage');
  const row = { id: DETAIL_ID.toUpperCase(), account_id: DETAIL_ACCOUNT_ID.toUpperCase(), linked_property_account_id: PROPERTY_ACCOUNT_ID.toUpperCase(), original_principal_local: 1000, term_months: 24 };
  const first = ctx.importAccountData({ file_type: fileType, rows: [row] });
  assert.equal(first.created, 1);
  assert.equal(first.results[0].key, DETAIL_ID);
  // Also exercise a pre-existing Sheet row that has an uppercase UUID.
  sheet.rows[1][0] = DETAIL_ID.toUpperCase();
  const second = ctx.importAccountData({ file_type: fileType, rows: [{ ...row, id: DETAIL_ID, original_principal_local: 900 }] });
  assert.equal(second.updated, 1);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][0], DETAIL_ID);
  assert.equal(sheet.rows[1][1], DETAIL_ACCOUNT_ID);
  assert.equal(sheet.rows[1][spec.columns.indexOf('linked_property_account_id')], PROPERTY_ACCOUNT_ID);
  assert.equal(row.id, DETAIL_ID.toUpperCase());
});
test('repeated UUID casing within one batch cannot append duplicate detail rows', () => {
  const fileType = 'account_deposit';
  const { ctx, sheet } = detailImporter(fileType, 'cash');
  const result = ctx.importAccountData({ file_type: fileType, rows: [
    { id: DETAIL_ID.toUpperCase(), account_id: DETAIL_ACCOUNT_ID },
    { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, interest_rate: 2 },
  ] });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(sheet.rows.length, 2);
});
test('ambiguous existing detail UUID duplicates reject the import before row writes', () => {
  const fileType = 'account_deposit';
  const { ctx, sheet } = detailImporter(fileType, 'cash', [
    [DETAIL_ID, DETAIL_ACCOUNT_ID, '', '', '', '', ''],
    [DETAIL_ID.toUpperCase(), DETAIL_ACCOUNT_ID, '', '', '', '', ''],
  ]);
  assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID }] }).error, 'duplicate_detail_id');
  assert.equal(sheet.writes, 0);
});
test('detail imports enforce statuses, numeric values, and subtype boundaries', () => {
  for (const [fileType, subType, amountField, fields] of [
    ['account_liability_mortgage', 'mortgage', 'original_principal_local', { term_months: 24 }],
    ['account_deposit', 'savings', 'interest_rate', {}],
  ]) {
    const { ctx, sheet, spec } = detailImporter(fileType, subType);
    const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, [amountField]: 10, ...fields };
    for (const recordStatus of ['active', 'inactive', 'deleted', 'locked']) {
      assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, record_status: recordStatus }] }).ok, true);
      assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], recordStatus);
    }
    for (const [field, value] of [['record_status', 'unknown'], ['rate_type', 'FLOATING'], [amountField, Infinity]]) {
      const writes = sheet.writes;
      assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, [field]: value }] }).results[0].error, 'invalid_' + field);
      assert.equal(sheet.writes, writes);
    }
    const incompatible = detailImporter(fileType, 'stocks-shares');
    assert.equal(incompatible.ctx.importAccountData({ file_type: fileType, rows: [row] }).results[0].error, 'sub_type_mismatch');
    assert.equal(incompatible.sheet.writes, 0);
  }
});
test('detail numeric text accepts decimal notation only and preserves precision', () => {
  const fileType = 'account_liability_credit_card';
  const { ctx, sheet, spec } = detailImporter(fileType, 'credit-card');
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID };
  for (const amount of ['0x10', '0b10', '0o10', '1_000', '1.2.3']) {
    const result = ctx.importAccountData({ file_type: fileType, rows: [{ ...row, credit_limit_local: amount }] });
    assert.equal(result.results[0].error, 'invalid_credit_limit_local');
    assert.equal(sheet.writes, 0);
  }
  for (const amount of ['12345678901234567890.123456789012345678', '1.25e+3', '+.5', '2.', '-2.5E-2']) {
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, credit_limit_local: amount }] }).ok, true);
    assert.equal(sheet.rows[1][spec.columns.indexOf('credit_limit_local')], amount);
  }
});
test('six detail contracts append audit columns without moving existing positions', () => {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  for (const [fileType, , , oldCount] of AUDITED_DETAIL_CASES) {
    const spec = ctx.getImportSpec(fileType);
    const originalPrefix = oldCount - (fileType === 'account_investment_stocks' ? 1 : 0);
    assert.equal(spec.columns.length, originalPrefix + 6);
    assert.deepEqual(Array.from(spec.columns.slice(originalPrefix)), DETAIL_METADATA_COLUMNS);
    assert.deepEqual(Array.from(spec.enums.record_status), ['active', 'inactive', 'deleted', 'locked']);
  }
});
test('six detail imports own audit values and preserve omitted record status on update', () => {
  for (const [fileType, subType, fields] of AUDITED_DETAIL_CASES) {
    const { ctx, sheet, spec } = detailImporter(fileType, subType);
    const cell = name => sheet.rows[1][spec.columns.indexOf(name)];
    const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, ...fields, record_status: 'inactive', sync_status: 'in-sync', sync_date: 'forged-date', sync_notes: 'forged-notes', created_at: 'forged-created', updated_at: 'forged-updated' };
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [row] }).ok, true);
    assert.equal(cell('record_status'), 'inactive');
    assert.equal(cell('sync_status'), 'create-pending');
    assert.equal(cell('sync_date'), '');
    assert.equal(cell('sync_notes'), '');
    assert.match(cell('created_at'), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(cell('created_at'), cell('updated_at'));
    const createdAt = cell('created_at');
    sheet.rows[1][spec.columns.indexOf('sync_status')] = 'in-sync';
    sheet.rows[1][spec.columns.indexOf('sync_date')] = 'old-sync-date';
    sheet.rows[1][spec.columns.indexOf('sync_notes')] = 'old-sync-notes';
    sheet.rows[1][spec.columns.indexOf('updated_at')] = 'old-update';
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, record_status: '' }] }).ok, true);
    assert.equal(cell('id'), DETAIL_ID);
    assert.equal(cell('record_status'), 'inactive');
    assert.equal(cell('sync_status'), 'update-pending');
    assert.equal(cell('sync_date'), '');
    assert.equal(cell('sync_notes'), '');
    assert.equal(cell('created_at'), createdAt);
    assert.notEqual(cell('updated_at'), 'old-update');
    assert.equal(sheet.rows.length, 2);
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ id: PROPERTY_ACCOUNT_ID, account_id: DETAIL_ACCOUNT_ID, ...fields }] }).ok, true);
    assert.equal(sheet.rows[2][spec.columns.indexOf('record_status')], 'active');
  }
});
test('detail retry states and explicit lifecycle transitions remain syncable', () => {
  const fileType = 'account_deposit';
  const { ctx, sheet, spec } = detailImporter(fileType, 'cash');
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID };
  ctx.importAccountData({ file_type: fileType, rows: [row] });
  for (const [oldStatus, nextStatus] of [['create-pending', 'create-pending'], ['create-failed', 'create-pending'], ['update-failed', 'update-pending']]) {
    sheet.rows[1][spec.columns.indexOf('sync_status')] = oldStatus;
    assert.equal(ctx.importAccountData({ file_type: fileType, rows: [{ ...row, record_status: 'deleted' }] }).ok, true);
    assert.equal(sheet.rows[1][spec.columns.indexOf('sync_status')], nextStatus);
    assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], 'deleted');
  }
});
test('invalid detail record status fails before accessing Sheets', () => {
  const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
  ctx.getOrCreateSheet = () => { throw new Error('invalid status reached Sheets'); };
  for (const [fileType, , fields] of AUDITED_DETAIL_CASES) {
    const result = ctx.importAccountData({ file_type: fileType, rows: [{ id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, ...fields, record_status: 'unknown' }] });
    assert.equal(result.results[0].error, 'invalid_record_status');
  }
});
test('invalid account references cannot create or initialize detail target tabs', () => {
  for (const [rowFields, accountRows, expected] of [
    [{ account_id: PROPERTY_ACCOUNT_ID }, [{ id: DETAIL_ACCOUNT_ID, sub_type: 'mortgage' }], 'unknown_account'],
    [{ account_id: DETAIL_ACCOUNT_ID }, [{ id: DETAIL_ACCOUNT_ID, sub_type: 'cash' }], 'sub_type_mismatch'],
    [{ account_id: DETAIL_ACCOUNT_ID, linked_property_account_id: PROPERTY_ACCOUNT_ID }, [{ id: DETAIL_ACCOUNT_ID, sub_type: 'mortgage' }, { id: PROPERTY_ACCOUNT_ID, sub_type: 'cash' }], 'invalid_linked_property'],
  ]) {
    const ctx = runtime(['app-config.gs', 'sync-utils.gs', 'import-registry.gs', 'import-core.gs']);
    ctx.getAccountSheetColumns = () => ['id', 'sub_type'];
    ctx.sheetToObjects = () => accountRows;
    ctx.getOrCreateSheet = name => { assert.equal(name, 'account_master', 'invalid references accessed target tab'); return {}; };
    const result = ctx.importAccountData({ file_type: 'account_liability_mortgage', rows: [{ id: DETAIL_ID, original_principal_local: 100, term_months: 12, ...rowFields }] });
    assert.equal(result.results[0].error, expected);
    assert.equal(result.created, 0);
  }
});
test('detail metadata migration touches existing tabs only and is idempotent', () => {
  const specifications = runtime(['app-config.gs', 'import-registry.gs']);
  const sheets = AUDITED_DETAIL_CASES.map(([fileType, , fields, oldCount]) => {
    const spec = specifications.getImportSpec(fileType);
    const legacyHeaders = Array.from(spec.columns.slice(0, oldCount));
    const original = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, ...fields, record_status: 'deleted' };
    const sheet = new Sheet([legacyHeaders, legacyHeaders.map(column => original[column] ?? '')]);
    sheet.name = spec.sheet_name;
    return sheet;
  });
  const financialBefore = sheets.map(sheet => sheet.rows[1].slice());
  const { ctx, releases } = detailMigrationRuntime(sheets);
  const first = ctx.migrateAccountDetailMetadata();
  assert.equal(first.ok, true);
  assert.equal(first.results.length, 6);
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i], spec = specifications.getImportSpec(sheet.name);
    assert.deepEqual(sheet.rows[0], Array.from(spec.columns));
    assert.deepEqual(sheet.rows[1].slice(0, financialBefore[i].length), financialBefore[i]);
    assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], sheet.name === 'account_investment_stocks' ? 'deleted' : 'active');
    assert.equal(sheet.rows[1][spec.columns.indexOf('sync_status')], 'create-pending');
    assert.equal(sheet.rows[1][spec.columns.indexOf('created_at')], '');
    assert.match(sheet.rows[1][spec.columns.indexOf('updated_at')], /^\d{4}-\d{2}-\d{2}T/);
  }
  const writes = sheets.map(sheet => sheet.writes);
  assert.equal(ctx.migrateAccountDetailMetadata().results.every(result => result.initialized === 0), true);
  assert.deepEqual(sheets.map(sheet => sheet.writes), writes);
  assert.equal(releases(), 2);
  const absent = detailMigrationRuntime([]);
  assert.equal(absent.ctx.migrateAccountDetailMetadata().results.length, 0);
});
test('detail metadata migration validates all headers before any append or backfill', () => {
  const ctx = runtime(['app-config.gs', 'import-registry.gs']);
  const valid = new Sheet([Array.from(ctx.getImportSpec('account_deposit').columns.slice(0, 7)), [DETAIL_ID, DETAIL_ACCOUNT_ID]]);
  valid.name = 'account_deposit';
  const invalid = new Sheet([['id', 'renamed_account_id'], [PROPERTY_ACCOUNT_ID, DETAIL_ACCOUNT_ID]]);
  invalid.name = 'account_investment_property';
  const migration = detailMigrationRuntime([valid, invalid]);
  assert.throws(() => migration.ctx.migrateAccountDetailMetadata(), /sheet_header_mismatch/);
  assert.equal(valid.writes, 0);
  assert.equal(invalid.writes, 0);
  assert.equal(migration.releases(), 1);
});
test('initialized detail metadata and unknown creation timestamps survive migration and reimport', () => {
  const { ctx, sheet, spec } = detailImporter('account_deposit', 'cash');
  const original = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, record_status: 'locked', sync_status: 'update-failed', sync_date: 'known-sync', sync_notes: 'failure', created_at: '', updated_at: 'known-update' };
  sheet.rows.push(Array.from(spec.columns, name => original[name] ?? ''));
  const before = JSON.stringify(sheet.rows);
  assert.equal(ctx._initializeAccountDetailMetadata(sheet, spec).initialized, 0);
  assert.equal(JSON.stringify(sheet.rows), before);
  ctx.importAccountData({ file_type: 'account_deposit', rows: [{ id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID }] });
  assert.equal(sheet.rows[1][spec.columns.indexOf('created_at')], '');
  assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], 'locked');
  assert.equal(sheet.rows[1][spec.columns.indexOf('sync_status')], 'update-pending');
});
test('direct Sheet multirow edits queue pending sync and preserve financial values', () => {
  const { ctx, sheet, spec } = detailImporter('account_deposit', 'cash');
  ctx.importAccountData({ file_type: 'account_deposit', rows: [
    { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, interest_rate: '1.2' },
    { id: PROPERTY_ACCOUNT_ID, account_id: DETAIL_ACCOUNT_ID, interest_rate: '2.4', record_status: 'deleted' },
  ] });
  sheet.rows[1][spec.columns.indexOf('sync_status')] = 'in-sync';
  sheet.rows[2][spec.columns.indexOf('sync_status')] = 'create-failed';
  const financialBefore = sheet.rows.slice(1).map(row => row.slice(0, 7));
  const createdBefore = sheet.rows.slice(1).map(row => row[spec.columns.indexOf('created_at')]);
  sheet.rows.slice(1).forEach(row => {
    row[spec.columns.indexOf('sync_date')] = 'old-date';
    row[spec.columns.indexOf('sync_notes')] = 'old-notes';
    row[spec.columns.indexOf('updated_at')] = 'old-update';
  });
  vm.runInContext(fs.readFileSync(path.join(api, 'category-core.gs'), 'utf8'), ctx);
  ctx.markAccountTypeEditPending = () => false;
  ctx.onEdit({ range: { getSheet: () => sheet, getRow: () => 2, getColumn: () => 7, getNumRows: () => 2 } });
  assert.deepEqual(sheet.rows.slice(1).map(row => row.slice(0, 7)), financialBefore);
  assert.deepEqual(sheet.rows.slice(1).map(row => row[spec.columns.indexOf('created_at')]), createdBefore);
  assert.deepEqual(sheet.rows.slice(1).map(row => row[spec.columns.indexOf('sync_status')]), ['update-pending', 'create-pending']);
  for (const row of sheet.rows.slice(1)) {
    assert.equal(row[spec.columns.indexOf('sync_date')], '');
    assert.equal(row[spec.columns.indexOf('sync_notes')], '');
    assert.match(row[spec.columns.indexOf('updated_at')], /^\d{4}-\d{2}-\d{2}T/);
  }
  const writes = sheet.writes;
  assert.equal(ctx.markAccountDetailEditPending({ range: { getSheet: () => sheet, getRow: () => 1, getColumn: () => 1, getNumRows: () => 1 } }), true);
  assert.equal(sheet.writes, writes);
  sheet.rows[1][spec.columns.indexOf('sync_status')] = 'in-sync';
  assert.equal(ctx.markAccountDetailEditPending({ range: { getSheet: () => sheet, getRow: () => 2, getColumn: () => spec.columns.indexOf('sync_status') + 1, getNumRows: () => 1 } }), true);
  assert.equal(sheet.rows[1][spec.columns.indexOf('sync_status')], 'in-sync');
  assert.equal(sheet.writes, writes);
});
test('property imports use the valuation date and ignore the retired CSV rate field', () => {
  const { ctx, sheet, spec } = detailImporter('account_investment_property', 'property');
  const row = {
    id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, acquisition_type: 'GIFTED',
    current_value_local: '123.45', current_value_evaluation_date: '2026-09-24',
    property_address: 'Example address', evaluation_currency_rate_id: 'retired-not-a-uuid',
  };
  assert.equal(spec.columns.length, 23);
  assert.equal(spec.columns.includes('evaluation_currency_rate_id'), false);
  assert.equal(ctx.importAccountData({ file_type: 'account_investment_property', rows: [row] }).ok, true);
  assert.equal(sheet.rows[1][spec.columns.indexOf('current_value_evaluation_date')], '2026-09-24');
  assert.equal(sheet.rows[1][spec.columns.indexOf('property_address')], 'Example address');
  assert.equal(sheet.rows[1].includes(row.evaluation_currency_rate_id), false);
});
test('property rate-column migration preserves aligned fields and is idempotent for old 18/24 layouts', () => {
  const registry = runtime(['app-config.gs', 'import-registry.gs']);
  const spec = registry.getImportSpec('account_investment_property');
  for (const withMetadata of [false, true]) {
    const oldHeaders = Array.from(spec.columns);
    oldHeaders.splice(16, 0, 'evaluation_currency_rate_id');
    if (withMetadata === false) oldHeaders.length = 18;
    const original = {
      id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, account_name: 'Property',
      acquisition_type: 'GIFTED', current_value_local: '1234.56',
      current_value_evaluation_date: '2026-09-24', evaluation_currency_rate_id: EVALUATION_RATE_ID,
      property_address: 'Preserved address', record_status: 'locked', sync_status: 'in-sync',
      sync_date: 'old-sync-date', sync_notes: 'old-notes',
      created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-02-01T00:00:00.000Z',
    };
    const sheet = new Sheet([oldHeaders, oldHeaders.map(column => original[column] ?? '')]);
    sheet.name = 'account_investment_property';
    const migration = detailMigrationRuntime([sheet]);
    const first = migration.ctx.migrateAccountPropertyRateColumn();
    assert.equal(first.ok, true);
    assert.equal(first.removed, true);
    assert.equal(first.queued, 1);
    assert.deepEqual(sheet.deletedColumns, [17]);
    assert.deepEqual(sheet.rows[0], Array.from(spec.columns));
    for (const field of spec.columns.slice(0, 17)) {
      assert.equal(sheet.rows[1][spec.columns.indexOf(field)], original[field] ?? '', field);
    }
    assert.equal(sheet.rows[1][spec.columns.indexOf('record_status')], withMetadata ? 'locked' : 'active');
    assert.equal(sheet.rows[1][spec.columns.indexOf('created_at')], withMetadata ? original.created_at : '');
    assert.equal(sheet.rows[1][spec.columns.indexOf('sync_status')], withMetadata ? 'update-pending' : 'create-pending');
    assert.equal(sheet.rows[1][spec.columns.indexOf('sync_date')], '');
    assert.equal(sheet.rows[1][spec.columns.indexOf('sync_notes')], '');
    assert.match(sheet.rows[1][spec.columns.indexOf('updated_at')], /^\d{4}-\d{2}-\d{2}T/);
    const after = JSON.stringify(sheet.rows), writes = sheet.writes;
    const second = migration.ctx.migrateAccountPropertyRateColumn();
    assert.equal(second.removed, false);
    assert.equal(second.initialized, 0);
    assert.equal(second.queued, 0);
    assert.equal(JSON.stringify(sheet.rows), after);
    assert.equal(sheet.writes, writes);
    assert.equal(migration.releases(), 2);
  }
});
test('property migration accepts new 17-column layout and does not create absent tabs', () => {
  const registry = runtime(['app-config.gs', 'import-registry.gs']);
  const spec = registry.getImportSpec('account_investment_property');
  const headers = Array.from(spec.columns.slice(0, 17));
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, acquisition_type: 'GIFTED', property_address: 'Unchanged address' };
  const sheet = new Sheet([headers, headers.map(column => row[column] ?? '')]);
  sheet.name = 'account_investment_property';
  const migration = detailMigrationRuntime([sheet]);
  const result = migration.ctx.migrateAccountPropertyRateColumn();
  assert.equal(result.removed, false);
  assert.equal(result.initialized, 1);
  assert.equal(sheet.deletedColumns, undefined);
  assert.equal(sheet.rows[1][spec.columns.indexOf('property_address')], 'Unchanged address');
  const missing = detailMigrationRuntime([]);
  assert.equal(missing.ctx.migrateAccountPropertyRateColumn().removed, false);
  assert.equal(missing.releases(), 1);
});
test('property migration rejects unknown layouts before writes and metadata helper gives the explicit migration action', () => {
  const registry = runtime(['app-config.gs', 'import-registry.gs']);
  const spec = registry.getImportSpec('account_investment_property');
  const oldHeaders = Array.from(spec.columns);
  oldHeaders.splice(16, 0, 'evaluation_currency_rate_id');
  const validOld = new Sheet([oldHeaders, [DETAIL_ID, DETAIL_ACCOUNT_ID]]);
  validOld.name = 'account_investment_property';
  const oldMigration = detailMigrationRuntime([validOld]);
  assert.throws(() => oldMigration.ctx.migrateAccountDetailMetadata(), /migrateAccountPropertyRateColumn\(\)/);
  assert.equal(validOld.writes, 0);
  for (const headers of [oldHeaders.slice(0, 23), ['id', 'renamed_account_id']]) {
    const sheet = new Sheet([headers, [DETAIL_ID, DETAIL_ACCOUNT_ID]]);
    sheet.name = 'account_investment_property';
    const migration = detailMigrationRuntime([sheet]);
    assert.throws(() => migration.ctx.migrateAccountPropertyRateColumn(), /sheet_header_mismatch/);
    assert.equal(sheet.writes, 0);
    assert.equal(migration.releases(), 1);
  }
});
test('property migration queues before removal so deletion failures remain safely retryable', () => {
  const registry = runtime(['app-config.gs', 'import-registry.gs']);
  const spec = registry.getImportSpec('account_investment_property');
  const headers = Array.from(spec.columns);
  headers.splice(16, 0, 'evaluation_currency_rate_id');
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, record_status: 'active', sync_status: 'in-sync', created_at: 'known-created' };
  const sheet = new Sheet([headers, headers.map(column => row[column] ?? '')]);
  sheet.name = 'account_investment_property';
  sheet.deleteColumn = () => { throw new Error('simulated delete failure'); };
  const migration = detailMigrationRuntime([sheet]);
  assert.throws(() => migration.ctx.migrateAccountPropertyRateColumn(), /simulated delete failure/);
  assert.deepEqual(sheet.rows[0], headers);
  assert.equal(sheet.rows[1][headers.indexOf('sync_status')], 'update-pending');
  assert.equal(sheet.rows[1][headers.indexOf('created_at')], 'known-created');
  assert.equal(migration.releases(), 1);
});
test('property imports never remove the retired column implicitly', () => {
  const registry = runtime(['app-config.gs', 'import-registry.gs']);
  const headers = Array.from(registry.getImportSpec('account_investment_property').columns);
  headers.splice(16, 0, 'evaluation_currency_rate_id');
  const property = new Sheet([headers, [DETAIL_ID, DETAIL_ACCOUNT_ID]]);
  property.name = 'account_investment_property';
  const accounts = new Sheet([['id', 'sub_type'], [DETAIL_ACCOUNT_ID, 'property']]);
  accounts.name = 'account_master';
  const migration = detailMigrationRuntime([property, accounts]);
  migration.ctx.getAccountSheetColumns = () => ['id', 'sub_type'];
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, acquisition_type: 'GIFTED' };
  assert.equal(migration.ctx.importAccountData({ file_type: property.name, rows: [{ ...row, id: 'invalid-id' }] }).results[0].error, 'invalid_id');
  assert.throws(() => migration.ctx.importAccountData({ file_type: property.name, rows: [row] }), /sheet_header_mismatch/);
  assert.equal(property.writes, 0);
  assert.equal(property.deletedColumns, undefined);
  assert.deepEqual(property.rows[0], headers);
});
test('account master UUIDs canonicalize and duplicate create cannot append another identity', () => {
  const { ctx, sheet, account } = accountImporter();
  assert.equal(ctx.createAccount({ ...account, id: ' ' + account.id.toUpperCase() + ' ' }).id, account.id);
  assert.equal(sheet.rows[1][ctx.acctColIndex('id')], account.id);
  const writes = sheet.writes;
  assert.equal(ctx.createAccount(account).error, 'account_id_exists');
  assert.equal(sheet.writes, writes);
  assert.equal(sheet.rows.length, 2);
});
test('bulk master retries canonicalize identity and preserve latest lifecycle and creation timestamp', () => {
  const { ctx, sheet, account } = accountImporter();
  const first = ctx.createAccountsBulk({ accounts: [{ ...account, id: account.id.toUpperCase(), record_status: 'deleted' }] });
  assert.equal(first.created, 1);
  const createdAt = sheet.rows[1][ctx.acctColIndex('created_at')];
  const repeat = ctx.createAccountsBulk({ accounts: [account, { ...account, record_status: 'inactive' }, account] });
  assert.equal(repeat.updated, 3);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][ctx.acctColIndex('id')], account.id);
  assert.equal(sheet.rows[1][ctx.acctColIndex('record_status')], 'inactive');
  assert.equal(sheet.rows[1][ctx.acctColIndex('created_at')], createdAt);
  assert.equal(sheet.rows[1][ctx.acctColIndex('sync_status')], 'create-pending');
});
test('bulk master rejects ambiguous existing UUID casing before row writes', () => {
  const { ctx, sheet, account } = accountImporter();
  ctx.createAccount(account);
  const duplicate = sheet.rows[1].slice();
  duplicate[ctx.acctColIndex('id')] = account.id.toUpperCase();
  sheet.rows.push(duplicate);
  const writes = sheet.writes;
  assert.equal(ctx.createAccountsBulk({ accounts: [account] }).error, 'duplicate_account_id');
  assert.equal(sheet.writes, writes);
});
test('bulk master matches legacy uppercase UUID without breaking existing source references', () => {
  const { ctx, sheet, account } = accountImporter();
  ctx.createAccount(account);
  sheet.rows[1][ctx.acctColIndex('id')] = account.id.toUpperCase();
  assert.equal(ctx.createAccountsBulk({ accounts: [account] }).updated, 1);
  assert.equal(sheet.rows[1][ctx.acctColIndex('id')], account.id.toUpperCase());
  assert.equal(sheet.rows.length, 2);
});
test('detail import cannot move an existing UUID to another account', () => {
  const { ctx, sheet } = detailImporter('account_deposit', 'cash');
  const row = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID };
  assert.equal(ctx.importAccountData({ file_type: 'account_deposit', rows: [row] }).ok, true);
  ctx.sheetToObjects = () => [{ id: DETAIL_ACCOUNT_ID, sub_type: 'cash' }, { id: PROPERTY_ACCOUNT_ID, sub_type: 'cash' }];
  const before = JSON.stringify(sheet.rows), writes = sheet.writes;
  const result = ctx.importAccountData({ file_type: 'account_deposit', rows: [{ ...row, account_id: PROPERTY_ACCOUNT_ID }] });
  assert.equal(result.results[0].error, 'detail_account_move_rejected');
  assert.equal(JSON.stringify(sheet.rows), before);
  assert.equal(sheet.writes, writes);
});
test('invalid detail reassignment cannot upgrade legacy headers or blank metadata', () => {
  for (const withMetadata of [false, true]) {
    const { ctx, sheet, spec } = detailImporter('account_deposit', 'cash');
    const columns = Array.from(withMetadata ? spec.columns : spec.columns.slice(0, 7));
    const existing = { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, interest_rate: '1.5' };
    sheet.rows = [columns, columns.map(column => existing[column] ?? '')];
    ctx.sheetToObjects = () => [{ id: DETAIL_ACCOUNT_ID, sub_type: 'cash' }, { id: PROPERTY_ACCOUNT_ID, sub_type: 'cash' }];
    const getSheet = ctx.getOrCreateSheet;
    ctx.getOrCreateSheet = name => {
      assert.equal(name, 'account_master', 'invalid reassignment reached target migration');
      return getSheet(name);
    };
    const before = JSON.stringify(sheet.rows);
    const result = ctx.importAccountData({ file_type: 'account_deposit', rows: [{ id: DETAIL_ID, account_id: PROPERTY_ACCOUNT_ID, interest_rate: '2' }] });
    assert.equal(result.results[0].error, 'detail_account_move_rejected');
    assert.equal(sheet.writes, 0);
    assert.equal(JSON.stringify(sheet.rows), before);
  }
});
test('detail importer ignores an undeclared linked-property column', () => {
  const { ctx, sheet } = detailImporter('account_deposit', 'cash');
  const result = ctx.importAccountData({ file_type: 'account_deposit', rows: [{ id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID, linked_property_account_id: 'undeclared-not-a-uuid' }] });
  assert.equal(result.ok, true);
  assert.equal(sheet.rows[1].includes('undeclared-not-a-uuid'), false);
});
test('same-batch detail ID reuse cannot change its newly created account association', () => {
  const { ctx, sheet, spec } = detailImporter('account_deposit', 'cash');
  ctx.sheetToObjects = () => [{ id: DETAIL_ACCOUNT_ID, sub_type: 'cash' }, { id: PROPERTY_ACCOUNT_ID, sub_type: 'cash' }];
  const result = ctx.importAccountData({ file_type: 'account_deposit', rows: [
    { id: DETAIL_ID, account_id: DETAIL_ACCOUNT_ID },
    { id: DETAIL_ID.toUpperCase(), account_id: PROPERTY_ACCOUNT_ID },
  ] });
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].error, 'detail_account_move_rejected');
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1][spec.columns.indexOf('account_id')], DETAIL_ACCOUNT_ID);
});
test('invalid master IDs, numeric syntax and calendar dates fail before any account-sheet access', () => {
  const { ctx, account } = accountImporter();
  ctx.getOrCreateSheet = () => { throw new Error('invalid input accessed Sheet'); };
  for (const [field, value, error] of [
    ['id', 'not-a-uuid', 'invalid_id'],
    ['opening_value_local', true, 'invalid_opening_value_local'],
    ['opening_value_local', '0x10', 'invalid_opening_value_local'],
    ['opening_value_local', '0b10', 'invalid_opening_value_local'],
    ['opening_value_local', ['10'], 'invalid_opening_value_local'],
    ['account_opening_date_local', '2026-02-30', 'invalid_account_opening_date_local'],
    ['account_opening_date_local', '2026-01-01T00:00:00Z', 'invalid_account_opening_date_local'],
    ['account_closing_date_local', '2025-12-31', 'invalid_account_closing_date_local'],
    ['tracking_start_date_local', '2026-01-01 24:00', 'invalid_tracking_start_date_local'],
    ['account_currency_local', 'G1P', 'invalid_local_currency'],
  ]) {
    const row = { ...account, [field]: value };
    assert.equal(ctx.createAccount(row).error, error);
    const result = ctx.createAccountsBulk({ accounts: [row] });
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error, error);
  }
});
test('master amounts preserve decimal text and signed nonliability values', () => {
  for (const [type, subtype, amount, expected] of [
    ['asset', 'cash', '-1234567890.123456789', '-1234567890.123456789'],
    ['investment', 'stocks-shares', '-2.5e2', '-2.5e2'],
    ['liability', 'mortgage', '+1234567890.123456789', '-1234567890.123456789'],
    ['liability', 'mortgage', -10, -10],
  ]) {
    const { ctx, sheet, account } = accountImporter();
    const row = { ...account, type, sub_type: subtype, opening_value_local: amount };
    assert.equal(ctx.createAccount(row).ok, true);
    assert.equal(sheet.rows[1][ctx.acctColIndex('opening_value_local')], expected);
    assert.equal(ctx.createAccountsBulk({ accounts: [row] }).ok, true);
    assert.equal(sheet.rows[1][ctx.acctColIndex('opening_value_local')], expected);
  }
});
test('account local dates reject rollover and retain valid leap-day and microsecond ordering', () => {
  const { ctx, sheet, account } = accountImporter();
  const row = { ...account, account_opening_date_local: '2024-02-29 12:00:00.000002' };
  assert.equal(ctx.createAccount({ ...row, account_closing_date_local: '2024-02-29 12:00:00.000001' }).error, 'invalid_account_closing_date_local');
  assert.equal(ctx.createAccount(row).ok, true);
  const writes = sheet.writes;
  for (const closing of ['2024-02-28', '2025-02-29', '2024-12-01+01:00']) {
    assert.equal(ctx.updateAccount({ row_num: 2, account_name: account.account_name, account_closing_date_local: closing }).error, 'invalid_account_closing_date_local');
    assert.equal(sheet.writes, writes);
  }
  assert.equal(ctx.updateAccount({ row_num: 2, account_name: account.account_name, account_closing_date_local: '2024-03-01 12:00' }).ok, true);
});
test('master lifecycle mutations clear stale sync acknowledgements and retain source identity', () => {
  const { ctx, sheet, account } = accountImporter();
  ctx.createAccount(account);
  for (const [action, payload] of [
    ['updateAccount', { row_num: 2, account_name: account.account_name }],
    ['deleteAccount', { row_num: 2 }],
    ['restoreAccount', { row_num: 2 }],
  ]) {
    sheet.rows[1][ctx.acctColIndex('sync_status')] = 'in-sync';
    sheet.rows[1][ctx.acctColIndex('sync_date')] = 'old-sync-date';
    sheet.rows[1][ctx.acctColIndex('sync_notes')] = 'old-sync-notes';
    assert.equal(ctx[action](payload).ok, true);
    assert.equal(sheet.rows[1][ctx.acctColIndex('id')], account.id);
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_status')], 'update-pending');
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_date')], '');
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_notes')], '');
  }
});
test('direct master edits queue sync including tracking timestamp beyond audit columns', () => {
  const { ctx, sheet, account } = accountImporter();
  ctx.createAccount(account);
  const createdAt = sheet.rows[1][ctx.acctColIndex('created_at')];
  ctx.markAccountTypeEditPending = () => false;
  ctx.markAccountDetailEditPending = () => false;
  vm.runInContext(fs.readFileSync(path.join(api, 'category-core.gs'), 'utf8'), ctx);
  for (const field of ['account_name', 'record_status', 'tracking_start_date_local']) {
    sheet.rows[1][ctx.acctColIndex('sync_status')] = 'in-sync';
    sheet.rows[1][ctx.acctColIndex('sync_date')] = 'stale-date';
    sheet.rows[1][ctx.acctColIndex('sync_notes')] = 'stale-notes';
    const before = sheet.rows[1].slice();
    ctx.onEdit({ range: { getSheet: () => sheet, getColumn: () => ctx.acctColIndex(field) + 1, getNumColumns: () => 1, getRow: () => 2, getNumRows: () => 1 } });
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_status')], 'update-pending');
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_date')], '');
    assert.equal(sheet.rows[1][ctx.acctColIndex('sync_notes')], '');
    assert.equal(sheet.rows[1][ctx.acctColIndex('created_at')], createdAt);
    for (const key of ['id', 'opening_value_local', 'tracking_start_date_local', 'account_name', 'record_status']) {
      assert.equal(sheet.rows[1][ctx.acctColIndex(key)], before[ctx.acctColIndex(key)]);
    }
  }
  const writes = sheet.writes;
  ctx.onEdit({ range: { getSheet: () => sheet, getColumn: () => ctx.acctColIndex('sync_status') + 1, getNumColumns: () => 5, getRow: () => 2, getNumRows: () => 1 } });
  assert.equal(sheet.writes, writes);
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
    isLiabilityType: () => false, TRANSACTIONS_SHEET: 'transaction_master', getTransactionSheetColumns: () => [],
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
  const ctx = runtime(['app-config.gs', 'app-utils.gs'], { SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getSheets: () => [] }) } });
  assert.throws(() => ctx.getOrCreateSheet('account_master', ['id', 'account_currency_local']), /sheet_header_mismatch/);
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
