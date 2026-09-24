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
  const frontend = load('sections/subscriptions.js', { state });
  const parsed = frontend._parseSubscriptionsCsv(csv);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.subscriptions[0].subscription_amount_local, row.subscription_amount_local);
  assert.equal(parsed.subscriptions[0].description, row.description);
  assert.equal(parsed.subscriptions[0].record_status, 'inactive');
  assert.equal(parsed.subscriptions[0].created_at, undefined);
  assert.equal(parsed.subscriptions[0].sync_status, undefined);
});

test('pause sends only lifecycle intent so it cannot overwrite business fields from an old browser snapshot', async () => {
  const payloads = [], events = [];
  const context = load('sections/subscriptions.js', {
    state: { subscriptions: [{ _row: 2, record_status: 'active', description: 'Stale browser text', subscription_amount_local: '12.345' }] },
    ExpenseAPI: { async updateSubscription(body) { payloads.push(body); return { ok: true }; } },
    showLoading() {}, hideLoading() {}, showMsg() {},
    document: { dispatchEvent: event => events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
  });
  await context._toggle(2);
  assert.deepEqual(JSON.parse(JSON.stringify(payloads)), [{ row_num: 2, record_status: 'inactive' }]);
  assert.deepEqual(events, ['et:reload']);
});

test('subscription suggestions use shared fields, ignore removed tags and exclude deleted definitions', () => {
  const state = { subscriptions: [] };
  const context = load('sections/transactions.js', { state });
  const transaction = { account_id: account, tx_type: 'money-out', major_category: 'bills', minor_category: 'test', counterparty_name: 'Merchant', tx_tags: 'tagged-transaction' };
  const subscription = { source_account: account.toUpperCase(), tx_type: 'money-out', major_category: 'bills', minor_category: 'test', counterparty_name: ' merchant ', record_status: 'active' };
  state.subscriptions = [subscription];
  assert.equal(context._isAlreadySubscribed(transaction), true);
  state.subscriptions = [{ ...subscription, record_status: 'deleted' }];
  assert.equal(context._isAlreadySubscribed(transaction), false);
  state.subscriptions = [{ ...subscription, source_account: identity }];
  assert.equal(context._isAlreadySubscribed(transaction), false);
  state.subscriptions = [{ ...subscription, minor_category: 'different' }];
  assert.equal(context._isAlreadySubscribed(transaction), false);
  state.subscriptions = [{ ...subscription, tx_type: '', major_category: '', minor_category: '', record_status: 'inactive' }];
  assert.equal(context._isAlreadySubscribed(transaction), true);
});
