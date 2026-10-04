// Report store (task 14): reading what the analytics job published — missing
// tabs, the active-slot switch, chunk joins, variant keys, XAU → quote
// conversion against the Python fixture, missing rates, failed reports, Home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { seedViewFixture } = require('./support/view-fixture.cjs');
const { publish, payload, predefinedId, PREDEFINED, CONTRACT } = require('./support/report-publish.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const NET_WORTH = predefinedId('kpi-net-worth');
const TOP_PAYEES = predefinedId('22-top-counterparties');

function appRuntime() {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  return runtime;
}

const tile = grams => payload({ stat_cards: [{ key: 'value', label: 'Net worth', value: grams, format: 'money' }] });

test('nothing published yet: every read says so, nothing is created', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_report', id: NET_WORTH });
  assert.equal(response.ok, true);
  assert.equal(response.data.payload, null);
  assert.deepEqual(response.warnings, [{ code: 'not_published' }]);
  assert.equal(response.generation_id, '');
  const home = runtime.get({ action: 'get_home_view' });
  assert.equal(home.data.slots.length, 8);
  assert.ok(home.data.slots.every(slot => slot.payload === null));
  assert.equal(runtime.sheets.some(sheet => sheet.name.startsWith('report_meta') || sheet.name.startsWith('report_data')), false);
});

test('a payload split into chunks is joined, parsed and converted at the quote rate', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [{ report_id: NET_WORTH, payload: tile(40.5) }], chunk: 25 });
  assert.ok(runtime.sheets.find(sheet => sheet.name === 'report_data_a').rows.length > 3, 'several chunks');
  const response = runtime.get({ action: 'get_report', id: NET_WORTH });
  assert.equal(response.data.payload.stat_cards[0].value, 40.5 * 80);
  assert.deepEqual([response.generation_id, response.published_at, response.quote.rate], ['gen-1', '2026-09-30T06:00:00.000Z', 80]);
  const inr = runtime.get({ action: 'get_report', id: NET_WORTH, quote_currency: 'INR' });
  assert.equal(inr.data.payload.stat_cards[0].value, 40.5 * 8400);
});

test('the app reads only the slot report_meta names; a new generation is read at once', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [{ report_id: NET_WORTH, payload: tile(1) }] });
  assert.equal(runtime.get({ action: 'get_report', id: NET_WORTH }).data.payload.stat_cards[0].value, 80);
  // A publish in progress writes slot b; until report_meta switches, slot a stays live.
  publish(runtime.sheets, { generation_id: 'gen-2', slot: 'b', outputs: [{ report_id: NET_WORTH, payload: tile(2) }], skipMeta: true });
  assert.equal(runtime.get({ action: 'get_report', id: NET_WORTH }).data.payload.stat_cards[0].value, 80);
  publish(runtime.sheets, { generation_id: 'gen-2', slot: 'b', outputs: [{ report_id: NET_WORTH, payload: tile(2) }] });
  const response = runtime.get({ action: 'get_report', id: NET_WORTH });
  assert.deepEqual([response.generation_id, response.data.payload.stat_cards[0].value], ['gen-2', 160]);
});

test('variant keys follow the contract: sorted, defaults left out, encoded like Python quote()', () => {
  const { ctx } = appRuntime();
  const entry = PREDEFINED.reports.find(report => report.key === '22-top-counterparties');
  const key = params => plain(ctx.rsPredefinedVariant(entry, params));
  assert.deepEqual(key({}), { ok: true, key: '' });
  assert.deepEqual(key({ period: entry.default_period, top_n: String(entry.controls[0].default) }), { ok: true, key: '' });
  assert.deepEqual(key({ period: 'ytd', top_n: '20' }), { ok: true, key: 'period=ytd&top_n=20' });
  assert.deepEqual(key({ drill: "counterparty:o'neil (uk)!*" }), { ok: true, key: 'drill=counterparty%3Ao%27neil%20%28uk%29%21%2A' });
  // A drill is published for the default controls only: a changed control is dropped, the period kept.
  assert.deepEqual(key({ period: 'ytd', top_n: '20', drill: 'counterparty:tesco' }), { ok: true, key: 'drill=counterparty%3Atesco&period=ytd' });
  assert.equal(key({ period: 'fortnight' }).error, 'invalid_period');
  assert.equal(key({ top_n: '11' }).error, 'invalid_filter');
  assert.equal(key({ drill: 'major:food' }).error, 'invalid_drill');
});

test('get_report finds a drill variant; an unknown variant or report is reported', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [
    { report_id: TOP_PAYEES, payload: payload({ title: 'base' }) },
    { report_id: TOP_PAYEES, variant_key: 'drill=counterparty%3Atesco', payload: payload({ drill: { title: 'Tesco', subtitle: { text: '{0} in this period', values: [{ value: 2, format: 'money' }] } } }) },
  ] });
  const drill = runtime.get({ action: 'get_report', id: TOP_PAYEES, drill: 'counterparty:tesco' });
  assert.deepEqual(plain(drill.data.payload.drill.subtitle), { text: '{0} in this period', values: [{ value: 160, format: 'money' }] });
  assert.equal(drill.data.variant_key, 'drill=counterparty%3Atesco');
  const other = runtime.get({ action: 'get_report', id: TOP_PAYEES, period: 'ytd' });
  assert.deepEqual([other.data.payload, other.warnings], [null, [{ code: 'variant_not_published' }]]);
  assert.equal(runtime.get({ action: 'get_report', id: 'not-a-uuid' }).error, 'report_not_found');
  assert.equal(runtime.get({ action: 'get_report', id: '99999999-9999-4999-8999-999999999999' }).error, 'report_not_found');
});

test('a report the job could not compute carries its error code', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [], results: [{ report_id: NET_WORTH, status: 'failed', error_code: 'invalid_payload:charts[0]:kind' }] });
  const response = runtime.get({ action: 'get_report', id: NET_WORTH });
  assert.deepEqual([response.data.payload, response.warnings], [null, [{ code: 'report_failed', error_code: 'invalid_payload:charts[0]:kind' }]]);
});

test('every money value in the Python fixture is converted, and nothing else', () => {
  const { ctx } = appRuntime();
  const fixture = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'fixtures', 'payload-conversion.json'), 'utf8'));
  const converted = plain(ctx.rsConvert(fixture.payload, 2));
  const leaves = (value, at, out) => {
    if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${at}[${index}]`, out));
    else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([key, item]) => leaves(item, at === '' ? key : `${at}.${key}`, out));
    else out.set(at, value);
    return out;
  };
  const before = leaves(fixture.payload, '', new Map());
  const after = leaves(converted, '', new Map());
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'same shape');
  const money = new Set(fixture.money_paths);
  for (const [at, value] of before) assert.equal(after.get(at), money.has(at) ? value * 2 : value, at);
  // Missing rate: money becomes null, never 1:1.
  const missing = leaves(plain(ctx.rsConvert(fixture.payload, null)), '', new Map());
  for (const at of money) assert.equal(missing.get(at), null, at);
});

test('a quote currency without a rate returns null money and a missing_rate warning', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [{ report_id: NET_WORTH, payload: tile(3) }] });
  const response = runtime.get({ action: 'get_report', id: NET_WORTH, quote_currency: 'USD' });
  assert.equal(response.data.payload.stat_cards[0].value, null);
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
});

test('get_home_view fills the default layout with each slot report’s default payload', () => {
  const runtime = appRuntime();
  const layout = PREDEFINED.default_layout;
  const ids = [...layout.tiles, ...layout.panels].map(predefinedId);
  publish(runtime.sheets, { outputs: ids.map((id, index) => ({ report_id: id, payload: tile(index + 1) })) });
  const home = runtime.get({ action: 'get_home_view' });
  assert.equal(home.data.is_default_layout, true);
  assert.deepEqual(home.data.slots.map(slot => [slot.slot, slot.area, slot.report_id]), ['tile_1', 'tile_2', 'tile_3', 'tile_4', 'panel_1', 'panel_2', 'panel_3', 'panel_4'].map((slot, index) => [slot, slot.split('_')[0], ids[index]]));
  assert.deepEqual(home.data.slots.map(slot => slot.payload.stat_cards[0].value), ids.map((_, index) => (index + 1) * 80));
  assert.ok(home.data.slots.every(slot => slot.title !== ''));
});

test('the index is read once per generation; each payload once', () => {
  const runtime = appRuntime();
  publish(runtime.sheets, { outputs: [{ report_id: NET_WORTH, payload: tile(1) }, { report_id: TOP_PAYEES, payload: payload() }] });
  const index = runtime.sheets.find(sheet => sheet.name === 'report_index_a');
  runtime.get({ action: 'get_report', id: NET_WORTH });
  runtime.get({ action: 'get_report', id: TOP_PAYEES });
  runtime.get({ action: 'get_report', id: NET_WORTH, quote_currency: 'INR' });
  assert.equal(index.reads, 1);
});

test('the advisor snapshot is the published figures in XAU, not a calculation', () => {
  const runtime = appRuntime();
  const { ctx } = runtime;
  assert.deepEqual(plain(ctx._buildSnapshot()), { note: 'No published figures yet: the analytics job has not run.', published_at: '' });
  const card = (key, value) => ({ key, label: key, value, format: 'money' });
  publish(runtime.sheets, { outputs: [
    { report_id: predefinedId('dataset-accounts-summary'), payload: payload({ stat_cards: [card('total_assets', 12.3456), card('total_liabilities', 2), card('net_worth', 10.3456), card('liquid_cash', 5)] }) },
    { report_id: predefinedId('dataset-account-balances'), payload: payload({ tables: [{ id: 'balances', columns: [], rows: [
      { key: 'x', cells: { account_id: 'x', name: 'Bank', type: 'asset', subtype: 'Current', currency: 'GBP', record_status: 'active', balance_local: 800, balance: 10 } },
      { key: 'y', cells: { account_id: 'y', name: 'Old', type: 'asset', subtype: 'Current', currency: 'GBP', record_status: 'deleted', balance_local: 0, balance: 0 } }] }] }) },
    { report_id: predefinedId('06-last-12-months'), payload: payload({ charts: [{ id: 'months', kind: 'mixed', labels: ['Sep 26'], y_format: 'money', ref_lines: [], datasets: [{ key: 'income', data: [30] }, { key: 'expense', data: [18.25] }] }] }) },
    { report_id: predefinedId('10-top-categories'), variant_key: 'period=last_3', payload: payload({ tables: [{ id: 'changes', columns: [], rows: [{ key: 'rent|general', cells: { category: 'Rent › General', current: 30 } }] }] }) },
  ] });
  const snapshot = plain(ctx._buildSnapshot());
  assert.deepEqual([snapshot.net_worth_xau, snapshot.total_assets_xau, snapshot.liquid_cash_xau, snapshot.published_at], [10.346, 12.346, 5, '2026-09-30T06:00:00.000Z']);
  assert.deepEqual(snapshot.accounts, [{ name: 'Bank', type: 'asset', sub_type: 'Current', currency: 'GBP', balance_local: 800, balance_xau: 10 }]);
  assert.deepEqual(snapshot.last_12_months, { months: ['Sep 26'], income: [30], spending: [18.25] });
  assert.deepEqual(snapshot.top_spending_categories_last_3_months, [{ category: 'Rent › General', amount: 30 }]);
  assert.deepEqual(snapshot.top_payees_last_3_months, []);
});
