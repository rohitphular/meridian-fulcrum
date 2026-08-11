# Insight 00 — Income, Expense & Savings

**File:** `sections/insights/00-earn-burn-rate.js`
**Group:** Cash flow
**Chart type:** Multi-line (3 lines) with fill
**Tabs:** None
**Default insight:** Yes (`state.insightId` defaults to `'00-earn-burn-rate'`)

---

## What it shows

Three trailing-average lines on a single chart:

| Line | Colour | Description |
|---|---|---|
| Income rate | Green (`#34d399`) | money-in trailing avg per day |
| Expense rate | Red (`#f87171`) | money-out trailing avg per day |
| Savings rate | Blue (`#60a5fa`) | (income − expense) trailing avg per day — fills to origin |

The savings rate fill shows financial health at a glance:
- **Blue fill above zero** — saving
- **Red fill below zero** — overspending

Window chips (7d / 14d / 30d / 90d) adjust the trailing average smoothing period.

---

## Data source

Uses **all** `state.transactions` (not the period-filtered slice), so the trailing window
can reach before the selected period's `from` date. All amounts are converted to the
quote currency via `toBase(amount, currency, fx_rate)`.

Only `money-in` and `money-out` transaction types are counted. `money-transfer` is excluded.

---

## Computation

`_computeRates(from, to, windowDays)`:

1. Builds `earnByDay` and `burnByDay` maps — keyed by `YYYY-MM-DD`, values summed in quote currency.
2. Iterates day-by-day from `from` to `min(to, today)` — future dates are excluded.
3. For each day, sums the trailing `windowDays` days from both maps.
4. Derives three rate arrays:
   - `incomeRates[i]  = earnSum / windowDays`
   - `expenseRates[i] = burnSum / windowDays`
   - `savingsRates[i] = (earnSum − burnSum) / windowDays`

---

## Window chips

Four chips rendered as `.dash-tab` buttons inside `#dashChart`:

| Chip | `_windowDays` |
|---|---|
| 7d | 7 |
| 14d | 14 |
| 30d | 30 (default) |
| 90d | 90 |

Clicking a chip sets `_windowDays` and re-calls `_render()`. The active chip gets `.active`.

---

## Stat cards (4)

Values are taken from the **last data point** (i.e. today's trailing average).

| Card | Value | Colour |
|---|---|---|
| Savings / day | `savingsRates[last]` — signed (+/−) | `.positive` if ≥ 0, `.negative` if < 0 |
| Income / day | `incomeRates[last]` | `.positive` |
| Expense / day | `expenseRates[last]` | `.negative` |
| Savings rate | `savings / income × 100` % — `"—"` if income = 0 | `.positive` / `.negative` |

---

## Chart

```js
datasets: [
  {
    label:       'Income rate',
    borderColor: '#34d399',
    fill:        false,
  },
  {
    label:       'Expense rate',
    borderColor: '#f87171',
    fill:        false,
  },
  {
    label:       'Savings rate',
    borderColor: '#60a5fa',
    fill: {
      target: 'origin',
      above:  'rgba(96,165,250,0.15)',   // blue — saving
      below:  'rgba(248,113,113,0.18)',  // red — overspending
    },
  },
]
```

All lines: `pointRadius: 0`, `pointHoverRadius: 4`, `tension: 0.3`.

Y-axis ticks: prefixed with quote currency symbol; values ≥ 1000 abbreviated to `k`.
Negative savings rate values shown with `−` prefix.

---

## Module-level state

```js
let _windowDays = 30;   // persists across period changes within the session
let _localChart = null; // destroyed and recreated on each _render() call
```

---

## Shared utilities used

| Utility | Source |
|---|---|
| `toBase` | `core/utils.js` |
| `el`, `esc` | `core/utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No transactions in window | All rates = 0; flat lines at zero |
| income = 0 | Savings rate stat card shows `"—"` |
| savings < 0 | Red fill below zero axis; stat card shows `.negative` with `−` prefix |
| Future dates | `end = min(to, today)` — future dates never plotted |
| Currency mix | All amounts converted via `toBase()` before accumulation |
