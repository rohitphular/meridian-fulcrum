# Insight 02 — Year-on-Year Monthly Comparison

**File:** `sections/insights/02-yoy-monthly.js`
**Group:** Spending comparisons
**Chart type:** Line — 2 series
**Tabs:** Transactions | Accounts

---

## What it shows

Daily cumulative spend (or total asset value) for a selected calendar month in the current year vs the exact same calendar month in the previous year. Answers: "Is this July running hotter or cooler than last July?"

---

## Period derivation

The coordinator passes `from`/`to` from the standard period picker. The sub-insight derives both comparison periods from `from`:

```js
const yearA  = from.getFullYear();
const monthA = from.getMonth();         // 0-indexed

// Period A — selected month, current year
const aFrom = new Date(yearA,     monthA, 1);
const aTo   = new Date(yearA,     monthA + 1, 0);  // last day

// Period B — same month, previous year
const bFrom = new Date(yearA - 1, monthA, 1);
const bTo   = new Date(yearA - 1, monthA + 1, 0);
```

The user controls which month to view via the coordinator's standard period picker (`this_month`, `last_month`, `custom`). The "previous year" comparison is always automatic (year − 1).

---

## Transactions tab

### Computation

1. Filter `state.transactions` (not `options.txs`) independently for both periods to `money-out`.
2. Build cumulative day-by-day arrays via `_buildCumulative` — same algorithm as Insight 01.
3. Period A: null-out days after today if `aFrom` is the current month.
4. Pad both arrays to `maxDays = max(daysA, daysB)`.

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Period A label | Total money-out | — |
| Period B label | Total money-out | — |
| YoY change | `delta` with ↓/↑ and % | `delta ≤ 0` → `.positive`; `delta > 0` → `.negative` |
| Month | Long month name (e.g. "July") | — |

### Chart

- **Series 1 (Period A):** `borderColor: C.teal`, `fill: false`, `tension: 0.3`, `pointRadius: 3`
- **Series 2 (Period B):** `borderColor: '#f59e0b'` (amber), `borderDash: [4,4]`, `fill: false`, `pointRadius: 2`
- Labels: `"Jul 2026"` | `"Jul 2025"`

---

## Accounts tab

### Computation

Same as Insight 01 accounts tab, using `_computeDailyTotalAssets` with Period A and Period B derived above.

Asset accounts: `accounts.filter(a => a.is_active && !liabilityTypes.has(a.type))`.

### Stat cards

| Card | Value | Colour rule |
|---|---|---|
| Assets Period A | Last non-null value in Period A | — |
| Assets Period B | Last non-null value in Period B | — |
| YoY change | `delta` with ↓/↑ and % | `delta ≥ 0` → `.positive`; `delta < 0` → `.negative` |
| Month | Long month name | — |

### Chart

- **Series 1 (Period A):** `C.teal`, `fill: true` with `C.teal + '18'` background
- **Series 2 (Period B):** amber `#f59e0b`, `borderDash: [4,4]`, `fill: false`
- Labels: `"Assets Jul 2026"` | `"Assets Jul 2025"`

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No money-out in either period | `.chart-empty` "No spend data for either period."; return `null` |
| No data for Period B only | Period B line is flat zero — still renders, no special handling |
| No active asset accounts | `.chart-empty` "No active asset accounts found."; return `null` |
| Period A = future month | Period A series is all null / empty; chart still renders Period B |

---

## Implementation notes

- Both periods fetch from `state.transactions` directly — `options.txs` (which is filtered to the selected period by the coordinator) is not used, because the sub-insight needs Period B independently.
- `_buildCumulative` and `_computeDailyTotalAssets` are duplicated from `01-mom-cumulative.js`. Extract to `insight-utils.js` when a third insight needs them.
- Amber `#f59e0b` is used for Period B (previous year) — consistent with Chart.js palette position 2 across all YoY/WoW insights.
- The period picker shows all 12 standard presets; the meaningful ones for this insight are `this_month`, `last_month`, `this_quarter` (picks quarter start month), and `custom`.
