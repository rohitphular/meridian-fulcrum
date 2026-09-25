const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');
const ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000099';
const COLUMNS = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'is_loan', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const LEGACY_COLUMNS = COLUMNS.filter(key => key !== 'is_loan' && key !== 'detail_sheet');
function catalog() {
  return [
    { id: ID, account_type_key: 'asset', account_type_label: 'Owned assets', account_subtype_key: 'everyday-wallet', account_subtype_label: 'Everyday wallet', description: '', is_loan: false, detail_sheet: 'account_deposit' },
    { id: 'a0000000-0000-4000-8000-000000000002', account_type_key: 'asset', account_type_label: 'Owned assets', account_subtype_key: 'reserve-cash', account_subtype_label: 'Reserve', description: '', is_loan: false, detail_sheet: '' },
    { id: 'a0000000-0000-4000-8000-000000000003', account_type_key: 'investment', account_type_label: 'Invested assets', account_subtype_key: 'fund-position', account_subtype_label: 'Fund position', description: '', is_loan: false, detail_sheet: 'account_investment_stocks' },
    { id: 'a0000000-0000-4000-8000-000000000004', account_type_key: 'liability', account_type_label: 'Borrowings', account_subtype_key: 'bank-loan', account_subtype_label: 'Bank loan', description: '', is_loan: true, detail_sheet: 'account_liability_personal_loan' },
  ];
}
class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  setFrozenRows() {}
  appendRow(row) { this.writes++; this.rows.push(row.slice()); }
  getRange(start, column, count = 1, width = 1) {
    const write = rows => { this.writes++; rows.forEach((row, offset) => { while (this.rows.length < start + offset) this.rows.push([]); row.forEach((value, index) => { this.rows[start - 1 + offset][column - 1 + index] = value; }); }); };
    return { getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, index) => this.rows[start - 1 + offset]?.[column - 1 + index] ?? '')), setValues: write, setValue: value => write([[value]]) };
  }
}
function runtime(initial = []) {
  const sheets = initial;
  let held = false;
  let released = 0;
  const lock = { tryLock: () => { assert.equal(held, false); held = true; return true; }, releaseLock: () => { held = false; released++; } };
  const spreadsheet = { getSheets: () => sheets, getSheetByName: name => sheets.find(sheet => sheet.name === name), insertSheet: name => { const sheet = new Sheet(name); sheets.push(sheet); return sheet; } };
  const ctx = vm.createContext({ console: { log() {}, error() {}, warn() {} }, SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet }, LockService: { getScriptLock: () => lock }, listRates: () => [{ currency: 'GBP' }] });
  for (const file of ['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'import-registry.gs', 'import-core.gs', 'account-type-schema.gs', 'account-type-validation.gs', 'account-type-utils.gs', 'account-type-core.gs', 'account-type-migration.gs', 'account-schema.gs', 'account-utils.gs', 'account-validation.gs', 'category-schema.gs', 'category-utils.gs', 'category-validation.gs', 'category-core.gs']) vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  return { ctx, sheets, lock, releases: () => released, table: () => sheets.find(sheet => sheet.name === 'account_types') };
}
function boot() { const fixture = runtime(); assert.equal(fixture.ctx.createAccountTypesBulk({ account_types: catalog() }).ok, true); return fixture; }
function first(ctx) { return ctx.listAccountTypes().find(row => row.id === ID); }
function account() { return { account_name: 'Example', type: 'asset', sub_type: 'everyday-wallet', account_currency_local: 'GBP', opening_value_local: '0', account_opening_date_local: '2026-01-01' }; }
function sourceSheet(ctx, name, fields) {
  const headers = Array.from(name === 'account_master' ? ctx.getAccountSheetColumns() : ctx.getCategorySheetColumns());
  return new Sheet(name, [headers, headers.map(column => ({ id: OTHER_ID, record_status: 'active', sync_status: 'in-sync', sync_date: 'previous-ack', sync_notes: 'old-note', created_at: 'original-created', updated_at: 'original-updated', ...fields })[column] ?? '')]);
}
function legacyTable() {
  return new Sheet('account_types', [LEGACY_COLUMNS, ...catalog().map(row => LEGACY_COLUMNS.map(column => ({ ...row, account_type_key: row.account_type_key.replaceAll('-', '_'), account_subtype_key: row.account_subtype_key.replaceAll('-', '_'), record_status: 'active', sync_status: 'in-sync', sync_date: 'old-date', sync_notes: 'old-note', created_at: 'original-created', updated_at: 'original-updated' })[column] ?? ''))]);
}

test('empty GETs return no catalog and make no writes or implicit seed', () => {
  const { ctx, sheets } = runtime();
  assert.equal(ctx.listAccountTypes().length, 0);
  assert.equal(ctx.getAccountTypeSchemaForClient().types.length, 0);
  assert.equal(ctx.getAccountSchemaForClient().types.length, 0);
  assert.equal(ctx.getCategorySchemaForClient().account_type_hints.length, 0);
  assert.equal(sheets.length, 0);
  assert.deepEqual(Array.from(ctx.getAccountTypeSchemaForClient().columns), COLUMNS);
  assert.equal(ctx.createAccountType(catalog()[0]).error, 'account_type_creation_restricted');
});
test('CSV bootstrap is the only population route and later imports cannot add classifications', () => {
  const { ctx, table } = boot();
  assert.equal(ctx.listAccountTypes().length, catalog().length);
  const before = JSON.stringify(table().rows);
  assert.equal(ctx.createAccountTypesBulk({ account_types: [{ ...catalog()[0], id: OTHER_ID, account_subtype_key: 'another-key' }] }).error, 'account_type_creation_restricted');
  assert.equal(JSON.stringify(table().rows), before);
});
test('all classification labels, loan membership and detail eligibility come from the imported Sheet', () => {
  const { ctx } = boot();
  const schema = ctx.getAccountSchemaForClient();
  assert.equal(schema.types.find(type => type.value === 'asset').label, 'Owned assets');
  assert.equal(schema.subtype_labels['everyday-wallet'], 'Everyday wallet');
  assert.deepEqual(Array.from(schema.loan_sub_types), ['bank-loan']);
  assert.equal(schema.subtypes_by_type.liability.includes('bank-loan'), true);
  assert.equal(ctx.validateAccountCreate(account()).ok, true);
  const spec = ctx.getImportSpec('account_deposit');
  assert.equal(ctx._validateImportDetailAccount(spec, { account_id: OTHER_ID }, { [OTHER_ID]: 'everyday-wallet' }).ok, true);
  assert.equal(ctx._validateImportDetailAccount(spec, { account_id: OTHER_ID }, { [OTHER_ID]: 'reserve-cash' }).error, 'sub_type_mismatch');
  const row = first(ctx);
  assert.equal(ctx.updateAccountType({ row_num: row._row, id: row.id, is_loan: true, detail_sheet: '' }).ok, true);
  assert.equal(ctx.getAccountSchemaForClient().loan_sub_types.includes('everyday-wallet'), true);
  assert.equal(ctx._validateImportDetailAccount(spec, { account_id: OTHER_ID }, { [OTHER_ID]: 'everyday-wallet' }).error, 'sub_type_mismatch');
});
test('generic preexisting catalog families are accepted without an embedded family enum', () => {
  const { ctx } = runtime();
  const rows = [{ ...catalog()[0], account_type_key: 'owned-resource', account_type_label: 'Resources' }];
  assert.equal(ctx.createAccountTypesBulk({ account_types: rows }).ok, true);
  assert.equal(ctx.getAccountSchemaForClient().types[0].value, 'owned-resource');
});
test('category CSV hints preserve individual investment subtypes and the broad investment alias', () => {
  const { ctx } = boot();
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures/category-account-type-hints.csv'), 'utf8').trim().split('\n');
  const headers = lines.shift().split(',');
  for (const line of lines) {
    const cells = line.split(','); // The committed fixture deliberately contains unquoted single-token cells.
    const hints = Object.fromEntries(headers.map((key, index) => [key, cells[index]]));
    assert.equal(ctx.validateCategoryCreate({ tx_type_key: 'money-out', major_category_label: 'Transfer', minor_category_label: 'Position', ...hints }).ok, true);
    for (const key of headers) assert.equal(ctx.normaliseAccountTypes(hints[key]), hints[key]);
  }
  const options = ctx.getCategorySchemaForClient().account_type_hints;
  assert.equal(options.find(option => option.value === 'fund-position').label, 'Fund position');
  assert.equal(options.find(option => option.value === 'investment').label, 'Invested assets');
});
test('invalid keys and policies fail before any Sheet creation', () => {
  const { ctx, sheets } = runtime();
  for (const patch of [{ id: 'bad' }, { account_subtype_key: 'has_underscores' }, { account_type_key: 'has_underscores' }, { account_subtype_key: 'asset' }, { account_type_label: '' }, { is_loan: '' }, { is_loan: 'yes' }, { detail_sheet: 'invented_detail' }, { record_status: 'unknown' }]) {
    assert.equal(ctx.createAccountTypesBulk({ account_types: [{ ...catalog()[0], ...patch }] }).ok, false);
    assert.equal(sheets.length, 0);
  }
});
test('family labels, UUIDs and subtype identities validate across the whole import before writes', () => {
  for (const changed of [
    [{ ...catalog()[1], account_type_label: 'Different label' }],
    [catalog()[0], { ...catalog()[1], id: ID.toUpperCase() }],
    [{ ...catalog()[1], account_subtype_key: 'everyday-wallet' }],
  ]) {
    const { ctx, table } = boot();
    const before = JSON.stringify(table().rows);
    assert.equal(ctx.createAccountTypesBulk({ account_types: changed }).ok, false);
    assert.equal(JSON.stringify(table().rows), before);
  }
});
test('interactive family label edits propagate to siblings and respect a locked sibling', () => {
  const { ctx, table } = boot();
  const row = first(ctx);
  assert.equal(ctx.updateAccountType({ row_num: row._row, account_type_label: 'Holdings' }).ok, true);
  assert.equal(ctx.listAccountTypes().filter(type => type.account_type_key === 'asset').every(type => type.account_type_label === 'Holdings'), true);
  const sibling = ctx.listAccountTypes().find(type => type.account_subtype_key === 'reserve-cash');
  ctx.updateAccountType({ row_num: sibling._row, record_status: 'locked' });
  const before = JSON.stringify(table().rows);
  assert.equal(ctx.updateAccountType({ row_num: row._row, account_type_label: 'Renamed again' }).error, 'record_locked');
  assert.equal(JSON.stringify(table().rows), before);
});
test('UUIDs and keys are immutable outside the explicit underscore migration', () => {
  const { ctx, table } = boot();
  const row = first(ctx);
  const before = JSON.stringify(table().rows);
  assert.equal(ctx.updateAccountType({ row_num: row._row, id: OTHER_ID }).error, 'stale_row');
  assert.equal(ctx.updateAccountType({ row_num: row._row, account_subtype_key: 'another-key' }).error, 'field_not_editable');
  assert.equal(ctx.createAccountTypesBulk({ account_types: [{ ...catalog()[0], account_subtype_key: 'another-key' }] }).error, 'field_not_editable');
  assert.equal(JSON.stringify(table().rows), before);
});
test('locked rows remain usable but field changes and deletion require explicit unlock across APIs', () => {
  for (const operation of ['delete', 'update', 'bulk']) {
    const { ctx, table } = boot();
    const row = first(ctx);
    ctx.updateAccountType({ row_num: row._row, record_status: 'locked' });
    assert.equal(ctx.validateAccountCreate(account()).ok, true);
    const before = JSON.stringify(table().rows);
    const mutation = operation === 'delete' ? ctx.deleteAccountType({ row_num: row._row }) : operation === 'update' ? ctx.updateAccountType({ row_num: row._row, record_status: 'deleted' }) : ctx.createAccountTypesBulk({ account_types: [{ ...catalog()[0], record_status: 'deleted' }] });
    assert.equal(mutation.error, 'record_locked');
    assert.equal(ctx.updateAccountType({ row_num: row._row, is_loan: true, record_status: 'active' }).error, 'record_locked');
    assert.equal(JSON.stringify(table().rows), before);
    assert.equal(ctx.updateAccountType({ row_num: row._row, record_status: 'active' }).ok, true);
  }
});
test('historical accounts and category hints block retirement, including investment shorthand', () => {
  for (const relation of ['account', 'category', 'investment']) {
    const { ctx, sheets, table } = boot();
    const row = relation === 'investment' ? ctx.listAccountTypes().find(type => type.account_type_key === 'investment') : first(ctx);
    sheets.push(relation === 'account' ? sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday-wallet', record_status: 'deleted' }) : sourceSheet(ctx, 'category_master', { target_account_types: relation === 'investment' ? 'investment' : 'everyday-wallet', record_status: 'inactive' }));
    const before = JSON.stringify(table().rows);
    assert.equal(ctx.updateAccountType({ row_num: row._row, record_status: 'inactive' }).error, 'account_type_in_use');
    assert.equal(ctx.deleteAccountType({ row_num: row._row }).error, 'account_type_in_use');
    assert.equal(JSON.stringify(table().rows), before);
  }
});
test('inactive/deleted classifications disappear from new choices and restore preserves UUID', () => {
  const { ctx } = boot(); const row = first(ctx);
  assert.equal(ctx.updateAccountType({ row_num: row._row, record_status: 'inactive' }).ok, true);
  assert.equal(ctx.validateAccountCreate(account()).error, 'invalid_sub_type');
  assert.equal(ctx.getAccountSchemaForClient().subtype_labels['everyday-wallet'], 'Everyday wallet');
  assert.equal(ctx.getCategoryAccountTypeHints().some(hint => hint.value === 'everyday-wallet'), false);
  assert.equal(ctx.deleteAccountType({ row_num: row._row }).ok, true);
  assert.equal(ctx.restoreAccountType({ row_num: row._row, id: row.id }).ok, true);
  assert.equal(first(ctx).id, row.id);
});

test('detail mapping changes are blocked for existing accounts while loan policy remains configurable', () => {
  const { ctx, sheets, table } = boot(); const row = first(ctx);
  sheets.push(sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday-wallet', record_status: 'deleted' }));
  const before = JSON.stringify(table().rows);
  assert.equal(ctx.updateAccountType({ row_num: row._row, detail_sheet: '' }).error, 'account_type_in_use');
  assert.equal(ctx.createAccountTypesBulk({ account_types: [{ ...catalog()[0], detail_sheet: '' }] }).error, 'account_type_in_use');
  assert.equal(JSON.stringify(table().rows), before);
  assert.equal(ctx.updateAccountType({ row_num: row._row, is_loan: true }).ok, true);
});

test('bootstrap normalizes existing dependent references without writing unrelated formulas', () => {
  const { ctx, sheets } = runtime();
  const accounts = sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday_wallet', opening_value_local: '=SUM(A100:A102)' });
  const amountIndex = accounts.rows[0].indexOf('opening_value_local');
  const physicalRead = accounts.getDataRange.bind(accounts);
  accounts.getDataRange = () => ({ getValues: () => {
    const evaluated = physicalRead().getValues(); evaluated[1][amountIndex] = 123.45; return evaluated;
  } });
  sheets.push(accounts);
  const imported = ctx.createAccountTypesBulk({ account_types: catalog() });
  assert.equal(imported.ok, true); assert.equal(imported.references_migrated, 1);
  assert.equal(accounts.rows[1][amountIndex], '=SUM(A100:A102)');
  assert.equal(accounts.rows[1][accounts.rows[0].indexOf('id')], OTHER_ID);
  assert.equal(accounts.rows[1][accounts.rows[0].indexOf('created_at')], 'original-created');
  assert.equal(accounts.rows[1][accounts.rows[0].indexOf('sync_status')], 'update-pending');
});
test('import controls audit state and preserves creation timestamps and row identity', () => {
  const { ctx, table } = boot(); const row = first(ctx);
  table().rows[row._row - 1][COLUMNS.indexOf('sync_status')] = 'in-sync';
  const imported = { ...catalog()[0], id: ID.toUpperCase(), sync_status: 'in-sync', created_at: 'forged', updated_at: 'forged', sync_notes: 'forged', is_loan: 'FALSE' };
  assert.equal(ctx.createAccountTypesBulk({ account_types: [imported] }).updated, 1);
  const latest = first(ctx);
  assert.equal(latest.id, ID); assert.equal(latest._row, row._row); assert.equal(latest.created_at, row.created_at);
  assert.equal(latest.sync_status, 'update-pending'); assert.equal(latest.sync_notes, '');
});
test('14-column CSV upgrades legacy metadata layout and normalizes dependent keys without touching balances or UUIDs', () => {
  const legacy = legacyTable(); const { ctx, sheets } = runtime([legacy]);
  const accounts = sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday_wallet', opening_value_local: '123.456' });
  const categories = sourceSheet(ctx, 'category_master', { source_account_types: 'everyday_wallet, reserve_cash', target_account_types: 'investment' });
  sheets.push(accounts, categories);
  assert.equal(ctx.getAccountTypeSchemaForClient().requires_migration, true);
  assert.equal(ctx.getAccountSchemaForClient().types.length, 0);
  assert.equal(ctx.listAccountTypes().length, catalog().length);
  assert.equal(ctx.updateAccountType({ row_num: 2, description: 'blocked' }).error, 'account_type_migration_required');
  const outcome = ctx.migrateAccountTypeKeys(catalog());
  assert.equal(outcome.ok, true); assert.equal(outcome.references_migrated, 2);
  assert.deepEqual(legacy.rows[0], COLUMNS);
  assert.equal(first(ctx).id, ID); assert.equal(first(ctx).created_at, 'original-created'); assert.equal(first(ctx).is_loan, false);
  const accountRow = Object.fromEntries(accounts.rows[0].map((key, index) => [key, accounts.rows[1][index]]));
  assert.equal(accountRow.id, OTHER_ID); assert.equal(accountRow.sub_type, 'everyday-wallet'); assert.equal(accountRow.opening_value_local, '123.456');
  assert.equal(accountRow.created_at, 'original-created'); assert.equal(accountRow.sync_status, 'update-pending'); assert.equal(accountRow.sync_date, '');
  assert.equal(categories.rows[1][categories.rows[0].indexOf('source_account_types')], 'everyday-wallet, reserve-cash');
  assert.equal(ctx.migrateAccountTypeKeys(catalog()).references_migrated, 0);
});
test('migration requires the full catalog and rejects unknown dependent references before any write', () => {
  const legacy = legacyTable(); const { ctx, sheets } = runtime([legacy]);
  assert.equal(ctx.createAccountTypesBulk({ account_types: [catalog()[0]] }).error, 'complete_account_type_catalog_required');
  const badCategory = sourceSheet(ctx, 'category_master', { target_account_types: 'unknown_type' });
  sheets.push(sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday_wallet' }), badCategory);
  const before = sheets.map(sheet => JSON.stringify(sheet.rows));
  assert.equal(ctx.migrateAccountTypeKeys(catalog()).error, 'unknown_account_type_reference');
  assert.deepEqual(sheets.map(sheet => JSON.stringify(sheet.rows)), before);
  assert.equal(sheets.every(sheet => sheet.writes === 0), true);
});
test('migration retries safely after a dependent Sheet write fails', () => {
  const legacy = legacyTable(); const { ctx, sheets } = runtime([legacy]);
  const accounts = sourceSheet(ctx, 'account_master', { type: 'asset', sub_type: 'everyday_wallet' }); sheets.push(accounts);
  const getRange = accounts.getRange.bind(accounts);
  accounts.getRange = (...args) => ({ ...getRange(...args), setValues() { throw new Error('service failure'); } });
  assert.equal(ctx.migrateAccountTypeKeys(catalog()).error, 'account_type_import_failed');
  assert.equal(first(ctx).id, ID);
  accounts.getRange = getRange;
  assert.equal(ctx.migrateAccountTypeKeys(catalog()).ok, true);
  assert.equal(accounts.rows[1][accounts.rows[0].indexOf('sub_type')], 'everyday-wallet');
});
test('malformed header layouts and underscore collisions fail before upgrade writes', () => {
  const malformed = new Sheet('account_types', [['id', 'wrong-header']]);
  assert.throws(() => runtime([malformed]).ctx.listAccountTypes(), /sheet_header_mismatch/);
  assert.equal(malformed.writes, 0);
  const legacy = legacyTable(); legacy.rows[2][LEGACY_COLUMNS.indexOf('account_subtype_key')] = 'everyday-wallet';
  const { ctx } = runtime([legacy]);
  assert.equal(ctx.createAccountTypesBulk({ account_types: catalog() }).error, 'duplicate_account_type');
  assert.equal(legacy.writes, 0);
});
test('direct edits queue only sync metadata and preserve UUIDs and creation timestamps', () => {
  const { ctx, table } = boot(); const row = first(ctx); const cells = table().rows[row._row - 1];
  cells[COLUMNS.indexOf('sync_status')] = 'in-sync'; const before = cells.slice(0, 9); const created = cells[COLUMNS.indexOf('created_at')];
  ctx.markAccountTypeEditPending({ range: { getSheet: table, getColumn: () => 7, getRow: () => row._row, getNumRows: () => 1 } });
  assert.deepEqual(cells.slice(0, 9), before); assert.equal(cells[COLUMNS.indexOf('created_at')], created); assert.equal(cells[COLUMNS.indexOf('sync_status')], 'update-pending');
});
