const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');
const APP = path.join(__dirname, '../app');
const TYPE_ID = 'a0000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = 'b0000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT_ID = 'b0000000-0000-4000-8000-000000000002';
const DETAIL_ID = 'c0000000-0000-4000-8000-000000000001';
const OTHER_DETAIL_ID = 'c0000000-0000-4000-8000-000000000002';
const TYPE_COLUMNS = ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'detail_sheet', 'record_status', 'sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at'];
const plain = value => JSON.parse(JSON.stringify(value));

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  setFrozenRows() {}
  appendRow(row) { this.rows.push(row.slice()); this.writes++; }
  getRange(start, column, count = 1, width = 1) {
    const write = rows => { this.writes++; rows.forEach((row, offset) => { while (this.rows.length < start + offset) this.rows.push([]); row.forEach((value, index) => { this.rows[start - 1 + offset][column - 1 + index] = value; }); }); };
    return { getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, index) => this.rows[start - 1 + offset]?.[column - 1 + index] ?? '')), setValues: write, setValue: value => write([[value]]), setNumberFormat() { return this; }, setNumberFormats() { return this; } };
  }
}

// { sheetless: true } makes every Sheet access throw, proving dry runs never touch the spreadsheet.
function runtime({ sheetless = false } = {}) {
  const types = new Sheet('account_types', [TYPE_COLUMNS,
    TYPE_COLUMNS.map(key => ({ id: TYPE_ID, account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'current', account_subtype_label: 'Current', detail_sheet: 'account_deposit', record_status: 'active' })[key] ?? '')]);
  const sheets = [types];
  const touch = () => { throw new Error('sheet_access_in_dry_run'); };
  const ss = sheetless
    ? { getSheets: touch, getSheetByName: touch, insertSheet: touch }
    : { getSheets: () => sheets, getSheetByName: name => sheets.find(sheet => sheet.name === name), insertSheet: name => { const sheet = new Sheet(name); sheets.push(sheet); return sheet; } };
  let uuid = 100;
  const ctx = importResultHelpers.context({
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: { getUuid: () => 'f0000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  });
  for (const file of ['app-config.gs', 'sync-utils.gs', 'app-utils.gs', 'csv-import.gs', 'account-type-schema.gs', 'account-type-validation.gs', 'account-type-utils.gs',
    'account-schema.gs', 'account-utils.gs', 'account-validation.gs', 'account-core.gs', 'import-registry.gs', 'import-core.gs', 'account-import.gs']) {
    vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx, { filename: file });
  }
  ctx.listRates = () => [{ currency: 'GBP' }, { currency: 'INR' }];
  return { ctx, sheets, sheet: name => sheets.find(candidate => candidate.name === name) };
}

const MASTER_HEADER = 'id,account_name,legal_entity_name,type,sub_type,account_currency_local,local_timezone,tracking_start_date_local,account_opening_date_local,account_closing_date_local,opening_value_local,current_value_local,record_status,description';
const masterRow = (id, name, extra = {}) => {
  const row = { id, account_name: name, legal_entity_name: '', type: 'asset', sub_type: 'current', account_currency_local: 'GBP', local_timezone: 'Europe/London', tracking_start_date_local: '', account_opening_date_local: '2020-01-01 00:00:00', account_closing_date_local: '', opening_value_local: '10.00', current_value_local: '', record_status: 'active', description: '', ...extra };
  return MASTER_HEADER.split(',').map(key => row[key].includes(',') || row[key].includes('\n') || row[key].includes('"') ? '"' + row[key].replaceAll('"', '""') + '"' : row[key]).join(',');
};
const DEPOSIT_HEADER = 'id,account_id,account_name,is_interest_paid,rate_type,interest_payment_frequency,interest_rate,record_status,sync_status,sync_date,sync_notes,created_at,updated_at';
const depositRow = (id, accountId, extra = '') => [id, accountId, 'Bank', 'false', '', '', extra, 'active', 'create-pending', '', '', '', ''].join(',');
function stored(ctx, sheet, index = 1) { return Object.fromEntries(Array.from(ctx.getAccountSheetColumns(), (key, column) => [key, sheet.rows[index][column]])); }

// Converted from frontend-final-review "account and extension CSVs accept multiline exported fields and reject duplicate headers".
test('account CSV keeps multiline quoted fields and exact decimal text, and lines follow physical CSV lines', () => {
  const { ctx, sheet } = runtime();
  const csv = MASTER_HEADER + '\r\n' + masterRow(ACCOUNT_ID, 'Bank', { description: 'one\nsecond, "quoted"', opening_value_local: '90071992547409.91' }) + '\r\n'
    + masterRow(OTHER_ACCOUNT_ID, 'Broker') + '\r\n';
  const result = ctx.importAccountDataCsv({ file_type: 'account_master', csv });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rows, 2);
  assert.equal(result.created, 2);
  assert.deepEqual(plain(result.results.map(entry => entry.line)), [2, 4]);
  const saved = stored(ctx, sheet('account_master'));
  assert.equal(saved.description, 'one\nsecond, "quoted"');
  assert.equal(saved.opening_value_local, '90071992547409.91');
});

test('header problems, column-count errors and unknown file types are rejected before any write', () => {
  const { ctx, sheets } = runtime();
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_master', csv: 'id,id\na,b' }).error, 'invalid_csv_headers');
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_master', csv: 'id,\na,b' }).error, 'invalid_csv_headers');
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_master', csv: MASTER_HEADER }).error, 'csv_has_no_rows');
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_master' }).error, 'missing_csv');
  const counts = ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID) + ',extra\n' });
  assert.equal(counts.error, 'invalid_csv_rows');
  assert.deepEqual(Array.from(counts.errors), ['Row 2: expected 13 columns, found 14.']);
  assert.equal(ctx.importAccountDataCsv({ file_type: 'accounts_master', csv: MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') }).error, 'unknown_file_type');
  assert.equal(ctx.importAccountDataCsv({ csv: MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') }).error, 'missing_file_type');
  assert.deepEqual(sheets.map(sheet => sheet.name), ['account_types']);
});

test('headers are normalised like the old browser parser and cells reach the importer as trimmed text', () => {
  const { ctx, sheet } = runtime();
  const header = MASTER_HEADER.split(',').map(key => key === 'account_name' ? ' Account Name ' : key === 'sub_type' ? 'Sub Type' : key).join(',');
  const csv = header + '\n' + masterRow(ACCOUNT_ID, '  Padded bank  ');
  const result = ctx.importAccountDataCsv({ file_type: 'account_master', csv });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(stored(ctx, sheet('account_master')).account_name, 'Padded bank');
});

test('dry run validates format for account and detail files without touching any Sheet', () => {
  const { ctx } = runtime({ sheetless: true });
  const master = MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') + '\n' + masterRow(OTHER_ACCOUNT_ID, 'Broker');
  assert.deepEqual(plain(ctx.importAccountDataCsv({ file_type: 'account_master', csv: master, dry_run: true })), { ok: true, dry_run: true, file_type: 'account_master', rows: 2 });
  const deposit = DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID, '1.5');
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: deposit, dry_run: true }).ok, true);
  const badMaster = MASTER_HEADER + '\n' + masterRow('not-a-uuid', 'Bank') + '\n' + masterRow(OTHER_ACCOUNT_ID, 'Broker', { opening_value_local: '12junk' })
    + '\n' + masterRow(ACCOUNT_ID, '') + '\n' + masterRow(ACCOUNT_ID.toUpperCase(), 'Twin', { record_status: 'bogus' });
  assert.deepEqual(Array.from(ctx.importAccountDataCsv({ file_type: 'account_master', csv: badMaster, dry_run: true }).errors), [
    'Row 2: invalid_id', 'Row 3: invalid_opening_value_local', 'Row 4: missing_account_name', 'Row 5: invalid_record_status',
  ]);
  const badDeposit = DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID) + '\n' + depositRow(OTHER_DETAIL_ID, 'nope') + '\n' + depositRow(OTHER_DETAIL_ID, ACCOUNT_ID, '0x10') + '\n' + depositRow(DETAIL_ID.toUpperCase(), ACCOUNT_ID);
  assert.deepEqual(Array.from(ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: badDeposit, dry_run: true }).errors), [
    'Row 3: invalid_account_id', 'Row 4: invalid_interest_rate', 'Row 5: duplicate_id (also on row 2)',
  ]);
});

test('duplicate ids in one file are rejected (case-insensitive) and nothing is written', () => {
  const { ctx, sheets } = runtime();
  const csv = MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') + '\n' + masterRow(ACCOUNT_ID.toUpperCase(), 'Again');
  const result = ctx.importAccountDataCsv({ file_type: 'account_master', csv });
  assert.equal(result.error, 'invalid_csv_rows');
  assert.deepEqual(Array.from(result.errors), ['Row 3: duplicate_id (also on row 2)']);
  assert.deepEqual(sheets.map(sheet => sheet.name), ['account_types']);
  const blankIds = MASTER_HEADER + '\n' + masterRow('', 'One') + '\n' + masterRow('', 'Two');
  assert.equal(ctx.importAccountDataCsv({ file_type: 'account_master', csv: blankIds }).created, 2);
});

test('a format error anywhere in a real run writes nothing', () => {
  const { ctx, sheets } = runtime();
  const csv = MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') + '\n' + masterRow(OTHER_ACCOUNT_ID, 'Broker', { account_opening_date_local: '2020-02-30' });
  const result = ctx.importAccountDataCsv({ file_type: 'account_master', csv });
  assert.deepEqual(plain(result), { ok: false, error: 'invalid_csv_rows', errors: ['Row 3: invalid_account_opening_date_local'] });
  assert.deepEqual(sheets.map(sheet => sheet.name), ['account_types']);
});

test('Sheet-dependent failures come back per row with their CSV line and valid rows still import', () => {
  const { ctx, sheet } = runtime();
  const master = MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, 'Bank') + '\n' + masterRow(OTHER_ACCOUNT_ID, 'Unknown ccy', { account_currency_local: 'USD' });
  const accounts = ctx.importAccountDataCsv({ file_type: 'account_master', csv: master });
  assert.equal(accounts.ok, false);
  assert.deepEqual(plain(accounts.results.map(entry => [entry.line, entry.ok, entry.error ?? entry.action])), [[2, true, 'created'], [3, false, 'unknown_currency']]);
  const deposit = DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID, '1.5') + '\n"\n"\n' + depositRow(OTHER_DETAIL_ID, OTHER_ACCOUNT_ID);
  const details = ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: deposit });
  assert.equal(details.rows, 2);
  assert.equal(details.created, 1);
  assert.deepEqual(plain(details.results.map(entry => [entry.line, entry.ok, entry.error ?? entry.action])), [[2, true, 'created'], [5, false, 'unknown_account']]);
  assert.equal(sheet('account_deposit').rows.length, 2);
  const again = ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID, '2') });
  assert.deepEqual(plain(again.results), [{ line: 2, key: DETAIL_ID, ok: true, action: 'updated' }]);
});

test('responses without per-row results pass through unchanged', () => {
  const { ctx } = runtime();
  ctx.importAccountData = () => ({ ok: false, error: 'duplicate_detail_id' });
  assert.deepEqual(plain(ctx.importAccountDataCsv({ file_type: 'account_deposit', csv: DEPOSIT_HEADER + '\n' + depositRow(DETAIL_ID, ACCOUNT_ID) })), { rows: 1, ok: false, error: 'duplicate_detail_id' });
});

// ── Frontend panel ────────────────────────────────────────────────────────────

function loadPanel(respond) {
  const source = fs.readFileSync(path.join(APP, 'sections/accounts.js'), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const nodes = {};
  const calls = [];
  const events = [];
  const messages = [];
  const state = { accImportOpen: true };
  const context = importResultHelpers.context({
    console, state,
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
    el: id => nodes[id] ??= { disabled: false, textContent: '', innerHTML: '', value: 'C:\\fakepath\\file.csv' },
    showLoading() {}, hideLoading() {}, showMsg: text => messages.push(text),
    document: { dispatchEvent: event => events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    ExpenseAPI: { importAccountData: async payload => { calls.push(payload); return respond(payload); } },
  });
  vm.runInContext(source + '\nthis.exposed = { _submitImport, _renderImportPanel, snapshot: () => ({ file: _importFile, busy: _importBusy, result: _importResult }) };', context);
  return { ...context.exposed, nodes, calls, events, messages, state };
}

test('import panel sends the raw CSV text with the file type and renders line-numbered failures', async () => {
  const raw = MASTER_HEADER + '\n' + masterRow(ACCOUNT_ID, '<Bank>');
  const panel = loadPanel(() => ({ ok: false, created: 1, updated: 0, failed: 1, rows: 2, results: [
    { line: 2, key: ACCOUNT_ID, ok: true, action: 'created' },
    { line: 7, key: OTHER_ACCOUNT_ID, ok: false, error: '<unknown_currency>', field: 'account_currency_local' },
  ] }));
  assert.doesNotMatch(panel._renderImportPanel(), /Retry failed rows|ready to import/);
  await panel._submitImport('account_master', { text: async () => raw });
  assert.deepEqual(plain(panel.calls), [{ file_type: 'account_master', csv: raw }]);
  const html = panel.snapshot().result;
  assert.match(html, /1 created · 0 updated · 1 failed/);
  assert.match(html, /<td class="td-mono">7<\/td><td class="import-result-reason">&lt;unknown currency(&gt;|>)\.<div class="td-mono td-muted">&lt;unknown_currency(&gt;|>)<\/div><\/td><td>account_currency_local · b0000000-0000-4000-8000-000000000002<\/td>/);
  assert.equal(panel.nodes.accImportStatus.innerHTML, html);
  assert.deepEqual(panel.events, ['et:reload']);
  assert.equal(panel.snapshot().file, null);
  assert.equal(panel.snapshot().busy, false);
  assert.equal(panel.nodes.accImportConfirm.disabled, true);
  assert.equal(panel.nodes.accImportConfirm.textContent, 'Import');
});

test('import panel lists file-level errors without reloading, and closes on full success', async () => {
  const invalid = loadPanel(() => ({ ok: false, error: 'invalid_csv_rows', errors: ['Row 3: <invalid_id>'] }));
  await invalid._submitImport('account_deposit', { text: async () => 'id\nx' });
  assert.match(invalid.snapshot().result, /<li>Row 3: &lt;invalid_id(&gt;|>)/);
  assert.match(invalid.snapshot().result, /Nothing was imported/);
  assert.deepEqual(invalid.events, []);
  assert.equal(invalid.state.accImportOpen, true);

  const topLevel = loadPanel(() => ({ ok: false, error: 'unknown_file_type' }));
  await topLevel._submitImport('account_deposit', { text: async () => 'id\nx' });
  assert.match(topLevel.snapshot().result, /Import failed: unknown_file_type/);
  assert.deepEqual(topLevel.events, []);

  const success = loadPanel(() => ({ ok: true, created: 2, updated: 1, failed: 0, results: [{ ok: true, action: 'created' }, { ok: true, action: 'created' }, { ok: true, action: 'updated' }] }));
  await success._submitImport('account_master', { text: async () => 'id\nx' });
  assert.equal(success.state.accImportOpen, false);
  assert.deepEqual(success.messages, ['2 created · 1 updated · 0 unchanged']);
  assert.deepEqual(success.events, ['et:reload']);
  // Every row identical to the Sheet: nothing was written, so nothing reloads.
  const same = loadPanel(() => ({ ok: true, created: 0, updated: 0, skipped: 2, failed: 0, results: [{ ok: true, action: 'unchanged' }, { ok: true, action: 'unchanged' }] }));
  await same._submitImport('account_master', { text: async () => 'id\nx' });
  assert.deepEqual(same.messages, ['0 created · 0 updated · 2 unchanged']);
  assert.deepEqual(same.events, []);

  const lost = loadPanel(() => { throw new Error('connection_error'); });
  await lost._submitImport('account_master', { text: async () => 'id\nx' });
  assert.match(lost.snapshot().result, /Some rows may have been saved/);
  assert.deepEqual(lost.events, ['et:reload']);
  assert.equal(lost.snapshot().busy, false);
  // The server handler threw part-way: rows may be saved, so it reloads and says so.
  const threw = loadPanel(() => ({ ok: false, error: 'request_failed' }));
  await threw._submitImport('account_master', { text: async () => 'id\nx' });
  assert.match(threw.snapshot().result, /Some rows may have been saved/);
  assert.deepEqual(threw.events, ['et:reload']);
});
