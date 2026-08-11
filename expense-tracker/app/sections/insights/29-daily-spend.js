/* global Chart */
import { el, esc } from '../../core/utils.js';
import {
  groupByDay, sumAmountBase,
  getCssColors, baseChartOptions, renderDrillTxTable,
} from './insight-utils.js';

function _pad(n) { return String(n).padStart(2, '0'); }

// ── Build per-day labels, values, and tx buckets ──────────────────────────────

function _buildData(txs, from, to) {
  const byDay  = groupByDay(txs);
  const labels = [];
  const values = [];
  const dayTxs = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end    = new Date(to.getFullYear(), to.getMonth(), to.getDate());

  while (cursor <= end) {
    const key     = `${cursor.getFullYear()}-${_pad(cursor.getMonth() + 1)}-${_pad(cursor.getDate())}`;
    const mon     = cursor.toLocaleDateString('en-GB', { month: 'short' });
    const txsDay  = byDay.get(key) || [];
    labels.push(`${cursor.getDate()} ${mon}`);
    values.push(sumAmountBase(txsDay));
    dayTxs.push(txsDay);
    cursor.setDate(cursor.getDate() + 1);
  }

  return { labels, values, dayTxs };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, values, labels) {
  const fmt      = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const total    = values.reduce((s, v) => s + v, 0);
  const spendDays = values.filter(v => v > 0);
  const avg      = spendDays.length ? total / spendDays.length : 0;
  const maxVal   = spendDays.length ? Math.max(...spendDays) : 0;
  const maxIdx   = maxVal > 0 ? values.indexOf(maxVal) : -1;
  const maxLabel = maxIdx >= 0 ? labels[maxIdx] : '—';

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total spend</p>
        <p class="stat-card-value">${esc(fmt(total))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg / spend day</p>
        <p class="stat-card-value">${esc(fmt(avg))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Highest day</p>
        <p class="stat-card-value">${esc(fmt(maxVal))}</p>
        <p class="stat-card-sub">${esc(maxLabel)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Spend days</p>
        <p class="stat-card-value" style="font-size:var(--text-lg)">${esc(String(spendDays.length))} / ${esc(String(values.length))}</p>
      </div>
    </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-29] container not found:', containerId);
    return null;
  }

  const moneyOut = txs.filter(t => t.tx_type === 'money-out');
  const { labels, values, dayTxs } = _buildData(moneyOut, from, to);

  if (!values.some(v => v > 0)) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spending found for this period.</p></div>`;
    return null;
  }

  const C = getCssColors();

  container.innerHTML = `
    ${_statCards(sym, values, labels)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>
    <div id="ds-drill"></div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const bgColors    = values.map(v => v > 0 ? C.teal + 'cc' : C.hair);
  const hoverColors = values.map(v => v > 0 ? C.teal : C.muted);

  const base    = baseChartOptions(sym, C);
  const options = {
    ...base,
    interaction: { mode: 'index', intersect: true },
    plugins: {
      ...base.plugins,
      legend: { display: false },
    },
    scales: {
      ...base.scales,
      x: {
        ...base.scales.x,
        ticks: { ...base.scales.x.ticks, maxTicksLimit: 15 },
      },
      y: {
        ...base.scales.y,
        min: 0,
      },
    },
    onClick: (_evt, elements) => {
      if (!elements.length) return;
      const idx    = elements[0].index;
      const drillEl = document.getElementById('ds-drill');
      if (!drillEl) return;
      const txsDay = dayTxs[idx] || [];
      drillEl.innerHTML = `
        <div style="display:flex;align-items:baseline;gap:8px;margin:16px 0 8px;padding-top:12px;border-top:1px solid var(--hair)">
          <strong style="font-size:var(--text-sm)">${esc(labels[idx])}</strong>
          <span style="font-size:var(--text-xs);color:var(--muted)">${esc(String(txsDay.length))} transaction${txsDay.length !== 1 ? 's' : ''}</span>
        </div>
        ${renderDrillTxTable(txsDay, sym)}`;
    },
  };

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Daily spend',
        data:  values,
        backgroundColor:      bgColors,
        hoverBackgroundColor: hoverColors,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options,
  });

  console.log(`[insight-29] daily spend — ${labels.length} days, total=${values.reduce((s, v) => s + v, 0).toFixed(0)}`);
  return chart;
}
