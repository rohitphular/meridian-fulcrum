const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const PARENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CHILD_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OLD_CHILD_ID = 'cccccccc-0000-4000-8000-000000000003';
const SOURCE_ACCOUNT = 'dddddddd-0000-4000-8000-000000000004';
const TARGET_ACCOUNT = 'eeeeeeee-0000-4000-8000-000000000005';
const api = path.join(__dirname, '../api');

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; this.validations = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  getRange(start, column, count = 1, width = 1) {
    const values = () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, cell) => this.rows[start - 1 + offset]?.[column - 1 + cell] ?? ''));
    const write = rows => {
      assert.ok(start >= 1);
      this.writes++;
      rows.forEach((row, offset) => {
        const destination = this.rows[start - 1 + offset] ?? [];
        row.forEach((value, cell) => { destination[column - 1 + cell] = value; });
        this.rows[start - 1 + offset] = destination;
      });
    };
    return {
      getValues: values, getValue: () => values()[0][0], setValues: write, setValue: value => write([[value]]),
      clearContent: () => write(Array.from({ length: count }, () => Array(width).fill(''))),
      setDataValidation: () => { this.validations++; }, clearDataValidations: () => { this.validations++; },
    };
  }
  appendRow(row) { this.writes++; this.rows.push(row.slice()); }
}

function runtime() {
  let generated = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, TRANSACTIONS_SHEET: 'transaction_master', CATEGORIES_SHEET: 'category_master',
    MASTER_SHEET_RENAMES: [], Utilities: { getUuid: () => 'f0000000-0000-4000-8000-' + String(++generated).padStart(12, '0') },
  });
  for (const file of ['app-utils.gs', 'sync-utils.gs', 'transaction-schema.gs', 'transaction-utils.gs', 'transaction-validation.gs', 'transaction-core.gs', 'category-core.gs', 'view-context.gs', 'ledger-core.gs', 'fx-utils.gs']) {
    vm.runInContext(fs.readFileSync(path.join(api, file), 'utf8'), ctx);
  }
  const sheet = new Sheet('transaction_master', [ctx.getTransactionSheetColumns()]);
  const categorySheet = new Sheet('category_master', [
    ['tx_type_key', 'major_category_key', 'minor_category_key', 'record_status'],
    ['money-out', 'transfer', 'bank', 'active'], ['money-in', 'transfer', 'bank', 'active'],
  ]);
  ctx.getOrCreateSheet = name => { assert.equal(name, 'transaction_master'); return sheet; };
  ctx.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({ getSheets: () => [sheet, categorySheet] }),
    newDataValidation: () => ({ requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } }),
  };
  const categories = {
    'money-out|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-in|transfer|bank': { source_account_mandatory: true, target_account_mandatory: true },
    'money-out|expense|food': { source_account_mandatory: true, target_account_mandatory: false },
  };
  ctx._buildCategoryMap = () => categories;
  ctx._loadAccountMap = () => ({ [SOURCE_ACCOUNT]: { account_currency_local: 'GBP' }, [TARGET_ACCOUNT]: { account_currency_local: 'GBP' } });
  ctx.markAccountTypeEditPending = ctx.markAccountDetailEditPending = ctx.markAccountMasterEditPending = () => false;
  ctx.catColIndex = key => categorySheet.rows[0].indexOf(key);
  const transfer = {
    id: PARENT_ID, tx_type: 'money-out', tx_date_local: '2026-09-24 12:00:00', tx_timezone_local: 'Europe/London',
    source_account: SOURCE_ACCOUNT, target_account: TARGET_ACCOUNT, source_amount_local: '10.25', target_amount_local: '10.25',
    major_category: 'transfer', minor_category: 'bank',
  };
  const row = overrides => ctx.getTransactionSheetColumns().map(key => ({
    id: PARENT_ID, tx_date_local: transfer.tx_date_local, tx_timezone_local: transfer.tx_timezone_local,
    parent_tx_id: '', tx_type: 'money-out', account_id: SOURCE_ACCOUNT, tx_amount_local: 10.25,
    major_category: 'transfer', minor_category: 'bank', record_status: 'active', sync_status: 'in-sync',
    sync_date: 'old-sync-date', sync_notes: 'old-sync-note', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z',
    ...overrides,
  }[key] ?? ''));
  const value = (stored, key) => stored[ctx.txColIndex(key)];
  const event = (start, column, count = 1, width = 1) => ({ range: {
    getSheet: () => sheet, getRow: () => start, getColumn: () => column, getNumRows: () => count, getNumColumns: () => width,
  } });
  return { ctx, sheet, categories, transfer, row, value, event };
}

test('a missing reverse transfer category rejects both source paths before transaction writes', () => {
  for (const bulk of [false, true]) {
    const { ctx, sheet, categories, transfer } = runtime();
    delete categories['money-in|transfer|bank'];
    const result = bulk ? ctx.createTransactionsBulk({ transactions: [transfer] }).results[0] : ctx.createTransaction(transfer);
    assert.equal(result.error, 'missing_reverse_transfer_category');
    assert.equal(sheet.writes, 0);
  }
});

test('either transfer direction keeps shared keys and resolves a real reverse category', () => {
  for (const txType of ['money-in', 'money-out']) {
    const { ctx, sheet, transfer, value } = runtime();
    assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, tx_type: txType }] }).ok, true);
    assert.equal(value(sheet.rows[1], 'tx_type'), txType);
    assert.notEqual(value(sheet.rows[2], 'tx_type'), txType);
    assert.equal(value(sheet.rows[1], 'major_category'), value(sheet.rows[2], 'major_category'));
    assert.equal(value(sheet.rows[1], 'minor_category'), value(sheet.rows[2], 'minor_category'));
  }
});

test('a transfer cannot use the same account on both legs', () => {
  for (const bulk of [false, true]) {
    const { ctx, sheet, transfer } = runtime();
    const invalid = { ...transfer, target_account: SOURCE_ACCOUNT };
    const result = bulk ? ctx.createTransactionsBulk({ transactions: [invalid] }).results[0] : ctx.createTransaction(invalid);
    assert.equal(result.error, 'same_transfer_account');
    assert.equal(sheet.writes, 0);
  }
});

test('bulk UUIDs validate and case variants cannot create duplicate source identities', () => {
  for (const id of ['not-a-uuid', 42, {}, 'aaaaaaaa000040008000000000000001']) {
    const { ctx, sheet, transfer } = runtime();
    assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, id }] }).results[0].error, 'invalid_id');
    assert.equal(sheet.writes, 0);
  }
  const { ctx, sheet, transfer, value } = runtime();
  const result = ctx.createTransactionsBulk({ transactions: [{ ...transfer, id: ' ' + PARENT_ID.toUpperCase() + ' ' }, transfer] });
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].error, 'duplicate_id_in_batch');
  assert.equal(value(sheet.rows[1], 'id'), PARENT_ID);
  assert.equal(sheet.rows.length, 3);
});

test('uppercase stored UUIDs match retries without changing existing identities, links or created_at', () => {
  const { ctx, sheet, transfer, row, value } = runtime();
  sheet.rows.push(row({ id: PARENT_ID.toUpperCase() }));
  sheet.rows.push(row({ id: CHILD_ID.toUpperCase(), parent_tx_id: PARENT_ID.toUpperCase(), tx_type: 'money-in', account_id: TARGET_ACCOUNT }));
  assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).updated, 1);
  assert.equal(value(sheet.rows[1], 'id'), PARENT_ID.toUpperCase());
  assert.equal(value(sheet.rows[2], 'id'), CHILD_ID.toUpperCase());
  assert.equal(value(sheet.rows[2], 'parent_tx_id'), PARENT_ID.toUpperCase());
  for (const stored of sheet.rows.slice(1)) {
    assert.equal(value(stored, 'created_at'), '2024-01-01T00:00:00.000Z');
    assert.equal(value(stored, 'sync_status'), 'update-pending');
    assert.equal(value(stored, 'sync_date'), '');
  }
});

test('ambiguous or invalid existing UUIDs reject the whole rewrite before any write', () => {
  for (const [overrides, error] of [
    [{ id: PARENT_ID.toUpperCase() }, 'duplicate_existing_transaction_id'],
    [{ id: 'broken' }, 'invalid_existing_transaction_id'],
    [{ id: CHILD_ID, parent_tx_id: 'broken' }, 'invalid_existing_parent_tx_id'],
  ]) {
    const { ctx, sheet, transfer, row } = runtime();
    sheet.rows.push(row({}), row(overrides));
    const before = JSON.stringify(sheet.rows);
    assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).error, error);
    assert.equal(JSON.stringify(sheet.rows), before);
    assert.equal(sheet.writes, 0);
  }
});

test('bulk lifecycle applies to new pairs and omitted lifecycle preserves existing leg statuses', () => {
  for (const status of ['active', 'inactive', 'deleted', 'locked']) {
    const { ctx, sheet, transfer, value } = runtime();
    assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, record_status: status }] }).ok, true);
    assert.deepEqual(sheet.rows.slice(1).map(stored => value(stored, 'record_status')), [status, status]);
    if (status === 'locked') continue;
    assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).ok, true);
    assert.deepEqual(sheet.rows.slice(1).map(stored => value(stored, 'record_status')), [status, status]);
    assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, record_status: 'active' }] }).ok, true);
    assert.deepEqual(sheet.rows.slice(1).map(stored => value(stored, 'record_status')), ['active', 'active']);
  }
});

test('invalid lifecycle and locked existing legs reject imports without changing source history', () => {
  for (const lockedLeg of [0, 1]) {
    const { ctx, sheet, transfer, row } = runtime();
    sheet.rows.push(row({ record_status: lockedLeg === 0 ? 'locked' : 'active' }));
    sheet.rows.push(row({ id: CHILD_ID, parent_tx_id: PARENT_ID, tx_type: 'money-in', account_id: TARGET_ACCOUNT, record_status: lockedLeg === 1 ? 'locked' : 'active' }));
    const before = JSON.stringify(sheet.rows);
    assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, record_status: 'active' }] }).results[0].error, 'record_locked');
    assert.equal(JSON.stringify(sheet.rows), before);
    assert.equal(sheet.writes, 0);
  }
  const { ctx, sheet, transfer } = runtime();
  assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, record_status: 'archived' }] }).results[0].error, 'invalid_record_status');
  assert.equal(sheet.writes, 0);
});

test('a deleted parent cannot accidentally be rebuilt with a live child', () => {
  const { ctx, sheet, transfer, row, value } = runtime();
  sheet.rows.push(row({ record_status: 'deleted' }));
  sheet.rows.push(row({ id: CHILD_ID, parent_tx_id: PARENT_ID, tx_type: 'money-in', account_id: TARGET_ACCOUNT }));
  assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).results[0].error, 'invalid_transfer_lifecycle');
  assert.equal(sheet.writes, 0);
  assert.equal(ctx.createTransactionsBulk({ transactions: [{ ...transfer, record_status: 'deleted' }] }).ok, true);
  assert.deepEqual(sheet.rows.slice(1).map(stored => value(stored, 'record_status')), ['deleted', 'deleted']);
});

test('live child identity wins over historical tombstones and duplicate live children fail', () => {
  const { ctx, sheet, transfer, row, value } = runtime();
  sheet.rows.push(row({}), row({ id: CHILD_ID, parent_tx_id: PARENT_ID, tx_type: 'money-in', account_id: TARGET_ACCOUNT }));
  sheet.rows.push(row({ id: OLD_CHILD_ID, parent_tx_id: PARENT_ID, tx_type: 'money-in', account_id: TARGET_ACCOUNT, record_status: 'deleted' }));
  assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).ok, true);
  const live = sheet.rows.slice(1).filter(stored => value(stored, 'record_status') !== 'deleted');
  assert.deepEqual(live.map(stored => value(stored, 'id')), [PARENT_ID, CHILD_ID]);
  sheet.rows.push(row({ id: '12345678-0000-4000-8000-000000000006', parent_tx_id: PARENT_ID, tx_type: 'money-in', account_id: TARGET_ACCOUNT }));
  const before = sheet.writes;
  assert.equal(ctx.createTransactionsBulk({ transactions: [transfer] }).error, 'multiple_live_transfer_children');
  assert.equal(sheet.writes, before);
});

test('manual edits to every business/lifecycle field queue normal sync without overwriting data', () => {
  for (let column = 1; column <= 19; column++) {
    const { ctx, sheet, row, value, event } = runtime();
    sheet.rows.push(row({}));
    const originalBusiness = sheet.rows[1].slice(0, 19);
    assert.equal(ctx.markTransactionEditPending(event(2, column)), true);
    assert.deepEqual(sheet.rows[1].slice(0, 19), originalBusiness);
    assert.equal(value(sheet.rows[1], 'sync_status'), 'update-pending');
    assert.equal(value(sheet.rows[1], 'sync_date'), '');
    assert.equal(value(sheet.rows[1], 'sync_notes'), '');
    assert.equal(value(sheet.rows[1], 'created_at'), '2024-01-01T00:00:00.000Z');
    assert.match(value(sheet.rows[1], 'updated_at'), /^\d{4}-\d\d-\d\dT/);
  }
});

test('multirow pasted transactions queue each nonempty row and retain pending-create semantics', () => {
  const { ctx, sheet, row, value, event } = runtime();
  sheet.rows.push(row({ sync_status: 'create-failed' }), Array(24).fill(''), row({ id: CHILD_ID }));
  ctx.markTransactionEditPending(event(1, 1, 4, 24));
  assert.equal(value(sheet.rows[1], 'sync_status'), 'create-pending');
  assert.equal(value(sheet.rows[3], 'sync_status'), 'update-pending');
  assert.deepEqual(sheet.rows[2], Array(24).fill(''));
  assert.equal(sheet.writes, 2);
});

test('large transaction pastes queue sync with two writes independent of row count', () => {
  const { ctx, sheet, row, value, event } = runtime();
  for (let index = 0; index < 1000; index++) sheet.rows.push(index === 450 ? Array(24).fill('') : row({}));
  ctx.markTransactionEditPending(event(2, 7, 1000, 1));
  assert.equal(sheet.writes, 2);
  assert.deepEqual(sheet.rows[451], Array(24).fill(''));
  assert.equal(sheet.rows.slice(1).filter(stored => value(stored, 'sync_status') === 'update-pending').length, 999);
  assert.equal(value(sheet.rows[1000], 'created_at'), '2024-01-01T00:00:00.000Z');
});

test('metadata-only edits and invalid positional headers never trigger business rewrites', () => {
  for (let column = 20; column <= 24; column++) {
    const { ctx, sheet, row, event } = runtime();
    sheet.rows.push(row({}));
    ctx.markTransactionEditPending(event(2, column));
    assert.equal(sheet.writes, 0);
  }
  const { ctx, sheet, row, event } = runtime();
  sheet.rows.push(row({}));
  [sheet.rows[0][5], sheet.rows[0][6]] = [sheet.rows[0][6], sheet.rows[0][5]];
  assert.throws(() => ctx.markTransactionEditPending(event(2, 7)), /sheet_header_mismatch/);
  assert.equal(sheet.writes, 0);
});

test('onEdit queues sync and keeps the single-cell dropdown cascade, while pasted categories survive', () => {
  const single = runtime();
  single.sheet.rows.push(single.row({}));
  single.ctx.onEdit(single.event(2, single.ctx.txColIndex('tx_type') + 1));
  assert.equal(single.value(single.sheet.rows[1], 'sync_status'), 'update-pending');
  assert.equal(single.value(single.sheet.rows[1], 'major_category'), '');
  assert.equal(single.value(single.sheet.rows[1], 'minor_category'), '');
  assert.ok(single.sheet.validations > 0);
  const pasted = runtime();
  pasted.sheet.rows.push(pasted.row({}), pasted.row({ id: CHILD_ID }));
  pasted.ctx.onEdit(pasted.event(2, 5, 2, 5));
  for (const stored of pasted.sheet.rows.slice(1)) {
    assert.equal(pasted.value(stored, 'sync_status'), 'update-pending');
    assert.equal(pasted.value(stored, 'major_category'), 'transfer');
    assert.equal(pasted.value(stored, 'minor_category'), 'bank');
  }
});
