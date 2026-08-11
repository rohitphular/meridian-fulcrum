# Insight 16 — Asset vs Liability Over Time

**File:** `sections/insights/16-asset-vs-liability.js`
**Group:** Net worth
**Chart type:** Line — 2 series with area fill
**Tabs:** None (accounts view only — no tab strip)

---

## What it shows

Month-end total assets and total liabilities as two separate filled lines. The gap between them is net worth — widening as assets grow and liabilities shrink is the goal.

---

## Relationship to Insight 14

14 combines assets and liabilities into a single net-worth line. 16 separates them to show whether assets are growing, whether liabilities are shrinking, and at what relative rates.

---

## Computation

`_buildMonthly(assetAccts, liabAccts, monthKeys)`:
1. Builds `from` (first of first month) → `to` (last day of last month).
2. `computeDailyTotalAssets(assetAccts, ...)` → daily asset totals (positive values).
3. `computeDailyTotalAssets(liabAccts,  ...)` → daily liability totals (negative values, debt).
4. For each month: samples the last day of the month from each daily array.
5. Liabilities displayed as `Math.abs(value)` — shown as positive magnitude.

Empty account group → zero-filled array of the same length (avoids a second `computeDailyTotalAssets` call for accounts that don't exist).

---

## Account partitioning

- **Asset accounts:** `!liabilityTypes.has(a.type)` — includes investments.
- **Liability accounts:** `liabilityTypes.has(a.type)` — from `state.accountSchema.liability_types`.

---

## Chart

```js
datasets: [
  { label: 'Total Assets',      borderColor: C.teal,  backgroundColor: C.teal  + '1a', fill: true },
  { label: 'Total Liabilities', borderColor: C.ember, backgroundColor: C.ember + '1a', fill: true, borderDash: [4,4] },
]
```

Both filled. Liabilities are dashed to distinguish from assets even in monochrome. The visual gap between them represents net worth.

---

## Stat cards (4)

| Card | Value | Colour |
|---|---|---|
| Total assets | Current month-end asset total | `.positive` |
| Total liabilities | Current month-end liability total (abs) | `.negative` |
| Net worth | `assets − liabilities` | `.positive` / `.negative` |
| Period Δ net | Net worth change from first to last month | ↑/↓ with colour |

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
| No liability accounts | Liability line is zero flat — visually confirms debt-free status |
| Liability increases (new loan) | Liability line goes up in the chart — visually clear |
| All foreign-currency accounts | `computeDailyTotalAssets` converts via `toBase`; missing rates → that account excluded (balance = 0) |
