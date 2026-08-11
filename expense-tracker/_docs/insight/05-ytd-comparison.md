# Insight 05 — Year-to-Date Comparison

**File:** `sections/insights/05-ytd-comparison.js`
**Group:** Spending comparisons
**Chart type:** Line — 2 series
**Tabs:** Transactions | Accounts

---

## What it shows

Monthly cumulative spend from January 1st to today (current year) vs the same months in the previous year — the big-picture view of whether annual spending is tracking up or down.

---

## Key difference from 01/02/03/04

**Monthly granularity, not daily.** A full year at daily resolution would produce up to 365 data points, which is unreadable on mobile. Monthly accumulation gives at most 12 points per series, fitting neatly on all screen sizes.

---

## Period derivation

`from` is Jan 1 of the selected year and `to` is Dec 31 (guaranteed by `getPeriodBounds` for `ytd` / `last_year`):

```js
const isCurrentYear = todayLocal.getFullYear() === yearA;
const aEnd          = isCurrentYear ? todayLocal : to;
const numMonths     = aEnd.getMonth() + 1;  // Jan=1 … Dec=12

// Period B: same N months starting Jan 1 of previous year
const bFrom = new Date(yearB, 0, 1);
const bEnd  = new Date(yearB, aEnd.getMonth(), aEnd.getDate());
```

Both periods fetch from `state.transactions` directly (not `options.txs`).

---

## Transactions tab

### Computation

1. Filter to each year's range, `money-out` only.
2. `_buildYtdCumulative(txs, yearStart, numMonths, partialMonthTo)`:
   - Groups by month via `groupByMonth`.
   - For months 0..N-2: full month sum.
   - For month N-1 (last, potentially partial): filters by `transaction_date_utc <= aEnd`.
   - Returns cumulative running total per month.
3. Period B: `partialMonthTo = null` (all months are complete in the previous year window).

### X-axis labels

```js
['Jan', 'Feb', 'Mar', ..., <current month>]  // max 12
```

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Year A label | Cumulative spend Period A | — |
| Year B label | Cumulative spend Period B | — |
| YoY change | `delta` with ↓/↑ and % | `delta ≤ 0` → `.positive`; `delta > 0` → `.negative` |
| Months | `numMonths` / of 12 | — |

### Chart

- **Series 1 (Period A):** `C.teal`, solid, `pointRadius: 5`
- **Series 2 (Period B):** `AMBER (#f59e0b)`, `borderDash: [4,4]`, `pointRadius: 5`
- **Legend labels (current year):** `"2026 YTD"` | `"2025 (same period)"`
- **Legend labels (last year):** `"2025"` | `"2024"`
- `maxTicksLimit: 12` — all 12 month labels always visible

---

## Accounts tab

### Computation

`_sampleMonthEndAssets(assetAccounts, yearStart, aEnd, numMonths, isCurrentYear)`:
1. Calls `computeDailyTotalAssets` for the full year range (`yearStart` → `aEnd`) — one pass.
2. Samples the result at the **last day of each complete month**, or at `aEnd` (today) for the current partial month.
3. Returns an array of `numMonths` values — one total-assets snapshot per month.

Both Period A and Period B are computed independently via `_sampleMonthEndAssets`.

### Stat cards

Same structure as the transactions tab but with assets instead of spend:
- "Assets 2026 YTD" / "Assets 2025 (same period)"
- `positiveWhenDown: false` — rising assets is `.positive`

---

## Shared utilities used

| Utility | Source |
|---|---|
| `filterTxByRange` | `insight-utils.js` |
| `groupByMonth` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| App started mid-year (e.g. first entry is May) | Jan–Apr show 0 cumulative; chart still renders correctly |
| No previous year data | `moneyOutB` is empty → `hasPrevData = false`; Period B series hidden; notice rendered |
| `last_year` selected | `isCurrentYear = false`; both series show 12 complete months; no partial month logic |
| January 1st of current year (N=1) | Single point each; renders as a dot; Chart.js handles gracefully |
| No active asset accounts (accounts tab) | `.chart-empty` "No active asset accounts found."; returns `null` |
