const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
const csv = (rows, columns = [...new Set(rows.flatMap(Object.keys))]) => columns.join(',') + '\r\n' + rows.map(row =>
  columns.map(key => '"' + String(row[key] ?? '').replace(/"/g, '""') + '"').join(',')
).join('\r\n');
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
    return { ok: true, results: payload.subscriptions.map((row, index) => ({ index, ok: true, action: 'created', key: row.id })) };
  } };
  let loading = 0;
  const context = vm.createContext({
    state, ExpenseAPI: api, esc, el: id => elements[id] ?? null,
    openContextMenu: (button, items, select) => select('csv'), exportSubscriptions: (format, rows) => exports.push({ format, rows }),
    getSymbol: () => '£', toBase: (value, currency) => currency === 'UNKNOWN' || currency === '' ? NaN : value,
    recordStatusIcon: status => status, syncStatusIcon: () => '',
    showLoading: () => loading++, hideLoading: () => loading--, showMsg: (message, kind) => messages.push({ message, kind }),
    console: { log() {}, warn() {}, error() {} },
    document: { dispatchEvent: event => reloads.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } }, AbortController,
  });
  vm.runInContext(source + '\nthis.exposed = {_subscriptionErrors,_parseSubscriptionsCsv,_readSubscriptionImport,_submitImport,_renderImportPanel,_renderForm,_renderTable,_txTypeOpts,_majorOpts,_minorOpts,_dueDays,_toMonthly,_collectForm,_saveAdd,_attachEvents,renderSubscriptions,pending:()=>_importParsed};', context);
  return { ...context.exposed, state, elements, requests, reloads, messages, exports, api, loading: () => loading };
}
const select = async (context, rows) => context._readSubscriptionImport({ name: 'subscription_master.csv', text: async () => csv(rows) });

test('CSV headers, malformed quoting and ragged rows fail explicitly and block submission', async () => {
  const f = fixture();
  for (const [text, pattern] of [
    ['subscription_name\nRent', /Missing required headers/],
    ['subscription_name,subscription_name\nRent,Rent', /duplicate column headers/],
    [csv([subscription(1)]) + '\nshort,row', /expected .* columns/],
    [csv([subscription(1)]) + '\n"unclosed', /not closed/],
    [csv([subscription(1)]) + '\n"quoted"tail', /invalid characters/],
  ]) assert.match(f._parseSubscriptionsCsv(text).errors.join(), pattern);
  await f._readSubscriptionImport({ name: 'bad.csv', text: async () => csv([subscription(1), { ...subscription(2), subscription_amount_local: 'junk' }]) });
  assert.equal(f.pending(), null);
  assert.equal(f.elements.subImportConfirm.disabled, true);
  assert.match(f._renderImportPanel(), /Correct the CSV errors/);
});

test('CSV supports BOM, quoted commas, quotes and multiline notes with physical row numbers', () => {
  const f = fixture();
  const rows = [{ ...subscription(1), description: 'Line 1, "quoted"\r\nline 2' }, subscription(2)];
  const result = f._parseSubscriptionsCsv('\uFEFF' + csv(rows));
  assert.equal(result.errors.length, 0);
  assert.equal(result.subscriptions[0].description, rows[0].description);
  assert.deepEqual(Array.from(result.subscriptions, row => row.csv_row_num), [2, 4]);
});

test('CSV UUIDs are canonicalized and case-insensitive duplicate identities are reported', () => {
  const f = fixture();
  const first = { ...subscription(1), id: uuid(1).toUpperCase(), source_account: uuid(100).toUpperCase() };
  const result = f._parseSubscriptionsCsv(csv([first]));
  assert.equal(result.errors.length, 0);
  assert.equal(result.subscriptions[0].id, uuid(1));
  assert.equal(result.subscriptions[0].source_account, uuid(100));
  assert.match(f._parseSubscriptionsCsv(csv([first, subscription(1)])).errors.join(), /duplicate id/);
  assert.match(f._parseSubscriptionsCsv(csv([{ ...subscription(1), id: 'old-id' }])).errors.join(), /id must be a UUID/);
  assert.match(f._parseSubscriptionsCsv(csv([{ ...subscription(1), source_account: 'Bank' }])).errors.join(), /source_account must be a UUID/);
});

test('CSV preserves supplied lifecycle choices but omits blank lifecycle and server-owned metadata', () => {
  const f = fixture();
  const result = f._parseSubscriptionsCsv(csv(statuses.map((record_status, index) => ({ ...subscription(index + 1), record_status, sync_status: 'in-sync', created_at: 'past' }))));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(Array.from(result.subscriptions, row => row.record_status), statuses);
  assert.ok(result.subscriptions.every(row => row.sync_status === undefined && row.created_at === undefined));
  const blank = f._parseSubscriptionsCsv(csv([{ ...subscription(1), record_status: '' }]));
  assert.equal(Object.hasOwn(blank.subscriptions[0], 'record_status'), false);
  assert.match(f._parseSubscriptionsCsv(csv([{ ...subscription(1), record_status: 'archived' }])).errors.join(), /invalid record_status/);
});

test('CSV amounts reject prefixes, non-finite values, hex and locale separators', () => {
  const f = fixture();
  for (const value of ['12bad', '1,234.56', '1,25', 'Infinity', 'NaN', '0x10', '1e309', '1_000', '0', '-1']) {
    const result = f._parseSubscriptionsCsv(csv([{ ...subscription(1), subscription_amount_local: value }]));
    assert.equal(result.subscriptions.length, 0, value);
    assert.match(result.errors.join(), /positive finite decimal/);
  }
  for (const value of ['.001', '+12.50', '1.2e2', '12.']) {
    const result = f._parseSubscriptionsCsv(csv([{ ...subscription(1), subscription_amount_local: value }]));
    assert.equal(result.errors.length, 0, value);
    assert.equal(result.subscriptions[0].subscription_amount_local, value);
  }
});

test('CSV schedules reject missing anchors, invalid day fields, impossible dates and unqualified local times', () => {
  const f = fixture();
  for (const [overrides, pattern] of [
    [{ frequency: 'quarterly' }, /start date is required/],
    [{ day_of_week: '8' }, /day_of_week must be a whole number/],
    [{ day_of_month: '1.5' }, /whole number/],
    [{ subscription_start_date_local: '2026-02-30', subscription_timezone_local: 'Europe/London' }, /real local date/],
    [{ subscription_start_date_local: '2026-09-01' }, /timezone.*required/],
    [{ subscription_timezone_local: 'Invalid/Zone' }, /invalid subscription_timezone_local/],
    [{ subscription_start_date_local: '2026-09-02', subscription_end_date_local: '2026-09-01', subscription_timezone_local: 'Europe/London' }, /end date must not precede/],
  ]) assert.match(f._parseSubscriptionsCsv(csv([{ ...subscription(1), ...overrides }])).errors.join(), pattern);
  const partial = f._parseSubscriptionsCsv(csv([{ ...subscription(1), tx_type: 'money-out', day_of_week: '2' }]));
  assert.equal(partial.errors.length, 0);
  assert.equal(partial.subscriptions[0].day_of_week, '2');
  assert.equal(partial.subscriptions[0].tx_type, 'money-out');
  const result = f._parseSubscriptionsCsv(csv([{ ...subscription(1), frequency: 'annual', subscription_start_date_local: '2026-09-01', subscription_end_date_local: '2027-09-01T12:13:14.123456', subscription_timezone_local: 'Europe/London' }]));
  assert.equal(result.errors.length, 0);
  assert.equal(result.subscriptions[0].subscription_start_date_local, '2026-09-01 00:00:00');
  assert.equal(result.subscriptions[0].subscription_end_date_local, '2027-09-01 12:13:14.123456');
});

test('schema provides frequency, lifecycle and transaction choices; unavailable schema cannot import', () => {
  const f = fixture();
  f.state.transactionSchema = { types: ['transfer', 'money-in', 'money-out'] };
  assert.doesNotMatch(f._txTypeOpts(), /transfer/);
  f.state.subscriptionSchema.tx_types = ['custom'];
  f.state.subscriptionSchema.record_statuses = ['review'];
  const result = f._parseSubscriptionsCsv(csv([{ ...subscription(1), tx_type: 'custom', major_category: 'major', minor_category: 'minor', record_status: 'review' }]));
  assert.equal(result.errors.length, 0);
  assert.match(f._txTypeOpts(), /custom/);
  f.state.subscriptionSchema = null;
  assert.match(f._parseSubscriptionsCsv(csv([subscription(1)])).errors.join(), /configuration is unavailable/);
  f.renderSubscriptions();
  assert.match(f.elements.subscriptionsContent.innerHTML, /configuration is unavailable/);
});

test('failed-only retry retains physical rows, actionable reasons and escaped labels across renders', async () => {
  const f = fixture();
  await select(f, [subscription(1), { ...subscription(2), subscription_name: '<script>bad</script>' }]);
  f.api.createSubscriptionsBulk = async payload => {
    f.requests.push(payload);
    return { ok: false, results: [{ index: 1, ok: false, error: '<missing_rate>' }, { index: 0, ok: true, action: 'created' }] };
  };
  await f._submitImport(f.pending());
  assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].id, uuid(2));
  assert.equal(f.pending()[0].csv_row_num, 3);
  assert.match(f._renderImportPanel(), /Retry failed rows/);
  assert.match(f._renderImportPanel(), /&lt;missing_rate&gt;/);
  assert.doesNotMatch(f._renderImportPanel(), /<script>/);
  f.renderSubscriptions();
  assert.equal(f.elements.subImportConfirm.disabled, false);
  f.api.createSubscriptionsBulk = async payload => {
    f.requests.push(payload);
    return { ok: true, results: [{ index: 0, ok: true, action: 'updated' }] };
  };
  await f._submitImport(f.pending());
  assert.equal(f.requests[1].subscriptions.length, 1);
  assert.equal(f.pending(), null);
  assert.equal(f.loading(), 0);
  assert.deepEqual(f.reloads, ['et:reload', 'et:reload']);
});

test('top-level backend failures remain visible even when results is an empty list', async () => {
  const f = fixture();
  await select(f, [subscription(1)]);
  f.api.createSubscriptionsBulk = async () => ({ ok: false, error: 'invalid_existing_subscription_id', results: [] });
  await f._submitImport(f.pending());
  assert.match(f._renderImportPanel(), /invalid_existing_subscription_id/);
  assert.equal(f.pending().length, 1);
  assert.equal(f.reloads.length, 0);
});

test('duplicate clicks cannot post twice and uncertain network outcomes require checking before retry', async () => {
  const f = fixture();
  await select(f, [subscription(1)]);
  let reject;
  f.api.createSubscriptionsBulk = payload => { f.requests.push(payload); return new Promise((_, rejectFn) => { reject = rejectFn; }); };
  const pending = f._submitImport(f.pending());
  await f._submitImport(f.pending());
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.subImportFile.disabled, true);
  assert.equal(f.elements.subImportCancel.disabled, true);
  reject(new Error('network'));
  await pending;
  assert.equal(f.pending(), null);
  assert.equal(f.elements.subImportConfirm.disabled, true);
  assert.match(f._renderImportPanel(), /Some rows may have been saved/);
  assert.equal(f.loading(), 0);
});

test('incomplete or duplicate response indexes never create a blind retry batch', async () => {
  for (const results of [[], [{ index: 0, ok: true }, { index: 0, ok: false }], [{ index: 5, ok: false }, { index: 0, ok: true }]]) {
    const f = fixture();
    await select(f, [subscription(1), subscription(2)]);
    f.api.createSubscriptionsBulk = async () => ({ ok: true, results });
    await f._submitImport(f.pending());
    assert.equal(f.pending(), null);
    assert.match(f._renderImportPanel(), /incomplete import result/);
  }
});

test('newer file selection wins when reads finish out of order', async () => {
  const f = fixture();
  let resolve;
  const older = f._readSubscriptionImport({ name: 'old.csv', text: () => new Promise(done => { resolve = done; }) });
  await select(f, [subscription(2)]);
  resolve(csv([subscription(1)]));
  await older;
  assert.equal(f.pending()[0].id, uuid(2));
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

test('request_failed after a partial server write cannot blindly replay the full file', async () => {
  const f = fixture();
  await select(f, [subscription(1)]);
  f.api.createSubscriptionsBulk = async () => ({ ok: false, error: 'request_failed' });
  await f._submitImport(f.pending());
  assert.equal(f.pending(), null);
  assert.match(f._renderImportPanel(), /request_failed.*Some rows may have been saved/);
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

test('amount text reaches both import and form API payloads without financial precision loss', async () => {
  const f = fixture();
  const amount = '9007199254740993.123456789';
  const parsed = f._parseSubscriptionsCsv(csv([{ ...subscription(1), subscription_amount_local: '  ' + amount + '  ' }]));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.subscriptions[0].subscription_amount_local, amount);
  await f._submitImport(parsed.subscriptions);
  assert.equal(f.requests[0].subscriptions[0].subscription_amount_local, amount);
  const values = { subFrequency: 'monthly', subDayOfMonth: '1', subName: 'Test', subCounterparty: '', subAmount: '  ' + amount + '  ', subSourceAccount: uuid(100), subTxType: '', subMajor: '', subMinor: '', subDescription: '', subTimezone: '', subStartDate: '', subEndDate: '' };
  Object.entries(values).forEach(([id, value]) => { f.elements[id] = { value }; });
  f.api.createSubscription = async payload => { f.requests.push(payload); return { ok: true }; };
  await f._saveAdd();
  assert.equal(f.requests[1].subscription_amount_local, amount);
});

test('unknown CSV headers are rejected while all six lifecycle/sync/audit headers are accepted', () => {
  const f = fixture();
  for (const header of ['notes', 'record_stats', 'next_payment_date', '']) {
    const parsed = f._parseSubscriptionsCsv(csv([{ ...subscription(1), [header]: 'unexpected' }]));
    assert.equal(parsed.subscriptions.length, 0);
    assert.match(parsed.errors.join(), /Unknown CSV headers/);
  }
  const parsed = f._parseSubscriptionsCsv(csv([{ ...subscription(1), record_status: 'inactive', sync_status: 'in-sync', sync_date: 'ignored', sync_notes: 'ignored', created_at: 'ignored', updated_at: 'ignored' }]));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.subscriptions[0].record_status, 'inactive');
  for (const key of ['sync_status', 'sync_date', 'sync_notes', 'created_at', 'updated_at']) assert.equal(Object.hasOwn(parsed.subscriptions[0], key), false);
});

test('numeric timezone offsets fail before API submission while IANA fixed zones remain valid', () => {
  const f = fixture();
  for (const zone of ['+05:30', '-04:00', '+0530', '+05', '-00:00']) {
    const parsed = f._parseSubscriptionsCsv(csv([{ ...subscription(1), subscription_timezone_local: zone }]));
    assert.match(parsed.errors.join(), /invalid subscription_timezone_local/);
  }
  const parsed = f._parseSubscriptionsCsv(csv([{ ...subscription(1), subscription_timezone_local: 'Etc/GMT-5' }]));
  assert.equal(parsed.errors.length, 0);
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
