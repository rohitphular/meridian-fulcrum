// Transaction import panel: the browser sends the raw file text and renders the
// server's outcome. Parsing and validation live in api/transaction-import.gs
// (see transaction-csv-import.cjs for the converted lifecycle/numeric checks).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');

function load(globals, exports) {
  const source = fs.readFileSync(path.join(__dirname, '../app/sections/transactions.js'), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export \{[^}]+\};/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  const context = importResultHelpers.context({ ...globals });
  vm.runInContext(source + '\nglobalThis.testExports = {' + exports.join(',') + '};', context);
  return context.testExports;
}

const RAW = 'id,tx_date_local\r\n"a, ""quoted""",2026-09-24\n';
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function fixture(respond) {
  const nodes = {};
  const requests = [];
  const messages = [];
  const events = [];
  const state = { txImportOpen: true };
  const exported = load({
    state, esc,
    el: id => nodes[id] ??= { disabled: false, textContent: '', innerHTML: '', value: 'C:\\fakepath\\file.csv' },
    showLoading() {}, hideLoading() {}, showMsg: (text, kind) => messages.push([text, kind]),
    document: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type) { this.type = type; } },
    ExpenseAPI: { async createTransactionsBulk(payload) { requests.push(payload); return respond(payload); } },
  }, ['_chooseTxImportFile', '_submitTxImport', 'snapshot: () => ({ file: _txImportFile, busy: _txImportBusy, result: _txImportResult })']);
  return { ...exported, nodes, requests, messages, events, state };
}
const file = text => ({ text: async () => text });

test('choosing a file only enables Import; the raw text is sent unparsed on Import', async () => {
  const f = fixture(() => ({ ok: true, created: 1, updated: 0, failed: 0, rows: 1, without_id: 0, results: [{ ok: true, action: 'created', line: 2 }] }));
  assert.equal(f.snapshot().file, null);
  f._chooseTxImportFile(file(RAW));
  assert.equal(f.nodes.txImportConfirm.disabled, false);
  assert.equal(f.requests.length, 0);
  await f._submitTxImport(f.snapshot().file);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [{ csv: RAW }]);
  assert.equal(f.state.txImportOpen, false);
  assert.deepEqual(f.messages.map(([text, kind]) => [text, kind]), [['1 created · 0 updated', undefined]]);
  assert.deepEqual(f.events.map(event => event.type), ['et:reload']);
  assert.equal(f.snapshot().file, null);
  assert.equal(f.nodes.txImportFile.value, '');
});

test('row failures render a line-numbered table with human messages; no retry is offered', async () => {
  const f = fixture(() => ({ ok: false, created: 1, updated: 0, failed: 2, rows: 3, without_id: 0, results: [
    { ok: true, action: 'created', line: 2, key: 'k1' },
    { ok: false, error: 'latitude_out_of_range', line: 5, key: 'k2' },
    { ok: false, error: '<custom_code>', line: 9, field: 'tx_date_local', key: '' },
  ] }));
  f._chooseTxImportFile(file(RAW));
  await f._submitTxImport(f.snapshot().file);
  const html = f.nodes.txImportStatus.innerHTML;
  assert.match(html, /1 created · 0 updated · 2 failed/);
  assert.match(html, /<td class="td-mono">5<\/td><td class="import-result-reason">Latitude must be between −90 and 90\.<div class="td-mono td-muted">[^<]*<\/div><\/td><td>k2<\/td>/);
  assert.match(html, /<td class="td-mono">9<\/td><td class="import-result-reason">&lt;custom code&gt;\.<div class="td-mono td-muted">&lt;custom_code&gt;<\/div><\/td><td>tx_date_local<\/td>/);
  assert.ok(!/<td>2<\/td>/.test(html));
  assert.ok(!/Retry/i.test(html));
  assert.equal(f.nodes.txImportConfirm.textContent, 'Import');
  assert.equal(f.nodes.txImportConfirm.disabled, true);
  assert.equal(f.state.txImportOpen, true);
  assert.equal(f.events.length, 1);
});

test('an invalid file lists the server errors, writes nothing and does not reload', async () => {
  const f = fixture(() => ({ ok: false, error: 'invalid_csv_rows', errors: ['Row 4: missing tx_type', 'Row 7: unknown account: "<b>" (source_account)'] }));
  f._chooseTxImportFile(file(RAW));
  await f._submitTxImport(f.snapshot().file);
  const html = f.nodes.txImportStatus.innerHTML;
  assert.match(html, /Some rows in the file are invalid\. Nothing was imported\./);
  assert.match(html, /<li>Row 4: missing tx_type<\/li>/);
  assert.match(html, /<li>Row 7: unknown account: &quot;&lt;b&gt;&quot; \(source_account\)<\/li>/);
  assert.equal(f.events.length, 0);
  assert.equal(f.state.txImportOpen, true);
});

test('a file-level error without results is shown as a message', async () => {
  const f = fixture(() => ({ ok: false, error: 'csv_has_no_rows' }));
  await f._submitTxImport(file('id\n'));
  assert.match(f.nodes.txImportStatus.innerHTML, /header row but no transactions/);
  assert.equal(f.events.length, 0);
});

test('rows without an id are called out after import and keep the panel open', async () => {
  const f = fixture(() => ({ ok: true, created: 3, updated: 0, failed: 0, rows: 3, without_id: 2, results: [1, 2, 3].map(line => ({ ok: true, action: 'created', line })) }));
  await f._submitTxImport(file(RAW));
  assert.match(f.nodes.txImportStatus.innerHTML, /2 rows have no id; every import of this file inserts them as new transactions\. Export after importing/);
  assert.equal(f.state.txImportOpen, true);
  assert.equal(f.events.length, 1);
});

test('an interrupted or incomplete response reloads and warns that rows may have been saved', async () => {
  for (const respond of [() => { throw new Error('connection_error'); }, () => ({ ok: true })]) {
    const f = fixture(respond);
    await f._submitTxImport(file(RAW));
    assert.match(f.snapshot().result, /Some rows may have been saved/);
    assert.equal(f.snapshot().busy, false);
    assert.equal(f.events.length, 1);
    assert.equal(f.requests.length, 1);
  }
});

test('an unreadable file sends nothing and a busy import ignores a second submit', async () => {
  const unreadable = fixture(() => { throw new Error('unexpected'); });
  await unreadable._submitTxImport({ text: async () => { throw new Error('gone'); } });
  assert.match(unreadable.nodes.txImportStatus.innerHTML, /Could not read this CSV/);
  assert.equal(unreadable.requests.length, 0);
  let release;
  const f = fixture(() => new Promise(resolve => { release = () => resolve({ ok: true, created: 1, updated: 0, failed: 0, without_id: 0, results: [{ ok: true, action: 'created', line: 2 }] }); }));
  const first = f._submitTxImport(file(RAW));
  await new Promise(resolve => setImmediate(resolve));
  f._chooseTxImportFile(file('other'));
  await f._submitTxImport(file(RAW));
  release(); await first;
  assert.equal(f.requests.length, 1);
});
