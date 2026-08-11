/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { sumAmountBase, getCssColors, baseChartOptions, fmtMonthKey } from './insight-utils.js';

const TOP_OPTIONS = [10, 15, 20];
const DEFAULT_TOP = 15;

// Module-level state — reset at the top of render() on each fresh render.
let _chart          = null;
let _sparklineChart = null; // sparkline in drill panel
let _allRows  = []; // [{label, total, txs}] sorted desc — full list before top-N slice
let _selIdx   = -1; // highlighted bar index
let _from     = null;
let _to       = null;
let _sym      = '';
let _C        = {};

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch (_e) {} }
  _chart = c;
  state.insightChartInstance = c;
}

function _destroyChart() {
  _setChart(null);
  if (_sparklineChart) { try { _sparklineChart.destroy(); } catch (_e) {} _sparklineChart = null; }
}

// ── Data grouping ─────────────────────────────────────────────────────────────

function _groupCounterparties(outTxs) {
  const map = new Map();
  for (const tx of outTxs) {
    const key = ((tx.counterparty_name || '').trim() || 'Unknown merchant').toLowerCase();
    const display = ((tx.counterparty_name || '').trim() || 'Unknown merchant');
    if (!map.has(key)) map.set(key, { label: display, txs: [] });
    map.get(key).txs.push(tx);
  }
  return [...map.values()]
    .map(r => ({ label: r.label, total: sumAmountBase(r.txs), txs: r.txs }))
    .sort((a, b) => b.total - a.total);
}

// ── Previous-period spend for a counterparty ──────────────────────────────────

function _prevSpend(labelLower) {
  if (!_from || !_to) return 0;
  const duration = _to - _from;
  const prevFrom = new Date(_from.getTime() - duration - 86400000);
  const prevTo   = new Date(_from.getTime() - 1);

  return state.transactions
    .filter(t => {
      if (t.tx_type !== 'money-out') return false;
      const cp = ((t.counterparty_name || '').trim() || 'unknown merchant').toLowerCase();
      if (cp !== labelLower) return false;
      const d  = new Date(t.tx_date_time);
      const dl = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return dl >= prevFrom && dl <= prevTo;
    })
    .reduce((s, t) => s + (Number(t.amount_base) || 0), 0);
}

// ── Drill-down panel ──────────────────────────────────────────────────────────

function _showPanel(idx) {
  const panel = el('dash22-panel');
  if (!panel) return;

  // Destroy any previous sparkline before rebuilding the panel
  if (_sparklineChart) { try { _sparklineChart.destroy(); } catch (_e) {} _sparklineChart = null; }

  const row   = _allRows[idx];
  if (!row)   { panel.innerHTML = ''; return; }

  const fmt       = v => _sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const prevTotal = _prevSpend(row.label.toLowerCase());
  const diff      = row.total - prevTotal;
  const diffClass = diff <= 0 ? 'positive' : 'negative'; // lower spend = good
  const diffArrow = diff <= 0 ? '↓' : '↑';

  const sorted = [...row.txs].sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));

  const txRows = sorted.map(t => {
    const d    = new Date(t.tx_date_time);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const cat  = esc(t.minor_category || t.major_category || '—');
    return `<li style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--hair);font-size:var(--text-sm)">
      <span style="color:var(--muted);width:60px;flex-shrink:0">${esc(date)}</span>
      <span style="flex:1;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cat}</span>
      <span style="font-weight:600">${esc(fmt(Number(t.amount_base) || 0))}</span>
    </li>`;
  }).join('');

  // Monthly spend sparkline — last 6 months from today, using full transaction history
  const now = new Date();
  const sparkMonths = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    sparkMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const labelLower   = row.label.toLowerCase();
  const allMerchant  = state.transactions.filter(t =>
    t.tx_type === 'money-out' &&
    ((t.counterparty_name || '').trim() || 'unknown merchant').toLowerCase() === labelLower
  );
  const monthlySpend = sparkMonths.map(mk =>
    allMerchant.filter(t => t.tx_date_time.startsWith(mk))
               .reduce((s, t) => s + (Number(t.amount_base) || 0), 0)
  );
  const hasSparkData = monthlySpend.some(v => v > 0);

  panel.innerHTML = `
    <div style="margin-top:20px;padding:16px;background:var(--panel);border-radius:8px;border:1px solid var(--hair)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
        <span style="font-size:var(--text-sm);font-weight:600">${esc(row.label)}</span>
        <span style="font-size:var(--text-xs);color:var(--muted)">${row.txs.length} transaction${row.txs.length === 1 ? '' : 's'}</span>
      </div>
      ${prevTotal > 0 ? `
        <div style="display:flex;gap:16px;margin-bottom:12px;font-size:var(--text-xs);color:var(--muted)">
          <span>This period: <strong style="color:var(--ink)">${esc(fmt(row.total))}</strong></span>
          <span>Prev period: <strong style="color:var(--ink)">${esc(fmt(prevTotal))}</strong></span>
          <span class="${diffClass}">${diffArrow} ${esc(fmt(Math.abs(diff)))}</span>
        </div>` : ''}
      ${hasSparkData ? `
        <p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Monthly spend (last 6 months)</p>
        <div style="height:80px;margin-bottom:12px"><canvas id="dash22-spark" style="width:100%;height:100%"></canvas></div>` : ''}
      <ul style="list-style:none;padding:0;margin:0;max-height:240px;overflow-y:auto">${txRows}</ul>
    </div>`;

  // Render sparkline after innerHTML is set
  if (hasSparkData) {
    const sparkCanvas = el('dash22-spark');
    if (sparkCanvas) {
      _sparklineChart = new Chart(sparkCanvas, {
        type: 'bar',
        data: {
          labels:   sparkMonths.map(fmtMonthKey),
          datasets: [{ data: monthlySpend, backgroundColor: _C.teal + '88', borderRadius: 2 }],
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          plugins: {
            legend:  { display: false },
            tooltip: {
              callbacks: { label: ctx => ` ${_sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` },
            },
          },
          scales: {
            x: { ticks: { color: _C.muted, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: _C.muted, font: { size: 10 }, callback: v => `${_sym}${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` }, grid: { color: _C.hair } },
          },
        },
      });
    }
  }
}

// ── Chart render ──────────────────────────────────────────────────────────────

function _renderChart(containerId, topN) {
  _selIdx = -1;
  const container = el(containerId);
  if (!container) return;

  const panel = el('dash22-panel');
  if (panel) panel.innerHTML = '';

  const rows   = _allRows.slice(0, topN);
  const labels = rows.map(r => r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label);
  const data   = rows.map(r => r.total);
  const counts = rows.map(r => r.txs.length);
  const colors = rows.map(() => _C.teal);

  const canvasWrap = el('dash22-canvas-wrap');
  if (canvasWrap) {
    const h = Math.max(300, rows.length * 44);
    canvasWrap.style.height = `${h}px`;
  }

  const canvas = el('dash22-canvas');
  if (!canvas) return;

  const base = baseChartOptions(_sym, _C);
  _setChart(new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data:            data,
        backgroundColor: colors,
        borderRadius:    4,
      }],
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
            label: ctx => `  ${_sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { maximumFractionDigits: 0 })} (${counts[ctx.dataIndex]} txn${counts[ctx.dataIndex] === 1 ? '' : 's'})`,
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
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        _selIdx = (_selIdx === idx) ? -1 : idx; // toggle

        const chart = _chart;
        if (!chart) return;
        const ds = chart.data.datasets[0];
        ds.backgroundColor = rows.map((_, i) =>
          i === _selIdx ? _C.ember : _C.teal
        );
        chart.update('none');

        if (_selIdx >= 0) _showPanel(idx);
        else { const p = el('dash22-panel'); if (p) p.innerHTML = ''; }
      },
    },
  }));
}

// ── Filter pill events ────────────────────────────────────────────────────────

function _attachPills(containerId) {
  const container = el(containerId);
  if (!container) return;

  container.querySelectorAll('[data-d22-top]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-d22-top]').forEach(b => {
        b.style.background = 'transparent';
        b.style.color      = 'var(--muted)';
      });
      btn.style.background = 'var(--teal)';
      btn.style.color      = 'var(--ink)';

      const topN = Number(btn.dataset.d22Top);
      const h    = Math.max(300, Math.min(topN, _allRows.length) * 44);
      const wrap = el('dash22-canvas-wrap');
      if (wrap) wrap.style.height = `${h}px`;

      // Recreate canvas (Chart.js requires a fresh canvas after destroy)
      const oldCanvas = el('dash22-canvas');
      if (oldCanvas && _chart) {
        _destroyChart();
        oldCanvas.remove();
        const newCanvas = document.createElement('canvas');
        newCanvas.id = 'dash22-canvas';
        newCanvas.style.cssText = 'width:100%;height:100%';
        if (wrap) wrap.appendChild(newCanvas);
      }

      _renderChart(containerId, topN);
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, from, to, sym }) {
  // Reset module state
  _chart   = null;
  _allRows = [];
  _selIdx  = -1;
  _from    = from;
  _to      = to;
  _sym     = sym;

  const container = el(containerId);
  if (!container) {
    console.warn('[insight-22] container not found:', containerId);
    return { destroy() { _destroyChart(); } };  // _destroyChart also kills _sparklineChart
  }

  const outTxs = txs.filter(t => t.tx_type === 'money-out');
  if (!outTxs.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spend transactions for this period.</p></div>`;
    _setChart(null);
    return { destroy() { _destroyChart(); } };  // _destroyChart also kills _sparklineChart
  }

  _C       = getCssColors();
  _allRows = _groupCounterparties(outTxs);

  const total       = _allRows.reduce((s, r) => s + r.total, 0);
  const totalCount  = outTxs.length;
  const topRow      = _allRows[0];
  const fmt         = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const N   = Math.min(DEFAULT_TOP, _allRows.length);
  const h   = Math.max(300, N * 44);

  const pillHtml = TOP_OPTIONS.map((n, i) =>
    `<button data-d22-top="${n}" style="padding:5px 12px;border:none;border-radius:20px;font-size:var(--text-sm);cursor:pointer;background:${n === DEFAULT_TOP ? 'var(--teal)' : 'transparent'};color:${n === DEFAULT_TOP ? 'var(--ink)' : 'var(--muted)'}">${'Top ' + n}</button>`
  ).join('');

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total spend</p>
        <p class="stat-card-value negative">${esc(fmt(total))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Merchants</p>
        <p class="stat-card-value">${esc(String(_allRows.length))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Transactions</p>
        <p class="stat-card-value">${esc(String(totalCount))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Top merchant</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(topRow ? (topRow.label.length > 14 ? topRow.label.slice(0, 13) + '…' : topRow.label) : '—')}</p>
        <p class="stat-card-sub">${esc(topRow ? fmt(topRow.total) : '')}</p>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;-webkit-overflow-scrolling:touch">${pillHtml}</div>
    <div id="dash22-canvas-wrap" class="chart-container" style="height:${h}px">
      <canvas id="dash22-canvas" style="width:100%;height:100%"></canvas>
    </div>
    <div id="dash22-panel"></div>`;

  _renderChart(containerId, N);
  _attachPills(containerId);

  console.log(`[insight-22] merchants=${_allRows.length}, spend=${total.toFixed(0)}`);

  return { destroy() { _destroyChart(); } };  // _destroyChart also kills _sparklineChart
}
