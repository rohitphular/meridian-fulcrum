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
// Balance replay, period and conversion checks that used to live here run on
// the server now: ledger-core-backend.cjs, ledger-goldens-backend.cjs, fx-utils-backend.cjs.
const exportState = {};
const utils = load('core/utils.js', { state: exportState, _exportData: (format, rows, filename, cols) => ({ rows, filename, cols }) }, ['exportSubscriptions', 'exportCategories', 'downloadExport']);
const sub = { subscription_name: 'Rent', subscription_start_date_local: '2026-09-01', subscription_end_date_local: '2026-12-31' };
const exported = utils.exportSubscriptions('csv', [sub]);
assert.equal(exported.rows[0].subscription_name, 'Rent');
assert.ok(exported.cols.includes('subscription_start_date_local'));
assert.ok(!exported.cols.includes('tags'));
// Accounts / account types / transactions download the server export as-is
// (export_accounts etc.; accounts-view-backend.cjs covers the columns).
const serverExport = { filename: 'account_master', columns: ['id', 'tracking_start_date_local'], rows: [{ id: 'a' }] };
assert.deepEqual(utils.downloadExport('csv', serverExport), { rows: serverExport.rows, filename: 'account_master', cols: serverExport.columns });
assert.equal(utils.exportCategories('csv', []).filename, 'category_master');
assert.equal(exported.filename, 'subscription_master');
// Transfer export (one compact row per transfer, parent id and exact date kept)
// is built by the server: view-transactions-backend.cjs covers export_transactions.
const subscriptionSchema = { frequencies: ['monthly'], tx_types: ['money-in', 'money-out'], record_statuses: ['active', 'inactive', 'deleted', 'locked'], default_timezone: 'Europe/London' };
// The insufficient-balance rule (incl. the tracking-start skip) is server-side:
// form-validation-backend.cjs covers createTransaction / updateTransaction.
console.log('Frontend regression checks passed');


(async () => {
  const fields = Object.fromEntries(Object.entries({
    accNewName: 'Precision account', accNewLegalEntity: '', accNewCurrency: 'GBP',
    accNewType: 'asset', accNewSubType: 'bank', accNewDescription: '',
    accNewOpeningDate: '2026-09-24T10:00', accNewTrackingStart: '', accNewOpeningValue: '',
  }).map(([id, value]) => [id, { value }]));
  fields.accAddError = { textContent: '' };
  fields.accSaveNew = { disabled: false, textContent: 'Save' };
  const accountState = { accAddOpen: true };
  const payloads = [];
  const reloads = [];
  let loading = 0;
  let response = { ok: true };
  const accounts = load('sections/accounts.js', {
    state: accountState, el: id => fields[id] ?? null,
    showLoading() { loading++; }, hideLoading() { loading--; }, showMsg() {},
    document: { dispatchEvent(event) { reloads.push(event.type); } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    ExpenseAPI: { async createAccount(payload) { payloads.push(payload); return response; } },
  }, ['_saveNew']);

  for (const value of [' 90071992547409.91 ', '+12.300e-2', '-.125', '12.', '0']) {
    fields.accNewOpeningValue.value = value;
    fields.accSaveNew.disabled = false;
    accountState.accAddOpen = true;
    await accounts._saveNew();
    assert.equal(payloads.at(-1).opening_value_local, value.trim());
    assert.equal(accountState.accAddOpen, false);
    assert.equal(fields.accAddError.textContent, '');
    assert.equal(reloads.at(-1), 'et:reload');
    assert.equal(loading, 0);
  }
  assert.equal(payloads.length, 5);
  assert.equal(reloads.length, 5);

  // validateAccountCreate owns the rule (form-validation-backend.cjs): the form
  // submits the text as entered and shows the server outcome without reloading.
  for (const value of ['', '12junk', '0x10', 'NaN', 'Infinity', '1e309', '1e', '1_000', '１２']) {
    fields.accNewOpeningValue.value = value;
    fields.accSaveNew.disabled = false;
    accountState.accAddOpen = true;
    response = { ok: false, error: value === '' ? 'missing_opening_value_local' : 'invalid_opening_value_local' };
    await accounts._saveNew();
    assert.equal(payloads.at(-1).opening_value_local, value.trim());
    assert.equal(reloads.length, 5);
    assert.equal(accountState.accAddOpen, true);
    assert.equal(fields.accSaveNew.disabled, false);
    assert.match(fields.accAddError.textContent, /Opening value (?:is required|must be a finite number)/);
    assert.equal(loading, 0);
  }
  response = { ok: false, error: 'missing_account_name', message: 'Account name is required (server).' };
  fields.accNewName.value = '';
  await accounts._saveNew();
  assert.equal(fields.accAddError.textContent, 'Account name is required (server).');
  assert.equal(payloads.length, 15);
  console.log('Account opening decimal precision checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  // loadAll loads get_app_context only (no raw lists); a failed or invalid
  // context keeps the previous complete snapshot and names the failing schema.
  const previousContext = { quote_currencies: [], schemas: {} };
  const snapshotState = { context: previousContext };
  const messages = [];
  let renders = 0;
  let authPrompts = 0;
  let contextFailure = null;
  let subscriptionSchemaResponse = subscriptionSchema;
  let accountTypeSchema = { fields: [], types: [], record_statuses: [], columns: [] };
  const calls = [];
  const main = load('main.js', {
    state: snapshotState,
    ExpenseAPI: {
      getAppContext: async () => {
        calls.push('get_app_context');
        if (contextFailure) return { ok: false, error: contextFailure };
        return { ok: true, data: { quote_currencies: [{ currency: 'XAU', symbol: '', rate: 1, rate_label: '1.00' }], schemas: {
          account: { types: [] }, transaction: { types: [] }, category: { types: [], record_statuses: ['active'] },
          account_type: accountTypeSchema, subscription: subscriptionSchemaResponse,
        } } };
      },
    },
    showLoading() {}, hideLoading() {}, showMsg: message => messages.push(message),
    showSection() { renders++; }, clearSession() {}, showPinGate() { authPrompts++; },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    document: { addEventListener() {} }, el: () => ({ value: 'XAU', innerHTML: '' }), esc: String,
  }, ['loadAll']);
  contextFailure = 'sheet_header_mismatch';
  await main.loadAll();
  assert.equal(snapshotState.context, previousContext);
  assert.equal(renders, 0);
  assert.match(messages[0], /app context: sheet_header_mismatch/);
  assert.match(messages[0], /Check the affected sheet headers/);
  contextFailure = 'auth';
  await main.loadAll();
  assert.equal(authPrompts, 1);
  assert.equal(snapshotState.context, previousContext);
  contextFailure = null;
  accountTypeSchema = { fields: [] };
  await main.loadAll();
  assert.equal(snapshotState.context, previousContext);
  assert.match(messages.at(-1), /account type schema: invalid_schema/);
  accountTypeSchema = { fields: [], types: [], record_statuses: [], columns: [] };
  subscriptionSchemaResponse = { frequencies: ['monthly'] };
  await main.loadAll();
  assert.equal(snapshotState.context, previousContext);
  assert.equal(renders, 0);
  assert.match(messages.at(-1), /subscription schema: invalid_schema/);
  subscriptionSchemaResponse = subscriptionSchema;
  await main.loadAll();
  assert.notEqual(snapshotState.context, previousContext);
  assert.equal(snapshotState.subscriptionSchema, subscriptionSchema);
  assert.equal(snapshotState.accountTypeSchema, accountTypeSchema);
  assert.deepEqual(Array.from(snapshotState.categorySchema.record_statuses), ['active']);
  for (const key of ['transactions', 'accounts', 'categories', 'subscriptions', 'rates', 'rateMap', 'accountMap', 'accountTypes']) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotState, key), false, key);
  }
  assert.deepEqual(calls, Array(5).fill('get_app_context'));
  assert.equal(renders, 1);
  console.log('Atomic frontend refresh checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
