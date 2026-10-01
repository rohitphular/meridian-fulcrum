const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../app');
function load(file, globals, expose) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source + '\nthis.exposed = {' + expose.join(',') + '};', context);
  return context.exposed;
}
// Export reconstruction, lossy-transfer refusal, sibling pairing and the
// date-range / search filters are server-side now: view-transactions-backend.cjs.
test('transaction export only downloads the rows and columns the server built', () => {
  let received;
  const { downloadExport } = load('core/utils.js', { state: {}, _exportData: (...args) => { received = args; } }, ['downloadExport']);
  const data = { filename: 'transaction_master', columns: ['id', 'source_account'], rows: [{ id: 'x', source_account: 'Bank' }] };
  downloadExport('csv', data);
  assert.deepEqual(received, ['csv', data.rows, 'transaction_master', data.columns]);
  const source = fs.readFileSync(path.join(root, 'core/utils.js'), 'utf8');
  assert.doesNotMatch(source, /parent_tx_id|siblingMap|separately edited/);
  assert.equal(fs.existsSync(path.join(root, 'core/daterange.js')), false);
});

test('suggestions use an account-specific stable key without delimiter collisions', () => {
  const { _suggestionKey } = load('sections/transactions.js', {}, ['_suggestionKey']);
  const entry = { counterparty_name: 'A|B', major_category: 'food', minor_category: 'cafe', account_id: 'gbp', currency: 'GBP' };
  assert.notEqual(_suggestionKey(entry), _suggestionKey({ ...entry, account_id: 'inr', currency: 'INR' }));
  assert.equal(_suggestionKey({ ...entry, suggestion_key: 'server-key' }), 'server-key');
});

test('interrupted requests have bounded deadlines, clean timers and never auto-retry a mutation', async () => {
  let timer, duration, clears = 0, calls = 0;
  const context = vm.createContext({ URLSearchParams, AbortController,
    setTimeout: (callback, ms) => { timer = callback; duration = ms; return 1; },
    clearTimeout: () => { clears++; },
    fetch: (_url, options) => { calls++; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')))); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, '../_shared/sheets-client.js'), 'utf8') + '\nthis.client = SheetsClient;', context);
  context.client.init({ scriptUrl: 'https://example.invalid', pin: 'not-real' });
  const read = context.client.list();
  assert.equal(duration, 60000);
  timer(); await assert.rejects(read, /request_timeout/);
  const write = context.client.post({ action: 'create_transaction' });
  assert.equal(duration, 180000);
  timer(); await assert.rejects(write, /request_timeout/);
  assert.equal(calls, 2);
  assert.equal(clears, 2);
});

test('optional location enrichment ends after its deadline and clears the timer', async () => {
  let timer, duration, cleared = false;
  const { _locationData } = load('sections/transactions.js', {
    AbortController, setTimeout: (callback, ms) => { timer = callback; duration = ms; return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')))),
  }, ['_locationData']);
  const lookup = _locationData('https://example.invalid');
  assert.equal(duration, 5000);
  timer(); await assert.rejects(lookup, /AbortError/);
  assert.equal(cleared, true);
});

test('edit form lists the server-kept closed account first and only offers eligible accounts otherwise', () => {
  const options = {
    categories: { 'money-out': { majors: [{ key: 'food', minors: [{ key: 'shop', source: { mandatory: true, account_set: 'current' }, target: { mandatory: false, account_set: 'none' } }] }] } },
    uncategorised: { 'money-out': { source: { mandatory: true, account_set: '' }, target: { mandatory: false, account_set: '' } } },
    account_sets: { '': ['o1', 'o2'], current: ['o1'], none: [] },
    accounts: [{ id: 'c1', label: 'Finio-1 (GBP) · inactive' }, { id: 'o1', label: 'Bank (GBP)' }, { id: 'o2', label: 'Cash (GBP)' }],
    edit: { keep_account_id: 'c1' },
  };
  const ctx = load('sections/transactions.js', { state: {}, esc: String }, ['_editAccountIds', '_accountOptionsHtml']);
  assert.deepEqual(Array.from(ctx._editAccountIds(options, 'money-out', 'food', 'shop')), ['c1', 'o1']);
  assert.deepEqual(Array.from(ctx._editAccountIds(options, 'money-out', '', '')), ['c1', 'o1', 'o2']);
  assert.match(ctx._accountOptionsHtml(options, ['c1', 'o1'], 'c1'), /value="c1" selected>Finio-1 \(GBP\) · inactive/);
  assert.deepEqual(Array.from(ctx._editAccountIds({ ...options, edit: { keep_account_id: null } }, 'money-out', 'food', 'shop')), ['o1']);
});

test('transactions.js is a renderer: no client collections, conversion or list logic', () => {
  const source = fs.readFileSync(path.join(root, 'sections/transactions.js'), 'utf8');
  assert.doesNotMatch(source, /state\.(accountMap|categories|rateMap|accounts|subscriptions|metadata)\b/);
  assert.doesNotMatch(source, /state\.transactions\b/, 'no raw transaction list in the browser');
  assert.doesNotMatch(source, /\b(fmtBase|getSymbol|toBase|filteredTx|getRangeBounds|_sortTx|_buildSiblingMap|_catMajorOpts|_normCatKeys|_isAlreadySubscribed)\b/);
  assert.doesNotMatch(source, /\.sort\(\(a, b\)/, 'no client-side list sorting');
});

test('the list is requested with the applied query, older responses are dropped and deep links become params', async () => {
  const calls = [], pending = [];
  const state = { filters: { types: [] }, views: {} };
  let renders = 0;
  const ctx = load('sections/transactions.js', {
    state, console: { warn() {}, error() {}, log() {} },
    ExpenseAPI: { view: (action, params) => { calls.push([action, JSON.parse(JSON.stringify(params))]); return new Promise(resolve => pending.push(resolve)); } },
  }, ['_loadList', '_listParams', '_consumeDeepLink', 'list: () => _list', 'query: () => _query', 'setRender: fn => { _renderListRegion = fn; }']);
  ctx.setRender(() => { renders++; });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._listParams())), {
    range: 'last_30', types: [], account_ids: [], account_types: [], major: [], minor: [], user_location_country: '', user_location_city: '',
    user_location_area: '', tag: '', counterparty: '', search: '', sort_col: 'tx_date_local', sort_dir: 'desc', page: 1, page_size: 50,
  });
  ctx._loadList('first');
  ctx._loadList('second');
  pending[1]({ ok: true, data: { rows: [{ id: 'new' }], page: 1 } });
  pending[0]({ ok: true, data: { rows: [{ id: 'old' }], page: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.list().rows[0].id, 'new');
  assert.equal(state.views.transactions.data.rows[0].id, 'new');
  assert.equal(renders, 1);
  assert.deepEqual(calls.map(call => call[0]), ['list_transactions_view', 'list_transactions_view']);
  // Accounts / categories / subscriptions deep-link by assigning state.filters.
  state.filters = { types: [], accounts: ['acc-1'], major: ['food'], minor: [], user_location_country: '', tag: '', search: 'Tesco' };
  ctx._consumeDeepLink();
  assert.deepEqual([Array.from(ctx.query().account_ids), Array.from(ctx.query().major), ctx.query().search, ctx.query().page, ctx.query().range], [['acc-1'], ['food'], 'Tesco', 1, 'last_30']);
  // The same handoff also accepts list_transactions_view param names (e.g. a subscription drill).
  state.filters = { account_ids: ['acc-2'], counterparty: 'Netflix', range: 'all' };
  ctx._consumeDeepLink();
  assert.deepEqual([Array.from(ctx.query().account_ids), ctx.query().counterparty, ctx.query().search, ctx.query().range], [['acc-2'], 'Netflix', '', 'all']);
  ctx._consumeDeepLink();
  assert.equal(ctx.query().counterparty, 'Netflix', 'a handoff is consumed once');
});
