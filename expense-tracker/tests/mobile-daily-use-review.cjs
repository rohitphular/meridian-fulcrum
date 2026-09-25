const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function load(file, globals, exposed, setup = '') {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, esc, AbortController, setTimeout, clearTimeout, ...globals });
  vm.runInContext(source + '\n' + setup + '\nglobalThis.exposed = {' + exposed.join(',') + '};', context);
  return context.exposed;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function authFixture() {
  const elements = Object.fromEntries(['pinOverlay', 'appShell', 'pinInput', 'totpInput', 'pinSubmit', 'pinError'].map(id => [id, {
    value: id === 'pinInput' ? '123456' : '123456', disabled: false, textContent: '',
    classList: { add() {}, remove() {} }, focus() {}, addEventListener() {},
  }]));
  let verifyCalls = 0;
  const verified = deferred();
  const store = new Map();
  const reloads = [];
  let geoTimeout;
  const auth = load('_shared/auth.js', {
    el: id => elements[id], navigator: { userAgent: 'test' }, window: { CONFIG: { SCRIPT_URL: 'mock' } },
    SheetsClient: { init() {} }, fetch: async () => ({ ok: true, json: async () => ({}) }),
    sessionStorage: { setItem: (key, value) => store.set(key, value), getItem: key => store.get(key), removeItem: key => store.delete(key) },
    document: { dispatchEvent: event => reloads.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: callback => { geoTimeout = callback; return 1; }, clearTimeout() {},
  }, ['createAuthModule']);
  const instance = auth.createAuthModule({ sessionKey: 'et_session', verifyFn: () => { verifyCalls++; return verified.promise; }, reloadEvent: 'et:reload' });
  return { instance, elements, verified, reloads, verifyCalls: () => verifyCalls };
}

test('sign-in ignores repeated Enter and can be submitted again after the gate reopens', async () => {
  const f = authFixture();
  const first = f.instance.submitPin();
  await flush();
  await f.instance.submitPin();
  assert.equal(f.verifyCalls(), 1);
  assert.equal(f.elements.pinSubmit.disabled, true);
  f.verified.resolve({ ok: true });
  await first;
  assert.equal(f.elements.pinSubmit.disabled, false);
  assert.equal(f.elements.pinInput.value, '');
  assert.equal(f.elements.totpInput.value, '');
  f.instance.showPinGate();
  assert.equal(f.elements.pinSubmit.disabled, false);
  assert.deepEqual(f.reloads, ['et:reload']);
});

test('optional geolocation timeout falls back without blocking authentication', async () => {
  let timeout;
  let cleared = false;
  const { createAuthModule } = load('_shared/auth.js', {
    navigator: { userAgent: 'test' },
    fetch: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 3000); timeout = callback; return 1; },
    clearTimeout: () => { cleared = true; },
  }, ['createAuthModule']);
  const request = createAuthModule({}).fetchGeo();
  timeout();
  assert.deepEqual(JSON.parse(JSON.stringify(await request)), { ip: 'unknown', city: '', country: '', ua: 'test' });
  assert.equal(cleared, true);
});

test('an older refresh cannot overwrite a newer successful snapshot or show stale authentication errors', async () => {
  const state = {};
  const older = deferred();
  let transactionRequests = 0;
  let rendered = 0;
  let gates = 0;
  const result = data => Promise.resolve({ ok: true, data });
  const main = load('app/main.js', {
    state, ExpenseAPI: {
      listTransactions: () => ++transactionRequests === 1 ? older.promise : result([{ id: 'newest' }]),
      listCategories: () => result([]), listAccounts: () => result([]), listRates: () => result([]),
      listSubscriptions: () => result([]), listAccountTypes: () => result([]),
    },
    loadAccountSchema: async () => ({ types: [] }), loadTransactionSchema: async () => ({ types: [] }), loadCategorySchema: async () => ({ types: [] }),
    loadAccountTypeSchema: async () => ({ fields: [], types: [], record_statuses: [], columns: [] }),
    loadSubscriptionSchema: async () => ({ frequencies: ['monthly'], tx_types: ['money-out'], record_statuses: ['active'], default_timezone: 'Europe/London' }),
    document: { addEventListener() {} }, el: () => ({ value: 'GBP' }), localStorage: { getItem() {} }, sessionStorage: { getItem() {} },
    showLoading() {}, hideLoading() {}, showMsg() {}, clearSession() {}, showPinGate: () => gates++, showSection: () => rendered++,
  }, ['loadAll']);
  const first = main.loadAll();
  await flush();
  await main.loadAll();
  older.resolve({ ok: false, error: 'auth' });
  await first;
  assert.equal(state.transactions[0].id, 'newest');
  assert.equal(rendered, 1);
  assert.equal(gates, 0);
});

test('every row-based API mutation binds the displayed identity and rejects an unknown row locally', async () => {
  const state = Object.fromEntries(['accounts', 'categories', 'transactions', 'subscriptions', 'accountTypes'].map(key => [key, [{ _row: 2, id: key + '-uuid', updated_at: '2026-09-25T10:00:00Z' }]]));
  state.accountTypes[0].row_num = 2;
  delete state.accountTypes[0]._row;
  const requests = [];
  const { ExpenseAPI } = load('app/core/api.js', { state, SheetsClient: { post: async fields => { requests.push(fields); return { ok: true }; } } }, ['ExpenseAPI']);
  for (const [entity, collection] of [['Account', 'accounts'], ['Category', 'categories'], ['Transaction', 'transactions'], ['Subscription', 'subscriptions'], ['AccountType', 'accountTypes']]) {
    for (const verb of ['update', 'delete', 'restore']) {
      const method = ExpenseAPI[verb + entity];
      if (!method) continue;
      await method({ row_num: 2, description: 'edited' });
      assert.equal(requests.at(-1).expected_id, collection + '-uuid');
      assert.equal(requests.at(-1).expected_updated_at, '2026-09-25T10:00:00Z');
      const count = requests.length;
      assert.equal((await method({ row_num: 99 })).error, 'stale_record');
      assert.equal(requests.length, count);
    }
  }
});

test('refresh keeps every open row selection attached to its UUID after a reorder', () => {
  const state = { txEditRow: 2, txDeleteRow: 3, accViewRow: 2, catDeleteRow: 2, subEditRow: 2,
    transactions: [{ _row: 2, id: 'A' }, { _row: 3, id: 'B' }],
    accounts: [{ _row: 2, id: 'account' }], categories: [{ _row: 2, id: 'category' }], subscriptions: [{ _row: 2, id: 'subscription' }],
  };
  const snapshot = { transactions: [{ _row: 3, id: 'a' }, { _row: 2, id: 'b' }],
    accounts: [{ _row: 7, id: 'account' }], categories: [{ _row: 2, id: 'different' }], subscriptions: [{ _row: 9, id: 'subscription' }] };
  const { _remapRowSelections } = load('app/main.js', { state, document: { addEventListener() {} } }, ['_remapRowSelections']);
  _remapRowSelections(snapshot);
  assert.equal(snapshot.txEditRow, 3);
  assert.equal(snapshot.txDeleteRow, 2);
  assert.equal(snapshot.accViewRow, 7);
  assert.equal(snapshot.catDeleteRow, null);
  assert.equal(snapshot.subEditRow, 9);
});

function transactionFixture() {
  const values = { afDate: '2026-09-25T10:00', afType: 'money-out', afFromAccount: 'from', afToAccount: 'to',
    afSourceAmount: '12.50', afTargetAmount: '15.25', afMajor: 'transfer', afMinor: 'transfer',
    afCounterparty: '', afArea: '', afCity: '', afCountry: '', afTags: '', afDescription: '', afLatitude: '', afLongitude: '', afBeneficiaries: '',
  };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  elements.afSubmit = { disabled: false }; elements.afError = { textContent: '' };
  const state = { transactions: [], accountSchema: { loan_sub_types: [] }, accountMap: {
    from: { id: 'from', type: 'investment', account_currency_local: 'GBP', current_value_local: '1e20' },
    to: { id: 'to', type: 'investment', account_currency_local: 'USD', current_value_local: '1000' },
  }, categories: [{ tx_type_key: 'money-out', major_category_key: 'transfer', minor_category_key: 'transfer', source_account_mandatory: true, target_account_mandatory: true }] };
  const requests = [];
  const exposed = load('app/sections/transactions.js', {
    state, el: key => elements[key] ?? null, showLoading() {}, hideLoading() {}, showMsg() {},
    ExpenseAPI: { createTransaction: async fields => { requests.push(fields); return { ok: true }; } },
    document: { dispatchEvent() {} }, CustomEvent: class {}, getSymbol: () => '£',
  }, ['_saveTransaction', '_isPositiveAmount', '_localInputTimestamp', '_dispatchTxAction', '_buildSiblingMap'], 'renderTransactions = () => {};');
  return { ...exposed, state, elements, requests };
}

test('transaction amounts retain decimal text and reject invalid or absent cross-currency target amounts', async () => {
  const f = transactionFixture();
  for (const value of ['', '0', '-1', '12oops', 'NaN', 'Infinity', '0x10']) {
    f.elements.afTargetAmount.value = value;
    await f._saveTransaction();
    assert.equal(f.requests.length, 0);
    assert.match(f.elements.afError.textContent, /target amount|Target amount/);
  }
  f.elements.afTargetAmount.value = '123456789.123456789';
  f.elements.afSourceAmount.value = '90071992547409.91';
  await f._saveTransaction();
  assert.equal(f.requests[0].source_amount_local, '90071992547409.91');
  assert.equal(f.requests[0].target_amount_local, '123456789.123456789');
  assert.equal(f.requests[0].tx_date_local, '2026-09-25 10:00:00');
});

test('same-currency transfer may default its blank target and unrelated edits preserve timestamp precision', async () => {
  const f = transactionFixture();
  f.state.accountMap.to.account_currency_local = 'GBP';
  f.elements.afTargetAmount.value = '';
  await f._saveTransaction();
  assert.equal(f.requests[0].target_amount_local, '12.50');
  assert.equal(f._localInputTimestamp('2026-09-25T10:00', '2026-09-25 10:00:42.123456'), '2026-09-25 10:00:42.123456');
  assert.equal(f._localInputTimestamp('2026-09-25T10:01', '2026-09-25 10:00:42'), '2026-09-25 10:01:00');
  for (const value of ['12bad', 'Infinity', '-1', '0', '0x10']) assert.equal(f._isPositiveAmount(value), false);
});

test('copying the money-in leg of a transfer retains both currency amounts', () => {
  const parent = { _row: 2, id: 'parent', account_id: 'to', tx_type: 'money-in', tx_amount_local: '15.250000000001' };
  const child = { _row: 3, id: 'child', parent_tx_id: 'parent', account_id: 'from', tx_type: 'money-out', tx_amount_local: '12.500000000001' };
  const state = { transactions: [parent, child] };
  const { _dispatchTxAction } = load('app/sections/transactions.js', { state }, ['_dispatchTxAction'], 'renderTransactions = () => {}; _siblingMap = _buildSiblingMap(state.transactions);');
  _dispatchTxAction('tx-copy', 2);
  assert.equal(state.txCopyPrefill.source_amount, child.tx_amount_local);
  assert.equal(state.txCopyPrefill.target_amount, parent.tx_amount_local);
  assert.equal(state.txCopyPrefill.source_account, 'from');
  assert.equal(state.txCopyPrefill.target_account, 'to');
});

test('late suggestions update only their panel and retain the active transaction form', () => {
  const form = { value: 'Unfinished transaction', innerHTML: 'keep' };
  const panel = { innerHTML: '' }, toggle = { addEventListener(event, callback) { this.click = callback; } };
  const { _refreshSuggestionsPanel } = load('app/sections/transactions.js', {
    state: { suggestions: [], suggestionsFetching: false, suggestionsOpen: true },
    el: id => id === 'txSuggestions' ? panel : id === 'suggestionsToggle' ? toggle : form,
  }, ['_refreshSuggestionsPanel'], 'renderTransactions = () => { throw new Error("full render loses draft"); };');
  _refreshSuggestionsPanel();
  assert.match(panel.innerHTML, /No suggestions right now/);
  toggle.click();
  assert.equal(form.value, 'Unfinished transaction');
  assert.equal(form.innerHTML, 'keep');
});

test('mobile delete cards contain confirmation actions including blocked account and rate deletions', () => {
  const state = { accDeleteRow: 2, accDeleteBlocked: { referenced_count: 1 }, accounts: [{ _row: 2, id: 'a', type: 'asset', account_name: '<Bank>', account_currency_local: 'GBP' }],
    accountSchema: { type_labels: { asset: 'Assets' }, type_groups: {}, loan_sub_types: [] }, quoteCurrency: 'GBP',
    catDeleteRow: 2, categories: [], catSchema: {}, rates: [{ currency: 'USD' }], rateDeleteCurrency: 'USD', rateDeleteBlocked: { error: 'currency_in_use_by_accounts', referenced_count: 1 } };
  const accounts = load('app/sections/accounts.js', { state, getSymbol: () => '£', toBase: () => 0 }, ['_renderTable']);
  const accountHtml = accounts._renderTable(state.accounts);
  assert.match(accountHtml, /<div class="acc-cards">[\s\S]*record-confirm-card[\s\S]*acc-deactivate/);
  assert.doesNotMatch(accountHtml, /<Bank>|acc-has-active/);
  const categories = load('app/sections/categories.js', { state }, ['_renderCatTable']);
  const categoryHtml = categories._renderCatTable([{ _row: 2, major_category_label: 'Food', minor_category_label: '<Lunch>' }]);
  assert.match(categoryHtml, /<div class="cat-cards">[\s\S]*cat-confirm-delete/);
  assert.doesNotMatch(categoryHtml, /<Lunch>|cat-has-active/);
  const rateContent = { innerHTML: '' };
  const rates = load('app/sections/rates.js', { state, el: () => rateContent, closeContextMenu() {} }, ['renderRates'], '_attachRateEvents = () => {};');
  rates.renderRates();
  assert.match(rateContent.innerHTML, /<div class="rate-cards">[\s\S]*record-confirm-card[\s\S]*rate-cancel-delete/);
  assert.doesNotMatch(rateContent.innerHTML, /rate-has-active/);
});

test('precomputed insights pass only the payload to the renderer and retain the server timestamp', async () => {
  const inner = { innerHTML: '' }, chart = { innerHTML: '' }, payload = { chart: { labels: ['A'], datasets: [] } };
  let received, timestamp;
  const insight = load('app/sections/insights.js', {
    state: { insightId: '01-mom-cumulative', insightPeriod: 'this_month', insightMode: 'precomputed', transactions: [], accounts: [], quoteCurrency: 'GBP' },
    el: id => id === 'insightInner' ? inner : chart,
    ExpenseAPI: { getComputedInsights: async () => ({ ok: true, data: { payload, computed_at: '2026-09-25T10:00:00Z' } }) },
    getPeriodBounds: () => ({}), filterTxByRange: () => [], getSymbol: () => '£', findMissingRates: () => [],
    capture: value => { received = value; }, captureTimestamp: value => { timestamp = value; },
  }, ['_renderActiveInsight'], '_loadRenderer = async () => null; _renderFromPayload = (container, payload) => { capture(payload); return {}; }; _appendComputedAt = (container, timestamp) => captureTimestamp(timestamp);');
  await insight._renderActiveInsight();
  assert.equal(received, payload);
  assert.equal(timestamp, '2026-09-25T10:00:00Z');
});
