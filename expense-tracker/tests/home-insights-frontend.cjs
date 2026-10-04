// Task 15: home.js (configurable dashboard) and the generic report renderer
// (sections/reports/render-kinds.js + chart-theme.js) only render published
// payloads. Payloads are published into mock Sheets exactly as the analytics
// job lays them out and read back through the real GAS views (get_home_view,
// get_dashboard_layout, get_report), so the client is checked against the
// server contract. Nothing is computed in the browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, read, flush, plain, FakeChart, fakeDom, loadModules, appServer, loadApi, loadUtils } = require('./support/frontend-harness.cjs');
const { publish, payload, predefinedId, CONTRACT } = require('./support/report-publish.cjs');

const { fmtAsOf } = loadUtils();
const PUBLISHED_AT = '2026-09-30T06:00:00.000Z';
const ID = predefinedId;

// The browser's own short month (ICU: 'Sep' or 'Sept').
const MONTH_SEP_26 = new Date(2026, 8, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

const tile = (label, grams, extra = {}) => payload({ stat_cards: [{ key: 'value', label, value: grams, format: 'money', ...extra }] });
const bars = (labels, grams) => payload({ charts: [{ id: 'c', kind: 'bar', labels, datasets: [{ key: 'v', label: 'Income', data: grams, style: 'income' }], y_format: 'money', ref_lines: [],
  drill: { param: 'month', values: labels, mode: 'panel', hint: 'Tap a month' } }] });

// The default layout with published payloads: two tiles ready, one failed, one not published.
function publishedHome(runtime) {
  publish(runtime.sheets, {
    published_at: PUBLISHED_AT,
    outputs: [
      { report_id: ID('kpi-net-worth'), payload: tile('Net worth', 40.5, { tone: 'positive', sub: { text: '{0} on last month', values: [{ value: 1.5, format: 'money_delta' }] } }) },
      { report_id: ID('kpi-total-assets'), payload: tile('Total assets', 50) },
      { report_id: ID('home-income-trend'), payload: bars(['Aug 26', 'Sep 26'], [10, 12.5]) },
      { report_id: ID('home-debt-to-income'), payload: payload({ charts: [{ id: 'g', kind: 'gauge', labels: [], datasets: [], y_format: 'percent', ref_lines: [],
        gauge: { value: 17.6, max: 100, tone: 'positive', label: { text: '{0}', values: [{ value: 17.6, format: 'percent' }] }, sub: 'Excellent' } }] }) },
      { report_id: ID('08-category-pie'), payload: payload({ empty: { text: 'No spending in this period.' } }) },
    ],
    results: [
      { report_id: ID('kpi-net-worth'), status: 'ready' }, { report_id: ID('kpi-total-assets'), status: 'ready' },
      { report_id: ID('kpi-total-liabilities'), status: 'failed', error_code: 'missing_rate' },
      { report_id: ID('home-income-trend'), status: 'ready' }, { report_id: ID('home-debt-to-income'), status: 'ready' }, { report_id: ID('08-category-pie'), status: 'ready' },
    ],
  });
}

function homeApp(runtime, { stateExtra = {}, wrapView } = {}) {
  const dom = fakeDom();
  const state = { views: {}, homeCustomise: null, quoteCurrency: 'GBP', ...stateExtra };
  const messages = [], events = [];
  const api = loadApi(runtime, state);
  const ExpenseAPI = wrapView ? { ...api, view: (action, params) => api.view(action, params).then(response => wrapView(action, response)) } : api;
  const home = loadModules(['app/sections/reports/chart-theme.js', 'app/sections/reports/render-kinds.js', 'app/sections/reports/viewer.js', 'app/sections/home.js'], {
    state, el: dom.el, fmtAsOf, shareSnapshot() {}, ExpenseAPI, showLoading() {}, hideLoading() {},
    showMsg: (text, kind) => messages.push([text, kind ?? 'success']),
    document: { documentElement: {}, dispatchEvent: event => events.push(event.type) },
  }, ['renderHome']);
  const html = () => dom.el('homeContent').innerHTML;
  const click = dataset => dom.fire('homeContent', 'click', dataset);
  return { home, dom, state, messages, events, html, click };
}

// ── Home ──────────────────────────────────────────────────────────────────────

test('home renders 4 number tiles and 4 compact panels from get_home_view (converted values, Text, statuses, As of)', async () => {
  const runtime = appServer();
  publishedHome(runtime);
  FakeChart.instances = [];
  const app = homeApp(runtime);
  app.home.renderHome();
  assert.match(app.html(), /Loading…/);
  await flush();
  assert.deepEqual(runtime.calls.map(call => call[1].action), ['get_home_view']);
  const html = app.html();
  assert.equal((html.match(/class="home-tile[ "]/g) ?? []).length, 4);
  assert.equal((html.match(/class="home-panel[ "]/g) ?? []).length, 4);
  // 40.5 g × 80 (GBP rate) = £3,240, converted by GAS; the browser formats only.
  assert.match(html, /Net worth<\/div>\s*<div class="home-tile-value positive">£3,240<\/div>\s*<div class="home-tile-sub">\+£120 on last month<\/div>/);
  assert.match(html, /Total assets<\/div>\s*<div class="home-tile-value ">£4,000<\/div>/);
  assert.match(html, /Total liabilities<\/div>\s*<div class="home-tile-value ">—<\/div>\s*<div class="home-tile-sub">This report could not be computed \(missing_rate\)\.<\/div>/);
  assert.match(html, /Reports appear after the next refresh\./);   // kpi-monthly-income has no payload
  assert.match(html, /Income trend/);
  assert.ok(html.includes(`As of ${fmtAsOf(PUBLISHED_AT)}`));
  assert.doesNotMatch(html, /Customise dashboard|Save layout/);
  // Panels: charts only, fixed height, no drill hint and no click-through.
  const income = app.dom.el('homePanelBody_panel_1').innerHTML;
  assert.match(income, /height:190px/);
  assert.doesNotMatch(income, /Tap a month/);
  assert.match(app.dom.el('homePanelBody_panel_2').innerHTML, /17\.6%[\s\S]*Excellent/);
  assert.match(app.dom.el('homePanelBody_panel_4').innerHTML, /No spending in this period\./);
  const [bar, gauge] = FakeChart.instances;
  assert.deepEqual(plain(bar.config.data.datasets[0].data), [800, 1000]);
  assert.equal(bar.config.options.onClick, undefined);
  assert.deepEqual(plain(gauge.config.data.datasets[0].data), [17.6, 82.4]);
});

test('home shows the last payload at once, keeps it on a failed refresh, and says when nothing is published', async () => {
  const runtime = appServer();
  publishedHome(runtime);
  const cached = runtime.get({ action: 'get_home_view' });
  const failing = homeApp(runtime, { stateExtra: { views: { get_home_view: cached } }, wrapView: () => ({ ok: false, error: 'boom', message: 'Home is down.' }) });
  failing.home.renderHome();
  assert.match(failing.html(), /£3,240/);
  await flush();
  assert.match(failing.html(), /£3,240/);
  const fresh = homeApp(runtime, { wrapView: () => ({ ok: false, error: 'boom', message: 'Home is down.' }) });
  fresh.home.renderHome();
  await flush();
  assert.match(fresh.html(), /Home is down\./);
  const nothing = homeApp(appServer());
  nothing.home.renderHome();
  await flush();
  const html = nothing.html();
  assert.match(html, /<div class="insight-warn">Reports appear after the next refresh\.<\/div>/);
  assert.equal((html.match(/home-tile-value ">—</g) ?? []).length, 4);
  assert.doesNotMatch(html, /As of/);
});

test('customise: change through the searchable picker, remove, move, cancel, then save posts all 8 slots', async () => {
  const runtime = appServer();
  publishedHome(runtime);
  const app = homeApp(runtime);
  app.home.renderHome();
  await flush();
  const before = plain(runtime.ctx.readDashboardLayout().slots);
  app.click({ action: 'home-customise' });
  await flush();
  assert.equal(runtime.calls.at(-1)[1].action, 'get_dashboard_layout');
  assert.match(app.html(), /Customise dashboard/);
  assert.match(app.html(), /Save layout/);
  assert.match(app.html(), /Reset to default/, 'the layout view offers the default slots');
  // Remove tile 2, move panel 1 later, change tile 2 through the picker.
  app.click({ action: 'home-remove', slot: 'tile_2' });
  assert.match(app.html(), /data-action="home-pick" data-slot="tile_2">\+ Add number/);
  app.click({ action: 'home-move', slot: 'panel_1', step: '1' });
  app.click({ action: 'home-pick', slot: 'tile_2' });
  let html = app.html();
  assert.match(html, /Choose a number for tile 2/);
  assert.match(html, /<span>Net worth<\/span><span class="field-hint">Already on Home<\/span>/);
  assert.match(html, /data-id="[^"]+" disabled>\s*<span>Net worth/);
  assert.doesNotMatch(html.slice(html.indexOf('homePickerList'), html.indexOf('Tiles take single-number')), /Income trend/, 'tiles offer number reports only');
  app.dom.fire('homeContent', 'input', { id: 'homePickerSearch', value: 'DEBT' });
  const list = app.dom.el('homePickerList').innerHTML;
  assert.match(list, /Total debt/);
  assert.doesNotMatch(list, /Net worth/);
  assert.equal(app.html(), html, 'searching re-renders only the option list');
  app.click({ action: 'home-choose', id: ID('kpi-total-debt') });
  // Cancel discards the draft.
  app.click({ action: 'home-cancel' });
  assert.equal(app.state.homeCustomise, null);
  assert.match(app.html(), /Your dashboard/);
  assert.equal(runtime.calls.filter(call => call[0] === 'POST').length, 0);
  // Again, then save.
  app.click({ action: 'home-customise' });
  await flush();
  app.click({ action: 'home-pick', slot: 'tile_2' });
  app.click({ action: 'home-choose', id: ID('kpi-total-debt') });
  app.click({ action: 'home-remove', slot: 'tile_4' });
  app.click({ action: 'home-move', slot: 'panel_1', step: '1' });
  app.click({ action: 'home-move', slot: 'panel_4', step: '1' });   // last panel: no later slot
  app.click({ action: 'home-save' });
  await flush();
  const post = runtime.calls.find(call => call[0] === 'POST');
  assert.equal(post[1].action, 'update_dashboard_layout');
  assert.deepEqual(post[1].slots, {
    tile_1: before.tile_1, tile_2: ID('kpi-total-debt'), tile_3: before.tile_3, tile_4: '',
    panel_1: before.panel_2, panel_2: before.panel_1, panel_3: before.panel_3, panel_4: before.panel_4,
  });
  assert.deepEqual(plain(runtime.ctx.readDashboardLayout().slots), post[1].slots);
  assert.deepEqual(app.messages.at(-1), ['Dashboard saved.', 'success']);
  assert.deepEqual(app.events, ['et:reload']);
  assert.equal(app.state.homeCustomise, null);
});

test('customise: a server refusal stays in edit mode with its message; Reset applies server defaults when offered', async () => {
  const runtime = appServer();
  const number = runtime.ctx.createReport({ report_name: 'Spend number', measure: 'spend', period_preset: 'this_month', chart_kind: 'number' }).id;
  const defaults = { tile_1: ID('kpi-net-worth'), tile_2: ID('kpi-total-assets'), tile_3: ID('kpi-total-liabilities'), tile_4: ID('kpi-monthly-income'),
    panel_1: ID('home-income-trend'), panel_2: ID('home-debt-to-income'), panel_3: ID('14-networth-trend'), panel_4: ID('08-category-pie') };
  const app = homeApp(runtime, { wrapView: (action, response) => (action === 'get_dashboard_layout' ? { ...response, data: { ...response.data, default_slots: defaults } } : response) });
  app.home.renderHome();
  await flush();
  app.click({ action: 'home-customise' });
  await flush();
  app.click({ action: 'home-pick', slot: 'tile_4' });
  assert.match(app.html(), /My reports[\s\S]*Spend number/);
  app.click({ action: 'home-choose', id: number });
  assert.match(app.html(), /Spend number[\s\S]*Shown after you save the layout\./);
  // Reset (server defaults) puts the contract layout back into the draft.
  assert.match(app.html(), /Reset to default/);
  app.click({ action: 'home-reset' });
  assert.equal(app.state.homeCustomise.slots.tile_4.report_id, defaults.tile_4);
  assert.equal(app.state.homeCustomise.slots.tile_4.title, 'Monthly income');
  // The chosen report is deleted on the server before the save: the refusal is shown.
  app.click({ action: 'home-pick', slot: 'tile_4' });
  app.click({ action: 'home-choose', id: number });
  const rowNum = runtime.sheets.find(sheet => sheet.name === 'report_master').rows.findIndex(row => row[0] === number) + 1;
  runtime.ctx.deleteReport({ row_num: rowNum });
  app.click({ action: 'home-save' });
  await flush();
  assert.match(app.html(), /<p class="pin-error" role="alert">This report has been deleted\.<\/p>/);
  assert.match(app.html(), /Customise dashboard/);
  assert.deepEqual(app.events, []);
});

test('home layout: tiles 1×4 and panels 2×2 on desktop; tiles 2×2 and panels stacked on mobile', () => {
  const css = read('app/style/expense-tracker.css');
  assert.match(css, /\.home-tiles \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.home-panels \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  const mobile = css.slice(css.indexOf('.home-option[disabled]'));
  assert.match(mobile, /@media \(max-width: 640px\) \{\s*\.home-tiles  \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s*\.home-panels \{ grid-template-columns: 1fr; \}/);
});

test('home.js holds no business logic (no compute, conversion, thresholds or collections)', () => {
  const source = read('app/sections/home.js');
  for (const banned of ['.reduce(', '.sort(', 'toBase', 'rate *', 'state.transactions', 'state.accounts', 'dti', 'has_data', 'insight-utils']) assert.ok(!source.includes(banned), banned);
});

// ── Generic renderer ──────────────────────────────────────────────────────────

function loadRenderer() {
  return loadModules(['app/sections/reports/chart-theme.js', 'app/sections/reports/render-kinds.js'], {},
    ['renderInsightPayload', 'renderInsightDrill', 'renderCompactPayload', 'chartConfig', 'fmtValue', 'fmtText', 'fmtTick', 'getCssColors']);
}

test('fmtValue / fmtText format server values by format key only; Text placeholders are filled', () => {
  const { fmtValue, fmtText } = loadRenderer();
  assert.deepEqual([
    fmtValue(-1234.4, 'money', '£'), fmtValue(12.345, 'money2', '£'), fmtValue(-5, 'money_delta', '£'), fmtValue(5, 'money_delta', '£'),
    fmtValue(17.64, 'percent', '£'), fmtValue(42.5, 'progress', '£'), fmtValue(3, 'days', '£'), fmtValue('2 / 30', 'text', '£'), fmtValue(null, 'money', '£'),
    fmtValue(1200, 'count', '£'), fmtValue('2026-09', 'month', '£'), fmtValue(-1234.5, 'local', '£'), fmtValue(250, 'local', '£', 'USD'),
  ], ['−£1,234', '£12.35', '−£5', '+£5', '17.6%', '42.5%', '3 days', '2 / 30', '—', '1,200', MONTH_SEP_26, '−1,234.50', '250.00 USD']);
  assert.match(fmtValue('2026-09-30', 'date', '£'), /^30 Sept? 2026$/);
  assert.equal(fmtText({ text: '{0} vs {1} ({2})', values: [{ value: 120, format: 'money_delta' }, { value: '2026-09', format: 'month' }, { value: 12.5, format: 'percent_delta' }] }, '£'), `+£120 vs ${MONTH_SEP_26} (+12.5%)`);
  assert.equal(fmtText('plain', '£'), 'plain');
  assert.equal(fmtText({ text: '{1} missing', values: [] }, '£'), '{1} missing');
  assert.equal(fmtText({ text: 'No rate {0}', values: [{ value: null, format: 'money' }] }, '£'), 'No rate —');
});

test('fmtTick keeps pence on small money2 axes', () => {
  const { fmtTick } = loadRenderer();
  assert.deepEqual([fmtTick(1.25, 'money2', '£'), fmtTick(-0.5, 'money2', '£'), fmtTick(250.4, 'money2', '£'), fmtTick(1500, 'money2', '£'), fmtTick(1.25, 'money', '£')],
    ['£1.25', '−£0.5', '£250', '£2k', '£1']);
});

function box(dom, id = 'reportViewerChart') {
  return dom.el(id);
}

test('the Python payload fixture, read through get_report, renders converted Text, local cells and the drill panel', () => {
  const runtime = appServer();
  const fixture = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'fixtures/payload-conversion.json'), 'utf8')).payload;
  const reportId = ID('22-top-counterparties');
  fixture.stat_cards[1].sub = { text: '<b>{0}</b> & more', values: [{ value: 2, format: 'count' }] };
  publish(runtime.sheets, { outputs: [{ report_id: reportId, payload: fixture }] });
  const response = runtime.get({ action: 'get_report', id: reportId });
  const r = loadRenderer();
  const dom = fakeDom();
  FakeChart.instances = [];
  r.renderInsightPayload(box(dom), response.data.payload, response.quote.symbol, {});
  const html = box(dom).innerHTML;
  assert.ok(html.includes(`<p class="stat-card-sub">+£120 vs ${MONTH_SEP_26} (+12.5%)</p>`));   // 1.5 g × 80
  assert.match(html, /<p class="stat-card-sub">&lt;b&gt;2&lt;\/b&gt; &amp; more<\/p>/);
  assert.match(html, />£60 a month</);                     // 0.75 g × 80 inside a table cell Text
  assert.match(html, /text-align:right">250\.00</);        // local: not converted, no currency cell → plain number
  assert.match(html, /Balances on 30 Sept? 2026/);
  assert.match(html, /£720 in total/);                    // drill subtitle Text: 9 g × 80
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.equal(FakeChart.instances[0].config.data.datasets[0].data[0], 100);   // 1.25 g × 80
});

test('render-kinds: local cells use the row currency; tabs, controls, crumbs and row drills call the handlers', () => {
  const r = loadRenderer();
  const dom = fakeDom();
  const container = box(dom);
  const calls = [];
  const data = payload({
    tabs: [{ key: 'transactions', label: 'Transactions', active: true }, { key: 'accounts', label: 'Accounts', active: false }],
    controls: [{ param: 'window', label: 'Smoothing', value: 30, options: [{ value: 7, label: '7d' }, { value: 30, label: '30d' }] }],
    breadcrumbs: [{ label: 'All categories', drill: null }, { label: 'Food', drill: { major: 'food' } }],
    tables: [{ id: 't', columns: [{ key: 'name', label: 'Account', format: 'text' }, { key: 'currency', label: 'CCY', format: 'text' }, { key: 'owed', label: 'Owed', format: 'local', align: 'right' }, { key: 'paid', label: 'Paid', format: 'progress' }],
      rows: [
        { key: 'a', cells: { name: 'Car loan', currency: 'USD', owed: 1234.5, paid: 42.5 }, drill: { param: 'account', value: 'a', mode: 'panel' } },
        { key: 'b', cells: { name: 'Tesco', currency: 'GBP', owed: 10, paid: 0 }, drill: { param: 'counterparty', value: 'tesco', mode: 'query', query: { action: 'list_transactions_view', params: { counterparty: 'tesco' }, note: 'All payments' } } },
      ], sortable: ['owed'], sort: null }],
  });
  r.renderInsightPayload(container, data, '£', {
    onTab: key => calls.push(['tab', key]), onControl: (param, value) => calls.push(['control', param, value]),
    onCrumb: drill => calls.push(['crumb', plain(drill)]), onDrill: (target, mode, query) => calls.push(['drill', plain(target), mode, plain(query)]),
  });
  const html = container.innerHTML;
  assert.match(html, />1,234\.50 USD</);
  assert.match(html, /width:42\.5%/);
  assert.doesNotMatch(html, /insight-sort|cursor:pointer" data-action="report-sort/, 'no client sorting');
  dom.fire(container, 'click', { action: 'report-tab', tab: 'accounts' });
  dom.fire(container, 'click', { action: 'report-control', param: 'window', value: '7' });
  dom.fire(container, 'click', { action: 'report-crumb', index: '0' });
  dom.fire(container, 'click', { action: 'report-row-drill', table: '0', row: '0' });
  dom.fire(container, 'click', { action: 'report-row-drill', table: '0', row: '1' });
  assert.deepEqual(calls, [
    ['tab', 'accounts'], ['control', 'window', '7'], ['crumb', null],
    ['drill', { account: 'a' }, 'panel', null],
    ['drill', { counterparty: 'tesco' }, 'query', { action: 'list_transactions_view', params: { counterparty: 'tesco' }, note: 'All payments' }],
  ]);
});

test('render-kinds: chart drills — panel / replace send the value, query sends queries[i], null targets show the note', () => {
  const r = loadRenderer();
  const C = r.getCssColors();
  const drills = [];
  const onDrill = (target, mode, query) => drills.push([plain(target), mode, plain(query)]);
  const toggles = [];
  const note = { dataset: { role: 'chart-drill-note' }, classList: { toggle: (name, on) => toggles.push(on) } };
  const canvas = { closest: () => ({ nextElementSibling: { dataset: {}, nextElementSibling: note } }) };
  const queries = [{ action: 'list_transactions_view', params: { from: '2026-09-20', to: '2026-09-20', types: 'money-out' }, note: "That day's spending" }, null];
  const query = r.chartConfig({ kind: 'bar', labels: ['20 Sep', '21 Sep'], datasets: [{ key: 'v', label: 'Spend', data: [5, 0] }],
    drill: { param: 'date', values: ['2026-09-20', '2026-09-21'], mode: 'query', queries, hint: 'Tap a day', null_text: 'Nothing that day.' } }, '£', C, onDrill);
  query.options.onClick({}, [{ index: 0, datasetIndex: 0 }], { canvas });
  query.options.onClick({}, [{ index: 1, datasetIndex: 0 }], { canvas });
  const replace = r.chartConfig({ kind: 'hbar', labels: ['Food'], datasets: [{ key: 'v', label: 'Spend', data: [5] }], drill: { param: 'major', values: ['food'], mode: 'replace' } }, '£', C, onDrill);
  replace.options.onClick({}, [{ index: 0, datasetIndex: 0 }], { canvas });
  const series = r.chartConfig({ kind: 'line', labels: ['Aug 26', 'Sep 26'], datasets: [{ key: 'food', label: 'food', data: [1, 2] }, { key: 'work', label: 'work', data: [3, 4] }],
    drill: { param: 'month', series_param: 'tag', values: ['2026-08', '2026-09'], mode: 'panel' } }, '£', C, onDrill);
  series.options.onClick({}, [{ index: 1, datasetIndex: 0 }], { getElementsAtEventForMode: () => [{ index: 1, datasetIndex: 1 }] });
  assert.deepEqual(drills, [
    [{ date: '2026-09-20' }, 'query', queries[0]],
    [{ major: 'food' }, 'replace', null],
    [{ month: '2026-09', tag: 'work' }, 'panel', null],
  ]);
  // toggle('hidden', on): the note is hidden after a drill and shown for a null target.
  assert.deepEqual(toggles, [true, false, true]);
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
  assert.equal(mixed.options.scales.y2.ticks.callback(20), '20%');
});

test('render-kinds: the drill panel shows the Drill shape (Text title, charts, table, Open in Transactions) and is replaced per drill', () => {
  const r = loadRenderer();
  const dom = fakeDom();
  const container = box(dom);
  FakeChart.instances = [];
  r.renderInsightPayload(container, payload({ charts: [] }), '£', {});
  const trend = { kind: 'bar', labels: ['Aug 26', 'Sep 26'], datasets: [{ key: 'spend', label: 'Spend', data: [5, 9], style: 'primary' }], y_format: 'money', y_max: 20 };
  const first = r.renderInsightDrill(container, { drill: { title: { text: 'Tesco · {0}', values: [{ value: 400, format: 'money' }] }, subtitle: '2 payments', charts: [trend],
    query: { action: 'list_transactions_view', params: { counterparty: 'tesco' }, note: 'All payments to this payee' } } }, '£');
  const slot = container.querySelector('[data-role="report-drill"]');
  assert.match(slot.innerHTML, /Tesco · £400/);
  assert.match(slot.innerHTML, /Open in Transactions/);
  assert.match(slot.innerHTML, /All payments to this payee/);
  assert.doesNotMatch(slot.innerHTML, /No transactions/);
  assert.equal(first[0].config.options.scales.y.max, 20);
  const opened = [];
  r.renderInsightPayload(container, payload({ drill: { title: 'Tesco', query: { action: 'list_transactions_view', params: { counterparty: 'tesco' } } } }), '£', { onOpenTransactions: query => opened.push(plain(query.params)) });
  dom.fire(container, 'click', { action: 'report-open-transactions' });
  assert.deepEqual(opened, [{ counterparty: 'tesco' }]);
  const second = r.renderInsightDrill(container, { drill: { title: 'Van', charts: [trend, trend] } }, '£');
  assert.equal(second.length, 2);
});

test('render-kinds: compact Home panels draw charts at a fixed height, tables when there is no chart, never drills', () => {
  const r = loadRenderer();
  const dom = fakeDom();
  FakeChart.instances = [];
  const panel = dom.el('panel');
  const charts = r.renderCompactPayload(panel, payload({ stat_cards: [{ key: 'x', label: 'X', value: 1, format: 'count' }],
    charts: [{ kind: 'bar', title: 'Hidden title', labels: ['a'], datasets: [{ key: 'v', label: 'V', data: [1] }], drill: { param: 'a', values: ['a'], mode: 'panel', hint: 'Tap' } }] }), '£');
  assert.equal(charts[0].config.options.onClick, undefined);
  assert.doesNotMatch(panel.innerHTML, /Tap|Hidden title|stat-card/);
  const table = dom.el('table');
  r.renderCompactPayload(table, payload({ tables: [{ id: 't', columns: [{ key: 'n', label: 'Loan', format: 'text' }], rows: [{ key: 'a', cells: { n: 'Car' }, drill: { param: 'account', value: 'a', mode: 'panel' } }] }] }), '£');
  assert.match(table.innerHTML, /Car/);
  assert.doesNotMatch(table.innerHTML, /report-row-drill/);
});

test('the old Insights shell is gone; the renderer lives in sections/reports', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app/sections/insights.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'app/sections/insights')), false);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'app/sections/reports')).sort(), ['builder.js', 'chart-theme.js', 'render-kinds.js', 'viewer.js']);
  const nav = read('app/core/nav.js') + read('app/index.html');
  assert.match(nav, /data-section="reports">Reports</);
  assert.doesNotMatch(nav, /insight/i);
  const renderer = read('app/sections/reports/render-kinds.js') + read('app/sections/reports/chart-theme.js');
  for (const banned of ['.reduce(', '.sort(', 'rate *', 'toBase', 'get_insight', 'renderDrillRowsTable', 'total_quote']) assert.ok(!renderer.includes(banned), banned);
});
