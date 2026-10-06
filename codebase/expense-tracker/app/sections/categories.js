import { state } from '../core/state.js';
import { el, esc, openContextMenu, closeContextMenu, exportCategories, recordStatusIcon, syncStatusIcon, renderImportResult, clearFormError, showFormError } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';

// The section renders server view models only:
// - list_categories_view: filtered / sorted / paged rows (type badge, account-type
//   hint labels, allowed_actions) plus facets for the filter bar.
// - get_category_form_options: tx types, account-type hint groups for the
//   source / target checkboxes and status choices.
const LIST_VIEW = 'list_categories_view';
const FORM_VIEW = 'get_category_form_options';
const PAGE_SIZES = ['all', 25, 50, 100];

// Returns the error code string, or '[no error code]' if absent.
function _errMsg(code) {
  if (code === 'stale_record') return 'This record moved or changed. Refresh, then reopen it before trying again.';
  return (code !== undefined && code !== null) ? String(code) : '[no error code]';
}

// validateCategoryCreate/Update (server) own the form rules: forms show the
// server `message` and highlight the input named by `field`.
const _CAT_FIELD_IDS = {
  add:  { tx_type_key: 'catNewType', major_category_label: 'catNewMajor', minor_category_label: 'catNewMinor' },
  edit: { tx_type_key: 'catEditType', major_category_label: 'catEditMajor', minor_category_label: 'catEditMinor', record_status: 'catEditRecordStatus' },
};

let _catImportFile   = null;   // File chosen in the import panel; the server parses it
let _catMenuKey      = null;
let _catDraft        = null;   // pending filter selections; copied to state.catFilters on Search
let _catDDCleanup    = null;   // cleanup fn for the currently open filter dropdown's outside-click listener

let _listSeq = 0;
let _listLoading = false;
let _listError = null;
let _catPage = 1;
let _catPageSize = 'all';
let _catSort = { col: 'row_num', dir: 'asc' };
let _formOptions = null;        // get_category_form_options data
let _formOptionsError = null;
let _formSeq = 0;
let _recordSnapshot = null;     // the viewed / edited row when the form opened

function _listPayload() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true && response.data !== null && typeof response.data === 'object' ? response : null;
}

function _viewRows() { return _listPayload()?.data.rows ?? []; }

// Open panels / confirmations hold the category id (a Sheet row number can
// move after an import or a manual sort). The viewed / edited row comes from
// the latest view, else the snapshot taken when it opened; mutations send that
// row's row_num + id + updated_at (the server's stale_record check stays).
function _recordById(id) {
  if (typeof id !== 'string' || id === '') return undefined;
  const found = _viewRows().find(cat => cat.id === id);
  if (found !== undefined) {
    if (id === state.catEditRow || id === state.catViewRow) _recordSnapshot = found;
    return found;
  }
  return _recordSnapshot !== null && _recordSnapshot.id === id ? _recordSnapshot : undefined;
}

// Row identity for mutations: the server rejects a stale or moved row (stale_record).
function _identity(cat) {
  return cat === undefined || cat === null ? {} : { id: cat.id, updated_at: cat.updated_at };
}

function _allStatuses() { return state.categorySchema.record_statuses; }

// ── Requests ──────────────────────────────────────────────────────────────────

// Filters / sort / page → list_categories_view params. All statuses selected is
// the default (no param); an empty selection is sent as 'none'.
function _listParams(overrides = {}) {
  const f = state.catFilters;
  const all = _allStatuses().every(status => f.recordStatuses.includes(status));
  const tri = value => (value === 'all' ? undefined : value);
  return {
    type: tri(f.type), major: tri(f.major), minor: tri(f.minor), search: f.search,
    source_mandatory: tri(f.sourceMandatory), target_mandatory: tri(f.targetMandatory), subscription_eligible: tri(f.subscriptionEligible),
    statuses: all ? undefined : (f.recordStatuses.length === 0 ? 'none' : f.recordStatuses),
    sort_col: _catSort.col, sort_dir: _catSort.dir, page: _catPage, page_size: _catPageSize,
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
      _catPage = res.data.page ?? 1;
    } else {
      console.warn('[categories] list view failed:', res?.error);
      _listError = res?.message || (res?.error ? `Categories could not be loaded: ${res.error}` : 'Categories could not be loaded.');
    }
  } catch (err) {
    if (seq !== _listSeq) return;
    console.error('[categories] list view failed:', err);
    _listError = 'Connection error. Categories could not be refreshed.';
  } finally {
    hideLoading();
    if (seq === _listSeq) {
      _listLoading = false;
      _refreshListParts();
    }
  }
}

async function _loadFormOptions() {
  const seq = ++_formSeq;
  _formOptionsError = null;
  const shown = _formOptions;
  try {
    const res = await ExpenseAPI.view(FORM_VIEW, {});
    if (seq !== _formSeq) return;
    if (res?.ok === true) {
      _formOptions = res.data;
      // Cached options already rendered the form: keep what the user typed unless they changed.
      if (shown !== null && JSON.stringify(shown) === JSON.stringify(res.data)) return;
    } else {
      console.warn('[categories] form options failed:', res?.error);
      _formOptionsError = res?.message || 'The form could not be loaded. Close it and try again.';
    }
  } catch (err) {
    if (seq !== _formSeq) return;
    console.error('[categories] form options failed:', err);
    _formOptionsError = 'Connection error. The form could not be loaded.';
  }
  _refreshFormPart();
}

function _anyFormOpen() {
  return state.catAddOpen || state.catViewRow !== null || state.catEditRow !== null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Navigation / reload entry: render what is on hand, then request the view.
export function renderCategories() {
  _render();
  if (!_schemaReady() || el('categoriesContent') === null) return;
  _loadList();
  if (_anyFormOpen()) _loadFormOptions();
}

function _schemaReady() {
  return state.categorySchema !== null && state.categorySchema !== undefined && Array.isArray(state.categorySchema.record_statuses);
}

function _renderForms() {
  const viewCat = state.catViewRow !== null ? _recordById(state.catViewRow) : undefined;
  const editCat = state.catEditRow !== null ? _recordById(state.catEditRow) : undefined;
  return `${state.catAddOpen ? _renderForm({}, 'add') : ''}
    ${viewCat !== undefined ? _renderForm(viewCat, 'view') : ''}
    ${editCat !== undefined ? _renderForm(editCat, 'edit') : ''}`;
}

// Local re-render from the last view payload (no request).
function _render() {
  closeContextMenu(); _catMenuKey = null;
  const content = el('categoriesContent');
  if (content === null) return;
  if (!_schemaReady()) {
    content.innerHTML = '<p class="placeholder">Category schema unavailable — please reload.</p>';
    return;
  }

  content.innerHTML = `
    <div class="sec-head">
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-secondary btn-sm" id="catImportBtn">${state.catImportOpen ? '× Close' : '↑ Import'}</button>
        <button class="btn btn-secondary btn-sm" id="catExportBtn">↓ Export</button>
        <button class="btn btn-primary btn-sm" id="catAddBtn">${_anyFormOpen() ? '× Close' : '+ Add'}</button>
      </div>
    </div>
    ${state.catImportOpen ? _renderCatImportPanel() : ''}
    <div id="catFormWrap">${_renderForms()}</div>
    <div id="catFilterWrap">${_renderCatFilterBar()}</div>
    <div id="catListWrap">${_renderList()}</div>
  `;

  _attachCatEvents();
}

function _refreshListParts() {
  const filters = el('catFilterWrap');
  if (filters !== null) filters.innerHTML = _renderCatFilterBar();
  const list = el('catListWrap');
  if (list !== null) list.innerHTML = _renderList();
  _attachFilterEvents();
  _attachListEvents();
}

function _refreshFormPart() {
  const wrap = el('catFormWrap');
  if (wrap === null) return;
  wrap.innerHTML = _renderForms();
  _attachFormEvents();
}

function _openForm(changes) {
  state.catAddOpen = false; state.catViewRow = null; state.catEditRow = null; state.catDeleteRow = null;
  Object.assign(state, changes);
  _render();
  _loadFormOptions();   // always refresh (hint groups follow Configure); server-cached by data_version
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function _facets() {
  return _listPayload()?.data.facets ?? { majors: [], minors_by_major: {}, types: state.categorySchema.types ?? [] };
}

function _labelOf(list, key, fallback) {
  const hit = list.find(item => item.key === key);
  return hit === undefined ? (key === 'all' ? fallback : key) : hit.label;
}

function _statusLabel(statuses) {
  return statuses.length === _allStatuses().length ? 'All' : statuses.length === 0 ? 'None'
    : statuses.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
}

function _minorItems(majorKey, selected) {
  const OPT_STYLE = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';
  const minors = _facets().minors_by_major[majorKey] ?? [];
  return [['all', 'All minor'], ...minors.map(n => [n.key, n.label])].map(([v, l]) =>
    `<label style="${OPT_STYLE}"><input type="radio" name="catFMinorR" value="${esc(v)}"${v === selected ? ' checked' : ''}> ${esc(l)}</label>`
  ).join('');
}

function _renderCatFilterBar() {
  const activeCount = _listPayload()?.data.active_filter_count ?? 0;
  const f = _catDraft !== null ? _catDraft : state.catFilters; // panel UI uses draft when available
  const facets = _facets();
  const rs = new Set(f.recordStatuses);

  const typeLabel   = f.type === 'all' ? 'All types' : (facets.types.find(t => t.value === f.type)?.label ?? f.type);
  const majorLabel  = f.major === 'all' ? 'All major' : esc(_labelOf(facets.majors, f.major, 'All major'));
  const minorLabel  = f.major === 'all' ? '— select major first —' : (f.minor === 'all' ? 'All minor' : esc(_labelOf(facets.minors_by_major[f.major] ?? [], f.minor, 'All minor')));
  const choiceLabel = (list, value) => (list ?? []).find(item => item.value === value)?.label ?? (value === 'all' ? 'All' : value);
  const srcLabel    = esc(choiceLabel(facets.mandatory, f.sourceMandatory));
  const tgtLabel    = esc(choiceLabel(facets.mandatory, f.targetMandatory));
  const subLabel    = esc(choiceLabel(facets.subscription_eligible, f.subscriptionEligible));

  const trigStyle = 'width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:6px 10px;font-size:var(--text-base);color:var(--ink);cursor:pointer;outline:none';
  const optStyle  = 'display:flex;align-items:center;gap:8px;font-size:var(--text-base);color:var(--ink);cursor:pointer';

  const choices = list => list.map(item => [item.value, item.label]);
  const mandatory = choices(facets.mandatory ?? [{ value: 'all', label: 'All' }]);
  const eligibility = choices(facets.subscription_eligible ?? [{ value: 'all', label: 'All' }]);
  const radioRows = (name, opts, cur) => opts.map(([val, lbl]) =>
    `<label style="${optStyle}"><input type="radio" name="${name}" value="${esc(val)}"${cur === val ? ' checked' : ''}> ${esc(lbl)}</label>`
  ).join('');

  const dd = (triggerId, labelId, menuId, curLabel, items, disabled) => `
    <div style="flex:1;position:relative">
      <button type="button" id="${triggerId}"${disabled ? ' disabled' : ''} style="${trigStyle}${disabled ? ';opacity:0.5;cursor:not-allowed' : ''}">
        <span id="${labelId}">${curLabel}</span>
        <span style="color:var(--muted);font-size:var(--text-2xs);margin-left:8px">▼</span>
      </button>
      <div id="${menuId}" style="display:none">${items}</div>
    </div>`;

  return `
  <div class="filter-bar">
    <button class="filter-toggle" id="catFilterToggle">
      Filters${activeCount > 0 ? ` (${activeCount})` : ''} <span class="filter-arrow">${state.catFilterOpen ? '▲' : '▼'}</span>
    </button>
    <div class="filter-body ${state.catFilterOpen ? '' : 'hidden'}" id="catFilterBody">
      <div class="filter-row">
        <label>Type</label>
        ${dd('catFTypeTrigger','catFTypeLabel','catFTypeMenu', esc(typeLabel),
          radioRows('catFTypeR', [['all','All types'], ...facets.types.map(t => [t.value, t.label])], f.type))}
      </div>
      <div class="filter-row">
        <label>Major</label>
        ${dd('catFMajorTrigger','catFMajorLabel','catFMajorMenu', majorLabel,
          radioRows('catFMajorR', [['all','All major'], ...facets.majors.map(m => [m.key, m.label])], f.major))}
      </div>
      <div class="filter-row">
        <label>Minor</label>
        ${dd('catFMinorTrigger','catFMinorLabel','catFMinorMenu', minorLabel,
          f.major === 'all' ? '' : _minorItems(f.major, f.minor),
          f.major === 'all')}
      </div>
      <div class="filter-row">
        <label>Search</label>
        <input type="text" id="catFSearch" placeholder="name, keywords…" value="${esc(f.search)}" style="flex:1">
      </div>
      <div class="filter-row">
        <label>Source acct</label>
        ${dd('catFSrcTrigger','catFSrcLabel','catFSrcMenu', srcLabel,
          radioRows('catFSrcR', mandatory, f.sourceMandatory))}
      </div>
      <div class="filter-row">
        <label>Target acct</label>
        ${dd('catFTgtTrigger','catFTgtLabel','catFTgtMenu', tgtLabel,
          radioRows('catFTgtR', mandatory, f.targetMandatory))}
      </div>
      <div class="filter-row">
        <label>Subscription</label>
        ${dd('catFSubTrigger','catFSubLabel','catFSubMenu', subLabel,
          radioRows('catFSubR', eligibility, f.subscriptionEligible))}
      </div>
      <div class="filter-row">
        <label>Status</label>
        ${dd('catFStatusTrigger','catFStatusLabel','catFStatusMenu', esc(_statusLabel(f.recordStatuses)),
          _allStatuses().map(s =>
            `<label style="${optStyle}"><input type="checkbox" data-cat-filter-rstat="${esc(s)}"${rs.has(s) ? ' checked' : ''}> ${esc(s.charAt(0).toUpperCase() + s.slice(1))}</label>`
          ).join(''))}
      </div>
      <div style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" id="catFClear">Clear</button>
        <button class="btn btn-primary btn-sm" id="catFSearchBtn">Search</button>
      </div>
    </div>
  </div>`;
}

// ── Unified form (Add / View / Edit) ─────────────────────────────────────────

function _renderForm(cat, mode) {
  const o = _formOptions;
  if (o === null) {
    return `<div class="card" style="margin-bottom:20px">${_formOptionsError === null
      ? '<p class="placeholder">Loading form…</p>'
      : `<p class="pin-error" role="alert">${esc(_formOptionsError)}</p>`}</div>`;
  }
  const isView = mode === 'view';
  const isEdit = mode === 'edit';
  const dis    = isView ? ' disabled' : '';
  const pfx    = isEdit ? 'catEdit' : 'catNew';
  const srcId  = isView ? '' : `${pfx}Src`;
  const tgtId  = isView ? '' : `${pfx}Tgt`;

  const typeOpts = o.types.map(t =>
    `<option value="${esc(t.value)}" ${cat.tx_type_key === t.value ? 'selected' : ''}>${esc(t.label)}</option>`
  ).join('');

  const header = (isView || isEdit) ? `
    <div class="cat-form-header">
      ${isView ? 'Viewing' : 'Editing'} —
      <strong>${esc(cat.major_category_label)}</strong> / ${esc(cat.minor_category_label)}
    </div>` : '';

  // Status choices come from the server: add allows only active (the backend writes it).
  const statusOptions = (isEdit || isView ? o.statuses_for_edit : o.statuses_for_add).map(s => {
    const isSelected = isEdit || isView ? (cat.record_status === s.value ? 'selected' : '') : (s.value === 'active' ? 'selected' : '');
    return `<option value="${esc(s.value)}" ${isSelected}>${esc(s.label)}</option>`;
  }).join('');
  const actions = Array.isArray(cat.allowed_actions) ? cat.allowed_actions : [];

  return `
  <div class="card" style="margin-bottom:20px">
    ${header}
    <div class="form-grid form-grid-4" style="margin-bottom:12px">
      <div class="field">
        <label>Type *</label>
        <select id="${pfx}Type"${dis}>${typeOpts}</select>
        <div class="field-hint">money-in or money-out.</div>
      </div>
      <div class="field">
        <label>Major *</label>
        <input type="text" id="${pfx}Major" placeholder="e.g. Food" ${cat.major_category_label !== undefined && cat.major_category_label !== null && cat.major_category_label !== '' ? `value="${esc(String(cat.major_category_label))}"` : ''}${dis}>
        <div class="field-hint">Top-level category group.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Minor *</label>
        <input type="text" id="${pfx}Minor" placeholder="e.g. Groceries" ${cat.minor_category_label !== undefined && cat.minor_category_label !== null && cat.minor_category_label !== '' ? `value="${esc(String(cat.minor_category_label))}"` : ''}${dis}>
        <div class="field-hint">Specific category name shown in dropdowns.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Description</label>
        <input type="text" id="${pfx}Desc" placeholder="Short description" ${cat.description !== undefined && cat.description !== null && cat.description !== '' ? `value="${esc(String(cat.description))}"` : ''}${dis}>
        <div class="field-hint">Shown in tooltips and reports.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Tag keywords</label>
        <input type="text" id="${pfx}Keywords" placeholder="tesco, sainsbury…" ${cat.tag_keywords !== undefined && cat.tag_keywords !== null && cat.tag_keywords !== '' ? `value="${esc(String(cat.tag_keywords))}"` : ''}${dis}>
        <div class="field-hint">Comma-and-space-separated, for auto-classification.</div>
      </div>
      <div class="field form-grid-span-2">
        <label>Counterparty examples</label>
        <input type="text" id="${pfx}Counterparty" placeholder="Tesco, Sainsbury's…" ${cat.counterparty_examples !== undefined && cat.counterparty_examples !== null && cat.counterparty_examples !== '' ? `value="${esc(String(cat.counterparty_examples))}"` : ''}${dis}>
        <div class="field-hint">Comma-separated merchant names.</div>
      </div>
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Source account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}SrcMandatory" ${cat.source_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(srcId, cat.source_account_types, isView)}
    </div>
    <div class="cat-acct-section">
      <div class="cat-acct-header">
        <div class="cat-acct-label">Target account types</div>
        <label class="checkbox-label cat-mandatory-check">
          <input type="checkbox" id="${pfx}TgtMandatory" ${cat.target_account_mandatory === true ? 'checked' : ''}${dis}> Mandatory
        </label>
      </div>
      ${_renderAcctTypeCheckboxes(tgtId, cat.target_account_types, isView)}
    </div>
    <div class="field" style="margin-top:14px">
      <label>Record status</label>
      <select id="${pfx}RecordStatus"${dis}>${statusOptions}</select>
    </div>
    <label class="checkbox-label cat-mandatory-check" style="margin-top:8px">
      <input type="checkbox" id="${pfx}IsSubEligible" ${cat.is_subscription_eligible === true ? 'checked' : ''}${dis}> Subscription eligible
    </label>
    ${isView ? `
    <div style="margin-top:14px;font-size:12px;color:var(--muted)">
      Sync: ${syncStatusIcon((cat.sync_status !== undefined && cat.sync_status !== null) ? cat.sync_status : '')} ${esc((cat.sync_status !== undefined && cat.sync_status !== null) ? cat.sync_status : '—')}${(cat.sync_notes !== undefined && cat.sync_notes !== null && cat.sync_notes !== '') ? ' · ' + esc(cat.sync_notes) : ''}
    </div>` : ''}
    ${isView ? `
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-secondary" id="catCancelView">Close</button>
      ${actions.includes('restore') ? `<button class="btn btn-primary" id="catViewRestore" data-row="${esc(cat.id)}">Restore</button>` : ''}
      ${actions.includes('edit') ? `<button class="btn btn-primary" id="catViewToEdit" data-row="${esc(cat.id)}">Edit</button>` : ''}
    </div>
    ` : `
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="${isEdit ? 'catSaveEdit' : 'catSaveNew'}">Save</button>
      <button class="btn btn-secondary" id="${isEdit ? 'catCancelEdit' : 'catCancelNew'}">Cancel</button>
    </div>
    <div class="pin-error" id="${isEdit ? 'catEditError' : 'catAddError'}"></div>
    `}
  </div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

function _renderCategoryDelete(cat) {
  return `<span class="confirm-text">Delete <strong>${esc(cat.major_category_label)} → ${esc(cat.minor_category_label)}</strong>?</span>
    <div class="row-actions">
      <button class="btn-link danger" data-action="cat-confirm-delete" data-row="${esc(cat.id)}">Yes, delete</button>
      <button class="btn-link muted" data-action="cat-cancel-delete">Cancel</button>
    </div>`;
}

function _renderPager(data) {
  const size = data.page_size === 'all' ? 'all' : Number(data.page_size);
  const sizes = PAGE_SIZES.map(n => `<option value="${esc(n)}"${String(size) === String(n) ? ' selected' : ''}>${n === 'all' ? 'All' : `${n} / page`}</option>`).join('');
  return `
    <div class="pagination">
      <button class="btn btn-secondary btn-sm" id="catPrevPage" ${data.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${esc(data.page)} of ${esc(data.pages)} (${esc(data.total)} rows)</span>
      <select id="catPerPage" class="per-page-select">${sizes}</select>
      <button class="btn btn-secondary btn-sm" id="catNextPage" ${data.page >= data.pages ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function _renderList() {
  const response = _listPayload();
  if (response === null) {
    return _listError !== null ? `<p class="pin-error" role="alert">${esc(_listError)}</p>` : '<p class="placeholder">Loading categories…</p>';
  }
  const { data } = response;
  const notice = _listError !== null
    ? `<p class="pin-error" role="alert">${esc(_listError)} Showing the last loaded list.</p>`
    : '';
  return `${notice}
    <div class="cat-count-bar">
      <span class="cat-count">${esc(data.count)} ${data.count === 1 ? 'category' : 'categories'}</span>
    </div>
    ${_renderCatTable(data.rows)}
    ${data.pages > 1 || data.page_size !== 'all' || data.total > 25 ? _renderPager(data) : ''}`;
}

function _renderCatTable(cats) {
  if (cats.length === 0) {
    return `<p class="placeholder">No categories for this filter. Use &ldquo;+ Add&rdquo; to create one.</p>`;
  }

  const thSort = (col, label, style = '') => {
    const active = _catSort.col === col;
    return `<th class="${active ? `sort-${_catSort.dir}` : ''}" data-cat-sort="${esc(col)}"${style === '' ? '' : ` style="${style}"`}>${esc(label)}</th>`;
  };

  const rows = cats.map(cat => {
    const rowStyle = cat.record_status === 'deleted'  ? ' style="opacity:0.5"'
                   : cat.record_status === 'inactive' ? ' style="opacity:0.5"'
                   : cat.record_status === 'locked'   ? ' style="opacity:0.7"' : '';

    if (state.catDeleteRow === cat.id) {
      return `<tr><td colspan="4">${_renderCategoryDelete(cat)}</td></tr>`;
    }

    return `<tr${rowStyle}>
      <td>${_catTypeBadge(cat.type_badge)}</td>
      <td class="td-name">${esc(cat.major_category_label)}</td>
      <td>${esc(cat.minor_category_label)}</td>
      <td><div style="display:flex;align-items:center;justify-content:flex-end;gap:5px">
        ${recordStatusIcon(cat.record_status)}${syncStatusIcon(cat.sync_status)}
        <button class="tx-menu-trigger" data-action="cat-menu" data-row="${esc(cat.id)}">⋮</button>
      </div></td>
    </tr>`;
  }).join('');

  const cardRows = cats.map(cat => {
    if (state.catDeleteRow === cat.id) return `<div class="card record-confirm-card">${_renderCategoryDelete(cat)}</div>`;
    const isArchived = cat.record_status !== 'active';
    return `<div class="cat-card${isArchived ? ' is-archived' : ''}">
      <div class="cat-card-top">
        <div class="cat-card-name">
          ${_catTypeDot(cat.type_badge)}
          <span class="cat-card-major">${esc(cat.major_category_label)}</span>
          <span class="cat-card-sep">›</span>
          <span class="cat-card-minor">${esc(cat.minor_category_label)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${recordStatusIcon(cat.record_status)} ${syncStatusIcon(cat.sync_status)}
          <button class="tx-menu-trigger" data-action="cat-menu" data-row="${esc(cat.id)}">⋮</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="table-wrap cat-table-wrap">
      <table>
        <thead><tr>
          ${thSort('tx_type_key', 'Type', 'width:80px')}
          ${thSort('major_category_label', 'Major')}
          ${thSort('minor_category_label', 'Minor')}
          <th style="width:64px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="cat-cards">${cardRows}</div>`;
}

// ── Account type multi-select ─────────────────────────────────────────────────

// Groups and labels come from get_category_form_options.account_type_hint_groups.
function _renderAcctTypeCheckboxes(containerId, currentValue, disabled = false) {
  const rawValue = (currentValue !== undefined && currentValue !== null) ? String(currentValue) : '';
  const selected = new Set(
    rawValue.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '')
  );
  const dis = disabled ? ' disabled' : '';

  const renderGroup = group =>
    `<div class="acct-type-group">
      <span class="acct-type-group-label">${esc(group.label)}</span>
      <div class="acct-type-checks">
        ${group.hints.map(hint =>
          `<label class="acct-type-check">
            <input type="checkbox" data-acct-type="${esc(hint.value)}" ${selected.has(hint.value) ? 'checked' : ''}${dis}> ${esc(hint.label)}
          </label>`
        ).join('')}
      </div>
    </div>`;

  const idAttr = containerId !== '' ? ` id="${esc(containerId)}"` : '';
  return `<div class="account-type-checkboxes"${idAttr}>
    ${(_formOptions?.account_type_hint_groups ?? []).map(renderGroup).join('')}
  </div>`;
}

function _getCheckedAccountTypes(containerId) {
  const container = el(containerId);
  if (container === null) return '';
  return Array.from(container.querySelectorAll('input[data-acct-type]:checked'))
    .map(cb => cb.dataset.acctType)
    .join(', ');
}

// ── Badge (server type_badge: 'in' | 'out') ───────────────────────────────────

function _catTypeBadge(badge) {
  const cls   = badge === 'in' ? 'badge-et-in' : 'badge-et-out';
  const label = badge === 'in' ? 'in' : 'out';
  return `<span class="badge ${cls}">${label}</span>`;
}

function _catTypeDot(badge) {
  const cls = badge === 'in' ? 'tx-dot-in' : 'tx-dot-out';
  return `<span class="tx-type-dot ${cls}">●</span>`;
}


// ── CSV import ────────────────────────────────────────────────────────────────
// The server parses and validates the CSV; the panel uploads the raw text and
// renders the server's summary, file errors, and per-line failures.

function _renderCatImportPanel() {
  const ready = !state.catImportBusy && _catImportFile !== null;
  return `
  <div class="card" id="catImportPanel" style="margin-bottom:20px">
    <div class="cat-form-header">Import categories from CSV</div>
    <div class="form-grid" style="margin-bottom:16px;align-items:start">
      <div class="field form-grid-span-2">
        <label for="catImportFile">CSV file</label>
        <input type="file" id="catImportFile" accept=".csv,text/csv"${state.catImportBusy ? ' disabled' : ''}>
        <div class="field-hint">Required: tx_type_key, major_category_label, minor_category_label. Optional: id, description, record_status, tag_keywords, counterparty_examples, source_account_types, target_account_types, source_account_mandatory, target_account_mandatory, is_subscription_eligible. Exported sync and audit columns are accepted; the server manages their values.</div>
      </div>
    </div>
    <div id="catImportChosen">${_renderCatImportChosen()}</div>
    <div id="catImportReport" aria-live="polite">${_renderCatImportReport(state.catImportReport)}</div>
    <div class="form-actions" style="margin-top:16px">
      <button class="btn btn-primary" id="catImportConfirm"${ready ? '' : ' disabled'}>${state.catImportBusy ? 'Importing…' : 'Import'}</button>
      <button class="btn btn-secondary" id="catImportCancel"${state.catImportBusy ? ' disabled' : ''}>Close</button>
    </div>
    <div class="pin-error" id="catImportError" role="alert"></div>
  </div>`;
}

function _renderCatImportChosen() {
  return _catImportFile === null ? '' : `<p class="cat-count">Selected: ${esc(_catImportFile.name ?? 'CSV file')}</p>`;
}

function _categoryImportError(result) {
  const messages = {
    missing_csv: 'Choose a CSV file with a header row and at least one category.',
    invalid_csv: 'The file is not valid CSV. Correct it and select the file again.',
    csv_has_no_rows: 'The CSV has no category rows.',
    invalid_csv_headers: 'The CSV headers are invalid. Correct them and select the file again.',
    invalid_csv_rows: 'The CSV has invalid rows. Nothing was imported; correct them and select the file again.',
    missing_categories: 'The connected backend does not support CSV upload yet. Deploy the updated backend and reload.',
    account_types_missing: 'Import account_types.csv in Configure → Account Types first, then retry.',
    account_types_backend_outdated: 'The connected backend uses the old Account Types schema. Deploy the updated backend and reload. Then import account_types.csv in Configure → Account Types before importing categories.',
    account_types_migration_required: 'Account Types still uses the old Sheet layout or underscore keys. Import the complete updated account_types.csv in Configure → Account Types, then return here. Selecting category_master.csv does not upgrade Account Types.',
    invalid_account_types: 'The account_types Sheet contains invalid or conflicting configuration. Correct it in Configure before retrying.',
    invalid_source_account_types: 'Source account-type hints are not available in the current configuration. Check Configure and the deployed backend version.',
    invalid_target_account_types: 'Target account-type hints are not available in the current configuration. Check Configure and the deployed backend version.',
    invalid_record_status: 'The record status is invalid or unsupported by the deployed backend.',
    invalid_id: 'The category ID must be a UUID.',
    record_locked: 'This category is locked. Unlock it before changing it.',
    duplicate_category: 'Another category already uses this transaction type, major and minor key.',
    duplicate_category_id: 'The CSV repeats a category UUID.',
    duplicate_id_in_import: 'The CSV repeats a category UUID. Keep one row for each ID.',
    invalid_existing_category_id: 'The category Sheet contains a malformed or duplicate UUID. Correct the existing identities before retrying.',
    invalid_boolean: 'Use true, false, or a blank value for this field.',
    stale_row: 'This category moved or changed during import. Reload before retrying.',
    category_write_failed: 'The Sheet write failed. Reload to check whether the row was saved before retrying with the same UUID.',
    fk_scan_error: 'References to this category could not be checked. Retry after the connection is restored.',
    category_key_change_has_dependents: 'Transactions or subscriptions use this category key. Reconcile those references before renaming it.',
    missing_major_category: 'A major category label is required.',
    missing_minor_category: 'A minor category label is required.',
    invalid_category_label: 'The label must produce a non-empty category key.',
    invalid_transaction_type: 'Choose a transaction type from the current category schema.',
    sheet_header_mismatch: 'The category Sheet headers need to be aligned with the current schema.',
    connection_error: 'Connection error. The server may have saved some rows. Reload before retrying.',
    invalid_response: 'The server did not return a complete import result. Reload before retrying; some rows may have been saved.',
    request_failed: 'Import stopped part-way. Some rows may have been saved. Refresh and check before importing the file again.',
  };
  const code = typeof result?.error === 'string' ? result.error : 'unknown_error';
  const values = Array.isArray(result?.invalid_values) ? result.invalid_values.map(String).join(', ') : '';
  return (messages[code] ?? `The server rejected this row: ${code}.`) + (values === '' ? '' : ` Values: ${values}.`);
}

function _renderCatImportReport(report) {
  if (report === null || report === undefined) return '';
  const message = (code, entry) => _categoryImportError(entry ?? { error: code });
  if (report.globalError !== null) return renderImportResult({ ok: false, ...report.globalError }, { message });
  return renderImportResult({ ok: true, results: report.failures, created: report.created, updated: report.updated, skipped: report.skipped }, { message });
}

function _refreshCatImportPanel() {
  const chosen = el('catImportChosen');
  if (chosen !== null) chosen.innerHTML = _renderCatImportChosen();
  const report = el('catImportReport');
  if (report !== null) report.innerHTML = _renderCatImportReport(state.catImportReport);
  const button = el('catImportConfirm');
  if (button !== null) {
    button.disabled = state.catImportBusy || _catImportFile === null;
    button.textContent = state.catImportBusy ? 'Importing…' : 'Import';
  }
  for (const id of ['catImportFile', 'catImportCancel', 'catImportBtn', 'catAddBtn']) {
    const control = el(id);
    if (control !== null) control.disabled = state.catImportBusy;
  }
}

function _selectCatImportFile(file) {
  _catImportFile = file ?? null;
  state.catImportReport = null;
  _refreshCatImportPanel();
}

async function _submitCatImport() {
  if (state.catImportBusy || _catImportFile === null) return;
  const file = _catImportFile;
  state.catImportBusy = true; state.catImportReport = null;
  _refreshCatImportPanel();
  if (el('catImportError') !== null) el('catImportError').textContent = '';
  showLoading();
  try {
    let csv;
    try { csv = await file.text(); } catch (_) {
      state.catImportReport = { globalError: { error: 'invalid_csv', errors: ['Unable to read the CSV. Select the file again.'] } };
      return;
    }
    const res = await ExpenseAPI.createCategoriesBulk({ csv });
    const results = res?.results;
    if (!Array.isArray(results) || results.length === 0) {
      state.catImportReport = { globalError: { ...res, error: typeof res?.error === 'string' ? res.error : 'invalid_response' } };
      showMsg(_categoryImportError(state.catImportReport.globalError), 'warn');
      // request_failed: the handler threw part-way, so rows may already be saved.
      if (res?.error === 'request_failed') document.dispatchEvent(new CustomEvent('et:reload'));
      return;
    }
    if (results.some(result => result === null || typeof result !== 'object' || typeof result.ok !== 'boolean')) {
      state.catImportReport = { globalError: { error: 'invalid_response' } };
      showMsg(_categoryImportError(state.catImportReport.globalError), 'warn');
      document.dispatchEvent(new CustomEvent('et:reload'));
      return;
    }
    const failures = results.filter(result => result.ok === false).map(result => ({ ...result, error: result.error ?? 'unknown_error' }));
    const created = results.filter(result => result.ok && result.action === 'created').length;
    const updated = results.filter(result => result.ok && result.action === 'updated').length;
    const skipped = results.filter(result => result.ok && result.action === 'unchanged').length;
    state.catImportReport = { created, updated, skipped, failures, globalError: null };
    state.catImportOpen = true;
    showMsg(`${created} created · ${updated} updated · ${skipped} unchanged · ${failures.length} failed`, failures.length > 0 ? 'warn' : 'success');
    if (created + updated > 0) document.dispatchEvent(new CustomEvent('et:reload'));
  } catch (_) {
    state.catImportReport = { globalError: { error: 'connection_error' } };
    console.warn('[categories] _submitCatImport: error=connection_error');
    document.dispatchEvent(new CustomEvent('et:reload'));
  } finally {
    state.catImportBusy = false;
    _refreshCatImportPanel();
    hideLoading();
  }
}


// ── Events ────────────────────────────────────────────────────────────────────

async function _export(format) {
  showLoading();
  try {
    // Export the whole filtered set, not just the visible page.
    const res = await ExpenseAPI.view(LIST_VIEW, _listParams({ page: 1, page_size: 'all' }));
    if (res?.ok !== true) { showMsg(res?.message || 'Export failed: ' + _errMsg(res?.error), 'warn'); return; }
    if (res.data.rows.length === 0) { showMsg('No categories to export.', 'warn'); return; }
    exportCategories(format, res.data.rows);
  } catch (err) {
    console.error('[categories] export failed:', err);
    showMsg('Connection error. The export could not be prepared.', 'warn');
  } finally {
    hideLoading();
  }
}

function _attachCatEvents() {
  if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
  el('catExportBtn').addEventListener('click', () => {
    openContextMenu(el('catExportBtn'), [
      { key: 'csv',  label: '↓ CSV'  },
      { key: 'json', label: '↓ JSON' },
    ], key => _export(key));
  });

  el('catImportBtn').addEventListener('click', () => {
    if (state.catImportBusy) return;
    if (state.catImportOpen) {
      state.catImportOpen = false;
      _catImportFile = null; state.catImportReport = null;
    } else {
      state.catImportOpen = true;
      state.catAddOpen = false;
      state.catViewRow = null;
      state.catEditRow = null;
    }
    _render();
  });

  if (state.catImportOpen) {
    el('catImportFile').addEventListener('change', event => { if (!state.catImportBusy) _selectCatImportFile(event.target.files[0]); });

    el('catImportConfirm').addEventListener('click', () => { _submitCatImport(); });

    el('catImportCancel').addEventListener('click', () => {
      if (state.catImportBusy) return;
      state.catImportReport = null;
      state.catImportOpen = false;
      _catImportFile = null;
      _render();
    });
  }

  el('catAddBtn').addEventListener('click', () => {
    if (state.catImportBusy) return;
    if (_anyFormOpen()) {
      state.catAddOpen = false;
      state.catViewRow = null;
      state.catEditRow = null;
      _render();
    } else {
      _openForm({ catAddOpen: true });
    }
  });

  _attachFormEvents();
  _attachFilterEvents();
  _attachListEvents();
}

function _attachFormEvents() {
  // Add form
  if (state.catAddOpen && el('catSaveNew') !== null) {
    el('catSaveNew').addEventListener('click', _saveNewCategory);
    el('catCancelNew').addEventListener('click', () => { state.catAddOpen = false; _render(); });
  }

  // Edit form
  if (state.catEditRow !== null && el('catSaveEdit') !== null) {
    el('catSaveEdit').addEventListener('click', _saveCatEdit);
    el('catCancelEdit').addEventListener('click', () => { state.catEditRow = null; _render(); });
  }

  // View form
  if (state.catViewRow !== null && el('catCancelView') !== null) {
    el('catCancelView').addEventListener('click', () => { state.catViewRow = null; _render(); });
    const viewToEditEl = el('catViewToEdit');
    if (viewToEditEl !== null) viewToEditEl.addEventListener('click', e => {
      _openForm({ catEditRow: e.currentTarget.dataset.row });
    });
    const viewRestoreEl = el('catViewRestore');
    if (viewRestoreEl !== null) viewRestoreEl.addEventListener('click', e => {
      const row = e.currentTarget.dataset.row;
      state.catViewRow = null;
      _restoreCat(row);
    });
  }
}

function _attachFilterEvents() {
  if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
  const toggle = el('catFilterToggle');
  if (toggle === null) return;
  toggle.addEventListener('click', () => {
    state.catFilterOpen = !state.catFilterOpen;
    if (state.catFilterOpen && _catDraft === null) {
      _catDraft = { ...state.catFilters, recordStatuses: [...state.catFilters.recordStatuses] };
    }
    const wrap = el('catFilterWrap');
    if (wrap !== null) wrap.innerHTML = _renderCatFilterBar();
    _attachFilterEvents();
  });

  if (!state.catFilterOpen) return;
  if (_catDraft === null) {
    _catDraft = { ...state.catFilters, recordStatuses: [...state.catFilters.recordStatuses] };
  }

  const MENU_OPEN_STYLE = 'display:flex;flex-direction:column;gap:8px;position:fixed;z-index:1000;background:var(--panel);border:1px solid var(--hair-strong);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.15)';
  const ALL_DD_MENUS = ['catFTypeMenu','catFMajorMenu','catFMinorMenu','catFSrcMenu','catFTgtMenu','catFSubMenu','catFStatusMenu'];

  const _openDD = (triggerId, menuId) => {
    ALL_DD_MENUS.filter(id => id !== menuId).forEach(id => {
      const m = el(id); if (m !== null && m.style.display !== 'none') m.style.cssText = 'display:none';
    });
    if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
    const menu = el(menuId);
    if (menu === null) return;
    if (menu.style.display === 'flex') { menu.style.cssText = 'display:none'; return; }
    const trig = el(triggerId);
    if (trig === null) return;
    const r = trig.getBoundingClientRect();
    menu.style.cssText = `${MENU_OPEN_STYLE};top:${r.bottom + 4}px;left:${r.left}px;width:${r.width}px`;
    const close = e => {
      if (trig.contains(e.target) || menu.contains(e.target)) return;
      menu.style.cssText = 'display:none';
      document.removeEventListener('click', close, true);
      _catDDCleanup = null;
    };
    document.addEventListener('click', close, true);
    _catDDCleanup = () => document.removeEventListener('click', close, true);
  };

  el('catFTypeTrigger').addEventListener('click',   () => _openDD('catFTypeTrigger',   'catFTypeMenu'));
  el('catFMajorTrigger').addEventListener('click',  () => _openDD('catFMajorTrigger',  'catFMajorMenu'));
  el('catFMinorTrigger').addEventListener('click',  () => {
    const trig = el('catFMinorTrigger');
    if (trig !== null && trig.disabled) return;
    _openDD('catFMinorTrigger', 'catFMinorMenu');
  });
  el('catFSrcTrigger').addEventListener('click',    () => _openDD('catFSrcTrigger',    'catFSrcMenu'));
  el('catFTgtTrigger').addEventListener('click',    () => _openDD('catFTgtTrigger',    'catFTgtMenu'));
  el('catFSubTrigger').addEventListener('click',    () => _openDD('catFSubTrigger',    'catFSubMenu'));
  el('catFStatusTrigger').addEventListener('click', () => _openDD('catFStatusTrigger', 'catFStatusMenu'));

  const facets = _facets();
  const typeLabels = Object.fromEntries([['all', 'All types'], ...facets.types.map(t => [t.value, t.label])]);

  // Single-select radio menus — event delegation on the container
  const _delegateRadio = (menuId, draftKey, labelId, labelMap) => {
    const menu = el(menuId);
    if (menu === null) return;
    menu.addEventListener('change', e => {
      const radio = e.target.closest('input[type="radio"]');
      if (radio === null) return;
      const val = radio.value;
      if (_catDraft !== null) _catDraft[draftKey] = val;
      const lbl = el(labelId); if (lbl !== null) lbl.textContent = labelMap[val] !== undefined ? labelMap[val] : val;
      menu.style.cssText = 'display:none';
      if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
    });
  };
  _delegateRadio('catFTypeMenu',  'type',                'catFTypeLabel',  typeLabels);
  const labelMap = list => Object.fromEntries((list ?? []).map(item => [item.value, item.label]));
  _delegateRadio('catFSrcMenu',   'sourceMandatory',      'catFSrcLabel',   labelMap(facets.mandatory));
  _delegateRadio('catFTgtMenu',   'targetMandatory',      'catFTgtLabel',   labelMap(facets.mandatory));
  _delegateRadio('catFSubMenu',   'subscriptionEligible', 'catFSubLabel',   labelMap(facets.subscription_eligible));

  // Major — delegation; repopulates the minor menu from the server facets
  const majorMenu = el('catFMajorMenu');
  if (majorMenu !== null) {
    majorMenu.addEventListener('change', e => {
      const radio = e.target.closest('input[type="radio"]');
      if (radio === null) return;
      const val = radio.value;
      if (_catDraft !== null) { _catDraft.major = val; _catDraft.minor = 'all'; }
      const lbl = el('catFMajorLabel'); if (lbl !== null) lbl.textContent = _labelOf(facets.majors, val, 'All major');
      majorMenu.style.cssText = 'display:none';
      if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }

      const minTrig = el('catFMinorTrigger');
      const minMenu = el('catFMinorMenu');
      const minLbl  = el('catFMinorLabel');
      if (val === 'all') {
        if (minTrig !== null) { minTrig.disabled = true; minTrig.style.opacity = '0.5'; minTrig.style.cursor = 'not-allowed'; }
        if (minLbl !== null)  minLbl.textContent = '— select major first —';
        if (minMenu !== null) minMenu.innerHTML = '';
      } else {
        if (minTrig !== null) { minTrig.disabled = false; minTrig.style.opacity = ''; minTrig.style.cursor = ''; }
        if (minLbl !== null)  minLbl.textContent = 'All minor';
        if (minMenu !== null) minMenu.innerHTML = _minorItems(val, 'all');
      }
    });
  }

  // Minor — delegation (handles dynamically repopulated innerHTML)
  const minorMenu = el('catFMinorMenu');
  if (minorMenu !== null) {
    minorMenu.addEventListener('change', e => {
      const radio = e.target.closest('input[type="radio"]');
      if (radio === null) return;
      const val = radio.value;
      if (_catDraft !== null) _catDraft.minor = val;
      const minors = _catDraft !== null ? facets.minors_by_major[_catDraft.major] ?? [] : [];
      const lbl = el('catFMinorLabel'); if (lbl !== null) lbl.textContent = _labelOf(minors, val, 'All minor');
      minorMenu.style.cssText = 'display:none';
      if (_catDDCleanup !== null) { _catDDCleanup(); _catDDCleanup = null; }
    });
  }

  // Status checkboxes — delegation; dropdown stays open while checking
  const statusMenu = el('catFStatusMenu');
  if (statusMenu !== null) {
    statusMenu.addEventListener('change', () => {
      if (_catDraft === null) return;
      const checked = Array.from(statusMenu.querySelectorAll('[data-cat-filter-rstat]:checked'))
        .map(c => c.dataset.catFilterRstat);
      _catDraft.recordStatuses = checked;
      const lbl = el('catFStatusLabel');
      if (lbl) lbl.textContent = _statusLabel(checked);
    });
  }

  // Apply draft → state on Search / Enter, then request the filtered view.
  const _applyDraft = () => {
    if (_catDraft !== null) {
      _catDraft.search = el('catFSearch').value.trim();
      state.catFilters = { ..._catDraft, recordStatuses: [..._catDraft.recordStatuses] };
      _catDraft = null;
    }
    _catPage = 1;
    _refreshListParts();
    _loadList();
  };
  el('catFSearchBtn').addEventListener('click', _applyDraft);
  el('catFSearch').addEventListener('keydown', e => { if (e.key === 'Enter') _applyDraft(); });

  // Clear — reset both draft and applied
  el('catFClear').addEventListener('click', () => {
    _catDraft = null;
    state.catFilters = {
      type: 'all', major: 'all', minor: 'all', search: '',
      sourceMandatory: 'all', targetMandatory: 'all', subscriptionEligible: 'all',
      recordStatuses: _allStatuses().slice(),
    };
    _catPage = 1;
    _refreshListParts();
    _loadList();
  });
}

const _MENU_LABELS = { view: 'View', edit: 'Edit', transactions: 'Transactions', restore: 'Restore', delete: 'Delete' };

function _attachListEvents() {
  const content = el('categoriesContent');
  if (content === null) return;

  const handleCatAction = e => {
    const sort = e.target.closest('th[data-cat-sort]');
    if (sort !== null) {
      const col = sort.dataset.catSort;
      _catSort = { col, dir: _catSort.col === col && _catSort.dir === 'asc' ? 'desc' : 'asc' };
      _catPage = 1;
      _loadList();
      return;
    }
    const btn    = e.target.closest('[data-action]');
    if (btn === null) return;
    const action = btn.dataset.action;
    const row    = btn.dataset.row !== undefined && btn.dataset.row !== '' ? btn.dataset.row : undefined;

    if (action === 'cat-menu') {
      if (_catMenuKey === row) { closeContextMenu(); _catMenuKey = null; return; }
      _catMenuKey = row;
      const menuCat = _recordById(row);
      if (menuCat === undefined) return;
      const menuItems = menuCat.allowed_actions.filter(key => _MENU_LABELS[key] !== undefined)
        .map(key => ({ key, label: _MENU_LABELS[key], cls: key === 'delete' ? 'danger' : '' }));
      openContextMenu(btn, menuItems, key => {
        _catMenuKey = null;
        if (key === 'view')    _openForm({ catViewRow: row });
        if (key === 'edit')    _openForm({ catEditRow: row });
        if (key === 'delete')  { state.catDeleteRow = row; state.catViewRow = null; state.catEditRow = null; _render(); }
        if (key === 'restore') { _restoreCat(row); }
        if (key === 'transactions') {
          state.filters = { types: [], accounts: [], major: menuCat.transactions_filter.major, minor: menuCat.transactions_filter.minor, user_location_country: '', tag: '', search: '' };
          document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
        }
      });
      return;
    }
    if (action === 'cat-cancel-delete')  { state.catDeleteRow = null; _render(); }
    if (action === 'cat-confirm-delete') { _deleteCat(row); }
  };
  const tableWrap = content.querySelector('.cat-table-wrap');
  if (tableWrap !== null) tableWrap.addEventListener('click', handleCatAction);
  const catCards = content.querySelector('.cat-cards');
  if (catCards !== null) catCards.addEventListener('click', handleCatAction);

  el('catPrevPage')?.addEventListener('click', () => { _catPage = Math.max(1, _catPage - 1); _loadList(); });
  el('catNextPage')?.addEventListener('click', () => { _catPage += 1; _loadList(); });
  el('catPerPage')?.addEventListener('change', e => {
    _catPageSize = e.target.value === 'all' ? 'all' : Number(e.target.value);
    _catPage = 1;
    _loadList();
  });
}

// ── Restore ───────────────────────────────────────────────────────────────────

async function _restoreCat(categoryId) {
  const cat = _recordById(categoryId);
  if (cat === undefined || cat === null) return;
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num:                  cat._row,
      ..._identity(cat),
      tx_type_key:              cat.tx_type_key,
      major_category_label:     cat.major_category_label,
      minor_category_label:     cat.minor_category_label,
      description:              cat.description,
      record_status:            'active',
      is_subscription_eligible: Boolean(cat.is_subscription_eligible),
      tag_keywords:             cat.tag_keywords,
      counterparty_examples:    cat.counterparty_examples,
      source_account_types:     cat.source_account_types,
      target_account_types:     cat.target_account_types,
      source_account_mandatory: Boolean(cat.source_account_mandatory),
      target_account_mandatory: Boolean(cat.target_account_mandatory),
    });
    if (res.ok) {
      showMsg('Category restored.');
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _restoreCat failed:', res.error);
      const msg = res.error === 'duplicate_category'
        ? 'Cannot restore: this category already exists.'
        : res.error === 'record_locked'
          ? 'This category is locked.'
          : (res.message || 'Restore failed: ' + _errMsg(res.error));
      showMsg(msg, 'warn');
      _render();
    }
  } catch (err) {
    console.error('[categories] _restoreCat failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    _render();
  } finally {
    hideLoading();
  }
}

// ── Save new ──────────────────────────────────────────────────────────────────

async function _saveNewCategory() {
  const tx_type_key           = el('catNewType').value;
  const major_category_label  = el('catNewMajor').value.trim();
  const minor_category_label  = el('catNewMinor').value.trim();
  const description           = el('catNewDesc').value.trim();
  const tag_keywords          = el('catNewKeywords').value.trim();
  const counterparty_examples = el('catNewCounterparty').value.trim();
  const source_account_types  = _getCheckedAccountTypes('catNewSrc');
  const target_account_types  = _getCheckedAccountTypes('catNewTgt');
  const source_account_mandatory = el('catNewSrcMandatory').checked === true;
  const target_account_mandatory = el('catNewTgtMandatory').checked === true;
  // CAT-M-8: record_status is NOT sent on create — backend always writes 'active' regardless.
  const is_subscription_eligible = el('catNewIsSubEligible').checked === true;
  const errEl                    = el('catAddError');

  clearFormError(errEl);

  const btn = el('catSaveNew');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.createCategory({
      tx_type_key, major_category_label, minor_category_label, description,
      is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory,
    });
    if (res.ok) {
      showMsg('Category added.');
      state.catAddOpen = false;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveNewCategory failed:', res.error);
      showFormError(errEl, res, _CAT_FIELD_IDS.add);
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveNewCategory failed:', err);
    if (errEl !== null) errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Save edit ─────────────────────────────────────────────────────────────────

async function _saveCatEdit() {
  const cat = _recordById(state.catEditRow);
  if (cat === undefined) return;

  const tx_type_key           = el('catEditType').value;
  const major_category_label  = el('catEditMajor').value.trim();
  const minor_category_label  = el('catEditMinor').value.trim();
  const description           = el('catEditDesc').value.trim();
  const tag_keywords          = el('catEditKeywords').value.trim();
  const counterparty_examples = el('catEditCounterparty').value.trim();
  const source_account_types  = _getCheckedAccountTypes('catEditSrc');
  const target_account_types  = _getCheckedAccountTypes('catEditTgt');
  const source_account_mandatory = el('catEditSrcMandatory').checked === true;
  const target_account_mandatory = el('catEditTgtMandatory').checked === true;
  const record_status            = el('catEditRecordStatus').value;
  const is_subscription_eligible = el('catEditIsSubEligible').checked === true;
  const errEl                    = el('catEditError');

  clearFormError(errEl);

  const btn = el('catSaveEdit');
  if (btn !== null) { btn.disabled = true; btn.textContent = 'Saving…'; }
  showLoading();
  try {
    const res = await ExpenseAPI.updateCategory({
      row_num: cat._row, ..._identity(cat), tx_type_key, major_category_label, minor_category_label, description,
      record_status, is_subscription_eligible, tag_keywords, counterparty_examples,
      source_account_types, target_account_types,
      source_account_mandatory, target_account_mandatory,
    });
    if (res.ok) {
      showMsg('Category updated.');
      state.catEditRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _saveCatEdit failed:', res.error);
      showFormError(errEl, res, _CAT_FIELD_IDS.edit);
      if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  } catch (err) {
    console.error('[categories] _saveCatEdit failed:', err);
    if (errEl !== null) errEl.textContent = 'Connection lost. The change may have completed. Refresh and check before retrying.';
    if (btn !== null) { btn.disabled = false; btn.textContent = 'Save'; }
  } finally {
    hideLoading();
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _deleteCat(categoryId) {
  const cat = _recordById(categoryId);
  if (cat === undefined) return;
  showLoading();
  try {
    const res = await ExpenseAPI.deleteCategory({ row_num: cat._row, ..._identity(cat) });
    if (res.ok) {
      showMsg('Category marked as deleted.');
      state.catDeleteRow = null;
      document.dispatchEvent(new CustomEvent('et:reload'));
    } else {
      console.warn('[categories] _deleteCat failed:', res.error);
      const msg = res.error === 'record_locked'
        ? 'This category is locked and cannot be deleted.'
        : (res.message || 'Delete failed: ' + _errMsg(res.error));
      showMsg(msg, 'warn');
      state.catDeleteRow = null;
      _render();
    }
  } catch (err) {
    console.error('[categories] _deleteCat failed:', err);
    showMsg('Connection lost. The change may have completed. Refresh and check before retrying.', 'warn');
    state.catDeleteRow = null;
    _render();
  } finally {
    hideLoading();
  }
}
