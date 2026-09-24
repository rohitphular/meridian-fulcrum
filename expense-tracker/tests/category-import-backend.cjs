const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');
const ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const TYPE_COLUMNS = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'is_loan', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const LEGACY_COLUMNS = TYPE_COLUMNS.filter(key => !['is_loan', 'detail_sheet'].includes(key));
const TYPE = { id: ID, account_type_key: 'investment', account_type_label: 'Investments', account_subtype_key: 'fund-position', account_subtype_label: 'Funds', description: '', is_loan: false, detail_sheet: '', record_status: 'active' };
class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; this.reads = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getDataRange() { this.reads++; return { getValues: () => this.rows.map(row => row.slice()) }; }
  setFrozenRows() {}
  appendRow(row) { this.rows.push(row.slice()); this.writes++; }
  getRange(start, column, count = 1, width = 1) {
    const write = rows => { this.writes++; rows.forEach((row, offset) => { while (this.rows.length < start + offset) this.rows.push([]); row.forEach((value, index) => { this.rows[start - 1 + offset][column - 1 + index] = value; }); }); };
    return { getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, index) => this.rows[start - 1 + offset]?.[column - 1 + index] ?? '')), setValues: write, setValue: value => write([[value]]) };
  }
}
function typeSheet(rows = [TYPE], columns = TYPE_COLUMNS) { return new Sheet('account_types', [columns, ...rows.map(row => columns.map(key => row[key] ?? ''))]); }
function runtime(types = typeSheet()) {
  const sheets = types === null ? [] : [types];
  let uuid = 10;
  const ss = { getSheets: () => sheets, getSheetByName: name => sheets.find(sheet => sheet.name === name), insertSheet: name => { const sheet = new Sheet(name); sheets.push(sheet); return sheet; } };
  const ctx = vm.createContext({ console: { log() {}, error() {} }, SpreadsheetApp: { getActiveSpreadsheet: () => ss }, Utilities: { getUuid: () => 'f0000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') } });
  for (const file of ['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'import-registry.gs', 'account-type-schema.gs', 'account-type-validation.gs', 'account-type-utils.gs', 'category-schema.gs', 'category-utils.gs', 'category-validation.gs', 'category-core.gs']) vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  return { ctx, sheets, table: () => sheets.find(sheet => sheet.name === 'category_master') };
}
function category(overrides = {}) {
  return { id: ID, tx_type_key: 'money-in', major_category_label: 'Portfolio', minor_category_label: 'Fund return', source_account_types: '', target_account_types: 'fund-position, investment', source_account_mandatory: false, target_account_mandatory: true, is_subscription_eligible: false, record_status: 'active', ...overrides };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function stored(ctx, sheet) { return Object.fromEntries(Array.from(ctx.getCategorySheetColumns(), (key, index) => [key, sheet.rows[1][index]])); }

test('legacy CSV hints resolve only to configured canonical keys and preserve every token on create/retry', () => {
  const { ctx, table } = runtime();
  const input = category({ target_account_types: 'fund_position, investment', id: ID.toUpperCase(), csv_row_num: 47 });
  const first = ctx.createCategoriesBulk({ categories: [input] });
  assert.deepEqual(plain(first.results[0]), { index: 0, key: ID, csv_row_num: 47, ok: true, action: 'created' });
  const created = stored(ctx, table());
  assert.equal(created.target_account_types, 'fund-position, investment');
  assert.equal(created.id, ID);
  const retry = ctx.createCategoriesBulk({ categories: [input] });
  assert.equal(retry.updated, 1); assert.equal(table().getLastRow(), 2);
  assert.equal(stored(ctx, table()).created_at, created.created_at);
});

test('missing or legacy account_types stops hinted imports before any category write with one actionable prerequisite', () => {
  for (const [types, error] of [[null, 'account_types_missing'], [typeSheet([], TYPE_COLUMNS), 'account_types_missing'], [typeSheet([TYPE], LEGACY_COLUMNS), 'account_types_migration_required'], [typeSheet([{ ...TYPE, account_subtype_key: 'fund_position' }]), 'account_types_migration_required']]) {
    const { ctx, table } = runtime(types);
    const result = ctx.createCategoriesBulk({ categories: [category(), category({ id: OTHER_ID })] });
    assert.equal(result.error, error); assert.equal(result.failed, 0); assert.equal(result.results.length, 0); assert.equal(table(), undefined);
    if (types !== null) assert.equal(types.writes, 0);
  }
});

test('malformed catalog returns prerequisite reason and inactive classifications stay unavailable', () => {
  const malformed = runtime(typeSheet([{ ...TYPE, is_loan: '' }]));
  assert.equal(malformed.ctx.createCategoriesBulk({ categories: [category()] }).error, 'invalid_account_types');
  assert.equal(malformed.table(), undefined);
  const { ctx, table } = runtime(typeSheet([{ ...TYPE, record_status: 'inactive' }]));
  const result = ctx.createCategoriesBulk({ categories: [category()] });
  assert.equal(result.failed, 1); assert.equal(result.results[0].field, 'target_account_types');
  assert.deepEqual(plain(result.results[0].invalid_values), ['fund-position', 'investment']); assert.equal(table(), undefined);
});

test('row failures identify input index, CSV line, field, and offending values without dropping good rows', () => {
  const { ctx, table } = runtime();
  const rows = [category({ id: OTHER_ID, target_account_types: 'missing_position, unknown', csv_row_num: 12 }), category({ csv_row_num: 15 })];
  const result = ctx.createCategoriesBulk({ categories: rows });
  assert.equal(result.ok, false); assert.equal(result.created, 1); assert.equal(result.failed, 1);
  assert.deepEqual(plain(result.results[0]), { index: 0, key: OTHER_ID, csv_row_num: 12, ok: false, error: 'invalid_target_account_types', field: 'target_account_types', invalid_values: ['missing_position', 'unknown'], reason: 'invalid_target_account_types' });
  assert.equal(table().getLastRow(), 2);
  assert.equal(ctx.normaliseAccountTypes('missing_position'), 'missing_position');
});

test('CSV lifecycle values are preserved; omitted replacement status retains state and source audit is ignored', () => {
  for (const status of ['active', 'inactive', 'deleted', 'locked']) {
    const { ctx, table } = runtime();
    const input = category({ record_status: status, created_at: 'untrusted', updated_at: 'untrusted', sync_status: 'in-sync', sync_date: 'untrusted', sync_notes: 'untrusted' });
    assert.equal(ctx.createCategoriesBulk({ categories: [input] }).created, 1);
    const first = stored(ctx, table());
    assert.equal(first.record_status, status); assert.notEqual(first.created_at, 'untrusted'); assert.equal(first.sync_status, 'create-pending'); assert.equal(first.sync_date, ''); assert.equal(first.sync_notes, '');
    delete input.record_status;
    const result = ctx.createCategoriesBulk({ categories: [input] });
    assert.equal(result.ok, true); assert.equal(stored(ctx, table()).record_status, status); assert.equal(stored(ctx, table()).created_at, first.created_at);
    if (status === 'locked') assert.equal(result.skipped, 1);
  }
});

test('locked category cannot be changed or unlocked through CSV and identical retry makes no write', () => {
  const { ctx, table } = runtime(); const input = category({ record_status: 'locked' });
  ctx.createCategoriesBulk({ categories: [input] }); const writes = table().writes;
  assert.equal(ctx.createCategoriesBulk({ categories: [input] }).skipped, 1); assert.equal(table().writes, writes);
  for (const update of [{ description: 'changed' }, { record_status: 'active' }, { record_status: 'deleted' }]) {
    const result = ctx.createCategoriesBulk({ categories: [{ ...input, ...update }] });
    assert.equal(result.results[0].error, 'record_locked'); assert.equal(table().writes, writes);
  }
});

test('invalid UUID, duplicate input IDs, bad lifecycle and malformed booleans report fields before writes', () => {
  for (const [rows, error, field] of [
    [[category({ id: 'not-uuid' })], 'invalid_id', 'id'],
    [[category(), category({ id: ID.toUpperCase() })], 'duplicate_id_in_import', 'id'],
    [[category({ record_status: 'bad' })], 'invalid_record_status', 'record_status'],
    [[category({ target_account_mandatory: 'yes' })], 'invalid_boolean', 'target_account_mandatory'],
    [[null], 'invalid_category_row', 'row'],
  ]) {
    const { ctx, table } = runtime(); const result = ctx.createCategoriesBulk({ categories: rows });
    assert.equal(result.results[0].error, error); assert.equal(result.results[0].field, field); assert.equal(table(), undefined);
  }
});

test('catalog is read once for the whole batch, independent of row count', () => {
  const types = typeSheet(); const { ctx } = runtime(types);
  const categories = Array.from({ length: 100 }, (_, index) => category({ id: `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  const result = ctx.createCategoriesBulk({ categories }); assert.equal(result.created, 100); assert.equal(types.reads, 1);
});

test('existing referenced category keys are protected and dependency scanning creates no tabs', () => {
  const { ctx, sheets, table } = runtime(); ctx.createCategoriesBulk({ categories: [category()] });
  const writes = table().writes;
  sheets.push(new Sheet('transaction_master', [['tx_type', 'major_category', 'minor_category'], ['money-in', 'portfolio', 'fund-return']]));
  const result = ctx.createCategoriesBulk({ categories: [category({ major_category_label: 'Renamed' })] });
  assert.equal(result.results[0].error, 'category_key_change_has_dependents'); assert.equal(result.results[0].count, 1); assert.equal(table().writes, writes);
  assert.equal(sheets.some(sheet => sheet.name === 'subscription_master'), false);
});

test('failed writes retain per-row diagnostics and a retry matches successfully written UUIDs', () => {
  const { ctx, table } = runtime(); ctx.createCategoriesBulk({ categories: [category()] });
  const original = table().appendRow;
  table().appendRow = () => { throw new Error('transient'); };
  const rows = [category(), category({ id: OTHER_ID })];
  const result = ctx.createCategoriesBulk({ categories: rows });
  assert.equal(result.updated, 1); assert.equal(result.failed, 1); assert.equal(result.results[1].error, 'category_write_failed');
  table().appendRow = original;
  assert.equal(ctx.createCategoriesBulk({ categories: rows }).created, 1); assert.equal(table().getLastRow(), 3);
});

module.exports = { runtime, Sheet, typeSheet };
