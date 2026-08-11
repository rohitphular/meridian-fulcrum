/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, computeDailyTotalAssets,
  getCssColors, baseChartOptions, fmtMonthKey, buildPalette,
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

// ── Monthly balance computation ───────────────────────────────────────────────
// One computeDailyTotalAssets pass per liability account; displayed as positive.

function _buildMonthlyBalances(liabAccounts, monthKeys) {
  if (!monthKeys.length || !liabAccounts.length) return {};
  const from = _monthStart(monthKeys[0]);
  const to   = _monthEnd(monthKeys[monthKeys.length - 1]);
  const result = {};
  for (const acc of liabAccounts) {
    const daily = computeDailyTotalAssets([acc], state.transactions, from, to);
    result[acc.id] = monthKeys.map(mk => {
      const dayIdx = Math.round((_monthEnd(mk) - from) / 86400000);
      const raw    = daily[Math.min(dayIdx, daily.length - 1)] || 0;
      return Math.abs(raw);
    });
  }
  return result;
}

// ── Projected payoff ──────────────────────────────────────────────────────────
// Mean month-over-month balance reduction across last 3 months.

function _projectPayoff(balances) {
  const n = balances.length;
  if (n < 2) return null;
  const start = Math.max(0, n - 3);
  let total = 0;
  let count = 0;
  for (let i = start; i < n - 1; i++) {
    const reduction = balances[i] - balances[i + 1];
    if (reduction > 0) { total += reduction; count++; }
  }
  if (!count) return null;
  const avg     = total / count;
  const current = balances[n - 1];
  if (current <= 0) return { months: 0 };
  return { months: Math.ceil(current / avg) };
}

function _payoffDateStr(n) {
  const now = new Date();
  const d   = new Date(now.getFullYear(), now.getMonth() + n, 1);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

// ── Progress bar HTML ─────────────────────────────────────────────────────────

function _progressHtml(acc, balances, sym) {
  const current    = balances.length ? balances[balances.length - 1] : 0;
  const openingRaw = parseFloat(acc.opening_value);
  const opening    = isNaN(openingRaw) ? 0 : Math.abs(openingRaw);

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  let pctLabel, fillPct;
  if (opening > 0) {
    const paid = Math.max(0, Math.min(100, (1 - current / opening) * 100));
    pctLabel = `${Math.round(paid)}% paid`;
    fillPct  = paid.toFixed(1);
  } else {
    pctLabel = '% paid: N/A';
    fillPct  = 0;
  }

  let metaText;
  if (current <= 0) {
    metaText = 'Fully paid off';
  } else {
    const proj = _projectPayoff(balances);
    if (proj && proj.months > 0) {
      metaText = `${fmt(current)} remaining · ~${proj.months} months to clear (${_payoffDateStr(proj.months)})`;
    } else {
      metaText = `${fmt(current)} remaining`;
    }
  }

  return `
    <div style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:var(--text-sm);font-weight:600">${esc(acc.name)}</span>
        <span style="font-size:var(--text-xs);color:var(--muted)">${esc(pctLabel)}</span>
      </div>
      <div style="height:8px;border-radius:4px;background:var(--hair);overflow:hidden">
        <div style="height:100%;width:${fillPct}%;background:var(--ember);border-radius:4px;transition:width 0.4s ease"></div>
      </div>
      <div style="font-size:var(--text-xs);color:var(--muted);margin-top:4px">${esc(metaText)}</div>
    </div>`;
}

// ── Chart options ─────────────────────────────────────────────────────────────

function _buildChartOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    plugins: {
      ...base.plugins,
      legend: {
        ...base.plugins.legend,
        display: true,
        position: 'bottom',
        labels: { ...base.plugins.legend.labels, boxWidth: 12, padding: 12 },
      },
    },
    scales: {
      ...base.scales,
      x: {
        ...base.scales.x,
        ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 6 },
      },
      y: { ...base.scales.y, min: 0 },
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { accounts, from, to, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-17] container not found:', containerId);
    return null;
  }

  const liabAccounts   = accounts.filter(a => a.is_active && a.type === 'liability');

  if (!liabAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active liability accounts found.</p></div>`;
    return null;
  }

  const monthKeys   = monthRange(from, to);
  const allBalances = _buildMonthlyBalances(liabAccounts, monthKeys);
  const labels      = monthKeys.map(fmtMonthKey);

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const totalCurrent = liabAccounts.reduce((s, a) => {
    const b = allBalances[a.id];
    return s + (b ? (b[b.length - 1] || 0) : 0);
  }, 0);
  const totalOpening = liabAccounts.reduce((s, a) => {
    const v = parseFloat(a.opening_value);
    return s + (isNaN(v) ? 0 : Math.abs(v));
  }, 0);
  const overallPaid = totalOpening > 0
    ? Math.max(0, Math.min(100, (1 - totalCurrent / totalOpening) * 100))
    : null;

  const C       = getCssColors();
  const palette = buildPalette(C);

  const MAX_VISIBLE = 6;

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Outstanding</p>
        <p class="stat-card-value negative">${esc(fmt(totalCurrent))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Started with</p>
        <p class="stat-card-value">${esc(totalOpening > 0 ? fmt(totalOpening) : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Overall paid</p>
        <p class="stat-card-value${overallPaid !== null ? ' positive' : ''}">${esc(overallPaid !== null ? Math.round(overallPaid) + '%' : 'N/A')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Accounts</p>
        <p class="stat-card-value">${esc(String(liabAccounts.length))}</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container" style="height:260px"><canvas></canvas></div>
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--hair)">
      <p style="font-size:var(--text-sm);font-weight:600;margin:0 0 16px">Paydown Progress</p>
      ${liabAccounts.map(a => _progressHtml(a, allBalances[a.id] || [], sym)).join('')}
    </div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  console.log(`[insight-17] liab_accounts=${liabAccounts.length}, total_outstanding=${totalCurrent.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: liabAccounts.map((acc, i) => ({
        label:            acc.name.length > 16 ? acc.name.slice(0, 15) + '…' : acc.name,
        data:             allBalances[acc.id] || Array(labels.length).fill(0),
        borderColor:      palette[i % palette.length],
        backgroundColor:  palette[i % palette.length] + '22',
        tension:          0.3,
        pointRadius:      4,
        pointHoverRadius: 6,
        hidden:           i >= MAX_VISIBLE,
      })),
    },
    options: _buildChartOptions(sym, C),
  });
}
