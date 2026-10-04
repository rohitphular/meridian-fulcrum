// Rates are published by forex-database-load (mode publish-sheet) and are
// read-only in the app: GAS reads the tab, never creates, seeds or edits it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

function runtime(initial) {
  const columns = ['currency', 'rate', 'symbol', 'updated_at', 'rate_date'];
  const rows = initial === null ? null : initial.map(row => row.slice());
  let writes = 0;
  const sheet = rows === null ? null : {
    getRange() { return { setValues() { writes++; } }; },
    getDataRange() { return { getValues: () => [columns, ...rows] }; },
  };
  const ctx = vm.createContext({ console, RATES_SHEET: 'rates',
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => (name === 'rates' ? sheet : null), insertSheet() { writes++; } }) },
    sheetToObjects: tab => tab.getDataRange().getValues().slice(1).map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'api', 'rate-core.gs'), 'utf8'), ctx);
  return { ctx, writes: () => writes };
}

test('published rates are read as they are, with their rate date, and reading never writes', () => {
  const { ctx, writes } = runtime([['XAU', 1, '⊕', '2026-10-04T06:30:00Z', '2026-10-03'], ['GBP', 76.9, '£', '2026-10-04T06:30:00Z', '2026-10-03']]);
  const rates = ctx.listRates();
  assert.deepEqual(JSON.parse(JSON.stringify(rates.map(row => [row.currency, row.rate, row.rate_date]))), [['XAU', 1, '2026-10-03'], ['GBP', 76.9, '2026-10-03']]);
  assert.equal(writes(), 0);
});

test('legacy GBP-relative tables are still normalised to XAU on read, without writing', () => {
  const { ctx, writes } = runtime([['GBP', 1, '£', 'old', ''], ['XAU', 0.013, '⊕', 'old', ''], ['INR', 105, '₹', 'old', '']]);
  const rates = ctx.listRates();
  assert.equal(rates.find(row => row.currency === 'XAU').rate, 1);
  assert.ok(Math.abs(rates[2].rate / rates[0].rate - 105) < 1e-10);
  assert.equal(writes(), 0);
});

test('a missing or empty tab reads as XAU only and is never created or seeded', () => {
  for (const initial of [null, []]) {
    const { ctx, writes } = runtime(initial);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.listRates().map(row => [row.currency, row.rate]))), [['XAU', 1]]);
    assert.equal(writes(), 0);
  }
  assert.throws(() => runtime([['XAU', 0, '⊕', '', '']]).ctx.listRates(), /invalid_rate_table/);
});

test('nothing in the app can edit rates: no routes, no functions, no edit UI', () => {
  const api = fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.gs')).map(name => fs.readFileSync(path.join(root, 'api', name), 'utf8')).join('\n');
  assert.doesNotMatch(api, /upsert_rate|delete_rate|function upsertRate|function deleteRate|DEFAULT_RATES = /);
  assert.equal(fs.existsSync(path.join(root, 'api', 'rate-validation.gs')), false);
  const client = fs.readFileSync(path.join(root, 'app/core/api.js'), 'utf8') + fs.readFileSync(path.join(root, 'app/sections/rates.js'), 'utf8');
  assert.doesNotMatch(client, /upsertRate|deleteRate|rateAddBtn|rate-menu|openContextMenu/);
});
