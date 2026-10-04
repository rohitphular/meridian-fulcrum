import { state } from '../core/state.js';
import { el, esc, fmtAsOf, shareSnapshot } from '../core/utils.js';
import { showLoading, hideLoading, showMsg } from '../core/ui.js';
import { ExpenseAPI } from '../core/api.js';
import { fmtValue, fmtText } from './reports/chart-theme.js';
import { renderCompactPayload } from './reports/render-kinds.js';
import { reportWarningText, reportWarningsHtml } from './reports/viewer.js';

// Home: the configurable dashboard. get_home_view returns the 8 slots (4 number
// tiles, then 4 report panels) with each slot report's published default
// payload, already converted to the display currency. Tiles show the single
// stat card of a number report; panels show the report's charts compactly.
// No click-through, no period switch. Customise edits the layout from
// get_dashboard_layout (what each slot can hold) and saves all 8 slots with
// update_dashboard_layout; the server checks the slot rules.
const HOME_VIEW = 'get_home_view';
const LAYOUT_VIEW = 'get_dashboard_layout';

let _homeSeq = 0;
let _homeError = '';
let _homeCharts = [];
let _homeAbort = null;

function _homeDestroyCharts() {
  _homeCharts.forEach(chart => { try { chart?.destroy(); } catch (_) {} });
  _homeCharts = [];
}

function _homeLayout() {
  const response = state.views?.[LAYOUT_VIEW];
  return response?.ok === true ? response.data : null;
}

// The slot list in order: the draft while customising, else the home view.
function _homeSlots(view) {
  const custom = state.homeCustomise;
  if (!custom) return view?.data?.slots ?? [];
  return custom.order.map(({ slot, area }) => {
    const chosen = custom.slots[slot] ?? { report_id: '', title: '' };
    const shown = (view?.data?.slots ?? []).find(item => item.report_id !== '' && item.report_id === chosen.report_id) ?? null;
    return { slot, area, report_id: chosen.report_id, title: chosen.title, report_type: chosen.report_type,
      payload: shown?.payload ?? null, warnings: shown ? shown.warnings : [], pending: chosen.report_id !== '' && shown === null };
  });
}

function _homeStatusLine(slot) {
  if (slot.pending) return 'Shown after you save the layout.';
  const warning = (slot.warnings ?? [])[0];
  return warning ? reportWarningText(warning) : 'Appears after the next refresh.';
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _homeTools(slot, index, count) {
  if (!state.homeCustomise) return '';
  return `<div class="home-tools">
    <button type="button" class="btn btn-secondary btn-sm" data-action="home-move" data-slot="${esc(slot.slot)}" data-step="-1"${index === 0 ? ' disabled' : ''} aria-label="Move earlier">‹</button>
    <button type="button" class="btn btn-secondary btn-sm" data-action="home-move" data-slot="${esc(slot.slot)}" data-step="1"${index === count - 1 ? ' disabled' : ''} aria-label="Move later">›</button>
    ${slot.report_id ? `<button type="button" class="btn btn-secondary btn-sm" data-action="home-pick" data-slot="${esc(slot.slot)}" aria-label="Change">Change</button>
    <button type="button" class="btn btn-secondary btn-sm" data-action="home-remove" data-slot="${esc(slot.slot)}" aria-label="Remove">×</button>` : ''}
  </div>`;
}

function _homeEmptyHtml(slot, cls, label) {
  const picked = state.homeCustomise?.picker?.slot === slot.slot ? ' sel' : '';
  if (!state.homeCustomise) return `<div class="${cls} home-empty">Empty</div>`;
  return `<button type="button" class="${cls} home-empty home-empty-edit${picked}" data-action="home-pick" data-slot="${esc(slot.slot)}">+ ${esc(label)}</button>`;
}

function _homeTileHtml(slot, index, count, sym) {
  if (!slot.report_id) return _homeEmptyHtml(slot, 'home-tile', 'Add number');
  const picked = state.homeCustomise?.picker?.slot === slot.slot ? ' sel' : '';
  const cards = slot.payload?.stat_cards ?? [];
  const card = cards.find(item => item.key === 'value') ?? cards[0] ?? null;
  const tone = card?.tone === 'positive' || card?.tone === 'negative' ? card.tone : '';
  const sub = card === null ? _homeStatusLine(slot) : fmtText(card.sub ?? '', sym);
  return `<div class="home-tile${picked}">
    ${_homeTools(slot, index, count)}
    <div class="home-tile-label">${esc(slot.title || card?.label || '')}</div>
    <div class="home-tile-value ${esc(tone)}">${esc(card === null ? '—' : fmtValue(card.value, card.format, sym))}</div>
    <div class="home-tile-sub">${esc(sub)}</div>
  </div>`;
}

function _homePanelHtml(slot, index, count) {
  if (!slot.report_id) return _homeEmptyHtml(slot, 'home-panel', 'Add report panel');
  const picked = state.homeCustomise?.picker?.slot === slot.slot ? ' sel' : '';
  return `<div class="home-panel${picked}">
    ${_homeTools(slot, index, count)}
    <div class="home-panel-title">${esc(slot.title || slot.payload?.title || '')}</div>
    <div class="home-panel-body" id="homePanelBody_${esc(slot.slot)}">${slot.payload ? '' : `<p class="chart-empty">${esc(_homeStatusLine(slot))}</p>`}</div>
  </div>`;
}

function _homePickerListHtml(picker) {
  const layout = _homeLayout();
  const custom = state.homeCustomise;
  const area = custom.order.find(item => item.slot === picker.slot)?.area;
  const options = layout?.options?.[area] ?? [];
  const query = String(picker.query ?? '').trim().toLowerCase();
  const used = Object.entries(custom.slots).filter(([, chosen]) => chosen.report_id !== '');
  const groups = [['predefined', 'Pre-built'], ['user_defined', 'My reports']].map(([type, label]) => {
    // Search over the server's option list (input UX, like tag autocomplete).
    const items = options.filter(option => option.report_type === type && (query === '' || String(option.title).toLowerCase().includes(query)));
    if (items.length === 0) return '';
    return `<div class="rpt-eyebrow" style="margin:10px 0 4px">${esc(label)}</div>${items.map(option => {
      const here = custom.slots[picker.slot]?.report_id === option.report_id;
      const taken = !here && used.some(([, chosen]) => chosen.report_id === option.report_id);
      return `<button type="button" class="home-option" data-action="home-choose" data-id="${esc(option.report_id)}"${taken ? ' disabled' : ''}>
        <span>${esc(option.title)}</span><span class="field-hint">${here ? 'Current' : taken ? 'Already on Home' : ''}</span></button>`;
    }).join('')}`;
  }).join('');
  return groups || '<p class="field-hint" style="padding:8px 0">No match.</p>';
}

function _homePickerHtml(area) {
  const custom = state.homeCustomise;
  const picker = custom?.picker;
  if (!picker) return '';
  const order = custom.order.filter(item => item.area === area);
  const index = order.findIndex(item => item.slot === picker.slot);
  if (index === -1) return '';
  const title = area === 'tile' ? `Choose a number for tile ${index + 1}` : `Choose a report for panel ${index + 1}`;
  return `<div class="card home-picker">
    <div class="home-picker-head"><strong>${esc(title)}</strong><button type="button" class="btn btn-secondary btn-sm" data-action="home-pick-close" aria-label="Close picker">×</button></div>
    <input type="search" id="homePickerSearch" placeholder="Search" value="${esc(picker.query ?? '')}" aria-label="Search reports">
    <div id="homePickerList">${_homePickerListHtml(picker)}</div>
    ${area === 'tile' ? '<p class="field-hint" style="margin-top:8px">Tiles take single-number reports. Your reports appear here when they show one number.</p>' : ''}
  </div>`;
}

function _homeBarHtml() {
  const custom = state.homeCustomise;
  if (!custom) {
    return `<button type="button" class="btn btn-secondary btn-sm" id="homeShareBtn" data-action="home-share">📤 Share</button>
      <button type="button" class="btn btn-secondary btn-sm" data-action="home-customise">Customise</button>`;
  }
  const reset = _homeLayout()?.default_slots ? '<button type="button" class="btn btn-secondary btn-sm" data-action="home-reset">Reset to default</button>' : '';
  return `${reset}
    <button type="button" class="btn btn-secondary btn-sm" data-action="home-cancel">Cancel</button>
    <button type="button" class="btn btn-primary btn-sm" data-action="home-save">Save layout</button>`;
}

function _homeRender() {
  _homeDestroyCharts();
  const content = el('homeContent');
  if (!content) return;
  const response = state.views?.[HOME_VIEW];
  if (response?.ok !== true) {
    content.innerHTML = `<p class="placeholder" style="margin-top:32px">${esc(_homeError || 'Loading…')}</p>`;
    return;
  }
  const sym = response.quote?.symbol ?? '';
  const slots = _homeSlots(response);
  const tiles = slots.filter(slot => slot.area === 'tile');
  const panels = slots.filter(slot => slot.area === 'panel');
  const custom = state.homeCustomise;
  const asOf = fmtAsOf(response.published_at);
  content.innerHTML = `
    <div class="home-head">
      <div><div class="rpt-eyebrow">Home</div><div class="home-title">${custom ? 'Customise dashboard' : 'Your dashboard'}</div></div>
      <div class="home-bar">${_homeBarHtml()}</div>
    </div>
    ${custom?.error ? `<p class="pin-error" role="alert">${esc(custom.error)}</p>` : ''}
    ${reportWarningsHtml(response.warnings)}
    <div class="home-tiles${custom ? ' home-edit' : ''}">${tiles.map((slot, index) => _homeTileHtml(slot, index, tiles.length, sym)).join('')}</div>
    <div id="homePicker_tile">${_homePickerHtml('tile')}</div>
    <div class="home-panels${custom ? ' home-edit' : ''}">${panels.map((slot, index) => _homePanelHtml(slot, index, panels.length)).join('')}</div>
    <div id="homePicker_panel">${_homePickerHtml('panel')}</div>
    ${asOf ? `<p class="rpt-asof" style="margin-top:10px">As of ${esc(asOf)}</p>` : ''}`;
  _homeAttach(content);
  panels.forEach(slot => {
    if (!slot.payload) return;
    _homeCharts.push(...renderCompactPayload(el(`homePanelBody_${slot.slot}`), slot.payload, sym));
  });
}

// ── Events ────────────────────────────────────────────────────────────────────

function _homeAttach(content) {
  if (_homeAbort) _homeAbort.abort();
  _homeAbort = new AbortController();
  const { signal } = _homeAbort;
  content.addEventListener('input', e => {
    if (e.target.id !== 'homePickerSearch' || !state.homeCustomise?.picker) return;
    state.homeCustomise.picker.query = e.target.value;
    const list = el('homePickerList');
    if (list) list.innerHTML = _homePickerListHtml(state.homeCustomise.picker);
  }, { signal });
  content.addEventListener('click', e => {
    const button = e.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const { action, slot } = button.dataset;
    const custom = state.homeCustomise;
    if (action === 'home-share') { shareSnapshot(content, 'home-dashboard.png'); return; }
    if (action === 'home-customise') { _homeStartCustomise(); return; }
    if (!custom) return;
    if (action === 'home-cancel') { state.homeCustomise = null; _homeRender(); return; }
    if (action === 'home-save') { _homeSave(); return; }
    if (action === 'home-reset') { _homeReset(); return; }
    if (action === 'home-pick') { custom.picker = { slot, query: '' }; _homeRender(); return; }
    if (action === 'home-pick-close') { custom.picker = null; _homeRender(); return; }
    if (action === 'home-remove') {
      custom.slots[slot] = { report_id: '', title: '', report_type: '' };
      if (custom.picker?.slot === slot) custom.picker = null;
      _homeRender();
      return;
    }
    if (action === 'home-move') {
      const area = custom.order.find(item => item.slot === slot)?.area;
      const order = custom.order.filter(item => item.area === area).map(item => item.slot);
      const other = order[order.indexOf(slot) + Number(button.dataset.step)];
      if (other === undefined) return;
      [custom.slots[slot], custom.slots[other]] = [custom.slots[other], custom.slots[slot]];
      custom.picker = null;
      _homeRender();
      return;
    }
    if (action === 'home-choose' && custom.picker) {
      const area = custom.order.find(item => item.slot === custom.picker.slot)?.area;
      const option = (_homeLayout()?.options?.[area] ?? []).find(item => item.report_id === button.dataset.id);
      if (!option) return;
      custom.slots[custom.picker.slot] = { report_id: option.report_id, title: option.title, report_type: option.report_type };
      custom.picker = null;
      _homeRender();
    }
  }, { signal });
}

async function _homeStartCustomise() {
  let response;
  showLoading();
  try { response = await ExpenseAPI.view(LAYOUT_VIEW, {}); }
  catch (error) { response = { ok: false, message: 'Home layout could not be loaded. Check your connection and try again.' }; }
  finally { hideLoading(); }
  if (response?.ok !== true) { showMsg(response?.message || ('Home layout could not be loaded: ' + (response?.error ?? 'invalid_response')), 'warn'); return; }
  state.views[LAYOUT_VIEW] = response;
  const slots = {};
  (response.data.slots ?? []).forEach(item => { slots[item.slot] = { report_id: item.report_id ?? '', title: item.title ?? '', report_type: item.report_type ?? '' }; });
  state.homeCustomise = { order: (response.data.slots ?? []).map(item => ({ slot: item.slot, area: item.area })), slots, picker: null, error: '' };
  _homeRender();
}

// default_slots ({ slot: report_id }) when the layout view offers it.
function _homeReset() {
  const custom = state.homeCustomise;
  const layout = _homeLayout();
  if (!custom || !layout?.default_slots) return;
  custom.order.forEach(({ slot, area }) => {
    const id = layout.default_slots[slot] ?? '';
    const option = (layout.options?.[area] ?? []).find(item => item.report_id === id);
    custom.slots[slot] = { report_id: id, title: option?.title ?? '', report_type: option?.report_type ?? '' };
  });
  custom.picker = null;
  showMsg('Default layout restored. Save to keep it.');
  _homeRender();
}

async function _homeSave() {
  const custom = state.homeCustomise;
  const body = { slots: {} };
  custom.order.forEach(({ slot }) => { body.slots[slot] = custom.slots[slot]?.report_id ?? ''; });
  let response;
  showLoading();
  try { response = await ExpenseAPI.updateDashboardLayout(body); }
  catch (error) { response = { ok: false, error: 'connection_error', message: 'The layout may not have been saved. Refresh and check Home.' }; }
  finally { hideLoading(); }
  if (state.homeCustomise !== custom) return;
  if (response?.ok !== true) {
    custom.error = response?.message || ('The layout was not saved: ' + (response?.error ?? 'invalid_response'));
    _homeRender();
    return;
  }
  state.homeCustomise = null;
  showMsg('Dashboard saved.');
  document.dispatchEvent(new CustomEvent('et:reload'));
}

// ── Loading ───────────────────────────────────────────────────────────────────

async function _homeLoad() {
  const seq = ++_homeSeq;
  let response;
  try { response = await ExpenseAPI.view(HOME_VIEW, {}); }
  catch (error) {
    if (seq !== _homeSeq) return;
    console.error('[home] view failed:', error?.message ?? 'error');
    _homeError = 'Home could not be loaded. Check your connection and refresh.';
    if (state.views?.[HOME_VIEW]?.ok !== true) _homeRender();
    return;
  }
  if (seq !== _homeSeq) return;
  if (response?.ok !== true) {
    console.warn('[home] view failed:', response?.error);
    _homeError = response?.message || ('Home could not be loaded: ' + (response?.error ?? 'invalid_response'));
    if (state.views?.[HOME_VIEW]?.ok !== true) _homeRender();
    return;
  }
  _homeError = '';
  state.views[HOME_VIEW] = response;
  _homeRender();
}

// Called by navigation, quote-currency changes and every reload: renders the
// last payload at once, then refreshes it from the server.
export function renderHome() {
  if (state.views === undefined || state.views === null) state.views = {};
  _homeRender();
  _homeLoad();
}
