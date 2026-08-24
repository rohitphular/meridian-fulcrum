# currency-rates — Module Requirements

---

## What

The `currency-rates` module manages two PostgreSQL tables that underpin all multi-currency financial data in the Meridian system:

- **`currency_master`** — reference data for every tracked currency: code, name, symbol, decimal precision, minor unit name, and tracking metadata.
- **`currency_rates`** — daily exchange rates expressed as "how many major units of currency X equal 1 XAU (1 gram of gold)". One row per currency per day.

---

## Why

### Base currency is XAU (1 gram of gold)

All financial transactions in `ledger-extract` are stored in a base currency for unified analysis. The base currency is XAU, defined as **1 gram of gold** — not 1 troy ounce. This is a deliberate design choice. A rate_value of 76 for GBP means "76 GBP = 1 gram of gold."

### BIGINT minor units require decimal_places

Transaction amounts are stored as BIGINT integers in currency minor units (e.g. pence for GBP, nanograms for XAU). The minor unit factor for any currency is `10^decimal_places`, sourced from `currency_master`. Without this table, the pipeline cannot convert amounts.

### Daily rates drive base-amount computation

For every non-XAU transaction, `ledger-extract` looks up the rate for `(quote_currency_code, rate_date)` from `currency_rates` and computes `tx_amount_base = tx_amount_local / rate_value`. This allows all transactions to be compared in a single denomination regardless of original currency.

---

## How

### Schema

#### currency_master

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `currency_code` | CHAR(3) | Unique; ISO 4217 for fiat/commodity, ticker for crypto |
| `currency_name` | TEXT | Human-readable name |
| `currency_symbol` | TEXT | Display symbol (e.g. `£`, `$`) |
| `decimal_places` | SMALLINT | Minor unit factor = `10^decimal_places`; BETWEEN 0 AND 9 |
| `minor_unit_name` | TEXT NOT NULL | Name of the lowest denomination (e.g. `pence`, `satoshi`, `nanogram`) |
| `currency_type` | TEXT | One of: `fiat`, `commodity`, `crypto` |
| `is_tracked` | BOOLEAN | Whether the sync job fetches rates for this currency |
| `currency_rank` | INTEGER | Display ordering; NULL for XAU (base currency, always first) |
| `last_fetched_date` | DATE | Updated by the sync job after each successful fetch |
| `created_at` / `updated_at` | TIMESTAMPTZ | `updated_at` auto-maintained by trigger `fn_set_updated_at()` |

Key constraints:
- `chk_cm_decimal_places`: `decimal_places BETWEEN 0 AND 9`
- `chk_cm_xau_dp_pinned`: XAU is fixed at `decimal_places = 9` (1 nanogram = 10^-9 grams)
- `chk_cm_currency_type`: must be `fiat`, `commodity`, or `crypto`

#### currency_rates

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `rate_date` | DATE | The date this rate applies to |
| `base_currency_code` | CHAR(3) | Always `XAU`; enforced by CHECK constraint |
| `quote_currency_code` | CHAR(3) | The currency being priced against XAU |
| `rate_value` | NUMERIC(19,8) | How many major units of quote_currency = 1 XAU (1 gram of gold) |
| `rate_source` | TEXT | Origin of the rate (e.g. `yahoo_finance`, `stooq`) |
| `created_at` / `updated_at` | TIMESTAMPTZ | `updated_at` auto-maintained by trigger |

Key constraints:
- `uq_cr_quote_currency_date`: one rate per currency per day
- `chk_cr_rate_positive`: `rate_value > 0`
- `chk_cr_base_is_xau`: `base_currency_code = 'XAU'`

### Seeded currencies (18)

XAU (commodity), USD/EUR/GBP/INR/JPY/CNY/AUD/CAD/CHF/SGD/AED/HKD/BRL/KRW (fiat), BTC/ETH/SOL (crypto).

All 18 have `minor_unit_name` seeded. Any future addition must also include `minor_unit_name`.

### Migration sequence

| Migration | What it does |
|---|---|
| `0001_create_currency_master.py` | Create `currency_master` table, `fn_set_updated_at()` trigger, seed 18 currencies |
| `0002_create_currency_rates.py` | Create `currency_rates` table, trigger, indexes |
| `0003_update_xau_decimal_places.py` | Widen CHECK to BETWEEN 0 AND 9; add pinned constraint for XAU=9; UPDATE XAU decimal_places 2→9 |
| `0004_add_minor_unit_name.py` | ADD `minor_unit_name TEXT`; seed all 18 rows; SET NOT NULL |
| `0005_update_rate_value_precision.py` | Drop unused views `v_latest_rates` and `v_rates_to_gbp`; widen `currency_rates.rate_value` NUMERIC(19,6) → NUMERIC(19,8) |

Migrations run in numeric order. Each migration follows the pattern:
```python
def upgrade(client: Any) -> None:
    with client.cursor() as cursor:
        cursor.execute("...")
    client.commit()
```

### Sync job — two modes

**Daily mode** — fetches the past 365 days of rates from Yahoo Finance. Intended to run nightly after markets close. Upserts into `currency_rates` and updates `currency_master.last_fetched_date`.

**Historical mode** — loads fiat rates from locally downloaded CSV files (stooq format), then fetches today's crypto rates from Yahoo Finance. Run once to backfill before the daily job takes over.

Fiat rates are fetched for 14 currencies (all except XAU, BTC, ETH, SOL). Crypto rates are fetched from Yahoo Finance tickers. XAU has no rate row in `currency_rates` — it is the base; its rate_value would be 1 by definition and is never needed.

### Triggering the sync job

From `meridian-fulcrum/` root:
```bash
make data-sync   # interactive menu — select currency-rates → env → mode
```

Or directly from the module directory:
```bash
make run ENV=dev
make run ENV=prod
```

See `_runbooks/USAGE-INSTRUCTIONS.md` for prerequisites, environment variables, and troubleshooting.
