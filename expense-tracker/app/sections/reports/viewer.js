// Report viewer: requests get_report for the open report (id + tab, controls and
// drill as the user picked them) and hands the published payload to the generic
// renderer. Drill modes (contract/report-payload.md): 'panel' requests the
// variant drill=<param>:<value> and shows its payload.drill under the report;
// 'replace' requests that variant as the report body (breadcrumbs lead back);
// 'query' opens Transactions with the query's params. Nothing is computed here.
import { el, esc, fmtAsOf, shareSnapshot } from '../../core/utils.js';
import { ExpenseAPI } from '../../core/api.js';
import { renderInsightPayload, renderInsightDrill } from './render-kinds.js';

const VIEWER_ACTION = 'get_report';

let _viewerSeq = 0;       // only the newest report request may render
let _viewerDrillSeq = 0;  // panel drills
let _viewerCharts = [];

// Reader / payload warnings → one line of text each.
export function reportWarningText(warning) {
  switch (warning?.code) {
    case 'not_published':         return 'Reports appear after the next refresh.';
    case 'variant_not_published': return 'This view appears after the next refresh.';
    case 'report_failed':         return `This report could not be computed (${warning.error_code || 'unknown error'}).`;
    case 'missing_rate':          return `No exchange rate for ${(warning.currencies ?? []).join(', ')} — affected amounts are left out.`;
    default:                      return String(warning?.code ?? '');
  }
}

export function reportWarningsHtml(warnings) {
  const lines = (warnings ?? []).map(reportWarningText).filter(text => text !== '');
  return lines.map(text => `<div class="insight-warn">${esc(text)}</div>`).join('');
}

// 'param:value' for a drill target ({ param: value }); the first key is the
// chart's own drill param (a series key added after it is not part of a
// published variant).
export function viewerDrillParam(target) {
  const entry = Object.entries(target ?? {})[0];
  return entry === undefined ? '' : `${entry[0]}:${entry[1]}`;
}

export function viewerParams(view, drill = view.drill) {
  const params = { id: view.id, ...(view.controls ?? {}) };
  if (view.period) params.period = view.period;
  if (view.tab) params.tab = view.tab;
  if (drill) params.drill = drill;
  return params;
}

function _viewerDestroy() {
  _viewerCharts.forEach(chart => { try { chart.destroy(); } catch (_) {} });
  _viewerCharts = [];
}

function _viewerHeadHtml(view, response) {
  const payload = response?.data?.payload ?? null;
  const period = payload?.period?.label ? `<span class="rpt-period">${esc(payload.period.label)}${payload.compare?.label ? ` · vs ${esc(payload.compare.label)}` : ''}</span>` : '';
  const asOf = fmtAsOf(response?.published_at);
  // Period choices come from list_reports_view (the catalogue entry's periods).
  const periods = view.periods ?? [];
  const picker = periods.length > 1
    ? `<select id="reportPeriodSelect" class="rpt-period-select" aria-label="Period">${periods.map(option =>
      `<option value="${esc(option.value)}"${option.value === (view.period || view.default_period) ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
    : '';
  return `
    <div class="rpt-viewer-head">
      <button type="button" class="btn btn-secondary btn-sm" data-action="rpt-viewer-back">← Reports</button>
      <button type="button" class="btn btn-secondary btn-sm" id="reportShareBtn" data-action="rpt-viewer-share">📤 Share</button>
    </div>
    <h3 class="rpt-viewer-title">${esc(payload?.title || view.title)}</h3>
    ${(payload?.description || view.description) ? `<p class="insight-description">${esc(payload?.description || view.description)}</p>` : ''}
    <div class="rpt-viewer-meta">${picker}${period}${asOf ? `<span class="rpt-asof">As of ${esc(asOf)}</span>` : ''}</div>`;
}

// Renders the open report (state.reportView) into container. ctx:
// { view, onBack(), onOpenTransactions(query) }.
export function renderViewer(container, ctx) {
  if (!container) return;
  _viewerDestroy();
  container.innerHTML = `<div id="reportViewerHead">${_viewerHeadHtml(ctx.view, null)}</div>
    <div id="reportViewerBody"><div class="insight-placeholder"><span class="spinner"></span>Loading…</div></div>`;
  _viewerAttach(container, ctx);
  _viewerLoad(ctx);
}

function _viewerAttach(container, ctx) {
  if (container._viewerAbort) container._viewerAbort.abort();
  const abort = new AbortController();
  container._viewerAbort = abort;
  container.addEventListener('click', e => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'rpt-viewer-back') { _viewerDestroy(); _viewerSeq++; ctx.onBack?.(); }
    if (button.dataset.action === 'rpt-viewer-share') { const body = el('reportsContent'); if (body) shareSnapshot(body, 'report.png'); }
  }, { signal: abort.signal });
}

function _viewerHandlers(ctx) {
  const view = ctx.view;
  const reload = () => _viewerLoad(ctx);
  return {
    onTab: key => { view.tab = key; view.drill = ''; reload(); },
    onControl: (param, value) => { view.controls = { ...(view.controls ?? {}), [param]: value }; view.drill = ''; reload(); },
    onCrumb: drill => { view.drill = viewerDrillParam(drill); reload(); },
    onDrill: (target, mode, query) => {
      if (mode === 'query') { if (query) ctx.onOpenTransactions?.(query); return; }
      const drill = viewerDrillParam(target);
      if (mode === 'replace') { view.drill = drill; reload(); return; }
      _viewerLoadPanel(ctx, drill);
    },
    onDrillClose: () => {},
    onOpenTransactions: query => ctx.onOpenTransactions?.(query),
  };
}

async function _viewerLoad(ctx) {
  const seq = ++_viewerSeq;
  const view = ctx.view;
  let response;
  try { response = await ExpenseAPI.view(VIEWER_ACTION, viewerParams(view)); }
  catch (error) {
    if (seq !== _viewerSeq) return;
    console.error('[reports] get_report failed:', error?.message ?? 'error');
    const body = el('reportViewerBody');
    if (body) body.innerHTML = '<div class="insight-placeholder">This report could not be loaded. Check your connection and try again.</div>';
    return;
  }
  if (seq !== _viewerSeq) return;
  const head = el('reportViewerHead');
  const body = el('reportViewerBody');
  if (!body) return;
  if (response?.ok !== true) {
    console.warn('[reports] get_report refused:', response?.error);
    // A drill the new choices no longer offer is dropped and the report retried once.
    if (response?.error === 'invalid_drill' && view.drill) { view.drill = ''; _viewerLoad(ctx); return; }
    body.innerHTML = `<div class="insight-placeholder">${esc(response?.message || ('This report could not be loaded: ' + (response?.error ?? 'invalid_response')))}</div>`;
    return;
  }
  if (head) {
    head.innerHTML = _viewerHeadHtml(view, response);
    const select = el('reportPeriodSelect');
    if (select) select.addEventListener('change', () => { view.period = select.value; view.drill = ''; _viewerLoad(ctx); });
  }
  _viewerDestroy();
  const payload = response.data?.payload ?? null;
  body.innerHTML = `${reportWarningsHtml(response.warnings)}<div id="reportViewerChart"></div>`;
  if (payload === null) return;
  _viewerCharts = renderInsightPayload(el('reportViewerChart'), payload, response.quote?.symbol ?? '', _viewerHandlers(ctx));
}

async function _viewerLoadPanel(ctx, drill) {
  const seq = ++_viewerDrillSeq;
  const reportSeq = _viewerSeq;
  let response;
  try { response = await ExpenseAPI.view(VIEWER_ACTION, viewerParams(ctx.view, drill)); }
  catch (error) { console.error('[reports] drill failed:', error?.message ?? 'error'); return; }
  if (seq !== _viewerDrillSeq || reportSeq !== _viewerSeq) return;
  const container = el('reportViewerChart');
  if (!container) return;
  const payload = response?.ok === true ? response.data?.payload ?? null : null;
  if (payload === null) {
    const slot = container.querySelector?.('[data-role="report-drill"]');
    const text = response?.ok === true ? reportWarningsHtml(response.warnings) : `<div class="insight-warn">${esc(response?.message || 'This detail could not be loaded.')}</div>`;
    if (slot) slot.innerHTML = text;
    return;
  }
  _viewerCharts.push(...(renderInsightDrill(container, payload, response.quote?.symbol ?? '', _viewerHandlers(ctx)) ?? []));
}
