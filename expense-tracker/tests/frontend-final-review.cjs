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
const utils = load('core/utils.js', { state }, ['parseCsvRecords']);
const txParser = () => load('sections/transactions.js', { state, ...utils }, ['_parseTxCsv']);
const csv = (rows, columns = Object.keys(rows[0])) => columns.join(',') + '\r\n' + rows.map(row => columns.map(key => '"' + String(row[key] ?? '').replaceAll('"','""') + '"').join(',')).join('\r\n');
const transaction = extra => ({ tx_date_local: '2026-09-25 10:00:42.123456', tx_type: 'money-out', source_account: 'Bank', source_amount_local: '90071992547409.91', major_category: 'food', minor_category: 'groceries', description: 'Line one\r\nLine two, "quoted"', ...extra });

test('transaction CSV round-trip accepts quoted multiline descriptions and preserves exact amount text', () => {
  const result = txParser()._parseTxCsv(csv([transaction()]));
  assert.equal(result.errors.length, 0, result.errors.join('; '));
  assert.equal(result.transactions[0].description, transaction().description);
  assert.equal(result.transactions[0].source_amount_local, '90071992547409.91');
});

test('transaction CSV header failures are actionable instead of throwing or accepting overwritten columns', () => {
  const parser = txParser();
  for (const source of ['id\na', 'tx_date_local,tx_date_local\none,two', 'id,\na,b']) {
    assert.doesNotThrow(() => {
      const result = parser._parseTxCsv(source);
      assert.ok(result.errors.length > 0);
      assert.equal(result.transactions.length, 0);
    });
  }
});

test('account and extension CSVs accept multiline exported fields and reject duplicate headers', () => {
  const parser = load('sections/accounts.js', { ...utils }, ['_parseGenericCsv']);
  const result = parser._parseGenericCsv(csv([{ id: 'a', description: 'one\nsecond, "quoted"', opening_value_local: '90071992547409.91' }]));
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].description, 'one\nsecond, "quoted"');
  assert.equal(result.rows[0].opening_value_local, '90071992547409.91');
  assert.ok(parser._parseGenericCsv('id,id\na,b').errors.length > 0);
});

test('standalone money-in exports its amount on the populated target account', () => {
  const row = { id: 'income', account_id: account.id, tx_type: 'money-in', tx_amount_local: '123456789.123456789' };
  const { exportData } = load('core/utils.js', { state: { transactions: [row], accountMap: { [account.id]: account } }, _exportData: (format, rows) => rows }, ['exportData']);
  const exported = exportData('csv', [row])[0];
  assert.equal(exported.source_account, '');
  assert.equal(exported.target_account, account.account_name);
  assert.equal(exported.target_amount_local, row.tx_amount_local);
});

function importFixture(kind, respond) {
  const isTx = kind === 'transaction';
  const prefix = isTx ? '_txImport' : '_import';
  const nodes = {};
  const messages = [];
  const calls = [];
  const events = [];
  const context = { ...state, txImportOpen: true, accImportOpen: true };
  const globals = {
    state: context, ...utils, esc: value => String(value).replaceAll('<', '&lt;'),
    el: id => nodes[id] ??= { disabled: false, textContent: '', innerHTML: '' },
    showLoading() {}, hideLoading() {}, showMsg: text => messages.push(text),
    document: { dispatchEvent: event => events.push(event) }, CustomEvent: class {},
    ExpenseAPI: { [isTx ? 'createTransactionsBulk' : 'importAccountData']: async payload => {
      calls.push(isTx ? payload.transactions : payload.rows);
      return respond(payload, calls.length);
    } },
  };
  const methods = load(isTx ? 'sections/transactions.js' : 'sections/accounts.js', globals,
    [isTx ? '_submitTxImport' : '_submitImport', isTx ? '_readTxImport' : '_readAccountImport',
     `snapshot: () => ({ parsed: ${prefix}Parsed, busy: ${prefix}Busy, result: ${prefix}Result })`]);
  return { ...methods, nodes, messages, calls, events, context,
    submit: rows => isTx ? methods._submitTxImport(rows) : methods._submitImport('account_master', rows),
    read: file => isTx ? methods._readTxImport(file) : methods._readAccountImport(file) };
}

for (const kind of ['transaction', 'account']) {
  test(`${kind} import retries only known failures and reports an incomplete outcome without retrying`, async () => {
    const fixture = importFixture(kind, (_payload, count) => count === 1
      ? { results: [{ ok: true, action: 'created' }, { ok: false, error: '<invalid>' }] }
      : { results: [] });
    await fixture.submit([{ id: 'saved' }, { id: 'failed' }]);
    assert.deepEqual(Array.from(fixture.snapshot().parsed, row => row.id), ['failed']);
    assert.match(fixture.snapshot().result, /&lt;invalid>/);
    assert.equal(fixture.events.length, 1);
    await fixture.submit(fixture.snapshot().parsed);
    assert.deepEqual(Array.from(fixture.calls[1], row => row.id), ['failed']);
    assert.equal(fixture.snapshot().parsed, null);
    assert.match(fixture.snapshot().result, /Some rows may have been saved/);
    assert.equal(fixture.snapshot().busy, false);
    assert.equal(fixture.events.length, 2);
  });

  test(`${kind} file reader ignores old completion and blocks partial invalid files`, async () => {
    const fixture = importFixture(kind, () => { throw new Error('unexpected write'); });
    let resolveOld;
    const old = fixture.read({ text: () => new Promise(resolve => { resolveOld = resolve; }) });
    const row = kind === 'transaction' ? transaction({ description: 'new' }) : { id: 'new', description: 'new' };
    await fixture.read({ text: async () => csv([row]) });
    resolveOld(csv([kind === 'transaction' ? transaction({ description: 'old' }) : { id: 'old' }]));
    await old;
    assert.equal(fixture.snapshot().parsed[0].description, 'new');
    await fixture.read({ text: async () => csv([row]) + '\n"unterminated' });
    assert.equal(fixture.snapshot().parsed, null);
    assert.equal(fixture.calls.length, 0);
  });
}

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
