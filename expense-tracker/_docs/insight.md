# Insight

The default landing view. Summarises income, expenses, net flow, and savings rate for the active date range; visualises monthly trend, top categories, and per-account spend.

## Inputs

- The filtered set of transactions for the active date range (see [Date range filter](#date-range-filter)).
- The accounts list (for name lookup on the per-account chart).
- The rates table (for converting all amounts to the base currency).

Malformed rows (missing `id`, `transaction_date_utc`, or invalid `transaction_type`) are excluded from every calculation.

## Summary cards

Four cards rendered at the top, always in the base currency. All sums apply `toBase(amount, currency, fx_rate)` per transaction.

| Card | Calculation |
|---|---|
| **Income** | Sum of base-currency amounts for transactions where `transaction_type = money-in` |
| **Expenses** | Sum of base-currency amounts for transactions where `transaction_type = money-out` |
| **Net** | `Income − Expenses` |
| **Savings rate** | `(Net / Income) × 100`, expressed as `N.N%`. Zero income → 0% |

Money-transfers are excluded from these four cards — transfers move funds between owned accounts and do not represent earnings or spending. If transfers exist in the range, a single counter row shows `Transfers: N rows · Volume: <base>`.

Net and Savings rate are coloured green for positive, red for negative.

## Charts

### Monthly income vs expenses

- Bar chart, two series per month: income (teal), expenses (ember).
- X-axis: months between `range.from` and today, inclusive. Months earlier than the first transaction in range are still shown (gaps render as zero bars).
- Capped at the most recent 24 months — if the range spans more, older months are dropped.
- Each bar's value is the sum of base-currency `amount` for that month, filtered by transaction type.

### Spend by category (drillable)

- Horizontal bar chart of `money-out` totals by `major_category` for the date range.
- Top 8 majors shown individually; the rest summed into a single `Other` bar.
- Bars sorted descending by value.
- Clicking a bar drills into that major — the chart re-renders showing minors within that major (sorted descending, no cap). A `← All categories` button returns to the major view.
- Empty state: if there are no expenses in the range, render `No expense data for this period.`

### Spend by account

- Horizontal bar chart of `money-out` totals by `source_account` name for the date range.
- All accounts with non-zero spend are shown, sorted descending. No cap, no `Other` bucket.
- Empty state: if there is no spend, render `No spend data for this period.`

## Date range filter

The date range applies to every insight calculation and to the transactions list. It sits in a sticky bar between the header and the section content. Options:

| Option | Range |
|---|---|
| `this_month` | First of this month → today (default) |
| `last_month` | First of last month → last day of last month |
| `last_3` | Start of (today − 2 months) → today |
| `last_6` | Start of (today − 5 months) → today |
| `last_12` | Start of (today − 11 months) → today |
| `ytd` | 1 January of this year → today |
| `all` | Year 2000 → today (effectively "all time") |
| `custom` | Two date inputs: `from` and `to`. Either blank falls back to `all` on that side. |

The filter is **inclusive on both ends** and operates on the local-time date portion of `transaction_date_utc`. Rows with no date are *included* (treated as no constraint) rather than dropped — they are still flagged as malformed elsewhere.

## Rendering rules

- The insight section is re-rendered on every navigation to the section and on every data mutation (transaction create/edit/delete).
- Any existing chart instances must be destroyed before re-rendering to avoid leaks on long sessions.
- Theme switch (light ↔ dark) triggers a chart palette swap; tick, grid, and tooltip colours read from the theme tokens.

## Out of scope (not on the insight section)

- Account balance summary — that lives on the Accounts section (see [accounts.md](accounts.md))
- Net worth — also on Accounts
- Budget tracking, projections, recurring forecasts
