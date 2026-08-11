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
  const netArr     = [];
  const partial    = [];

  for (const mk of monthKeys) {
    const isPartial = mk === curYYYYMM;
    partial.push(isPartial);

    const inTxs  = inByMonth.get(mk)  || [];
    const outTxs = outByMonth.get(mk) || [];

    // Partial month: only count txs up to today
    const filterPartial = arr => isPartial
      ? arr.filter(t => {
          const d = new Date(t.tx_date_time);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate()) <= todayLocal;
        })
      : arr;

    const inc = sumAmountBase(filterPartial(inTxs));
    const exp = sumAmountBase(filterPartial(outTxs));
    incomeArr.push(inc);
    expenseArr.push(exp);
    netArr.push(inc - exp);
  }

  return { incomeArr, expenseArr, netArr, partial };
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C, isMobile) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { ...base.plugins.legend, display: true },
      tooltip: {
        ...base.plugins.tooltip,
        callbacks: {
          ...base.plugins.tooltip.callbacks,
          afterBody: tooltipItems => {
            const incomeItem = tooltipItems.find(t => t.datasetIndex === 0);
            const netItem    = tooltipItems.find(t => t.datasetIndex === 2);
            if (!incomeItem || !netItem) return [];
            const inc  = incomeItem.parsed.y || 0;
            const net  = netItem.parsed.y    || 0;
            if (inc <= 0) return [];
            const rate = Math.round(net / inc * 100);
            return [`  Savings rate: ${rate}%`];
          },
        },
      },
    },
    scales: {
      ...base.scales,
      x: {
        ...base.scales.x,
        stacked: false,
        ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: isMobile ? 4 : 6 },
      },
      y: { ...base.scales.y, stacked: false },
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-18] container not found:', containerId);
    return null;
  }

  const monthKeys                       = monthRange(from, to);
  const { incomeArr, expenseArr, netArr, partial } = _buildMonthly(txs, monthKeys);

  const totalIncome  = incomeArr.reduce((s, v) => s + v, 0);
  const totalExpense = expenseArr.reduce((s, v) => s + v, 0);
  const totalNet     = totalIncome - totalExpense;

  // Avg savings rate across months where income > 0
  const savingsRates = incomeArr.map((inc, i) => inc > 0 ? (netArr[i] / inc) * 100 : null).filter(r => r !== null);
  const avgRate      = savingsRates.length
    ? Math.round(savingsRates.reduce((s, r) => s + r, 0) / savingsRates.length)
    : null;

  const fmt      = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const netClass = totalNet >= 0 ? 'positive' : 'negative';

  const labels   = monthKeys.map((mk, i) => fmtMonthKey(mk) + (partial[i] ? '*' : ''));
  const hasPartial = partial.some(Boolean);

  const C        = getCssColors();
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  // Group all txs by month key for drill access
  const inByMonth  = groupByMonth(txs.filter(t => t.tx_type === 'money-in'));
  const outByMonth = groupByMonth(txs.filter(t => t.tx_type === 'money-out'));

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total income</p>
        <p class="stat-card-value positive">${esc(fmt(totalIncome))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Total expenses</p>
        <p class="stat-card-value negative">${esc(fmt(totalExpense))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Net</p>
        <p class="stat-card-value ${netClass}">${esc(fmt(totalNet))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg savings rate</p>
        <p class="stat-card-value${avgRate !== null && avgRate >= 0 ? ' positive' : ''}">${esc(avgRate !== null ? avgRate + '%' : 'N/A')}</p>
      </div>
    </div>
    ${hasPartial ? '<p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 8px">* partial month</p>' : ''}
    <p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 8px;text-align:center">Tap a bar to see monthly breakdown</p>
    <div class="chart-wrap">
      <div class="chart-container" style="height:280px"><canvas></canvas></div>
    </div>
    <div id="dash18-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = container.querySelector('canvas');
  const drillEl = container.querySelector('#dash18-drill');
  if (!canvas) return null;

  console.log(`[insight-18] months=${monthKeys.length}, income=${totalIncome.toFixed(0)}, expense=${totalExpense.toFixed(0)}, net=${totalNet.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           'Income',
          type:            'bar',
          data:            incomeArr,
          backgroundColor: 'rgba(52,211,153,0.8)',
          borderRadius:    3,
          order:           2,
        },
        {
          label:           'Expenses',
          type:            'bar',
          data:            expenseArr,
          backgroundColor: 'rgba(248,113,113,0.8)',
          borderRadius:    3,
          order:           2,
        },
        {
          label:        'Net',
          type:         'line',
          data:         netArr,
          borderColor:  '#f59e0b',
          borderWidth:  2,
          pointRadius:  4,
          pointHoverRadius: 6,
          fill:         false,
          tension:      0.3,
          order:        1,
        },
      ],
    },
    options: {
      ..._buildChartOptions(sym, C, isMobile),
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const idx = elements[0].index;
        const mk  = monthKeys[idx];
        if (!mk) return;

        const monthIn  = inByMonth.get(mk)  || [];
        const monthOut = outByMonth.get(mk) || [];

        const fmtV = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const thS  = `padding:8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;white-space:nowrap`;
        const tdS  = `padding:8px;font-size:var(--text-sm);border-bottom:1px solid var(--hair)`;

        // Top income by counterparty
        const incMap = new Map();
        for (const t of monthIn) {
          const k = t.counterparty_name || '(unknown)';
          incMap.set(k, (incMap.get(k) || 0) + sumAmountBase([t]));
        }
        const incRows = [...incMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([cp, v]) => `<tr><td style="${tdS}">${esc(cp)}</td><td style="${tdS};text-align:right;white-space:nowrap" class="positive">${esc(fmtV(v))}</td></tr>`)
          .join('');

        // Top expenses by major category
        const expMap = new Map();
        for (const t of monthOut) {
          const k = t.major_category || 'Uncategorised';
          expMap.set(k, (expMap.get(k) || 0) + sumAmountBase([t]));
        }
        const expRows = [...expMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([cat, v]) => `<tr><td style="${tdS}">${esc(cat)}</td><td style="${tdS};text-align:right;white-space:nowrap" class="negative">${esc(fmtV(v))}</td></tr>`)
          .join('');

        drillEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(labels[idx])}</h3>
            <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div>
              <p style="font-size:var(--text-xs);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">Income sources</p>
              <table style="width:100%;border-collapse:collapse">
                <thead><tr style="border-bottom:1px solid var(--hair)">
                  <th style="${thS};text-align:left">From</th><th style="${thS};text-align:right">Amount</th>
                </tr></thead>
                <tbody>${incRows || `<tr><td colspan="2" style="padding:8px;color:var(--muted)">No income</td></tr>`}</tbody>
              </table>
            </div>
            <div>
              <p style="font-size:var(--text-xs);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">Expenses by category</p>
              <table style="width:100%;border-collapse:collapse">
                <thead><tr style="border-bottom:1px solid var(--hair)">
                  <th style="${thS};text-align:left">Category</th><th style="${thS};text-align:right">Amount</th>
                </tr></thead>
                <tbody>${expRows || `<tr><td colspan="2" style="padding:8px;color:var(--muted)">No expenses</td></tr>`}</tbody>
              </table>
            </div>
          </div>`;
        drillEl.hidden = false;
        drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
        drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
  });
}
