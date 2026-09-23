const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../app');
function load(file, globals, expose) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source + '\n globalThis.testExports = {' + expose.join(',') + '};', context);
  return context.testExports;
}
const insights = load('sections/insights/insight-utils.js', {
  state: {}, toBase: (amount, currency) => currency === 'GBP' ? amount / 2 : amount,
}, ['accountBalanceByMonth', 'computeBalancesAt', 'computeDailyTotalAssets']);
const account = { id: 'a', account_currency_local: 'GBP', opening_value_local: 100, tracking_start_date_local: '2026-09-02 12:00' };
const tx = (date, amount, extra = {}) => ({ account_id: 'a', tx_date_local: date, tx_amount_local: amount, tx_type: 'money-in', ...extra });
const txs = [tx('2026-09-01 10:00', 200), tx('2026-09-02 11:59', 300), tx('2026-09-02 12:00', 20), tx('2026-09-03 10:00', 10, { tx_type: 'money-out' }), tx('bad', 900), tx('2026-09-03', 900, { record_status: 'deleted' }), tx('2026-09-03', 'bad')];
assert.deepEqual(Array.from(insights.computeDailyTotalAssets([account], txs, new Date(2026, 8, 1), new Date(2026, 8, 3))), [0, 60, 55]);
assert.equal(insights.computeBalancesAt([account], txs, new Date(2026, 8, 3)).get('a'), 55);
assert.equal(insights.accountBalanceByMonth([account], txs, ['2026-08', '2026-09']).get('2026-09').a, 55);
assert.equal(insights.accountBalanceByMonth([account], txs, ['2026-08', '2026-09']).get('2026-08').a, 0);
assert.equal(insights.computeBalancesAt([{ ...account, tracking_start_date_local: '' }], [tx('2026-09-01', 20)], new Date(2026, 8, 3)).get('a'), 60);
const exportState = {};
const utils = load('core/utils.js', { state: exportState, _exportData: (format, rows, filename, cols) => ({ rows, cols }), utcToLocalInput: value => value }, ['exportSubscriptions', 'exportAccounts', 'exportData', 'parseCsvRow']);
assert.deepEqual(Array.from(utils.parseCsvRow('"a ""quoted"" name",42')), ['a "quoted" name', '42']);
const sub = { subscription_name: 'Rent', subscription_start_date_local: '2026-09-01', subscription_end_date_local: '2026-12-31' };
const exported = utils.exportSubscriptions('csv', [sub]);
assert.equal(exported.rows[0].subscription_name, 'Rent');
assert.ok(exported.cols.includes('subscription_start_date_local'));
assert.ok(!exported.cols.includes('tags'));
assert.ok(utils.exportAccounts('csv', [account]).cols.includes('tracking_start_date_local'));
const parent = { id: 'parent', account_id: 'a', tx_type: 'money-out', tx_amount_local: 10, tx_date_local: '2026-09-03 12:00:45' };
const child = { id: 'child', parent_tx_id: 'parent', account_id: 'b', tx_type: 'money-in', tx_amount_local: 20 };
exportState.transactions = [parent, child];
exportState.accountMap = { a: { account_name: 'Bank' }, b: { account_name: 'Wallet' } };
const transferExport = utils.exportData('csv', [child, parent]);
assert.equal(transferExport.rows.length, 1);
assert.equal(transferExport.rows[0].id, 'parent');
assert.equal(transferExport.rows[0].tx_date_local, '2026-09-03 12:00:45');
assert.equal(transferExport.rows[0].target_amount_local, 20);
const subscriptions = load('sections/subscriptions.js', { state: {}, parseCsvRow: utils.parseCsvRow }, ['_parseSubscriptionsCsv']);
const subscriptionImport = subscriptions._parseSubscriptionsCsv('id,subscription_name,subscription_amount_local,frequency,subscription_timezone_local,record_status\nsub-1,Rent,100,monthly,Europe/London,inactive');
assert.equal(subscriptionImport.subscriptions[0].id, 'sub-1');
assert.equal(subscriptionImport.subscriptions[0].subscription_timezone_local, 'Europe/London');
assert.equal(subscriptionImport.subscriptions[0].record_status, 'inactive');
const imported = [];
const frontend = load('sections/transactions.js', {
  state: { accounts: [{ id: 'a', account_name: 'Bank' }], accountSchema: { loan_sub_types: ['personal_loan'] } }, getSymbol: () => '£', parseCsvRow: utils.parseCsvRow,
  el: () => null, showLoading() {}, hideLoading() {}, showMsg() {},
  document: { dispatchEvent() {} }, CustomEvent: class {},
  ExpenseAPI: { async createTransactionsBulk(payload) { imported.push(...payload.transactions); return { ok: true, created: 0, updated: payload.transactions.length, failed: 0, results: [] }; } },
}, ['_parseTxCsv', '_submitTxImport', '_checkBalanceRules', '_checkRule5']);
assert.match(frontend._checkBalanceRules('money-out', { ...account, type: 'asset', current_value_local: 10 }, false, 20, '2026-09-03'), /Insufficient balance/);
assert.equal(frontend._checkBalanceRules('money-out', { ...account, type: 'asset', current_value_local: 10 }, false, 20, '2026-09-01'), null);
assert.match(frontend._checkRule5('money-out', { type: 'liability', sub_type: 'personal_loan' }, 'shopping', 'other'), /Cannot record/);
assert.equal(frontend._checkRule5('money-out', { type: 'liability', sub_type: 'personal_loan' }, 'debt-finance', 'interest-charges'), null);
const parsed = frontend._parseTxCsv('id,tx_date_local,tx_type,source_account,source_amount_local,major_category,minor_category\none,2026-09-03,money-out,Bank,10,food,lunch\ntwo,2026-09-03,money-out,Bank,10,food,lunch');
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.transactions[0].id, 'one');
(async () => {
  await frontend._submitTxImport(parsed.transactions);
  assert.deepEqual(imported.map(row => row.id), ['one', 'two']);
  console.log('Frontend regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const previousTransactions = [{ id: 'previous' }];
  const previousAccounts = [{ id: 'previous-account' }];
  const snapshotState = { transactions: previousTransactions, accounts: previousAccounts, subscriptions: [{ id: 'previous-sub' }] };
  const messages = [];
  let renders = 0;
  let authPrompts = 0;
  let accountResponse = { ok: false, error: 'sheet_header_mismatch' };
  let schemaFailure = null;
  const response = data => Promise.resolve({ ok: true, data });
  const main = load('main.js', {
    state: snapshotState,
    ExpenseAPI: {
      listTransactions: () => response([{ id: 'fresh' }]),
      listCategories: () => response([]),
      listAccounts: () => Promise.resolve(accountResponse),
      listRates: () => response([{ currency: 'XAU', rate: 1 }]),
      listSubscriptions: () => response([]),
    },
    loadAccountSchema: async () => { if (schemaFailure) throw Object.assign(new Error('schema'), { code: schemaFailure }); return { types: [] }; },
    loadTransactionSchema: async () => ({ types: [] }),
    loadCategorySchema: async () => ({ types: [] }),
    showLoading() {}, hideLoading() {}, showMsg: message => messages.push(message),
    showSection() { renders++; }, clearSession() {}, showPinGate() { authPrompts++; },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    document: { addEventListener() {} }, el: () => ({ value: 'XAU', innerHTML: '' }), esc: String,
  }, ['loadAll']);
  await main.loadAll();
  assert.equal(snapshotState.transactions, previousTransactions);
  assert.equal(snapshotState.accounts, previousAccounts);
  assert.equal(renders, 0);
  assert.match(messages[0], /accounts: sheet_header_mismatch/);
  accountResponse = { ok: true, data: [{ id: 'fresh-account' }] };
  schemaFailure = 'auth';
  await main.loadAll();
  assert.equal(authPrompts, 1);
  assert.equal(snapshotState.transactions, previousTransactions);
  assert.equal(renders, 0);
  schemaFailure = null;
  await main.loadAll();
  assert.equal(snapshotState.transactions[0].id, 'fresh');
  assert.equal(snapshotState.accounts[0].id, 'fresh-account');
  assert.equal(renders, 1);
  console.log('Atomic frontend refresh checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
