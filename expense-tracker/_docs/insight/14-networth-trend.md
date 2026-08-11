# Insight 14 — Net Worth Trend

**File:** `sections/insights/14-networth-trend.js`
**Group:** Net worth
**Chart type:** Line with area fill (`fill: 'origin'`)
**Tabs:** None (accounts view only — no tab strip)

---

## What it shows

Month-end net worth (total assets − total liabilities) plotted over time — the single most important financial health indicator.

---

## Sign convention for liabilities

`computeDailyTotalAssets` is passed **all active accounts** (assets + liabilities). Asset accounts have positive `opening_value`; liability accounts have negative `opening_value` (debt stored as a negative balance). When the function sums all balances, assets cancel liabilities naturally — the result is net worth directly, with no separate subtraction step needed.

---

## Computation

`_buildMonthlyNetworth(allAccounts, monthKeys)`:
1. Builds `from` (first of first month) → `to` (last day of last month).
2. Calls `computeDailyTotalAssets(allAccounts, state.transactions, from, to)` — one pass for the full period.
3. For each month key: samples the daily array at the index corresponding to that month's last day.
4. Returns one net-worth value per month.

`_networthAtMonthEnd(allAccounts, yyyyMM)`:
- Calls `computeDailyTotalAssets` with `from = to = monthEnd` — produces a 1-element array.
- Used to fetch the 12-months-ago reference regardless of the selected period.

---

## Zero-line grid

The y-axis grid uses a color callback to highlight the zero line:

```js
grid: { color: ctx => ctx.tick.value === 0 ? C.ember + 'bb' : C.hair }
```

The ember-coloured zero line is visually prominent — important when net worth dips negative.

---

## Stat cards (3)

| Card | Value | Colour rule |
|---|---|---|
| Net worth | Current month-end value | `.positive` if ≥ 0; `.negative` if < 0 |
| Change this month | Current − previous month | ↑ green / ↓ red |
| vs 12 months ago | Current − 12-months-ago reference (always computed, period-independent) | ↑ green / ↓ red; sub-label shows % |

The "vs 12 months ago" stat is computed independently of the selected period — even if the user selects `last_6`, the comparison to 12 months ago is still computed via `_networthAtMonthEnd`.

---

## Chart

```js
{
  type: 'line',
  fill: 'origin',              // fills between line and zero axis
  backgroundColor: C.teal + '18',
  borderColor: C.teal,
  pointRadius: 6,
  legend: { display: false },  // single series, stat cards tell the story
}
```

When net worth goes negative, `fill: 'origin'` automatically fills below the zero axis (downward fill). The fill color is a light teal regardless of sign — the ember zero-line provides the visual distinction.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No active accounts | `chart-empty` "No active accounts found."; returns `null` |
| Net worth goes negative | Chart renders below zero; ember zero-line highlights the crossing |
| Foreign-currency account with missing rate | `toBase` returns 0 for that account — it is excluded silently |
| Only 1 month in period | Single data point — Chart.js renders as a dot; valid |
| 12-months-ago reference month has no data | `_networthAtMonthEnd` returns `0`; stat card shows 0 as base |
