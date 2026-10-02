// Phase 0 view foundations: GET registry routing, get_app_context shape,
// per-request dataset reads, view-cache keys / invalidation, data_version bumps
// (POST + onEdit), audit batching, and load-order independence of new files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { API, Sheet, gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, seedViewFixture } = require('./support/view-fixture.cjs');

const NEW_FILES = ['view-cache.gs', 'fx-utils.gs', 'ledger-core.gs', 'view-context.gs', 'get-registry.gs', 'view-config.gs'];
const plain = value => JSON.parse(JSON.stringify(value));

function appRuntime() {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  runtime.post = body => JSON.parse(runtime.ctx.doPost({ postData: { contents: JSON.stringify({ pin: '1234', ...body }) } }).getContent());
  runtime.version = () => runtime.props.store.get('DATA_VERSION') || '0';
  return runtime;
}

test('new foundation files have no load-time cross-file dependencies', () => {
  for (const file of NEW_FILES) {
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(API, file), 'utf8'), vm.createContext({}), { filename: file }), file);
  }
  // GAS file order is not guaranteed: the project still loads with the new files first.
  const rest = fs.readdirSync(API).filter(file => file.endsWith('.gs') && !NEW_FILES.includes(file)).sort();
  assert.doesNotThrow(() => gasRuntime({ files: [...NEW_FILES].reverse().concat(rest) }));
});

test('router delegates unknown actions to the registry and keeps existing actions', () => {
  const runtime = appRuntime();
  assert.equal(runtime.get({ action: 'nope' }).error, 'unknown_action');
  for (const action of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(runtime.get({ action }).error, 'unknown_action', action);
  assert.equal(runtime.get({ action: 'get_app_context' }).ok, true);
  const rates = runtime.get({ action: 'list_rates' });
  assert.equal(rates.ok, true);
  assert.equal(rates.data.length, 3);
  assert.equal(runtime.get({ action: 'get_account_schema' }).data.types.length, 3);
  assert.equal(runtime.get({ action: 'get_app_context', pin: 'wrong' }).error, 'auth');
  assert.equal(runtime.ctx.grHasGetAction('get_app_context'), true);
  assert.equal(runtime.ctx.grHasGetAction('toString'), false);
});

test('get_app_context returns schemas, quote currencies, option trees, periods and the envelope', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_app_context', quote_currency: 'gbp', tz: 'Asia/Kolkata', today: '2026-09-30' });
  assert.equal(response.ok, true);
  assert.equal(response.data_version, '0');
  assert.match(response.computed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(response.quote, { currency: 'GBP', symbol: '£', rate_available: true });
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const data = response.data;
  assert.deepEqual([data.default_quote, data.default_timezone, data.tz, data.today], ['GBP', 'Europe/London', 'Asia/Kolkata', '2026-09-30']);
  assert.deepEqual(Object.keys(data.schemas).sort(), ['account', 'account_type', 'category', 'rate', 'subscription', 'transaction']);
  assert.deepEqual(data.schemas.account, plain(runtime.ctx.getAccountSchemaForClient()));
  assert.deepEqual(data.schemas.subscription, plain(runtime.ctx.getSubscriptionSchemaForClient()));
  for (const key of ['fields', 'types', 'record_statuses', 'columns']) assert.ok(Array.isArray(data.schemas.account_type[key]), key);
  assert.deepEqual(data.quote_currencies, [
    { currency: 'GBP', symbol: '£', rate: 80, rate_label: '80.00' },
    { currency: 'INR', symbol: '₹', rate: 8400, rate_label: '8400.00' },
    { currency: 'XAU', symbol: '⊕', rate: 1, rate_label: '1.00' },
  ]);
  // Deleted accounts / categories are omitted; majors are active when any minor is.
  assert.deepEqual(data.options.accounts.map(group => [group.type, group.type_label, group.accounts.map(a => a.account_name)]),
    [['asset', 'Asset', ['Bank', 'Rupee']], ['investment', 'Investment', ['Brokerage']], ['liability', 'Liability', ['Card']]]);
  assert.deepEqual(data.options.accounts[0].accounts[1], { id: ID(12), account_name: 'Rupee', sub_type: 'current', sub_type_label: 'Current', currency: 'INR', currency_symbol: '₹', record_status: 'inactive' });
  const out = data.options.categories.find(type => type.tx_type === 'money-out');
  assert.equal(out.label, 'Money Out');
  assert.deepEqual(out.majors.map(major => [major.key, major.is_active, major.minors.map(minor => minor.key)]), [['food', true, ['groceries', 'takeaway']], ['transfer', true, ['own']]]);
  assert.deepEqual(out.majors[0].minors[1], { key: 'takeaway', label: 'Takeaway', record_status: 'inactive', is_active: false, source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false });
  assert.ok(data.periods.some(period => period.value === 'last_30' && period.label === 'Last 30 days'));
  // Phase 4: the insights registry (insights-registry.gs) fills nav.
  assert.deepEqual(data.nav, { insights_registry: plain(runtime.ctx.insightsRegistryForClient()) });
  assert.equal(data.nav.insights_registry.length, 30);
});

test('view params are validated with field-level messages', () => {
  const runtime = appRuntime();
  for (const [params, error, field] of [[{ tz: '+05:30' }, 'invalid_timezone', 'tz'], [{ tz: 'Not/AZone' }, 'invalid_timezone', 'tz'],
    [{ quote_currency: 'G B P' }, 'invalid_quote_currency', 'quote_currency'], [{ today: '2026-02-30' }, 'invalid_today', 'today']]) {
    const response = runtime.get({ action: 'get_app_context', ...params });
    assert.equal(response.ok, false);
    assert.equal(response.error, error);
    assert.equal(response.field, field);
    assert.ok(response.message.length > 0);
  }
  const unknownQuote = runtime.get({ action: 'get_app_context', quote_currency: 'EUR' });
  assert.equal(unknownQuote.quote.rate_available, false);
  assert.ok(unknownQuote.warnings.some(warning => warning.code === 'missing_rate' && warning.currencies.includes('EUR')));
});

test('each sheet is read at most once per request and the dataset equals listAccounts()', () => {
  const runtime = appRuntime();
  runtime.get({ action: 'get_app_context' });
  assert.equal(runtime.tabs.accounts.reads, 1);
  assert.equal(runtime.tabs.categories.reads, 1);
  assert.equal(runtime.tabs.transactions.reads, 0);
  const expected = plain(runtime.ctx.listAccounts());
  runtime.ctx.vmResetRequest();
  const before = runtime.tabs.transactions.reads;
  const accounts = plain(runtime.ctx.vmLoad('accounts'));
  runtime.ctx.vmLoad('transactions');
  runtime.ctx.vmLedger('Asia/Kolkata');
  assert.equal(runtime.tabs.transactions.reads - before, 1);
  assert.deepEqual(accounts, expected);
  assert.deepEqual(accounts.map(account => account.current_value_local), [3142.5, 9450, 40, 525, 999]);
  runtime.ctx.vmResetRequest();
  assert.throws(() => runtime.ctx.vmLoad('secrets'), /unknown_dataset/);
});

test('view payloads are cached by data_version + action + params and invalidated by POST and Sheet edits', () => {
  const runtime = appRuntime();
  const first = runtime.get({ action: 'get_app_context', today: '2026-09-30' });
  const reads = runtime.tabs.accounts.reads;
  const second = runtime.get({ action: 'get_app_context', today: '2026-09-30', ip: 'other', ua: 'x' });
  assert.deepEqual(second, first);
  assert.equal(runtime.tabs.accounts.reads, reads, 'cache hit must not read sheets');
  assert.equal(runtime.cache.puts.length, 1);
  assert.ok(runtime.cache.puts[0].ttl <= 600);
  assert.match(runtime.cache.puts[0].key, /^v:0:get_app_context:/);
  // Different quote / tz / today → different entries.
  runtime.get({ action: 'get_app_context', today: '2026-09-30', quote_currency: 'INR' });
  runtime.get({ action: 'get_app_context', today: '2026-09-30', tz: 'UTC' });
  runtime.get({ action: 'get_app_context', today: '2026-10-01' });
  assert.equal(new Set(runtime.cache.puts.map(put => put.key)).size, 4);
  // A successful POST bumps data_version; the next GET recomputes.
  const updated = runtime.post({ action: 'upsert_rate', currency: 'EUR', rate: 90, symbol: '€' });
  assert.equal(updated.ok, true);
  assert.notEqual(runtime.version(), '0');
  const fresh = runtime.get({ action: 'get_app_context', today: '2026-09-30' });
  assert.equal(fresh.data_version, runtime.version());
  assert.ok(fresh.data.quote_currencies.some(q => q.currency === 'EUR'));
  // A direct Sheet edit bumps too (onEdit), before the edit cascade runs.
  const beforeEdit = runtime.version();
  runtime.ctx.onEdit({ range: { getSheet: () => runtime.tabs.rates, getRow: () => 2, getColumn: () => 2, getNumRows: () => 1, getNumColumns: () => 1 } });
  assert.notEqual(runtime.version(), beforeEdit);
});

test('only { ok:true } payloads up to 90 KB are cached', () => {
  const runtime = gasRuntime({ files: ['view-cache.gs'] });
  const big = { ok: true, data: '£'.repeat(46 * 1024) };           // ~92 KB in UTF-8, ~46 K chars
  assert.equal(runtime.ctx.vcGetOrCompute('1', 'big', {}, 600, () => big).hit, false);
  assert.equal(runtime.cache.puts.length, 0);
  runtime.ctx.vcGetOrCompute('1', 'bad', {}, 600, () => ({ ok: false, error: 'x' }));
  assert.equal(runtime.cache.puts.length, 0);
  let calls = 0;
  const small = () => { calls++; return { ok: true, n: 1 }; };
  runtime.ctx.vcGetOrCompute('1', 'small', { b: '2', a: '1' }, 9999, small);
  const hit = runtime.ctx.vcGetOrCompute('1', 'small', { a: '1', b: '2' }, 9999, small);
  assert.deepEqual([hit.hit, calls, runtime.cache.puts[0].ttl], [true, 1, 600]);
  assert.equal(runtime.ctx.vcGetOrCompute('2', 'small', { a: '1', b: '2' }, 600, small).hit, false);
  // Long params are hashed into a bounded key; the stored params rule out collisions.
  const long = { search: 'x'.repeat(400) };
  runtime.ctx.vcGetOrCompute('1', 'long', long, 600, small);
  assert.ok(runtime.cache.puts.at(-1).key.length < 250);
  const [key] = [...runtime.cache.store.keys()].filter(k => k.includes(':long:'));
  runtime.cache.store.set(key, JSON.stringify({ p: 'search=other', v: { ok: true, n: 'wrong' } }));
  assert.equal(runtime.ctx.vcGetOrCompute('1', 'long', long, 600, small).value.n, 1);
  // Cache service failures never fail the request.
  const broken = gasRuntime({ files: ['view-cache.gs'], globals: { CacheService: { getScriptCache: () => ({ get() { throw new Error('down'); }, put() { throw new Error('down'); } }) } } });
  assert.equal(broken.ctx.vcGetOrCompute('1', 'x', {}, 600, () => ({ ok: true })).value.ok, true);
});

test('data_version bumps on data-changing POSTs only, and a failed bump never fails a committed write', () => {
  const calls = [];
  const bumps = [];
  let propertiesFail = false;
  const runtime = gasRuntime({ files: ['app-router.gs', 'view-cache.gs'], globals: {
    json: value => value, extractMeta: () => ({ ip: 'test' }), checkLocked: () => false, checkPin: () => true, recordAccess() {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: (key, value) => { if (propertiesFail) throw new Error('quota'); bumps.push(value); } }) },
    createTransaction: body => { calls.push(body.action); return { ok: true }; },
    updateTransaction: () => ({ ok: false, error: 'stale_record' }),
    importTransactionsCsv: body => (body.dry_run === true ? { ok: true, created: 0 } : { ok: false, created: 2, failed: 1 }),
    advisorChat: () => ({ ok: true }),
    deleteTransaction: () => { throw new Error('sheet failure after write'); },
  } });
  const post = body => runtime.ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  assert.equal(post({ action: 'create_transaction' }).ok, true); assert.equal(bumps.length, 1);
  post({ action: 'update_transaction' }); assert.equal(bumps.length, 1);
  post({ action: 'create_transactions_bulk', dry_run: true }); assert.equal(bumps.length, 1);
  post({ action: 'create_transactions_bulk' }); assert.equal(bumps.length, 2);
  post({ action: 'advisor_chat' }); assert.equal(bumps.length, 2);
  assert.equal(post({ action: 'delete_transaction' }).error, 'request_failed'); assert.equal(bumps.length, 3);
  assert.equal(new Set(bumps).size, 3, 'tokens are unique, not counters');
  propertiesFail = true;
  assert.equal(post({ action: 'create_transaction' }).ok, true);
  assert.ok(runtime.logs.some(line => line.includes('vcBumpDataVersion: error=properties_write_failed')));
});

test('GET dispatch reads data_version before any sheet and resets the per-request dataset', () => {
  const runtime = appRuntime();
  runtime.get({ action: 'get_app_context' });
  runtime.tabs.accounts.rows.push(runtime.tabs.accounts.rows[1].map((value, index) => (index === 0 ? ID(99) : index === 1 ? 'New' : value)));
  runtime.ctx.vcBumpDataVersion();
  const next = runtime.get({ action: 'get_app_context' });
  assert.ok(next.data.options.accounts[0].accounts.some(account => account.account_name === 'New'), 'memo must not leak across requests');
});

test('audit: one sheet read per request and one row write for a known IP', () => {
  const audit = new Sheet('audit_access', [
    ['ip', 'city', 'country', 'user_agent', 'first_seen', 'last_seen', 'total_attempts', 'success_count', 'failure_count', 'last_failed_at', 'is_locked', 'locked_at'],
    ['1.1.1.1', 'London', 'UK', 'old-ua', 'first', 'last', 4, 3, 1, 'failed-at', false, ''],
  ]);
  const runtime = gasRuntime({ files: ['app-config.gs', 'app-auth.gs'], globals: { getOrCreateSheet: () => audit } });
  const meta = { ip: '1.1.1.1', city: 'London', country: 'UK', ua: 'new-ua' };
  assert.equal(runtime.ctx.checkLocked(meta.ip), false);
  runtime.ctx.recordAccess(meta, true);
  assert.equal(audit.reads, 1);
  assert.equal(audit.writes, 1);
  const row = audit.rows[1];
  assert.deepEqual([row[3], row[4], row[6], row[7], row[8], row[9], row[10]], ['new-ua', 'first', 5, 4, 1, 'failed-at', false]);
  // Failures lock at MAX_FAILURES; recordAccess without a matching snapshot re-reads.
  runtime.ctx.recordAccess(meta, false);
  runtime.ctx.recordAccess(meta, false);
  assert.equal(audit.rows[1][10], true);
  assert.equal(runtime.ctx.checkLocked(meta.ip), true);
  runtime.ctx.checkLocked('2.2.2.2');
  runtime.ctx.recordAccess({ ip: '2.2.2.2', city: '', country: '', ua: 'ua' }, true);
  assert.equal(audit.rows.length, 3);
  assert.equal(runtime.ctx.checkLocked('unknown'), false);
});
