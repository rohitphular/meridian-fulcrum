# Insight 22 — Top Counterparties

**File:** `sections/insights/22-top-counterparties.js`
**Group:** Spending analysis
**Chart type:** Horizontal bar (`indexAxis: 'y'`)
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

Top merchants / counterparties ranked by total spend in the selected period. Horizontal bars sorted largest to smallest. Tapping a bar expands a drill-down panel showing the individual transactions and a period-over-period comparison.

---

## Module-level state

```js
let _chart    = null;  // active Chart.js instance
let _allRows  = [];    // [{label, total, txs}] — full sorted list, pre-slice
let _selIdx   = -1;    // highlighted bar index (-1 = none)
let _from, _to, _sym, _C;
```

All fields reset at the top of `render()`. Same `_setChart` / `_destroyChart` pattern as insights 11 and 21.

---

## Data grouping

`_groupCounterparties(outTxs)`:
1. Groups `money-out` transactions by `counterparty.trim().toLowerCase()` (case-insensitive normalisation).
2. Display label = the original (non-lowercased) value, or `'Unknown merchant'` if blank.
3. `sumAmountBase` per group.
4. Sorted descending by total.
5. Returns `[{label, total, txs}]` — full unsorted list, all counterparties.

The top-N slice happens at render time, not here, so filter pills can re-slice without recomputing.

---

## Computation

`_allRows` is computed once per `render()` call from all `money-out` txs in the period.

Filter pills control which slice of `_allRows` is shown:
- `Top 10` → `_allRows.slice(0, 10)`
- `Top 15` (default) → `_allRows.slice(0, 15)`
- `Top 20` → `_allRows.slice(0, 20)`

---

## Chart

```js
{
  type: 'bar',
  indexAxis: 'y',                         // horizontal bars
  datasets: [{
    data:            spendAmounts,
    backgroundColor: barColors,           // teal by default, ember for selected
    borderRadius:    4,
  }],
  options: {
    legend: { display: false },
    tooltip: { label: ctx => `${sym}${amount} (N txns)` },
    onClick: (evt, elements) => { /* highlight + drill-down */ }
  }
}
```

Y-axis labels truncated to 22 chars (ellipsis) — full name shown in tooltip.
Canvas height: `Math.max(300, N × 44)` px — grows with the number of bars.

### Bar highlighting

When a bar is tapped:
```js
ds.backgroundColor = rows.map((_, i) => i === _selIdx ? C.ember : C.teal);
chart.update('none');
```

Tapping the same bar again deselects (toggles `_selIdx` back to `-1`).

---

## Drill-down panel (`#dash22-panel`)

Shown below the chart when a bar is selected. Contains:

1. **Header:** Counterparty name + transaction count
2. **Period comparison** (when previous period has data):
   - This period spend | Prev period spend | Δ with ↑/↓ arrow
3. **Transaction list:** Sorted newest-first. Each row: date | category | amount

Previous-period spend is computed via `_prevSpend(labelLower)`:
- `duration = to − from` (ms)
- `prevFrom = from − duration − 1 day`, `prevTo = from − 1 ms`
- Scans `state.transactions` directly (not coordinator-filtered `txs`) so the full history is available

Spend delta colour: `.positive` when lower spend (saving money), `.negative` when higher.

Panel closes when the same bar is tapped again.

---

## Filter pills

```
Top 10 | Top 15 | Top 20
```

Horizontally scrollable on mobile (`overflow-x: auto`). Active pill: `background: var(--teal)`.

Pill click: destroys old chart, recreates `<canvas>` (Chart.js requires a fresh canvas element after `.destroy()`), calls `_renderChart(containerId, topN)`.

---

## Stat cards (4)

| Card | Value |
|---|---|
| Total spend | Sum of all `money-out` in period |
| Merchants | Count of distinct counterparties |
| Transactions | Total `money-out` transaction count |
| Top merchant | Name (truncated) + amount as `stat-card-sub` |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No spend transactions | `chart-empty` "No spend transactions for this period."; returns proxy |
| Blank counterparty | Grouped as `'Unknown merchant'` |
| Case variations (`AMAZON` vs `Amazon`) | Normalised via `.toLowerCase()` before grouping; display label = first seen value |
| All spend from one counterparty | Single bar; no special treatment |
| Fewer rows than selected top-N | Slice returns all available rows; canvas height still `max(300, rows.length × 44)` |
| No previous-period data for counterparty | Period comparison row hidden |
| `money-transfer` txs | Excluded (only `money-out` counted) |
