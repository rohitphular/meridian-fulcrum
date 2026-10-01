const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const account = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const identity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function load(file, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../app', file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source, context);
  return context;
}

test('exported subscription CSV matches every Sheet column and round-trips without losing precision or UTC audit values', () => {
  const gas = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api/subscription-schema.gs'), 'utf8'), gas);
  const schema = gas.getSubscriptionSchemaForClient();
  const state = { subscriptionSchema: schema };
  const utils = load('core/utils.js', { state, _exportData: (_format, rows, filename, columns) => ({ rows, filename, columns }) });
  const row = {
    id: identity, subscription_name: 'Synthetic', subscription_amount_local: '90071992547409.925',
    frequency: 'monthly', day_of_month: 15, source_account: account, record_status: 'inactive',
    created_at: '2026-01-01T23:45:12.123Z', updated_at: '2026-09-01T01:02:03Z',
    sync_status: 'in-sync', sync_date: '2026-09-01T01:02:05Z', sync_notes: '',
    description: 'Quoted "note"\nwith a second line', subscription_timezone_local: 'Europe/London',
    subscription_start_date_local: '2026-01-01 00:00:00.123456',
  };
  const exported = vm.runInContext('exportSubscriptions', utils)('csv', [row]);
  assert.deepEqual(Array.from(exported.columns), Array.from(gas.getSubscriptionSheetColumns()));
  assert.equal(exported.rows[0].created_at, row.created_at);
  assert.equal(exported.rows[0].updated_at, row.updated_at);
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const csv = exported.columns.join(',') + '\n' + exported.columns.map(key => quote(row[key])).join(',');
  const backend = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  for (const file of ['app-config.gs', 'app-utils.gs', 'subscription-schema.gs', 'subscription-utils.gs', 'subscription-validation.gs', 'csv-import.gs', 'subscription-import.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), backend);
  }
  const forwarded = [];
  backend.createSubscriptionsBulk = body => { forwarded.push(...body.subscriptions); return { ok: true, results: body.subscriptions.map((_, index) => ({ index, ok: true, action: 'created' })) }; };
  const result = backend.importSubscriptionsCsv({ csv });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.results[0].line, 2);
  assert.equal(forwarded[0].subscription_amount_local, row.subscription_amount_local);
  assert.equal(forwarded[0].description, row.description);
  assert.equal(forwarded[0].record_status, 'inactive');
  assert.equal(forwarded[0].subscription_timezone_local, 'Europe/London');
  assert.equal(forwarded[0].id, identity);
  assert.equal(forwarded[0].subscription_start_date_local, row.subscription_start_date_local);
  assert.equal(forwarded[0].created_at, undefined);
  assert.equal(forwarded[0].sync_status, undefined);
});

test('pause sends only lifecycle intent so it cannot overwrite business fields from an old browser snapshot', async () => {
  const payloads = [], events = [];
  const context = load('sections/subscriptions.js', {
    state: { views: { list_subscriptions_view: { ok: true, data: { rows: [{ _row: 2, row_num: 2, id: identity, updated_at: '2026-09-01T00:00:00Z', record_status: 'active',
      allowed_actions: ['edit', 'pause', 'transactions', 'delete'], description: 'Stale browser text', subscription_amount_local: '12.345' }] } } } },
    ExpenseAPI: { async updateSubscription(body) { payloads.push(body); return { ok: true }; } },
    showLoading() {}, hideLoading() {}, showMsg() {},
    document: { dispatchEvent: event => events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
  });
  await context._toggle(identity);   // rows are addressed by id
  assert.deepEqual(JSON.parse(JSON.stringify(payloads)), [{ row_num: 2, record_status: 'inactive', id: identity, updated_at: '2026-09-01T00:00:00Z' }]);
  assert.deepEqual(events, ['et:reload']);
});

// The "already subscribed" heuristic (shared fields, removed tags ignored, deleted
// definitions excluded) is server-side now: view-transactions-backend.cjs covers
// get_transaction_prefill mode=subscribe and the 'subscribe' allowed action.
