/* global Chart */
import { el, esc } from '../../core/utils.js';
import {
  groupByMonth, monthRange, sumAmountBase,
  getCssColors, buildPalette, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

// ── Dataset build ─────────────────────────────────────────────────────────────

function _buildDatasets(moneyOut, monthKeys, C) {
  const byMonth = groupByMonth(moneyOut);
  const palette = buildPalette(C);

  // Per-month category totals: monthCatMaps[i] = Map<category, total>
  const monthCatMaps = monthKeys.map(key => {
    const catMap = new Map();
    (byMonth.get(key) || []).forEach(t => {
      const cat = t.major_category || 'Uncategorised';
      if (!catMap.has(cat)) catMap.set(cat, []);
      catMap.get(cat).push(t);
    });
    const totals = new Map();
    catMap.forEach((txs, cat) => totals.set(cat, sumAmountBase(txs)));
    return totals;
  });

  // All unique categories across all months
  const allCats = [...new Set(monthCatMaps.flatMap(m => [...m.keys()]))];

  // Sort by grand total descending (largest → bottom of stack)
  const sorted = allCats
    .map(cat => ({ cat, total: monthCatMaps.reduce((s, m) => s + (m.get(cat) || 0), 0) }))
    .sort((a, b) => b.total - a.total);

  return sorted.map(({ cat }, i) => ({
    label:           cat,
    data:            monthCatMaps.map(m => m.get(cat) || 0),
    backgroundColor: palette[i % palette.length] + 'cc',
    stack:           'spend',
    borderRadius:    2,
  }));
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales: {
      ...base.scales,
      x: { ...base.scales.x, stacked: true, ticks: { ...base.scales.x.ticks, maxTicksLimit: 6 } },
      y: { ...base.scales.y, stacked: true },
    },
  };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, datasets, monthKeys) {
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const grandTotal = datasets.reduce((s, ds) => s + ds.data.reduce((a, b) => a + b, 0), 0);
  const topDs      = datasets[0];  // already sorted by total desc
  const topTotal   = topDs ? topDs.data.reduce((s, v) => s + v, 0) : 0;

  // Month with highest total spend
  const monthTotals = monthKeys.map((_, mi) =>
    datasets.reduce((s, ds) => s + (ds.data[mi] || 0), 0)
  );
  const peakIdx      = monthTotals.indexOf(Math.max(...monthTotals));
  const peakLabel    = monthKeys[peakIdx] ? fmtMonthKey(monthKeys[peakIdx]) : '—';
  const peakValue    = monthTotals[peakIdx] || 0;

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total spend</p>
        <p class="stat-card-value">${esc(fmt(grandTotal))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Top category</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(topDs?.label || '—')}</p>
        <p class="stat-card-sub">${esc(fmt(topTotal))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Peak month</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(peakLabel)}</p>
        <p class="stat-card-sub">${esc(fmt(peakValue))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Categories</p>
        <p class="stat-card-value">${esc(String(datasets.length))}</p>
      </div>
    </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, sym, from, to }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-09] container not found:', containerId);
    return null;
  }

  const moneyOut = txs.filter(t => t.tx_type === 'money-out');

  if (!moneyOut.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spending data for this period.</p></div>`;
    return null;
  }

  const monthKeys = monthRange(from, to);
  const C         = getCssColors();
  const datasets  = _buildDatasets(moneyOut, monthKeys, C);
  const labels    = monthKeys.map(fmtMonthKey);

  container.innerHTML = `
    ${_statCards(sym, datasets, monthKeys)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-09] ${moneyOut.length} txs, ${datasets.length} categories, ${monthKeys.length} months`);

  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: _buildChartOptions(sym, C),
  });
}
