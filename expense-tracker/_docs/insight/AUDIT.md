# Insight Audit

**Scope:** All 28 insight JS files + coordinator (`insights.js`) + `insight-utils.js`
**Date:** 2026-08-03

---

## Summary

| Severity | Count |
|---|---|
| Bug — incorrect behaviour | 5 |
| Bug — string coercion risk | 3 |
| Improvement | 9 |
| Drilldown opportunity | 12 |

---

## Bugs

### B1 — Insight 23: Category column sorts by wrong key
**File:** `23-recurring-payments.js:265`

The "Category" table header passes `'frequency'` as the sort column key instead of `'category'`:
```js
${_thHtml('frequency', 'Category', 'left')}  // wrong — should be 'category'
```
Clicking the "Category" header sorts the table by frequency (weekly/monthly/quarterly), not alphabetically by category. Additionally, `_renderTable`'s `switch` has no `'category'` case, so sorting by category is silently a no-op even after fixing the header.

**Fix:** Change the header key to `'category'` and add a `case 'category': return sign * a.category.localeCompare(b.category);` to the sort switch.

---

### B2 — Insight 10: "Previous period" is always the calendar month prior
**File:** `10-top-categories.js:28–30`

`_prevMonth(from)` always computes the calendar month before `from` — regardless of which period the user selected. When the user selects "Last 7 days" or "Last 30 days", Period A is 7–30 days but the comparison Period B is still a full calendar month. The stat card labels (`labelA = fmtMonthKey(from)`) also show a month key for a rolling-day period, which formats incorrectly (it shows the month that contains the start date, not the rolling range).

**Fix:** Either (a) make Period B mirror Period A's duration by subtracting the same number of days, or (b) hide this insight's period-B comparison when a rolling-day filter is active.

---

### B3 — Insight 22 / 26 / 28: `amount_base` used raw without coercion
**Files:** `22-top-counterparties.js:85`, `26-loan-progress.js:71`, `28-forex-spend.js:36`

Several insights access `t.amount_base || 0` or `t.amount || 0` directly for arithmetic, bypassing `sumAmountBase` / `toBase()`. If `amount_base` is stored as a string (which can happen with CSV import), the `||` operator won't coerce it — you get `"123.45" || 0` → `"123.45"` (a string), and numeric operations silently produce `NaN` or string concatenation.

Specific locations:
- D22 `_showPanel`: `t.amount_base || 0` in the drill panel (displays as NaN)
- D22 `_prevSpend`: `t.amount_base || 0` in the comparison calculation  
- D26 `_renderHistoryChart`: `Math.abs(t.amount_base || 0)` for cumulative repaid amounts
- D28 `_groupByCurrency`: `Math.abs(t.amount || 0)` for native currency totals

**Fix:** Replace with `Number(t.amount_base) || 0` or use `sumAmountBase([t])` where `toBase()` already handles coercion.

---

### B4 — Insight 15: Liability classification fails silently when schema missing
**File:** `15-account-balances.js:86`

```js
const liabilityTypes = new Set(state.accountSchema?.liability_types || []);
```

If `accountSchema` hasn't loaded yet, `liability_types` is an empty array and **all liability accounts are classified as assets**. The net worth stat card will then show a wildly inflated asset total and zero liabilities, with no error or warning to the user.

**Fix:** Show an error/loading message if `state.accountSchema` is null/undefined rather than silently using an empty set.

---

### B5 — Insight 26: Loan canvas IDs break if account name contains special chars
**File:** `26-loan-progress.js:178`

```js
<canvas id="history-canvas-${esc(String(accId))}">
```

`accId = loan.acc.id || loan.acc.name`. If an account name contains spaces, slashes, or other characters that are invalid in HTML `id` attributes (ids must not contain spaces), `document.getElementById('history-canvas-My Account')` silently returns `null` and the history chart is never rendered. No error is surfaced to the user.

**Fix:** Sanitise the canvas ID: replace non-alphanumeric chars with `_`, or use a sequential numeric index instead of the account name.

---

## Improvements

### I1 — Insight 19: Waterfall "Closing" balance excludes transfers
**File:** `19-cashflow-waterfall.js:82`

The waterfall `closing = startBalance + income - expenses` includes only `money-in` and `money-out` transactions. Transfers between accounts (`money-transfer`) are excluded. This means the waterfall's closing balance will differ from the actual account balance shown in D14/D15/D16, which can confuse the user.

**Suggestion:** Add a "Transfers" bar to the waterfall for net transfer activity, or add a footnote explaining the exclusion.

---

### I2 — Insight 23: Recurring detection threshold is very strict (5%)
**File:** `23-recurring-payments.js:57`

```js
if (_stdDev(amounts) / amtMean > 0.05) continue;
```

A 5% coefficient of variation threshold means any subscription with even a small price change (e.g. Netflix raising monthly fee) is excluded from recurring detection. Most real-world recurring bills have occasional changes.

**Suggestion:** Relax to 15–20% and consider running a separate pass for "nearly-recurring" items shown in a separate table section.

---

### I3 — Insight 25: Domestic country is hardcoded to UK
**File:** `25-spend-by-city.js:14`

```js
const DOMESTIC_COUNTRY = 'United Kingdom';
```

Teal bars = domestic (UK), amber = international. This is hardcoded and wrong for users based outside the UK.

**Suggestion:** Read `state.userCountry` (or a configurable setting), or remove the domestic/foreign distinction and colour by region instead.

---

### I4 — Insight 24 / 25: `COUNTRY_NORM` duplicated
**Files:** `24-spend-by-country.js:9–14`, `25-spend-by-city.js:8–12`

The country normalisation map is copy-pasted between two files. Any fix (e.g. adding a new abbreviation) must be made in both places.

**Suggestion:** Move to `insight-utils.js` and export as `COUNTRY_NORM`.

---

### I5 — Insight 18: Mobile stacked mode visually confusing
**File:** `18-income-vs-expenses.js:116–117`

On mobile (`window.innerWidth < 640`), income and expense bars are stacked on the same bar. This makes the bar height = income + expenses, which is not meaningful. The Net line overlaid on a stacked bar is hard to read on a small screen.

**Suggestion:** On mobile, switch to a horizontal bar layout or show income and expenses in separate rows. Alternatively, keep grouped bars but reduce bar width and increase chart height.

---

### I6 — Insight 20: Income and expense bars hidden on mobile by default
**File:** `20-savings-rate.js:188–193`

Income and expense bars are `hidden: isMobile` on mobile, leaving only the savings rate line. This is a reasonable mobile optimisation but users have no affordance to know the hidden bars exist (no legend visible, no toggle button).

**Suggestion:** Show the chart legend even on mobile so users can toggle the income/expense bars via the legend if they want them.

---

### I7 — Coordinator: Failed module imports are permanently cached
**File:** `insights.js:238–241`

```js
} catch (_) {
  _renderers[insightId] = null;
  return null;
}
```

If an insight module fails to load (transient network error), `_renderers[insightId]` is set to `null` permanently. The next time the user selects the same insight in the same session, it returns `null` immediately without retrying. The user sees "not yet implemented" with no way to recover without a page refresh.

**Fix:** Don't cache `null` — only cache successful imports. On failure, set `_renderers[insightId]` to `undefined` (or delete the key) so the next selection retries the import.

---

### I8 — Insight 27: "Transactions" tab is actually income trend, not transactions
**File:** `27-debt-to-income.js:222–281`

The `transactions` tab renders an income bar chart with monthly totals — it has nothing to do with individual transactions. The tab label misleads the user.

**Suggestion:** Rename the tab to "Income trend" and update `state.insightTab` handling in the coordinator accordingly (or keep the same `tab: 'transactions'` key but change the visible label).

---

### I9 — Insight 15: `_currentBalance` called per-account in a loop (N replay passes)
**File:** `15-account-balances.js:96`

```js
const withBalance = active.map(a => ({ ...a, balance: _currentBalance(a) }));
```

`_currentBalance` calls `computeDailyTotalAssets([acc], ...)` for each account individually. For 10 accounts, this is 10 separate transaction-replay passes over `state.transactions`. For users with many accounts and many transactions this will be slow.

**Suggestion:** Batch all accounts into a single `computeDailyTotalAssets` call and derive per-account balances from that, or cache the per-account daily balance array.

---

## Drilldown Opportunities

Drilldowns are listed by priority (impact × implementation effort).

---

### D1 — Category drilldown level 3: transaction list (HIGH)
**Insight:** 11-category-drilldown

**Current:** Major category → minor category bar chart (2 levels)
**Add:** Minor category bar click → transaction list (level 3)

Show a table with: Date | Counterparty | Description | Amount — sorted by date desc. Add a "← Back to [Minor]" button. This closes the loop — the user can always drill from any chart down to actual transactions.

**Implementation sketch:**
```js
// In _renderLevel2, add onClick to the chart:
onClick: (_, elements) => {
  const minor = minors[elements[0].index].cat;
  _destroyChart();
  _renderLevel3(container, moneyOut, major, minor, sym);
}

function _renderLevel3(container, moneyOut, major, minor, sym) {
  const txs = moneyOut.filter(t =>
    (t.major_category || 'Uncategorised') === major &&
    (t.minor_category || 'Other') === minor
  ).sort((a, b) => new Date(b.transaction_date_utc) - new Date(a.transaction_date_utc));
  // render back button + scrollable table
}
```

---

### D2 — Tag pie: click segment → transaction list (HIGH)
**Insight:** 12-tag-pie

**Current:** Doughnut + ranked table below
**Add:** Click a doughnut segment → inline panel shows transactions with that tag

The table already exists below the chart but shows aggregated rows. The drilldown should show individual transactions when a segment is clicked.

**Implementation sketch:**
```js
options: {
  onClick: (_, elements) => {
    if (!elements.length) return;
    const tag = segments[elements[0].index].label;
    const tagTxs = moneyOut.filter(t =>
      (t.tags || '').split(';').map(s => s.toLowerCase().trim()).includes(tag)
    ).sort((a, b) => new Date(b.transaction_date_utc) - new Date(a.transaction_date_utc));
    // render panel below chart
  }
}
```

---

### D3 — Category pie (D08): click segment → transaction list (HIGH)
**Insight:** 08-category-pie

**Current:** Doughnut + ranked table
**Add:** Click segment → show transactions in that category

Same pattern as D2 — same implementation.

---

### D4 — Waterfall (D19): click expense bar → transaction list (MEDIUM)
**Insight:** 19-cashflow-waterfall

**Current:** Waterfall chart with opening/income/expense-categories/closing bars
**Add:** Click an expense category bar → slide-in panel shows transactions in that category

The `expGroups` array already holds `[[cat, amount], ...]` — map bar index to category and filter `outTxs`.

---

### D5 — Top counterparties (D22): already has drill panel — add monthly trend (MEDIUM)
**Insight:** 22-top-counterparties

**Current:** Drill panel shows transaction list + previous-period comparison
**Add:** A mini sparkline in the drill panel showing monthly spend with this merchant over the last 6 months

Using `state.transactions` filtered to the merchant, group by month, render a small bar chart. Gives a quick "is this merchant getting more expensive?" view.

---

### D6 — Income vs expenses (D18): click month → category breakdown (MEDIUM)
**Insight:** 18-income-vs-expenses

**Current:** Monthly grouped bar chart + net line
**Add:** Click a month bar → slide-in panel with income sources (counterparties) and expense categories for that month

**Implementation sketch:**
```js
onClick: (_, elements) => {
  if (!elements.length) return;
  const mk = monthKeys[elements[0].index];
  const monthTxs = txs.filter(t => t.transaction_date_utc.startsWith(mk));
  // render two mini-tables: income by counterparty, expenses by major category
}
```

---

### D7 — Spend by country (D24): click country → city breakdown (MEDIUM)
**Insight:** 24-spend-by-country

**Current:** Horizontal bar chart + table by country
**Add:** Click a country bar → re-render showing cities within that country

Use D25's `_groupByCity` logic but pre-filtered to the selected country. Back button returns to country view.

---

### D8 — Spend by city (D25): click city → transaction list (MEDIUM)
**Insight:** 25-spend-by-city

**Current:** Horizontal bar chart + table by city
**Add:** Click a bar → panel shows transactions in that city (date, merchant, amount, category)

---

### D9 — Net worth trend (D14): click month → account breakdown (LOW-MEDIUM)
**Insight:** 14-networth-trend

**Current:** Single net-worth line across months
**Add:** Click a data point → panel shows each active account's balance at that month-end

Gives visibility into which accounts are driving net worth changes month to month.

---

### D10 — Tag trend (D13): click data point → transactions for that tag in that month (LOW-MEDIUM)
**Insight:** 13-tag-trend

**Current:** Multi-series line chart; Chart.js legend toggles visibility
**Add:** Click a data point → panel shows transactions with that tag in that month (with split amounts)

---

### D11 — Recurring payments (D23): expand row → payment history chart (LOW)
**Insight:** 23-recurring-payments

**Current:** Table + horizontal bar chart
**Add:** Click a table row → inline history chart (similar to D26's expandable `<details>` pattern)

Show a dot plot or line chart of actual payment dates and amounts over the full history (from `state.transactions`). This lets the user see if the amount has been creeping up.

---

### D12 — Income sources (D21): click segment → transaction list (LOW)
**Insight:** 21-income-sources

**Current:** Donut sub-view (By Source / By Category / Trend)
**Add:** Click a donut segment → panel shows individual income transactions from that source or in that category

---

## Cross-cutting notes

**Mobile layout:** All insights use `chart-container` which constrains height. On phones, horizontal bar charts with many bars (D22, D23, D24, D25) render correctly because height is dynamic (`rows.length * 44`). The main mobile concern is the stat-cards grid (4 cards on 2 columns) — on very narrow screens (<340px) the 4-up grid wraps awkwardly. Consider a 2×2 grid forced layout for stat cards on mobile.

**Period filter + month-based charts:** Insights 09, 13, 14, 16, 17, 18, 20 use `monthRange(from, to)` which produces partial months when `last_7/30/60/90` is selected. The charts render correctly (partial months show partial data) but there's no visual indicator that the first/last month bars are partial. D18 already adds a `*` annotation for the current partial month — consider applying the same to all period-affected charts when a rolling-day filter is active.

**Hardcoded chart colors vs CSS vars:** Insights 18, 19, 21, 23 use hardcoded rgba strings for income (green) and expense (red) colours. These are intentional semantic colours (green = income, red = expense) rather than theme palette colours, so they don't need to read from CSS vars. They should remain readable on both light and dark themes — verify contrast on dark mode.

**`Math.max(...array)` spread:** Used in several stat-card computations (`Math.max(...monthTotals)` etc.). Safe for personal-scale data (<10,000 months), but worth noting.
