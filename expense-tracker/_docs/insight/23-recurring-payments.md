# Insight 23 — Recurring Payments

**File:** `sections/insights/23-recurring-payments.js`
**Group:** Spending analysis
**Chart type:** Sortable HTML table + horizontal bar chart
**Tabs:** None (transactions view only — no tab strip)

---

## What it shows

Automatically detected recurring payments (subscriptions, loan repayments, rent) — their counterparty, category, frequency, amount, and last payment date. Total recurring spend normalised to a monthly equivalent and shown as a % of income.

---

## Recurring detection algorithm

`_detectRecurring(outTxs)` — pure JS, no Chart.js:

1. **Group** `money-out` transactions by `counterparty.trim().toLowerCase()`.
2. **Skip groups with fewer than 2 transactions.**
3. **Amount consistency check:** compute mean and stdDev of `amount_base` per group. Skip if `stdDev / mean > 0.05` (more than 5% variance → not a fixed recurring charge).
4. **Gap analysis:** compute day-gaps between consecutive transactions (sorted by `transaction_date_utc`). Compute mean gap and stdDev of gaps.
5. **Frequency detection:**
   | Band | Mean gap (days) | Max gap stdDev |
   |---|---|---|
   | `weekly` | 5–9 | ≤ 2 |
   | `monthly` | 28–35 | ≤ 5 |
   | `quarterly` | 85–95 | ≤ 7 |
6. Skip if no frequency matches.
7. Push `{ counterparty, amount (mean), frequency, count, lastDate, category }`.
8. Sort by `amount` descending.

Helper functions:
- `_mean(arr)` — arithmetic mean
- `_stdDev(arr)` — population stdDev
- `_daysBetween(a, b)` — `Math.round(|b − a| / 86400000)`

---

## Display

### Stat cards (4)

| Card | Value | Notes |
|---|---|---|
| Recurring / month | `totalMonthly` | Monthly-normalised sum (see below) |
| % of income | `totalMonthly / monthlyIncome × 100` | Shown as `.negative` if > 50% |
| Count | Number of detected recurring items | — |
| Largest | Counterparty name (12-char truncated) + amount as sub | — |

**Monthly normalisation:**
```js
const MONTHLY_EQUIV = { weekly: 52/12, monthly: 1, quarterly: 1/3 };
totalMonthly = recurring.reduce((s, r) => s + r.amount * MONTHLY_EQUIV[r.frequency], 0);
```

**Monthly income:**
```js
monthlyIncome = sumAmountBase(money-in txs) / monthRange(from, to).length
```

### Table

5 columns: Payee | Category | Frequency | Amount | Last paid

- Horizontally scrollable on mobile (`overflow-x: auto`, `min-width: 460px` on `<table>`).
- **Sortable by any column** — click header toggles asc/desc; arrow indicator (↓/↑) shows active sort.
- Default sort: Amount descending.
- Frequency badges: pill-shaped, per-frequency colour (`teal` / amber `#f59e0b` / `ember`).

### Bar chart

Horizontal bar (`indexAxis: 'y'`) — one bar per recurring payee, sorted by amount.

- Bar color = palette color per `major_category` (same category → same color).
- Canvas height: `Math.max(200, N × 44)` px.
- Tooltip: `£amount / frequency` (e.g. `£15.99 / monthly`).
- No legend — table already provides the full breakdown.

---

## Module-level state

```js
let _chart     = null;
let _recurring = [];  // computed at render time, used by sort callbacks
let _sortCol   = 'amount';
let _sortDir   = 'desc';
let _sym, _C;
```

All reset at the top of `render()`.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions`, `buildPalette` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No recurring detected | `chart-empty` "No recurring payments detected in this period." |
| Group with < 2 txs | Skipped in detection |
| Variable amount (>5% stdDev) | Excluded — e.g. dynamic utility bills |
| No income in period | `% of income` shows `"—"` |
| Annual payments in short window | Not detected (gap ~365 days matches no frequency band); note in task doc |
| Blank counterparty | Grouped as `'unknown'` during detection; display label from `tx.counterparty` falls back to `'Unknown'` |
| `money-transfer` txs | Excluded before detection (only `money-out` passed) |
