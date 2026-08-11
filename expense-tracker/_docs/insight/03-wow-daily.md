# Insight 03 — Week-on-Week Daily Comparison

**File:** `sections/insights/03-wow-daily.js`
**Group:** Spending comparisons
**Chart type:** Line — 2 series, filled area on Period A
**Tabs:** Transactions | Accounts

---

## What it shows

Daily spend (non-cumulative) for the current ISO week (Mon–Sun) vs the previous ISO week on the same weekday axis. Spots heavy spend days early in the week. The filled area on Period A makes it visually distinct from the dashed Period B line.

---

## Key difference from 01/02

**This chart shows daily spend, not cumulative.** Each point = total spend on that single weekday. This makes it easier to identify which individual days are expensive rather than tracking running totals.

---

## Period derivation

`from` is always the Monday of the selected week (guaranteed by `getPeriodBounds` for `this_week`/`last_week`):

```js
// Period A — selected week (Mon → Sun)
const aFrom = new Date(from);
const aTo   = new Date(from); aTo.setDate(from.getDate() + 6);

// Period B — previous week (Mon → Sun)
const bFrom = new Date(from); bFrom.setDate(from.getDate() - 7);
const bTo   = new Date(from); bTo.setDate(from.getDate() - 1);
```

Both periods fetch from `state.transactions` directly (not `options.txs`).

---

## Transactions tab

### Computation

1. Filter `state.transactions` to each week range, `money-out` only.
2. `_buildWeeklyDaily(txs, weekFrom, cutoffDate)` — returns a 7-element array (Mon–Sun). Each element = `sumAmountBase` of that day's transactions.
3. Period A: days after today → `null` if in the current week.
4. Period B: all 7 days always filled (past week).

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Period A label | Total spend this week | — |
| Period B label | Total spend last week | — |
| WoW change | `delta` with ↓/↑ and % | `delta ≤ 0` → `.positive`; `delta > 0` → `.negative` |
| Week | ISO week label e.g. `W31 2026` | — |

### Chart

- **X axis:** `['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']` — fixed 7 labels
- **Series 1 (Period A):** `C.teal`, `fill: 'origin'`, `backgroundColor: C.teal + '1a'`, `pointRadius: 4`
- **Series 2 (Period B):** `C.muted`, `borderDash: [4,4]`, `fill: false`, `pointRadius: 3`
- **Legend labels:** `"W31 2026 (current)"` | `"W30 2026 (prev)"`
- `spanGaps: false` — null days render as gaps (today onwards in current week)

---

## Accounts tab

### Computation

Uses `computeDailyTotalAssets` (from `insight-utils.js`) for both periods — 7 data points each.

- Period A: cutoffs days after today index if in the current week
- Period B: full 7-day array

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Current assets | Last non-null in Period A | — |
| Prev week end | Last value in Period B | — |
| WoW change | `delta` ↑/↓ with % | `delta ≥ 0` → `.positive`; `delta < 0` → `.negative` |
| Week | ISO week label | — |

---

## ISO week label

```js
function _isoWeekLabel(monday) {
  // Shifts to Thursday of the week (ISO standard) to find the correct year
  const d = new Date(monday);
  d.setDate(d.getDate() + 3);
  const jan4    = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
  return `W${String(weekNum).padStart(2, '0')} ${d.getFullYear()}`;
}
```

---

## Shared utilities used

| Utility | Source |
|---|---|
| `filterTxByRange` | `insight-utils.js` |
| `groupByDay` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Monday of current week | Period A has 1 non-null point; Tue–Sun are `null` (gap on chart) |
| No transactions in either week | Both series are all-zero flat lines; no special empty state (zeros are valid data) |
| No active asset accounts (accounts tab) | `.chart-empty` "No active asset accounts found."; return `null` |
| Custom period where `from` is not a Monday | Period A starts from `from`; the weekday alignment may be off — week presets are the intended usage |
