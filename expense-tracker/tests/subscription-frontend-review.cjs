const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../app/sections/subscriptions.js'), 'utf8')
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
const uuid = index => `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const statuses = ['active', 'inactive', 'deleted', 'locked'];
const subscription = index => ({
  id: uuid(index), subscription_name: 'Subscription ' + index, subscription_amount_local: '12.50',
  frequency: 'monthly', day_of_month: '1', source_account: uuid(100),
});
// Server view-model fixtures (shapes of list_subscriptions_view / get_subscription_form_options).
const OPTIONS = {
  tx_types: [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }],
  frequencies: [{ value: 'weekly', label: 'Weekly', short: 'wk' }, { value: 'monthly', label: 'Monthly', short: 'mo' }],
  days_of_week: [{ value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' }],
  day_of_month: { min: 1, max: 31 }, default_frequency: 'monthly', default_timezone: 'Europe/London',
  record_statuses: statuses,
  categories: [{ tx_type: 'money-out', label: 'Money Out', majors: [
    { key: 'housing', label: 'Housing', active: true, stored: false, minors: [{ key: 'rent', label: 'Rent', active: true, stored: false }, { key: 'old', label: 'Old <rent>', active: false, stored: true }] },
    { key: 'retired', label: 'Retired', active: false, stored: true, minors: [] },
  ] }],
  source_accounts: [{ id: uuid(100), account_name: 'Bank', currency: 'GBP', currency_symbol: '£', record_status: 'active', active: true, label: 'Bank (GBP)' }],
  current: null,
};
const viewRow = (index, extra = {}) => ({
  ...subscription(index), _row: index + 1, row_num: index + 1, record_status: 'active', sync_status: 'in-sync', updated_at: '2026-09-01T00:00:00.000Z',
  account_name: 'Bank', account_currency: 'GBP', currency_symbol: '£', amount: { native: 12.5, currency: 'GBP', currency_symbol: '£', quote: 12.5 },
  frequency_short: 'mo', monthly: { native: 12.5, currency: 'GBP', currency_symbol: '£', quote: 12.5 }, amount_monthly_quote: 12.5, is_foreign: false,
  schedule_status: 'current', is_scheduled: true, next_payment_date: '2026-10-01', due_in_days: 1,
  allowed_actions: ['edit', 'pause', 'transactions', 'delete'], readonly: false, transactions_search: 'Subscription ' + index, ...extra,
});
function listResponse(rows, summary = {}) {
  return { ok: true, quote: { currency: 'GBP', symbol: '£', rate_available: true }, warnings: [], data: {
    summary: { scheduled_count: rows.filter(row => row.is_scheduled).length, total_count: rows.length, est_monthly_quote: 0, missing_rate_count: 0, partial: false, ...summary },
    rows, total: rows.length, page: 1, page_size: 'all', pages: 1, sort: { col: 'next_payment_date', dir: 'asc' },
    filters: {}, active_filter_count: 0, facets: { majors: [{ key: 'housing', label: 'Housing' }], frequencies: OPTIONS.frequencies, statuses: statuses.map(value => ({ value, label: value })) } } };
}
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fixture(overrides = {}) {
  const state = {
    views: {}, quoteCurrency: 'GBP',
    subscriptionSchema: { frequencies: ['weekly', 'monthly', 'quarterly', 'annual'], tx_types: ['money-in', 'money-out'], record_statuses: statuses, default_timezone: 'Europe/London' },
    subImportOpen: true, subAddOpen: false, subEditRow: null, subDeleteRow: null, subPrefill: null,
    subFilters: { recordStatuses: statuses, majorCategory: 'all', frequency: 'all', search: '' },
    subSort: { col: 'next_payment_date', dir: 'asc' }, ...overrides,
  };
  const ids = ['subscriptionsContent', 'subImportStatus', 'subImportError', 'subImportFile', 'subImportConfirm', 'subImportCancel', 'subImportBtn', 'subAddBtn', 'subTableResults', 'subFilterWrap', 'subFormWrap', 'subFSearch', 'subFilterApply', 'subFormError', 'subSaveBtn', 'subExportBtn'];
  const elements = Object.fromEntries(ids.map(id => [id, { innerHTML: '', textContent: '', disabled: false, handlers: {},
    addEventListener(event, callback) { this.handlers[event] = callback; }, querySelectorAll() { return []; } }]));
  const requests = [], reloads = [], messages = [], exports = [], views = [];
  const api = { view: async (action, params) => { views.push({ action, params: JSON.parse(JSON.stringify(params)) }); return api.respond(action, params); },
    respond: (action) => (action === 'get_subscription_form_options' ? { ok: true, data: OPTIONS } : listResponse([])),
    createSubscriptionsBulk: async payload => {
    requests.push(payload);
    return { ok: true, created: 1, updated: 0, failed: 0, rows: 1, results: [{ index: 0, line: 2, ok: true, action: 'created', key: uuid(1) }] };
  } };
  let loading = 0;
  const context = importResultHelpers.context({
    state, ExpenseAPI: api, esc, el: id => elements[id] ?? null,
    openContextMenu: (button, items, select) => select('csv'), exportSubscriptions: (format, rows) => exports.push({ format, rows }),
    recordStatusIcon: status => status, syncStatusIcon: () => '',
    showLoading: () => loading++, hideLoading: () => loading--, showMsg: (message, kind) => messages.push({ message, kind }),
    console: { log() {}, warn() {}, error() {} },
    document: { dispatchEvent: event => reloads.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } }, AbortController,
  });
  vm.runInContext(source + '\nthis.exposed = {_chooseSubscriptionImport,_submitImport,_renderImportPanel,_renderForm,_renderTable,_txTypeOpts,_majorSelectHtml,_minorSelectHtml,_collectForm,_saveAdd,_saveEdit,_toggle,_attachEvents,_listParams,_loadList,_loadFormOptions,renderSubscriptions,setOptions:data=>{_formOptions={key:_formKey(),data};},pending:()=>_subImportFile};', context);
  return { ...context.exposed, state, elements, requests, reloads, messages, exports, views, api, loading: () => loading };
}
const file = (text, name = 'subscription_master.csv') => ({ name, text: async () => text });

test('import panel uploads the raw file text and never parses or validates CSV in the browser', async () => {
  const f = fixture();
  assert.doesNotMatch(source, /_parseSubscriptionsCsv|_subscriptionCsvRecords|Retry failed rows|_renderImportStatus/);
  assert.equal(f.elements.subImportConfirm.disabled, false);
  f._chooseSubscriptionImport(undefined);
  assert.equal(f.elements.subImportConfirm.disabled, true);
  const raw = '﻿id,subscription_name\r\n"x","not, validated here"\r\nragged';
  f._chooseSubscriptionImport(file(raw, '<b>subs</b>.csv'));
  assert.match(f.elements.subImportStatus.innerHTML, /&lt;b&gt;subs&lt;\/b&gt;\.csv selected/);
  assert.equal(f.elements.subImportConfirm.disabled, false);
  await f._submitImport();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [{ csv: raw }]);
  assert.equal(f.pending(), null);
  assert.equal(f.elements.subImportConfirm.disabled, true);
  assert.deepEqual(f.reloads, ['et:reload']);
  assert.equal(f.loading(), 0);
});

test('server results render a summary and a line-numbered, escaped failure table', async () => {
  const f = fixture();
  f.api.createSubscriptionsBulk = async payload => {
    f.requests.push(payload);
    return { ok: false, created: 1, updated: 1, failed: 2, rows: 4, results: [
      { index: 0, line: 2, ok: true, action: 'created' },
      { index: 1, line: 5, ok: false, error: '<unknown_source_account>', key: uuid(2) },
      { index: 2, line: 7, ok: true, action: 'updated' },
      { index: 3, line: 9, ok: false, error: 'field_invalid', field: 'day_of_month', invalid_values: ['<32>'] },
    ] };
  };
  f._chooseSubscriptionImport(file('csv text'));
  await f._submitImport();
  const html = f._renderImportPanel();
  assert.match(html, /1 created · 1 updated · 2 failed/);
  assert.match(html, /<td class="td-mono">5<\/td><td class="import-result-reason">&lt;unknown source account&gt;\.<div class="td-mono td-muted">&lt;unknown_source_account&gt;<\/div><\/td><td>a0000000-0000-4000-8000-000000000002<\/td>/);
  assert.match(html, /<td class="td-mono">9<\/td><td class="import-result-reason">Field invalid\.<div class="td-mono td-muted">field_invalid<\/div><\/td><td>day_of_month · &lt;32&gt;<\/td>/);
  assert.doesNotMatch(html, /<unknown_source_account>|Retry/);
  assert.deepEqual(f.reloads, ['et:reload']);
  assert.equal(f.messages.at(-1).kind, 'warn');
});

test('invalid-file responses render every server error as a list and nothing reloads', async () => {
  const f = fixture();
  f.api.createSubscriptionsBulk = async () => ({ ok: false, error: 'invalid_csv_rows', errors: ['Row 3: invalid frequency (invalid_frequency).', 'Row 4: <bad>'] });
  f._chooseSubscriptionImport(file('csv text'));
  await f._submitImport();
  const html = f._renderImportPanel();
  assert.match(html, /<li>Row 3: invalid frequency \(invalid_frequency\)\.<\/li><li>Row 4: &lt;bad&gt;/);
  assert.match(html, /Nothing was imported/);
  assert.equal(f.reloads.length, 0);
  assert.equal(f.pending(), null);
});

test('top-level backend failures remain visible even when results is an empty list', async () => {
  const f = fixture();
  f.api.createSubscriptionsBulk = async () => ({ ok: false, error: 'invalid_existing_subscription_id', results: [] });
  f._chooseSubscriptionImport(file('csv text'));
  await f._submitImport();
  assert.match(f._renderImportPanel(), /Import failed: invalid_existing_subscription_id/);
  assert.equal(f.reloads.length, 0);
});

test('request_failed after a partial server write warns and reloads instead of replaying', async () => {
  const f = fixture();
  f.api.createSubscriptionsBulk = async () => ({ ok: false, error: 'request_failed' });
  f._chooseSubscriptionImport(file('csv text'));
  await f._submitImport();
  assert.equal(f.pending(), null);
  assert.match(f._renderImportPanel(), /request_failed.*Some rows may have been saved/);
  assert.deepEqual(f.reloads, ['et:reload']);
});

test('duplicate clicks cannot post twice and uncertain network outcomes require checking before importing again', async () => {
  const f = fixture();
  let reject;
  f.api.createSubscriptionsBulk = payload => { f.requests.push(payload); return new Promise((_, rejectFn) => { reject = rejectFn; }); };
  f._chooseSubscriptionImport(file('csv text'));
  const pending = f._submitImport();
  await f._submitImport();
  await new Promise(done => setImmediate(done));
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.subImportFile.disabled, true);
  assert.equal(f.elements.subImportCancel.disabled, true);
  f._chooseSubscriptionImport(file('other'));
  reject(new Error('network'));
  await pending;
  assert.equal(f.pending(), null);
  assert.equal(f.elements.subImportConfirm.disabled, true);
  assert.match(f._renderImportPanel(), /Some rows may have been saved/);
  assert.equal(f.loading(), 0);
});

test('schema gate blocks the section; transaction choices come from the form options', () => {
  const f = fixture();
  f.state.subAddOpen = true;
  f.setOptions({ ...OPTIONS, tx_types: [{ value: 'custom', label: '<Custom>' }] });
  assert.match(f._txTypeOpts('custom'), /value="custom" selected>&lt;Custom&gt;/);
  assert.doesNotMatch(f._txTypeOpts(), /transfer/);
  f.state.subscriptionSchema = null;
  f.renderSubscriptions();
  assert.match(f.elements.subscriptionsContent.innerHTML, /configuration is unavailable/);
  assert.equal(f.views.length, 0);
});

test('amount text reaches the form API payload without financial precision loss', async () => {
  const f = fixture();
  const amount = '9007199254740993.123456789';
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '  ' + amount + '  ', subSourceAccount: uuid(100), subTxType: '', subMajor: '', subMinor: '', subDescription: '', subTimezone: '', subStartDate: '', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  f.api.createSubscription = async payload => { f.requests.push(payload); return { ok: true }; };
  await f._saveAdd();
  assert.equal(f.requests[0].subscription_amount_local, amount);
});

test('the table renders the server summary, due-in days and quote amounts without computing them', () => {
  const f = fixture();
  assert.doesNotMatch(source, /_toMonthly|_sortSubs|_applySubFilters|_isScheduled|_dueDays|_majorOpts|_minorOpts|toBase|getSymbol|accountMap|state\.subscriptions|state\.categories|state\.accounts/);
  const rows = [
    viewRow(1, { due_in_days: 0 }),
    viewRow(2, { account_currency: 'INR', currency_symbol: '₹', amount: { native: 1000, currency: 'INR', currency_symbol: '₹', quote: 9.52 }, frequency_short: 'qtr',
      monthly: { native: 333.33, currency: 'INR', currency_symbol: '₹', quote: 3.17 }, is_foreign: true, due_in_days: -2, next_payment_date: '2026-09-28' }),
    viewRow(3, { is_foreign: true, monthly: { native: 5, currency: 'ZZZ', currency_symbol: 'ZZZ ', quote: null }, due_in_days: 12 }),
    viewRow(4, { is_scheduled: false, schedule_status: 'expired', next_payment_date: '', due_in_days: null, record_status: 'active' }),
  ];
  const html = f._renderTable(listResponse(rows, { scheduled_count: 3, total_count: 5, est_monthly_quote: 1234.5, missing_rate_count: 1, partial: true }));
  assert.match(html, /3 \/ 5/);
  assert.match(html, /£1,234\.50 \(partial\)/);
  assert.match(html, /1 subscription\(s\) could not be converted/);
  assert.match(html, /\(today\)/);
  assert.match(html, /\(2d overdue\)/);
  assert.match(html, /\(in 12d\)/);
  assert.match(html, /₹1,000\.00\/qtr<span class="td-base-amt">£3\.17\/mo/);
  assert.match(html, /td-base-amt">—</);
  assert.match(html, /Expired/);
  assert.match(html, /data-sub-sort="amount_monthly_quote"/);
  assert.match(f._renderTable(listResponse([])), /No subscriptions match/);
});

test('filters, sort and paging travel as view params; an empty status selection is explicit', async () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(f._listParams())), { search: '', sort_col: 'next_payment_date', sort_dir: 'asc', page: 1, page_size: 'all' });
  f.state.subFilters = { recordStatuses: ['active', 'locked'], majorCategory: 'housing', frequency: 'weekly', search: 'rent' };
  f.state.subSort = { col: 'amount_monthly_quote', dir: 'desc' };
  const params = JSON.parse(JSON.stringify(f._listParams()));
  assert.deepEqual(params, { statuses: ['active', 'locked'], major: 'housing', frequency: 'weekly', search: 'rent', sort_col: 'amount_monthly_quote', sort_dir: 'desc', page: 1, page_size: 'all' });
  f.state.subFilters.recordStatuses = [];
  assert.equal(f._listParams().statuses, 'none');
  await f._loadList();
  assert.equal(f.views.at(-1).action, 'list_subscriptions_view');
  assert.equal(f.state.views.list_subscriptions_view.ok, true);
});

test('search waits for Apply / Enter, then re-requests the view without redrawing the page shell', async () => {
  const f = fixture();
  f._attachEvents();
  f.elements.subscriptionsContent.innerHTML = 'original shell';
  f.elements.subFSearch.handlers.input({ target: { value: 'rent' } });
  assert.equal(f.views.length, 0);
  assert.equal(f.state.subFilters.search, '');
  f.elements.subFSearch.handlers.keydown({ key: 'Enter', target: { value: ' rent ' } });
  await new Promise(done => setImmediate(done));
  assert.equal(f.state.subFilters.search, 'rent');
  assert.equal(f.views.at(-1).params.search, 'rent');
  assert.equal(f.elements.subscriptionsContent.innerHTML, 'original shell');
  assert.match(f.elements.subTableResults.innerHTML, /No subscriptions match/);
});

test('a failed list response shows the server message and keeps the last loaded rows', async () => {
  const f = fixture();
  f.state.views.list_subscriptions_view = listResponse([viewRow(1)]);
  f.api.respond = () => ({ ok: false, error: 'invalid_filter', field: 'statuses', message: 'Choose <statuses> from the list.' });
  await f._loadList();
  assert.match(f.elements.subTableResults.innerHTML, /Choose &lt;statuses&gt; from the list\. Showing the last loaded list\./);
  assert.match(f.elements.subTableResults.innerHTML, /Subscription 1/);
});

test('editing preserves exact timestamps and timezone; form amount collection sends text as entered', () => {
  const f = fixture();
  const sub = viewRow(1, { subscription_start_date_local: '2026-09-01 12:13:14.123456', subscription_end_date_local: '', subscription_timezone_local: 'Asia/Kolkata' });
  f.state.views.list_subscriptions_view = listResponse([sub]);
  f.state.subEditRow = uuid(1);   // open panels hold the record id
  f.setOptions(OPTIONS);
  const html = f._renderForm(sub);
  assert.match(html, /2026-09-01T12:13:14\.123/);
  assert.doesNotMatch(html, /2026-09-01T12:13:14\.123456/);
  assert.match(html, /Asia\/Kolkata/);
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '12bad', subSourceAccount: uuid(100), subTxType: '', subMajor: '', subMinor: '', subDescription: '', subTimezone: 'Asia/Kolkata', subStartDate: '2026-09-01T12:13:14.123', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  const body = f._collectForm();
  // Sent as entered; validateSubscriptionCreate rejects it (form-validation-backend.cjs).
  assert.equal(body.subscription_amount_local, '12bad');
  assert.equal(body.subscription_start_date_local, sub.subscription_start_date_local);
  assert.equal(body.subscription_timezone_local, 'Asia/Kolkata');
  sub.subscription_start_date_local = '2026-09-01 12:13:14.000456';
  f.elements.subStartDate.value = '2026-09-01T12:13:14';
  assert.equal(f._collectForm().subscription_start_date_local, '2026-09-01 12:13:14.000456');
  sub.day_of_week = 2;
  assert.equal(f._collectForm().day_of_week, 2);
});

test('the form waits for its options and renders server accounts, frequencies and day labels', async () => {
  const f = fixture();
  f.state.subAddOpen = true;
  assert.match(f._renderForm(null), /Loading form…/);
  await f._loadFormOptions();
  assert.deepEqual(f.views.at(-1), { action: 'get_subscription_form_options', params: {} });
  assert.match(f.elements.subFormWrap.innerHTML, /<option value="a0000000-0000-4000-8000-000000000100" >Bank \(GBP\)<\/option>/);
  assert.match(f.elements.subFormWrap.innerHTML, /<option value="monthly" selected>Monthly<\/option>/);
  f.state.subAddOpen = false;
  f.state.views.list_subscriptions_view = listResponse([viewRow(1)]);
  f.state.subEditRow = uuid(1);   // open panels hold the record id
  await f._loadFormOptions();
  assert.deepEqual(f.views.at(-1), { action: 'get_subscription_form_options', params: { id: uuid(1) } });
});

test('archived, stored and unknown category keys stay visible but unselectable', () => {
  const f = fixture();
  f.state.subAddOpen = true;
  f.setOptions(OPTIONS);
  assert.match(f._majorSelectHtml('money-out', 'retired'), /value="retired" selected disabled[^>]*>Retired \(archived\)/);
  assert.match(f._minorSelectHtml('money-out', 'housing', 'old'), /value="old" selected disabled[^>]*>Old &lt;rent&gt; \(archived\)/);
  assert.match(f._minorSelectHtml('money-out', 'housing'), /value="rent">Rent/);
  assert.match(f._majorSelectHtml('', 'historic'), /value="historic" selected disabled>historic \(stored\)/);
  assert.match(f._minorSelectHtml('', '', 'historic-minor'), /value="historic-minor" selected disabled/);
  assert.match(f._majorSelectHtml('money-out', 'unknown'), /value="unknown" selected disabled>unknown \(stored\)/);
  assert.doesNotMatch(f._majorSelectHtml('money-out'), /historic|unknown|\(stored\)/);
  assert.doesNotMatch(f._majorSelectHtml('', '<bad>'), /<bad>/);
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '10', subSourceAccount: uuid(100), subTxType: '', subMajor: 'historic', subMinor: 'historic-minor', subDescription: 'changed', subTimezone: '', subStartDate: '', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  const body = f._collectForm();
  assert.equal(body.tx_type, '');
  assert.equal(body.major_category, 'historic');
  assert.equal(body.minor_category, 'historic-minor');
});

test('export requests every filtered row from the server, not just the visible page', async () => {
  const f = fixture();
  f.state.subFilters.search = 'Subscription 2';
  f.api.respond = () => listResponse([viewRow(2)]);
  f._attachEvents();
  f.elements.subExportBtn.handlers.click();
  await new Promise(done => setImmediate(done));
  assert.equal(f.views.at(-1).params.search, 'Subscription 2');
  assert.equal(f.views.at(-1).params.page_size, 'all');
  assert.equal(f.exports[0].rows.length, 1);
  assert.equal(f.exports[0].rows[0].id, uuid(2));
});

test('mutations carry the displayed row identity; pause / resume follow allowed_actions', async () => {
  const f = fixture();
  f.state.views.list_subscriptions_view = listResponse([viewRow(1), viewRow(2, { record_status: 'inactive', allowed_actions: ['edit', 'resume', 'transactions', 'delete'] })]);
  const payloads = [];
  f.api.updateSubscription = async body => { payloads.push(JSON.parse(JSON.stringify(body))); return { ok: true }; };
  await f._toggle(uuid(1));
  await f._toggle(uuid(2));
  assert.deepEqual(payloads, [
    { row_num: 2, record_status: 'inactive', id: uuid(1), updated_at: '2026-09-01T00:00:00.000Z' },
    { row_num: 3, record_status: 'active', id: uuid(2), updated_at: '2026-09-01T00:00:00.000Z' },
  ]);
});

test('the form submits without browser validation and renders the server message on the named field', async () => {
  const f = fixture();
  assert.doesNotMatch(source, /_subscriptionErrors|_timestampValid|FE duplicate check/);
  const wraps = {};
  const values = { subFrequency: 'quarterly', subDayOfMonth: '1', subName: 'Rent', subCounterparty: '', subAmount: '', subSourceAccount: '', subTxType: '', subMajor: '', subMinor: '', subDescription: '', subTimezone: '', subStartDate: '', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => {
    const classes = new Set();
    wraps[id] = classes;
    f.elements[id] = { value, closest: selector => (selector === '.field' ? { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } : null) };
  });
  const responses = [
    { ok: false, error: 'missing_subscription_amount_local', field: 'subscription_amount_local', message: 'Amount is required.' },
    { ok: false, error: 'duplicate_subscription' },
  ];
  f.api.createSubscription = async payload => { f.requests.push(payload); return responses.shift(); };
  await f._saveAdd();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].subscription_amount_local, '');
  assert.equal(f.elements.subFormError.textContent, 'Amount is required.');
  assert.equal(wraps.subAmount.has('error'), true);
  await f._saveAdd();
  assert.equal(f.requests.length, 2);
  assert.equal(f.elements.subFormError.textContent, 'Duplicate subscription.');
  f.state.views.list_subscriptions_view = listResponse([viewRow(1)]);
  f.state.subEditRow = uuid(1);   // open panels hold the record id
  f.api.updateSubscription = async payload => { f.requests.push(payload); return { ok: false, error: 'end_before_start', field: 'subscription_end_date_local', message: 'End date must not be before the start date.' }; };
  await f._saveEdit();
  assert.equal(f.requests[2].row_num, 2);
  assert.equal(f.requests[2].id, uuid(1));
  assert.equal(f.elements.subFormError.textContent, 'End date must not be before the start date.');
  assert.equal(wraps.subEndDate.has('error'), true);
  assert.equal(f.reloads.length, 0);
  assert.equal(f.loading(), 0);
});

test('a local file-read failure is reported without claiming a server write or reloading', async () => {
  const f = fixture();
  f._chooseSubscriptionImport({ name: 'bad.csv', text: async () => { throw new Error('read'); } });
  await f._submitImport();
  assert.equal(f.requests.length, 0);
  assert.equal(f.reloads.length, 0);
  assert.match(f._renderImportPanel(), /Unable to read the CSV/);
  assert.equal(f.loading(), 0);
});

test('reopening a form with cached options renders at once and an unchanged refresh keeps typed input', async () => {
  const f = fixture();
  f.state.subAddOpen = true;
  f.setOptions(OPTIONS);
  f.elements.subFormWrap.innerHTML = 'form with typed input';
  await f._loadFormOptions();
  assert.equal(f.views.at(-1).action, 'get_subscription_form_options');
  assert.equal(f.elements.subFormWrap.innerHTML, 'form with typed input');
  f.api.respond = () => ({ ok: true, data: { ...OPTIONS, source_accounts: [] } });
  await f._loadFormOptions();
  assert.match(f.elements.subFormWrap.innerHTML, /New subscription/);
});
