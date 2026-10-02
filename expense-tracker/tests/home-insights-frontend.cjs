// Phase 4 (P4-A): home.js, the insights.js shell and insights/render-kinds.js
// only render server payloads. The payloads are produced by the real GAS code
// (get_home_view / get_insight on the view fixture), so this also checks the
// client against the server contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNTS, seedViewFixture } = require('./support/view-fixture.cjs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

const CSS = { '--teal': '#14b8a6', '--ember': '#e4572e', '--muted': '#888888', '--ink': '#111111', '--hair': '#dddddd', '--panel': '#ffffff' };

class FakeChart {
  constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; FakeChart.instances.push(this); }
  destroy() { this.destroyed = true; }
}
FakeChart.instances = [];

// Loads ES-module source files into one vm context (imports stripped, exports unwrapped).
function loadModules(files, globals, exposed, setup = '') {
  const source = files.map(file => read(file)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '')).join('\n');
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, esc, Chart: FakeChart, setImmediate,
    getComputedStyle: () => ({ getPropertyValue: name => CSS[name] ?? '' }),
    document: { documentElement: {}, dispatchEvent() {}, createElement: () => ({ className: '', innerHTML: '' }) },
    window: {}, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    AbortController, WeakMap, ...globals,
  });
  vm.runInContext(source + '\n' + setup + '\nglobalThis.exposed = {' + exposed.join(',') + '};', context);
  return context.exposed;
}

function server(overrides) {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  seedViewFixture(runtime, overrides);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', today: '2026-09-30', ...params } }).getContent());
  return runtime;
}

function element(id) {
  return { id, innerHTML: '', children: [], appendChild(child) { this.children.push(child); }, addEventListener() {}, querySelectorAll: () => [], classList: { toggle() {} } };
}

// ── Home ──────────────────────────────────────────────────────────────────────

const OWED = ACCOUNTS.map(account => (account.id === ID(13) ? { ...account, opening_value_local: -2000 } : account));

function loadHome(state, view) {
  const elements = {};
  const el = id => (elements[id] ??= element(id));
  const calls = [];
  const home = loadModules(['app/sections/insights/chart-theme.js', 'app/sections/home.js'], {
    state, el, shareSnapshot() {},
    ExpenseAPI: { view: async (action, params) => { calls.push([action, plain(params)]); return view(action, params); } },
  }, ['renderHome']);
  return { home, elements, calls };
}

test('home.js renders get_home_view as-is (figures, status label/colour, projection, chart series)', async () => {
  const response = server({ accounts: OWED }).get({ action: 'get_home_view' });
  FakeChart.instances = [];
  const state = { views: {} };
  const { home, elements, calls } = loadHome(state, async () => response);
  home.renderHome();
  assert.match(elements.homeContent.innerHTML, /Loading…/);
  await flush();
  assert.deepEqual(calls, [['get_home_view', {}]]);
  assert.equal(state.views.get_home_view, response);
  const html = elements.homeContent.innerHTML;
  assert.match(html, /17\.6%/);
  assert.match(html, /Excellent/);
  assert.match(html, /−£1,760/);          // total debt (server total_debt)
  assert.match(html, /2 yrs 6 mo/);        // debt_free.months = 30
  assert.match(html, /£60<\/span>/);       // monthly reduction
  assert.match(html, /Jul 26/);            // peak label from the server
  assert.match(html, /all time/);
  assert.match(html, /No exchange rate for <strong>USD<\/strong>/);
  const [income, gauge] = FakeChart.instances;
  assert.deepEqual(plain(income.config.data.labels), response.data.income.chart.labels);
  assert.deepEqual(plain(income.config.data.datasets[0].data), response.data.income.chart.income);
  assert.equal(income.config.data.datasets[0].backgroundColor[response.data.income.chart.peak_index], 'rgba(52,211,153,1)');
  assert.deepEqual(plain(gauge.config.data.datasets[0].data), [response.data.dti.gauge_value, 100 - response.data.dti.gauge_value]);
  assert.equal(gauge.config.data.datasets[0].backgroundColor[0], '#34d399');
});

test('home.js shows the last payload at once, then the server message on failure', async () => {
  const cached = server().get({ action: 'get_home_view' });
  const state = { views: { get_home_view: cached } };
  const { home, elements } = loadHome(state, async () => ({ ok: false, error: 'boom', message: 'Home is down.' }));
  home.renderHome();
  assert.match(elements.homeContent.innerHTML, /Debt-free/);
  await flush();
  assert.match(elements.homeContent.innerHTML, /Debt-free/);   // keeps the last good payload
  const fresh = loadHome({ views: {} }, async () => ({ ok: false, error: 'boom', message: 'Home is down.' }));
  fresh.home.renderHome();
  await flush();
  assert.match(fresh.elements.homeContent.innerHTML, /Home is down\./);
  const none = loadHome({ views: {} }, async () => server({ accounts: [], transactions: [] }).get({ action: 'get_home_view' }));
  none.home.renderHome();
  await flush();
  assert.match(none.elements.homeContent.innerHTML, /No data yet/);
});

test('home.js holds no business logic (no compute, thresholds, conversion or raw collections)', () => {
  const source = read('app/sections/home.js');
  for (const banned of ['_compute', 'toBase', 'state.transactions', 'state.accounts', 'computeDailyTotalAssets', 'sumAmountBase', '_dtiStatus', '< 20', '< 36', '< 50', 'insight-utils']) {
    assert.ok(!source.includes(banned), banned);
  }
});

// ── Insights shell ────────────────────────────────────────────────────────────

function loadShell(state, view, setup = '', extra = {}) {
  const elements = {};
  const el = id => (elements[id] ??= element(id));
  const calls = [], rendered = [], drills = [];
  const shell = loadModules(['app/sections/insights.js'], {
    state, el, shareSnapshot() {},
    renderInsightPayload: (container, data, sym, handlers) => { rendered.push({ container, data, sym, handlers }); return [new FakeChart(null, {})]; },
    renderInsightDrill: (container, data, sym) => { drills.push({ container, data, sym }); },
    ExpenseAPI: { view: async (action, params) => { calls.push([action, plain(params)]); return view(action, params); } },
    ...extra,
  }, ['renderInsights'], setup);
  return { shell, elements, calls, rendered, drills };
}

function shellState(runtime, extra = {}) {
  const context = runtime.get({ action: 'get_app_context' }).data;
  return { context, views: {}, insightId: '29-daily-spend', insightPeriod: 'last_3', insightCustomFrom: '', insightCustomTo: '', insightTab: 'transactions',
    insightDrill: null, insightParams: {}, quoteCurrency: 'GBP', ...extra };
}

test('insights.js: server insights request get_insight from UI state and hand the payload to the renderer', async () => {
  const runtime = server();
  const state = shellState(runtime);
  const { shell, elements, calls, rendered, drills } = loadShell(state, async (action, params) => runtime.get({ action, ...params, drill: params.drill ? JSON.stringify(params.drill) : '' }));
  shell.renderInsights();
  await flush(); await flush();
  // last_3 is not offered by 29 → snapped to its default period.
  assert.equal(state.insightPeriod, 'last_30');
  assert.deepEqual(calls, [['get_insight', { id: '29-daily-spend', period: 'last_30' }]]);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].container, elements.insightChart);
  assert.equal(rendered[0].sym, '£');
  assert.equal(rendered[0].data.insight_id, '29-daily-spend');
  assert.equal(rendered[0].data.stat_cards[0].value, 70);
  assert.match(elements.insightContent.innerHTML, /Daily spend \(with payments\)/);
  assert.doesNotMatch(elements.insightContent.innerHTML, /insightModeSelect|Pre-Computed/);
  // Panel drill: re-request with the drill, re-render only the drill panel.
  rendered[0].handlers.onDrill({ date: '2026-09-20' }, 'panel');
  await flush(); await flush();
  assert.deepEqual(calls[1], ['get_insight', { id: '29-daily-spend', period: 'last_30', drill: { date: '2026-09-20' } }]);
  assert.equal(drills.length, 1);
  assert.equal(drills[0].data.drill.rows[0].id, ID(37));
  assert.equal(rendered.length, 1);
  // Controls and sort become params; the drill is cleared.
  rendered[0].handlers.onControl('window', '7');
  await flush(); await flush();
  assert.deepEqual(calls[2], ['get_insight', { id: '29-daily-spend', window: '7', period: 'last_30' }]);
  rendered[1].handlers.onSort('amount');
  await flush(); await flush();
  assert.deepEqual(calls[3][1], { id: '29-daily-spend', window: '7', sort: 'amount', sort_dir: 'desc', period: 'last_30' });
  // Open in Transactions: deep link via state.filters.
  rendered[2].handlers.onOpenTransactions({ params: { range: 'custom', from: '2026-09-20', to: '2026-09-20', types: 'money-out' } });
  assert.deepEqual(plain(state.filters), { range: 'custom', from: '2026-09-20', to: '2026-09-20', types: 'money-out' });
});

test('insights.js: server errors show the server message; a stale drill is dropped once', async () => {
  const runtime = server();
  const state = shellState(runtime, { insightPeriod: 'this_month', insightDrill: { date: '2026-01-01' } });
  const { shell, elements, calls, rendered } = loadShell(state, async (action, params) => runtime.get({ action, ...params, drill: params.drill ? JSON.stringify(params.drill) : '' }));
  shell.renderInsights();
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(calls.map(call => call[1].drill ?? null), [{ date: '2026-01-01' }, null]);
  assert.equal(state.insightDrill, null);
  assert.equal(rendered.length, 1);
  const failing = loadShell(shellState(runtime), async () => ({ ok: false, error: 'insight_failed', message: 'This insight could not be computed. Refresh and try again.' }));
  failing.shell.renderInsights();
  await flush(); await flush();
  assert.match(failing.elements.insightInner.innerHTML, /could not be computed/);
  assert.ok(elements.insightChart);
});

test('every registered insight is server-computed and the shell has no client insight path', () => {
  const registry = server().get({ action: 'get_app_context' }).data.nav.insights_registry;
  assert.equal(registry.length, 30);
  for (const entry of registry) assert.equal(entry.server, true, entry.id);
  const source = read('app/sections/insights.js');
  for (const banned of ['import(', 'insight-utils', 'getPeriodBounds', 'filterTxByRange', 'findMissingRates', 'state.transactions', 'state.accounts', 'insightChartInstance', 'server !== true', '_renderLegacy'])
    assert.ok(!source.includes(banned), banned);
  assert.deepEqual(fs.readdirSync(path.join(root, 'app/sections/insights')).sort(), ['chart-theme.js', 'render-kinds.js']);
});

test('insights.js has no precomputed/live toggle, local registry or payload math', () => {
  const source = read('app/sections/insights.js');
  for (const banned of ['insightMode', 'precomputed', 'getComputedInsights', '_renderFromPayload', 'const INSIGHTS', 'sumAmountBase', 'toBase']) assert.ok(!source.includes(banned), banned);
  assert.ok(!fs.existsSync(path.join(root, 'app/sections/insights/18-income-vs-expenses.js')));
  for (const ported of ['10-top-categories', '29-daily-spend', '30-daily-spend-no-payments']) assert.ok(!fs.existsSync(path.join(root, `app/sections/insights/${ported}.js`)), ported);
});

// ── Generic renderer ──────────────────────────────────────────────────────────

function loadRenderer() {
  return loadModules(['app/sections/insights/chart-theme.js', 'app/sections/insights/render-kinds.js'], {}, ['renderInsightPayload', 'renderInsightDrill', 'chartConfig', 'fmtValue', 'getCssColors']);
}

function container() {
  const box = element('insightChart');
  box.contains = () => true;
  box.querySelectorAll = selector => {
    if (selector !== 'canvas[data-chart-index]') return [];
    return [...box.innerHTML.matchAll(/data-chart-index="(\d+)"/g)].map(match => ({ dataset: { chartIndex: match[1] }, parentElement: null }));
  };
  box.querySelector = () => null;
  return box;
}

test('render-kinds: stat cards, bar chart tones and the drill click come straight from the payload', () => {
  const runtime = server();
  const data = runtime.get({ action: 'get_insight', id: '29-daily-spend', period: 'this_month', drill: JSON.stringify({ date: '2026-09-20' }) }).data;
  const r = loadRenderer();
  FakeChart.instances = [];
  const box = container();
  const drills = [];
  const charts = r.renderInsightPayload(box, data, '£', { onDrill: (drill, mode) => drills.push([plain(drill), mode]) });
  assert.equal(charts.length, 1);
  const html = box.innerHTML;
  for (const text of ['Total spend', '£70', 'Avg / spend day', '£35', '29 Sep', '2 / 30', 'Tap a bar', '20 Sep', '1 transaction', '£10.00', 'Food → Groceries', 'Open in Transactions']) assert.ok(html.includes(text), text);
  const config = charts[0].config;
  assert.equal(config.type, 'bar');
  assert.deepEqual(plain(config.data.labels), data.charts[0].labels);
  assert.equal(config.data.datasets[0].backgroundColor[19], '#14b8a6cc');
  assert.equal(config.data.datasets[0].backgroundColor[0], '#dddddd');
  assert.equal(config.options.scales.y.min, 0);
  config.options.onClick(null, [{ index: 19 }]);
  assert.deepEqual(drills, [[{ date: '2026-09-20' }, 'panel']]);
});

test('render-kinds: hbar with compare dataset and a delta table; empty payloads', () => {
  const runtime = server();
  const data = runtime.get({ action: 'get_insight', id: '10-top-categories', period: 'last_3' }).data;
  const r = loadRenderer();
  const box = container();
  const [chart] = r.renderInsightPayload(box, data, '£', {});
  assert.equal(chart.config.options.indexAxis, 'y');
  assert.deepEqual(plain(chart.config.data.datasets.map(d => d.backgroundColor)), ['#14b8a6', '#f59e0b']);
  assert.match(box.innerHTML, /Change vs Apr 26 – Jun 26/);
  assert.match(box.innerHTML, /class="drill-td negative"[^>]*>\+£1[56]</);
  const empty = runtime.get({ action: 'get_insight', id: '10-top-categories', period: 'last_week' }).data;
  const emptyBox = container();
  assert.deepEqual(plain(r.renderInsightPayload(emptyBox, empty, '£', {})), []);
  assert.match(emptyBox.innerHTML, /No spending data for this period\./);
});

test('render-kinds: chart kinds (donut, gauge, waterfall, mixed with ref lines and y2) are config only', () => {
  const r = loadRenderer();
  const C = r.getCssColors();
  const donut = r.chartConfig({ kind: 'donut', labels: ['A', 'B'], datasets: [{ key: 'v', label: 'Spend', data: [3, 1], style: 'palette' }] }, '£', C);
  assert.equal(donut.type, 'doughnut');
  assert.deepEqual(plain(donut.data.datasets[0].backgroundColor), ['#14b8a6', '#f59e0b']);
  const gauge = r.chartConfig({ kind: 'gauge', gauge: { value: 140, max: 100, tone: 'negative' } }, '£', C);
  assert.deepEqual(plain([gauge.data.datasets[0].data, gauge.options.circumference, gauge.data.datasets[0].backgroundColor[0]]), [[100, 0], 180, '#f87171']);
  const waterfall = r.chartConfig({ kind: 'waterfall', labels: ['Open', 'In'], datasets: [{ key: 'w', label: 'Amount', data: [[0, 100], [100, 150]], point_tones: ['muted', 'positive'] }] }, '£', C);
  assert.deepEqual(plain(waterfall.data.datasets[0].data), [[0, 100], [100, 150]]);
  assert.equal(waterfall.options.plugins.tooltip.callbacks.label({ raw: [100, 150] }), '  £50');
  const mixed = r.chartConfig({ kind: 'mixed', labels: ['Jan', 'Feb'], y_format: 'money', y2_format: 'percent',
    datasets: [{ key: 'in', label: 'Income', data: [1, 2], style: 'income' }, { key: 'rate', label: 'Rate', data: [10, 20], kind: 'line', axis: 'y2', style: 'savings' }],
    ref_lines: [{ value: 20, label: 'Target', tone: 'warn', axis: 'y2' }] }, '£', C);
  assert.deepEqual(plain(mixed.data.datasets.map(d => [d.type, d.yAxisID])), [['bar', 'y'], ['line', 'y2'], ['line', 'y2']]);
  assert.deepEqual(plain(mixed.data.datasets[2].data), [20, 20]);
  assert.equal(mixed.options.scales.y2.position, 'right');
  assert.equal(mixed.options.scales.y2.ticks.callback(20), '20%');
});

test('render-kinds: drill panels draw their own charts (replaced and destroyed per drill), progress cells, y_max', () => {
  const r = loadRenderer();
  FakeChart.instances = [];
  const box = container();
  const slot = { innerHTML: '', scrollIntoView() {}, querySelectorAll: selector => (selector === 'canvas[data-drill-chart-index]'
    ? [...slot.innerHTML.matchAll(/data-drill-chart-index="(\d+)"/g)].map(match => ({ dataset: { drillChartIndex: match[1] }, parentElement: null })) : []) };
  box.querySelector = selector => (selector === '[data-role="insight-drill"]' ? slot : null);
  const trend = { kind: 'bar', labels: ['Aug 26', 'Sep 26'], datasets: [{ key: 'spend', label: 'Spend', data: [5, 9], style: 'primary' }], y_format: 'money', y_max: 20 };
  const data = {
    stat_cards: [], charts: [], drill: null, notes: [], breadcrumbs: [], controls: [],
    tables: [{ id: 'loans', columns: [{ key: 'name', label: 'Loan', format: 'text' }, { key: 'paid', label: 'Paid', format: 'progress' }],
      rows: [{ key: 'a', cells: { name: 'Car', paid: 42.5 }, drill: { param: 'account_id', value: 'a', mode: 'panel' } }], sortable: [], sort: null }],
  };
  assert.deepEqual(plain(r.renderInsightPayload(box, data, '£', {})), []);
  assert.match(box.innerHTML, /width:42\.5%/);
  assert.match(box.innerHTML, /42\.5%<\/span>/);
  assert.match(box.innerHTML, /data-action="insight-row-drill" data-table="0" data-row="0"/);
  const first = r.renderInsightDrill(box, { drill: { title: 'Car', subtitle: '2 repayments', rows: [], total_count: 2, shown_count: 0, charts: [trend] } }, '£');
  assert.equal(first.length, 1);
  assert.equal(first[0].config.options.scales.y.max, 20);
  assert.doesNotMatch(slot.innerHTML, /No transactions/);   // a chart-only drill shows no empty table
  const second = r.renderInsightDrill(box, { drill: { title: 'Van', rows: [], charts: [trend, trend] } }, '£');
  assert.equal(first[0].destroyed, true);
  assert.equal(second.length, 2);
});

test('render-kinds: series drills send the clicked line key; null drill values show the server note', () => {
  const r = loadRenderer();
  const C = r.getCssColors();
  const drills = [];
  const chart = { kind: 'line', labels: ['Aug 26', 'Sep 26'], y_format: 'money',
    datasets: [{ key: 'food', label: 'food', data: [1, 2] }, { key: 'work', label: 'work', data: [3, 4] }],
    ref_lines: [{ value: 2, label: 'Avg', tone: 'muted' }],
    drill: { param: 'month', series_param: 'tag', values: ['2026-08', '2026-09'], mode: 'panel' } };
  const config = r.chartConfig(chart, '£', C, (drill, mode) => drills.push([plain(drill), mode]));
  const instance = hits => ({ getElementsAtEventForMode: () => hits });
  // A point on the second line: month + that series' key (not dataset 0).
  config.options.onClick({}, [{ index: 1, datasetIndex: 0 }], instance([{ index: 1, datasetIndex: 1 }]));
  // Off the lines: month only. On a reference line: month only.
  config.options.onClick({}, [{ index: 0, datasetIndex: 0 }], instance([]));
  config.options.onClick({}, [{ index: 0, datasetIndex: 0 }], instance([{ index: 0, datasetIndex: 2 }]));
  assert.deepEqual(drills, [[{ month: '2026-09', tag: 'work' }, 'panel'], [{ month: '2026-08' }, 'panel'], [{ month: '2026-08' }, 'panel']]);
  // Without series_param the first element's index is used as before.
  const plainDrills = [];
  const byIndex = r.chartConfig({ ...chart, drill: { param: 'month', values: ['2026-08', '2026-09'] } }, '£', C, drill => plainDrills.push(plain(drill)));
  byIndex.options.onClick({}, [{ index: 1, datasetIndex: 1 }], instance([]));
  assert.deepEqual(plainDrills, [{ month: '2026-09' }]);
  // A null value (an 'Other' bucket) does not drill and reveals the note rendered under the chart.
  const box = container();
  const noteChart = { kind: 'donut', labels: ['a', 'Other tags'], datasets: [{ key: 'spend', label: 'Spend', data: [2, 1], style: 'palette' }],
    drill: { param: 'tag', values: ['a', null], mode: 'panel', hint: 'Tap a tag', null_text: 'Other tags groups the smaller tags.' } };
  r.renderInsightPayload(box, { stat_cards: [], charts: [noteChart], tables: [], notes: [], breadcrumbs: [], controls: [], drill: null }, '£', {});
  assert.match(box.innerHTML, /class="hidden" data-role="chart-drill-note"[^>]*><em>Other tags groups the smaller tags\.<\/em>/);
  const toggles = [];
  const note = { dataset: { role: 'chart-drill-note' }, classList: { toggle: (name, on) => toggles.push([name, on]) } };
  const hint = { dataset: {}, nextElementSibling: note };
  const canvas = { closest: () => ({ nextElementSibling: hint }) };
  const donutDrills = [];
  const donut = r.chartConfig(noteChart, '£', C, drill => donutDrills.push(plain(drill)));
  donut.options.onClick({}, [{ index: 1, datasetIndex: 0 }], { canvas });
  donut.options.onClick({}, [{ index: 0, datasetIndex: 0 }], { canvas });
  assert.deepEqual(donutDrills, [{ tag: 'a' }]);
  assert.deepEqual(toggles, [['hidden', false], ['hidden', true]]);
});

test('fmtTick keeps pence on small money2 axes', () => {
  const { fmtTick } = loadModules(['app/sections/insights/chart-theme.js'], {}, ['fmtTick']);
  assert.deepEqual([fmtTick(1.25, 'money2', '£'), fmtTick(-0.5, 'money2', '£'), fmtTick(250.4, 'money2', '£'), fmtTick(1500, 'money2', '£'), fmtTick(1.25, 'money', '£')],
    ['£1.25', '−£0.5', '£250', '£2k', '£1']);
});

test('fmtValue formats server values by format key only', () => {
  const { fmtValue } = loadRenderer();
  assert.deepEqual([
    fmtValue(-1234.4, 'money', '£'), fmtValue(12.345, 'money2', '£'), fmtValue(-5, 'money_delta', '£'), fmtValue(5, 'money_delta', '£'),
    fmtValue(17.64, 'percent', '£'), fmtValue(3, 'days', '£'), fmtValue('2 / 30', 'text', '£'), fmtValue(null, 'money', '£'), fmtValue(1200, 'count', '£'),
  ], ['−£1,234', '£12.35', '−£5', '+£5', '17.6%', '3 days', '2 / 30', '—', '1,200']);
});
