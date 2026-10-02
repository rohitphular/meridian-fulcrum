import { state } from '../core/state.js';
import { el, esc, fmtDateTime, fmtDateTimeCompact, nowLocalISO, downloadExport, openContextMenu, closeContextMenu, syncStatusIcon, recordStatusIcon, renderImportResult, importErrorText, clearFormError, showFormError } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// Transactions render what the server returns (api/view-transactions.gs):
// - list_transactions_view: filtered / sorted / paged rows
// - get_transaction_facets: filter-bar options (once per data refresh)
// - get_transaction(id): the view panel
// - get_transaction_form_options: add / edit option trees (category rules,
//   eligible accounts per leg); the form only looks values up in the tree
// - get_transaction_prefill: copy and mark-as-subscription
// - export_transactions: compact import rows, downloaded as-is
// The browser keeps UI state only: the applied query, the filter draft, the
// open panel, and optional enrichment (geocoding, tag autocomplete).

const SUGGESTIONS_CACHE_KEY = 'et_suggestions_v3';
const SUGGESTIONS_TTL_MS    = 6 * 60 * 60 * 1000;

const _DEFAULT_FILTERS = () => ({
  range: 'last_30', from: '', to: '', types: [], account_ids: [], account_types: [], major: [], minor: [],
  user_location_country: '', user_location_city: '', user_location_area: '', tag: '', counterparty: '', search: '',
});
const _ACTION_LABELS = { view: 'View', edit: 'Edit', copy: 'Copy', delete: 'Delete', restore: 'Restore', subscribe: 'Subscribe' };
const _ACTION_KEYS   = { view: 'tx-view', edit: 'tx-edit', copy: 'tx-copy', delete: 'tx-delete', restore: 'tx-restore', subscribe: 'tx-mark-sub' };

let filterOpen         = false;
let _txImportFile   = null;   // file chosen in the import panel; read only on Import
let _txImportBusy = false;
let _filterEventsAbort = null;
let _txImportResult  = null;   // persists the import outcome HTML across re-renders
let _txMenuKey      = null;
let _txEventsAbort  = null;

// Applied query (sent to list_transactions_view) and the filter-bar draft.
let _query = { ..._DEFAULT_FILTERS(), sort_col: 'tx_date_local', sort_dir: 'desc', page: 1, page_size: 50 };
let _draft = null;
let _list = null;            // last list_transactions_view data
let _listError = null;
let _listKey = null;         // request key of the list on screen / in flight
let _listSeq = 0;            // newest list request; older responses are dropped
let _reloadSrc = null;       // state.context identity last seen: loadAll replaces it on every refresh
let _reloadGen = 0;
let _facets = null;          // last get_transaction_facets data (filter-bar options, page sizes)
let _facetsGen = -1;         // _reloadGen the facets were requested for
// Deep-link handoff from other sections: they assign a new state.filters object.
let _filtersSrc = typeof state === 'object' && state !== null ? state.filters : undefined;
// Open panel: { mode: 'add'|'view'|'edit'|'delete', id, row?, detail?, options?, prefill? }
let _panel = null;
let _addOptions = null;      // create-mode form options (reused until the next refresh)

function _transactionError(code) {
  const messages = {
    stale_record: 'This record moved or changed. Refresh, then reopen it before trying again.',
    transfer_parent_deleted: 'A live linked transaction needs its original transfer. Delete the linked transaction first, or restore the original.',
    invalid_transfer_pair: 'A transfer must link different accounts and opposite money-in / money-out directions.',
    invalid_transfer_lifecycle: 'Both legs of a transfer must be deleted together, or both kept. Set record_status for this transfer explicitly.',
    multiple_live_transfer_children: 'This transfer has more than one live linked leg in the Sheet. Delete the extra leg, then import again.',
    // Bulk-import row results carry codes only; these keep their copy readable.
    invalid_tx_date_local: 'Enter a valid local date and time.',
    invalid_tx_timezone_local: 'The transaction timezone is invalid.',
    nonexistent_local_time: 'This time does not exist because the clocks moved forward. Choose a valid time.',
    ambiguous_local_time: 'This time occurs twice when the clocks move back. Choose an unambiguous time.',
    incomplete_location_coordinates: 'Enter both latitude and longitude, or clear both.',
    latitude_out_of_range: 'Latitude must be between −90 and 90.',
    longitude_out_of_range: 'Longitude must be between −180 and 180.',
    unknown_account_id: 'The account is not available. Choose an active account; deleted accounts cannot be used.',
    missing_csv: 'The file is empty.',
    invalid_csv: 'The file is not valid CSV.',
    csv_has_no_rows: 'The file has a header row but no transactions.',
    invalid_csv_headers: 'The CSV header row is not valid.',
    invalid_csv_rows: 'Some rows in the file are invalid.',
  };
  return messages[code] ?? (typeof code === 'string' && code !== '' ? code : '[no error code]');
}

// Server message first; the local map is a fallback for older responses.
function _responseMessage(res) {
  return typeof res?.message === 'string' && res.message !== '' ? res.message : _transactionError(res?.error);
}

function _suggestionKey(suggestion) {
  return suggestion.suggestion_key ?? JSON.stringify([suggestion.counterparty_name, suggestion.major_category, suggestion.minor_category, suggestion.account_id, suggestion.currency]);
}

// ── Query params ──────────────────────────────────────────────────────────────

function _filterParams(query) {
  const params = { range: query.range, types: query.types, account_ids: query.account_ids, account_types: query.account_types,
    major: query.major, minor: query.minor, user_location_country: query.user_location_country, user_location_city: query.user_location_city,
    user_location_area: query.user_location_area, tag: query.tag, counterparty: query.counterparty, search: query.search };
  if (query.range === 'custom') { params.from = query.from; params.to = query.to; }
  return params;
}

function _listParams() {
  return { ..._filterParams(_query), sort_col: _query.sort_col, sort_dir: _query.sort_dir, page: _query.page, page_size: _query.page_size };
}

// Other sections deep-link by assigning a new state.filters object and
// showing this section. Both the legacy shape ({ types, accounts, major,
// minor, … }) and list_transactions_view param names ({ account_ids,
// account_types, counterparty, range, from, to, … }) are accepted; the range
// is kept unless the link names one.
function _consumeDeepLink() {
  if (state.filters === _filtersSrc) return;
  _filtersSrc = state.filters;
  const f = state.filters ?? {};
  const list = value => Array.isArray(value) ? value.slice() : (typeof value === 'string' && value !== '' ? value.split(',') : []);
  const text = value => typeof value === 'string' ? value : '';
  Object.assign(_query, {
    types: list(f.types), account_ids: list(f.account_ids ?? f.accounts), account_types: list(f.account_types),
    major: list(f.major), minor: list(f.minor),
    user_location_country: text(f.user_location_country), user_location_city: text(f.user_location_city),
    user_location_area: text(f.user_location_area), tag: text(f.tag), counterparty: text(f.counterparty), search: text(f.search), page: 1,
  });
  if (typeof f.range === 'string' && f.range !== '') Object.assign(_query, { range: f.range, from: text(f.from), to: text(f.to) });
  _draft = null;
  _panel = null;
}

// ── Loading ───────────────────────────────────────────────────────────────────

function _loadList(key) {
  _listKey = key;
  const seq = ++_listSeq;
  let request;
  try { request = ExpenseAPI.view('list_transactions_view', _listParams()); }
  catch (error) { request = Promise.reject(error); }
  // Every page, sort or filter change waits on the server, so show the loader.
  showLoading();
  Promise.resolve(request).finally(hideLoading).then(res => {
    if (seq !== _listSeq) return;
    if (res?.ok === true) {
      _list = res.data;
      _listError = null;
      state.views.transactions = res;
      // The server clamps an out-of-range page; keep the query (and its key) in step.
      if (Number.isInteger(res.data.page) && res.data.page !== _query.page) {
        _query.page = res.data.page;
        _listKey = _requestKey();
      }
    } else {
      _listError = _responseMessage(res);
      console.warn('[transactions] list_transactions_view failed:', res?.error);
    }
    _renderListRegion();
  }).catch(error => {
    if (seq !== _listSeq) return;
    console.error('[transactions] list_transactions_view failed:', error);
    _listError = 'Connection lost. Refresh to try again.';
    _renderListRegion();
  });
}

// Facets do not depend on the list query, so they load once per data refresh
// instead of riding on every list page.
function _loadFacets() {
  if (_facetsGen === _reloadGen) return;
  const gen = _reloadGen;
  _facetsGen = gen;
  let request;
  try { request = ExpenseAPI.view('get_transaction_facets'); }
  catch (error) { request = Promise.reject(error); }
  Promise.resolve(request).then(res => {
    if (gen !== _reloadGen) return;
    if (res?.ok === true) { _facets = res.data; _renderListRegion(); return; }
    _facetsGen = -1;   // retried on the next render
    console.warn('[transactions] get_transaction_facets failed:', res?.error);
  }).catch(error => {
    if (gen !== _reloadGen) return;
    _facetsGen = -1;
    console.error('[transactions] get_transaction_facets failed:', error);
  });
}

function _loadSuggestions() {
  if (state.suggestionsLoaded) return;
  state.suggestionsLoaded = true;
  try {
    const raw = localStorage.getItem(SUGGESTIONS_CACHE_KEY);
    if (raw !== null && raw !== undefined && raw !== '') {
      const { suggestions, ts } = JSON.parse(raw);
      if (Array.isArray(suggestions) && Date.now() - ts < SUGGESTIONS_TTL_MS) { state.suggestions = suggestions; return; }
      localStorage.removeItem(SUGGESTIONS_CACHE_KEY);
    }
  } catch (_) {}
  state.suggestionsFetching = true;
  ExpenseAPI.getSuggestedTransactions().then(res => {
    state.suggestionsFetching = false;
    if (res.ok) {
      state.suggestions = Array.isArray(res.data) ? res.data : [];
      try { localStorage.setItem(SUGGESTIONS_CACHE_KEY, JSON.stringify({ suggestions: state.suggestions, ts: Date.now() })); } catch (_) {}
    }
    _refreshSuggestionsPanel();
  }).catch(() => {
    state.suggestionsFetching = false;
    _refreshSuggestionsPanel();
  });
}

// Fetches a view for the open panel; drops the answer if the panel changed.
async function _panelRequest(panel, action, params) {
  let res;
  try { res = await ExpenseAPI.view(action, params); }
  catch (error) {
    console.error('[transactions] ' + action + ' failed:', error);
    res = { ok: false, error: 'connection_error', message: 'Connection lost. Refresh to try again.' };
  }
  if (_panel !== panel) return null;
  return res;
}

async function _createOptions() {
  if (_addOptions !== null) return _addOptions;
  let res;
  try { res = await ExpenseAPI.view('get_transaction_form_options', { mode: 'create' }); }
  catch (error) { console.error('[transactions] get_transaction_form_options failed:', error); return null; }
  if (res?.ok !== true) { showMsg(_responseMessage(res), 'warn'); return null; }
  _addOptions = res.data;
  return _addOptions;
}

async function _openAdd(prefill = null) {
  const panel = { mode: 'add', prefill };
  _panel = panel;
  state.txImportOpen = false;
  _txImportFile = null;
  renderTransactions();
  const options = await _createOptions();
  if (_panel !== panel) return;
  if (options === null) { _panel = null; renderTransactions(); return; }
  panel.options = options;
  renderTransactions();
}

async function _openView(id) {
  const panel = { mode: 'view', id };
  _panel = panel;
  renderTransactions();
  const res = await _panelRequest(panel, 'get_transaction', { id });
  if (res === null) return;
  if (res.ok !== true) { showMsg(_responseMessage(res), 'warn'); _panel = null; renderTransactions(); return; }
  panel.detail = res.data.transaction;
  renderTransactions();
}

async function _openEdit(id) {
  const panel = { mode: 'edit', id };
  _panel = panel;
  renderTransactions();
  const res = await _panelRequest(panel, 'get_transaction_form_options', { mode: 'edit', id });
  if (res === null) return;
  if (res.ok !== true) { showMsg(_responseMessage(res), 'warn'); _panel = null; renderTransactions(); return; }
  panel.options = res.data;
  panel.detail = res.data.edit.record;
  renderTransactions();
}

async function _openCopy(id) {
  let res;
  try { res = await ExpenseAPI.view('get_transaction_prefill', { id, mode: 'copy' }); }
  catch (error) { console.error('[transactions] get_transaction_prefill failed:', error); showMsg('Connection lost. Refresh to try again.', 'warn'); return; }
  if (res?.ok !== true) { showMsg(_responseMessage(res), 'warn'); return; }
  await _openAdd(res.data.prefill);
}

async function _markSubscription(id) {
  let res;
  try { res = await ExpenseAPI.view('get_transaction_prefill', { id, mode: 'subscribe' }); }
  catch (error) { console.error('[transactions] get_transaction_prefill failed:', error); showMsg('Connection lost. Refresh to try again.', 'warn'); return; }
  if (res?.ok !== true) { showMsg(_responseMessage(res), 'warn'); return; }
  state.subPrefill = res.data.prefill;
  state.subAddOpen = true;
  document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'subscriptions' }));
}

function _rowById(id) {
  return (_list?.rows ?? []).find(row => row.id === id) ?? null;
}

function _dispatchTxAction(action, id) {
  if (action === 'tx-view')           { _openView(id); }
  if (action === 'tx-cancel-view')    { _panel = null; renderTransactions(); }
  if (action === 'tx-edit')           { _openEdit(id); }
  if (action === 'tx-cancel-edit')    { _panel = null; renderTransactions(); }
  if (action === 'tx-save-edit')      { _saveEdit(); }
  if (action === 'tx-delete')         { const row = _rowById(id); if (row !== null) { _panel = { mode: 'delete', id, row }; renderTransactions(); } }
  if (action === 'tx-cancel-delete')  { _panel = null; renderTransactions(); }
  if (action === 'tx-confirm-delete') { _confirmDelete(_panel?.mode === 'delete' ? _panel.row : _rowById(id)); }
  if (action === 'tx-restore')        { _restoreTx(_rowById(id)); }
  if (action === 'tx-copy')           { _openCopy(id); }
  if (action === 'tx-mark-sub')       { _markSubscription(id); }
}

// ── Option-tree lookups (no rules in the browser) ────────────────────────────

function _majorsFor(options, type) {
  return options?.categories?.[type]?.majors ?? [];
}

function _minorFor(options, type, majorKey, minorKey) {
  const major = _majorsFor(options, type).find(m => m.key === majorKey);
  return major?.minors?.find(m => m.key === minorKey) ?? null;
}

// Leg rule for the chosen category: { source:{mandatory, account_set}, target:{…}, is_transfer }.
function _legRule(options, type, majorKey, minorKey) {
  return _minorFor(options, type, majorKey, minorKey) ?? options?.uncategorised?.[type] ?? null;
}

// Eligible account ids for one leg (a lookup in the server's account_sets).
function _legAccountIds(options, leg) {
  const ids = options?.account_sets?.[leg?.account_set];
  return Array.isArray(ids) ? ids : [];
}

function _majorOptionsHtml(options, type, selected = '') {
  return `<option value="">— select —</option>` + _majorsFor(options, type).map(major => major.active
    ? `<option value="${esc(major.key)}" ${major.key === selected ? 'selected' : ''}>${esc(major.label)}</option>`
    : `<option value="${esc(major.key)}" ${major.key === selected ? 'selected' : ''} disabled style="color:var(--muted)">${esc(major.label)} (archived)</option>`).join('');
}

function _minorOptionsHtml(options, type, majorKey, selected = '') {
  const major = _majorsFor(options, type).find(m => m.key === majorKey);
  return `<option value="">— select —</option>` + (major?.minors ?? []).map(minor => minor.active
    ? `<option value="${esc(minor.key)}" ${minor.key === selected ? 'selected' : ''}>${esc(minor.label)}</option>`
    : `<option value="${esc(minor.key)}" ${minor.key === selected ? 'selected' : ''} disabled style="color:var(--muted)">${esc(minor.label)} (archived)</option>`).join('');
}

function _accountOptionsHtml(options, ids, selected = '') {
  const byId = new Map((options?.accounts ?? []).map(account => [account.id, account]));
  return ids.map(id => byId.get(id)).filter(account => account !== undefined).map(account =>
    `<option value="${esc(account.id)}" ${account.id === selected ? 'selected' : ''}>${esc(account.label)}</option>`).join('');
}

// Formats server-parsed beneficiaries as readable chips.
function _beneficiariesHtml(list) {
  if (!Array.isArray(list) || list.length === 0) return '—';
  return list.map(entry => entry.pct === null || entry.pct === undefined
    ? esc(entry.name)
    : `${esc(entry.name)} <span style="color:var(--muted)">(${esc(entry.pct)}%)</span>`).join(' &middot; ');
}

// Location enrichment in the add/edit form is optional and must not leave the form waiting forever.
async function _locationData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error('location_unavailable');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Forward geocode: area+city+country → lat/lon via Nominatim.
async function _geocodeCity(areaId, cityId, countryId, latId, lonId) {
  const area    = el(areaId)    !== null && el(areaId)    !== undefined ? el(areaId).value    : '';
  const city    = el(cityId)    !== null && el(cityId)    !== undefined ? el(cityId).value    : '';
  const country = el(countryId) !== null && el(countryId) !== undefined ? el(countryId).value : '';
  if (area === '' && city === '' && country === '') return;
  const latEl = el(latId);
  const lonEl = el(lonId);
  if (latEl === null || latEl === undefined || lonEl === null || lonEl === undefined) return;
  if (latEl.value !== '' && lonEl.value !== '') return; // already set
  try {
    const q   = encodeURIComponent([area, city, country].filter(v => v !== undefined && v !== null && v !== '').join(', '));
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const data = await _locationData(url);
    if (data !== null && data !== undefined && data[0] !== undefined && data[0] !== null) {
      latEl.value = parseFloat(data[0].lat).toFixed(6);
      lonEl.value = parseFloat(data[0].lon).toFixed(6);
    }
  } catch (_) {}
}

// Reverse geocode: lat/lon → area/city/country via Nominatim.
async function _reverseGeocode(latId, lonId, areaId, cityId, countryId) {
  const latEl = el(latId);
  const lonEl = el(lonId);
  if (latEl === null || latEl === undefined || lonEl === null || lonEl === undefined) return;
  const lat = latEl.value.trim();
  const lon = lonEl.value.trim();
  if (lat === '' || lon === '') return;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json`;
    const data = await _locationData(url);
    if (data !== null && data !== undefined && data.address !== undefined && data.address !== null) {
      const addr     = data.address;
      const cityEl   = el(cityId);
      const ctryEl   = el(countryId);
      const areaEl   = el(areaId);
      if (cityEl !== null && cityEl !== undefined && cityEl.value === '') cityEl.value   = (addr.city !== undefined && addr.city !== null) ? addr.city : ((addr.town !== undefined && addr.town !== null) ? addr.town : ((addr.village !== undefined && addr.village !== null) ? addr.village : ((addr.municipality !== undefined && addr.municipality !== null) ? addr.municipality : '')));
      if (ctryEl !== null && ctryEl !== undefined && ctryEl.value === '') ctryEl.value   = (addr.country !== undefined && addr.country !== null) ? addr.country : '';
      if (areaEl !== null && areaEl !== undefined && areaEl.value === '') areaEl.value   = (addr.suburb !== undefined && addr.suburb !== null) ? addr.suburb : ((addr.neighbourhood !== undefined && addr.neighbourhood !== null) ? addr.neighbourhood : ((addr.county !== undefined && addr.county !== null) ? addr.county : ''));
    }
  } catch (_) {}
}

// ── Section render ────────────────────────────────────────────────────────────

function _requestKey() {
  return JSON.stringify([_listParams(), state.quoteCurrency, _reloadGen]);
}

// Requests the list when the query, quote currency or data changed; otherwise
// re-renders from the payload on screen (panel toggles never refetch).
export function renderTransactions() {
  _txMenuKey = null;
  _consumeDeepLink();
  if (state.context !== _reloadSrc) {
    _reloadSrc = state.context;
    _reloadGen++;
    _addOptions = null;
  }
  _loadFacets();
  _loadSuggestions();
  const key = _requestKey();
  if (key !== _listKey) _loadList(key);
  _renderView();
}

function _renderView() {
  const txEl = el('transactionsContent');
  if (txEl === null || txEl === undefined) return;
  const panel = _panel;
  const anyAddOpen = panel !== null && (panel.mode === 'add' || panel.mode === 'view' || panel.mode === 'edit');
  const loadingCard = `<div class="card" style="margin-bottom:16px;color:var(--muted)">Loading…</div>`;

  txEl.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="txImportBtn">${state.txImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="txExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="txAddBtn">${anyAddOpen ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.txImportOpen ? _renderTxImportPanel() : ''}
    ${panel?.mode === 'add'  ? (panel.options ? _renderAddForm(panel.options) : loadingCard) : ''}
    ${panel?.mode === 'view' ? (panel.detail ? _renderTxView(panel.detail) : loadingCard) : ''}
    ${panel?.mode === 'edit' ? (panel.options ? _renderTxEdit(panel.options) : loadingCard) : ''}
    <div id="txSuggestions">${_renderSuggestionsPanel()}</div>
    <div id="txListRegion">${_listRegionHtml()}</div>
  `;

  el('txImportBtn').addEventListener('click', () => {
    if (_txImportBusy) return;
    if (state.txImportOpen) {
      state.txImportOpen = false;
      _txImportFile = null;
      _txImportResult = null;
    } else {
      state.txImportOpen = true;
      _panel = null;
    }
    renderTransactions();
  });

  el('txAddBtn').addEventListener('click', () => {
    if (_txImportBusy) return;
    if (anyAddOpen) { _panel = null; renderTransactions(); return; }
    _openAdd();
  });

  if (state.txImportOpen) {
    el('txImportFile').addEventListener('change', e => _chooseTxImportFile(e.target.files[0]));
    el('txImportConfirm').addEventListener('click', () => _submitTxImport(_txImportFile));
    _updateTxImportControls();

    el('txImportCancel').addEventListener('click', () => {
      if (_txImportBusy) return;
      state.txImportOpen = false;
      _txImportFile = null;
      _txImportResult = null;
      renderTransactions();
    });
  }

  _attachSuggestionEvents();
  if (panel?.mode === 'add' && panel.options) _attachAddFormEvents(panel);
  if (panel?.mode === 'edit' && panel.options) _attachTxEditCascadeEvents(panel.options);
  _attachListRegionEvents();

  el('txExportBtn').addEventListener('click', () => {
    openContextMenu(el('txExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => { _exportTransactions(key); });
  });
}

// Filter bar and table: everything that depends on the list payload.
function _listRegionHtml() {
  const list = _list;
  const warnRows = list?.warn_rows ?? [];
  const loadingCard = `<div class="card" style="margin-bottom:16px;color:var(--muted)">Loading…</div>`;
  return `
    ${_renderFilterBar()}
    ${_listError !== null ? `<p class="pin-error" role="alert">${esc(_listError)}</p>` : ''}
    ${warnRows.length ? `<div class="warning-count" id="warnToggle">⚠ ${warnRows.length} row${warnRows.length > 1 ? 's' : ''} have warnings — click to expand</div>` : ''}
    ${list ? _renderTxTable(list) : (_listError === null ? loadingCard : '')}`;
}

function _attachListRegionEvents() {
  _attachFilterEvents();
  _attachEvents();
  if ((_list?.warn_rows ?? []).length) {
    el('warnToggle')?.addEventListener('click', () => el('warnTable').classList.toggle('hidden'));
  }
}

// A list response only replaces the list region, so a form the user is
// filling in (or the import panel) is never re-rendered underneath them.
function _renderListRegion() {
  const region = el('txListRegion');
  if (region === null || region === undefined) { _renderView(); return; }
  region.innerHTML = _listRegionHtml();
  _attachListRegionEvents();
}

async function _exportTransactions(format) {
  showLoading();
  try {
    const res = await ExpenseAPI.view('export_transactions', _filterParams(_query));
    if (res?.ok !== true) { showMsg(_responseMessage(res), 'warn'); return; }
    if (!Array.isArray(res.data?.rows) || res.data.rows.length === 0) { showMsg('No transactions to export.', 'warn'); return; }
    downloadExport(format, res.data);
  } catch (error) {
    console.error('[transactions] export_transactions failed:', error);
    showMsg('Connection lost. Refresh to try again.', 'warn');
  } finally {
    hideLoading();
  }
}

function _amountCell(amount) {
  const native = esc(amount?.native_display ?? '—');
  const quote = amount?.show_quote ? ` <span class="td-base-amt">${esc(amount.quote_display)}</span>` : '';
  const missing = amount?.missing_rate ? ' <span class="badge badge-warn" title="Currency not in rates tab">?</span>' : '';
  return native + quote + missing;
}

function _badgeClass(row) {
  return row.badge === 'in' ? 'badge-et-in' : row.badge === 'out' ? 'badge-et-out' : 'badge-et-transfer';
}

function _renderTxTable(list) {
  const rows = Array.isArray(list.rows) ? list.rows : [];
  const sort = list.sort ?? { col: _query.sort_col, dir: _query.sort_dir };
  const pages = list.pages ?? 1;
  const page = list.page ?? 1;
  const sizes = _facets?.page_sizes ?? [10, 25, 50];

  const thSort = (col, label) => {
    const cls = sort.col === col ? ` sort-${sort.dir}` : '';
    return `<th class="${cls}" data-sort="${esc(col)}">${esc(label)}</th>`;
  };

  const rowData = rows.map(row => {
    if (_panel?.mode === 'delete' && _panel.id === row.id) return {
      tr: `<tr><td colspan="6">${_renderTxDelete(row)}</td></tr>`,
      card: `<div class="card record-confirm-card">${_renderTxDelete(row)}</div>`,
    };
    const catLabel = row.category?.label ?? '—';
    const dotCls = row.badge === 'in' ? 'tx-dot-in' : row.badge === 'out' ? 'tx-dot-out' : 'tx-dot-transfer';
    const menu = `${recordStatusIcon(row.record_status)}
          ${syncStatusIcon(row.sync_status)}
          <button class="tx-menu-trigger" data-action="tx-menu" data-id="${esc(row.id)}" title="Actions">⋮</button>`;
    return {
      tr: `<tr>
        <td class="td-mono td-nowrap">${esc(fmtDateTimeCompact(row.tx_date_local))}</td>
        <td><span class="badge ${_badgeClass(row)}">${esc(row.tx_type_label)}</span></td>
        <td class="td-truncate" title="${esc(row.account_label)}">${esc(row.account_label)}</td>
        <td class="td-mono td-nowrap">${_amountCell(row.amount)}</td>
        <td class="td-truncate" title="${esc(catLabel)}">${esc(catLabel)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${menu}
        </td>
      </tr>`,
      card: `<div class="tx-card">
          <div class="tx-card-body">
            <div class="tx-card-name"><span class="tx-type-dot ${dotCls}">●</span> ${esc(fmtDateTimeCompact(row.tx_date_local))} · ${esc(row.account_label)}</div>
            ${catLabel !== '—' ? `<div class="tx-card-cat">${esc(catLabel)}</div>` : ''}
          </div>
          <div class="tx-card-amt td-mono">${esc(row.amount?.native_display ?? '—')}</div>
          <div style="display:flex;align-items:center;gap:2px">
            ${menu}
          </div>
        </div>`,
    };
  });

  const warnRows = list.warn_rows ?? [];
  const warnRowsHtml = warnRows.length ? `
    <tbody id="warnTable" class="hidden">
      ${warnRows.map(row => `<tr>
        <td colspan="6"><span class="badge badge-warn">⚠ malformed</span> id=${esc(row.id || '?')} type=${esc(row.tx_type || '?')} date=${esc(row.tx_date_local || '?')} (${esc(row.reason)})</td>
      </tr>`).join('')}
    </tbody>` : '';

  const pagination = `
    <div class="pagination">
      <button class="btn btn-secondary btn-sm" id="prevPage" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${esc(page)} of ${esc(pages)} (${esc(list.total ?? 0)} rows)</span>
      <select id="txPerPage" class="per-page-select">
        ${sizes.map(n => `<option value="${esc(n)}" ${Number(list.page_size) === n ? 'selected' : ''}>${esc(n)} / page</option>`).join('')}
      </select>
      <button class="btn btn-secondary btn-sm" id="nextPage" ${page >= pages ? 'disabled' : ''}>Next →</button>
    </div>`;

  return `
    <div class="table-wrap tx-table-wrap">
      <table>
        <thead><tr>
          ${thSort('tx_date_local', 'Date')}
          ${thSort('tx_type', 'Type')}
          ${thSort('account', 'Account')}
          ${thSort('amount', 'Amount')}
          ${thSort('category', 'Category')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${rowData.map(d => d.tr).join('')}</tbody>
        ${warnRowsHtml}
      </table>
    </div>
    <div class="tx-cards">${rowData.map(d => d.card).join('')}</div>
    ${pagination}
  `;
}

function _attachEvents() {
  if (_txEventsAbort) _txEventsAbort.abort();
  _txEventsAbort = new AbortController();
  const { signal } = _txEventsAbort;

  const content = el('transactionsContent');
  if (content === null || content === undefined) return;

  content.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      _query.sort_dir = _query.sort_col === col ? (_query.sort_dir === 'asc' ? 'desc' : 'asc') : 'asc';
      _query.sort_col = col;
      _query.page = 1;
      renderTransactions();
    }, { signal });
  });

  el('prevPage')?.addEventListener('click', () => { _query.page = Math.max(1, _query.page - 1); renderTransactions(); }, { signal });
  el('nextPage')?.addEventListener('click', () => { _query.page++; renderTransactions(); }, { signal });
  el('txPerPage')?.addEventListener('change', e => { _query.page_size = Number(e.target.value); _query.page = 1; renderTransactions(); }, { signal });

  content.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn === null || btn === undefined) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id ?? null;
    if (action === 'tx-menu') {
      const row = _rowById(id);
      if (row === null) return;
      if (_txMenuKey === id) { closeContextMenu(); _txMenuKey = null; return; }
      _txMenuKey = id;
      const items = (row.allowed_actions ?? []).filter(key => _ACTION_KEYS[key] !== undefined)
        .map(key => ({ key: _ACTION_KEYS[key], label: _ACTION_LABELS[key], cls: key === 'delete' ? 'danger' : '' }));
      openContextMenu(btn, items, key => { _txMenuKey = null; _dispatchTxAction(key, id); });
      return;
    }
    if (action === 'sugg-add') {
      const key = btn.dataset.key;
      const s = state.suggestions.find(x => _suggestionKey(x) === key);
      if (s === undefined || s === null) return;
      _openAdd({
        tx_type:              'money-out',
        major_category:       s.major_category,
        minor_category:       s.minor_category,
        source_account:       s.account_id ?? '',
        target_account:       '',
        source_amount:        s.typical_amount,
        target_amount:        '',
        counterparty_name:    s.counterparty_name,
        user_location_area:   s.user_location_area ?? '',
        user_location_city:   s.user_location_city ?? '',
        user_location_country: s.user_location_country ?? '',
        tx_tags:              s.tx_tags ?? '',
        beneficiaries:        s.beneficiaries ?? '',
        description:          '',
      });
      return;
    }
    _dispatchTxAction(action, id);
  }, { signal });
}

// ── Add-transaction form ──────────────────────────────────────────────────────

function _renderAddForm(options) {
  const lists = options.datalists ?? {};
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="form-grid form-grid-6">
      <!-- Row 1: Type | Major category | Minor category -->
      <div class="field form-grid-span-2">
        <label for="afType">Type *</label>
        <select id="afType">
          <option value="">— select —</option>
          ${(options.tx_types ?? []).map(t => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field form-grid-span-2" id="afMajorField">
        <label for="afMajor">Major category *</label>
        <select id="afMajor" disabled><option value="">— select type first —</option></select>
      </div>
      <div class="field form-grid-span-2" id="afMinorField">
        <label for="afMinor">Minor category *</label>
        <select id="afMinor" disabled><option value="">— select major first —</option></select>
      </div>
      <!-- Row 2: Source account | Target account -->
      <div class="field form-grid-span-3" id="afFromAccountWrap">
        <label for="afFromAccount">Source account</label>
        <select id="afFromAccount" disabled>
          <option value="">— select type first —</option>
        </select>
      </div>
      <div class="field form-grid-span-3" id="afToAccountWrap">
        <label for="afToAccount">Target account</label>
        <select id="afToAccount" disabled>
          <option value="">External</option>
        </select>
      </div>
      <!-- Row 3: Date & time | Source amount | Target amount -->
      <div class="field form-grid-span-2" id="afDateField">
        <label for="afDate">Date &amp; time *</label>
        <input type="datetime-local" id="afDate" value="${nowLocalISO()}">
      </div>
      <div class="field form-grid-span-2" id="afSourceAmountField">
        <label for="afSourceAmount" id="afSourceAmountLabel">Amount *</label>
        <input type="number" id="afSourceAmount" inputmode="decimal" min="0" step="any" placeholder="0.00">
      </div>
      <div class="field form-grid-span-1 hidden" id="afTargetAmountField">
        <label for="afTargetAmount">Target amount</label>
        <input type="number" id="afTargetAmount" inputmode="decimal" min="0" step="any" placeholder="0.00">
      </div>
      <!-- Row 4: Counterparty | Tags -->
      <div class="field form-grid-span-3" id="afCounterpartyField">
        <label for="afCounterparty">Counterparty</label>
        <input type="text" id="afCounterparty" placeholder="Tesco, employer, …" list="dlAfCounterparty" autocomplete="off">
      </div>
      <div class="field form-grid-span-3" id="afTagsField">
        <label for="afTags">Tags</label>
        <input type="text" id="afTags" placeholder="reimbursable, work" list="dlAfTags" autocomplete="off">
      </div>
      <!-- Row 5: Description -->
      <div class="field form-grid-full" id="afDescriptionField">
        <label for="afDescription">Description</label>
        <input type="text" id="afDescription" placeholder="free text">
      </div>
      <!-- Row 6: Beneficiaries -->
      <div class="field form-grid-full" id="afBeneficiariesField">
        <label for="afBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
        <input type="text" id="afBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off">
      </div>
      <!-- Row 7: Area | City | Country -->
      <div class="field form-grid-span-2" id="afAreaField">
        <label for="afArea">Area</label>
        <input type="text" id="afArea" placeholder="e.g. West End" list="dlAfArea" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afCityField">
        <label for="afCity">City</label>
        <input type="text" id="afCity" placeholder="e.g. London" list="dlAfCity" autocomplete="off">
      </div>
      <div class="field form-grid-span-2" id="afCountryField">
        <label for="afCountry">Country</label>
        <input type="text" id="afCountry" placeholder="UK" list="dlAfCountry" autocomplete="off">
      </div>
      <!-- Row 8: Coordinates -->
      <div class="field form-grid-full" id="afCoordinatesField">
        <label>Coordinates <span class="optional">optional</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="afLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90">
          <input type="number" id="afLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180">
          <button type="button" id="afDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
        </div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" id="afSubmit">Save</button>
      <button class="btn btn-secondary" id="afReset">Clear</button>
    </div>
    <div class="pin-error" id="afError"></div>
    ${_datalist('dlAfCounterparty', lists.counterparties)}
    ${_datalist('dlAfArea',         lists.areas)}
    ${_datalist('dlAfCity',         lists.cities)}
    ${_datalist('dlAfCountry',      lists.countries)}
    ${_datalist('dlAfTags',         lists.tags)}
  </div>`;
}

function _setValue(id, value) {
  const node = el(id);
  if (node !== null && node !== undefined) node.value = value === undefined || value === null ? '' : value;
}

function _prefillAddForm(options, p) {
  const typeEl = el('afType');
  if (typeEl === null || typeEl === undefined) return;
  typeEl.value = p.tx_type ?? '';
  const majorEl = el('afMajor');
  const minorEl = el('afMinor');
  if (typeEl.value !== '') {
    majorEl.innerHTML = _majorOptionsHtml(options, typeEl.value);
    majorEl.disabled  = false;
    minorEl.disabled  = false;
  }
  // The server already resolved legacy label values to category keys.
  if (typeof p.major_category === 'string' && p.major_category !== '') {
    majorEl.value     = p.major_category;
    minorEl.innerHTML = _minorOptionsHtml(options, typeEl.value, p.major_category);
    minorEl.value     = p.minor_category ?? '';
  }
  _afRefreshFromAccountOpts(options);
  _setValue('afFromAccount', p.source_account);
  _afRefreshToAccountField(options);
  _setValue('afToAccount', p.target_account);
  // Date stays as nowLocalISO().
  _setValue('afSourceAmount', p.source_amount);
  _setValue('afTargetAmount', p.target_amount);
  _setValue('afCounterparty', p.counterparty_name);
  _setValue('afArea', p.user_location_area);
  _setValue('afCity', p.user_location_city);
  _setValue('afCountry', p.user_location_country);
  _setValue('afTags', p.tx_tags !== undefined && p.tx_tags !== null ? String(p.tx_tags).replace(/;/g, ', ') : '');
  _setValue('afDescription', p.description);
  _setValue('afLatitude', p.user_location_latitude);
  _setValue('afLongitude', p.user_location_longitude);
  _setValue('afBeneficiaries', p.beneficiaries);
}

function _attachAddFormEvents(panel) {
  const options = panel.options;
  el('afType').addEventListener('change', () => {
    const type       = el('afType').value;
    const majorEl    = el('afMajor');
    const minorEl    = el('afMinor');

    majorEl.innerHTML = '<option value="">— select type first —</option>';
    minorEl.innerHTML = '<option value="">— select major first —</option>';
    _setValue('afFromAccount', '');
    _setValue('afToAccount', '');

    if (type === '') {
      majorEl.disabled = true;
      minorEl.disabled = true;
      const fromEl = el('afFromAccount');
      if (fromEl !== null && fromEl !== undefined) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
      const toEl = el('afToAccount');
      if (toEl !== null && toEl !== undefined) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
      return;
    }

    majorEl.innerHTML = _majorOptionsHtml(options, type);
    majorEl.disabled  = false;
    minorEl.disabled  = false;
    _afRefreshFromAccountOpts(options);
  });

  el('afMajor').addEventListener('change', () => {
    el('afMinor').innerHTML = _minorOptionsHtml(options, el('afType').value, el('afMajor').value);
    _afRefreshFromAccountOpts(options);
  });

  el('afMinor').addEventListener('change', () => _afRefreshFromAccountOpts(options));
  el('afFromAccount').addEventListener('change', () => _afRefreshToAccountField(options));

  el('afSubmit').addEventListener('click', _saveTransaction);
  el('afReset').addEventListener('click', () => {
    ['afDate','afSourceAmount','afTargetAmount','afCounterparty','afArea','afCity','afCountry','afTags','afDescription','afLatitude','afLongitude','afBeneficiaries']
      .forEach(id => _setValue(id, id === 'afDate' ? nowLocalISO() : ''));
    el('afType').value = '';
    const fromEl = el('afFromAccount');
    if (fromEl !== null && fromEl !== undefined) { fromEl.disabled = true; fromEl.innerHTML = '<option value="">— select type first —</option>'; }
    const toEl = el('afToAccount');
    if (toEl !== null && toEl !== undefined) { toEl.disabled = true; toEl.innerHTML = '<option value="">External</option>'; }
    el('afMajor').innerHTML = '<option value="">— select type first —</option>';
    el('afMajor').disabled  = true;
    el('afMinor').innerHTML = '<option value="">— select major first —</option>';
    el('afMinor').disabled  = true;
    el('afError').textContent = '';
  });

  _attachTagAutocomplete('afTags', 'dlAfTags', options.datalists?.tags);

  el('afDetectLocation').addEventListener('click', () => {
    if (navigator.geolocation === undefined || navigator.geolocation === null) return;
    navigator.geolocation.getCurrentPosition(pos => {
      _setValue('afLatitude', pos.coords.latitude.toFixed(6));
      _setValue('afLongitude', pos.coords.longitude.toFixed(6));
      _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry');
    });
  });

  el('afArea').addEventListener('blur',    () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afCity').addEventListener('blur',    () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afCountry').addEventListener('blur', () => _geocodeCity('afArea', 'afCity', 'afCountry', 'afLatitude', 'afLongitude'));
  el('afLatitude').addEventListener('blur',  () => _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry'));
  el('afLongitude').addEventListener('blur', () => _reverseGeocode('afLatitude', 'afLongitude', 'afArea', 'afCity', 'afCountry'));

  // A copy / suggestion prefill is applied once, now that events are wired.
  if (panel.prefill) {
    _prefillAddForm(options, panel.prefill);
    panel.prefill = null;
  }
}

// Source leg: "External" unless the category books a source account; the
// choices are the server's eligible accounts for that leg.
function _afRefreshFromAccountOpts(options) {
  const fromEl = el('afFromAccount');
  if (fromEl === null || fromEl === undefined) return;
  const rule = _legRule(options, el('afType').value, el('afMajor').value, el('afMinor').value);
  if (rule === null || !rule.source.mandatory) {
    fromEl.disabled  = true;
    fromEl.innerHTML = `<option value="">External</option>`;
    fromEl.value     = '';
  } else {
    fromEl.disabled  = false;
    const prevVal    = fromEl.value;
    fromEl.innerHTML = `<option value="">— select —</option>${_accountOptionsHtml(options, _legAccountIds(options, rule.source), prevVal)}`;
    if (prevVal !== '') fromEl.value = prevVal;
  }
  _afRefreshToAccountField(options);
}

// Target leg: enabled only when the category books one; the chosen source is
// not offered again (the server re-checks same_transfer_account).
function _afRefreshToAccountField(options) {
  const rule = _legRule(options, el('afType').value, el('afMajor').value, el('afMinor').value);
  const isTransfer = rule !== null && rule.is_transfer === true;
  const toAccEl = el('afToAccount');
  if (toAccEl === null || toAccEl === undefined) return;

  if (rule !== null && rule.target.mandatory) {
    toAccEl.disabled  = false;
    const fromId      = el('afFromAccount')?.value ?? '';
    const prevVal     = toAccEl.value;
    const ids         = _legAccountIds(options, rule.target).filter(id => id !== fromId);
    toAccEl.innerHTML = `<option value="">— select —</option>${_accountOptionsHtml(options, ids, prevVal)}`;
    if (prevVal !== '' && prevVal !== fromId) toAccEl.value = prevVal;
  } else {
    toAccEl.disabled  = true;
    toAccEl.innerHTML = `<option value="">External</option>`;
    toAccEl.value     = '';
  }

  const srcAmtLbl   = el('afSourceAmountLabel');
  const srcAmtField = el('afSourceAmountField');
  const tgtAmtField = el('afTargetAmountField');
  if (srcAmtLbl !== null && srcAmtLbl !== undefined) srcAmtLbl.textContent = isTransfer ? 'Source amount *' : 'Amount *';
  if (tgtAmtField !== null && tgtAmtField !== undefined) {
    if (isTransfer) {
      tgtAmtField.classList.remove('hidden');
      if (srcAmtField !== null && srcAmtField !== undefined) { srcAmtField.classList.remove('form-grid-span-2'); srcAmtField.classList.add('form-grid-span-1'); }
    } else {
      tgtAmtField.classList.add('hidden');
      if (srcAmtField !== null && srcAmtField !== undefined) { srcAmtField.classList.remove('form-grid-span-1'); srcAmtField.classList.add('form-grid-span-2'); }
      _setValue('afTargetAmount', '');
    }
  }
}

// ── Server validation → form ─────────────────────────────────────────────────
// The server validates every field and business rule (required fields, amounts,
// categories, insufficient balance). Forms submit what the user entered and show
// the server's `message`, highlighting the input named by `field`.
const _AF_FIELD_IDS = {
  tx_date_local: 'afDate', tx_type: 'afType', source_account: 'afFromAccount', target_account: 'afToAccount',
  source_amount_local: 'afSourceAmount', target_amount_local: 'afTargetAmount',
  major_category: 'afMajor', minor_category: 'afMinor', beneficiaries: 'afBeneficiaries',
  user_location_latitude: 'afLatitude', user_location_longitude: 'afLongitude',
};
const _TX_EDIT_FIELD_IDS = {
  tx_date_local: 'txEditDate', tx_type: 'txEditType', account_id: 'txEditAccount', tx_amount_local: 'txEditAmount',
  major_category: 'txEditMajor', minor_category: 'txEditMinor', beneficiaries: 'txEditBeneficiaries',
  user_location_latitude: 'txEditLatitude', user_location_longitude: 'txEditLongitude',
};

async function _saveTransaction() {
  const btn   = el('afSubmit');
  if (btn.disabled) return;
  const errEl = el('afError');
  clearFormError(errEl);

  const dateRaw              = el('afDate').value;
  const tx_type              = el('afType').value;
  const source_account       = el('afFromAccount').value;
  const target_account       = el('afToAccount').value;
  const source_amount_raw    = el('afSourceAmount').value;
  const target_amount_raw    = el('afTargetAmount').value;
  const major_category       = el('afMajor').value;
  const minor_category       = el('afMinor').value;
  const counterparty_name    = el('afCounterparty').value.trim();
  const user_location_area     = el('afArea').value.trim();
  const user_location_city     = el('afCity').value.trim();
  const user_location_country  = el('afCountry').value.trim();
  const tx_tags              = el('afTags').value.trim();
  const description          = el('afDescription').value.trim();
  const tx_timezone             = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const user_location_latitude  = el('afLatitude').value  !== '' ? Number(el('afLatitude').value)  : '';
  const user_location_longitude = el('afLongitude').value !== '' ? Number(el('afLongitude').value) : '';
  const beneficiaries           = el('afBeneficiaries').value.trim();

  // Form shape only: a transfer shows its own target-amount input (blank lets the
  // server default a same-currency transfer); otherwise the single Amount input
  // is the amount of whichever leg the category books.
  const rule          = _legRule(_panel?.options ?? null, tx_type, major_category, minor_category);
  const isTransfer    = rule !== null && rule.is_transfer === true;
  const source_amount = source_amount_raw.trim();
  const target_amount = isTransfer ? target_amount_raw.trim() : source_amount;

  btn.disabled = true; btn.textContent = 'Saving…';
  showLoading();
  try {
    const res = await ExpenseAPI.createTransaction({
      tx_date_local: _localInputTimestamp(dateRaw),
      tx_type, source_account, target_account,
      source_amount_local: source_amount, target_amount_local: target_amount,
      major_category, minor_category,
      counterparty_name, user_location_area, user_location_city, user_location_country,
      tx_tags, description,
      tx_timezone_local: tx_timezone, user_location_latitude, user_location_longitude, beneficiaries,
    });
    if (res.ok) {
      showMsg(res.ids ? '2 transactions saved (transfer split).' : 'Transaction saved.');
      _panel = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _saveTransaction failed:', res.error);
      showFormError(errEl, res, _AF_FIELD_IDS);
      btn.disabled = false; btn.textContent = 'Save';
    }
  } catch (err) {
    console.error('[transactions] _saveTransaction failed:', err);
    errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
    btn.disabled = false; btn.textContent = 'Save';
  } finally {
    hideLoading();
  }
}

function _localInputTimestamp(value, original = '') {
  // The edit control displays minutes. Preserve stored seconds/microseconds
  // when another field is edited, rather than silently moving the transaction.
  const local = value.replace('T', ' ');
  if (original !== '' && local === String(original).replace('T', ' ').slice(0, 16)) return original;
  return local.length === 16 ? local + ':00' : local;
}

// ── Transaction view / edit card ──────────────────────────────────────────────

function _renderTxView(tx) {
  const vf = (label, value, span = 'form-grid-span-2') =>
    `<div class="field ${span}"><label>${label}</label><div class="field-val">${value}</div></div>`;
  const dash = value => (typeof value === 'string' && value.trim() !== '' ? value : '—');
  const location = tx.location ?? {};
  const hasCoords = (location.latitude ?? '') !== '' || (location.longitude ?? '') !== '';
  const canEdit = (tx.allowed_actions ?? []).includes('edit');
  const quote = tx.amount?.show_quote ? `<span style="color:var(--muted);font-size:var(--text-sm)">≈ ${esc(tx.amount.quote_display)}</span>` : '';
  return `
    <div class="card" style="margin-bottom:16px">
      <div class="form-grid form-grid-6">
        <!-- Row 1: Type | Major category | Minor category -->
        <div class="field form-grid-span-2">
          <label>Type</label>
          <div class="field-val"><span class="badge ${_badgeClass(tx)}">${esc(tx.tx_type_label)}</span></div>
        </div>
        ${vf('Major category', esc(tx.category?.major_label ?? '—'))}
        ${vf('Minor category', esc(tx.category?.minor_label ?? '—'))}
        <!-- Row 2: Account (full width) -->
        ${vf('Account', esc(tx.account_label), 'form-grid-full')}
        <!-- Row 3: Date & time | Timezone | Amount -->
        ${vf('Date &amp; time', esc(fmtDateTime(tx.tx_date_local)))}
        ${vf('Timezone', esc(dash(tx.tx_timezone_local)))}
        <div class="field form-grid-span-2">
          <label>Amount</label>
          <div class="field-val">
            ${esc(tx.amount?.native_display ?? '—')}
            ${quote}
          </div>
        </div>
        <!-- Row 4: Counterparty | Tags -->
        ${vf('Counterparty', esc(dash(tx.counterparty_name)), 'form-grid-span-3')}
        ${vf('Tags', esc(dash(tx.tags_display)), 'form-grid-span-3')}
        <!-- Row 5: Description -->
        ${vf('Description', esc(dash(tx.description)), 'form-grid-full')}
        <!-- Row 6: Beneficiaries -->
        ${vf('Beneficiaries', _beneficiariesHtml(tx.beneficiaries_list), 'form-grid-full')}
        <!-- Row 7: Area | City | Country -->
        ${vf('Area',    esc(dash(location.area)))}
        ${vf('City',    esc(dash(location.city)))}
        ${vf('Country', esc(dash(location.country)))}
        <!-- Row 8: Coordinates (only if set) -->
        ${hasCoords ? vf('Coordinates', esc(`${location.latitude ?? ''}, ${location.longitude ?? ''}`), 'form-grid-full') : ''}
      </div>
      ${dash(tx.sync_status) !== '—' ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px">${syncStatusIcon(tx.sync_status)}<span style="font-size:var(--text-sm);color:var(--muted)">${esc(tx.sync_status)}</span>${dash(tx.sync_notes) !== '—' ? `<span style="font-size:var(--text-sm)">— ${esc(tx.sync_notes)}</span>` : ''}</div>` : ''}
      <div class="form-actions" style="margin-top:12px">
        <button class="btn btn-secondary btn-sm" data-action="tx-cancel-view">Close</button>
        ${canEdit ? `<button class="btn btn-primary btn-sm" data-action="tx-edit" data-id="${esc(tx.id)}">Edit</button>` : ''}
      </div>
    </div>`;
}

// Edit account choices: the leg's eligible accounts for the chosen category,
// plus the row's own (possibly closed) account, which the server keeps listed.
function _editAccountIds(options, type, majorKey, minorKey) {
  const rule = _legRule(options, type, majorKey, minorKey);
  const field = type === 'money-out' ? 'source' : 'target';
  const ids = rule === null ? [] : _legAccountIds(options, rule[field]).slice();
  const keep = options.edit?.keep_account_id ?? null;
  if (keep !== null && !ids.includes(keep)) ids.unshift(keep);
  return ids;
}

function _renderTxEdit(options) {
  const edit = options.edit;
  const tx = edit.record;
  const location = tx.location ?? {};
  const lists = options.datalists ?? {};
  const majorKey = edit.category?.major_key ?? '';
  const minorKey = edit.category?.minor_key ?? '';
  const typeOpts = (options.tx_types ?? []).map(t =>
    `<option value="${esc(t.value)}" ${tx.tx_type === t.value ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  const accountOpts = _accountOptionsHtml(options, _editAccountIds(options, tx.tx_type, majorKey, minorKey), tx.account?.id ?? '');
  const transferNote = tx.counter_leg !== null && tx.counter_leg !== undefined
    ? `<div style="font-size:var(--text-sm);color:var(--muted);margin-bottom:4px">Linked transfer — edit this leg only. The other leg (${esc(tx.counter_leg.account_name || '—')}) is a separate row.</div>`
    : '';

  return `
  <div class="card" style="margin-bottom:16px">
    ${transferNote}
    <div class="form-grid form-grid-6">
      <!-- Row 1: Type | Major category | Minor category -->
      <div class="field form-grid-span-2">
        <label>Type</label>
        <select id="txEditType">${typeOpts}</select>
      </div>
      <div class="field form-grid-span-2" id="txEditMajorField">
        <label>Major category</label>
        <select id="txEditMajor">${_majorOptionsHtml(options, tx.tx_type, majorKey)}</select>
      </div>
      <div class="field form-grid-span-2" id="txEditMinorField">
        <label>Minor category</label>
        <select id="txEditMinor">${_minorOptionsHtml(options, tx.tx_type, majorKey, minorKey)}</select>
      </div>
      <!-- Row 2: Account (full width) -->
      <div class="field form-grid-full">
        <label>Account</label>
        <select id="txEditAccount">
          <option value="">— select —</option>
          ${accountOpts}
        </select>
      </div>
      <!-- Row 3: Date & time | Timezone | Amount -->
      <div class="field form-grid-span-2">
        <label>Date &amp; time</label>
        <input type="datetime-local" id="txEditDate" value="${esc(tx.tx_date_input)}">
      </div>
      <div class="field form-grid-span-2">
        <label>Timezone</label>
        <div class="field-val">${esc(tx.tx_timezone_local || '—')}</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Amount</label>
        <input type="number" id="txEditAmount" inputmode="decimal" min="0" step="any" value="${esc(tx.tx_amount_local)}">
      </div>
      <!-- Row 4: Counterparty | Tags -->
      <div class="field form-grid-span-3">
        <label>Counterparty</label>
        <input type="text" id="txEditCounterparty" value="${esc(tx.counterparty_name)}" list="dlEditCounterparty" autocomplete="off">
      </div>
      <div class="field form-grid-span-3">
        <label>Tags</label>
        <input type="text" id="txEditTags" value="${esc(tx.tags_display)}" list="dlEditTags" autocomplete="off">
      </div>
      <!-- Row 5: Description -->
      <div class="field form-grid-full">
        <label>Description</label>
        <input type="text" id="txEditDescription" value="${esc(tx.description)}">
      </div>
      <!-- Row 6: Beneficiaries -->
      <div class="field form-grid-full">
        <label for="txEditBeneficiaries">Beneficiaries <span class="optional">optional</span></label>
        <input type="text" id="txEditBeneficiaries" placeholder="e.g. Alice:60;Bob:40 or Alice;Bob" autocomplete="off" value="${esc(tx.beneficiaries)}">
      </div>
      <!-- Row 7: Area | City | Country -->
      <div class="field form-grid-span-2">
        <label>Area</label>
        <input type="text" id="txEditArea" value="${esc(location.area)}" list="dlEditArea" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>City</label>
        <input type="text" id="txEditCity" value="${esc(location.city)}" list="dlEditCity" autocomplete="off">
      </div>
      <div class="field form-grid-span-2">
        <label>Country</label>
        <input type="text" id="txEditCountry" value="${esc(location.country)}" list="dlEditCountry" autocomplete="off">
      </div>
      <!-- Row 8: Coordinates -->
      <div class="field form-grid-full">
        <label>Coordinates <span class="optional">optional</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="txEditLatitude"  step="any" placeholder="Latitude"  style="flex:1" min="-90"  max="90"  value="${esc(location.latitude)}">
          <input type="number" id="txEditLongitude" step="any" placeholder="Longitude" style="flex:1" min="-180" max="180" value="${esc(location.longitude)}">
          <button type="button" id="txEditDetectLocation" class="btn btn-secondary btn-sm">Detect</button>
        </div>
      </div>
    </div>
    <div class="form-actions" style="margin-top:8px">
      <button class="btn btn-primary btn-sm" data-action="tx-save-edit">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="tx-cancel-edit">Cancel</button>
    </div>
    <div class="pin-error" id="txEditError"></div>
    ${_datalist('dlEditCounterparty', lists.counterparties)}
    ${_datalist('dlEditArea',         lists.areas)}
    ${_datalist('dlEditCity',         lists.cities)}
    ${_datalist('dlEditCountry',      lists.countries)}
    ${_datalist('dlEditTags',         lists.tags)}
  </div>`;
}

function _renderTxDelete(row) {
  return `
      <span class="confirm-text">Delete <strong>${esc(fmtDateTime(row.tx_date_local))}</strong> — ${esc(row.account_label)} — ${esc(row.amount?.native_display ?? '—')}?</span>
      <div class="row-actions">
        <button class="btn-link danger" data-action="tx-confirm-delete" data-id="${esc(row.id)}">Yes, delete</button>
        <button class="btn-link" data-action="tx-cancel-delete">Cancel</button>
      </div>`;
}

function _attachTxEditCascadeEvents(options) {
  const _refreshAccountOpts = () => {
    const acctEl = el('txEditAccount');
    if (acctEl === null || acctEl === undefined) return;
    const prev = acctEl.value;
    const ids = _editAccountIds(options, el('txEditType').value, el('txEditMajor').value, el('txEditMinor').value);
    acctEl.innerHTML = `<option value="">— select —</option>${_accountOptionsHtml(options, ids, prev)}`;
    if (prev) acctEl.value = prev;
  };

  el('txEditType').addEventListener('change', () => {
    el('txEditMajor').innerHTML = _majorOptionsHtml(options, el('txEditType').value);
    el('txEditMinor').innerHTML = `<option value="">— select major first —</option>`;
    _refreshAccountOpts();
  });
  el('txEditMajor').addEventListener('change', () => {
    el('txEditMinor').innerHTML = _minorOptionsHtml(options, el('txEditType').value, el('txEditMajor').value);
    _refreshAccountOpts();
  });
  el('txEditMinor').addEventListener('change', _refreshAccountOpts);

  _attachTagAutocomplete('txEditTags', 'dlEditTags', options.datalists?.tags);

  el('txEditDetectLocation').addEventListener('click', () => {
    if (navigator.geolocation === undefined || navigator.geolocation === null) return;
    navigator.geolocation.getCurrentPosition(pos => {
      _setValue('txEditLatitude', pos.coords.latitude.toFixed(6));
      _setValue('txEditLongitude', pos.coords.longitude.toFixed(6));
      _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry');
    });
  });

  el('txEditArea').addEventListener('blur',    () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditCity').addEventListener('blur',    () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditCountry').addEventListener('blur', () => _geocodeCity('txEditArea', 'txEditCity', 'txEditCountry', 'txEditLatitude', 'txEditLongitude'));
  el('txEditLatitude').addEventListener('blur',  () => _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry'));
  el('txEditLongitude').addEventListener('blur', () => _reverseGeocode('txEditLatitude', 'txEditLongitude', 'txEditArea', 'txEditCity', 'txEditCountry'));
}

async function _saveEdit() {
  const errEl = el('txEditError');
  clearFormError(errEl);
  const record = _panel?.mode === 'edit' ? _panel.detail : null;
  if (record === null || record === undefined) return;

  const user_location_latitude  = el('txEditLatitude').value  !== '' ? Number(el('txEditLatitude').value)  : '';
  const user_location_longitude = el('txEditLongitude').value !== '' ? Number(el('txEditLongitude').value) : '';

  showLoading();
  try {
    const res = await ExpenseAPI.updateTransaction({
      id: record.id, row_num: record.row_num, updated_at: record.updated_at,
      tx_date_local: _localInputTimestamp(el('txEditDate').value, record.tx_date_local ?? ''),
      tx_type: el('txEditType').value,
      account_id: el('txEditAccount').value, tx_amount_local: el('txEditAmount').value.trim(),
      major_category: el('txEditMajor').value, minor_category: el('txEditMinor').value,
      counterparty_name: el('txEditCounterparty').value.trim(),
      user_location_area: el('txEditArea').value.trim(), user_location_city: el('txEditCity').value.trim(),
      user_location_country: el('txEditCountry').value.trim(),
      tx_tags: el('txEditTags').value.trim(), description: el('txEditDescription').value.trim(),
      user_location_latitude, user_location_longitude, beneficiaries: el('txEditBeneficiaries').value.trim(),
    });
    if (res.ok) {
      showMsg('Transaction updated.');
      _panel = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _saveEdit failed:', res.error);
      showFormError(errEl, res, _TX_EDIT_FIELD_IDS);
    }
  } catch (err) {
    console.error('[transactions] _saveEdit failed:', err);
    errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
  } finally {
    hideLoading();
  }
}

function _identity(row) {
  return { id: row.id, row_num: row.row_num, updated_at: row.updated_at };
}

async function _confirmDelete(row) {
  if (row === null || row === undefined) return;
  showLoading();
  try {
    const res = await ExpenseAPI.deleteTransaction(_identity(row));
    _panel = null;
    if (res.ok) {
      showMsg('Transaction deleted.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _confirmDelete failed:', res.error);
      showMsg('Delete failed: ' + _responseMessage(res), 'warn');
      renderTransactions();
    }
  } catch (err) {
    console.error('[transactions] _confirmDelete failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    _panel = null;
    renderTransactions();
  } finally {
    hideLoading();
  }
}

async function _restoreTx(row) {
  if (row === null || row === undefined) return;
  showLoading();
  try {
    const res = await ExpenseAPI.restoreTransaction(_identity(row));
    if (res.ok) {
      showMsg('Transaction restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[transactions] _restoreTx failed:', res.error);
      showMsg('Restore failed: ' + _responseMessage(res), 'warn');
      renderTransactions();
    }
  } catch (err) {
    console.error('[transactions] _restoreTx failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    renderTransactions();
  } finally {
    hideLoading();
  }
}

// ── Suggestions panel ─────────────────────────────────────────────────────────

function _refreshSuggestionsPanel() {
  // Suggestions arrive independently; replacing the entire section here would
  // discard an add/edit form the user started while the request was in flight.
  const panel = el('txSuggestions');
  if (panel === null) return;
  panel.innerHTML = _renderSuggestionsPanel();
  _attachSuggestionEvents();
}

function _renderSuggestionsPanel() {
  if (state.suggestionsFetching) {
    return `
    <div class="suggestions-panel">
      <button class="suggestions-toggle" id="suggestionsToggle">
        Suggestions <span class="filter-arrow">▼</span>
      </button>
      <div class="suggestions-body" id="suggestionsBody">
        <div class="suggestions-scroll">
          ${Array.from({length: 10}).map(() => `<div class="suggestion-card suggestion-skeleton"></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  const visible = state.suggestions;
  const isEmpty  = visible.length === 0;
  const isOpen   = isEmpty ? false : state.suggestionsOpen;
  const arrow     = isOpen ? '▲' : '▼';
  const bodyClass = isOpen ? '' : 'hidden';
  const countLabel = visible.length > 0 ? ` (${visible.length})` : '';

  // The server supplies every display string (account name, category, amount).
  const cards = visible.map(s => {
    const key     = _suggestionKey(s);
    const display = s.display ?? {};
    const meta    = `${display.category_label ?? s.minor_category ?? ''} · ${display.account_name ?? s.account_id ?? ''}`;
    return `
      <div class="suggestion-card" data-key="${esc(key)}">
        <div class="suggestion-name" title="${esc(s.counterparty_name)}">${esc(s.counterparty_name)}</div>
        <div class="suggestion-meta" title="${esc(meta)}">${esc(meta)}</div>
        <div class="suggestion-amount">${esc(display.typical_amount ?? '—')}</div>
        <div class="suggestion-reason" title="${esc(s.reason)}">${esc(s.reason)}</div>
        <button class="btn btn-primary btn-sm suggestion-add" data-action="sugg-add" data-key="${esc(key)}">Add</button>
      </div>`;
  }).join('');

  const body = isEmpty
    ? `<div class="suggestions-empty">No suggestions right now.</div>`
    : `<div class="suggestions-scroll">${cards}</div>`;

  return `
  <div class="suggestions-panel">
    <button class="suggestions-toggle" id="suggestionsToggle">
      Suggestions${esc(countLabel)} <span class="filter-arrow">${arrow}</span>
    </button>
    <div class="suggestions-body ${bodyClass}" id="suggestionsBody">
      ${body}
    </div>
  </div>`;
}

// ── Filter bar (options come from get_transaction_facets; Apply sends the draft)

function _currentDraft() {
  if (_draft === null) {
    const { sort_col, sort_dir, page, page_size, ...filters } = _query;
    _draft = JSON.parse(JSON.stringify(filters));
  }
  return _draft;
}

function _facetLabel(entries, key, value) {
  const found = (entries ?? []).find(entry => entry[key] === value);
  return found === undefined ? value : (found.label ?? found.name ?? value);
}

// Accounts offered in the filter for the selected account types (facet lookup).
function _filterAccounts(facets, draft) {
  const accounts = facets?.accounts ?? [];
  if (draft.account_types.length === 0) return accounts;
  const ids = new Set(draft.account_types.flatMap(type => facets?.accounts_by_type?.[type] ?? []));
  return accounts.filter(account => ids.has(account.id));
}

// Minors for the selected majors (facet lookup).
function _filterMinors(facets, draft) {
  if (draft.major.length === 0) return facets?.minors ?? [];
  const seen = new Map();
  draft.major.forEach(major => (facets?.minors_by_major?.[major] ?? []).forEach(minor => { if (!seen.has(minor.key)) seen.set(minor.key, minor); }));
  return [...seen.values()];
}

function _checkboxList(items, attr, selected, emptyText) {
  if (items.length === 0) return `<span style="font-size:var(--text-sm);color:var(--muted)">${esc(emptyText)}</span>`;
  return items.map(item => `<label style="display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer">
      <input type="checkbox" ${attr}="${esc(item.value)}" ${selected.includes(item.value) ? 'checked' : ''}> ${esc(item.label)}${item.count !== undefined ? ` <span style="color:var(--muted);font-size:var(--text-xs)">(${esc(item.count)})</span>` : ''}
    </label>`).join('');
}

function _selectionLabel(values, lookup, allText) {
  return values.length === 0 ? allText : values.map(lookup).join(', ');
}

function _datalist(id, items) {
  // Always render the element so it exists in the DOM even before options load.
  if (!Array.isArray(items)) return `<datalist id="${esc(id)}"></datalist>`;
  return `<datalist id="${esc(id)}">${items.map(v => `<option value="${esc(String(v))}">`).join('')}</datalist>`;
}

// Tag prefix completion over the server's tag list (input UX only).
function _attachTagAutocomplete(inputId, datalistId, tags) {
  const input = el(inputId);
  const dl    = el(datalistId);
  if (input === null || input === undefined || dl === null || dl === undefined) return;
  input.addEventListener('input', () => {
    if (!Array.isArray(tags) || tags.length === 0) return;
    const val       = input.value;
    const lastComma = val.lastIndexOf(',');
    const prefix    = lastComma >= 0 ? val.slice(0, lastComma + 1) + ' ' : '';
    const partial   = val.slice(lastComma + 1).trimStart().toLowerCase();
    const existing  = new Set(val.split(',').map(t => t.trim().toLowerCase()).filter(v => v !== ''));
    const hits      = tags.filter(t =>
      (partial === '' || t.toLowerCase().startsWith(partial)) && !existing.has(t.toLowerCase())
    );
    dl.innerHTML = hits.map(t => `<option value="${esc(prefix + t)}">`).join('');
  });
}

const _TRIGGER_STYLE = 'width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none';
const _DROPDOWN_STYLE = 'position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.15)';

function _renderFilterBar() {
  const facets = _facets ?? {};
  const d = _currentDraft();
  const ranges = facets.ranges ?? [{ value: 'last_30', label: 'Last 30 days' }];
  const isCustomRange = d.range === 'custom';
  // Resolved bounds of the applied range come from the server.
  const applied = _list?.range ?? null;
  const showsApplied = applied !== null && applied.key === d.range;
  const rangeFromStr = isCustomRange ? d.from : (showsApplied ? (applied.from ?? '') : '');
  const rangeToStr   = isCustomRange ? d.to   : (showsApplied ? (applied.to ?? '') : '');
  const rangeDateStyle = (editable) => `background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);font-family:var(--grotesk);color:${editable ? 'var(--ink)' : 'var(--muted)'};cursor:${editable ? 'auto' : 'default'}`;
  const activeCount = _list?.active_filter_count ?? 0;

  const typeItems = (facets.types ?? []).map(t => ({ value: t.value, label: t.label }));
  const accTypeItems = (facets.account_types ?? []).map(t => ({ value: t.value, label: t.label, count: t.count }));
  const accountItems = _filterAccounts(facets, d).map(a => ({ value: a.id, label: a.name }));
  const majorItems = (facets.majors ?? []).map(m => ({ value: m.key, label: m.label }));
  const minorItems = _filterMinors(facets, d).map(m => ({ value: m.key, label: m.label }));
  const accountName = id => _facetLabel(facets.accounts, 'id', id);

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="filterToggle">
      Filters${activeCount ? ` (${esc(activeCount)})` : ''} <span class="filter-arrow">${filterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${filterOpen ? '' : 'hidden'}" id="filterBody">
      <div class="filter-row">
        <label>Date range</label>
        <div style="flex:1;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div id="filterDateRangeWrap" style="flex:1;min-width:140px;position:relative">
            <button id="filterDateRangeTrigger" type="button" style="${_TRIGGER_STYLE}">
              <span id="filterDateRangeLabel">${esc(_facetLabel(ranges, 'value', d.range))}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterDateRangeDropdown" class="hidden" style="position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 4px 16px rgba(0,0,0,.15)">
              ${ranges.map(o => `<div data-range-val="${esc(o.value)}" style="padding:6px 10px;font-size:var(--text-base);color:${d.range === o.value ? 'var(--ember)' : 'var(--ink)'};background:${d.range === o.value ? 'var(--hair)' : 'transparent'};border-radius:6px;cursor:pointer">${esc(o.label)}</div>`).join('')}
            </div>
          </div>
          <input type="date" id="filterDateFrom" value="${esc(rangeFromStr)}" ${isCustomRange ? '' : 'readonly'} style="${rangeDateStyle(isCustomRange)}">
          <span style="color:var(--muted)">–</span>
          <input type="date" id="filterDateTo" value="${esc(rangeToStr)}" ${isCustomRange ? '' : 'readonly'} style="${rangeDateStyle(isCustomRange)}">
        </div>
      </div>
      <div class="filter-row">
        <label>Type</label>
        <div id="filterTypeWrap" style="flex:1;min-width:120px;position:relative">
          <button id="filterTypeTrigger" type="button" style="${_TRIGGER_STYLE}">
            <span id="filterTypeLabel">${esc(_selectionLabel(d.types, v => _facetLabel(facets.types, 'value', v), 'All types'))}</span>
            <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
          </button>
          <div id="filterTypeDropdown" class="hidden" style="${_DROPDOWN_STYLE}">
            ${_checkboxList(typeItems, 'data-filter-type', d.types, 'No types')}
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Account</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <div id="filterAccTypeWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterAccTypeTrigger" type="button" style="${_TRIGGER_STYLE}">
              <span id="filterAccTypeLabel">${esc(_selectionLabel(d.account_types, v => _facetLabel(facets.account_types, 'value', v), 'All account types'))}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterAccTypeDropdown" class="hidden" style="${_DROPDOWN_STYLE}">
              ${_checkboxList(accTypeItems, 'data-acc-type', d.account_types, 'No account types')}
            </div>
          </div>
          <div id="filterAccountWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterAccountTrigger" type="button" style="${_TRIGGER_STYLE}">
              <span id="filterAccountLabel">${esc(_selectionLabel(d.account_ids, accountName, 'All accounts'))}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterAccountDropdown" class="hidden" style="${_DROPDOWN_STYLE};max-height:200px;overflow-y:auto">
              ${_checkboxList(accountItems, 'data-filter-account', d.account_ids, 'No accounts for selected type')}
            </div>
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Category</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <div id="filterMajorWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterMajorTrigger" type="button" style="${_TRIGGER_STYLE}">
              <span id="filterMajorLabel">${esc(_selectionLabel(d.major, v => _facetLabel(facets.majors, 'key', v), 'All major'))}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMajorDropdown" class="hidden" style="${_DROPDOWN_STYLE};max-height:240px;overflow-y:auto">
              ${_checkboxList(majorItems, 'data-filter-major', d.major, 'No major categories')}
            </div>
          </div>
          <div id="filterMinorWrap" style="flex:1;min-width:130px;position:relative">
            <button id="filterMinorTrigger" type="button" style="${_TRIGGER_STYLE}">
              <span id="filterMinorLabel">${esc(_selectionLabel(d.minor, v => _facetLabel(facets.minors, 'key', v), 'All minor'))}</span>
              <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
            </button>
            <div id="filterMinorDropdown" class="hidden" style="${_DROPDOWN_STYLE};max-height:240px;overflow-y:auto">
              ${_checkboxList(minorItems, 'data-filter-minor', d.minor, 'No minor categories')}
            </div>
          </div>
        </div>
      </div>
      <div class="filter-row">
        <label>Location</label>
        <div style="flex:1;display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="filterCountry" value="${esc(d.user_location_country)}" list="dlFCountry" placeholder="Country" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFCountry', facets.countries)}
          <input type="text" id="filterCity" value="${esc(d.user_location_city)}" list="dlFCity" placeholder="City" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFCity', facets.cities)}
          <input type="text" id="filterArea" value="${esc(d.user_location_area)}" list="dlFArea" placeholder="Area" autocomplete="off" style="flex:1;min-width:100px">
          ${_datalist('dlFArea', facets.areas)}
        </div>
      </div>
      <div class="filter-row">
        <label>Tag</label>
        <input type="text" id="filterTag" value="${esc(d.tag)}" placeholder="any tag" list="dlFTag" autocomplete="off">
        ${_datalist('dlFTag', facets.tags)}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="filterSearch" value="${esc(d.search)}" placeholder="counterparty, notes or account">
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="clearFilters">Clear</button>
        <button class="btn btn-primary btn-sm" id="applyFilters">Apply</button>
      </div>
    </div>
  </div>`;
}

// ── Transaction CSV import ────────────────────────────────────────────────────

function _renderTxImportPanel() {
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">Import transactions from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="txImportFile">CSV file</label>
        <input type="file" id="txImportFile" accept=".csv">
        <div class="field-hint">Columns: id (optional), tx_date_local, tx_timezone_local, tx_type, source_account, target_account, source_amount_local, target_amount_local, major_category, minor_category, description, counterparty_name, tx_tags, beneficiaries, user_location_area, user_location_city, user_location_country, user_location_latitude, user_location_longitude, record_status (optional; leave blank to preserve existing status)</div>
        <div class="field-hint">Accounts accept names or UUIDs. When names repeat, the category's account types must identify one account.</div>
        <div class="field-hint">The file is checked when you import. A formatting or account-name problem on any line stops the whole import; other rows that fail are listed by line while the rest are saved.</div>
      </div>
    </div>
    <div id="txImportStatus">${_txImportResult !== null ? _txImportResult : ''}</div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="txImportConfirm" disabled>Import</button>
      <button class="btn btn-secondary" id="txImportCancel">Cancel</button>
    </div>
    <div class="pin-error" id="txImportError"></div>
  </div>`;
}

// The backend parses and validates the file; the browser only sends its text
// and renders the outcome (summary, line-numbered failures, or file errors).
function _chooseTxImportFile(file) {
  if (_txImportBusy) return;
  _txImportFile = file ?? null;
  _txImportResult = null;
  const status = el('txImportStatus');
  if (status !== null) status.innerHTML = '';
  _updateTxImportControls();
}

function _updateTxImportControls() {
  const button = el('txImportConfirm');
  if (button !== null) {
    button.disabled = _txImportBusy || _txImportFile === null;
    button.textContent = _txImportBusy ? 'Importing…' : 'Import';
  }
  for (const id of ['txImportFile', 'txImportCancel', 'txImportBtn', 'txAddBtn']) {
    const control = el(id);
    if (control !== null) control.disabled = _txImportBusy;
  }
}

// Bulk import matches existing rows by id only, so id-less rows insert again on every import.
function _txImportWithoutIdNotice(count) {
  if (!(count > 0)) return '';
  return `<p class="field-hint" style="color:var(--ember);margin:4px 0 0">${count} row${count !== 1 ? 's have' : ' has'} no id; every import of this file inserts ${count !== 1 ? 'them' : 'it'} as new transaction${count !== 1 ? 's' : ''}. Export after importing to get ids for a safe re-import.</p>`;
}

function _renderTxImportOutcome(response) {
  const notice = (response?.created ?? 0) > 0 ? _txImportWithoutIdNotice(response.without_id) : '';
  const message = code => { const text = _transactionError(code); return text === code ? importErrorText(code) : text; };
  return renderImportResult(response, { message, notice });
}

async function _submitTxImport(file) {
  if (_txImportBusy || file === null || file === undefined) return;
  _txImportBusy = true;
  _updateTxImportControls();
  showLoading();
  let changed = false;
  let uncertain = false;
  try {
    let csv;
    try {
      csv = await file.text();
    } catch (_) {
      _txImportResult = '<p class="pin-error" role="alert">Could not read this CSV. Choose the file again.</p>';
      return;
    }
    const progress = el('txImportStatus');
    if (progress !== null) progress.textContent = 'Importing…';
    const response = await ExpenseAPI.createTransactionsBulk({ csv });
    // request_failed: the handler threw part-way, so rows may already be saved (uncertain).
    if (response?.error === 'request_failed') throw new Error('request_failed');
    if (Array.isArray(response?.errors) || (typeof response?.error === 'string' && !Array.isArray(response?.results))) {
      _txImportResult = Array.isArray(response.errors)
        ? _renderTxImportOutcome(response)
        : `<p class="pin-error" role="alert">${esc(_transactionError(response.error))} Nothing was imported.</p>`;
      showMsg('Transaction import failed. Review the reasons in the import panel.', 'warn');
      return;
    }
    if (!Array.isArray(response?.results) || !response.results.every(result => typeof result?.ok === 'boolean')) {
      uncertain = true;
      throw new Error(response?.error ?? 'incomplete_import_response');
    }
    const created = response.created ?? 0;
    const updated = response.updated ?? 0;
    const unchanged = response.skipped ?? 0;
    const failed = response.results.filter(result => !result.ok).length;
    changed = created + updated > 0;
    _txImportResult = _renderTxImportOutcome(response);
    if (failed === 0 && !(created > 0 && response.without_id > 0)) {
      _txImportResult = null;
      state.txImportOpen = false;
      showMsg(`${created} created · ${updated} updated · ${unchanged} unchanged`);
    } else if (failed === 0) {
      showMsg(`${created} created · ${updated} updated · ${unchanged} unchanged`);
    } else {
      showMsg(`${failed} transaction row${failed !== 1 ? 's' : ''} failed. Fix those lines in the file and import it again.`, 'warn');
    }
  } catch (error) {
    uncertain = true;
    const message = `Import stopped: ${error?.message ?? 'connection_error'}. Some rows may have been saved. Refresh and check before importing the file again.`;
    _txImportResult = `<p class="pin-error" role="alert">${esc(message)}</p>`;
    showMsg(message, 'warn');
  } finally {
    // The chosen file has been sent (or could not be read); choose it again to re-import.
    _txImportFile = null;
    _txImportBusy = false;
    const input = el('txImportFile');
    if (input !== null) input.value = '';
    const status = el('txImportStatus');
    if (status !== null && _txImportResult !== null) status.innerHTML = _txImportResult;
    _updateTxImportControls();
    if (changed || uncertain) document.dispatchEvent(new CustomEvent('et:reload'));
    hideLoading();
  }
}

function _attachSuggestionEvents() {
  el('suggestionsToggle').addEventListener('click', () => {
    state.suggestionsOpen = !state.suggestionsOpen;
    _refreshSuggestionsPanel();
  });
}

function _positionDropdown(triggerId, dropdownId) {
  const trigger  = el(triggerId);
  const dropdown = el(dropdownId);
  if (trigger === null || trigger === undefined || dropdown === null || dropdown === undefined) return;
  const rect = trigger.getBoundingClientRect();
  dropdown.style.top   = (rect.bottom + 4) + 'px';
  dropdown.style.left  = rect.left + 'px';
  dropdown.style.width = rect.width + 'px';
}

const _FILTER_DROPDOWN_IDS = ['filterDateRangeDropdown','filterTypeDropdown','filterAccTypeDropdown','filterAccountDropdown','filterMajorDropdown','filterMinorDropdown'];
const _FILTER_WRAP_IDS     = ['filterDateRangeWrap','filterTypeWrap','filterAccTypeWrap','filterAccountWrap','filterMajorWrap','filterMinorWrap'];

function _closeAllFilterDropdowns(exceptId) {
  _FILTER_DROPDOWN_IDS.forEach(id => { const d = el(id); if ((d !== null && d !== undefined) && id !== exceptId) d.classList.add('hidden'); });
}

function _bindDropdown(triggerId, dropdownId) {
  const trigger  = el(triggerId);
  const dropdown = el(dropdownId);
  if (!trigger || !dropdown) return null;
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const opening = dropdown.classList.contains('hidden');
    if (opening) _closeAllFilterDropdowns(dropdownId);
    dropdown.classList.toggle('hidden');
    if (opening) _positionDropdown(triggerId, dropdownId);
  });
  return dropdown;
}

// Checkbox changes edit the draft only; Apply sends it to the server.
function _bindDraftCheckboxes(dropdown, attr, key, onChange) {
  if (!dropdown) return;
  const dataKey = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  dropdown.querySelectorAll(`[${attr}]`).forEach(cb => {
    cb.addEventListener('change', () => {
      const d = _currentDraft();
      const value = cb.dataset[dataKey];
      if (cb.checked) { if (!d[key].includes(value)) d[key].push(value); }
      else { d[key] = d[key].filter(x => x !== value); }
      if (onChange) onChange();
    });
  });
}

function _refreshFilterBar() {
  const body = el('filterBody');
  const wasOpen = body !== null && body !== undefined && !body.classList.contains('hidden');
  filterOpen = wasOpen || filterOpen;
  _renderListRegion();
}

function _applyDraft() {
  const d = _currentDraft();
  Object.assign(_query, JSON.parse(JSON.stringify(d)), { page: 1 });
  _draft = null;
  renderTransactions();
}

function _attachFilterEvents() {
  if (_filterEventsAbort) _filterEventsAbort.abort();
  _filterEventsAbort = new AbortController();
  const { signal: filterSignal } = _filterEventsAbort;
  const facets = _facets ?? {};

  el('filterToggle').addEventListener('click', () => { filterOpen = !filterOpen; _renderListRegion(); }, { signal: filterSignal });

  // ── Date range ────────────────────────────────────────────────────────────
  const dateRangeDropdown = _bindDropdown('filterDateRangeTrigger', 'filterDateRangeDropdown');
  if (dateRangeDropdown) {
    dateRangeDropdown.querySelectorAll('[data-range-val]').forEach(item => {
      item.addEventListener('click', () => {
        const d = _currentDraft();
        d.range = item.dataset.rangeVal;
        d.from = '';
        d.to = '';
        _refreshFilterBar();
      });
    });
  }
  el('filterDateFrom').addEventListener('change', e => { const d = _currentDraft(); d.from = e.target.value; d.range = 'custom'; _refreshFilterBar(); });
  el('filterDateTo').addEventListener('change', e => { const d = _currentDraft(); d.to = e.target.value; d.range = 'custom'; _refreshFilterBar(); });

  const setLabel = (id, values, lookup, allText) => { const node = el(id); if (node) node.textContent = _selectionLabel(values, lookup, allText); };

  _bindDraftCheckboxes(_bindDropdown('filterTypeTrigger', 'filterTypeDropdown'), 'data-filter-type', 'types',
    () => setLabel('filterTypeLabel', _currentDraft().types, v => _facetLabel(facets.types, 'value', v), 'All types'));

  const accountLabel = () => setLabel('filterAccountLabel', _currentDraft().account_ids, id => _facetLabel(facets.accounts, 'id', id), 'All accounts');
  const minorLabel = () => setLabel('filterMinorLabel', _currentDraft().minor, v => _facetLabel(facets.minors, 'key', v), 'All minor');
  // Dependent lists refresh in place so the open dropdown stays open.
  const refreshAccounts = () => {
    const d = _currentDraft();
    const offered = _filterAccounts(facets, d);
    const ids = new Set(offered.map(a => a.id));
    d.account_ids = d.account_ids.filter(id => ids.has(id));
    const dropdown = el('filterAccountDropdown');
    if (dropdown) {
      dropdown.innerHTML = _checkboxList(offered.map(a => ({ value: a.id, label: a.name })), 'data-filter-account', d.account_ids, 'No accounts for selected type');
      _bindDraftCheckboxes(dropdown, 'data-filter-account', 'account_ids', accountLabel);
    }
    accountLabel();
  };
  const refreshMinors = () => {
    const d = _currentDraft();
    const offered = _filterMinors(facets, d);
    const keys = new Set(offered.map(m => m.key));
    d.minor = d.minor.filter(key => keys.has(key));
    const dropdown = el('filterMinorDropdown');
    if (dropdown) {
      dropdown.innerHTML = _checkboxList(offered.map(m => ({ value: m.key, label: m.label })), 'data-filter-minor', d.minor, 'No minor categories');
      _bindDraftCheckboxes(dropdown, 'data-filter-minor', 'minor', minorLabel);
    }
    minorLabel();
  };

  // Account types narrow the account choices (and filter rows once applied).
  _bindDraftCheckboxes(_bindDropdown('filterAccTypeTrigger', 'filterAccTypeDropdown'), 'data-acc-type', 'account_types', () => {
    setLabel('filterAccTypeLabel', _currentDraft().account_types, v => _facetLabel(facets.account_types, 'value', v), 'All account types');
    refreshAccounts();
  });
  _bindDraftCheckboxes(_bindDropdown('filterAccountTrigger', 'filterAccountDropdown'), 'data-filter-account', 'account_ids', accountLabel);
  _bindDraftCheckboxes(_bindDropdown('filterMajorTrigger', 'filterMajorDropdown'), 'data-filter-major', 'major', () => {
    setLabel('filterMajorLabel', _currentDraft().major, v => _facetLabel(facets.majors, 'key', v), 'All major');
    refreshMinors();
  });
  _bindDraftCheckboxes(_bindDropdown('filterMinorTrigger', 'filterMinorDropdown'), 'data-filter-minor', 'minor', minorLabel);

  // ── Global outside-click: close all dropdowns when clicking outside every wrap ──
  document.addEventListener('click', e => {
    const inAnyWrap = _FILTER_WRAP_IDS.some(id => { const w = el(id); return (w !== null && w !== undefined) && w.contains(e.target); });
    if (!inAnyWrap) _closeAllFilterDropdowns();
  }, { signal: filterSignal });

  const bindText = (id, key) => el(id).addEventListener('input', e => { _currentDraft()[key] = e.target.value.trim(); });
  bindText('filterCountry', 'user_location_country');
  bindText('filterCity',    'user_location_city');
  bindText('filterArea',    'user_location_area');
  bindText('filterTag',     'tag');
  bindText('filterSearch',  'search');
  _attachTagAutocomplete('filterTag', 'dlFTag', facets.tags);

  el('applyFilters').addEventListener('click', _applyDraft);
  el('clearFilters').addEventListener('click', () => {
    _draft = _DEFAULT_FILTERS();
    _applyDraft();
  });
}
