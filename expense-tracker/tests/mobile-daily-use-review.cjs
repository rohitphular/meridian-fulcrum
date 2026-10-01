const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function load(file, globals, exposed, setup = '') {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = importResultHelpers.context({ console, esc, AbortController, setTimeout, clearTimeout, ...globals });
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
  let contextRequests = 0;
  let rendered = 0;
  let gates = 0;
  const context = marker => ({ ok: true, data: { marker, quote_currencies: [], schemas: {
    account: { types: [] }, transaction: { types: [] }, category: { types: [] },
    account_type: { fields: [], types: [], record_statuses: [], columns: [] },
    subscription: { frequencies: ['monthly'], tx_types: ['money-out'], record_statuses: ['active'], default_timezone: 'Europe/London' },
  } } });
  const main = load('app/main.js', {
    state, ExpenseAPI: { getAppContext: () => ++contextRequests === 1 ? older.promise : Promise.resolve(context('newest')) },
    document: { addEventListener() {} }, el: () => ({ value: 'GBP' }), localStorage: { getItem() {} }, sessionStorage: { getItem() {} },
    showLoading() {}, hideLoading() {}, showMsg() {}, clearSession() {}, showPinGate: () => gates++, showSection: () => rendered++,
  }, ['loadAll']);
  const first = main.loadAll();
  await flush();
  await main.loadAll();
  older.resolve({ ok: false, error: 'auth' });
  await first;
  assert.equal(state.context.marker, 'newest');
  assert.equal(rendered, 1);
  assert.equal(gates, 0);
});

test('an auth or locked answer to any view GET reopens the PIN gate; get_app_context is left to loadAll', async () => {
  const answers = [];
  const { ExpenseAPI } = load('app/core/api.js', { state: { quoteCurrency: 'GBP' }, Intl, SheetsClient: { get: async params => answers.shift() ?? { ok: true, action: params.action } } }, ['ExpenseAPI']);
  const reopened = [];
  ExpenseAPI.onAuthError(code => reopened.push(code));
  answers.push({ ok: false, error: 'auth' }, { ok: false, error: 'locked' }, { ok: false, error: 'invalid_page' }, { ok: false, error: 'auth' }, { ok: false, error: 'auth' });
  assert.equal((await ExpenseAPI.view('list_transactions_view', { page: 2 })).error, 'auth');
  await ExpenseAPI.view('get_insight', { id: '29-daily-spend' });
  await ExpenseAPI.view('list_accounts_view');
  await ExpenseAPI.getSuggestedTransactions();
  assert.equal((await ExpenseAPI.getAppContext()).error, 'auth');
  assert.deepEqual(reopened, ['auth', 'locked', 'auth']);
});

test('every row-based API mutation sends the identity of the row in hand and refuses a row without one locally', async () => {
  const requests = [];
  // No collection lookup: state holds no rows at all.
  const { ExpenseAPI } = load('app/core/api.js', { state: {}, SheetsClient: { post: async fields => { requests.push(fields); return { ok: true }; } } }, ['ExpenseAPI']);
  for (const entity of ['Account', 'Category', 'Transaction', 'Subscription', 'AccountType']) {
    for (const verb of ['update', 'delete', 'restore']) {
      const method = ExpenseAPI[verb + entity];
      if (!method) continue;
      await method({ id: entity + '-uuid', row_num: 2, updated_at: '2026-09-25T10:00:00Z', description: 'edited' });
      const sent = requests.at(-1);
      assert.equal(sent.expected_id, entity + '-uuid');
      assert.equal(sent.expected_updated_at, '2026-09-25T10:00:00Z');
      assert.equal(sent.row_num, 2);
      assert.equal(sent.description, 'edited');
      assert.equal(sent.updated_at, undefined, 'the version is never sent as a data field');
      // Only account types accept the id in the body; other cores reject it as not editable.
      assert.equal(sent.id, entity === 'AccountType' ? entity + '-uuid' : undefined);
      await method({ id: entity + '-uuid', row_num: 2, expected_updated_at: 'explicit' });
      assert.equal(requests.at(-1).expected_updated_at, 'explicit');
      const count = requests.length;
      assert.equal((await method({ row_num: 99 })).error, 'stale_record');
      assert.equal((await method({ id: ' ', row_num: 2 })).error, 'stale_record');
      assert.equal(requests.length, count);
    }
  }
});

test('open row selections are ids: a reorder that moves Sheet rows cannot retarget an open panel', () => {
  // _remapRowSelections is gone: accounts / categories / subscriptions keep the
  // record id of the open panel and send the row_num of the row found by id.
  for (const [file, lookup] of [['app/sections/accounts.js', '_rowById'], ['app/sections/categories.js', '_recordById'], ['app/sections/subscriptions.js', '_rowById']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.includes('function ' + lookup + '(id)'), file);
    assert.doesNotMatch(source, /_rowByNum|_recordByRow|Number\([^)]*dataset\.row\)/, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'app/main.js'), 'utf8'), /_remapRowSelections/);
  const views = { list_accounts_view: { ok: true, data: { groups: [{ rows: [{ id: 'b', row_num: 2 }, { id: 'a', row_num: 7 }] }] } } };
  const { _rowById } = load('app/sections/accounts.js', { state: { views } }, ['_rowById']);
  // The account opened as 'a' (row 2 before an import) is still 'a', now on row 7.
  assert.equal(_rowById('a').row_num, 7);
  assert.equal(_rowById(2), null);
  assert.equal(_rowById('missing'), null);
});

const TRANSFER_OPTIONS = { categories: { 'money-out': { majors: [{ key: 'transfer', active: true, minors: [{ key: 'transfer', active: true,
  source: { mandatory: true, account_set: 'from' }, target: { mandatory: true, account_set: 'to' }, is_transfer: true }] }] } },
  uncategorised: {}, account_sets: { from: ['from'], to: ['to'] }, accounts: [], datalists: {} };

function transactionFixture() {
  const values = { afDate: '2026-09-25T10:00', afType: 'money-out', afFromAccount: 'from', afToAccount: 'to',
    afSourceAmount: '12.50', afTargetAmount: '15.25', afMajor: 'transfer', afMinor: 'transfer',
    afCounterparty: '', afArea: '', afCity: '', afCountry: '', afTags: '', afDescription: '', afLatitude: '', afLongitude: '', afBeneficiaries: '',
  };
  const fieldWrap = key => ({ key, classes: new Set(), classList: { add(name) { this.owner.classes.add(name); }, remove(name) { this.owner.classes.delete(name); } } });
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const wrap = fieldWrap(key); wrap.classList.owner = wrap;
    return [key, { value, wrap, closest: selector => (selector === '.field' ? wrap : null) }];
  }));
  elements.afSubmit = { disabled: false }; elements.afError = { textContent: '' };
  const options = JSON.parse(JSON.stringify(TRANSFER_OPTIONS));
  const state = {};
  const requests = [];
  const responses = [];
  const exposed = load('app/sections/transactions.js', {
    state, el: key => elements[key] ?? null, showLoading() {}, hideLoading() {}, showMsg() {},
    ExpenseAPI: { createTransaction: async fields => { requests.push(fields); return responses.shift() ?? { ok: true }; } },
    document: { dispatchEvent() {} }, CustomEvent: class {},
  }, ['_saveTransaction', '_localInputTimestamp', 'setPanel: value => { _panel = value; }', 'panel: () => _panel'], 'renderTransactions = () => {};');
  // The add form is open with the server's option tree (a transfer category).
  exposed.setPanel({ mode: 'add', options });
  return { ...exposed, state, elements, requests, responses, options };
}

// Amount rules (positive finite decimal, cross-currency target required) are
// server-side now: form-validation-backend.cjs covers them. The form sends the
// text as entered and renders the server's message on the named field.
test('transaction amounts reach the API as entered and server field errors render verbatim', async () => {
  const f = transactionFixture();
  for (const value of ['', '0', '-1', '12oops', 'NaN', 'Infinity', '0x10']) {
    f.elements.afTargetAmount.value = value;
    f.responses.push({ ok: false, error: 'missing_target_amount', field: 'target_amount_local', message: 'Enter a positive target amount.' });
    await f._saveTransaction();
    assert.equal(f.requests.at(-1).target_amount_local, value.trim());
    assert.equal(f.elements.afError.textContent, 'Enter a positive target amount.');
    assert.equal(f.elements.afTargetAmount.wrap.classes.has('error'), true);
    assert.equal(f.elements.afSubmit.disabled, false);
  }
  f.elements.afTargetAmount.value = '123456789.123456789';
  f.elements.afSourceAmount.value = '90071992547409.91';
  await f._saveTransaction();
  assert.equal(f.requests.at(-1).source_amount_local, '90071992547409.91');
  assert.equal(f.requests.at(-1).target_amount_local, '123456789.123456789');
  assert.equal(f.requests.at(-1).tx_date_local, '2026-09-25 10:00:00');
  assert.equal(f.panel(), null, 'a successful save closes the form');
});

test('a blank transfer target is left to the server and unrelated edits preserve timestamp precision', async () => {
  const f = transactionFixture();
  f.elements.afTargetAmount.value = '';
  await f._saveTransaction();
  assert.equal(f.requests[0].source_amount_local, '12.50');
  assert.equal(f.requests[0].target_amount_local, '');
  // A non-transfer books its single Amount on whichever leg the category uses.
  const minor = f.options.categories['money-out'].majors[0].minors[0];
  minor.target.mandatory = false; minor.is_transfer = false;
  f.setPanel({ mode: 'add', options: f.options });
  f.elements.afSubmit.disabled = false;   // a successful save leaves Save disabled until the reload
  await f._saveTransaction();
  assert.equal(f.requests[1].target_amount_local, '12.50');
  assert.equal(f._localInputTimestamp('2026-09-25T10:00', '2026-09-25 10:00:42.123456'), '2026-09-25 10:00:42.123456');
  assert.equal(f._localInputTimestamp('2026-09-25T10:01', '2026-09-25 10:00:42'), '2026-09-25 10:01:00');
});

test('the insufficient-balance rule is not evaluated in the browser', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app/sections/transactions.js'), 'utf8');
  assert.doesNotMatch(source, /_checkBalanceRules|_isPositiveAmount|current_value_local\s*</);
  assert.doesNotMatch(source, /Insufficient balance/);
});

test('copy asks the server for the prefill (the counter leg may be on another page) and opens the add form with it', async () => {
  const calls = [];
  const prefill = { tx_type: 'money-out', source_account: 'from', target_account: 'to', source_amount: '12.500000000001', target_amount: '15.250000000001' };
  const { _dispatchTxAction, panel } = load('app/sections/transactions.js', { state: {}, showMsg() {},
    ExpenseAPI: { view: async (action, params) => { calls.push([action, JSON.parse(JSON.stringify(params))]);
      return action === 'get_transaction_prefill' ? { ok: true, data: { mode: 'copy', prefill } } : { ok: true, data: { mode: 'create', categories: {} } }; } },
  }, ['_dispatchTxAction', 'panel: () => _panel'], 'renderTransactions = () => {};');
  _dispatchTxAction('tx-copy', 'parent-id');
  await flush(); await flush();
  assert.deepEqual(calls[0], ['get_transaction_prefill', { id: 'parent-id', mode: 'copy' }]);
  assert.deepEqual(calls[1], ['get_transaction_form_options', { mode: 'create' }]);
  assert.equal(panel().mode, 'add');
  assert.equal(panel().prefill, prefill);
  const source = fs.readFileSync(path.join(__dirname, '../app/sections/transactions.js'), 'utf8');
  assert.doesNotMatch(source, /_buildSiblingMap|_siblingMap|_isAlreadySubscribed|_isCatSubEligible|_sortTx|filteredTx/);
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
  // Open confirmations hold record ids (accounts / categories) or the currency (rates).
  const state = { accDeleteRow: 'a', accDeleteBlocked: { referenced_count: 1 }, quoteCurrency: 'GBP',
    catDeleteRow: 'c', rateDeleteCurrency: 'USD', rateDeleteBlocked: { error: 'currency_in_use_by_accounts', referenced_count: 1 } };
  // Accounts and rates render their server view models (list_accounts_view / list_rates_view).
  const accountRow = { row_num: 2, id: 'a', type: 'asset', account_name: '<Bank>', description: '', sub_type_label: 'Current', currency: 'GBP', currency_symbol: '£',
    balance: { native: 10, quote: 10, display_sign: 'positive', is_foreign: false }, record_status: 'active', sync_status: '', allowed_actions: ['view', 'edit', 'transactions', 'delete'] };
  const accountView = { total: 1, summary: { all_count: 1 }, groups: [{ type: 'asset', label: 'Assets', is_liability: false, total: { quote: 10, display_sign: 'positive', missing_currencies: [] }, rows: [accountRow] }] };
  const accounts = load('app/sections/accounts.js', { state }, ['_renderTable']);
  const accountHtml = accounts._renderTable(accountView, { currency: 'GBP', symbol: '£' });
  assert.match(accountHtml, /<div class="acc-cards">[\s\S]*record-confirm-card[\s\S]*acc-deactivate/);
  assert.doesNotMatch(accountHtml, /<Bank>|acc-has-active/);
  const categories = load('app/sections/categories.js', { state }, ['_renderCatTable']);
  const categoryHtml = categories._renderCatTable([{ _row: 2, id: 'c', major_category_label: 'Food', minor_category_label: '<Lunch>' }]);
  assert.match(categoryHtml, /<div class="cat-cards">[\s\S]*cat-confirm-delete/);
  assert.doesNotMatch(categoryHtml, /<Lunch>|cat-has-active/);
  const rateContent = { innerHTML: '' };
  state.views = { list_rates_view: { ok: true, data: { rows: [{ currency: 'USD', symbol: '$', rate: 97.7, rate_label: '97.70', updated_at: '', is_base: false, allowed_actions: ['edit', 'delete'], used_by_accounts: ['<Brokerage>'] }] } } };
  const rates = load('app/sections/rates.js', { state, el: id => (id === 'ratesContent' ? rateContent : null), closeContextMenu() {},
    showLoading() {}, hideLoading() {}, ExpenseAPI: { view: () => new Promise(() => {}) } }, ['renderRates'], '_attachRateEvents = () => {};');
  rates.renderRates();
  assert.match(rateContent.innerHTML, /<div class="rate-cards">[\s\S]*record-confirm-card[\s\S]*rate-cancel-delete/);
  assert.match(rateContent.innerHTML, /used by: <strong>&lt;Brokerage&gt;<\/strong>/);
  assert.doesNotMatch(rateContent.innerHTML, /rate-has-active/);
});

// Insights / Home rendering from server payloads: home-insights-frontend.cjs.
