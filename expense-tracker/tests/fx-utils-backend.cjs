// fx-utils.gs is the only currency conversion (the client toBase / toQuote /
// getSymbol were removed in phase 5). It consumes
// the XAU-normalised rows from listRates() (rate-core.gs), as rates-regressions.cjs covers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { gasRuntime } = require('./support/gas-runtime.cjs');

const { ctx } = gasRuntime({ files: ['fx-utils.gs'] });
const plain = value => JSON.parse(JSON.stringify(value));

function rateRuntime(initial) {
  const columns = ['currency', 'rate', 'symbol', 'updated_at'];
  const rows = initial.map(row => row.slice());
  let writes = 0;
  const sheet = { getRange: () => ({ setValues() { writes++; } }), getDataRange: () => ({ getValues: () => [columns, ...rows] }) };
  const context = vm.createContext({ console, RATES_SHEET: 'rates', getRateSheetColumns: () => columns, getOrCreateSheet: () => sheet,
    sheetToObjects: () => rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))) });
  for (const file of ['rate-core.gs', 'fx-utils.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), context);
  return { context, writes: () => writes };
}

test('conversion preserves zero but never substitutes zero or 1:1 for invalid values', () => {
  const rates = { GBP: 80, XAU: 1 };
  assert.equal(ctx.fxConvert(0, 'GBP', null, rates, 'XAU'), 0);
  assert.equal(ctx.fxConvert(160, 'GBP', null, rates, 'XAU'), 2);
  assert.ok(Number.isNaN(ctx.fxConvert('bad', 'GBP', null, rates, 'XAU')));
  assert.ok(Number.isNaN(ctx.fxToQuote(12, 'GBP', { GBP: Infinity, XAU: 1 }, 'XAU')));
  for (const amount of ['', null, undefined, '12oops']) assert.ok(Number.isNaN(ctx.fxConvert(amount, 'GBP', null, rates, 'XAU')));
  assert.ok(Number.isNaN(ctx.fxConvert(12, 'GBP', Infinity, rates, 'XAU')));
  assert.equal(ctx.fxConvert(12, 'GBP', 4, rates, 'XAU'), 3);
  assert.ok(Number.isNaN(ctx.fxToQuote(12, 'USD', rates, 'XAU')));
  assert.ok(Number.isNaN(ctx.fxToQuote(12, 'GBP', rates, 'USD')));
});

// Goldens verified equal to the old client toBase / toQuote (deleted from
// _shared/utils.js in phase 5): XAU-relative pair ratios, NaN (never 1:1 or 0)
// for a missing, non-positive or unknown rate and for non-numeric amounts.
test('server conversion goldens across currencies, quotes and invalid inputs', () => {
  const rates = { GBP: 80, INR: 8400, USD: 101.5, XAU: 1, BAD: -1 };
  const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9;
  const cases = [
    [0, 'GBP', 'INR', 0], [1, 'GBP', 'INR', 105], [12.345, 'INR', 'GBP', 12.345 / 105], [-40, 'USD', 'GBP', -40 / 101.5 * 80],
    ['17.5', 'XAU', 'GBP', 1400], [1, 'GBP', 'XAU', 1 / 80], [1, 'GBP', 'GBP', 1],
    ['', 'GBP', 'INR', NaN], ['x', 'GBP', 'INR', NaN], [null, 'GBP', 'INR', NaN],
    [1, 'BAD', 'GBP', NaN], [1, 'NOPE', 'GBP', NaN], [1, 'GBP', 'NOPE', NaN], [1, 'GBP', 'BAD', NaN],
  ];
  for (const [amount, from, quote, expected] of cases) {
    assert.ok(same(ctx.fxToQuote(amount, from, rates, quote), expected), ['toQuote', amount, from, quote].join(' '));
    assert.ok(same(ctx.fxConvert(amount, from, null, rates, quote), expected), ['convert', amount, from, quote].join(' '));
  }
});

test('legacy GBP-relative tables are normalised once by listRates and convert with the same pair ratios', () => {
  const { context, writes } = rateRuntime([['GBP', 1, '£', 'old'], ['XAU', 0.013, '⊕', 'old'], ['INR', 105, '₹', 'old']]);
  const fx = context.fxContext(context.listRates(), 'GBP');
  assert.equal(fx.rate_map.XAU, 1);
  assert.ok(Math.abs(context.fxToQuote(105, 'INR', fx.rate_map, 'GBP') - 1) < 1e-12);
  assert.ok(Math.abs(context.fxToQuote(1, 'XAU', fx.rate_map, 'GBP') - 1 / 0.013) < 1e-9);
  assert.equal(writes(), 0);
  const implicit = rateRuntime([['GBP', 80, '£', 'old']]);
  const implicitFx = implicit.context.fxContext(implicit.context.listRates(), 'XAU');
  assert.equal(implicitFx.rate_available, true);
  assert.equal(implicit.context.fxToQuote(160, 'GBP', implicitFx.rate_map, 'XAU'), 2);
});

test('money fields, symbols and missing-rate warnings', () => {
  const fx = ctx.fxContext([{ currency: 'gbp', rate: 80, symbol: '£' }, { currency: 'XAU', rate: 1, symbol: '⊕' }, { currency: 'INR', rate: 'bad', symbol: '₹' }], 'gbp');
  assert.equal(fx.quote_currency, 'GBP');
  assert.equal(fx.quote_symbol, '£');
  assert.deepEqual(plain(ctx.fxMoney(2, 'XAU', fx)), { native: 2, currency: 'XAU', currency_symbol: '⊕', quote: 160 });
  assert.deepEqual(plain(ctx.fxMoney(5, 'INR', fx)), { native: 5, currency: 'INR', currency_symbol: '₹', quote: null });
  assert.deepEqual(plain(ctx.fxMoney('x', 'USD', fx)), { native: null, currency: 'USD', currency_symbol: 'USD ', quote: null });
  assert.equal(ctx.fxSymbol('', fx.symbols), '');
  assert.deepEqual(plain(ctx.fxMissingRates(['GBP', 'INR', 'usd', '', 'INR'], fx)), ['INR', 'USD']);
  assert.equal(ctx.fxMissingRateWarning(['GBP', 'XAU'], fx), null);
  const noQuote = ctx.fxContext([{ currency: 'GBP', rate: 80 }], 'EUR');
  assert.equal(noQuote.rate_available, false);
  assert.deepEqual(plain(ctx.fxMissingRates(['GBP'], noQuote)), ['EUR', 'GBP']);
});
