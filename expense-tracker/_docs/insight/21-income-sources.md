# Insight 21 — Income Sources

**File:** `sections/insights/21-income-sources.js`
**Group:** Income & cash flow
**Chart type:** Doughnut (By Source / By Category) + Line (Trend) — three internal sub-views
**Tabs:** None (transactions view only — no coordinator tab strip)

---

## What it shows

Where income comes from, in three switchable sub-views:

| Sub-view | Chart | What it answers |
|---|---|---|
| By Source | Doughnut | Which counterparties send money? |
| By Category | Doughnut | What income types dominate? |
| Trend | Line + stat cards | Is income growing or shrinking? |

---

## Data source

```js
const inTxs = txs.filter(t => t.transaction_type === 'money-in');
```

`money-transfer` and `money-out` excluded.

---

## Internal sub-view architecture

Insight 21 manages its own tab strip (not the coordinator's). The pattern mirrors `11-category-drilldown`:

```js
let _chart = null;

function _setChart(c) {
  if (_chart && _chart !== c) _chart.destroy();
  _chart = c;
  state.insightChartInstance = c;
}
```

`render()` returns `{ destroy() { _destroyChart(); } }`. After any sub-view switch, `_setChart(newChart)` overwrites `state.insightChartInstance` with the new chart directly, so the coordinator always calls `.destroy()` on the currently active chart.

`_chart = null` is set at the top of `render()` to clear any stale reference from a previous render of this insight.

---

## Sub-view: By Source / By Category

`_groupBy(inTxs, field, fallback)`:
1. Groups income transactions by `field` (`'counterparty'` or `'major_category'`).
2. Blank/missing values → `fallback` (`'Unknown source'` or `'Uncategorised'`).
3. Sorts by amount descending.
4. Top `MAX_SEGMENTS = 8` kept; remainder grouped as `'Other'`.
5. Returns `[[label, amount], ...]`.

### Doughnut chart

```js
{
  type: 'doughnut',
  cutout: '60%',
  datasets: [{ data: amounts, backgroundColor: palette, borderWidth: 2 }],
  options: {
    legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8 } },
    tooltip: { label: ctx => `${label}: ${sym}${amount} (${pct}%)` }
  }
}
```

Palette: `buildPalette(C)` (8 colors), cycled via `i % palette.length`.

Canvas height: `200px`.

### Table below donut

Each segment rendered as a list row: `color swatch | name | amount | %`.

**Concentrated income warning:** If `amounts[0] / total > 0.9`, a note appears above the chart:
> "Concentrated income — Vega Investments accounts for 94%"

---

## Sub-view: Trend

`_monthlyTotals(inTxs, monthKeys)` — `groupByMonth` then `sumAmountBase` per month key.

Line chart: filled area, `borderColor: '#34d399'`, `fill: true`, canvas height `220px`.

Stat cards (3, above the chart):

| Card | Value |
|---|---|
| Total income | Sum of `monthly` array |
| Avg monthly | `total / monthKeys.length` |
| Peak month | `fmtMonthKey(monthKeys[peakIdx])` + amount as `stat-card-sub` |

---

## Internal tab strip

Pill-styled buttons with `data-d21-view` attribute (`'source'`, `'category'`, `'trend'`).

Active button: `background: var(--teal)`, `color: var(--ink)`.
Inactive: `background: transparent`, `color: var(--muted)`.

Click handler calls the appropriate render function; `_setChart` destroys the previous chart.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange` | `insight-utils.js` |
| `groupByMonth` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions`, `buildPalette` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No income in period | `chart-empty` "No income recorded for this period."; returns proxy with no-op |
| Blank counterparty | Grouped as `'Unknown source'` |
| Blank major_category | Grouped as `'Uncategorised'` |
| One source > 90% of income | Amber "Concentrated income" note above doughnut |
| More than 8 sources/categories | Excess grouped as `'Other'` |
| Trend with single month | Single point rendered; line still valid |
