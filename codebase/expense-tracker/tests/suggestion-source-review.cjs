const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../api/transaction-suggestions.gs'), 'utf8');
const fxSource = fs.readFileSync(path.join(__dirname, '../api/fx-utils.gs'), 'utf8');
const today = new Date(2026, 8, 25, 12, 0, 0);
class ReviewDate extends Date {
  constructor(...args) { super(...(args.length ? args : [today.getTime()])); }
}
function runtime(rows, accounts = {}) {
  const logs = [];
  const context = vm.createContext({
    Date: ReviewDate, console: { log: message => logs.push(message) },
    listTransactions: () => rows,
    listRates: () => [{ currency: 'GBP', rate: 80, symbol: '£' }, { currency: 'INR', rate: 8400, symbol: '₹' }],
    listCategories: () => [{ minor_category_key: 'food', minor_category_label: 'Food & drink' }],
    _loadAccountMap: () => ({
      gbp: { account_currency_local: 'GBP', record_status: 'active' },
      inr: { account_currency_local: 'INR', record_status: 'active' },
      ...accounts,
    }),
  });
  vm.runInContext(fxSource, context);
  vm.runInContext(source, context);
  return { context, logs };
}
function row(date, changes = {}) {
  return { tx_type: 'money-out', record_status: 'active', tx_date_local: date,
    counterparty_name: 'Synthetic private payee', major_category: 'living', minor_category: 'food',
    account_id: 'gbp', tx_amount_local: '10', ...changes };
}

test('suggestions keep native amounts and identities separate across account currencies', () => {
  const rows = ['2026-09-21 12:00:00', '2026-09-22 12:00:00'].flatMap(date => [
    row(date), row(date, { account_id: 'inr', tx_amount_local: '1000' }),
  ]);
  const { context, logs } = runtime(rows);
  const suggestions = context.getSuggestedTransactions();
  assert.equal(suggestions.length, 2);
  assert.deepEqual(Array.from(suggestions, s => [s.account_id, s.currency, s.typical_amount]).sort(), [
    ['gbp', 'GBP', 10], ['inr', 'INR', 1000],
  ]);
  assert.equal(new Set(suggestions.map(s => s.suggestion_key)).size, 2);
  assert.ok(logs.every(message => !message.includes('Synthetic private payee')));
  // Card text is server-built: the browser renders display as-is.
  const inr = suggestions.find(s => s.account_id === 'inr');
  assert.deepEqual(JSON.parse(JSON.stringify(inr.display)), { account_name: 'inr', currency_symbol: '₹', category_label: 'Food & drink', typical_amount: '₹1000.00' });
});

test('deleted, invalid, future and unavailable-account history cannot create suggestions', () => {
  for (const changes of [
    { record_status: 'deleted' }, { tx_amount_local: 'NaN' }, { tx_amount_local: '0' },
    { tx_date_local: '2026-10-01 12:00:00' }, { account_id: 'missing' }, { account_id: 'inactive' },
  ]) {
    const { context } = runtime([row('2026-09-21 12:00:00', changes), row('2026-09-22 12:00:00', changes)], {
      inactive: { account_currency_local: 'GBP', record_status: 'inactive' },
    });
    assert.equal(context.getSuggestedTransactions().length, 0, JSON.stringify(changes));
  }
});

test('a payment today suppresses its own account suggestion without hiding another currency', () => {
  const rows = ['2026-09-21 12:00:00', '2026-09-22 12:00:00'].flatMap(date => [
    row(date), row(date, { account_id: 'inr', tx_amount_local: '1000' }),
  ]);
  rows.push(row('2026-09-25 10:00:00'));
  const { context } = runtime(rows);
  const suggestions = context.getSuggestedTransactions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].account_id, 'inr');
});

test('time-of-day grouping handles delimiters in names without parsing them as hours', () => {
  const { context } = runtime([
    row('2026-09-11 12:00:00', { counterparty_name: 'Synthetic | payee' }),
    row('2026-09-18 12:00:00', { counterparty_name: 'Synthetic | payee' }),
  ]);
  const suggestions = context.getSuggestedTransactions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].signal, 'time_of_day');
  assert.equal(suggestions[0].typical_amount, 10);
});

test('monthly signal observes its documented due-day window', () => {
  const { context } = runtime([]);
  const rows = ['05', '06', '07', '08'].map(month => ({ ...row('2026-' + month + '-25 12:00:00'), amount: 10, currency: 'GBP' }));
  const early = {};
  context._applyRecurringMonthly(rows, new Date(2026, 8, 1, 12), early);
  assert.equal(Object.keys(early).length, 0);
  const due = {};
  context._applyRecurringMonthly(rows, new Date(2026, 8, 22, 12), due);
  assert.equal(Object.keys(due).length, 1);
});
