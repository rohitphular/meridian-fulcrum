const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const cacheKey = 'et_transaction_schema_v1';
function fixture(cached, responses) {
  const storage = new Map(cached === undefined ? [] : [[cacheKey, JSON.stringify(cached)]]);
  let calls = 0;
  const context = vm.createContext({
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    ExpenseAPI: { getTransactionSchema: async () => ({ ok: true, data: responses[calls++] }) },
    console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../app/core/schema.js'), 'utf8')
    .replace(/^import .*;\s*/gm, '').replace(/export /g, '');
  vm.runInContext(source, context);
  return { load: () => context.loadTransactionSchema(), storage, calls: () => calls };
}

test('transaction schema exposes lifecycle values directly from its GAS field registry', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api/transaction-schema.gs'), 'utf8'), context);
  const statuses = vm.runInContext('TRANSACTION_SCHEMA.record_status.enum_values', context);
  const schema = context.getTransactionSchemaForClient();
  assert.deepEqual(Array.from(schema.record_statuses), Array.from(statuses));
  assert.notEqual(schema.record_statuses, statuses);
});

test('legacy transaction schema cache refreshes before CSV lifecycle validation', async () => {
  const current = { types: [], record_statuses: ['custom-status'] };
  const context = fixture({ types: [] }, [current]);
  assert.equal(await context.load(), current);
  assert.equal(context.calls(), 1);
  assert.deepEqual(JSON.parse(context.storage.get(cacheKey)), current);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.load())), current);
  assert.equal(context.calls(), 1);
});

test('an old backend response cannot remain cached after backend deployment', async () => {
  const old = { types: [] };
  const current = { types: [], record_statuses: ['active'] };
  const context = fixture(old, [old, current]);
  assert.equal(await context.load(), old);
  assert.equal(await context.load(), current);
  assert.equal(context.calls(), 2);
});
