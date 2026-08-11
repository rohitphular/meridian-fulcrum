# Insight 13 — Tag Spending Trend

**File:** `sections/insights/13-tag-trend.js`
**Group:** Categories
**Chart type:** Multi-series line (one per tag, monthly)
**Tabs:** None (no tab strip)

---

## What it shows

Monthly spend attributed to each tag over the selected period — tracks whether per-person or per-purpose spend is growing or shrinking month by month.

---

## Key differences from 09 (category trend)

- **Lines, not stacked bars** — each tag gets its own line; they are not summed.
- **Split attribution** — same as 12: each tag receives `amount / tagCount`, not the full tx amount.
- **Default visibility cap** — top 6 tags rendered visible; additional tags are hidden by default but togglable via the chart legend.

---

## Data flow

Uses `options.txs` (pre-filtered by coordinator) and `options.from` / `options.to` for the month range. Filters to `money-out` only.

---

## Computation

`_buildTagMonthly(moneyOut, monthKeys)`:
1. `groupByMonth(moneyOut)` — groups all txs by `'YYYY-MM'`.
2. For each month: iterates txs, splits `tags` by `;`, normalises (lowercase + trim), skips blank tags.
3. Computes `share = sumAmountBase([tx]) / tags.length` — proportional split per tag.
4. For each tag: adds `share` to `tagMonthMap[tag][monthKey]`.
5. Returns `Map<tag, Map<monthKey, total>>`.

Untagged txs are skipped.

---

## Datasets

```js
sorted.map(({ tag }, i) => ({
  label:   tag,
  data:    monthKeys.map(mk => monthMap.get(mk) || 0),
  hidden:  i >= 6,    // top 6 visible, rest hidden but legend-togglable
  ...
}))
```

- Sorted by grand total descending — top-spending tags get prominent colours and are visible by default.
- `0` for months with no spend for that tag (not `null`).
- `backgroundColor: palette[i] + '22'` — very light fill under each line.

---

## Legend toggle

Chart.js default legend click handler toggles dataset visibility. No custom `onClick` override needed — the built-in behavior is exactly what's required: click a legend item to show/hide that tag's line.

---

## Stat cards (2)

| Card | Value |
|---|---|
| Distinct tags | Total unique tags across all months; sub-label if > 6 |
| Top tag | Highest-spending tag name + its total |

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
| No tagged transactions | `chart-empty` "No tagged transactions in this period."; returns `null` |
| Single tag | One line rendered; no visibility cap needed |
| Tag in one month only | Line peaks at that month, `0` elsewhere |
| > 6 tags | Top 6 visible; rest present in legend greyed-out (click to show) |
| Mixed-case tags | Normalised to lowercase — `Rohit` and `rohit` merge into one series |
