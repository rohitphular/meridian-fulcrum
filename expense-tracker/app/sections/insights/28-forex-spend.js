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
  const accountMap = new Map((state.accounts ?? []).map(a => [a.id, a]));
  const map = new Map();
  for (const tx of outTxs) {
    const acc = accountMap.get(tx.account_id);
    const ccy = (acc ? acc.currency : quoteCcy ?? 'GBP').trim().toUpperCase();
    if (!map.has(ccy)) map.set(ccy, []);
    map.get(ccy).push({ tx, acc });
  }

  const rows = [...map.entries()].map(([ccy, entries]) => {
    const txs         = entries.map(e => e.tx);
    const nativeTotal = txs.reduce((s, t) => s + Math.abs(Number(t.tx_amount_local)), 0);
    const gbpEquiv    = sumAmountBase(txs);
    const count       = txs.length;
    // fx_rate is not stored on transactions — use rateMap for display purposes only
    const rateFromMap = state.rateMap?.[ccy] || null;
    const avgRate     = rateFromMap;
    const hasEstimated = false;
    const rateUnavail = ccy !== quoteCcy && !avgRate;
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

  const quoteCcy = (state.quoteCurrency ?? 'GBP').toUpperCase();
  const C        = getCssColors();
  const rows     = _groupByCurrency(outTxs, quoteCcy);

  const totalGbp     = rows.reduce((s, r) => s + r.gbpEquiv, 0);
  const domRow       = rows.find(r => r.ccy === quoteCcy);
  const domGbp       = domRow ? domRow.gbpEquiv : 0;
  const foreignGbp   = totalGbp - domGbp;
  const foreignRows  = rows.filter(r => r.ccy !== quoteCcy);
  const topForeign   = foreignRows.length ? foreignRows[0] : null;
  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = (v, tot) => tot > 0 ? ` (${Math.round((v / tot) * 100)}%)` : '';

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
    <div id="dash28-view"></div>`;

  const viewEl = el('dash28-view');
  _renderByCurrency(viewEl, rows, sym, C);

  console.log(`[insight-28] currencies=${rows.length}, foreign_gbp=${foreignGbp.toFixed(0)}`);

  return { destroy() { _destroyChart(); } };
}
