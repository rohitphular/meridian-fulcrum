# insight-utils.js — Reference

**Location:** `sections/insights/insight-utils.js`

Shared computation helpers for all insight sub-modules. Import what you need:

```js
import {
  getPeriodBounds, filterTxByRange, groupByMonth, sumAmountBase,
  cumulativeByDay, findMissingRates, getCssColors, baseChartOptions,
} from './insight-utils.js';
```

---

## Period bounds

### `getPeriodBounds(period, customFrom, customTo)`

Converts a period preset to `Date` bounds.

```js
const { from, to, compareFrom, compareTo } = getPeriodBounds('this_month', '', '');
```

| Parameter | Type | Notes |
|---|---|---|
| `period` | string | One of the 12 period preset values |
| `customFrom` | string | `'YYYY-MM-DD'`, used when `period === 'custom'` |
| `customTo` | string | `'YYYY-MM-DD'` |

Returns `{ from: Date, to: Date, compareFrom: Date, compareTo: Date }`. `compareFrom`/`compareTo` is the equal-length window immediately before `from` — useful for period-on-period deltas.

---

## Filtering

### `filterTxByRange(txs, from, to)`

Filters `state.transactions` to the given date range (inclusive). Compares local calendar date, not UTC timestamp.

```js
const txs = filterTxByRange(state.transactions, from, to);
```

---

## Grouping

All group functions return `Map<key, tx[]>` sorted by insertion order (chronological if txs are sorted).

### `groupByDay(txs)` → `Map<'YYYY-MM-DD', tx[]>`
### `groupByWeek(txs)` → `Map<'YYYY-WNN', tx[]>` (ISO week)
### `groupByMonth(txs)` → `Map<'YYYY-MM', tx[]>`
### `groupByQuarter(txs)` → `Map<'YYYY-QN', tx[]>`

### `monthRange(from, to)` → `string[]`

Returns an ordered array of `'YYYY-MM'` keys spanning the full month range from `from` to `to` (inclusive). Useful for building chart labels with no gaps.

```js
const months = monthRange(from, to);
// → ['2026-01', '2026-02', '2026-03', ...]
```

---

## Monetary aggregation

All functions use the state-aware `toBase()` from `core/utils.js` — reads `state.rateMap` and `state.quoteCurrency` automatically.

### `sumAmountBase(txs)` → `number`

Sum of all transaction amounts converted to quote currency. Transactions with no rate are excluded (not counted as zero).

```js
const totalSpend = sumAmountBase(expenses);
```

### `cumulativeByDay(txs, from, to)` → `{ labels: string[], values: number[] }`

Day-by-day running total from `from` to `to`. Labels are day-of-month strings (`'1'`, `'2'`, …). Gaps (days with no transactions) produce intermediate values (carry-forward).

```js
const { labels, values } = cumulativeByDay(expenses, from, to);
```

### `accountBalanceByMonth(accounts, txs, months)` → `Map<'YYYY-MM', { [accountId]: number }>`

Replays all transactions chronologically to compute end-of-month balance per account. Starts from `account.opening_value`. Returns a map from month key to object of `{ accountId: balance }`.

```js
const months = monthRange(from, to);
const balances = accountBalanceByMonth(state.accounts, state.transactions, months);
const totals = months.map(m => Object.values(balances.get(m) || {}).reduce((s, v) => s + v, 0));
```

---

## Daily asset balance replay

### `computeDailyTotalAssets(assetAccounts, allTxs, from, to)` → `number[]`

Replays ALL transactions chronologically from each account's `opening_value`, returning one total-asset-value entry per calendar day in `[from, to]` (inclusive). Used by MoM (01), YoY (02), WoW (03), and Net Worth insights.

```js
const months   = monthRange(from, to);
const assetAccounts = accounts.filter(a => a.is_active && !liabilityTypes.has(a.type));
const dailyA   = computeDailyTotalAssets(assetAccounts, state.transactions, aFrom, aTo);
// → [12450.00, 12450.00, 12380.50, ...]   one value per day
```

- Initialises each account from `opening_value` (via `toBase` to convert to quote currency).
- Applies `money-out` (subtracts from source), `money-in` (adds to target), `money-transfer` (both sides) — only for accounts in `assetAccounts`.
- Transactions before `from` are replayed first (on the first day iteration) to establish the correct opening balance for the period.
- Exchange rates applied at current `state.rateMap` values — historical rate accuracy is not guaranteed.

---

## Tags

### `splitTags(txs)` → `{ tag: string, tx: object }[]`

Expands transactions with multiple tags (semicolon-separated) into one entry per tag. Useful for tag frequency charts.

```js
const tagPairs = splitTags(txs);
const freq = {};
tagPairs.forEach(({ tag }) => freq[tag] = (freq[tag] || 0) + 1);
```

---

## Missing rates

### `findMissingRates(txs, accounts)` → `string[]`

Returns currencies that appear in transactions or accounts but have no entry in `state.rateMap`. Used to render the `.insight-warn` banner.

```js
const missing = findMissingRates(txs, state.accounts);
// → ['AED', 'SGD']
```

---

## Labels

### `parsePeriodLabel(period)` → `string`

Human-readable period label:

```js
parsePeriodLabel('this_month') // → 'August 2026'
parsePeriodLabel('ytd')        // → '2026 to date'
parsePeriodLabel('last_year')  // → '2025'
```

### `fmtMonthKey(key)` → `string`

Formats a `'YYYY-MM'` key as `'Aug 26'`.

```js
fmtMonthKey('2026-08') // → 'Aug 26'
```

---

## CSS colors

### `getCssColors()` → `C` object

Reads all design token values from `getComputedStyle` at call time — picks up the active light/dark theme. Call at the top of each `render()` function.

```js
const C = getCssColors();
// → { teal, ember, muted, ink, hair, panel, mono, grotesk }
```

### `buildPalette(C)` → `string[]`

8-colour array for multi-series charts:

```js
const palette = buildPalette(C);
// → [C.teal, amber, C.ember, purple, blue, green, orange, C.muted]
```

---

## Chart.js base options

### `baseChartOptions(sym, C)` → `object`

Shared Chart.js `options` object with:
- `responsive: true`, `maintainAspectRatio: false`
- `interaction: { mode: 'index', intersect: false }` — touch-friendly tooltips
- Legend: bottom, ink-colored labels, 13px font
- Tooltip: panel background, ink border, formatted currency callback
- X/Y axis ticks: muted, 12px, `maxRotation: 0`, abbreviated k/M suffixes

```js
const C = getCssColors();
const chart = new Chart(ctx, {
  type: 'bar',
  data: { ... },
  options: {
    ...baseChartOptions(sym, C),
    // add overrides here
  },
});
```

Merge overrides on top rather than duplicating. For horizontal bar charts add `indexAxis: 'y'` in the merge.

---

## Usage pattern in a sub-insight

```js
/* global Chart */
import { el, esc, getSymbol, fmtBase } from '../../core/utils.js';
import { state } from '../../core/state.js';
import {
  groupByMonth, monthRange, sumAmountBase,
  getCssColors, buildPalette, baseChartOptions, fmtMonthKey,
} from './insight-utils.js';

export async function render(containerId, { txs, accounts, from, to, sym }) {
  const C       = getCssColors();          // read tokens after DOM exists
  const palette = buildPalette(C);
  const months  = monthRange(from, to);
  const byMonth = groupByMonth(txs.filter(t => t.transaction_type === 'money-out'));

  const values = months.map(m => sumAmountBase(byMonth.get(m) || []));
  const labels = months.map(fmtMonthKey);

  const container = el(containerId);
  container.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card">
        <div class="stat-card-label">Total spend</div>
        <div class="stat-card-value negative">${esc(sym + Math.round(values.reduce((a, b) => a + b, 0)).toLocaleString('en-GB'))}</div>
      </div>
    </div>
    <div class="chart-wrap">
      <div class="chart-container"><canvas id="${esc(containerId)}-canvas"></canvas></div>
    </div>`;

  const ctx = el(`${containerId}-canvas`) || container.querySelector('canvas');
  if (!ctx) return null;

  return new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Spend', data: values, backgroundColor: C.ember, borderRadius: 4 }] },
    options: baseChartOptions(sym, C),
  });
}
```
