# Insight 01 — Month-on-Month Daily Cumulative

**File:** `sections/insights/01-mom-cumulative.js`
**Group:** Spending comparisons
**Chart type:** Line — 2 series
**Tabs:** Transactions | Accounts

---

## What it shows

Running daily cumulative totals for two consecutive months on the same X-axis (day 1–31), so you can see at a glance whether spending or asset value is tracking ahead or behind last month.

---

## Periods

| | Period A | Period B |
|---|---|---|
| Start | `from` (first of selected month) | First day of the month before `from` |
| End | `to` (last of selected month) | Last day of the month before `from` |
| Txs source | `options.txs` (already filtered by coordinator) | Fetched from `state.transactions` inside the renderer |

Period B is always the full calendar month immediately before Period A regardless of which preset is selected.

---

## Transactions tab

### Computation

1. Filter Period A `txs` to `money-out` only.
2. Filter `state.transactions` to Period B range + `money-out`.
3. For each period, group by calendar day using `groupByDay()`, then build a cumulative sum day by day via `_buildCumulative()`.
4. Period A: days after today → `null` (Chart.js renders a gap at the end for the current month).
5. Pad both arrays to `maxDays = max(daysInMonthA, daysInMonthB)`.

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Period A label | Total money-out | — |
| Period B label | Total money-out | — |
| Change | `delta` with ↓/↑, % vs last month | `delta ≤ 0` → `.positive` (spent less); `delta > 0` → `.negative` |
| Today | Day-of-month / total days | — (shows "—" for historical months) |

---

## Accounts tab

### Computation

1. Identify asset accounts: `accounts.filter(a => a.is_active && !liabilityTypes.has(a.type))` where `liabilityTypes` comes from `state.accountSchema.liability_types`.
2. For each period, call `_computeDailyTotalAssets(assetAccounts, state.transactions, from, to)`:
   - Initialises each account's balance from `opening_value`.
   - Sorts ALL `state.transactions` chronologically.
   - Walks day by day from period start; applies every transaction (money-in, money-out, transfer) to the relevant account balances as it passes each day boundary.
   - Returns an array of total asset values, one per day.
3. Period A: null-out days after today if in the current month.
4. Pad both arrays to `maxDays`.

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Current assets | Last non-null value in Period A | — |
| Last month end | Last value in Period B | — |
| Change | `delta` with ↓/↑, % | `delta ≥ 0` → `.positive`; `delta < 0` → `.negative` |
| Asset accounts | Count of active asset accounts | — |

---

## Chart spec

| Property | Value |
|---|---|
| Type | `line` |
| Period A series | `borderColor: C.teal`, `fill: false`, `tension: 0.3`, `pointRadius: 3` |
| Period B series | `borderColor: C.muted`, `borderDash: [4,4]`, `fill: false`, `tension: 0.3`, `pointRadius: 2` |
| `spanGaps` | `false` — gaps render as breaks (used for future-day nulls) |
| Legend | `display: true`, position bottom |
| X ticks | `maxTicksLimit: 7` (shows ~every 5th day) |
| Base options | `baseChartOptions(sym, C)` from `insight-utils.js` |

Period A label: `"August 2026"` (full month name + year).
Accounts tab labels: `"Assets Aug 2026"` / `"Assets Jul 2026"`.

---

## Period picker presets

Only `this_month`, `last_month`, and `custom` are meaningful for this day-by-day view. All 12 presets remain in the selector (coordinator renders them all); other values simply treat the selected range as Period A and shift back one calendar month for Period B.

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in Period A | Show `.chart-empty` "No spend data for this period." inside `.chart-wrap`; return `null` |
| No money-out in Period B | Period B line absent from chart (all-zero array still renders as a flat zero line) |
| No active asset accounts | Show `.chart-empty` "No active asset accounts found."; return `null` |
| Currency with no rate | `toBase` returns 0 for that transaction; effectively excluded from sums (`.dash-warn` shown by coordinator) |
| `opening_value` missing | Treated as 0 — `Number(a.opening_value) \|\| 0` |

---

## Implementation notes

- Period B transactions are fetched inside the renderer from `state.transactions` (not from `options.txs`).
- `_computeDailyTotalAssets` sorts ALL `state.transactions` on each call. This is intentional — it ensures account balances at the start of Period B are correctly computed by replaying history from `opening_value`.
- Exchange rates are applied at the current `state.rateMap` values (not historical rates). This is acceptable for a personal finance app.
- Canvas is found via `container.querySelector('canvas')` — not `el()` — since the canvas is inside the coordinator-provided container, not directly in the document root.
