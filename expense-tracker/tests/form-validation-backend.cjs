// Phase 1 (dumb UI): validation and business rules the browser used to check
// (plan R1–R6, R18, R19, R22, R25, R26, R31) enforced on the write paths.
// Failures keep their error code and carry `field` + a human `message`.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');
const { ID, ACCOUNTS, seedViewFixture } = require('./support/view-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const BANK = ID(11), RUPEE = ID(12), CARD = ID(13), BROKERAGE = ID(14);

function runtime(overrides) {
  const rt = gasRuntime();
  rt.tabs = seedViewFixture(rt, overrides);
  rt.rowOf = id => rt.tabs.transactions.rows.findIndex(row => row[rt.ctx.txColIndex('id')] === id) + 1;
  rt.balance = id => rt.ctx.listAccounts().find(account => account.id === id).current_value_local;
  return rt;
}

// Asserts the form envelope: code, field and a non-empty human message.
function assertFormError(result, error, field, message) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, error, JSON.stringify(result));
  assert.equal(result.field, field, JSON.stringify(result));
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0 && result.message !== error, JSON.stringify(result));
  if (message !== undefined) assert.match(result.message, message);
}

const spend = extra => ({ tx_date_local: '2026-09-15 10:00:00', tx_timezone_local: 'Europe/London', tx_type: 'money-out',
  source_account: BANK, source_amount_local: '10', major_category: 'food', minor_category: 'groceries', ...extra });
const transfer = extra => spend({ major_category: 'transfer', minor_category: 'own', target_account: CARD, ...extra });

// ── R1: insufficient balance on interactive create ────────────────────────────

test('create blocks a money-out that would overdraw an asset account, with field, message and details', () => {
  const rt = runtime();
  const before = rt.tabs.transactions.rows.length;
  assert.equal(rt.balance(BANK), 3142.5);
  const result = plain(rt.ctx.createTransaction(spend({ source_amount_local: '5000' })));
  assertFormError(result, 'insufficient_balance', 'source_amount_local', /^Insufficient balance\. Bank has £3142\.50 — this transaction needs £5000\.00\./);
  assert.deepEqual(result.details, { account_id: BANK, currency: 'GBP', available: '3142.50', required: '5000.00' });
  assert.equal(rt.tabs.transactions.rows.length, before, 'nothing is written');
  // Spending exactly the balance is allowed; the next penny is not.
  assert.equal(rt.ctx.createTransaction(spend({ source_amount_local: '3142.5' })).ok, true);
  assertFormError(plain(rt.ctx.createTransaction(spend({ tx_date_local: '2026-09-16 10:00:00', source_amount_local: '0.01' }))), 'insufficient_balance', 'source_amount_local');
});

test('create checks both transfer directions from an asset source and skips liabilities and money-in', () => {
  const rt = runtime();
  assertFormError(plain(rt.ctx.createTransaction(transfer({ source_amount_local: '5000' }))), 'insufficient_balance', 'source_amount_local');
  // A transfer submitted as money-in still debits its source account.
  assertFormError(plain(rt.ctx.createTransaction(transfer({ tx_type: 'money-in', source_amount_local: '5000' }))), 'insufficient_balance', 'source_amount_local');
  // Liability source (Card) and money-in are never balance-checked.
  assert.equal(rt.ctx.createTransaction(spend({ source_account: CARD, source_amount_local: '99999' })).ok, true);
  assert.equal(rt.ctx.createTransaction({ tx_date_local: '2026-09-15 11:00:00', tx_type: 'money-in', target_account: BANK,
    target_amount_local: '99999', source_amount_local: '99999', major_category: 'income', minor_category: 'salary' }).ok, true);
});

test('create skips movements before the account tracking start (legacy and zoned accounts)', () => {
  const rt = runtime();
  // Bank tracks from 2026-07-01 00:00 Europe/London.
  assert.equal(rt.ctx.createTransaction(spend({ tx_date_local: '2026-06-30 23:59:59', source_amount_local: '999999' })).ok, true);
  assertFormError(plain(rt.ctx.createTransaction(spend({ tx_date_local: '2026-07-01 00:00:00', source_amount_local: '999999' }))), 'insufficient_balance', 'source_amount_local');
  // Zoned comparison uses the transaction's own zone: 2026-07-01 01:30 in New York is after the London cutoff.
  assertFormError(plain(rt.ctx.createTransaction(spend({ tx_date_local: '2026-06-30 20:30:00', tx_timezone_local: 'America/New_York', source_amount_local: '999999' }))), 'insufficient_balance', 'source_amount_local');
  const legacy = runtime({ accounts: ACCOUNTS.map(account => account.id === BANK ? { ...account, local_timezone: '' } : account) });
  assert.equal(legacy.ctx.createTransaction(spend({ tx_date_local: '2026-06-30 23:59:59', source_amount_local: '999999' })).ok, true);
});

test('summed balances with float drift can still be spent in full', () => {
  const rt = runtime({ transactions: [
    { id: ID(51), account_id: BANK, tx_type: 'money-in', tx_amount_local: 0.1, tx_date_local: '2026-08-01 10:00:00', tx_timezone_local: 'Europe/London', major_category: 'income', minor_category: 'salary', record_status: 'active' },
    { id: ID(52), account_id: BANK, tx_type: 'money-in', tx_amount_local: 0.2, tx_date_local: '2026-08-02 10:00:00', tx_timezone_local: 'Europe/London', major_category: 'income', minor_category: 'salary', record_status: 'active' },
  ], accounts: ACCOUNTS.map(account => account.id === BANK ? { ...account, opening_value_local: 0 } : account) });
  assert.notEqual(rt.balance(BANK), 0.3);
  assert.equal(rt.ctx.createTransaction(spend({ source_amount_local: '0.3' })).ok, true);
});

// ── R2: insufficient balance on edit, after reversing the old movement ────────

const editOf = (rt, id, extra = {}) => {
  const row = rt.tabs.transactions.rows[rt.rowOf(id) - 1];
  const value = field => row[rt.ctx.txColIndex(field)];
  return { row_num: rt.rowOf(id), tx_date_local: value('tx_date_local'), tx_type: value('tx_type'), account_id: value('account_id'),
    tx_amount_local: String(value('tx_amount_local')), major_category: value('major_category'), minor_category: value('minor_category'), ...extra };
};

test('update checks the post-reversal balance on the same account and the full balance on a new account', () => {
  const rt = runtime();
  // Row 32 is a 45.50 spend on Bank (balance 3142.50): up to 3188.00 fits after reversal.
  assertFormError(plain(rt.ctx.updateTransaction(editOf(rt, ID(32), { tx_amount_local: '3188.01' }))), 'insufficient_balance', 'tx_amount_local', /Bank has £3188\.00/);
  // Moving Card's 60.00 spend onto Bank has nothing to reverse there.
  assertFormError(plain(rt.ctx.updateTransaction(editOf(rt, ID(39), { account_id: BANK, tx_amount_local: '3142.51' }))), 'insufficient_balance', 'tx_amount_local');
  // Edited to before the tracking start: no longer affects the balance, so not checked.
  assert.equal(rt.ctx.updateTransaction(editOf(rt, ID(32), { tx_date_local: '2026-06-20 12:00:00', tx_amount_local: '999999' })).ok, true);
  assert.equal(rt.ctx.updateTransaction(editOf(rt, ID(32), { tx_date_local: '2026-08-03 12:30:00', tx_amount_local: '3188' })).ok, true);
  assert.equal(rt.balance(BANK), 0);
});

test('every existing fixture row re-saves unchanged; a genuinely overdrawn account blocks its money-out edits', () => {
  const rt = runtime();
  const live = [31, 32, 33, 35, 36, 37, 38, 39, 40];
  for (const n of live) assert.equal(rt.ctx.updateTransaction(editOf(rt, ID(n))).ok, true, 'row ' + n);
  assertFormError(plain(rt.ctx.updateTransaction(editOf(rt, ID(34)))), 'transaction_deleted', undefined);
});

// ── Bulk import never runs the balance rule ────────────────────────────────────

test('CSV import (createTransactionsBulk) skips the balance rule for historical rows; interactive create does not', () => {
  const rt = runtime();
  const csv = 'tx_date_local,tx_type,source_account,source_amount_local,major_category,minor_category\n'
    + '2026-09-15 10:00:00,money-out,Bank,999999,food,groceries\n';
  const imported = plain(rt.ctx.importTransactionsCsv({ csv }));
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.created, 1);
  assert.equal(rt.balance(BANK), 3142.5 - 999999);
  const bulk = plain(rt.ctx.createTransactionsBulk({ transactions: [spend({ tx_date_local: '2026-09-16 10:00:00', source_amount_local: '5' })] }));
  assert.equal(bulk.ok, true, JSON.stringify(bulk));
  assert.equal(bulk.results[0].message, undefined, 'bulk results keep bare codes');
  // The same movement entered interactively is refused.
  assertFormError(plain(rt.ctx.createTransaction(spend({ tx_date_local: '2026-09-17 10:00:00', source_amount_local: '999999' }))), 'insufficient_balance', 'source_amount_local');
  // The account is now genuinely overdrawn: a money-out edit is refused until a correction, money-in edits are not.
  assertFormError(plain(rt.ctx.updateTransaction(editOf(rt, ID(32), { description: 'note' }))), 'insufficient_balance', 'tx_amount_local');
  assert.equal(rt.ctx.updateTransaction(editOf(rt, ID(31), { description: 'note' })).ok, true);
});

// ── R3–R6: required fields and amounts ────────────────────────────────────────

test('create reports required fields and invalid amounts with the input field', () => {
  const rt = runtime({ accounts: ACCOUNTS.map(account => account.id === RUPEE ? { ...account, record_status: 'active' } : account) });
  const create = body => plain(rt.ctx.createTransaction(body));
  assertFormError(create(spend({ tx_date_local: '' })), 'missing_date', 'tx_date_local');
  assertFormError(create(spend({ tx_date_local: '2026-02-30 10:00:00' })), 'invalid_tx_date_local', 'tx_date_local');
  assertFormError(create(spend({ tx_type: '' })), 'invalid_transaction_type', 'tx_type');
  for (const value of ['', '12bad', 'Infinity', '-1', '0', '0x10', 'NaN']) {
    assertFormError(create(spend({ source_amount_local: value })), 'missing_source_amount', 'source_amount_local');
  }
  assertFormError(create(spend({ major_category: '' })), 'missing_category', 'major_category');
  assertFormError(create(spend({ minor_category: '' })), 'missing_category', 'minor_category');
  assertFormError(create(spend({ minor_category: 'takeaway' })), 'unknown_category', 'minor_category');
  assertFormError(create(spend({ source_account: '' })), 'missing_source_account', 'source_account');
  assertFormError(create(spend({ source_account: BROKERAGE })), 'unknown_source_account', 'source_account');
  assertFormError(create({ tx_date_local: '2026-09-15 10:00:00', tx_type: 'money-in', target_amount_local: '5', major_category: 'income', minor_category: 'salary' }),
    'missing_target_account', 'target_account');
  assertFormError(create(transfer({ target_account: BANK })), 'same_transfer_account', 'target_account');
  // R4: a cross-currency transfer needs its target amount; same-currency defaults it.
  assertFormError(create(transfer({ target_account: RUPEE, target_amount_local: '' })), 'missing_target_amount', 'target_amount_local', /different currencies/);
  assertFormError(create(transfer({ target_account: RUPEE, target_amount_local: '0' })), 'missing_target_amount', 'target_amount_local');
  const same = create(transfer({ target_amount_local: '' }));
  assert.equal(same.ok, true, JSON.stringify(same));
  assertFormError(create(spend({ user_location_latitude: '91', user_location_longitude: '0' })), 'latitude_out_of_range', 'user_location_latitude');
  assertFormError(create(spend({ beneficiaries: 'A:60;B:30' })), 'beneficiary_percentages_do_not_sum_to_100', 'beneficiaries');
  assertFormError(create(spend({ tx_date_local: '2026-03-29 01:30:00' })), 'nonexistent_local_time', 'tx_date_local');
});

test('update reports required fields and invalid amounts with the input field', () => {
  const rt = runtime();
  const update = extra => plain(rt.ctx.updateTransaction(editOf(rt, ID(32), extra)));
  assertFormError(update({ tx_date_local: '' }), 'missing_date', 'tx_date_local');
  assertFormError(update({ tx_type: 'transfer' }), 'invalid_transaction_type', 'tx_type');
  for (const value of ['', '12bad', 'Infinity', '-1', '0', '0x10']) assertFormError(update({ tx_amount_local: value }), 'invalid_amount', 'tx_amount_local');
  assertFormError(update({ account_id: '' }), 'missing_account_id', 'account_id');
  assertFormError(update({ account_id: ID(99) }), 'unknown_account_id', 'account_id');
  assertFormError(update({ minor_category: '' }), 'missing_category', 'minor_category');
  assertFormError(update({ id: ID(32) }), 'field_not_editable', 'id');
  assertFormError(update({ expected_id: ID(31) }), 'stale_record', undefined, /moved or changed/);
});

// ── R18 / R19: account create and edit (codes only; see report follow-up) ─────

test('account create and edit rules the form used to check are enforced by the account validators', () => {
  const { ctx } = runtime();
  const account = extra => ({ account_name: 'New', type: 'asset', sub_type: 'current', account_currency_local: 'GBP',
    account_opening_date_local: '2026-09-24 10:00', opening_value_local: '0', ...extra });
  const code = extra => ctx.validateAccountCreate(account(extra)).error;
  assert.equal(ctx.validateAccountCreate(account()).ok, true);
  assert.equal(code({ account_name: ' ' }), 'missing_account_name');
  assert.equal(code({ type: '' }), 'invalid_account_type');
  assert.equal(code({ type: 'bogus' }), 'invalid_account_type');
  assert.equal(code({ sub_type: '' }), 'missing_sub_type');
  assert.equal(code({ account_currency_local: '' }), 'missing_local_currency');
  assert.equal(code({ account_currency_local: 'JPY' }), 'unknown_currency');
  assert.equal(code({ account_opening_date_local: '' }), 'missing_opening_date_local');
  assert.equal(code({ opening_value_local: '' }), 'missing_opening_value_local');
  for (const value of ['12junk', '0x10', 'NaN', 'Infinity', '1e309', '1e', '1_000', '１２']) assert.equal(code({ opening_value_local: value }), 'invalid_opening_value_local', value);
  for (const value of [' 90071992547409.91 ', '+12.300e-2', '-.125', '12.', '0']) assert.equal(ctx.validateAccountCreate(account({ opening_value_local: value })).ok, true, value);
  assert.equal(ctx.validateAccountUpdate({ row_num: 2, account_name: '' }, 'asset', '2020-01-01 00:00:00', 'Europe/London').error, 'missing_account_name');
});

// ── R22: category labels ───────────────────────────────────────────────────────

test('category create and edit report missing or unusable labels on the label field', () => {
  const { ctx } = runtime();
  const category = extra => ({ tx_type_key: 'money-out', major_category_label: 'Travel', minor_category_label: 'Trains', ...extra });
  assertFormError(plain(ctx.createCategory(category({ major_category_label: '' }))), 'missing_major_category', 'major_category_label', /^Major category is required\.$/);
  assertFormError(plain(ctx.createCategory(category({ minor_category_label: '  ' }))), 'missing_minor_category', 'minor_category_label');
  assertFormError(plain(ctx.createCategory(category({ minor_category_label: '&' }))), 'invalid_category_label', 'minor_category_label');
  assertFormError(plain(ctx.createCategory(category({ tx_type_key: 'transfer' }))), 'invalid_transaction_type', 'tx_type_key');
  assertFormError(plain(ctx.updateCategory(category({ row_num: 2, major_category_label: '' }))), 'missing_major_category', 'major_category_label');
  assert.equal(ctx.createCategory(category()).ok, true);
});

// ── R25 / R26: subscriptions ───────────────────────────────────────────────────

test('subscription create reports every schedule and amount rule on its field; duplicate names are refused', () => {
  const { ctx } = runtime();
  const sub = extra => ({ subscription_name: 'Rent', subscription_amount_local: '12.50', frequency: 'monthly', day_of_month: '1', source_account: BANK, ...extra });
  const dated = { subscription_timezone_local: 'Europe/London' };
  for (const [extra, error, field] of [
    [{ subscription_name: '' }, 'missing_name', 'subscription_name'],
    [{ subscription_amount_local: '' }, 'missing_subscription_amount_local', 'subscription_amount_local'],
    [{ subscription_amount_local: '12bad' }, 'invalid_subscription_amount_local', 'subscription_amount_local'],
    [{ subscription_amount_local: '0' }, 'invalid_subscription_amount_local', 'subscription_amount_local'],
    [{ source_account: '' }, 'missing_source_account', 'source_account'],
    [{ source_account: 'Bank' }, 'invalid_source_account', 'source_account'],
    [{ source_account: BROKERAGE }, 'source_account_not_active', 'source_account'],
    [{ frequency: '' }, 'missing_frequency', 'frequency'],
    [{ frequency: 'daily' }, 'invalid_frequency', 'frequency'],
    [{ day_of_month: '' }, 'missing_day_of_month', 'day_of_month'],
    [{ day_of_month: '32' }, 'invalid_day_of_month', 'day_of_month'],
    [{ frequency: 'weekly', day_of_month: '' }, 'missing_day_of_week', 'day_of_week'],
    [{ day_of_week: '8' }, 'invalid_day_of_week', 'day_of_week'],
    [{ tx_type: 'transfer' }, 'invalid_tx_type', 'tx_type'],
    [{ record_status: 'archived' }, 'invalid_record_status', 'record_status'],
    [{ subscription_start_date_local: '2026-09-01 00:00:00' }, 'missing_subscription_timezone_local', 'subscription_timezone_local'],
    [{ ...dated, subscription_timezone_local: 'Invalid/Zone' }, 'invalid_subscription_timezone_local', 'subscription_timezone_local'],
    [{ ...dated, subscription_timezone_local: '+05:30' }, 'invalid_subscription_timezone_local', 'subscription_timezone_local'],
    [{ ...dated, subscription_start_date_local: '2026-02-30 00:00:00' }, 'invalid_subscription_start_date_local', 'subscription_start_date_local'],
    [{ ...dated, subscription_start_date_local: '2026-03-29 01:30:00' }, 'nonexistent_local_time', 'subscription_start_date_local'],
    [{ ...dated, subscription_start_date_local: '2026-09-02 00:00:00', subscription_end_date_local: '2026-09-01 00:00:00' }, 'end_before_start', 'subscription_end_date_local'],
    [{ frequency: 'quarterly' }, 'missing_subscription_start_date_local', 'subscription_start_date_local'],
    [{ tx_type: 'money-out', major_category: 'food', minor_category: 'groceries' }, 'category_not_subscription_eligible', 'major_category'],
  ]) assertFormError(plain(ctx.createSubscription(sub(extra))), error, field);
  assert.equal(ctx.createSubscription(sub()).ok, true);
  // R26: duplicate name among non-deleted subscriptions (case-insensitive).
  assert.equal(ctx.createSubscription(sub({ subscription_name: 'RENT' })).error, 'duplicate_subscription');
  assertFormError(plain(ctx.updateSubscription({ row_num: 2, frequency: 'daily' })), 'invalid_frequency', 'frequency');
});

// Rates are published by forex-database-load and read-only in the app (rates-regressions.cjs).
