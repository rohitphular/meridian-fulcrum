/* global Chart */
import { state } from '../core/state.js';
import { el, esc, getSymbol, toBase, shareSnapshot } from '../core/utils.js';
import {
  monthRange, groupByMonth, sumAmountBase,
  computeDailyTotalAssets, getCssColors, baseChartOptions, fmtMonthKey,
} from './insights/insight-utils.js';

let _charts = [];

// ── Bounds ────────────────────────────────────────────────────────────────────

function _allTimeBounds() {
  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!state.transactions.length) {
    return { from: new Date(today.getFullYear(), 0, 1), to: todayLocal };
  }
  let minTs = Infinity;
  state.transactions.forEach(tx => {
    const d = new Date(tx.tx_date_time);
    if (!isNaN(d)) minTs = Math.min(minTs, d.getTime());
  });
  const earliest = new Date(minTs);
  return { from: new Date(earliest.getFullYear(), earliest.getMonth(), 1), to: todayLocal };
}

function _monthEnd(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo, 0);
}

function _monthStart(yyyyMM) {
  const [yr, mo] = yyyyMM.split('-').map(Number);
  return new Date(yr, mo - 1, 1);
}

// ── DTI helpers ───────────────────────────────────────────────────────────────

function _dtiColor(dti) {
  if (dti < 20) return '#34d399';
  if (dti < 36) return '#14b8a6';
  if (dti < 50) return '#f59e0b';
  return '#f87171';
}

function _dtiStatus(dti) {
  if (dti < 20) return 'Excellent';
  if (dti < 36) return 'Good';
  if (dti < 50) return 'Caution';
  return 'High risk';
}

function _fmtFreedom(months) {
  if (months === null) return null;
  const yrs = Math.floor(months / 12);
  const mo  = months % 12;
  if (yrs === 0) return `${mo} month${mo !== 1 ? 's' : ''}`;
  if (mo  === 0) return `${yrs} year${yrs !== 1 ? 's' : ''}`;
  return `${yrs} yr${yrs !== 1 ? 's' : ''} ${mo} mo`;
}

// ── Core computations ─────────────────────────────────────────────────────────

function _compute() {
  const { from, to } = _allTimeBounds();
  const txs          = state.transactions;
  const accounts     = state.accounts;
  const sym          = getSymbol(state.quoteCurrency);

  const today      = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const curYYYYMM  = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}`;

  const monthKeys     = monthRange(from, to);
  const inByMonth     = groupByMonth(txs.filter(t => t.tx_type === 'money-in'));
  const outByMonth    = groupByMonth(txs.filter(t => t.tx_type === 'money-out'));
  const completeMKs   = monthKeys.filter(mk => mk !== curYYYYMM);
  const avgMonths     = completeMKs.length || monthKeys.length;
  const totalIncome   = (completeMKs.length ? completeMKs : monthKeys)
    .reduce((s, mk) => s + sumAmountBase(inByMonth.get(mk) || []), 0);
  const monthlyIncome    = avgMonths > 0 ? totalIncome / avgMonths : 0;
  const annualisedIncome = monthlyIncome * 12;

  const monthlyInc  = monthKeys.map(mk => sumAmountBase(inByMonth.get(mk)  || []));
  const monthlyOut  = monthKeys.map(mk => sumAmountBase(outByMonth.get(mk) || []));

  // Peak income month
  let peakIdx = 0;
  monthlyInc.forEach((v, i) => { if (v > monthlyInc[peakIdx]) peakIdx = i; });

  // Liability accounts + total debt
  const liabAccts = accounts.filter(a => a.is_active && a.type === 'liability');
  const totalDebt = liabAccts.length
    ? Math.abs(computeDailyTotalAssets(liabAccts, txs, todayLocal, todayLocal)[0] || 0)
    : 0;

  // DTI
  const hasDTI    = annualisedIncome > 0;
  const dtiRatio  = hasDTI ? (totalDebt / annualisedIncome) * 100 : null;
  const dtiVal    = dtiRatio !== null ? Math.min(dtiRatio, 100) : 0;
  const gaugeColor = dtiRatio !== null ? _dtiColor(dtiRatio) : '#94a3b8';
  const statusText = dtiRatio !== null
    ? (totalDebt === 0 ? 'Debt-free' : _dtiStatus(dtiRatio))
    : 'N/A';

  // Debt-free projection: linear extrapolation from earliest debt to now
  let monthsToFreedom      = null;
  let monthlyDebtReduction = 0;
  if (totalDebt === 0) {
    monthsToFreedom = 0;
  } else if (liabAccts.length && monthKeys.length >= 2) {
    const daily = computeDailyTotalAssets(
      liabAccts, txs,
      _monthStart(monthKeys[0]),
      _monthStart(monthKeys[0]),
    );
    const debtAtStart  = Math.abs(daily[0] || 0);
    const totalMonths  = monthKeys.length;
    monthlyDebtReduction = (debtAtStart - totalDebt) / totalMonths;
    if (monthlyDebtReduction > 0) {
      monthsToFreedom = Math.ceil(totalDebt / monthlyDebtReduction);
    }
  }

  // Net worth
  const assetAccts  = accounts.filter(a => a.is_active && (a.type === 'asset' || a.type === 'investment'));
  const totalAssets = assetAccts.reduce((s, a) => s + toBase(parseFloat(a.current_value || 0), a.currency, null), 0);
  const netWorth    = totalAssets - totalDebt;

  return {
    sym, monthKeys, monthlyInc, monthlyOut,
    monthlyIncome, annualisedIncome, peakIdx,
    totalDebt, totalAssets, netWorth,
    dtiRatio, dtiVal, gaugeColor, statusText, hasDTI,
    monthsToFreedom, monthlyDebtReduction,
    from, to,
  };
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function _fmt(sym, v, decimals = 0) {
  return sym + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function _renderHero(d) {
  const { sym, netWorth, monthlyIncome, totalDebt, dtiRatio, gaugeColor, statusText } = d;
  const nwCls    = netWorth >= 0 ? 'positive' : 'negative';
  const nwAccent = netWorth >= 0 ? 'var(--teal)' : '#f87171';
  const dtiStr   = dtiRatio !== null ? dtiRatio.toFixed(1) + '%' : 'N/A';

  return `
    <div class="home-hero-stats">
      <div class="home-hero-card" style="border-left:4px solid ${nwAccent}">
        <div class="home-hero-label">Net Worth</div>
        <div class="home-hero-value ${nwCls}">${esc(netWorth < 0 ? '−' + _fmt(sym, netWorth) : _fmt(sym, netWorth))}</div>
        <div class="home-hero-sub">assets − liabilities</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid var(--teal)">
        <div class="home-hero-label">Avg Monthly Income</div>
        <div class="home-hero-value positive">${esc(_fmt(sym, monthlyIncome))}</div>
        <div class="home-hero-sub">all-time average</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid ${totalDebt > 0 ? '#f87171' : 'var(--teal)'}">
        <div class="home-hero-label">Total Debt</div>
        <div class="home-hero-value ${totalDebt > 0 ? 'negative' : ''}">${esc(totalDebt > 0 ? '−' + _fmt(sym, totalDebt) : _fmt(sym, 0))}</div>
        <div class="home-hero-sub">active liabilities</div>
      </div>
      <div class="home-hero-card" style="border-left:4px solid ${gaugeColor}">
        <div class="home-hero-label">DTI Ratio</div>
        <div class="home-hero-value" style="color:${gaugeColor}">${esc(dtiStr)}</div>
        <div class="home-hero-sub">${esc(statusText)}</div>
      </div>
    </div>`;
}

function _renderIncomeCard(d) {
  const { sym, monthlyInc, monthlyIncome, annualisedIncome, peakIdx, monthKeys } = d;
  const totalIncome = monthlyInc.reduce((s, v) => s + v, 0);
  const peakLabel   = monthKeys.length ? fmtMonthKey(monthKeys[peakIdx]) : '—';
  const peakAmt     = monthKeys.length ? monthlyInc[peakIdx] : 0;
  return `
    <div class="card home-chart-card">
      <div class="home-chart-title">Income Trend <span class="home-chart-period">all-time</span></div>
      <div class="stat-cards home-income-stats" style="margin:12px 0 8px">
        <div class="stat-card">
          <p class="stat-card-label">Income</p>
          <p class="stat-card-value positive">${esc(_fmt(sym, totalIncome))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Monthly</p>
          <p class="stat-card-value">${esc(_fmt(sym, monthlyIncome))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Annualised</p>
          <p class="stat-card-value">${esc(_fmt(sym, annualisedIncome))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Peak</p>
          <p class="stat-card-value" style="font-size:var(--text-base)">${esc(peakLabel)}</p>
          <p class="stat-card-sub">${esc(_fmt(sym, peakAmt))}</p>
        </div>
      </div>
      <div class="chart-container home-chart-grow">
        <canvas id="home-income-chart"></canvas>
      </div>
    </div>`;
}

function _renderDtiCard(d) {
  const { sym, dtiRatio, dtiVal, gaugeColor, statusText, hasDTI, totalDebt, monthlyIncome, annualisedIncome, monthsToFreedom, monthlyDebtReduction } = d;
  const dtiStr     = dtiRatio !== null ? dtiRatio.toFixed(1) + '%' : 'N/A';
  const freedomVal = totalDebt === 0
    ? 'Now'
    : (monthsToFreedom !== null ? _fmtFreedom(monthsToFreedom) : '—');
  const _amtSpan = `<span style="color:var(--teal);font-style:normal;font-weight:600">${esc(_fmt(sym, monthlyDebtReduction))}</span>`;
  const freedomNote = monthsToFreedom !== null && totalDebt > 0 && monthlyDebtReduction > 0
    ? `<p class="home-dti-note"><em>At your current avg monthly debt reduction of ${_amtSpan}, assuming income and lifestyle stay the same.</em></p>`
    : '';

  return `
    <div class="card home-chart-card">
      <div class="home-chart-title">Debt-to-Income <span class="home-chart-period">all-time</span></div>
      <div style="position:relative;height:180px;margin:12px 0 4px">
        <canvas id="home-gauge-chart" style="width:100%;height:100%"></canvas>
        <div style="position:absolute;left:50%;bottom:14%;transform:translateX(-50%);text-align:center;pointer-events:none">
          <div style="font-size:var(--text-xl);font-weight:700;color:${gaugeColor}">${esc(dtiStr)}</div>
          <div style="font-size:var(--text-sm);color:var(--muted)">${esc(statusText)}</div>
        </div>
      </div>
      ${!hasDTI ? `<p style="font-size:var(--text-xs);color:var(--muted);text-align:center;margin:0 0 8px">No income data — DTI unavailable.</p>` : ''}
      <div class="stat-cards home-dti-stats" style="margin-bottom:0">
        <div class="stat-card">
          <p class="stat-card-label">Debt</p>
          <p class="stat-card-value ${totalDebt > 0 ? 'negative' : ''}">${esc(_fmt(sym, totalDebt))}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Monthly</p>
          <p class="stat-card-value">${esc(monthlyIncome > 0 ? _fmt(sym, monthlyIncome) : '—')}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Annualised</p>
          <p class="stat-card-value">${esc(annualisedIncome > 0 ? _fmt(sym, annualisedIncome) : '—')}</p>
        </div>
        <div class="stat-card">
          <p class="stat-card-label">Debt free</p>
          <p class="stat-card-value ${totalDebt === 0 ? 'positive' : ''}" style="font-size:var(--text-base)">${esc(freedomVal)}</p>
        </div>
      </div>
      ${freedomNote}
    </div>`;
}

// ── Chart builders ────────────────────────────────────────────────────────────

function _buildIncomeChart(d) {
  const canvas = el('home-income-chart');
  if (!canvas) return null;
  const C      = getCssColors();
  const base   = baseChartOptions(d.sym, C);
  const colors = d.monthlyInc.map((_, i) =>
    i === d.peakIdx ? 'rgba(52,211,153,1)' : 'rgba(52,211,153,0.65)'
  );
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels:   d.monthKeys.map(fmtMonthKey),
      datasets: [{
        label:           'Income',
        data:            d.monthlyInc,
        backgroundColor: colors,
        borderRadius:    3,
      }],
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
        data:            [d.dtiVal, 100 - d.dtiVal],
        backgroundColor: [d.gaugeColor, C.hair],
        borderWidth:     0,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      rotation:            -90,
      circumference:       180,
      cutout:              '75%',
      plugins: {
        legend:  { display: false },
        tooltip: { enabled: false },
      },
    },
  });
}

// ── Public render ─────────────────────────────────────────────────────────────

export function renderHome() {
  _charts.forEach(c => { try { c?.destroy(); } catch (_) {} });
  _charts = [];

  const content = el('homeContent');
  if (!content) return;

  if (!state.transactions.length && !state.accounts.length) {
    content.innerHTML = `<p class="placeholder" style="margin-top:32px">No data yet — add transactions and accounts to see your dashboard.</p>`;
    return;
  }

  const d = _compute();

  content.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn btn-secondary btn-sm" id="homeShareBtn">📤 Share</button>
    </div>
    ${_renderHero(d)}
    <div class="home-charts-grid">
      ${_renderIncomeCard(d)}
      ${_renderDtiCard(d)}
    </div>`;

  el('homeShareBtn')?.addEventListener('click', () => shareSnapshot(content, 'home-dashboard.png'));

  const incomeChart = _buildIncomeChart(d);
  const gaugeChart  = _buildGaugeChart(d);

  if (incomeChart) _charts.push(incomeChart);
  if (gaugeChart)  _charts.push(gaugeChart);
}
