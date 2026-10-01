const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');
// The loader job that calls these endpoints lives in data-synchronization/ledger-sheet-load.
const LOADER = path.join(__dirname, '../../data-synchronization/ledger-sheet-load');

class Sheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map(row => row.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getMaxRows() { return this.rows.length; }
  getMaxColumns() { return this.getLastColumn(); }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  setFrozenRows() {}
  appendRow(row) { this.rows.push(row.slice()); }
  getRange(start, column, count = 1, width = 1) {
    const write = rows => rows.forEach((row, offset) => {
      while (this.rows.length < start + offset) this.rows.push([]);
      row.forEach((value, index) => { this.rows[start - 1 + offset][column - 1 + index] = value; });
    });
    return {
      getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, index) => this.rows[start - 1 + offset]?.[column - 1 + index] ?? '')),
      getValue: () => this.rows[start - 1]?.[column - 1] ?? '',
      setValues: write, setValue: value => write([[value]]), setNumberFormat() { return this; }, setNumberFormats() { return this; }, clearContent() {},
    };
  }
}
function runtime(initialTabs) {
  const sheets = initialTabs.map(name => new Sheet(name, [['keep', name]]));
  let uuid = 0;
  const spreadsheet = {
    getId: () => 'sheet-id', getSheets: () => sheets, getSpreadsheetTimeZone: () => 'Europe/London',
    getSheetByName: name => sheets.find(sheet => sheet.name === name),
    insertSheet: name => { const sheet = new Sheet(name); sheets.push(sheet); return sheet; },
    deleteSheet: sheet => sheets.splice(sheets.indexOf(sheet), 1),
  };
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { getUuid: () => 'f0000000-0000-4000-8000-' + String(++uuid).padStart(12, '0'), formatDate: date => date.toISOString() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Session: { getScriptTimeZone: () => 'Europe/London' },
  });
  for (const file of fs.readdirSync(API).filter(name => name.endsWith('.gs')).sort()) vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), ctx);
  ctx.listRates = () => [{ currency: 'GBP' }, { currency: 'XAU' }];
  return { ctx, sheets, tab: name => sheets.find(sheet => sheet.name === name) };
}
const RETAINED = ['dummy', 'rates', 'audit_access', 'advisor_chat', 'computed_insights', 'my_notes'];

test('delete removes only the CSV-backed tabs and requires confirmation for the bound spreadsheet', () => {
  const { ctx, sheets } = runtime([...RETAINED, 'account_types', 'transaction_master', 'account_deposit']);
  assert.equal(ctx.factoryResetDeleteSheets({ spreadsheet_id: 'sheet-id' }).error, 'confirmation_required');
  assert.equal(ctx.factoryResetDeleteSheets({ confirm: 'factory-reset', spreadsheet_id: 'other' }).error, 'spreadsheet_mismatch');
  assert.equal(sheets.length, RETAINED.length + 3);
  const result = ctx.factoryResetDeleteSheets({ confirm: 'factory-reset', spreadsheet_id: 'sheet-id' });
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.deleted).sort(), ['account_deposit', 'account_types', 'transaction_master']);
  assert.deepEqual(sheets.map(sheet => sheet.name), RETAINED);
  assert.ok(sheets.every(sheet => JSON.stringify(sheet.rows) === JSON.stringify([['keep', sheet.name]])));
});

test('delete refuses to remove the last remaining tab', () => {
  const { ctx, sheets } = runtime(['account_types']);
  assert.equal(ctx.factoryResetDeleteSheets({ confirm: 'factory-reset', spreadsheet_id: 'sheet-id' }).error, 'no_retained_sheet');
  assert.equal(sheets.length, 1);
});

test('router exposes the delete action behind the PIN check, and imports use the entity CSV endpoints', () => {
  const source = fs.readFileSync(path.join(API, 'app-router.gs'), 'utf8');
  const post = source.slice(source.indexOf('function _dispatchPost('));
  assert.match(post, /'factory_reset_delete_sheets'\)\s+return json\(factoryResetDeleteSheets\(body\)\)/);
  assert.doesNotMatch(post, /factory_reset_import/);
  for (const [action, handler] of [['create_account_types_bulk', 'importAccountTypesCsv'], ['create_categories_bulk', 'importCategoriesCsv'],
    ['import_account_data', 'importAccountDataCsv'], ['create_subscriptions_bulk', 'importSubscriptionsCsv'], ['create_transactions_bulk', 'importTransactionsCsv']])
    assert.match(post, new RegExp(`'${action}'\\)\\s+return json\\(${handler}\\(body\\)\\)`));
  const datasets = fs.readFileSync(path.join(LOADER, 'config.yaml'), 'utf8');
  for (const action of ['create_account_types_bulk', 'create_categories_bulk', 'import_account_data', 'create_subscriptions_bulk', 'create_transactions_bulk']) assert.ok(datasets.includes(action));
});

test('arrange_sheet_tabs reuses the existing sheet-order code outside the POST lock, after the PIN check', () => {
  const runtimeFor = pinOk => {
    const ctx = vm.createContext({ console: { log() {}, error() {}, warn() {} } });
    vm.runInContext(fs.readFileSync(path.join(API, 'app-router.gs'), 'utf8'), ctx);
    const seen = { order: 0, lock: 0 };
    Object.assign(ctx, {
      json: value => value, extractMeta: () => ({ ip: 'test' }), checkLocked: () => false, checkPin: () => pinOk, recordAccess() {},
      ensureExpenseTrackerSheetOrder: () => { seen.order++; return { ok: true, changed: true, moved: 3 }; },
      LockService: { getScriptLock: () => { seen.lock++; return { tryLock: () => true, releaseLock() {} }; } },
    });
    return { post: body => ctx.doPost({ postData: { contents: JSON.stringify(body) } }), seen };
  };
  const allowed = runtimeFor(true);
  assert.deepEqual(JSON.parse(JSON.stringify(allowed.post({ action: 'arrange_sheet_tabs', pin: 'x' }))), { ok: true, changed: true, moved: 3 });
  assert.deepEqual(allowed.seen, { order: 1, lock: 0 });
  const denied = runtimeFor(false);
  assert.equal(denied.post({ action: 'arrange_sheet_tabs', pin: 'bad' }).error, 'auth');
  assert.equal(denied.seen.order, 0);
  assert.match(fs.readFileSync(path.join(LOADER, 'steps/order_tabs.py'), 'utf8'), /post\("arrange_sheet_tabs"\)/);
});

test('ledger-sheet-load only calls actions the router serves; delete and fill ids keep their server contracts', () => {
  const router = fs.readFileSync(path.join(API, 'app-router.gs'), 'utf8');
  const config = fs.readFileSync(path.join(LOADER, 'config.yaml'), 'utf8');
  const steps = ['fill_ids', 'check_files', 'drop_tabs', 'load_data', 'order_tabs'].map(name => fs.readFileSync(path.join(LOADER, `steps/${name}.py`), 'utf8')).join('\n');
  const loader = fs.readFileSync(path.join(LOADER, 'core/loader.py'), 'utf8');
  const actions = new Set([
    ...[...config.matchAll(/action: ([a-z_]+)/g)].map(match => match[1]),
    ...[...config.matchAll(/^  - (list_[a-z_]+)$/gm)].map(match => match[1]),
    ...[...(steps + loader).matchAll(/client\.(?:get|post)\("([a-z_]+)"/g)].map(match => match[1]),
  ]);
  for (const action of ['verify', 'fill_csv_ids', 'factory_reset_delete_sheets', 'arrange_sheet_tabs', 'list_accounts', 'create_transactions_bulk']) assert.ok(actions.has(action), action);
  for (const action of actions) assert.match(router, new RegExp(`'${action}'`), `router serves ${action}`);
  assert.match(steps, /confirm="factory-reset", spreadsheet_id=context\.spreadsheet_id/);
  assert.ok(!fs.existsSync(path.join(__dirname, '../scripts')), 'the bash scripts moved to the Python module');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../Makefile'), 'utf8'), /factory-reset/);
});
