import { state } from '../core/state.js';
import { el, esc, exportSubscriptions, openContextMenu, syncStatusIcon, recordStatusIcon, renderImportResult, clearFormError, showFormError } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// The section renders server view models only:
// - list_subscriptions_view: rows (schedule, next payment, due-in days, monthly
//   equivalent in the quote currency, allowed_actions), summary and facets;
//   filter / sort / page selections travel as request params.
// - get_subscription_form_options: eligible categories, source accounts,
//   frequencies and day labels for the add / edit form.
const LIST_VIEW = 'list_subscriptions_view';
const FORM_VIEW = 'get_subscription_form_options';
const ESTIMATE_VIEW = 'get_subscription_estimate';
const PAGE_SIZES = ['all', 10, 25, 50];

function _schemaReady() {
  return ['frequencies', 'tx_types', 'record_statuses'].every(key =>
    Array.isArray(state.subscriptionSchema?.[key]) && state.subscriptionSchema[key].length > 0
  );
}

function _recordStatuses() { return state.subscriptionSchema.record_statuses; }

let _listSeq = 0;
let _listLoading = false;
let _listError = null;
let _subPage = 1;
let _subPageSize = 'all';
let _subDraft = null;          // pending filter edits; applied to state.subFilters on Apply
let _formOptions = null;       // { key, data } for the open add / edit form
let _formOptionsError = null;
let _formSeq = 0;

// ── Estimate selection ────────────────────────────────────────────────────────
// Which subscriptions the monthly estimate covers is UI state for this visit
// only; the server computes every figure. null = all active (the default).
let _selectMode = false;
let _selection = null;
let _estimateRes = null;
let _estimateLoading = false;
let _estimateSeq = 0;
let _estimateTimer = null;

function _defaultSelectedIds() {
  return _listPayload()?.data.summary.estimate?.selected_ids ?? [];
}

function _setSelection(next) {
  _selection = next;
  if (_selection === null) {
    clearTimeout(_estimateTimer);
    _estimateSeq++;
    _estimateRes = null;
    _estimateLoading = false;
    _refreshTablePart();
    return;
  }
  _scheduleEstimate();
}

// Taps are batched so a run of quick selections costs one server request.
function _scheduleEstimate() {
  clearTimeout(_estimateTimer);
  _estimateLoading = true;
  _refreshTablePart();
  _estimateTimer = setTimeout(_loadEstimate, 450);
}

async function _loadEstimate() {
  if (_selection === null) return;
  const seq = ++_estimateSeq;
  const ids = Array.from(_selection);
  try {
    const res = await ExpenseAPI.view(ESTIMATE_VIEW, { ids: ids.length === 0 ? 'none' : ids });
    if (seq !== _estimateSeq || _selection === null) return;
    _estimateRes = res;
  } catch (err) {
    if (seq !== _estimateSeq) return;
    console.error('[subscriptions] estimate failed:', err);
    _estimateRes = { ok: false, message: 'Connection error. The estimate could not be updated.' };
  }
  _estimateLoading = false;
  _refreshTablePart();
}

function _toggleSelected(id) {
  const sub = _rowById(id);
  if (sub === null || sub.selectable !== true) return;
  const next = new Set(_selection ?? _defaultSelectedIds());
  const key = String(id).toLowerCase();
  if (next.has(key)) next.delete(key); else next.add(key);
  _setSelection(next);
}

function _isSelected(sub) {
  if (sub.selectable !== true) return false;
  const key = String(sub.id).toLowerCase();
  return _selection === null ? _defaultSelectedIds().includes(key) : _selection.has(key);
}

function _listPayload() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true && response.data !== null && typeof response.data === 'object' ? response : null;
}

function _viewRows() { return _listPayload()?.data.rows ?? []; }

// Open panels / confirmations hold the subscription id (a Sheet row number can
// move after an import or a manual sort). Mutations send the row_num + id +
// updated_at of the row found here; the server's stale_record check stays.
function _rowById(id) {
  return typeof id === 'string' && id !== '' ? (_viewRows().find(sub => sub.id === id) ?? null) : null;
}

// Row identity for mutations: the server rejects a stale or moved row (stale_record).
function _identity(sub) {
  return sub === null || sub === undefined ? {} : { id: sub.id, updated_at: sub.updated_at };
}

// The edited row: from the latest view, else the snapshot taken when the form
// opened (a later filter or page change may hide the row from the list).
let _editSnapshot = null;
function _editRecord() {
  if (state.subEditRow === null) return null;
  const row = _rowById(state.subEditRow);
  if (row !== null) { _editSnapshot = row; return row; }
  return _editSnapshot !== null && _editSnapshot.id === state.subEditRow ? _editSnapshot : null;
}

// ── Request params ────────────────────────────────────────────────────────────

// Filters / sort / page → list_subscriptions_view params. All statuses selected
// is the default (no param); an empty selection is sent as 'none'.
function _listParams(overrides = {}) {
  const f = state.subFilters;
  const all = _recordStatuses().every(status => f.recordStatuses.includes(status));
  return {
    statuses: all ? undefined : (f.recordStatuses.length === 0 ? 'none' : f.recordStatuses),
    major: f.majorCategory === 'all' ? undefined : f.majorCategory,
    frequency: f.frequency === 'all' ? undefined : f.frequency,
    search: f.search,
    sort_col: state.subSort.col,
    sort_dir: state.subSort.dir,
    page: _subPage,
    page_size: _subPageSize,
    ...overrides,
  };
}

async function _loadList() {
  const seq = ++_listSeq;
  _listLoading = true;
  // Every list request (open, filter, sort, page) shows the loader, as on Transactions.
  showLoading();
  try {
    const res = await ExpenseAPI.view(LIST_VIEW, _listParams());
    if (seq !== _listSeq) return;
    if (res?.ok === true) {
      state.views[LIST_VIEW] = res;
      _listError = null;
      _subPage = res.data.page ?? 1;
      if (_selection !== null) _scheduleEstimate();
    } else {
      console.warn('[subscriptions] list view failed:', res?.error);
      _listError = res?.message || (res?.error ? `Subscriptions could not be loaded: ${res.error}` : 'Subscriptions could not be loaded.');
    }
  } catch (err) {
    if (seq !== _listSeq) return;
    console.error('[subscriptions] list view failed:', err);
    _listError = 'Connection error. Subscriptions could not be refreshed.';
  } finally {
    hideLoading();
    if (seq === _listSeq) {
      _listLoading = false;
      _refreshListParts();
    }
  }
}

// ── Form options ──────────────────────────────────────────────────────────────

function _formKey() {
  if (state.subEditRow !== null) return 'edit:' + (_editRecord()?.id ?? state.subEditRow);
  return state.subAddOpen ? 'add' : null;
}

function _options() {
  return _formOptions !== null && _formOptions.key === _formKey() ? _formOptions.data : null;
}

async function _loadFormOptions() {
  const key = _formKey();
  if (key === null) return;
  const seq = ++_formSeq;
  _formOptionsError = null;
  const record = _editRecord();
  const shown = _options();
  try {
    const res = await ExpenseAPI.view(FORM_VIEW, record === null ? {} : { id: record.id });
    if (seq !== _formSeq || _formKey() !== key) return;
    if (res?.ok === true) {
      _formOptions = { key, data: res.data };
      // Cached options already rendered the form: keep what the user typed unless they changed.
      if (shown !== null && JSON.stringify(shown) === JSON.stringify(res.data)) return;
    } else {
      console.warn('[subscriptions] form options failed:', res?.error);
      _formOptionsError = res?.message || 'The form could not be loaded. Close it and try again.';
    }
  } catch (err) {
    if (seq !== _formSeq) return;
    console.error('[subscriptions] form options failed:', err);
    _formOptionsError = 'Connection error. The form could not be loaded.';
  }
  _refreshFormPart();
}

// ── Form HTML ─────────────────────────────────────────────────────────────────

// Server validation → form: the form shows the server `message` and highlights
// the input named by `field`.
const _SUB_FIELD_IDS = {
  subscription_name: 'subName', subscription_amount_local: 'subAmount', frequency: 'subFrequency',
  day_of_week: 'subDayOfWeek', day_of_month: 'subDayOfMonth', source_account: 'subSourceAccount',
  tx_type: 'subTxType', major_category: 'subMajor', minor_category: 'subMinor',
  subscription_timezone_local: 'subTimezone', subscription_start_date_local: 'subStartDate',
  subscription_end_date_local: 'subEndDate',
};

function _localTimestamp(value) {
  const text = String(value ?? '').trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text + ' 00:00:00';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text + ':00';
  return text;
}

function _timestampOrder(value) {
  return value.slice(0, 19) + '.' + (value.split('.')[1] ?? '').padEnd(6, '0');
}

function _dateInputValue(value) {
  // Native datetime inputs support milliseconds; preserve any finer source
  // precision in _collectLocalTimestamp when the displayed value is unchanged.
  return String(value ?? '').replace(' ', 'T').slice(0, 23);
}

function _collectLocalTimestamp(id, key) {
  const value = _localTimestamp(el(id).value);
  const original = _editRecord()?.[key];
  if (original !== undefined && original !== null && _timestampOrder(value) === _timestampOrder(_localTimestamp(_dateInputValue(original)))) return _localTimestamp(original);
  return value;
}

function _txTypeOpts(selected = '') {
  const types = _options()?.tx_types ?? [];
  return `<option value="">— select —</option>` +
    types.map(t => `<option value="${esc(t.value)}"${t.value === selected ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
}

// A stored value the options tree does not list stays visible (and unselectable).
function _storedCategoryOption(selectedVal) {
  return selectedVal === undefined || selectedVal === null || selectedVal === '' ? '' :
    `<option value="${esc(selectedVal)}" selected disabled>${esc(selectedVal)} (stored)</option>`;
}

// Lookups in the server tree: entries with active:false render disabled "(archived)".
function _categoryOptionHtml(entries, selectedVal) {
  return `<option value="">— select —</option>` +
    entries.map(entry => {
      const sel = selectedVal === entry.key ? ' selected' : '';
      return entry.active
        ? `<option value="${esc(entry.key)}"${sel}>${esc(entry.label)}</option>`
        : `<option value="${esc(entry.key)}"${sel} disabled style="color:var(--muted)">${esc(entry.label)} (archived)</option>`;
    }).join('') + (entries.some(entry => entry.key === selectedVal) ? '' : _storedCategoryOption(selectedVal));
}

function _majorEntries(txType) {
  return (_options()?.categories ?? []).find(type => type.tx_type === txType)?.majors ?? [];
}

function _majorSelectHtml(txType, selectedVal = '') {
  if (txType === undefined || txType === null || txType === '') return `<option value="">— select type first —</option>` + _storedCategoryOption(selectedVal);
  return _categoryOptionHtml(_majorEntries(txType), selectedVal);
}

function _minorSelectHtml(txType, major, selectedVal = '') {
  if (txType === undefined || txType === null || txType === '' || major === undefined || major === null || major === '') {
    return `<option value="">— select type and major first —</option>` + _storedCategoryOption(selectedVal);
  }
  return _categoryOptionHtml(_majorEntries(txType).find(entry => entry.key === major)?.minors ?? [], selectedVal);
}

function _dayFieldHtml(frequency, dayVal = '') {
  if (frequency === 'weekly') {
    const opts = (_options()?.days_of_week ?? []).map(d =>
      `<option value="${esc(d.value)}" ${String(dayVal) === d.value ? 'selected' : ''}>${esc(d.label)}</option>`
    ).join('');
    return `<label for="subDayOfWeek">Day of week</label><select id="subDayOfWeek">${opts}</select>`;
  }
  const range = _options()?.day_of_month ?? { min: 1, max: 31 };
  return `<label for="subDayOfMonth">Day of month</label>
    <input type="number" id="subDayOfMonth" min="${esc(range.min)}" max="${esc(range.max)}" step="1"${dayVal !== '' && dayVal !== null && dayVal !== undefined ? ` value="${esc(String(dayVal))}"` : ''}>`;
}

function _renderForm(sub = null) {
  const o = _options();
  if (o === null) {
    return `<div class="card" style="margin-bottom:20px">${_formOptionsError === null
      ? '<p class="placeholder">Loading form…</p>'
      : `<p class="pin-error" role="alert">${esc(_formOptionsError)}</p>`}
      <div class="form-actions"><button class="btn btn-secondary btn-sm" data-action="sub-cancel">Cancel</button></div></div>`;
  }
  const p      = state.subPrefill;   // null when opening a fresh form; non-null when subscribing from a tx
  const isEdit = sub !== null;
  const pick = (key, fallback = '') => (p !== null && p !== undefined && p[key] !== undefined && p[key] !== null && p[key] !== '' ? p[key] : fallback);

  const nameVal        = isEdit ? sub.subscription_name : pick('name');
  const cpVal          = isEdit ? sub.counterparty_name : pick('counterparty_name');
  const amountVal      = isEdit ? sub.subscription_amount_local : pick('amount');
  const freqVal        = isEdit ? sub.frequency         : pick('frequency', o.default_frequency);
  const srcAccVal      = isEdit ? sub.source_account    : pick('source_account');
  const txTypeVal      = isEdit ? sub.tx_type           : pick('tx_type');
  const majorVal       = isEdit ? sub.major_category    : pick('major_category');
  const minorVal       = isEdit ? sub.minor_category    : pick('minor_category');
  const descriptionVal = isEdit ? sub.description       : '';
  const dayVal         = isEdit ? (sub.frequency === 'weekly' ? sub.day_of_week : sub.day_of_month) : '';
  const startDateVal   = isEdit ? sub.subscription_start_date_local : '';
  const endDateVal     = isEdit ? sub.subscription_end_date_local   : '';
  const timezoneVal    = isEdit ? sub.subscription_timezone_local : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const freqOpts = o.frequencies.map(f =>
    `<option value="${esc(f.value)}" ${freqVal === f.value ? 'selected' : ''}>${esc(f.label)}</option>`
  ).join('');
  const accOpts = `<option value="">— select —</option>` +
    o.source_accounts.map(a => `<option value="${esc(a.id)}" ${a.id === srcAccVal ? 'selected' : ''}>${esc(a.label)}</option>`).join('');

  const header = isEdit ? `Editing: ${esc(sub.subscription_name)}` : 'New subscription';

  return `
  <div class="card" style="margin-bottom:20px">
    <div class="cat-form-header">${header}</div>
    <div class="form-grid form-grid-4">
      <div class="field form-grid-span-4">
        <label for="subName">Name *</label>
        <input type="text" id="subName" value="${esc(nameVal)}" placeholder="Netflix, Spotify, …">
      </div>
      <div class="field form-grid-span-4">
        <label for="subCounterparty">Counterparty name</label>
        <input type="text" id="subCounterparty" value="${esc(cpVal)}" placeholder="Netflix Inc.">
      </div>
      <div class="field form-grid-span-2">
        <label for="subAmount">Amount *</label>
        <input type="number" id="subAmount" min="0" step="any" placeholder="0.00" value="${esc(String(amountVal))}">
      </div>
      <div class="field form-grid-span-2">
        <label for="subFrequency">Frequency *</label>
        <select id="subFrequency">${freqOpts}</select>
      </div>
      <div class="field form-grid-span-2" id="subDayWrap">
        ${_dayFieldHtml(freqVal, dayVal)}
      </div>
      <div class="field form-grid-span-2">
        <label for="subStartDate">Start date</label>
        <input type="datetime-local" step="any" id="subStartDate" value="${esc(_dateInputValue(startDateVal))}">
        <div class="field-hint">Required for quarterly and annual payments; its month anchors the schedule.</div>
      </div>
      <div class="field form-grid-span-2">
        <label for="subEndDate">End date</label>
        <input type="datetime-local" step="any" id="subEndDate" value="${esc(_dateInputValue(endDateVal))}">
      </div>
      <div class="field form-grid-span-2">
        <label for="subTimezone">Timezone</label>
        <input type="text" id="subTimezone" value="${esc(timezoneVal ?? '')}" placeholder="${esc(o.default_timezone ?? '')}">
        <div class="field-hint">Payments follow this timezone. Required when start or end dates are supplied.</div>
      </div>
      <div class="field form-grid-span-2">
        <label for="subSourceAccount">Source account *</label>
        <select id="subSourceAccount">${accOpts}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subTxType">Transaction type</label>
        <select id="subTxType">${_txTypeOpts(txTypeVal)}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subMajor">Major category</label>
        <select id="subMajor">${_majorSelectHtml(txTypeVal, majorVal)}</select>
      </div>
      <div class="field form-grid-span-2">
        <label for="subMinor">Minor category</label>
        <select id="subMinor">${_minorSelectHtml(txTypeVal, majorVal, minorVal)}</select>
      </div>
      <div class="field form-grid-span-4">
        <label for="subDescription">Notes</label>
        <textarea id="subDescription" placeholder="Optional note">${esc(descriptionVal)}</textarea>
      </div>
    </div>
    <div class="form-actions">
      <button id="subSaveBtn" class="btn btn-primary btn-sm" data-action="sub-save">Save</button>
      <button class="btn btn-secondary btn-sm" data-action="sub-cancel">Cancel</button>
    </div>
    <div class="pin-error" id="subFormError"></div>
  </div>`;
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function _renderSubFilterBar() {
  const payload = _listPayload();
  const facets = payload?.data.facets ?? { majors: [], frequencies: [], statuses: _recordStatuses().map(value => ({ value, label: value })) };
  const activeCount = payload?.data.active_filter_count ?? 0;
  const f = _subDraft ?? state.subFilters;
  const rs = new Set(f.recordStatuses);
  const optStyle = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';
  const majors = facets.majors.some(m => m.key === f.majorCategory) || f.majorCategory === 'all'
    ? facets.majors : [...facets.majors, { key: f.majorCategory, label: f.majorCategory }];

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="subFilterToggle">
      Filters${activeCount ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.subFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.subFilterOpen ? '' : 'hidden'}" id="subFilterBody">
      <div class="filter-row">
        <label>Status</label>
        <div style="display:flex;flex-wrap:wrap;gap:12px">
          ${facets.statuses.map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-sub-filter-rstat="${esc(s.value)}"${rs.has(s.value) ? ' checked' : ''}> ${esc(s.label)}</label>`
          ).join('')}
        </div>
      </div>
      <div class="filter-row">
        <label>Category</label>
        <select id="subFMajor" style="flex:1">
          <option value="all">All categories</option>
          ${majors.map(m => `<option value="${esc(m.key)}"${f.majorCategory === m.key ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-row">
        <label>Frequency</label>
        <select id="subFFrequency" style="flex:1">
          <option value="all">All</option>
          ${facets.frequencies.map(fr => `<option value="${esc(fr.value)}"${f.frequency === fr.value ? ' selected' : ''}>${esc(fr.label)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="subFSearch" placeholder="name, counterparty, notes…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-actions">
        <button class="btn btn-secondary btn-sm" id="subFilterClear">Clear</button>
        <button class="btn btn-primary btn-sm" id="subFilterApply">Apply</button>
      </div>
    </div>
  </div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

const _money = value => Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function _subCells(sub, sym) {
  const amtFmt  = `${sub.currency_symbol}${sub.amount.native === null ? '—' : _money(sub.amount.native)}/${sub.frequency_short}`;
  const baseAmt = sub.is_foreign ? (sub.monthly.quote === null ? '—' : `${sym}${_money(sub.monthly.quote)}/mo`) : '';
  let nextText = sub.schedule_status === 'expired' ? 'Expired' : sub.schedule_status === 'invalid' ? 'Invalid schedule' : '—';
  let duePart = '';
  if (sub.is_scheduled && sub.next_payment_date !== '') {
    const [ny, nm, nd] = sub.next_payment_date.split('-').map(Number);
    nextText = new Date(ny, nm - 1, nd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const diffDays = sub.due_in_days;
    duePart = diffDays === null ? '' : diffDays === 0 ? 'today' : diffDays === 1 ? 'tomorrow' : diffDays > 0 ? `in ${diffDays}d` : `${Math.abs(diffDays)}d overdue`;
  }
  return { amtFmt, baseAmt, nextText, duePart, accName: sub.account_name !== '' ? sub.account_name : '—' };
}

function _selectAttrs(sub) {
  if (!_selectMode) return '';
  if (sub.selectable !== true) return ' aria-disabled="true"';
  return ` data-sub-select="${esc(sub.id)}" role="checkbox" aria-checked="${_isSelected(sub)}" tabindex="0"`;
}

function _renderSubCard(sub, sym) {
  const id = sub.id;
  if (state.subDeleteRow === id) {
    return `<div class="sub-card">
      <span class="confirm-text">Delete <strong>${esc(sub.subscription_name)}</strong>?</span>
      <span class="row-actions">
        <button class="btn-link danger" data-action="sub-confirm-delete" data-row="${esc(id)}">Yes, delete</button>
        <button class="btn-link" data-action="sub-cancel-delete">Cancel</button>
      </span>
    </div>`;
  }
  const c = _subCells(sub, sym);
  const selected = _selectMode && _isSelected(sub);
  const side = _selectMode
    ? `<span class="sub-check${selected ? ' is-on' : ''}" aria-hidden="true">${selected ? '✓' : ''}</span>`
    : `${recordStatusIcon(sub.record_status)}${syncStatusIcon(sub.sync_status)}
       <button class="tx-menu-trigger" data-action="sub-menu" data-row="${esc(id)}" title="Actions">⋮</button>`;
  return `<div class="sub-card${sub.is_scheduled ? '' : ' is-unscheduled'}${selected ? ' is-selected' : ''}"${_selectAttrs(sub)}>
    <div class="sub-card-main">
      <div class="sub-card-name">${esc(sub.subscription_name)}</div>
      <div class="sub-card-meta">${esc(c.accName)} · ${esc(c.nextText)}${c.duePart !== '' ? ` <span class="sub-card-due">(${esc(c.duePart)})</span>` : ''}</div>
    </div>
    <div class="sub-card-amt td-mono">${esc(c.amtFmt)}${c.baseAmt !== '' ? `<div class="td-base-amt">${esc(c.baseAmt)}</div>` : ''}</div>
    <div class="sub-card-side">${side}</div>
  </div>`;
}

function _renderSubRow(sub, sym) {
  const row = sub.id;

  if (state.subDeleteRow === row) {
    return `<tr>
      <td colspan="${_selectMode ? 6 : 5}">
        <span class="confirm-text">Delete <strong>${esc(sub.subscription_name)}</strong>?</span>
        <span style="display:inline-flex;gap:8px;margin-left:16px">
          <button class="btn-link danger" data-action="sub-confirm-delete" data-row="${esc(row)}">Yes, delete</button>
          <button class="btn-link" data-action="sub-cancel-delete">Cancel</button>
        </span>
      </td>
    </tr>`;
  }

  const amtFmt  = `${sub.currency_symbol}${sub.amount.native === null ? '—' : _money(sub.amount.native)}/${sub.frequency_short}`;
  const baseAmt = sub.is_foreign
    ? `<span class="td-base-amt">${sub.monthly.quote === null ? '—' : `${esc(sym)}${esc(_money(sub.monthly.quote))}/mo`}</span>`
    : '';

  let nextCell = sub.schedule_status === 'expired' ? 'Expired' : sub.schedule_status === 'invalid' ? 'Invalid schedule' : '—';
  if (sub.is_scheduled && sub.next_payment_date !== '') {
    const [ny, nm, nd] = sub.next_payment_date.split('-').map(Number);
    const nextFmt  = new Date(ny, nm - 1, nd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const diffDays = sub.due_in_days;
    const duePart  = diffDays === 0 ? 'today'
                   : diffDays === 1 ? 'tomorrow'
                   : diffDays  >  0 ? `in ${diffDays}d`
                   : `${Math.abs(diffDays)}d overdue`;
    nextCell = esc(nextFmt) + (diffDays === null ? '' : ` <span class="sub-card-due">(${esc(duePart)})</span>`);
  }

  const accName = sub.account_name !== '' ? sub.account_name : '—';

  const selected = _selectMode && _isSelected(sub);
  const checkCell = _selectMode
    ? `<td class="sub-check-cell">${sub.selectable === true ? `<span class="sub-check${selected ? ' is-on' : ''}" aria-hidden="true">${selected ? '✓' : ''}</span>` : ''}</td>`
    : '';
  return `<tr class="${selected ? 'is-selected' : ''}"${sub.is_scheduled ? '' : ' style="opacity:0.6"'}${_selectAttrs(sub)}>
    ${checkCell}
    <td>${esc(sub.subscription_name)}</td>
    <td class="td-truncate" title="${esc(accName)}">${esc(accName)}</td>
    <td class="td-nowrap">${nextCell}</td>
    <td class="td-mono td-nowrap">${esc(amtFmt)}${baseAmt}</td>
    <td style="text-align:right;white-space:nowrap">
      ${recordStatusIcon(sub.record_status)}
      ${syncStatusIcon(sub.sync_status)}
      ${_selectMode ? '' : `<button class="tx-menu-trigger" data-action="sub-menu" data-row="${esc(row)}" title="Actions">⋮</button>`}
    </td>
  </tr>`;
}

function _renderPager(data) {
  const size = data.page_size === 'all' ? 'all' : Number(data.page_size);
  const sizes = PAGE_SIZES.map(n => `<option value="${esc(n)}"${String(size) === String(n) ? ' selected' : ''}>${n === 'all' ? 'All' : `${n} / page`}</option>`).join('');
  return `
    <div class="pagination">
      <button class="btn btn-secondary btn-sm" id="subPrevPage" ${data.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${esc(data.page)} of ${esc(data.pages)} (${esc(data.total)} rows)</span>
      <select id="subPerPage" class="per-page-select">${sizes}</select>
      <button class="btn btn-secondary btn-sm" id="subNextPage" ${data.page >= data.pages ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function _renderTable(response = _listPayload()) {
  if (response === null) {
    return _listError !== null
      ? `<p class="pin-error" role="alert">${esc(_listError)}</p>`
      : `<p class="placeholder">Loading subscriptions…</p>`;
  }
  const { data, quote } = response;
  const sym = quote?.symbol ?? '';
  const quoteCurrency = quote?.currency ?? state.quoteCurrency;
  const notice = _listError !== null
    ? `<p class="pin-error" role="alert">${esc(_listError)} Showing the last loaded list.</p>`
    : '';

  const thSort = (col, label) => {
    const active = state.subSort.col === col;
    return `<th class="${active ? `sort-${state.subSort.dir}` : ''}" data-sub-sort="${esc(col)}">${esc(label)}</th>`;
  };
  const { summary } = data;
  const custom = _selection !== null;
  const estimateError = custom && _estimateRes !== null && _estimateRes.ok !== true ? (_estimateRes.message || 'The estimate could not be updated.') : null;
  const est = custom && _estimateRes?.ok === true ? _estimateRes.data.estimate : summary.estimate;
  const stale = _estimateLoading || (custom && _estimateRes === null);
  // The chosen count is known locally at once; the money waits for the server.
  const scope = custom ? `${_selection.size} selected` : `All ${est.considered_count} active`;
  const moneyText = value => `${sym}${_money(value)}`;

  return `${notice}
    <div class="summary-grid" style="margin-bottom:12px">
      <div class="summary-card">
        <div class="summary-card-label">Scheduled / Total</div>
        <div class="summary-card-value">${esc(summary.scheduled_count)} / ${esc(summary.total_count)}</div>
      </div>
      <div class="summary-card sub-estimate${stale ? ' is-stale' : ''}" aria-busy="${stale}">
        <div class="summary-card-label">Est. monthly amount</div>
        <div class="summary-card-value">${esc(moneyText(est.out_quote))}${est.partial ? ' (partial)' : ''}</div>
        <div class="summary-card-sub">${esc(scope)}${stale ? ' · updating…' : ''}${est.in_quote > 0 ? ` · income ${esc(moneyText(est.in_quote))}` : ''}</div>
      </div>
    </div>
    <div class="sub-estimate-actions">
      <button class="btn btn-secondary btn-sm" id="subSelectBtn" aria-pressed="${_selectMode}">${_selectMode ? 'Done' : 'Choose subscriptions'}</button>
      ${custom ? '<button class="btn-link" id="subSelReset">Use all active</button>' : ''}
    </div>
    ${estimateError !== null ? `<p class="pin-error" role="alert">${esc(estimateError)}</p>` : ''}
    <p class="field-hint" style="margin-bottom:12px">Amounts converted to ${esc(quoteCurrency)}. Quarterly ÷ 3, Annual ÷ 12, Weekly × 52 ÷ 12. Covers outgoing scheduled payments.${est.partial ? ` ${esc(est.missing_rate_count)} subscription(s) could not be converted; check account currencies and rates.` : ''}</p>
    ${data.rows.length === 0 ? `<p class="placeholder">No subscriptions match the current filters.</p>` : `
    <div class="sub-cards">${data.rows.map(s => _renderSubCard(s, sym)).join('')}</div>
    <div class="table-wrap acc-table-wrap${state.subDeleteRow !== null ? ' acc-has-active' : ''}">
      <table class="acc-table">
        <thead><tr>
          ${_selectMode ? '<th class="sub-check-cell"></th>' : ''}
          ${thSort('subscription_name', 'Name')}
          <th>Account</th>
          ${thSort('next_payment_date', 'Next payment')}
          ${thSort('amount_monthly_quote', 'Amount')}
          <th style="width:40px"></th>
        </tr></thead>
        <tbody>${data.rows.map(s => _renderSubRow(s, sym)).join('')}</tbody>
      </table>
    </div>`}
    ${data.pages > 1 || data.page_size !== 'all' || data.total > 10 ? _renderPager(data) : ''}
    ${_selectMode ? _renderSelectBar(data, est, stale, moneyText) : ''}`;
}

// Pinned to the bottom while choosing, so the figure stays in view on a phone.
function _renderSelectBar(data, est, stale, moneyText) {
  const matching = Array.isArray(data.selectable_ids) ? data.selectable_ids : [];
  return `<div class="sub-select-bar" role="region" aria-label="Estimate for the chosen subscriptions">
    <div class="sub-select-total${stale ? ' is-stale' : ''}" aria-live="polite">
      <strong>${esc(moneyText(est.out_quote))}</strong>/mo · ${esc(_selection === null ? 'all active' : `${_selection.size} selected`)}
    </div>
    <div class="sub-select-actions">
      <button class="btn btn-secondary btn-sm" id="subSelAll">All active</button>
      ${data.active_filter_count > 0 ? `<button class="btn btn-secondary btn-sm" id="subSelMatching">Matching (${esc(matching.length)})</button>` : ''}
      <button class="btn btn-secondary btn-sm" id="subSelNone">None</button>
      <button class="btn btn-primary btn-sm" id="subSelDone">Done</button>
    </div>
  </div>`;
}

function _refreshTablePart() {
  const table = el('subTableResults');
  if (table !== null) table.innerHTML = _renderTable();
  el('subscriptionsContent')?.classList?.toggle('is-selecting', _selectMode);
}

let _subMenuKey = null;
let _subImportFile = null;
let _subImportResult = null;
let _subImportBusy = false;

// ── CSV import ────────────────────────────────────────────────────────────────
// The server parses and validates the file; the browser only uploads the raw
// text and renders the outcome.

function _renderImportPanel() {
  return `
  <div class="card">
    <div class="cat-form-header">Import subscriptions from CSV</div>
    <div class="form-grid">
      <div class="field form-grid-span-2">
        <label for="subImportFile">CSV file</label>
        <input type="file" id="subImportFile" accept=".csv"${_subImportBusy ? ' disabled' : ''}>
        <div class="field-hint">Required: subscription_name, subscription_amount_local, frequency, source_account, and the applicable day_of_week or day_of_month. Optional: id, counterparty_name, tx_type, major_category, minor_category, description, record_status, subscription_start_date_local, subscription_end_date_local, subscription_timezone_local. Start date is required for quarterly and annual schedules. Dates require a timezone. Sync and audit columns are accepted; the server manages their values. The server checks the whole file first and imports nothing if any row is invalid.</div>
      </div>
    </div>
    <div id="subImportStatus">${_subImportResult ?? ''}</div>
    <div class="form-actions">
      <button class="btn btn-primary" id="subImportConfirm"${_subImportBusy || _subImportFile === null ? ' disabled' : ''}>${_subImportBusy ? 'Importing…' : 'Import'}</button>
      <button class="btn btn-secondary" id="subImportCancel"${_subImportBusy ? ' disabled' : ''}>Close</button>
    </div>
    <div class="pin-error" id="subImportError" role="alert"></div>
  </div>`;
}

function _refreshImportPanel() {
  const status = el('subImportStatus');
  if (status !== null) status.innerHTML = _subImportResult ?? '';
  const button = el('subImportConfirm');
  if (button !== null) {
    button.disabled = _subImportBusy || _subImportFile === null;
    button.textContent = _subImportBusy ? 'Importing…' : 'Import';
  }
  for (const id of ['subImportFile', 'subImportCancel', 'subImportBtn', 'subAddBtn']) {
    const node = el(id);
    if (node !== null) node.disabled = _subImportBusy;
  }
}

function _chooseSubscriptionImport(file) {
  if (_subImportBusy) return;
  _subImportFile = file ?? null;
  _subImportResult = _subImportFile === null ? null : `<p class="field-hint">${esc(_subImportFile.name)} selected</p>`;
  _refreshImportPanel();
}

function _renderImportOutcome(res) {
  return renderImportResult(res);
}

async function _submitImport() {
  if (_subImportBusy || _subImportFile === null) return;
  const file = _subImportFile;
  _subImportBusy = true;
  _refreshImportPanel();
  const error = el('subImportError');
  if (error !== null) error.textContent = '';
  showLoading();
  let csv;
  try {
    csv = await file.text();
  } catch (_) {
    _subImportFile = null;
    _subImportResult = '<p class="pin-error" role="alert">Unable to read the CSV. Select the file again.</p>';
    _subImportBusy = false;
    _refreshImportPanel();
    hideLoading();
    return;
  }
  try {
    const res = await ExpenseAPI.createSubscriptionsBulk({ csv });
    _subImportFile = null;
    const topLevel = res?.ok === false && typeof res.error === 'string' && !Array.isArray(res.errors) && (!Array.isArray(res.results) || res.results.length === 0);
    if (topLevel) {
      const uncertain = res.error === 'request_failed';
      if (uncertain) document.dispatchEvent(new CustomEvent('et:reload'));
      _subImportResult = `<p class="pin-error" role="alert">Import failed: ${esc(res.error)}${uncertain ? '. Some rows may have been saved. Reload and check before importing again.' : ''}</p>`;
      showMsg('Import failed: ' + res.error, 'warn');
      return;
    }
    _subImportResult = _renderImportOutcome(res);
    const results = Array.isArray(res?.results) ? res.results : [];
    const saved = results.filter(result => result?.ok === true).length;
    const failed = results.length - saved;
    if (Array.isArray(res?.errors)) showMsg('Import rejected: ' + (res.error ?? 'invalid_csv'), 'warn');
    else showMsg(`${saved} imported · ${failed} failed`, failed > 0 ? 'warn' : 'success');
    if (saved > 0) document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (_) {
    _subImportFile = null;
    _subImportResult = '<p class="pin-error" role="alert">Connection error. Some rows may have been saved. Reload and check before importing again.</p>';
    console.warn('[subscriptions] _submitImport: error=connection_error');
    document.dispatchEvent(new CustomEvent('et:reload'));
  } finally {
    _subImportBusy = false;
    const input = el('subImportFile');
    if (input !== null) input.value = '';
    _refreshImportPanel();
    hideLoading();
  }
}


// ── Entry point ───────────────────────────────────────────────────────────────

// Navigation / reload entry: render what is on hand, then request the view.
export function renderSubscriptions() {
  _render();
  if (!_schemaReady() || el('subscriptionsContent') === null) return;
  _loadList();
  if (_formKey() !== null) _loadFormOptions();
}

// Local re-render from the last view payload (no request).
function _render() {
  _subMenuKey = null;
  const content      = el('subscriptionsContent');
  if (content === null) return;
  if (!_schemaReady()) {
    content.innerHTML = '<p class="pin-error" role="alert">Subscription configuration is unavailable. Reload after deploying the updated backend.</p>';
    return;
  }
  const anyFormOpen  = state.subAddOpen || state.subEditRow !== null;
  const addBtnText   = anyFormOpen ? '× Close' : '+ Add';
  const impBtnText   = state.subImportOpen ? '× Close' : '↑ Import';

  content.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="subImportBtn">${impBtnText}</button>
        <button class="btn btn-secondary btn-sm" id="subExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="subAddBtn">${addBtnText}</button>
      </div>
    </div>
    ${state.subImportOpen ? _renderImportPanel() : ''}
    <div id="subFormWrap">${anyFormOpen ? _renderForm(state.subEditRow !== null ? _editRecord() : null) : ''}</div>
    <div id="subFilterWrap">${_renderSubFilterBar()}</div>
    <div id="subTableResults">${_renderTable()}</div>
  `;

  content.classList?.toggle('is-selecting', _selectMode);
  _attachEvents();
  _refreshImportPanel();
}

// After a list response: redraw the filter bar and table only, so an open form keeps its input.
function _refreshListParts() {
  const filters = el('subFilterWrap');
  if (filters !== null) filters.innerHTML = _renderSubFilterBar();
  const table = el('subTableResults');
  if (table !== null) table.innerHTML = _renderTable();
  _attachFilterEvents();
}

function _refreshFormPart() {
  const wrap = el('subFormWrap');
  if (wrap === null) return;
  const anyFormOpen = state.subAddOpen || state.subEditRow !== null;
  wrap.innerHTML = anyFormOpen ? _renderForm(state.subEditRow !== null ? _editRecord() : null) : '';
  _attachFormEvents();
}

function _openForm(editRow) {
  state.subEditRow = editRow;
  state.subAddOpen = editRow === null;
  state.subImportOpen = false;
  state.subDeleteRow = null;
  _render();
  _loadFormOptions();
}

// ── Event attachment ──────────────────────────────────────────────────────────

let _eventsAbort = null;
let _filterAbort = null;
let _formAbort = null;

const _MENU_LABELS = { edit: 'Edit', pause: 'Pause', resume: 'Resume', transactions: 'Transactions', delete: 'Delete', restore: 'Restore' };

function _attachFormEvents() {
  if (_formAbort) _formAbort.abort();
  _formAbort = new AbortController();
  const { signal } = _formAbort;

  // Frequency change → re-render just the day field wrapper
  el('subFrequency')?.addEventListener('change', () => {
    const freq = el('subFrequency').value;
    const wrap = el('subDayWrap');
    if (wrap) wrap.innerHTML = _dayFieldHtml(freq, '');
  }, { signal });

  // Transaction type cascade → major → minor (lookups in the options tree)
  el('subTxType')?.addEventListener('change', () => {
    const txType  = el('subTxType').value;
    const majorEl = el('subMajor');
    const minorEl = el('subMinor');
    if (majorEl) majorEl.innerHTML = _majorSelectHtml(txType, '');
    if (minorEl) minorEl.innerHTML = _minorSelectHtml(txType, '', '');
  }, { signal });

  el('subMajor')?.addEventListener('change', () => {
    const txType  = el('subTxType').value;
    const major   = el('subMajor').value;
    const minorEl = el('subMinor');
    if (minorEl) minorEl.innerHTML = _minorSelectHtml(txType, major, '');
  }, { signal });
}

function _draft() {
  if (_subDraft === null) _subDraft = { ...state.subFilters, recordStatuses: [...state.subFilters.recordStatuses] };
  return _subDraft;
}

function _applyFilters(filters) {
  state.subFilters = filters;
  _subDraft = null;
  _subPage = 1;
  _refreshListParts();
  _loadList();
}

function _attachFilterEvents() {
  if (_filterAbort) _filterAbort.abort();
  _filterAbort = new AbortController();
  const { signal } = _filterAbort;

  el('subFilterToggle')?.addEventListener('click', () => {
    state.subFilterOpen = !state.subFilterOpen;
    const body  = el('subFilterBody');
    const arrow = el('subFilterToggle')?.querySelector('.filter-arrow');
    if (body)  body.classList.toggle('hidden', !state.subFilterOpen);
    if (arrow) arrow.textContent = state.subFilterOpen ? '▲' : '▼';
  }, { signal });

  el('subFilterBody')?.querySelectorAll('[data-sub-filter-rstat]').forEach(cb => {
    cb.addEventListener('change', () => {
      _draft().recordStatuses = Array.from(el('subFilterBody').querySelectorAll('[data-sub-filter-rstat]:checked'))
        .map(c => c.dataset.subFilterRstat);
    }, { signal });
  });

  el('subFMajor')?.addEventListener('change', e => { _draft().majorCategory = e.target.value; }, { signal });
  el('subFFrequency')?.addEventListener('change', e => { _draft().frequency = e.target.value; }, { signal });
  el('subFSearch')?.addEventListener('input', e => { _draft().search = e.target.value; }, { signal });
  el('subFSearch')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _applyFilters({ ..._draft(), search: e.target.value.trim() });
  }, { signal });

  el('subFilterApply')?.addEventListener('click', () => {
    const draft = _draft();
    _applyFilters({ ...draft, recordStatuses: [...draft.recordStatuses], search: String(draft.search ?? '').trim() });
  }, { signal });

  el('subFilterClear')?.addEventListener('click', () => {
    _applyFilters({ recordStatuses: [..._recordStatuses()], majorCategory: 'all', frequency: 'all', search: '' });
  }, { signal });

  el('subPrevPage')?.addEventListener('click', () => { _subPage = Math.max(1, _subPage - 1); _loadList(); }, { signal });
  el('subNextPage')?.addEventListener('click', () => { _subPage += 1; _loadList(); }, { signal });
  el('subPerPage')?.addEventListener('change', e => {
    _subPageSize = e.target.value === 'all' ? 'all' : Number(e.target.value);
    _subPage = 1;
    _loadList();
  }, { signal });
}

async function _export(format) {
  showLoading();
  try {
    // Export the whole filtered set, not just the visible page.
    const res = await ExpenseAPI.view(LIST_VIEW, _listParams({ page: 1, page_size: 'all' }));
    if (res?.ok !== true) { showMsg(res?.message || 'Export failed: ' + (res?.error ?? 'unknown_error'), 'warn'); return; }
    if (res.data.rows.length === 0) { showMsg('No subscriptions to export.', 'warn'); return; }
    exportSubscriptions(format, res.data.rows);
  } catch (err) {
    console.error('[subscriptions] export failed:', err);
    showMsg('Connection error. The export could not be prepared.', 'warn');
  } finally {
    hideLoading();
  }
}

function _attachEvents() {
  if (_eventsAbort) _eventsAbort.abort();
  _eventsAbort = new AbortController();
  const { signal } = _eventsAbort;

  const content = el('subscriptionsContent');
  if (content === null) return;

  el('subImportBtn')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    if (state.subImportOpen) {
      state.subImportOpen = false;
      _subImportFile = null;
      _subImportResult = null;
    } else {
      state.subImportOpen = true;
      _subImportFile = null;
      _subImportResult = null;
      state.subDeleteRow = null;
      state.subAddOpen    = false;
      state.subEditRow    = null;
      state.subPrefill    = null;
    }
    _render();
  }, { signal });

  el('subImportFile')?.addEventListener('change', event => {
    _chooseSubscriptionImport(event.target.files[0]);
  }, { signal });

  el('subImportConfirm')?.addEventListener('click', () => { _submitImport(); }, { signal });

  el('subImportCancel')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    state.subImportOpen = false;
    _subImportFile = null;
    _subImportResult = null;
    _render();
  }, { signal });

  el('subAddBtn')?.addEventListener('click', () => {
    if (_subImportBusy) return;
    if (state.subAddOpen || state.subEditRow !== null) {
      state.subAddOpen  = false;
      state.subEditRow  = null;
      state.subPrefill  = null;
      _render();
    } else {
      _subImportFile      = null;
      _subImportResult    = null;
      _openForm(null);
    }
  }, { signal });

  content.addEventListener('click', e => {
    if (_subImportBusy) return;
    const selectBtn = e.target.closest('#subSelectBtn, #subSelDone, #subSelAll, #subSelNone, #subSelMatching, #subSelReset');
    if (selectBtn !== null) {
      if (selectBtn.id === 'subSelectBtn') _selectMode = !_selectMode;
      if (selectBtn.id === 'subSelDone') _selectMode = false;
      if (selectBtn.id === 'subSelAll' || selectBtn.id === 'subSelReset') { _setSelection(null); return; }
      if (selectBtn.id === 'subSelNone') { _setSelection(new Set()); return; }
      if (selectBtn.id === 'subSelMatching') { _setSelection(new Set(_listPayload()?.data.selectable_ids ?? [])); return; }
      _refreshTablePart();
      return;
    }
    const pick = _selectMode ? e.target.closest('[data-sub-select]') : null;
    if (pick !== null) { _toggleSelected(pick.dataset.subSelect); return; }
    const sort = e.target.closest('th[data-sub-sort]');
    if (sort !== null) {
      const col = sort.dataset.subSort;
      state.subSort.dir = state.subSort.col === col && state.subSort.dir === 'asc' ? 'desc' : 'asc';
      state.subSort.col = col;
      _subPage = 1;
      _loadList();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row !== undefined && btn.dataset.row !== '' ? btn.dataset.row : null;

    if (action === 'sub-cancel') {
      state.subAddOpen = false;
      state.subEditRow = null;
      state.subPrefill = null;
      _render();
    }
    if (action === 'sub-save') {
      if (state.subEditRow !== null) _saveEdit();
      else _saveAdd();
    }
    if (action === 'sub-menu') {
      _subMenuKey = row;
      const sub = _rowById(row);
      if (sub === null) return;
      const menuItems = sub.allowed_actions.filter(key => _MENU_LABELS[key] !== undefined)
        .map(key => ({ key, label: _MENU_LABELS[key], ...(key === 'delete' ? { cls: 'danger' } : {}) }));
      openContextMenu(btn, menuItems, async key => {
        _subMenuKey = null;
        if (key === 'edit')   { state.subPrefill = null; _openForm(row); }
        if (key === 'pause' || key === 'resume') { _toggle(row); }
        if (key === 'delete') { state.subDeleteRow = row; state.subAddOpen = false; state.subEditRow = null; _render(); }
        if (key === 'restore') {
          showLoading();
          try {
            const res = await ExpenseAPI.restoreSubscription({ row_num: sub.row_num, ..._identity(sub) });
            if (!res.ok) {
              console.warn('[subscriptions] restore failed:', res?.error);
              showMsg(res.message || ('Restore failed: ' + (res.error !== undefined && res.error !== null ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : '[no error code]')), 'warn');
              return;
            }
            document.dispatchEvent(new CustomEvent('et:reload'));
          } catch (err) {
            console.error('[subscriptions] restore failed:', err);
            showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
          } finally {
            hideLoading();
          }
          return;
        }
        if (key === 'transactions') {
          state.filters = {
            types: [], accounts: [], major: [], minor: [],
            user_location_country: '', user_location_city: '', user_location_area: '',
            tag: '', search: sub.transactions_search,
          };
          document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
        }
      });
    }
    if (action === 'sub-cancel-delete')  { state.subDeleteRow = null; _render(); }
    if (action === 'sub-confirm-delete') { _confirmDelete(row); }
  }, { signal });

  content.addEventListener('keydown', e => {
    if (!_selectMode || (e.key !== ' ' && e.key !== 'Enter')) return;
    const pick = e.target.closest('[data-sub-select]');
    if (pick === null) return;
    e.preventDefault();
    _toggleSelected(pick.dataset.subSelect);
  }, { signal });

  el('subExportBtn')?.addEventListener('click', () => {
    openContextMenu(el('subExportBtn'), [
      { key: 'csv',  label: 'CSV'  },
      { key: 'json', label: 'JSON' },
    ], key => _export(key));
  }, { signal });

  _attachFilterEvents();
  _attachFormEvents();
}

// ── Form collection helper ────────────────────────────────────────────────────

function _collectForm() {
  const freq       = el('subFrequency').value;
  const current = _editRecord();
  const sameFrequency = current !== null && current.frequency === freq;
  const dayOfWeek  = freq === 'weekly' ? el('subDayOfWeek').value : sameFrequency ? current.day_of_week ?? '' : '';
  const dayOfMonth = freq !== 'weekly' ? el('subDayOfMonth').value : sameFrequency ? current.day_of_month ?? '' : '';

  return {
    subscription_name:             el('subName').value.trim(),
    counterparty_name:             el('subCounterparty').value.trim(),
    subscription_amount_local:     el('subAmount').value.trim(),
    frequency:                     freq,
    day_of_week:                   dayOfWeek,
    day_of_month:                  dayOfMonth,
    source_account:                el('subSourceAccount').value,
    tx_type:                       el('subTxType').value,
    major_category:                el('subMajor').value,
    minor_category:                el('subMinor').value,
    description:                   el('subDescription').value.trim(),
    subscription_timezone_local:  el('subTimezone').value.trim(),
    subscription_start_date_local: _collectLocalTimestamp('subStartDate', 'subscription_start_date_local'),
    subscription_end_date_local:   _collectLocalTimestamp('subEndDate', 'subscription_end_date_local'),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function _saveAdd() {
  const errEl = el('subFormError');
  clearFormError(errEl);

  const body = _collectForm();

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.createSubscription(body);
    if (res.ok) {
      showMsg('Subscription added.');
      state.subAddOpen = false;
      state.subPrefill = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _saveAdd failed:', res?.error);
      showFormError(errEl, res, _SUB_FIELD_IDS);
    }
  } catch (err) {
    console.error('[subscriptions] _saveAdd failed:', err);
    if (errEl) errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    hideLoading();
  }
}

async function _saveEdit() {
  const errEl = el('subFormError');
  clearFormError(errEl);
  const record = _editRecord();
  if (record === null) return;

  const body = _collectForm();

  showLoading();
  const saveBtn = el('subSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await ExpenseAPI.updateSubscription({ ...body, row_num: record.row_num, ..._identity(record) });
    if (res.ok) {
      showMsg('Subscription updated.');
      state.subEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _saveEdit failed:', res?.error);
      showFormError(errEl, res, _SUB_FIELD_IDS);
    }
  } catch (err) {
    console.error('[subscriptions] _saveEdit failed:', err);
    if (errEl) errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    hideLoading();
  }
}

// Pause / Resume per the row's server allowed_actions.
async function _toggle(subscriptionId) {
  const sub = _rowById(subscriptionId);
  if (sub === null) return;
  const newStatus = sub.allowed_actions.includes('pause') ? 'inactive' : 'active';
  showLoading();
  try {
    const res = await ExpenseAPI.updateSubscription({
      row_num:                       sub.row_num,
      record_status:                 newStatus,
      ..._identity(sub),
    });
    if (res.ok) {
      showMsg(newStatus === 'active' ? 'Subscription resumed.' : 'Subscription paused.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _toggle failed:', res?.error);
      showMsg(res.message || ('Update failed: ' + (res.error !== undefined && res.error !== null ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : '[no error code]')), 'warn');
    }
  } catch (err) {
    console.error('[subscriptions] _toggle failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
  } finally {
    hideLoading();
  }
}

async function _confirmDelete(subscriptionId) {
  const sub = _rowById(subscriptionId);
  if (sub === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.deleteSubscription({ row_num: sub.row_num, ..._identity(sub) });
    if (res.ok) {
      showMsg('Subscription deleted.');
      state.subDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[subscriptions] _confirmDelete failed:', res?.error);
      showMsg(res.message || ('Delete failed: ' + (res.error !== undefined && res.error !== null ? (res.error === 'stale_record' ? 'This record moved or changed. Refresh, then reopen it before trying again.' : res.error) : '[no error code]')), 'warn');
      state.subDeleteRow = null;
      _render();
    }
  } catch (err) {
    console.error('[subscriptions] _confirmDelete failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    state.subDeleteRow = null;
    _render();
  } finally {
    hideLoading();
  }
}
