# Insight 11 — Category Drill-down

**File:** `sections/insights/11-category-drilldown.js`
**Group:** Categories
**Chart type:** Horizontal bar — two levels (major → minor)
**Tabs:** None (no tab strip)

---

## What it shows

Major categories as horizontal bars. Tap any bar to drill into its minor category breakdown. A "← Back" button returns to the major view. Optimised for one-tap mobile exploration.

---

## State key

```js
state.insightDrillMajor: string | null
```

Added to `core/state.js`. `null` = top-level major view. A string value = drilled into that major category. Persists across period changes; if the drilled major has no data in the new period it is auto-reset to `null`.

---

## Chart lifecycle (internal)

Unlike other insights, this one manages its own Chart.js instance internally because the drill-down click handler must destroy the current chart and create a new one without going through the coordinator.

```js
let _chart = null;

function _destroyChart() { _chart.destroy(); _chart = null; state.insightChartInstance = null; }
function _setChart(c)    { _chart = c; state.insightChartInstance = c; }
```

`state.insightChartInstance` is kept in sync so the coordinator's `_destroyChart()` (called on period change or navigation) still works correctly.

---

## Level 1 — major categories

`_renderLevel1(container, moneyOut, sym)`:
1. `_groupMajors(moneyOut)` → groups by `major_category` (falls back to `'Uncategorised'`), sums via `sumAmountBase`, sorts desc.
2. Colors: one palette color per bar — `palette[i % palette.length]`.
3. Chart `onClick` callback: `majors[elements[0].index].cat` → sets `state.insightDrillMajor`, destroys level-1 chart, calls `_renderLevel2`.

---

## Level 2 — minor categories within a major

`_renderLevel2(container, moneyOut, major, majorColor, sym)`:
1. `_groupMinors(moneyOut, major)` → filters to the selected major, groups by `minor_category` (falls back to `'Other'`), sorts desc.
2. All bars colored with `majorColor` (the palette color of the parent major bar).
3. "← Back" button rendered above chart. Click listener: `state.insightDrillMajor = null`, destroy chart, call `_renderLevel1`.
4. Title: `"Food — minor breakdown"`.

---

## Canvas height

Dynamic: `Math.max(120, numBars × 36 + 40)` — grows with the number of categories. 10 bars ≈ 400px; 4 bars ≈ 184px.

---

## Chart options

```js
{
  indexAxis: 'y',              // horizontal bar
  onClick: handler,            // null for level 2
  plugins: { legend: { display: false } },
  scales: { y: { ticks: { font: { size: 12 } } } },
}
```

No legend — category names are already on the y-axis.

---

## Back button

44×44px minimum tap target, `data-action="drill-back"`, rendered above the level-2 chart. Event bound directly to the element (not via delegation) — the element is destroyed when `innerHTML` resets on the next render.

---

## Stat cards

- **Level 1:** Total spend | Category count (with "tap a bar to drill in" hint)
- **Level 2:** Total for major | Sub-category count

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `buildPalette`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in period | `chart-empty` "No spending data for this period."; returns `null` |
| `dashDrillMajor` set but major absent in new period | Auto-reset to `null`, renders level 1 |
| Major with single minor category | Level 2 renders one bar — valid |
| Uncategorised major tapped | Level 2 groups its `minor_category` (or `'Other'` if blank) |
