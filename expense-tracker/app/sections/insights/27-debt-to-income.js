/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, groupByMonth, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

// ── Month helpers ─────────────────────────────────────────────────────────────

function _monthEnd(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo, 0);
}

function _monthStart(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo - 1, 1);
}

// ── DTI helpers ───────────────────────────────────────────────────────────────

function _dtiColor(dti, C) {
  if (dti < 20) return '#34d399';
  if (dti < 36) return C.teal;
  if (dti < 50) return '#f59e0b';
  return C.ember;
}

function _dtiStatus(dti) {
  if (dti < 20) return 'Excellent';
  if (dti < 36) return 'Good';
  if (dti < 50) return 'Caution';
  return 'High risk';
}

// ── Reference line plugin (draws dashed horizontal at 36%) ────────────────────

function _refLinePlugin(C) {
  return {
    id: 'dtiRefLine',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales.y) return;
      const y = scales.y.getPixelForValue(36);
      if (y < chartArea.top || y > chartArea.bottom) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#f59e0b99';
      ctx.lineWidth   = 1.5;
      ctx.moveTo(chartArea.left,  y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.restore();
    },
  };
}

// ── Monthly DTI trend ─────────────────────────────────────────────────────────

function _buildMonthlyDTI(liabAccts, monthKeys, annualisedIncome) {
  if (!monthKeys.length || annualisedIncome <= 0) return monthKeys.map(() => null);
  if (!liabAccts.length) return monthKeys.map(() => 0);

  const from  = _monthStart(monthKeys[0]);
  const to    = _monthEnd(monthKeys[monthKeys.length - 1]);
  const daily = computeDailyTotalAssets(liabAccts, state.transactions, from, to);

  return monthKeys.map(mk => {
    const dayIdx = Math.round((_monthEnd(mk) - from) / 86400000);
    const liab   = Math.abs(daily[Math.min(dayIdx, daily.length - 1)] || 0);
    return (liab / annualisedIncome) * 100;
  });
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function _proxy(charts) {
  return { destroy() { charts.forEach(c => { try { c?.destroy(); } catch (_e) {} }); } };
}

// ── Accounts tab ──────────────────────────────────────────────────────────────

function _renderAccounts(container, { txs, accounts, from, to, sym }, C) {
  const liabAccts      = accounts.filter(a => a.is_active && a.type === 'liability');
  const monthKeys      = monthRange(from, to);

  // Current total debt
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const totalDebt  = liabAccts.length
    ? Math.abs(computeDailyTotalAssets(liabAccts, state.transactions, todayLocal, todayLocal)[0] || 0)
    : 0;

  // Monthly income — exclude current (partial) month from average
  const curYYYYMM    = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}`;
  const inByMonth    = groupByMonth(txs.filter(t => t.tx_type === 'money-in'));
  const completeMKs  = monthKeys.filter(mk => mk !== curYYYYMM);
  const avgMonths    = completeMKs.length || monthKeys.length;
  const totalIncome  = (completeMKs.length ? completeMKs : monthKeys)
    .reduce((s, mk) => s + sumAmountBase(inByMonth.get(mk) || []), 0);
  const monthlyIncome    = avgMonths > 0 ? totalIncome / avgMonths : 0;
  const annualisedIncome = monthlyIncome * 12;

  const hasDTI   = annualisedIncome > 0;
  const dtiRatio = hasDTI ? (totalDebt / annualisedIncome) * 100 : null;
  const dtiVal   = dtiRatio !== null ? Math.min(dtiRatio, 100) : 0;
  const gaugeColor = dtiRatio !== null ? _dtiColor(dtiRatio, C) : C.muted;
  const statusText = dtiRatio !== null
    ? (totalDebt === 0 ? 'Debt-free' : _dtiStatus(dtiRatio))
    : 'N/A';

  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const dtiStr = dtiRatio !== null ? dtiRatio.toFixed(1) + '%' : 'N/A';

  // Monthly DTI trend
  const monthlyDTI = _buildMonthlyDTI(liabAccts, monthKeys, annualisedIncome);

  container.innerHTML = `
    <div style="position:relative;height:200px;margin-bottom:8px">
      <canvas id="dash27-gauge" style="width:100%;height:100%"></canvas>
      <div style="position:absolute;left:50%;bottom:12%;transform:translateX(-50%);text-align:center;pointer-events:none">
        <div style="font-size:var(--text-xl);font-weight:700;color:${gaugeColor}">${esc(dtiStr)}</div>
        <div style="font-size:var(--text-sm);color:var(--muted)">${esc(statusText)}</div>
      </div>
    </div>
    ${!hasDTI ? `<p style="font-size:var(--text-xs);color:var(--muted);text-align:center;margin:0 0 12px">No income data in period — DTI unavailable.</p>` : ''}
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total debt</p>
        <p class="stat-card-value negative">${esc(fmt(totalDebt))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Monthly income (avg)</p>
        <p class="stat-card-value">${esc(monthlyIncome > 0 ? fmt(monthlyIncome) : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Annualised income</p>
        <p class="stat-card-value">${esc(annualisedIncome > 0 ? fmt(annualisedIncome) : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">DTI ratio</p>
        <p class="stat-card-value" style="color:${gaugeColor}">${esc(dtiStr)}</p>
      </div>
    </div>
    <div class="chart-container" style="height:220px;margin-top:16px">
      <canvas id="dash27-trend" style="width:100%;height:100%"></canvas>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:var(--text-xs);color:var(--muted)">
      <span style="display:inline-block;width:18px;height:2px;background:#f59e0b;border-top:1px dashed #f59e0b"></span>
      <span>36% healthy threshold</span>
    </div>`;

  const gaugeCanvas = el('dash27-gauge');
  const trendCanvas = el('dash27-trend');

  const gaugeChart = gaugeCanvas ? new Chart(gaugeCanvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data:            [dtiVal, 100 - dtiVal],
        backgroundColor: [gaugeColor, C.hair],
        borderWidth:     0,
      }],
    },
    options: {
      responsive:        true,
      maintainAspectRatio: false,
      rotation:          -90,
      circumference:     180,
      cutout:            '75%',
      plugins: {
        legend:  { display: false },
        tooltip: { enabled: false },
      },
    },
  }) : null;

  const base = baseChartOptions(sym, C);
  const trendChart = trendCanvas ? new Chart(trendCanvas, {
    type: 'line',
    data: {
      labels:   monthKeys.map(fmtMonthKey),
      datasets: [{
        label:            'DTI %',
        data:             monthlyDTI,
        borderColor:      '#f59e0b',
        backgroundColor:  '#f59e0b22',
        fill:             true,
        tension:          0.3,
        pointRadius:      4,
        pointHoverRadius: 6,
        spanGaps:         false,
      }],
    },
    options: {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: false },
      },
      scales: {
        ...base.scales,
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 6 } },
        y: {
          ...base.scales.y,
          min: 0,
          ticks: { color: C.muted, callback: v => `${Math.round(v)}%` },
        },
      },
    },
    plugins: [_refLinePlugin(C)],
  }) : null;

  return _proxy([gaugeChart, trendChart]);
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function _renderTransactions(container, { txs, from, to, sym }, C) {
  const monthKeys   = monthRange(from, to);
  const inByMonth   = groupByMonth(txs.filter(t => t.tx_type === 'money-in'));
  const monthlyInc  = monthKeys.map(mk => sumAmountBase(inByMonth.get(mk) || []));
  const totalIncome = monthlyInc.reduce((s, v) => s + v, 0);
  const avgMonthly  = monthKeys.length ? totalIncome / monthKeys.length : 0;
  let peakIdx = 0;
  monthlyInc.forEach((v, i) => { if (v > monthlyInc[peakIdx]) peakIdx = i; });

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total income</p>
        <p class="stat-card-value positive">${esc(fmt(totalIncome))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Avg monthly</p>
        <p class="stat-card-value">${esc(fmt(avgMonthly))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Annualised</p>
        <p class="stat-card-value">${esc(fmt(avgMonthly * 12))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Peak month</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(monthKeys.length ? fmtMonthKey(monthKeys[peakIdx]) : '—')}</p>
        <p class="stat-card-sub">${esc(monthKeys.length ? fmt(monthlyInc[peakIdx]) : '')}</p>
      </div>
    </div>
    <div class="chart-container" style="height:240px;margin-top:8px">
      <canvas id="dash27-income" style="width:100%;height:100%"></canvas>
    </div>`;

  const canvas = el('dash27-income');
  if (!canvas) return _proxy([]);

  const base = baseChartOptions(sym, C);
  return _proxy([new Chart(canvas, {
    type: 'bar',
    data: {
      labels:   monthKeys.map(fmtMonthKey),
      datasets: [{
        label:           'Income',
        data:            monthlyInc,
        backgroundColor: 'rgba(52,211,153,0.75)',
        borderRadius:    3,
      }],
    },
    options: {
      ...base,
      plugins: { ...base.plugins, legend: { display: false } },
      scales: {
        ...base.scales,
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 6 } },
      },
    },
  })]);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, options) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-27] container not found:', containerId);
    return _proxy([]);
  }

  const C = getCssColors();

  if (options.tab === 'transactions') {
    return _renderTransactions(container, options, C);
  }
  return _renderAccounts(container, options, C);
}
