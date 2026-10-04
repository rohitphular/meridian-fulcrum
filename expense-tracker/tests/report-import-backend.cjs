// Report configuration CSV round trip (task 04): create_reports_bulk and
// import_dashboard_layout, the exports, and the seed files from the contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');

const SEED = path.join(__dirname, '../../data-synchronization/analytics/contract/seed');
const HSBC = '11111111-1111-4111-8111-111111111111';
const OLD = '33333333-3333-4333-8333-333333333333';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const plain = value => JSON.parse(JSON.stringify(value));
const cell = value => /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
const toCsv = (columns, rows) => [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column] ?? '')).join(','))].join('\n') + '\n';

function setup() {
  const sheets = [];
  const { ctx, Sheet } = gasRuntime({ sheets });
  const accountColumns = ctx.getAccountSheetColumns();
  const account = (id, status) => accountColumns.map(column => ({ id, account_name: id.slice(0, 4), account_currency_local: 'GBP', record_status: status })[column] ?? '');
  sheets.push(new Sheet('account_master', [accountColumns, account(HSBC, 'active'), account(OLD, 'deleted')]));
  sheets.push(new Sheet('category_master', [ctx.getCategorySheetColumns()]));
  const tab = name => sheets.find(sheet => sheet.name === name);
  const rows = () => plain(ctx.listReportRows());
  const view = action => plain(ctx[action]({ params: {}, quote_currency: 'GBP', data_version: 'v', computed_at: 'now' }).data);
  return { ctx, sheets, tab, rows, view };
}

const mine = (extra = {}) => ({
  id: MINE, report_type: 'user_defined', report_name: 'Monthly spend', measure: 'spend', period_preset: 'last_6',
  time_grain: 'month', group_by_1: 'category', chart_kind: 'stacked', ...extra,
});
const reportCsv = (ctx, list) => toCsv(ctx.getReportCsvColumns(), list);

test('the seed report_master.csv creates every pre-built row locked, and re-imports as unchanged', () => {
  const { ctx, tab, rows } = setup();
  const csv = fs.readFileSync(path.join(SEED, 'report_master.csv'), 'utf8');
  const first = plain(ctx.importReportsCsv({ csv }));
  assert.equal(first.ok, true);
  const catalogue = JSON.parse(fs.readFileSync(path.join(SEED, '../predefined-reports.json'), 'utf8')).reports;
  assert.equal(first.created, catalogue.length);
  const stored = rows();
  assert.ok(stored.every(row => row.report_type === 'predefined' && row.record_status === 'locked' && row.sync_status === 'create-pending'));
  assert.equal(stored.find(row => row.predefined_key === '14-networth-trend').report_name, 'Net worth trend');
  const writes = tab('report_master').writes;
  const again = plain(ctx.importReportsCsv({ csv }));
  assert.deepEqual([again.created, again.updated, again.skipped], [0, 0, catalogue.length]);
  assert.equal(tab('report_master').writes, writes, 'an unchanged file writes nothing');
});

test('pre-built rows must carry the catalogue id and key; their name comes from the contract', () => {
  const { ctx, rows } = setup();
  const report = { id: ctx.rptPredefinedByKey('08-category-pie').id, report_type: 'predefined', predefined_key: '08-category-pie', report_name: 'Renamed by hand' };
  assert.equal(ctx.importReportsCsv({ csv: reportCsv(ctx, [report]) }).ok, true);
  assert.equal(rows()[0].report_name, 'Spending by category');
  for (const bad of [{ ...report, predefined_key: 'nope' }, { ...report, id: MINE }]) {
    const result = plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [bad]) }));
    assert.equal(result.error, 'invalid_csv_rows');
    assert.match(result.errors[0], /^Row 2: invalid_predefined_key/);
  }
  assert.match(plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [{ ...mine(), predefined_key: '08-category-pie' }]) })).errors[0], /invalid_predefined_key \(predefined_key\)/);
});

test('user reports import by id: created, unchanged, updated and queued, deleted clears Home', () => {
  const { ctx, tab, rows } = setup();
  const created = plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine()]) }));
  assert.deepEqual([created.created, created.results[0].action, created.results[0].line], [1, 'created', 2]);
  assert.equal(rows()[0].id, MINE);
  assert.equal(rows()[0].sync_status, 'create-pending');
  assert.equal(plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine()]) })).skipped, 1);
  tab('report_master').rows[1][ctx.reportColIndex('sync_status')] = 'in-sync';
  const updated = plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine({ period_preset: 'last_12' })]) }));
  assert.equal(updated.updated, 1);
  assert.deepEqual([rows()[0].period_preset, rows()[0].sync_status], ['last_12', 'update-pending']);
  const number = { ...mine({ id: '55555555-5555-4555-8555-555555555555', report_name: 'A number', time_grain: 'none', group_by_1: '', chart_kind: 'number' }) };
  ctx.importReportsCsv({ csv: reportCsv(ctx, [number]) });
  const slots = plain(ctx.readDashboardLayout().slots);
  assert.equal(ctx.updateDashboardLayout({ slots: { ...slots, tile_4: number.id } }).ok, true);
  assert.equal(ctx.importReportsCsv({ csv: reportCsv(ctx, [{ ...number, record_status: 'deleted' }]) }).updated, 1);
  assert.equal(ctx.readDashboardLayout().slots.tile_4, '');
});

test('a dry run checks the format only; the real import also checks references, and a bad file writes nothing', () => {
  const { ctx, sheets } = setup();
  const csv = reportCsv(ctx, [mine({ filter_account_ids: OLD })]);
  assert.deepEqual(plain(ctx.importReportsCsv({ csv, dry_run: true })), { ok: true, dry_run: true, rows: 1 });
  assert.equal(sheets.some(sheet => sheet.name === 'report_master'), false, 'a dry run never touches a Sheet');
  const result = plain(ctx.importReportsCsv({ csv }));
  assert.equal(result.error, 'invalid_csv_rows');
  assert.match(result.errors[0], /^Row 2: unknown_filter_reference \(filter_account_ids\)/);
  assert.equal(ctx.listReportRows().length, 0);
});

test('ids and names must be unique across the file and the reports it does not change; types never change', () => {
  const { ctx } = setup();
  const twice = plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine(), mine({ report_name: 'Other' })]) }));
  assert.match(twice.errors[0], /^Row 3: id repeats row 2/);
  const sameName = plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine(), mine({ id: HSBC, report_name: 'MONTHLY SPEND' })]) }));
  assert.match(sameName.errors[0], /^Row 3: duplicate_report_name/);
  ctx.createReport({ ...mine(), report_name: 'Taken' });
  assert.match(plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [mine({ report_name: 'taken' })]) })).errors[0], /duplicate_report_name/);
  ctx.importReportsCsv({ csv: reportCsv(ctx, [mine()]) });
  const retyped = { id: MINE, report_type: 'predefined', predefined_key: '08-category-pie' };
  assert.match(plain(ctx.importReportsCsv({ csv: reportCsv(ctx, [retyped]) })).errors[0], /invalid_predefined_key \(id\)/);
  assert.equal(plain(ctx.importReportsCsv({ csv: 'report_name\nx\n' })).error, 'invalid_csv_headers');
});

test('export_reports → CSV → import is a no-op round trip', () => {
  const { ctx, view } = setup();
  ctx.importReportsCsv({ csv: fs.readFileSync(path.join(SEED, 'report_master.csv'), 'utf8') });
  ctx.importReportsCsv({ csv: reportCsv(ctx, [mine({ filter_account_ids: HSBC, filter_tags: 'Holiday;work', report_description: 'Has, a "comma"' })]) });
  const exported = view('vwRptExportReports');
  assert.equal(exported.filename, 'report_master');
  assert.deepEqual(exported.columns, plain(ctx.getReportCsvColumns()), 'no audit or sync columns in the backup');
  const result = plain(ctx.importReportsCsv({ csv: toCsv(exported.columns, exported.rows) }));
  assert.deepEqual([result.created, result.updated, result.skipped], [0, 0, exported.count]);
});

test('dashboard_layout.csv: the seed saves the default layout once, then re-imports as unchanged', () => {
  const { ctx, tab, view } = setup();
  ctx.importReportsCsv({ csv: fs.readFileSync(path.join(SEED, 'report_master.csv'), 'utf8') });
  const csv = fs.readFileSync(path.join(SEED, 'dashboard_layout.csv'), 'utf8');
  assert.deepEqual(plain(ctx.importDashboardLayoutCsv({ csv, dry_run: true })), { ok: true, dry_run: true, rows: 8 });
  assert.equal(tab('dashboard_layout'), undefined);
  const first = plain(ctx.importDashboardLayoutCsv({ csv }));
  assert.deepEqual([first.created, first.updated, first.skipped], [8, 0, 0]);
  assert.equal(ctx.readDashboardLayout().is_default, false);
  const writes = tab('dashboard_layout').writes;
  assert.equal(plain(ctx.importDashboardLayoutCsv({ csv })).skipped, 8);
  assert.equal(tab('dashboard_layout').writes, writes);
  const exported = view('vwRptExportLayout');
  assert.deepEqual(exported.rows.map(row => row.slot), ['tile_1', 'tile_2', 'tile_3', 'tile_4', 'panel_1', 'panel_2', 'panel_3', 'panel_4']);
  assert.equal(plain(ctx.importDashboardLayoutCsv({ csv: toCsv(exported.columns, exported.rows) })).skipped, 8);
});

test('dashboard_layout.csv errors: unknown, repeated or missing slots, bad ids, and the slot rules', () => {
  const { ctx } = setup();
  const lines = body => 'slot,report_id\n' + body;
  assert.match(plain(ctx.importDashboardLayoutCsv({ csv: lines('tile_9,\n') })).errors[0], /^Row 2: invalid_dashboard_slot/);
  assert.match(plain(ctx.importDashboardLayoutCsv({ csv: lines('tile_1,\ntile_1,\n') })).errors[0], /^Row 3: slot repeats/);
  assert.match(plain(ctx.importDashboardLayoutCsv({ csv: lines('tile_1,not-a-uuid\n') })).errors[0], /^Row 2: invalid_id/);
  assert.match(plain(ctx.importDashboardLayoutCsv({ csv: lines('tile_1,\n') })).errors[0], /^Missing slots: tile_2/);
  const slots = ['tile_1', 'tile_2', 'tile_3', 'tile_4', 'panel_1', 'panel_2', 'panel_3', 'panel_4'];
  const chart = ctx.rptPredefinedByKey('08-category-pie').id;
  const result = plain(ctx.importDashboardLayoutCsv({ csv: lines(slots.map(slot => `${slot},${slot === 'tile_1' ? chart : ''}`).join('\n') + '\n') }));
  assert.deepEqual([result.error, result.field], ['report_not_allowed_in_slot', 'tile_1']);
});

test('the seed files are generated from the contract and fill_csv_ids leaves them alone', () => {
  const { ctx } = setup();
  for (const name of ['report_master.csv', 'dashboard_layout.csv']) {
    const csv = fs.readFileSync(path.join(SEED, name), 'utf8');
    assert.equal(plain(ctx.fillCsvIds({ csv })).filled, 0, name);
  }
  const lines = fs.readFileSync(path.join(SEED, 'report_master.csv'), 'utf8').trim().split('\n');
  assert.equal(lines[0], ctx.getReportCsvColumns().join(','));
  for (const column of ['created_at', 'updated_at', 'sync_status', 'sync_date', 'sync_notes']) assert.equal(lines[0].split(',').includes(column), false, column);
  assert.equal(fs.readFileSync(path.join(SEED, 'dashboard_layout.csv'), 'utf8').split('\n')[0], 'slot,report_id');
  const catalogue = JSON.parse(fs.readFileSync(path.join(SEED, '../predefined-reports.json'), 'utf8')).reports;
  assert.deepEqual(lines.slice(1).map(line => line.split(',')[0]), catalogue.map(report => report.id), 'run generate_seed.py after a catalogue change');
});

test('an older file that still has audit or sync columns imports the same way: those columns are ignored', () => {
  const { ctx, rows } = setup();
  const columns = [...ctx.getReportCsvColumns(), 'created_at', 'updated_at', 'sync_status', 'sync_date', 'sync_notes'];
  const result = plain(ctx.importReportsCsv({ csv: toCsv(columns, [{ ...mine(), created_at: '2020-01-01', updated_at: '2020-01-01', sync_status: 'in-sync', sync_notes: 'x' }]) }));
  assert.equal(result.created, 1);
  const stored = rows()[0];
  assert.equal(stored.sync_status, 'create-pending');
  assert.notEqual(stored.created_at, '2020-01-01');
  assert.equal(stored.sync_notes, '');
});
