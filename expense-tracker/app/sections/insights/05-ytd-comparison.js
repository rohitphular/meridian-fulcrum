/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, groupByMonth, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions,
} from './insight-utils.js';

const AMBER        = '#f59e0b';
const MONTH_ABBREV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Period derivation ─────────────────────────────────────────────────────────
// `from` = Jan 1 of selected year (guaranteed by getPeriodBounds for ytd / last_year).
// `to`   = Dec 31 of selected year.

function _periods(from, to) {
  const today         = new Date();
  const todayLocal    = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yearA         = from.getFullYear();
  const yearB         = yearA - 1;
  const isCurrentYear = todayLocal.getFullYear() === yearA;
  const aEnd          = isCurrentYear ? todayLocal : to;

  // numMonths includes the partial current month (Jan=1 … Dec=12)
  const numMonths = aEnd.getMonth() + 1;

  // Period B: same months in previous year (same calendar day for partial month)
  const bFrom = new Date(yearB, 0, 1);
  const bEnd  = new Date(yearB, aEnd.getMonth(), aEnd.getDate());

  const labels = MONTH_ABBREV.slice(0, numMonths);

  return { yearA, yearB, aEnd, bFrom, bEnd, numMonths, isCurrentYear, labels };
}

// ── Monthly cumulative build ──────────────────────────────────────────────────

function _buildYtdCumulative(txs, yearStart, numMonths, partialMonthTo) {
  const byMonth = groupByMonth(txs);
  const yr      = yearStart.getFullYear();
  const result  = [];
  let running   = 0;
  for (let m = 0; m < numMonths; m++) {
    const monthKey    = `${yr}-${String(m + 1).padStart(2, '0')}`;
    const isLastMonth = m === numMonths - 1;
    let monthTotal;
    if (isLastMonth && partialMonthTo !== null) {
      const filtered = (byMonth.get(monthKey) || []).filter(t => {
        const d = new Date(t.tx_date_time);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()) <= partialMonthTo;
      });
      monthTotal = sumAmountBase(filtered);
    } else {
      monthTotal = sumAmountBase(byMonth.get(monthKey) || []);
    }
    running += monthTotal;
    result.push(running);
  }
  return result;
}

// ── Month-end asset sampling ──────────────────────────────────────────────────
// Calls computeDailyTotalAssets for the full year range once, then samples
// the last day of each month (or today for the current partial month).

function _sampleMonthEndAssets(assetAccounts, yearStart, aEnd, numMonths, isCurrentYear) {
  const yearA      = yearStart.getFullYear();
  const dailyTotals = computeDailyTotalAssets(assetAccounts, state.transactions, yearStart, aEnd);
  const result     = [];
  for (let m = 0; m < numMonths; m++) {
    const isLastMonth = m === numMonths - 1;
    const sampleDate  = (isLastMonth && isCurrentYear)
      ? aEnd
      : new Date(yearA, m + 1, 0);  // last day of month m (0-indexed)
    const dayIdx = Math.round((sampleDate - yearStart) / 86400000);
    result.push(dailyTotals[Math.min(dayIdx, dailyTotals.length - 1)] || 0);
  }
  return result;
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 12 } } },
  };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, labelA, labelB, totalA, totalB, numMonths, positiveWhenDown) {
  const fmt        = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const delta      = totalA - totalB;
  const isDown     = delta <= 0;
  const deltaClass = (isDown === positiveWhenDown) ? 'positive' : 'negative';
  const deltaArrow = isDown ? '↓' : '↑';
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
        <p class="stat-card-label">YoY change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(fmt(Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Months</p>
        <p class="stat-card-value">${esc(String(numMonths))}</p>
        <p class="stat-card-sub">of 12</p>
      </div>
    </div>`;
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { from, to, sym }) {
  const { yearA, yearB, aEnd, bFrom, bEnd, numMonths, isCurrentYear, labels } = _periods(from, to);

  const yearStart = new Date(yearA, 0, 1);
  const bStart    = new Date(yearB, 0, 1);

  const moneyOutA = filterTxByRange(state.transactions, yearStart, aEnd)
    .filter(t => t.tx_type === 'money-out');
  const moneyOutB = filterTxByRange(state.transactions, bStart, bEnd)
    .filter(t => t.tx_type === 'money-out');

  const dataA = _buildYtdCumulative(moneyOutA, yearStart, numMonths, isCurrentYear ? aEnd : null);
  const dataB = _buildYtdCumulative(moneyOutB, bStart,    numMonths, null);

  const totalA     = dataA[dataA.length - 1] || 0;
  const totalB     = dataB[dataB.length - 1] || 0;
  const hasPrevData = moneyOutB.length > 0;

  const labelA = isCurrentYear ? `${yearA} YTD` : String(yearA);
  const labelB = isCurrentYear ? `${yearB} (same period)` : String(yearB);

  container.innerHTML = `
    ${_statCards(sym, labelA, labelB, totalA, totalB, numMonths, true)}
    ${!hasPrevData ? `<p class="chart-empty" style="margin-bottom:12px">No data for ${esc(String(yearB))} — comparison series hidden.</p>` : ''}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  const datasets = [
    { label: labelA, data: dataA, borderColor: C.teal, fill: false, tension: 0.3, pointRadius: 5, pointHoverRadius: 7, spanGaps: false },
  ];
  if (hasPrevData) {
    datasets.push({ label: labelB, data: dataB, borderColor: AMBER, fill: false, tension: 0.3, pointRadius: 5, pointHoverRadius: 7, borderDash: [4, 4], spanGaps: false });
  }

  console.log(`[insight-05] transactions — A=${labelA} total=${totalA.toFixed(0)}, B=${labelB} total=${totalB.toFixed(0)}`);

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

  const { yearA, yearB, aEnd, bFrom, bEnd, numMonths, isCurrentYear, labels } = _periods(from, to);

  const yearStart = new Date(yearA, 0, 1);
  const bStart    = new Date(yearB, 0, 1);

  const dataA = _sampleMonthEndAssets(assetAccounts, yearStart, aEnd,  numMonths, isCurrentYear);
  const dataB = _sampleMonthEndAssets(assetAccounts, bStart,    bEnd,  numMonths, false);

  const latestA = dataA[dataA.length - 1] || 0;
  const latestB = dataB[dataB.length - 1] || 0;

  const labelA = isCurrentYear ? `${yearA} YTD` : String(yearA);
  const labelB = isCurrentYear ? `${yearB} (same period)` : String(yearB);

  container.innerHTML = `
    ${_statCards(sym, `Assets ${labelA}`, `Assets ${labelB}`, latestA, latestB, numMonths, false)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-05] accounts — A=${labelA} latest=${latestA.toFixed(0)}, B=${labelB} latest=${latestB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: `Assets ${labelA}`, data: dataA, borderColor: C.teal, backgroundColor: C.teal + '18', fill: true, tension: 0.3, pointRadius: 5, pointHoverRadius: 7 },
        { label: `Assets ${labelB}`, data: dataB, borderColor: AMBER,  fill: false, tension: 0.3, pointRadius: 5, pointHoverRadius: 7, borderDash: [4, 4] },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-05] container not found:', containerId);
    return null;
  }
  if (tab === 'accounts') {
    return _renderAccounts(container, { from, to, accounts, sym });
  }
  return _renderTransactions(container, { from, to, sym });
}
