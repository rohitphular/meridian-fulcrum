// Phase 4 (P4-B): golden outputs of the server ports of the cash-flow and
// spending-comparison insights (00-07, 19-21) on the shared view fixture.
// Flows exclude deleted rows (tx 34) and own-account transfers (35/36); the
// USD income (38) has no rate and is reported; 1050 INR = 10 GBP; the
// 5 Oct row is future-dated. Extra rows: 70 GBP income on 27 Sep from
// 'Acme Ltd' and two 2025 spends (for the year-on-year comparisons).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, TRANSACTIONS, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const round = value => (typeof value === 'number' ? Math.round(value * 10000) / 10000 : value);
const cards = data => data.stat_cards.map(card => [card.label, round(card.value), card.sub ?? null, card.tone ?? null]);
const series = chart => chart.datasets.map(dataset => [dataset.label, dataset.style, dataset.data.map(v => (Array.isArray(v) ? v.map(round) : round(v)))]);
const USD = [{ code: 'missing_rate', currencies: ['USD'] }];
const PORTED = ['00-earn-burn-rate', '01-mom-cumulative', '02-yoy-monthly', '03-wow-daily', '04-qtd-comparison', '05-ytd-comparison',
  '06-last-12-months', '07-last-8-weeks', '19-cashflow-waterfall', '20-savings-rate', '21-income-sources'];

const EXTRA = [...TRANSACTIONS,
  { ...TRANSACTIONS[0], id: ID(43), tx_amount_local: 70, tx_date_local: '2026-09-27 10:00:00', counterparty_name: 'Acme Ltd' },
  { ...TRANSACTIONS[1], id: ID(44), tx_amount_local: 30, tx_date_local: '2025-09-10 12:00:00' },
  { ...TRANSACTIONS[1], id: ID(45), tx_amount_local: 20, tx_date_local: '2025-02-14 12:00:00' }];

// Fresh runtime per call: get_insight responses are cached per params.
function insight(params, overrides) {
  const runtime = gasRuntime({ properties: { PIN_SECRET: '1234' } });
  seedViewFixture(runtime, { transactions: EXTRA, ...(overrides || {}) });
  return JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', action: 'get_insight', ...params } }).getContent());
}
const data = params => { const response = insight(params); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
const days = (count, fn) => Array.from({ length: count }, (_, i) => fn(i + 1));

test('registry: the P4-B insights are server-computed; 21 has By source / By category / Trend tabs', () => {
  const { ctx } = gasRuntime();
  const registry = plain(ctx.insightsRegistryForClient());
  for (const id of PORTED) assert.equal(registry.find(entry => entry.id === id).server, true, id);
  assert.deepEqual(registry.find(entry => entry.id === '21-income-sources').tabs.map(tab => tab.key), ['source', 'category', 'trend']);
  assert.deepEqual(registry.find(entry => entry.id === '01-mom-cumulative').tabs.map(tab => tab.key), ['transactions', 'accounts']);
  const root = path.resolve(__dirname, '..');
  for (const id of PORTED) assert.ok(!fs.existsSync(path.join(root, `app/sections/insights/${id}.js`)), id + ' client module deleted');
  assert.equal(ctx._insCmpIsoWeekLabel('2026-12-31'), 'W53 2026');
  assert.equal(ctx._insCmpIsoWeekLabel('2027-01-01'), 'W53 2026');
  assert.equal(ctx._insCmpIsoWeekLabel('2024-12-30'), 'W01 2025');
  assert.equal(ctx._insCmpShiftYear('2024-02-29', 1), '2025-02-28');
});

// ── 00 ────────────────────────────────────────────────────────────────────────

test('00-earn-burn-rate golden: trailing-window rates per day, window control, missing rate', () => {
  const response = insight({ id: '00-earn-burn-rate', period: 'custom', from: '2026-09-26', to: '2026-09-30', window: '7' });
  assert.deepEqual(response.warnings, USD);
  const d = response.data;
  assert.deepEqual(plain(d.controls), [{ param: 'window', value: 7, options: [7, 14, 30, 90].map(v => ({ value: v, label: v + 'd' })) }]);
  // 30 Sep window = 24–30 Sep: income 70 (27 Sep), spend 60 (29 Sep); 20 Sep spend 10 only reaches 26 Sep.
  assert.deepEqual(cards(d), [
    ['Savings / day', 1.4286, '7d trailing avg', 'positive'], ['Income / day', 10, '7d trailing avg', 'positive'],
    ['Expense / day', 8.5714, '7d trailing avg', 'negative'], ['Savings rate', 14.2857, 'of income', 'positive'],
  ]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.y_format, chart.labels], ['line', 'money2', ['26 Sep', '27 Sep', '28 Sep', '29 Sep', '30 Sep']]);
  assert.deepEqual(series(chart), [
    ['Income rate', 'income', [0, 10, 10, 10, 10]],
    ['Expense rate', 'expense', [1.4286, 0, 0, 8.5714, 8.5714]],
    ['Savings rate', 'savings', [-1.4286, 10, 10, 1.4286, 1.4286]],
  ]);
  assert.equal(chart.datasets[2].fill, 'signed');
  // Default window 30 over last_3 (1 Jul – today); the 15 Jun spend is inside the first windows.
  const dflt = data({ id: '00-earn-burn-rate' });
  assert.deepEqual([dflt.controls[0].value, dflt.charts[0].labels.length, dflt.charts[0].labels[0], round(dflt.charts[0].datasets[1].data[0])], [30, 92, '1 Jul', 3.3333]);
  assert.equal(dflt.stat_cards[3].sub, 'of income');
  assert.equal(insight({ id: '00-earn-burn-rate', window: '5' }).error, 'invalid_param');
  const noIncome = data({ id: '00-earn-burn-rate', period: 'custom', from: '2026-09-21', to: '2026-09-21', window: '7' });
  assert.deepEqual(cards(noIncome)[3], ['Savings rate', null, 'of income', null]);
});

// ── 01 ────────────────────────────────────────────────────────────────────────

test('01-mom-cumulative golden: cumulative spend this month vs last month, same-days compare when partial', () => {
  const d = data({ id: '01-mom-cumulative' });
  assert.deepEqual(cards(d), [['September 2026', 70, null, null], ['August 2026', 45.5, null, null], ['Change', 24.5, '54% higher', 'negative'], ['Days in', 30, 'of 30 days', null]]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.labels.length, chart.labels[30], chart.y_min], ['line', 31, '31', 0]);
  assert.deepEqual(series(chart), [
    ['September 2026', 'primary', [...days(19, () => 0), ...days(9, () => 10), 70, 70, null]],
    ['August 2026', 'compare', [0, 0, ...days(29, () => 45.5)]],
  ]);
  assert.equal(chart.datasets[1].dashed, true);
  const partial = data({ id: '01-mom-cumulative', today: '2026-09-25' });
  assert.deepEqual(cards(partial), [['September 2026 (to date)', 10, null, null], ['August 2026', 45.5, 'first 25 days', null], ['Change', -35.5, '78% lower', 'positive'], ['Days in', 25, 'of 30 days', null]]);
  assert.deepEqual(partial.charts[0].datasets[0].data.slice(24), [10, null, null, null, null, null, null]);
  const last = data({ id: '01-mom-cumulative', period: 'last_month' });
  assert.deepEqual(cards(last).slice(0, 2), [['August 2026', 45.5, null, null], ['July 2026', 0, null, null]]);
  assert.deepEqual(data({ id: '01-mom-cumulative', period: 'custom', from: '2026-05-01', to: '2026-05-31' }).empty, { text: 'No spend data for this period.' });
});

test('01-mom-cumulative accounts golden: daily asset + investment balances (all non-deleted accounts)', () => {
  const response = insight({ id: '01-mom-cumulative', tab: 'accounts' });
  assert.deepEqual(response.warnings, USD);
  const d = response.data;
  // Bank 1000 + 2500 − 45.5 − 300 (transfer to Card) + 70 = 3224.5; Rupee (inactive) 9450 INR = 90.
  assert.deepEqual(cards(d), [['Assets 30 Sep 26', 3314.5, null, null], ['Assets 31 Aug 26', 3554.5, 'last month end', null], ['Change', -240, '7% lower', 'negative'], ['Asset accounts', 3, null, null]]);
  const [current, previous] = d.charts[0].datasets;
  assert.deepEqual([current.label, current.style, current.data[10], current.data[11], current.data[19], current.data[26], current.data[30]], ['Assets Sep 2026', 'asset', 3554.5, 3254.5, 3244.5, 3314.5, null]);
  assert.deepEqual([previous.label, previous.data[0], previous.data[2]], ['Assets Aug 2026', 3600, 3554.5]);
});

// ── 02 ────────────────────────────────────────────────────────────────────────

test('02-yoy-monthly golden: multi-month periods compare monthly spend with the same months last year', () => {
  // The old client drew only the month of the period start (January for YTD).
  const d = data({ id: '02-yoy-monthly' });
  assert.deepEqual(cards(d), [['Jan 26 – Sep 26', 215.5, null, null], ['Jan 25 – Sep 25', 50, null, null], ['YoY change', 165.5, '331% higher', 'negative'], ['Months', 9, null, null]]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.labels], ['bar', ['Jan 26', 'Feb 26', 'Mar 26', 'Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26']]);
  assert.deepEqual(series(chart), [['Jan 26 – Sep 26', 'primary', [0, 0, 0, 0, 0, 100, 0, 45.5, 70]], ['Jan 25 – Sep 25', 'compare', [0, 20, 0, 0, 0, 0, 0, 0, 30]]]);
});

test('02-yoy-monthly golden: a single month is daily cumulative vs the same month last year', () => {
  const d = data({ id: '02-yoy-monthly', period: 'this_month', today: '2026-09-15' });
  assert.deepEqual(cards(d), [['Sep 2026 (to date)', 0, null, null], ['Sep 2025', 30, 'to 15 Sep', null], ['YoY change', -30, '100% lower', 'positive'], ['Month', 'September', null, null]]);
  assert.deepEqual(series(d.charts[0]), [
    ['Sep 2026', 'primary', [...days(15, () => 0), ...days(15, () => null)]],
    ['Sep 2025', 'compare', [...days(9, () => 0), ...days(21, () => 30)]],
  ]);
  const accounts = insight({ id: '02-yoy-monthly', tab: 'accounts', period: 'last_month' });
  assert.deepEqual(accounts.warnings, USD);
  assert.deepEqual(cards(accounts.data), [['Assets 31 Aug 26', 3554.5, null, null], ['Assets 31 Aug 25', 0, null, null], ['YoY change', 3554.5, null, 'positive'], ['Month', 'August', null, null]]);
  const ytdAccounts = data({ id: '02-yoy-monthly', tab: 'accounts' });
  assert.deepEqual(series(ytdAccounts.charts[0])[0], ['Assets Jan 26 – Sep 26', 'asset', [0, 0, 0, 0, 0, 0, 3600, 3554.5, 3314.5]]);
  assert.deepEqual(data({ id: '02-yoy-monthly', period: 'custom', from: '2026-04-01', to: '2026-04-30' }).empty, { text: 'No spend data for either period.' });
});

// ── 03 ────────────────────────────────────────────────────────────────────────

test('03-wow-daily golden: daily spend this week vs last week, real weekday labels for rolling weeks', () => {
  const d = data({ id: '03-wow-daily' });
  assert.deepEqual(cards(d), [['W40 2026 (current)', 60, null, null], ['W39 2026 (prev)', 0, 'first 3 days', null], ['WoW change', 60, null, 'negative'], ['Week', 'W40 2026', null, null]]);
  assert.deepEqual(d.charts[0].labels, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(series(d.charts[0]), [['W40 2026 (current)', 'primary', [0, 60, 0, null, null, null, null]], ['W39 2026 (prev)', 'compare', [0, 0, 0, 0, 0, 0, 0]]]);
  // last_7 = 24–30 Sep (Thu–Wed); the old client labelled any 7 days Mon–Sun.
  const rolling = data({ id: '03-wow-daily', period: 'last_7' });
  assert.deepEqual(rolling.charts[0].labels, ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
  assert.deepEqual(cards(rolling), [['24 Sep 26 – 30 Sep 26', 60, null, null], ['17 Sep 26 – 23 Sep 26 (prev)', 10, null, null], ['WoW change', 50, '500% higher', 'negative'], ['Week', '24 Sep 26 – 30 Sep 26', null, null]]);
  // Accounts: today is included (the old accounts tab dropped it).
  const accounts = data({ id: '03-wow-daily', tab: 'accounts' });
  assert.deepEqual(cards(accounts), [['Assets 30 Sep 26', 3314.5, null, null], ['Assets 27 Sep 26', 3314.5, 'prev week end', null], ['WoW change', 0, 'no change', 'positive'], ['Week', 'W40 2026', null, null]]);
  assert.deepEqual(series(accounts.charts[0])[0][2], [3314.5, 3314.5, 3314.5, null, null, null, null]);
});

// ── 04 ────────────────────────────────────────────────────────────────────────

test('04-qtd-comparison golden: cumulative quarter-to-date spend vs the same days of the previous quarter', () => {
  const d = data({ id: '04-qtd-comparison', today: '2026-09-20' });
  assert.deepEqual(cards(d), [['Q3 2026 (to date)', 55.5, null, null], ['Q2 2026 (same days)', 100, null, null], ['QTD change', -44.5, '45% lower', 'positive'], ['Days in', 82, 'of 92 days', null]]);
  const [a, b] = d.charts[0].datasets;
  assert.deepEqual([d.charts[0].labels.length, d.charts[0].labels[0], a.data[32], a.data[33], a.data[81], b.data[74], b.data[75], b.data[81]], [82, 'Day 1', 0, 45.5, 55.5, 0, 100, 100]);
  assert.deepEqual(d.notes, []);
  const last = data({ id: '04-qtd-comparison', period: 'last_quarter' });
  assert.deepEqual(cards(last)[0], ['Q2 2026', 100, null, null]);
  assert.equal(last.charts[0].datasets.length, 1);
  assert.deepEqual(last.notes, [{ text: 'No data for Q1 2026 (same days) — comparison series hidden.' }]);
  const accounts = data({ id: '04-qtd-comparison', tab: 'accounts', today: '2026-08-10' });
  assert.deepEqual(cards(accounts), [['Assets 10 Aug 26', 3554.5, null, null], ['Q2 2026 (same days)', 0, 'at 11 May 26', null], ['QTD change', 3554.5, null, 'positive'], ['Days in', 41, 'of 92 days', null]]);
});

// ── 05 ────────────────────────────────────────────────────────────────────────

test('05-ytd-comparison golden: monthly cumulative spend this year vs the same period last year', () => {
  const d = data({ id: '05-ytd-comparison' });
  assert.deepEqual(cards(d), [['2026 YTD', 215.5, null, null], ['2025 (same period)', 50, null, null], ['YoY change', 165.5, '331% higher', 'negative'], ['Months', 9, 'of 12', null]]);
  assert.deepEqual(d.charts[0].labels, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  assert.deepEqual(series(d.charts[0]), [['2026 YTD', 'primary', [0, 0, 0, 0, 0, 100, 100, 145.5, 215.5]], ['2025 (same period)', 'compare', [0, 20, 20, 20, 20, 20, 20, 20, 50]]]);
  const last = data({ id: '05-ytd-comparison', period: 'last_year' });
  assert.deepEqual([cards(last)[0], cards(last)[3], last.charts[0].datasets.length, last.notes], [['2025', 50, null, null], ['Months', 12, 'of 12', null], 1, [{ text: 'No data for 2024 — comparison series hidden.' }]]);
  const accounts = data({ id: '05-ytd-comparison', tab: 'accounts' });
  assert.deepEqual(series(accounts.charts[0])[0], ['Assets 2026 YTD', 'asset', [0, 0, 0, 0, 0, 0, 3600, 3554.5, 3314.5]]);
});

// ── 06 / 07 ───────────────────────────────────────────────────────────────────

test('06-last-12-months golden: monthly income, expenses and net over the 12 months to today', () => {
  const response = insight({ id: '06-last-12-months', period: 'last_7' }); // fixed window, period ignored
  assert.deepEqual(response.warnings, USD);
  const d = response.data;
  assert.deepEqual(cards(d), [['Income (12 mo)', 2570, null, 'positive'], ['Expenses (12 mo)', 215.5, null, 'negative'], ['Net', 2354.5, null, 'positive'], ['Avg spend/mo', 17.9583, null, null]]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.labels[0], chart.labels[11], chart.datasets.map(ds => ds.kind)], ['mixed', 'Oct 25', 'Sep 26', ['bar', 'bar', 'line']]);
  assert.deepEqual(series(chart).map(s => [s[0], s[1], s[2].slice(8)]), [['Income', 'income', [0, 2500, 0, 70]], ['Expenses', 'expense', [100, 0, 45.5, 70]], ['Net', 'compare', [-100, 2500, -45.5, 0]]]);
  assert.deepEqual(d.notes, []);
  const partial = data({ id: '06-last-12-months', today: '2026-09-15' });
  assert.deepEqual([partial.charts[0].labels[11], partial.notes], ['Sep 26*', [{ text: '* current month is partial' }]]);
  const accounts = data({ id: '06-last-12-months', tab: 'accounts' });
  assert.deepEqual(cards(accounts), [['Total assets', 3314.5, null, null], ['Account groups', 2, 'Current, Stocks & shares', null]]);
  assert.deepEqual([accounts.charts[0].kind, series(accounts.charts[0]).map(s => [s[0], s[1], s[2].slice(9)])], ['stacked', [['Current', 'palette:0', [3600, 3554.5, 3314.5]], ['Stocks & shares', 'palette:1', [0, 0, 0]]]]);
});

test('07-last-8-weeks golden: ISO-week income and expenses for the current week and the 7 before', () => {
  const d = data({ id: '07-last-8-weeks' });
  assert.deepEqual(cards(d), [['Income (8 wks)', 70, null, 'positive'], ['Expenses (8 wks)', 70, null, 'negative'], ['Net', 0, null, 'positive'], ['Avg spend/wk', 8.75, null, null]]);
  assert.deepEqual(d.charts[0].labels, ['W33', 'W34', 'W35', 'W36', 'W37', 'W38', 'W39', 'W40 (now)']);
  assert.deepEqual(series(d.charts[0]), [['Income', 'income', [0, 0, 0, 0, 0, 0, 70, 0]], ['Expenses', 'expense', [0, 0, 0, 0, 0, 10, 0, 60]]]);
  assert.equal(d.period, null);
});

// ── 19 ────────────────────────────────────────────────────────────────────────

test('19-cashflow-waterfall golden: opening net worth, income, spend by category, reconciled closing', () => {
  const d = data({ id: '19-cashflow-waterfall' });
  // Opening = net worth at 31 Aug (assets 3554.5 + card −200); closing = net worth at 30 Sep.
  assert.deepEqual(cards(d), [['Opening balance', 3354.5, 'at 31 Aug 26', null], ['Total income', 70, null, 'positive'], ['Total expenses', 70, null, 'negative'], ['Closing balance', 3354.5, null, 'positive']]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.height, chart.labels], ['waterfall', 300, ['Opening', 'Income', 'Food', 'Closing']]);
  assert.deepEqual(plain(chart.datasets[0]), { key: 'amount', label: 'Amount', data: [[0, 3354.5], [3354.5, 3424.5], [3424.5, 3354.5], [0, 3354.5]], style: 'primary', point_tones: ['primary', 'positive', 'negative', 'primary'] });
  assert.deepEqual(plain(chart.drill), { param: 'major', values: [null, null, 'food', null], mode: 'panel', hint: 'Tap an expense bar to see transactions',
    null_text: 'Opening, closing, income and other movements have no transaction list — tap an expense bar.' });
  assert.deepEqual(d.notes, []);
  // last_3: Bank / Rupee start tracking on 1 Jul, so their opening balances (1000 + 100) are 'Other movements'.
  const quarter = data({ id: '19-cashflow-waterfall', period: 'last_3' });
  assert.deepEqual(quarter.charts[0].labels, ['Opening', 'Income', 'Food', 'Other movements', 'Closing']);
  assert.deepEqual(quarter.charts[0].datasets[0].data, [[0, -200], [-200, 2370], [2370, 2254.5], [2254.5, 3354.5], [0, 3354.5]]);
  assert.deepEqual(quarter.charts[0].datasets[0].point_tones, ['primary', 'positive', 'negative', 'warn', 'primary']);
  assert.match(quarter.notes[0].text, /^Other movements: own-account transfers/);
  const drill = data({ id: '19-cashflow-waterfall', period: 'last_3', drill: JSON.stringify({ major: 'food' }) }).drill;
  assert.deepEqual([drill.title, drill.total_count, drill.total_quote, drill.rows.map(row => row.id)], ['Food', 3, 115.5, [ID(39), ID(37), ID(32)]]);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-07-01', to: '2026-09-30', types: 'money-out', major: 'food' });
  assert.equal(insight({ id: '19-cashflow-waterfall', drill: JSON.stringify({ major: 'rent' }) }).error, 'invalid_drill');
  assert.deepEqual(data({ id: '19-cashflow-waterfall', period: 'custom', from: '2026-04-01', to: '2026-04-30' }).empty, { text: 'No income or spending in this period.' });
});

test('19-cashflow-waterfall groups the 11th+ categories into a drillable Other expenses bar', () => {
  const majors = Array.from({ length: 12 }, (_, i) => 'm' + String(i + 1).padStart(2, '0'));
  const categories = majors.map((major, i) => ({ id: ID(100 + i), tx_type_key: 'money-out', major_category_key: major, major_category_label: 'Major ' + (i + 1), minor_category_key: 'x', minor_category_label: 'X', record_status: 'active', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false }));
  const transactions = majors.map((major, i) => ({ ...TRANSACTIONS[1], id: ID(200 + i), major_category: major, minor_category: 'x', tx_amount_local: 120 - i * 5, tx_date_local: '2026-09-1' + (i % 9) + ' 10:00:00' }));
  const run = params => { const r = insight(params, { categories, transactions }); assert.equal(r.ok, true); return r.data; };
  const d = run({ id: '19-cashflow-waterfall' });
  assert.equal(d.charts[0].labels.length, 2 + 10 + 1 + 1);
  assert.deepEqual([d.charts[0].labels[12], d.charts[0].drill.values[12]], ['Other expenses', '__other__']);
  const other = run({ id: '19-cashflow-waterfall', drill: JSON.stringify({ major: '__other__' }) }).drill;
  assert.deepEqual([other.title, other.total_count, other.total_quote, other.query.params.major], ['Other expenses', 2, 70 + 65, 'm11,m12']);
});

// ── 20 ────────────────────────────────────────────────────────────────────────

test('20-savings-rate golden: monthly savings rate on y2 with income / expense bars', () => {
  const d = data({ id: '20-savings-rate', period: 'last_3' });
  assert.deepEqual(cards(d), [['Avg savings rate', 50, null, 'positive'], ['Best month', 100, 'Jul 26', 'positive'], ['Worst month', 0, 'Sep 26', 'negative'], ['Positive streak', null, null, null]]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.y_format, chart.y2_format, chart.labels], ['mixed', 'money', 'percent', ['Jul 26', 'Aug 26', 'Sep 26']]);
  assert.deepEqual(series(chart), [['Income', 'income', [2500, 0, 70]], ['Expenses', 'expense', [0, 45.5, 70]], ['Savings %', 'compare', [100, null, 0]]]);
  assert.deepEqual([chart.datasets[2].axis, chart.datasets[2].kind, plain(chart.ref_lines)], ['y2', 'line', [{ value: 0, label: 'Break-even', tone: 'negative', axis: 'y2' }]]);
  const partial = data({ id: '20-savings-rate', period: 'last_3', today: '2026-09-28' });
  assert.deepEqual([partial.charts[0].labels[2], partial.notes, cards(partial)[3]], ['Sep 26*', [{ text: '* partial month' }], ['Positive streak', '1 month', null, null]]);
});

// ── 21 ────────────────────────────────────────────────────────────────────────

test('21-income-sources golden: by source (blank = Unknown source), by category, trend, drills', () => {
  const response = insight({ id: '21-income-sources' });
  assert.deepEqual(response.warnings, USD);
  const d = response.data;
  assert.deepEqual([d.tab, d.tabs.map(tab => [tab.key, tab.active])], ['source', [['source', true], ['category', false], ['trend', false]]]);
  const chart = d.charts[0];
  assert.deepEqual([chart.kind, chart.labels, series(chart)], ['donut', ['Unknown source', 'Acme Ltd'], [['Income', 'palette', [2500, 70]]]]);
  assert.deepEqual(plain(chart.drill), { param: 'source', values: ['(none)', 'acme ltd'], mode: 'panel', hint: 'Tap a segment to see transactions' });
  assert.deepEqual(d.tables[0].rows.map(row => [row.cells.label, row.cells.amount, round(row.cells.share), row.drill.value]), [['Unknown source', 2500, 97.2763, '(none)'], ['Acme Ltd', 70, 2.7237, 'acme ltd']]);
  assert.deepEqual(d.notes, [{ text: 'Concentrated income — Unknown source accounts for 97%', tone: 'warn' }]);
  const acme = data({ id: '21-income-sources', drill: JSON.stringify({ source: 'acme ltd' }) }).drill;
  assert.deepEqual([acme.title, acme.total_count, acme.total_quote, acme.rows[0].id, plain(acme.query.params)],
    ['Acme Ltd', 1, 70, ID(43), { range: 'custom', from: '2025-10-01', to: '2026-09-30', types: 'money-in', counterparty: 'Acme Ltd' }]);
  const unknown = data({ id: '21-income-sources', drill: JSON.stringify({ source: '(none)' }) }).drill;
  assert.deepEqual([unknown.title, unknown.total_count, unknown.query], ['Unknown source', 1, null]);
  const category = data({ id: '21-income-sources', tab: 'category', drill: JSON.stringify({ major: 'income' }) });
  assert.deepEqual([category.charts[0].labels, category.charts[0].drill.param, category.drill.total_quote, category.drill.query.params.major], [['Income'], 'major', 2570, 'income']);
  const trend = data({ id: '21-income-sources', tab: 'trend', period: 'last_3' });
  assert.deepEqual(cards(trend), [['Total income', 2570, null, 'positive'], ['Avg monthly', 856.6667, null, null], ['Peak month', 2500, 'Jul 26', null]]);
  assert.deepEqual(series(trend.charts[0]), [['Income', 'income', [2500, 0, 70]]]);
  assert.equal(insight({ id: '21-income-sources', tab: 'trend', drill: JSON.stringify({ source: 'acme ltd' }) }).error, 'invalid_drill');
  assert.equal(insight({ id: '21-income-sources', drill: JSON.stringify({ source: 'nobody' }) }).error, 'invalid_drill');
  assert.equal(insight({ id: '21-income-sources', tab: 'accounts' }).error, 'invalid_tab');
  assert.deepEqual(data({ id: '21-income-sources', period: 'custom', from: '2026-08-01', to: '2026-08-31' }).empty, { text: 'No income recorded for this period.' });
});

test('P4-B insights: INR quote currency converts every flow; payloads stay small', () => {
  const inr = insight({ id: '06-last-12-months', quote_currency: 'INR' });
  assert.deepEqual([inr.quote.symbol, inr.data.stat_cards[0].value, inr.data.stat_cards[1].value], ['₹', 2570 * 105, 215.5 * 105]);
  for (const id of PORTED) {
    const response = insight({ id });
    assert.equal(response.ok, true, id);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 60 * 1024, id);
  }
});
