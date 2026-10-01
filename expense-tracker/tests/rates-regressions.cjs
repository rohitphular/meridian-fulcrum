const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
// isFiniteDecimal only: the rest of app-utils.gs would replace the Sheet stubs below.
const appUtils = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'api', 'app-utils.gs'), 'utf8'), appUtils);
function runtime(initial) {
  const rows = initial.map(row => row.slice());
  let writes = 0;
  const columns = ['currency', 'rate', 'symbol', 'updated_at'];
  const sheet = {
    getRange(start, column, count, width) { return { setValues(values) {
      assert.equal(column, 1); assert.equal(width, 4); assert.equal(count, values.length);
      writes++;
      values.forEach((row, index) => { rows[start - 2 + index] = row.slice(); });
    } }; },
    getDataRange() { return { getValues: () => [columns, ...rows] }; },
    deleteRow(row) { rows.splice(row - 2, 1); writes++; },
  };
  const ctx = vm.createContext({console, RATES_SHEET: 'rates', ACCOUNTS_SHEET: 'account_master', getRateSheetColumns: () => columns,
    getOrCreateSheet: () => sheet, sheetToObjects: () => rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    rateColIndex: field => columns.indexOf(field), isFiniteDecimal: appUtils.isFiniteDecimal,
  });
  for (const file of ['view-context.gs','rate-validation.gs','rate-core.gs']) vm.runInContext(fs.readFileSync(path.join(root, 'api', file), 'utf8'), ctx);
  return {ctx, rows, writes: () => writes};
}
test('legacy GBP rates normalise to XAU without changing pair ratios or writing on read', () => {
  const {ctx, writes} = runtime([['GBP',1,'£','old'],['XAU',0.013,'⊕','old'],['INR',105,'₹','old']]);
  const rates = ctx.listRates();
  assert.equal(rates.find(row => row.currency === 'XAU').rate, 1);
  assert.ok(Math.abs(rates[2].rate / rates[0].rate - 105) < 1e-10);
  assert.equal(writes(),0);
});
test('upsert persists all legacy rates on one XAU basis and preserves symbols', () => {
  const {ctx, rows, writes} = runtime([['GBP',1,'£','old'],['XAU',0.013,'⊕','old'],['INR',105,'₹','old']]);
  assert.equal(ctx.upsertRate({currency:'gbp', rate:80}).ok, true);
  assert.equal(rows[0][1],80); assert.equal(rows[0][2],'£'); assert.equal(rows[1][1],1);
  assert.equal(rows[2][1],105/0.013); assert.equal(writes(),1);
  assert.equal(ctx.listRates()[0].rate,80);
});
test('implicit XAU base is exposed as rate one, and empty store seeds XAU-relative defaults', () => {
  const {ctx} = runtime([['GBP',80,'£','old']]);
  assert.equal(ctx.listRates()[1].currency,'XAU'); assert.equal(ctx.listRates()[1].rate,1);
  const fresh = runtime([]); assert.equal(fresh.ctx.listRates().find(row => row.currency === 'XAU').rate,1);
});
test('invalid inputs and invalid existing tables never write', () => {
  for (const rate of [NaN,Infinity,-1,0,'bad','']) {
    const {ctx,writes} = runtime([]); assert.equal(ctx.upsertRate({currency:'USD',rate}).ok,false); assert.equal(writes(),0);
  }
  const {ctx,writes} = runtime([['XAU',0,'⊕','old']]);
  assert.equal(ctx.upsertRate({currency:'USD',rate:80}).error,'invalid_rate_table'); assert.equal(writes(),0);
  assert.equal(ctx.upsertRate({currency:' xau ',rate:2}).error,'base_currency_readonly');
});
test('rate deletion looks up current account currency field and blocks used currency', () => {
  const {ctx,writes} = runtime([['USD',80,'$','old']]);
  ctx.getAccountSheetColumns = () => ['id','account_currency_local'];
  ctx.acctColIndex = field => { assert.equal(field,'account_currency_local'); return 1; };
  ctx.getOrCreateSheet = () => ({getDataRange: () => ({getValues: () => [['id','account_currency_local'],['a','USD']]})});
  assert.equal(ctx.deleteRate({currency:'usd'}).error,'currency_in_use_by_accounts'); assert.equal(writes(),0);
});
// Conversion rules (zero kept, NaN for invalid input) are server-side: fx-utils-backend.cjs.

// R31: the add form sends mode 'create' and raw text; upsertRate owns "already
// exists" and rate > 0 (form-validation-backend.cjs). Errors render verbatim.
test('rate forms submit as entered and render the server message on the named field', async () => {
  const source = fs.readFileSync(path.join(root, 'app/sections/rates.js'), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
  assert.doesNotMatch(source, /already exists — use Edit|Rate must be a positive number|parseFloat\(el\('rate(New|Edit)Rate/);
  const classes = {};
  const elements = { rateAddError: { textContent: '' }, rateEditError: { textContent: '' }, rateSaveNew: { disabled: false, textContent: 'Save' }, rateSaveEdit: { disabled: false, textContent: 'Save' } };
  for (const [id, value] of Object.entries({ rateNewCurrency: ' gbp ', rateNewSymbol: '', rateNewRate: ' 0x10 ', rateEditSymbol: '£', rateEditRate: '' })) {
    classes[id] = new Set();
    elements[id] = { value, closest: selector => (selector === '.field' ? { classList: { add: name => classes[id].add(name) } } : null) };
  }
  const requests = [];
  const responses = [
    { ok: false, error: 'rate_already_exists', field: 'currency', message: 'This currency already exists. Use Edit to update it.' },
    { ok: false, error: 'missing_rate', field: 'rate', message: 'Rate is required.' },
  ];
  const ctx = importResultHelpers.context({ console: { log() {}, warn() {}, error() {} }, state: { rates: [{ currency: 'GBP', rate: 80 }] },
    el: id => elements[id] ?? null, showLoading() {}, hideLoading() {}, showMsg() {},
    document: { dispatchEvent() { throw new Error('no reload on failure'); } }, CustomEvent: class {},
    ExpenseAPI: { upsertRate: async body => { requests.push(body); return responses.shift(); } } });
  vm.runInContext(source + '\nthis.exposed = {_saveNewRate,_saveEdit};', ctx);
  await ctx.exposed._saveNewRate();
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { currency: 'GBP', symbol: '', rate: '0x10', mode: 'create' });
  assert.equal(elements.rateAddError.textContent, 'This currency already exists. Use Edit to update it.');
  assert.equal(classes.rateNewCurrency.has('error'), true);
  assert.equal(elements.rateSaveNew.disabled, false);
  await ctx.exposed._saveEdit('GBP');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1])), { currency: 'GBP', rate: '', symbol: '£' });
  assert.equal(elements.rateEditError.textContent, 'Rate is required.');
  assert.equal(classes.rateEditRate.has('error'), true);
});
