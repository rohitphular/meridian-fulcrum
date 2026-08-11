# Insight 04 — Quarter-to-Date Comparison

**File:** `sections/insights/04-qtd-comparison.js`
**Group:** Spending comparisons
**Chart type:** Line — 2 series
**Tabs:** Transactions | Accounts

---

## What it shows

Cumulative spend from the start of the selected quarter to today (or to the quarter end for past quarters), compared against the same number of days elapsed into the previous quarter. Useful for spotting budget drift at the quarter level before the quarter ends.

---

## Period derivation

`from` is the first day of the selected quarter and `to` is the last day (both guaranteed by `getPeriodBounds` for `this_quarter` / `last_quarter`):

```js
// Is today inside the selected quarter?
const isCurrentQ  = todayLocal >= from && todayLocal <= to;
const aEnd        = isCurrentQ ? todayLocal : to;
const daysElapsed = Math.round((aEnd - from) / 86400000) + 1;

// Period B: prev quarter start (JS Date handles Q1→Q4 wraparound)
const bFrom = new Date(from.getFullYear(), from.getMonth() - 3, 1);
const bTo   = new Date(bFrom.getFullYear(), bFrom.getMonth(), bFrom.getDate() + daysElapsed - 1);
```

Both periods fetch directly from `state.transactions` (not the pre-filtered `options.txs`).

---

## Transactions tab

### Computation

1. Filter `state.transactions` to each period, `money-out` only.
2. `_buildQtdCumulative(txs, quarterStart, numDays)` — accumulates daily totals via `groupByDay` + `sumAmountBase` over `numDays` days from `quarterStart`.
3. Both series always have the same length: `daysElapsed` points (or 2 minimum).

### X-axis labels

```js
['Day 1', 'Day 2', ..., 'Day D']
```

D is `daysElapsed`. Minimum 2 labels when today is the first day of the quarter.

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Current quarter label | Cumulative spend (Period A) | — |
| Previous quarter label | Cumulative spend (Period B, same days) | — |
| QTD change | `delta` with ↓/↑ and % | `delta ≤ 0` → `.positive`; `delta > 0` → `.negative` |
| Days in | `daysElapsed` / `daysInQuarter` | — |

### Chart

- **Series 1 (Period A):** `C.teal`, solid, `fill: false`
- **Series 2 (Period B):** `AMBER (#f59e0b)`, `borderDash: [4,4]`, `fill: false`
- **Legend labels:** `"Q3 2026 (to date)"` | `"Q2 2026 (same days)"`
- `maxTicksLimit: 8` — shows ~8 day labels across the x-axis
- `spanGaps: false`

---

## Accounts tab

### Computation

Uses `computeDailyTotalAssets` (from `insight-utils.js`) for both periods — `daysElapsed` data points each.

- Period A: `aFrom` → `aEnd` (today or quarter end)
- Period B: `bFrom` → `bTo` (same D-day window in prev quarter)

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Current assets | Last value in Period A | — |
| Prev quarter (same days) | Last value in Period B | — |
| QTD change | `delta` ↑/↓ with % | `delta ≥ 0` → `.positive`; `delta < 0` → `.negative` |
| Days in | `daysElapsed` / `daysInQuarter` | — |

### Chart

- Series 1 (Period A): `C.teal`, `fill: true`, `backgroundColor: C.teal + '18'`
- Series 2 (Period B): `AMBER`, `fill: false`, `borderDash: [4,4]`

---

## Quarter label format

```js
function _quarterLabel(qStart) {
  const q = Math.floor(qStart.getMonth() / 3) + 1;
  return `Q${q} ${qStart.getFullYear()}`;
}
// e.g. from = 2026-07-01 → "Q3 2026"
//      from = 2026-04-01 → "Q2 2026"
```

---

## Shared utilities used

| Utility | Source |
|---|---|
| `filterTxByRange` | `insight-utils.js` |
| `groupByDay` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Q1 of first year with no prior transactions | `moneyOutB` is empty → `hasPrevData = false`; Period B series hidden; notice rendered above chart |
| D = 1 (first day of quarter) | Labels padded to 2; data padded with last value so Chart.js renders at least a line segment |
| `last_quarter` selected | `isCurrentQ = false`; `aEnd = to` (full quarter); D = all days in that quarter; both series fully populated |
| Custom range crossing quarter boundary | Works as-is — `from` is treated as quarter start; no special validation (user responsibility) |
| No active asset accounts (accounts tab) | `.chart-empty` "No active asset accounts found."; returns `null` |
