// categories.js renders list_categories_view / get_category_form_options only:
// filters, sort and paging become request params; menus follow allowed_actions;
// the hint checkboxes come from the server groups.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importResultHelpers = require('./support/import-result.cjs');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../app/sections/categories.js'), 'utf8')
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport (?=(?:async )?function|const|let)/g, '');
const uuid = n => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const statuses = ['active', 'inactive', 'deleted', 'locked'];
const OPTIONS = {
  types: [{ value: 'money-in', label: 'Money In' }, { value: 'money-out', label: 'Money Out' }],
  account_type_hint_groups: [{ type: 'custom', label: '<Custom>', hints: [{ value: 'custom-key', label: 'Configured <label>' }, { value: 'other', label: 'Other' }] }],
  statuses_for_add: [{ value: 'active', label: 'Active' }],
  statuses_for_edit: statuses.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
};
const row = (n, extra = {}) => ({ id: uuid(n), _row: n + 1, row_num: n + 1, updated_at: '2026-09-01T00:00:00.000Z', tx_type_key: 'money-out', type_badge: 'out',
  major_category_key: 'food', major_category_label: 'Food', minor_category_key: 'm' + n, minor_category_label: 'Minor ' + n, record_status: 'active', sync_status: 'in-sync',
  source_account_types: 'custom-key', target_account_types: '', allowed_actions: ['view', 'edit', 'transactions', 'delete'], transactions_filter: { major: ['food'], minor: ['m' + n] }, ...extra });
const listResponse = rows => ({ ok: true, quote: { currency: 'GBP', symbol: '£' }, warnings: [], data: {
  rows, count: rows.length, total: rows.length, page: 1, page_size: 'all', pages: 1, active_filter_count: 0,
  facets: { types: OPTIONS.types, majors: [{ key: 'food', label: 'Food' }, { key: 'travel', label: 'Travel <x>' }],
    minors_by_major: { food: [{ key: 'm1', label: 'Minor 1' }], travel: [{ key: 'rail', label: 'Rail <r>' }] }, statuses: statuses.map(value => ({ value, label: value })) } } });

function fixture(overrides = {}) {
  const state = { views: {}, categorySchema: { types: OPTIONS.types, record_statuses: statuses }, catImportOpen: false, catImportBusy: false, catImportReport: null,
    catAddOpen: false, catViewRow: null, catEditRow: null, catDeleteRow: null, catFilterOpen: false,
    catFilters: { type: 'all', major: 'all', minor: 'all', search: '', sourceMandatory: 'all', targetMandatory: 'all', subscriptionEligible: 'all', recordStatuses: statuses.slice() }, ...overrides };
  const node = () => ({ innerHTML: '', textContent: '', value: '', disabled: false, style: {}, handlers: {}, dataset: {},
    addEventListener(event, callback) { this.handlers[event] = callback; }, querySelector() { return null; }, querySelectorAll() { return []; } });
  const elements = {};
  const views = [], exports = [], menus = [], events = [], requests = [];
  const api = { view: async (action, params) => { views.push({ action, params: JSON.parse(JSON.stringify(params)) }); return api.respond(action, params); },
    respond: action => (action === 'get_category_form_options' ? { ok: true, data: OPTIONS } : listResponse([row(1)])),
    updateCategory: async body => { requests.push(JSON.parse(JSON.stringify(body))); return { ok: true }; },
    deleteCategory: async body => { requests.push(JSON.parse(JSON.stringify(body))); return { ok: true }; } };
  const context = importResultHelpers.context({
    state, ExpenseAPI: api, el: id => (elements[id] ??= node()), console: { log() {}, warn() {}, error() {} },
    openContextMenu: (button, items, select) => { menus.push(items.map(item => item.key)); if (button.pick) select(button.pick); },
    closeContextMenu() {}, exportCategories: (format, rows) => exports.push({ format, rows }),
    recordStatusIcon: value => value, syncStatusIcon: () => '', showLoading() {}, hideLoading() {}, showMsg() {},
    document: { dispatchEvent: event => events.push(event), addEventListener() {}, removeEventListener() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  vm.runInContext(source + '\nthis.exposed = {renderCategories,_render,_renderForm,_renderCatFilterBar,_listParams,_loadList,_loadFormOptions,_attachListEvents,_attachFilterEvents,_restoreCat,_deleteCat,_export,setOptions:data=>{_formOptions=data;}};', context);
  return { ...context.exposed, state, elements, views, exports, menus, events, requests, api };
}
const flush = () => new Promise(done => setImmediate(done));

test('the section keeps no client filter, facet scan or hint grouping logic', () => {
  assert.doesNotMatch(source, /_applyFilters|_activeFilterCount|_acctTypeGroups|_accountHintLabel|state\.categories|state\.accountSchema|account_type_hints/);
});

test('filters, sort and paging travel as view params; an empty status selection is explicit', async () => {
  const f = fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(f._listParams())), { search: '', sort_col: 'row_num', sort_dir: 'asc', page: 1, page_size: 'all' });
  f.state.catFilters = { type: 'money-in', major: 'food', minor: 'm1', search: 'x', sourceMandatory: 'yes', targetMandatory: 'no', subscriptionEligible: 'yes', recordStatuses: ['active'] };
  assert.deepEqual(JSON.parse(JSON.stringify(f._listParams())), { type: 'money-in', major: 'food', minor: 'm1', search: 'x', source_mandatory: 'yes', target_mandatory: 'no',
    subscription_eligible: 'yes', statuses: ['active'], sort_col: 'row_num', sort_dir: 'asc', page: 1, page_size: 'all' });
  f.state.catFilters.recordStatuses = [];
  assert.equal(f._listParams().statuses, 'none');
  f.renderCategories();
  await flush();
  assert.equal(f.views.at(-1).action, 'list_categories_view');
  assert.match(f.elements.catListWrap.innerHTML, /1 category/);
  assert.match(f.elements.catListWrap.innerHTML, /data-cat-sort="major_category_label"/);
});

test('the filter bar renders server facets; choosing a major repopulates minors from the facets', async () => {
  const f = fixture({ catFilterOpen: true });
  f.state.views.list_categories_view = listResponse([row(1)]);
  const html = f._renderCatFilterBar();
  assert.match(html, /value="travel"> Travel &lt;x&gt;/);
  f._attachFilterEvents();
  f.elements.catFMajorMenu.handlers.change({ target: { closest: () => ({ value: 'travel' }) } });
  assert.match(f.elements.catFMinorMenu.innerHTML, /value="rail"> Rail &lt;r&gt;/);
  assert.equal(f.elements.catFMajorLabel.textContent, 'Travel <x>');
  f.elements.catFSearch.value = ' rail ';
  f.elements.catFSearchBtn.handlers.click();
  await flush();
  assert.equal(f.state.catFilters.major, 'travel');
  assert.deepEqual([f.views.at(-1).params.major, f.views.at(-1).params.search], ['travel', 'rail']);
});

test('row menus follow allowed_actions and the transactions link uses the server filter', () => {
  const f = fixture();
  f.state.views.list_categories_view = listResponse([row(1), row(2, { record_status: 'locked', allowed_actions: ['view', 'transactions'] })]);
  f._render();
  const content = f.elements.categoriesContent;
  const wrap = { handlers: {}, addEventListener(event, callback) { this.handlers[event] = callback; } };
  content.querySelector = selector => (selector === '.cat-table-wrap' ? wrap : null);
  f._attachListEvents();
  // Rows are addressed by id (data-row carries the UUID, never the Sheet row).
  const click = (id, pick) => wrap.handlers.click({ target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'cat-menu', row: id }, pick } : null) } });
  click(uuid(2));
  assert.deepEqual(f.menus.at(-1), ['view', 'transactions']);
  click(uuid(1), 'transactions');
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.filters)), { types: [], accounts: [], major: ['food'], minor: ['m1'], user_location_country: '', tag: '', search: '' });
  assert.equal(f.events.at(-1).type, 'et:show-section');
});

test('forms wait for options, then render server hint groups, labels and status choices', async () => {
  const f = fixture({ catAddOpen: true });
  assert.match(f._renderForm({}, 'add'), /Loading form…/);
  await f._loadFormOptions();
  assert.equal(f.views.at(-1).action, 'get_category_form_options');
  const add = f.elements.catFormWrap.innerHTML;
  assert.match(add, /acct-type-group-label">&lt;Custom&gt;/);
  assert.match(add, /data-acct-type="custom-key" [^>]*> Configured &lt;label&gt;/);
  assert.match(add, /<option value="active" selected>Active<\/option>/);
  assert.doesNotMatch(add, /value="deleted"/);
  const view = f._renderForm(row(1, { allowed_actions: ['view', 'transactions', 'restore'], record_status: 'deleted' }), 'view');
  assert.match(view, /data-acct-type="custom-key" checked disabled/);
  assert.match(view, /id="catViewRestore"/);
  assert.doesNotMatch(view, /id="catViewToEdit"/);
});

test('export requests every filtered row; mutations carry the displayed identity', async () => {
  const f = fixture();
  f.state.catFilters.search = 'minor';
  f.api.respond = () => listResponse([row(1), row(2)]);
  await f._export('csv');
  assert.deepEqual([f.views.at(-1).params.page_size, f.views.at(-1).params.search], ['all', 'minor']);
  assert.equal(f.exports[0].rows.length, 2);
  f.state.views.list_categories_view = listResponse([row(1), row(2, { record_status: 'deleted' })]);
  await f._restoreCat(uuid(2));
  await f._deleteCat(uuid(1));
  assert.deepEqual([f.requests[0].row_num, f.requests[0].id, f.requests[0].updated_at, f.requests[0].record_status], [3, uuid(2), '2026-09-01T00:00:00.000Z', 'active']);
  assert.deepEqual(f.requests[1], { row_num: 2, id: uuid(1), updated_at: '2026-09-01T00:00:00.000Z' });
});

test('a failed list response shows the server message and keeps the last loaded rows', async () => {
  const f = fixture();
  f.state.views.list_categories_view = listResponse([row(1)]);
  f._render();
  f.api.respond = () => ({ ok: false, error: 'invalid_filter', field: 'type', message: 'Choose a <type>.' });
  await f._loadList();
  assert.match(f.elements.catListWrap.innerHTML, /Choose a &lt;type&gt;\. Showing the last loaded list\./);
  assert.match(f.elements.catListWrap.innerHTML, /Minor 1/);
});

test('opening a form always refreshes options, but an unchanged refresh keeps typed input', async () => {
  const f = fixture({ catAddOpen: true });
  f.setOptions(OPTIONS);
  f.elements.catFormWrap = { innerHTML: 'form with typed input' };
  await f._loadFormOptions();
  assert.equal(f.elements.catFormWrap.innerHTML, 'form with typed input');
  f.api.respond = () => ({ ok: true, data: { ...OPTIONS, account_type_hint_groups: [{ type: 'asset', label: 'Asset', hints: [{ value: 'new-sub', label: 'New subtype' }] }] } });
  await f._loadFormOptions();
  assert.match(f.elements.catFormWrap.innerHTML, /data-acct-type="new-sub"/);
});

test('the viewed row snapshot survives a filter that hides it, and menu lookups on other rows do not replace it', async () => {
  const f = fixture({ catEditRow: uuid(1) });
  f.state.views.list_categories_view = listResponse([row(1), row(2)]);
  f._render();
  f.state.views.list_categories_view = listResponse([row(2)]);   // edited row filtered out
  const wrap = { handlers: {}, addEventListener(event, callback) { this.handlers[event] = callback; } };
  f.elements.categoriesContent.querySelector = selector => (selector === '.cat-table-wrap' ? wrap : null);
  f._attachListEvents();
  wrap.handlers.click({ target: { closest: selector => (selector === '[data-action]' ? { dataset: { action: 'cat-menu', row: uuid(2) } } : null) } });
  await f._deleteCat(uuid(1));
  assert.equal(f.requests.at(-1).id, uuid(1));
});
