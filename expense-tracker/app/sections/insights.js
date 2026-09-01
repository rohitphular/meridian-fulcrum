/* global Chart */
import { state } from '../core/state.js';
import { el, esc, getSymbol, shareSnapshot } from '../core/utils.js';
import { getPeriodBounds, filterTxByRange, findMissingRates, getCssColors, baseChartOptions } from './insights/insight-utils.js';
import { ExpenseAPI } from '../core/api.js';

const INSIGHTS = [
  // Cash flow rates
  { id: '00-earn-burn-rate',    label: 'Income, Expense & Savings',  group: 'Cash flow',            tabs: false, description: 'Trailing-average income, expense, and savings rate per day — three lines in one view. Blue band = saving; red band = overspending. Use the window chips to adjust smoothing.', periods: ['last_3', 'last_6', 'last_12', 'ytd', 'last_year', 'custom'], defaultVariant: '30d' },
  // Spending comparisons
  { id: '01-mom-cumulative',    label: 'Month-on-Month daily cumulative', group: 'Spending comparisons', tabs: true,  description: 'Cumulative spend day-by-day through the month, compared against the previous month.',                          periods: ['this_month', 'last_month', 'custom'],                       pcChart: 'line'    },
  { id: '02-yoy-monthly',       label: 'Year-on-Year monthly',            group: 'Spending comparisons', tabs: true,  description: 'Monthly spend by calendar month, this year vs the same period last year.',                                   periods: ['this_month', 'last_month', 'ytd', 'last_year', 'custom'],  pcChart: 'bar'     },
  { id: '03-wow-daily',         label: 'Week-on-Week daily',              group: 'Spending comparisons', tabs: true,  description: 'Daily spend through the week, this week vs last week.',                                                       periods: ['this_week', 'last_week', 'last_7', 'custom'],               pcChart: 'line'    },
  { id: '04-qtd-comparison',    label: 'Quarter-to-date comparison',      group: 'Spending comparisons', tabs: true,  description: 'Spend so far this quarter, day-by-day, compared against the same number of days in the previous quarter.',    periods: ['this_quarter', 'last_quarter', 'custom'],                   pcChart: 'line'    },
  { id: '05-ytd-comparison',    label: 'Year-to-date comparison',         group: 'Spending comparisons', tabs: true,  description: 'Monthly spend this year vs the same months last year.',                                                       periods: ['ytd', 'last_year', 'custom'],                               pcChart: 'bar'     },
  { id: '06-last-12-months',    label: 'Last 12 months',                  group: 'Spending comparisons', tabs: true,  description: 'Income, expenses, and net savings per calendar month over the last 12 months.',                              periods: false,                                                        pcChart: 'stacked' },
  { id: '07-last-8-weeks',      label: 'Last 8 weeks',                    group: 'Spending comparisons', tabs: false, description: 'Weekly income and expenses over the last 8 weeks.',                                                           periods: false,                                                        pcChart: 'bar'     },
  // Categories
  { id: '08-category-pie',      label: 'Category breakdown',              group: 'Categories',           tabs: false, description: 'How your spending is split across categories this period. Click a segment to see the individual transactions.' },
  { id: '09-category-trend',    label: 'Category trend over time',        group: 'Categories',           tabs: false, description: 'How each category\'s spend has trended month by month over the selected period.',                                                                                                pcChart: 'stacked' },
  { id: '10-top-categories',    label: 'Top categories',                  group: 'Categories',           tabs: false, description: 'Your highest-spending categories this period vs the previous period.',                                                                                                           pcChart: 'hbar'    },
  { id: '11-category-drilldown', label: 'Category drilldown',             group: 'Categories',           tabs: false, description: 'Explore spending by major category, then drill into minor categories and individual transactions.' },
  { id: '12-tag-pie',           label: 'Tag breakdown',                   group: 'Categories',           tabs: false, description: 'How your tagged spend is distributed. Click a segment to see transactions for that tag.' },
  { id: '13-tag-trend',         label: 'Tag trend over time',             group: 'Categories',           tabs: false, description: 'How each tag\'s spend has changed month by month. Click a point to see transactions for that month.',                                                                           pcChart: 'line'    },
  // Net worth
  { id: '14-networth-trend',    label: 'Net worth trend',                 group: 'Net worth',            tabs: false, description: 'Total net worth (assets minus liabilities) over time. Click a point to see account balances at that date.',                                                                    pcChart: 'line'    },
  { id: '15-account-balances',  label: 'Account balances',                group: 'Net worth',            tabs: false, description: 'Current balance of every account, grouped by type.' },
  { id: '16-asset-vs-liability', label: 'Assets vs liabilities',          group: 'Net worth',            tabs: false, description: 'Total asset value vs total liability value over time.',                                                                                                                        pcChart: 'stacked' },
  { id: '17-liability-paydown', label: 'Liability paydown',               group: 'Net worth',            tabs: false, description: 'How your liabilities have changed over time, by liability account.',                                                                                                           pcChart: 'line'    },
  // Cash flow
  { id: '19-cashflow-waterfall', label: 'Cashflow waterfall',             group: 'Cash flow',            tabs: false, description: 'Where money came in and went out each month, shown as a waterfall. Click a bar to see transactions.',                                                                          pcChart: 'stacked' },
  { id: '20-savings-rate',      label: 'Savings rate',                    group: 'Cash flow',            tabs: false, description: 'What percentage of income is saved each month.' },
  { id: '21-income-sources',    label: 'Income sources',                  group: 'Cash flow',            tabs: false, description: 'Where your income comes from. Click a segment to see transactions for that source.' },
  // Counterparties
  { id: '22-top-counterparties', label: 'Top counterparties',             group: 'Counterparties',       tabs: false, description: 'Your highest-spend counterparties. Click a bar to see their monthly spend trend.' },
  { id: '23-recurring-payments', label: 'Recurring payments',             group: 'Counterparties',       tabs: false, description: 'Counterparties you pay regularly. Click a row to see their full payment history.' },
  // Geography
  { id: '24-spend-by-country',  label: 'Spend by country',                group: 'Geography',            tabs: false, description: 'How spend is distributed by country. Click a segment to see spend by city within that country.' },
  { id: '25-spend-by-city',     label: 'Spend by city',                   group: 'Geography',            tabs: false, description: 'How spend is distributed by city. Click a bar to see the individual transactions.' },
  // Loans
  { id: '26-loan-progress',     label: 'Loan progress',                   group: 'Loans',                tabs: false, description: 'Repayment progress for each active loan.' },
  { id: '27-debt-to-income',    label: 'Debt-to-income',                  group: 'Loans',                tabs: true,  description: 'Debt-to-income ratio trend and how it compares to common thresholds.', tabLabels: { transactions: 'Income trend', accounts: 'DTI ratio' } },
  // FX
  { id: '28-forex-spend',       label: 'Foreign currency spend',          group: 'FX & currency',        tabs: false, description: 'Spend in foreign currencies, converted to base currency.' },
  // Daily
  { id: '29-daily-spend',            label: 'Daily spend (with payments)',    group: 'Spending comparisons', tabs: false, description: 'Daily money-out as a bar chart — includes all categories. Click any bar to see that day\'s transactions.', periods: ['last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month', 'custom'] },
  { id: '30-daily-spend-no-payments', label: 'Daily spend (without payments)', group: 'Spending comparisons', tabs: false, description: 'Daily money-out excluding subscription-eligible categories (loan repayments, rent, recurring commitments). Click any bar to see that day\'s transactions.', periods: ['last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month', 'custom'] },
];

const PERIOD_OPTIONS = [
  { value: 'this_week',    label: 'This week'      },
  { value: 'last_week',    label: 'Last week'      },
  { value: 'last_7',       label: 'Last 7 days'    },
  { value: 'last_30',      label: 'Last 30 days'   },
  { value: 'last_60',      label: 'Last 60 days'   },
  { value: 'last_90',      label: 'Last 90 days'   },
  { value: 'this_month',   label: 'This month'     },
  { value: 'last_month',   label: 'Last month'     },
  { value: 'last_3',       label: 'Last 3 months'  },
  { value: 'last_6',       label: 'Last 6 months'  },
  { value: 'last_12',      label: 'Last 12 months' },
  { value: 'this_quarter', label: 'This quarter'   },
  { value: 'last_quarter', label: 'Last quarter'   },
  { value: 'ytd',          label: 'Year to date'   },
  { value: 'last_year',    label: 'Last year'      },
  { value: 'custom',       label: 'Custom range'   },
];

const _renderers = {};
let _renderId    = 0;  // incremented on every render; stale async continuations bail out
let _shellAbort  = null; // aborts previous shell event listeners before re-attaching

export function renderInsights() {
  _destroyChart();
  _applyChartDefaults();

  const container = el('insightContent');
  container.innerHTML = _buildShellHtml();
  _attachShellEvents();
  _renderActiveInsight();
}

// ── Shell HTML ─────────────────────────────────────────────────────────────────

function _buildShellHtml() {
  const dash = INSIGHTS.find(d => d.id === state.insightId) || INSIGHTS[0];

  // Snap state.insightPeriod to a valid option for this insight
  const allowedPeriods = Array.isArray(dash.periods) ? dash.periods : null;
  if (allowedPeriods && !allowedPeriods.includes(state.insightPeriod)) {
    state.insightPeriod = allowedPeriods[0];
  }

  // Group selector by group
  const groupMap = new Map();
  INSIGHTS.forEach(d => {
    if (!groupMap.has(d.group)) groupMap.set(d.group, []);
    groupMap.get(d.group).push(d);
  });
  const selectorHtml = [...groupMap.entries()].map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map(d =>
      `<option value="${esc(d.id)}"${d.id === state.insightId ? ' selected' : ''}>${esc(d.label)}</option>`
    ).join('')}</optgroup>`
  ).join('');

  const visiblePeriods = allowedPeriods
    ? PERIOD_OPTIONS.filter(p => allowedPeriods.includes(p.value))
    : PERIOD_OPTIONS;
  const periodHtml = visiblePeriods.map(p =>
    `<option value="${esc(p.value)}"${p.value === state.insightPeriod ? ' selected' : ''}>${esc(p.label)}</option>`
  ).join('');

  const hidePeriod  = dash.periods === false;
  const customHidden = (hidePeriod || state.insightPeriod !== 'custom') ? ' hidden' : '';

  const tl = dash.tabLabels || {};
  const tabStrip = dash.tabs
    ? `<div class="insight-tabs">
        <button class="insight-tab${state.insightTab === 'transactions' ? ' active' : ''}" data-action="insight-tab" data-tab="transactions">${esc(tl.transactions || 'Transactions')}</button>
        <button class="insight-tab${state.insightTab === 'accounts'     ? ' active' : ''}" data-action="insight-tab" data-tab="accounts">${esc(tl.accounts || 'Accounts')}</button>
      </div>`
    : '';

  const modeHtml = `
    <option value="precomputed"${state.insightMode === 'precomputed' ? ' selected' : ''}>Pre-Computed</option>
    <option value="live"${state.insightMode === 'live' ? ' selected' : ''}>Live</option>`;

  return `
    <div class="insight-controls">
      <div class="insight-top-row">
        <select class="insight-selector" id="insightSelector">${selectorHtml}</select>
        ${hidePeriod ? '' : `<select class="insight-period-select" id="insightPeriodSelect">${periodHtml}</select>`}
        <select class="insight-mode-select" id="insightModeSelect">${modeHtml}</select>
      </div>
      <div class="insight-custom-dates${customHidden}" id="insightCustomDates">
        <input type="date" id="insightCustomFrom" value="${esc(state.insightCustomFrom)}">
        <span class="insight-custom-sep">–</span>
        <input type="date" id="insightCustomTo" value="${esc(state.insightCustomTo)}">
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        ${dash.description ? `<p class="insight-description" style="margin:0;flex:1">${esc(dash.description)}</p>` : '<div style="flex:1"></div>'}
        <button class="btn btn-secondary btn-sm" id="insightShareBtn" data-action="snapshot" style="flex-shrink:0">📤 Share</button>
      </div>
      ${tabStrip}
    </div>
    <div id="insightInner"></div>`;
}

// ── Events ─────────────────────────────────────────────────────────────────────

function _attachShellEvents() {
  if (_shellAbort) _shellAbort.abort();
  _shellAbort = new AbortController();
  const { signal } = _shellAbort;
  const container = el('insightContent');

  container.addEventListener('change', e => {
    const id = e.target.id;

    if (id === 'insightSelector') {
      state.insightId  = e.target.value;
      state.insightTab = 'transactions';
      renderInsights();
      return;
    }
    if (id === 'insightPeriodSelect') {
      state.insightPeriod = e.target.value;
      const customDates = el('insightCustomDates');
      if (customDates) customDates.classList.toggle('hidden', state.insightPeriod !== 'custom');
      if (state.insightPeriod !== 'custom') _renderActiveInsight();
      return;
    }
    if (id === 'insightCustomFrom') {
      state.insightCustomFrom = e.target.value;
      if (state.insightCustomFrom && state.insightCustomTo) _renderActiveInsight();
      return;
    }
    if (id === 'insightCustomTo') {
      state.insightCustomTo = e.target.value;
      if (state.insightCustomFrom && state.insightCustomTo) _renderActiveInsight();
      return;
    }
    if (id === 'insightModeSelect') {
      state.insightMode = e.target.value;
      _renderActiveInsight();
    }
  }, { signal });

  container.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action } = btn.dataset;

    if (action === 'insight-tab') {
      state.insightTab = btn.dataset.tab;
      _destroyChart();
      container.querySelectorAll('.insight-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === state.insightTab)
      );
      _renderActiveInsight();
      return;
    }

    if (action === 'go-rates') {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'rates' }));
      return;
    }

    if (action === 'snapshot') {
      const target = el('insightContent');
      if (target) shareSnapshot(target, `insight-${state.insightId}.png`);
      return;
    }
  }, { signal });
}

// ── Render active insight ─────────────────────────────────────────────────────

async function _renderActiveInsight() {
  const inner = el('insightInner');
  if (!inner) return;

  // Stamp this render — stale async continuations bail when myId !== _renderId.
  const myId = ++_renderId;

  _destroyChart();
  inner.innerHTML = '<div class="insight-placeholder"><span class="spinner"></span>Loading…</div>';

  const dash         = INSIGHTS.find(d => d.id === state.insightId) || INSIGHTS[0];
  const { from, to } = getPeriodBounds(state.insightPeriod, state.insightCustomFrom, state.insightCustomTo);
  const txs          = filterTxByRange(state.transactions, from, to);
  const sym          = getSymbol(state.quoteCurrency);
  const missingRates = findMissingRates(txs, state.accounts);

  const rateWarn = missingRates.length
    ? `<div class="insight-warn">⚠ No exchange rate for <strong>${esc(missingRates.join(', '))}</strong> — affected transactions excluded from totals. <a href="#" data-action="go-rates">Add rates →</a></div>`
    : '';

  const periodKey   = dash.periods === false ? 'default' : state.insightPeriod;
  const derivedFrom = dash.tabs ? state.insightTab : 'default';

  const isPrecomputed = state.insightMode === 'precomputed';

  // Pre-Computed mode: always call the API for non-custom periods.
  // pcChart only governs rendering method, not whether we fetch.
  if (isPrecomputed && periodKey !== 'custom') {
    const [precomputed, renderer] = await Promise.all([
      ExpenseAPI.getComputedInsights({
        insight_id: state.insightId, period_key: periodKey,
        derived_from: derivedFrom, chart_variant: dash.defaultVariant,
      }).catch(() => null),
      _loadRenderer(state.insightId),
    ]);

    if (myId !== _renderId) return;

    inner.innerHTML = `${rateWarn}<div id="insightChart"></div>`;

    if (!precomputed?.ok) {
      el('insightChart').innerHTML =
        `<div class="insight-placeholder">No pre-computed data for <strong>${esc(state.insightId)}</strong> / <strong>${esc(periodKey)}</strong>.<br>Run the insights job or switch to <em>Live</em> mode.</div>`;
      return;
    }

    // Precomputed data available — generic render if pcChart supports it.
    if (dash.pcChart) {
      const chartInstance = _renderFromPayload(el('insightChart'), precomputed.data, dash, sym);
      if (myId !== _renderId) { try { chartInstance?.destroy(); } catch (_) {} return; }
      if (chartInstance) state.insightChartInstance = chartInstance;
      _appendComputedAt(inner, precomputed.computed_at, false);
      return;
    }

    // No generic renderer — fall through to local renderer but honour the server timestamp.
    if (renderer) {
      const chartInstance = await renderer.render('insightChart', {
        txs, accounts: state.accounts, from, to, sym,
        tab: state.insightTab, period: state.insightPeriod,
        precomputed: precomputed.data,
      });
      if (myId !== _renderId) { try { chartInstance?.destroy(); } catch (_) {} return; }
      if (chartInstance) state.insightChartInstance = chartInstance;
      _appendComputedAt(inner, precomputed.computed_at, false);
    }
    return;
  }

  // Live mode: skip API entirely, always compute locally.
  const renderer = await _loadRenderer(state.insightId);

  if (myId !== _renderId) return;

  inner.innerHTML = `${rateWarn}<div id="insightChart"></div>`;

  if (!renderer) {
    inner.innerHTML = `${rateWarn}<div class="insight-placeholder">Insight <strong>${esc(state.insightId)}</strong> is not yet implemented.</div>`;
    return;
  }

  const chartInstance = await renderer.render('insightChart', {
    txs,
    accounts: state.accounts,
    from,
    to,
    sym,
    tab:    state.insightTab,
    period: state.insightPeriod,
  });

  if (myId !== _renderId) {
    try { chartInstance?.destroy(); } catch (_) {}
    return;
  }

  if (chartInstance) state.insightChartInstance = chartInstance;
  _appendComputedAt(inner, new Date().toISOString(), true);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Generic renderer for precomputed payloads. Handles 'line', 'bar', 'stacked', 'hbar'.
// Returns a Chart.js instance, or null if the payload isn't compatible (falls through to local).
function _renderFromPayload(container, payload, dash, sym) {
  const { stat_cards, chart } = payload ?? {};
  if (!chart || !Array.isArray(chart.labels) || !Array.isArray(chart.datasets)) return null;

  const C    = getCssColors();
  const base = baseChartOptions(sym, C);

  const cardsHtml = (stat_cards ?? []).map(c => `
    <div class="stat-card">
      <p class="stat-card-label">${esc(c.label)}</p>
      <p class="stat-card-value ${esc(c.class)}">${esc(c.value)}</p>
      ${c.sub ? `<p class="stat-card-sub">${esc(c.sub)}</p>` : ''}
    </div>`).join('');

  container.innerHTML = `
    <div class="stat-cards">${cardsHtml}</div>
    <div class="chart-wrap"><div class="chart-container"><canvas></canvas></div></div>`;

  const canvas = container.querySelector('canvas');
  if (!canvas) return null;

  let type      = 'bar';
  let extraOpts = {};

  switch (dash.pcChart) {
    case 'line':
      type = 'line';
      break;
    case 'stacked':
      extraOpts = {
        scales: {
          x: { ...base.scales.x, stacked: true },
          y: { ...base.scales.y, stacked: true },
        },
      };
      break;
    case 'hbar':
      extraOpts = {
        indexAxis: 'y',
        scales: {
          x: { ...base.scales.y },
          y: { ticks: { color: C.muted, font: { size: 11 } }, grid: { color: C.hair }, border: { display: false } },
        },
      };
      break;
    // 'bar' — default type, no extra opts
  }

  return new Chart(canvas, {
    type,
    data:    { labels: chart.labels, datasets: chart.datasets },
    options: { ...base, ...extraOpts },
  });
}

function _fmtAge(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins <  1)  return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _appendComputedAt(inner, isoStr, isLive) {
  const label = isLive ? `Live · ${_fmtAge(isoStr)}` : `Computed ${_fmtAge(isoStr)}`;
  const cls   = isLive ? 'insight-meta-live' : 'insight-meta-cached';
  const div   = document.createElement('div');
  div.className = 'insight-meta';
  div.innerHTML = `<span class="insight-meta-dot ${esc(cls)}"></span>${esc(label)}`;
  inner.appendChild(div);
}

async function _loadRenderer(insightId) {
  if (Object.prototype.hasOwnProperty.call(_renderers, insightId)) return _renderers[insightId];
  try {
    const mod = await import(`./insights/${insightId}.js`);
    _renderers[insightId] = mod;
    return mod;
  } catch (_) {
    return null; // don't cache failures — next selection will retry the import
  }
}

function _destroyChart() {
  if (state.insightChartInstance) {
    try { state.insightChartInstance.destroy(); } catch (_) {}
    state.insightChartInstance = null;
  }
}

function _applyChartDefaults() {
  if (!window.Chart) return;
  const s = getComputedStyle(document.documentElement);
  window.Chart.defaults.font.family = s.getPropertyValue('--grotesk').trim() || 'inherit';
  window.Chart.defaults.font.size   = 12;
  window.Chart.defaults.color       = s.getPropertyValue('--ink').trim();
}
