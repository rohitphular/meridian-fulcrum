/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { computeDailyTotalAssets, getCssColors, baseChartOptions } from './insight-utils.js';

// Charts created inside expandable history panels — destroyed together on navigation.
const _historyCharts = new Map(); // accId → Chart

// Produce a safe HTML id token from an account id or name.
// HTML ids must not contain spaces; replace non-alphanumeric chars with '_'.
function _safeId(raw) { return String(raw).replace(/[^a-zA-Z0-9-]/g, '_'); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function _monthsSince(dateStr) {
  if (!dateStr) return 1;
  const opened = new Date(dateStr);
  const now    = new Date();
  return Math.max(1, (now.getFullYear() - opened.getFullYear()) * 12 + (now.getMonth() - opened.getMonth()));
}

function _payoffDateStr(months) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + months, 1)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// Repayment txs targeting this liability account (money-transfer credits).
function _repaymentTxs(acc) {
  return state.transactions.filter(t =>
    t.tx_type === 'money-transfer' && (
      t.target_account === acc.name ||
      t.to_account     === acc.name ||
      t.to_account_id  === acc.id
    )
  ).sort((a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time));
}

// ── Per-loan computation ──────────────────────────────────────────────────────

function _loanStats(acc) {
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daily      = computeDailyTotalAssets([acc], state.transactions, todayLocal, todayLocal);
  const currentBal = Math.abs(daily[0] || 0);

  const openingRaw    = parseFloat(acc.opening_value);
  const originalBal   = isNaN(openingRaw) ? 0 : Math.abs(openingRaw);
  const totalRepaid   = Math.max(0, originalBal - currentBal);
  const hasOpening    = originalBal > 0;

  const repayTxs      = _repaymentTxs(acc);
  const openingDate   = acc.opening_date || repayTxs[0]?.tx_date_time || null;
  const months        = _monthsSince(openingDate);
  const avgMonthly    = totalRepaid > 0 ? totalRepaid / months : 0;
  const monthsToPayoff = (avgMonthly > 0 && currentBal > 0) ? Math.ceil(currentBal / avgMonthly) : null;

  const pctPaid      = hasOpening && originalBal > 0 ? Math.min(100, (totalRepaid / originalBal) * 100) : null;
  const balIncreased = hasOpening && currentBal > originalBal;
  const paidOff      = currentBal <= 0;

  return {
    acc, currentBal, originalBal, totalRepaid, hasOpening,
    avgMonthly, monthsToPayoff, pctPaid, paidOff, balIncreased,
    repayTxs,
  };
}

// ── History chart ─────────────────────────────────────────────────────────────

function _renderHistoryChart(canvasId, loan, sym, C) {
  const canvas = el(canvasId);
  if (!canvas || !loan.repayTxs.length) return null;

  const amounts    = loan.repayTxs.map(t => Math.abs(Number(t.amount_base) || 0));
  const cumulative = amounts.map((_, i) => amounts.slice(0, i + 1).reduce((s, v) => s + v, 0));
  const labels     = loan.repayTxs.map(t => {
    const d = new Date(t.tx_date_time);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  });

  const base = baseChartOptions(sym, C);
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label:           'Cumulative repaid',
        data:            cumulative,
        borderColor:     '#34d399',
        backgroundColor: 'rgba(52,211,153,0.15)',
        fill:            true,
        tension:         0.3,
        pointRadius:     3,
        pointHoverRadius: 5,
      }],
    },
    options: {
      ...base,
      plugins: { ...base.plugins, legend: { display: false } },
      scales: {
        ...base.scales,
        y: {
          ...base.scales.y,
          min: 0,
          max: loan.originalBal > 0 ? loan.originalBal : undefined,
          ticks: {
            ...base.scales.y.ticks,
            callback: v => `${sym}${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
          },
        },
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 6, maxRotation: 30 } },
      },
    },
  });
}

// ── Loan card HTML ────────────────────────────────────────────────────────────

function _loanCardHtml(loan, sym) {
  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtAvg = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const accId  = _safeId(loan.acc.id || loan.acc.name);

  let progressHtml = '';
  if (loan.paidOff) {
    progressHtml = `
      <div style="margin:12px 0">
        <div style="height:20px;border-radius:10px;background:#34d399;margin-bottom:6px"></div>
        <span style="font-size:var(--text-xs);padding:2px 10px;border-radius:20px;background:#34d39922;color:#34d399;font-weight:600">Paid off ✓</span>
      </div>`;
  } else if (loan.pctPaid !== null) {
    progressHtml = `
      <div style="margin:12px 0">
        <div style="height:20px;border-radius:10px;background:var(--hair);overflow:hidden;margin-bottom:6px">
          <div style="height:100%;width:${loan.pctPaid.toFixed(1)}%;background:var(--teal);border-radius:10px;transition:width 0.4s ease"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:var(--text-xs);color:var(--muted)">
          <span>Original: ${esc(fmt(loan.originalBal))}</span>
          <span style="font-weight:600;color:var(--ink)">${Math.round(loan.pctPaid)}% paid</span>
          <span>Remaining: ${esc(fmt(loan.currentBal))}</span>
        </div>
      </div>`;
  } else {
    progressHtml = `<p style="font-size:var(--text-xs);color:var(--muted);margin:8px 0">Original balance unknown — progress unavailable.</p>`;
  }

  let projectionHtml = '';
  if (loan.paidOff) {
    projectionHtml = `<p style="font-size:var(--text-sm);color:#34d399;margin:4px 0">Fully paid off.</p>`;
  } else if (loan.balIncreased) {
    projectionHtml = `<p style="font-size:var(--text-xs);color:var(--ember);margin:4px 0">⚠ Balance increased — projection updated.</p>`;
  }

  if (!loan.paidOff && loan.avgMonthly > 0) {
    projectionHtml += `<p style="font-size:var(--text-sm);color:var(--muted);margin:4px 0">
      Avg monthly repayment: <strong style="color:var(--ink)">${esc(fmtAvg(loan.avgMonthly))}</strong>
    </p>`;
  }
  if (!loan.paidOff && loan.monthsToPayoff !== null) {
    projectionHtml += `<p style="font-size:var(--text-sm);color:var(--muted);margin:4px 0">
      Projected payoff: <strong style="color:var(--ink)">${esc(_payoffDateStr(loan.monthsToPayoff))} (~${loan.monthsToPayoff} mo)</strong>
    </p>`;
  } else if (!loan.paidOff && !loan.avgMonthly) {
    projectionHtml += `<p style="font-size:var(--text-xs);color:var(--muted);margin:4px 0">No repayments found — projection N/A.</p>`;
  }

  // Repayment history table rows
  const txRows = [...loan.repayTxs].reverse().slice(0, 24).map(t => {
    const d   = new Date(t.tx_date_time);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
    const amt  = Math.abs(Number(t.amount_base) || 0);
    return `<tr>
      <td style="padding:7px 8px;font-size:var(--text-sm);color:var(--muted)">${esc(date)}</td>
      <td style="padding:7px 8px;font-size:var(--text-sm);text-align:right;font-weight:600">${esc(sym + amt.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</td>
    </tr>`;
  }).join('');

  const historyContent = loan.repayTxs.length ? `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--hair)">
      <div class="chart-container" style="height:200px;margin-bottom:12px">
        <canvas id="history-canvas-${esc(String(accId))}" style="width:100%;height:100%"></canvas>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--hair)">
            <th style="padding:6px 8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;text-align:left">Date</th>
            <th style="padding:6px 8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;text-align:right">Amount</th>
          </tr></thead>
          <tbody>${txRows}</tbody>
        </table>
      </div>
    </div>` : `<p style="font-size:var(--text-xs);color:var(--muted);margin:12px 0 0">No repayment transactions found.</p>`;

  const cat      = esc(loan.acc.sub_type || loan.acc.type || 'Liability');
  const currency = esc(loan.acc.currency || '—');

  return `
    <details style="background:var(--panel);border:1px solid var(--hair);border-radius:8px;padding:16px;margin-bottom:16px" data-loan-id="${esc(String(accId))}">
      <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">
        <div>
          <p style="font-size:var(--text-base);font-weight:600;margin:0 0 2px">${esc(loan.acc.name)}</p>
          <p style="font-size:var(--text-xs);color:var(--muted);margin:0">Category: ${cat} · Currency: ${currency}</p>
        </div>
        <span style="font-size:var(--text-sm);color:var(--muted);margin-left:12px;flex-shrink:0">${esc(fmt(loan.currentBal))} ▾</span>
      </summary>
      ${progressHtml}
      ${projectionHtml}
      ${historyContent}
    </details>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { accounts, sym }) {
  // Clear any previously created history charts
  _historyCharts.forEach(c => { try { c?.destroy(); } catch (_e) {} });
  _historyCharts.clear();

  const container = el(containerId);
  if (!container) {
    console.warn('[insight-26] container not found:', containerId);
    return { destroy() { _historyCharts.forEach(c => { try { c?.destroy(); } catch(_e){} }); _historyCharts.clear(); } };
  }

  const liabAccounts = accounts.filter(a => a.is_active && a.type === 'liability');

  if (!liabAccounts.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No active liability accounts found.</p></div>`;
    return { destroy() {} };
  }

  const C     = getCssColors();
  const loans = liabAccounts.map(acc => _loanStats(acc));

  // Summary stat cards
  const totalDebt     = loans.reduce((s, l) => s + l.currentBal, 0);
  const totalRepaid   = loans.reduce((s, l) => s + l.totalRepaid, 0);
  const monthlyBurden = loans.reduce((s, l) => s + l.avgMonthly, 0);
  const withPayoff    = loans.filter(l => l.monthsToPayoff !== null && !l.paidOff);
  const earliest      = withPayoff.length ? withPayoff.reduce((a, b) => a.monthsToPayoff < b.monthsToPayoff ? a : b) : null;

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total debt</p>
        <p class="stat-card-value negative">${esc(fmt(totalDebt))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Total repaid</p>
        <p class="stat-card-value positive">${esc(fmt(totalRepaid))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Monthly burden</p>
        <p class="stat-card-value negative">${esc(fmt(monthlyBurden))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Earliest payoff</p>
        <p class="stat-card-value" style="font-size:var(--text-sm)">${esc(earliest ? (earliest.acc.name.length > 12 ? earliest.acc.name.slice(0, 11) + '…' : earliest.acc.name) : '—')}</p>
        <p class="stat-card-sub">${esc(earliest ? _payoffDateStr(earliest.monthsToPayoff) : '')}</p>
      </div>
    </div>
    ${loans.map(l => _loanCardHtml(l, sym)).join('')}`;

  // Attach toggle handlers — create history chart on first expand
  container.querySelectorAll('details[data-loan-id]').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const accId = details.dataset.loanId;
      if (_historyCharts.has(accId)) return; // already created
      const loan   = loans.find(l => _safeId(l.acc.id || l.acc.name) === accId);
      if (!loan) return;
      const chart = _renderHistoryChart(`history-canvas-${accId}`, loan, sym, C);
      if (chart) _historyCharts.set(accId, chart);
    });
  });

  console.log(`[insight-26] loans=${loans.length}, total_debt=${totalDebt.toFixed(0)}, monthly_burden=${monthlyBurden.toFixed(0)}`);

  return {
    destroy() {
      _historyCharts.forEach(c => { try { c?.destroy(); } catch (_e) {} });
      _historyCharts.clear();
    },
  };
}
