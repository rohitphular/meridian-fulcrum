/* global Chart */
import { el, esc } from '../../core/utils.js';
import {
  groupByMonth, monthRange, sumAmountBase,
  getCssColors, buildPalette, baseChartOptions, fmtMonthKey, renderDrillTxTable,
} from './insight-utils.js';

const MAX_VISIBLE = 6;  // top N tags visible by default; rest togglable via legend

// ── Monthly tag attribution ────────────────────────────────────────────────────
// Split attribution: each tag on a tx receives (amount / tagCount).
// A £90 tx tagged rohit;reena;aryan contributes £30 to each tag's monthly total.

function _buildTagMonthly(moneyOut, monthKeys) {
  const byMonth   = groupByMonth(moneyOut);
  const tagMonthMap = new Map();  // tag → Map<monthKey, total>

  monthKeys.forEach(mk => {
    (byMonth.get(mk) || []).forEach(tx => {
      const tags = (tx.tags || '').split(';').map(t => t.toLowerCase().trim()).filter(Boolean);
      if (!tags.length) return;
      const share = sumAmountBase([tx]) / tags.length;
      tags.forEach(tag => {
        if (!tagMonthMap.has(tag)) tagMonthMap.set(tag, new Map());
        const monthMap = tagMonthMap.get(tag);
        monthMap.set(mk, (monthMap.get(mk) || 0) + share);
      });
    });
  });

  return tagMonthMap;
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

export async function render(containerId, { txs, sym, from, to }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-13] container not found:', containerId);
    return null;
  }

  const moneyOut  = txs.filter(t => t.tx_type === 'money-out');
  const monthKeys = monthRange(from, to);
  const tagMonthMap = _buildTagMonthly(moneyOut, monthKeys);

  if (!tagMonthMap.size) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No tagged transactions in this period.</p></div>`;
    return null;
  }

  // Sort tags by grand total descending
  const sorted = [...tagMonthMap.entries()]
    .map(([tag, monthMap]) => ({ tag, total: [...monthMap.values()].reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.total - a.total);

  const C       = getCssColors();
  const palette = buildPalette(C);
  const labels  = monthKeys.map(fmtMonthKey);

  const datasets = sorted.map(({ tag }, i) => {
    const monthMap = tagMonthMap.get(tag);
    return {
      label:            tag,
      data:             monthKeys.map(mk => monthMap.get(mk) || 0),
      borderColor:      palette[i % palette.length],
      backgroundColor:  palette[i % palette.length] + '22',
      tension:          0.3,
      pointRadius:      5,
      pointHoverRadius: 7,
      hidden:           i >= MAX_VISIBLE,
    };
  });

  const fmt      = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const topTag   = sorted[0];
  const tagCount = sorted.length;

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Distinct tags</p>
        <p class="stat-card-value">${esc(String(tagCount))}</p>
        ${tagCount > MAX_VISIBLE ? `<p class="stat-card-sub">top ${MAX_VISIBLE} shown</p>` : ''}
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Top tag</p>
        <p class="stat-card-value" style="font-size:var(--text-base)">${esc(topTag.tag)}</p>
        <p class="stat-card-sub">${esc(fmt(topTag.total))} — tap a point to drill</p>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas></canvas></div>
    </div>
    <div id="dash13-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = container.querySelector('canvas');
  const drillEl = container.querySelector('#dash13-drill');
  if (!canvas) return null;

  console.log(`[insight-13] ${tagCount} tags, ${monthKeys.length} months, visible=${Math.min(tagCount, MAX_VISIBLE)}`);

  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ..._buildChartOptions(sym, C),
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const dsIdx  = elements[0].datasetIndex;
        const ptIdx  = elements[0].index;
        const tag    = sorted[dsIdx]?.tag;
        const mk     = monthKeys[ptIdx];
        if (!tag || !mk) return;

        const tagTxs = moneyOut.filter(t => {
          if (!t.tx_date_time.startsWith(mk)) return false;
          return String(t.tags || '').split(';').map(s => s.toLowerCase().trim()).includes(tag);
        }).sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));

        const shareTotal = tagTxs.reduce((s, t) => {
          const tags = String(t.tags || '').split(';').filter(Boolean);
          return s + sumAmountBase([t]) / Math.max(tags.length, 1);
        }, 0);
        const fmtV = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

        drillEl.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h3 style="font-size:var(--text-sm);font-weight:600;margin:0"><em>${esc(tag)}</em> — ${esc(fmtMonthKey(mk))}</h3>
            <div style="display:flex;gap:8px;font-size:var(--text-xs);color:var(--muted)">
              <span>${esc(String(tagTxs.length))} txs · ${esc(fmtV(shareTotal))}</span>
              <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
            </div>
          </div>
          ${renderDrillTxTable(tagTxs, sym)}`;
        drillEl.hidden = false;
        drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
        drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    },
  });
}
