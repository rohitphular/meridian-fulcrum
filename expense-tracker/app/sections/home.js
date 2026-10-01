/* global Chart */
import { state } from '../core/state.js';
import { el, esc, shareSnapshot } from '../core/utils.js';
import { ExpenseAPI } from '../core/api.js';
import { getCssColors, baseChartOptions, dtiStatusColor } from './insights/chart-theme.js';

// Renders get_home_view (api/view-home.gs) as-is: every figure, the period,
// the DTI status and the debt-free projection come from the server.
const HOME_VIEW = 'get_home_view';

let _charts   = [];
let _viewSeq  = 0;
let _viewError = '';

function _fmtFreedom(months) {
  if (months === null) return null;
  const yrs = Math.floor(months / 12);
  const mo  = months % 12;
  if (yrs === 0) return `${mo} month${mo !== 1 ? 's' : ''}`;
  if (mo  === 0) return `${yrs} year${yrs !== 1 ? 's' : ''}`;
  return `${yrs} yr${yrs !== 1 ? 's' : ''} ${mo} mo`;
}

function _fmt(sym, v, decimals = 0) {
  return sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function _fmtRatio(ratio) {
  return ratio === null || ratio === undefined ? 'N/A' : ratio.toFixed(1) + '%';
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function _renderHero(d, sym) {
  const { hero, dti } = d;
  const nwCls    = hero.net_worth >= 0 ? 'positive' : 'negative';
  const nwAccent = hero.net_worth >= 0 ? 'var(--teal)' : '#f87171';
  const dtiColor = dtiStatusColor(dti.status);

  return `
    <div class="home-hero-stats">
      <div class="home-hero-card" style="border-left:4px solid ${nwAccent}">
        <div class="home-hero-label">Net Worth</div>
        <div class="home-hero-value ${nwCls}">${esc(hero.net_worth < 0 ? '−' + _fmt(sym, hero.net_worth) : _fmt(sym, hero.net_worth))}</div>
        <div class="home-hero-sub">assets − liabilities</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid var(--teal)">
        <div class="home-hero-label">Avg Monthly Income</div>
        <div class="home-hero-value positive">${esc(_fmt(sym, hero.monthly_income))}</div>
        <div class="home-hero-sub">all-time average</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid ${hero.total_debt > 0 ? '#f87171' : 'var(--teal)'}">
        <div class="home-hero-label">Total Debt</div>
        <div class="home-hero-value ${hero.total_debt > 0 ? 'negative' : ''}">${esc(hero.total_debt > 0 ? '−' + _fmt(sym, hero.total_debt) : _fmt(sym, 0))}</div>
        <div class="home-hero-sub">all liabilities</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid ${esc(dtiColor)}">
        <div class="home-hero-label">DTI Ratio</div>
        <div class="home-hero-value" style="color:${esc(dtiColor)}">${esc(_fmtRatio(dti.ratio))}</div>
        <div class="home-hero-sub">${esc(dti.status_label)}</div>
      </div>
    </div>`;
}

function _renderIncomeCard(d, sym) {
  const { income, period } = d;
  const peak = income.peak;
  return `
    <div class="card home-chart-card">
      <div class="home-chart-title">Income Trend <span class="home-chart-period">${esc(period.label.toLowerCase())}</span></div>
      <div class="stat-cards home-income-stats" style="margin:12px 0 8px">
        <div class="stat-card">
          <p class="stat-card-label">Income</p>
          <p class="stat-card-value positive">${esc(_fmt(sym, income.total))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Monthly</p>
          <p class="stat-card-value">${esc(_fmt(sym, income.monthly_avg))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Annualised</p>
          <p class="stat-card-value">${esc(_fmt(sym, income.annualised))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Peak</p>
          <p class="stat-card-value" style="font-size:var(--text-base)">${esc(peak ? peak.label : '—')}</p>
          <p class="stat-card-sub">${esc(_fmt(sym, peak ? peak.value : 0))}</p>
        </div>
      </div>
      <div class="chart-container home-chart-grow">
        <canvas id="home-income-chart"></canvas>
      </div>
    </div>`;
}

function _renderDtiCard(d, sym) {
  const { dti, hero, debt_free: debtFree, period } = d;
  const dtiColor   = dtiStatusColor(dti.status);
  const freedomVal = debtFree.is_debt_free
    ? 'Now'
    : (debtFree.months !== null ? _fmtFreedom(debtFree.months) : '—');
  const amtSpan = `<span style="color:var(--teal);font-style:normal;font-weight:600">${esc(_fmt(sym, debtFree.monthly_reduction))}</span>`;
  const freedomNote = debtFree.months !== null && !debtFree.is_debt_free && debtFree.monthly_reduction > 0
    ? `<p class="home-dti-note"><em>At your current avg monthly debt reduction of ${amtSpan}, assuming income and lifestyle stay the same.</em></p>`
    : '';

  return `
    <div class="card home-chart-card">
      <div class="home-chart-title">Debt-to-Income <span class="home-chart-period">${esc(period.label.toLowerCase())}</span></div>
      <div style="position:relative;height:180px;margin:12px 0 4px">
        <canvas id="home-gauge-chart" style="width:100%;height:100%"></canvas>
        <div style="position:absolute;left:50%;bottom:14%;transform:translateX(-50%);text-align:center;pointer-events:none">
          <div style="font-size:var(--text-xl);font-weight:700;color:${esc(dtiColor)}">${esc(_fmtRatio(dti.ratio))}</div>
          <div style="font-size:var(--text-sm);color:var(--muted)">${esc(dti.status_label)}</div>
        </div>
      </div>
      ${!dti.has_income ? `<p style="font-size:var(--text-xs);color:var(--muted);text-align:center;margin:0 0 8px">No income data — DTI unavailable.</p>` : ''}
      <div class="stat-cards home-dti-stats" style="margin-bottom:0">
        <div class="stat-card">
          <p class="stat-card-label">Debt</p>
          <p class="stat-card-value ${hero.total_debt > 0 ? 'negative' : ''}">${esc(_fmt(sym, hero.total_debt))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Monthly</p>
          <p class="stat-card-value">${esc(hero.monthly_income > 0 ? _fmt(sym, hero.monthly_income) : '—')}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Annualised</p>
          <p class="stat-card-value">${esc(hero.annualised_income > 0 ? _fmt(sym, hero.annualised_income) : '—')}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Debt free</p>
          <p class="stat-card-value ${debtFree.is_debt_free ? 'positive' : ''}" style="font-size:var(--text-base)">${esc(freedomVal)}</p>
        </div>
      </div>
      ${freedomNote}
    </div>`;
}

function _rateWarnHtml(response) {
  const warning = (response.warnings ?? []).find(w => w?.code === 'missing_rate');
  if (!warning || !Array.isArray(warning.currencies) || warning.currencies.length === 0) return '';
  return `<div class="insight-warn" style="margin-bottom:10px">⚠ No exchange rate for <strong>${esc(warning.currencies.join(', '))}</strong> — affected amounts are left out.</div>`;
}

// ── Chart builders ────────────────────────────────────────────────────────────

function _buildIncomeChart(d, sym) {
  const canvas = el('home-income-chart');
  if (!canvas) return null;
  const C      = getCssColors();
  const base   = baseChartOptions(sym, C);
  const chart  = d.income.chart;
  const colors = chart.income.map((_, i) =>
    i === chart.peak_index ? 'rgba(52,211,153,1)' : 'rgba(52,211,153,0.65)'
  );
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels:   chart.labels,
      datasets: [{ label: 'Income', data: chart.income, backgroundColor: colors, borderRadius: 3 }],
    },
    options: {
      ...base,
      plugins: { ...base.plugins, legend: { display: false } },
      scales: {
        ...base.scales,
        x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 0, maxTicksLimit: 8 } },
      },
    },
  });
}

function _buildGaugeChart(d) {
  const canvas = el('home-gauge-chart');
  if (!canvas) return null;
  const C = getCssColors();
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data:            [d.dti.gauge_value, 100 - d.dti.gauge_value],
        backgroundColor: [dtiStatusColor(d.dti.status), C.hair],
        borderWidth:     0,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      rotation:            -90,
      circumference:       180,
      cutout:              '75%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function _destroyCharts() {
  _charts.forEach(c => { try { c?.destroy(); } catch (_) {} });
  _charts = [];
}

function _render() {
  _destroyCharts();
  const content = el('homeContent');
  if (!content) return;
  const response = state.views?.[HOME_VIEW];

  if (response?.ok !== true) {
    content.innerHTML = _viewError
      ? `<p class="placeholder" style="margin-top:32px">${esc(_viewError)}</p>`
      : '<p class="placeholder" style="margin-top:32px">Loading…</p>';
    return;
  }
  const d = response.data;
  if (!d.has_data) {
    content.innerHTML = `<p class="placeholder" style="margin-top:32px">No data yet — add transactions and accounts to see your dashboard.</p>`;
    return;
  }
  const sym = response.quote?.symbol ?? '';

  content.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn btn-secondary btn-sm" id="homeShareBtn">📤 Share</button>
    </div>
    ${_rateWarnHtml(response)}
    ${_renderHero(d, sym)}
    <div class="home-charts-grid">
      ${_renderIncomeCard(d, sym)}
      ${_renderDtiCard(d, sym)}
    </div>`;

  el('homeShareBtn')?.addEventListener('click', () => shareSnapshot(content, 'home-dashboard.png'));

  const incomeChart = _buildIncomeChart(d, sym);
  const gaugeChart  = _buildGaugeChart(d);
  if (incomeChart) _charts.push(incomeChart);
  if (gaugeChart)  _charts.push(gaugeChart);
}

async function _loadView() {
  const seq = ++_viewSeq;
  let response;
  try { response = await ExpenseAPI.view(HOME_VIEW, {}); }
  catch (error) {
    if (seq !== _viewSeq) return;
    console.error('[home] view failed:', error);
    _viewError = 'Home could not be loaded. Check your connection and refresh.';
    if (state.views?.[HOME_VIEW]?.ok !== true) _render();
    return;
  }
  if (seq !== _viewSeq) return;
  if (response?.ok !== true) {
    console.warn('[home] view failed:', response?.error);
    _viewError = response?.message || ('Home could not be loaded: ' + (response?.error ?? 'invalid_response'));
    if (state.views?.[HOME_VIEW]?.ok !== true) _render();
    return;
  }
  _viewError = '';
  state.views[HOME_VIEW] = response;
  _render();
}

// Called by navigation, quote-currency changes and every reload: renders the
// last payload at once, then refreshes it from the server.
export function renderHome() {
  if (state.views === undefined || state.views === null) state.views = {};
  _render();
  _loadView();
}
