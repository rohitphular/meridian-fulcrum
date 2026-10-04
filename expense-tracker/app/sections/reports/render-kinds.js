/* global Chart */
// Generic renderer for published report payloads (data-synchronization/analytics/
// contract/report-payload.md, returned by get_report / get_home_view).
// Renders tabs, controls, breadcrumbs, stat cards, charts (line / area / bar /
// hbar / stacked / stacked_hbar / mixed / donut / pie / gauge / waterfall + reference
// lines), tables, notes and the drill panel. Chart.js configuration and display
// formatting only: every number, label, tone and drill value comes from the
// server (money already converted by GAS); Text with values is filled here.
import { esc } from '../../core/utils.js';
import {
  getCssColors, baseChartOptions, buildPalette, toneColor, styleColor,
  fmtValue, fmtText, fmtTick,
} from './chart-theme.js';

// ── HTML pieces ───────────────────────────────────────────────────────────────

function _toneClass(tone) {
  return tone === 'positive' || tone === 'negative' ? tone : '';
}

function _statCardsHtml(cards, sym) {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  return `<div class="stat-cards">${cards.map(card => `
    <div class="stat-card">
      <p class="stat-card-label">${esc(card.label)}</p>
      <p class="stat-card-value ${esc(_toneClass(card.tone))}">${esc(fmtValue(card.value, card.format, sym))}</p>
      ${card.sub ? `<p class="stat-card-sub">${esc(fmtText(card.sub, sym))}</p>` : ''}
    </div>`).join('')}</div>`;
}

function _tabsHtml(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return '';
  return `<div class="insight-tabs" style="margin-bottom:12px">${tabs.map(tab =>
    `<button class="insight-tab${tab.active ? ' active' : ''}" data-action="report-tab" data-tab="${esc(tab.key)}">${esc(tab.label)}</button>`
  ).join('')}</div>`;
}

function _controlsHtml(controls) {
  if (!Array.isArray(controls) || controls.length === 0) return '';
  return controls.map(control => `
    <div class="insight-tabs" style="margin-bottom:12px">
      ${control.label ? `<span style="font-size:var(--text-xs);color:var(--muted);align-self:center">${esc(control.label)}</span>` : ''}
      ${(control.options ?? []).map(option => `<button class="insight-tab${String(option.value) === String(control.value) ? ' active' : ''}"
        data-action="report-control" data-param="${esc(control.param)}" data-value="${esc(String(option.value))}">${esc(option.label)}</button>`).join('')}
    </div>`).join('');
}

function _breadcrumbsHtml(crumbs) {
  if (!Array.isArray(crumbs) || crumbs.length < 2) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px;font-size:var(--text-sm)">${crumbs.map((crumb, index) => {
    const last = index === crumbs.length - 1;
    const item = last
      ? `<strong>${esc(crumb.label)}</strong>`
      : `<button class="btn btn-secondary btn-sm" data-action="report-crumb" data-index="${index}">${esc(crumb.label)}</button>`;
    return item + (last ? '' : '<span style="color:var(--muted)">›</span>');
  }).join('')}</div>`;
}

// One table cell. Text with values is filled; 'local' amounts use the row's
// own currency cell when the row has one.
function _cellHtml(value, column, sym, rowTone, cells) {
  if (column.format === 'progress' && (typeof value === 'number' || value === null || value === undefined)) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    return `<td class="drill-td" style="min-width:90px"><div style="display:flex;align-items:center;gap:6px">
      <div style="flex:1;height:6px;background:var(--hair);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--teal)"></div></div>
      <span style="font-size:var(--text-xs);color:var(--muted)">${esc(fmtValue(value, 'progress', sym))}</span></div></td>`;
  }
  const currency = typeof cells?.currency === 'string' ? cells.currency : '';
  const text = value !== null && typeof value === 'object' ? fmtText(value, sym) : fmtValue(value, column.format, sym, currency);
  const numeric = typeof value === 'number' && String(column.format ?? '').startsWith('money');
  const cls = numeric && rowTone ? _toneClass(rowTone) : '';
  const align = column.align ?? (numeric ? 'right' : 'left');
  return `<td class="drill-td ${esc(cls)}" style="text-align:${esc(align)}">${esc(text)}</td>`;
}

function _sectionTitle(text, sym) {
  return text ? `<p style="font-size:var(--text-xs);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px">${esc(fmtText(text, sym))}</p>` : '';
}

function _tableHtml(table, tableIndex, sym) {
  const columns = table.columns ?? [];
  const head = columns.map(column => `<th class="drill-th" style="text-align:${esc(column.align ?? 'left')}">${esc(column.label)}</th>`).join('');
  const rows = (table.rows ?? []).map((row, rowIndex) => {
    const drillAttrs = row.drill && tableIndex >= 0 ? ` data-action="report-row-drill" data-table="${tableIndex}" data-row="${rowIndex}" style="cursor:pointer"` : '';
    return `<tr class="drill-row"${drillAttrs}>${columns.map(column => _cellHtml(row.cells?.[column.key], column, sym, row.tone, row.cells)).join('')}</tr>`;
  }).join('');
  const total = table.total_row
    ? `<tr class="drill-row" style="font-weight:600">${columns.map(column => _cellHtml(table.total_row.cells?.[column.key], column, sym, null, table.total_row.cells)).join('')}</tr>`
    : '';
  return `
    ${_sectionTitle(table.title, sym)}
    <div class="drill-table-wrap">
      <table class="drill-table">
        <thead><tr class="drill-thead-row">${head}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${columns.length || 1}" class="drill-empty">${esc(fmtText(table.empty_text ?? 'Nothing to show', sym))}</td></tr>`}${total}</tbody>
      </table>
    </div>`;
}

// compact (Home panels): no drill hints, a fixed height, no click-through.
function _chartHtml(chart, index, sym, attr = 'data-chart-index', compact = false) {
  if (chart.empty_text && !(chart.labels ?? []).length && chart.kind !== 'gauge') {
    return `<div class="chart-wrap"><p class="chart-empty">${esc(fmtText(chart.empty_text, sym))}</p></div>`;
  }
  const fixed = Number.isFinite(chart.height) ? chart.height : (chart.kind === 'gauge' ? 180 : null);
  const height = compact ? (chart.kind === 'gauge' ? 160 : 190) : fixed;
  const style = height ? ` style="height:${height}px;position:relative"` : ' style="position:relative"';
  const gauge = chart.kind === 'gauge' && chart.gauge ? `
    <div style="position:absolute;left:50%;bottom:14%;transform:translateX(-50%);text-align:center;pointer-events:none">
      <div style="font-size:var(--text-xl);font-weight:700" data-role="gauge-label">${esc(fmtText(chart.gauge.label ?? '', sym))}</div>
      ${chart.gauge.sub ? `<div style="font-size:var(--text-sm);color:var(--muted)">${esc(fmtText(chart.gauge.sub, sym))}</div>` : ''}
    </div>` : '';
  const hints = compact ? '' : `
    ${chart.drill?.hint ? `<p style="font-size:var(--text-xs);color:var(--muted);margin:4px 0 0;text-align:center">${esc(fmtText(chart.drill.hint, sym))}</p>` : ''}
    ${chart.drill?.null_text ? `<p class="hidden" data-role="chart-drill-note" style="font-size:var(--text-xs);color:var(--muted);margin:4px 0 0;text-align:center"><em>${esc(fmtText(chart.drill.null_text, sym))}</em></p>` : ''}`;
  return `
    ${compact ? '' : _sectionTitle(chart.title, sym)}
    <div class="chart-wrap">
      <div class="chart-container"${style}><canvas ${attr}="${index}"></canvas>${gauge}</div>
    </div>${hints}`;
}

function _notesHtml(notes, sym) {
  if (!Array.isArray(notes) || notes.length === 0) return '';
  return notes.map(note => `<p class="report-note" style="color:${note?.tone === 'warn' ? 'var(--ember)' : 'var(--muted)'}"><em>${esc(fmtText(note, sym))}</em></p>`).join('');
}

function _emptyHtml(empty, sym) {
  return `<div class="chart-wrap"><p class="chart-empty">${esc(fmtText(empty?.text ?? empty, sym))}</p></div>`;
}

// ── Drill panel ───────────────────────────────────────────────────────────────

// Drill = { title, subtitle?, charts?, table?, query? } (Text in title / subtitle).
export function drillPanelHtml(drill, sym) {
  if (!drill) return '';
  const open = drill.query ? `<button class="btn btn-secondary btn-sm" data-action="report-open-transactions">Open in Transactions</button>` : '';
  const note = drill.query?.note ? `<p class="report-note"><em>${esc(fmtText(drill.query.note, sym))}</em></p>` : '';
  return `
    <div class="report-drill-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(fmtText(drill.title ?? '', sym))}</h3>
        <div style="display:flex;gap:8px;align-items:center;font-size:var(--text-xs);color:var(--muted)">
          <span>${esc(fmtText(drill.subtitle ?? '', sym))}</span>
          ${open}
          <button data-action="report-drill-close" aria-label="Close detail" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
        </div>
      </div>
      ${(drill.charts ?? []).map((chart, index) => _chartHtml(chart, index, sym, 'data-drill-chart-index')).join('')}
      ${drill.table ? _tableHtml(drill.table, -1, sym) : ''}
      ${note}
    </div>`;
}

// ── Chart.js configs ──────────────────────────────────────────────────────────

function _alpha(color, hex) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color + hex : color;
}

function _pointColors(dataset, C, fallback) {
  if (Array.isArray(dataset.point_tones)) return dataset.point_tones.map(tone => (tone === 'primary' ? _alpha(C.teal, 'cc') : toneColor(tone, C)));
  if (dataset.style === 'palette') return (dataset.data ?? []).map((_, i) => styleColor('palette', C, i));
  return fallback;
}

function _lineDataset(dataset, C, index, count) {
  const color = styleColor(dataset.style, C, index);
  let fill = false;
  if (dataset.fill === 'origin') fill = { target: 'origin', above: _alpha(color, '18'), below: _alpha(color, '18') };
  if (dataset.fill === 'signed') fill = { target: 'origin', above: 'rgba(96,165,250,0.15)', below: 'rgba(248,113,113,0.18)' };
  return {
    type: 'line', label: dataset.label, data: dataset.data, borderColor: color, backgroundColor: _alpha(color, '18'),
    borderWidth: 2, fill, tension: 0.3, pointRadius: count > 60 ? 0 : 3, pointHoverRadius: 5, spanGaps: false,
    borderDash: dataset.dashed ? [4, 4] : undefined, hidden: dataset.hidden === true, yAxisID: dataset.axis === 'y2' ? 'y2' : 'y',
  };
}

function _barDataset(dataset, C, index) {
  const color = styleColor(dataset.style, C, index);
  const colors = _pointColors(dataset, C, color);
  const hover = Array.isArray(dataset.point_tones) ? dataset.point_tones.map(tone => (tone === 'muted' ? C.muted : toneColor(tone, C))) : colors;
  return {
    type: 'bar', label: dataset.label, data: dataset.data, backgroundColor: colors, hoverBackgroundColor: hover,
    borderRadius: 4, borderSkipped: false, hidden: dataset.hidden === true, yAxisID: dataset.axis === 'y2' ? 'y2' : 'y',
  };
}

function _refLineDatasets(chart, C) {
  return (chart.ref_lines ?? []).map(line => ({
    type: 'line', label: line.label, data: (chart.labels ?? []).map(() => line.value),
    borderColor: toneColor(line.tone, C), borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false,
    yAxisID: line.axis === 'y2' ? 'y2' : 'y',
  }));
}

function _y2Scale(chart, base, sym) {
  if (!(chart.datasets ?? []).some(d => d.axis === 'y2') && !(chart.ref_lines ?? []).some(l => l.axis === 'y2')) return {};
  const format = chart.y2_format ?? 'percent';
  return { y2: { ...base.scales.y, position: 'right', grid: { drawOnChartArea: false }, ticks: { ...base.scales.y.ticks, callback: v => fmtTick(v, format, sym) } } };
}

// Shows / hides the chart's server-given note for a point without a drill
// target (e.g. an 'Other' segment that merges several values).
function _toggleDrillNote(instance, show) {
  const note = instance?.canvas?.closest?.('.chart-wrap')?.nextElementSibling;
  const target = note?.dataset?.role === 'chart-drill-note' ? note
    : note?.nextElementSibling?.dataset?.role === 'chart-drill-note' ? note.nextElementSibling : null;
  target?.classList?.toggle('hidden', !show);
}

// Click → onDrill({ [drill.param]: values[i] }, mode, query). mode 'panel' /
// 'replace' name a published variant; mode 'query' carries queries[i] (opens
// Transactions; null = not drillable). With drill.series_param the clicked
// line's dataset key is added after the primary param; reference lines (after
// the server datasets) never drill.
function _drillClick(chart, onDrill) {
  const drill = chart.drill;
  if (!drill || typeof onDrill !== 'function') return undefined;
  const datasets = chart.datasets ?? [];
  const mode = drill.mode ?? 'panel';
  return (evt, elements, instance) => {
    const onSeries = drill.series_param && typeof instance?.getElementsAtEventForMode === 'function'
      ? instance.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false) : [];
    const hit = onSeries[0] ?? elements[0];
    if (hit === undefined) return;
    const value = (drill.values ?? [])[hit.index];
    const query = mode === 'query' ? (drill.queries ?? [])[hit.index] ?? null : null;
    if (value === undefined || value === null || value === '' || (mode === 'query' && query === null)) { _toggleDrillNote(instance, true); return; }
    _toggleDrillNote(instance, false);
    const params = { [drill.param]: value };
    if (drill.series_param && onSeries.length > 0) {
      const key = hit.datasetIndex < datasets.length ? datasets[hit.datasetIndex]?.key : undefined;
      if (key !== undefined && key !== null && key !== '') params[drill.series_param] = key;
    }
    onDrill(params, mode, query);
  };
}

// Chart.js config for one server chart spec.
export function chartConfig(chart, sym, C, onDrill) {
  const format = chart.y_format ?? 'money';
  const base = baseChartOptions(sym, C, format);
  const datasets = chart.datasets ?? [];
  const multi = datasets.length > 1;
  const onClick = _drillClick(chart, onDrill);
  const legend = { ...base.plugins.legend, display: multi };
  const withY = extra => ({ ...base.scales.y, ...(chart.y_min !== undefined ? { min: chart.y_min } : {}), ...(chart.y_max !== undefined ? { max: chart.y_max } : {}), ...extra });

  switch (chart.kind) {
    case 'donut':
    case 'pie': {
      const dataset = datasets[0] ?? { data: [] };
      const palette = buildPalette(C);
      return {
        type: chart.kind === 'pie' ? 'pie' : 'doughnut',
        data: { labels: chart.labels, datasets: [{ label: dataset.label, data: dataset.data, borderWidth: 0,
          backgroundColor: Array.isArray(dataset.point_tones) ? dataset.point_tones.map(t => toneColor(t, C)) : (dataset.data ?? []).map((_, i) => palette[i % palette.length]) }] },
        options: {
          responsive: true, maintainAspectRatio: false, onClick,
          plugins: { legend: { position: 'bottom', labels: { color: C.ink, boxWidth: 12, padding: 10 } },
            tooltip: { callbacks: { label: ctx => `  ${ctx.label}: ${fmtValue(ctx.parsed, format, sym)}` } } },
        },
      };
    }
    case 'gauge': {
      const gauge = chart.gauge ?? { value: 0, max: 100 };
      const max = Number.isFinite(gauge.max) ? gauge.max : 100;
      const value = Math.max(0, Math.min(Number(gauge.value) || 0, max));
      return {
        type: 'doughnut',
        data: { datasets: [{ data: [value, max - value], backgroundColor: [toneColor(gauge.tone ?? 'primary', C), C.hair], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, rotation: -90, circumference: 180, cutout: '75%',
          plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      };
    }
    case 'waterfall': {
      const dataset = datasets[0] ?? { data: [] };
      return {
        type: 'bar',
        data: { labels: chart.labels, datasets: [{ label: dataset.label, data: dataset.data, borderRadius: 4, borderSkipped: false,
          backgroundColor: _pointColors(dataset, C, styleColor(dataset.style, C)) }] },
        options: {
          ...base, onClick,
          plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: {
            label: ctx => { const raw = Array.isArray(ctx.raw) ? ctx.raw[1] - ctx.raw[0] : ctx.raw; return `  ${fmtValue(raw, format, sym)}`; } } } },
          scales: { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 0, font: { size: 12 } } }, y: withY({}) },
        },
      };
    }
    case 'hbar':
    case 'stacked_hbar': {
      const stacked = chart.kind === 'stacked_hbar';
      return {
        type: 'bar',
        data: { labels: chart.labels, datasets: datasets.map((d, i) => _barDataset(d, C, i)) },
        options: {
          ...base, indexAxis: 'y', onClick,
          plugins: { ...base.plugins, legend },
          scales: {
            x: { ...base.scales.y, stacked, ...(chart.y_min !== undefined ? { min: chart.y_min } : {}), ...(chart.y_max !== undefined ? { max: chart.y_max } : {}) },
            y: { stacked, ticks: { color: C.muted, font: { size: 12 } }, grid: { color: C.hair }, border: { display: false } },
          },
        },
      };
    }
    default: {
      // line / area / bar / stacked / mixed
      const count = (chart.labels ?? []).length;
      const lineKinds = chart.kind === 'line' || chart.kind === 'area';
      const built = datasets.map((d, i) => {
        const asLine = chart.kind === 'mixed' ? d.kind === 'line' : lineKinds;
        const spec = asLine ? _lineDataset(chart.kind === 'area' && d.fill === undefined ? { ...d, fill: 'origin' } : d, C, i, count) : _barDataset(d, C, i);
        return chart.kind === 'stacked' ? { ...spec, stack: 'stack' } : spec;
      });
      const stacked = chart.kind === 'stacked';
      return {
        type: lineKinds ? 'line' : 'bar',
        data: { labels: chart.labels, datasets: [...built, ..._refLineDatasets(chart, C)] },
        options: {
          ...base, onClick,
          interaction: onClick ? { mode: 'index', intersect: chart.kind === 'bar' } : base.interaction,
          plugins: { ...base.plugins, legend: { ...legend, display: multi || (chart.ref_lines ?? []).length > 0 } },
          scales: {
            ...base.scales,
            x: { ...base.scales.x, stacked, ticks: { ...base.scales.x.ticks, maxTicksLimit: count > 31 ? 8 : 15 } },
            y: withY({ stacked }),
            ..._y2Scale(chart, base, sym),
          },
        },
      };
    }
  }
}

// ── Public render ─────────────────────────────────────────────────────────────

// Renders a report payload into container. handlers:
// { onDrill(params, mode, query), onTab(key), onControl(param, value), onCrumb(drill|null),
//   onDrillClose(), onOpenTransactions(query) }. Returns the Chart.js instances created.
export function renderInsightPayload(container, data, sym, handlers = {}) {
  if (!container || !data) return [];
  if (data.empty) {
    container.innerHTML = `${_tabsHtml(data.tabs)}${_breadcrumbsHtml(data.breadcrumbs)}${_controlsHtml(data.controls)}${_emptyHtml(data.empty, sym)}`;
    _attachPayloadEvents(container, data, handlers);
    return [];
  }
  const charts = data.charts ?? [];
  container.innerHTML = `
    ${_tabsHtml(data.tabs)}
    ${_breadcrumbsHtml(data.breadcrumbs)}
    ${_controlsHtml(data.controls)}
    ${_statCardsHtml(data.stat_cards, sym)}
    ${charts.map((chart, index) => _chartHtml(chart, index, sym)).join('')}
    ${(data.tables ?? []).map((table, index) => _tableHtml(table, index, sym)).join('')}
    ${_notesHtml(data.notes, sym)}
    <div data-role="report-drill">${drillPanelHtml(data.drill, sym)}</div>`;
  _attachPayloadEvents(container, data, handlers);

  const instances = _buildCharts(container, 'data-chart-index', charts, sym, handlers.onDrill);
  _drillInstances.set(container, _buildCharts(container, 'data-drill-chart-index', data.drill?.charts ?? [], sym, handlers.onDrill));
  return [...instances, ..._drillInstances.get(container)];
}

// A Home panel: the payload's charts (or, without charts, its tables) at a fixed
// height; no tabs, controls, drills or click-through. Returns the Chart.js instances.
export function renderCompactPayload(container, data, sym) {
  if (!container || !data) return [];
  const charts = data.charts ?? [];
  if (data.empty) container.innerHTML = _emptyHtml(data.empty, sym);
  else if (charts.length > 0) container.innerHTML = charts.map((chart, index) => _chartHtml(chart, index, sym, 'data-chart-index', true)).join('');
  else if ((data.tables ?? []).length > 0) container.innerHTML = (data.tables ?? []).map(table => _tableHtml(table, -1, sym)).join('');
  else container.innerHTML = `${_statCardsHtml(data.stat_cards, sym)}${_notesHtml(data.notes, sym)}`;
  return data.empty ? [] : _buildCharts(container, 'data-chart-index', charts, sym, undefined);
}

// Instantiates the canvases carrying attr (chart index) inside root.
function _buildCharts(root, attr, charts, sym, onDrill) {
  if (typeof Chart === 'undefined' || !charts.length) return [];
  const C = getCssColors();
  const instances = [];
  root.querySelectorAll(`canvas[${attr}]`).forEach(canvas => {
    const chart = charts[Number(canvas.dataset[attr === 'data-chart-index' ? 'chartIndex' : 'drillChartIndex'])];
    if (!chart) return;
    if (chart.kind === 'gauge') {
      const label = canvas.parentElement?.querySelector('[data-role="gauge-label"]');
      if (label) label.style.color = toneColor(chart.gauge?.tone ?? 'primary', C);
    }
    instances.push(new Chart(canvas, chartConfig(chart, sym, C, onDrill)));
  });
  return instances;
}

function _destroyDrillCharts(container) {
  (_drillInstances.get(container) ?? []).forEach(chart => { try { chart.destroy(); } catch (_) {} });
  _drillInstances.set(container, []);
}

// Replaces only the drill panel (drill mode 'panel') with data.drill (the
// variant's payload); returns the drill-panel Chart.js instances (the previous
// ones are destroyed here).
export function renderInsightDrill(container, data, sym, handlers = {}) {
  const slot = container?.querySelector('[data-role="report-drill"]');
  if (!slot) return [];
  _destroyDrillCharts(container);
  slot.innerHTML = drillPanelHtml(data?.drill, sym);
  slot.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  _currentDrill.set(container, data?.drill ?? null);
  const instances = _buildCharts(slot, 'data-drill-chart-index', data?.drill?.charts ?? [], sym, handlers.onDrill);
  _drillInstances.set(container, instances);
  return instances;
}

// Drill-panel charts per container (destroyed when the panel is replaced or closed).
const _drillInstances = new WeakMap();

// Drill currently shown per container (for "Open in Transactions").
const _currentDrill = new WeakMap();

function _attachPayloadEvents(container, data, handlers) {
  _currentDrill.set(container, data.drill ?? null);
  if (container._reportAbort) container._reportAbort.abort();
  const abort = new AbortController();
  container._reportAbort = abort;
  container.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target || !container.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'report-tab') handlers.onTab?.(target.dataset.tab);
    else if (action === 'report-control') handlers.onControl?.(target.dataset.param, target.dataset.value);
    else if (action === 'report-crumb') handlers.onCrumb?.((data.breadcrumbs ?? [])[Number(target.dataset.index)]?.drill ?? null);
    else if (action === 'report-row-drill') {
      const drill = (data.tables ?? [])[Number(target.dataset.table)]?.rows?.[Number(target.dataset.row)]?.drill;
      if (drill) handlers.onDrill?.({ [drill.param]: drill.value }, drill.mode ?? 'panel', drill.mode === 'query' ? drill.query ?? null : null);
    } else if (action === 'report-drill-close') {
      _destroyDrillCharts(container);
      const slot = container.querySelector('[data-role="report-drill"]');
      if (slot) slot.innerHTML = '';
      handlers.onDrillClose?.();
    } else if (action === 'report-open-transactions') {
      const drill = _currentDrill.get(container);
      if (drill?.query) handlers.onOpenTransactions?.(drill.query);
    }
  }, { signal: abort.signal });
}
