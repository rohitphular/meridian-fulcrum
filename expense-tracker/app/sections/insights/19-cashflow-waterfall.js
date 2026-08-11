/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  computeDailyTotalAssets, sumAmountBase,
  getCssColors, baseChartOptions, renderDrillTxTable,
} from './insight-utils.js';

const MAX_CATS = 10;

// ── Starting balance ──────────────────────────────────────────────────────────
// Sum of all active accounts at end of the day before the first of the month.

function _startBalance(accounts, from) {
  const active = accounts.filter(a => a.is_active);
  if (!active.length) return 0;
  // Last day of previous month = day before the first of `from`'s month
  const prevEnd = new Date(from.getFullYear(), from.getMonth(), 0);
  if (prevEnd < new Date(2000, 0, 1)) return 0; // guard against very early dates
  const daily = computeDailyTotalAssets(active, state.transactions, prevEnd, prevEnd);
  return daily[0] || 0;
}

// ── Expense grouping ──────────────────────────────────────────────────────────

function _groupExpenses(outTxs) {
  const catMap = new Map();
  for (const tx of outTxs) {
    const cat = tx.major_category || 'Uncategorised';
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(tx);
  }
  const sorted = [...catMap.entries()]
    .map(([cat, txs]) => ({ cat, txs, amount: sumAmountBase(txs) }))
    .sort((a, b) => b.amount - a.amount);

  const top  = sorted.slice(0, MAX_CATS);
  const rest = sorted.slice(MAX_CATS);
  if (rest.length) {
    top.push({
      cat: 'Other expenses',
      txs: rest.flatMap(r => r.txs),
      amount: rest.reduce((s, r) => s + r.amount, 0),
    });
  }
  return top; // [{ cat, txs, amount }, ...]
}

// ── Waterfall segments ────────────────────────────────────────────────────────

function _buildWaterfall(txs, accounts, from, C) {
  const startBalance = _startBalance(accounts, from);

  const inTxs      = txs.filter(t => t.tx_type === 'money-in');
  const outTxs     = txs.filter(t => t.tx_type === 'money-out');
  const xferTxs    = txs.filter(t => t.tx_type === 'money-transfer');

  const income      = sumAmountBase(inTxs);
  const expGroups   = _groupExpenses(outTxs);
  // Net transfer effect: positive = net inflow from external accounts, negative = net outflow.
  // Internal transfers (both sides tracked) cancel out to zero here because amount_base is signed.
  const netTransfer = sumAmountBase(xferTxs);

  const GREEN  = 'rgba(52,211,153,0.85)';
  const BLUE   = 'rgba(96,165,250,0.85)'; // transfers

  const labels     = [];
  const baseVals   = [];
  const visVals    = [];
  const barColors  = [];

  let rt = startBalance; // running total

  // Opening
  labels.push('Opening'); baseVals.push(0); visVals.push(startBalance); barColors.push(C.teal);
  rt = startBalance;

  // Income
  labels.push('Income'); baseVals.push(rt); visVals.push(income); barColors.push(GREEN);
  rt += income;

  // Expense categories (negative visible values float the bar downward)
  for (const { cat, amount: exp } of expGroups) {
    labels.push(cat); baseVals.push(rt); visVals.push(-exp); barColors.push(C.ember);
    rt -= exp;
  }

  // Net transfers (only shown when non-zero)
  if (Math.round(Math.abs(netTransfer)) > 0) {
    labels.push('Transfers'); baseVals.push(rt); visVals.push(netTransfer);
    barColors.push(netTransfer >= 0 ? BLUE : C.muted);
    rt += netTransfer;
  }

  // Closing
  const closing = rt;
  labels.push('Closing'); baseVals.push(0); visVals.push(closing);
  barColors.push(closing >= 0 ? C.teal : C.ember);

  return { labels, baseVals, visVals, barColors, income, expGroups, netTransfer, closing, startBalance };
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: {
      ...base.plugins,
      legend: { display: false },
      tooltip: {
        ...base.plugins.tooltip,
        callbacks: {
          title: ctx => ctx[0]?.label || '',
          label: ctx => {
            // Only show tooltip for the visible dataset (index 1), not the invisible base
            if (ctx.datasetIndex === 0) return null;
            return `  ${sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
          },
        },
      },
    },
    scales: {
      ...base.scales,
      x: {
        ...base.scales.x,
        stacked: true,
        ticks: { ...base.scales.x.ticks, maxRotation: 30, font: { size: 11 } },
      },
      y: {
        ...base.scales.y,
        stacked: false,
      },
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-19] container not found:', containerId);
    return null;
  }

  const C = getCssColors();
  const { labels, baseVals, visVals, barColors, income, expGroups, closing, startBalance }
    = _buildWaterfall(txs, accounts, from, C);

  const totalExpense = expGroups.reduce((s, g) => s + g.amount, 0);
  const net          = income - totalExpense;
  const netClass     = net >= 0 ? 'positive' : 'negative';

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtSigned = v => (v >= 0 ? '+' : '−') + ' ' + fmt(Math.abs(v));

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Opening balance</p>
        <p class="stat-card-value">${esc(fmt(startBalance))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Total income</p>
        <p class="stat-card-value positive">${esc(fmt(income))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Total expenses</p>
        <p class="stat-card-value negative">${esc(fmt(totalExpense))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Closing balance</p>
        <p class="stat-card-value ${closing >= 0 ? 'positive' : 'negative'}">${esc(fmt(closing))}</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container" style="height:300px"><canvas></canvas></div>
    </div>
    <p style="font-size:var(--text-xs);color:var(--muted);margin:4px 0 0;text-align:center">Tap an expense bar to see transactions</p>
    <div id="dash19-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = container.querySelector('canvas');
  const drillEl = container.querySelector('#dash19-drill');
  if (!canvas) return null;

  // Map label index → expGroup for drill panel. Expense bars begin at index 2.
  const EXP_OFFSET = 2; // Opening(0) + Income(1)

  console.log(`[insight-19] start=${startBalance.toFixed(0)}, income=${income.toFixed(0)}, expense=${totalExpense.toFixed(0)}, closing=${closing.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           '',
          data:            baseVals,
          backgroundColor: 'rgba(0,0,0,0)',
          stack:           'wf',
          borderWidth:     0,
        },
        {
          label:           'Amount',
          data:            visVals,
          backgroundColor: barColors,
          stack:           'wf',
          borderRadius:    4,
          borderSkipped:   false,
        },
      ],
    },
    options: {
      ..._buildChartOptions(sym, C),
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const barIdx = elements[0].index;
        const expIdx = barIdx - EXP_OFFSET;
        if (expIdx < 0 || expIdx >= expGroups.length) return; // Opening/Income/Transfers/Closing

        const { cat, txs: catTxs } = expGroups[expIdx];
        const sorted = [...catTxs].sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));
        const total  = sumAmountBase(sorted);
        const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

        drillEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(cat)}</h3>
            <div style="display:flex;gap:8px;font-size:var(--text-xs);color:var(--muted)">
              <span>${esc(String(sorted.length))} txs · ${esc(fmt(total))}</span>
              <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
            </div>
          </div>
          ${renderDrillTxTable(sorted, sym)}`;
        drillEl.hidden = false;
        drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
        drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
  });
}
