# Insight 08 — Category Breakdown (Donut)

**Original client module (deleted):** `app/sections/insights/08-category-pie.js`
**Group:** Categories
**Chart type:** Doughnut + custom HTML legend + minor category table
**Tabs:** None (no tab strip)

---

## Current implementation (server)

- **Computed by:** `insightCompute_08_category_pie` in `api/insights-categories.gs`, returned by GET `get_insight` with `id=08-category-pie`; the browser only renders the payload (`app/sections/insights/render-kinds.js`).
- **Render kind:** `donut` · **Periods:** `this_week`, `last_week`, `last_7`, `last_30`, `last_60`, `last_90`, `this_month`, `last_month`, `last_3`, `last_6`, `last_12`, `this_quarter`, `last_quarter`, `ytd`, `last_year`, `custom` · **Default:** `this_month` · **Tabs:** none
- **Extra params:** none · **Drill:** `drill` keys: `major`
- **Rules:** Counts flow-eligible rows only: deleted rows and own-account transfers (including loan / card repayments) are excluded. Periods are inclusive of today and bucket in the request `tz`; a missing rate excludes the value with a `missing_rate` warning. Definitions: [calculations](../calculations.md).

The sections below describe the original browser module (deleted in the dumb-UI refactor). Where they differ from the rules above, the server is authoritative.

---

## What it shows

Proportional spend by major category for the selected period, plus a ranked top-10 minor category table beneath the chart — the fastest way to see where money is going.

---

## Key differences from 01–07

- **Doughnut** — not a line or bar chart. No x/y scales, no `baseChartOptions`.
- **Custom HTML legend** — Chart.js legend is disabled; a custom 2-column grid legend is rendered in HTML to show label + amount + percentage.
- **Centre text** — absolute-positioned `<div>` over the canvas showing total spend.
- **Minor category table** — HTML `<table>`, not a chart.

---

## Data flow

Uses `options.txs` (already filtered by the coordinator to the selected period). Filters to `money-out` only.

---

## Segment computation

`_buildSegments(moneyOut)`:
1. Groups by `major_category` (falls back to `'Uncategorised'`).
2. Sums via `sumAmountBase` per group.
3. Sorts descending by amount.
4. If more than 8 categories: top 7 named + remaining merged into `'Other'`.
5. Returns `[{ label, amount }]`.

---

## Chart

```js
{
  type: 'doughnut',
  data: { labels, datasets: [{ data: amounts, backgroundColor: colors, borderWidth: 2, hoverOffset: 8 }] },
  options: {
    cutout: '60%',
    plugins: {
      legend: { display: false },          // custom HTML legend used instead
      tooltip: { callbacks: { label } },   // shows "£450 (35%)"
    },
  },
}
```

Colors: `buildPalette(C)` — 8 design-token colors, cycling for >8 segments.

---

## Centre text

Absolute-positioned `<div>` centered over the canvas (not a Chart.js plugin):

```html
<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%)">
  <p>£1,234</p>
  <p>total spend</p>
</div>
```

The wrapper `<div>` has `position:relative` so the overlay positions correctly.

---

## Custom legend (HTML)

2-column grid (`grid-template-columns: 1fr 1fr`) rendered below the canvas. Each item:

```
[swatch] Category name ............... £450  35.0%
```

Swatch = 11×11px coloured square. Label truncated with `text-overflow: ellipsis`. Amount and % are right-aligned.

---

## Minor category table

`_tableHtml(moneyOut, total, sym)`:
1. Groups by `major_category + minor_category` key pair.
2. Sums per pair, sorts desc, takes top 10.
3. Renders as `<table>` with columns: Category (`Major → Minor`) | Amount | %.
4. Scrollable horizontally on mobile.

Returns empty string if no rows (never happens when `moneyOut` is non-empty).

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `buildPalette` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in period | `chart-empty` "No spending data for this period."; returns `null` |
| Single category | Full circle; legend shows one item; table shows minor breakdown |
| Uncategorised txs | Grouped under `'Uncategorised'` segment |
| >8 major categories | Top 7 named; rest merged into `'Other'` |
| Minor category is blank | Displayed as `'—'` in the table |
