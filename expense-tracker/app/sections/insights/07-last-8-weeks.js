/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, sumAmountBase,
  getCssColors, baseChartOptions,
} from './insight-utils.js';

// ── ISO week helpers ──────────────────────────────────────────────────────────

function _isoWeekNum(monday) {
  const d = new Date(monday);
  d.setDate(d.getDate() + 3);  // Thursday of the week — determines ISO year
  const jan4    = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
}

function _currentWeekMonday(todayLocal) {
  const dow = todayLocal.getDay();  // 0=Sun … 6=Sat
  const diffToMon = dow === 0 ? 6 : dow - 1;
  return new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate() - diffToMon);
}

// ── 8-week window ─────────────────────────────────────────────────────────────
// weeks8[0] = 7 weeks ago, weeks8[7] = current week (may be partial)

function _window8() {
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const monday     = _currentWeekMonday(todayLocal);

  const weeks8 = Array.from({ length: 8 }, (_, i) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - (7 - i) * 7)
  );

  const labels = weeks8.map((m, i) => {
    const wNum = _isoWeekNum(m);
    const isCurrentWeek = i === 7;
    return isCurrentWeek ? `W${String(wNum).padStart(2, '0')} (now)` : `W${String(wNum).padStart(2, '0')}`;
  });

  return { weeks8, labels, todayLocal };
}

// ── Weekly income / expense build ────────────────────────────────────────────

function _buildWeekly(weeks8, todayLocal) {
  const income  = [];
  const expense = [];

  weeks8.forEach((weekFrom, i) => {
    const weekTo     = new Date(weekFrom.getFullYear(), weekFrom.getMonth(), weekFrom.getDate() + 6);
    const isCurrentWeek = i === 7;
    const clampedTo  = isCurrentWeek ? todayLocal : weekTo;

    const txs = filterTxByRange(state.transactions, weekFrom, clampedTo);
    income.push(sumAmountBase(txs.filter(t => t.tx_type === 'money-in')));
    expense.push(sumAmountBase(txs.filter(t => t.tx_type === 'money-out')));
  });

  return { income, expense };
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-07] container not found:', containerId);
    return null;
  }

  const { weeks8, labels, todayLocal } = _window8();
  const { income, expense }            = _buildWeekly(weeks8, todayLocal);

  const totalIncome  = income.reduce((s, v) => s + v, 0);
  const totalExpense = expense.reduce((s, v) => s + v, 0);
  const net          = totalIncome - totalExpense;
  const avgWeekly    = totalExpense / 8;

  const fmt      = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const netClass = net >= 0 ? 'positive' : 'negative';
  const netArrow = net >= 0 ? '↑' : '↓';

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Income (8 wks)</p>
        <p class="stat-card-value positive">${esc(fmt(totalIncome))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Expenses (8 wks)</p>
        <p class="stat-card-value negative">${esc(fmt(totalExpense))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Net</p>
        <p class="stat-card-value ${netClass}">${netArrow} ${esc(fmt(Math.abs(net)))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg spend/wk</p>
        <p class="stat-card-value">${esc(fmt(avgWeekly))}</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-07] income=${totalIncome.toFixed(0)}, expense=${totalExpense.toFixed(0)}, net=${net.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income',   data: income,  backgroundColor: 'rgba(52,211,153,0.8)', borderRadius: 3 },
        { label: 'Expenses', data: expense, backgroundColor: 'rgba(248,113,113,0.8)', borderRadius: 3 },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}
