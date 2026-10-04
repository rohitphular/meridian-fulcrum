import { state } from '../core/state.js';
import { el, esc, fmtAsOf } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';
import { renderBuilder, bldBody, bldDefaultDraft, bldDraftFromDefinition } from './reports/builder.js';
import { renderViewer } from './reports/viewer.js';

// Reports: a menu with Pre-built (the catalogue, by group) and My reports
// (user-defined reports with their status), the builder and the viewer.
// list_reports_view returns the builder schema, filter options, both lists,
// each report's status and allowed_actions; get_dashboard_layout says what is
// on Home. The analytics job computes every report; this file renders and
// sends the user's choices. Nothing is computed here.
const LIST_VIEW = 'list_reports_view';
const LAYOUT_VIEW = 'get_dashboard_layout';

let _rptSeq = 0;
let _rptError = '';
let _rptAbort = null;

const _RPT_ACTION_LABELS = {
  open: 'Open', customise: 'Customise', add_to_home: 'Add to Home', edit: 'Edit', duplicate: 'Duplicate', delete: 'Delete', restore: 'Restore',
};
const _RPT_AREA_LABELS = { tile: 'number tile', panel: 'report panel' };

function _rptList() {
  const response = state.views?.[LIST_VIEW];
  return response?.ok === true ? response.data : null;
}

function _rptLayoutSlots() {
  const response = state.views?.[LAYOUT_VIEW];
  return response?.ok === true ? (response.data.slots ?? []) : [];
}

function _rptOnHome(id) {
  return _rptLayoutSlots().some(slot => slot.report_id === id);
}

function _rptMine(id) {
  return (_rptList()?.mine ?? []).find(row => row.id === id) ?? null;
}

function _rptPredefined(id) {
  for (const group of _rptList()?.predefined ?? []) {
    const item = (group.items ?? []).find(entry => entry.id === id);
    if (item) return item;
  }
  return null;
}

// ── Status badge ──────────────────────────────────────────────────────────────

// Queued | Invalid: <reason> | Ready · as of <local time> | Failed: <reason>
export function reportStatusText(item) {
  const label = item.status_label || item.status || '';
  if (item.status === 'ready') {
    const asOf = fmtAsOf(item.published_at);
    return asOf ? `${label} · as of ${asOf}` : label;
  }
  return item.status_reason ? `${label}: ${item.status_reason}` : label;
}

function _rptBadge(item) {
  if (!item.status) return '';
  return `<span class="rpt-badge rpt-badge-${esc(item.status)}">${esc(reportStatusText(item))}</span>`;
}

// ── Lists ─────────────────────────────────────────────────────────────────────

function _rptActions(item) {
  return (item.allowed_actions ?? []).map(action => {
    if (action === 'add_to_home' && _rptOnHome(item.id)) return '<button type="button" class="btn-link muted" disabled>On Home</button>';
    const cls = action === 'delete' ? 'btn-link danger' : 'btn-link';
    return `<button type="button" class="${cls}" data-action="rpt-${esc(action)}" data-id="${esc(item.id)}">${esc(_RPT_ACTION_LABELS[action] ?? action)}</button>`;
  }).join('');
}

function _rptPredefinedHtml(data) {
  const groups = data.predefined ?? [];
  if (groups.length === 0) return '<p class="placeholder">No pre-built reports.</p>';
  return groups.map(group => `
    <div class="rpt-eyebrow" style="margin-top:16px">${esc(group.group)}</div>
    ${(group.items ?? []).map(item => `
      <div class="rpt-item">
        <div class="rpt-item-main">
          <div class="rpt-item-title">${esc(item.title)}</div>
          <div class="field-hint">${esc(item.description)}</div>
        </div>
        ${_rptBadge(item)}
        <div class="row-actions rpt-actions">${_rptActions(item)}</div>
      </div>`).join('')}`).join('');
}

function _rptDeleteHtml(row) {
  const home = _rptOnHome(row.id) ? ' It is also removed from Home.' : '';
  return `
    <div class="rpt-item rpt-item-confirm">
      <span class="confirm-text">Delete <strong>${esc(row.report_name)}</strong>?${esc(home)} You can restore it from Show deleted.</span>
      <div class="row-actions">
        <button type="button" class="btn-link danger" data-action="rpt-confirm-delete" data-id="${esc(row.id)}">Yes, delete</button>
        <button type="button" class="btn-link muted" data-action="rpt-cancel-delete">Keep it</button>
      </div>
    </div>`;
}

function _rptMineHtml(data) {
  const rows = data.mine ?? [];
  const toggle = `<label class="rpt-check rpt-show-deleted"><input type="checkbox" id="rptShowDeleted"${state.reportsShowDeleted ? ' checked' : ''}> Show deleted</label>`;
  if (rows.length === 0) return `${toggle}<p class="placeholder">No reports yet. Use &ldquo;+ New report&rdquo;, or Customise a pre-built one.</p>`;
  return toggle + rows.map(row => {
    if (state.reportDeleteId === row.id) return _rptDeleteHtml(row);
    return `
      <div class="rpt-item${row.record_status === 'deleted' ? ' rpt-item-deleted' : ''}">
        <div class="rpt-item-main">
          <div class="rpt-item-title">${esc(row.report_name)}</div>
          <div class="field-hint">${esc(row.summary)}</div>
          ${row.report_description ? `<div class="field-hint">${esc(row.report_description)}</div>` : ''}
        </div>
        ${row.record_status === 'deleted' ? '<span class="rpt-badge rpt-badge-deleted">Deleted</span>' : _rptBadge(row)}
        <div class="row-actions rpt-actions">${_rptActions(row)}</div>
      </div>`;
  }).join('');
}

function _rptListHtml() {
  const data = _rptList();
  if (data === null) {
    return _rptError !== '' ? `<p class="pin-error" role="alert">${esc(_rptError)}</p>` : '<p class="placeholder">Loading reports…</p>';
  }
  return `${_rptError !== '' ? `<p class="pin-error" role="alert">${esc(_rptError)}</p>` : ''}
    ${state.reportsMenu === 'mine' ? _rptMineHtml(data) : _rptPredefinedHtml(data)}`;
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderReports() {
  if (state.views === undefined || state.views === null) state.views = {};
  _rptRender();
  if (state.reportView === null || state.reportView === undefined) _rptLoad();
}

function _rptRender() {
  const content = el('reportsContent');
  if (!content) return;
  if (_rptAbort) _rptAbort.abort();
  _rptAbort = null;
  if (state.reportView) {
    renderViewer(content, {
      view: state.reportView,
      onBack: () => { state.reportView = null; renderReports(); },
      onOpenTransactions: query => {
        state.filters = { ...(query?.params ?? {}) };
        document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
      },
    });
    return;
  }
  if (content._viewerAbort) { content._viewerAbort.abort(); content._viewerAbort = null; }
  const menu = state.reportsMenu === 'mine' ? 'mine' : 'predefined';
  content.innerHTML = `
    <div class="sec-head rpt-head">
      <div class="rpt-seg" role="tablist">
        <button type="button" role="tab" class="${menu === 'predefined' ? 'on' : ''}" aria-selected="${menu === 'predefined'}" data-action="rpt-menu" data-menu="predefined">Pre-built</button>
        <button type="button" role="tab" class="${menu === 'mine' ? 'on' : ''}" aria-selected="${menu === 'mine'}" data-action="rpt-menu" data-menu="mine">My reports</button>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-action="rpt-new"${_rptList() === null ? ' disabled' : ''}>+ New report</button>
    </div>
    <div id="reportBuilderSlot"></div>
    <div id="reportsList">${_rptListHtml()}</div>`;
  _rptRenderBuilder();
  _rptAttach(content);
}

function _rptRenderList() {
  const region = el('reportsList');
  if (!region || state.reportView) { _rptRender(); return; }
  region.innerHTML = _rptListHtml();
  const add = el('reportsContent')?.querySelector?.('[data-action="rpt-new"]');
  if (add) add.disabled = _rptList() === null;
}

function _rptRenderBuilder() {
  const slot = el('reportBuilderSlot');
  const data = _rptList();
  if (!slot) return;
  if (!state.reportBuilder || data === null) { slot.innerHTML = ''; return; }
  renderBuilder(slot, {
    schema: data.schema, options: data.filter_options, builder: state.reportBuilder,
    onSave: _rptSave,
    onClose: () => { state.reportBuilder = null; _rptRenderBuilder(); },
  });
}

async function _rptLoad() {
  const seq = ++_rptSeq;
  const params = state.reportsShowDeleted ? { include_deleted: 'true' } : {};
  let list, layout;
  try {
    [list, layout] = await Promise.all([ExpenseAPI.view(LIST_VIEW, params), ExpenseAPI.view(LAYOUT_VIEW, {})]);
  } catch (error) {
    if (seq !== _rptSeq) return;
    console.error('[reports] list failed:', error?.message ?? 'error');
    _rptError = 'Reports could not be loaded. Check your connection and refresh.';
    _rptRenderList();
    return;
  }
  if (seq !== _rptSeq) return;
  if (list?.ok !== true) {
    console.warn('[reports] list refused:', list?.error);
    _rptError = list?.message || ('Reports could not be loaded: ' + (list?.error ?? 'invalid_response'));
  } else {
    _rptError = '';
    state.views[LIST_VIEW] = list;
  }
  if (layout?.ok === true) state.views[LAYOUT_VIEW] = layout;
  if (state.reportView) return;
  _rptRenderList();
  if (state.reportBuilder && !el('reportBuilderSlot')?.innerHTML) _rptRenderBuilder();
}

// ── Events ────────────────────────────────────────────────────────────────────

function _rptAttach(content) {
  _rptAbort = new AbortController();
  const { signal } = _rptAbort;
  content.addEventListener('change', e => {
    if (e.target.id === 'rptShowDeleted') {
      state.reportsShowDeleted = e.target.checked === true;
      state.reportDeleteId = null;
      _rptLoad();
    }
  }, { signal });
  content.addEventListener('click', e => {
    const button = e.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    if (action === 'rpt-menu') { state.reportsMenu = button.dataset.menu; state.reportDeleteId = null; _rptRender(); return; }
    if (action === 'rpt-new') { _rptOpenBuilder('create', null, ''); return; }
    if (action === 'rpt-open') { _rptOpen(id); return; }
    if (action === 'rpt-customise') { const item = _rptPredefined(id); if (item) _rptOpenBuilder('create', null, `Copy of ${item.title}`); return; }
    if (action === 'rpt-edit') { _rptOpenBuilder('edit', id, ''); return; }
    if (action === 'rpt-duplicate') { _rptRowAction(id, 'duplicateReport', row => `Duplicated "${row.report_name}". The copy is ready after the next refresh.`); return; }
    if (action === 'rpt-restore') { _rptRowAction(id, 'restoreReport', row => `Restored "${row.report_name}". It is ready after the next refresh.`); return; }
    if (action === 'rpt-delete') { state.reportDeleteId = id; _rptRenderList(); return; }
    if (action === 'rpt-cancel-delete') { state.reportDeleteId = null; _rptRenderList(); return; }
    if (action === 'rpt-confirm-delete') {
      _rptRowAction(id, 'deleteReport', (row, res) => `Deleted "${row.report_name}".${res.layout_slots_cleared > 0 ? ' It was removed from Home.' : ''}`);
      return;
    }
    if (action === 'rpt-add_to_home') _rptAddToHome(id);
  }, { signal });
}

function _rptOpen(id) {
  const item = _rptMine(id) ?? _rptPredefined(id);
  if (!item) return;
  state.reportView = {
    id, title: item.title ?? item.report_name ?? '', description: item.description ?? item.report_description ?? '',
    period: '', default_period: item.default_period ?? '', periods: item.periods ?? [], tab: '', controls: {}, drill: '',
  };
  state.reportBuilder = null;
  _rptRender();
}

function _rptOpenBuilder(mode, id, name) {
  const data = _rptList();
  if (data === null) return;
  let draft;
  if (mode === 'edit') {
    const row = _rptMine(id);
    if (!row) return;
    draft = bldDraftFromDefinition(data.schema, row.definition ?? {}, row.report_name);
    draft.report_description = row.report_description ?? draft.report_description;
  } else {
    draft = bldDefaultDraft(data.schema, name);
  }
  state.reportBuilder = { mode, id, draft, error: null };
  state.reportsMenu = 'mine';
  state.reportDeleteId = null;
  _rptRender();
}

async function _rptSave() {
  const builder = state.reportBuilder;
  const data = _rptList();
  if (!builder || data === null) return;
  const body = bldBody(data.schema, builder.draft);
  let response;
  showLoading();
  try {
    if (builder.mode === 'edit') {
      const row = _rptMine(builder.id);
      if (!row) { builder.error = { error: 'report_not_found', message: 'This report could not be found. Refresh and try again.' }; _rptRenderBuilder(); return; }
      response = await ExpenseAPI.updateReport({ id: row.id, row_num: row.row_num, updated_at: row.updated_at, ...body });
    } else {
      response = await ExpenseAPI.createReport(body);
    }
  } catch (error) {
    console.error('[reports] save failed:', error?.message ?? 'error');
    response = { ok: false, error: 'connection_error', message: 'The report may not have been saved. Refresh and check My reports before trying again.' };
  } finally { hideLoading(); }
  if (state.reportBuilder !== builder) return;
  if (response?.ok !== true) {
    builder.error = { error: response?.error ?? 'invalid_response', field: response?.field ?? '', message: response?.message ?? '' };
    _rptRenderBuilder();
    return;
  }
  state.reportBuilder = null;
  state.reportsMenu = 'mine';
  showMsg(response.unchanged === true ? 'No changes to save.' : `Saved "${body.report_name}". It is ready after the next refresh.`);
  document.dispatchEvent(new CustomEvent('et:reload'));
}

// duplicate / restore / delete: the row in hand (id + row_num + updated_at).
async function _rptRowAction(id, method, message) {
  const row = _rptMine(id);
  if (!row) return;
  let response;
  showLoading();
  try { response = await ExpenseAPI[method]({ id: row.id, row_num: row.row_num, updated_at: row.updated_at }); }
  catch (error) {
    console.error('[reports] ' + method + ' failed:', error?.message ?? 'error');
    response = { ok: false, error: 'connection_error', message: 'The change may not have been saved. Refresh and check My reports.' };
  } finally { hideLoading(); }
  state.reportDeleteId = null;
  if (response?.ok !== true) {
    showMsg(response?.message || ('Could not update the report: ' + (response?.error ?? 'invalid_response')), 'warn');
    _rptRenderList();
    return;
  }
  showMsg(message(row, response));
  document.dispatchEvent(new CustomEvent('et:reload'));
}

// Puts the report in the first empty Home slot of its kind (tile for single
// numbers, panel for charts) and saves all 8 slots; the server checks the slot
// rules. The layout is read again right before the write.
async function _rptAddToHome(id) {
  const item = _rptMine(id) ?? _rptPredefined(id);
  if (!item) return;
  const title = item.title ?? item.report_name ?? '';
  showLoading();
  try {
    let layout;
    try { layout = await ExpenseAPI.view(LAYOUT_VIEW, {}); }
    catch (error) { layout = { ok: false, message: 'Home could not be loaded. Check your connection and try again.' }; }
    if (layout?.ok !== true) { showMsg(layout?.message || 'Home could not be loaded.', 'warn'); return; }
    state.views[LAYOUT_VIEW] = layout;
    const slots = layout.data.slots ?? [];
    if (slots.some(slot => slot.report_id === id)) { showMsg(`"${title}" is already on Home.`); _rptRenderList(); return; }
    const free = slots.find(slot => slot.area === item.home_slot && slot.report_id === '');
    if (!free) {
      showMsg(`Home has no empty ${_RPT_AREA_LABELS[item.home_slot] ?? 'slot'}. Open Home and use Customise to replace one.`, 'warn');
      return;
    }
    const body = { slots: {} };
    slots.forEach(slot => { body.slots[slot.slot] = slot.slot === free.slot ? id : slot.report_id; });
    let response;
    try { response = await ExpenseAPI.updateDashboardLayout(body); }
    catch (error) { response = { ok: false, message: 'Home may not have been saved. Refresh and check Home.' }; }
    if (response?.ok !== true) { showMsg(response?.message || ('Home was not saved: ' + (response?.error ?? 'invalid_response')), 'warn'); return; }
    showMsg(`Added "${title}" to Home.`);
    document.dispatchEvent(new CustomEvent('et:reload'));
  } finally { hideLoading(); }
}
