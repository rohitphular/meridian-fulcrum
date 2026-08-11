/* global Chart */
import { el, esc, toBase } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  filterTxByRange, groupByDay, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions, PREV_PERIOD_COLOR,
} from './insight-utils.js';

// ── Private helpers ───────────────────────────────────────────────────────────

function _buildCumulative(txs, monthFrom, daysInMonth, cutoffDay) {
  const byDay   = groupByDay(txs);
  const result  = [];
  let running   = 0;

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


function _fmtAmount(sym, value) {
  return esc(sym + Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }));
}

function _fmtDelta(sym, delta) {
  const sign = delta > 0 ? '+' : '';
  return esc(`${sign}${sym}${Math.abs(delta).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
}

function _lastNonNull(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  }
  return 0;
}

// ── Stat card builders ────────────────────────────────────────────────────────

function _txStatCards(sym, labelA, labelB, totalA, totalB, today, daysInMonthA, isCurrentMonth) {
  const delta   = totalA - totalB;
  const pct     = totalB !== 0 ? Math.abs(Math.round((delta / totalB) * 100)) : null;
  const deltaClass = delta <= 0 ? 'positive' : 'negative';
  const deltaArrow = delta <= 0 ? '↓' : '↑';
  const pctStr  = pct !== null ? ` (${pct}%)` : '';
  const deltaStr = `${deltaArrow} ${_fmtDelta(sym, delta)}${esc(pctStr)}`;

  const todayVal = isCurrentMonth
    ? `<p class="stat-card-value">${esc(String(today))}</p><p class="stat-card-sub">of ${esc(String(daysInMonthA))} days</p>`
    : `<p class="stat-card-value">—</p>`;

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelA)}</p>
        <p class="stat-card-value">${_fmtAmount(sym, totalA)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">${esc(labelB)}</p>
        <p class="stat-card-value">${_fmtAmount(sym, totalB)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Change</p>
        <p class="stat-card-value ${deltaClass}">${deltaStr}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Today</p>
        ${todayVal}
      </div>
    </div>`;
}

function _accountStatCards(sym, latestA, lastMonthEnd, assetCount) {
  const delta      = latestA - lastMonthEnd;
  const deltaClass = delta >= 0 ? 'positive' : 'negative';
  const deltaArrow = delta >= 0 ? '↑' : '↓';
  const pct        = lastMonthEnd !== 0 ? Math.abs(Math.round((delta / lastMonthEnd) * 100)) : null;
  const pctStr     = pct !== null ? ` (${pct}%)` : '';
  const deltaStr   = `${deltaArrow} ${_fmtDelta(sym, delta)}${esc(pctStr)}`;

  return `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Current assets</p>
        <p class="stat-card-value">${_fmtAmount(sym, latestA)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Last month end</p>
        <p class="stat-card-value">${_fmtAmount(sym, lastMonthEnd)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Change</p>
        <p class="stat-card-value ${deltaClass}">${deltaStr}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Asset accounts</p>
        <p class="stat-card-value">${esc(String(assetCount))}</p>
      </div>
    </div>`;
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { txs, from, to, sym }) {
  const today         = new Date();
  const todayDate     = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isCurrentMonth = from.getFullYear() === todayDate.getFullYear() &&
                         from.getMonth()    === todayDate.getMonth();

  // Period A bounds
  const daysInMonthA = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();

  // Period B: calendar month immediately before `from`
  const bFrom       = new Date(from.getFullYear(), from.getMonth() - 1, 1);
  const bTo         = new Date(from.getFullYear(), from.getMonth(), 0);
  const daysInMonthB = bTo.getDate();

  const maxDays = Math.max(daysInMonthA, daysInMonthB);

  // Filter to money-out only
  const moneyOutA = txs.filter(t => t.tx_type === 'money-out');
  const moneyOutB = filterTxByRange(
    state.transactions.filter(t => t.tx_type === 'money-out'),
    bFrom, bTo
  );

  if (!moneyOutA.length) {
    container.innerHTML = `
      <div class="chart-wrap">
        <p class="chart-empty">No spend data for this period.</p>
      </div>`;
    return null;
  }

  const cutoffDay    = isCurrentMonth ? todayDate.getDate() : null;
  const dataA        = _buildCumulative(moneyOutA, from, daysInMonthA, cutoffDay);
  const dataB        = _buildCumulative(moneyOutB, bFrom, daysInMonthB, null);

  // Pad both arrays to maxDays with null
  while (dataA.length < maxDays) dataA.push(null);
  while (dataB.length < maxDays) dataB.push(null);

  const totalA = sumAmountBase(moneyOutA);
  const totalB = sumAmountBase(moneyOutB);

  const labelA = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const labelB = bFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const labels = Array.from({ length: maxDays }, (_, i) => String(i + 1));

  const statHtml = _txStatCards(sym, labelA, labelB, totalA, totalB, todayDate.getDate(), daysInMonthA, isCurrentMonth);

  container.innerHTML = `
    ${statHtml}
    <div class="chart-wrap">
      <div class="chart-container"><canvas id="mom-canvas"></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C    = getCssColors();
  const base = baseChartOptions(sym, C);
  const options = {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales,  x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 7 } } },
  };

  console.log(`[insight-01] rendering transactions tab — periodA=${labelA}, periodB=${labelB}, daysA=${daysInMonthA}, daysB=${daysInMonthB}, maxDays=${maxDays}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:       labelA,
          data:        dataA,
          borderColor: C.teal,
          fill:        false,
          tension:     0.3,
          pointRadius: 3,
          spanGaps:    false,
        },
        {
          label:       labelB,
          data:        dataB,
          borderColor: PREV_PERIOD_COLOR,
          fill:        false,
          tension:     0.3,
          pointRadius: 2,
          borderDash:  [4, 4],
          spanGaps:    false,
        },
      ],
    },
    options,
  });
}

// ── Accounts tab ──────────────────────────────────────────────────────────────

function _renderAccounts(container, { accounts, from, to, sym }) {
  const assetAccounts  = accounts.filter(a => a.is_active && a.type !== 'liability');

  if (!assetAccounts.length) {
    container.innerHTML = `
      <div class="chart-wrap">
        <p class="chart-empty">No active asset accounts found.</p>
      </div>`;
    return null;
  }

  const today      = new Date();
  const todayDate  = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isCurrentMonth = from.getFullYear() === todayDate.getFullYear() &&
                         from.getMonth()    === todayDate.getMonth();

  // Period A dimensions
  const daysInMonthA = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();

  // Period B: calendar month immediately before `from`
  const bFrom        = new Date(from.getFullYear(), from.getMonth() - 1, 1);
  const bTo          = new Date(from.getFullYear(), from.getMonth(), 0);
  const daysInMonthB = bTo.getDate();

  const maxDays = Math.max(daysInMonthA, daysInMonthB);

  // Compute daily totals for both periods using all transactions
  const allTxs = state.transactions;

  const dailyA = computeDailyTotalAssets(assetAccounts, allTxs, from, to);
  const dailyB = computeDailyTotalAssets(assetAccounts, allTxs, bFrom, bTo);

  // Build chart data arrays — null-out days after today for current month (Period A)
  const cutoffDay = isCurrentMonth ? todayDate.getDate() : null;
  const dataA = dailyA.map((v, i) => {
    const day = i + 1;
    return (cutoffDay !== null && day > cutoffDay) ? null : v;
  });
  const dataB = dailyB.slice();

  // Pad to maxDays
  while (dataA.length < maxDays) dataA.push(null);
  while (dataB.length < maxDays) dataB.push(null);

  const latestA     = _lastNonNull(dataA);
  const lastMonthEnd = _lastNonNull(dataB);

  const labelA = `Assets ${from.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  const labelB = `Assets ${bFrom.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  const labels = Array.from({ length: maxDays }, (_, i) => String(i + 1));

  const statHtml = _accountStatCards(sym, latestA, lastMonthEnd, assetAccounts.length);

  container.innerHTML = `
    ${statHtml}
    <div class="chart-wrap">
      <div class="chart-container"><canvas id="mom-canvas"></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  const C    = getCssColors();
  const base = baseChartOptions(sym, C);
  const options = {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales,  x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 7 } } },
  };

  console.log(`[insight-01] rendering accounts tab — periodA=${labelA}, periodB=${labelB}, assetAccounts=${assetAccounts.length}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:       labelA,
          data:        dataA,
          borderColor: C.teal,
          fill:        false,
          tension:     0.3,
          pointRadius: 3,
          spanGaps:    false,
        },
        {
          label:       labelB,
          data:        dataB,
          borderColor: PREV_PERIOD_COLOR,
          fill:        false,
          tension:     0.3,
          pointRadius: 2,
          borderDash:  [4, 4],
          spanGaps:    false,
        },
      ],
    },
    options,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, accounts, from, to, sym, tab }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-01] container not found:', containerId);
    return null;
  }

  if (tab === 'accounts') {
    return _renderAccounts(container, { accounts, from, to, sym });
  }

  return _renderTransactions(container, { txs, from, to, sym });
}
