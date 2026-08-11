# Insight 10 — Top Categories MoM Comparison

**File:** `sections/insights/10-top-categories.js`
**Group:** Categories
**Chart type:** Horizontal grouped bar (`indexAxis: 'y'`)
**Tabs:** None (no tab strip)

---

## What it shows

Top 10 minor categories by spend in the selected month, paired with the preceding month — instantly reveals which categories grew or shrank.

---

## Period derivation

- **Period A:** Coordinator's `options.txs` (already filtered to selected range), `money-out` only.
- **Period B:** Month immediately before `from`:

```js
const bFrom = new Date(from.getFullYear(), from.getMonth() - 1, 1);
const bTo   = new Date(from.getFullYear(), from.getMonth(), 0);
```

Fetched directly from `state.transactions` via `filterTxByRange`.

---

## Computation

1. `_groupByMinor(txs)` → `Map<minor_category, total>` — groups by `minor_category` (falls back to `'Uncategorised'`), sums via `sumAmountBase`.
2. Union of all minor categories appearing in either period.
3. Sort by **Period A amount descending**.
4. Take top 10 (`TOP_N = 10`).
5. Period B value for any category absent from B = `0`.

---

## Chart

```js
{
  type: 'bar',
  indexAxis: 'y',           // ← horizontal bars
  datasets: [
    { label: labelA, data: amtsA, backgroundColor: C.teal,        borderRadius: 4 },
    { label: labelB, data: amtsB, backgroundColor: C.muted+'99',  borderRadius: 4 },
  ],
}
```

- `indexAxis: 'y'` flips the chart horizontal. Y-axis = category labels; X-axis = amounts.
- Muted color (`C.muted + '99'` alpha) for Period B — visually subordinate to Period A (teal).
- Canvas height dynamic: `max(200, rows.length × 32)px` — grows with row count, up to ~320px for 10 rows.
- Y-axis tick font: 11px (compact for long category names).

---

## Stat cards (2)

| Card | Value |
|---|---|
| Period A total | Sum of top-N categories for current month |
| Period B total | Sum of same categories for previous month |

---

## Delta list

Below the chart: `<ul>` of all `rows.length` categories with per-item delta:

```
Eating out      ▲ +£23 vs Jun 26
Groceries       ▼ −£11 vs Jun 26
```

- `▲` / `▼` arrow + signed delta amount vs Period B label.
- `.positive` class when spending decreased (`delta ≤ 0`); `.negative` when increased.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `filterTxByRange` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in Period A | `chart-empty` "No spending data for this period."; returns `null` |
| Fewer than 10 minor categories | All available rows shown (< 10 bars) |
| Category new in Period A (0 in B) | Included; Period B bar = 0 |
| Category only in Period B | Excluded — list sorted by Period A; zeros rank last |
