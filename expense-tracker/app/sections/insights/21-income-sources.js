/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, groupByMonth, sumAmountBase,
  getCssColors, baseChartOptions, fmtMonthKey, buildPalette, renderDrillTxTable,
} from './insight-utils.js';

const MAX_SEGMENTS = 8;

// Module-level chart ref — lets sub-view switches destroy the previous chart
// and keep state.insightChartInstance in sync (same pattern as 11-category-drilldown).
let _chart = null;

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch (_e) {} }
  _chart = c;
  state.insightChartInstance = c;
}

function _destroyChart() { _setChart(null); }

// ── Data helpers ──────────────────────────────────────────────────────────────

function _groupBy(inTxs, field, fallback) {
  const map = new Map();
  for (const tx of inTxs) {
    const key = (tx[field] || '').trim() || fallback;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  }
  const sorted = [...map.entries()]
    .map(([label, list]) => [label, sumAmountBase(list)])
    .sort((a, b) => b[1] - a[1]);
  const top  = sorted.slice(0, MAX_SEGMENTS);
  const rest = sorted.slice(MAX_SEGMENTS);
  if (rest.length) top.push(['Other', rest.reduce((s, [, v]) => s + v, 0)]);
  return top; // [[label, amount], ...]
}

function _monthlyTotals(inTxs, monthKeys) {
  const byMonth = groupByMonth(inTxs);
  return monthKeys.map(mk => sumAmountBase(byMonth.get(mk) || []));
}

// ── Donut sub-view ────────────────────────────────────────────────────────────

function _renderDonut(viewEl, segments, sym, C, field, fallback, inTxs) {
  const total = segments.reduce((s, [, v]) => s + v, 0);
  if (!total) {
    viewEl.innerHTML = `<p class="chart-empty">No income for selected period.</p>`;
    _setChart(null);
    return;
  }

  const palette = buildPalette(C);
  const labels  = segments.map(([l]) => l);
  const amounts = segments.map(([, v]) => v);
  const colors  = segments.map((_, i) => palette[i % palette.length]);
  const fmt     = v => sym + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const topShare     = amounts[0] / total;
  const concentrated = topShare > 0.9;

  const rows = segments.map(([label, amt], i) => `
    <li style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--hair);font-size:var(--text-sm)">
      <span style="display:flex;align-items:center;gap:8px;min-width:0">
        <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
      </span>
      <span style="white-space:nowrap;color:var(--muted);margin-left:12px">${esc(fmt(amt))} <span style="opacity:0.6">${((amt / total) * 100).toFixed(1)}%</span></span>
    </li>`).join('');

  viewEl.innerHTML = `
    ${concentrated ? `<p style="font-size:var(--text-xs);color:var(--ember);margin:0 0 8px">Concentrated income — ${esc(labels[0])} accounts for ${((topShare) * 100).toFixed(0)}%</p>` : ''}
    <p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 6px;text-align:center">Tap a segment to see transactions</p>
    <div class="chart-container" style="height:200px"><canvas id="dash21-canvas"></canvas></div>
    <ul style="list-style:none;padding:0;margin:8px 0 0">${rows}</ul>
    <div id="dash21-drill" hidden style="margin-top:16px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = viewEl.querySelector('#dash21-canvas');
  const drillEl = viewEl.querySelector('#dash21-drill');
  if (!canvas) { _setChart(null); return; }

  _setChart(new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: amounts, backgroundColor: colors, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      onClick: (_, elements) => {
        if (!elements.length || !drillEl || !inTxs || !field) return;
        const label = labels[elements[0].index];
        if (label === 'Other') return;
        const segTxs = inTxs
          .filter(t => ((t[field] || '').trim() || fallback) === label)
          .sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));
        const segTotal = sumAmountBase(segTxs);

        drillEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(label)}</h3>
            <div style="display:flex;gap:8px;font-size:var(--text-xs);color:var(--muted)">
              <span>${esc(String(segTxs.length))} txs · ${esc(fmt(segTotal))}</span>
              <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
            </div>
          </div>
          ${renderDrillTxTable(segTxs, sym)}`;
        drillEl.hidden = false;
        drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
        drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: C.ink, font: { size: 12 }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          backgroundColor: C.panel,
          borderColor: C.hair, borderWidth: 1,
          bodyColor: C.ink,
          callbacks: {
            label: ctx => `  ${ctx.label}: ${fmt(ctx.raw)} (${((ctx.raw / total) * 100).toFixed(1)}%)`,
          },
        },
      },
    },
  }));
}

// ── Trend sub-view ────────────────────────────────────────────────────────────

function _renderTrend(viewEl, inTxs, monthKeys, sym, C) {
  if (!monthKeys.length) {
    viewEl.innerHTML = `<p class="chart-empty">No data for selected period.</p>`;
    _setChart(null);
    return;
  }

  const monthly = _monthlyTotals(inTxs, monthKeys);
  const total   = monthly.reduce((s, v) => s + v, 0);
  const avg     = monthly.length ? total / monthly.length : 0;
  let peakIdx   = 0;
  monthly.forEach((v, i) => { if (v > monthly[peakIdx]) peakIdx = i; });

  const fmt  = v => sym + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const base = baseChartOptions(sym, C);

  viewEl.innerHTML = `
    <div class="stat-cards" style="margin-bottom:12px">
      <div class="stat-card">
        <p class="stat-card-label">Total income</p>
        <p class="stat-card-value positive">${esc(fmt(total))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg monthly</p>
        <p class="stat-card-value">${esc(fmt(avg))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Peak month</p>
        <p class="stat-card-value">${esc(monthKeys.length ? fmtMonthKey(monthKeys[peakIdx]) : '—')}</p>
        <p class="stat-card-sub">${esc(monthKeys.length ? fmt(monthly[peakIdx]) : '')}</p>
      </div>
    </div>
    <div class="chart-container" style="height:220px"><canvas id="dash21-canvas"></canvas></div>`;

  const canvas = viewEl.querySelector('#dash21-canvas');
  if (!canvas) { _setChart(null); return; }

  _setChart(new Chart(canvas, {
    type: 'line',
    data: {
      labels: monthKeys.map(fmtMonthKey),
      datasets: [{
        label:            'Income',
        data:             monthly,
        borderColor:      '#34d399',
        backgroundColor:  '#34d39922',
        fill:             true,
        tension:          0.3,
        pointRadius:      4,
        pointHoverRadius: 6,
      }],
    },
    options: {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false },
      },
      scales: {
        ...base.scales,
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 6 } },
      },
    },
  }));
}

// ── Tab bar events ────────────────────────────────────────────────────────────

function _attachTabs(containerId, inTxs, monthKeys, sym, C) {
  const container = el(containerId);
  if (!container) return;

  container.querySelectorAll('[data-d21-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-d21-view]').forEach(b => {
        b.style.background = 'transparent';
        b.style.color      = 'var(--muted)';
      });
      btn.style.background = 'var(--teal)';
      btn.style.color      = 'var(--ink)';

      const viewEl = el('dash21-view');
      if (!viewEl) return;

      switch (btn.dataset.d21View) {
        case 'source':
          _renderDonut(viewEl, _groupBy(inTxs, 'counterparty_name', 'Unknown source'), sym, C, 'counterparty_name', 'Unknown source', inTxs);
          break;
        case 'category':
          _renderDonut(viewEl, _groupBy(inTxs, 'major_category', 'Uncategorised'), sym, C, 'major_category', 'Uncategorised', inTxs);
          break;
        case 'trend':
          _renderTrend(viewEl, inTxs, monthKeys, sym, C);
          break;
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  _chart = null; // reset stale ref from any previous render of this insight

  const container = el(containerId);
  if (!container) {
    console.warn('[insight-21] container not found:', containerId);
    return { destroy() { _destroyChart(); } };
  }

  const inTxs     = txs.filter(t => t.tx_type === 'money-in');
  const monthKeys = monthRange(from, to);

  if (!inTxs.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No income recorded for this period.</p></div>`;
    _setChart(null);
    return { destroy() { _destroyChart(); } };
  }

  const C = getCssColors();

  const tabBtn = (view, label, active) =>
    `<button data-d21-view="${view}" style="padding:6px 14px;border:none;border-radius:20px;font-size:var(--text-sm);cursor:pointer;transition:background 0.2s;background:${active ? 'var(--teal)' : 'transparent'};color:${active ? 'var(--ink)' : 'var(--muted)'}">${label}</button>`;

  container.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
      ${tabBtn('source',   'By Source',   true)}
      ${tabBtn('category', 'By Category', false)}
      ${tabBtn('trend',    'Trend',        false)}
    </div>
    <div id="dash21-view"></div>`;

  // Render default sub-view
  const viewEl = el('dash21-view');
  _renderDonut(viewEl, _groupBy(inTxs, 'counterparty_name', 'Unknown source'), sym, C, 'counterparty_name', 'Unknown source', inTxs);

  _attachTabs(containerId, inTxs, monthKeys, sym, C);

  console.log(`[insight-21] income_txs=${inTxs.length}, months=${monthKeys.length}`);

  return { destroy() { _destroyChart(); } };
}
