/* global Chart */
import { el, esc } from '../../core/utils.js';
import {
  monthRange, groupByMonth, sumAmountBase,
  getCssColors, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

// ── Monthly build ─────────────────────────────────────────────────────────────

function _buildMonthly(txs, monthKeys) {
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const curYYYYMM  = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}`;

  const inByMonth  = groupByMonth(txs.filter(t => t.tx_type === 'money-in'));
  const outByMonth = groupByMonth(txs.filter(t => t.tx_type === 'money-out'));

  const incomeArr  = [];
  const expenseArr = [];
  const rateArr    = []; // null when income = 0 (renders as gap)
  const partial    = [];

  for (const mk of monthKeys) {
    const isPartial = mk === curYYYYMM;
    partial.push(isPartial);

    const filterPartial = arr => isPartial
      ? arr.filter(t => {
          const d = new Date(t.tx_date_time);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate()) <= todayLocal;
        })
      : arr;

    const inTxs  = filterPartial(inByMonth.get(mk)  || []);
    const outTxs = filterPartial(outByMonth.get(mk) || []);

    const inc = sumAmountBase(inTxs);
    const exp = sumAmountBase(outTxs);
    incomeArr.push(inc);
    expenseArr.push(exp);
    rateArr.push(inc > 0 ? ((inc - exp) / inc) * 100 : null);
  }

  return { incomeArr, expenseArr, rateArr, partial };
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function _computeStats(rateArr, monthKeys) {
  const nonNull = rateArr.map((r, i) => r !== null ? { r, i } : null).filter(Boolean);
  if (!nonNull.length) return { avg: null, bestIdx: -1, worstIdx: -1, streak: 0 };

  const avg = nonNull.reduce((s, { r }) => s + r, 0) / nonNull.length;

  let bestIdx  = nonNull[0].i;
  let worstIdx = nonNull[0].i;
  for (const { r, i } of nonNull) {
    if (r > rateArr[bestIdx])  bestIdx  = i;
    if (r < rateArr[worstIdx]) worstIdx = i;
  }

  // Current trailing streak of positive months
  let streak = 0;
  for (let i = rateArr.length - 1; i >= 0; i--) {
    if (rateArr[i] !== null && rateArr[i] > 0) streak++;
    else break;
  }

  return { avg, bestIdx, worstIdx, streak };
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { ...base.plugins.legend, display: true },
    },
    scales: {
      y: {
        position: 'left',
        ticks: {
          color:    C.muted,
          callback: v => `${sym}${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
        },
        grid: { color: C.hair },
      },
      y2: {
        position: 'right',
        grid: {
          drawOnChartArea: true,
          color: ctx => ctx.tick.value === 0 ? C.ember + '99' : 'transparent',
        },
        ticks: { color: C.muted, callback: v => `${Math.round(v)}%` },
      },
      x: {
        ...base.scales.x,
        ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 6 },
      },
    },
  };
}

// ── Stat card HTML ────────────────────────────────────────────────────────────

function _statCardsHtml(rateArr, monthKeys, C) {
  const { avg, bestIdx, worstIdx, streak } = _computeStats(rateArr, monthKeys);

  const fmtRate = r => `${Math.round(r)}%`;
  const fmtMkR  = (i) => `${fmtMonthKey(monthKeys[i])} (${fmtRate(rateArr[i])})`;

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Avg savings rate</p>
        <p class="stat-card-value${avg !== null && avg >= 0 ? ' positive' : avg !== null ? ' negative' : ''}">${esc(avg !== null ? fmtRate(avg) : 'N/A')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Best month</p>
        <p class="stat-card-value positive">${esc(bestIdx >= 0 ? fmtMkR(bestIdx) : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Worst month</p>
        <p class="stat-card-value negative">${esc(worstIdx >= 0 ? fmtMkR(worstIdx) : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Positive streak</p>
        <p class="stat-card-value">${esc(streak > 0 ? `${streak} month${streak === 1 ? '' : 's'}` : '—')}</p>
      </div>
    </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-20] container not found:', containerId);
    return null;
  }

  const monthKeys = monthRange(from, to);
  if (!monthKeys.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No data for selected period.</p></div>`;
    return null;
  }

  const { incomeArr, expenseArr, rateArr, partial } = _buildMonthly(txs, monthKeys);

  const hasPartial = partial.some(Boolean);
  const labels     = monthKeys.map((mk, i) => fmtMonthKey(mk) + (partial[i] ? '*' : ''));

  const C        = getCssColors();
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  container.innerHTML = `
    ${_statCardsHtml(rateArr, monthKeys, C)}
    ${hasPartial ? '<p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 8px">* partial month</p>' : ''}
    ${isMobile ? '<p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 6px">Tap legend to show income / expenses</p>' : ''}
    <div class="chart-wrap">
      <div class="chart-container" style="height:280px"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const nonNullRates = rateArr.filter(r => r !== null);
  const avgRate = nonNullRates.length
    ? nonNullRates.reduce((s, r) => s + r, 0) / nonNullRates.length
    : null;

  console.log(`[insight-20] months=${monthKeys.length}, avg_rate=${avgRate !== null ? avgRate.toFixed(1) : 'N/A'}%`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           'Income',
          type:            'bar',
          data:            incomeArr,
          backgroundColor: 'rgba(52,211,153,0.5)',
          borderRadius:    3,
          yAxisID:         'y',
          order:           2,
          hidden:          isMobile,
        },
        {
          label:           'Expenses',
          type:            'bar',
          data:            expenseArr,
          backgroundColor: 'rgba(248,113,113,0.5)',
          borderRadius:    3,
          yAxisID:         'y',
          order:           2,
          hidden:          isMobile,
        },
        {
          label:            'Savings %',
          type:             'line',
          data:             rateArr,
          borderColor:      '#f59e0b',
          borderWidth:      2.5,
          pointRadius:      5,
          pointHoverRadius: 7,
          fill:             false,
          tension:          0.3,
          spanGaps:         false,
          yAxisID:          'y2',
          order:            1,
        },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}
