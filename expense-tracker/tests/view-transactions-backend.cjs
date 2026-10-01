// Phase 2–3 transactions view (api/view-transactions.gs): server list with
// filters / sort / paging / facets / totals, detail, form options (shared CSV
// hint rule), copy / subscribe prefill, and the compact export with its
// lossy-transfer guards (ported from app/core/utils.js exportData and the
// frontend-final-review / frontend-regressions export assertions).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sheet, gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNTS, CATEGORIES, TRANSACTIONS, seedViewFixture } = require('./support/view-fixture.cjs');

const TODAY = '2026-09-30';
const plain = value => JSON.parse(JSON.stringify(value));

const EXTRA_CATEGORIES = [
  { id: ID(27), tx_type_key: 'money-out', major_category_key: 'bills', major_category_label: 'Bills', minor_category_key: 'phone', minor_category_label: 'Phone', record_status: 'active',
    source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: true, source_account_types: 'current' },
  { id: ID(28), tx_type_key: 'money-out', major_category_key: 'debt', major_category_label: 'Debt', minor_category_key: 'card', minor_category_label: 'Card payment', record_status: 'active',
    source_account_mandatory: true, target_account_mandatory: true, is_subscription_eligible: false, source_account_types: 'asset', target_account_types: ' CREDIT-CARD ' },
];

function runtime({ transactions = TRANSACTIONS, accounts = ACCOUNTS, categories = CATEGORIES.concat(EXTRA_CATEGORIES), subscriptions = [] } = {}) {
  const rt = gasRuntime({ properties: { PIN_SECRET: '1234' } });
  rt.tabs = seedViewFixture(rt, { transactions, accounts, categories });
  const columns = rt.ctx.getSubscriptionSheetColumns();
  subscriptions.forEach(record => rt.tabs.subscriptions.rows.push(columns.map(column => (record[column] === undefined ? '' : record[column]))));
  rt.get = params => JSON.parse(rt.ctx.doGet({ parameter: { pin: '1234', today: TODAY, ...params } }).getContent());
  return rt;
}

const list = (rt, params = {}) => rt.get({ action: 'list_transactions_view', ...params });
const ids = response => response.data.rows.map(row => row.id);

test('actions register through viewTransactionsRegister; list and detail are cached, export is not', () => {
  const rt = runtime();
  const actions = rt.ctx.grGetActions();
  for (const action of ['list_transactions_view', 'get_transaction', 'get_transaction_form_options', 'get_transaction_prefill', 'export_transactions']) {
    assert.equal(typeof actions[action].handler, 'function', action);
  }
  assert.equal(actions.list_transactions_view.cache, true);
  assert.equal(actions.export_transactions.cache, false);
  const first = list(rt);
  const reads = rt.tabs.transactions.reads;
  assert.deepEqual(list(rt), first);
  assert.equal(rt.tabs.transactions.reads, reads, 'a cache hit reads no sheet');
});

test('no filters returns every leg (deleted rows, both transfer legs, future-dated rows) newest first', () => {
  const rt = runtime();
  const response = list(rt);
  assert.equal(response.ok, true);
  const data = response.data;
  assert.equal(data.total, TRANSACTIONS.length);
  assert.deepEqual([data.page, data.pages, data.page_size], [1, 1, 50]);
  assert.deepEqual(data.sort, { col: 'tx_date_local', dir: 'desc' });
  assert.deepEqual(data.range, { key: 'all', label: 'All time', from: null, to: null });
  assert.equal(data.rows[0].id, ID(40), 'future-dated row is part of "all"');
  assert.deepEqual(data.warn_rows, []);
  // Each sheet read once for the whole request.
  assert.equal(rt.tabs.transactions.reads, 1);
  assert.equal(rt.tabs.accounts.reads, 1);
});

test('rows are shaped for the table: labels, money in native + quote, transfer counter leg, actions', () => {
  const rt = runtime();
  const rows = Object.fromEntries(list(rt).data.rows.map(row => [row.id, row]));
  const parent = rows[ID(35)], child = rows[ID(36)];
  assert.equal(parent.account_label, 'Bank → Card');
  assert.equal(child.account_label, 'Bank → Card', 'money-in leg shows the source first');
  assert.equal(parent.counter_leg.id, ID(36));
  assert.equal(parent.counter_leg.account_name, 'Card');
  assert.equal(child.counter_leg.id, ID(35));
  assert.equal(parent.is_transfer_leg, true);
  assert.deepEqual(plain(parent.category), { major_key: 'transfer', minor_key: 'own', major_label: 'Transfer', minor_label: 'Own accounts', label: 'Transfer → Own accounts' });
  assert.deepEqual(plain(parent.amount), { native: 300, currency: 'GBP', currency_symbol: '£', quote: 300, native_display: '£300.00', quote_display: '£300.00', show_quote: false, missing_rate: false });
  const rupee = rows[ID(37)];
  assert.equal(rupee.amount.native_display, '₹1,050.00');
  assert.equal(rupee.amount.quote_display, '£10.00');
  assert.equal(rupee.amount.show_quote, true);
  const brokerage = rows[ID(38)];
  assert.equal(brokerage.amount.quote, null, 'a missing rate is never converted 1:1');
  assert.equal(brokerage.amount.missing_rate, true);
  assert.equal(brokerage.amount.native_display, 'USD 25.00');
  assert.deepEqual([parent.tx_type_label, parent.badge, child.badge], ['Money Out', 'out', 'in']);
  assert.deepEqual(Array.from(rows[ID(34)].allowed_actions), ['view', 'restore']);
  assert.equal(rows[ID(34)].readonly, true);
  assert.deepEqual(Array.from(rows[ID(31)].allowed_actions), ['view', 'edit', 'copy', 'delete']);
  assert.equal(rows[ID(31)].row_num, 2);
  assert.ok('updated_at' in rows[ID(31)]);
});

test('locked rows are view-only; a deleted historical child never replaces the live transfer leg', () => {
  const t = TRANSACTIONS.concat([
    { ...TRANSACTIONS[5], id: ID(41), record_status: 'deleted', account_id: ID(12) },
    { ...TRANSACTIONS[0], id: ID(42), record_status: 'locked', tx_date_local: '2026-07-29 09:00:00' },
  ]);
  const rt = runtime({ transactions: t });
  const rows = Object.fromEntries(list(rt).data.rows.map(row => [row.id, row]));
  assert.equal(rows[ID(35)].counter_leg.id, ID(36));
  assert.equal(rows[ID(41)].counter_leg.id, ID(35), 'the deleted child still names its parent');
  assert.deepEqual(Array.from(rows[ID(42)].allowed_actions), ['view']);
});

test('the list carries no In/Out/Net totals; currencies without a rate are reported as a warning', () => {
  assert.equal(list(runtime()).data.totals, undefined);
  const response = list(runtime());
  assert.ok(response.warnings.some(w => w.code === 'missing_rate' && w.currencies.includes('USD')));
});

test('date ranges use ldg periods on the recorded wall date; custom ranges are inclusive', () => {
  const rt = runtime();
  const last30 = list(rt, { range: 'last_30' });
  assert.deepEqual(plain(last30.data.range), { key: 'last_30', label: 'Last 30 days', from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(ids(last30).sort(), [ID(34), ID(35), ID(36), ID(37), ID(38), ID(39)].sort());
  // 18:00 in Asia/Kolkata on 20 Sep is still the 20th (recorded date), whatever the viewer tz.
  assert.deepEqual(ids(list(rt, { range: 'custom', from: '2026-09-20', to: '2026-09-20', tz: 'America/Los_Angeles' })), [ID(37)]);
  assert.deepEqual(ids(list(rt, { range: 'custom', from: '2026-09-29' })), [ID(39)], 'blank custom end = today');
  assert.deepEqual(ids(list(rt, { range: 'last_month' })).sort(), [ID(32)]);
  for (const params of [{ range: 'bogus' }, { range: 'custom', from: '2026-09-21', to: '2026-09-20' }, { range: 'custom', from: '2026-02-30' }, { range: 'custom', from: '2026-10-01' }]) {
    const response = list(rt, params);
    assert.equal(response.error, 'invalid_period', JSON.stringify(params));
    assert.equal(response.field, 'range');
    assert.ok(response.message.length > 0);
  }
});

test('filters: type, account, account type, category, location, tag, counterparty and search', () => {
  const t = TRANSACTIONS.map(tx => tx.id === ID(39) ? { ...tx, user_location_city: 'London', user_location_country: 'UK', user_location_area: 'Soho', tx_tags: 'work;Travel', counterparty_name: 'Tesco Metro', description: 'Lunch' } : tx);
  const rt = runtime({ transactions: t });
  assert.deepEqual(ids(list(rt, { types: 'money-in' })).sort(), [ID(31), ID(36), ID(38)].sort());
  assert.deepEqual(ids(list(rt, { account_ids: ID(13).toUpperCase() })).sort(), [ID(36), ID(39)].sort());
  assert.deepEqual(ids(list(rt, { account_types: 'liability,investment' })).sort(), [ID(36), ID(38), ID(39)].sort());
  assert.deepEqual(ids(list(rt, { major: 'transfer', minor: 'own' })).sort(), [ID(35), ID(36)].sort());
  assert.deepEqual(ids(list(rt, { user_location_city: 'lond', user_location_country: 'uk', user_location_area: 'SO' })), [ID(39)]);
  assert.deepEqual(ids(list(rt, { tag: 'trav' })), [ID(39)]);
  assert.deepEqual(ids(list(rt, { counterparty: ' tesco metro ' })), [ID(39)]);
  assert.deepEqual(ids(list(rt, { counterparty: 'tesco' })), [], 'counterparty is an exact match (insight drill)');
  assert.deepEqual(ids(list(rt, { search: 'LUNCH' })), [ID(39)]);
  assert.deepEqual(ids(list(rt, { search: 'rupee' })), [ID(37)], 'search covers the account name');
  const combined = list(rt, { range: 'last_30', types: 'money-out', search: 'bank' });
  assert.deepEqual(ids(combined).sort(), [ID(34), ID(35)].sort());
  assert.equal(combined.data.active_filter_count, 2, 'last_30 is the default range');
  assert.equal(list(rt, { range: 'last_30' }).data.active_filter_count, 0);
});

test('sort by date / type / account / amount / category with blanks last and a stable tie-break; paging clamps', () => {
  const rt = runtime();
  const asc = ids(list(rt, { sort_col: 'tx_date_local', sort_dir: 'asc' }));
  assert.equal(asc[0], ID(33));
  // 35 and 36 share a timestamp: sheet order breaks the tie in both directions.
  assert.ok(asc.indexOf(ID(35)) < asc.indexOf(ID(36)));
  const desc = ids(list(rt));
  assert.ok(desc.indexOf(ID(35)) < desc.indexOf(ID(36)));
  const byAmount = list(rt, { sort_col: 'amount', sort_dir: 'desc' }).data.rows;
  assert.equal(byAmount[0].id, ID(31));
  assert.equal(byAmount.at(-1).id, ID(38), 'no quote (missing rate) sorts last');
  assert.equal(list(rt, { sort_col: 'amount', sort_dir: 'asc' }).data.rows.at(-1).id, ID(38));
  const byAccount = list(rt, { sort_col: 'account', sort_dir: 'asc' }).data.rows.map(row => row.account_label);
  assert.deepEqual(byAccount, byAccount.slice().sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  assert.equal(list(rt, { sort_col: 'major_category', sort_dir: 'asc' }).data.sort.col, 'category', 'legacy column names are accepted');
  assert.equal(list(rt, { sort_col: 'category', sort_dir: 'asc' }).data.rows[0].category.label, 'Food → Groceries');
  assert.equal(list(rt, { sort_col: 'tx_type', sort_dir: 'asc' }).data.rows[0].tx_type, 'money-in');
  const page2 = list(rt, { page_size: 10, page: 1 });
  assert.equal(page2.data.pages, 1);
  const small = runtime({ transactions: Array.from({ length: 23 }, (_, n) => ({ ...TRANSACTIONS[0], id: ID(100 + n), tx_date_local: '2026-07-' + String(n + 1).padStart(2, '0') + ' 09:00:00' })) });
  const second = list(small, { page_size: 10, page: 2 });
  assert.deepEqual([second.data.total, second.data.pages, second.data.page, second.data.rows.length], [23, 3, 2, 10]);
  assert.equal(second.data.rows[0].id, ID(112));
  const clamped = list(small, { page_size: 10, page: 9 });
  assert.deepEqual([clamped.data.page, clamped.data.rows.length], [3, 3]);
  const seen = new Set();
  for (const page of [1, 2, 3]) ids(list(small, { page_size: 10, page })).forEach(id => { assert.ok(!seen.has(id)); seen.add(id); });
  assert.equal(seen.size, 23);
  for (const [params, error] of [[{ sort_col: 'nope' }, 'invalid_sort'], [{ sort_dir: 'up' }, 'invalid_sort'], [{ page: '0' }, 'invalid_page'], [{ page: '1.5' }, 'invalid_page'], [{ page_size: '7' }, 'invalid_page_size']]) {
    const response = list(rt, params);
    assert.equal(response.error, error, JSON.stringify(params));
    assert.ok(response.message.length > 0);
  }
});

test('malformed rows are reported in warn_rows (independent of the date filter) and never listed', () => {
  const t = TRANSACTIONS.concat([
    { ...TRANSACTIONS[0], id: ID(50), tx_date_local: '2026-09-25 10:45' },      // no seconds
    { ...TRANSACTIONS[0], id: '', tx_date_local: '2026-09-25 10:45:00' },
    { ...TRANSACTIONS[0], id: ID(51), tx_type: 'transfer' },
  ]);
  const rt = runtime({ transactions: t });
  const response = list(rt, { range: 'last_30' });
  assert.deepEqual(response.data.warn_rows.map(row => row.reason).sort(), ['invalid_date', 'missing_id']);
  assert.ok(!ids(response).includes(ID(50)));
  assert.deepEqual(list(rt).data.warn_rows.map(row => row.reason).sort(), ['invalid_date', 'invalid_type', 'missing_id']);
});

test('get_transaction_facets comes from the full dataset; list pages no longer carry facets', () => {
  const t = TRANSACTIONS.map(tx => tx.id === ID(32) ? { ...tx, tx_tags: 'work; home', user_location_city: 'Leeds' } : tx.id === ID(34) ? { ...tx, tx_tags: 'deleted-only' } : tx);
  const rt = runtime({ transactions: t });
  assert.equal(Object.prototype.hasOwnProperty.call(list(rt, { range: 'last_30' }).data, 'facets'), false);
  const response = rt.get({ action: 'get_transaction_facets' });
  assert.equal(response.ok, true);
  const facets = response.data;
  assert.deepEqual(plain(facets.types), [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }]);
  assert.deepEqual(plain(facets.account_types), [{ value: 'asset', label: 'Asset', count: 3 }, { value: 'liability', label: 'Liability', count: 1 }, { value: 'investment', label: 'Investment', count: 1 }]);
  assert.deepEqual(Array.from(facets.accounts_by_type.asset), [ID(11), ID(12), ID(15)]);
  assert.deepEqual(facets.accounts.map(a => a.name), ['Bank', 'Brokerage', 'Card', 'Closed', 'Rupee']);
  assert.deepEqual(plain(facets.minors_by_major.food), [{ key: 'groceries', label: 'Groceries' }, { key: 'takeaway', label: 'Takeaway' }]);
  assert.ok(facets.majors.some(m => m.key === 'bills' && m.label === 'Bills'));
  assert.deepEqual(Array.from(facets.tags), ['home', 'work'], 'deleted rows do not contribute suggestions');
  assert.deepEqual(Array.from(facets.cities), ['Leeds']);
  assert.deepEqual(facets.ranges.map(r => r.value), ['last_30', 'this_month', 'last_month', 'last_3', 'last_6', 'last_12', 'ytd', 'all', 'custom']);
  assert.deepEqual(Array.from(facets.page_sizes), [10, 25, 50]);
});

test('get_transaction returns the full record with its counter leg', () => {
  const t = TRANSACTIONS.map(tx => tx.id === ID(36) ? { ...tx, tx_tags: 'a;b', beneficiaries: 'Alice:60;Bob:40', user_location_latitude: 51.5, user_location_longitude: -0.12, description: 'Move', sync_status: 'in-sync' } : tx);
  const rt = runtime({ transactions: t });
  const response = rt.get({ action: 'get_transaction', id: ID(36).toUpperCase() });
  assert.equal(response.ok, true);
  const tx = response.data.transaction;
  assert.equal(tx.id, ID(36));
  assert.equal(tx.parent_tx_id, ID(35));
  assert.equal(tx.counter_leg.account_name, 'Bank');
  assert.equal(tx.tx_amount_local, '300');
  assert.equal(tx.tx_date_input, '2026-09-12T10:00');
  assert.equal(tx.tags_display, 'a, b');
  assert.deepEqual(plain(tx.beneficiaries_list), [{ name: 'Alice', pct: '60' }, { name: 'Bob', pct: '40' }]);
  assert.deepEqual(plain(tx.location), { area: '', city: '', country: '', latitude: '51.5', longitude: '-0.12' });
  const missing = rt.get({ action: 'get_transaction', id: ID(99) });
  assert.deepEqual([missing.ok, missing.error, missing.field], [false, 'transaction_not_found', 'id']);
  assert.ok(missing.message.length > 0);
});

test('form options: category tree with per-leg eligible accounts from the shared CSV hint helper', () => {
  const rt = runtime();
  const response = rt.get({ action: 'get_transaction_form_options' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.equal(data.mode, 'create');
  assert.equal(data.edit, null);
  const active = ACCOUNTS.filter(a => a.record_status === 'active');
  assert.deepEqual(data.accounts.map(a => a.id), active.map(a => a.id));
  assert.deepEqual(plain(data.accounts[0]), { id: ID(11), name: 'Bank', currency: 'GBP', currency_symbol: '£', record_status: 'active', label: 'Bank (GBP)' });
  const out = data.categories['money-out'].majors;
  const debt = out.find(m => m.key === 'debt').minors[0];
  const hint = hintText => Array.from(rt.ctx.txAccountsForCategoryHint(active, hintText), a => a.id);
  const eligible = leg => Array.from(data.account_sets[leg.account_set]);
  assert.deepEqual(eligible(debt.source), hint('asset'));
  assert.deepEqual(eligible(debt.target), hint(' CREDIT-CARD '));
  assert.deepEqual(eligible(debt.target), [ID(13)]);
  assert.equal(debt.target.account_set, 'credit-card', 'hints are normalised into shared account sets');
  assert.deepEqual([debt.source.mandatory, debt.target.mandatory, debt.is_transfer], [true, true, true]);
  const phone = out.find(m => m.key === 'bills').minors[0];
  assert.deepEqual(eligible(phone.source), [ID(11)], 'sub_type hint "current"');
  assert.deepEqual(eligible(phone.target), [ID(11), ID(13)], 'a blank hint keeps every active account');
  const food = out.find(m => m.key === 'food');
  assert.equal(food.active, true);
  assert.deepEqual(food.minors.map(m => [m.key, m.active]), [['groceries', true], ['takeaway', false]]);
  assert.equal(out.find(m => m.key === 'old').active, false, 'deleted categories are listed as archived');
  assert.deepEqual(plain(data.uncategorised['money-out'].source), { mandatory: true, account_set: '' });
  assert.deepEqual(eligible(data.uncategorised['money-out'].source), [ID(11), ID(13)]);
  assert.equal(data.uncategorised['money-in'].source.mandatory, false);
  assert.ok(Array.isArray(data.datalists.tags));
  assert.equal(rt.get({ action: 'get_transaction_form_options', mode: 'bulk' }).error, 'invalid_form_mode');
});

test('edit options keep the row on its closed account (never a deleted one) and resolve legacy category labels', () => {
  const t = TRANSACTIONS.concat([
    { ...TRANSACTIONS[0], id: ID(60), account_id: ID(15), tx_type: 'money-out', major_category: 'Food', minor_category: 'Groceries' },
  ]);
  const rt = runtime({ transactions: t });
  const edit = rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(37) }).data;
  assert.equal(edit.edit.keep_account_id, ID(12));
  assert.equal(edit.edit.account_field, 'source');
  assert.deepEqual(plain(edit.accounts[0]), { id: ID(12), name: 'Rupee', currency: 'INR', currency_symbol: '₹', record_status: 'inactive', label: 'Rupee (INR) · inactive' });
  assert.equal(edit.accounts.filter(a => a.id === ID(12)).length, 1);
  assert.equal(edit.edit.record.id, ID(37));
  const legacy = rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(60) }).data;
  assert.equal(legacy.edit.keep_account_id, null, 'a deleted account is never offered');
  assert.ok(!legacy.accounts.some(a => a.id === ID(15)));
  assert.deepEqual(plain(legacy.edit.category), { major_key: 'food', minor_key: 'groceries' });
  assert.equal(legacy.edit.record.category.label, 'Food → Groceries');
  const transfer = rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(36) }).data;
  assert.equal(transfer.edit.account_field, 'target');
  assert.equal(transfer.edit.counter_leg_account_name, 'Bank');
  assert.equal(rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(34) }).error, 'transaction_deleted');
  assert.equal(rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(38) }).ok, true, 'an active row on a locked account can be edited');
  assert.equal(rt.get({ action: 'get_transaction_form_options', mode: 'edit', id: ID(98) }).error, 'transaction_not_found');
});

test('copy prefill rebuilds both legs of a transfer from either leg', () => {
  const t = TRANSACTIONS.map(tx => tx.id === ID(36) ? { ...tx, tx_amount_local: '15.250000000001' } : tx.id === ID(35) ? { ...tx, tx_amount_local: '12.500000000001' } : tx);
  const rt = runtime({ transactions: t });
  const fromChild = rt.get({ action: 'get_transaction_prefill', id: ID(36), mode: 'copy' }).data.prefill;
  assert.deepEqual([fromChild.source_account, fromChild.target_account, fromChild.source_amount, fromChild.target_amount], [ID(11), ID(13), '12.500000000001', '15.250000000001']);
  const fromParent = rt.get({ action: 'get_transaction_prefill', id: ID(35), mode: 'copy' }).data.prefill;
  assert.deepEqual([fromParent.source_account, fromParent.target_account, fromParent.source_amount, fromParent.target_amount], [ID(11), ID(13), '12.500000000001', '15.250000000001']);
  const single = rt.get({ action: 'get_transaction_prefill', id: ID(31) }).data;
  assert.equal(single.mode, 'copy');
  assert.deepEqual([single.prefill.source_account, single.prefill.target_account, single.prefill.source_amount, single.prefill.major_category], ['', ID(11), '2500', 'income']);
  assert.equal(rt.get({ action: 'get_transaction_prefill', id: ID(31), mode: 'x' }).error, 'invalid_prefill_mode');
});

test('subscribe: offered only for eligible categories that no live subscription already tracks', () => {
  const merchant = { ...TRANSACTIONS[1], id: ID(70), major_category: 'bills', minor_category: 'phone', counterparty_name: 'Merchant', tx_tags: 'tagged-transaction' };
  const sub = { id: ID(80), subscription_name: 'Phone', counterparty_name: ' merchant ', source_account: ID(11).toUpperCase(), tx_type: 'money-out', major_category: 'bills', minor_category: 'phone',
    subscription_amount_local: '10', frequency: 'monthly', day_of_month: 1, record_status: 'active', subscription_timezone_local: 'Europe/London' };
  const check = (subscriptions, expected) => {
    const rt = runtime({ transactions: TRANSACTIONS.concat([merchant]), subscriptions });
    const row = list(rt).data.rows.find(r => r.id === ID(70));
    assert.equal(row.allowed_actions.includes('subscribe'), !expected, JSON.stringify(subscriptions));
    const prefill = rt.get({ action: 'get_transaction_prefill', id: ID(70), mode: 'subscribe' });
    if (expected) {
      assert.deepEqual([prefill.ok, prefill.error, prefill.message], [false, 'already_subscribed', 'Already tracked as a subscription.']);
    } else {
      assert.equal(prefill.ok, true);
      assert.deepEqual(plain(prefill.data.prefill), { name: 'Merchant', counterparty_name: 'Merchant', amount: 45.5, source_account: ID(11), tx_type: 'money-out', major_category: 'bills', minor_category: 'phone', tx_tags: 'tagged-transaction' });
    }
  };
  check([sub], true);
  check([{ ...sub, record_status: 'deleted' }], false);
  check([{ ...sub, source_account: ID(13) }], false);
  check([{ ...sub, minor_category: 'different' }], false);
  check([{ ...sub, tx_type: '', major_category: '', minor_category: '', record_status: 'inactive' }], true);
  check([], false);
  const rt = runtime();
  assert.equal(list(rt).data.rows.find(r => r.id === ID(32)).allowed_actions.includes('subscribe'), false, 'groceries is not subscription-eligible');
  assert.equal(rt.get({ action: 'get_transaction_prefill', id: ID(32), mode: 'subscribe' }).error, 'not_subscription_eligible');
});

const exportOf = (rt, params = {}) => rt.get({ action: 'export_transactions', ...params });

test('export: compact import rows; a transfer exports once as its parent even when only the child matches', () => {
  const rt = runtime();
  const all = exportOf(rt);
  assert.equal(all.ok, true);
  assert.equal(all.data.filename, 'transaction_master');
  assert.ok(all.data.columns.includes('record_status'));
  assert.equal(all.data.legs, 10);
  assert.equal(all.data.rows.length, 9, 'the two transfer legs become one row');
  const byId = Object.fromEntries(all.data.rows.map(row => [row.id, row]));
  // Standalone money-in: amount on the populated target account.
  assert.deepEqual([byId[ID(31)].source_account, byId[ID(31)].target_account, byId[ID(31)].source_amount_local, byId[ID(31)].target_amount_local], ['', 'Bank', '', '2500']);
  assert.deepEqual([byId[ID(32)].source_account, byId[ID(32)].target_account, byId[ID(32)].source_amount_local, byId[ID(32)].target_amount_local], ['Bank', '', '45.5', '']);
  const transfer = byId[ID(35)];
  assert.deepEqual([transfer.tx_type, transfer.source_account, transfer.target_account, transfer.source_amount_local, transfer.target_amount_local, transfer.tx_date_local],
    ['money-out', 'Bank', 'Card', '300', '300', '2026-09-12 10:00:00']);
  assert.equal(byId[ID(36)], undefined);
  assert.equal(byId[ID(34)].record_status, 'deleted', 'lifecycle is preserved');
  // Only the child leg matches: the parent row is still what is exported, once.
  const childOnly = exportOf(rt, { account_ids: ID(13), types: 'money-in' });
  assert.deepEqual(childOnly.data.rows.map(row => row.id), [ID(35)]);
  assert.equal(childOnly.data.rows[0].target_amount_local, '300');
  // Export honours the list filters (and ignores paging params).
  assert.deepEqual(exportOf(rt, { range: 'last_month', page_size: '10' }).data.rows.map(row => row.id), [ID(32)]);
});

test('export keeps the exact amount text and uses UUIDs when an account name is not unique', () => {
  const accounts = ACCOUNTS.concat([{ ...ACCOUNTS[0], id: ID(16), account_name: 'Card' }]);
  const t = TRANSACTIONS.map(tx => tx.id === ID(31) ? { ...tx, tx_amount_local: '123456789.123456789' } : tx);
  const rows = Object.fromEntries(exportOf(runtime({ accounts, transactions: t })).data.rows.map(row => [row.id, row]));
  assert.equal(rows[ID(31)].target_amount_local, '123456789.123456789');
  assert.equal(rows[ID(35)].target_account, ID(13), 'duplicate name → UUID so the import cannot pick the wrong account');
  assert.equal(rows[ID(35)].source_account, 'Bank');
});

test('export refuses transfers whose legs cannot share one import row', () => {
  const parent = { ...TRANSACTIONS[4], record_status: 'inactive' };
  const child = { ...TRANSACTIONS[5], record_status: 'inactive' };
  const others = TRANSACTIONS.filter(tx => tx.id !== parent.id && tx.id !== child.id);
  const refuse = (transactions, params = {}) => {
    const response = exportOf(runtime({ transactions }), params);
    assert.equal(response.ok, false, JSON.stringify(params));
    assert.equal(response.error, 'transfer_export_lossy');
    assert.match(response.message, /Export transaction_master directly/);
    return response;
  };
  // Baseline: matching lifecycle and shared fields export fine (status kept).
  const ok = exportOf(runtime({ transactions: others.concat([parent, child]) }));
  assert.equal(ok.data.rows.find(row => row.id === parent.id).record_status, 'inactive');
  // A deleted child next to a live parent.
  refuse(others.concat([parent, { ...child, record_status: 'deleted' }]));
  // A leg edited independently.
  refuse(others.concat([parent, { ...child, description: 'Edited independently' }]));
  refuse(others.concat([parent, child, { ...child, id: ID(90), record_status: 'deleted' }]), { account_ids: ID(11) });
  // An old deleted child hidden by a live one is still a lossy transfer.
  const lossy = refuse(others.concat([parent, child, { ...child, id: ID(90), record_status: 'deleted' }]));
  assert.ok(lossy.details.id);
  // A child whose parent is missing.
  refuse(others.concat([{ ...child, parent_tx_id: ID(91) }]));
});
