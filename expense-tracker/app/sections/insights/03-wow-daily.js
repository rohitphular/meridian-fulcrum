/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, groupByDay, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions, PREV_PERIOD_COLOR,
} from './insight-utils.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── ISO week label ────────────────────────────────────────────────────────────

function _isoWeekLabel(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 3);  // Thursday of the week — determines ISO year
  const jan4    = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
  return `W${String(weekNum).padStart(2, '0')} ${d.getFullYear()}`;
}

// ── Period derivation ─────────────────────────────────────────────────────────
// `from` is always the Monday of the selected week (guaranteed by getPeriodBounds
// for this_week / last_week; custom periods use from as-is).

function _periods(from) {
  const aFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const aTo   = new Date(aFrom.getFullYear(), aFrom.getMonth(), aFrom.getDate() + 6);
  const bFrom = new Date(aFrom.getFullYear(), aFrom.getMonth(), aFrom.getDate() - 7);
  const bTo   = new Date(aFrom.getFullYear(), aFrom.getMonth(), aFrom.getDate() - 1);
  return { aFrom, aTo, bFrom, bTo };
}

// ── Daily (non-cumulative) 7-point array ──────────────────────────────────────

function _buildWeeklyDaily(txs, weekFrom, cutoffDate) {
  const byDay = groupByDay(txs);
  return Array.from({ length: 7 }, (_, d) => {
    const day = new Date(weekFrom.getFullYear(), weekFrom.getMonth(), weekFrom.getDate() + d);
    if (cutoffDate !== null && day > cutoffDate) return null;
    const yr  = day.getFullYear();
    const mo  = String(day.getMonth() + 1).padStart(2, '0');
    const dd  = String(day.getDate()).padStart(2, '0');
    return sumAmountBase(byDay.get(`${yr}-${mo}-${dd}`) || []);
  });
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  {
      ...base.scales,
      x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 7 } },
    },
  };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, labelA, labelB, totalA, totalB, weekLabelA) {
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
        <p class="stat-card-label">WoW change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(fmt(Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Week</p>
        <p class="stat-card-value" style="font-size:var(--text-lg)">${esc(weekLabelA)}</p>
      </div>
    </div>`;
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { from, sym }) {
  const { aFrom, aTo, bFrom, bTo } = _periods(from);
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const isCurrentWeek = aFrom <= todayLocal && todayLocal <= aTo;
  const cutoffDate    = isCurrentWeek ? todayLocal : null;

  const moneyOutA = filterTxByRange(state.transactions, aFrom, aTo)
    .filter(t => t.tx_type === 'money-out');
  const moneyOutB = filterTxByRange(state.transactions, bFrom, bTo)
    .filter(t => t.tx_type === 'money-out');

  const dataA = _buildWeeklyDaily(moneyOutA, aFrom, cutoffDate);
  const dataB = _buildWeeklyDaily(moneyOutB, bFrom, null);

  const totalA = moneyOutA.reduce((s, t) => s + (sumAmountBase([t]) || 0), 0);
  const totalB = moneyOutB.reduce((s, t) => s + (sumAmountBase([t]) || 0), 0);

  const labelA    = _isoWeekLabel(aFrom) + (isCurrentWeek ? ' (current)' : '');
  const labelB    = _isoWeekLabel(bFrom) + ' (prev)';
  const weekLabel = _isoWeekLabel(aFrom);

  container.innerHTML = `
    ${_statCards(sym, labelA, labelB, totalA, totalB, weekLabel)}
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-03] transactions — A=${labelA} total=${totalA.toFixed(0)}, B=${labelB} total=${totalB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: WEEKDAYS,
      datasets: [
        {
          label:           labelA,
          data:            dataA,
          borderColor:     C.teal,
          backgroundColor: C.teal + '1a',
          fill:            'origin',
          tension:         0.3,
          pointRadius:     4,
          pointHoverRadius: 6,
          spanGaps:        false,
        },
        {
          label:       labelB,
          data:        dataB,
          borderColor: PREV_PERIOD_COLOR,
          fill:        false,
          tension:     0.3,
          pointRadius: 3,
          borderDash:  [4, 4],
          spanGaps:    false,
        },
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

  const isCurrentWeek = aFrom <= todayLocal && todayLocal <= aTo;
  const cutoffDay     = isCurrentWeek ? todayLocal.getDay() === 0 ? 7 : ((todayLocal - aFrom) / 86400000) : null;

  const dailyA = computeDailyTotalAssets(assetAccounts, state.transactions, aFrom, aTo);
  const dailyB = computeDailyTotalAssets(assetAccounts, state.transactions, bFrom, bTo);

  const dataA = dailyA.map((v, i) => (cutoffDay !== null && i >= cutoffDay) ? null : v);
  const dataB = dailyB.slice(0, 7);

  const latestA    = dataA.filter(v => v !== null).slice(-1)[0] || 0;
  const latestB    = dataB.slice(-1)[0] || 0;
  const labelA     = _isoWeekLabel(aFrom) + (isCurrentWeek ? ' (current)' : '');
  const labelB     = _isoWeekLabel(bFrom) + ' (prev)';
  const weekLabel  = _isoWeekLabel(aFrom);

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
        <p class="stat-card-label">Prev week end</p>
        <p class="stat-card-value">${esc(fmt(latestB))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">WoW change</p>
        <p class="stat-card-value ${deltaClass}">${deltaArrow} ${esc(fmt(Math.abs(delta)))}${esc(pctStr)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Week</p>
        <p class="stat-card-value" style="font-size:var(--text-lg)">${esc(weekLabel)}</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-03] accounts — A=${labelA} latest=${latestA.toFixed(0)}, B=${labelB} latest=${latestB.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: WEEKDAYS,
      datasets: [
        {
          label:           `Assets ${labelA}`,
          data:            dataA,
          borderColor:     C.teal,
          backgroundColor: C.teal + '1a',
          fill:            true,
          tension:         0.3,
          pointRadius:     4,
          spanGaps:        false,
        },
        {
          label:       `Assets ${labelB}`,
          data:        dataB,
          borderColor: PREV_PERIOD_COLOR,
          fill:        false,
          tension:     0.3,
          pointRadius: 3,
          borderDash:  [4, 4],
          spanGaps:    false,
        },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-03] container not found:', containerId);
    return null;
  }

  if (tab === 'accounts') {
    return _renderAccounts(container, { from, accounts, sym });
  }
  return _renderTransactions(container, { from, sym });
}
