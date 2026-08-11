# Insight 19 — Cash Flow Waterfall

**File:** `sections/insights/19-cashflow-waterfall.js`
**Group:** Income & cash flow
**Chart type:** Waterfall (stacked bar simulation)
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

Opening balance → income → spending by major category → closing balance for the selected month. Each segment drops (expenses) or raises (income) the running total. Instantly shows where money went within a single month and what remained.

---

## Waterfall simulation in Chart.js

Chart.js has no native waterfall type. It's simulated with a two-dataset stacked bar chart:

| Dataset | Role | Color |
|---|---|---|
| 0 — "base" | Invisible offset that floats the visible bar to the right position | `rgba(0,0,0,0)` |
| 1 — "Amount" | The colored bar the user sees | Per segment (see below) |

Both datasets share `stack: 'wf'`. With `x.stacked: true`, dataset 1 sits on top of dataset 0 at each X position.

For each segment, the visible bar spans from `baseVals[i]` to `baseVals[i] + visVals[i]`:
- **Opening / Closing:** `base = 0`, `visible = balance` — bar rises from zero
- **Income:** `base = runningTotal`, `visible = +income` — bar rises
- **Expense category:** `base = runningTotal`, `visible = −expense` — bar drops

---

## Computation

### Starting balance

`_startBalance(accounts, from)`:
1. Filters `accounts` to `is_active`.
2. Derives `prevEnd = new Date(from.getFullYear(), from.getMonth(), 0)` — last day of the previous month.
3. Calls `computeDailyTotalAssets(active, state.transactions, prevEnd, prevEnd)` — single-day replay.
4. Returns `daily[0] || 0`.

All active accounts (assets + liabilities + investments) are included. This gives the net balance (net worth) at the start of the month.

### Expense grouping

`_groupExpenses(outTxs)`:
1. Groups `money-out` transactions by `major_category` (fallback: `'Uncategorised'`).
2. `sumAmountBase` per category.
3. Sorts by amount descending.
4. Top `MAX_CATS = 10` categories kept; remainder grouped as `"Other expenses"`.
5. Returns `[[label, amount], ...]`.

### Waterfall build

```
rt = startBalance
Opening:   base=0,  visible=startBalance,  color=teal
Income:    base=rt, visible=+income,       color=green;  rt += income
For each expense category:
           base=rt, visible=-expense,      color=ember;  rt -= expense
Closing:   base=0,  visible=rt,            color=teal (or ember if rt < 0)
```

---

## Chart

```js
{
  type: 'bar',
  datasets: [
    { label: '',       data: baseVals, backgroundColor: 'rgba(0,0,0,0)', stack: 'wf', borderWidth: 0 },
    { label: 'Amount', data: visVals,  backgroundColor: barColors,       stack: 'wf', borderRadius: 4 },
  ],
  options: {
    scales: {
      x: { stacked: true,  ticks: { maxRotation: 30, font: { size: 11 } } },
      y: { stacked: false }    // Y axis uses absolute values, not cumulative
    }
  }
}
```

**Segment colors:**
| Segment | Color |
|---|---|
| Opening | `C.teal` |
| Income | `rgba(52,211,153,0.85)` (green) |
| Expense categories | `C.ember` (red) |
| Closing (positive) | `C.teal` |
| Closing (negative) | `C.ember` |

Canvas height: `300px`.
Legend: `display: false` (bars are self-explanatory from X labels).
X-axis labels: `['Opening', 'Income', ...majorCategories, 'Closing']`; rotated 30° for mobile legibility.

---

## Tooltip

Only dataset 1 (visible bars) produces a tooltip label:
```js
label: ctx => ctx.datasetIndex === 0 ? null : `${sym}${Math.abs(ctx.raw).toLocaleString()}`
```

`Math.abs` normalises negative expense values so the tooltip always shows a positive amount owed.

---

## Stat cards (4)

| Card | Value | Colour |
|---|---|---|
| Opening balance | `startBalance` | neutral |
| Total income | Sum of all `money-in` txs | `.positive` |
| Total expenses | Sum of all `money-out` txs | `.negative` |
| Closing balance | `startBalance + income − expenses` | `.positive` / `.negative` |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `computeDailyTotalAssets` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No active accounts | `_startBalance` returns `0`; waterfall starts at 0 |
| Opening balance = 0 | Opening bar absent (zero height); waterfall starts at income |
| Month with no income | Income bar = 0; net = negative; closing bar red if balance goes negative |
| Closing balance < 0 (overdraft) | Closing bar drops below zero; colored `C.ember` |
| More than 10 expense categories | Smallest categories grouped as `"Other expenses"` |
| No expense transactions | Only Opening + Income + Closing shown |
| `money-transfer` txs | Excluded (only `money-in` and `money-out` counted) |
