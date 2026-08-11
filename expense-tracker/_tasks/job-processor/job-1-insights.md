# Job 1 — Insights Generator

## Objective

Pre-compute all insight data server-side (Python job) and store results in
Google Sheets. The frontend requests pre-computed insights by
`(insight_id, period_key, derived_from, chart_variant)` and renders directly —
no in-browser computation.

---

## Storage schema

### Sheet: `computed_insights`

One row per unique `(computed_at_date, insight_id, period_key, derived_from, chart_variant)`
combination. The sheet accumulates one day's worth of rows per run. If the job runs
multiple times on the same day, rows for that date are replaced — not duplicated.

| Column | Type | Description |
|---|---|---|
| `computed_at` | ISO datetime string | Timestamp of this run — e.g. `2026-08-06T14:30:00Z` |
| `insight_id` | string | Insight slug — e.g. `00-earn-burn-rate` |
| `period_key` | string | Period preset — e.g. `last_3`, `ytd`, `default` |
| `derived_from` | string | `transactions` or `accounts` for tabbed insights; `default` for all others |
| `chart_variant` | string | Sub-parameter where applicable (e.g. `30d` for window size); empty string otherwise |
| `insight_payload` | JSON string | Full payload — stat cards + chart data (see envelope below) |
| `expert_commentary` | string | LLM-generated analysis of this insight's data — empty until LLM job is built |

**Primary key (lookup):** `(insight_id, period_key, derived_from, chart_variant)` — GAS returns the row with the most recent `computed_at`

### Replacement strategy

On each run the job:
1. Reads all existing rows from `computed_insights`
2. Drops rows where `computed_at[:10]` (the date portion) = today's date
3. Appends the newly computed rows for today

This preserves historical daily snapshots (one set per day) while ensuring
multiple runs on the same day produce exactly one set of records for that day.

### Retention policy

The job retains **30 days** of snapshots. At the start of each run, rows where
`computed_at[:10]` is older than 30 days are deleted before new rows are appended.

This keeps the sheet at a stable ~3,900 rows regardless of how long the job runs.

**Future:** Historical data beyond 30 days will be replayed and stored in Postgres
using a start-date / end-date window, enabling long-term trend analysis without
impacting Sheets performance.

---

## Payload JSON envelope

Every `insight_payload` cell is a JSON string conforming to this shape:

```json
{
  "stat_cards": [
    {
      "label": "Savings / day",
      "value": "+£12.40",
      "sub":   "30d trailing avg",
      "class": "positive"
    }
  ],
  "chart": {
    "labels":   ["1 May", "2 May", "..."],
    "datasets": [
      {
        "label":       "Income rate",
        "data":        [10.2, 11.4],
        "borderColor": "#34d399"
      }
    ]
  },
  "meta": {
    "from":        "2026-05-01",
    "to":          "2026-08-06",
    "currency":    "GBP",
    "window_days": 30
  }
}
```

| Field | Notes |
|---|---|
| `stat_cards` | Array of 2–4 cards. `class` is `"positive"`, `"negative"`, or `""` |
| `chart` | Chart.js-compatible `{ labels, datasets }`. `null` for HTML-only insights |
| `meta` | Always includes `from`, `to`, `currency`. Insight-specific extras (e.g. `window_days`) added as needed |

---

## Code structure

```
forge/expense-tracker/job/
  runner.py
  config.py
  sheets_client.py
  requirements.txt
  jobs/
    __init__.py
    base.py                         ← BaseJob
    kpi_summary.py
    insights/
      __init__.py                   ← ALL_INSIGHTS registry
      job.py                        ← InsightsJob(BaseJob) — orchestrates all insights
      base_insight.py               ← BaseInsight abstract class
      insight_schema.py             ← field name constants, enum values (TxField, AccountField, etc.)
      period_utils.py               ← period_key → (from_date, to_date) resolution
      data_utils.py                 ← shared compute helpers (group_by_month, sum_amount_base, etc.)
      insights/
        __init__.py                 ← registry of all insight classes
        d00_earn_burn_rate.py
        d01_mom_cumulative.py
        d02_yoy_monthly.py
        d03_wow_daily.py
        d04_qtd_comparison.py
        d05_ytd_comparison.py
        d06_last_12_months.py
        d07_last_8_weeks.py
        d08_category_pie.py
        d09_category_trend.py
        d10_top_categories.py
        d11_category_drilldown.py
        d12_tag_pie.py
        d13_tag_trend.py
        d14_networth_trend.py
        d15_account_balances.py
        d16_asset_vs_liability.py
        d17_liability_paydown.py
        d19_cashflow_waterfall.py
        d20_savings_rate.py
        d21_income_sources.py
        d22_top_counterparties.py
        d23_recurring_payments.py
        d24_spend_by_country.py
        d25_spend_by_city.py
        d26_loan_progress.py
        d27_debt_to_income.py
        d28_forex_spend.py
```

---

## Key files

### `base_insight.py` — interface every insight implements

```python
class BaseInsight(ABC):
    insight_id: str        # e.g. '00-earn-burn-rate'
    periods: list[str]       # period_keys to compute; None → ['default']
    derived_from: list[str]  # ['transactions', 'accounts'] or ['default']
    chart_variants: list[str]# e.g. ['7d','14d','30d','90d'] or ['']

    @abstractmethod
    def compute(self, raw: dict, from_date: date, to_date: date,
                derived_from: str, variant: str) -> dict:
        # returns { stat_cards, chart, meta }
        raise NotImplementedError
```

### `insight_schema.py` — field name constants

```python
TX_TYPE_MONEY_IN       = 'money-in'
TX_TYPE_MONEY_OUT      = 'money-out'
TX_TYPE_MONEY_TRANSFER = 'money-transfer'

class TxField:
    ID               = 'id'
    DATE_TIME        = 'tx_date_time'
    TYPE             = 'tx_type'
    AMOUNT           = 'amount'
    CURRENCY         = 'currency'
    FX_RATE          = 'fx_rate'
    MAJOR_CATEGORY   = 'major_category'
    MINOR_CATEGORY   = 'minor_category'
    COUNTERPARTY     = 'counterparty_name'
    SOURCE_ACCOUNT   = 'source_account'
    TARGET_ACCOUNT   = 'target_account'
    LOCATION_COUNTRY = 'tx_location_country'
    LOCATION_CITY    = 'tx_location_city'
    TAGS             = 'tags'

class AccountField:
    ID            = 'id'
    NAME          = 'name'
    TYPE          = 'type'
    SUB_TYPE      = 'sub_type'        # used by D06 to group by sub-type
    CURRENCY      = 'currency'
    OPENING_VALUE = 'opening_value'   # field name in Sheets; JS uses a.opening_value
    IS_ACTIVE     = 'is_active'
```

No insight file ever hardcodes `'tx_type'` or `'money-out'` — all field names and
enum values come from `insight_schema.py`. If a sheet column is renamed, one file to update.

### `period_utils.py` — period resolution

Python equivalent of `getPeriodBounds()` from `insight-utils.js`.
Maps each `period_key` to a `(from_date, to_date)` tuple at run time.

### `data_utils.py` — shared compute helpers

Python equivalent of `insight-utils.js`. Shared by all insight files:

| Function | Description |
|---|---|
| `filter_by_range(txs, from_date, to_date)` | Filter transactions to period |
| `group_by_month(txs)` | `{ 'YYYY-MM': [tx, ...] }` |
| `group_by_day(txs)` | `{ 'YYYY-MM-DD': [tx, ...] }` |
| `group_by_week(txs)` | `{ 'YYYY-Www': [tx, ...] }` |
| `group_by_major(txs)` | `{ 'Food': [tx, ...] }` grouped by major_category |
| `sum_amount_base(txs, rate_map)` | Sum amounts converted to quote currency |
| `tx_amount_base(tx, rate_map)` | Single transaction converted to quote currency |
| `to_base(amount, currency, fx_rate)` | Convert single amount to quote currency |
| `month_range(from_date, to_date)` | List of `YYYY-MM` keys between two dates |
| `fmt_month_key(yyyy_mm)` | `'2026-05'` → `'May'` |
| `tx_date(tx)` | Parse `tx_date_time` to `date`; returns `None` if missing |
| `is_active_account(account)` | Handles `'TRUE'/'FALSE'` strings from Sheets |
| `compute_daily_total_assets(accts, txs, from, to)` | Daily net total (mirrors JS `computeDailyTotalAssets`) |
| `build_cumulative(txs, start, n, cutoff, ...)` | Running daily cumulative; nulls beyond cutoff |
| `build_monthly_cumulative(txs, year, n, partial_to, ...)` | Running monthly cumulative |
| `sample_month_end_assets(accts, txs, ...)` | Month-end asset snapshot array |
| `split_tags(tx)` | Normalised (lower, strip) tags list from semicolon field |
| `aggregate_tags(txs, ...)` | Proportional spend per tag (`amount / tag_count`) |
| `last_non_null(arr)` | Last non-None value in array, or `0.0` |
| `TEAL`, `AMBER`, `PALETTE` | Chart colour constants matching JS design tokens |

### `job.py` — orchestrator

```python
class InsightsJob(BaseJob):
    name        = 'insights'
    description = 'Pre-compute all insights and write to computed_insights sheet'

    def run(self):
        # 1. Read all raw data once
        raw = {
            'transactions': self.sheets.read_sheet('transactions'),
            'accounts':     self.sheets.read_sheet('accounts'),
            'categories':   self.sheets.read_sheet('categories'),
            'rates':        self.sheets.read_sheet('rates'),
        }

        # 2. Build rate map { 'GBP': 1.0, 'INR': 105.2, ... }
        rate_map = { r['currency']: float(r['rate']) for r in raw['rates'] }

        # 3. Compute all insights
        rows = []
        for InsightClass in ALL_INSIGHTS:
            insight = InsightClass(rate_map)
            for period_key, from_date, to_date in _resolve_periods(insight.periods):
                for derived in insight.derived_from:
                    for variant in insight.chart_variants:
                        payload  = insight.compute(raw, from_date, to_date, derived, variant)
                        rows.append([now_iso, insight.insight_id, period_key,
                                     derived, variant, json.dumps(payload), ''])

        # 4. Apply retention + replace today's rows
        self.sheets.replace_today_and_trim('computed_insights', HEADERS, rows, retain_days=30)
```

### `sheets_client.py` — new method

Current `write_sheet` does a full clear-and-rewrite. A new method handles retention
and replace-today logic:

```python
def replace_today_and_trim(self, name, headers, new_rows, retain_days=30):
    # 1. Read existing rows
    # 2. Drop rows where computed_at[:10] == today
    # 3. Drop rows where computed_at[:10] < today - retain_days
    # 4. Append new_rows
    # 5. Write headers + surviving rows + new_rows back
```

---

## Coverage — rows computed per run (122 total, verified 2026-08-06)

`custom` period is never pre-computed (user-defined at runtime).
Fixed-period insights use `period_key = 'default'`.

| Insight | Periods | Derived from | Variants | Rows |
|---|---|---|---|---|
| 00 — Income, Expense & Savings | last_3, last_6, last_12, ytd, last_year | default | 7d, 14d, 30d, 90d | 20 |
| 01 — MoM cumulative | this_month, last_month | transactions, accounts | — | 4 |
| 02 — YoY monthly | this_month, last_month | transactions, accounts | — | 4 |
| 03 — WoW daily | this_week, last_week, last_7 | transactions, accounts | — | 6 |
| 04 — QTD comparison | this_quarter, last_quarter | transactions, accounts | — | 4 |
| 05 — YTD comparison | ytd, last_year | transactions, accounts | — | 4 |
| 06 — Last 12 months | default | transactions, accounts | — | 2 |
| 07 — Last 8 weeks | default | default | — | 1 |
| 08 — Category pie | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 09 — Category trend | last_6, last_12, ytd, last_year | default | — | 4 |
| 10 — Top categories MoM | this_month, last_month | default | — | 2 |
| 11 — Category drilldown | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 12 — Tag pie | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 13 — Tag trend | last_6, last_12, ytd, last_year | default | — | 4 |
| 14 — Net worth trend | last_6, last_12, ytd, last_year | default | — | 4 |
| 15 — Account balances | default | default | — | 1 |
| 16 — Asset vs liability | last_6, last_12, ytd, last_year | default | — | 4 |
| 17 — Liability paydown | last_6, last_12, ytd, last_year | default | — | 4 |
| 19 — Cashflow waterfall | this_month, last_month | default | — | 2 |
| 20 — Savings rate | last_6, last_12, ytd, last_year | default | — | 4 |
| 21 — Income sources | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 22 — Top counterparties | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 23 — Recurring payments | last_6, last_12, ytd | default | — | 3 |
| 24 — Spend by country | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 25 — Spend by city | last_3, last_6, last_12, ytd, last_year | default | — | 5 |
| 26 — Loan progress | default | default | — | 1 |
| 27 — Debt-to-income | last_6, last_12, ytd, last_year | default | — | 4 |
| 28 — Forex spend | last_3, last_6, last_12, ytd, last_year | default | — | 5 |

---

## Period resolution at compute time

| Period key | Resolves to |
|---|---|
| `this_week` | Mon of current week → today |
| `last_week` | Mon → Sun of previous week |
| `last_7` | today−6 → today |
| `this_month` | 1st of current month → today |
| `last_month` | 1st → last day of previous month |
| `last_3` | 3 months ago (1st) → today |
| `last_6` | 6 months ago (1st) → today |
| `last_12` | 12 months ago (1st) → today |
| `this_quarter` | 1st of current quarter → today |
| `last_quarter` | Full previous quarter |
| `ytd` | 1 Jan of current year → today |
| `last_year` | 1 Jan → 31 Dec of previous year |
| `default` | Entire available data range |

Resolved `from` and `to` dates are stored in `meta` on every row.

---

## GAS integration

New action added to `app-router.gs`:

```
GET /exec?action=getComputedInsights
         &insight_id=00-earn-burn-rate
         &period_key=last_3
         &derived_from=default
         &chart_variant=30d
         &pin=...

→ { ok: true, computed_at: '2026-08-06T14:30:00Z',
              data: { stat_cards: [...], chart: {...}, meta: {...} } }
→ { ok: false, error: 'not_computed' }   ← row not found
```

GAS reads `computed_insights`, finds the latest row matching
`(insight_id, period_key, derived_from, chart_variant)`, parses `insight_payload`
JSON, and returns it. No computation in GAS — pure lookup.

---

## Frontend changes (future)

Each insight renderer gains an optional fast path:

1. Call `getComputedInsights` with current `(insight_id, period_key, derived_from, chart_variant)`
2. `ok: true` → render from returned data directly (skip local compute)
3. `ok: false / not_computed` → fall back to local compute (current behaviour)

Graceful degradation — insights work even if the job hasn't run yet.

---

## Drill-down interactions

Insights with click-to-drill interactions (08, 10, 11, 22, 24, 25) — pre-computing
every possible drill state is not practical.

**Decision:** Pre-compute top-level data only. Drill-down continues to run locally
from raw `state.transactions`. Acceptable because drill-downs are user-triggered,
not part of initial load.

---

## Open questions

1. For drill-down insights, is top-level-only pre-computation acceptable or do we want the N most common drill paths pre-computed too?
2. Run frequency — on demand only, or nightly cron?
3. Should the frontend show a "last computed at" timestamp in the insight UI?
