const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../app');
function load(file, globals, expose) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source + '\nthis.exposed = {' + expose.join(',') + '};', context);
  return context.exposed;
}
const account = { id: 'a0000000-0000-4000-8000-000000000001', account_name: 'Bank' };
const state = { accounts: [account], transactionSchema: { record_statuses: ['active', 'inactive', 'deleted', 'locked'] } };
test('standalone money-in exports its amount on the populated target account', () => {
  const row = { id: 'income', account_id: account.id, tx_type: 'money-in', tx_amount_local: '123456789.123456789' };
  const { exportData } = load('core/utils.js', { state: { transactions: [row], accountMap: { [account.id]: account } }, _exportData: (format, rows) => rows }, ['exportData']);
  const exported = exportData('csv', [row])[0];
  assert.equal(exported.source_account, '');
  assert.equal(exported.target_account, account.account_name);
  assert.equal(exported.target_amount_local, row.tx_amount_local);
});

test('transaction export preserves lifecycle and rejects transfers that would lose per-leg data', () => {
  const parent = { id: 'parent', tx_type: 'money-out', account_id: 'a', tx_amount_local: '10', record_status: 'inactive' };
  const child = { ...parent, id: 'child', parent_tx_id: 'parent', account_id: 'b', tx_type: 'money-in', tx_amount_local: '20' };
  const exportState = { transactions: [parent, child], accountMap: {} };
  const { exportData } = load('core/utils.js', { state: exportState, _exportData: (format, rows, filename, columns) => ({ rows, filename, columns }) }, ['exportData']);
  const output = exportData('csv', [child]);
  assert.equal(output.filename, 'transaction_master');
  assert.ok(output.columns.includes('record_status'));
  assert.equal(output.rows[0].record_status, 'inactive');
  assert.equal(output.rows[0].target_amount_local, '20');
  child.record_status = 'deleted';
  assert.throws(() => exportData('csv', [parent, child]), /Export transaction_master directly/);
  child.record_status = 'inactive';
  child.description = 'Edited independently';
  assert.throws(() => exportData('csv', [parent]), /separately edited/);
  child.description = '';
  exportState.transactions.push({ ...child, id: 'old-child', record_status: 'deleted' });
  assert.throws(() => exportData('csv', exportState.transactions), /separately edited/);
});

test('a deleted historical child cannot replace the active transfer sibling in UI', () => {
  const parent = { id: 'p' };
  const active = { id: 'c', parent_tx_id: 'p', record_status: 'active' };
  const deleted = { id: 'd', parent_tx_id: 'p', record_status: 'deleted' };
  const { _buildSiblingMap } = load('sections/transactions.js', {}, ['_buildSiblingMap']);
  assert.equal(_buildSiblingMap([parent, active, deleted]).p, active);
});

test('date-range filtering uses the recorded calendar date and account search uses current schema', () => {
  const RealDate = Date;
  class StrictDate extends RealDate {
    constructor(...args) { super(...(args.length === 1 && typeof args[0] === 'string' && args[0].includes(' ') ? [NaN] : args)); }
  }
  const context = { dateRange: 'custom', customFrom: '2026-09-25', customTo: '2026-09-25',
    filters: { types: [], accounts: [], major: [], minor: [], search: 'bank' },
    transactions: [{ account_id: account.id, tx_date_local: '2026-09-25 10:45:01' }], accountMap: { [account.id]: account } };
  const helpers = load('core/daterange.js', { state: context, Date: StrictDate,
    parseLocalDate: value => new StrictDate(...String(value).slice(0, 10).split('-').map((n, index) => Number(n) - (index === 1 ? 1 : 0))) }, ['txInRange', 'filteredTx']);
  assert.equal(helpers.txInRange({ tx_date_local: '2026-09-01 10:45:01' }), false);
  assert.equal(helpers.filteredTx().length, 1);
});

test('suggestions use an account-specific stable key without delimiter collisions', () => {
  const { _suggestionKey } = load('sections/transactions.js', {}, ['_suggestionKey']);
  const entry = { counterparty_name: 'A|B', major_category: 'food', minor_category: 'cafe', account_id: 'gbp', currency: 'GBP' };
  assert.notEqual(_suggestionKey(entry), _suggestionKey({ ...entry, account_id: 'inr', currency: 'INR' }));
  assert.equal(_suggestionKey({ ...entry, suggestion_key: 'server-key' }), 'server-key');
});

test('interrupted requests have bounded deadlines, clean timers and never auto-retry a mutation', async () => {
  let timer, duration, clears = 0, calls = 0;
  const context = vm.createContext({ URLSearchParams, AbortController,
    setTimeout: (callback, ms) => { timer = callback; duration = ms; return 1; },
    clearTimeout: () => { clears++; },
    fetch: (_url, options) => { calls++; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')))); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, '../_shared/sheets-client.js'), 'utf8') + '\nthis.client = SheetsClient;', context);
  context.client.init({ scriptUrl: 'https://example.invalid', pin: 'not-real' });
  const read = context.client.list();
  assert.equal(duration, 60000);
  timer(); await assert.rejects(read, /request_timeout/);
  const write = context.client.post({ action: 'create_transaction' });
  assert.equal(duration, 180000);
  timer(); await assert.rejects(write, /request_timeout/);
  assert.equal(calls, 2);
  assert.equal(clears, 2);
});

test('optional location enrichment ends after its deadline and clears the timer', async () => {
  let timer, duration, cleared = false;
  const { _locationData } = load('sections/transactions.js', {
    AbortController, setTimeout: (callback, ms) => { timer = callback; duration = ms; return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')))),
  }, ['_locationData']);
  const lookup = _locationData('https://example.invalid');
  assert.equal(duration, 5000);
  timer(); await assert.rejects(lookup, /AbortError/);
  assert.equal(cleared, true);
});

test('edit form keeps a closed account selectable for its own row but never offers it as a new choice', () => {
  const closed = { id: 'c1', account_name: 'Finio-1', account_currency_local: 'GBP', record_status: 'inactive', sub_type: 'personal-loan' };
  const open = { id: 'o1', account_name: 'Bank', account_currency_local: 'GBP', record_status: 'active', sub_type: 'current' };
  const gone = { id: 'd1', account_name: 'Gone', account_currency_local: 'GBP', record_status: 'deleted', sub_type: 'current' };
  const ctx = load('sections/transactions.js', { state: { ...state, accounts: [closed, open, gone] }, esc: String }, ['_editAccountOpts']);
  const own = ctx._editAccountOpts('', 'c1', 'c1');
  assert.match(own, /value="c1" selected>Finio-1 \(GBP\) · inactive/);
  assert.match(own, /value="o1"/);
  assert.doesNotMatch(ctx._editAccountOpts('', 'o1', 'o1'), /c1|d1/);
  assert.doesNotMatch(ctx._editAccountOpts('', 'd1', 'd1'), /d1/);
});
