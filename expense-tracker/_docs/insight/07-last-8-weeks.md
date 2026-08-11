# Insight 07 — Last 8 Weeks

**File:** `sections/insights/07-last-8-weeks.js`
**Group:** Spending comparisons
**Chart type:** Grouped bar (income | expense)
**Tabs:** Transactions only

---

## What it shows

Weekly income vs expense bars for the rolling last 8 ISO weeks. Sits between the daily WoW chart (03) and the monthly 12-month chart (06) — useful for spotting week-level trends without the noise of daily granularity.

---

## Key differences from other insights

- **Transactions only** — no Accounts tab.
- **Fixed window** — ignores coordinator `from`/`to`. Window is always 8 ISO weeks ending with the current (partial) week.
- **No net line** — simpler than 06; just income and expense bars side by side.

---

## Window computation

```js
// Current week's Monday
const dow  = todayLocal.getDay();  // 0=Sun … 6=Sat
const diffToMon = dow === 0 ? 6 : dow - 1;
const monday = new Date(today - diffToMon * 86400000);

// 8 weeks: weeks8[0] = 7 weeks ago, weeks8[7] = this week
const weeks8 = Array.from({ length: 8 }, (_, i) =>
  new Date(monday - (7 - i) * 7 * 86400000)
);
```

The last bucket (index 7 = current week) is clamped to `todayLocal` — only transactions up to today are counted.

---

## Computation

`_buildWeekly(weeks8, todayLocal)`:
- For each week: `filterTxByRange(state.transactions, weekFrom, clampedTo)`.
- `clampedTo = todayLocal` for the current week; `weekFrom + 6 days` for past weeks.
- Sums `money-in` → income, `money-out` → expense via `sumAmountBase`.

### X-axis labels

```
['W27', 'W28', 'W29', 'W30', 'W31', 'W32', 'W33', 'W34 (now)']
```

ISO week number (zero-padded). Current week gets `(now)` suffix.

### ISO week number

Thursday-anchor approach (same as 03):
```js
const d = new Date(monday);
d.setDate(d.getDate() + 3);  // Thursday
const jan4 = new Date(d.getFullYear(), 0, 4);
const weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
```

---

## Stat cards (4)

| Card | Value |
|---|---|
| Income (8 wks) | Sum of all income — `.positive` |
| Expenses (8 wks) | Sum of all expenses — `.negative` |
| Net | `totalIncome - totalExpense` — `.positive` / `.negative` |
| Avg spend/wk | `totalExpense / 8` |

---

## Chart

- `type: 'bar'`
- Income: `rgba(52,211,153,0.8)`, `borderRadius: 3`
- Expenses: `rgba(248,113,113,0.8)`, `borderRadius: 3`
- `maxTicksLimit: 8` — all 8 week labels shown
- Legend: bottom

---

## Shared utilities used

| Utility | Source |
|---|---|
| `filterTxByRange` | `insight-utils.js` |
| `sumAmountBase` | `insight-utils.js` |
| `getCssColors`, `baseChartOptions` | `insight-utils.js` |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Fewer than 8 weeks of data | Early weeks return 0 income/expense; bars absent (zero height) |
| No income in a week | Income bar = 0 — still part of the dataset for tooltip correctness |
| Current week is Monday (first day) | Current bucket has 1 day of data; `(now)` label still applies |
| Mixed currencies, missing rates | `sumAmountBase` silently excludes txs with no rate |
