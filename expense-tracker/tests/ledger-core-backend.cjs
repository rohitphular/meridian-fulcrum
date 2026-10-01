// ledger-core.gs: balance replay, tracking cutoffs, periods, transfer pairing.
// Numeric assertions are ported from frontend-regressions.cjs (balance parts)
// and date-utils-review.cjs so the server reproduces the client numbers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');

const { ctx } = gasRuntime({ files: ['app-config.gs', 'app-utils.gs', 'account-utils.gs', 'fx-utils.gs', 'ledger-core.gs'] });
const plain = value => JSON.parse(JSON.stringify(value));
// Client stub was toBase = GBP amount / 2 → XAU-per-unit GBP rate 2, quote XAU.
const fx = ctx.fxContext([{ currency: 'GBP', rate: 2, symbol: '£' }, { currency: 'XAU', rate: 1, symbol: '⊕' }], 'XAU');

const account = { id: 'a', type: 'asset', record_status: 'active', account_currency_local: 'GBP', opening_value_local: 100, tracking_start_date_local: '2026-09-02 12:00' };
const tx = (date, amount, extra = {}) => ({ account_id: 'a', tx_date_local: date, tx_amount_local: amount, tx_type: 'money-in', ...extra });
// Same fixture as frontend-regressions.cjs, with seconds: server transaction dates
// use strict localDateTimeKey (as _buildAccountNetMap / listAccounts do).
const txs = [tx('2026-09-01 10:00:00', 200), tx('2026-09-02 11:59:00', 300), tx('2026-09-02 12:00:00', 20),
  tx('2026-09-03 10:00:00', 10, { tx_type: 'money-out' }), tx('bad', 900), tx('2026-09-03 00:00:00', 900, { record_status: 'deleted' }), tx('2026-09-03 00:00:00', 'bad')];

test('tracking-aware daily totals, balances at a date and by month match the client replay', () => {
  const ledger = ctx.ldgBuild([account], txs, { tz: 'Europe/London' });
  assert.deepEqual(plain(ctx.ldgDailyTotals(ledger, '2026-09-01', '2026-09-03', fx).totals), [0, 60, 55]);
  assert.equal(ctx.fxToQuote(ctx.ldgBalancesAt(ledger, '2026-09-03').a, 'GBP', fx.rate_map, 'XAU'), 55);
  const byMonth = ctx.ldgBalanceByMonth(ledger, ['2026-09', '2026-08']);
  assert.equal(ctx.fxToQuote(byMonth['2026-09'].a, 'GBP', fx.rate_map, 'XAU'), 55);
  assert.equal(byMonth['2026-08'].a, 0);
  const untracked = ctx.ldgBuild([{ ...account, tracking_start_date_local: '' }], [tx('2026-09-01 00:00:00', 20)], { tz: 'Europe/London' });
  assert.equal(ctx.fxToQuote(ctx.ldgBalancesAt(untracked, '2026-09-03').a, 'GBP', fx.rate_map, 'XAU'), 60);
});

test('current balance follows _buildAccountNetMap: every eligible movement, future rows included', () => {
  const ledger = ctx.ldgBuild([account], [...txs, tx('2027-01-01 00:00:00', 5)], { tz: 'Europe/London' });
  assert.equal(ctx.ldgCurrentBalances(ledger).a, 100 + 20 - 10 + 5);
  // Date-only / minute-only transaction dates are skipped (strict seconds rule).
  const strict = ctx.ldgBuild([{ ...account, tracking_start_date_local: '' }], [tx('2026-09-01', 20), tx('2026-09-01 10:00', 20)], {});
  assert.equal(ctx.ldgCurrentBalances(strict).a, 100);
  const invalid = ctx.ldgBuild([{ ...account, tracking_start_date_local: 'not a date' }], txs, {});
  assert.deepEqual(plain(invalid.invalid_account_ids), ['a']);
});

test('row timezones resolve independently of the server zone, including fractional seconds', () => {
  const instant = (value, zone) => ctx._ldgWallInstant(ctx.localDateTimeKey(value), zone);
  assert.equal(instant('2026-09-25 04:30:00', 'Asia/Kolkata'), Date.parse('2026-09-24T23:00:00Z'));
  assert.equal(instant('2026-09-25 00:00:00', 'Europe/London'), Date.parse('2026-09-24T23:00:00Z'));
  assert.equal(instant('2026-09-25 00:00:00.123456', 'UTC'), Date.parse('2026-09-25T00:00:00Z') + 123.456);
});

test('invalid calendars, offsets, invalid zones, DST gaps and folds remain unavailable', () => {
  for (const value of ['2026-02-30 00:00:00', '2026-09-25T24:00:00', '2026-09-25T00:00:00Z']) assert.equal(ctx.localDateTimeKey(value), null, value);
  for (const [value, zone] of [['2026-09-25 00:00:00', '+05:30'], ['2026-09-25 00:00:00', 'Unknown/Zone'],
    ['2026-03-29 01:30:00', 'Europe/London'], ['2026-10-25 01:30:00', 'Europe/London'],
    ['2026-04-05 01:45:00', 'Australia/Lord_Howe'], ['2026-10-04 02:15:00', 'Australia/Lord_Howe']]) {
    assert.ok(Number.isNaN(ctx._ldgWallInstant(ctx.localDateTimeKey(value), zone)), value + ' ' + zone);
  }
});

test('travel movements before a zoned snapshot do not double-count its opening balance', () => {
  const zoned = { id: 'account', type: 'asset', local_timezone: 'Europe/London', tracking_start_date_local: '2026-09-25 00:00:00', opening_value_local: 100, account_currency_local: 'GBP' };
  const before = { account_id: 'account', tx_date_local: '2026-09-25 03:30:00', tx_timezone_local: 'Asia/Kolkata', tx_amount_local: 40, tx_type: 'money-in', record_status: 'active' };
  const at = { ...before, tx_date_local: '2026-09-25 04:30:00', tx_amount_local: 10 };
  const ledger = ctx.ldgBuild([zoned], [before, at], { tz: 'Europe/London' });
  assert.equal(ctx.ldgBalancesAt(ledger, '2026-09-30').account, 110);
  assert.equal(ctx.ldgCurrentBalances(ledger).account, 110);
  const reverse = { ...before, tx_date_local: '2026-09-24 19:30:00', tx_timezone_local: 'America/New_York' };
  assert.equal(ctx.ldgCurrentBalances(ctx.ldgBuild([zoned], [reverse], {})).account, 140);
});

test('microsecond snapshot boundaries and legacy blank zones keep their intended behaviour', () => {
  const base = { id: 'm', type: 'asset', opening_value_local: 0, account_currency_local: 'GBP' };
  const move = (date, zone) => ({ account_id: 'm', tx_date_local: date, tx_timezone_local: zone, tx_type: 'money-in', tx_amount_local: 1 });
  const micro = { ...base, local_timezone: 'UTC', tracking_start_date_local: '2026-09-25 00:00:00.123456' };
  assert.equal(ctx.ldgCurrentBalances(ctx.ldgBuild([micro], [move('2026-09-25 00:00:00.123455', 'UTC')], {})).m, 0);
  assert.equal(ctx.ldgCurrentBalances(ctx.ldgBuild([micro], [move('2026-09-25 00:00:00.123456', 'UTC')], {})).m, 1);
  const legacy = { ...base, tracking_start_date_local: '2026-09-25 00:00:00' };
  assert.equal(ctx.ldgCurrentBalances(ctx.ldgBuild([legacy], [move('2026-09-24 23:59:59', 'America/New_York')], {})).m, 0);
  assert.equal(ctx.ldgAccountCutoff({}).cutoff, null);
  assert.equal(ctx.ldgCurrentBalances(ctx.ldgBuild([{ ...base, local_timezone: 'UTC' }], [move('2026-09-25 00:00:00', '')], {})).m, 1);
});

test('legacy blank-zone cutoffs compare wall times without DST normalisation', () => {
  const legacy = { id: 'legacy', type: 'asset', tracking_start_date_local: '2026-03-08 03:00:00', opening_value_local: 100, account_currency_local: 'GBP' };
  const before = { account_id: 'legacy', tx_date_local: '2026-03-08 02:30:00', tx_timezone_local: 'Europe/London', tx_type: 'money-in', tx_amount_local: 40, record_status: 'active' };
  const at = { ...before, tx_date_local: '2026-03-08 03:00:00', tx_amount_local: 10 };
  const ledger = ctx.ldgBuild([legacy], [before, at], { tz: 'America/New_York' });
  assert.equal(ctx.ldgBalancesAt(ledger, '2026-03-09').legacy, 110);
  assert.equal(ctx.ldgBalancesAt(ledger, '2026-03-07').legacy, 0);
});

test('zoned snapshots bucket by the request tz calendar date', () => {
  const zoned = { id: 'z', type: 'asset', local_timezone: 'Europe/London', tracking_start_date_local: '', opening_value_local: 0, account_currency_local: 'GBP' };
  const late = { account_id: 'z', tx_date_local: '2026-09-25 23:30:00', tx_timezone_local: 'Europe/London', tx_type: 'money-in', tx_amount_local: 5 };
  assert.equal(ctx.ldgBalancesAt(ctx.ldgBuild([zoned], [late], { tz: 'Europe/London' }), '2026-09-25').z, 5);
  assert.equal(ctx.ldgBalancesAt(ctx.ldgBuild([zoned], [late], { tz: 'Asia/Kolkata' }), '2026-09-25').z, 0);
  assert.equal(ctx.ldgBalancesAt(ctx.ldgBuild([zoned], [late], { tz: 'Asia/Kolkata' }), '2026-09-26').z, 5);
});

test('periods are inclusive of today and calendar aligned', () => {
  const p = (period, from, to) => plain(ctx.ldgPeriodBounds(period, '2026-09-30', from, to));
  assert.deepEqual([p('last_30').from, p('last_30').to, p('last_30').days], ['2026-09-01', '2026-09-30', 30]);
  assert.deepEqual([p('last_30').compare_from, p('last_30').compare_to], ['2026-08-02', '2026-08-31']);
  assert.deepEqual([p('last_7').from, p('last_7').to], ['2026-09-24', '2026-09-30']);
  assert.deepEqual([p('last_3').from, p('last_3').to, p('last_3').compare_from, p('last_3').compare_to], ['2026-07-01', '2026-09-30', '2026-04-01', '2026-06-30']);
  assert.deepEqual([p('last_12').from, p('last_12').to], ['2025-10-01', '2026-09-30']);
  assert.deepEqual([p('this_month').from, p('this_month').to, p('this_month').compare_from, p('this_month').compare_to], ['2026-09-01', '2026-09-30', '2026-08-01', '2026-08-30']);
  assert.deepEqual([p('last_month').from, p('last_month').to, p('last_month').compare_from, p('last_month').compare_to], ['2026-08-01', '2026-08-31', '2026-07-01', '2026-07-31']);
  assert.deepEqual([p('this_week').from, p('this_week').to, p('this_week').compare_from, p('this_week').compare_to], ['2026-09-28', '2026-09-30', '2026-09-21', '2026-09-23']);
  assert.deepEqual([p('last_week').from, p('last_week').to], ['2026-09-21', '2026-09-27']);
  assert.deepEqual([p('this_quarter').from, p('this_quarter').to, p('this_quarter').compare_from, p('this_quarter').compare_to], ['2026-07-01', '2026-09-30', '2026-04-01', '2026-06-30']);
  assert.deepEqual([p('last_quarter').from, p('last_quarter').to], ['2026-04-01', '2026-06-30']);
  assert.deepEqual([p('ytd').from, p('ytd').to, p('ytd').compare_from, p('ytd').compare_to], ['2026-01-01', '2026-09-30', '2025-01-01', '2025-09-30']);
  assert.deepEqual([p('last_year').from, p('last_year').to], ['2025-01-01', '2025-12-31']);
  assert.deepEqual([p('all').from, p('all').to, p('all').compare_from], [null, '2026-09-30', null]);
  assert.deepEqual([p('custom', '2026-09-10', '').from, p('custom', '2026-09-10', '').to], ['2026-09-10', '2026-09-30']);
  assert.equal(ctx.ldgPeriodBounds('custom', '2026-09-30', '2026-09-31', ''), null);
  assert.equal(ctx.ldgPeriodBounds('custom', '2026-09-30', '2026-09-20', '2026-09-10'), null);
  assert.equal(ctx.ldgPeriodBounds('fortnight', '2026-09-30'), null);
  // Leap-year / month-end arithmetic on date keys, independent of process TZ.
  assert.deepEqual(plain(ctx.ldgPeriodBounds('this_month', '2024-03-31')).compare_to, '2024-02-29');
  assert.deepEqual(plain(ctx.ldgMonthKeys('2025-11-15', '2026-02-01')), ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('period filters use the recorded wall date; the zoned variant re-expresses the instant in tz', () => {
  // Boundary-crossing row: 01:00 IST on 1 Sep is 20:30 on 31 Aug in London.
  const ist = { tx_date_local: '2026-09-01 01:00:00', tx_timezone_local: 'Asia/Kolkata' };
  assert.equal(ctx.ldgTxDateKey(ist), '2026-09-01');
  assert.equal(ctx.ldgInRange(ctx.ldgTxDateKey(ist), '2026-09-01', '2026-09-30'), true, 'a row shown as 1 Sep is in September');
  assert.equal(ctx.ldgTxZonedDateKey(ist, 'Europe/London'), '2026-08-31');
  assert.equal(ctx.ldgTxZonedDateKey(ist, 'Asia/Kolkata'), '2026-09-01');
  assert.equal(ctx.ldgTxZonedDateKey({ tx_date_local: '2026-09-25 03:30:00', tx_timezone_local: '' }, 'Europe/London'), '2026-09-25');
  assert.equal(ctx.ldgTxZonedDateKey({ tx_date_local: '2026-03-29 01:30:00', tx_timezone_local: 'Europe/London' }, 'UTC'), '2026-03-29');
  assert.equal(ctx.ldgTxDateKey({ tx_date_local: '2026-09-25', tx_timezone_local: '' }), null);
  assert.equal(ctx.ldgInRange(null, '2026-09-01', '2026-09-30'), false);
  assert.equal(ctx.ldgInRange('2026-09-01', null, '2026-09-30'), true);
});

test('transfer pairing: flows exclude deleted rows and own-account transfers, balances keep transfer legs', () => {
  const rows = [
    { id: 'P1', tx_type: 'money-out', record_status: 'active' },
    { id: 'c1', parent_tx_id: 'p1', tx_type: 'money-in', record_status: 'active' },
    { id: 'p2', tx_type: 'money-out', record_status: 'active' },
    { id: 'c2', parent_tx_id: 'p2', tx_type: 'money-in', record_status: 'deleted' },
    { id: 'p3', tx_type: 'money-out', record_status: 'deleted' },
    { id: 'c3', parent_tx_id: 'p3', tx_type: 'money-in', record_status: 'active' },
    { id: 'x', tx_type: 'money-in', record_status: 'active' },
    { id: 'y', tx_type: 'money-out', record_status: 'deleted' },
  ];
  const pairs = ctx.ldgPairLegs(rows);
  const kinds = Object.fromEntries(rows.map(row => [row.id, ctx.ldgFlowKind(row, pairs)]));
  assert.deepEqual(kinds, { P1: null, c1: null, p2: 'spend', c2: null, p3: null, c3: null, x: 'income', y: null });
  assert.equal(ctx.ldgSibling(rows[0], pairs).id, 'c1');
  assert.equal(ctx.ldgSibling(rows[1], pairs).id, 'P1');
  // A deleted child never hides a live leg.
  const replaced = ctx.ldgPairLegs([rows[2], rows[3], { id: 'c2b', parent_tx_id: 'p2', record_status: 'active' }]);
  assert.equal(ctx.ldgSibling(rows[2], replaced).id, 'c2b');
  // Balance replay still moves both transfer legs.
  const accounts = [{ id: 'a', type: 'asset', opening_value_local: 0, account_currency_local: 'GBP' }, { id: 'b', type: 'asset', opening_value_local: 0, account_currency_local: 'GBP' }];
  const legs = [{ id: 'p', account_id: 'a', tx_type: 'money-out', tx_amount_local: 10, tx_date_local: '2026-09-01 00:00:00' },
    { id: 'c', parent_tx_id: 'p', account_id: 'b', tx_type: 'money-in', tx_amount_local: 10, tx_date_local: '2026-09-01 00:00:00' }];
  assert.deepEqual(plain(ctx.ldgCurrentBalances(ctx.ldgBuild(accounts, legs, {}))), { a: -10, b: 10 });
});

test('net worth counts all non-deleted accounts and never converts a missing rate 1:1', () => {
  const accounts = [
    { id: 'cash', type: 'asset', record_status: 'active', account_currency_local: 'GBP', opening_value_local: 100 },
    { id: 'old', type: 'asset', record_status: 'inactive', account_currency_local: 'GBP', opening_value_local: 50 },
    { id: 'isa', type: 'investment', record_status: 'locked', account_currency_local: 'GBP', opening_value_local: 30 },
    { id: 'card', type: 'liability', record_status: 'active', account_currency_local: 'GBP', opening_value_local: -40 },
    { id: 'gone', type: 'asset', record_status: 'deleted', account_currency_local: 'GBP', opening_value_local: 1000 },
    { id: 'inr', type: 'asset', record_status: 'active', account_currency_local: 'INR', opening_value_local: 999 },
  ];
  const gbp = ctx.fxContext([{ currency: 'GBP', rate: 80 }, { currency: 'XAU', rate: 1 }], 'GBP');
  const ledger = ctx.ldgBuild(accounts, [], {});
  const worth = plain(ctx.ldgNetWorth(ledger, ctx.ldgCurrentBalances(ledger), gbp));
  assert.deepEqual(worth, { total_assets: 180, total_liabilities: 40, net_worth: 140, missing_currencies: ['INR'] });
});
