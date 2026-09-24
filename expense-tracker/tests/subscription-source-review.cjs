const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const api = path.join(__dirname, '../api');
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCOUNT = 'bbbbbbbb-0000-4000-8000-000000000002';
const CATEGORY = 'cccccccc-0000-4000-8000-000000000003';
const OTHER_ID = 'dddddddd-0000-4000-8000-000000000004';

class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(row => row.slice()); this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows[0].length; }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  appendRow(row) { this.rows.push(row.slice()); this.writes++; }
  getRange(start, column, count = 1, width = 1) {
    return {
      getValues: () => Array.from({ length: count }, (_, offset) => Array.from({ length: width }, (_, cell) => this.rows[start + offset - 1]?.[column + cell - 1] ?? '')),
      setValues: rows => {
        this.writes++;
        rows.forEach((row, offset) => {
          this.rows[start + offset - 1] ??= [];
          row.forEach((value, cell) => { this.rows[start + offset - 1][column + cell - 1] = value; });
        });
      },
    };
  }
}

function runtime() {
  let generated = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Utilities: { getUuid: () => 'e0000000-0000-4000-8000-' + String(++generated).padStart(12, '0') },
  });
  for (const file of ['app-config.gs', 'app-utils.gs', 'sync-utils.gs', 'account-schema.gs', 'category-schema.gs',
    'subscription-schema.gs', 'subscription-utils.gs', 'subscription-validation.gs', 'subscription-core.gs', 'category-core.gs']) {
    vm.runInContext(fs.readFileSync(path.join(api, file), 'utf8'), ctx);
  }
  const sheet = new Sheet('subscription_master', [ctx.getSubscriptionSheetColumns()]);
  const account = { id: ACCOUNT, account_currency_local: 'GBP', record_status: 'active' };
  const category = { id: CATEGORY, tx_type_key: 'money-out', major_category_key: 'housing', minor_category_key: 'rent', is_subscription_eligible: true, record_status: 'active' };
  const accounts = new Sheet('account_master', [ctx.getAccountSheetColumns(), ctx.getAccountSheetColumns().map(key => account[key] ?? '')]);
  const categories = new Sheet('category_master', [ctx.getCategorySheetColumns(), ctx.getCategorySheetColumns().map(key => category[key] ?? '')]);
  const sheets = [sheet, accounts, categories];
  ctx.getOrCreateSheet = name => { const found = sheets.find(candidate => candidate.name === name); assert.ok(found, name); return found; };
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'Europe/London' }) };
  ctx.markAccountTypeEditPending = ctx.markAccountDetailEditPending = ctx.markAccountMasterEditPending = () => false;
  const body = { id: ID, subscription_name: 'Rent', subscription_amount_local: '12.005', frequency: 'monthly', day_of_month: 31, source_account: ACCOUNT,
    tx_type: 'money-out', major_category: 'housing', minor_category: 'rent', subscription_timezone_local: 'Europe/London' };
  const row = overrides => ctx.getSubscriptionSheetColumns().map(key => ({ ...body, record_status: 'active', sync_status: 'in-sync', sync_date: 'old-date',
    sync_notes: 'old-note', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', ...overrides }[key] ?? ''));
  const value = (stored, key) => stored[ctx.subColIndex(key)];
  const event = (start, column, count = 1, width = 1) => ({ range: { getSheet: () => sheet, getRow: () => start, getColumn: () => column,
    getNumRows: () => count, getNumColumns: () => width } });
  return { ctx, sheet, accounts, categories, body, row, value, event };
}

test('interactive create stores its optional end date and precise amount without a runtime failure', () => {
  const { ctx, sheet, body, value } = runtime();
  assert.equal(ctx.createSubscription({ ...body, subscription_end_date_local: '2030-12-31 23:59:59' }).ok, true);
  assert.equal(value(sheet.rows[1], 'subscription_end_date_local'), '2030-12-31 23:59:59');
  assert.equal(value(sheet.rows[1], 'subscription_amount_local'), '12.005');
  assert.equal(value(sheet.rows[1], 'sync_status'), 'create-pending');
  assert.equal(value(sheet.rows[1], 'id'), ID);
});

test('invalid values fail before any subscription write in both creation paths', () => {
  for (const [change, error] of [
    [{ subscription_amount_local: true }, 'invalid_subscription_amount_local'],
    [{ subscription_amount_local: '12bad' }, 'invalid_subscription_amount_local'],
    [{ subscription_amount_local: '0x10' }, 'invalid_subscription_amount_local'],
    [{ subscription_amount_local: 'Infinity' }, 'invalid_subscription_amount_local'],
    [{ source_account: 'broken' }, 'invalid_source_account'],
    [{ id: 'broken' }, 'invalid_id'],
    [{ day_of_month: '2.5' }, 'invalid_day_of_month'],
    [{ day_of_week: false }, 'invalid_day_of_week'],
    [{ subscription_timezone_local: 'not/a-zone' }, 'invalid_subscription_timezone_local'],
    [{ subscription_timezone_local: '+01:00' }, 'invalid_subscription_timezone_local'],
    [{ subscription_start_date_local: '2026-02-30 00:00:00' }, 'invalid_subscription_start_date_local'],
    [{ subscription_start_date_local: '2026-02-01' }, 'invalid_subscription_start_date_local'],
    [{ subscription_start_date_local: '2026-02-01 00:00:00Z' }, 'invalid_subscription_start_date_local'],
    [{ subscription_start_date_local: '2026-01-01 00:00:00', subscription_timezone_local: '' }, 'missing_subscription_timezone_local'],
    [{ subscription_start_date_local: '2026-03-29 01:30:00' }, 'nonexistent_local_time'],
    [{ subscription_start_date_local: '2026-10-25 01:30:00' }, 'ambiguous_local_time'],
    [{ subscription_start_date_local: '2026-01-01 00:00:00.000002', subscription_end_date_local: '2026-01-01 00:00:00.000001' }, 'end_before_start'],
    [{ frequency: 'quarterly' }, 'missing_subscription_start_date_local'],
    [{ frequency: 'annual' }, 'missing_subscription_start_date_local'],
    [{ record_status: 'invalid' }, 'invalid_record_status'],
  ]) {
    for (const bulk of [false, true]) {
      const { ctx, sheet, body } = runtime();
      const payload = { ...body, ...change };
      const result = bulk ? ctx.createSubscriptionsBulk({ subscriptions: [payload] }).results[0] : ctx.createSubscription(payload);
      assert.equal(result.error, error, JSON.stringify(change));
      assert.equal(sheet.writes, 0);
    }
  }
});

test('complete category/account references validate; optional partial classification stays optional', () => {
  for (const [change, error] of [[{ source_account: OTHER_ID }, 'unknown_source_account'], [{ minor_category: 'missing' }, 'unknown_category']]) {
    const { ctx, sheet, body } = runtime();
    assert.equal(ctx.createSubscription({ ...body, ...change }).error, error);
    assert.equal(sheet.writes, 0);
  }
  const { ctx, sheet, body, categories } = runtime();
  categories.rows[1][ctx.catColIndex('is_subscription_eligible')] = false;
  assert.equal(ctx.createSubscription(body).error, 'category_not_subscription_eligible');
  assert.equal(ctx.createSubscription({ ...body, tx_type: '', major_category: '', minor_category: 'rent' }).ok, true);
  assert.equal(sheet.rows.length, 2);
});

test('historical bulk rows can reference closed accounts and inactive categories without changing lifecycle', () => {
  const { ctx, sheet, body, accounts, categories, value } = runtime();
  accounts.rows[1][ctx.acctColIndex('record_status')] = 'inactive';
  assert.equal(ctx.createSubscription(body).error, 'source_account_not_active');
  categories.rows[1][ctx.catColIndex('record_status')] = 'inactive';
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [{ ...body, record_status: 'deleted' }] }).ok, true);
  assert.equal(value(sheet.rows[1], 'record_status'), 'deleted');
});

test('bulk matching preserves UUID spelling, omitted lifecycle and server audit ownership', () => {
  for (const status of ['inactive', 'deleted', 'active']) {
    const { ctx, sheet, body, row, value } = runtime();
    sheet.rows.push(row({ id: ID.toUpperCase(), record_status: status }));
    const result = ctx.createSubscriptionsBulk({ subscriptions: [{ ...body, record_status: '', created_at: 'forged', updated_at: 'forged', sync_status: 'in-sync', sync_notes: 'forged' }] });
    assert.equal(result.updated, 1);
    assert.equal(result.results[0].index, 0);
    assert.equal(sheet.rows.length, 2);
    assert.equal(value(sheet.rows[1], 'id'), ID.toUpperCase());
    assert.equal(value(sheet.rows[1], 'record_status'), status);
    assert.equal(value(sheet.rows[1], 'created_at'), '2024-01-01T00:00:00Z');
    assert.notEqual(value(sheet.rows[1], 'updated_at'), 'forged');
    assert.equal(value(sheet.rows[1], 'sync_status'), 'update-pending');
    assert.equal(value(sheet.rows[1], 'sync_date'), '');
    assert.equal(value(sheet.rows[1], 'sync_notes'), '');
  }
});

test('duplicate input and ambiguous existing UUIDs cannot create or overwrite identities', () => {
  const { ctx, sheet, body } = runtime();
  const result = ctx.createSubscriptionsBulk({ subscriptions: [body, { ...body, id: ID.toUpperCase() }] });
  assert.equal(result.created, 1);
  assert.equal(result.results[1].error, 'duplicate_id_in_batch');
  assert.equal(sheet.rows.length, 2);
  for (const [stored, error] of [[ID.toUpperCase(), 'duplicate_existing_subscription_id'], ['broken', 'invalid_existing_subscription_id']]) {
    const { ctx, sheet, body, row } = runtime();
    sheet.rows.push(row({}), row({ id: stored }));
    assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [body] }).error, error);
    assert.equal(sheet.writes, 0);
  }
});

test('generated UUID collisions fail without replacing a stored record', () => {
  const { ctx, sheet, body, row } = runtime();
  sheet.rows.push(row({}));
  ctx.Utilities.getUuid = () => ID;
  const { id, ...withoutId } = body;
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [withoutId] }).results[0].error, 'duplicate_generated_subscription_id');
  assert.equal(sheet.writes, 0);
});

test('locked subscriptions reject updates, bulk overwrite, restore and delete', () => {
  const { ctx, sheet, body, row } = runtime();
  sheet.rows.push(row({ record_status: 'locked' }));
  assert.equal(ctx.updateSubscription({ row_num: 2, subscription_name: 'Edited' }).error, 'record_locked');
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [body] }).results[0].error, 'record_locked');
  assert.equal(ctx.deleteSubscription({ row_num: 2 }).error, 'record_locked');
  assert.equal(ctx.restoreSubscription({ row_num: 2 }).error, 'record_locked');
  assert.equal(sheet.writes, 0);
});

test('partial update preserves unsubmitted values, catches duplicate names and clears sync metadata', () => {
  const { ctx, sheet, row, value } = runtime();
  sheet.rows.push(row({}), row({ id: OTHER_ID, subscription_name: 'Other' }));
  assert.equal(ctx.updateSubscription({ row_num: 2, subscription_name: 'Other' }).error, 'duplicate_subscription');
  assert.equal(sheet.writes, 0);
  assert.equal(ctx.updateSubscription({ row_num: 2, record_status: 'inactive' }).ok, true);
  assert.equal(value(sheet.rows[1], 'record_status'), 'inactive');
  assert.equal(value(sheet.rows[1], 'subscription_name'), 'Rent');
  assert.equal(value(sheet.rows[1], 'subscription_amount_local'), '12.005');
  assert.equal(value(sheet.rows[1], 'sync_date'), '');
  assert.equal(value(sheet.rows[1], 'sync_notes'), '');
  assert.equal(value(sheet.rows[1], 'created_at'), '2024-01-01T00:00:00Z');
});

test('delete and restore protect row bounds, clear acknowledgement and preserve source creation', () => {
  const { ctx, sheet, row, value } = runtime();
  sheet.rows.push(row({}));
  for (const row_num of [1, 3, 2.5, 'bad']) {
    assert.equal(ctx.deleteSubscription({ row_num }).error, 'invalid_row');
    assert.equal(ctx.restoreSubscription({ row_num }).error, 'invalid_row');
  }
  assert.equal(ctx.deleteSubscription({ row_num: 2 }).ok, true);
  assert.equal(ctx.deleteSubscription({ row_num: 2 }).error, 'subscription_already_deleted');
  assert.equal(ctx.updateSubscription({ row_num: 2, subscription_name: 'Edited' }).error, 'record_deleted');
  assert.equal(value(sheet.rows[1], 'sync_date'), '');
  assert.equal(ctx.restoreSubscription({ row_num: 2 }).ok, true);
  assert.equal(value(sheet.rows[1], 'record_status'), 'active');
  assert.equal(value(sheet.rows[1], 'created_at'), '2024-01-01T00:00:00Z');
});

test('weekly scheduling is timezone aware and includes today at the local date boundary', () => {
  const { ctx } = runtime();
  const instant = new Date('2026-09-27T23:30:00Z');
  assert.equal(ctx.computeNextPaymentDate('weekly', '', 7, '', '', 'Europe/London', instant), '2026-10-04');
  assert.equal(ctx.computeNextPaymentDate('weekly', '', 7, '', '', 'America/New_York', instant), '2026-09-27');
});

test('quarterly and annual schedules stay anchored to their start month across reads', () => {
  const { ctx } = runtime();
  const start = '2024-02-29 00:00:00';
  assert.equal(ctx.computeNextPaymentDate('quarterly', 31, '', start, '', 'UTC', new Date('2026-09-01Z')), '2026-11-30');
  assert.equal(ctx.computeNextPaymentDate('quarterly', 31, '', start, '', 'UTC', new Date('2026-10-01Z')), '2026-11-30');
  assert.equal(ctx.computeNextPaymentDate('annual', 29, '', start, '', 'UTC', new Date('2025-02-01Z')), '2025-02-28');
  assert.equal(ctx.computeNextPaymentDate('annual', 29, '', start, '', 'UTC', new Date('2025-03-01Z')), '2026-02-28');
  assert.equal(ctx.computeNextPaymentDate('annual', 29, '', '', '', 'UTC', new Date('2025-03-01Z')), '');
});

test('start/end boundaries include the whole local date and never return a payment outside them', () => {
  const { ctx } = runtime();
  const now = new Date('2026-09-01T12:00:00Z');
  assert.equal(ctx.computeNextPaymentDate('monthly', 1, '', '2026-10-02 12:00:00', '', 'UTC', now), '2026-11-01');
  assert.equal(ctx.computeNextPaymentDate('monthly', 31, '', '', '2026-09-30 00:00:00', 'UTC', now), '2026-09-30');
  assert.equal(ctx.computeNextPaymentDate('monthly', 31, '', '', '2026-09-29 23:59:59', 'UTC', now), '');
  assert.equal(ctx.computeNextPaymentDate('monthly', 1, '', '', '2026-08-31 00:00:00', 'UTC', now), '');
});

test('list is read-only, includes deleted rows for restore/export, and exposes schedule errors', () => {
  const { ctx, sheet, row } = runtime();
  sheet.rows.push(row({ subscription_end_date_local: '2000-01-01 00:00:00' }), row({ id: OTHER_ID, record_status: 'deleted' }), row({ id: ACCOUNT, frequency: 'annual' }));
  const before = JSON.stringify(sheet.rows);
  const subscriptions = ctx.listSubscriptions();
  assert.equal(subscriptions.length, 3);
  assert.equal(subscriptions[0].record_status, 'active');
  assert.equal(subscriptions[0].schedule_status, 'expired');
  assert.equal(subscriptions[0].next_payment_date, '');
  assert.equal(subscriptions[1].record_status, 'deleted');
  assert.equal(subscriptions[2].schedule_error, 'missing_subscription_start_date_local');
  assert.equal(sheet.writes, 0);
  assert.equal(JSON.stringify(sheet.rows), before);
});

test('manual business and lifecycle edits queue sync, including trailing date/timezone columns', () => {
  for (const field of ['id', 'subscription_name', 'record_status', 'subscription_start_date_local', 'subscription_end_date_local', 'subscription_timezone_local']) {
    const { ctx, sheet, row, value, event } = runtime();
    sheet.rows.push(row({}));
    ctx.onEdit(event(2, ctx.subColIndex(field) + 1));
    assert.equal(value(sheet.rows[1], 'sync_status'), 'update-pending', field);
    assert.equal(value(sheet.rows[1], 'sync_date'), '');
    assert.equal(value(sheet.rows[1], 'sync_notes'), '');
    assert.equal(value(sheet.rows[1], 'created_at'), '2024-01-01T00:00:00Z');
  }
});

test('large pastes queue once, preserve blank rows, and metadata edits never queue', () => {
  const { ctx, sheet, row, value, event } = runtime();
  for (let index = 0; index < 1000; index++) sheet.rows.push(index === 500 ? Array(21).fill('') : row({ sync_status: 'create-failed' }));
  ctx.markSubscriptionEditPending(event(1, 1, 1001, 21));
  assert.equal(sheet.writes, 1);
  assert.equal(value(sheet.rows[1], 'sync_status'), 'create-pending');
  assert.ok(sheet.rows[501].every(value => value === ''));
  for (const field of ['created_at', 'updated_at', 'sync_status', 'sync_notes', 'sync_date']) ctx.markSubscriptionEditPending(event(2, ctx.subColIndex(field) + 1));
  assert.equal(sheet.writes, 1);
  sheet.rows[0][1] = 'broken_header';
  assert.throws(() => ctx.markSubscriptionEditPending(event(2, 2)), /sheet_header_mismatch/);
  assert.equal(sheet.writes, 1);
});

test('client schema exports copied lifecycle and type registries plus the undated schedule default', () => {
  const { ctx } = runtime();
  const schema = ctx.getSubscriptionSchemaForClient();
  assert.deepEqual(Array.from(schema.tx_types), ['money-in', 'money-out']);
  assert.deepEqual(Array.from(schema.record_statuses), ['active', 'inactive', 'deleted', 'locked']);
  assert.equal(schema.default_timezone, 'Europe/London');
  schema.record_statuses.push('invalid');
  assert.equal(ctx.getSubscriptionSchemaForClient().record_statuses.length, 4);
});


test('new and reassigned active subscriptions require an active account while existing references survive account closure', () => {
  const { ctx, sheet, body, accounts, row } = runtime();
  accounts.rows[1][ctx.acctColIndex('record_status')] = 'inactive';
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [body] }).results[0].error, 'source_account_not_active');
  assert.equal(sheet.writes, 0);
  sheet.rows.push(row({}));
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [body] }).updated, 1);
  assert.equal(ctx.updateSubscription({ row_num: 2, subscription_name: 'Edited' }).ok, true);
  const second = accounts.rows[1].slice();
  second[ctx.acctColIndex('id')] = OTHER_ID;
  second[ctx.acctColIndex('record_status')] = 'deleted';
  accounts.rows.push(second);
  const before = sheet.writes;
  assert.equal(ctx.createSubscriptionsBulk({ subscriptions: [{ ...body, source_account: OTHER_ID }] }).results[0].error, 'source_account_not_active');
  assert.equal(ctx.updateSubscription({ row_num: 2, source_account: OTHER_ID }).error, 'source_account_not_active');
  assert.equal(sheet.writes, before);
});

test('a Sheets date cell is returned as its displayed local wall time, with audit instants in UTC', () => {
  const { ctx, sheet, row } = runtime();
  ctx.Utilities.formatDate = (date, timezone, pattern) => {
    assert.equal(timezone, 'Europe/London');
    assert.equal(pattern, 'yyyy-MM-dd HH:mm:ss.SSS');
    assert.equal(date.toISOString(), '2026-06-30T23:00:00.123Z');
    return '2026-07-01 00:00:00.123';
  };
  sheet.rows.push(row({ subscription_start_date_local: new Date('2026-06-30T23:00:00.123Z'), created_at: new Date('2024-01-01T00:00:00Z') }));
  const subscription = ctx.listSubscriptions()[0];
  assert.equal(subscription.subscription_start_date_local, '2026-07-01 00:00:00.123');
  assert.equal(subscription.created_at, '2024-01-01T00:00:00.000Z');
  assert.equal(sheet.writes, 0);
});


test('accepted timezone casing and aliases are stored as canonical IANA zone names', () => {
  const { ctx, sheet, body, value } = runtime();
  assert.equal(ctx.createSubscription({ ...body, subscription_timezone_local: 'europe/london' }).ok, true);
  assert.equal(value(sheet.rows[1], 'subscription_timezone_local'), 'Europe/London');
});

test('DST validation handles half-hour transitions, not only one-hour European changes', () => {
  const { ctx, body } = runtime();
  assert.equal(ctx.validateSubscriptionCreate({ ...body, subscription_timezone_local: 'Australia/Lord_Howe', subscription_start_date_local: '2026-10-04 02:15:00' }).error, 'nonexistent_local_time');
  assert.equal(ctx.validateSubscriptionCreate({ ...body, subscription_timezone_local: 'Australia/Lord_Howe', subscription_start_date_local: '2026-04-05 01:45:00' }).error, 'ambiguous_local_time');
  assert.equal(ctx.validateSubscriptionCreate({ ...body, subscription_timezone_local: 'Australia/Lord_Howe', subscription_start_date_local: '2026-04-05 02:00:00' }).ok, true);
});
