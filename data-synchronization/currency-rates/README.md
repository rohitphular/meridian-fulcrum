# currency-rates

Fetches and stores daily exchange rates for fiat currencies and crypto assets, all expressed relative to gold (XAU per gram). Backs the expense-tracker's multi-currency valuation.

---

## What it does

Fetches daily exchange rates for 14 fiat currencies and 3 crypto assets from two external sources and stores them in PostgreSQL. All rates use gold (XAU per gram) as the base, so any two currencies can be compared by dividing their rates without storing every pair. The job runs in two modes: Daily fetches the rolling last 365 days via HTTP from stooq (fiat) and exchangerate.fun (crypto); Historical loads fiat rates from locally downloaded CSV files for a one-time backfill. After every fiat upsert, a forward-fill pass fills weekend and holiday gaps by carrying the last real closing rate forward.

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

**Fiat (14)** — sourced from stooq. Fetched in priority order (see below):

| Rank | Code | Currency |
|------|------|----------|
| 1    | USD  | US Dollar |
| 2    | EUR  | Euro |
| 3    | GBP  | British Pound |
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

**Crypto (3)** — sourced from exchangerate.fun (fetched in a single call):

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

Stooq imposes a daily download limit per IP. To make the most of each run, currencies are fetched in this order:

1. **Never-fetched first** (`last_fetched_date IS NULL`) — currencies with no data at all hit the API before the limit kicks in
2. **Then by `currency_rank` ASC** — within currencies that have been fetched, higher-ranked ones go before lower-ranked ones

SQL: `ORDER BY last_fetched_date ASC NULLS FIRST, currency_rank ASC NULLS LAST`

After each successful fetch, `last_fetched_date` is updated to the latest date returned for that currency. If a run is cut short by a rate limit, the next run automatically starts with the currencies that were missed.

To change the rank of a currency:
```sql
UPDATE currency_master SET currency_rank = 3 WHERE currency_code = 'INR';
```

---

## Data sources

### stooq — fiat rates
- **URL pattern:** `https://stooq.com/q/d/l/?s=xauusd&f=20200101&t=20260812&i=d`
- Provides daily XAU/{currency} OHLCV data as CSV
- Requires browser-like headers and session cookies to avoid access denied — the code hits the stooq homepage first to establish a session, then adds a matching `Referer` header per request
- The fetcher sleeps 1–5 seconds between each currency request to avoid rate limiting
- stooq uses **XAU = 1 troy ounce** (ISO 4217 standard); all values are divided by `31.1035` to convert to per gram before storage
- Crypto pairs (BTC, ETH, SOL) do not exist on stooq

### exchangerate.fun — crypto rates
- **URL:** `https://api.exchangerate.fun/latest?base=XAU`
- Returns all 170+ currencies in a single call with XAU as base
- Free, no API key, no rate limits, hourly updates
- Only BTC, ETH, and SOL are extracted from the response
- Same troy ounce → gram conversion applied (`÷ 31.1035`)
- Fetches today's rate only (no historical support)

---

## Two modes of operation

### Daily (rolling last 365 days)

Fetches the past 365 days of fiat rates via HTTP from stooq, plus today's crypto rates from exchangerate.fun. Designed to run on a schedule (e.g. nightly cron).

Entry point: `core/runner.py`

### Historical (one-time backfill)

Loads fiat rates from locally downloaded CSV files (one file per currency, downloaded manually from stooq). Processes files in the same priority order as the daily job. Logs a warning for any missing files and skips them. Fetches today's crypto rates from exchangerate.fun as a finishing step.

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

Gold and forex markets close on weekends and public holidays — stooq returns no row for those days. After every stooq upsert, a forward-fill pass runs automatically:

- Finds all dates in the range with no row for a given currency
- Carries the last real closing rate forward into those gap dates
- Marks filled rows with `rate_source = 'stooq_forward_fill'` so they are always distinguishable from real closes
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
| `rate_source`        | TEXT           | `stooq`, `exchangerate`, or `stooq_forward_fill` |
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
  stooq:
    enabled: true
  exchangerate:
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
│   ├── fetcher.py           # daily fetch logic (stooq loop + exchangerate)
│   ├── runner.py            # daily job entry point (rolling 365 days)
│   └── historical.py        # historical load entry point (local CSV files)
├── sources/
│   ├── constants.py         # shared conversion constants (TROY_OZ_TO_GRAM)
│   ├── stooq.py             # stooq HTTP client and CSV parser
│   └── exchangerate.py      # exchangerate.fun HTTP client
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
