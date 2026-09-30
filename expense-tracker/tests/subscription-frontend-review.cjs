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
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fixture(overrides = {}) {
  const state = {
    subscriptions: [], accounts: [], accountMap: {}, categories: [], quoteCurrency: 'GBP',
    subscriptionSchema: { frequencies: ['weekly', 'monthly', 'quarterly', 'annual'], tx_types: ['money-in', 'money-out'], record_statuses: statuses, default_timezone: 'Europe/London' },
    subImportOpen: true, subAddOpen: false, subEditRow: null, subDeleteRow: null, subPrefill: null,
    subFilters: { recordStatuses: statuses, majorCategory: 'all', frequency: 'all', search: '' },
    subSort: { col: 'next_payment_date', dir: 'asc' }, ...overrides,
  };
  const ids = ['subscriptionsContent', 'subImportStatus', 'subImportError', 'subImportFile', 'subImportConfirm', 'subImportCancel', 'subImportBtn', 'subAddBtn', 'subTableResults', 'subFSearch', 'subFormError', 'subSaveBtn', 'subExportBtn'];
  const elements = Object.fromEntries(ids.map(id => [id, { innerHTML: '', textContent: '', disabled: false, handlers: {},
    addEventListener(event, callback) { this.handlers[event] = callback; }, querySelectorAll() { return []; } }]));
  const requests = [], reloads = [], messages = [], exports = [];
  const api = { createSubscriptionsBulk: async payload => {
    requests.push(payload);
    return { ok: true, created: 1, updated: 0, failed: 0, rows: 1, results: [{ index: 0, line: 2, ok: true, action: 'created', key: uuid(1) }] };
  } };
  let loading = 0;
  const context = vm.createContext({ ...importResultHelpers(),
    state, ExpenseAPI: api, esc, el: id => elements[id] ?? null,
    openContextMenu: (button, items, select) => select('csv'), exportSubscriptions: (format, rows) => exports.push({ format, rows }),
    getSymbol: () => '£', toBase: (value, currency) => currency === 'UNKNOWN' || currency === '' ? NaN : value,
    recordStatusIcon: status => status, syncStatusIcon: () => '',
    showLoading: () => loading++, hideLoading: () => loading--, showMsg: (message, kind) => messages.push({ message, kind }),
    console: { log() {}, warn() {}, error() {} },
    document: { dispatchEvent: event => reloads.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } }, AbortController,
  });
  vm.runInContext(source + '\nthis.exposed = {_subscriptionErrors,_chooseSubscriptionImport,_submitImport,_renderImportPanel,_renderForm,_renderTable,_txTypeOpts,_majorOpts,_minorOpts,_dueDays,_toMonthly,_collectForm,_saveAdd,_attachEvents,renderSubscriptions,pending:()=>_subImportFile};', context);
  return { ...context.exposed, state, elements, requests, reloads, messages, exports, api, loading: () => loading };
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

test('schema provides transaction choices; unavailable schema blocks the section', () => {
  const f = fixture();
  f.state.transactionSchema = { types: ['transfer', 'money-in', 'money-out'] };
  assert.doesNotMatch(f._txTypeOpts(), /transfer/);
  f.state.subscriptionSchema.tx_types = ['custom'];
  assert.match(f._txTypeOpts(), /custom/);
  f.state.subscriptionSchema = null;
  f.renderSubscriptions();
  assert.match(f.elements.subscriptionsContent.innerHTML, /configuration is unavailable/);
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

test('due-day labels use each subscription timezone instead of the browser day', () => {
  const f = fixture();
  const now = new Date('2026-09-24T23:30:00Z');
  assert.equal(f._dueDays('2026-09-25', 'Europe/London', now), 0);
  assert.equal(f._dueDays('2026-09-25', 'America/New_York', now), 1);
  assert.equal(f._dueDays('2026-03-30', 'Europe/London', new Date('2026-03-28T12:00:00Z')), 2);
  assert.equal(f._dueDays('bad', 'Europe/London', now), null);
});

test('monthly estimate excludes expired/inactive rows and explicitly marks missing conversions', () => {
  const f = fixture();
  f.state.accountMap[uuid(100)] = { account_currency_local: 'GBP', account_name: 'Bank' };
  f.state.accountMap[uuid(101)] = { account_currency_local: 'UNKNOWN', account_name: 'Unknown' };
  f.state.subscriptions = [
    { ...subscription(1), _row: 2, record_status: 'active', schedule_status: 'current' },
    { ...subscription(2), _row: 3, subscription_amount_local: 1000, record_status: 'active', schedule_status: 'expired' },
    { ...subscription(3), _row: 4, record_status: 'active', schedule_status: 'upcoming', source_account: uuid(101) },
    { ...subscription(4), _row: 5, record_status: 'inactive', schedule_status: 'inactive' },
  ];
  const html = f._renderTable(f.state.subscriptions);
  assert.match(html, /2 \/ 4/);
  assert.match(html, /£12\.50 \(partial\)/);
  assert.match(html, /1 subscription\(s\) could not be converted/);
  assert.match(html, /Expired/);
  assert.equal(f._toMonthly(12, 'weekly'), 52);
});

test('editing preserves exact timestamps and timezone; form amount collection rejects partial numbers', () => {
  const f = fixture();
  const sub = { ...subscription(1), subscription_start_date_local: '2026-09-01 12:13:14.123456', subscription_end_date_local: '', subscription_timezone_local: 'Asia/Kolkata' };
  const html = f._renderForm(sub);
  assert.match(html, /2026-09-01T12:13:14\.123/);
  assert.doesNotMatch(html, /2026-09-01T12:13:14\.123456/);
  f.state.subEditRow = 2;
  f.state.subscriptions = [{ ...sub, _row: 2 }];
  assert.match(html, /Asia\/Kolkata/);
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '12bad', subSourceAccount: uuid(100), subTxType: '', subMajor: '', subMinor: '', subDescription: '', subTimezone: 'Asia/Kolkata', subStartDate: '2026-09-01T12:13:14.123', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  const body = f._collectForm();
  assert.equal(body.subscription_amount_local, '12bad');
  assert.match(f._subscriptionErrors(body).join(), /positive finite decimal/);
  assert.equal(body.subscription_start_date_local, sub.subscription_start_date_local);
  assert.equal(body.subscription_timezone_local, 'Asia/Kolkata');
  f.state.subscriptions[0].subscription_start_date_local = '2026-09-01 12:13:14.000456';
  f.elements.subStartDate.value = '2026-09-01T12:13:14';
  assert.equal(f._collectForm().subscription_start_date_local, '2026-09-01 12:13:14.000456');
  f.state.subscriptions[0].day_of_week = 2;
  assert.equal(f._collectForm().day_of_week, 2);
});

test('subscription search leaves the focused input in place while updating table results', () => {
  const f = fixture();
  f._attachEvents();
  f.elements.subscriptionsContent.innerHTML = 'original shell';
  f.elements.subFSearch.handlers.input({ target: { value: 'rent' } });
  assert.equal(f.state.subFilters.search, 'rent');
  assert.equal(f.elements.subscriptionsContent.innerHTML, 'original shell');
  assert.match(f.elements.subTableResults.innerHTML, /No subscriptions match/);
});

test('archived or no-longer-eligible selected category keys remain visible during edits', () => {
  const f = fixture({ categories: [{ tx_type_key: 'money-out', major_category_key: 'housing', major_category_label: 'Housing', minor_category_key: 'rent', minor_category_label: 'Rent', is_subscription_eligible: false, record_status: 'active' }] });
  assert.match(f._majorOpts('money-out', 'housing'), /value="housing" selected disabled/);
  assert.match(f._minorOpts('money-out', 'housing', 'rent'), /value="rent" selected disabled/);
});

test('CSV export follows current filters instead of including hidden subscriptions', () => {
  const f = fixture();
  f.state.subscriptions = [subscription(1), subscription(2)].map(row => ({ ...row, record_status: 'active' }));
  f.state.subFilters.search = 'Subscription 2';
  f._attachEvents();
  f.elements.subExportBtn.handlers.click();
  assert.equal(f.exports[0].rows.length, 1);
  assert.equal(f.exports[0].rows[0].id, uuid(2));
});

test('partial and unknown stored classification survives unrelated form edits without becoming new catalog choices', () => {
  const f = fixture({ categories: [{ tx_type_key: 'money-out', major_category_key: 'housing', major_category_label: 'Housing', minor_category_key: 'rent', minor_category_label: 'Rent', is_subscription_eligible: true, record_status: 'active' }] });
  assert.match(f._majorOpts('', 'historic'), /value="historic" selected disabled/);
  assert.match(f._minorOpts('', '', 'historic-minor'), /value="historic-minor" selected disabled/);
  assert.match(f._minorOpts('money-out', '', 'historic-minor'), /value="historic-minor" selected disabled/);
  assert.match(f._majorOpts('money-out', 'unknown'), /value="unknown" selected disabled/);
  assert.match(f._minorOpts('money-out', 'housing', 'unknown'), /value="unknown" selected disabled/);
  assert.doesNotMatch(f._majorOpts('money-out'), /historic|unknown/);
  assert.match(f._majorOpts('money-out'), /value="housing"/);
  assert.doesNotMatch(f._majorOpts('', '<bad>'), /<bad>/);
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '10', subSourceAccount: uuid(100), subTxType: '', subMajor: 'historic', subMinor: 'historic-minor', subDescription: 'changed', subTimezone: '', subStartDate: '', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  const body = f._collectForm();
  assert.equal(body.tx_type, '');
  assert.equal(body.major_category, 'historic');
  assert.equal(body.minor_category, 'historic-minor');
  assert.equal(f._subscriptionErrors(body).length, 0);
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
