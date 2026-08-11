/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, groupByDay, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions,
} from './insight-utils.js';

const AMBER = '#f59e0b';

// ── Quarter helpers ───────────────────────────────────────────────────────────

function _quarterLabel(qStart) {
  const q = Math.floor(qStart.getMonth() / 3) + 1;
  return `Q${q} ${qStart.getFullYear()}`;
}

// ── Period derivation ─────────────────────────────────────────────────────────
// `from` = first day of selected quarter (guaranteed by getPeriodBounds for
// this_quarter / last_quarter; custom uses from as-is).
// `to`   = last day of selected quarter.

function _periods(from, to) {
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isCurrentQ = todayLocal >= from && todayLocal <= to;
  const aEnd       = isCurrentQ ? todayLocal : to;
  const daysElapsed = Math.round((aEnd - from) / 86400000) + 1;

  // Prev quarter start: exactly 3 months before — JS Date handles Q1→Q4 wraparound
  const bFrom = new Date(from.getFullYear(), from.getMonth() - 3, 1);
  const bTo   = new Date(bFrom.getFullYear(), bFrom.getMonth(), bFrom.getDate() + daysElapsed - 1);

  const daysInQuarter = Math.round((to - from) / 86400000) + 1;

  return { aFrom: from, aEnd, bFrom, bTo, daysElapsed, isCurrentQ, daysInQuarter };
}

// ── Cumulative build ──────────────────────────────────────────────────────────

function _buildQtdCumulative(txs, quarterStart, numDays) {
  const byDay = groupByDay(txs);
  const result = [];
  let running = 0;
  for (let d = 0; d < numDays; d++) {
    const day = new Date(quarterStart.getFullYear(), quarterStart.getMonth(), quarterStart.getDate() + d);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    running += sumAmountBase(byDay.get(key) || []);
    result.push(running);
  }
  return result;
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 8 } } },
  };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, labelA, labelB, totalA, totalB, daysElapsed, daysInQuarter) {
  const fmt        = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const delta      = totalA - totalB;
  const deltaClass = delta <= 0 ? 'positive' : 'negative';
  const deltaArrow = delta <= 0 ? '↓' : '↑';
  const pct        = totalB !== 0 ? Math.round(Math.abs(delta) / Math.abs(totalB) * 100) : null;
  const pctStr     = pct !== null ? ` (${pct}%)` : '';

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelA)}</p>
        <p class="stat-card-value">${esc(fmt(totalA))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelB)}</p>
        <p class="stat-card-value">${esc(fmt(totalB))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">QTD change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(fmt(Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Days in</p>
        <p class="stat-card-value">${esc(String(daysElapsed))}</p>
        <p class="stat-card-sub">of ${esc(String(daysInQuarter))} days</p>
      </div>
    </div>`;
}

// ── X-axis labels ─────────────────────────────────────────────────────────────

function _dayLabels(numDays) {
  const n = Math.max(numDays, 2);
  return Array.from({ length: n }, (_, i) => `Day ${i + 1}`);
}

function _padTo(arr, targetLength) {
  if (arr.length >= targetLength) return arr;
  return [...arr, ...Array(targetLength - arr.length).fill(arr[arr.length - 1] || 0)];
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { from, to, sym }) {
  const { aFrom, aEnd, bFrom, bTo, daysElapsed, isCurrentQ, daysInQuarter } = _periods(from, to);

  const moneyOutA = filterTxByRange(state.transactions, aFrom, aEnd)
    .filter(t => t.tx_type === 'money-out');
  const moneyOutB = filterTxByRange(state.transactions, bFrom, bTo)
    .filter(t => t.tx_type === 'money-out');

  const rawA = _buildQtdCumulative(moneyOutA, aFrom, daysElapsed);
  const rawB = _buildQtdCumulative(moneyOutB, bFrom, daysElapsed);

  const totalA     = rawA[rawA.length - 1] || 0;
  const totalB     = rawB[rawB.length - 1] || 0;
  const hasPrevData = moneyOutB.length > 0;

  const currentQLabel = _quarterLabel(aFrom) + (isCurrentQ ? ' (to date)' : '');
  const prevQLabel    = _quarterLabel(bFrom) + ' (same days)';
  const labels        = _dayLabels(daysElapsed);
  const dataA         = _padTo(rawA, labels.length);
  const dataB         = _padTo(rawB, labels.length);

  container.innerHTML = `
    ${_statCards(sym, currentQLabel, prevQLabel, totalA, totalB, daysElapsed, daysInQuarter)}
    ${!hasPrevData ? `<p class="chart-empty" style="margin-bottom:12px">No data for ${esc(prevQLabel)} — comparison series hidden.</p>` : ''}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  const datasets = [
    { label: currentQLabel, data: dataA, borderColor: C.teal, fill: false, tension: 0.3, pointRadius: 2, spanGaps: false },
  ];
  if (hasPrevData) {
    datasets.push({ label: prevQLabel, data: dataB, borderColor: AMBER, fill: false, tension: 0.3, pointRadius: 2, borderDash: [4, 4], spanGaps: false });
  }

  console.log(`[insight-04] transactions — A=${currentQLabel} D=${daysElapsed}, B=${prevQLabel} hasPrev=${hasPrevData}`);

  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: _buildChartOptions(sym, C),
  });
}

// ── Accounts tab ──────────────────────────────────────────────────────────────

function _renderAccounts(container, { from, to, accounts, sym }) {
  const assetAccounts  = accounts.filter(a => a.is_active && a.type !== 'liability');

  if (!assetAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active asset accounts found.</p></div>`;
    return null;
  }

  const { aFrom, aEnd, bFrom, bTo, daysElapsed, isCurrentQ, daysInQuarter } = _periods(from, to);

  const rawA = computeDailyTotalAssets(assetAccounts, state.transactions, aFrom, aEnd);
  const rawB = computeDailyTotalAssets(assetAccounts, state.transactions, bFrom, bTo);

  const latestA = rawA[rawA.length - 1] || 0;
  const latestB = rawB[rawB.length - 1] || 0;

  const currentQLabel = _quarterLabel(aFrom) + (isCurrentQ ? ' (to date)' : '');
  const prevQLabel    = _quarterLabel(bFrom) + ' (same days)';
  const labels        = _dayLabels(daysElapsed);
  const dataA         = _padTo(rawA, labels.length);
  const dataB         = _padTo(rawB, labels.length);

  const fmt        = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const delta      = latestA - latestB;
  const deltaClass = delta >= 0 ? 'positive' : 'negative';
  const deltaArrow = delta >= 0 ? '↑' : '↓';
  const pct        = latestB !== 0 ? Math.round(Math.abs(delta) / Math.abs(latestB) * 100) : null;
  const pctStr     = pct !== null ? ` (${pct}%)` : '';

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Current assets</p>
        <p class="stat-card-value">${esc(fmt(latestA))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(prevQLabel)}</p>
        <p class="stat-card-value">${esc(fmt(latestB))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">QTD change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(fmt(Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Days in</p>
        <p class="stat-card-value">${esc(String(daysElapsed))}</p>
        <p class="stat-card-sub">of ${esc(String(daysInQuarter))} days</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-04] accounts — A=${currentQLabel} D=${daysElapsed}, latestA=${latestA.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: `Assets ${currentQLabel}`, data: dataA, borderColor: C.teal, backgroundColor: C.teal + '18', fill: true, tension: 0.3, pointRadius: 2 },
        { label: `Assets ${prevQLabel}`,    data: dataB, borderColor: AMBER,  fill: false, tension: 0.3, pointRadius: 2, borderDash: [4, 4] },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-04] container not found:', containerId);
    return null;
  }
  if (tab === 'accounts') {
    return _renderAccounts(container, { from, to, accounts, sym });
  }
  return _renderTransactions(container, { from, to, sym });
}
