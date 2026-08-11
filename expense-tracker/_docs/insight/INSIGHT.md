# Insight — Section Reference

## Overview

The insight section renders client-side charts from data already loaded in `state` — no extra API calls. The user picks from 28 insights via a selector, sets a time period, and (for dual-view insights) switches tabs.

**Default insight:** `00-earn-burn-rate` (Income, Expense & Savings).

**Entry point:** `sections/insights.js` → `renderInsight()`

---

## Architecture

```
sections/
  insights.js                   ← coordinator: selector, period picker, tab strip, lazy dispatch
  insights/
    insight-utils.js            ← shared computation helpers
    01-mom-cumulative.js        ← each insight exports render(containerId, options)
    02-yoy-monthly.js
    ... (28 total)
```

**Coordinator** (`insights.js`) owns the shell UI. Each sub-insight receives already-filtered data via `options` and owns only its own chart + stat cards.

---

## State keys

```js
state.insightId            // active insight slug, e.g. '00-earn-burn-rate' (default)
state.insightPeriod        // period preset, e.g. 'this_month'
state.insightCustomFrom    // 'YYYY-MM-DD' — used when insightPeriod = 'custom'
state.insightCustomTo      // 'YYYY-MM-DD'
state.insightTab           // 'transactions' | 'accounts'
state.insightChartInstance // active Chart.js instance — destroyed before switching
```

---

## How an insight renders

1. User picks an insight → `renderInsight()` called
2. Coordinator builds shell HTML (selector, period picker, tab strip, `#insightInner`)
3. `_renderActiveInsight()` — computes period bounds, filters `state.transactions`, checks for missing rates
4. Lazy-imports the sub-insight module via `import('./insights/${insightId}.js')`
5. Sets `#insightInner` to `<div id="insightChart"></div>` (plus optional `.insight-warn`)
6. Calls `renderer.render('insightChart', options)` — sub-insight renders into `#insightChart`
7. Stores returned Chart.js instance in `state.insightChartInstance`

---

## Options object passed to each renderer

```js
{
  txs:      tx[],       // transactions filtered to the selected period
  accounts: account[],  // all accounts from state
  from:     Date,       // period start (local midnight)
  to:       Date,       // period end (local midnight, inclusive)
  sym:      string,     // quote currency symbol — '£', '₹', '$'
  tab:      string,     // 'transactions' | 'accounts'
  period:   string,     // period preset key
}
```

---

## Sub-insight contract

Every file in `sections/insights/` must:

```js
export async function render(containerId, options) {
  const container = el(containerId);
  container.innerHTML = _buildHtml(options);  // innerHTML first
  _attachEvents(containerId, options);         // then events
  return _renderChart(containerId, options);   // return Chart instance or null
}
```

- `containerId` is `'insightChart'`
- Return the Chart.js instance so the coordinator can store and destroy it later
- Return `null` for HTML-only insights (no canvas)

---

## Period options

| Value | Label |
|---|---|
| `this_week` | This week |
| `last_week` | Last week |
| `this_month` | This month |
| `last_month` | Last month |
| `last_3` | Last 3 months |
| `last_6` | Last 6 months |
| `last_12` | Last 12 months |
| `this_quarter` | This quarter |
| `last_quarter` | Last quarter |
| `ytd` | Year to date |
| `last_year` | Last year |
| `custom` | Custom range |

---

## Insight registry

28 insights in 8 groups. ✓ = implemented.

| ID | Label | Group | Tabs | Status |
|---|---|---|---|---|
| 00-earn-burn-rate | Income, Expense & Savings | Cash flow | — | ✓ done |
| 01-mom-cumulative | Month-on-Month daily cumulative | Spending comparisons | ✓ | ✓ done |
| 02-yoy-monthly | Year-on-Year monthly | Spending comparisons | ✓ | ✓ done |
| 03-wow-daily | Week-on-Week daily | Spending comparisons | ✓ | ✓ done |
| 04-qtd-comparison | Quarter-to-date comparison | Spending comparisons | ✓ | ✓ done |
| 05-ytd-comparison | Year-to-date comparison | Spending comparisons | ✓ | ✓ done |
| 06-last-12-months | Last 12 months | Spending comparisons | ✓ | ✓ done |
| 07-last-8-weeks | Last 8 weeks | Spending comparisons | — | ✓ done |
| 08-category-pie | Category breakdown | Categories | — | ✓ done |
| 09-category-trend | Category trend over time | Categories | — | ✓ done |
| 10-top-categories | Top categories | Categories | — | ✓ done |
| 11-category-drilldown | Category drilldown | Categories | — | ✓ done |
| 12-tag-pie | Tag breakdown | Categories | — | ✓ done |
| 13-tag-trend | Tag trend over time | Categories | — | ✓ done |
| 14-networth-trend | Net worth trend | Net worth | — | ✓ done |
| 15-account-balances | Account balances | Net worth | — | ✓ done |
| 16-asset-vs-liability | Assets vs liabilities | Net worth | — | ✓ done |
| 17-liability-paydown | Liability paydown | Net worth | — | ✓ done |
| 19-cashflow-waterfall | Cashflow waterfall | Cash flow | — | ✓ done |
| 20-savings-rate | Savings rate | Cash flow | — | ✓ done |
| 21-income-sources | Income sources | Cash flow | — | ✓ done |
| 22-top-counterparties | Top counterparties | Counterparties | — | ✓ done |
| 23-recurring-payments | Recurring payments | Counterparties | — | ✓ done |
| 24-spend-by-country | Spend by country | Geography | — | ✓ done |
| 25-spend-by-city | Spend by city | Geography | — | ✓ done |
| 26-loan-progress | Loan progress | Loans | — | ✓ done |
| 27-debt-to-income | Debt-to-income | Loans | — | ✓ done |
| 28-forex-spend | Foreign currency spend | FX & currency | — | ✓ done |

Dual-tab insights (Transactions + Accounts tab strip): `01-mom-cumulative`, `02-yoy-monthly`, `03-wow-daily`, `04-qtd-comparison`, `05-ytd-comparison`, `06-last-12-months`.

Note: `18-income-vs-expenses` was removed — its concept is merged into `00-earn-burn-rate`.

---

## CSS classes

| Class | Purpose |
|---|---|
| `.insight-controls` | Top bar wrapping selector + period picker + tabs |
| `.insight-selector` | Insight `<select>` |
| `.insight-period-row` | Period picker row |
| `.insight-period-select` | Period preset `<select>` |
| `.insight-custom-dates` | Custom date inputs (hidden unless period = custom) |
| `.insight-tabs` / `.insight-tab` | Tab strip + individual tab buttons |
| `.insight-warn` | Amber banner for missing exchange rates |
| `.insight-placeholder` | Loading / not-yet-implemented message |
| `.stat-cards` / `.stat-card` | 2-col mobile, 4-col desktop summary cards |
| `.stat-card-label` | Monospace label above the value |
| `.stat-card-value` | Large number; add `.positive` / `.negative` for colour |
| `.stat-card-sub` | Muted sub-line below the value |
| `.chart-container` | Canvas wrapper — `260px` mobile, `340px` desktop |

---

## Canvas lifecycle

```js
// Before every re-render:
if (state.insightChartInstance) {
  state.insightChartInstance.destroy();
  state.insightChartInstance = null;
}
```

The coordinator handles this automatically. Sub-insights must not store Chart instances themselves.

---

## Dark mode

`renderInsight()` calls `_applyChartDefaults()` which reads `--grotesk`, `--ink` from `getComputedStyle` at call time. Each sub-insight reads CSS tokens at the top of its `render()` call via `getCssColors()` from `insight-utils.js`. Theme changes trigger a `renderInsight()` call from `main.js:setTheme()`.

---

## Missing rate warning

When transactions or accounts have a currency not in `state.rateMap`, the coordinator renders a `.insight-warn` banner above the chart with an "Add rates →" link. Tapping it fires `et:show-section` → navigates to the Rates section.

Detection: `findMissingRates(txs, accounts)` from `insight-utils.js`.

---

## Navigation

`et:show-section` custom event is listened to in `core/nav.js`. Dispatch from anywhere:

```js
document.dispatchEvent(new CustomEvent('et:show-section', { detail: 'rates' }));
```
