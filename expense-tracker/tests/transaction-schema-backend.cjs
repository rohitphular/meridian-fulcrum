// The transaction schema the client receives (get_app_context schemas.transaction)
// comes straight from the GAS field registry. (The browser schema cache in
// app/core/schema.js was removed in phase 5: schemas arrive with every refresh.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('transaction schema exposes lifecycle values directly from its GAS field registry', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api/transaction-schema.gs'), 'utf8'), context);
  const statuses = vm.runInContext('TRANSACTION_SCHEMA.record_status.enum_values', context);
  const schema = context.getTransactionSchemaForClient();
  assert.deepEqual(Array.from(schema.record_statuses), Array.from(statuses));
  assert.notEqual(schema.record_statuses, statuses);
});
