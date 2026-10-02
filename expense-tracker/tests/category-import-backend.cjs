const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');
const ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const TYPE_COLUMNS = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const LEGACY_COLUMNS = TYPE_COLUMNS.filter(key => key !== 'detail_sheet');
const TYPE = { id: ID, account_type_key: 'investment', account_type_label: 'Investments', account_subtype_key: 'fund-position', account_subtype_label: 'Funds', description: '', detail_sheet: '', record_status: 'active' };
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
  for (const file of ['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'import-registry.gs', 'account-type-schema.gs', 'account-type-validation.gs', 'account-type-utils.gs', 'category-schema.gs', 'category-utils.gs', 'category-validation.gs', 'category-core.gs', 'csv-import.gs', 'category-import.gs', 'view-context.gs']) vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
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
  // An identical retry matches the stored row and rewrites nothing.
  const retry = ctx.createCategoriesBulk({ categories: [input] });
  assert.equal(retry.updated, 0); assert.equal(retry.skipped, 1); assert.equal(table().getLastRow(), 2);
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
  const malformed = runtime(typeSheet([{ ...TYPE, detail_sheet: 'invented_detail' }]));
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
  const categories = Array.from({ length: 100 }, (_, index) => category({ id: `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, minor_category_label: 'Fund return ' + index }));
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
  const rows = [category(), category({ id: OTHER_ID, minor_category_label: 'Other return' })];
  const result = ctx.createCategoriesBulk({ categories: rows });
  // The first row matches what is stored (unchanged); the new one fails to append.
  assert.equal(result.skipped, 1); assert.equal(result.failed, 1); assert.equal(result.results[1].error, 'category_write_failed');
  table().appendRow = original;
  assert.equal(ctx.createCategoriesBulk({ categories: rows }).created, 1); assert.equal(table().getLastRow(), 3);
});

module.exports = { runtime, Sheet, typeSheet };

test('category natural keys are unique across imports, existing rows and deleted history', () => {
  for (const status of ['active', 'inactive', 'deleted']) {
    const { ctx, table } = runtime();
    assert.equal(ctx.createCategoriesBulk({ categories: [category({ record_status: status })] }).ok, true);
    const before = JSON.stringify(table().rows), writes = table().writes;
    const result = ctx.createCategoriesBulk({ categories: [category({ id: OTHER_ID })] });
    assert.equal(result.results[0].error, 'duplicate_category');
    assert.equal(JSON.stringify(table().rows), before);
    assert.equal(table().writes, writes);
  }
  const { ctx, table } = runtime();
  const result = ctx.createCategoriesBulk({ categories: [category(), category({ id: OTHER_ID })] });
  assert.equal(result.created, 1);
  assert.equal(result.results[1].error, 'duplicate_category');
  assert.equal(table().getLastRow(), 2);
});

test('existing duplicate category keys fail preflight without any rewrite', () => {
  const { ctx, table } = runtime();
  assert.equal(ctx.createCategoriesBulk({ categories: [category()] }).ok, true);
  const duplicate = table().rows[1].slice(); duplicate[ctx.catColIndex('id')] = OTHER_ID;
  table().rows.push(duplicate);
  const before = JSON.stringify(table().rows), writes = table().writes;
  assert.equal(ctx.createCategoriesBulk({ categories: [category({ description: 'new' })] }).error, 'duplicate_existing_category_key');
  assert.equal(JSON.stringify(table().rows), before); assert.equal(table().writes, writes);
});

test('interactive category creation validates UUID and never appends a reused identity', () => {
  const { ctx, table } = runtime();
  assert.equal(ctx.createCategory(category({ id: 'invalid' })).error, 'invalid_id');
  assert.equal(table(), undefined);
  assert.equal(ctx.createCategory(category({ id: ID.toUpperCase() })).ok, true);
  const before = JSON.stringify(table().rows), writes = table().writes;
  assert.equal(ctx.createCategory(category({ minor_category_label: 'Different' })).error, 'category_id_exists');
  assert.equal(JSON.stringify(table().rows), before); assert.equal(table().writes, writes);
});

test('category key dependency checks cannot be bypassed with force and never create missing tabs', () => {
  const { ctx, sheets, table } = runtime();
  ctx.createCategoriesBulk({ categories: [category()] });
  sheets.push(new Sheet('transaction_master', [['tx_type', 'major_category', 'minor_category'], ['money-in', 'portfolio', 'fund-return']]));
  const before = JSON.stringify(table().rows), writes = table().writes;
  const result = ctx.updateCategory({ ...category({ minor_category_label: 'Renamed' }), row_num: 2, force: true });
  assert.equal(result.error, 'category_key_change_has_dependents');
  assert.equal(result.count, 1);
  assert.equal(JSON.stringify(table().rows), before); assert.equal(table().writes, writes);
  assert.equal(sheets.some(sheet => sheet.name === 'subscription_master'), false);
});

test('interactive category boolean values follow the same parsing as imports', () => {
  const { ctx, table } = runtime();
  assert.equal(ctx.createCategory(category({ target_account_mandatory: 'yes' })).error, 'invalid_boolean');
  assert.equal(table(), undefined);
  assert.equal(ctx.createCategory(category({ target_account_mandatory: ' TRUE ', is_subscription_eligible: 'TRUE' })).ok, true);
  assert.equal(stored(ctx, table()).target_account_mandatory, true);
  assert.equal(stored(ctx, table()).is_subscription_eligible, true);
  assert.equal(ctx.updateCategory({ ...category({ target_account_mandatory: 'no' }), row_num: 2 }).error, 'invalid_boolean');
});

test('category dependency failures redact caught details and preserve the source row', () => {
  const { ctx, table } = runtime();
  ctx.createCategoriesBulk({ categories: [category()] });
  const before = JSON.stringify(table().rows), writes = table().writes, logs = [];
  ctx.console.error = (...args) => logs.push(args.join(' '));
  ctx._countCategoryKeyReferences = () => { throw new Error('private transaction detail'); };
  const result = ctx.updateCategory({ ...category({ minor_category_label: 'Renamed' }), row_num: 2 });
  assert.equal(result.error, 'fk_scan_error');
  assert.equal(JSON.stringify(logs).includes('private transaction detail'), false);
  assert.equal(JSON.stringify(table().rows), before); assert.equal(table().writes, writes);
});

test('direct category business edits queue normal sync and revision without touching business cells', () => {
  const { ctx, table } = runtime();
  ctx.createCategoriesBulk({ categories: [category()] });
  const sheet = table();
  for (const field of ['description', 'record_status', 'id']) {
    sheet.rows[1][ctx.catColIndex('sync_status')] = 'in-sync';
    sheet.rows[1][ctx.catColIndex('sync_date')] = 'old-sync';
    sheet.rows[1][ctx.catColIndex('sync_notes')] = 'old-note';
    sheet.rows[1][ctx.catColIndex('updated_at')] = 'old-revision';
    const business = sheet.rows[1].slice(0, ctx.catColIndex('sync_status'));
    const event = { range: { getSheet: () => sheet, getRow: () => 2, getNumRows: () => 1,
      getColumn: () => ctx.catColIndex(field) + 1, getNumColumns: () => 1 } };
    ctx.onEdit(event);
    assert.deepEqual(sheet.rows[1].slice(0, ctx.catColIndex('sync_status')), business);
    assert.equal(sheet.rows[1][ctx.catColIndex('sync_status')], 'update-pending');
    assert.equal(sheet.rows[1][ctx.catColIndex('sync_date')], '');
    assert.equal(sheet.rows[1][ctx.catColIndex('sync_notes')], '');
    assert.notEqual(sheet.rows[1][ctx.catColIndex('updated_at')], 'old-revision');
  }
  const writes = sheet.writes;
  assert.equal(ctx.markCategoryEditPending({ range: { getSheet: () => sheet, getColumn: () => ctx.catColIndex('sync_status') + 1, getNumColumns: () => 3 } }), true);
  assert.equal(sheet.writes, writes);
});

// ── importCategoriesCsv: server-side CSV parsing and format validation ──────
const CSV_COLUMNS = ['id', 'tx_type_key', 'major_category_label', 'minor_category_label', 'record_status'];
function csvText(rows, columns = CSV_COLUMNS) {
  return columns.join(',') + '\r\n' + rows.map(row => columns.map(key => '"' + String(row[key] ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
}
const csvRow = (index, overrides = {}) => ({ id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, tx_type_key: 'money-out', major_category_label: 'Group', minor_category_label: 'Item ' + index, record_status: 'active', ...overrides });
function importing(types) {
  const env = runtime(types); const calls = [];
  const bulk = env.ctx.createCategoriesBulk;
  env.ctx.createCategoriesBulk = body => { calls.push(plain(body)); return bulk(body); };
  return { ...env, calls, run: body => plain(env.ctx.importCategoriesCsv(body)) };
}

test('CSV import keeps UUIDs, multiline cells and physical line numbers; exported extra columns are ignored', () => {
  const { run, calls, table, ctx } = importing();
  const rows = [csvRow(1), csvRow(2, { description: 'Quoted, "description"\r\nsecond line', record_status: 'inactive' }), csvRow(3, { id: csvRow(3).id.toUpperCase() })];
  const columns = [...CSV_COLUMNS, 'description', 'created_at', 'major_category_key', 'tx_type_label'];
  const result = run({ csv: '﻿' + csvText(rows.map(row => ({ ...row, created_at: 'untrusted', major_category_key: 'ignored-key', tx_type_label: 'Ignored' })), columns) });
  assert.equal(result.ok, true); assert.equal(result.created, 3); assert.equal(result.rows, 3);
  const sent = calls[0].categories;
  assert.deepEqual(sent.map(row => row.csv_row_num), [2, 3, 5]);
  assert.equal(sent[1].description, rows[1].description);
  assert.equal(sent[1].record_status, 'inactive');
  assert.equal(sent[2].id, csvRow(3).id);
  for (const field of ['created_at', 'major_category_key', 'tx_type_label']) assert.equal(sent[0][field], undefined);
  assert.deepEqual(result.results.map(item => item.line), [2, 3, 5]);
  assert.equal(result.results[0].label, 'Group → Item 1');
  assert.equal(table().getLastRow(), 4);
  assert.equal(stored(ctx, table()).major_category_key, 'group');
});

test('CSV file-level errors: missing/duplicate headers, ragged rows, malformed quoting, empty file', () => {
  const { run, calls, table } = importing();
  const cases = [
    ['tx_type_key\nmoney-out', 'invalid_csv_headers', /Missing required headers: major_category_label, minor_category_label/],
    ['tx_type_key,tx_type_key\nmoney-out,money-out', 'invalid_csv_headers', /duplicate column/],
    ['tx_type_key,major_category_label,minor_category_label\nmoney-out,One', 'invalid_csv_rows', /Row 2: expected 3 columns, found 2/],
    [csvText([csvRow(1)]) + '\n"unclosed', 'invalid_csv', /not closed/],
    [csvText([csvRow(1)]) + '\n"quoted"tail', 'invalid_csv', /invalid characters/],
    ['tx_type_key,major_category_label,minor_category_label\n', 'csv_has_no_rows', null],
    ['', 'missing_csv', null],
  ];
  for (const [csv, error, pattern] of cases) {
    const result = run({ csv });
    assert.equal(result.ok, false); assert.equal(result.error, error, csv);
    if (pattern !== null) assert.match(result.errors.join(), pattern);
  }
  assert.equal(run({}).error, 'missing_csv');
  assert.equal(calls.length, 0); assert.equal(table(), undefined);
});

test('CSV row validation reports every bad row by line and writes nothing', () => {
  const { run, calls, table } = importing();
  const columns = [...CSV_COLUMNS, 'source_account_mandatory', 'target_account_mandatory', 'is_subscription_eligible'];
  const rows = [
    csvRow(1),
    csvRow(2, { id: 'bad' }),
    csvRow(3, { tx_type_key: 'sideways' }),
    csvRow(4, { record_status: 'archived' }),
    csvRow(5, { source_account_mandatory: 'yes', is_subscription_eligible: '1' }),
    csvRow(6, { major_category_label: '', minor_category_label: '' }),
    csvRow(7, { tx_type_key: '' }),
    csvRow(1, { minor_category_label: 'Duplicate', id: csvRow(1).id.toUpperCase() }),
  ];
  const result = run({ csv: csvText(rows, columns) });
  assert.equal(result.error, 'invalid_csv_rows');
  assert.deepEqual(result.errors, [
    'Row 3: invalid_id (id: bad).',
    'Row 4: invalid_transaction_type (tx_type_key: sideways).',
    'Row 5: invalid_record_status (record_status: archived).',
    'Row 6: invalid_boolean (source_account_mandatory: yes).',
    'Row 7: missing_major_category (major_category_label).',
    'Row 8: invalid_transaction_type (tx_type_key).',
    'Row 9: id repeats row 2.',
  ]);
  assert.equal(calls.length, 0); assert.equal(table(), undefined);
});

test('CSV booleans accept TRUE/FALSE in any case, become real booleans, and blanks are omitted with record_status', () => {
  const { run, calls, ctx, table } = importing();
  const columns = ['tx_type_key', 'major_category_label', 'minor_category_label', 'record_status', 'source_account_mandatory', 'target_account_mandatory', 'is_subscription_eligible'];
  const result = run({ csv: csvText([csvRow(1, { record_status: '', source_account_mandatory: 'FALSE', target_account_mandatory: 'True', is_subscription_eligible: '' })], columns) });
  assert.equal(result.ok, true);
  const sent = calls[0].categories[0];
  assert.equal(sent.source_account_mandatory, false); assert.equal(sent.target_account_mandatory, true);
  assert.equal('is_subscription_eligible' in sent, false); assert.equal('record_status' in sent, false); assert.equal('id' in sent, false);
  assert.equal(stored(ctx, table()).record_status, 'active');
  assert.equal(stored(ctx, table()).target_account_mandatory, true);
});

test('dry run validates format without reading or writing any Sheet', () => {
  const types = typeSheet(); const { run, calls, sheets } = importing(types);
  const ss = { getSheets: () => { throw new Error('sheet access in dry run'); }, getSheetByName: () => { throw new Error('sheet access in dry run'); }, insertSheet: () => { throw new Error('sheet access in dry run'); } };
  const env = importing(types); env.ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ss };
  const columns = [...CSV_COLUMNS, 'target_account_types'];
  assert.deepEqual(env.run({ csv: csvText([csvRow(1, { target_account_types: 'unknown-hint' }), csvRow(2)], columns), dry_run: true }), { ok: true, dry_run: true, rows: 2 });
  assert.equal(env.run({ csv: csvText([csvRow(1, { id: 'bad' })]), dry_run: true }).error, 'invalid_csv_rows');
  assert.equal(env.calls.length, 0); assert.equal(types.reads, 0); assert.equal(types.writes, 0);
  assert.equal(calls.length, 0); assert.equal(sheets.length, 1);
  assert.equal(run({ csv: csvText([csvRow(1)]), dry_run: 'true' }).created, 1);
});

test('server prerequisites and per-row bulk failures surface with CSV line and label', () => {
  const missing = importing(null);
  const columns = [...CSV_COLUMNS, 'source_account_types'];
  const blocked = missing.run({ csv: csvText([csvRow(1, { source_account_types: 'fund-position' })], columns) });
  assert.equal(blocked.error, 'account_types_missing'); assert.deepEqual(blocked.results, []); assert.equal(blocked.rows, 1);
  assert.equal(importing(typeSheet([TYPE], LEGACY_COLUMNS)).run({ csv: csvText([csvRow(1, { source_account_types: 'investment' })], columns) }).error, 'account_types_migration_required');
  const { run, table } = importing();
  const result = run({ csv: csvText([csvRow(1, { source_account_types: 'old_key' }), csvRow(2, { source_account_types: 'investment' })], columns) });
  assert.equal(result.ok, false); assert.equal(result.created, 1); assert.equal(result.failed, 1);
  assert.equal(result.results[0].line, 2); assert.equal(result.results[0].label, 'Group → Item 1');
  assert.equal(result.results[0].error, 'invalid_source_account_types'); assert.equal(result.results[0].field, 'source_account_types');
  assert.deepEqual(result.results[0].invalid_values, ['old_key']);
  assert.equal(result.results[1].line, 3); assert.equal(result.results[1].action, 'created');
  assert.equal(table().getLastRow(), 2);
});
