/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  monthRange, sumAmountBase,
  getCssColors, baseChartOptions, buildPalette,
} from './insight-utils.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _chart        = null;
let _historyChart = null; // payment-history chart in the drill panel
let _recurring    = [];   // detected [{counterparty, amount, frequency, count, lastDate, category}]
let _sortCol      = 'amount';
let _sortDir      = 'desc';
let _sym          = '';
let _C            = {};

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch (_e) {} }
  _chart = c;
  state.insightChartInstance = c;
}

function _destroyChart() {
  _setChart(null);
  if (_historyChart) { try { _historyChart.destroy(); } catch (_e) {} _historyChart = null; }
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function _mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

function _stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function _daysBetween(a, b) { return Math.round(Math.abs(b - a) / 86400000); }

// ── Recurring detection ───────────────────────────────────────────────────────

function _detectRecurring(outTxs) {
  // Group by normalised counterparty name
  const map = new Map();
  for (const tx of outTxs) {
    const key = ((tx.counterparty_name || '').trim() || 'unknown').toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  }

  const recurring = [];
  for (const [, rows] of map) {
    if (rows.length < 2) continue;

    const sorted  = [...rows].sort((a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time));
    const amounts = sorted.map(t => Number(t.amount_base) || 0);
    const amtMean = _mean(amounts);
    if (amtMean <= 0) continue;
    if (_stdDev(amounts) / amtMean > 0.15) continue; // too variable

    const dates = sorted.map(t => new Date(t.tx_date_time));
    const gaps  = dates.slice(1).map((d, i) => _daysBetween(dates[i], d));
    const gMean = _mean(gaps);
    const gSd   = _stdDev(gaps);

    let frequency = null;
    if (gMean >=  5 && gMean <=  9 && gSd <= 2) frequency = 'weekly';
    if (gMean >= 28 && gMean <= 35 && gSd <= 5) frequency = 'monthly';
    if (gMean >= 85 && gMean <= 95 && gSd <= 7) frequency = 'quarterly';
    if (!frequency) continue;

    recurring.push({
      counterparty: (sorted[0].counterparty_name || 'Unknown').trim(),
      amount:       amtMean,
      frequency,
      count:        sorted.length,
      lastDate:     dates[dates.length - 1],
      category:     sorted[sorted.length - 1].major_category || 'Other',
    });
  }

  return recurring.sort((a, b) => b.amount - a.amount);
}

// ── Table rendering ───────────────────────────────────────────────────────────

const FREQ_COLOR = { weekly: 'var(--teal)', monthly: '#f59e0b', quarterly: 'var(--ember)' };

function _renderTable(tbodyId) {
  const tbody = el(tbodyId);
  if (!tbody) return;

  const sign   = _sortDir === 'asc' ? 1 : -1;
  const sorted = [..._recurring].sort((a, b) => {
    switch (_sortCol) {
      case 'counterparty': return sign * a.counterparty.localeCompare(b.counterparty);
      case 'category':     return sign * a.category.localeCompare(b.category);
      case 'frequency':    return sign * a.frequency.localeCompare(b.frequency);
      case 'amount':       return sign * (a.amount - b.amount);
      case 'last_date':    return sign * (a.lastDate - b.lastDate);
      default:             return 0;
    }
  });

  const fmt = v => _sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  tbody.innerHTML = sorted.map(r => `
    <tr data-cp="${esc(r.counterparty.toLowerCase())}" style="border-bottom:1px solid var(--hair);cursor:pointer" title="Tap to see payment history">
      <td style="padding:10px 8px;font-size:var(--text-sm)">${esc(r.counterparty)}</td>
      <td style="padding:10px 8px;font-size:var(--text-sm);color:var(--muted)">${esc(r.category)}</td>
      <td style="padding:10px 8px;text-align:center">
        <span style="font-size:var(--text-xs);padding:2px 8px;border-radius:20px;background:${FREQ_COLOR[r.frequency]}22;color:${FREQ_COLOR[r.frequency]};white-space:nowrap">${esc(r.frequency)}</span>
      </td>
      <td style="padding:10px 8px;text-align:right;font-weight:600;font-size:var(--text-sm)">${esc(fmt(r.amount))}</td>
      <td style="padding:10px 8px;text-align:right;color:var(--muted);font-size:var(--text-sm)">${esc(fmtDate(r.lastDate))}</td>
    </tr>`).join('');
}

function _thStyle() {
  return `padding:8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;text-align:left;cursor:pointer;white-space:nowrap;user-select:none`;
}

function _thHtml(col, label, align) {
  const indicator = _sortCol === col ? (_sortDir === 'desc' ? ' ↓' : ' ↑') : '';
  return `<th data-sort="${col}" style="${_thStyle()}${align === 'right' ? ';text-align:right' : align === 'center' ? ';text-align:center' : ''}">${esc(label)}${indicator}</th>`;
}

// ── Bar chart ─────────────────────────────────────────────────────────────────

function _renderBar(canvasId) {
  const canvas = el(canvasId);
  if (!canvas || !_recurring.length) { _setChart(null); return; }

  const palette    = buildPalette(_C);
  const catColors  = {};
  let catIdx       = 0;
  _recurring.forEach(r => {
    if (!catColors[r.category]) catColors[r.category] = palette[catIdx++ % palette.length];
  });

  const freqs  = _recurring.map(r => r.frequency);
  const labels = _recurring.map(r => r.counterparty.length > 22 ? r.counterparty.slice(0, 21) + '…' : r.counterparty);
  const data   = _recurring.map(r => r.amount);
  const colors = _recurring.map(r => catColors[r.category]);

  const base = baseChartOptions(_sym, _C);
  _setChart(new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderRadius: 4 }],
    },
    options: {
      ...base,
      indexAxis: 'y',
      plugins: {
        ...base.plugins,
        legend: { display: false },
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: {
            label: ctx => `  ${_sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${freqs[ctx.dataIndex]}`,
          },
        },
      },
      scales: {
        ...base.scales,
        x: {
          ...base.scales.x,
          ticks: {
            ...base.scales.x.ticks,
            callback: v => `${_sym}${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
          },
        },
        y: { ...base.scales.y, ticks: { color: _C.muted, font: { size: 12 } } },
      },
    },
  }));
}

// ── Payment history panel ─────────────────────────────────────────────────────

function _showHistory(historyEl, cpKey) {
  if (_historyChart) { try { _historyChart.destroy(); } catch (_e) {} _historyChart = null; }

  const cpTxs = state.transactions
    .filter(t =>
      t.tx_type === 'money-out' &&
      ((t.counterparty_name || '').trim() || 'unknown').toLowerCase() === cpKey
    )
    .sort((a, b) => new Date(a.tx_date_time) - new Date(b.tx_date_time));

  if (!cpTxs.length) {
    historyEl.hidden = true;
    return;
  }

  // Group by YYYY-MM for bar chart
  const monthMap = new Map();
  for (const t of cpTxs) {
    const mk = t.tx_date_time.slice(0, 7);
    if (!monthMap.has(mk)) monthMap.set(mk, 0);
    monthMap.set(mk, monthMap.get(mk) + (Number(t.amount_base) || 0));
  }
  const monthKeys = [...monthMap.keys()].sort();
  const monthVals = monthKeys.map(mk => monthMap.get(mk));

  const fmtMk  = mk => { const [y, m] = mk.split('-'); return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m)-1]} ${y.slice(2)}`; };
  const fmtAmt = v => _sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const r = _recurring.find(rec => rec.counterparty.toLowerCase() === cpKey);

  historyEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <p style="font-size:var(--text-xs);color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin:0">Payment history${r ? ` · ${r.frequency}` : ''}</p>
      <button data-action="history-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
    </div>
    <div style="height:100px"><canvas id="dash23-hchart" style="width:100%;height:100%"></canvas></div>`;

  historyEl.hidden = false;
  historyEl.querySelector('[data-action="history-close"]')?.addEventListener('click', () => { historyEl.hidden = true; });

  const canvas = el('dash23-hchart');
  if (!canvas) return;
  _historyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels:   monthKeys.map(fmtMk),
      datasets: [{ data: monthVals, backgroundColor: _C.teal + '88', borderRadius: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend:  { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmtAmt(ctx.raw)}` } },
      },
      scales: {
        x: { ticks: { color: _C.muted, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: _C.muted, font: { size: 10 }, callback: v => fmtAmt(v) }, grid: { color: _C.hair } },
      },
    },
  });
}

function _attachRowClicks(containerId) {
  const tbody     = el('dash23-tbody');
  const historyEl = el('dash23-history');
  if (!tbody || !historyEl) return;

  tbody.addEventListener('click', e => {
    const row = e.target.closest('tr[data-cp]');
    if (!row) return;
    const cpKey = row.dataset.cp;
    _showHistory(historyEl, cpKey);
    historyEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// ── Sort event attachment ─────────────────────────────────────────────────────

function _attachSort(containerId) {
  const container = el(containerId);
  if (!container) return;
  container.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_sortCol === col) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      else { _sortCol = col; _sortDir = 'desc'; }
      _renderTable('dash23-tbody');
      // refresh sort indicators in headers
      container.querySelectorAll('[data-sort]').forEach(h => {
        const base = h.textContent.replace(/[ ↓↑]+$/, '');
        h.textContent = base + (_sortCol === h.dataset.sort ? (_sortDir === 'desc' ? ' ↓' : ' ↑') : '');
      });
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  _chart     = null;
  _recurring = [];
  _sortCol   = 'amount';
  _sortDir   = 'desc';
  _sym       = sym;

  const container = el(containerId);
  if (!container) {
    console.warn('[insight-23] container not found:', containerId);
    return { destroy() { _destroyChart(); } };
  }

  // Detect from full history — patterns need multiple months to be identified.
  // Then filter to only those that fired at least once within the selected period.
  const allOutTxs    = state.transactions.filter(t => t.tx_type === 'money-out');
  const periodOutTxs = txs.filter(t => t.tx_type === 'money-out');
  const periodKeys   = new Set(periodOutTxs.map(t => ((t.counterparty_name || '').trim() || 'unknown').toLowerCase()));
  _recurring = _detectRecurring(allOutTxs).filter(r => periodKeys.has(r.counterparty.toLowerCase()));
  _C           = getCssColors();

  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  if (!_recurring.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No recurring payments detected in this period.</p></div>`;
    _setChart(null);
    return { destroy() { _destroyChart(); } };
  }

  // Stat card values
  const MONTHLY_EQUIV = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3 };
  const totalMonthly  = _recurring.reduce((s, r) => s + r.amount * MONTHLY_EQUIV[r.frequency], 0);

  const inTxs        = txs.filter(t => t.tx_type === 'money-in');
  const monthCount   = Math.max(1, monthRange(from, to).length);
  const monthlyIncome = sumAmountBase(inTxs) / monthCount;
  const pctOfIncome  = monthlyIncome > 0 ? Math.round((totalMonthly / monthlyIncome) * 100) : null;

  const top = _recurring[0];

  // Chart height
  const barH = Math.max(200, _recurring.length * 44);

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Recurring / month</p>
        <p class="stat-card-value negative">${esc(fmt(totalMonthly))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">% of income</p>
        <p class="stat-card-value${pctOfIncome !== null && pctOfIncome > 50 ? ' negative' : ''}">${esc(pctOfIncome !== null ? pctOfIncome + '%' : '—')}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Count</p>
        <p class="stat-card-value">${esc(String(_recurring.length))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Largest</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(top.counterparty.length > 12 ? top.counterparty.slice(0, 11) + '…' : top.counterparty)}</p>
        <p class="stat-card-sub">${esc(sym + top.amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</p>
      </div>
    </div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse;min-width:460px">
        <thead>
          <tr style="border-bottom:2px solid var(--hair)">
            ${_thHtml('counterparty', 'Payee', 'left')}
            ${_thHtml('category',     'Category', 'left')}
            ${_thHtml('frequency',    'Frequency', 'center')}
            ${_thHtml('amount',       'Amount', 'right')}
            ${_thHtml('last_date',    'Last paid', 'right')}
          </tr>
        </thead>
        <tbody id="dash23-tbody"></tbody>
      </table>
    </div>
    <div id="dash23-history" hidden style="margin-bottom:16px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>
    <div class="chart-container" style="height:${barH}px">
      <canvas id="dash23-canvas" style="width:100%;height:100%"></canvas>
    </div>`;

  _renderTable('dash23-tbody');
  _renderBar('dash23-canvas');
  _attachSort(containerId);
  _attachRowClicks(containerId);

  console.log(`[insight-23] recurring=${_recurring.length}, monthly_total=${totalMonthly.toFixed(0)}`);

  return { destroy() { _destroyChart(); } };
}
