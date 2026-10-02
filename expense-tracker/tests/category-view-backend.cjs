// list_categories_view / get_category_form_options (api/view-categories.gs):
// server filter / sort / paging incl. the major / minor facets, account-type
// hint labels, allowed_actions, and the hint groups for the form checkboxes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, CATEGORIES, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const CATS = CATEGORIES.map(cat => (cat.minor_category_key === 'groceries'
  ? { ...cat, source_account_types: 'current, stocks-shares', description: 'Weekly SHOP', tag_keywords: 'tesco', is_subscription_eligible: true }
  : cat.minor_category_key === 'salary' ? { ...cat, target_account_types: 'current, unknown-hint' } : cat))
  .concat([{ id: ID(27), tx_type_key: 'money-out', major_category_key: 'bills', major_category_label: 'Bills', minor_category_key: 'tv', minor_category_label: 'TV', record_status: 'locked', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: true }]);

function appRuntime() {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime, { categories: CATS });
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  runtime.list = params => runtime.get({ action: 'list_categories_view', ...params });
  return runtime;
}
const keys = rows => rows.map(row => row.major_category_key + '/' + row.minor_category_key + (row.tx_type_key === 'money-in' ? '<' : ''));

test('list_categories_view returns every category in sheet order with badges, hint labels and actions', () => {
  const runtime = appRuntime();
  const response = runtime.list({});
  assert.equal(response.ok, true);
  const { data } = response;
  assert.equal(data.rows.length, 7);
  assert.deepEqual([data.count, data.total, data.total_all, data.page, data.page_size, data.pages], [7, 7, 7, 1, 'all', 1]);
  assert.deepEqual(data.sort, { col: 'row_num', dir: 'asc' });
  assert.deepEqual(data.rows.map(row => row.row_num), [2, 3, 4, 5, 6, 7, 8]);
  runtime.ctx.vmResetRequest();
  const raw = plain(runtime.ctx.listCategories());
  data.rows.forEach((row, index) => {
    assert.equal(row.id, raw[index].id);
    assert.equal(row._row, raw[index]._row);
    assert.equal(row.updated_at, raw[index].updated_at);
  });
  const groceries = data.rows[0];
  assert.deepEqual([groceries.type_badge, groceries.tx_type_label], ['out', 'Money Out']);
  assert.deepEqual(groceries.source_account_type_labels, ['Current', 'Stocks & shares']);
  assert.deepEqual(groceries.transactions_filter, { major: ['food'], minor: ['groceries'] });
  assert.deepEqual(groceries.allowed_actions, ['view', 'edit', 'transactions', 'delete']);
  const salary = data.rows[2];
  assert.equal(salary.type_badge, 'in');
  assert.deepEqual(salary.target_account_type_labels, ['Current', 'unknown-hint']);
  assert.deepEqual(data.rows.find(row => row.record_status === 'deleted').allowed_actions, ['view', 'transactions', 'restore']);
  const locked = data.rows.find(row => row.record_status === 'locked');
  assert.deepEqual(locked.allowed_actions, ['view', 'transactions']);
  assert.equal(locked.readonly, true);
  assert.equal(groceries.readonly, false);
});

test('facets list active majors by key and the minors of each major', () => {
  const { facets } = appRuntime().list({ statuses: 'deleted' }).data;   // facets ignore the applied filters
  assert.deepEqual(facets.types, [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }]);
  assert.deepEqual(facets.majors, [{ key: 'food', label: 'Food' }, { key: 'income', label: 'Income' }, { key: 'transfer', label: 'Transfer' }]);
  assert.deepEqual(plain(facets.minors_by_major), { food: [{ key: 'groceries', label: 'Groceries' }], income: [{ key: 'salary', label: 'Salary' }], transfer: [{ key: 'own', label: 'Own accounts' }] });
  assert.deepEqual(facets.statuses.map(item => item.value), ['active', 'inactive', 'deleted', 'locked']);
});

test('type, major, minor, search, mandatory, eligibility and status filters run on the server', () => {
  const runtime = appRuntime();
  const list = params => keys(runtime.list(params).data.rows);
  assert.deepEqual(list({ type: 'money-in' }), ['income/salary<', 'transfer/own<']);
  assert.deepEqual(list({ major: 'food' }), ['food/groceries', 'food/takeaway']);
  assert.deepEqual(list({ major: 'food', minor: 'takeaway' }), ['food/takeaway']);
  assert.deepEqual(list({ search: 'shop' }), ['food/groceries']);
  assert.deepEqual(list({ search: 'TESCO' }), ['food/groceries']);
  assert.deepEqual(list({ search: 'own acc' }), ['transfer/own', 'transfer/own<']);
  assert.deepEqual(list({ source_mandatory: 'no' }), ['income/salary<']);
  assert.deepEqual(list({ target_mandatory: 'yes', type: 'money-out' }), ['transfer/own']);
  assert.deepEqual(list({ subscription_eligible: 'yes' }), ['food/groceries', 'bills/tv']);
  assert.deepEqual(list({ statuses: 'deleted,locked' }), ['old/gone', 'bills/tv']);
  assert.deepEqual(list({ statuses: 'none' }), []);
  const filtered = runtime.list({ type: 'money-out', major: 'food', search: 'x', statuses: 'active' }).data;
  assert.equal(filtered.active_filter_count, 4);
  assert.deepEqual(filtered.filters, { type: 'money-out', major: 'food', minor: 'all', search: 'x', source_mandatory: 'all', target_mandatory: 'all', subscription_eligible: 'all', statuses: ['active'] });
  assert.equal(runtime.list({ statuses: 'active,inactive,deleted,locked' }).data.active_filter_count, 0);
});

test('sorting and paging are server-side and invalid params return field errors', () => {
  const runtime = appRuntime();
  assert.deepEqual(keys(runtime.list({ sort_col: 'major_category_label', sort_dir: 'desc' }).data.rows),
    ['transfer/own', 'transfer/own<', 'old/gone', 'income/salary<', 'food/groceries', 'food/takeaway', 'bills/tv']);
  const page = runtime.list({ page_size: '3', page: '3' }).data;
  assert.deepEqual([page.page, page.pages, page.count, page.rows.length], [3, 3, 7, 1]);
  assert.equal(runtime.list({ page_size: '3', page: '99' }).data.page, 3);
  for (const [params, error, field] of [
    [{ type: 'transfer' }, 'invalid_filter', 'type'], [{ source_mandatory: 'maybe' }, 'invalid_filter', 'source_mandatory'],
    [{ subscription_eligible: 'true' }, 'invalid_filter', 'subscription_eligible'], [{ statuses: 'archived' }, 'invalid_filter', 'statuses'],
    [{ sort_col: 'description' }, 'invalid_sort', 'sort_col'], [{ page_size: '501' }, 'invalid_page', 'page_size'],
  ]) {
    const response = runtime.list(params);
    assert.equal(response.ok, false, JSON.stringify(params));
    assert.deepEqual([response.error, response.field], [error, field]);
    assert.ok(response.message.length > 0);
  }
});

test('get_category_form_options groups account-type hints like the old client and exposes status choices', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_category_form_options' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.deepEqual(data.types, [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }]);
  assert.deepEqual(data.statuses_for_add, [{ value: 'active', label: 'Active' }]);
  assert.deepEqual(data.statuses_for_edit.map(item => item.value), ['active', 'inactive', 'deleted', 'locked']);
  assert.deepEqual(plain(data.account_type_hint_groups), [
    { type: 'asset', label: 'Asset', hints: [{ value: 'current', label: 'Current' }] },
    { type: 'liability', label: 'Liability', hints: [{ value: 'credit-card', label: 'Credit card' }] },
    { type: 'investment', label: 'Investment', hints: [{ value: 'stocks-shares', label: 'Stocks & shares' }, { value: 'investment', label: 'Investment' }] },
  ]);
  // Parity with the retired client _acctTypeGroups over the old schema payloads.
  runtime.ctx.vmResetRequest();
  const accountSchema = plain(runtime.ctx.getAccountSchemaForClient());
  const hints = plain(runtime.ctx.getCategoryAccountTypeHints());
  const legacy = accountSchema.types.map(type => ({
    label: type.label,
    keys: hints.filter(hint => hint.value === type.value || (accountSchema.subtypes_by_type[type.value] || []).includes(hint.value)).map(hint => hint.value),
  })).filter(group => group.keys.length > 0);
  assert.deepEqual(data.account_type_hint_groups.map(group => ({ label: group.label, keys: group.hints.map(hint => hint.value) })), legacy);
});

test('hint groups use the configured family labels and subtype keys without catalog fallbacks', () => {
  const { ctx } = gasRuntime();
  const result = plain(ctx.vwCatHintGroups([{ account_type_key: 'custom-family', account_type_label: '<Custom>', account_subtype_key: 'custom-key', account_subtype_label: 'Configured label' }]));
  assert.deepEqual(result.groups, [{ type: 'custom-family', label: '<Custom>', hints: [{ value: 'custom-key', label: 'Configured label' }] }]);
  assert.deepEqual(result.labels, { 'custom-key': 'Configured label' });
  assert.deepEqual(plain(ctx.vwCatHintGroups([])), { groups: [], labels: {} });
});

test('new view globals keep their file prefix', () => {
  const source = fs.readFileSync(path.join(__dirname, '../api/view-categories.gs'), 'utf8');
  const names = [...source.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm)].map(match => match[1] || match[2]);
  assert.ok(names.length > 5);
  for (const name of names) assert.match(name, /^(_?vwCat|_VWCAT|viewCategoriesRegister$)/, name);
  assert.doesNotMatch(source, /\?\?|\?\./);
});
