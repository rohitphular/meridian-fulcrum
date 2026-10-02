// Phase 4 (P4-D): golden outputs of the net-worth / loans ports
// (insights-networth.gs: 14, 15, 16, 17, 26, 27) and the counterparty / geo /
// FX ports (insights-counterparty-geo.gs: 22, 23, 24, 25, 28) on the view
// fixture plus a loan with monthly repayments (own-account transfer legs), a
// paid-off inactive loan, a weekly payee and locations.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNT_TYPES, ACCOUNTS, CATEGORIES, TRANSACTIONS, RATES, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≠ ${expected}`);
const card = (data, key) => data.stat_cards.find(c => c.key === key);
const PORTED = ['14-networth-trend', '15-account-balances', '16-asset-vs-liability', '17-liability-paydown', '22-top-counterparties',
  '23-recurring-payments', '24-spend-by-country', '25-spend-by-city', '26-loan-progress', '27-debt-to-income', '28-forex-spend'];

const tx = (n, account, type, amount, date, extra = {}) => ({ id: ID(n), account_id: ID(account), tx_type: type, tx_amount_local: amount, tx_date_local: date,
  tx_timezone_local: 'Europe/London', major_category: 'food', minor_category: 'groceries', record_status: 'active', ...extra });
const repay = (n, account, amount, date, counterparty) => [
  tx(n, 11, 'money-out', amount, date, { major_category: 'debt-repayment', minor_category: 'loan', counterparty_name: counterparty }),
  tx(n + 1, account, 'money-in', amount, date, { parent_tx_id: ID(n), major_category: 'debt-repayment', minor_category: 'loan', counterparty_name: counterparty }),
];
const located = { UK: { user_location_country: 'UK', user_location_city: 'Brighton' }, uk: { user_location_country: 'uk', user_location_city: 'London' } };

const FIXTURE = {
  accountTypes: [...ACCOUNT_TYPES, { id: ID(4), account_type_key: 'liability', account_type_label: 'Liability', account_subtype_key: 'personal-loan', account_subtype_label: 'Personal loan', detail_sheet: 'account_liability_personal_loan', record_status: 'active' }],
  accounts: [...ACCOUNTS,
    { id: ID(16), account_name: 'Loan', type: 'liability', sub_type: 'personal-loan', account_currency_local: 'GBP', local_timezone: 'Europe/London', account_opening_date_local: '2025-01-01 00:00:00', tracking_start_date_local: '2026-07-01 00:00:00', opening_value_local: -1200, record_status: 'active' },
    { id: ID(17), account_name: 'Old loan', type: 'liability', sub_type: 'personal-loan', account_currency_local: 'GBP', local_timezone: '', account_opening_date_local: '2024-01-01 00:00:00', tracking_start_date_local: '2026-07-01 00:00:00', opening_value_local: -300, record_status: 'inactive' }],
  categories: [...CATEGORIES,
    { id: ID(28), tx_type_key: 'money-out', major_category_key: 'debt-repayment', major_category_label: 'Debt repayment', minor_category_key: 'loan', minor_category_label: 'Loan', record_status: 'active', source_account_mandatory: true, target_account_mandatory: true, is_subscription_eligible: true },
    { id: ID(29), tx_type_key: 'money-in', major_category_key: 'debt-repayment', major_category_label: 'Debt repayment', minor_category_key: 'loan', minor_category_label: 'Loan', record_status: 'active', source_account_mandatory: true, target_account_mandatory: true, is_subscription_eligible: false }],
  transactions: [
    ...TRANSACTIONS.map(row => {
      if (row.id === ID(32)) return { ...row, counterparty_name: 'Tesco', ...located.UK };
      if (row.id === ID(37)) return { ...row, counterparty_name: 'Spice Shop', user_location_country: 'India', user_location_city: 'Mumbai' };
      if (row.id === ID(39)) return { ...row, counterparty_name: 'Cafe' };
      return row;
    }),
    ...repay(50, 16, 100, '2026-07-05 10:00:00', 'Loan Co'),
    ...repay(52, 16, 100, '2026-08-05 10:00:00', 'Loan Co'),
    ...repay(54, 16, 100, '2026-09-05 10:00:00', 'Loan Co'),
    ...repay(56, 17, 300, '2026-07-20 10:00:00', 'Old Lender'),
    tx(58, 16, 'money-out', 12, '2026-08-20 10:00:00', { major_category: 'debt-finance', minor_category: 'interest', counterparty_name: 'Loan Co Interest' }),
    ...['01', '08', '15', '22'].map((day, i) => tx(60 + i, 11, 'money-out', 10, `2026-09-${day} 07:00:00`, { counterparty_name: 'Gym', ...located.uk })),
  ],
  rates: [...RATES, { currency: 'USD', rate: 100, symbol: '$', updated_at: '2026-09-30T00:00:00Z' }],
};

function appRuntime(overrides = {}) {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime, { ...FIXTURE, ...overrides });
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', ...params } }).getContent());
  runtime.insight = params => runtime.get({ action: 'get_insight', ...params });
  return runtime;
}

// ── Registry / consistency ───────────────────────────────────────────────────

test('P4-D insights are server computed; 15 and 26 have no period selector', () => {
  const registry = plain(appRuntime().ctx.insightsRegistryForClient());
  const byId = Object.fromEntries(registry.map(entry => [entry.id, entry]));
  for (const id of PORTED) assert.equal(byId[id].server, true, id);
  for (const id of ['15-account-balances', '26-loan-progress']) assert.deepEqual([byId[id].periods, byId[id].default_period], [[], null], id);
  assert.equal(byId['27-debt-to-income'].tabs.length, 2);
});

test('14 / 15 / 16 / 17 / 26 / 27 headline numbers equal list_accounts_view summary and get_home_view', () => {
  const runtime = appRuntime();
  const summary = runtime.get({ action: 'list_accounts_view' }).data.summary;
  const home = runtime.get({ action: 'get_home_view' }).data;
  assert.deepEqual([summary.total_assets, summary.total_liabilities, summary.net_worth], [3012.5, 872, 2140.5]);
  assert.deepEqual([home.hero.net_worth, home.hero.total_debt], [2140.5, 872]);
  const d14 = runtime.insight({ id: '14-networth-trend' }).data;
  const d15 = runtime.insight({ id: '15-account-balances' }).data;
  const d16 = runtime.insight({ id: '16-asset-vs-liability' }).data;
  assert.equal(card(d14, 'net_worth').value, summary.net_worth);
  assert.equal(card(d15, 'net_worth').value, summary.net_worth);
  assert.equal(card(d15, 'liabilities').value, summary.total_liabilities);
  near(card(d15, 'assets').value + card(d15, 'investments').value, summary.total_assets, '15 assets + investments');
  assert.deepEqual([card(d16, 'total_assets').value, card(d16, 'total_liabilities').value, card(d16, 'net_worth').value],
    [summary.total_assets, summary.total_liabilities, summary.net_worth]);
  assert.equal(card(runtime.insight({ id: '17-liability-paydown' }).data, 'outstanding').value, home.hero.total_debt);
  assert.equal(card(runtime.insight({ id: '26-loan-progress' }).data, 'total_debt').value, home.hero.total_debt);
  // 27 over Home's period (all months from the first flow month) = Home's DTI.
  for (const params of [{ period: 'custom' }, { period: 'custom', from: home.period.from, to: '2026-09-30' }, {}]) {
    const d27 = runtime.insight({ id: '27-debt-to-income', tab: 'accounts', ...params }).data;
    near(card(d27, 'dti_ratio').value, home.dti.ratio, '27 ratio ' + JSON.stringify(params));
    assert.equal(d27.charts[0].gauge.status, home.dti.status);
    assert.equal(card(d27, 'dti_ratio').sub, home.dti.status_label);
    assert.equal(card(d27, 'total_debt').value, home.hero.total_debt);
    near(card(d27, 'monthly_income').value, home.hero.monthly_income, '27 monthly income');
  }
});

// ── 14 ────────────────────────────────────────────────────────────────────────

test('14-networth-trend golden: month-end net worth of all non-deleted accounts, deltas from net worth now', () => {
  const runtime = appRuntime();
  const response = runtime.insight({ id: '14-networth-trend' });
  assert.deepEqual(response.warnings, []);
  const data = response.data;
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'net_worth', label: 'Net worth', value: 2140.5, format: 'money', sub: 'All accounts, now', tone: 'positive' },
    { key: 'month_change', label: 'Change this month', value: -102, format: 'money_delta', sub: 'since 31 Aug 26', tone: 'negative' },
    { key: 'year_change', label: 'vs 12 months ago', value: 2340.5, format: 'money_delta', sub: '+1170.3% vs 30 Sep 25', tone: 'positive' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels[0], chart.labels[11]], ['line', 'Oct 25', 'Sep 26']);
  // Card (no tracking start) counts from the beginning: −200 until July.
  // Inactive loans and the locked USD brokerage are included (product decision).
  assert.deepEqual(chart.datasets[0].data, [-200, -200, -200, -200, -200, -200, -200, -200, -200, 1900, 2242.5, 2152.5]);
  assert.deepEqual([chart.drill.param, chart.drill.mode, chart.drill.values[9], chart.drill.values[11]], ['date', 'panel', '2026-07-31', '2026-09-30']);
  // The 5 Oct future-dated spend is in "now" (Accounts) but not in the 30 Sep point.
  assert.deepEqual(data.notes.map(n => n.text), ['Net worth now includes future-dated transactions; the chart shows balances as of each date.']);
});

test('14-networth-trend drill: balances at the month end; untracked months are null', () => {
  const runtime = appRuntime();
  const drill = runtime.insight({ id: '14-networth-trend', drill: JSON.stringify({ date: '2026-08-31' }) }).data.drill;
  assert.deepEqual([drill.title, drill.subtitle, drill.total_quote, drill.rows], ['Account balances — 31 Aug 26', '6 accounts', 2242.5, []]);
  assert.deepEqual(drill.table.rows.map(r => [r.cells.account, r.cells.type, r.cells.native, r.cells.balance, r.tone]), [
    ['Bank', 'Asset', '£2,954.50', 2954.5, 'positive'], ['Loan', 'Liability', '−£1,012.00', -1012, 'negative'],
    ['Brokerage', 'Investment', '$500.00', 400, 'positive'], ['Card', 'Liability', '−£200.00', -200, 'negative'],
    ['Rupee', 'Asset', '₹10,500.00', 100, 'positive'], ['Old loan', 'Liability', '£0.00', 0, 'positive']]);
  assert.deepEqual(plain(drill.table.total_row.cells), { account: 'Net worth', type: '', native: '', balance: 2242.5 });
  assert.equal(runtime.insight({ id: '14-networth-trend', drill: JSON.stringify({ date: '2026-08-30' }) }).error, 'invalid_drill');
  // With every account tracked from July, earlier months are null (no fake 0).
  const accounts = FIXTURE.accounts.map(a => (a.id === ID(13) ? { ...a, tracking_start_date_local: '2026-07-01 00:00:00' } : a));
  const tracked = appRuntime({ accounts }).insight({ id: '14-networth-trend' }).data;
  assert.deepEqual(tracked.charts[0].datasets[0].data.slice(8), [null, 1900, 2242.5, 2152.5]);
  assert.deepEqual([card(tracked, 'year_change').value, card(tracked, 'year_change').sub], [null, 'Not tracked on 30 Sep 25']);
  assert.equal(tracked.charts[0].drill.values[0], '');
  assert.match(tracked.notes[0].text, /tracked from 1 Jul 26/);
  assert.equal(appRuntime({ accounts }).insight({ id: '14-networth-trend', drill: JSON.stringify({ date: '2025-10-31' }) }).error, 'invalid_drill');
});

// ── 15 / 16 ───────────────────────────────────────────────────────────────────

test('15-account-balances golden: current balances by family, liabilities as owed', () => {
  const data = appRuntime().insight({ id: '15-account-balances', period: 'last_7' }).data;
  assert.equal(data.period, null);
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub]), [
    ['assets', 2592.5, '2 accounts'], ['liabilities', 872, '3 accounts'], ['investments', 420, '1 account'], ['net_worth', 2140.5, 'Assets + investments − liabilities']]);
  assert.deepEqual(data.charts.map(c => [c.id, c.kind, c.labels, c.datasets[0].data, c.datasets[0].style]), [
    ['assets', 'hbar', ['Bank', 'Rupee'], [2502.5, 90], 'asset'],
    ['liabilities', 'hbar', ['Loan', 'Old loan', 'Card'], [912, 0, -40], 'liability'],
    ['investments', 'hbar', ['Brokerage'], [420], 'compare']]);
  // Without a USD rate the brokerage is left out and reported, never 1:1.
  const missing = appRuntime({ rates: RATES }).insight({ id: '15-account-balances' });
  assert.deepEqual(missing.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  assert.deepEqual([missing.data.charts.length, card(missing.data, 'net_worth').value], [2, 1720.5]);
});

test('16-asset-vs-liability golden: month-end assets and owed liabilities, period change', () => {
  const data = appRuntime().insight({ id: '16-asset-vs-liability' }).data;
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub]), [
    ['total_assets', 3012.5, 'Now'], ['total_liabilities', 872, 'Now'], ['net_worth', 2140.5, 'Now'], ['period_change', 2340.5, 'since 31 Oct 25']]);
  const chart = data.charts[0];
  assert.equal(chart.kind, 'area');
  assert.deepEqual(chart.datasets.map(d => [d.key, d.style, d.dashed === true, d.data.slice(8)]), [
    ['assets', 'asset', false, [0, 3200, 3454.5, 3024.5]], ['liabilities', 'liability', true, [200, 1300, 1212, 872]]]);
  const lastYear = appRuntime().insight({ id: '16-asset-vs-liability', period: 'last_year' }).data;
  assert.deepEqual([card(lastYear, 'period_change').value, lastYear.charts[0].labels.length], [0, 12]);
});

// ── 17 / 26 (repayments are own-transfer legs: ledger balances) ───────────────

test('17-liability-paydown golden: owed per liability from ledger balances, payoff projection', () => {
  const data = appRuntime().insight({ id: '17-liability-paydown' }).data;
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value]).slice(0, 2), [['outstanding', 872], ['started_with', 1700]]);
  near(card(data, 'overall_paid').value, (1 - 872 / 1700) * 100, 'overall paid');
  assert.equal(card(data, 'accounts').value, 3);
  const chart = data.charts[0];
  assert.deepEqual(chart.datasets.map(d => [d.label, d.style, d.data.slice(8)]), [
    ['Card', 'palette:0', [200, 200, 200, -40]], ['Loan', 'palette:1', [null, 1100, 1012, 912]], ['Old loan', 'palette:2', [null, 0, 0, 0]]]);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.account, r.cells.outstanding, Math.round(r.cells.paid * 1e6) / 1e6, r.cells.projection, r.tone]), [
    ['Card', -40, 100, 'Fully paid off', 'positive'],
    ['Loan', 912, 24, '~10 months (Jul 27)', undefined],
    ['Old loan', 0, 100, 'Fully paid off', 'positive']]);
  assert.equal(data.tables[0].columns.find(c => c.key === 'paid').format, 'progress');
});

test('26-loan-progress golden: balance paydown since tracking start, repayment drill from transfer legs', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '26-loan-progress' }).data;
  assert.equal(data.period, null);
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub]), [
    ['total_debt', 872, undefined], ['total_repaid', 828, 'Since tracking start'], ['monthly_burden', 144, 'Average across loans'], ['earliest_payoff', 'Loan', 'Apr 27']]);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.loan, r.cells.type, r.cells.remaining, r.cells.original, r.cells.paid, r.cells.avg_monthly, r.cells.payoff, r.tone ?? null, r.drill.value]), [
    ['Card', 'Credit card · GBP', -40, 200, 100, 0, 'Paid off', 'positive', ID(13)],
    ['Loan', 'Personal loan · GBP', 912, 1200, 24, 144, 'Apr 27 (~7 mo)', null, ID(16)],
    ['Old loan', 'Personal loan · GBP', 0, 300, 100, 0, 'Paid off', 'positive', ID(17)]]);
  const drill = runtime.insight({ id: '26-loan-progress', drill: JSON.stringify({ account: ID(16) }) }).data.drill;
  assert.deepEqual([drill.title, drill.subtitle, drill.total_count, drill.total_quote], ['Loan', '3 repayments', 3, 300]);
  assert.deepEqual(drill.rows.map(r => [r.id, r.is_transfer_leg, r.tx_type]), [[ID(55), true, 'money-in'], [ID(53), true, 'money-in'], [ID(51), true, 'money-in']]);
  assert.deepEqual([drill.charts[0].labels, drill.charts[0].datasets[0].data, drill.charts[0].ref_lines[0].value], [['5 Jul 26', '5 Aug 26', '5 Sep 26'], [100, 200, 300], 1200]);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-07-01', to: '2026-09-30', account_ids: ID(16), types: 'money-in' });
  assert.equal(runtime.insight({ id: '26-loan-progress', drill: JSON.stringify({ account: ID(11) }) }).error, 'invalid_drill');
  assert.deepEqual(appRuntime({ accounts: ACCOUNTS.filter(a => a.type !== 'liability') }).insight({ id: '26-loan-progress' }).data.empty, { text: 'No liability accounts found.' });
});

// ── 27 ────────────────────────────────────────────────────────────────────────

test('27-debt-to-income golden: both tabs share Home\'s income average; trend = month-end debt ÷ annualised income', () => {
  const runtime = appRuntime();
  const dti = runtime.insight({ id: '27-debt-to-income', tab: 'accounts' }).data;
  // Income: 2500 (Jul) + 25 USD (Sep, 20 GBP); months Jun (first flow) – Sep, Jun–Aug complete.
  assert.deepEqual(dti.stat_cards.map(c => [c.key, Math.round(c.value * 1000) / 1000, c.sub ?? null, c.tone ?? null]), [
    ['total_debt', 872, 'Owed now', 'negative'], ['monthly_income', 833.333, 'Jun 26 – Sep 26', null],
    ['annualised_income', 10000, null, null], ['dti_ratio', 8.72, 'Excellent', 'positive']]);
  assert.deepEqual(plain(dti.charts[0].gauge), { value: 8.72, max: 100, status: 'excellent', label: '8.7%', sub: 'Excellent', tone: 'positive' });
  const trend = dti.charts[1];
  assert.deepEqual([trend.labels, trend.y_format, trend.ref_lines[0].value], [['Jun 26', 'Jul 26', 'Aug 26', 'Sep 26'], 'percent', 36]);
  assert.deepEqual(trend.datasets[0].data.map(v => Math.round(v * 100) / 100), [2, 13, 12.12, 8.72]);
  const income = runtime.insight({ id: '27-debt-to-income', tab: 'transactions' }).data;
  assert.deepEqual(income.stat_cards.map(c => [c.key, Math.round(c.value * 1000) / 1000 || c.value, c.sub]), [
    ['total_income', 2520, 'Jun 26 – Sep 26'], ['avg_monthly', 833.333, '3 complete months'], ['annualised', 10000, undefined], ['peak_month', 'Jul 26', '£2,500']]);
  assert.deepEqual(income.charts[0].datasets[0].data, [0, 2500, 0, 20]);
  const none = runtime.insight({ id: '27-debt-to-income', tab: 'accounts', period: 'custom', from: '2026-01-01', to: '2026-05-31' }).data;
  assert.deepEqual([card(none, 'dti_ratio').value, none.charts[0].gauge.status, none.notes[0].text], [null, 'na', 'No income data in period — DTI unavailable.']);
});

// ── 22 ────────────────────────────────────────────────────────────────────────

test('22-top-counterparties golden: spend flows only (repayments are transfers), top_n control, drill panel', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '22-top-counterparties' }).data;
  assert.deepEqual(plain(data.controls), [{ param: 'top_n', value: 15, options: [{ value: 10, label: 'Top 10' }, { value: 15, label: 'Top 15' }, { value: 20, label: 'Top 20' }] }]);
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub ?? null]), [
    ['total', 167.5, null], ['merchants', 5, null], ['transactions', 8, null], ['top_merchant', 'Cafe', '£60']]);
  const chart = data.charts[0];
  // 'Loan Co' / 'Old Lender' repayments (own-transfer legs) are not spend.
  assert.deepEqual([chart.labels, chart.datasets[0].data], [['Cafe', 'Tesco', 'Gym', 'Loan Co Interest', 'Spice Shop'], [60, 45.5, 40, 12, 10]]);
  assert.deepEqual(chart.drill.values, ['cafe', 'tesco', 'gym', 'loan co interest', 'spice shop']);
  assert.equal(runtime.insight({ id: '22-top-counterparties', top_n: '12' }).error, 'invalid_param');
  const drilled = runtime.insight({ id: '22-top-counterparties', top_n: '10', drill: JSON.stringify({ counterparty: 'gym' }) }).data;
  assert.deepEqual(drilled.charts[0].datasets[0].point_tones, ['primary', 'primary', 'highlight', 'primary', 'primary']);
  const drill = drilled.drill;
  assert.deepEqual([drill.title, drill.total_count, drill.total_quote, drill.rows.map(r => r.id)], ['Gym', 4, 40, [ID(63), ID(62), ID(61), ID(60)]]);
  assert.deepEqual([drill.charts[0].labels, drill.charts[0].datasets[0].data], [['Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26'], [0, 0, 0, 0, 0, 40]]);
  assert.deepEqual([drill.table.columns[1].label, plain(drill.table.rows[0].cells), drill.table.rows[0].tone], ['Apr 26 – Jun 26', { current: 40, previous: 0, change: 40 }, 'negative']);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-07-01', to: '2026-09-30', types: 'money-out', counterparty: 'Gym' });
  assert.equal(runtime.insight({ id: '22-top-counterparties', drill: JSON.stringify({ counterparty: 'loan co' }) }).error, 'invalid_drill');
});

// ── 23 ────────────────────────────────────────────────────────────────────────

test('23-recurring-payments golden: repayment transfer legs and a weekly payee are detected; sort and drill', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '23-recurring-payments' }).data;
  near(card(data, 'monthly_total').value, 100 + 10 * 52 / 12, 'monthly total');
  near(card(data, 'pct_income').value, (100 + 10 * 52 / 12) / 630 * 100, 'pct of income');
  assert.equal(card(data, 'pct_income').sub, 'of £630 / month');
  assert.deepEqual([card(data, 'count').value, card(data, 'largest').value, card(data, 'largest').sub], [2, 'Loan Co', '£100.00']);
  const table = data.tables[0];
  assert.deepEqual(plain(table.sort), { col: 'amount', dir: 'desc' });
  assert.deepEqual(table.sortable, ['counterparty', 'category', 'frequency', 'amount', 'last_date']);
  assert.deepEqual(table.rows.map(r => [r.cells.counterparty, r.cells.category, r.cells.frequency, r.cells.amount, r.cells.last_date, r.drill.value]), [
    ['Loan Co', 'Debt repayment', 'Monthly', 100, '5 Sep 26', 'loan co'], ['Gym', 'Food', 'Weekly', 10, '22 Sep 26', 'gym']]);
  const byName = runtime.insight({ id: '23-recurring-payments', sort: 'counterparty', sort_dir: 'asc' }).data;
  assert.deepEqual(byName.tables[0].rows.map(r => r.key), ['gym', 'loan co']);
  assert.deepEqual(byName.charts[0].labels, ['Loan Co', 'Gym']);
  assert.equal(runtime.insight({ id: '23-recurring-payments', sort: 'bogus' }).field, 'sort');
  const drill = runtime.insight({ id: '23-recurring-payments', drill: JSON.stringify({ counterparty: 'loan co' }) }).data.drill;
  assert.deepEqual([drill.subtitle, drill.total_quote, drill.rows.map(r => r.id), drill.query], ['3 payments · Monthly', 300, [ID(54), ID(52), ID(50)], null]);
  assert.deepEqual([drill.charts[0].labels, drill.charts[0].datasets[0].data], [['Jul 26', 'Aug 26', 'Sep 26'], [100, 100, 100]]);
  // Only payees paid in the period are listed.
  assert.deepEqual(runtime.insight({ id: '23-recurring-payments', period: 'last_month' }).data.tables[0].rows.map(r => r.key), ['loan co']);
  assert.equal(runtime.insight({ id: '23-recurring-payments', period: 'last_year' }).data.empty.text, 'No recurring payments detected in this period.');
});

test('23 dates: detection uses recorded wall-date keys (never new Date on "YYYY-MM-DD HH:MM:SS")', () => {
  const { ctx } = appRuntime();
  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../api/insights-counterparty-geo.gs'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../api/insights-networth.gs'), 'utf8');
  assert.doesNotMatch(source, /new Date\(/);
  // A payment late in the evening of the 31st still counts on its recorded day.
  assert.equal(ctx.ldgDaysBetween('2026-07-31', '2026-08-31') - 1, 31);
});

// ── 24 / 25 ───────────────────────────────────────────────────────────────────

test('24-spend-by-country golden: normalised countries, Unknown last, city drill', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '24-spend-by-country' }).data;
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub ?? null]).slice(0, 3), [
    ['total', 267.5, null], ['countries', 2, null], ['top_country', 'United Kingdom', '£86']]);
  near(card(data, 'top_country_pct').value, 85.5 / 267.5 * 100, 'top country %');
  const chart = data.charts[0];
  assert.deepEqual([chart.labels, chart.datasets[0].data, chart.datasets[0].point_tones, chart.drill.values],
    [['United Kingdom', 'India', 'Unknown'], [85.5, 10, 172], ['primary', 'primary', 'muted'], ['United Kingdom', 'India', 'Unknown']]);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.place, r.cells.spend, r.cells.count, r.cells.avg, r.cells.top_category]), [
    ['United Kingdom', 85.5, 5, 17.1, 'Food'], ['India', 10, 1, 10, 'Food'], ['Unknown', 172, 3, 172 / 3, 'Food']]);
  const drill = runtime.insight({ id: '24-spend-by-country', drill: JSON.stringify({ country: 'United Kingdom' }) }).data.drill;
  assert.deepEqual([drill.title, drill.total_quote, drill.table.rows.map(r => [r.cells.city, r.cells.spend, r.cells.count])],
    ['Cities in United Kingdom', 85.5, [['Brighton', 45.5, 1], ['London', 40, 4]]]);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2025-10-01', to: '2026-09-30', types: 'money-out', user_location_country: 'UK' });
  assert.equal(runtime.insight({ id: '24-spend-by-country', drill: JSON.stringify({ country: 'France' }) }).error, 'invalid_drill');
});

test('25-spend-by-city golden: domestic from the quote currency, legend datasets, transaction drill', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '25-spend-by-city' }).data;
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub ?? null]), [
    ['total', 267.5, null], ['cities', 3, null], ['domestic', 85.5, '32%'], ['international', 10, '4%']]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels], ['stacked_hbar', ['Brighton, United Kingdom', 'London, United Kingdom', 'Mumbai, India', 'Unknown']]);
  assert.deepEqual(chart.datasets.map(d => [d.label, d.style, d.data]), [
    ['Domestic (United Kingdom)', 'primary', [45.5, 40, null, null]], ['International', 'compare', [null, null, 10, null]], ['Unknown / other', 'muted', [null, null, null, 172]]]);
  const drill = runtime.insight({ id: '25-spend-by-city', drill: JSON.stringify({ city: 'mumbai, india' }) }).data.drill;
  assert.deepEqual([drill.title, drill.rows.map(r => r.id), drill.total_quote, drill.query.params.user_location_city], ['Mumbai, India', [ID(37)], 10, 'Mumbai']);
  const inr = runtime.insight({ id: '25-spend-by-city', quote_currency: 'INR' }).data;
  assert.deepEqual([inr.charts[0].labels[0], inr.charts[0].datasets[0].label, card(inr, 'domestic').value], ['Mumbai, India', 'Domestic (India)', 1050]);
});

// ── 28 ────────────────────────────────────────────────────────────────────────

test('28-forex-spend golden: spend by account currency with native totals and quote rates', () => {
  const data = appRuntime().insight({ id: '28-forex-spend' }).data;
  assert.deepEqual(data.stat_cards.map(c => [c.key, c.value, c.sub ?? null]), [
    ['currencies', 2, null], ['domestic', 257.5, '96%'], ['foreign', 10, '4%'], ['largest_foreign', 'INR', '£10']]);
  assert.deepEqual([data.charts[0].labels, data.charts[0].datasets[0].data], [['GBP', 'INR'], [257.5, 10]]);
  assert.deepEqual(data.tables[0].columns.map(c => c.label), ['Currency', 'Native total', 'GBP equiv', 'Share', 'Txns', 'Rate']);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.currency, r.cells.native, r.cells.quote, r.cells.count, r.cells.rate]), [
    ['GBP', '£257.50', 257.5, 8, '—'], ['INR', '₹1,050.00', 10, 1, '1 INR = £0.009524']]);
  // A currency without a rate keeps its native total, flagged; never 1:1.
  const transactions = [...FIXTURE.transactions, tx(70, 14, 'money-out', 5, '2026-09-26 10:00:00', { tx_timezone_local: 'America/New_York' })];
  const missing = appRuntime({ transactions, rates: RATES }).insight({ id: '28-forex-spend' });
  assert.deepEqual(missing.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const usd = missing.data.tables[0].rows.find(r => r.key === 'USD');
  assert.deepEqual([usd.cells.quote, usd.cells.share, usd.cells.rate, usd.tone, card(missing.data, 'currencies').value], [null, null, 'Rate unavailable', 'warn', 3]);
});

test('empty states for spend insights', () => {
  const runtime = appRuntime();
  for (const id of ['22-top-counterparties', '24-spend-by-country', '25-spend-by-city', '28-forex-spend']) {
    assert.deepEqual(runtime.insight({ id, period: 'custom', from: '2026-01-01', to: '2026-01-31' }).data.empty, { text: 'No spend transactions for this period.' }, id);
  }
});
