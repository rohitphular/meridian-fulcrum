// Task 15: the Reports section (sections/reports.js), the builder
// (reports/builder.js) and the viewer (reports/viewer.js), against the real GAS
// views and POSTs (list_reports_view, get_dashboard_layout, get_report,
// create / update / delete / restore / duplicate_report, update_dashboard_layout).
// The builder's disabled options are checked against the server validator.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { read, flush, plain, FakeChart, fakeDom, loadModules, appServer, loadApi, loadUtils } = require('./support/frontend-harness.cjs');
const { publish, payload, predefinedId } = require('./support/report-publish.cjs');

const { fmtAsOf } = loadUtils();
const ID = predefinedId;
const PUBLISHED_AT = '2026-10-04T12:05:00.000Z';
const BUILDER = ['bldGroupAllowed', 'bldCompareAllowed', 'bldFilterAllowed', 'bldChartFits', 'bldNormalise', 'bldDefaultDraft', 'bldDraftFromDefinition', 'bldBody', 'bldHtml', 'renderBuilder'];

const base = (extra = {}) => ({
  report_name: 'Monthly spend by category', measure: 'spend', period_preset: 'last_6', time_grain: 'month',
  group_by_1: 'category', chart_kind: 'stacked', ...extra,
});

function reportRows(runtime) {
  return runtime.sheets.find(sheet => sheet.name === 'report_master');
}

function rowOf(runtime, id) {
  const sheet = reportRows(runtime);
  const index = sheet.rows.findIndex(row => row[0] === id);
  return { rowNum: index + 1, get: column => sheet.rows[index][runtime.ctx.reportColIndex(column)], set: (column, value) => { sheet.rows[index][runtime.ctx.reportColIndex(column)] = value; } };
}

function reportsApp(runtime, stateExtra = {}) {
  const dom = fakeDom();
  const state = { views: {}, reportsMenu: 'predefined', reportsShowDeleted: false, reportDeleteId: null, reportBuilder: null, reportView: null, filters: {}, quoteCurrency: 'GBP', ...stateExtra };
  const messages = [], events = [];
  const exposed = loadModules([
    'app/sections/reports/chart-theme.js', 'app/sections/reports/render-kinds.js', 'app/sections/reports/builder.js',
    'app/sections/reports/viewer.js', 'app/sections/reports.js',
  ], {
    state, el: dom.el, fmtAsOf, shareSnapshot() {}, ExpenseAPI: loadApi(runtime, state), showLoading() {}, hideLoading() {},
    showMsg: (text, kind) => messages.push([text, kind ?? 'success']),
    document: { documentElement: {}, dispatchEvent: event => events.push([event.type, event.detail ?? null]) },
  }, ['renderReports', 'reportStatusText']);
  const content = () => dom.el('reportsContent').innerHTML;
  // The list region after a list-only render, else the whole section.
  const list = () => dom.el('reportsList').innerHTML || content();
  const click = dataset => dom.fire('reportsContent', 'click', dataset);
  const builderClick = dataset => dom.fire('reportBuilderSlot', 'click', dataset);
  const builder = () => dom.el('reportBuilderSlot').innerHTML;
  const posts = () => runtime.calls.filter(call => call[0] === 'POST').map(call => call[1]);
  return { ...exposed, dom, state, messages, events, content, list, click, builderClick, builder, posts };
}

// ── Builder rules = the schema's rules (checked against the GAS validator) ────

test('builder rules follow the schema list_reports_view returns and agree with the server validator', () => {
  const runtime = appServer();
  const schema = runtime.get({ action: 'list_reports_view' }).data.schema;
  const b = loadModules(['app/sections/reports/builder.js'], {}, BUILDER);
  const validate = body => runtime.ctx.validateReportDefinition({ report_name: 'Rule check', period_preset: 'last_6', chart_kind: 'table', ...body }, null);
  const draftFor = body => ({ measure: 'spend', period_preset: 'last_6', compare_mode: 'none', time_grain: 'none', group_by_1: '', group_by_2: '', filters: {}, ...body });
  let checked = 0;
  for (const measure of schema.measures) {
    // Group-bys the measure allows.
    for (const group of schema.group_by) {
      const allowed = b.bldGroupAllowed(schema, draftFor({ measure: measure.key }), group.key);
      const result = validate({ measure: measure.key, group_by_1: group.key });
      assert.equal(allowed, result.ok === true || result.error !== 'group_by_not_allowed_for_measure', `${measure.key} × ${group.key}`);
    }
    const groups = schema.group_by.filter(group => b.bldGroupAllowed(schema, draftFor({ measure: measure.key }), group.key)).map(group => group.key).slice(0, 2);
    // Chart kinds for every grain × breakdown shape.
    for (const grain of ['none', 'month']) {
      for (let count = 0; count <= groups.length; count++) {
        const shape = { measure: measure.key, time_grain: grain, group_by_1: groups[0] && count > 0 ? groups[0] : '', group_by_2: groups[1] && count > 1 ? groups[1] : '' };
        for (const chart of schema.chart_kinds) {
          const fits = b.bldChartFits(schema, draftFor(shape), chart);
          const result = validate({ ...shape, chart_kind: chart.key });
          if (!result.ok) assert.match(result.error, /^chart_not_allowed_for_/, `${measure.key} ${grain} ${count} ${chart.key}: ${result.error}`);
          assert.equal(fits, result.ok, `${measure.key} ${grain} ${count} ${chart.key}`);
          checked++;
        }
      }
    }
    // Transaction-only filters on stock measures.
    for (const filter of schema.filters) {
      const allowed = b.bldFilterAllowed(schema, draftFor({ measure: measure.key }), filter.key);
      const result = validate({ measure: measure.key, [filter.column]: filter.value_type === 'amount' ? '5' : filter.value_type === 'tx_type_list' ? 'money-in' : 'ABC' });
      assert.equal(allowed, result.ok === true || result.error !== 'filter_not_allowed_for_measure', `${measure.key} × ${filter.key}`);
    }
  }
  // Compare modes per period.
  for (const preset of schema.period_presets) {
    for (const mode of schema.compare_modes) {
      const dates = preset.key === 'fixed' ? { period_from: '2026-01-01', period_to: '2026-01-31' } : {};
      const allowed = b.bldCompareAllowed(schema, draftFor({ period_preset: preset.key }), mode.key);
      const result = validate({ measure: 'spend', period_preset: preset.key, compare_mode: mode.key, ...dates });
      assert.equal(allowed, result.ok === true || result.error !== 'compare_not_allowed', `${preset.key} × ${mode.key}`);
    }
  }
  assert.ok(checked > 100);
});

test('builder: options the schema rules out are disabled and dropped; top N only with a breakdown; name counter and 60 limit', () => {
  const runtime = appServer();
  const { schema, filter_options: options } = runtime.get({ action: 'list_reports_view' }).data;
  const b = loadModules(['app/sections/reports/builder.js'], {}, BUILDER);
  const draft = b.bldDefaultDraft(schema, 'Copy of Income trend');
  assert.deepEqual([draft.measure, draft.period_preset, draft.compare_mode, draft.time_grain, draft.group_by_1, draft.chart_kind],
    [schema.measures[0].key, schema.period_presets[0].key, 'none', 'none', '', 'table'], 'first schema options; the first chart that fits');
  let html = b.bldHtml(schema, options, { mode: 'create', draft, error: null });
  assert.match(html, /id="rptBName" maxlength="60" value="Copy of Income trend"/);
  assert.match(html, /<span class="field-hint" id="rptBNameCount">20 \/ 60<\/span>/);
  assert.match(html, /id="rptBDescription" maxlength="140"/);
  assert.doesNotMatch(html, /rptBTopN|rptBOther/, 'no Top N without a breakdown');
  assert.match(html, /data-action="rpt-b-chart" data-key="line" disabled/);
  assert.match(html, /data-action="rpt-b-chart" data-key="table"/);
  assert.doesNotMatch(html, /data-key="table" disabled/);
  // A breakdown brings Top N with the schema defaults.
  draft.group_by_1 = 'category';
  b.bldNormalise(schema, draft);
  html = b.bldHtml(schema, options, { mode: 'create', draft, error: null });
  assert.match(html, /<option value="7" selected>7<\/option>/);
  assert.match(html, /id="rptBOther" checked/);
  assert.deepEqual([b.bldBody(schema, draft).top_n, b.bldBody(schema, draft).include_other], ['7', true]);
  // Net worth: no breakdown, no transaction filters, Top N gone, compare rules from the period.
  draft.measure = 'net_worth';
  draft.filters.tags = ['travel'];
  draft.filters.amount_min = '5';
  draft.filters.account_ids = [options.accounts[0].value];
  b.bldNormalise(schema, draft);
  assert.deepEqual([draft.group_by_1, b.bldBody(schema, draft).top_n, b.bldBody(schema, draft).include_other, plain(draft.filters.tags), draft.filters.amount_min, plain(draft.filters.account_ids)],
    ['', '', false, [], '', [options.accounts[0].value]]);
  html = b.bldHtml(schema, options, { mode: 'create', draft, error: null });
  for (const group of schema.group_by) assert.match(html, new RegExp(`data-action="rpt-b-group" data-key="${group.key}" disabled`));
  assert.match(html, /<option value="tags"[^>]* disabled>Tag<\/option>/);
  assert.match(html, /id="rptBAmount_amount_min"[^>]*disabled/);
  draft.period_preset = 'all';
  draft.compare_mode = 'previous';
  b.bldNormalise(schema, draft);
  assert.equal(draft.compare_mode, 'none');
  assert.match(b.bldHtml(schema, options, { mode: 'create', draft, error: null }), /<option value="previous" disabled>/);
  draft.period_preset = 'fixed';
  assert.match(b.bldHtml(schema, options, { mode: 'create', draft, error: null }), /id="rptBFrom"[\s\S]*id="rptBTo"/);
  // Typing updates the draft and the counter only (no re-render, focus kept).
  const dom = fakeDom();
  const slot = dom.el('slot');
  const builder = { mode: 'create', draft: b.bldDefaultDraft(schema, ''), error: null };
  b.renderBuilder(slot, { schema, options, builder });
  const before = slot.innerHTML;
  dom.fire(slot, 'input', { id: 'rptBName', value: 'x'.repeat(60) });
  assert.equal(dom.el('rptBNameCount').textContent, '60 / 60');
  assert.equal(builder.draft.report_name.length, 60);
  assert.equal(slot.innerHTML, before);
});

// ── Lists, statuses and actions ───────────────────────────────────────────────

// Four user reports, one per status, plus a failed pre-built report.
function statusFixture(runtime) {
  const { ctx } = runtime;
  const ids = {
    queued: ctx.createReport(base({ report_name: 'Queued one' })).id,
    invalid: ctx.createReport(base({ report_name: 'Invalid one' })).id,
    ready: ctx.createReport(base({ report_name: '<b>Ready</b> one', report_description: 'Spend <by> month' })).id,
    failed: ctx.createReport(base({ report_name: 'Failed one' })).id,
  };
  rowOf(runtime, ids.invalid).set('sync_status', 'create-failed');
  rowOf(runtime, ids.invalid).set('sync_notes', 'invalid_group_by');
  for (const key of ['ready', 'failed']) rowOf(runtime, ids[key]).set('sync_status', 'in-sync');
  publish(runtime.sheets, { published_at: PUBLISHED_AT, outputs: [], results: [
    { report_id: ids.ready, definition_updated_at: rowOf(runtime, ids.ready).get('updated_at'), status: 'ready' },
    { report_id: ids.failed, definition_updated_at: rowOf(runtime, ids.failed).get('updated_at'), status: 'failed', error_code: 'too_many_rows' },
    { report_id: ID('14-networth-trend'), status: 'failed', error_code: 'missing_rate' },
    { report_id: ID('22-top-counterparties'), status: 'ready' },
  ] });
  return ids;
}

test('reports list: Pre-built by group and My reports with statuses and the actions the server allows', async () => {
  const runtime = appServer();
  const ids = statusFixture(runtime);
  const app = reportsApp(runtime);
  app.renderReports();
  assert.match(app.content(), /Loading reports…/);
  await flush();
  assert.deepEqual(runtime.calls.map(call => call[1].action).sort(), ['get_dashboard_layout', 'list_reports_view']);
  let html = app.list();
  for (const group of ['Overview', 'Cash flow', 'Categories and tags', 'Net worth and debt', 'Payees and places']) assert.ok(html.includes(group), group);
  // Net worth (a number report already on Home): add_to_home only → "On Home".
  assert.match(html, /Net worth<\/div>[\s\S]*?<div class="row-actions rpt-actions"><button type="button" class="btn-link muted" disabled>On Home<\/button><\/div>/);
  assert.match(html, new RegExp(`data-action="rpt-open" data-id="${ID('22-top-counterparties')}">Open[\\s\\S]*?data-action="rpt-customise"[\\s\\S]*?data-action="rpt-add_to_home"`));
  assert.match(html, /rpt-badge-failed">Failed: missing_rate</);
  assert.ok(html.includes(`rpt-badge-ready">Ready · as of ${fmtAsOf(PUBLISHED_AT)}<`));
  app.click({ action: 'rpt-menu', menu: 'mine' });
  html = app.content();
  assert.match(html, /aria-selected="true" data-action="rpt-menu" data-menu="mine"/);
  assert.match(html, /rpt-badge-queued">Queued</);
  assert.match(html, /rpt-badge-invalid">Invalid: invalid_group_by</);
  assert.ok(html.includes(`rpt-badge-ready">Ready · as of ${fmtAsOf(PUBLISHED_AT)}<`));
  assert.match(html, /rpt-badge-failed">Failed: too_many_rows</);
  assert.match(html, /&lt;b&gt;Ready&lt;\/b&gt; one/);
  assert.match(html, /Spend &lt;by&gt; month/);
  assert.doesNotMatch(html, /<b>Ready/);
  assert.match(html, /Spending · by month · per category · last 6 months/);
  for (const action of ['open', 'edit', 'duplicate', 'add_to_home', 'delete']) assert.ok(html.includes(`data-action="rpt-${action}" data-id="${ids.ready}"`), action);
  assert.equal(app.reportStatusText({ status: 'queued', status_label: 'Queued' }), 'Queued');
});

test('delete warns when the report is on Home and posts the row identity; duplicate, show deleted and restore', async () => {
  const runtime = appServer();
  const chart = runtime.ctx.createReport(base({ report_name: 'On home chart' })).id;
  const other = runtime.ctx.createReport(base({ report_name: 'Other chart' })).id;
  const layout = plain(runtime.ctx.readDashboardLayout().slots);
  runtime.ctx.updateDashboardLayout({ slots: { ...layout, panel_4: chart } });
  const app = reportsApp(runtime, { reportsMenu: 'mine' });
  app.renderReports();
  await flush();
  app.click({ action: 'rpt-delete', id: chart });
  assert.match(app.list(), /Delete <strong>On home chart<\/strong>\? It is also removed from Home\. You can restore it from Show deleted\./);
  app.click({ action: 'rpt-cancel-delete' });
  assert.doesNotMatch(app.list(), /Yes, delete/);
  app.click({ action: 'rpt-delete', id: other });
  assert.match(app.list(), /Delete <strong>Other chart<\/strong>\? You can restore/);
  app.click({ action: 'rpt-delete', id: chart });
  const row = rowOf(runtime, chart);
  const expected = { row_num: row.rowNum, expected_id: chart, expected_updated_at: row.get('updated_at') };
  app.click({ action: 'rpt-confirm-delete', id: chart });
  await flush();
  assert.deepEqual(app.posts().at(-1), { action: 'delete_report', ...expected });
  assert.deepEqual(app.messages.at(-1), ['Deleted "On home chart". It was removed from Home.', 'success']);
  assert.deepEqual(app.events.at(-1), ['et:reload', null]);
  assert.equal(runtime.ctx.readDashboardLayout().slots.panel_4, '');
  // Duplicate: the row in hand.
  app.renderReports();
  await flush();
  app.click({ action: 'rpt-duplicate', id: other });
  await flush();
  assert.deepEqual(app.posts().at(-1), { action: 'duplicate_report', row_num: rowOf(runtime, other).rowNum, expected_id: other, expected_updated_at: rowOf(runtime, other).get('updated_at') });
  assert.equal(app.messages.at(-1)[0], 'Duplicated "Other chart". The copy is ready after the next refresh.');
  // Show deleted → restore.
  app.renderReports();
  await flush();
  app.dom.fire('reportsContent', 'change', { id: 'rptShowDeleted', checked: true });
  await flush();
  assert.equal(runtime.calls.filter(call => call[1].action === 'list_reports_view').at(-1)[1].include_deleted, 'true');
  assert.match(app.list(), new RegExp(`rpt-item-deleted[\\s\\S]*?data-action="rpt-restore" data-id="${chart}">Restore`));
  app.click({ action: 'rpt-restore', id: chart });
  await flush();
  assert.equal(app.posts().at(-1).action, 'restore_report');
  assert.equal(rowOf(runtime, chart).get('record_status'), 'active');
});

test('Add to Home fills the first empty slot of the report kind and saves all 8 slots; a full Home says so', async () => {
  const runtime = appServer();
  const chart = runtime.ctx.createReport(base({ report_name: 'Chart report' })).id;
  const app = reportsApp(runtime, { reportsMenu: 'mine' });
  app.renderReports();
  await flush();
  app.click({ action: 'rpt-add_to_home', id: chart });
  await flush();
  assert.deepEqual(app.messages.at(-1), ['Home has no empty report panel. Open Home and use Customise to replace one.', 'warn']);
  assert.equal(app.posts().length, 0);
  const layout = plain(runtime.ctx.readDashboardLayout().slots);
  runtime.ctx.updateDashboardLayout({ slots: { ...layout, panel_2: '' } });
  app.click({ action: 'rpt-add_to_home', id: chart });
  await flush();
  assert.equal(runtime.calls.at(-2)[1].action, 'get_dashboard_layout', 'the layout is read again right before the write');
  assert.deepEqual(app.posts().at(-1), { action: 'update_dashboard_layout', slots: { ...layout, panel_2: chart } });
  assert.deepEqual(app.messages.at(-1), ['Added "Chart report" to Home.', 'success']);
  assert.deepEqual(app.events.at(-1), ['et:reload', null]);
});

// ── Builder save ──────────────────────────────────────────────────────────────

test('builder: Customise opens "Copy of <title>" with no server call; choices, filters and save go to create_report', async () => {
  const runtime = appServer();
  const app = reportsApp(runtime);
  app.renderReports();
  await flush();
  const before = runtime.calls.length;
  app.click({ action: 'rpt-customise', id: ID('22-top-counterparties') });
  assert.equal(runtime.calls.length, before, 'Customise has no server action');
  assert.equal(app.state.reportsMenu, 'mine');
  assert.match(app.builder(), /value="Copy of Top payees"/);
  assert.match(app.builder(), /New report/);
  app.builderClick({ action: 'rpt-b-measure', key: 'income' });
  app.builderClick({ action: 'rpt-b-grain', key: 'month' });
  app.builderClick({ action: 'rpt-b-group', key: 'category' });
  app.builderClick({ action: 'rpt-b-chart', key: 'line' });
  // After each re-render the selects show the draft's field (set here as a browser would).
  app.dom.fire('reportBuilderSlot', 'change', { id: 'rptBFilterField', value: 'tags' });
  assert.match(app.builder(), /<option value="tags" selected>Tag<\/option>[\s\S]*<input type="text" id="rptBFilterValue"/);
  app.dom.el('rptBFilterField').value = 'tags';
  app.dom.el('rptBFilterValue').value = ' travel ';
  app.builderClick({ action: 'rpt-b-filter-add' });
  app.dom.el('rptBFilterField').value = 'tags';
  app.dom.el('rptBFilterValue').value = 'work';
  app.builderClick({ action: 'rpt-b-filter-add' });
  app.dom.el('rptBFilterField').value = 'categories';
  app.dom.el('rptBFilterValue').value = 'food';
  app.builderClick({ action: 'rpt-b-filter-add' });
  assert.match(app.builder(), /Category: Food[\s\S]*Tag: travel[\s\S]*Tag: work/);
  app.builderClick({ action: 'rpt-b-filter-remove', key: 'tags', index: '1' });
  app.dom.fire('reportBuilderSlot', 'input', { dataset: { filter: 'amount_min' }, value: '5' });
  app.builderClick({ action: 'rpt-b-save' });
  await flush();
  const body = app.posts().at(-1);
  assert.equal(body.action, 'create_report');
  assert.deepEqual({ ...body, action: undefined }, { action: undefined,
    report_name: 'Copy of Top payees', report_description: '', measure: 'income', period_preset: 'last_7', period_from: '', period_to: '', compare_mode: 'none',
    time_grain: 'month', group_by_1: 'category', group_by_2: '', top_n: '7', include_other: true, chart_kind: 'line',
    filter_account_ids: '', filter_categories: 'food', filter_tags: 'travel', filter_payees: '', filter_currencies: '', filter_countries: '', filter_tx_types: '',
    filter_amount_min: '5', filter_amount_max: '' });
  assert.deepEqual(app.messages.at(-1), ['Saved "Copy of Top payees". It is ready after the next refresh.', 'success']);
  assert.deepEqual(app.events.at(-1), ['et:reload', null]);
  assert.equal(app.state.reportBuilder, null);
  const saved = runtime.ctx.listReportRows().find(row => row.report_name === 'Copy of Top payees');
  assert.equal(saved.sync_status, 'create-pending');
});

test('builder: server errors show next to the field they name; Edit sends update_report with the row identity', async () => {
  const runtime = appServer();
  const existing = runtime.ctx.createReport(base({ report_name: 'Taken name', filter_tags: 'travel;work', top_n: 10, include_other: false })).id;
  const app = reportsApp(runtime, { reportsMenu: 'mine' });
  app.renderReports();
  await flush();
  app.click({ action: 'rpt-new' });
  app.dom.fire('reportBuilderSlot', 'input', { id: 'rptBName', value: 'ab' });
  app.builderClick({ action: 'rpt-b-save' });
  await flush();
  let html = app.builder();
  const message = html.indexOf('Use at least 3 characters for the report name.');
  assert.ok(message > 0 && message < html.indexOf('What to measure'), 'shown in the name step');
  assert.match(html, /<div class="field error" id="rptB_report_name">/);
  app.dom.fire('reportBuilderSlot', 'input', { id: 'rptBName', value: 'TAKEN NAME' });
  app.builderClick({ action: 'rpt-b-save' });
  await flush();
  assert.match(app.builder(), /rpt-field-error" role="alert">You already have a report with this name\./);
  assert.notEqual(app.state.reportBuilder, null);
  assert.deepEqual(app.events, []);
  app.builderClick({ action: 'rpt-b-cancel' });
  assert.equal(app.builder(), '');
  // Edit: prefilled from the saved definition.
  app.click({ action: 'rpt-edit', id: existing });
  html = app.builder();
  assert.match(html, /Edit report/);
  assert.match(html, /value="Taken name"/);
  assert.match(html, /<option value="10" selected>10<\/option>/);
  assert.doesNotMatch(html, /id="rptBOther" checked/);
  assert.match(html, /Tag: travel[\s\S]*Tag: work/);
  app.builderClick({ action: 'rpt-b-grain', key: 'week' });
  app.builderClick({ action: 'rpt-b-save' });
  await flush();
  const body = app.posts().at(-1);
  const row = rowOf(runtime, existing);
  assert.deepEqual([body.action, body.row_num, body.expected_id, body.time_grain, body.filter_tags, body.top_n, body.include_other],
    ['update_report', row.rowNum, existing, 'week', 'travel;work', '10', false]);
  assert.equal(body.expected_updated_at, app.state.views.list_reports_view.data.mine[0].updated_at);
  assert.equal(row.get('time_grain'), 'week');
  assert.equal(app.messages.at(-1)[0], 'Saved "Taken name". It is ready after the next refresh.');
});

// ── Viewer ────────────────────────────────────────────────────────────────────

const PAYEES = ID('22-top-counterparties');
const DRILLDOWN = ID('11-category-drilldown');

function publishViewer(runtime) {
  const query = { action: 'list_transactions_view', params: { from: '2026-07-01', to: '2026-09-30', counterparty: 'tesco' }, note: 'Transactions with this payee' };
  publish(runtime.sheets, { published_at: PUBLISHED_AT, outputs: [
    { report_id: PAYEES, payload: payload({ title: 'Top payees', description: 'Who gets most', period: { key: 'last_3', label: 'Last 3 months' },
      controls: [{ param: 'top_n', label: 'Show', value: 15, options: [{ value: 10, label: 'Top 10' }, { value: 15, label: 'Top 15' }] }],
      stat_cards: [{ key: 'total', label: 'Total', value: 10, format: 'money', sub: { text: '{0} vs last period', values: [{ value: -2, format: 'money_delta' }] } }],
      charts: [
        { id: 'top', kind: 'hbar', labels: ['Tesco'], datasets: [{ key: 'v', label: 'Spend', data: [5] }], y_format: 'money', ref_lines: [], drill: { param: 'counterparty', values: ['tesco'], mode: 'panel', hint: 'Tap a payee' } },
        { id: 'q', kind: 'bar', labels: ['Tesco', 'Other'], datasets: [{ key: 'v', label: 'Spend', data: [5, 1] }], y_format: 'money', ref_lines: [], drill: { param: 'counterparty', values: ['tesco', null], mode: 'query', queries: [query, null] } },
      ] }) },
    { report_id: PAYEES, variant_key: 'drill=counterparty%3Atesco', payload: payload({ drill: { title: { text: 'Tesco · {0}', values: [{ value: 5, format: 'money' }] }, query } }) },
    { report_id: DRILLDOWN, payload: payload({ title: 'Category drill-down', breadcrumbs: [{ label: 'All categories', drill: null }],
      charts: [{ id: 'm', kind: 'hbar', labels: ['Food'], datasets: [{ key: 'v', label: 'Spend', data: [5] }], y_format: 'money', ref_lines: [], drill: { param: 'major', values: ['food'], mode: 'replace' } }] }) },
    { report_id: DRILLDOWN, variant_key: 'drill=major%3Afood', payload: payload({ title: 'Category drill-down', breadcrumbs: [{ label: 'All categories', drill: null }, { label: 'Food', drill: { major: 'food' } }],
      charts: [{ id: 'n', kind: 'hbar', labels: ['Groceries'], datasets: [{ key: 'v', label: 'Spend', data: [4] }], y_format: 'money', ref_lines: [] }] }) },
  ], results: [{ report_id: PAYEES, status: 'ready' }, { report_id: DRILLDOWN, status: 'ready' }, { report_id: ID('08-category-pie'), status: 'failed', error_code: 'boom' }] });
  return query;
}

const reportCalls = runtime => runtime.calls.filter(call => call[1].action === 'get_report').map(call => {
  const { action, pin, quote_currency, tz, ...params } = call[1];
  return params;
});

test('viewer: get_report for the open report, Text with values, As of, panel drills and controls', async () => {
  const runtime = appServer();
  publishViewer(runtime);
  const app = reportsApp(runtime);
  app.renderReports();
  await flush();
  FakeChart.instances = [];
  app.click({ action: 'rpt-open', id: PAYEES });
  await flush();
  assert.deepEqual(reportCalls(runtime), [{ id: PAYEES }]);
  const head = app.dom.el('reportViewerHead').innerHTML;
  assert.match(head, /Top payees/);
  assert.match(head, /Last 3 months/);
  assert.ok(head.includes(`As of ${fmtAsOf(PUBLISHED_AT)}`));
  const body = app.dom.el('reportViewerChart').innerHTML;
  assert.match(body, /£800/);                         // 10 g × 80
  assert.match(body, /−£160 vs last period/);        // Text: −2 g × 80
  assert.match(body, /Tap a payee/);
  // Panel drill → the drill=<param>:<value> variant, shown under the report.
  const top = FakeChart.instances.find(chart => chart.config.options.indexAxis === 'y');
  top.config.options.onClick({}, [{ index: 0, datasetIndex: 0 }], {});
  await flush();
  assert.deepEqual(reportCalls(runtime).at(-1), { id: PAYEES, drill: 'counterparty:tesco' });
  const drill = app.dom.el('reportViewerChart').querySelector('[data-role="report-drill"]').innerHTML;
  assert.match(drill, /Tesco · £400/);
  assert.match(drill, /Open in Transactions/);
  // A control re-requests with its param; an unpublished variant says so.
  app.dom.fire('reportViewerChart', 'click', { action: 'report-control', param: 'top_n', value: '10' });
  await flush();
  assert.deepEqual(reportCalls(runtime).at(-1), { id: PAYEES, top_n: '10' });
  assert.match(app.dom.el('reportViewerBody').innerHTML, /This view appears after the next refresh\./);
  // Back to the list.
  app.click({ action: 'rpt-viewer-back' });
  await flush();
  assert.equal(app.state.reportView, null);
  assert.match(app.list(), /Pre-built|Overview/);
});

test('viewer: query drills open Transactions with the query params; replace drills swap the body with breadcrumbs', async () => {
  const runtime = appServer();
  const query = publishViewer(runtime);
  const app = reportsApp(runtime);
  app.renderReports();
  await flush();
  FakeChart.instances = [];
  app.click({ action: 'rpt-open', id: PAYEES });
  await flush();
  const bar = FakeChart.instances.find(chart => chart.config.type === 'bar' && chart.config.options.indexAxis !== 'y');
  bar.config.options.onClick({}, [{ index: 1, datasetIndex: 0 }], {});   // 'Other': not drillable
  assert.deepEqual(app.events, []);
  bar.config.options.onClick({}, [{ index: 0, datasetIndex: 0 }], {});
  assert.deepEqual(plain(app.state.filters), query.params);
  assert.deepEqual(app.events, [['et:show-section', 'transactions']]);
  // Replace drill (11-category-drilldown).
  app.state.reportView = null;
  app.renderReports();
  await flush();
  FakeChart.instances = [];
  app.click({ action: 'rpt-open', id: DRILLDOWN });
  await flush();
  FakeChart.instances[0].config.options.onClick({}, [{ index: 0, datasetIndex: 0 }], {});
  await flush();
  assert.deepEqual(reportCalls(runtime).at(-1), { id: DRILLDOWN, drill: 'major:food' });
  assert.equal(app.state.reportView.drill, 'major:food');
  assert.match(app.dom.el('reportViewerChart').innerHTML, /data-action="report-crumb" data-index="0">All categories<\/button>[\s\S]*<strong>Food<\/strong>/);
  app.dom.fire('reportViewerChart', 'click', { action: 'report-crumb', index: '0' });
  await flush();
  assert.deepEqual(reportCalls(runtime).at(-1), { id: DRILLDOWN });
});

test('viewer: reader warnings (not published, failed) are shown instead of a body', async () => {
  const runtime = appServer();
  publishViewer(runtime);
  const app = reportsApp(runtime);
  app.renderReports();
  await flush();
  app.click({ action: 'rpt-open', id: ID('08-category-pie') });
  await flush();
  assert.match(app.dom.el('reportViewerBody').innerHTML, /<div class="insight-warn">This report could not be computed \(boom\)\.<\/div>/);
  app.click({ action: 'rpt-viewer-back' });
  await flush();
  const empty = reportsApp(appServer());
  empty.renderReports();
  await flush();
  empty.click({ action: 'rpt-open', id: PAYEES });
  await flush();
  assert.match(empty.dom.el('reportViewerBody').innerHTML, /Reports appear after the next refresh\./);
  assert.doesNotMatch(empty.dom.el('reportViewerHead').innerHTML, /As of/);
});


test('reports code renders only: no sums, sorting, conversion or period math', () => {
  for (const file of ['app/sections/reports.js', 'app/sections/reports/builder.js', 'app/sections/reports/viewer.js']) {
    const source = read(file);
    for (const banned of ['.reduce(', '.sort(', 'rate *', '* rate', 'toBase', 'new Date(', 'getDate', 'setDate', 'Math.']) assert.ok(!source.includes(banned), `${file}: ${banned}`);
  }
});
