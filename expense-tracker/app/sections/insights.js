import { state } from '../core/state.js';
import { el, esc, shareSnapshot } from '../core/utils.js';
import { ExpenseAPI } from '../core/api.js';
import { renderInsightPayload, renderInsightDrill } from './insights/render-kinds.js';

// The registry (titles, groups, periods, tabs) comes from get_app_context
// nav.insights_registry (api/insights-registry.gs). Every insight is computed
// by the server: the shell turns controls into get_insight params and hands
// the payload to render-kinds.js. Nothing is computed in the browser.

let _renderId   = 0;    // incremented on every render; stale async continuations bail out
let _drillSeq   = 0;    // panel-drill requests
let _shellAbort = null; // aborts previous shell event listeners before re-attaching
let _charts     = [];   // Chart.js instances created by render-kinds

function _registry() {
  const list = state.context?.nav?.insights_registry;
  return Array.isArray(list) ? list : [];
}

function _activeEntry() {
  const registry = _registry();
  return registry.find(entry => entry.id === state.insightId) ?? registry[0] ?? null;
}

// Snap persisted UI state to what the active insight offers.
function _snapState(entry) {
  if (entry.id !== state.insightId) state.insightId = entry.id;
  const periods = (entry.periods ?? []).map(p => p.value);
  if (periods.length > 0 && !periods.includes(state.insightPeriod)) {
    state.insightPeriod = periods.includes(entry.default_period) ? entry.default_period : periods[0];
  }
  const tabs = (entry.tabs ?? []).map(t => t.key);
  if (tabs.length > 0 && !tabs.includes(state.insightTab)) state.insightTab = tabs[0];
}

function _resetInsightView() {
  state.insightDrill = null;
  state.insightParams = {};
}

export function renderInsights() {
  _destroyCharts();
  _applyChartDefaults();

  const container = el('insightContent');
  const entry = _activeEntry();
  if (entry === null) {
    container.innerHTML = '<div class="insight-placeholder">Insights are not available yet. Refresh to load them.</div>';
    return;
  }
  _snapState(entry);
  container.innerHTML = _buildShellHtml(entry);
  _attachShellEvents();
  _renderActiveInsight();
}

// ── Shell HTML ─────────────────────────────────────────────────────────────────

function _buildShellHtml(entry) {
  const groupMap = new Map();
  _registry().forEach(d => {
    if (!groupMap.has(d.group)) groupMap.set(d.group, []);
    groupMap.get(d.group).push(d);
  });
  const selectorHtml = [...groupMap.entries()].map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map(d =>
      `<option value="${esc(d.id)}"${d.id === entry.id ? ' selected' : ''}>${esc(d.title ?? d.label)}</option>`
    ).join('')}</optgroup>`
  ).join('');

  const periods = entry.periods ?? [];
  const periodHtml = periods.map(p =>
    `<option value="${esc(p.value)}"${p.value === state.insightPeriod ? ' selected' : ''}>${esc(p.label)}</option>`
  ).join('');
  const hidePeriod = periods.length === 0;
  const customHidden = (hidePeriod || state.insightPeriod !== 'custom') ? ' hidden' : '';

  const tabs = entry.tabs ?? [];
  const tabStrip = tabs.length > 0
    ? `<div class="insight-tabs">${tabs.map(tab =>
      `<button class="insight-tab${state.insightTab === tab.key ? ' active' : ''}" data-action="insight-tab" data-tab="${esc(tab.key)}">${esc(tab.label)}</button>`
    ).join('')}</div>`
    : '';

  return `
    <div class="insight-controls">
      <div class="insight-top-row">
        <select class="insight-selector" id="insightSelector">${selectorHtml}</select>
        ${hidePeriod ? '' : `<select class="insight-period-select" id="insightPeriodSelect">${periodHtml}</select>`}
      </div>
      <div class="insight-custom-dates${customHidden}" id="insightCustomDates">
        <input type="date" id="insightCustomFrom" value="${esc(state.insightCustomFrom)}">
        <span class="insight-custom-sep">–</span>
        <input type="date" id="insightCustomTo" value="${esc(state.insightCustomTo)}">
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        ${entry.description ? `<p class="insight-description" style="margin:0;flex:1">${esc(entry.description)}</p>` : '<div style="flex:1"></div>'}
        <button class="btn btn-secondary btn-sm" id="insightShareBtn" data-action="snapshot" style="flex-shrink:0">📤 Share</button>
      </div>
      ${tabStrip}
    </div>
    <div id="insightInner"></div>`;
}

// ── Events ─────────────────────────────────────────────────────────────────────

function _attachShellEvents() {
  if (_shellAbort) _shellAbort.abort();
  _shellAbort = new AbortController();
  const { signal } = _shellAbort;
  const container = el('insightContent');

  container.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'insightSelector') {
      state.insightId = e.target.value;
      state.insightTab = 'transactions';
      _resetInsightView();
      renderInsights();
      return;
    }
    if (id === 'insightPeriodSelect') {
      state.insightPeriod = e.target.value;
      state.insightDrill = null;
      const customDates = el('insightCustomDates');
      if (customDates) customDates.classList.toggle('hidden', state.insightPeriod !== 'custom');
      if (state.insightPeriod !== 'custom') _renderActiveInsight();
      return;
    }
    if (id === 'insightCustomFrom' || id === 'insightCustomTo') {
      if (id === 'insightCustomFrom') state.insightCustomFrom = e.target.value;
      else state.insightCustomTo = e.target.value;
      state.insightDrill = null;
      if (state.insightCustomFrom && state.insightCustomTo) _renderActiveInsight();
    }
  }, { signal });

  container.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action } = btn.dataset;

    if (action === 'insight-tab') {
      state.insightTab = btn.dataset.tab;
      _resetInsightView();
      _destroyCharts();
      container.querySelectorAll('.insight-tab[data-action="insight-tab"]').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === state.insightTab)
      );
      _renderActiveInsight();
      return;
    }
    if (action === 'go-rates') {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'rates' }));
      return;
    }
    if (action === 'snapshot') {
      const target = el('insightContent');
      if (target) shareSnapshot(target, `insight-${state.insightId}.png`);
    }
  }, { signal });
}

// ── get_insight params (UI state → request) ───────────────────────────────────

function _insightParams(entry, drill) {
  const params = { id: entry.id, ...(state.insightParams ?? {}) };
  if ((entry.periods ?? []).length > 0) {
    params.period = state.insightPeriod;
    if (state.insightPeriod === 'custom') { params.from = state.insightCustomFrom; params.to = state.insightCustomTo; }
  }
  if ((entry.tabs ?? []).length > 0) params.tab = state.insightTab;
  if (drill) params.drill = drill;
  return params;
}

function _rateWarnHtml(currencies) {
  if (!currencies.length) return '';
  return `<div class="insight-warn">⚠ No exchange rate for <strong>${esc(currencies.join(', '))}</strong> — affected transactions excluded from totals. <a href="#" data-action="go-rates">Add rates →</a></div>`;
}

function _missingFromWarnings(response) {
  const warning = (response?.warnings ?? []).find(w => w?.code === 'missing_rate');
  return Array.isArray(warning?.currencies) ? warning.currencies : [];
}

// ── Render active insight ─────────────────────────────────────────────────────

async function _renderActiveInsight() {
  const inner = el('insightInner');
  if (!inner) return;
  const myId = ++_renderId;
  _destroyCharts();
  inner.innerHTML = '<div class="insight-placeholder"><span class="spinner"></span>Loading…</div>';

  const entry = _activeEntry();
  if (entry === null) return;
  await _renderServer(entry, inner, myId);
}

function _handlers(entry) {
  return {
    onDrill: (drill, mode) => {
      state.insightDrill = drill;
      if (mode === 'replace') _renderActiveInsight();
      else _loadDrillPanel(entry, drill);
    },
    onDrillClose: () => { state.insightDrill = null; },  // render-kinds destroys the panel charts
    onControl: (param, value) => {
      state.insightParams = { ...(state.insightParams ?? {}), [param]: value };
      state.insightDrill = null;
      _renderActiveInsight();
    },
    onSort: col => {
      const params = state.insightParams ?? {};
      const dir = params.sort === col && params.sort_dir !== 'asc' ? 'asc' : 'desc';
      state.insightParams = { ...params, sort: col, sort_dir: dir };
      _renderActiveInsight();
    },
    onCrumb: drill => {
      state.insightDrill = drill;
      _renderActiveInsight();
    },
    onOpenTransactions: query => {
      state.filters = { ...(query?.params ?? {}) };
      document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'transactions' }));
    },
  };
}

async function _renderServer(entry, inner, myId) {
  let response;
  try { response = await ExpenseAPI.view('get_insight', _insightParams(entry, state.insightDrill)); }
  catch (error) {
    if (myId !== _renderId) return;
    console.error('[insights] get_insight failed:', error);
    inner.innerHTML = '<div class="insight-placeholder">This insight could not be loaded. Check your connection and try again.</div>';
    return;
  }
  if (myId !== _renderId) return;
  if (response?.ok !== true) {
    console.warn('[insights] get_insight refused:', response?.error);
    // A stale drill (e.g. a date outside a new period) is dropped and retried once.
    if (response?.error === 'invalid_drill' && state.insightDrill) { state.insightDrill = null; _renderActiveInsight(); return; }
    inner.innerHTML = `<div class="insight-placeholder">${esc(response?.message || ('This insight could not be loaded: ' + (response?.error ?? 'invalid_response')))}</div>`;
    return;
  }
  inner.innerHTML = `${_rateWarnHtml(_missingFromWarnings(response))}<div id="insightChart"></div>`;
  _charts = renderInsightPayload(el('insightChart'), response.data, response.quote?.symbol ?? '', _handlers(entry));
  _appendComputedAt(inner, response.computed_at);
}

async function _loadDrillPanel(entry, drill) {
  const seq = ++_drillSeq;
  const myId = _renderId;
  let response;
  try { response = await ExpenseAPI.view('get_insight', _insightParams(entry, drill)); }
  catch (error) { console.error('[insights] drill failed:', error); return; }
  if (seq !== _drillSeq || myId !== _renderId) return;
  if (response?.ok !== true) { console.warn('[insights] drill refused:', response?.error); return; }
  // render-kinds destroys the previous panel charts; keep the new ones for _destroyCharts.
  _charts.push(...(renderInsightDrill(el('insightChart'), response.data, response.quote?.symbol ?? '', _handlers(entry)) ?? []));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fmtAge(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins <  1)  return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _appendComputedAt(inner, isoStr) {
  const div = document.createElement('div');
  div.className = 'insight-meta';
  div.innerHTML = `<span class="insight-meta-dot insight-meta-live"></span>${esc(`Updated ${_fmtAge(isoStr)}`)}`;
  inner.appendChild(div);
}

function _destroyCharts() {
  _charts.forEach(chart => { try { chart.destroy(); } catch (_) {} });
  _charts = [];
}

function _applyChartDefaults() {
  if (!window.Chart) return;
  const s = getComputedStyle(document.documentElement);
  window.Chart.defaults.font.family = s.getPropertyValue('--grotesk').trim() || 'inherit';
  window.Chart.defaults.font.size   = 12;
  window.Chart.defaults.color       = s.getPropertyValue('--ink').trim();
}
