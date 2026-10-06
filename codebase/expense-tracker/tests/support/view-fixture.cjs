// Small deterministic dataset written straight into mock Sheets (positional
// columns from each *SheetColumns()), shared by the view-foundation and parity tests.
const { Sheet } = require('./gas-runtime.cjs');

const ID = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

const ACCOUNT_TYPES = [
  { id: ID(1), account_type_key: 'asset', account_type_label: 'Asset', account_subtype_key: 'current', account_subtype_label: 'Current', detail_sheet: 'account_deposit', record_status: 'active' },
  { id: ID(2), account_type_key: 'liability', account_type_label: 'Liability', account_subtype_key: 'credit-card', account_subtype_label: 'Credit card', detail_sheet: 'account_liability_credit_card', record_status: 'active' },
  { id: ID(3), account_type_key: 'investment', account_type_label: 'Investment', account_subtype_key: 'stocks-shares', account_subtype_label: 'Stocks & shares', detail_sheet: 'account_investment_stocks', record_status: 'active' },
];

const ACCOUNTS = [
  { id: ID(11), account_name: 'Bank', type: 'asset', sub_type: 'current', account_currency_local: 'GBP', local_timezone: 'Europe/London', account_opening_date_local: '2020-01-01 00:00:00', tracking_start_date_local: '2026-07-01 00:00:00', opening_value_local: 1000, record_status: 'active' },
  { id: ID(12), account_name: 'Rupee', type: 'asset', sub_type: 'current', account_currency_local: 'INR', local_timezone: '', account_opening_date_local: '2020-01-01 00:00:00', tracking_start_date_local: '2026-07-01 00:00:00', opening_value_local: 10500, record_status: 'inactive' },
  { id: ID(13), account_name: 'Card', type: 'liability', sub_type: 'credit-card', account_currency_local: 'GBP', local_timezone: 'Europe/London', account_opening_date_local: '2020-01-01 00:00:00', tracking_start_date_local: '', opening_value_local: -200, record_status: 'active' },
  { id: ID(14), account_name: 'Brokerage', type: 'investment', sub_type: 'stocks-shares', account_currency_local: 'USD', local_timezone: 'America/New_York', account_opening_date_local: '2020-01-01 00:00:00', tracking_start_date_local: '2026-08-01 00:00:00', opening_value_local: 500, record_status: 'locked' },
  { id: ID(15), account_name: 'Closed', type: 'asset', sub_type: 'current', account_currency_local: 'GBP', local_timezone: '', account_opening_date_local: '2020-01-01 00:00:00', tracking_start_date_local: '', opening_value_local: 999, record_status: 'deleted' },
];

const CATEGORIES = [
  { id: ID(21), tx_type_key: 'money-out', major_category_key: 'food', major_category_label: 'Food', minor_category_key: 'groceries', minor_category_label: 'Groceries', record_status: 'active', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false },
  { id: ID(22), tx_type_key: 'money-out', major_category_key: 'food', major_category_label: 'Food', minor_category_key: 'takeaway', minor_category_label: 'Takeaway', record_status: 'inactive', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false },
  { id: ID(23), tx_type_key: 'money-in', major_category_key: 'income', major_category_label: 'Income', minor_category_key: 'salary', minor_category_label: 'Salary', record_status: 'active', source_account_mandatory: false, target_account_mandatory: true, is_subscription_eligible: false },
  { id: ID(24), tx_type_key: 'money-out', major_category_key: 'transfer', major_category_label: 'Transfer', minor_category_key: 'own', minor_category_label: 'Own accounts', record_status: 'active', source_account_mandatory: true, target_account_mandatory: true, is_subscription_eligible: false },
  { id: ID(25), tx_type_key: 'money-in', major_category_key: 'transfer', major_category_label: 'Transfer', minor_category_key: 'own', minor_category_label: 'Own accounts', record_status: 'active', source_account_mandatory: true, target_account_mandatory: true, is_subscription_eligible: false },
  { id: ID(26), tx_type_key: 'money-out', major_category_key: 'old', major_category_label: 'Old', minor_category_key: 'gone', minor_category_label: 'Gone', record_status: 'deleted', source_account_mandatory: true, target_account_mandatory: false, is_subscription_eligible: false },
];

const t = (n, account, type, amount, date, extra = {}) => ({ id: ID(n), account_id: ID(account), tx_type: type, tx_amount_local: amount, tx_date_local: date,
  tx_timezone_local: 'Europe/London', major_category: type === 'money-in' ? 'income' : 'food', minor_category: type === 'money-in' ? 'salary' : 'groceries', record_status: 'active', ...extra });
const TRANSACTIONS = [
  t(31, 11, 'money-in', 2500, '2026-07-28 09:00:00'),
  t(32, 11, 'money-out', 45.5, '2026-08-03 12:30:00'),
  t(33, 11, 'money-out', 100, '2026-06-15 12:00:00'),                     // before tracking start
  t(34, 11, 'money-out', 20, '2026-09-10 08:00:00', { record_status: 'deleted' }),
  t(35, 11, 'money-out', 300, '2026-09-12 10:00:00', { major_category: 'transfer', minor_category: 'own' }),
  t(36, 13, 'money-in', 300, '2026-09-12 10:00:00', { parent_tx_id: ID(35), major_category: 'transfer', minor_category: 'own' }),
  t(37, 12, 'money-out', 1050, '2026-09-20 18:00:00', { tx_timezone_local: 'Asia/Kolkata' }),
  t(38, 14, 'money-in', 25, '2026-09-25 23:30:00', { tx_timezone_local: 'America/New_York' }),
  t(39, 13, 'money-out', 60, '2026-09-29 20:00:00'),
  t(40, 11, 'money-out', 12, '2026-10-05 09:00:00'),                      // future-dated
];

const RATES = [
  { currency: 'GBP', rate: 80, symbol: '£', updated_at: '2026-09-30T00:00:00Z' },
  { currency: 'INR', rate: 8400, symbol: '₹', updated_at: '2026-09-30T00:00:00Z' },
  { currency: 'XAU', rate: 1, symbol: '⊕', updated_at: '2026-09-30T00:00:00Z' },
];

function _rows(columns, records) {
  return [columns, ...records.map(record => columns.map(column => (record[column] === undefined ? '' : record[column])))];
}

// Pushes the fixture tabs into a gasRuntime spreadsheet. Options override records.
function seedViewFixture(runtime, overrides = {}) {
  const { ctx, sheets } = runtime;
  const data = { accountTypes: ACCOUNT_TYPES, accounts: ACCOUNTS, categories: CATEGORIES, transactions: TRANSACTIONS, rates: RATES, ...overrides };
  const add = (name, columns, records) => { const sheet = new Sheet(name, _rows(columns, records)); sheets.push(sheet); return sheet; };
  return {
    account_types: add('account_types', ctx.getAccountTypeSheetColumns(), data.accountTypes),
    accounts: add('account_master', ctx.getAccountSheetColumns(), data.accounts),
    categories: add('category_master', ctx.getCategorySheetColumns(), data.categories),
    transactions: add('transaction_master', ctx.getTransactionSheetColumns(), data.transactions),
    rates: add('rates', ctx.getRateSheetColumns(), data.rates),
    subscriptions: add('subscription_master', ctx.getSubscriptionSheetColumns(), []),
  };
}

module.exports = { ID, ACCOUNT_TYPES, ACCOUNTS, CATEGORIES, TRANSACTIONS, RATES, seedViewFixture };
