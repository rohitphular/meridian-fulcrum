/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { computeBalancesAt, getCssColors, baseChartOptions } from './insight-utils.js';


// ── Section chart ─────────────────────────────────────────────────────────────

function _buildSectionOptions(sym, C) {
  const base = baseChartOptions(sym, C);
  return {
    ...base,
    indexAxis: 'y',
    plugins: { ...base.plugins, legend: { display: false } },
    scales: {
      ...base.scales,
      x: { ...base.scales.y },
      y: { ticks: { color: C.muted, font: { size: 12 } }, grid: { color: C.hair }, border: { display: false } },
    },
  };
}

function _renderSection(container, canvasId, rows, color, sym, C) {
  if (!rows.length) return null;

  const canvas = container.querySelector(`#${canvasId}`);
  if (!canvas) return null;

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels:   rows.map(r => r.name),
      datasets: [{ data: rows.map(r => Math.abs(r.balance)), backgroundColor: color, borderRadius: 4 }],
    },
    options: _buildSectionOptions(sym, C),
  });
}

// ── Multi-chart proxy ─────────────────────────────────────────────────────────
// The coordinator expects a single object with .destroy(). We wrap multiple
// Chart instances so the coordinator can destroy all of them on navigation.

function _proxy(charts) {
  return {
    destroy() {
      charts.forEach(c => { try { c?.destroy(); } catch (_) {} });
    },
  };
}

// ── Section HTML ──────────────────────────────────────────────────────────────

function _sectionHtml(id, title, rows, totalStr, noDataMsg) {
  if (!rows.length) return `<p style="font-size:var(--text-sm);color:var(--muted);margin:8px 0">${esc(noDataMsg)}</p>`;
  const h = Math.max(80, rows.length * 40 + 40);
  return `
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(title)}</h3>
        <span style="font-size:var(--text-sm);color:var(--muted)">${esc(totalStr)}</span>
      </div>
      <div class="chart-container" style="height:${h}px"><canvas id="${esc(id)}"></canvas></div>
    </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { accounts, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-15] container not found:', containerId);
    return null;
  }

  if (!state.accountSchema) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">Account schema not loaded — cannot classify liabilities vs assets. Try reloading the page.</p></div>`;
    return null;
  }

  const investmentTypes = new Set(['investment']);

  const active = accounts.filter(a => a.is_active);
  if (!active.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active accounts found.</p></div>`;
    return null;
  }

  // Single-pass balance computation for all active accounts
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const balanceMap = computeBalancesAt(active, state.transactions, todayLocal);
  const withBalance = active.map(a => ({ ...a, balance: balanceMap.get(a.id) || 0 }));

  // Partition
  const assets      = withBalance.filter(a => a.type !== 'liability' && !investmentTypes.has(a.type)).sort((a, b) => b.balance - a.balance);
  const liabilities = withBalance.filter(a => a.type === 'liability').sort((a, b) => a.balance - b.balance);  // most negative first
  const investments = withBalance.filter(a => investmentTypes.has(a.type)).sort((a, b) => b.balance - a.balance);

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + Math.abs(a.balance), 0);
  const totalInvestments = investments.reduce((s, a) => s + a.balance, 0);
  const netWorth         = totalAssets + totalInvestments - totalLiabilities;
  const netClass         = netWorth >= 0 ? 'positive' : 'negative';

  const C = getCssColors();

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Assets</p>
        <p class="stat-card-value positive">${esc(fmt(totalAssets))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Liabilities</p>
        <p class="stat-card-value negative">${esc(fmt(totalLiabilities))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Investments</p>
        <p class="stat-card-value">${esc(fmt(totalInvestments))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Net worth</p>
        <p class="stat-card-value ${netClass}">${esc(fmt(netWorth))}</p>
      </div>
    </div>
    ${_sectionHtml('dash15-assets',      'Assets',      assets,      fmt(totalAssets),      'No asset accounts.')}
    ${_sectionHtml('dash15-liabilities', 'Liabilities', liabilities, fmt(totalLiabilities), 'No liability accounts.')}
    ${investments.length ? _sectionHtml('dash15-investments', 'Investments', investments, fmt(totalInvestments), '') : ''}`;

  console.log(`[insight-15] assets=${assets.length}, liabilities=${liabilities.length}, investments=${investments.length}, net=${netWorth.toFixed(0)}`);

  const charts = [
    _renderSection(container, 'dash15-assets',      assets,      C.teal,                         sym, C),
    _renderSection(container, 'dash15-liabilities', liabilities, 'rgba(248,113,113,0.8)',         sym, C),
    _renderSection(container, 'dash15-investments', investments, 'rgba(251,191,36,0.8)',           sym, C),
  ].filter(Boolean);

  return _proxy(charts);
}
