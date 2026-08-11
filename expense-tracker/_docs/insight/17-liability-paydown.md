# Insight 17 — Liability Paydown Progress

**File:** `sections/insights/17-liability-paydown.js`
**Group:** Net worth
**Chart type:** Line — one series per liability account
**Tabs:** None (accounts view only — no tab strip)

---

## What it shows

Month-end balance remaining for each active liability account (loans, credit cards, overdrafts). Each account is one line, displayed as a positive "amount owed." Below the chart, HTML progress bars show how far along each account is in its paydown journey, plus a projected payoff date.

---

## Account filtering

```js
const liabAccounts = accounts.filter(a =>
  a.is_active && liabilityTypes.has(a.type)
);
```

`liabilityTypes` = `new Set(state.accountSchema?.liability_types || [])`.

---

## Computation

`_buildMonthlyBalances(liabAccounts, monthKeys)`:
1. Derives `from` (first day of first month) and `to` (last day of last month) from `monthKeys`.
2. For each liability account: `computeDailyTotalAssets([acc], state.transactions, from, to)`.
3. Samples the last day of each month from the daily array.
4. Returns `Math.abs(raw)` — liabilities are stored negative; displayed as positive owed amount.
5. Missing months produce `0` (no gap in the chart line).

---

## Projected payoff

`_projectPayoff(balances)`:
1. Looks at the last 3 months of balance data.
2. Computes month-over-month reductions (positive = debt shrinking).
3. `avgMonthlyRepayment = totalReduction / countOfPayingMonths`.
4. `projectedMonths = Math.ceil(currentBalance / avgMonthlyRepayment)`.
5. Returns `null` if insufficient data or if balance is rising consistently.
6. Returns `{ months: 0 }` if already paid off (`currentBalance <= 0`).

The projected payoff date is rendered as `_payoffDateStr(n)` — adds `n` months to today, formats as `"Aug 2027"`.

---

## Chart

```js
{
  type: 'line',
  data: {
    labels: monthKeys.map(fmtMonthKey),
    datasets: liabAccounts.map((acc, i) => ({
      label:           acc.name (truncated to 15 chars + '…' if longer),
      data:            allBalances[acc.id],
      borderColor:     palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + '22',
      tension:         0.3,
      pointRadius:     4,
      hidden:          i >= 6,      // first 6 visible; rest togglable via legend
    }))
  }
}
```

Y-axis: `min: 0` — prevents negative display artifacts.
X-axis: `maxTicksLimit: 6`, `maxRotation: 0` — mobile-friendly.
Legend: `position: 'bottom'`, legend labels truncated to avoid horizontal overflow.
Canvas height: `260px` (fixed).

---

## Progress bars (below chart)

For each liability account:

```
Account name                   42% paid
████████████░░░░░░░░░░░░░░░░░
£4,800 remaining · ~14 months to clear (Oct 2027)
```

| Field | Computation |
|---|---|
| Fill % | `(1 - currentBalance / Math.abs(opening_value)) * 100`, clamped `[0, 100]` |
| `% paid` label | `Math.round(paid) + '%'`; `"% paid: N/A"` if `opening_value` blank or 0 |
| Meta line | `"£X remaining · ~N months to clear (Mon YYYY)"` or `"Fully paid off"` if `currentBalance <= 0` |

Progress bar implemented as inline CSS (`height:8px`, `border-radius:4px`, `background:var(--hair)`; fill div uses `background:var(--ember)` with CSS `transition: width 0.4s ease`).

---

## Stat cards (4)

| Card | Value | Colour |
|---|---|---|
| Outstanding | Sum of all current liability balances (absolute) | `.negative` |
| Started with | Sum of `Math.abs(opening_value)` across all accounts; `—` if all blank | neutral |
| Overall paid | `(1 - totalCurrent / totalOpening) * 100`; `"N/A"` if no opening data | `.positive` |
| Accounts | Count of active liability accounts | neutral |

---

## Shared utilities used

| Utility | Source |
|---|---|
| `monthRange` | `insight-utils.js` |
| `computeDailyTotalAssets` | `insight-utils.js` |
| `fmtMonthKey` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions`, `buildPalette` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| No active liability accounts | `chart-empty` "No active liability accounts found."; returns `null` |
| Account with rising balance | Line goes up — shown as-is; reflects new credit or charges |
| `opening_value` blank or 0 | Progress bar fill = 0%; pct label = `"% paid: N/A"` |
| Fully paid account (balance = 0) | Line flatlines at 0; progress bar 100%; meta = `"Fully paid off"` |
| Balance falling but non-monotonically | `_projectPayoff` uses only positive reductions — credit card fluctuations don't distort projection |
| More than 6 liability accounts | First 6 lines visible by default; extras togglable via Chart.js legend click |
| Single month selected | `monthKeys` has 1 entry; chart shows a single point per account |
