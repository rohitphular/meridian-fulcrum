/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, computeDailyTotalAssets, computeBalancesAt,
  getCssColors, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _monthEnd(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo, 0);  // last day of month
}

function _monthStart(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo - 1, 1);
}

// ── Monthly net worth computation ─────────────────────────────────────────────
// Passes all active accounts (assets + liabilities) to computeDailyTotalAssets.
// Asset accounts have positive opening_value; liability accounts have negative
// opening_value (representing debt). The sum is net worth directly.

function _buildMonthlyNetworth(allAccounts, monthKeys) {
  if (!monthKeys.length) return [];

  const from = _monthStart(monthKeys[0]);
  const to   = _monthEnd(monthKeys[monthKeys.length - 1]);

  const daily = computeDailyTotalAssets(allAccounts, state.transactions, from, to);

  return monthKeys.map(mk => {
    const dayIdx = Math.round((_monthEnd(mk) - from) / 86400000);
    return daily[Math.min(dayIdx, daily.length - 1)] || 0;
  });
}

// Net worth at a single month-end (used for 12-months-ago reference)
function _networthAtMonthEnd(allAccounts, yyyyMM) {
  const end   = _monthEnd(yyyyMM);
  const daily = computeDailyTotalAssets(allAccounts, state.transactions, end, end);
  return daily[0] || 0;
}

// ── Chart options (with zero-line grid) ───────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: { ...base.plugins, legend: { display: false } },
    scales: {
      ...base.scales,
      x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 6 } },
      y: {
        ...base.scales.y,
        grid: { color: ctx => ctx.tick.value === 0 ? C.ember + 'bb' : C.hair },
      },
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { accounts, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-14] container not found:', containerId);
    return null;
  }

  const allAccounts = accounts.filter(a => a.is_active);

  if (!allAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active accounts found.</p></div>`;
    return null;
  }

  const monthKeys    = monthRange(from, to);
  const networths    = _buildMonthlyNetworth(allAccounts, monthKeys);
  const current      = networths[networths.length - 1] || 0;
  const prevMonth    = networths.length >= 2 ? networths[networths.length - 2] : current;
  const periodStart  = networths[0] || 0;

  // 12-months-ago reference (independent of selected period)
  const today        = new Date();
  const yr12         = today.getFullYear();
  const mo12         = today.getMonth() - 11;   // negative months handled by Date
  const ref12Key     = `${new Date(yr12, mo12, 1).getFullYear()}-${String(new Date(yr12, mo12, 1).getMonth() + 1).padStart(2, '0')}`;
  const networth12mo = _networthAtMonthEnd(allAccounts, ref12Key);

  const fmt = v => {
    const abs = sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return v < 0 ? `−${abs}` : abs;
  };
  const delta = (v, positive) => {
    const cls   = positive ? 'positive' : 'negative';
    const arrow = positive ? '↑' : '↓';
    return `<span class="${cls}">${arrow} ${esc(sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }))}</span>`;
  };

  const momDelta   = current - prevMonth;
  const mom12Delta = current - networth12mo;
  const pct12      = networth12mo !== 0 ? ((mom12Delta / Math.abs(networth12mo)) * 100).toFixed(1) : null;

  const C = getCssColors();

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Net worth</p>
        <p class="stat-card-value ${current >= 0 ? 'positive' : 'negative'}">${esc(fmt(current))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Change this month</p>
        <p class="stat-card-value">${delta(momDelta, momDelta >= 0)}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">vs 12 months ago</p>
        <p class="stat-card-value">${delta(mom12Delta, mom12Delta >= 0)}</p>
        ${pct12 !== null ? `<p class="stat-card-sub">${esc(pct12)}%</p>` : ''}
      </div>
    </div>
    <p style="font-size:var(--text-xs);color:var(--muted);margin:4px 0 0;text-align:center">Tap a data point to see account balances at that month-end</p>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>
    <div id="dash14-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = container.querySelector('canvas');
  const drillEl = container.querySelector('#dash14-drill');
  if (!canvas) return null;

  console.log(`[insight-14] ${monthKeys.length} months, current=${current.toFixed(0)}, 12moRef=${networth12mo.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels:   monthKeys.map(fmtMonthKey),
      datasets: [{
        label:           'Net Worth',
        data:            networths,
        borderColor:     C.teal,
        backgroundColor: C.teal + '18',
        fill:            'origin',
        tension:         0.3,
        pointRadius:     6,
        pointHoverRadius: 8,
      }],
    },
    options: {
      ..._buildChartOptions(sym, C),
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const idx    = elements[0].index;
        const mk     = monthKeys[idx];
        const endDate = _monthEnd(mk);
        const balMap  = computeBalancesAt(allAccounts, state.transactions, endDate);

        const fmtV    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const thS     = `padding:8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;white-space:nowrap`;
        const tdS     = `padding:9px 8px;font-size:var(--text-sm);border-bottom:1px solid var(--hair)`;

        const accRows = allAccounts
          .map(a => ({ name: a.name, type: a.type, balance: balMap.get(a.id) || 0 }))
          .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
          .map(a => {
            const cls = a.balance >= 0 ? 'positive' : 'negative';
            return `<tr>
              <td style="${tdS}">${esc(a.name)}</td>
              <td style="${tdS};color:var(--muted)">${esc(a.type)}</td>
              <td style="${tdS};text-align:right;white-space:nowrap" class="${cls}">${esc(fmtV(a.balance))}</td>
            </tr>`;
          }).join('');

        drillEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">Account balances — ${esc(fmtMonthKey(mk))}</h3>
            <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
          </div>
          <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
            <table style="width:100%;border-collapse:collapse;min-width:280px">
              <thead>
                <tr style="border-bottom:2px solid var(--hair)">
                  <th style="${thS};text-align:left">Account</th>
                  <th style="${thS};text-align:left">Type</th>
                  <th style="${thS};text-align:right">Balance</th>
                </tr>
              </thead>
              <tbody>${accRows}</tbody>
            </table>
          </div>`;
        drillEl.hidden = false;
        drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
        drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
  });
}
