# Insight 26 — Loan Progress Detail

**File:** `sections/insights/26-loan-progress.js`
**Group:** Account & net worth
**Chart type:** Progress bars (HTML) + expandable area chart per loan
**Tabs:** None (accounts view only — no tab strip)
**Period picker:** Not applicable — shows full loan life from opening to today

---

## What it shows

Per-loan paydown detail: original balance, amount repaid, remaining balance, % paid, projected payoff date, and expandable repayment history (cumulative area chart + transaction table). More granular than Insight 17 (which shows a multi-loan trend line).

---

## Account filtering

```js
const liabAccounts = accounts.filter(a =>
  a.is_active && liabilityTypes.has(a.type)
);
```

`liabilityTypes` = `new Set(state.accountSchema?.liability_types || [])`.

---

## Per-loan computation (`_loanStats`)

For each liability account:

| Field | Source |
|---|---|
| `currentBal` | `computeDailyTotalAssets([acc], state.transactions, todayLocal, todayLocal)[0]` — `Math.abs` |
| `originalBal` | `Math.abs(parseFloat(acc.opening_value))` |
| `totalRepaid` | `Math.max(0, originalBal − currentBal)` — capped at 0 for new drawdowns |
| `avgMonthly` | `totalRepaid / _monthsSince(openingDate)` |
| `monthsToPayoff` | `Math.ceil(currentBal / avgMonthly)` — `null` when `avgMonthly = 0` |
| `pctPaid` | `Math.min(100, (totalRepaid / originalBal) × 100)` — `null` when `originalBal = 0` |
| `paidOff` | `currentBal ≤ 0` |
| `balIncreased` | `currentBal > originalBal` — new drawdown detected |

`_monthsSince(dateStr)`: computes calendar months between `acc.opening_date` (or first repayment tx date) and today. Minimum 1.

---

## Repayment transactions

`_repaymentTxs(acc)` — filters `state.transactions` (all time, not period-filtered):
```js
t.transaction_type === 'money-transfer' && (
  t.target_account === acc.name ||
  t.to_account     === acc.name ||
  t.to_account_id  === acc.id
)
```

Sorted oldest-first. Used for the history chart and table.

---

## Loan cards

Each card is a `<details>` element:
- **Summary bar:** Account name + sub-type + currency + current balance
- **Progress bar:** 20px height, `border-radius: 10px`; fill = `pctPaid%` in `var(--teal)`; flanked by "Original" and "Remaining" labels
- **Projection lines:** avg monthly repayment + projected payoff date (`"October 2027 (~27 mo)"`)
- **Warnings:** amber "⚠ Balance increased" when `balIncreased`; green "Paid off ✓" badge when `paidOff`

### Expandable history (`<details>` toggle)

Clicking the summary expands a history panel containing:

1. **Area chart** (`_renderHistoryChart`): cumulative repaid over time
   - X: repayment dates (`transaction_date_utc` formatted as `"15 Jul '26"`)
   - Y: `min: 0`, `max: originalBal` (shows paydown progress against the ceiling)
   - `borderColor: '#34d399'`, `fill: true`, `tension: 0.3`
   - Canvas height: 200px

2. **Transaction table:** newest-first, up to 24 rows. Columns: Date | Amount

Charts are created lazily on first expand via a `toggle` event listener. Already-created charts are reused on subsequent re-opens. All charts stored in `_historyCharts: Map<accId, Chart>`.

---

## Summary stat cards (4)

| Card | Value |
|---|---|
| Total debt | Sum of `currentBal` across all loans |
| Total repaid | Sum of `totalRepaid` across all loans |
| Monthly burden | Sum of `avgMonthly` across all loans |
| Earliest payoff | Account name + projected date (smallest `monthsToPayoff`) |

---

## Lifecycle

`render()` clears `_historyCharts` at the start (stale refs from prior render).

Returns `{ destroy() }` — destroys all charts in `_historyCharts` on navigation.

---

## Shared utilities used

| Utility | Source |
|---|---|
| `computeDailyTotalAssets` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| `opening_value` blank | `originalBal = 0`; progress bar omitted; "Original balance unknown" note |
| No repayment transactions | `totalRepaid = 0`, `avgMonthly = 0`; projection = N/A |
| Loan fully paid (`balance = 0`) | Full green progress bar; "Paid off ✓" badge |
| Balance increased (new drawdown) | `totalRepaid = 0` (capped); amber warning "Balance increased" |
| No active liability accounts | `chart-empty` "No active liability accounts found." |
| History chart not expanded | Canvas not created; chart created lazily on first `toggle` |
