/* global Chart */
import { el, esc, toBase } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, groupByDay, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions,
} from './insight-utils.js';

const AMBER = '#f59e0b';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildCumulative(txs, monthFrom, daysInMonth, cutoffDay) {
  const byDay  = groupByDay(txs);
  const result = [];
  let running  = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (cutoffDay !== null && d > cutoffDay) {
      result.push(null);
    } else {
      const yr  = monthFrom.getFullYear();
      const mo  = String(monthFrom.getMonth() + 1).padStart(2, '0');
      const day = String(d).padStart(2, '0');
      running += sumAmountBase(byDay.get(`${yr}-${mo}-${day}`) || []);
      result.push(running);
    }
  }
  return result;
}


function _lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  }
  return 0;
}

function _fmt(sym, v) {
  return sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales,  x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 7 } } },
  };
}

// ── Period derivation ─────────────────────────────────────────────────────────

function _periods(from) {
  const yearA  = from.getFullYear();
  const monthA = from.getMonth();
  const aFrom  = new Date(yearA,     monthA, 1);
  const aTo    = new Date(yearA,     monthA + 1, 0);
  const bFrom  = new Date(yearA - 1, monthA, 1);
  const bTo    = new Date(yearA - 1, monthA + 1, 0);
  return { aFrom, aTo, bFrom, bTo };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, labelA, labelB, totalA, totalB, fourthLabel, fourthValue, positiveWhenDown) {
  const delta      = totalA - totalB;
  const deltaClass = (positiveWhenDown ? delta <= 0 : delta >= 0) ? 'positive' : 'negative';
  const deltaArrow = delta <= 0 ? '↓' : '↑';
  const pct        = totalB !== 0 ? Math.round(Math.abs(delta) / Math.abs(totalB) * 100) : null;
  const pctStr     = pct !== null ? ` (${pct}%)` : '';

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelA)}</p>
        <p class="stat-card-value">${esc(_fmt(sym, totalA))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelB)}</p>
        <p class="stat-card-value">${esc(_fmt(sym, totalB))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">YoY change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(_fmt(sym, Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(fourthLabel)}</p>
        <p class="stat-card-value">${esc(fourthValue)}</p>
      </div>
    </div>`;
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { from, sym }) {
  const { aFrom, aTo, bFrom, bTo } = _periods(from);
  const today     = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const daysA = aTo.getDate();
  const daysB = bTo.getDate();
  const maxDays = Math.max(daysA, daysB);

  const isCurrentMonth = aFrom.getFullYear() === todayLocal.getFullYear() &&
                         aFrom.getMonth()    === todayLocal.getMonth();
  const cutoffDay = isCurrentMonth ? todayLocal.getDate() : null;

  const moneyOutA = filterTxByRange(state.transactions, aFrom, aTo)
    .filter(t => t.tx_type === 'money-out');
  const moneyOutB = filterTxByRange(state.transactions, bFrom, bTo)
    .filter(t => t.tx_type === 'money-out');

  if (!moneyOutA.length && !moneyOutB.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spend data for either period.</p></div>`;
    return null;
  }

  const dataA = _buildCumulative(moneyOutA, aFrom, daysA, cutoffDay);
  const dataB = _buildCumulative(moneyOutB, bFrom, daysB, null);
  while (dataA.length < maxDays) dataA.push(null);
  while (dataB.length < maxDays) dataB.push(null);

  const totalA = sumAmountBase(moneyOutA);
  const totalB = sumAmountBase(moneyOutB);
  const labelA = aFrom.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const labelB = bFrom.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const labels = Array.from({ length: maxDays }, (_, i) => String(i + 1));
  const monthName = aFrom.toLocaleDateString('en-GB', { month: 'long' });

  container.innerHTML = `
    ${_statCards(sym, labelA, labelB, totalA, totalB, 'Month', monthName, true)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-02] transactions — A=${labelA} total=${totalA.toFixed(0)}, B=${labelB} total=${totalB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: labelA, data: dataA, borderColor: C.teal, fill: false, tension: 0.3, pointRadius: 3, spanGaps: false },
        { label: labelB, data: dataB, borderColor: AMBER,  fill: false, tension: 0.3, pointRadius: 2, borderDash: [4, 4], spanGaps: false },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Accounts tab ──────────────────────────────────────────────────────────────

function _renderAccounts(container, { from, accounts, sym }) {
  const assetAccounts  = accounts.filter(a => a.is_active && a.type !== 'liability');

  if (!assetAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active asset accounts found.</p></div>`;
    return null;
  }

  const { aFrom, aTo, bFrom, bTo } = _periods(from);
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const daysA = aTo.getDate();
  const daysB = bTo.getDate();
  const maxDays = Math.max(daysA, daysB);

  const isCurrentMonth = aFrom.getFullYear() === todayLocal.getFullYear() &&
                         aFrom.getMonth()    === todayLocal.getMonth();
  const cutoffDay = isCurrentMonth ? todayLocal.getDate() : null;

  const dailyA = computeDailyTotalAssets(assetAccounts, state.transactions, aFrom, aTo);
  const dailyB = computeDailyTotalAssets(assetAccounts, state.transactions, bFrom, bTo);

  const dataA = dailyA.map((v, i) => (cutoffDay !== null && i + 1 > cutoffDay) ? null : v);
  const dataB = dailyB.slice();
  while (dataA.length < maxDays) dataA.push(null);
  while (dataB.length < maxDays) dataB.push(null);

  const latestA = _lastNonNull(dataA);
  const latestB = _lastNonNull(dataB);

  const labelA = `Assets ${aFrom.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  const labelB = `Assets ${bFrom.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  const labels = Array.from({ length: maxDays }, (_, i) => String(i + 1));
  const monthName = aFrom.toLocaleDateString('en-GB', { month: 'long' });

  container.innerHTML = `
    ${_statCards(sym, labelA, labelB, latestA, latestB, 'Month', monthName, false)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-02] accounts — A=${labelA} latest=${latestA.toFixed(0)}, B=${labelB} latest=${latestB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: labelA, data: dataA, borderColor: C.teal, backgroundColor: C.teal + '18', fill: true,  tension: 0.3, pointRadius: 3, spanGaps: false },
        { label: labelB, data: dataB, borderColor: AMBER,  backgroundColor: 'transparent',  fill: false, tension: 0.3, pointRadius: 2, borderDash: [4, 4], spanGaps: false },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-02] container not found:', containerId);
    return null;
  }

  if (tab === 'accounts') {
    return _renderAccounts(container, { from, accounts, sym });
  }
  return _renderTransactions(container, { from, sym });
}
