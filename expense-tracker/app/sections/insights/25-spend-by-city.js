/* global Chart */
import { el, esc } from '../../core/utils.js';
import { state } from '../../core/state.js';
import { sumAmountBase, getCssColors, baseChartOptions, normCountry, domesticCountry, renderDrillTxTable } from './insight-utils.js';

const MAX_CITIES = 15;

function _normCountry(raw) { return normCountry(raw); }

// ── City key + label ──────────────────────────────────────────────────────────
// Composite "City, Country" to disambiguate same city in different countries.

function _cityKey(tx) {
  const city    = (tx.tx_location_city    || '').trim();
  const country = _normCountry(tx.tx_location_country || '');

  if (city && country)   return `${city}, ${country}`;
  if (city)              return city;
  if (country)           return `${country} (city unknown)`;
  return 'Unknown';
}

// ── Data grouping ─────────────────────────────────────────────────────────────

function _groupByCity(outTxs) {
  const map = new Map();
  for (const tx of outTxs) {
    const key = _cityKey(tx);
    if (!map.has(key)) map.set(key, { txs: [], country: _normCountry(tx.tx_location_country || '') });
    map.get(key).txs.push(tx);
  }

  const rows = [...map.entries()].map(([label, { txs, country }]) => {
    const total = sumAmountBase(txs);
    const count = txs.length;
    const catFreq = {};
    for (const t of txs) { const c = t.major_category || '—'; catFreq[c] = (catFreq[c] || 0) + 1; }
    const topCat   = Object.entries(catFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
    const home = domesticCountry();
    const isDomestic = home !== null && country === home;
    const isUnknown  = label === 'Unknown' || label.endsWith('(city unknown)');
    return { label, total, count, avg: count ? total / count : 0, topCat, isDomestic, isUnknown };
  });

  // Sort: domestic first (desc), then foreign (desc), then unknown last
  const domestic = rows.filter(r => r.isDomestic  && !r.isUnknown).sort((a, b) => b.total - a.total);
  const foreign  = rows.filter(r => !r.isDomestic && !r.isUnknown).sort((a, b) => b.total - a.total);
  const unknown  = rows.filter(r => r.isUnknown);
  const sorted   = [...domestic, ...foreign, ...unknown];

  const top  = sorted.slice(0, MAX_CITIES);
  const rest = sorted.slice(MAX_CITIES);
  if (rest.length) {
    const otherTotal = rest.reduce((s, r) => s + r.total, 0);
    const otherCount = rest.reduce((s, r) => s + r.count, 0);
    top.push({ label: 'Other', total: otherTotal, count: otherCount, avg: otherCount ? otherTotal / otherCount : 0, topCat: '—', isDomestic: false, isUnknown: true });
  }

  return top;
}

// ── Bar colour ────────────────────────────────────────────────────────────────

function _barColor(row, C) {
  if (row.isUnknown) return C.muted + '88';
  if (row.isDomestic) return C.teal;
  return '#f59e0b'; // amber for foreign cities
}

// ── Stat table ────────────────────────────────────────────────────────────────

function _tableHtml(rows, sym) {
  const fmt  = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const th   = (label, align) => `<th style="padding:8px;font-size:var(--text-xs);color:var(--muted);font-weight:600;white-space:nowrap;text-align:${align || 'left'}">${esc(label)}</th>`;
  const tdS  = (align) => `padding:9px 8px;font-size:var(--text-sm);border-bottom:1px solid var(--hair);text-align:${align || 'left'}`;

  const bodyRows = rows.map(r => {
    const label = r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label;
    return `<tr>
      <td style="${tdS()}">${esc(label)}</td>
      <td style="${tdS('right')}">${esc(fmt(r.total))}</td>
      <td style="${tdS('right')};color:var(--muted)">${esc(String(r.count))}</td>
      <td style="${tdS('right')};color:var(--muted)">${esc(fmt(r.avg))}</td>
      <td style="${tdS()};color:var(--muted)">${esc(r.topCat)}</td>
    </tr>`;
  }).join('');

  return `
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:20px">
      <table style="width:100%;border-collapse:collapse;min-width:420px">
        <thead><tr style="border-bottom:2px solid var(--hair)">${th('City')}${th('Spend','right')}${th('Txns','right')}${th('Avg/txn','right')}${th('Top category')}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

// ── Transaction drill panel ───────────────────────────────────────────────────

function _renderTxDrill(drillEl, outTxs, cityLabel, sym) {
  const fmt = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const cityTxs = outTxs
    .filter(t => _cityKey(t) === cityLabel)
    .sort((a, b) => new Date(b.tx_date_time) - new Date(a.tx_date_time));

  const total = sumAmountBase(cityTxs);

  drillEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h3 style="font-size:var(--text-sm);font-weight:600;margin:0">${esc(cityLabel)}</h3>
      <div style="display:flex;gap:8px;font-size:var(--text-xs);color:var(--muted)">
        <span>${esc(String(cityTxs.length))} txs · ${esc(fmt(total))}</span>
        <button data-action="drill-close" style="background:none;border:none;color:var(--muted);font-size:var(--text-sm);cursor:pointer;padding:0 4px">✕</button>
      </div>
    </div>
    ${renderDrillTxTable(cityTxs, sym)}`;

  drillEl.hidden = false;
  drillEl.querySelector('[data-action="drill-close"]')?.addEventListener('click', () => { drillEl.hidden = true; });
  drillEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function render(containerId, { txs, sym }) {
  const container = el(containerId);
  if (!container) {
    console.warn('[insight-25] container not found:', containerId);
    return null;
  }

  const outTxs = txs.filter(t => t.tx_type === 'money-out');
  if (!outTxs.length) {
    container.innerHTML = `<div class="chart-wrap"><p class="chart-empty">No spend transactions for this period.</p></div>`;
    return null;
  }

  const rows = _groupByCity(outTxs);
  const C    = getCssColors();

  const totalAll     = rows.filter(r => r.label !== 'Other').reduce((s, r) => s + r.total, 0);
  const domTotal     = rows.filter(r => r.isDomestic && !r.isUnknown).reduce((s, r) => s + r.total, 0);
  const foreignTotal = rows.filter(r => !r.isDomestic && !r.isUnknown).reduce((s, r) => s + r.total, 0);
  const cityCount    = rows.filter(r => !r.isUnknown && r.label !== 'Other').length;
  const allUnknown   = rows.length === 1 && rows[0].isUnknown;

  const fmt    = v => sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtPct = (v, total) => total > 0 ? ` (${Math.round((v / total) * 100)}%)` : '';

  const labels  = rows.map(r => r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label);
  const amounts = rows.map(r => r.total);
  const counts  = rows.map(r => r.count);
  const topCats = rows.map(r => r.topCat);
  const colors  = rows.map(r => _barColor(r, C));
  const h       = Math.max(240, rows.length * 44);

  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <p class="stat-card-label">Total spend</p>
        <p class="stat-card-value negative">${esc(fmt(totalAll))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Cities</p>
        <p class="stat-card-value">${esc(String(cityCount))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">Domestic</p>
        <p class="stat-card-value">${esc(fmt(domTotal))}</p>
        <p class="stat-card-sub">${esc(fmtPct(domTotal, totalAll))}</p>
      </div>
      <div class="stat-card">
        <p class="stat-card-label">International</p>
        <p class="stat-card-value">${esc(fmt(foreignTotal))}</p>
        <p class="stat-card-sub">${esc(fmtPct(foreignTotal, totalAll))}</p>
      </div>
    </div>
    ${allUnknown ? '<p style="font-size:var(--text-xs);color:var(--muted);margin:0 0 12px">Add city to transactions for a richer view.</p>' : ''}
    <div style="display:flex;gap:16px;margin-bottom:12px;font-size:var(--text-xs);color:var(--muted)">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${C.teal};margin-right:4px;vertical-align:middle"></span>Domestic</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#f59e0b;margin-right:4px;vertical-align:middle"></span>International</span>
    </div>
    <div class="chart-container" style="height:${h}px">
      <canvas id="dash25-canvas" style="width:100%;height:100%"></canvas>
    </div>
    ${_tableHtml(rows, sym)}
    <div id="dash25-drill" hidden style="margin-top:20px;padding:16px;background:var(--panel);border:1px solid var(--hair);border-radius:8px"></div>`;

  const canvas  = el('dash25-canvas');
  const drillEl = container.querySelector('#dash25-drill');
  if (!canvas) return null;

  // Build a full-fidelity label→txs map for city click (rows uses truncated labels for display)
  const fullLabels = rows.map(r => r.label); // original labels before truncation for chart display

  console.log(`[insight-25] cities=${rows.length}, domestic=${domTotal.toFixed(0)}, foreign=${foreignTotal.toFixed(0)}`);

  const base = baseChartOptions(sym, C);
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: amounts, backgroundColor: colors, borderRadius: 4 }],
    },
    options: {
      ...base,
      indexAxis: 'y',
      onClick: (_, elements) => {
        if (!elements.length || !drillEl) return;
        const cityLabel = fullLabels[elements[0].index];
        if (!cityLabel || cityLabel === 'Other') return;
        _renderTxDrill(drillEl, outTxs, cityLabel, sym);
      },
      plugins: {
        ...base.plugins,
        legend: { display: false },
        tooltip: {
          ...base.plugins.tooltip,
          callbacks: {
            title: ctx => rows[ctx[0]?.dataIndex]?.label || ctx[0]?.label || '',
            label: ctx => `  ${sym}${Math.abs(ctx.raw).toLocaleString('en-GB', { maximumFractionDigits: 0 })} · ${counts[ctx.dataIndex]} txn${counts[ctx.dataIndex] === 1 ? '' : 's'} · ${topCats[ctx.dataIndex]}`,
          },
        },
      },
      scales: {
        ...base.scales,
        x: {
          ...base.scales.x,
          ticks: {
            ...base.scales.x.ticks,
            callback: v => `${sym}${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
          },
        },
        y: { ...base.scales.y, ticks: { color: C.muted, font: { size: 11 } } },
      },
    },
  });
}
