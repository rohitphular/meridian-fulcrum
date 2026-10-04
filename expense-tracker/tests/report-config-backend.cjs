// Report configuration in GAS (task 03): definition validation, report_master
// create / update / delete / restore / duplicate, the Home layout, and the two
// read views. No report numbers are computed here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { gasRuntime, API } = require('./support/gas-runtime.cjs');

const HSBC = '11111111-1111-4111-8111-111111111111';
const MONZO = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const plain = value => JSON.parse(JSON.stringify(value));

function setup() {
  const sheets = [];
  const runtime = gasRuntime({ sheets });
  const { ctx, Sheet } = runtime;
  const accountColumns = ctx.getAccountSheetColumns();
  const account = (id, name, currency, status) => accountColumns.map(column => ({ id, account_name: name, account_currency_local: currency, record_status: status })[column] ?? '');
  sheets.push(new Sheet('account_master', [accountColumns, account(HSBC, 'HSBC Current', 'GBP', 'active'), account(MONZO, 'Monzo', 'inr', 'active'), account(OLD, 'Old', 'USD', 'deleted')]));
  const categoryColumns = ctx.getCategorySheetColumns();
  const category = (major, minor, status) => categoryColumns.map(column => ({
    tx_type_key: 'money-out', major_category_key: major, major_category_label: major[0].toUpperCase() + major.slice(1),
    minor_category_key: minor, minor_category_label: minor[0].toUpperCase() + minor.slice(1), record_status: status,
  })[column] ?? '');
  sheets.push(new Sheet('category_master', [categoryColumns, category('groceries', 'supermarket', 'active'), category('travel', 'flights', 'deleted')]));
  const tab = name => sheets.find(sheet => sheet.name === name);
  const row = id => { const sheet = tab('report_master'); const cols = sheet.rows[0]; const found = sheet.rows.find(r => r[0] === id); return found && Object.fromEntries(cols.map((c, i) => [c, found[i]])); };
  const rowNum = id => tab('report_master').rows.findIndex(r => r[0] === id) + 1;
  const view = (action, params = {}) => ctx[action]({ params, quote_currency: 'GBP', data_version: 'v1', computed_at: 'now' });
  return { ctx, sheets, Sheet, tab, row, rowNum, view };
}

const base = (extra = {}) => ({
  report_name: 'Monthly spend by category', measure: 'spend', period_preset: 'last_6', time_grain: 'month',
  group_by_1: 'category', chart_kind: 'stacked', ...extra,
});

test('a valid definition is normalised: defaults, case, list order kept and joined with ;', () => {
  const { ctx } = setup();
  const result = plain(ctx.validateReportDefinition(base({
    filter_account_ids: ` ${HSBC.toUpperCase()} ; ${MONZO};${HSBC}`, filter_currencies: 'gbp;INR', filter_categories: 'groceries; groceries|supermarket',
    filter_tags: 'Holiday;holiday;work', filter_amount_min: '10', filter_amount_max: '250.50',
  }), ctx.rptReferences()));
  assert.equal(result.ok, true);
  const values = result.values;
  assert.equal(values.top_n, 7);
  assert.equal(values.include_other, true);
  assert.equal(values.compare_mode, 'none');
  assert.equal(values.filter_account_ids, `${HSBC};${MONZO}`);
  assert.equal(values.filter_currencies, 'GBP;INR');
  assert.equal(values.filter_categories, 'groceries;groceries|supermarket');
  assert.equal(values.filter_tags, 'Holiday;work');
  assert.equal(values.period_from, '');
});

test('every rule rejects with its contract code and field', () => {
  const { ctx } = setup();
  const refs = ctx.rptReferences();
  const cases = [
    [{ report_name: '' }, 'missing_report_name', 'report_name'],
    [{ report_name: 'ab' }, 'report_name_too_short', 'report_name'],
    [{ report_name: 'x'.repeat(61) }, 'report_name_too_long', 'report_name'],
    [{ report_description: 'x'.repeat(141) }, 'report_description_too_long', 'report_description'],
    [{ measure: 'profit' }, 'invalid_measure', 'measure'],
    [{ period_preset: 'last_2' }, 'invalid_period_preset', 'period_preset'],
    [{ period_preset: 'fixed', period_from: '2026-02-30', period_to: '2026-03-01' }, 'invalid_period_dates', 'period_from'],
    [{ period_preset: 'fixed', period_from: '2026-03-02', period_to: '2026-03-01' }, 'invalid_period_dates', 'period_to'],
    [{ period_preset: 'fixed', period_from: '2010-01-01', period_to: '2026-01-01' }, 'fixed_period_too_long', 'period_to'],
    [{ period_from: '2026-01-01' }, 'period_dates_not_allowed', 'period_from'],
    [{ period_preset: 'all', compare_mode: 'previous' }, 'compare_not_allowed', 'compare_mode'],
    [{ time_grain: 'hour' }, 'invalid_time_grain', 'time_grain'],
    [{ group_by_1: '', group_by_2: 'tag' }, 'group_by_order', 'group_by_2'],
    [{ group_by_2: 'category' }, 'duplicate_group_by', 'group_by_2'],
    [{ group_by_1: 'merchant' }, 'invalid_group_by', 'group_by_1'],
    [{ measure: 'balance', group_by_1: 'category', chart_kind: 'line' }, 'group_by_not_allowed_for_measure', 'group_by_1'],
    [{ group_by_1: '', chart_kind: 'line', top_n: '10' }, 'top_n_without_group_by', 'top_n'],
    [{ top_n: '8' }, 'invalid_top_n', 'top_n'],
    [{ include_other: 'maybe' }, 'invalid_include_other', 'include_other'],
    [{ filter_account_ids: OLD }, 'unknown_filter_reference', 'filter_account_ids'],
    [{ filter_account_ids: 'not-a-uuid' }, 'invalid_filter_value', 'filter_account_ids'],
    [{ filter_categories: 'travel' }, 'unknown_filter_reference', 'filter_categories'],
    [{ filter_categories: 'a|b|c' }, 'invalid_filter_value', 'filter_categories'],
    [{ filter_currencies: 'USD' }, 'unknown_filter_reference', 'filter_currencies'],
    [{ filter_tx_types: 'refund' }, 'invalid_filter_value', 'filter_tx_types'],
    [{ filter_amount_min: '-5' }, 'invalid_filter_value', 'filter_amount_min'],
    [{ filter_amount_min: '50', filter_amount_max: '10' }, 'invalid_amount_range', 'filter_amount_max'],
    [{ filter_tags: Array.from({ length: 51 }, (_, i) => 't' + i).join(';') }, 'too_many_filter_values', 'filter_tags'],
    [{ measure: 'net_worth', group_by_1: '', chart_kind: 'line', filter_tags: 'x' }, 'filter_not_allowed_for_measure', 'filter_tags'],
    [{ chart_kind: 'radar' }, 'invalid_chart_kind', 'chart_kind'],
    [{ chart_kind: 'donut' }, 'chart_not_allowed_for_shape', 'chart_kind'],
    [{ time_grain: 'none', measure: 'average', chart_kind: 'donut' }, 'chart_not_allowed_for_measure', 'chart_kind'],
    [{ measure: 'savings_rate', group_by_1: '', chart_kind: 'stacked' }, 'chart_not_allowed_for_measure', 'chart_kind'],
    [{ time_grain: 'none', chart_kind: 'number' }, 'chart_not_allowed_for_shape', 'chart_kind'],
    [{ period_preset: 'fixed', period_from: '2024-01-01', period_to: '2025-12-31', time_grain: 'day', chart_kind: 'line' }, 'too_many_points', 'time_grain'],
  ];
  for (const [patch, error, field] of cases) {
    assert.deepEqual(plain(ctx.validateReportDefinition(base(patch), refs)), { ok: false, error, field }, JSON.stringify(patch));
  }
  // Boundaries that pass: 60 characters, a single number, a year of days.
  assert.equal(ctx.validateReportDefinition(base({ report_name: 'x'.repeat(60) }), refs).ok, true);
  assert.equal(ctx.validateReportDefinition(base({ time_grain: 'none', group_by_1: '', chart_kind: 'number' }), refs).ok, true);
  assert.equal(ctx.validateReportDefinition(base({ period_preset: 'last_12', time_grain: 'day', chart_kind: 'line' }), refs).ok, true);
});

test('create stores a user report queued for sync; names are unique ignoring case', () => {
  const { ctx, row } = setup();
  const created = plain(ctx.createReport(base()));
  assert.equal(created.ok, true);
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  const stored = row(created.id);
  assert.equal(stored.report_type, 'user_defined');
  assert.equal(stored.record_status, 'active');
  assert.equal(stored.sync_status, 'create-pending');
  assert.equal(stored.predefined_key, '');
  assert.equal(stored.created_at, stored.updated_at);
  assert.deepEqual(plain(ctx.createReport(base({ report_name: 'MONTHLY SPEND BY CATEGORY' }))), { ok: false, error: 'duplicate_report_name', field: 'report_name' });
  assert.equal(ctx.createReport(base({ report_name: 'Another one', group_by_1: 'payee' })).ok, true);
});

test('update checks the row is current, skips unchanged saves and queues real changes', () => {
  const { ctx, tab, row, rowNum } = setup();
  const { id } = ctx.createReport(base());
  const sheet = tab('report_master');
  const at = row(id).updated_at;
  assert.equal(ctx.updateReport({ ...base(), row_num: rowNum(id), expected_id: id, expected_updated_at: 'stale' }).error, 'stale_record');
  const writes = sheet.writes;
  assert.equal(plain(ctx.updateReport({ ...base(), row_num: rowNum(id), expected_id: id, expected_updated_at: at })).unchanged, true);
  assert.equal(sheet.writes, writes, 'an unchanged save writes nothing');
  sheet.rows[rowNum(id) - 1][ctx.reportColIndex('sync_status')] = 'in-sync';
  assert.equal(ctx.updateReport({ ...base({ period_preset: 'last_12' }), row_num: rowNum(id), expected_id: id, expected_updated_at: at }).ok, true);
  assert.equal(row(id).period_preset, 'last_12');
  assert.equal(row(id).sync_status, 'update-pending');
  assert.equal(ctx.updateReport({ ...base(), row_num: 99 }).error, 'invalid_row');
});

test('pre-built and locked reports cannot be edited, deleted or duplicated through the app', () => {
  const { ctx, tab, rowNum } = setup();
  const { id } = ctx.createReport(base());
  const sheet = tab('report_master');
  const predefined = ctx.getReportSheetColumns().map(column => ({ id: '6b0c7a0e-0000-5000-8000-000000000001', report_type: 'predefined', predefined_key: '08-category-pie', report_name: 'Spending by category', record_status: 'locked' })[column] ?? '');
  sheet.rows.push(predefined);
  const preRow = sheet.rows.length;
  for (const action of ['updateReport', 'deleteReport', 'duplicateReport'])
    assert.equal(ctx[action]({ ...base(), row_num: preRow }).error, 'predefined_report_locked', action);
  sheet.rows[rowNum(id) - 1][ctx.reportColIndex('record_status')] = 'locked';
  assert.equal(ctx.updateReport({ ...base({ period_preset: 'ytd' }), row_num: rowNum(id) }).error, 'record_locked');
});

test('delete tombstones the report and empties its Home slots; restore brings it back unless the name is taken', () => {
  const { ctx, row, rowNum } = setup();
  const { id } = ctx.createReport(base({ report_name: 'Spend number', time_grain: 'none', group_by_1: '', chart_kind: 'number' }));
  const slots = plain(ctx.readDashboardLayout().slots);
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_4: id } }).ok, true);
  const deleted = plain(ctx.deleteReport({ row_num: rowNum(id) }));
  assert.deepEqual([deleted.ok, deleted.layout_slots_cleared], [true, 1]);
  assert.equal(row(id).record_status, 'deleted');
  assert.equal(ctx.readDashboardLayout().slots.tile_4, '');
  assert.equal(ctx.deleteReport({ row_num: rowNum(id) }).error, 'report_deleted');
  assert.equal(ctx.updateReport({ ...base(), row_num: rowNum(id) }).error, 'report_deleted');
  const clash = ctx.createReport(base({ report_name: 'Spend number' })).id;
  assert.equal(ctx.restoreReport({ row_num: rowNum(id) }).error, 'duplicate_report_name');
  assert.equal(ctx.restoreReport({ row_num: rowNum(clash) }).error, 'report_not_deleted');
  ctx.deleteReport({ row_num: rowNum(clash) });
  assert.equal(ctx.restoreReport({ row_num: rowNum(id) }).ok, true);
  assert.equal(row(id).record_status, 'active');
});

test('duplicate makes a unique "Copy of" name within 60 characters', () => {
  const { ctx, row, rowNum } = setup();
  const long = 'L'.repeat(60);
  const { id } = ctx.createReport(base({ report_name: long }));
  const first = plain(ctx.duplicateReport({ row_num: rowNum(id) }));
  const second = plain(ctx.duplicateReport({ row_num: rowNum(id) }));
  assert.equal(row(first.id).report_name, ('Copy of ' + long).slice(0, 60));
  assert.equal(row(second.id).report_name, ('Copy of ' + long).slice(0, 56) + ' (2)');
  assert.ok([first, second].every(copy => row(copy.id).report_name.length <= 60));
  assert.equal(row(first.id).sync_status, 'create-pending');
  assert.equal(row(first.id).chart_kind, 'stacked');
});

test('the Home layout defaults from the contract, then saves all 8 slots with slot rules', () => {
  const { ctx, sheets } = setup();
  const defaults = plain(ctx.readDashboardLayout());
  assert.equal(defaults.is_default, true);
  assert.equal(defaults.slots.tile_1, ctx.rptPredefinedByKey('kpi-net-worth').id);
  assert.equal(defaults.slots.panel_4, ctx.rptPredefinedByKey('08-category-pie').id);
  assert.equal(sheets.some(sheet => sheet.name === 'dashboard_layout'), false, 'reading never creates the tab');
  const chart = ctx.createReport(base()).id;
  const number = ctx.createReport(base({ report_name: 'Spend number', time_grain: 'none', group_by_1: '', chart_kind: 'number' })).id;
  const slots = defaults.slots;
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_2: chart } }).error, 'report_not_allowed_in_slot');
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, panel_1: number } }).error, 'report_not_allowed_in_slot');
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, panel_2: slots.panel_1 } }).error, 'duplicate_dashboard_report');
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_9: '' } }).error, 'invalid_dashboard_slot');
  const { panel_4, ...missing } = slots;
  assert.equal(ctx.updateDashboardLayout({ slots: missing }).error, 'invalid_dashboard_layout');
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_1: '99999999-9999-4999-8999-999999999999' } }).error, 'report_not_found');
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_3: number, panel_3: chart, panel_4: '' } }).ok, true);
  const saved = plain(ctx.readDashboardLayout());
  assert.equal(saved.is_default, false);
  assert.deepEqual([saved.slots.tile_3, saved.slots.panel_3, saved.slots.panel_4], [number, chart, '']);
});

test('list_reports_view: builder schema, filter options, pre-built groups and each status', () => {
  const { ctx, Sheet, sheets, tab, rowNum, view } = setup();
  const queued = ctx.createReport(base({ report_name: 'Queued one' })).id;
  const invalid = ctx.createReport(base({ report_name: 'Invalid one' })).id;
  const ready = ctx.createReport(base({ report_name: 'Ready one' })).id;
  const edited = ctx.createReport(base({ report_name: 'Edited since' })).id;
  const sheet = tab('report_master');
  const set = (id, column, value) => { sheet.rows[rowNum(id) - 1][ctx.reportColIndex(column)] = value; };
  set(invalid, 'sync_status', 'create-failed'); set(invalid, 'sync_notes', 'invalid_group_by');
  for (const id of [ready, edited]) set(id, 'sync_status', 'in-sync');
  const at = id => sheet.rows[rowNum(id) - 1][ctx.reportColIndex('updated_at')];
  const netWorth = ctx.rptPredefinedByKey('14-networth-trend').id;
  sheets.push(new Sheet('report_status', [['report_id', 'definition_updated_at', 'status', 'error_code', 'published_at'],
    [ready, at(ready), 'ready', '', '2026-10-04T12:05:00.000Z'], [edited, 'older', 'ready', '', '2026-10-04T12:05:00.000Z'],
    [netWorth, '', 'failed', 'missing_rate', '2026-10-04T12:05:00.000Z']]));
  const data = plain(view('listReportsView').data);
  assert.equal(data.schema.name.max_length, 60);
  assert.ok(data.schema.chart_kinds.some(kind => kind.key === 'number'));
  assert.deepEqual(data.filter_options.accounts.map(a => a.label), ['HSBC Current', 'Monzo']);
  assert.deepEqual(data.filter_options.currencies.map(c => c.value), ['GBP', 'INR']);
  assert.deepEqual(data.filter_options.categories.map(c => c.value), ['groceries', 'groceries|supermarket']);
  const status = Object.fromEntries(data.mine.map(r => [r.report_name, [r.status, r.status_reason, r.published_at]]));
  assert.deepEqual(status['Queued one'], ['queued', '', '']);
  assert.deepEqual(status['Invalid one'], ['invalid', 'invalid_group_by', '']);
  assert.deepEqual(status['Ready one'], ['ready', '', '2026-10-04T12:05:00.000Z']);
  assert.deepEqual(status['Edited since'], ['queued', '', ''], 'a result for an older definition does not count');
  const mine = data.mine.find(r => r.report_name === 'Ready one');
  assert.equal(mine.summary, 'Spending · by month · per category · last 6 months');
  assert.deepEqual(mine.allowed_actions, ['open', 'edit', 'duplicate', 'add_to_home', 'delete']);
  assert.equal(mine.home_slot, 'panel');
  const predefined = data.predefined.flatMap(group => group.items);
  assert.equal(predefined.some(item => item.kind === 'dataset'), false);
  const nw = predefined.find(item => item.id === netWorth);
  assert.deepEqual([nw.status, nw.status_reason], ['failed', 'missing_rate']);
  assert.deepEqual(predefined.find(item => item.key === 'kpi-net-worth').allowed_actions, ['add_to_home']);
  ctx.deleteReport({ row_num: rowNum(queued) });
  assert.equal(plain(view('listReportsView').data).mine.some(r => r.id === queued), false);
  assert.equal(plain(view('listReportsView', { include_deleted: 'true' }).data).mine.find(r => r.id === queued).allowed_actions[0], 'restore');
  assert.equal(view('listReportsView', { include_deleted: 'maybe' }).ok, false);
});

test('get_dashboard_layout: titled slots and the reports each slot can take', () => {
  const { ctx, view } = setup();
  const number = ctx.createReport(base({ report_name: 'Spend number', time_grain: 'none', group_by_1: '', chart_kind: 'number' })).id;
  const data = plain(view('getDashboardLayoutView').data);
  assert.equal(data.is_default, true);
  assert.deepEqual(data.slots.map(slot => slot.slot), ['tile_1', 'tile_2', 'tile_3', 'tile_4', 'panel_1', 'panel_2', 'panel_3', 'panel_4']);
  assert.equal(data.slots[0].title, 'Net worth');
  assert.ok(data.options.tile.some(option => option.report_id === number));
  assert.equal(data.options.panel.some(option => option.report_id === number), false);
  assert.equal(data.options.tile[0].title, 'Net worth', 'pre-built first, in catalogue order');
});

test('a hand edit of a definition cell queues the report; a sync-cell edit does not', () => {
  const { ctx, tab, row, rowNum } = setup();
  const { id } = ctx.createReport(base());
  const sheet = tab('report_master');
  sheet.rows[rowNum(id) - 1][ctx.reportColIndex('sync_status')] = 'in-sync';
  const event = column => ({ range: { getSheet: () => sheet, getColumn: () => column, getNumColumns: () => 1, getRow: () => rowNum(id), getNumRows: () => 1 } });
  assert.equal(ctx.markReportEditPending(event(ctx.reportColIndex('sync_notes') + 1)), true);
  assert.equal(row(id).sync_status, 'in-sync');
  assert.equal(ctx.markReportEditPending(event(ctx.reportColIndex('measure') + 1)), true);
  assert.equal(row(id).sync_status, 'update-pending');
  assert.equal(ctx.markReportEditPending({ range: { getSheet: () => tab('account_master') } }), false);
});

test('routes, the GET hook and a message for every contract error code', () => {
  const { ctx } = setup();
  const router = fs.readFileSync(path.join(API, 'app-router.gs'), 'utf8');
  for (const action of ['create_report', 'update_report', 'delete_report', 'restore_report', 'duplicate_report', 'update_dashboard_layout'])
    assert.match(router, new RegExp(`'${action}'`));
  const actions = ctx.grGetActions();
  assert.equal(actions.list_reports_view.cache, false);
  assert.equal(actions.get_dashboard_layout.cache, false);
  for (const code of vm.runInContext('REPORT_DEFINITION.error_codes', ctx)) assert.notEqual(ctx.vmMessage(code, ''), '', code);
  assert.equal(ctx._routerPostChangedData({ action: 'create_report' }, { ok: true, id: 'x' }), true);
});
