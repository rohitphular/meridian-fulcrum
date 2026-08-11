# Insight 20 — Savings Rate Over Time

**File:** `sections/insights/20-savings-rate.js`
**Group:** Income & cash flow
**Chart type:** Mixed — bar (income + expenses) + line (savings rate %)
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

Monthly savings rate as a percentage line (primary focus), with income and expense bars in the background for scale. Savings rate = `(income − expenses) / income × 100`. Tracks whether the user is living below their means month by month.

---

## Computation

`_buildMonthly(txs, monthKeys)`:
1. Groups `money-in` and `money-out` txs by month via `groupByMonth`.
2. Partial month (current calendar month): txs filtered to `<= todayLocal`.
3. Per month: `inc = sumAmountBase(inTxs)`, `exp = sumAmountBase(outTxs)`.
4. `rate = inc > 0 ? (inc − exp) / inc × 100 : null` — `null` when no income (renders as gap in line chart).
5. Rate can be negative (spent more than earned).

---

## Chart

**Type:** `'bar'` outer with mixed dataset types.

| Dataset | Type | Y axis | Notes |
|---|---|---|---|
| Income | bar | `y` (left, GBP) | `hidden: true` on mobile |
| Expenses | bar | `y` (left, GBP) | `hidden: true` on mobile |
| Savings % | line | `y2` (right, %) | Primary; `spanGaps: false` |

Colors:
- Income bars: `rgba(52,211,153,0.5)`
- Expense bars: `rgba(248,113,113,0.5)`
- Savings rate line: `#f59e0b` (amber), `borderWidth: 2.5`, `pointRadius: 5`

Canvas height: `280px`.

### Dual Y axes

```js
y:  { position: 'left',  ticks: { callback: v => `${sym}${v}` } }
y2: { position: 'right', grid: { drawOnChartArea: true, color: ctx => ctx.tick.value === 0 ? C.ember + '99' : 'transparent' },
      ticks: { callback: v => `${v}%` } }
```

The Y2 grid draws only the zero line (ember-colored) — all other Y2 gridlines are transparent. This marks the break-even point clearly without cluttering the chart.

### Mobile behaviour

When `window.innerWidth < 640`:
- Income and expense bar datasets: `hidden: true` — only the savings rate line is shown.
- Users can re-enable bars by tapping legend entries (Chart.js default toggle).

### Gaps for missing income

`spanGaps: false` on the savings rate dataset. Months where `income = 0` have `rate = null`, which Chart.js renders as a visible gap rather than a line interpolated to 0.

---

## Partial month

Same pattern as insights 06 and 18:
- If the last month key equals the current calendar month, label gets `*` suffix.
- A `"* partial month"` note appears above the chart.
- That month's transactions are filtered to `<= todayLocal`.

---

## Stat cards (4)

`_computeStats(rateArr, monthKeys)`:

| Card | Value | How computed |
|---|---|---|
| Avg savings rate | Mean of non-null rates | `.positive` if ≥ 0, `.negative` if < 0 |
| Best month | `"Jul '25 (43%)"` | Month with highest rate among non-null entries |
| Worst month | `"Jan '25 (−8%)"` | Month with lowest rate |
| Positive streak | `"N months"` or `"—"` | Trailing consecutive months ending at last month where rate > 0 |

All three month-specific cards show `"—"` when no non-null rates exist.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange` | `insight-utils.js` |
| `groupByMonth` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Month with zero income | `rate = null`; gap in line; excluded from avg/best/worst |
| Negative savings rate | Line goes below zero; zero line (ember) on Y2 marks break-even |
| All months zero income | All rates null; stat cards show `"N/A"` / `"—"` |
| Partial current month | `*` suffix on label; txs filtered to today |
| Mobile | Bar datasets hidden by default; savings rate line only |
| `money-transfer` txs | Excluded (neither `money-in` nor `money-out`) |
