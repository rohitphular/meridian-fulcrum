# Insight 09 — Category Spending Trend

**File:** `sections/insights/09-category-trend.js`
**Group:** Categories
**Chart type:** Stacked bar (monthly)
**Tabs:** None (no tab strip)

---

## What it shows

Monthly stacked bars where each colour represents a major category — lets you see how the spending mix has shifted over time (e.g. Food growing while Transport shrinks).

---

## Data flow

Uses `options.txs` (pre-filtered by coordinator) and `options.from` / `options.to` for the month range. Filters to `money-out` only.

---

## Computation

`_buildDatasets(moneyOut, monthKeys, C)`:

1. `groupByMonth(moneyOut)` → groups all txs by `'YYYY-MM'` key.
2. For each month key: builds a `Map<category, total>` using `sumAmountBase` per category group. Missing category → `'Uncategorised'`.
3. Collects all unique categories across all months.
4. Sorts categories by **grand total descending** — largest goes to the bottom of the stack (most visually prominent).
5. Each dataset: `data[i] = monthly total for that category (0 if absent)`. `0` not `null` — keeps the stack continuous.

---

## Chart

```js
{
  type: 'bar',
  datasets: [
    { label: 'Food',   data: [...], backgroundColor: palette[0]+'cc', stack: 'spend' },
    { label: 'Travel', data: [...], backgroundColor: palette[1]+'cc', stack: 'spend' },
    ...
  ],
  options: {
    scales: {
      x: { stacked: true, maxTicksLimit: 6 },
      y: { stacked: true },
    },
  },
}
```

- `stack: 'spend'` on every dataset — required for Chart.js stacking.
- `'cc'` alpha suffix on palette colors — slight transparency to soften adjacent segments.
- `borderRadius: 2` — softens bar tops.
- Legend: bottom (Chart.js default legend, `display: true`).

---

## Stat cards (4)

| Card | Value |
|---|---|
| Total spend | Grand total across all categories and months |
| Top category | Name of the highest-spending category + its total |
| Peak month | Month key with highest total spend + that total |
| Categories | Count of unique major categories in the period |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `groupByMonth` | `insight-utils.js` |
| `monthRange` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `buildPalette`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in period | `chart-empty` "No spending data for this period."; returns `null` |
| Single month | One stacked bar — valid Chart.js output |
| Category present in some months only | `0` for absent months (not `null`) — stack remains continuous |
| > 8 categories | Palette cycles (`i % palette.length`) — colors repeat after 8 |
