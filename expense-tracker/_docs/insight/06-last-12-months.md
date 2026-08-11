# Insight 06 — Last 12 Months

**File:** `sections/insights/06-last-12-months.js`
**Group:** Spending comparisons
**Chart type:** Mixed — grouped bar (income + expense) with net line overlay
**Tabs:** Transactions | Accounts

---

## What it shows

Monthly income vs expense bars for the rolling last 12 calendar months, with a net (income − expense) line overlay. The clearest macro view of cash-flow health over a full year.

---

## Key difference from 01–05

**No comparison period. Fixed window. Mixed chart type.** Unlike the other comparison insights, this shows a single 12-month window in absolute terms — not vs a prior period. The coordinator's `from`/`to` are ignored; the window is always computed internally.

---

## Window computation

Always fixed to the 12 months ending with the current partial month:

```js
// 12 months: 11 full months behind + current partial month
const months12 = Array.from({ length: 12 }, (_, i) =>
  new Date(todayLocal.getFullYear(), todayLocal.getMonth() - 11 + i, 1)
);
```

The last bucket (index 11) is the current month, filtered to transactions up to today. Labels have a `*` suffix: `'Aug 26*'`.

---

## Transactions tab

### Computation

`_buildMonthly(months12, todayLocal)`:
- Groups all `state.transactions` by month via `groupByMonth`.
- For each month: sums `money-in` as income, `money-out` as expense.
- Last bucket (index 11): filtered to `transaction_date_utc ≤ todayLocal`.
- Returns `{ income[], expense[], net[] }` — 12 values each.

### Stat cards (4)

| Card | Value |
|---|---|
| Income (12 mo) | Sum of all income — `.positive` |
| Expenses (12 mo) | Sum of all expenses — `.negative` |
| Net | `totalIncome - totalExpense` — `.positive` / `.negative` |
| Avg spend/mo | `totalExpense / 12` |

### Chart — mixed bar + line

```js
{
  type: 'bar',                          // outer type
  datasets: [
    { label: 'Income',   type: 'bar',  backgroundColor: 'rgba(52,211,153,0.8)', order: 2 },
    { label: 'Expenses', type: 'bar',  backgroundColor: 'rgba(248,113,113,0.8)', order: 2 },
    { label: 'Net',      type: 'line', borderColor: '#f59e0b', fill: false, order: 1 },
  ]
}
```

- `order: 1` on the net line draws it on top of the bars.
- `maxTicksLimit: 6` on x-axis — shows every other month on mobile.

---

## Accounts tab

### Computation

Groups active asset accounts by `sub_type` (falls back to `type`, then `'other'`) and renders a stacked bar per group:

1. For each group: `computeDailyTotalAssets(groupAccts, state.transactions, rangeStart, todayLocal)`.
2. Sample month-end value at last day of each complete month, or `todayLocal` for the current partial month.
3. Returns one dataset per group with `stack: 'assets'` — Chart.js stacks them automatically.

Group label: `sub_type` or `type`, capitalised, underscores replaced with spaces.
Colors: `buildPalette(C)` — cycles through 8 design tokens.

### Stat cards (2)

| Card | Value |
|---|---|
| Total assets | Sum of all groups on month 12 |
| Account groups | Count — sub-label lists group names |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `groupByMonth` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `buildPalette`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Fewer than 12 months of data | Early months show 0 income/expense — bars absent, chart still renders |
| Current month is the 1st of the month | Last bucket has ≤1 day of data; renders correctly (partial bars) |
| Mixed currencies, missing rates | `sumAmountBase` excludes txs with no rate — affects accuracy silently |
| No active asset accounts (accounts tab) | `.chart-empty` "No active asset accounts found."; returns `null` |
| All accounts in one sub_type | Single-colour stacked bar (no visible stacking); functionally correct |
