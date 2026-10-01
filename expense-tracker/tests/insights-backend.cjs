// Phase 4 (P4-A): insights registry, get_insight dispatch / params / errors,
// the per-insight extension hooks and golden outputs of the reference ports
// (10-top-categories, 29-daily-spend, 30-daily-spend-no-payments).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, CATEGORIES, TRANSACTIONS, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const hookName = id => 'insightCompute_' + id.replace(/-/g, '_');

function appRuntime(overrides) {
  const runtime = gasRuntime({ properties: { PIN_SECRET: '1234' } });
  runtime.tabs = seedViewFixture(runtime, overrides);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', ...params } }).getContent());
  runtime.insight = params => runtime.get({ action: 'get_insight', ...params });
  return runtime;
}

const ANY_PERIODS = ['this_week', 'last_week', 'last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month',
  'last_3', 'last_6', 'last_12', 'this_quarter', 'last_quarter', 'ytd', 'last_year', 'custom'];

// ── Registry ──────────────────────────────────────────────────────────────────

test('registry lists the 30 live insights (18 is dead) with client-ready metadata', () => {
  const { ctx } = gasRuntime();
  const registry = plain(ctx.insightsRegistryForClient());
  assert.equal(registry.length, 30);
  assert.equal(new Set(registry.map(entry => entry.id)).size, 30);
  assert.ok(!registry.some(entry => entry.id.startsWith('18-')));
  assert.deepEqual([...new Set(registry.map(entry => entry.group))],
    ['Cash flow', 'Spending comparisons', 'Categories', 'Net worth', 'Counterparties', 'Geography', 'Loans', 'FX & currency']);
  const byId = Object.fromEntries(registry.map(entry => [entry.id, entry]));
  for (const entry of registry) {
    // server = a compute hook exists; porting agents flip nothing.
    assert.equal(entry.server, typeof ctx[hookName(entry.id)] === 'function', entry.id);
    assert.equal(entry.label, entry.title);
    for (const key of ['id', 'title', 'group', 'description', 'render_kind']) assert.equal(typeof entry[key], 'string', entry.id + ' ' + key);
    assert.ok(Array.isArray(entry.params) && Array.isArray(entry.tabs) && Array.isArray(entry.periods), entry.id);
    if (entry.periods.length > 0) assert.ok(entry.periods.some(p => p.value === entry.default_period), entry.id + ' default period offered');
  }
  for (const id of ['10-top-categories', '29-daily-spend', '30-daily-spend-no-payments']) assert.equal(byId[id].server, true, id);
  assert.deepEqual(byId['10-top-categories'].periods.map(p => p.value), ANY_PERIODS);
  assert.deepEqual(byId['29-daily-spend'].periods[0], { value: 'last_7', label: 'Last 7 days' });
  assert.deepEqual([byId['06-last-12-months'].periods, byId['07-last-8-weeks'].periods], [[], []]);
  assert.deepEqual(byId['27-debt-to-income'].tabs, [{ key: 'transactions', label: 'Income trend' }, { key: 'accounts', label: 'DTI ratio' }]);
  assert.deepEqual(byId['01-mom-cumulative'].tabs.map(t => t.key), ['transactions', 'accounts']);
});

test('extension hooks: defining insightCompute_<id> / insightMeta_<id> in another file is enough', () => {
  const runtime = appRuntime();
  const { ctx } = runtime;
  ctx.insightMeta_08_category_pie = () => ({ periods: ['last_30', 'custom'], default_period: 'last_30', title: 'ignored', id: 'ignored' });
  ctx.insightCompute_08_category_pie = ictx => ({
    stat_cards: [ctx.insStat('total', 'Total', ctx.insTotal(ctx.insFlows(ictx, { kind: 'spend' })), 'money')],
    notes: [{ text: ictx.period.key + ' ' + ictx.period.from + ' ' + (ictx.compare === null ? '-' : ictx.compare.from) }],
    title: 'cannot override', insight_id: 'nope',
  });
  const entry = plain(ctx.insightsRegistryForClient()).find(e => e.id === '08-category-pie');
  assert.deepEqual([entry.server, entry.title, entry.default_period, entry.periods.map(p => p.value)], [true, 'Category breakdown', 'last_30', ['last_30', 'custom']]);
  const response = runtime.insight({ id: '08-category-pie' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.deepEqual([data.insight_id, data.title, data.tab, data.tabs, data.controls, data.charts, data.tables, data.drill, data.breadcrumbs, data.empty],
    ['08-category-pie', 'Category breakdown', null, [], [], [], [], null, [], null]);
  assert.deepEqual(plain(data.period), { key: 'last_30', label: 'Last 30 days', from: '2026-09-01', to: '2026-09-30', days: 30, compare_from: '2026-08-02', compare_to: '2026-08-31' });
  assert.deepEqual(plain(data.compare), { mode: 'previous', from: '2026-08-02', to: '2026-08-31', label: '2 Aug 26 – 31 Aug 26' });
  assert.deepEqual(plain(data.stat_cards), [{ key: 'total', label: 'Total', value: 70, format: 'money' }]);
  assert.equal(runtime.insight({ id: '08-category-pie', period: 'last_90' }).error, 'invalid_period');
  // A compute error envelope passes through; a throw becomes insight_failed.
  // (Distinct params: identical requests are served from the view cache.)
  ctx.insightCompute_08_category_pie = () => ctx.insError('invalid_param', 'top_n');
  assert.deepEqual(plain(runtime.insight({ id: '08-category-pie', top_n: '7' })), { ok: false, error: 'invalid_param', field: 'top_n', message: 'One of the insight options has an unsupported value. Reset the view and try again.' });
  ctx.insightCompute_08_category_pie = () => { throw new Error('boom'); };
  assert.equal(runtime.insight({ id: '08-category-pie', period: 'custom', to: '2026-09-29' }).error, 'insight_failed');
  assert.ok(runtime.logs.some(line => line.startsWith('ERR insGetInsight: compute failed id=08-category-pie')));
});

// ── get_insight params and errors ─────────────────────────────────────────────

test('get_insight validates id, period, compare, tab and drill with field-level messages', () => {
  const runtime = appRuntime();
  const { ctx } = runtime;
  const err = params => { const r = runtime.insight(params); return [r.ok, r.error, r.field, typeof r.message]; };
  assert.deepEqual(err({}), [false, 'missing_insight_id', 'id', 'string']);
  assert.deepEqual(err({ id: 'nope' }), [false, 'unknown_insight', 'id', 'string']);
  assert.deepEqual(err({ id: '18-income-vs-expenses' }), [false, 'unknown_insight', 'id', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', period: 'last_year' }), [false, 'invalid_period', 'period', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', period: 'custom', from: '2026-09-10', to: '2026-09-01' }), [false, 'invalid_period', 'period', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', period: 'custom', from: '2026-02-30' }), [false, 'invalid_period', 'period', 'string']);
  assert.deepEqual(err({ id: '10-top-categories', compare: 'forever' }), [false, 'invalid_compare', 'compare', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', drill: '{bad json' }), [false, 'invalid_drill', 'drill', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', drill: '[1]' }), [false, 'invalid_drill', 'drill', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', period: 'this_month', drill: JSON.stringify({ date: '2026-08-31' }) }), [false, 'invalid_drill', 'drill', 'string']);
  assert.deepEqual(err({ id: '29-daily-spend', drill: JSON.stringify({ day: '2026-09-20' }) }), [false, 'invalid_drill', 'drill', 'string']);
  assert.equal(runtime.insight({ id: '29-daily-spend', tz: 'Not/AZone' }).error, 'invalid_timezone');
  // Not computed on the server (no hook) → insight_not_available.
  ctx.insightCompute_29_daily_spend = undefined;
  assert.deepEqual(err({ id: '29-daily-spend' }), [false, 'insight_not_available', 'id', 'string']);
  assert.equal(plain(ctx.insightsRegistryForClient()).find(e => e.id === '29-daily-spend').server, false);
  // Tabs: default first tab, unknown tab refused. Fixed-period insights ignore period.
  ctx.insightCompute_01_mom_cumulative = ictx => ({ notes: [{ text: ictx.tab }] });
  ctx.insightCompute_06_last_12_months = ictx => ({ notes: [{ text: ictx.period.key + ' ' + ictx.period.from }] });
  assert.equal(runtime.insight({ id: '01-mom-cumulative' }).data.notes[0].text, 'transactions');
  const accountsTab = runtime.insight({ id: '01-mom-cumulative', tab: 'accounts' }).data;
  assert.deepEqual([accountsTab.tab, plain(accountsTab.tabs)], ['accounts', [{ key: 'transactions', label: 'Transactions', active: false }, { key: 'accounts', label: 'Accounts', active: true }]]);
  assert.deepEqual(err({ id: '01-mom-cumulative', tab: 'bogus' }), [false, 'invalid_tab', 'tab', 'string']);
  assert.equal(runtime.insight({ id: '06-last-12-months', period: 'last_7' }).data.notes[0].text, 'last_12 2025-10-01');
});

test('insIntParam / insChoiceParam validate control params against fixed lists', () => {
  const { ctx } = gasRuntime();
  const ictx = { params: { window: '30', top_n: '11', sort: 'amount' } };
  assert.deepEqual(plain(ctx.insIntParam(ictx, 'window', [7, 14, 30, 90], 30)), { ok: true, value: 30 });
  assert.equal(ctx.insIntParam(ictx, 'top_n', [10, 15, 20], 10).error, 'invalid_param');
  assert.deepEqual(plain(ctx.insIntParam({ params: {} }, 'top_n', [10, 15, 20], 10)), { ok: true, value: 10 });
  assert.deepEqual(plain(ctx.insChoiceParam(ictx, 'sort', ['amount', 'counterparty'], 'amount')), { ok: true, value: 'amount' });
  assert.equal(ctx.insChoiceParam(ictx, 'sort', ['counterparty'], 'counterparty').field, 'sort');
});

test('shared helpers: labels, weekly buckets, compare last_year, balance series', () => {
  const runtime = appRuntime();
  const { ctx } = runtime;
  assert.deepEqual([ctx.insDayLabel('2026-09-05'), ctx.insDateLabel('2026-09-05'), ctx.insMonthLabel('2026-09')], ['5 Sep', '5 Sep 26', 'Sep 26']);
  assert.deepEqual([ctx.insRangeLabel('2026-09-01', '2026-09-30'), ctx.insRangeLabel('2026-07-01', '2026-09-30'), ctx.insRangeLabel('2026-09-01', '2026-09-15'), ctx.insRangeLabel(null, '2026-09-15')],
    ['Sep 26', 'Jul 26 – Sep 26', '1 Sep 26 – 15 Sep 26', 'Up to 15 Sep 26']);
  assert.deepEqual([ctx.insWeekStart('2026-09-30'), ctx.insWeekStart('2026-09-28'), ctx.insWeekStart('2026-09-27')], ['2026-09-28', '2026-09-28', '2026-09-21']);
  ctx.insightCompute_07_last_8_weeks = ictx => {
    const spend = ctx.insFlows(ictx, { kind: 'spend', from: '2026-09-01', to: ictx.today });
    const weeks = ctx.insWeeklySeries(spend, '2026-09-01', ictx.today);
    const balances = ctx.insBalanceSeries(ictx, '2026-09-28', '2026-09-30');
    return { notes: [{ text: JSON.stringify([weeks.keys, weeks.values, balances.labels, balances.totals, ctx.insNetWorthNow(ictx).net_worth]) }] };
  };
  const [keys, values, labels, totals, worth] = JSON.parse(runtime.insight({ id: '07-last-8-weeks' }).data.notes[0].text);
  assert.deepEqual(keys, ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(values, [0, 0, 10, 0, 60]);
  assert.deepEqual(labels, ['28 Sep', '29 Sep', '30 Sep']);
  assert.equal(totals.length, 3);
  assert.equal(worth, 3272.5);
  const lastYear = runtime.insight({ id: '10-top-categories', period: 'last_3', compare: 'last_year' }).data;
  assert.deepEqual(plain(lastYear.compare), { mode: 'last_year', from: '2025-07-01', to: '2025-09-30', label: 'Jul 25 – Sep 25' });
});

// ── Golden outputs: 29 / 30 ───────────────────────────────────────────────────

test('29-daily-spend golden: daily money-out without deleted rows or own transfers', () => {
  const runtime = appRuntime();
  const response = runtime.insight({ id: '29-daily-spend', period: 'this_month' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.warnings, []);
  const data = response.data;
  assert.deepEqual(plain(data.period), { key: 'this_month', label: 'This month', from: '2026-09-01', to: '2026-09-30', days: 30, compare_from: '2026-08-01', compare_to: '2026-08-30' });
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'total', label: 'Total spend', value: 70, format: 'money' },
    { key: 'avg_spend_day', label: 'Avg / spend day', value: 35, format: 'money' },
    { key: 'highest_day', label: 'Highest day', value: 60, format: 'money', sub: '29 Sep' },
    { key: 'spend_days', label: 'Spend days', value: '2 / 30', format: 'text' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.id, chart.kind, chart.y_format, chart.y_min, chart.labels.length, chart.labels[0], chart.labels[29]], ['daily', 'bar', 'money', 0, 30, '1 Sep', '30 Sep']);
  const values = chart.datasets[0].data;
  // 10 Sep deleted (20) and 12 Sep transfer (300) are not spend; 20 Sep 1050 INR = 10 GBP.
  assert.deepEqual(values.map((v, i) => [i + 1, v]).filter(([, v]) => v !== 0), [[20, 10], [29, 60]]);
  assert.deepEqual([chart.datasets[0].point_tones[19], chart.datasets[0].point_tones[0]], ['primary', 'muted']);
  assert.deepEqual([chart.drill.param, chart.drill.mode, chart.drill.values[0], chart.drill.values[29]], ['date', 'panel', '2026-09-01', '2026-09-30']);
  assert.equal(data.drill, null);
  assert.equal(Buffer.byteLength(JSON.stringify(response)) < 90 * 1024, true);
});

test('29-daily-spend drill: TxRows for the day (list_transactions_view shape), one transaction read', () => {
  const runtime = appRuntime();
  const before = runtime.tabs.transactions.reads;
  const response = runtime.insight({ id: '29-daily-spend', period: 'this_month', drill: JSON.stringify({ date: '2026-09-20' }) });
  assert.equal(runtime.tabs.transactions.reads - before, 1);
  const drill = response.data.drill;
  assert.deepEqual([drill.title, drill.subtitle, drill.total_count, drill.shown_count, drill.total_quote], ['20 Sep', '1 transaction', 1, 1, 10]);
  const row = drill.rows[0];
  assert.deepEqual([row.id, row.tx_type, row.account.name, row.amount.native, row.amount.currency, row.amount.quote, row.amount.quote_display, row.category.label],
    [ID(37), 'money-out', 'Rupee', 1050, 'INR', 10, '£10.00', 'Food → Groceries']);
  const listRow = runtime.get({ action: 'list_transactions_view', range: 'custom', from: '2026-09-20', to: '2026-09-20' }).data.rows.find(r => r.id === ID(37));
  assert.deepEqual(Object.keys(row).sort(), Object.keys(listRow).sort());
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-09-20', to: '2026-09-20', types: 'money-out' });
  // A day with no spend has an empty drill; the transfer day shows nothing.
  const transferDay = runtime.insight({ id: '29-daily-spend', period: 'this_month', drill: JSON.stringify({ date: '2026-09-12' }) }).data.drill;
  assert.deepEqual([transferDay.total_count, transferDay.rows], [0, []]);
});

test('29-daily-spend: custom range without a start, last_7, missing rates, quote currency', () => {
  const extra = [...TRANSACTIONS, { ...TRANSACTIONS[1], id: ID(41), account_id: ID(14), tx_amount_local: 5, tx_date_local: '2026-09-26 10:00:00' }];
  const runtime = appRuntime({ transactions: extra });
  const custom = runtime.insight({ id: '29-daily-spend', period: 'custom', to: '2026-09-30' }).data;
  assert.deepEqual([custom.charts[0].labels[0], custom.charts[0].labels.length, custom.stat_cards[0].value], ['15 Jun', 108, 215.5]);
  const week = runtime.insight({ id: '29-daily-spend', period: 'last_7' });
  assert.deepEqual(week.data.charts[0].labels, ['24 Sep', '25 Sep', '26 Sep', '27 Sep', '28 Sep', '29 Sep', '30 Sep']);
  // The USD spend on 26 Sep has no rate: left out and reported, never 1:1.
  assert.deepEqual(week.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  assert.equal(week.data.stat_cards[0].value, 60);
  const inr = runtime.insight({ id: '29-daily-spend', period: 'last_7', quote_currency: 'INR' });
  assert.deepEqual([inr.quote.symbol, inr.data.stat_cards[0].value], ['₹', 6300]);
  const empty = runtime.insight({ id: '29-daily-spend', period: 'custom', from: '2026-09-01', to: '2026-09-05' }).data;
  assert.deepEqual([empty.empty, empty.charts], [{ text: 'No spending found for this period.' }, []]);
});

test('30-daily-spend-no-payments excludes subscription-eligible categories (old client excluded nothing)', () => {
  const same = appRuntime();
  assert.deepEqual(same.insight({ id: '30-daily-spend-no-payments', period: 'this_month' }).data.stat_cards,
    same.insight({ id: '29-daily-spend', period: 'this_month' }).data.stat_cards);
  const categories = CATEGORIES.map(c => (c.major_category_key === 'food' && c.minor_category_key === 'groceries' ? { ...c, is_subscription_eligible: true } : c));
  const runtime = appRuntime({ categories });
  assert.deepEqual(runtime.insight({ id: '30-daily-spend-no-payments', period: 'this_month' }).data.empty, { text: 'No spending found for this period.' });
  assert.equal(runtime.insight({ id: '29-daily-spend', period: 'this_month' }).data.stat_cards[0].value, 70);
});

// ── Golden outputs: 10 ────────────────────────────────────────────────────────

test('10-top-categories golden: current vs previous period by category, delta table', () => {
  const runtime = appRuntime();
  const data = runtime.insight({ id: '10-top-categories', period: 'last_3' }).data;
  assert.deepEqual(plain(data.compare), { mode: 'previous', from: '2026-04-01', to: '2026-06-30', label: 'Apr 26 – Jun 26' });
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'current', label: 'Jul 26 – Sep 26', value: 115.5, format: 'money', sub: 'top 1 categories' },
    { key: 'previous', label: 'Apr 26 – Jun 26', value: 100, format: 'money', sub: 'same categories' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.height, chart.labels], ['hbar', 200, ['Groceries']]);
  assert.deepEqual(plain(chart.datasets), [
    { key: 'current', label: 'Jul 26 – Sep 26', data: [115.5], style: 'primary' },
    { key: 'previous', label: 'Apr 26 – Jun 26', data: [100], style: 'compare' },
  ]);
  assert.deepEqual(plain(data.tables[0].rows), [{ key: 'food|groceries', cells: { category: 'Groceries', delta: 15.5 }, tone: 'negative' }]);
  const month = runtime.insight({ id: '10-top-categories', period: 'this_month' }).data;
  assert.deepEqual(month.stat_cards.map(card => [card.label, card.value]), [['Sep 26', 70], ['1 Aug 26 – 30 Aug 26', 45.5]]);
  assert.equal(month.tables[0].rows[0].tone, 'negative');
  const none = runtime.insight({ id: '10-top-categories', period: 'this_month', compare: 'none' }).data;
  assert.deepEqual([none.compare, none.stat_cards.length, none.charts[0].datasets.length, none.tables], [null, 1, 1, []]);
  const empty = runtime.insight({ id: '10-top-categories', period: 'last_week' }).data;
  assert.deepEqual(empty.empty, { text: 'No spending data for this period.' });
});

test('10-top-categories keeps equal minor keys of different majors apart and labels them', () => {
  const categories = [...CATEGORIES,
    { id: ID(27), tx_type_key: 'money-out', major_category_key: 'home', major_category_label: 'Home', minor_category_key: 'groceries', minor_category_label: 'Groceries', record_status: 'active', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false }];
  const transactions = [...TRANSACTIONS, { ...TRANSACTIONS[1], id: ID(42), major_category: 'home', tx_amount_local: 80, tx_date_local: '2026-09-15 10:00:00' }];
  const data = appRuntime({ categories, transactions }).insight({ id: '10-top-categories', period: 'this_month' }).data;
  assert.deepEqual(data.charts[0].labels, ['Home · Groceries', 'Food · Groceries']);
  assert.deepEqual(data.charts[0].datasets[0].data, [80, 70]);
});
