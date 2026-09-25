const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = path.resolve(__dirname, '../app');
const context = vm.createContext({ toBase: amount => amount, state: {} });
for (const file of ['core/date-utils.js', 'sections/insights/insight-utils.js']) {
  const source = fs.readFileSync(path.join(app, file), 'utf8')
    .replace(/^import .*;\s*$/gm, '').replace(/\bexport (?=function|const|let)/g, '');
  vm.runInContext(source, context);
}

test('row timezones resolve independently of the browser zone, including fractional seconds', () => {
  assert.equal(context.localDateTimeInstant('2026-09-25 04:30:00', 'Asia/Kolkata'), Date.parse('2026-09-24T23:00:00Z'));
  assert.equal(context.localDateTimeInstant('2026-09-25 00:00:00', 'Europe/London'), Date.parse('2026-09-24T23:00:00Z'));
  assert.equal(context.localDateTimeInstant('2026-09-25 00:00:00.123456', 'UTC'), Date.parse('2026-09-25T00:00:00Z') + 123.456);
});

test('invalid calendars, numeric offsets, invalid zones, DST gaps and folds remain unavailable', () => {
  for (const [value, zone] of [
    ['2026-02-30', 'UTC'], ['2026-09-25T24:00:00', 'UTC'], ['2026-09-25T00:00:00Z', 'UTC'],
    ['2026-09-25', '+05:30'], ['2026-09-25', 'Unknown/Zone'],
    ['2026-03-29 01:30:00', 'Europe/London'], ['2026-10-25 01:30:00', 'Europe/London'],
    ['2026-04-05 01:45:00', 'Australia/Lord_Howe'], ['2026-10-04 02:15:00', 'Australia/Lord_Howe'],
  ]) {
    assert.ok(Number.isNaN(context.localDateTimeInstant(value, zone)), value + ' ' + zone);
  }
});

test('travel movements before a snapshot do not double-count its opening balance', () => {
  const account = { id: 'account', local_timezone: 'Europe/London', tracking_start_date_local: '2026-09-25 00:00:00', opening_value_local: 100, account_currency_local: 'GBP' };
  const before = { account_id: 'account', tx_date_local: '2026-09-25 03:30:00', tx_timezone_local: 'Asia/Kolkata', tx_amount_local: 40, tx_type: 'money-in', record_status: 'active' };
  const at = { ...before, tx_date_local: '2026-09-25 04:30:00', tx_amount_local: 10 };
  assert.equal(context.balanceMovementAffectsSnapshot(account, before), false);
  assert.equal(context.balanceMovementAffectsSnapshot(account, at), true);
  assert.equal(context.computeBalancesAt([account], [before, at], new Date(2026, 8, 30)).get('account'), 110);
  const reverse = { ...before, tx_date_local: '2026-09-24 19:30:00', tx_timezone_local: 'America/New_York' };
  assert.equal(context.balanceMovementAffectsSnapshot(account, reverse), true);
});

test('microsecond snapshot boundaries and legacy blank zones keep their intended behavior', () => {
  const account = { local_timezone: 'UTC', tracking_start_date_local: '2026-09-25 00:00:00.123456' };
  assert.equal(context.balanceMovementAffectsSnapshot(account, { tx_timezone_local: 'UTC', tx_date_local: '2026-09-25 00:00:00.123455' }), false);
  assert.equal(context.balanceMovementAffectsSnapshot(account, { tx_timezone_local: 'UTC', tx_date_local: '2026-09-25 00:00:00.123456' }), true);
  const legacy = { tracking_start_date_local: '2026-09-25 00:00:00' };
  assert.equal(context.balanceMovementAffectsSnapshot(legacy, { tx_date_local: '2026-09-24 23:59:59', tx_timezone_local: 'America/New_York' }), false);
  assert.equal(context.accountSnapshotInstant({}), -Infinity);
  assert.equal(context.balanceMovementAffectsSnapshot({ local_timezone: 'UTC' }, { tx_date_local: '2026-09-25 00:00:00' }), true);
});

test('legacy blank-zone cutoffs compare wall times without device DST normalization', () => {
  const account = { id: 'legacy', tracking_start_date_local: '2026-03-08 03:00:00', opening_value_local: 100, account_currency_local: 'GBP' };
  const before = { account_id: 'legacy', tx_date_local: '2026-03-08 02:30:00', tx_timezone_local: 'Europe/London', tx_type: 'money-in', tx_amount_local: 40, record_status: 'active' };
  const at = { ...before, tx_date_local: '2026-03-08 03:00:00', tx_amount_local: 10 };
  assert.equal(context.balanceMovementAffectsSnapshot(account, before), false);
  assert.equal(context.balanceMovementAffectsSnapshot(account, at), true);
  assert.equal(context.computeBalancesAt([account], [before, at], new Date(2026, 2, 9)).get('legacy'), 110);
});
