/* global Chart */
import { el, esc } from '../../core/utils.js';
import { sumAmountBase, getCssColors, buildPalette, renderDrillTxTable } from './insight-utils.js';

const MAX_SEGMENTS = 7;  // segments beyond this are merged into "Other"

// ── Category grouping ─────────────────────────────────────────────────────────

function _groupByMajor(moneyOut) {
  const map = new Map();
  moneyOut.forEach(t => {
    const cat = t.major_category || 'Uncategorised';
    map.set(cat, (map.get(cat) || []).concat(t));
  });
  return map;
}

function _groupByMinor(moneyOut) {
  const map = new Map();
  moneyOut.forEach(t => {
    const key = `${t.major_category || 'Uncategorised'}|||${t.minor_category || '—'}`;
    if (!map.has(key)) map.set(key, { major: t.major_category || 'Uncategorised', minor: t.minor_category || '—', txs: [] });
    map.get(key).txs.push(t);
  });
  return map;
}

// ── Build segments (cap at MAX_SEGMENTS + "Other") ────────────────────────────

function _buildSegments(moneyOut) {
  const majorMap = _groupByMajor(moneyOut);
  const sorted   = [...majorMap.entries()]
    .map(([label, txs]) => ({ label, amount: sumAmountBase(txs) }))
    .sort((a, b) => b.amount - a.amount);

  if (sorted.length > MAX_SEGMENTS + 1) {
    const top   = sorted.slice(0, MAX_SEGMENTS);
    const other = sorted.slice(MAX_SEGMENTS).reduce((s, { amount }) => s + amount, 0);
    return [...top, { label: 'Other', amount: other }];
  }
  return sorted;
}

// ── HTML fragments ─────────────────────────────────────────────────────────────

function _legendHtml(segments, colors, total, sym) {
  const fmt = v => sym + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const items = segments.map(({ label, amount }, i) => {
    const pct = total > 0 ? ((amount / total) * 100).toFixed(1) : '0.0';
    return `
      <div style="display:flex;align-items:center;gap:6px;min-width:0">
        <span style="width:11px;height:11px;border-radius:2px;background:${esc(colors[i])};flex-shrink:0"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
        <span style="white-space:nowrap;color:var(--muted)">${esc(fmt(amount))}</span>
        <span style="white-space:nowrap;color:var(--muted);min-width:36px;text-align:right">${esc(pct)}%</span>
      </div>`;
  }).join('');
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;margin-top:16px;font-size:var(--text-sm)">${items}</div>`;
}

function _tableHtml(moneyOut, total, sym) {
  const minorMap = _groupByMinor(moneyOut);
  const rows     = [...minorMap.values()]
    .map(({ major, minor, txs }) => ({ major, minor, amount: sumAmountBase(txs) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  if (!rows.length) return '';

  const fmt   = v => sym + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const trHtml = rows.map(({ major, minor, amount }) => {
    const pct = total > 0 ? ((amount / total) * 100).toFixed(1) : '0.0';
    return `<tr>
      <td style="padding:5px 8px 5px 0">${esc(major)} → ${esc(minor)}</td>
      <td style="padding:5px 8px;text-align:right;white-space:nowrap">${esc(fmt(amount))}</td>
      <td style="padding:5px 0 5px 8px;text-align:right;color:var(--muted);white-space:nowrap">${esc(pct)}%</td>
    </tr>`;
  }).join('');

  return `
    <h3 style="font-size:var(--text-xs);color:var(--muted);margin:20px 0 8px;text-transform:uppercase;letter-spacing:.06em">Top minor categories</h3>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
        <thead>
          <tr style="border-bottom:1px solid var(--hair)">
            <th style="padding:5px 8px 5px 0;text-align:left;font-weight:600;color:var(--muted);font-size:var(--text-xs)">Category</th>
            <th style="padding:5px 8px;text-align:right;font-weight:600;color:var(--muted);font-size:var(--text-xs)">Amount</th>
            <th style="padding:5px 0 5px 8px;text-align:right;font-weight:600;color:var(--muted);font-size:var(--text-xs)">%</th>
          </tr>
        </thead>
        <tbody>${trHtml}</tbody>
      </table>
    </div>`;
}

// ── Drill panel — transactions in a major category ────────────────────────────

function _renderDrillPanel(drillEl, moneyOut, category, topLabels, sym) {
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const catTxs = (category === 'Other'
    ? moneyOut.filter(t => !topLabels.includes(t.major_category || 'Uncategorised'))
    : moneyOut.filter(t => (t.major_category || 'Uncategorised') === category)
  ).sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));

  const total = sumAmountBase(catTxs);

  drillEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(category)}</h3>
      <div style="display:flex;gap:8px;font-size:var(--text-xs);color:var(--muted)">
        <span>${esc(String(catTxs.length))} txs · ${esc(fmt(total))}</span>
        <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
      </div>
    </div>
    ${renderDrillTxTable(catTxs, sym)}`;

  drillEl.hidden = false;
  drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
  drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-08] container not found:', containerId);
    return null;
  }

  const moneyOut = txs.filter(t => t.tx_type === 'money-out');

  if (!moneyOut.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spending data for this period.</p></div>`;
    return null;
  }

  const segments  = _buildSegments(moneyOut);
  const total     = segments.reduce((s, { amount }) => s + amount, 0);
  const labels    = segments.map(({ label }) => label);
  const amounts   = segments.map(({ amount }) => amount);
  const topLabels = labels.filter(l => l !== 'Other'); // for "Other" bucket drill

  const C      = getCssColors();
  const palette = buildPalette(C);
  const colors  = segments.map((_, i) => palette[i % palette.length]);

  const fmt = v => sym + v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  container.innerHTML = `
    <div style="position:relative">
      <div class="chart-container"><canvas></canvas></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;width:120px">
        <p style="font-size:var(--text-lg);font-weight:700;line-height:1.2">${esc(fmt(total))}</p>
        <p style="font-size:var(--text-xs);color:var(--muted);margin-top:2px">tap to see transactions</p>
      </div>
    </div>
    ${_legendHtml(segments, colors, total, sym)}
    ${_tableHtml(moneyOut, total, sym)}
    <div id="dash08-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = container.querySelector('canvas');
  const drillEl = container.querySelector('#dash08-drill');
  if (!canvas) return null;

  console.log(`[insight-08] ${moneyOut.length} txs, ${segments.length} segments, total=${total.toFixed(0)}`);

  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: amounts, backgroundColor: colors, borderWidth: 2, hoverOffset: 8 }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      cutout:              '60%',
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const category = labels[elements[0].index];
        _renderDrillPanel(drillEl, moneyOut, category, topLabels, sym);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : '0.0';
              return ` ${fmt(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}
