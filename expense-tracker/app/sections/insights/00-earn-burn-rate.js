/* global Chart */
import { state } from '../../core/state.js';
import { el, esc, toBase } from '../../core/utils.js';
import { getCssColors, baseChartOptions } from './insight-utils.js';

const MONTH_ABBREV = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WINDOWS = [
  { value: 7,  label: '7d'  },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

let _windowDays = 30;
let _localChart  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _dayKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function _shiftDay(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

// ── Trailing-window rate computation ─────────────────────────────────────────
// Uses ALL transactions (state.transactions) so the trailing window can reach before `from`.
// All amounts are converted to quote currency via toBase().
//
// Returns:
//   incomeRates   — money-in / windowDays              (always ≥ 0)
//   expenseRates  — money-out / windowDays             (always ≥ 0)
//   savingsRates  — (income − expense) / windowDays    (positive = saving, negative = overspending)

function _computeRates(from, to, windowDays) {
  const earnByDay = {};
  const burnByDay = {};

  state.transactions.forEach(function(tx) {
    const d = new Date(tx.tx_date_time);
    if (isNaN(d.getTime())) return;
    const amt = toBase(Number(tx.amount) || 0, tx.currency, tx.fx_rate);
    if (!amt || isNaN(amt)) return;
    const key = _dayKey(d);
    if (tx.tx_type === 'money-in')  earnByDay[key] = (earnByDay[key] || 0) + amt;
    if (tx.tx_type === 'money-out') burnByDay[key] = (burnByDay[key] || 0) + amt;
  });

  const labels       = [];
  const incomeRates  = [];
  const expenseRates = [];
  const savingsRates = [];

  const today  = new Date();
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end    = new Date(Math.min(
    new Date(to.getFullYear(),    to.getMonth(),    to.getDate()).getTime(),
    new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  ));

  while (cursor <= end) {
    labels.push(cursor.getDate() + ' ' + MONTH_ABBREV[cursor.getMonth()]);

    let earnSum = 0, burnSum = 0;
    for (let i = 0; i < windowDays; i++) {
      const k = _dayKey(_shiftDay(cursor, -i));
      earnSum += earnByDay[k] || 0;
      burnSum += burnByDay[k] || 0;
    }
    incomeRates.push(earnSum / windowDays);
    expenseRates.push(burnSum / windowDays);
    savingsRates.push((earnSum - burnSum) / windowDays);

    cursor.setDate(cursor.getDate() + 1);
  }

  return { labels, incomeRates, expenseRates, savingsRates };
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function _statCards(sym, incomeRates, expenseRates, savingsRates) {
  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtSgn = v => (v >= 0 ? '+' : '−') + sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const income   = incomeRates[incomeRates.length   - 1] || 0;
  const expense  = expenseRates[expenseRates.length - 1] || 0;
  const savings  = savingsRates[savingsRates.length - 1] || 0;
  const savingsPct = income > 0
    ? ((savings / income) * 100).toFixed(1) + '%'
    : '—';

  const savClass = savings >= 0 ? 'positive' : 'negative';

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Savings / day</p>
        <p class="stat-card-value ${savClass}">${esc(fmtSgn(savings))}</p>
        <p class="stat-card-sub">${_windowDays}d trailing avg</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Income / day</p>
        <p class="stat-card-value positive">${esc(fmt(income))}</p>
        <p class="stat-card-sub">${_windowDays}d trailing avg</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Expense / day</p>
        <p class="stat-card-value negative">${esc(fmt(expense))}</p>
        <p class="stat-card-sub">${_windowDays}d trailing avg</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Savings rate</p>
        <p class="stat-card-value ${savClass}">${esc(savingsPct)}</p>
        <p class="stat-card-sub">of income</p>
      </div>
    </div>`;
}

// ── Chart ─────────────────────────────────────────────────────────────────────

function _buildChart(canvas, labels, incomeRates, expenseRates, savingsRates, sym) {
  const C    = getCssColors();
  const base = baseChartOptions(sym, C);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:            'Income rate',
          data:             incomeRates,
          borderColor:      '#34d399',
          borderWidth:      2,
          pointRadius:      0,
          pointHoverRadius: 4,
          tension:          0.3,
          fill:             false,
        },
        {
          label:            'Expense rate',
          data:             expenseRates,
          borderColor:      '#f87171',
          borderWidth:      2,
          pointRadius:      0,
          pointHoverRadius: 4,
          tension:          0.3,
          fill:             false,
        },
        {
          label:            'Savings rate',
          data:             savingsRates,
          borderColor:      '#60a5fa',
          borderWidth:      2,
          pointRadius:      0,
          pointHoverRadius: 4,
          tension:          0.3,
          // Fill to zero: green when positive (saving), red when negative (overspending)
          fill: {
            target: 'origin',
            above:  'rgba(96,165,250,0.15)',
            below:  'rgba(248,113,113,0.18)',
          },
        },
      ],
    },
    options: {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { ...base.plugins.legend, display: true },
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: {
            label: ctx => {
              const v    = ctx.parsed.y ?? 0;
              const neg  = v < 0;
              const sign = neg ? '−' : '';
              return `  ${ctx.dataset.label}: ${sign}${sym}${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/day`;
            },
          },
        },
      },
      scales: {
        ...base.scales,
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 8 } },
        y: {
          ...base.scales.y,
          ticks: {
            ...base.scales.y.ticks,
            callback: v => (v < 0 ? '−' : '') + sym + (Math.abs(v) >= 1000
              ? (Math.abs(v) / 1000).toFixed(1) + 'k'
              : Math.abs(v).toFixed(2)),
          },
        },
      },
    },
  });
}

// ── Render (called on first load and on window chip click) ────────────────────

function _render(container, { from, to, sym }) {
  const { labels, incomeRates, expenseRates, savingsRates } = _computeRates(from, to, _windowDays);
  const currentSavings = savingsRates[savingsRates.length - 1] || 0;
  const currentIncome  = incomeRates[incomeRates.length   - 1] || 0;
  const currentExpense = expenseRates[expenseRates.length - 1] || 0;

  container.innerHTML = `
    ${_statCards(sym, incomeRates, expenseRates, savingsRates)}
    <div class="insight-tabs" style="margin-bottom:16px">
      ${WINDOWS.map(w =>
        `<button class="insight-tab${_windowDays === w.value ? ' active' : ''}" data-action="eb-window" data-win="${esc(String(w.value))}">${esc(w.label)}</button>`
      ).join('')}
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  if (_localChart) { try { _localChart.destroy(); } catch (_) {} _localChart = null; }

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-00] income=${currentIncome.toFixed(2)}/day expense=${currentExpense.toFixed(2)}/day savings=${currentSavings.toFixed(2)}/day window=${_windowDays}d`);

  _localChart = _buildChart(canvas, labels, incomeRates, expenseRates, savingsRates, sym);
  state.insightChartInstance = _localChart;

  container.querySelectorAll('[data-action="eb-window"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _windowDays = Number(btn.dataset.win);
      _render(container, { from, to, sym });
    });
  });

  return _localChart;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { from, to, sym }) {
  const container = el(containerId);
  if (!container) return null;
  return _render(container, { from, to, sym });
}
