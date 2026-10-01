// Phase 2–3 client: accounts.js, rates.js and configure.js render the server view
// models and send filters / sort / paging as params, with no list logic of their own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const importResultHelpers = require('./support/import-result.cjs');

const APP = path.join(__dirname, '../app');
const read = file => fs.readFileSync(path.join(APP, file), 'utf8');
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const flush = () => new Promise(resolve => setImmediate(resolve));

function load(file, globals, names) {
  const source = read(file)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = importResultHelpers.context({ console: { log() {}, warn() {}, error() {} }, esc, ...globals });
  vm.runInContext(source + '\nglobalThis.exposed = {' + names.join(',') + '};', context);
  return context.exposed;
}

// Minimal DOM: every id resolves to a node that records listeners.
function dom() {
  const nodes = {};
  const node = () => ({
    innerHTML: '', value: '', textContent: '', disabled: false, style: {}, dataset: {}, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [], focus() {},
  });
  return { nodes, el: id => (nodes[id] ??= node()) };
}

const accountRow = extra => ({
  id: 'acc-1', row_num: 2, updated_at: '2026-09-29T10:00:00Z', account_name: 'Bank', legal_entity_name: '', description: '',
  type: 'asset', type_label: 'Asset', is_liability: false, sub_type: 'current', sub_type_label: 'Current', currency: 'GBP', currency_symbol: '£',
  local_timezone: 'Europe/London', account_opening_date_local: '2020-01-01 00:00:00', account_closing_date_local: '', tracking_start_date_local: '',
  balance: { native: 3142.5, currency: 'GBP', currency_symbol: '£', quote: 3142.5, display_sign: 'positive', is_foreign: false },
  opening: { native: 1000, currency: 'GBP', currency_symbol: '£', quote: 1000, display_sign: 'positive' },
  record_status: 'active', record_status_label: 'Active', sync_status: '', sync_notes: '',
  allowed_actions: ['view', 'edit', 'transactions', 'delete'], editable_fields: ['account_name', 'description', 'sub_type', 'account_closing_date_local', 'record_status'],
  statuses_for_edit: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'locked', label: 'Locked' }],
  ...extra,
});

function accountsView(extra = {}) {
  const card = accountRow({ id: 'acc-2', row_num: 3, account_name: '<Card>', type: 'liability', type_label: 'Liability', is_liability: true, sub_type_label: 'Credit card',
    balance: { native: -250, currency: 'GBP', currency_symbol: '£', quote: -250, display_sign: 'owed', is_foreign: false } });
  const usd = accountRow({ id: 'acc-3', row_num: 4, account_name: 'Brokerage', currency: 'USD', currency_symbol: '$', record_status: 'locked', allowed_actions: ['view', 'transactions'], editable_fields: [],
    balance: { native: 525, currency: 'USD', currency_symbol: '$', quote: null, display_sign: 'positive', is_foreign: true } });
  return {
    ok: true, quote: { currency: 'GBP', symbol: '£', rate_available: true }, warnings: [{ code: 'missing_rate', currencies: ['USD'] }],
    data: {
      summary: { all_count: 3, cards: [
        { key: 'total_assets', label: 'Total Assets', value: 3142.5, tone: 'positive' },
        { key: 'total_liabilities', label: 'Total Liabilities', value: 250, tone: 'negative' },
        { key: 'net_worth', label: 'Net Worth', value: -1234.4, tone: 'negative' },
        { key: 'liquid_cash', label: 'Liquid Cash', value: 3142.5, tone: 'positive' },
      ] },
      groups: [
        { type: 'asset', label: 'Asset', is_liability: false, count: 2, total: { quote: 3142.5, display_sign: 'positive', missing_currencies: ['USD'] }, rows: [accountRow(), usd] },
        { type: 'liability', label: 'Liability', is_liability: true, count: 1, total: { quote: -250, display_sign: 'owed', missing_currencies: [] }, rows: [card] },
      ],
      total: 3, page: 1, page_size: 50, pages: 1, sort: { col: 'sheet', dir: 'asc' }, active_filter_count: 0,
      facets: { types: [{ value: 'asset', label: 'Asset' }], sub_types_by_type: { asset: [{ value: 'current', label: 'Current' }] },
        currencies: [{ value: 'GBP', label: 'GBP' }], statuses: ['active', 'inactive', 'deleted', 'locked'].map(value => ({ value, label: value })) },
      ...extra,
    },
  };
}

function accountsFixture(stateExtra = {}) {
  const { nodes, el } = dom();
  const calls = [];
  const menus = [];
  let respond = () => accountsView();
  const state = {
    views: {}, accounts: [], accFilters: { type: 'all', subType: 'all', currency: 'all', search: '', recordStatuses: ['active', 'inactive', 'deleted', 'locked'] },
    accFilterOpen: false, accAddOpen: false, accImportOpen: false, accViewRow: null, accEditRow: null, accDeleteRow: null, accDeleteBlocked: null, ...stateExtra,
  };
  const exposed = load('sections/accounts.js', {
    state, el, showLoading() {}, hideLoading() {}, showMsg() {}, recordStatusIcon: () => '', syncStatusIcon: () => '',
    closeContextMenu() {}, openContextMenu: (button, items) => menus.push(items), exportAccounts() {},
    document: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }, CustomEvent: class { constructor(type) { this.type = type; } },
    ExpenseAPI: { view: async (action, params) => { calls.push([action, params]); return respond(action, params); } },
  }, ['renderAccounts', '_attachListEvents']);
  return { ...exposed, nodes, calls, menus, state, setRespond: fn => { respond = fn; } };
}

test('accounts render the server summary, groups and balances without converting in the browser', async () => {
  const context = accountsFixture();
  context.renderAccounts();
  assert.match(context.nodes.accountsContent.innerHTML, /Loading accounts/);
  await flush();
  const [action, params] = context.calls[0];
  assert.equal(action, 'list_accounts_view');
  assert.deepEqual(JSON.parse(JSON.stringify(params)), { type: '', sub_type: '', currency: '', search: '', statuses: ['active', 'inactive', 'deleted', 'locked'], sort: 'sheet', dir: 'asc', page: 1, page_size: 50 });
  const html = context.nodes.accListRegion.innerHTML;
  // Summary cards are the server values; only sign and grouping are formatted here.
  assert.match(html, /Total Assets<\/div>\s*<div class="summary-card-value positive">£3,143/);
  assert.match(html, /Total Liabilities<\/div>\s*<div class="summary-card-value negative">£250/);
  assert.match(html, /Net Worth<\/div>\s*<div class="summary-card-value negative">−£1,234/);
  // Group totals and display signs come from the payload.
  assert.match(html, /Liability[\s\S]*?−£250/);
  assert.match(html, /<span class="acc-bal-owed">−£250\.00<\/span>/);
  assert.match(html, /\$525\.00<\/span> <span class="td-base-amt">—<\/span>/);
  assert.match(html, /No exchange rate for USD/);
  assert.match(html, /&lt;Card&gt;/);
  assert.doesNotMatch(html, /<Card>/);
  assert.equal(context.state.views.list_accounts_view.data.total, 3);
});

test('account menus come from allowed_actions and filters are sent to the server on Apply', async () => {
  const context = accountsFixture({ accFilterOpen: true });
  context.renderAccounts();
  await flush();
  // Row menu: a locked row offers only what the server allows.
  const region = context.nodes.accListRegion;
  const tableWrap = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  region.querySelector = selector => (selector === '.acc-table-wrap' ? tableWrap : null);
  context._attachListEvents();
  const button = { dataset: { action: 'acc-menu', row: 'acc-3' } };   // rows are addressed by id
  tableWrap.listeners.click({ target: { closest: () => button } });
  assert.deepEqual(context.menus[0].map(item => item.key), ['view', 'transactions']);
  // Status "None" is an explicit selection, not "all".
  context.nodes.accFSearch.value = ' bro ';
  const statusMenu = context.nodes.accFStatusMenu;
  statusMenu.querySelectorAll = () => [];
  statusMenu.listeners.change.forEach(fn => fn());
  context.nodes.accFSearchBtn.listeners.click.forEach(fn => fn());
  await flush();
  const params = JSON.parse(JSON.stringify(context.calls.at(-1)[1]));
  assert.equal(params.search, 'bro');
  assert.equal(params.statuses, 'none');
  assert.equal(params.page, 1);
});

test('a landing list response re-renders only the list region, keeping an open add form', async () => {
  const context = accountsFixture();
  context.state.views.list_accounts_view = accountsView();
  context.state.views.get_account_form_options = { ok: true, data: { types: [{ value: 'asset', label: 'Asset' }], sub_types_by_type: {}, currencies: [{ value: 'GBP', label: 'GBP' }], import_file_types: [] } };
  context.state.accAddOpen = true;
  let resolve;
  context.setRespond(action => (action === 'list_accounts_view' ? new Promise(done => { resolve = done; }) : context.state.views.get_account_form_options));
  context.renderAccounts();
  const page = context.nodes.accountsContent.innerHTML;
  assert.match(page, /id="accNewName"/);
  resolve(accountsView({ total: 0, groups: [], summary: { all_count: 3, cards: [] } }));
  await flush();
  assert.equal(context.nodes.accountsContent.innerHTML, page);
  assert.match(context.nodes.accListRegion.innerHTML, /No accounts match the current filters/);
});

test('accounts, rates and configure keep no client-side list logic', () => {
  const accounts = read('sections/accounts.js');
  for (const pattern of [/toBase|fmtBase|getSymbol/, /_applyAccFilters|_accFilterCount|_isLiability|_validTypes/, /state\.accountTypes/, /state\.rates/, /\.sort\(/, /seenC/]) {
    assert.doesNotMatch(accounts, pattern, String(pattern));
  }
  const rates = read('sections/rates.js');
  for (const pattern of [/\.sort\(|\.filter\(/, /state\.rates\b/, /state\.accounts/, /=== 'XAU'/]) assert.doesNotMatch(rates, pattern, String(pattern));
  const configure = read('sections/configure.js');
  for (const pattern of [/\.sort\(/, /state\.accounts\b(?!Types)/, /hasAccounts/, /toLowerCase\(\)\.includes/, /\['locked', 'deleted'\]\.includes/]) {
    assert.doesNotMatch(configure, pattern, String(pattern));
  }
});

test('rates render list_rates_view rows, hide the menu when no action is allowed and send sort params', async () => {
  const { nodes, el } = dom();
  const calls = [];
  const view = { ok: true, data: { rows: [
    { currency: 'GBP', symbol: '£', rate: 80, rate_label: '80.00', updated_at: '', is_base: false, allowed_actions: ['edit', 'delete'], used_by_accounts: [] },
    { currency: 'XAU', symbol: '⊕', rate: 1, rate_label: '1.00', updated_at: '', is_base: true, allowed_actions: [], used_by_accounts: [] },
  ] } };
  const state = { views: {}, rateAddOpen: false, rateEditCurrency: null, rateDeleteCurrency: null, rateDeleteBlocked: null };
  const menus = [];
  const rates = load('sections/rates.js', {
    state, el, closeContextMenu() {}, openContextMenu: (button, items) => menus.push(items), fmtDateTime: value => value,
    showLoading() {}, hideLoading() {}, showMsg() {},
    ExpenseAPI: { view: async (action, params) => { calls.push([action, params]); return view; } },
  }, ['renderRates', '_attachListEvents']);
  rates.renderRates();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['list_rates_view', { sort: 'sheet', dir: 'asc' }]);
  const html = nodes.rateListRegion.innerHTML;
  assert.equal((html.match(/data-action="rate-menu" data-currency="GBP"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-currency="XAU"/);
  assert.match(html, /<td class="td-mono">80\.00<\/td>/);
  const header = { dataset: { rateSort: 'rate' }, addEventListener(type, fn) { this.click = fn; } };
  const wrap = { addEventListener(type, fn) { this.click = fn; } };
  const region = { querySelector: selector => (selector === '.rate-table-wrap' ? wrap : null), querySelectorAll: () => [header] };
  rates._attachListEvents(region);
  wrap.click({ target: { closest: () => ({ dataset: { action: 'rate-menu', currency: 'GBP' } }) } });
  assert.deepEqual(menus[0].map(item => item.key), ['rate-edit', 'rate-delete']);
  header.click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['list_rates_view', { sort: 'rate', dir: 'asc' }]);
});
