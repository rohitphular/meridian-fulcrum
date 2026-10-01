// Ledger / period goldens on the shared view fixture (phase 5). These values
// were verified equal to the old client replay (app/core/date-utils.js,
// insight-utils.js — deleted) by the phase 0–4 parity harness before it was
// retired; where the product decisions changed a number, the new rule is
// asserted and the old value noted in a comment.
process.env.TZ = 'Europe/London';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNTS, TRANSACTIONS, RATES } = require('./support/view-fixture.cjs');

const TODAY = '2026-09-30';
const TZ = 'Europe/London';
const { ctx } = gasRuntime();
const fx = ctx.fxContext(RATES, 'GBP');
const plain = value => JSON.parse(JSON.stringify(value));
const close = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
const quoteMap = (ledger, balances) => Object.fromEntries(Object.keys(balances).map(id => [id, ctx.fxQuoteValue(balances[id], ledger.accounts[id].currency, fx)]));
const balancesAt = (accounts, txs, dateKey) => { const ledger = ctx.ldgBuild(accounts, txs, { tz: TZ }); return quoteMap(ledger, ctx.ldgBalancesAt(ledger, dateKey)); };
const bounds = (period, today, from, to) => plain(ctx.ldgPeriodBounds(period, today, from, to));
const sumSpend = (accounts, txs, fromKey, toKey) => {
  const pairs = ctx.ldgPairLegs(txs);
  const currency = Object.fromEntries(accounts.map(a => [a.id, a.account_currency_local]));
  return txs.reduce((sum, tx) => {
    if (ctx.ldgFlowKind(tx, pairs) !== 'spend' || !ctx.ldgInRange(ctx.ldgTxDateKey(tx), fromKey, toKey)) return sum;
    const value = ctx.fxQuoteValue(tx.tx_amount_local, currency[tx.account_id], fx);
    return value === null ? sum : sum + value;
  }, 0);
};
// Accounts with a GBP / INR rate (Brokerage is USD, which has no rate).
const convertible = ACCOUNTS.filter(account => account.account_currency_local !== 'USD');
const [BANK, RUPEE, CARD, CLOSED] = [ID(11), ID(12), ID(13), ID(15)];

test('balances at a date and month-end snapshots per account (GBP)', () => {
  const expected = {
    '2026-06-30': [0, 0, -200, 999], '2026-07-01': [1000, 100, -200, 999], '2026-07-28': [3500, 100, -200, 999],
    '2026-08-31': [3454.5, 100, -200, 999], '2026-09-12': [3154.5, 100, 100, 999], '2026-09-26': [3154.5, 90, 100, 999],
    '2026-09-30': [3154.5, 90, 40, 999], '2026-10-31': [3142.5, 90, 40, 999],
  };
  for (const [dateKey, values] of Object.entries(expected)) {
    const got = balancesAt(convertible, TRANSACTIONS, dateKey);
    assert.deepEqual([got[BANK], got[RUPEE], got[CARD], got[CLOSED]], values, dateKey);
  }
  const ledger = ctx.ldgBuild(convertible, TRANSACTIONS, { tz: TZ });
  const byMonth = ctx.ldgBalanceByMonth(ledger, ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  const months = Object.fromEntries(Object.keys(byMonth).map(month => { const q = quoteMap(ledger, byMonth[month]); return [month, [q[BANK], q[RUPEE], q[CARD], q[CLOSED]]]; }));
  assert.deepEqual(months, {
    '2026-06': [0, 0, -200, 999], '2026-07': [3500, 100, -200, 999], '2026-08': [3454.5, 100, -200, 999],
    '2026-09': [3154.5, 90, 40, 999], '2026-10': [3142.5, 90, 40, 999],
  });
});

test('daily totals: a missing rate (USD) is excluded, never converted 1:1', () => {
  const totals = Array.from(ctx.ldgDailyTotals(ctx.ldgBuild(ACCOUNTS, TRANSACTIONS, { tz: TZ }), '2026-07-25', '2026-09-30', fx).totals);
  const runs = [[1899, 3], [4399, 6], [4353.5, 48], [4343.5, 9], [4283.5, 2]];
  assert.deepEqual(totals, runs.flatMap(([value, count]) => Array(count).fill(value)));
});

test('zoned movements bucket on the request-tz calendar day', () => {
  // Brokerage (America/New_York) movement at 23:30 NY on 25 Sep is 26 Sep in London.
  const brokerage = [{ ...ACCOUNTS[3], account_currency_local: 'GBP' }];
  assert.equal(balancesAt(brokerage, TRANSACTIONS, '2026-09-25')[ID(14)], 500);
  assert.equal(balancesAt(brokerage, TRANSACTIONS, '2026-09-26')[ID(14)], 525);
});

test('list ranges and insight periods are inclusive of today', () => {
  // Transaction-list ranges: identical to the old daterange.js bounds on 2026-09-30.
  const LIST_RANGES = {
    last_30: ['2026-09-01', '2026-09-30'], this_month: ['2026-09-01', '2026-09-30'], last_month: ['2026-08-01', '2026-08-31'],
    last_3: ['2026-07-01', '2026-09-30'], last_6: ['2026-04-01', '2026-09-30'], last_12: ['2025-10-01', '2026-09-30'], ytd: ['2026-01-01', '2026-09-30'],
  };
  for (const [range, expected] of Object.entries(LIST_RANGES)) assert.deepEqual([bounds(range, TODAY).from, bounds(range, TODAY).to], expected, range);
  // 'all' was 2000-01-01 on the client; the server leaves the start unbounded.
  assert.equal(bounds('all', TODAY).from, null);
  // Old insight periods: last_30 from 2026-08-31 (31 days), last_7 from 2026-09-23 → now today-29 / today-6.
  assert.equal(bounds('last_30', TODAY).from, '2026-09-01');
  assert.equal(bounds('last_7', TODAY).from, '2026-09-24');
  // last_N months / this_month used to end at month end; they now end today.
  assert.equal(bounds('last_30', '2026-09-15').from, '2026-08-17');
  assert.equal(bounds('last_3', '2026-09-15').to, '2026-09-15');
  assert.equal(bounds('this_month', '2026-09-15').to, '2026-09-15');
  // Completed calendar periods and custom ranges (unchanged from the client).
  assert.deepEqual([bounds('last_month', TODAY).from, bounds('last_month', TODAY).to], ['2026-08-01', '2026-08-31']);
  assert.deepEqual([bounds('last_quarter', TODAY).from, bounds('last_quarter', TODAY).to], ['2026-04-01', '2026-06-30']);
  assert.deepEqual([bounds('last_year', TODAY).from, bounds('last_year', TODAY).to], ['2025-01-01', '2025-12-31']);
  assert.deepEqual([bounds('custom', TODAY, '2026-09-02', '2026-09-20').from, bounds('custom', TODAY, '2026-09-02', '2026-09-20').to], ['2026-09-02', '2026-09-20']);
});

test('spending excludes deleted rows and own-account transfers (product decision)', () => {
  // Old client September money-out: deleted 20 + transfer parent 300 + INR 1050 (=10 GBP) + card 60.
  assert.ok(close(sumSpend(ACCOUNTS, TRANSACTIONS, '2026-09-01', '2026-09-30'), 10 + 60));
  // A boundary-crossing IST row buckets by its recorded date (1 Sep), not London's 31 Aug.
  const ist = { ...TRANSACTIONS[6], id: ID(90), tx_date_local: '2026-09-01 01:00:00' };
  assert.ok(close(sumSpend(ACCOUNTS, [ist], '2026-09-01', '2026-09-30'), 10));
  assert.ok(close(sumSpend(ACCOUNTS, [ist], '2026-08-01', '2026-08-31'), 0));
});

test('net worth counts every non-deleted account (Home / Insights used to count active only)', () => {
  const netWorth = accounts => { const ledger = ctx.ldgBuild(accounts, TRANSACTIONS, { tz: TZ }); return plain(ctx.ldgNetWorth(ledger, ctx.ldgCurrentBalances(ledger), fx)); };
  const worth = netWorth(ACCOUNTS);
  // Bank 3142.5 + Rupee 9450 INR (=90 GBP, inactive) + Brokerage USD (no rate, excluded); Card +40 (overpaid).
  assert.ok(close(worth.total_assets, 3142.5 + 90));
  assert.ok(close(worth.total_liabilities, -40));
  assert.ok(close(worth.net_worth, 3142.5 + 90 + 40));
  assert.deepEqual(worth.missing_currencies, ['USD']);
  assert.ok(close(netWorth(ACCOUNTS.filter(account => account.record_status === 'active')).total_assets, 3142.5));
});

test('date-only transaction dates are skipped by the replay (listAccounts rule; the old client counted them)', () => {
  const account = { id: 'd', type: 'asset', account_currency_local: 'GBP', opening_value_local: 0, tracking_start_date_local: '' };
  const rows = [{ id: 'r', account_id: 'd', tx_type: 'money-in', tx_amount_local: 8, tx_date_local: '2026-09-01' }];
  assert.equal(balancesAt([account], rows, TODAY).d, 0);
});
