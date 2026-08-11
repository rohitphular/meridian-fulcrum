/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, sumAmountBase,
  getCssColors, baseChartOptions, fmtMonthKey, PREV_PERIOD_COLOR,
} from './insight-utils.js';

const TOP_N = 10;

// ── Minor category grouping ───────────────────────────────────────────────────

function _groupByMinor(txs) {
  const buckets = new Map();
  txs.forEach(t => {
    const cat = t.minor_category || 'Uncategorised';
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(t);
  });
  const totals = new Map();
  buckets.forEach((list, cat) => totals.set(cat, sumAmountBase(list)));
  return totals;
}

// ── Period B derivation ───────────────────────────────────────────────────────
// Period B mirrors Period A's exact duration, immediately before Period A.

function _prevPeriod(from, to) {
  const durationMs = to.getTime() - from.getTime();
  const bTo   = new Date(from.getTime() - 86400000);
  const bFrom = new Date(bTo.getTime() - durationMs);
  return { bFrom, bTo };
}

function _periodLabel(from, to) {
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  const fmt  = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  // Use "Month 'YY" shorthand only when the range is a full calendar month
  if (days >= 28 && from.getDate() === 1) {
    const mk = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    return fmtMonthKey(mk);
  }
  return `${fmt(from)} – ${fmt(to)}`;
}

// ── Chart options (horizontal bar) ────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    indexAxis: 'y',
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales: {
      ...base.scales,
      x: { ...base.scales.y },
      y: { ticks: { color: C.muted, font: { size: 11 } }, grid: { color: C.hair }, border: { display: false } },
    },
  };
}

// ── Delta list ────────────────────────────────────────────────────────────────

function _deltaListHtml(rows, labelB, sym) {
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const items = rows.map(({ cat, amtA, amtB }) => {
    const delta      = amtA - amtB;
    const arrow      = delta >= 0 ? '▲' : '▼';
    const deltaClass = delta <= 0 ? 'positive' : 'negative';
    const sign       = delta >= 0 ? '+' : '−';
    return `<li style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--hair);font-size:var(--text-sm)">
      <span>${esc(cat || '—')}</span>
      <span class="${deltaClass}" style="white-space:nowrap">${arrow} ${sign}${esc(fmt(Math.abs(delta)))} vs ${esc(labelB)}</span>
    </li>`;
  }).join('');
  return `<ul style="list-style:none;padding:0;margin:16px 0 0">${items}</ul>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, sym, from, to }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-10] container not found:', containerId);
    return null;
  }

  const moneyOutA = txs.filter(t => t.tx_type === 'money-out');

  if (!moneyOutA.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spending data for this period.</p></div>`;
    return null;
  }

  const { bFrom, bTo } = _prevPeriod(from, to);
  const moneyOutB = filterTxByRange(state.transactions, bFrom, bTo)
    .filter(t => t.tx_type === 'money-out');

  const groupA = _groupByMinor(moneyOutA);
  const groupB = _groupByMinor(moneyOutB);

  // Union of categories, sorted by Period A desc, top N
  const allCats = [...new Set([...groupA.keys(), ...groupB.keys()])];
  const rows    = allCats
    .map(cat => ({ cat, amtA: groupA.get(cat) || 0, amtB: groupB.get(cat) || 0 }))
    .sort((a, b) => b.amtA - a.amtA)
    .slice(0, TOP_N);

  const labelA = _periodLabel(from, to);
  const labelB = _periodLabel(bFrom, bTo);

  const C   = getCssColors();
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const totalA = rows.reduce((s, r) => s + r.amtA, 0);
  const totalB = rows.reduce((s, r) => s + r.amtB, 0);

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelA)}</p>
        <p class="stat-card-value">${esc(fmt(totalA))}</p>
        <p class="stat-card-sub">top ${esc(String(rows.length))} categories</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelB)}</p>
        <p class="stat-card-value">${esc(fmt(totalB))}</p>
        <p class="stat-card-sub">same categories</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container" style="height:${Math.max(200, rows.length * 32)}px"><canvas></canvas></div>
    </div>
    ${_deltaListHtml(rows, labelB, sym)}`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-10] ${rows.length} categories, A=${labelA} total=${totalA.toFixed(0)}, B=${labelB} total=${totalB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.cat || '—'),
      datasets: [
        { label: labelA, data: rows.map(r => r.amtA), backgroundColor: C.teal, borderRadius: 4 },
        { label: labelB, data: rows.map(r => r.amtB), backgroundColor: PREV_PERIOD_COLOR, borderRadius: 4 },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}
