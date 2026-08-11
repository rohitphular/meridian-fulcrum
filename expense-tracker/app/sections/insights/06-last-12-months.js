/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  groupByMonth, sumAmountBase,
  computeDailyTotalAssets, getCssColors, buildPalette, baseChartOptions,
} from './insight-utils.js';

const MONTH_ABBREV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── 12-month window ───────────────────────────────────────────────────────────
// Always fixed: 11 full months behind + current partial month, ending today.

function _window12() {
  const today = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const months12 = Array.from({ length: 12 }, (_, i) =>
    new Date(todayLocal.getFullYear(), todayLocal.getMonth() - 11 + i, 1)
  );

  const labels = months12.map((m, i) => {
    const abbrev = `${MONTH_ABBREV[m.getMonth()]} ${String(m.getFullYear()).slice(2)}`;
    return i === 11 ? `${abbrev}*` : abbrev;
  });

  return { months12, labels, todayLocal };
}

// ── Monthly income / expense build ───────────────────────────────────────────

function _buildMonthly(months12, todayLocal) {
  const byMonth = groupByMonth(state.transactions);
  const income  = [];
  const expense = [];
  const net     = [];

  months12.forEach((monthStart, i) => {
    const yr  = monthStart.getFullYear();
    const mo  = String(monthStart.getMonth() + 1).padStart(2, '0');
    const key = `${yr}-${mo}`;
    const all = byMonth.get(key) || [];

    // Partial month: filter to today for the last bucket
    const txs = (i === 11)
      ? all.filter(t => {
          const d = new Date(t.tx_date_time);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate()) <= todayLocal;
        })
      : all;

    const inc = sumAmountBase(txs.filter(t => t.tx_type === 'money-in'));
    const exp = sumAmountBase(txs.filter(t => t.tx_type === 'money-out'));
    income.push(inc);
    expense.push(exp);
    net.push(inc - exp);
  });

  return { income, expense, net };
}

// ── Chart options (mixed bar + line) ─────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 6 } } },
  };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, totalIncome, totalExpense, net, avgMonthly) {
  const fmt  = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const netClass = net >= 0 ? 'positive' : 'negative';
  const netArrow = net >= 0 ? '↑' : '↓';

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Income (12 mo)</p>
        <p class="stat-card-value positive">${esc(fmt(totalIncome))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Expenses (12 mo)</p>
        <p class="stat-card-value negative">${esc(fmt(totalExpense))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Net</p>
        <p class="stat-card-value ${netClass}">${netArrow} ${esc(fmt(Math.abs(net)))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg spend/mo</p>
        <p class="stat-card-value">${esc(fmt(avgMonthly))}</p>
      </div>
    </div>`;
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { sym }) {
  const { months12, labels, todayLocal } = _window12();
  const { income, expense, net }         = _buildMonthly(months12, todayLocal);

  const totalIncome  = income.reduce((s, v) => s + v, 0);
  const totalExpense = expense.reduce((s, v) => s + v, 0);
  const totalNet     = totalIncome - totalExpense;
  const avgMonthly   = totalExpense / 12;

  container.innerHTML = `
    ${_statCards(sym, totalIncome, totalExpense, totalNet, avgMonthly)}
    <p class="stat-card-sub" style="margin-bottom:8px">* current month is partial</p>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C = getCssColors();
  console.log(`[insight-06] transactions — income=${totalIncome.toFixed(0)}, expense=${totalExpense.toFixed(0)}, net=${totalNet.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           'Income',
          data:            income,
          backgroundColor: 'rgba(52,211,153,0.8)',
          borderRadius:    3,
          order:           2,
        },
        {
          label:           'Expenses',
          data:            expense,
          backgroundColor: 'rgba(248,113,113,0.8)',
          borderRadius:    3,
          order:           2,
        },
        {
          type:        'line',
          label:       'Net',
          data:        net,
          borderColor: '#f59e0b',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          fill:        false,
          tension:     0.3,
          order:       1,
        },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}

// ── Accounts tab ──────────────────────────────────────────────────────────────

function _renderAccounts(container, { accounts, sym }) {
  const assetAccounts  = accounts.filter(a => a.is_active && a.type !== 'liability');

  if (!assetAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active asset accounts found.</p></div>`;
    return null;
  }

  const { months12, labels, todayLocal } = _window12();
  const rangeStart = months12[0];

  // Group asset accounts by sub_type (fall back to type)
  const groupMap = new Map();
  assetAccounts.forEach(a => {
    const key = a.sub_type || a.type || 'other';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(a);
  });

  const C        = getCssColors();
  const palette  = buildPalette(C);

  // Compute month-end total assets per group
  const groupEntries = [...groupMap.entries()];
  const datasets = groupEntries.map(([groupKey, groupAccts], i) => {
    const daily = computeDailyTotalAssets(groupAccts, state.transactions, rangeStart, todayLocal);
    const data  = months12.map((monthStart, j) => {
      const isLast     = j === 11;
      const sampleDate = isLast
        ? todayLocal
        : new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
      const dayIdx = Math.round((sampleDate - rangeStart) / 86400000);
      return daily[Math.min(dayIdx, daily.length - 1)] || 0;
    });
    const label = groupKey.charAt(0).toUpperCase() + groupKey.slice(1).replace(/_/g, ' ');
    return { label, data, backgroundColor: palette[i % palette.length] + 'cc', stack: 'assets', borderRadius: 3, order: 2 };
  });

  // Total for stat card = sum of all groups on last month
  const totalAssets = groupEntries.reduce((s, _, i) => s + (datasets[i].data[11] || 0), 0);
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total assets</p>
        <p class="stat-card-value">${esc(fmt(totalAssets))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Account groups</p>
        <p class="stat-card-value">${esc(String(groupEntries.length))}</p>
        <p class="stat-card-sub">${esc(groupEntries.map(([k]) => k).join(', '))}</p>
      </div>
    </div>
    <p class="stat-card-sub" style="margin-bottom:8px">* current month is partial</p>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-06] accounts — groups=${groupEntries.length}, totalAssets=${totalAssets.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: _buildChartOptions(sym, C),
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-06] container not found:', containerId);
    return null;
  }
  if (tab === 'accounts') {
    return _renderAccounts(container, { accounts, sym });
  }
  return _renderTransactions(container, { sym });
}
