// ledger-core.gs: periods, wall-date filters and transfer pairing (what the
// Transactions list and input validation still use; reports are computed by
// the analytics job).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');

const { ctx } = gasRuntime({ files: ['app-config.gs', 'app-utils.gs', 'account-utils.gs', 'fx-utils.gs', 'ledger-core.gs'] });
const plain = value => JSON.parse(JSON.stringify(value));

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
});

test('period filters use the recorded wall date', () => {
  // Boundary-crossing row: 01:00 IST on 1 Sep is 20:30 on 31 Aug in London.
  const ist = { tx_date_local: '2026-09-01 01:00:00', tx_timezone_local: 'Asia/Kolkata' };
  assert.equal(ctx.ldgTxDateKey(ist), '2026-09-01');
  assert.equal(ctx.ldgInRange(ctx.ldgTxDateKey(ist), '2026-09-01', '2026-09-30'), true, 'a row shown as 1 Sep is in September');
  assert.equal(ctx.ldgTxDateKey({ tx_date_local: '2026-09-25', tx_timezone_local: '' }), null);
  assert.equal(ctx.ldgInRange(null, '2026-09-01', '2026-09-30'), false);
  assert.equal(ctx.ldgInRange('2026-09-01', null, '2026-09-30'), true);
});

test('transfer pairing: the live sibling of each leg; a deleted child never hides a live leg', () => {
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
  assert.equal(ctx.ldgSibling(rows[0], pairs).id, 'c1');
  assert.equal(ctx.ldgSibling(rows[1], pairs).id, 'P1');
  // A deleted child never hides a live leg.
  const replaced = ctx.ldgPairLegs([rows[2], rows[3], { id: 'c2b', parent_tx_id: 'p2', record_status: 'active' }]);
  assert.equal(ctx.ldgSibling(rows[2], replaced).id, 'c2b');
});
