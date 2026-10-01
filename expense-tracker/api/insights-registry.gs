// =============================================================================
// FULCRUM FORGE — Insights registry, get_insight dispatcher and shared helpers
//
// GET action (registered only through insightsRegister, a get-registry.gs hook):
//   get_insight  params: id (or insight_id), period, from, to, compare, tab,
//                drill (JSON object), sort, sort_dir, window, top_n, …
//                + quote_currency / tz / today (view-context.gs).
//
// ── Extension mechanism (porting agents never edit this file) ────────────────
// Each insight is computed by a global function in its own insights-*.gs file:
//
//   function insightCompute_<id with - → _>(ictx) { … return payload | insError(…); }
//   e.g. insightCompute_29_daily_spend, insightCompute_10_top_categories
//
// _insHooks(id) looks every one of them up with an explicit typeof check (all
// 30 names are pre-listed below), so defining the function is all it takes:
// the registry then reports server:true and get_insight dispatches to it.
// The client renders server:true insights from get_insight and keeps the old
// client module for server:false ones (so each sub-batch stays deployable).
//
// Optional metadata override, also pre-listed:
//   function insightMeta_<id>() { return { periods: [...], default_period: 'x',
//     tabs: [{key,label}], params: [...], render_kind: 'bar', description: '…' }; }
// Keys returned replace the base entry below (id / group / title stay).
//
// ── ictx (argument of every compute function) ────────────────────────────────
// { ctx, id, entry, params (raw string params), quote_currency, symbol, tz, today,
//   period: { key, label, from, to, days, compare_from, compare_to } | null
//           (null only for insights without a period selector and no default),
//   compare: { mode:'previous'|'last_year'|'none', from, to, label } | null,
//   tab: 'transactions' | 'accounts' | … | null, drill: {…} | null (parsed JSON),
//   fx, missing: { CCY: true } (filled by the helpers; becomes the warning) }
//
// ── Payload schema (what a compute function returns; the dispatcher adds the
//    standard fields and wraps it in vmEnvelope) ──────────────────────────────
// data = {
//   insight_id, title, description,                     // dispatcher
//   period: { key,label,from,to,days,compare_from,compare_to } | null,  // dispatcher
//   compare: { mode, from, to, label } | null,          // dispatcher
//   tab: key | null, tabs: [{ key, label, active }],    // dispatcher (from registry)
//   controls: [{ param:'window'|'top_n'|…, label?, value, options:[{ value, label }] }],
//       chip / pill rows; clicking re-requests get_insight with { [param]: value }.
//   stat_cards: [{ key, label, value, format, sub?, tone? }],
//       value: number | string | null; format: FORMAT; tone: TONE (default neutral).
//   charts: [{
//     id, kind: 'line'|'bar'|'hbar'|'stacked'|'stacked_hbar'|'area'|'mixed'|
//               'donut'|'pie'|'gauge'|'waterfall',
//     title?, height? (px hint), labels: [string],
//     datasets: [{ key, label, data: [number|null] (waterfall: [[start, end]]),
//                  style: STYLE, kind?: 'bar'|'line' (mixed only), dashed?: bool,
//                  fill?: 'none'|'origin'|'signed' (signed = above/below zero tint),
//                  point_tones?: [TONE per point] (bar colour per point), axis?: 'y'|'y2',
//                  hidden?: bool }],
//     y_format: FORMAT (default 'money'), y2_format?, y_min?: number, y_max?: number,
//     ref_lines: [{ value, label, tone, axis? }],
//     gauge?: { value, max, status, label, sub } (kind 'gauge'),
//     drill?: { param, values: [value per label index], mode: 'panel'|'replace', hint?,
//               series_param?, null_text? },
//         click on point i → get_insight(same params + drill: { [param]: values[i] }).
//         'panel' re-renders only the drill panel; 'replace' re-renders the insight.
//         series_param: a click on a line point also sends { [series_param]:
//         datasets[d].key } of the clicked series (e.g. 13: { month, tag }).
//         null_text: shown under the chart when a point whose value is null
//         (not drillable, e.g. an 'Other' bucket) is clicked.
//     empty_text? }],
//   tables: [{ id, title?, columns: [{ key, label, format, align?: 'left'|'right'|'center' }],
//              rows: [{ key?, cells: { col: value }, tone?, drill?: { param, value, mode } }],
//              total_row?: { cells }, sortable: [col], sort: { col, dir } | null, empty_text? }],
//       clicking a sortable header re-requests with sort=<col>&sort_dir=<asc|desc>.
//   drill: { title, subtitle?, rows: [TxRow], total_count, shown_count, total_quote,
//            charts?: [<chart>] (drawn in the panel, e.g. a counterparty's monthly
//                     trend or a loan's cumulative repayments),
//            table?: <table> (non-transaction drill, e.g. balances at a date),
//            query?: { action:'list_transactions_view', params, note } } | null,
//       TxRow = list_transactions_view row (view-transactions.gs _vwTxRow).
//   breadcrumbs: [{ label, drill: {…} | null }],  // 'replace' drill levels; last = current
//   notes: [{ text, tone? }], empty: { text } | null  (empty → nothing else is drawn)
// }
// FORMAT: 'money' (quote currency, 0 dp, − for negatives) | 'money2' (2 dp) |
//         'money_delta' (+/−) | 'percent' (1 dp) | 'percent_delta' | 'count' |
//         'days' | 'text' | 'date' ('YYYY-MM-DD') | 'month' ('YYYY-MM') |
//         'progress' (table cells only: 0–100 drawn as a bar + percent).
// TONE:   'positive'|'negative'|'neutral'|'warn'|'muted'|'primary'|'highlight'.
// STYLE:  'primary'|'compare'|'income'|'expense'|'savings'|'asset'|'liability'|
//         'muted'|'palette' (one colour per point) | 'palette:<n>' (nth colour).
// The client maps tone / style → colours and formats values; no data logic.
//
// Globals in this file use the ins / _ins prefix; compute hooks insightCompute_*,
// metadata hooks insightMeta_*.
// =============================================================================

// Period choices the old client offered when an insight listed none.
const _INS_ANY_PERIODS = ['this_week', 'last_week', 'last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month',
  'last_3', 'last_6', 'last_12', 'this_quarter', 'last_quarter', 'ytd', 'last_year', 'custom'];
const _INS_DAILY_PERIODS = ['last_7', 'last_30', 'last_60', 'last_90', 'this_month', 'last_month', 'custom'];
const _INS_TX_ACCOUNT_TABS = [{ key: 'transactions', label: 'Transactions' }, { key: 'accounts', label: 'Accounts' }];
const _INS_COMPARE_MODES = ['previous', 'last_year', 'none'];
const _INS_DRILL_ROW_LIMIT = 50;
const _INS_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const _INS_MESSAGES = {
  missing_insight_id: 'Choose an insight.',
  unknown_insight: 'This insight does not exist. Choose one from the list.',
  insight_not_available: 'This insight is not computed on the server yet.',
  invalid_compare: 'Choose a valid comparison (previous period, last year or none).',
  invalid_tab: 'Choose one of the tabs shown for this insight.',
  invalid_drill: 'That selection is not part of this insight. Reset the view and try again.',
  invalid_param: 'One of the insight options has an unsupported value. Reset the view and try again.',
  insight_failed: 'This insight could not be computed. Refresh and try again.',
};

// Base registry (ports insights.js INSIGHTS; 18-income-vs-expenses is dead and
// not registered). periods: [] = no period selector (default_period still
// drives the computation when set). params: extra get_insight params the
// insight reads (informational).
const INS_REGISTRY = [
  { id: '00-earn-burn-rate', title: 'Income, Expense & Savings', group: 'Cash flow', render_kind: 'line', params: ['window'],
    description: 'Trailing-average income, expense, and savings rate per day — three lines in one view. Blue band = saving; red band = overspending. Use the window chips to adjust smoothing.',
    periods: ['last_3', 'last_6', 'last_12', 'ytd', 'last_year', 'custom'], default_period: 'last_3', tabs: [] },
  { id: '01-mom-cumulative', title: 'Month-on-Month daily cumulative', group: 'Spending comparisons', render_kind: 'line', params: [],
    description: 'Cumulative spend day-by-day through the month, compared against the previous month.',
    periods: ['this_month', 'last_month', 'custom'], default_period: 'this_month', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '02-yoy-monthly', title: 'Year-on-Year monthly', group: 'Spending comparisons', render_kind: 'line', params: [],
    description: 'Monthly spend by calendar month, this year vs the same period last year.',
    periods: ['this_month', 'last_month', 'ytd', 'last_year', 'custom'], default_period: 'ytd', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '03-wow-daily', title: 'Week-on-Week daily', group: 'Spending comparisons', render_kind: 'line', params: [],
    description: 'Daily spend through the week, this week vs last week.',
    periods: ['this_week', 'last_week', 'last_7', 'custom'], default_period: 'this_week', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '04-qtd-comparison', title: 'Quarter-to-date comparison', group: 'Spending comparisons', render_kind: 'line', params: [],
    description: 'Spend so far this quarter, day-by-day, compared against the same number of days in the previous quarter.',
    periods: ['this_quarter', 'last_quarter', 'custom'], default_period: 'this_quarter', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '05-ytd-comparison', title: 'Year-to-date comparison', group: 'Spending comparisons', render_kind: 'line', params: [],
    description: 'Monthly spend this year vs the same months last year.',
    periods: ['ytd', 'last_year', 'custom'], default_period: 'ytd', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '06-last-12-months', title: 'Last 12 months', group: 'Spending comparisons', render_kind: 'mixed', params: [],
    description: 'Income, expenses, and net savings per calendar month over the last 12 months.',
    periods: [], default_period: 'last_12', tabs: _INS_TX_ACCOUNT_TABS },
  { id: '07-last-8-weeks', title: 'Last 8 weeks', group: 'Spending comparisons', render_kind: 'bar', params: [],
    description: 'Weekly income and expenses over the last 8 weeks.',
    periods: [], default_period: null, tabs: [] },
  { id: '08-category-pie', title: 'Category breakdown', group: 'Categories', render_kind: 'donut', params: ['drill'],
    description: 'How your spending is split across categories this period. Click a segment to see the individual transactions.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '09-category-trend', title: 'Category trend over time', group: 'Categories', render_kind: 'stacked', params: [],
    description: 'How each category\'s spend has trended month by month over the selected period.',
    periods: _INS_ANY_PERIODS, default_period: 'last_6', tabs: [] },
  { id: '10-top-categories', title: 'Top categories', group: 'Categories', render_kind: 'hbar', params: ['compare'],
    description: 'Your highest-spending categories this period vs the previous period.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '11-category-drilldown', title: 'Category drilldown', group: 'Categories', render_kind: 'hbar', params: ['drill'],
    description: 'Explore spending by major category, then drill into minor categories and individual transactions.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '12-tag-pie', title: 'Tag breakdown', group: 'Categories', render_kind: 'donut', params: ['drill'],
    description: 'How your tagged spend is distributed. Click a segment to see transactions for that tag.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '13-tag-trend', title: 'Tag trend over time', group: 'Categories', render_kind: 'line', params: ['drill'],
    description: 'How each tag\'s spend has changed month by month. Click a point to see transactions for that month.',
    periods: _INS_ANY_PERIODS, default_period: 'last_6', tabs: [] },
  { id: '14-networth-trend', title: 'Net worth trend', group: 'Net worth', render_kind: 'line', params: ['drill'],
    description: 'Total net worth (assets minus liabilities) over time. Click a point to see account balances at that date.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '15-account-balances', title: 'Account balances', group: 'Net worth', render_kind: 'hbar', params: [],
    description: 'Current balance of every account, grouped by type.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '16-asset-vs-liability', title: 'Assets vs liabilities', group: 'Net worth', render_kind: 'area', params: [],
    description: 'Total asset value vs total liability value over time.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '17-liability-paydown', title: 'Liability paydown', group: 'Net worth', render_kind: 'line', params: [],
    description: 'How your liabilities have changed over time, by liability account.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '19-cashflow-waterfall', title: 'Cashflow waterfall', group: 'Cash flow', render_kind: 'waterfall', params: ['drill'],
    description: 'Where money came in and went out each month, shown as a waterfall. Click a bar to see transactions.',
    periods: _INS_ANY_PERIODS, default_period: 'this_month', tabs: [] },
  { id: '20-savings-rate', title: 'Savings rate', group: 'Cash flow', render_kind: 'mixed', params: [],
    description: 'What percentage of income is saved each month.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '21-income-sources', title: 'Income sources', group: 'Cash flow', render_kind: 'donut', params: ['drill'],
    description: 'Where your income comes from. Click a segment to see transactions for that source.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '22-top-counterparties', title: 'Top counterparties', group: 'Counterparties', render_kind: 'hbar', params: ['top_n', 'drill'],
    description: 'Your highest-spend counterparties. Click a bar to see their monthly spend trend.',
    periods: _INS_ANY_PERIODS, default_period: 'last_3', tabs: [] },
  { id: '23-recurring-payments', title: 'Recurring payments', group: 'Counterparties', render_kind: 'table', params: ['sort', 'sort_dir', 'drill'],
    description: 'Counterparties you pay regularly. Click a row to see their full payment history.',
    periods: _INS_ANY_PERIODS, default_period: 'last_6', tabs: [] },
  { id: '24-spend-by-country', title: 'Spend by country', group: 'Geography', render_kind: 'hbar', params: ['drill'],
    description: 'How spend is distributed by country. Click a segment to see spend by city within that country.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '25-spend-by-city', title: 'Spend by city', group: 'Geography', render_kind: 'hbar', params: ['drill'],
    description: 'How spend is distributed by city. Click a bar to see the individual transactions.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '26-loan-progress', title: 'Loan progress', group: 'Loans', render_kind: 'line', params: [],
    description: 'Repayment progress for each active loan.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '27-debt-to-income', title: 'Debt-to-income', group: 'Loans', render_kind: 'gauge', params: [],
    description: 'Debt-to-income ratio trend and how it compares to common thresholds.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12',
    tabs: [{ key: 'transactions', label: 'Income trend' }, { key: 'accounts', label: 'DTI ratio' }] },
  { id: '28-forex-spend', title: 'Foreign currency spend', group: 'FX & currency', render_kind: 'donut', params: [],
    description: 'Spend in foreign currencies, converted to base currency.',
    periods: _INS_ANY_PERIODS, default_period: 'last_12', tabs: [] },
  { id: '29-daily-spend', title: 'Daily spend (with payments)', group: 'Spending comparisons', render_kind: 'bar', params: ['drill'],
    description: 'Daily money-out as a bar chart — includes all categories. Click any bar to see that day\'s transactions.',
    periods: _INS_DAILY_PERIODS, default_period: 'last_30', tabs: [] },
  { id: '30-daily-spend-no-payments', title: 'Daily spend (without payments)', group: 'Spending comparisons', render_kind: 'bar', params: ['drill'],
    description: 'Daily money-out excluding subscription-eligible categories (loan repayments, rent, recurring commitments). Click any bar to see that day\'s transactions.',
    periods: _INS_DAILY_PERIODS, default_period: 'last_30', tabs: [] },
];

// Explicit per-insight hook lookup: { compute: fn|null, meta: fn|null }.
// Every registered id is listed; a porting agent only defines the function.
function _insHooks(id) {
  switch (id) {
    case '00-earn-burn-rate': return { compute: typeof insightCompute_00_earn_burn_rate === 'function' ? insightCompute_00_earn_burn_rate : null, meta: typeof insightMeta_00_earn_burn_rate === 'function' ? insightMeta_00_earn_burn_rate : null };
    case '01-mom-cumulative': return { compute: typeof insightCompute_01_mom_cumulative === 'function' ? insightCompute_01_mom_cumulative : null, meta: typeof insightMeta_01_mom_cumulative === 'function' ? insightMeta_01_mom_cumulative : null };
    case '02-yoy-monthly': return { compute: typeof insightCompute_02_yoy_monthly === 'function' ? insightCompute_02_yoy_monthly : null, meta: typeof insightMeta_02_yoy_monthly === 'function' ? insightMeta_02_yoy_monthly : null };
    case '03-wow-daily': return { compute: typeof insightCompute_03_wow_daily === 'function' ? insightCompute_03_wow_daily : null, meta: typeof insightMeta_03_wow_daily === 'function' ? insightMeta_03_wow_daily : null };
    case '04-qtd-comparison': return { compute: typeof insightCompute_04_qtd_comparison === 'function' ? insightCompute_04_qtd_comparison : null, meta: typeof insightMeta_04_qtd_comparison === 'function' ? insightMeta_04_qtd_comparison : null };
    case '05-ytd-comparison': return { compute: typeof insightCompute_05_ytd_comparison === 'function' ? insightCompute_05_ytd_comparison : null, meta: typeof insightMeta_05_ytd_comparison === 'function' ? insightMeta_05_ytd_comparison : null };
    case '06-last-12-months': return { compute: typeof insightCompute_06_last_12_months === 'function' ? insightCompute_06_last_12_months : null, meta: typeof insightMeta_06_last_12_months === 'function' ? insightMeta_06_last_12_months : null };
    case '07-last-8-weeks': return { compute: typeof insightCompute_07_last_8_weeks === 'function' ? insightCompute_07_last_8_weeks : null, meta: typeof insightMeta_07_last_8_weeks === 'function' ? insightMeta_07_last_8_weeks : null };
    case '08-category-pie': return { compute: typeof insightCompute_08_category_pie === 'function' ? insightCompute_08_category_pie : null, meta: typeof insightMeta_08_category_pie === 'function' ? insightMeta_08_category_pie : null };
    case '09-category-trend': return { compute: typeof insightCompute_09_category_trend === 'function' ? insightCompute_09_category_trend : null, meta: typeof insightMeta_09_category_trend === 'function' ? insightMeta_09_category_trend : null };
    case '10-top-categories': return { compute: typeof insightCompute_10_top_categories === 'function' ? insightCompute_10_top_categories : null, meta: typeof insightMeta_10_top_categories === 'function' ? insightMeta_10_top_categories : null };
    case '11-category-drilldown': return { compute: typeof insightCompute_11_category_drilldown === 'function' ? insightCompute_11_category_drilldown : null, meta: typeof insightMeta_11_category_drilldown === 'function' ? insightMeta_11_category_drilldown : null };
    case '12-tag-pie': return { compute: typeof insightCompute_12_tag_pie === 'function' ? insightCompute_12_tag_pie : null, meta: typeof insightMeta_12_tag_pie === 'function' ? insightMeta_12_tag_pie : null };
    case '13-tag-trend': return { compute: typeof insightCompute_13_tag_trend === 'function' ? insightCompute_13_tag_trend : null, meta: typeof insightMeta_13_tag_trend === 'function' ? insightMeta_13_tag_trend : null };
    case '14-networth-trend': return { compute: typeof insightCompute_14_networth_trend === 'function' ? insightCompute_14_networth_trend : null, meta: typeof insightMeta_14_networth_trend === 'function' ? insightMeta_14_networth_trend : null };
    case '15-account-balances': return { compute: typeof insightCompute_15_account_balances === 'function' ? insightCompute_15_account_balances : null, meta: typeof insightMeta_15_account_balances === 'function' ? insightMeta_15_account_balances : null };
    case '16-asset-vs-liability': return { compute: typeof insightCompute_16_asset_vs_liability === 'function' ? insightCompute_16_asset_vs_liability : null, meta: typeof insightMeta_16_asset_vs_liability === 'function' ? insightMeta_16_asset_vs_liability : null };
    case '17-liability-paydown': return { compute: typeof insightCompute_17_liability_paydown === 'function' ? insightCompute_17_liability_paydown : null, meta: typeof insightMeta_17_liability_paydown === 'function' ? insightMeta_17_liability_paydown : null };
    case '19-cashflow-waterfall': return { compute: typeof insightCompute_19_cashflow_waterfall === 'function' ? insightCompute_19_cashflow_waterfall : null, meta: typeof insightMeta_19_cashflow_waterfall === 'function' ? insightMeta_19_cashflow_waterfall : null };
    case '20-savings-rate': return { compute: typeof insightCompute_20_savings_rate === 'function' ? insightCompute_20_savings_rate : null, meta: typeof insightMeta_20_savings_rate === 'function' ? insightMeta_20_savings_rate : null };
    case '21-income-sources': return { compute: typeof insightCompute_21_income_sources === 'function' ? insightCompute_21_income_sources : null, meta: typeof insightMeta_21_income_sources === 'function' ? insightMeta_21_income_sources : null };
    case '22-top-counterparties': return { compute: typeof insightCompute_22_top_counterparties === 'function' ? insightCompute_22_top_counterparties : null, meta: typeof insightMeta_22_top_counterparties === 'function' ? insightMeta_22_top_counterparties : null };
    case '23-recurring-payments': return { compute: typeof insightCompute_23_recurring_payments === 'function' ? insightCompute_23_recurring_payments : null, meta: typeof insightMeta_23_recurring_payments === 'function' ? insightMeta_23_recurring_payments : null };
    case '24-spend-by-country': return { compute: typeof insightCompute_24_spend_by_country === 'function' ? insightCompute_24_spend_by_country : null, meta: typeof insightMeta_24_spend_by_country === 'function' ? insightMeta_24_spend_by_country : null };
    case '25-spend-by-city': return { compute: typeof insightCompute_25_spend_by_city === 'function' ? insightCompute_25_spend_by_city : null, meta: typeof insightMeta_25_spend_by_city === 'function' ? insightMeta_25_spend_by_city : null };
    case '26-loan-progress': return { compute: typeof insightCompute_26_loan_progress === 'function' ? insightCompute_26_loan_progress : null, meta: typeof insightMeta_26_loan_progress === 'function' ? insightMeta_26_loan_progress : null };
    case '27-debt-to-income': return { compute: typeof insightCompute_27_debt_to_income === 'function' ? insightCompute_27_debt_to_income : null, meta: typeof insightMeta_27_debt_to_income === 'function' ? insightMeta_27_debt_to_income : null };
    case '28-forex-spend': return { compute: typeof insightCompute_28_forex_spend === 'function' ? insightCompute_28_forex_spend : null, meta: typeof insightMeta_28_forex_spend === 'function' ? insightMeta_28_forex_spend : null };
    case '29-daily-spend': return { compute: typeof insightCompute_29_daily_spend === 'function' ? insightCompute_29_daily_spend : null, meta: typeof insightMeta_29_daily_spend === 'function' ? insightMeta_29_daily_spend : null };
    case '30-daily-spend-no-payments': return { compute: typeof insightCompute_30_daily_spend_no_payments === 'function' ? insightCompute_30_daily_spend_no_payments : null, meta: typeof insightMeta_30_daily_spend_no_payments === 'function' ? insightMeta_30_daily_spend_no_payments : null };
    default: return null;
  }
}

function insightsRegister(actions) {
  actions.get_insight = { handler: function(ctx) { return insGetInsight(ctx); }, cache: true, ttl: 600 };
}

function _insText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function insError(code, field, message, details) {
  return vmError(code, field, message === undefined || message === null || message === '' ? _INS_MESSAGES[code] : message, details);
}

// Registry entry with its optional insightMeta_<id>() overrides applied, or null.
function insEntry(id) {
  const base = INS_REGISTRY.find(function(entry) { return entry.id === id; });
  if (base === undefined) return null;
  const hooks = _insHooks(id);
  const entry = Object.assign({}, base);
  if (hooks !== null && hooks.meta !== null) {
    let meta = null;
    try { meta = hooks.meta(); } catch (err) { console.error('insEntry: meta hook failed id=' + id + ' ' + err); }
    if (meta !== null && typeof meta === 'object') {
      Object.keys(meta).forEach(function(key) { if (key !== 'id' && key !== 'group' && key !== 'title') entry[key] = meta[key]; });
    }
  }
  entry.server = hooks !== null && hooks.compute !== null;
  return entry;
}

// nav.insights_registry for get_app_context: display-ready, ordered as INS_REGISTRY.
// [{ id, title, label, group, description, periods:[{value,label}], default_period,
//    tabs:[{key,label}], render_kind, params, server }]
function insightsRegistryForClient() {
  return INS_REGISTRY.map(function(base) {
    const entry = insEntry(base.id);
    return {
      id: entry.id, title: entry.title, label: entry.title, group: entry.group, description: entry.description,
      periods: (entry.periods || []).map(function(key) { return { value: key, label: LDG_PERIOD_LABELS[key] !== undefined ? LDG_PERIOD_LABELS[key] : key }; }),
      default_period: entry.default_period === undefined ? null : entry.default_period,
      tabs: (entry.tabs || []).map(function(tab) { return { key: tab.key, label: tab.label }; }),
      render_kind: entry.render_kind, params: (entry.params || []).slice(), server: entry.server,
    };
  });
}

// ── Labels (server-side display strings; no locale dependence) ────────────────

// '2026-09-05' → '5 Sep'
function insDayLabel(dateKey) {
  return String(Number(dateKey.slice(8, 10))) + ' ' + _INS_MONTHS[Number(dateKey.slice(5, 7)) - 1];
}

// '2026-09-05' → '5 Sep 26'
function insDateLabel(dateKey) {
  return insDayLabel(dateKey) + ' ' + dateKey.slice(2, 4);
}

// '2026-09' → 'Sep 26' (ports fmtMonthKey en-GB { month:'short', year:'2-digit' })
function insMonthLabel(monthKey) {
  return _INS_MONTHS[Number(monthKey.slice(5, 7)) - 1] + ' ' + monthKey.slice(2, 4);
}

// A full calendar month → 'Sep 26'; whole months → 'Jul 26 – Sep 26';
// otherwise '1 Sep 26 – 15 Sep 26'. from null → 'Up to 30 Sep 26'.
function insRangeLabel(fromKey, toKey) {
  if (fromKey === null || fromKey === undefined) return 'Up to ' + insDateLabel(toKey);
  if (fromKey.slice(8) === '01' && toKey === ldgMonthEnd(toKey)) {
    if (fromKey.slice(0, 7) === toKey.slice(0, 7)) return insMonthLabel(fromKey.slice(0, 7));
    return insMonthLabel(fromKey.slice(0, 7)) + ' – ' + insMonthLabel(toKey.slice(0, 7));
  }
  return insDateLabel(fromKey) + ' – ' + insDateLabel(toKey);
}

// ── Params ────────────────────────────────────────────────────────────────────

// Integer param from a fixed list. Returns { ok:true, value } or an insError.
function insIntParam(ictx, name, allowed, dflt) {
  const raw = _insText(ictx.params[name]);
  if (raw === '') return { ok: true, value: dflt };
  const value = Number(raw);
  if (!Number.isInteger(value) || allowed.indexOf(value) === -1) return insError('invalid_param', name);
  return { ok: true, value: value };
}

// Choice param from a fixed list of strings.
function insChoiceParam(ictx, name, allowed, dflt) {
  const raw = _insText(ictx.params[name]);
  if (raw === '') return { ok: true, value: dflt };
  if (allowed.indexOf(raw) === -1) return insError('invalid_param', name);
  return { ok: true, value: raw };
}

// String value of a drill key, or null when absent.
function insDrillValue(ictx, key) {
  if (ictx.drill === null || ictx.drill[key] === undefined || ictx.drill[key] === null) return null;
  const value = _insText(ictx.drill[key]);
  return value === '' ? null : value;
}

// ── Data access (every sheet read once per request via vmLoad) ────────────────

// Shared transaction index from view-transactions.gs (category resolution and
// TxRow shaping for drill rows). Memoized on ictx.
function insIndex(ictx) {
  if (ictx._index === undefined) ictx._index = _vwTxIndex(ictx.ctx);
  return ictx._index;
}

function insLedger(ictx) {
  return vmLedger(ictx.tz);
}

function _insMarkMissing(ictx, currency) {
  ictx.missing[currency === '' ? '(blank)' : currency] = true;
}

// Native amount → quote currency; null (and a missing-rate warning) when no rate.
function insQuote(ictx, native, currency) {
  const value = fxQuoteValue(native, currency, ictx.fx);
  if (value === null) _insMarkMissing(ictx, _insText(currency).toUpperCase());
  return value;
}

// All flow-eligible transactions (ldgFlowKind: no deleted rows, no own-account
// transfers), memoized: [{ tx, id, kind:'income'|'spend', date_key, month_key,
// account_id, account, currency, native, quote|null, category:{major_key, minor_key,
// major_label, minor_label, label, is_subscription_eligible} }]. Rows with an
// unreadable date are dropped (they fall in no period).
function _insAllFlows(ictx) {
  if (ictx._flows !== undefined) return ictx._flows;
  const index = insIndex(ictx);
  const out = [];
  index.txs.forEach(function(tx) {
    const kind = ldgFlowKind(tx, index.pairs);
    if (kind === null) return;
    const dateKey = ldgTxDateKey(tx);
    if (dateKey === null) return;
    const native = Number(tx.tx_amount_local);
    if (!Number.isFinite(native) || native <= 0) return;
    const account = _vwTxAccount(index, tx.account_id);
    const currency = account === null ? '' : _insText(account.account_currency_local).toUpperCase();
    const resolved = _vwTxCategory(index, tx.tx_type, tx.major_category, tx.minor_category);
    out.push({
      tx: tx, id: _insText(tx.id), kind: kind, date_key: dateKey, month_key: dateKey.slice(0, 7),
      account_id: _insText(tx.account_id), account: account, currency: currency, native: native,
      quote: fxQuoteValue(native, currency, ictx.fx),
      category: {
        major_key: resolved.major_key, minor_key: resolved.minor_key,
        major_label: resolved.major_label, minor_label: resolved.minor_label, label: resolved.label,
        is_subscription_eligible: resolved.category !== null && toBool(resolved.category.is_subscription_eligible) === true,
      },
    });
  });
  ictx._flows = out;
  return out;
}

// Flow rows for a range. opts: { kind: 'spend'|'income'|'any' (default 'any'),
// from, to (default: the request period; null from = unbounded),
// filter: function(row) → bool }. Rows without a rate are left out and reported
// in the missing-rate warning (never converted 1:1).
function insFlows(ictx, opts) {
  const o = opts === undefined || opts === null ? {} : opts;
  const kind = o.kind === undefined ? 'any' : o.kind;
  const from = o.from !== undefined ? o.from : (ictx.period === null ? null : ictx.period.from);
  const to = o.to !== undefined ? o.to : (ictx.period === null ? ictx.today : ictx.period.to);
  return _insAllFlows(ictx).filter(function(row) {
    if (kind !== 'any' && row.kind !== kind) return false;
    if (!ldgInRange(row.date_key, from, to)) return false;
    if (typeof o.filter === 'function' && !o.filter(row)) return false;
    if (row.quote === null) { _insMarkMissing(ictx, row.currency); return false; }
    return true;
  });
}

function insTotal(rows) {
  return rows.reduce(function(sum, row) { return sum + row.quote; }, 0);
}

// Earliest flow date key (any kind), or null.
function insFirstFlowDate(ictx, kind) {
  let first = null;
  _insAllFlows(ictx).forEach(function(row) {
    if (kind !== undefined && kind !== 'any' && row.kind !== kind) return;
    if (first === null || row.date_key < first) first = row.date_key;
  });
  return first;
}

// ── Grouping ──────────────────────────────────────────────────────────────────

// Groups rows by keyFn(row) (return null/'' to skip a row). labelFn(row) gives
// the label of the first row seen. Returns [{ key, label, total, count, rows }]
// sorted by total desc, then label.
function insGroupBy(rows, keyFn, labelFn) {
  const groups = Object.create(null);
  const order = [];
  rows.forEach(function(row) {
    const key = keyFn(row);
    if (key === null || key === undefined || key === '') return;
    if (groups[key] === undefined) {
      groups[key] = { key: key, label: labelFn === undefined ? key : labelFn(row), total: 0, count: 0, rows: [] };
      order.push(key);
    }
    groups[key].total += row.quote;
    groups[key].count += 1;
    groups[key].rows.push(row);
  });
  return order.map(function(key) { return groups[key]; }).sort(function(a, b) {
    return b.total - a.total || a.label.localeCompare(b.label);
  });
}

// By major category key (label = major label; blank = 'Uncategorised').
function insByMajor(rows) {
  return insGroupBy(rows, function(row) { return row.category.major_key === '' ? '(none)' : row.category.major_key; },
    function(row) { return row.category.major_key === '' ? 'Uncategorised' : row.category.major_label; });
}

// By major+minor (key 'major|minor'). Labels are the minor label, prefixed
// with the major label when two groups share a minor label.
function insByMinor(rows) {
  const groups = insGroupBy(rows, function(row) {
    return (row.category.major_key === '' ? '(none)' : row.category.major_key) + '|' + (row.category.minor_key === '' ? '(none)' : row.category.minor_key);
  }, function(row) { return row.category.minor_key === '' ? 'Uncategorised' : row.category.minor_label; });
  const seen = Object.create(null);
  groups.forEach(function(group) { seen[group.label] = (seen[group.label] || 0) + 1; });
  groups.forEach(function(group) {
    if (seen[group.label] > 1 && group.rows[0].category.major_key !== '') group.label = group.rows[0].category.major_label + ' · ' + group.label;
  });
  return groups;
}

// Tags split on ';' (a row counts in full under each of its tags, as splitTags
// did). Untagged rows are skipped. Each group row carries tag_count.
function insByTag(rows) {
  const exploded = [];
  rows.forEach(function(row) {
    const tags = _insText(row.tx.tx_tags).split(';').map(function(tag) { return tag.trim(); }).filter(function(tag) { return tag !== ''; });
    tags.forEach(function(tag) { exploded.push(Object.assign({}, row, { tag: tag, tag_count: tags.length })); });
  });
  return insGroupBy(exploded, function(row) { return row.tag.toLowerCase(); }, function(row) { return row.tag; });
}

// Counterparty (case-insensitive; blank → skipped).
function insByCounterparty(rows) {
  return insGroupBy(rows, function(row) { return _insText(row.tx.counterparty_name).toLowerCase(); },
    function(row) { return _insText(row.tx.counterparty_name); });
}

// ── Bucketing ─────────────────────────────────────────────────────────────────

// Daily buckets from → to inclusive: { keys:['YYYY-MM-DD'], labels:['5 Sep'],
// values:[quote sum], rows_by_key:{ key: [rows] } }.
function insDailySeries(rows, fromKey, toKey) {
  const keys = ldgDateKeys(fromKey, toKey);
  const byKey = Object.create(null);
  keys.forEach(function(key) { byKey[key] = []; });
  rows.forEach(function(row) { if (byKey[row.date_key] !== undefined) byKey[row.date_key].push(row); });
  return { keys: keys, labels: keys.map(insDayLabel), values: keys.map(function(key) { return insTotal(byKey[key]); }), rows_by_key: byKey };
}

// Monthly buckets: keys 'YYYY-MM', labels 'Sep 26'.
function insMonthlySeries(rows, fromKey, toKey) {
  const keys = ldgMonthKeys(fromKey, toKey);
  const byKey = Object.create(null);
  keys.forEach(function(key) { byKey[key] = []; });
  rows.forEach(function(row) { if (byKey[row.month_key] !== undefined) byKey[row.month_key].push(row); });
  return { keys: keys, labels: keys.map(insMonthLabel), values: keys.map(function(key) { return insTotal(byKey[key]); }), rows_by_key: byKey };
}

// Monday of a date key's ISO week.
function insWeekStart(dateKey) {
  const weekday = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)))).getUTCDay();
  return ldgAddDays(dateKey, -((weekday + 6) % 7));
}

// Weekly buckets (ISO weeks, Monday start) covering from → to: keys = Monday
// date keys, labels '5 Sep'.
function insWeeklySeries(rows, fromKey, toKey) {
  const keys = [];
  if (ldgIsDateKey(fromKey) && ldgIsDateKey(toKey) && fromKey <= toKey) {
    for (let key = insWeekStart(fromKey); key <= toKey; key = ldgAddDays(key, 7)) keys.push(key);
  }
  const byKey = Object.create(null);
  keys.forEach(function(key) { byKey[key] = []; });
  rows.forEach(function(row) { const week = insWeekStart(row.date_key); if (byKey[week] !== undefined) byKey[week].push(row); });
  return { keys: keys, labels: keys.map(insDayLabel), values: keys.map(function(key) { return insTotal(byKey[key]); }), rows_by_key: byKey };
}

// ── Balances (ledger-core replay; transfer legs included) ─────────────────────

function insIsAssetAccount(account) {
  return account.record_status !== 'deleted' && (account.type === 'asset' || account.type === 'investment');
}

function insIsLiabilityAccount(account) {
  return account.record_status !== 'deleted' && account.type === 'liability';
}

// Daily total balance in the quote currency: { dates, labels, totals }.
// filter(ledgerAccount) selects accounts (default: all net-worth accounts, i.e.
// non-deleted asset / investment / liability). Missing rates → warning.
function insBalanceSeries(ictx, fromKey, toKey, filter) {
  const ledger = insLedger(ictx);
  const select = filter === undefined || filter === null ? ldgIsNetWorthAccount : filter;
  const series = ldgDailyTotals(ledger, fromKey, toKey, ictx.fx, select);
  series.missing_currencies.forEach(function(code) { _insMarkMissing(ictx, code); });
  return { dates: series.dates, labels: series.dates.map(insDayLabel), totals: series.totals };
}

// Native balances at the end of a date key: { account_id: native }.
function insBalancesAt(ictx, dateKey) {
  return ldgBalancesAt(insLedger(ictx), dateKey);
}

// Net worth now (current balances, all non-deleted accounts; same numbers as
// list_accounts_view summary): { total_assets, total_liabilities, net_worth }.
function insNetWorthNow(ictx) {
  const ledger = insLedger(ictx);
  const worth = ldgNetWorth(ledger, ldgCurrentBalances(ledger), ictx.fx);
  worth.missing_currencies.forEach(function(code) { _insMarkMissing(ictx, code); });
  return worth;
}

// ── Drill rows ────────────────────────────────────────────────────────────────

// Drill panel over flow rows: newest first, TxRows exactly as
// list_transactions_view shapes them, capped at limit (default 50).
// Returns { title, subtitle, rows, total_count, shown_count, total_quote, query }.
function insDrill(ictx, title, rows, query, limit) {
  const cap = limit === undefined || limit === null ? _INS_DRILL_ROW_LIMIT : limit;
  const index = insIndex(ictx);
  const sorted = rows.slice().sort(function(a, b) {
    const ka = ldgTxLocalKey(a.tx), kb = ldgTxLocalKey(b.tx);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  const shown = sorted.slice(0, cap).map(function(row) { return _vwTxRow(index, row.tx); });
  return {
    title: title,
    subtitle: rows.length + ' transaction' + (rows.length === 1 ? '' : 's'),
    rows: shown, total_count: rows.length, shown_count: shown.length, total_quote: insTotal(rows),
    query: query === undefined ? null : query,
  };
}

// Pointer to the Transactions list for a drill (the list keeps every leg,
// including transfers and deleted rows, so its totals can differ).
function insTxQuery(fromKey, toKey, extra) {
  const params = Object.assign({ range: 'custom', from: fromKey === null ? '' : fromKey, to: toKey }, extra || {});
  return { action: 'list_transactions_view', params: params, note: 'The Transactions list shows every leg, including own-account transfers and deleted rows.' };
}

// ── Payload builders ──────────────────────────────────────────────────────────

function insStat(key, label, value, format, sub, tone) {
  const card = { key: key, label: label, value: value === undefined ? null : value, format: format };
  if (sub !== undefined && sub !== null && sub !== '') card.sub = sub;
  if (tone !== undefined && tone !== null) card.tone = tone;
  return card;
}

function insEmpty(text) {
  return { empty: { text: text } };
}

// ── Period / compare ──────────────────────────────────────────────────────────

function _insShiftYear(dateKey, years) {
  const year = Number(dateKey.slice(0, 4)) + years;
  const month = Number(dateKey.slice(5, 7));
  const lastDay = Number(ldgMonthEnd(String(year).padStart(4, '0') + '-' + dateKey.slice(5, 7) + '-01').slice(8, 10));
  const day = Math.min(Number(dateKey.slice(8, 10)), lastDay);
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function _insCompare(mode, period) {
  if (period === null || period.from === null || mode === 'none') return null;
  let from = null, to = null;
  if (mode === 'previous') { from = period.compare_from; to = period.compare_to; }
  else if (mode === 'last_year') { from = _insShiftYear(period.from, -1); to = _insShiftYear(period.to, -1); }
  if (from === null || to === null) return null;
  return { mode: mode, from: from, to: to, label: insRangeLabel(from, to) };
}

// ── get_insight ───────────────────────────────────────────────────────────────

// Returns { ok:true, ictx } or an insError envelope.
function _insBuildContext(ctx, entry) {
  const p = ctx.params;
  let period = null;
  if ((entry.periods || []).length === 0) {
    if (entry.default_period !== null && entry.default_period !== undefined) period = ldgPeriodBounds(entry.default_period, ctx.today);
  } else {
    const key = _insText(p.period) === '' ? entry.default_period : _insText(p.period);
    if (entry.periods.indexOf(key) === -1) return insError('invalid_period', 'period', vmMessage('invalid_period'));
    period = ldgPeriodBounds(key, ctx.today, p.from, p.to);
    if (period === null) return insError('invalid_period', 'period', vmMessage('invalid_period'));
  }
  const compareMode = _insText(p.compare) === '' ? 'previous' : _insText(p.compare);
  if (_INS_COMPARE_MODES.indexOf(compareMode) === -1) return insError('invalid_compare', 'compare');
  let tab = null;
  const tabs = entry.tabs || [];
  if (tabs.length > 0) {
    tab = _insText(p.tab) === '' ? tabs[0].key : _insText(p.tab);
    if (!tabs.some(function(item) { return item.key === tab; })) return insError('invalid_tab', 'tab');
  }
  let drill = null;
  if (_insText(p.drill) !== '') {
    try { drill = JSON.parse(p.drill); } catch (_) { return insError('invalid_drill', 'drill'); }
    if (drill === null || typeof drill !== 'object' || Array.isArray(drill)) return insError('invalid_drill', 'drill');
  }
  const fx = vmFx(ctx);
  return {
    ok: true,
    ictx: {
      ctx: ctx, id: entry.id, entry: entry, params: p, quote_currency: ctx.quote_currency, symbol: fx.quote_symbol,
      tz: ctx.tz, today: ctx.today, period: period, compare: _insCompare(compareMode, period), compare_mode: compareMode,
      tab: tab, drill: drill, fx: fx, missing: Object.create(null),
    },
  };
}

// GET get_insight → vmEnvelope(data = payload schema above).
function insGetInsight(ctx) {
  const id = _insText(ctx.params.id) !== '' ? _insText(ctx.params.id) : _insText(ctx.params.insight_id);
  if (id === '') return insError('missing_insight_id', 'id');
  const entry = insEntry(id);
  if (entry === null) return insError('unknown_insight', 'id');
  const hooks = _insHooks(id);
  if (hooks === null || hooks.compute === null) return insError('insight_not_available', 'id');
  const built = _insBuildContext(ctx, entry);
  if (built.ok !== true) return built;
  const ictx = built.ictx;
  let result;
  try { result = hooks.compute(ictx); }
  catch (err) {
    console.error('insGetInsight: compute failed id=' + id + ' ' + (err && err.stack ? err.stack : err));
    return insError('insight_failed');
  }
  if (result !== null && typeof result === 'object' && result.ok === false) return result;
  const payload = result !== null && typeof result === 'object' ? result : {};
  const data = {
    insight_id: entry.id, title: entry.title, description: entry.description,
    period: ictx.period, compare: ictx.compare, tab: ictx.tab,
    tabs: (entry.tabs || []).map(function(item) { return { key: item.key, label: item.label, active: item.key === ictx.tab }; }),
    controls: [], stat_cards: [], charts: [], tables: [], drill: null, breadcrumbs: [], notes: [], empty: null,
  };
  Object.keys(payload).forEach(function(key) {
    if (['insight_id', 'title', 'period', 'compare', 'tab', 'tabs'].indexOf(key) === -1) data[key] = payload[key];
  });
  console.log('insGetInsight: id=' + id + ' period=' + (ictx.period === null ? '-' : ictx.period.key) + ' tab=' + (ictx.tab === null ? '-' : ictx.tab)
    + ' drill=' + (ictx.drill === null ? '-' : 'yes') + ' charts=' + data.charts.length + ' missing=' + Object.keys(ictx.missing).length);
  return vmEnvelope(ctx, data, [fxMissingRateWarning(Object.keys(ictx.missing), ictx.fx)]);
}
