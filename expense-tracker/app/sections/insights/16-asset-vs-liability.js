/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, computeDailyTotalAssets,
  getCssColors, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _monthEnd(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo, 0);
}

function _monthStart(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo - 1, 1);
}

// ── Monthly asset / liability computation ─────────────────────────────────────

function _buildMonthly(assetAccts, liabAccts, monthKeys) {
  if (!monthKeys.length) return { assets: [], liabs: [] };

  const from = _monthStart(monthKeys[0]);
  const to   = _monthEnd(monthKeys[monthKeys.length - 1]);

  const dailyAssets = assetAccts.length
    ? computeDailyTotalAssets(assetAccts, state.transactions, from, to)
    : Array(Math.round((to - from) / 86400000) + 1).fill(0);

  const dailyLiabs = liabAccts.length
    ? computeDailyTotalAssets(liabAccts, state.transactions, from, to)
    : Array(dailyAssets.length).fill(0);

  const sample = (daily, mk) => {
    const dayIdx = Math.round((_monthEnd(mk) - from) / 86400000);
    return daily[Math.min(dayIdx, daily.length - 1)] || 0;
  };

  return {
    assets: monthKeys.map(mk => sample(dailyAssets, mk)),
    liabs:  monthKeys.map(mk => Math.abs(sample(dailyLiabs, mk))),
  };
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: true } },
    scales:  { ...base.scales, x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 6 } } },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { accounts, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-16] container not found:', containerId);
    return null;
  }

  const allActive      = accounts.filter(a => a.is_active);

  if (!allActive.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active accounts found.</p></div>`;
    return null;
  }

  const assetAccts = allActive.filter(a => a.type !== 'liability');
  const liabAccts  = allActive.filter(a => a.type === 'liability');

  const monthKeys         = monthRange(from, to);
  const { assets, liabs } = _buildMonthly(assetAccts, liabAccts, monthKeys);

  const currentAssets = assets[assets.length - 1] || 0;
  const currentLiabs  = liabs[liabs.length  - 1] || 0;
  const currentNet    = currentAssets - currentLiabs;
  const firstNet      = (assets[0] || 0) - (liabs[0] || 0);
  const netChange     = currentNet - firstNet;

  const fmt      = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const netClass = currentNet >= 0 ? 'positive' : 'negative';
  const chgClass = netChange >= 0 ? 'positive' : 'negative';
  const chgArrow = netChange >= 0 ? '↑' : '↓';

  const C = getCssColors();

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total assets</p>
        <p class="stat-card-value positive">${esc(fmt(currentAssets))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Total liabilities</p>
        <p class="stat-card-value negative">${esc(fmt(currentLiabs))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Net worth</p>
        <p class="stat-card-value ${netClass}">${esc(fmt(currentNet))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Period Δ net</p>
        <p class="stat-card-value ${chgClass}">${chgArrow} ${esc(fmt(Math.abs(netChange)))}</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-16] assets=${currentAssets.toFixed(0)}, liabs=${currentLiabs.toFixed(0)}, net=${currentNet.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: monthKeys.map(fmtMonthKey),
      datasets: [
        {
          label:           'Total Assets',
          data:            assets,
          borderColor:     C.teal,
          backgroundColor: C.teal + '1a',
          fill:            true,
          tension:         0.3,
          pointRadius:     4,
          pointHoverRadius: 6,
        },
        {
          label:           'Total Liabilities',
          data:            liabs,
          borderColor:     C.ember,
          backgroundColor: C.ember + '1a',
          fill:            true,
          borderDash:      [4, 4],
          tension:         0.3,
          pointRadius:     4,
          pointHoverRadius: 6,
        },
      ],
    },
    options: _buildChartOptions(sym, C),
  });
}
