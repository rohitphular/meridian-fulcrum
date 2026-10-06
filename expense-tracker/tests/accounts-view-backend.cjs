// Phase 2–3 (P2-B accounts, P3-B): list_accounts_view, get_account_form_options,
// list_rates_view and list_account_types_view — server filter / sort / paging,
// summary placeholders, row flags. Balances come from listAccounts
// (_buildAccountNetMap); the summary cards carry no values for now.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNT_TYPES, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));

function appRuntime(overrides) {
  const runtime = gasRuntime({ properties: { MERIDIAN_FULCRUM_PIN: '1234' } });
  runtime.tabs = seedViewFixture(runtime, overrides);
  runtime.get = params => JSON.parse(runtime.ctx.doGet({ parameter: { pin: '1234', ...params } }).getContent());
  return runtime;
}

const rowsOf = data => data.groups.flatMap(group => group.rows);
const names = data => rowsOf(data).map(row => row.account_name);

// Fixture balances (GBP 80 / INR 8400 per XAU; no USD rate):
// Bank 3142.5 GBP, Rupee 9450 INR = 90 GBP (inactive), Card +40 GBP (liability in
// credit), Brokerage 525 USD (locked, no rate), Closed 999 GBP (deleted).

test('list_accounts_view returns every account by default with native and quote balances', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'list_accounts_view', today: '2026-09-30' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.quote, { currency: 'GBP', symbol: '£', rate_available: true });
  assert.deepEqual(response.warnings, [{ code: 'missing_rate', currencies: ['USD'] }]);
  const data = response.data;
  assert.deepEqual([data.total, data.page, data.pages, data.page_size, data.active_filter_count], [5, 1, 1, 5, 0]);
  assert.deepEqual(data.groups.map(group => [group.type, group.label, group.is_liability, group.count]),
    [['asset', 'Asset', false, 3], ['liability', 'Liability', true, 1], ['investment', 'Investment', false, 1]]);
  assert.deepEqual(names(data), ['Bank', 'Rupee', 'Closed', 'Card', 'Brokerage']);
  const byName = Object.fromEntries(rowsOf(data).map(row => [row.account_name, row]));
  assert.deepEqual(plain(byName.Rupee.balance), { native: 9450, currency: 'INR', currency_symbol: '₹', quote: 90, display_sign: 'positive', is_foreign: true });
  assert.deepEqual(plain(byName.Brokerage.balance), { native: 525, currency: 'USD', currency_symbol: 'USD ', quote: null, display_sign: 'positive', is_foreign: true });
  assert.equal(byName.Bank.balance.is_foreign, false);
  // Liabilities are stored negative: owed at or below zero, credit above zero.
  assert.equal(byName.Card.balance.display_sign, 'credit');
  assert.equal(byName.Card.opening.display_sign, 'owed');
  assert.deepEqual([byName.Bank.sub_type_label, byName.Bank.type_label, byName.Bank.detail_sheet, byName.Bank.detail_sheet_label, byName.Bank.is_liquid],
    ['Current', 'Asset', 'account_deposit', 'Deposit', true]);
  assert.equal(byName.Card.is_liquid, false);
  assert.equal(byName.Bank.id, ID(11));
  assert.equal(byName.Bank.row_num, 2);
  // Group totals: filtered, non-deleted rows; missing rates listed, never 1:1.
  assert.deepEqual(plain(data.groups[0].total), { quote: 3232.5, display_sign: 'positive', missing_currencies: [] });
  assert.deepEqual(plain(data.groups[1].total), { quote: 40, display_sign: 'credit', missing_currencies: [] });
  assert.deepEqual(plain(data.groups[2].total), { quote: 0, display_sign: 'positive', missing_currencies: ['USD'] });
  assert.deepEqual(plain(data.facets.currencies), [{ value: 'GBP', label: 'GBP', symbol: '£' }, { value: 'INR', label: 'INR', symbol: '₹' }, { value: 'USD', label: 'USD', symbol: 'USD ' }]);
  assert.deepEqual(plain(data.facets.types), [{ value: 'asset', label: 'Asset' }, { value: 'liability', label: 'Liability' }, { value: 'investment', label: 'Investment' }]);
  assert.deepEqual(plain(data.facets.sub_types_by_type.asset), [{ value: 'current', label: 'Current' }]);
  assert.deepEqual(data.facets.statuses.map(status => status.value), ['active', 'inactive', 'deleted', 'locked']);
});

test('native balances equal listAccounts().current_value_local for every account', () => {
  const runtime = appRuntime();
  const data = runtime.get({ action: 'list_accounts_view' }).data;
  const expected = Object.fromEntries(runtime.ctx.listAccounts().map(account => [account.id, account.current_value_local]));
  for (const row of rowsOf(data)) assert.equal(row.balance.native, expected[row.id], row.account_name);
});

test('summary cards are placeholders without values; counts cover all non-deleted accounts', () => {
  const runtime = appRuntime();
  for (const params of [{}, { statuses: 'active' }, { type: 'liability' }]) {
    const summary = runtime.get({ action: 'list_accounts_view', ...params }).data.summary;
    assert.deepEqual([summary.total_assets, summary.total_liabilities, summary.net_worth, summary.liquid_cash], [null, null, null, null]);
    assert.deepEqual([summary.account_count, summary.all_count], [4, 5]);
    assert.deepEqual(summary.cards.map(card => [card.key, card.value]), [['total_assets', null], ['total_liabilities', null], ['net_worth', null], ['liquid_cash', null]]);
  }
});

test('filters: type, sub_type, currency, search and statuses (csv or none)', () => {
  const runtime = appRuntime();
  const list = params => runtime.get({ action: 'list_accounts_view', ...params });
  assert.deepEqual(names(list({ type: 'asset' }).data), ['Bank', 'Rupee', 'Closed']);
  assert.deepEqual(names(list({ type: 'asset', sub_type: 'current', currency: 'inr' }).data), ['Rupee']);
  assert.deepEqual(names(list({ search: 'BRO' }).data), ['Brokerage']);
  assert.deepEqual(names(list({ statuses: 'active,locked' }).data), ['Bank', 'Card', 'Brokerage']);
  assert.deepEqual(names(list({ statuses: 'none' }).data), []);
  assert.equal(list({ statuses: 'none' }).data.summary.all_count, 5);
  const filtered = list({ type: 'asset', statuses: 'active', search: 'b', currency: 'all' }).data;
  assert.equal(filtered.active_filter_count, 3);
  assert.deepEqual(plain(filtered.filters), { type: 'asset', sub_type: 'all', currency: 'all', search: 'b', statuses: ['active'] });
  // Group totals follow the filters (the summary does not).
  assert.deepEqual(plain(filtered.groups[0].total), { quote: 3142.5, display_sign: 'positive', missing_currencies: [] });
  for (const [params, error, field] of [[{ statuses: 'active,gone' }, 'invalid_statuses', 'statuses'], [{ sort: 'nope' }, 'invalid_sort', 'sort'],
    [{ dir: 'up' }, 'invalid_sort', 'dir'], [{ page: '0' }, 'invalid_page', 'page'], [{ page_size: '501' }, 'invalid_page_size', 'page_size']]) {
    const response = list(params);
    assert.equal(response.ok, false, JSON.stringify(params));
    assert.equal(response.error, error);
    assert.equal(response.field, field);
    assert.ok(response.message.length > 0);
  }
});

test('sorting within type groups and paging over the sorted list', () => {
  const runtime = appRuntime();
  const list = params => runtime.get({ action: 'list_accounts_view', ...params }).data;
  assert.deepEqual(names(list({ sort: 'account_name', dir: 'desc' })), ['Rupee', 'Closed', 'Bank', 'Card', 'Brokerage']);
  // Balance sorts by quote value; missing quotes stay last in both directions.
  assert.deepEqual(names(list({ sort: 'balance', dir: 'desc', type: 'asset' })), ['Bank', 'Closed', 'Rupee']);
  assert.deepEqual(names(list({ sort: 'balance', dir: 'asc' })), ['Rupee', 'Closed', 'Bank', 'Card', 'Brokerage']);
  const page2 = list({ page_size: '2', page: '2' });
  assert.deepEqual([page2.total, page2.page, page2.pages, page2.page_size], [5, 2, 3, 2]);
  assert.deepEqual(names(page2), ['Closed', 'Card']);
  // Group totals and counts cover the whole filtered group, not just the page.
  assert.deepEqual([page2.groups[0].type, page2.groups[0].count, page2.groups[0].total.quote], ['asset', 3, 3232.5]);
  const clamped = list({ page_size: '2', page: '9' });
  assert.deepEqual([clamped.page, names(clamped)], [3, ['Brokerage']]);
  assert.deepEqual(plain(list({ sort: 'currency' }).sort), { col: 'currency', dir: 'asc' });
});

test('rows carry allowed actions and editable fields by status', () => {
  const runtime = appRuntime();
  const byName = Object.fromEntries(rowsOf(runtime.get({ action: 'list_accounts_view' }).data).map(row => [row.account_name, row]));
  assert.deepEqual(byName.Bank.allowed_actions, ['view', 'edit', 'transactions', 'delete']);
  assert.deepEqual(byName.Rupee.allowed_actions, ['view', 'edit', 'transactions', 'delete']);
  assert.deepEqual(byName.Brokerage.allowed_actions, ['view', 'transactions']);
  assert.deepEqual(byName.Closed.allowed_actions, ['view', 'transactions', 'restore']);
  assert.deepEqual(byName.Bank.editable_fields, ['account_name', 'description', 'sub_type', 'account_closing_date_local', 'record_status']);
  assert.ok(byName.Bank.readonly_fields.includes('opening_value_local'));
  assert.deepEqual([byName.Brokerage.readonly, byName.Brokerage.editable_fields, byName.Brokerage.statuses_for_edit], [true, [], []]);
  assert.deepEqual(byName.Bank.statuses_for_edit.map(status => status.value), ['active', 'inactive', 'locked']);
});

test('a list_accounts_view GET reads transaction_master and account_types once', () => {
  const runtime = appRuntime();
  const before = { tx: runtime.tabs.transactions.reads, accounts: runtime.tabs.accounts.reads, types: runtime.tabs.account_types.reads };
  assert.equal(runtime.get({ action: 'list_accounts_view' }).ok, true);
  assert.equal(runtime.tabs.transactions.reads - before.tx, 1);
  assert.equal(runtime.tabs.accounts.reads - before.accounts, 1);
  assert.equal(runtime.tabs.account_types.reads - before.types, 1);
});

test('listAccounts accepts preloaded transactions and keeps the sheet path', () => {
  const runtime = appRuntime();
  const { ctx, tabs } = runtime;
  const fromSheet = plain(ctx.listAccounts());
  const transactions = ctx.listTransactions();
  const reads = tabs.transactions.reads;
  assert.deepEqual(plain(ctx.listAccounts(transactions)), fromSheet);
  assert.equal(tabs.transactions.reads, reads);
  // The single-account form used by the balance rule still reads the sheet.
  const bank = fromSheet.find(account => account.id === ID(11));
  assert.equal(Number(bank.opening_value_local) + ctx._buildAccountNetMap([bank])[bank.id], bank.current_value_local);
  assert.equal(ctx._buildAccountNetMap([bank], [])[bank.id], 0);
});

test('catalog facts match the account and account-type schemas', () => {
  for (const accountTypes of [ACCOUNT_TYPES, ACCOUNT_TYPES.map((row, index) => (index === 1 ? { ...row, account_subtype_key: 'credit_card' } : row))]) {
    const runtime = appRuntime({ accountTypes });
    const { ctx } = runtime;
    ctx.vmResetRequest();
    const catalog = ctx._vwAccCatalog();
    const schema = ctx.getAccountSchemaForClient();
    assert.deepEqual(plain(catalog.subtypes_by_type), plain(schema.subtypes_by_type));
    assert.deepEqual(plain(catalog.type_labels), plain(schema.type_labels));
    assert.deepEqual(plain(catalog.subtype_labels), plain(schema.subtype_labels));
    assert.deepEqual(plain(catalog.types), plain(schema.types.map(type => ({ value: type.value, label: type.label }))));
    assert.equal(catalog.requires_migration, ctx.getAccountTypeSchemaForClient().requires_migration);
  }
});

test('get_account_form_options returns form choices and per-account editable fields', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'get_account_form_options' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.deepEqual(plain(data.types), [{ value: 'asset', label: 'Asset' }, { value: 'liability', label: 'Liability' }, { value: 'investment', label: 'Investment' }]);
  assert.deepEqual(plain(data.sub_types_by_type.liability), [{ value: 'credit-card', label: 'Credit card' }]);
  assert.deepEqual(plain(data.currencies), [{ value: 'GBP', label: 'GBP', symbol: '£' }, { value: 'INR', label: 'INR', symbol: '₹' }, { value: 'XAU', label: 'XAU', symbol: '⊕' }]);
  assert.deepEqual(data.statuses_for_edit.map(status => status.value), ['active', 'inactive', 'locked']);
  assert.deepEqual(plain(data.import_file_types[0]), { value: 'account_master', label: 'Accounts (master)' });
  assert.equal(data.import_file_types.length, 7);
  assert.deepEqual(plain(data.detail_sheets[0]), { value: 'account_deposit', label: 'Deposit' });
  assert.equal(data.account, null);
  assert.equal(data.requires_migration, false);
  const locked = runtime.get({ action: 'get_account_form_options', id: ID(14).toUpperCase() }).data.account;
  assert.deepEqual([locked.id, locked.row_num, locked.record_status, locked.editable_fields, locked.allowed_actions], [ID(14), 5, 'locked', [], ['view', 'transactions']]);
  const bank = runtime.get({ action: 'get_account_form_options', id: ID(11) }).data.account;
  assert.deepEqual(plain(bank.sub_types), [{ value: 'current', label: 'Current' }]);
  assert.ok(bank.editable_fields.includes('sub_type'));
  const missing = runtime.get({ action: 'get_account_form_options', id: ID(99) });
  assert.deepEqual([missing.ok, missing.error, missing.field], [false, 'unknown_account_id', 'id']);
});

test('list_rates_view: sheet order, every rate read-only, accounts using each currency, search and sort', () => {
  const runtime = appRuntime();
  const view = params => runtime.get({ action: 'list_rates_view', ...params });
  const data = view({}).data;
  assert.deepEqual(data.rows.map(row => row.currency), ['GBP', 'INR', 'XAU']);
  const [gbp, , xau] = data.rows;
  // Rates are published by forex-database-load: every row is read-only.
  assert.deepEqual([gbp.symbol, gbp.rate, gbp.rate_label, gbp.is_base, gbp.readonly, gbp.allowed_actions, gbp.rate_date], ['£', 80, '80.00', false, true, [], '']);
  // Every account status counts.
  assert.deepEqual([gbp.used_by_accounts, gbp.account_count], [['Bank', 'Card', 'Closed'], 3]);
  assert.deepEqual([xau.is_base, xau.readonly, xau.allowed_actions], [true, true, []]);
  assert.equal(data.rows[1].rate_label, '8,400.00');
  assert.deepEqual([data.total, data.total_all, data.base_currency], [3, 3, 'XAU']);
  assert.deepEqual(view({ sort: 'rate', dir: 'desc' }).data.rows.map(row => row.currency), ['INR', 'GBP', 'XAU']);
  assert.deepEqual(view({ sort: 'currency', dir: 'desc' }).data.rows.map(row => row.currency), ['XAU', 'INR', 'GBP']);
  assert.deepEqual(view({ search: '₹' }).data.rows.map(row => row.currency), ['INR']);
  assert.deepEqual(view({ search: 'xa' }).data.rows.map(row => row.currency), ['XAU']);
  assert.deepEqual([view({ sort: 'symbol' }).error, view({ sort: 'symbol' }).field], ['invalid_sort', 'sort']);
});

const ACCOUNT_TYPES_WIDE = [
  ...ACCOUNT_TYPES,
  { id: ID(4), account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'savings', account_subtype_label: 'Savings', detail_sheet: 'account_deposit', record_status: 'deleted' },
  { id: ID(5), account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'isa', account_subtype_label: 'ISA', description: 'Tax free', detail_sheet: '', record_status: 'locked' },
];

test('list_account_types_view sorts, filters and flags rows for the Configure panels', () => {
  const runtime = appRuntime({ accountTypes: ACCOUNT_TYPES_WIDE });
  const view = params => runtime.get({ action: 'list_account_types_view', ...params });
  const data = view({}).data;
  // Default order: type key, then subtype label.
  assert.deepEqual(data.rows.map(row => row.account_subtype_key), ['current', 'isa', 'savings', 'stocks-shares', 'credit-card']);
  assert.deepEqual([data.total, data.total_all, data.requires_migration, data.active_filter_count], [5, 5, false, 0]);
  const byKey = Object.fromEntries(data.rows.map(row => [row.account_subtype_key, row]));
  // has_accounts counts every account status (Closed is deleted), as account_type_in_use does.
  assert.deepEqual([byKey.current.has_accounts, byKey.current.account_count, byKey.current.readonly_fields], [true, 3, ['detail_sheet']]);
  assert.deepEqual([byKey.savings.has_accounts, byKey.savings.readonly_fields, byKey.savings.allowed_actions], [false, [], ['view', 'restore']]);
  assert.deepEqual(byKey.isa.allowed_actions, ['view', 'unlock']);
  assert.deepEqual(byKey.isa.readonly_fields, ['account_type_label', 'account_subtype_label', 'description', 'detail_sheet']);
  assert.deepEqual(byKey.isa.statuses_for_edit.map(status => status.value), ['active', 'inactive', 'locked']);
  assert.deepEqual(byKey.current.statuses_for_edit.map(status => status.value), ['active', 'inactive', 'deleted', 'locked']);
  assert.deepEqual(byKey['credit-card'].allowed_actions, ['view', 'edit', 'delete']);
  assert.deepEqual([byKey.current.record_status_label, byKey.current.detail_sheet_label, byKey.isa.detail_sheet_label], ['Active', 'Deposit', 'None']);
  assert.equal(byKey.current.row_num, 2);
  assert.equal(byKey.current._row, undefined);
  assert.deepEqual(plain(data.facets.types), [{ value: 'asset', label: 'Asset' }, { value: 'liability', label: 'Liability' }, { value: 'investment', label: 'Investment' }]);
  // Filters and sorts.
  assert.deepEqual(view({ status: 'locked' }).data.rows.map(row => row.account_subtype_key), ['isa']);
  assert.deepEqual(view({ type: 'liability' }).data.rows.map(row => row.account_subtype_key), ['credit-card']);
  assert.deepEqual(view({ search: 'TAX' }).data.rows.map(row => row.account_subtype_key), ['isa']);
  assert.equal(view({ search: 'tax', status: 'locked', type: 'asset' }).data.active_filter_count, 3);
  assert.deepEqual(view({ sort: 'sheet' }).data.rows.map(row => row.account_subtype_key), ['current', 'credit-card', 'stocks-shares', 'savings', 'isa']);
  assert.deepEqual(view({ sort: 'subtype', dir: 'desc' }).data.rows.map(row => row.account_subtype_label), ['Stocks & shares', 'Savings', 'ISA', 'Current', 'Credit card']);
  assert.deepEqual([view({ status: 'gone' }).error, view({ status: 'gone' }).field], ['invalid_record_status', 'status']);
});

test('a catalog that still needs migration only offers View', () => {
  const legacy = ACCOUNT_TYPES.map((row, index) => (index === 1 ? { ...row, account_subtype_key: 'credit_card' } : row));
  const runtime = appRuntime({ accountTypes: legacy });
  const data = runtime.get({ action: 'list_account_types_view' }).data;
  assert.equal(data.requires_migration, true);
  assert.ok(data.rows.every(row => row.allowed_actions.length === 1 && row.allowed_actions[0] === 'view'));
});

test('view actions are registered through the file hooks and cached by data_version', () => {
  const runtime = appRuntime();
  const actions = runtime.ctx.grGetActions();
  for (const action of ['list_accounts_view', 'get_account_form_options', 'list_rates_view', 'list_account_types_view']) {
    assert.equal(actions[action].cache, true, action);
    assert.ok(actions[action].ttl <= 600);
  }
  assert.equal(actions.list_accounts_view.cache, true);
  runtime.get({ action: 'list_accounts_view' });
  const reads = runtime.tabs.transactions.reads;
  runtime.get({ action: 'list_accounts_view' });
  assert.equal(runtime.tabs.transactions.reads, reads);
});

// ── Exports (phase 5): export_accounts / export_account_types ────────────────

// A CSV exactly as _shared/utils.js exportData writes it (header, every cell quoted).
function exportCsv(data) {
  return [data.columns.join(','), ...data.rows.map(row => data.columns.map(c => '"' + String(row[c] ?? '').replace(/"/g, '""') + '"').join(','))].join('\n');
}

test('export_accounts returns every account (all statuses, filters ignored) in the account_master columns and re-imports unchanged', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'export_accounts', status: 'active', search: 'Bank' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.equal(data.filename, 'account_master');
  assert.deepEqual(data.columns, ['id', 'account_name', 'legal_entity_name', 'type', 'sub_type', 'account_currency_local', 'local_timezone',
    'account_opening_date_local', 'account_closing_date_local', 'tracking_start_date_local', 'opening_value_local', 'description', 'record_status']);
  assert.equal(data.count, 5);
  assert.deepEqual(data.rows.map(row => row.account_name), runtime.ctx.listAccounts().map(account => account.account_name));
  assert.deepEqual(data.rows.map(row => row.record_status).sort(), ['active', 'active', 'deleted', 'inactive', 'locked']);
  assert.ok(data.rows.every(row => Object.keys(row).join() === data.columns.join()), 'stored columns only, no computed balances');
  const before = plain(runtime.ctx.listAccounts());
  const result = runtime.ctx.importAccountDataCsv({ file_type: 'account_master', csv: exportCsv(data) });
  // The fixture has no USD rate, so the USD account (Brokerage) is refused by
  // the import's currency rule, exactly as the file the old client wrote was.
  assert.equal(result.created, 0);
  assert.deepEqual(plain(result.results).filter(entry => entry.ok !== true).map(entry => [entry.key, entry.error]), [[ID(14), 'unknown_currency']]);
  // Re-importing the unchanged export rewrites nothing.
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 4);
  const after = plain(runtime.ctx.listAccounts());
  const stored = rows => rows.map(row => Object.fromEntries(data.columns.map(c => [c, row[c]])));
  assert.deepEqual(stored(after), stored(before));
  assert.equal(runtime.ctx.grGetActions().export_accounts.cache, false);
});

test('export_account_types returns the whole catalog in the 8 CSV columns (no audit or sync columns) and restores through importAccountTypesCsv', () => {
  const runtime = appRuntime();
  const response = runtime.get({ action: 'export_account_types', status: 'locked' });
  assert.equal(response.ok, true);
  const data = response.data;
  assert.equal(data.filename, 'account_types');
  assert.deepEqual(data.columns, plain(runtime.ctx.getAccountTypeCsvColumns()));
  assert.deepEqual(data.columns, ['id', 'account_type_key', 'account_type_label', 'account_subtype_key', 'account_subtype_label', 'description', 'detail_sheet', 'record_status']);
  assert.equal(data.count, ACCOUNT_TYPES.length);
  assert.equal(data.requires_migration, false);
  assert.deepEqual(data.rows.map(row => row.id), runtime.ctx.listAccountTypes().map(row => row.id));
  const before = plain(runtime.ctx.listAccountTypes()).map(row => Object.fromEntries(data.columns.map(c => [c, row[c]])));
  const result = runtime.ctx.importAccountTypesCsv({ csv: exportCsv(data) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.failed, 0);
  const after = plain(runtime.ctx.listAccountTypes()).map(row => Object.fromEntries(data.columns.map(c => [c, row[c]])));
  assert.deepEqual(after, before);
  // An older file with the audit and sync columns still imports; those columns are ignored.
  const full = { ...data, columns: plain(runtime.ctx.getAccountTypeSheetColumns()), rows: plain(runtime.ctx.listAccountTypes()) };
  assert.equal(runtime.ctx.importAccountTypesCsv({ csv: exportCsv(full) }).ok, true);
  const unknown = { ...data, columns: [...data.columns, 'is_loan'] };
  assert.equal(runtime.ctx.importAccountTypesCsv({ csv: exportCsv(unknown) }).error, 'invalid_csv_headers');
  const legacy = appRuntime({ accountTypes: ACCOUNT_TYPES.map((row, index) => (index === 1 ? { ...row, account_subtype_key: 'credit_card' } : row)) });
  assert.equal(legacy.get({ action: 'export_account_types' }).data.requires_migration, true);
  assert.equal(runtime.ctx.grGetActions().export_account_types.cache, false);
});
