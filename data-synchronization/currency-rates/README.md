# currency-rates

Fetches and stores daily exchange rates for fiat currencies and crypto assets, all expressed relative to gold (XAU per gram). Backs the expense-tracker's multi-currency valuation.

---

## What it does

Fetches daily exchange rates for 14 fiat currencies and 3 crypto assets from Yahoo Finance (yfinance) and stores them in PostgreSQL. All rates use gold (XAU per gram) as the base, so any two currencies can be compared by dividing their rates without storing every pair. The job runs in two modes: Daily fetches the rolling last 365 days via Yahoo Finance for both fiat and crypto; Historical loads fiat rates from locally downloaded CSV files for a one-time backfill. After every fiat upsert, a forward-fill pass fills weekend and holiday gaps by carrying the last real closing rate forward.

---

## What it stores

Every rate in the database answers: **"how many units of this currency equal 1 gram of gold?"**

- Base currency is always **XAU (gold, per gram)**
- A rate of `USD = 85.3` means 1 gram of gold = 85.30 USD
- XAU itself is stored with a rate of `1.0` (1 gram of gold = 1 gram of gold)

This model lets any two currencies be compared without storing every pair — just divide one rate by another.

---

## Currencies tracked

The list of tracked currencies and their fetch order lives in `currency_master` — not hardcoded in Python. To add or remove a currency, update the table directly.

**Fiat (14)** — sourced from Yahoo Finance (yfinance). Fetched in priority order (see below):

| Rank | Code | Currency |
|------|------|----------|
| 1    | USD  | US Dollar |
| 2    | EUR  | Euro |
| 3    | GBP  | Pound Sterling |
| 4    | INR  | Indian Rupee |
| 5    | JPY  | Japanese Yen |
| 6    | CNY  | Chinese Yuan |
| 7    | AUD  | Australian Dollar |
| 8    | CAD  | Canadian Dollar |
| 9    | CHF  | Swiss Franc |
| 10   | SGD  | Singapore Dollar |
| 11   | AED  | UAE Dirham |
| 12   | HKD  | Hong Kong Dollar |
| 13   | BRL  | Brazilian Real |
| 14   | KRW  | South Korean Won |

**Crypto (3)** — sourced from Yahoo Finance (yfinance):

| Rank | Code | Asset |
|------|------|-------|
| 15   | BTC  | Bitcoin |
| 16   | ETH  | Ethereum |
| 17   | SOL  | Solana |

**Gold (1)**

| Code | Asset |
|------|-------|
| XAU  | Gold (1 gram = 1.0, synthetic row inserted alongside fiat data) |

---

## Fetch priority ordering

To ensure the most important currencies are processed first in case a run is interrupted, currencies are fetched in this order:

1. **Never-fetched first** (`last_fetched_date IS NULL`) — currencies with no data at all are processed before those already partially covered
2. **Then by `currency_rank` ASC** — within currencies that have been fetched, higher-ranked ones go before lower-ranked ones

SQL: `ORDER BY last_fetched_date ASC NULLS FIRST, currency_rank ASC NULLS LAST`

After each successful fetch, `last_fetched_date` is updated to the latest date returned for that currency. If a run is cut short, the next run automatically resumes with the currencies that were missed.

To change the rank of a currency:
```sql
UPDATE currency_master SET currency_rank = 3 WHERE currency_code = 'INR';
```

---

## Data sources

### Yahoo Finance (yfinance) — fiat rates

Gold is fetched as `GC=F` (COMEX gold futures, priced in USD per troy ounce). Fiat rates are derived by combining the gold price with a forex pair:

| Pair type | Example tickers | Conversion |
|-----------|----------------|------------|
| CCY/USD (1 CCY = X USD) | `EURUSD=X`, `GBPUSD=X`, `AUDUSD=X`, `CADUSD=X`, `CHFUSD=X`, `SGDUSD=X` | XAU/CCY = GC=F / forex_rate |
| USD/CCY (1 USD = X CCY) | `USDJPY=X`, `USDCNY=X`, `USDINR=X`, `USDAED=X`, `USDHKD=X`, `USDBRL=X`, `USDKRW=X` | XAU/CCY = GC=F × forex_rate |

USD needs no forex pair — GC=F is already XAU/USD.

All values are divided by `31.1035` (troy ounces per gram) before storage.

### Yahoo Finance (yfinance) — crypto rates

Crypto tickers used: `BTC-USD`, `ETH-USD`, `SOL-USD`. Gold price from `GC=F`.

Conversion: `grams_of_gold_per_crypto = (GC=F / crypto_usd) / 31.1035`

This answers: "how many grams of gold does one unit of crypto buy?"

---

## Two modes of operation

### Daily (rolling last 365 days)

Fetches the past 365 days of fiat rates and latest crypto rates from Yahoo Finance. Designed to run on a schedule (e.g. nightly cron).

Entry point: `core/runner.py`

### Historical (one-time backfill)

Loads fiat rates from locally downloaded CSV files (one file per currency, downloaded manually from stooq in the original XAU/{CCY} format). Processes files in the same priority order as the daily job. Logs a warning for any missing files and skips them. Fetches latest crypto rates from Yahoo Finance as a finishing step.

Entry point: `core/historical.py`

Expected CSV filenames match stooq's symbol format:

```
xauusd.csv  xaueur.csv  xaugbp.csv  xaujpy.csv
xaucny.csv  xauinr.csv  xauaud.csv  xaucad.csv
xauchf.csv  xausgd.csv  xauaed.csv  xauhkd.csv
xaubrl.csv  xaukrw.csv
```

Download URL format (change the symbol and date range as needed):
```
https://stooq.com/q/d/l/?s=xauinr&f=20200101&t=20260812&i=d
```

---

## Weekend and holiday gap filling

Gold and forex markets close on weekends and public holidays — Yahoo Finance returns no row for those days. After every fiat upsert, a forward-fill pass runs automatically:

- Finds all dates in the range with no row for a given currency
- Carries the last real closing rate forward into those gap dates
- Marks filled rows with `rate_source = 'forward_fill'` so they are always distinguishable from real closes
- Never overwrites a real rate — uses `ON CONFLICT DO NOTHING`

The daily job's rolling 365-day window also self-heals any gap caused by a failed run: the next successful run covers the missed days automatically.

---

## Database schema

### `currency_master`

| Column             | Type        | Notes |
|--------------------|-------------|-------|
| `id`               | UUID        | Primary key, auto-generated |
| `currency_code`    | CHAR(3)     | Unique, not null (e.g. `USD`, `XAU`) |
| `currency_name`    | TEXT        | Display name |
| `currency_symbol`  | TEXT        | Display symbol |
| `decimal_places`   | SMALLINT    | Precision for display |
| `currency_type`    | TEXT        | `fiat`, `commodity`, or `crypto` |
| `is_tracked`       | BOOLEAN     | Whether this currency is actively fetched |
| `currency_rank`    | INTEGER     | Fetch priority (1 = highest). NULL = no preference |
| `last_fetched_date`| DATE        | Latest date for which we have rate data. NULL = never fetched |
| `created_at`       | TIMESTAMPTZ | Auto-set on insert |
| `updated_at`       | TIMESTAMPTZ | Auto-updated on any change |

### `currency_rates`

| Column               | Type           | Notes |
|----------------------|----------------|-------|
| `id`                 | UUID           | Primary key, auto-generated |
| `rate_date`          | DATE           | The date the rate applies to |
| `base_currency_code` | CHAR(3)        | Always `XAU` (enforced by constraint) |
| `quote_currency_code`| CHAR(3)        | The currency being measured |
| `rate_value`         | NUMERIC(19,6)  | Units of quote currency per 1 gram of XAU |
| `rate_source`        | TEXT           | `yfinance` or `forward_fill` |
| `created_at`         | TIMESTAMPTZ    | Auto-set on insert |
| `updated_at`         | TIMESTAMPTZ    | Auto-updated on upsert |

Unique constraint on `(quote_currency_code, rate_date)` — upserts overwrite on conflict, forward-fills skip on conflict.

**Views:**

- `v_latest_rates` — most recent rate per currency
- `v_rates_to_gbp` — cross rate from any currency to GBP, derived from latest XAU rates

---

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CR_DB_HOST`            | Yes  | —      | Postgres host |
| `CR_DB_PORT`            | No   | `5432` | Postgres port |
| `CR_DB_USER`            | Yes  | —      | Postgres user |
| `CR_DB_PASSWORD`        | Yes  | —      | Postgres password |
| `CR_DB_NAME`            | Yes  | —      | Postgres database name |
| `CR_HISTORICAL_CSV_DIR` | Yes¹ | —      | Absolute path to the folder containing downloaded stooq CSV files |
| `MERIDIAN_LOG_ROOT`     | Yes  | —      | Root directory for log output |

¹ Required only when running historical mode.

### Config file

`config.yaml` — toggle data sources on/off without touching code:

```yaml
sources:
  yfinance:
    enabled: true
```

---

## Project layout

```
currency-rates/
├── config.yaml              # source toggles
├── pyproject.toml           # dependencies (uv)
├── py_db_migrate.toml       # migration CLI connection config
├── start-up.sh              # interactive entry point — runs migrations then prompts for mode
├── core/
│   ├── config.py            # reads config.yaml and env vars
│   ├── fetcher.py           # daily fetch logic (fiat loop + crypto via yfinance)
│   ├── runner.py            # daily job entry point (rolling 365 days)
│   └── historical.py        # historical load entry point (local CSV files)
├── sources/
│   ├── constants.py         # shared conversion constants (TROY_OZ_TO_GRAM)
│   ├── stooq.py             # Yahoo Finance fiat rate fetcher; CSV parser for historical loads
│   └── exchangerate.py      # Yahoo Finance crypto rate fetcher
├── database/
│   ├── currency_master.py   # fetch-order query and last_fetched_date updates
│   └── upsert.py            # rate upsert and forward-fill
└── migrations/
    ├── 0001_create_currency_master.py
    └── 0002_create_currency_rates.py
```

---

## Running

```bash
cd data-synchronization/currency-rates
bash start-up.sh
```

The script loads `.env`, syncs dependencies, runs pending migrations, then prompts:

```
  1) Daily      — rolling last 365 days
  2) Historical — full load from local CSV files
```

For the historical load, place the downloaded stooq CSV files in the directory pointed to by `CR_HISTORICAL_CSV_DIR` before running. Missing files are logged as warnings and skipped — the load still completes for whatever files are present.
