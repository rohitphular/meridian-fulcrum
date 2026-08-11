/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { sumAmountBase, getCssColors, buildPalette } from './insight-utils.js';

// ── Currency symbol lookup ────────────────────────────────────────────────────
const CCY_SYMBOL = {
  GBP: '£', USD: '$', EUR: '€', INR: '₹', JPY: '¥',
  AUD: 'A$', CAD: 'C$', CHF: 'CHF ', SGD: 'S$',
  HKD: 'HK$', NZD: 'NZ$', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ',
};
function _ccySym(ccy) { return CCY_SYMBOL[ccy] || (ccy + ' '); }

// ── Module-level chart state (same pattern as 11 / 21) ────────────────────────
let _chart = null;

function _setChart(c) {
  if (_chart && _chart !== c) { try { _chart.destroy(); } catch (_e) {} }
  _chart = c;
  state.insightChartInstance = c;
}

function _destroyChart() { _setChart(null); }

// ── Data grouping ─────────────────────────────────────────────────────────────

function _groupByCurrency(outTxs, quoteCcy) {
  const map = new Map();
  for (const tx of outTxs) {
    const ccy = (tx.currency || quoteCcy || 'GBP').trim().toUpperCase();
    if (!map.has(ccy)) map.set(ccy, []);
    map.get(ccy).push(tx);
  }

  const rows = [...map.entries()].map(([ccy, txs]) => {
    const nativeTotal  = txs.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
    const gbpEquiv     = sumAmountBase(txs);
    const count        = txs.length;
    const ratedTxs     = txs.filter(t => t.fx_rate);
    const avgRate      = ratedTxs.length
      ? ratedTxs.reduce((s, t) => s + t.fx_rate, 0) / ratedTxs.length
      : (state.rateMap?.[ccy] || null);
    const hasEstimated = txs.some(t => !t.fx_rate) && ccy !== quoteCcy;
    const rateUnavail  = ccy !== quoteCcy && !avgRate;
    return { ccy, nativeTotal, gbpEquiv, count, avgRate, hasEstimated, rateUnavail, txs };
  });

  return rows.sort((a, b) => b.gbpEquiv - a.gbpEquiv);
}

// ── By Currency sub-view ──────────────────────────────────────────────────────

function _renderByCurrency(viewEl, rows, sym, C) {
  const palette     = buildPalette(C);
  const labels      = rows.map(r => r.ccy);
  const amounts     = rows.map(r => r.gbpEquiv);
  const total       = amounts.reduce((s, v) => s + v, 0);
  const colors      = rows.map((_, i) => palette[i % palette.length]);

  const fmtGbp    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtNative = (v, ccy) => _ccySym(ccy) + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tableRows = rows.map((r, i) => {
    const pct      = total > 0 ? ((r.gbpEquiv / total) * 100).toFixed(1) : '0.0';
    const rateStr  = r.avgRate !== null ? r.avgRate.toFixed(4) : '—';
    const estMark  = r.hasEstimated ? '<span title="Some rates estimated from rateMap" style="color:var(--muted)">~</span>' : '';
    const warnMark = r.rateUnavail  ? '<span title="Rate unavailable" style="color:var(--ember)">⚠</span>' : '';
    return `<tr>
      <td style="padding:9px 8px;font-size:var(--text-sm)">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colors[i]};margin-right:6px;vertical-align:middle"></span>
        <strong>${esc(r.ccy)}</strong>
      </td>
      <td style="padding:9px 8px;font-size:var(--text-sm);text-align:right">${esc(fmtNative(r.nativeTotal, r.ccy))}</td>
      <td style="padding:9px 8px;font-size:var(--text-sm);text-align:right">${estMark}${warnMark}${esc(fmtGbp(r.gbpEquiv))} <span style="color:var(--muted);font-size:var(--text-xs)">${pct}%</span></td>
      <td style="padding:9px 8px;font-size:var(--text-sm);text-align:right;color:var(--muted)">${esc(String(r.count))}</td>
      <td style="padding:9px 8px;font-size:var(--text-sm);text-align:right;color:var(--muted)">${esc(rateStr)}</td>
    </tr>`;
  }).join('');

  const th = (label, align) =>
    `<th style="padding:8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;white-space:nowrap;text-align:${align || 'left'}">${esc(label)}</th>`;

  viewEl.innerHTML = `
    <div class="chart-container" style="height:220px"><canvas id="dash28-canvas"></canvas></div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:12px">
      <table style="width:100%;border-collapse:collapse;min-width:380px">
        <thead><tr style="border-bottom:2px solid var(--hair)">
          ${th('Currency')}${th('Native total','right')}${th('GBP equiv','right')}${th('Txns','right')}${th('Avg rate','right')}
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;

  const canvas = viewEl.querySelector('#dash28-canvas');
  if (!canvas) { _setChart(null); return; }

  _setChart(new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: amounts, backgroundColor: colors, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { color: C.ink, font: { size: 12 }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          backgroundColor: C.panel, borderColor: C.hair, borderWidth: 1, bodyColor: C.ink,
          callbacks: {
            label: ctx => {
              const r = rows[ctx.dataIndex];
              const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : '0';
              return `  ${_ccySym(r.ccy)}${r.nativeTotal.toLocaleString('en-GB', { maximumFractionDigits: 0 })} ≈ ${sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { maximumFractionDigits: 0 })} (${pct}%)`;
            },
          },
        },
      },
    },
  }));
}

// ── FX Rate scatter sub-view ──────────────────────────────────────────────────

function _renderFxScatter(viewEl, rows, C) {
  const palette      = buildPalette(C);
  const quoteCcy     = (state.quoteCurrency || 'GBP').toUpperCase();
  const foreignRows  = rows.filter(r => r.ccy !== quoteCcy && r.txs.some(t => t.fx_rate));

  if (!foreignRows.length) {
    viewEl.innerHTML = `<p class="chart-empty" style="padding:24px 0">No foreign-currency transactions with FX rate data in this period.</p>`;
    _setChart(null);
    return;
  }

  const datasets = foreignRows.map((r, i) => ({
    label: r.ccy,
    data: r.txs
      .filter(t => t.fx_rate)
      .map(t => ({ x: new Date(t.tx_date_time).getTime(), y: t.fx_rate })),
    backgroundColor: palette[i % palette.length],
    pointRadius:     6,
    pointHoverRadius: 8,
  }));

  viewEl.innerHTML = `<div class="chart-container" style="height:260px"><canvas id="dash28-canvas"></canvas></div>`;

  const canvas = viewEl.querySelector('#dash28-canvas');
  if (!canvas) { _setChart(null); return; }

  _setChart(new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: C.ink, boxWidth: 12, padding: 10 } },
        tooltip: {
          backgroundColor: C.panel, borderColor: C.hair, borderWidth: 1, bodyColor: C.ink,
          callbacks: {
            label: ctx => {
              const d = new Date(ctx.parsed.x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
              return `  ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(4)} on ${d}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: C.muted, maxRotation: 0, maxTicksLimit: 6,
            callback: v => new Date(v).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
          },
          grid: { color: C.hair },
        },
        y: {
          ticks: { color: C.muted, callback: v => v.toFixed(4) },
          grid: { color: C.hair },
        },
      },
    },
  }));
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function _attachTabs(containerId, rows, sym, C) {
  const container = el(containerId);
  if (!container) return;

  container.querySelectorAll('[data-d28-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-d28-view]').forEach(b => {
        b.style.background = 'transparent'; b.style.color = 'var(--muted)';
      });
      btn.style.background = 'var(--teal)'; btn.style.color = 'var(--ink)';

      const viewEl = el('dash28-view');
      if (!viewEl) return;
      if (btn.dataset.d28View === 'currency') _renderByCurrency(viewEl, rows, sym, C);
      else _renderFxScatter(viewEl, rows, C);
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, sym }) {
  _chart = null;

  const container = el(containerId);
  if (!container) {
    console.warn('[insight-28] container not found:', containerId);
    return { destroy() { _destroyChart(); } };
  }

  const outTxs   = txs.filter(t => t.tx_type === 'money-out');
  if (!outTxs.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spend transactions for this period.</p></div>`;
    _setChart(null);
    return { destroy() { _destroyChart(); } };
  }

  const quoteCcy = (state.quoteCurrency || 'GBP').toUpperCase();
  const C        = getCssColors();
  const rows     = _groupByCurrency(outTxs, quoteCcy);

  const totalGbp     = rows.reduce((s, r) => s + r.gbpEquiv, 0);
  const domRow       = rows.find(r => r.ccy === quoteCcy);
  const domGbp       = domRow?.gbpEquiv || 0;
  const foreignGbp   = totalGbp - domGbp;
  const foreignRows  = rows.filter(r => r.ccy !== quoteCcy);
  const topForeign   = foreignRows[0] || null;
  const hasScatter   = foreignRows.some(r => r.txs.some(t => t.fx_rate));

  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = (v, tot) => tot > 0 ? ` (${Math.round((v / tot) * 100)}%)` : '';

  const tabBtn = (view, label, active) =>
    `<button data-d28-view="${view}" style="padding:6px 14px;border:none;border-radius:20px;font-size:var(--text-sm);cursor:pointer;background:${active ? 'var(--teal)' : 'transparent'};color:${active ? 'var(--ink)' : 'var(--muted)'}">${label}</button>`;

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Currencies used</p>
        <p class="stat-card-value">${esc(String(rows.length))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Domestic (${esc(quoteCcy)})</p>
        <p class="stat-card-value">${esc(fmt(domGbp))}</p>
        <p class="stat-card-sub">${esc(fmtPct(domGbp, totalGbp))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Foreign spend</p>
        <p class="stat-card-value${foreignGbp > 0 ? ' negative' : ''}">${esc(fmt(foreignGbp))}</p>
        <p class="stat-card-sub">${esc(fmtPct(foreignGbp, totalGbp))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Largest foreign</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(topForeign ? topForeign.ccy : '—')}</p>
        <p class="stat-card-sub">${esc(topForeign ? fmt(topForeign.gbpEquiv) : '')}</p>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
      ${tabBtn('currency', 'By Currency', true)}
      ${hasScatter ? tabBtn('fx-rates', 'FX Rates', false) : ''}
    </div>
    <div id="dash28-view"></div>`;

  const viewEl = el('dash28-view');
  _renderByCurrency(viewEl, rows, sym, C);
  _attachTabs(containerId, rows, sym, C);

  console.log(`[insight-28] currencies=${rows.length}, foreign_gbp=${foreignGbp.toFixed(0)}, has_scatter=${hasScatter}`);

  return { destroy() { _destroyChart(); } };
}
