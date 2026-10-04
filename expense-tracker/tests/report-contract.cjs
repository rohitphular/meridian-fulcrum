const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const CONTRACT = path.join(__dirname, '../../data-synchronization/analytics/contract');
const GENERATED = path.join(__dirname, '../api/report-contract.gs');
const json = name => JSON.parse(fs.readFileSync(path.join(CONTRACT, name), 'utf8'));
const strip = value => Array.isArray(value) ? value.map(strip)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')).map(([key, item]) => [key, strip(item)]))
  : value;
const definition = json('report-definition.json');
const catalogue = json('predefined-reports.json');
const tabs = json('sheet-tabs.json');
const keys = list => list.map(item => item.key);

// RFC 4122 version 5 (SHA-1, name-based), as Python's uuid.uuid5.
function uuid5(namespace, name) {
  const hash = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('the generated GAS copy matches the contract JSON (run generate_gas.py after editing it)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`${fs.readFileSync(GENERATED, 'utf8')}\nthis.out = { REPORT_DEFINITION, REPORT_PREDEFINED, REPORT_SHEET_TABS };`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out.REPORT_DEFINITION)), strip(definition));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out.REPORT_PREDEFINED)), strip(catalogue));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.out.REPORT_SHEET_TABS)), strip(tabs));
  assert.equal(definition.contract_version, catalogue.contract_version);
  assert.equal(definition.contract_version, tabs.contract_version);
});

test('the report tabs in app-config.gs, the tab order and factory reset follow sheet-tabs.json', () => {
  const ctx = vm.createContext({});
  for (const file of ['app-config.gs', 'factory-reset.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), ctx);
  vm.runInContext('this.out = { names: [REPORT_MASTER_SHEET, DASHBOARD_LAYOUT_SHEET, REPORT_META_SHEET, REPORT_STATUS_SHEET, REPORT_INDEX_A_SHEET, REPORT_INDEX_B_SHEET, REPORT_DATA_A_SHEET, REPORT_DATA_B_SHEET], output: REPORT_OUTPUT_SHEETS, order: EXPENSE_TRACKER_SHEET_ORDER, reset: FACTORY_RESET_SHEETS };', ctx);
  const { names, output, order, reset } = JSON.parse(JSON.stringify(ctx.out));
  assert.deepEqual(names.slice().sort(), tabs.tabs.map(tab => tab.name).sort());
  assert.deepEqual(output.slice().sort(), tabs.tabs.filter(tab => tab.owner === 'analytics').map(tab => tab.name).sort());
  for (const tab of tabs.tabs) assert.ok(order.includes(tab.name), tab.name);
  for (const tab of tabs.tabs.filter(item => item.factory_reset === 'deleted_recomputed')) assert.ok(reset.includes(tab.name), tab.name);
  for (const name of tabs.legacy_tabs_removed_by_factory_reset) assert.ok(reset.includes(name) && !order.includes(name), name);
  // Rebuilt by ledger-sheet-load from report_master.csv / dashboard_layout.csv.
  for (const tab of tabs.tabs.filter(item => item.factory_reset === 'rebuilt_from_csv')) assert.ok(reset.includes(tab.name), tab.name);
});

test('sheet-tabs.json: unique names, both slots per slotted tab, columns defined', () => {
  const names = tabs.tabs.map(tab => tab.name);
  assert.equal(new Set(names).size, names.length);
  for (const tab of tabs.tabs) {
    assert.ok(['app', 'analytics'].includes(tab.owner), tab.name);
    if (tab.columns_from) assert.equal(tab.columns_from, 'report-definition.json');
    else assert.equal(new Set(tab.columns).size, tab.columns.length, tab.name);
  }
  for (const base of ['report_index', 'report_data']) for (const slot of tabs.slots) assert.ok(names.includes(`${base}_${slot}`));
  assert.ok(tabs.payload_chunk_max_chars < 50000);
});

test('report_master columns are unique and include every filter column and the sync cells', () => {
  const columns = definition.columns;
  assert.equal(new Set(columns).size, columns.length);
  for (const filter of definition.filters) assert.ok(columns.includes(filter.column), filter.column);
  for (const column of ['id', 'report_name', 'report_description', 'record_status', 'created_at', 'updated_at', 'sync_status', 'sync_date', 'sync_notes'])
    assert.ok(columns.includes(column), column);
  assert.equal(definition.name.max_length, 60);
});

test('the CSV files carry business columns and record_status only, like the other master CSVs', () => {
  const serverOwned = ['created_at', 'updated_at', 'sync_status', 'sync_date', 'sync_notes'];
  assert.deepEqual(definition.csv_columns, definition.columns.filter(column => !serverOwned.includes(column)));
  const layout = tabs.tabs.find(tab => tab.name === 'dashboard_layout');
  assert.deepEqual(layout.csv_columns, ['slot', 'report_id']);
});

test('enum lists have unique keys and every cross-reference resolves', () => {
  for (const list of ['report_types', 'measures', 'period_presets', 'compare_modes', 'time_grains', 'group_by', 'chart_kinds', 'filters'])
    assert.equal(new Set(keys(definition[list])).size, definition[list].length, list);
  const groupBy = keys(definition.group_by), measures = keys(definition.measures), periods = keys(definition.period_presets);
  for (const measure of definition.measures) if (measure.group_by !== 'all') for (const key of measure.group_by) assert.ok(groupBy.includes(key), key);
  for (const chart of definition.chart_kinds) {
    if (Array.isArray(chart.measures)) for (const key of chart.measures) assert.ok(measures.includes(key), key);
    else assert.ok(['all', 'additive'].includes(chart.measures), chart.key);
    for (const mode of chart.modes) {
      assert.ok(['required', 'forbidden', 'any'].includes(mode.time_grain), chart.key);
      assert.ok(mode.group_by_min <= mode.group_by_max && mode.group_by_max <= definition.group_by_rules.max, chart.key);
    }
  }
  for (const key of definition.compare_rules.not_with_periods) assert.ok(periods.includes(key), key);
  for (const key of definition.home.tile_kinds.concat(definition.home.panel_kinds)) assert.ok(keys(definition.chart_kinds).includes(key), key);
  assert.ok(definition.group_by_rules.top_n_values.includes(definition.group_by_rules.top_n_default));
  assert.equal(new Set(definition.error_codes).size, definition.error_codes.length);
  for (const key of definition.filter_rules.transaction_only) assert.ok(keys(definition.filters).includes(key), key);
});

test('pre-built reports have stable unique keys, fixed UUIDs and valid periods, slots and drills', () => {
  const periods = keys(definition.period_presets);
  const reports = catalogue.reports;
  assert.equal(new Set(keys(reports)).size, reports.length);
  for (const report of reports) {
    assert.equal(report.id, uuid5(catalogue.uuid_namespace, report.key), report.key);
    assert.ok(['chart', 'number', 'dataset'].includes(report.kind), report.key);
    assert.equal(report.home_slot, { chart: 'panel', number: 'tile', dataset: null }[report.kind], report.key);
    if (report.kind !== 'dataset') assert.ok(catalogue.groups.includes(report.group), report.key);
    for (const period of report.periods) assert.ok(periods.includes(period), `${report.key} ${period}`);
    if (report.periods.length > 0) assert.ok(report.periods.includes(report.default_period), report.key);
    for (const drill of report.drills) assert.ok(['aggregate', 'query_only'].includes(drill.published), report.key);
    for (const control of report.controls) assert.ok(control.values.includes(control.default), report.key);
    if (report.sortable) assert.ok(report.sortable.columns.includes(report.sortable.default.col), report.key);
  }
  const byKey = Object.fromEntries(reports.map(report => [report.key, report]));
  assert.equal(catalogue.default_layout.tiles.length, definition.home.tiles);
  assert.equal(catalogue.default_layout.panels.length, definition.home.panels);
  for (const key of catalogue.default_layout.tiles) assert.equal(byKey[key]?.home_slot, 'tile', key);
  for (const key of catalogue.default_layout.panels) assert.equal(byKey[key]?.home_slot, 'panel', key);
});

test('the current insights are all in the catalogue (18 was never registered)', () => {
  const current = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17',
    '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30'];
  const prefixes = new Set(catalogue.reports.map(report => report.key.slice(0, 2)));
  for (const id of current) assert.ok(prefixes.has(id), id);
});
