// Phase 4 (P4-C): golden outputs of the server ports of the category and tag
// insights (08-category-pie, 09-category-trend, 11-category-drilldown,
// 12-tag-pie, 13-tag-trend). Spend excludes deleted rows and own-account
// transfers, periods end today, tags are split equally between a row's
// distinct tags, and drill state lives in the get_insight drill param.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, CATEGORIES, TRANSACTIONS, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const IDS = ['08-category-pie', '09-category-trend', '11-category-drilldown', '12-tag-pie', '13-tag-trend'];

function appRuntime(overrides) {
  const runtime = gasRuntime({ properties: { PIN_SECRET: '1234' } });
  runtime.tabs = seedViewFixture(runtime, overrides);
  runtime.insight = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', action: 'get_insight', ...params } }).getContent());
  return runtime;
}

const cat = (n, major, majorLabel, minor, minorLabel) => ({ id: ID(n), tx_type_key: 'money-out', major_category_key: major, major_category_label: majorLabel,
  minor_category_key: minor, minor_category_label: minorLabel, record_status: 'active', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false });
const spendTx = (n, amount, date, extra = {}) => ({ ...TRANSACTIONS[1], id: ID(n), tx_amount_local: amount, tx_date_local: date, tx_tags: '', ...extra });

// Fixture: base view fixture + a Home major (rent + a blank minor), an
// uncategorised row, and tags on flows, a deleted row and a transfer leg.
const TAGS = { [ID(32)]: 'food', [ID(34)]: 'trip', [ID(35)]: 'trip', [ID(37)]: 'Trip;food', [ID(39)]: 'trip' };
const CATS = [...CATEGORIES, cat(27, 'home', 'Home', 'rent', 'Rent'), cat(28, 'home', 'Home', 'repairs', 'Repairs')];
const TXS = [
  ...TRANSACTIONS.map(tx => (TAGS[tx.id] === undefined ? tx : { ...tx, tx_tags: TAGS[tx.id] })),
  spendTx(50, 40, '2026-09-05 10:00:00', { major_category: 'home', minor_category: 'rent', tx_tags: 'Trip; trip ;Home' }),  // duplicate tag → [trip, home]
  spendTx(51, 15, '2026-09-06 10:00:00', { major_category: '', minor_category: '' }),                                      // uncategorised, untagged
  spendTx(52, 25, '2026-09-07 10:00:00', { major_category: 'home', minor_category: '', tx_tags: 'home' }),                 // blank minor
];
const fixture = extra => appRuntime({ categories: CATS, transactions: TXS, ...(extra || {}) });

test('all five category / tag insights are computed on the server and the client modules are gone', () => {
  const { ctx } = fixture();
  const registry = plain(ctx.insightsRegistryForClient());
  for (const id of IDS) {
    assert.equal(registry.find(entry => entry.id === id).server, true, id);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'app/sections/insights', id + '.js')), false, id + ' client module deleted');
  }
  const state = fs.readFileSync(path.join(__dirname, '..', 'app/core/state.js'), 'utf8');
  assert.ok(!/insightDrillMajor|insightDrillMinor/.test(state), 'legacy 11 drill state removed');
});

// ── 08-category-pie ───────────────────────────────────────────────────────────

test('08-category-pie golden: donut by major (catalog labels), share tables, per-major drill', () => {
  const runtime = fixture();
  const response = runtime.insight({ id: '08-category-pie', period: 'this_month' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.warnings, []);
  const data = response.data;
  // Sep: 10 (1050 INR) + 60 food, 40 + 25 home, 15 uncategorised = 150. The
  // deleted 20, the 300 transfer and the 5 Oct future row are not spend.
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'total', label: 'Total spend', value: 150, format: 'money', sub: '5 expenses' },
    { key: 'categories', label: 'Categories', value: 3, format: 'count', sub: 'tap a segment to see transactions' },
    { key: 'top', label: 'Largest category', value: 70, format: 'money', sub: 'Food' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels, chart.datasets[0].data, chart.datasets[0].style], ['donut', ['Food', 'Home', 'Uncategorised'], [70, 65, 15], 'palette']);
  assert.deepEqual(plain(chart.drill), { param: 'major', values: ['food', 'home', '(none)'], mode: 'panel', hint: 'Tap a segment to see its transactions' });
  const [segments, minors] = data.tables;
  assert.deepEqual(segments.rows.map(r => [r.cells.category, r.cells.amount, Number(r.cells.share.toFixed(2)), r.drill.value]),
    [['Food', 70, 46.67, 'food'], ['Home', 65, 43.33, 'home'], ['Uncategorised', 15, 10, '(none)']]);
  assert.deepEqual([minors.id, minors.title], ['minors', 'Top minor categories']);
  assert.deepEqual(minors.rows.map(r => [r.key, r.cells.category, r.cells.amount]),
    [['food|groceries', 'Food → Groceries', 70], ['home|rent', 'Home → Rent', 40], ['home|(none)', 'Home → —', 25], ['(none)|(none)', 'Uncategorised', 15]]);
  assert.equal(data.drill, null);

  const drill = runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ major: 'home' }) }).data.drill;
  assert.deepEqual([drill.title, drill.subtitle, drill.total_count, drill.total_quote, drill.rows.map(r => r.id)], ['Home', '2 transactions', 2, 65, [ID(52), ID(50)]]);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-09-01', to: '2026-09-30', types: 'money-out', major: 'home' });
  assert.equal(runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ major: '(none)' }) }).data.drill.query, null);
  assert.equal(runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ major: 'old' }) }).error, 'invalid_drill');
  assert.equal(runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ tag: 'x' }) }).error, 'invalid_drill');
  assert.deepEqual(runtime.insight({ id: '08-category-pie', period: 'last_week' }).data.empty, { text: 'No spending data for this period.' });
});

test('08-category-pie merges majors beyond 7 into Other; Other and merged majors stay drillable', () => {
  const categories = [...CATEGORIES, ...Array.from({ length: 9 }, (_, i) => cat(60 + i, 'm' + (i + 1), 'M' + (i + 1), 'x', 'X'))];
  const transactions = Array.from({ length: 9 }, (_, i) => spendTx(70 + i, 9 - i, '2026-09-1' + i + ' 10:00:00', { major_category: 'm' + (i + 1), minor_category: 'x' }));
  const runtime = appRuntime({ categories, transactions });
  const data = runtime.insight({ id: '08-category-pie', period: 'this_month' }).data;
  assert.deepEqual(data.charts[0].labels, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'Other']);
  assert.deepEqual(data.charts[0].datasets[0].data, [9, 8, 7, 6, 5, 4, 3, 3]);
  assert.equal(data.charts[0].drill.values[7], '__other__');
  assert.equal(data.stat_cards[1].value, 9);
  const other = runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ major: '__other__' }) }).data.drill;
  assert.deepEqual([other.title, other.total_count, other.total_quote, other.query.params.major], ['Other', 2, 3, 'm8,m9']);
  const merged = runtime.insight({ id: '08-category-pie', period: 'this_month', drill: JSON.stringify({ major: 'm9' }) }).data.drill;
  assert.deepEqual([merged.title, merged.total_quote], ['M9', 1]);
});

// ── 09-category-trend ─────────────────────────────────────────────────────────

test('09-category-trend golden: stacked monthly spend by major through today', () => {
  const runtime = fixture();
  const response = runtime.insight({ id: '09-category-trend' });
  assert.deepEqual(response.warnings, []);
  const data = response.data;
  assert.deepEqual([data.period.key, data.period.from, data.period.to], ['last_6', '2026-04-01', '2026-09-30']);
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'total', label: 'Total spend', value: 295.5, format: 'money' },
    { key: 'top', label: 'Top category', value: 215.5, format: 'money', sub: 'Food' },
    { key: 'peak', label: 'Peak month', value: 150, format: 'money', sub: 'Sep 26' },
    { key: 'categories', label: 'Categories', value: 3, format: 'count' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels, chart.y_min], ['stacked', ['Apr 26', 'May 26', 'Jun 26', 'Jul 26', 'Aug 26', 'Sep 26'], 0]);
  assert.deepEqual(plain(chart.datasets), [
    { key: 'food', label: 'Food', data: [0, 0, 100, 0, 45.5, 70], style: 'palette:0' },
    { key: 'home', label: 'Home', data: [0, 0, 0, 0, 0, 65], style: 'palette:1' },
    { key: '(none)', label: 'Uncategorised', data: [0, 0, 0, 0, 0, 15], style: 'palette:2' },
  ]);
  // Custom range without a start begins at the first spend month.
  const custom = runtime.insight({ id: '09-category-trend', period: 'custom', to: '2026-08-31' }).data;
  assert.deepEqual([custom.charts[0].labels, custom.stat_cards[0].value], [['Jun 26', 'Jul 26', 'Aug 26'], 145.5]);
  assert.deepEqual(runtime.insight({ id: '09-category-trend', period: 'last_week' }).data.empty, { text: 'No spending data for this period.' });
});

// ── 11-category-drilldown ─────────────────────────────────────────────────────

test('11-category-drilldown: three levels with breadcrumbs, all driven by the drill param', () => {
  const runtime = fixture();
  const drill = value => runtime.insight({ id: '11-category-drilldown', period: 'this_month', drill: JSON.stringify(value) });

  const level1 = runtime.insight({ id: '11-category-drilldown', period: 'this_month' }).data;
  assert.deepEqual(plain(level1.stat_cards), [
    { key: 'total', label: 'Total spend', value: 150, format: 'money' },
    { key: 'categories', label: 'Categories', value: 3, format: 'count', sub: 'tap a bar to drill in' },
  ]);
  const c1 = level1.charts[0];
  assert.deepEqual([c1.kind, c1.height, c1.labels, c1.datasets[0].data, c1.datasets[0].style], ['hbar', 148, ['Food', 'Home', 'Uncategorised'], [70, 65, 15], 'palette']);
  assert.deepEqual([c1.drill.param, c1.drill.mode, c1.drill.values], ['major', 'replace', ['food', 'home', '(none)']]);
  assert.deepEqual(plain(level1.breadcrumbs), [{ label: 'All categories', drill: null }]);

  const level2 = drill({ major: 'home' }).data;
  assert.deepEqual(level2.stat_cards.map(c => [c.label, c.value]), [['Total (Home)', 65], ['Sub-categories', 2]]);
  const c2 = level2.charts[0];
  assert.deepEqual([c2.title, c2.labels, c2.datasets[0].data, c2.datasets[0].style], ['Home — minor breakdown', ['Rent', 'Other'], [40, 25], 'palette:1']);
  assert.deepEqual([c2.drill.param, c2.drill.mode, c2.drill.values], ['minor', 'replace', ['home|rent', 'home|(none)']]);
  assert.deepEqual(plain(level2.breadcrumbs), [{ label: 'All categories', drill: null }, { label: 'Home', drill: { major: 'home' } }]);

  // Level 3: the chart click form and the breadcrumb form are equivalent.
  const level3 = drill({ minor: 'home|rent' }).data;
  assert.deepEqual(plain(level3.stat_cards), [
    { key: 'total', label: 'Total', value: 40, format: 'money', tone: 'negative' },
    { key: 'count', label: 'Transactions', value: 1, format: 'count' },
  ]);
  assert.deepEqual([level3.charts, level3.drill.title, level3.drill.rows.map(r => r.id), level3.drill.total_quote], [[], 'Home › Rent', [ID(50)], 40]);
  assert.deepEqual(plain(level3.drill.query.params), { range: 'custom', from: '2026-09-01', to: '2026-09-30', types: 'money-out', major: 'home', minor: 'rent' });
  assert.deepEqual(plain(level3.breadcrumbs.map(c => c.drill)), [null, { major: 'home' }, { major: 'home', minor: 'rent' }]);
  assert.deepEqual(plain(drill({ major: 'home', minor: 'rent' }).data.drill.rows), plain(level3.drill.rows));
  const blankMinor = drill({ minor: 'home|(none)' }).data.drill;
  assert.deepEqual([blankMinor.title, blankMinor.total_quote, blankMinor.query.params.minor], ['Home › Other', 25, undefined]);
  assert.equal(drill({ minor: '(none)|(none)' }).data.drill.query, null);

  // A minor without spend in the period falls back to its major; a missing
  // major or an inconsistent path is refused (the client then reloads level 1).
  assert.deepEqual(drill({ major: 'food', minor: 'takeaway' }).data.breadcrumbs.map(c => c.label), ['All categories', 'Food']);
  assert.equal(drill({ major: 'old' }).error, 'invalid_drill');
  assert.equal(drill({ major: 'food', minor: 'home|rent' }).error, 'invalid_drill');
  assert.equal(drill({}).error, 'invalid_drill');
  assert.equal(runtime.insight({ id: '11-category-drilldown', period: 'last_week', drill: JSON.stringify({ major: 'food' }) }).error, 'invalid_drill');
  assert.deepEqual(runtime.insight({ id: '11-category-drilldown', period: 'last_week' }).data.empty, { text: 'No spending data for this period.' });
});

// ── 12-tag-pie ────────────────────────────────────────────────────────────────

test('12-tag-pie golden: split attribution over distinct tags, untagged card, per-tag drill', () => {
  const runtime = fixture();
  const response = runtime.insight({ id: '12-tag-pie', period: 'this_month' });
  assert.deepEqual(response.warnings, []);
  const data = response.data;
  // 39: trip 60 · 37: trip/food 5+5 · 50 'Trip; trip ;Home': trip/home 20+20 ·
  // 52: home 25 · 51 untagged 15. Deleted (34) and transfer (35) tags ignored.
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'tags', label: 'Distinct tags', value: 3, format: 'count' },
    { key: 'tagged', label: 'Tagged spend', value: 135, format: 'money', sub: '4 of 5 expenses — tap a segment to drill' },
    { key: 'untagged', label: 'Untagged spend', value: 15, format: 'money', sub: '1 expense' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels, chart.datasets[0].data], ['donut', ['trip', 'home', 'food'], [85, 45, 5]]);
  assert.deepEqual([chart.drill.param, chart.drill.mode, chart.drill.values], ['tag', 'panel', ['trip', 'home', 'food']]);
  assert.deepEqual(data.tables[0].columns.map(c => c.key), ['tag', 'count', 'total', 'avg']);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.tag, r.cells.count, r.cells.total, Number(r.cells.avg.toFixed(2)), r.drill.value]),
    [['trip', 3, 85, 28.33, 'trip'], ['home', 2, 45, 22.5, 'home'], ['food', 1, 5, 5, 'food']]);
  assert.deepEqual(plain(data.notes), [{ text: 'A transaction with several tags is split equally between them.' }]);

  const drill = runtime.insight({ id: '12-tag-pie', period: 'this_month', drill: JSON.stringify({ tag: 'Trip' }) }).data.drill;
  assert.deepEqual([drill.title, drill.subtitle, drill.rows.map(r => r.id), drill.total_quote],
    ['Transactions tagged trip', '3 transactions (2 shared with other tags, split equally)', [ID(39), ID(37), ID(50)], 85]);
  assert.deepEqual(plain(drill.query.params), { range: 'custom', from: '2026-09-01', to: '2026-09-30', types: 'money-out', tag: 'trip' });
  assert.equal(runtime.insight({ id: '12-tag-pie', period: 'this_month', drill: JSON.stringify({ tag: 'nope' }) }).error, 'invalid_drill');
  assert.deepEqual(runtime.insight({ id: '12-tag-pie', period: 'last_week' }).data.empty, { text: 'No tagged transactions in this period.' });
});

test('12-tag-pie: tags beyond 7 merge into "Other tags" (not drillable); missing rates are reported', () => {
  const transactions = [
    ...Array.from({ length: 9 }, (_, i) => spendTx(70 + i, 9 - i, '2026-09-1' + i + ' 10:00:00', { tx_tags: 't' + (i + 1) })),
    spendTx(80, 5, '2026-09-20 10:00:00', { account_id: ID(14), tx_tags: 't1' }),   // USD, no rate
  ];
  const response = appRuntime({ transactions }).insight({ id: '12-tag-pie', period: 'this_month' });
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const chart = response.data.charts[0];
  assert.deepEqual([chart.labels.at(-1), chart.datasets[0].data, chart.drill.values.at(-1)], ['Other tags', [9, 8, 7, 6, 5, 4, 3, 3], null]);
  assert.equal(response.data.tables[0].rows.length, 9);
  assert.deepEqual(response.data.notes, []);
});

// ── 13-tag-trend ──────────────────────────────────────────────────────────────

test('13-tag-trend golden: monthly split share per tag, month / tag / tag+month drills', () => {
  const runtime = fixture();
  const data = runtime.insight({ id: '13-tag-trend' }).data;
  assert.deepEqual(plain(data.stat_cards), [
    { key: 'tags', label: 'Distinct tags', value: 3, format: 'count' },
    { key: 'top', label: 'Top tag', value: 85, format: 'money', sub: 'trip' },
    { key: 'untagged', label: 'Untagged spend', value: 115, format: 'money', sub: '2 of 7 expenses' },
  ]);
  const chart = data.charts[0];
  assert.deepEqual([chart.kind, chart.labels.length, chart.y_min], ['line', 6, 0]);
  assert.deepEqual(plain(chart.datasets), [
    { key: 'trip', label: 'trip', data: [0, 0, 0, 0, 0, 85], style: 'palette:0', hidden: false },
    { key: 'food', label: 'food', data: [0, 0, 0, 0, 45.5, 5], style: 'palette:1', hidden: false },
    { key: 'home', label: 'home', data: [0, 0, 0, 0, 0, 45], style: 'palette:2', hidden: false },
  ]);
  assert.deepEqual([chart.drill.param, chart.drill.mode, chart.drill.values], ['month', 'panel', ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']]);
  assert.deepEqual(data.tables[0].rows.map(r => [r.cells.tag, r.cells.count, r.cells.total, r.drill.param]), [['trip', 3, 85, 'tag'], ['food', 2, 50.5, 'tag'], ['home', 2, 45, 'tag']]);

  const drill = value => runtime.insight({ id: '13-tag-trend', drill: JSON.stringify(value) }).data.drill;
  const month = drill({ month: '2026-09' });
  assert.deepEqual([month.title, month.total_count, month.total_quote, month.rows.map(r => r.id)], ['Sep 26 — tagged spend', 4, 135, [ID(39), ID(37), ID(52), ID(50)]]);
  assert.deepEqual(month.table.rows.map(r => [r.cells.tag, r.cells.count, r.cells.total]), [['trip', 3, 85], ['home', 2, 45], ['food', 1, 5]]);
  assert.deepEqual(plain(month.query.params), { range: 'custom', from: '2026-09-01', to: '2026-09-30', types: 'money-out' });

  const tag = drill({ tag: 'food' });
  assert.deepEqual([tag.title, tag.subtitle, tag.total_quote, tag.rows.map(r => r.id)], ['food', '2 transactions (1 shared with other tags, split equally)', 50.5, [ID(37), ID(32)]]);
  assert.deepEqual([tag.charts[0].kind, tag.charts[0].datasets[0].data], ['bar', [0, 0, 0, 0, 45.5, 5]]);

  const point = drill({ tag: 'food', month: '2026-08' });
  assert.deepEqual([point.title, point.total_quote, point.rows.map(r => r.id)], ['food — Aug 26', 45.5, [ID(32)]]);
  assert.deepEqual(plain(point.query.params), { range: 'custom', from: '2026-08-01', to: '2026-08-31', types: 'money-out', tag: 'food' });

  for (const bad of [{ month: '2026-10' }, { tag: 'nope' }, { date: '2026-09-01' }]) {
    assert.equal(runtime.insight({ id: '13-tag-trend', drill: JSON.stringify(bad) }).error, 'invalid_drill', JSON.stringify(bad));
  }
});

test('13-tag-trend shows the top 6 tag lines and hides the rest', () => {
  const transactions = [spendTx(70, 70, '2026-09-10 10:00:00', { tx_tags: 'a;b;c;d;e;f;g' })];
  const data = appRuntime({ transactions }).insight({ id: '13-tag-trend' }).data;
  assert.deepEqual(data.charts[0].datasets.map(d => [d.label, d.hidden, d.data[5]]),
    [['a', false, 10], ['b', false, 10], ['c', false, 10], ['d', false, 10], ['e', false, 10], ['f', false, 10], ['g', true, 10]]);
  assert.equal(data.stat_cards[0].sub, 'top 6 shown');
});

// ── Drill queries round-trip to the Transactions list ─────────────────────────

test('drill "Open in Transactions" queries select every drilled row in list_transactions_view', () => {
  const runtime = fixture();
  const list = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', action: 'list_transactions_view', page_size: '50', ...params } }).getContent());
  const drills = [
    ['08-category-pie', { major: 'home' }],
    ['11-category-drilldown', { minor: 'home|rent' }],
    ['12-tag-pie', { tag: 'trip' }],
    ['13-tag-trend', { tag: 'food', month: '2026-08' }],
    ['13-tag-trend', { month: '2026-09' }],
  ];
  for (const [id, value] of drills) {
    const period = id === '13-tag-trend' ? 'last_6' : 'this_month';
    const drill = runtime.insight({ id, period, drill: JSON.stringify(value) }).data.drill;
    const response = list(drill.query.params);
    assert.equal(response.ok, true, id);
    const ids = new Set(response.data.rows.map(row => row.id));
    assert.ok(drill.rows.length > 0 && drill.rows.every(row => ids.has(row.id)), id + ' ' + JSON.stringify(value));
  }
  // A custom range starting mid-month clamps the tag+month pointer to the period.
  const mid = runtime.insight({ id: '13-tag-trend', period: 'custom', from: '2026-09-10', to: '2026-09-30', drill: JSON.stringify({ tag: 'trip', month: '2026-09' }) }).data.drill;
  assert.deepEqual([mid.query.params.from, mid.query.params.to, mid.total_quote], ['2026-09-10', '2026-09-30', 65]);
});
