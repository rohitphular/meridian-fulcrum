const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const API = path.join(__dirname, '../api');

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
  const script = fs.readFileSync(path.join(__dirname, '../scripts/factory-reset.sh'), 'utf8');
  for (const action of ['create_account_types_bulk', 'create_categories_bulk', 'import_account_data', 'create_subscriptions_bulk', 'create_transactions_bulk']) assert.ok(script.includes(action));
});
