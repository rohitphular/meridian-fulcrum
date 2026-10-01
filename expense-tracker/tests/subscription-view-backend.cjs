// list_subscriptions_view / get_subscription_form_options (api/view-subscriptions.gs):
// schedule fields straight from listSubscriptions(), due-in days in each row's
// timezone, monthly equivalents in the quote currency, summary over all rows,
// server filter / sort / paging, allowed_actions and the form options tree.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sheet, gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, CATEGORIES, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-09-30T12:00:00Z');
class FixedDate extends Date {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}

const CATS = [
  ...CATEGORIES,
  { id: ID(51), tx_type_key: 'money-out', major_category_key: 'housing', major_category_label: 'Housing', minor_category_key: 'rent', minor_category_label: 'Rent', record_status: 'active', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: true },
  { id: ID(52), tx_type_key: 'money-out', major_category_key: 'housing', major_category_label: 'Housing', minor_category_key: 'service', minor_category_label: 'Service charge', record_status: 'inactive', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: true },
  { id: ID(53), tx_type_key: 'money-out', major_category_key: 'bills', major_category_label: 'Bills', minor_category_key: 'tv', minor_category_label: 'TV', record_status: 'deleted', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: true },
  { id: ID(54), tx_type_key: 'money-in', major_category_key: 'income', major_category_label: 'Income', minor_category_key: 'rental', minor_category_label: 'Rental income', record_status: 'active', source_account_mandatory: false, target_account_mandatory: true, is_subscription_eligible: true },
];

const sub = (n, fields) => ({ id: ID(n), subscription_name: 'Sub ' + n, counterparty_name: '', subscription_amount_local: '10', frequency: 'monthly', day_of_month: 1, day_of_week: '',
  source_account: ID(11), tx_type: 'money-out', major_category: 'housing', minor_category: 'rent', description: '', record_status: 'active',
  created_at: '2026-01-01T00:00:00.000Z', sync_status: 'in-sync', sync_date: '', sync_notes: '', updated_at: '2026-09-01T00:00:00.000Z',
  subscription_start_date_local: '', subscription_end_date_local: '', subscription_timezone_local: 'Europe/London', ...fields });

const SUBS = [
  sub(61, { subscription_name: 'Rent', counterparty_name: 'Landlord Ltd', subscription_amount_local: '1000' }),
  sub(62, { subscription_name: 'Gym', subscription_amount_local: '7', frequency: 'weekly', day_of_month: '', day_of_week: 3, source_account: ID(13), major_category: '', minor_category: '', tx_type: '' }),
  sub(63, { subscription_name: 'Rupee plan', subscription_amount_local: '12000', frequency: 'annual', day_of_month: 15, source_account: ID(12),
    subscription_start_date_local: '2026-01-15 00:00:00', subscription_timezone_local: 'Asia/Kolkata', major_category: 'food', minor_category: 'groceries', description: 'Yearly RUPEE fee' }),
  sub(64, { subscription_name: 'Broker fee', subscription_amount_local: '30', frequency: 'quarterly', day_of_month: 5, source_account: ID(14),
    subscription_start_date_local: '2026-08-01 00:00:00', subscription_timezone_local: 'America/New_York' }),
  sub(65, { subscription_name: 'Old', record_status: 'inactive' }),
  sub(66, { subscription_name: 'Expired', subscription_end_date_local: '2026-06-30 00:00:00' }),
  sub(67, { subscription_name: 'Gone', record_status: 'deleted' }),
  sub(68, { subscription_name: 'Locked sub', record_status: 'locked' }),
];

function appRuntime() {
  const runtime = gasRuntime({ properties: { PIN_SECRET: '1234' }, globals: { Date: FixedDate } });
  runtime.tabs = seedViewFixture(runtime, { categories: CATS });
  const columns = runtime.ctx.getSubscriptionSheetColumns();
  SUBS.forEach(record => runtime.tabs.subscriptions.rows.push(columns.map(column => (record[column] === undefined ? '' : record[column]))));
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  runtime.list = params => runtime.get({ action: 'list_subscriptions_view', ...params });
  return runtime;
}

test('list_subscriptions_view is registered and returns every row with schedule fields from listSubscriptions()', () => {
  const runtime = appRuntime();
  const response = runtime.list({});
  assert.equal(response.ok, true);
  assert.deepEqual(response.quote, { currency: 'GBP', symbol: '£', rate_available: true });
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const { data } = response;
  assert.equal(data.rows.length, 8);
  assert.deepEqual([data.total, data.page, data.page_size, data.pages], [8, 1, 'all', 1]);
  assert.deepEqual(data.sort, { col: 'next_payment_date', dir: 'asc' });
  runtime.ctx.vmResetRequest();
  const raw = plain(runtime.ctx.listSubscriptions());
  for (const row of data.rows) {
    const source = raw.find(item => item.id === row.id);
    assert.equal(row.next_payment_date, source.next_payment_date, row.subscription_name);
    assert.equal(row.schedule_status, source.schedule_status, row.subscription_name);
    assert.equal(row.row_num, source._row);
    assert.equal(row.updated_at, source.updated_at);
  }
  // Next payment ascending, blank dates last (sheet order breaks ties).
  assert.deepEqual(data.rows.map(row => row.subscription_name), ['Gym', 'Rent', 'Broker fee', 'Rupee plan', 'Old', 'Expired', 'Gone', 'Locked sub']);
  assert.deepEqual(data.rows.map(row => row.next_payment_date), ['2026-09-30', '2026-10-01', '2026-11-05', '2027-01-15', '', '', '', '']);
});

test('rows carry native and quote money, monthly equivalents, due-in days, labels and allowed actions', () => {
  const runtime = appRuntime();
  const rows = Object.fromEntries(runtime.list({}).data.rows.map(row => [row.subscription_name, row]));
  assert.deepEqual(rows.Rent.amount, { native: 1000, currency: 'GBP', currency_symbol: '£', quote: 1000 });
  assert.equal(rows.Rent.account_name, 'Bank');
  assert.equal(rows.Rent.due_in_days, 1);
  assert.equal(rows.Rent.is_scheduled, true);
  assert.equal(rows.Rent.is_foreign, false);
  assert.equal(rows.Rent.category_label, 'Housing → Rent');
  assert.equal(rows.Rent.transactions_search, 'Landlord Ltd');
  assert.deepEqual(rows.Rent.allowed_actions, ['edit', 'pause', 'transactions', 'delete']);
  assert.equal(rows.Gym.frequency_short, 'wk');
  assert.equal(rows.Gym.frequency_label, 'Weekly');
  assert.ok(Math.abs(rows.Gym.monthly.quote - 7 * 52 / 12) < 1e-9);
  assert.equal(rows.Gym.due_in_days, 0);   // 2026-09-30 is a Wednesday (day_of_week 3)
  assert.equal(rows.Gym.transactions_search, 'Gym');
  const rupee = rows['Rupee plan'];
  assert.deepEqual([rupee.account_currency, rupee.currency_symbol, rupee.is_foreign, rupee.frequency_short], ['INR', '₹', true, 'yr']);
  assert.equal(rupee.monthly.native, 1000);
  assert.ok(Math.abs(rupee.monthly.quote - 1000 / 8400 * 80) < 1e-9);
  assert.ok(Math.abs(rupee.amount_monthly_quote - rupee.monthly.quote) < 1e-12);
  assert.equal(rupee.due_in_days, 107);   // 2027-01-15 from 2026-09-30 in Asia/Kolkata
  assert.equal(rows['Broker fee'].monthly.native, 10);
  assert.equal(rows['Broker fee'].monthly.quote, null);   // USD has no rate: never 1:1
  assert.equal(rows['Broker fee'].currency_symbol, 'USD ');
  assert.equal(rows.Old.is_scheduled, false);
  assert.equal(rows.Old.due_in_days, null);
  assert.deepEqual(rows.Old.allowed_actions, ['edit', 'resume', 'transactions', 'delete']);
  assert.equal(rows.Expired.schedule_status, 'expired');
  assert.equal(rows.Expired.is_scheduled, false);
  assert.deepEqual(rows.Gone.allowed_actions, ['restore', 'transactions']);
  assert.deepEqual(rows['Locked sub'].allowed_actions, ['transactions']);
  assert.equal(rows['Locked sub'].readonly, true);
  assert.equal(rows.Rent.readonly, false);
});

test('summary covers every subscription: scheduled count, total and the partial monthly estimate', () => {
  const runtime = appRuntime();
  const { summary } = runtime.list({ statuses: 'deleted' }).data;   // filters never change the summary
  assert.equal(summary.scheduled_count, 4);
  assert.equal(summary.total_count, 8);
  assert.equal(summary.missing_rate_count, 1);
  assert.equal(summary.partial, true);
  assert.ok(Math.abs(summary.est_monthly_quote - (1000 + 7 * 52 / 12 + 1000 / 8400 * 80)) < 1e-9);
  const inr = runtime.list({ quote_currency: 'INR' });
  assert.equal(inr.quote.symbol, '₹');
  assert.ok(Math.abs(inr.data.summary.est_monthly_quote - ((1000 + 7 * 52 / 12) / 80 * 8400 + 1000)) < 1e-6);
});

test('status, major, frequency and search filters run on the server; an empty status selection is explicit', () => {
  const runtime = appRuntime();
  const names = params => runtime.list(params).data.rows.map(row => row.subscription_name);
  assert.deepEqual(names({ statuses: 'inactive,locked' }), ['Old', 'Locked sub']);
  assert.deepEqual(names({ statuses: 'none' }), []);
  assert.deepEqual(names({ frequency: 'weekly' }), ['Gym']);
  assert.deepEqual(names({ major: 'food' }), ['Rupee plan']);
  assert.deepEqual(names({ search: 'rupee' }), ['Rupee plan']);
  assert.deepEqual(names({ search: 'LANDLORD' }), ['Rent']);
  const filtered = runtime.list({ statuses: 'active', search: 'x', frequency: 'monthly', major: 'housing' }).data;
  assert.equal(filtered.active_filter_count, 4);
  assert.deepEqual(filtered.filters, { statuses: ['active'], major: 'housing', frequency: 'monthly', search: 'x' });
  assert.equal(runtime.list({ statuses: 'active,inactive,deleted,locked' }).data.active_filter_count, 0);
  assert.deepEqual(runtime.list({}).data.facets.majors, [{ key: 'food', label: 'Food' }, { key: 'housing', label: 'Housing' }]);
  assert.deepEqual(runtime.list({}).data.facets.frequencies.map(item => item.value), ['weekly', 'monthly', 'quarterly', 'annual']);
});

test('sorting and paging are server-side; missing conversions sort last in both directions', () => {
  const runtime = appRuntime();
  const asc = runtime.list({ sort_col: 'amount_monthly_quote', sort_dir: 'asc' }).data.rows;
  const desc = runtime.list({ sort_col: 'amount_monthly_quote', sort_dir: 'desc' }).data.rows;
  assert.equal(asc.at(-1).subscription_name, 'Broker fee');
  assert.equal(desc.at(-1).subscription_name, 'Broker fee');
  assert.equal(asc[0].subscription_name, 'Rupee plan');
  assert.equal(desc[0].subscription_name, 'Rent');
  assert.deepEqual(runtime.list({ sort_col: 'subscription_name' }).data.rows.slice(0, 3).map(row => row.subscription_name), ['Broker fee', 'Expired', 'Gone']);
  const page = runtime.list({ sort_col: 'subscription_name', page_size: '3', page: '2' }).data;
  assert.deepEqual([page.page, page.pages, page.page_size, page.total], [2, 3, 3, 8]);
  assert.deepEqual(page.rows.map(row => row.subscription_name), ['Gym', 'Locked sub', 'Old']);
  assert.equal(runtime.list({ page_size: '3', page: '9' }).data.page, 3);
  for (const [params, error, field] of [
    [{ sort_col: 'amount_base' }, 'invalid_sort', 'sort_col'], [{ sort_dir: 'up' }, 'invalid_sort', 'sort_dir'],
    [{ page_size: '0' }, 'invalid_page', 'page_size'], [{ page: 'x' }, 'invalid_page', 'page'],
    [{ statuses: 'active,paused' }, 'invalid_filter', 'statuses'], [{ frequency: 'daily' }, 'invalid_filter', 'frequency'],
  ]) {
    const response = runtime.list(params);
    assert.equal(response.ok, false, JSON.stringify(params));
    assert.equal(response.error, error);
    assert.equal(response.field, field);
    assert.ok(typeof response.message === 'string' && response.message.length > 0);
  }
});

test('due-in days use each subscription timezone instead of the request zone', () => {
  const { ctx } = gasRuntime();
  const now = new Date('2026-09-24T23:30:00Z');
  assert.equal(ctx.vwSubDueInDays('2026-09-25', 'Europe/London', now), 0);
  assert.equal(ctx.vwSubDueInDays('2026-09-25', 'America/New_York', now), 1);
  assert.equal(ctx.vwSubDueInDays('2026-09-25', '', now), 0);
  assert.equal(ctx.vwSubDueInDays('2026-03-30', 'Europe/London', new Date('2026-03-28T12:00:00Z')), 2);
  assert.equal(ctx.vwSubDueInDays('bad', 'Europe/London', now), null);
  assert.ok(Math.abs(ctx.vwSubMonthlyAmount('12', 'weekly') - 52) < 1e-12);
  assert.equal(ctx.vwSubMonthlyAmount('12', 'quarterly'), 4);
  assert.ok(Number.isNaN(ctx.vwSubMonthlyAmount('12bad', 'monthly')));
  assert.ok(Number.isNaN(ctx.vwSubMonthlyAmount('12', 'daily')));
});

test('get_subscription_form_options lists eligible categories, active source accounts, frequencies and days', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_subscription_form_options' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.deepEqual(data.tx_types, [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }]);
  assert.deepEqual(data.frequencies[0], { value: 'weekly', label: 'Weekly', short: 'wk' });
  assert.deepEqual(data.days_of_week[6], { value: '7', label: 'Sunday' });
  assert.deepEqual([data.default_frequency, data.default_timezone, data.current], ['monthly', 'Europe/London', null]);
  const out = data.categories.find(type => type.tx_type === 'money-out');
  // Only eligible, non-deleted categories: groceries (not eligible) and bills/tv (deleted) are absent.
  assert.deepEqual(plain(out.majors), [{ key: 'housing', label: 'Housing', active: true, stored: false, minors: [
    { key: 'rent', label: 'Rent', active: true, stored: false }, { key: 'service', label: 'Service charge', active: false, stored: false }] }]);
  assert.deepEqual(data.categories.find(type => type.tx_type === 'money-in').majors.map(major => major.key), ['income']);
  assert.deepEqual(data.source_accounts.map(account => account.label), ['Bank (GBP)', 'Card (GBP)']);
  assert.deepEqual(data.source_accounts[0], { id: ID(11), account_name: 'Bank', currency: 'GBP', currency_symbol: '£', record_status: 'active', active: true, label: 'Bank (GBP)' });
});

test('edit options keep the stored category and current inactive account visible as non-selectable entries', () => {
  const runtime = appRuntime();
  const data = runtime.get({ action: 'get_subscription_form_options', id: ID(63) }).data;
  assert.deepEqual(data.current, { id: ID(63), row_num: 4, source_account: ID(12), tx_type: 'money-out', major_category: 'food', minor_category: 'groceries' });
  const food = data.categories.find(type => type.tx_type === 'money-out').majors.find(major => major.key === 'food');
  assert.deepEqual(plain(food), { key: 'food', label: 'Food', active: false, stored: true, minors: [{ key: 'groceries', label: 'Groceries', active: false, stored: true }] });
  assert.deepEqual(data.source_accounts.map(account => [account.label, account.active]), [['Bank (GBP)', true], ['Rupee (INR) — inactive', false], ['Card (GBP)', true]]);
  for (const [id, error] of [['nope', 'invalid_id'], [ID(99), 'invalid_row']]) {
    const response = runtime.get({ action: 'get_subscription_form_options', id });
    assert.equal(response.ok, false);
    assert.equal(response.error, error);
    assert.equal(response.field, 'id');
  }
});

test('views read each sheet once, cache by data_version and refresh after a subscription write', () => {
  const runtime = appRuntime();
  const sheetsByName = Object.fromEntries(runtime.sheets.map(sheet => [sheet.name, sheet]));
  const before = sheetsByName.subscription_master.reads;
  const txBefore = sheetsByName.transaction_master.reads;
  assert.equal(runtime.list({}).ok, true);
  assert.equal(sheetsByName.subscription_master.reads - before, 1);
  assert.equal(sheetsByName.transaction_master.reads - txBefore, 0);   // no ledger replay for names / currencies
  const cachedReads = sheetsByName.subscription_master.reads;
  assert.equal(runtime.list({}).data.rows.length, 8);
  assert.equal(sheetsByName.subscription_master.reads, cachedReads);
  runtime.ctx.vcBumpDataVersion();
  assert.equal(runtime.list({}).data.rows.length, 8);
  assert.equal(sheetsByName.subscription_master.reads, cachedReads + 1);
});

test('new view globals keep their file prefix', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../api/view-subscriptions.gs'), 'utf8');
  const names = [...source.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm)].map(match => match[1] || match[2]);
  assert.ok(names.length > 5);
  for (const name of names) assert.match(name, /^(_?vwSub|_VWSUB|viewSubscriptionsRegister$)/, name);
  assert.doesNotMatch(source, /\?\?|\?\./);
  assert.ok(Sheet);
});
