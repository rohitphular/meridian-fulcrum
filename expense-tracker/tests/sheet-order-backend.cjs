const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function runtime(names, options = {}) {
  const calls = [], logs = [], toasts = [];
  const sheets = names.map((name, index) => ({
    id: index + 1, name, hidden: (options.hidden || []).includes(name),
    getSheetId() { return this.id; }, getName() { return this.name; },
    isSheetHidden() { calls.push(['hidden', this.name]); return this.hidden; },
    showSheet() { calls.push(['show', this.name]); this.hidden = false; },
    hideSheet() { calls.push(['hide', this.name]); if (options.failHide === this.name) throw new Error('private error'); this.hidden = true; },
  }));
  const originalIds = sheets.map(sheet => sheet.id);
  let active = sheets.find(sheet => sheet.name === options.active) || sheets.find(sheet => !sheet.hidden);
  const originalActive = active;
  let moves = 0, released = 0;
  const spreadsheet = {
    getSheets() { return sheets.slice(); },
    getActiveSheet() { calls.push(['getActive']); return active; },
    setActiveSheet(sheet, restoreSelection) {
      calls.push(['activate', sheet.name, restoreSelection]);
      assert.equal(sheet.hidden, false);
      active = sheet;
    },
    moveActiveSheet(position) {
      calls.push(['move', position]); moves++;
      if (options.failMove === moves) throw new Error('private error');
      assert.ok(position >= 1 && position <= sheets.length);
      sheets.splice(sheets.indexOf(active), 1); sheets.splice(position - 1, 0, active);
    },
    toast(...args) { toasts.push(args); },
  };
  const menu = { addItem(label, handler) { calls.push(['menuItem', label, handler]); return this; }, addToUi() { calls.push(['addMenu']); } };
  const ctx = vm.createContext({
    console: Object.fromEntries(['log', 'error'].map(level => [level, (...args) => logs.push(args.join(' '))])),
    LockService: { getScriptLock: () => ({
      tryLock(timeout) { calls.push(['lock', timeout]); return options.busy !== true; },
      releaseLock() { released++; if (options.failRelease) throw new Error('private error'); },
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet() { calls.push(['spreadsheet']); return options.noSpreadsheet ? null : spreadsheet; },
      getUi: () => ({ createMenu(label) { calls.push(['menu', label]); return menu; } }),
    },
  });
  for (const file of ['app-config.gs', 'sheet-order.gs'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), ctx);
  return { ctx, sheets, calls, logs, toasts, options, originalIds, originalActive,
    active: () => active, released: () => released };
}

test('partial workbook order preserves custom tab order, identities and original selection', () => {
  const state = runtime(['Notes', 'account_master', 'Archive', 'transaction_master', 'rates'], { active: 'Notes' });
  const result = state.ctx.ensureExpenseTrackerSheetOrder();
  assert.equal(result.ok, true); assert.equal(result.changed, true);
  assert.deepEqual(state.sheets.map(sheet => sheet.name), ['transaction_master', 'account_master', 'rates', 'Notes', 'Archive']);
  assert.deepEqual(state.sheets.map(sheet => sheet.id).sort(), state.originalIds.sort());
  assert.equal(state.active(), state.originalActive);
  assert.deepEqual(state.calls.filter(call => call[0] === 'activate').at(-1), ['activate', 'Notes', true]);
  assert.equal(state.released(), 1);
});

test('already ordered, custom-only and empty workbooks never change selection or visibility', () => {
  for (const names of [['transaction_master', 'rates', 'Notes'], ['Notes', 'Archive'], []]) {
    const state = runtime(names, { hidden: ['rates'] });
    const result = state.ctx.ensureExpenseTrackerSheetOrder();
    assert.equal(result.ok, true); assert.equal(result.changed, false); assert.equal(result.moved, 0);
    assert.deepEqual(state.calls, [['lock', 1000], ['spreadsheet']]);
    assert.equal(state.released(), 1);
  }
});

test('hidden moved tabs are temporarily shown and restored after the original selection', () => {
  const state = runtime(['Notes', 'rates', 'account_master', 'transaction_master'], { hidden: ['transaction_master', 'rates'], active: 'Notes' });
  assert.equal(state.ctx.ensureExpenseTrackerSheetOrder().ok, true);
  assert.deepEqual(state.sheets.filter(sheet => sheet.hidden).map(sheet => sheet.name), ['transaction_master', 'rates']);
  const restoreIndex = state.calls.findIndex(call => call[0] === 'activate' && call[1] === 'Notes' && call[2] === true);
  assert.ok(state.calls.every((call, index) => call[0] !== 'hide' || index > restoreIndex));
  assert.ok(state.calls.filter(call => call[0] === 'activate').every(call => call[2] === true));
  assert.equal(state.active(), state.originalActive);
});

test('partially failed reordering restores hidden state and selection and can be retried', () => {
  const state = runtime(['Notes', 'rates', 'account_master', 'transaction_master'], { hidden: ['transaction_master', 'account_master'], active: 'Notes', failMove: 2 });
  const failed = state.ctx.ensureExpenseTrackerSheetOrder();
  assert.equal(failed.error, 'sheet_order_failed'); assert.equal(failed.moved, 1);
  assert.equal(state.active(), state.originalActive);
  assert.equal(state.sheets.find(sheet => sheet.name === 'account_master').hidden, true);
  assert.equal(state.sheets.find(sheet => sheet.name === 'transaction_master').hidden, true);
  assert.equal(state.released(), 1); assert.equal(JSON.stringify(state.logs).includes('private error'), false);
  state.options.failMove = null;
  assert.equal(state.ctx.ensureExpenseTrackerSheetOrder().ok, true);
  assert.deepEqual(state.sheets.map(sheet => sheet.name), ['transaction_master', 'account_master', 'rates', 'Notes']);
  assert.equal(state.active(), state.originalActive); assert.equal(state.released(), 2);
});

test('cleanup failures return structured errors and do not skip remaining cleanup', () => {
  const state = runtime(['Notes', 'account_master', 'transaction_master'], { hidden: ['transaction_master', 'account_master'], failHide: 'transaction_master' });
  const result = state.ctx.ensureExpenseTrackerSheetOrder();
  assert.equal(result.error, 'sheet_order_cleanup_failed');
  assert.equal(result.restoration_errors[0], 'sheet_visibility_restore_failed');
  assert.equal(state.sheets.find(sheet => sheet.name === 'account_master').hidden, true);
  assert.equal(state.released(), 1);
  assert.equal(JSON.stringify(state.logs).includes('private error'), false);
  const noOp = runtime(['transaction_master'], { failRelease: true });
  assert.equal(noOp.ctx.ensureExpenseTrackerSheetOrder().error, 'sheet_order_cleanup_failed');
});

test('lock contention and absent spreadsheet make no tab changes', () => {
  const busy = runtime(['rates', 'transaction_master'], { busy: true });
  assert.equal(busy.ctx.ensureExpenseTrackerSheetOrder().error, 'busy_retry');
  assert.deepEqual(busy.calls, [['lock', 1000]]); assert.equal(busy.released(), 0);
  const missing = runtime([], { noSpreadsheet: true });
  assert.equal(missing.ctx.ensureExpenseTrackerSheetOrder().error, 'no_active_spreadsheet');
  assert.deepEqual(missing.calls, [['lock', 1000], ['spreadsheet']]); assert.equal(missing.released(), 1);
  const invalid = runtime(['rates', 'transaction_master']);
  vm.runInContext('EXPENSE_TRACKER_SHEET_ORDER.push(TRANSACTIONS_SHEET)', invalid.ctx);
  assert.equal(invalid.ctx.ensureExpenseTrackerSheetOrder().error, 'invalid_sheet_order');
  assert.deepEqual(invalid.calls, [['lock', 1000]]); assert.equal(invalid.released(), 1);
});

test('onOpen retains a retry menu when ordering is busy and menu action reports outcomes', () => {
  const state = runtime(['rates', 'transaction_master'], { busy: true });
  assert.equal(state.ctx.onOpen().error, 'busy_retry');
  assert.ok(state.calls.some(call => call[0] === 'menuItem' && call[1] === 'Arrange sheet tabs' && call[2] === 'arrangeExpenseTrackerSheetTabs'));
  assert.equal(state.ctx.arrangeExpenseTrackerSheetTabs().error, 'busy_retry');
  assert.match(state.toasts[0][0], /Please retry/);
  state.options.busy = false;
  assert.equal(state.ctx.arrangeExpenseTrackerSheetTabs().ok, true);
  assert.equal(state.toasts[1][0], 'Sheet tabs arranged.');
  assert.equal(state.ctx.arrangeExpenseTrackerSheetTabs().changed, false);
  assert.equal(state.toasts[2][0], 'Sheet tabs are already in order.');
});
