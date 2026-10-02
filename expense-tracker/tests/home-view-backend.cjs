// Phase 4 (P4-A): get_home_view — hero, income trend, DTI status and debt-free
// projection computed on the server with the product decisions (net worth over
// all non-deleted accounts, flows exclude deleted rows and own transfers,
// periods inclusive of today).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNTS, TRANSACTIONS, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

function appRuntime(overrides) {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime, overrides);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', ...params } }).getContent());
  return runtime;
}

// Fixture (GBP 80 / INR 8400 per XAU, no USD rate): income 2500 on 28 Jul;
// spend 100 (15 Jun), 45.5 (3 Aug), 1050 INR = 10 GBP (20 Sep), 60 (29 Sep);
// deleted 20 (10 Sep); own transfer 300 Bank → Card (12 Sep); USD income 25
// (no rate); future-dated 12 (5 Oct).
test('get_home_view: all-time months, complete-month income average, flows without deleted rows or transfers', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_home_view' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const data = response.data;
  assert.equal(data.has_data, true);
  assert.deepEqual(plain(data.period), { key: 'all', label: 'All time', from: '2026-06-01', to: '2026-09-30', months: 4, complete_months: 3 });
  const chart = data.income.chart;
  assert.deepEqual(chart.month_keys, ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(chart.labels, ['Jun 26', 'Jul 26', 'Aug 26', 'Sep 26']);
  // September: the transfer child (money-in 300 on Card) is not income; the
  // deleted 20 and the transfer parent (money-out 300) are not spend.
  assert.deepEqual(chart.income, [0, 2500, 0, 0]);
  assert.deepEqual(chart.expense, [100, 0, 45.5, 70]);
  assert.equal(chart.peak_index, 1);
  assert.deepEqual(plain(data.income.peak), { month_key: '2026-07', label: 'Jul 26', value: 2500 });
  assert.equal(data.income.total, 2500);
  // Average over complete months (Jun–Aug); the current month is excluded.
  assert.ok(Math.abs(data.income.monthly_avg - 2500 / 3) < 1e-9);
  assert.ok(Math.abs(data.income.annualised - 10000) < 1e-9);
});

test('get_home_view: net worth equals the list_accounts_view summary (all non-deleted accounts)', () => {
  const runtime = appRuntime();
  const hero = runtime.get({ action: 'get_home_view' }).data.hero;
  const summary = runtime.get({ action: 'list_accounts_view' }).data.summary;
  assert.deepEqual([hero.total_assets, hero.total_liabilities, hero.net_worth], [summary.total_assets, summary.total_liabilities, summary.net_worth]);
  // Inactive Rupee (90 GBP) counts; deleted Closed does not; Card is in credit (+40)
  // so total_liabilities is −40 and total debt clamps to 0.
  assert.deepEqual([hero.total_assets, hero.total_liabilities, hero.net_worth, hero.total_debt], [3232.5, -40, 3272.5, 0]);
  const data = runtime.get({ action: 'get_home_view' }).data;
  assert.deepEqual(plain(data.dti), { ratio: 0, gauge_value: 0, status: 'debt_free', status_label: 'Debt-free', has_income: true });
  assert.deepEqual(plain(data.debt_free), { months: 0, monthly_reduction: 0, is_debt_free: true });
});

test('get_home_view: DTI status and debt-free projection with an owed liability (transfer legs move balances)', () => {
  const accounts = ACCOUNTS.map(account => (account.id === ID(13) ? { ...account, opening_value_local: -2000 } : account));
  const runtime = appRuntime({ accounts });
  const data = runtime.get({ action: 'get_home_view' }).data;
  // Card: −2000 + 300 (transfer in) − 60 = −1760 owed.
  assert.equal(data.hero.total_debt, 1760);
  assert.equal(data.hero.total_liabilities, 1760);
  assert.equal(data.hero.net_worth, 3232.5 - 1760);
  assert.ok(Math.abs(data.dti.ratio - 17.6) < 1e-9);
  assert.deepEqual([data.dti.status, data.dti.status_label, data.dti.has_income], ['excellent', 'Excellent', true]);
  assert.ok(Math.abs(data.dti.gauge_value - 17.6) < 1e-9);
  // Debt at 1 Jun = 2000; reduction (2000 − 1760) / 4 months = 60 → ceil(1760 / 60) = 30.
  assert.deepEqual(plain(data.debt_free), { months: 30, monthly_reduction: 60, is_debt_free: false });
});

test('get_home_view: no income → DTI n/a; no data → has_data false', () => {
  const spendOnly = TRANSACTIONS.filter(tx => tx.tx_type === 'money-out');
  const accounts = ACCOUNTS.map(account => (account.id === ID(13) ? { ...account, opening_value_local: -500 } : account));
  const data = appRuntime({ accounts, transactions: spendOnly }).get({ action: 'get_home_view' }).data;
  assert.deepEqual(plain(data.dti), { ratio: null, gauge_value: 0, status: 'na', status_label: 'N/A', has_income: false });
  assert.equal(data.hero.monthly_income, 0);
  const empty = appRuntime({ accounts: [], transactions: [] }).get({ action: 'get_home_view' }).data;
  assert.equal(empty.has_data, false);
  assert.deepEqual(plain(empty.period), { key: 'all', label: 'All time', from: '2026-01-01', to: '2026-09-30', months: 9, complete_months: 8 });
  assert.equal(empty.income.total, 0);
});

test('DTI thresholds live on the server only', () => {
  const { ctx } = gasRuntime();
  assert.deepEqual([[null, 0], [0, 0], [19.9, 1], [20, 1], [35.9, 1], [36, 1], [49.9, 1], [50, 1], [150, 1]].map(([ratio, debt]) => ctx.vwHomeDtiStatus(ratio, debt)),
    ['na', 'debt_free', 'excellent', 'good', 'good', 'caution', 'caution', 'high_risk', 'high_risk']);
});

test('get_home_view converts to the requested quote currency and reads each sheet once', () => {
  const runtime = appRuntime();
  const before = runtime.tabs.transactions.reads;
  const inr = runtime.get({ action: 'get_home_view', quote_currency: 'INR' });
  assert.equal(runtime.tabs.transactions.reads - before, 1);
  assert.deepEqual(inr.quote, { currency: 'INR', symbol: '₹', rate_available: true });
  assert.deepEqual(inr.data.income.chart.income, [0, 2500 * 105, 0, 0]);
  assert.equal(inr.data.hero.net_worth, 3272.5 * 105);
});
