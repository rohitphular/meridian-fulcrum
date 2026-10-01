// ExpenseAPI.view: attaches quote_currency + browser tz, serialises params and
// refuses names that SheetsClient / the server reserve for auth and audit meta.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadApi(state, requests) {
  const source = fs.readFileSync(path.join(__dirname, '../app/core/api.js'), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport (?=const|function)/g, '');
  const context = vm.createContext({ state, Intl, SheetsClient: { get: async params => { requests.push(params); return { ok: true }; }, post: async () => ({ ok: true }) } });
  vm.runInContext(source + '\nglobalThis.exposed = ExpenseAPI;', context);
  return context.exposed;
}

test('view() attaches quote_currency and tz and serialises params', async () => {
  const requests = [];
  const api = loadApi({ quoteCurrency: 'INR' }, requests);
  await api.view('list_transactions_view', { types: ['money-in', 'money-out'], drill: { major: 'food' }, page: 2, search: '', tag: null, sort_dir: undefined, accounts: [] });
  const sent = requests.at(-1);
  assert.equal(sent.action, 'list_transactions_view');
  assert.equal(sent.quote_currency, 'INR');
  assert.equal(sent.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(sent.types, 'money-in,money-out');
  assert.equal(sent.drill, '{"major":"food"}');
  assert.equal(sent.page, '2');
  for (const key of ['search', 'tag', 'sort_dir', 'accounts']) assert.equal(Object.prototype.hasOwnProperty.call(sent, key), false, key);
  await api.view('get_home_view', { quote_currency: 'GBP', tz: 'UTC', today: '2026-09-30' });
  assert.deepEqual({ ...requests.at(-1) }, { quote_currency: 'GBP', tz: 'UTC', today: '2026-09-30', action: 'get_home_view' });
  await api.getAppContext();
  assert.equal(requests.at(-1).action, 'get_app_context');
});

test('view() refuses reserved param names instead of letting them be overwritten', () => {
  const api = loadApi({ quoteCurrency: 'GBP' }, []);
  for (const key of ['action', 'pin', 'totp', 'ip', 'city', 'country', 'ua', '_']) {
    assert.throws(() => api.view('list_transactions_view', { [key]: 'x' }), new RegExp('reserved_view_param:' + key.replace('_', '\\_')), key);
  }
});
