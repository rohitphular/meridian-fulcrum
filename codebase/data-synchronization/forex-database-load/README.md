# forex-database-load

Fetches and stores daily exchange rates for fiat currencies and crypto assets, all expressed relative to gold (XAU per gram). Backs the expense-tracker's multi-currency valuation.

---

## What it does

Fetches daily exchange rates for 14 fiat currencies and 3 crypto assets from Yahoo Finance (yfinance) and stores them in PostgreSQL. All rates use gold (XAU per gram) as the base, so any two currencies can be compared by dividing their rates without storing every pair. The job runs in two modes: Daily fetches the rolling last 365 days via Yahoo Finance for both fiat and crypto; Historical loads fiat rates from locally downloaded CSV files for a one-time backfill. After fetching, a forward-fill pass fills weekend and holiday gaps by carrying the last real closing rate forward.

---

## What it stores

Every rate in the database answers: **"how many units of this currency equal 1 gram of gold?"**

- Base currency is always **XAU (gold, per gram)**
- A rate of `USD = 85.3` means 1 gram of gold = 85.30 USD
- XAU itself is stored with a rate of `1.0` (1 gram of gold = 1 gram of gold)

This model lets any two currencies be compared without storing every pair — just divide one rate by another.

---

## Currencies tracked

The enabled currencies and fetch order come from `currency_master` for both fiat and crypto. Set `is_tracked` to disable fetching. Adding a currency also requires a supported ticker mapping in `sources/fiat.py` or `sources/crypto.py`, plus master metadata including `minor_unit_name`. Unsupported tracked codes fail the run.

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
| XAU  | Gold (1 gram = 1.0, synthetic row for every date in the requested range) |

---

## Fetch priority ordering

To ensure the most important currencies are processed first in case a run is interrupted, currencies are fetched in this order:

1. **Never-fetched first** (`last_fetched_date IS NULL`) — currencies with no data at all are processed before those already partially covered
2. **Oldest source date first** — previously fetched currencies are ordered by `last_fetched_date` ascending
3. **Then by `currency_rank` ASC** — rank breaks ties on source date

SQL: `ORDER BY last_fetched_date ASC NULLS FIRST, currency_rank ASC NULLS LAST`

Rates, gap fills, and source-date watermarks commit together. A failed run rolls back all job writes. Watermarks advance only to actual source dates, never to gap-fill dates or backwards during an older historical import.

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

All values are divided by `31.1034768` (grams per troy ounce) before storage.

### Yahoo Finance (yfinance) — crypto rates

Crypto tickers used: `BTC-USD`, `ETH-USD`, `SOL-USD`. Gold price from `GC=F`.

Conversion: `crypto_units_per_gram = (GC=F / crypto_usd) / 31.1034768`

This answers: "how many units of crypto equal one gram of gold?"

---

## Two modes of operation

### Daily (rolling last 365 days)

Fetches 365 calendar dates, from the current UTC date minus 364 days through that UTC date inclusive, for both tracked fiat and crypto. Designed to run on a schedule (e.g. nightly cron). A single downloaded gold-price snapshot is shared by all fiat and crypto conversions in the run, avoiding different gold anchors if a provisional close changes during fetching.

Entry point: `core/runner.py`

### Publish to Sheet (`publish-sheet`)

Copies the latest rate of every currency in `currency_master` that has one into the app's `rates` tab: `currency`, `rate` (units per gram of XAU), `symbol`, `updated_at` (publish time, UTC) and `rate_date`. XAU comes first, then `currency_rank`. One write replaces the tab (created if missing) and clears older rows below; values are written RAW. The app only reads this tab. Run it after `daily` (the consolidated pipeline does). It needs `spreadsheet_id` in `cicd/envs.json` and `FDL_SERVICE_ACCOUNT_FILE` (a service-account key with Editor access to the spreadsheet) in `infrastructure/.env.<env>`; the check step fails with a clear message if either is missing. Requests go through the shared paced client (`py_google_workspace.SheetsRequests`: spaced requests, bounded 429 backoff).

### Historical (one-time backfill)

Loads fiat rates from locally downloaded CSV files (one file per currency, downloaded manually from stooq in the original XAU/{CCY} format). Processes files in the same priority order as the daily job. Logs a warning for any missing files and skips them. When yfinance is enabled, fetches tracked crypto over the imported fiat date range through today, retaining actual source dates.

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

Gold and forex markets close on weekends and public holidays — Yahoo Finance returns no row for those days. After fetching, a forward-fill pass runs automatically:

- Operates only on tracked fiat currencies successfully fetched or imported in this run
- Carries the last real closing rate forward into those gap dates
- Marks filled rows with `rate_source = 'forward_fill'` so they are always distinguishable from real closes
- Refreshes existing forward-filled rows after a corrected real close; preserves real source rows
- Does not create or update crypto gaps; old crypto forward-fill rows from earlier versions require a separately reviewed data cleanup
- Fills through the requested end date using the latest earlier real close, even after the last source date; the source tag identifies stale carried values
- Generates calendar dates independently of the database timezone, including midnight clock changes and skipped local civil dates

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
| `decimal_places`   | SMALLINT    | Minor unit factor = `10^decimal_places`; BETWEEN 0 AND 9 |
| `minor_unit_name`  | TEXT        | Human-readable name for the lowest denomination (e.g. `pence`, `satoshi`, `nanogram`) |
| `currency_type`    | TEXT        | `fiat`, `commodity`, or `crypto` |
| `is_tracked`       | BOOLEAN     | Whether this currency is actively fetched |
| `currency_rank`    | INTEGER     | Fetch priority (1 = highest). NULL = no preference |
| `last_fetched_date`| DATE        | Latest real source date, excluding gap fills. NULL = never fetched |
| `created_at`       | TIMESTAMPTZ | Auto-set on insert |
| `updated_at`       | TIMESTAMPTZ | Auto-updated on any change |

### `currency_rates`

| Column               | Type           | Notes |
|----------------------|----------------|-------|
| `id`                 | UUID           | Primary key, auto-generated |
| `rate_date`          | DATE           | The date the rate applies to |
| `base_currency_code` | CHAR(3)        | Always `XAU` (enforced by constraint) |
| `quote_currency_code`| CHAR(3)        | The currency being measured |
| `rate_value`         | NUMERIC(19,8)  | Units of quote currency per 1 gram of XAU |
| `rate_source`        | TEXT           | `yfinance`, `stooq`, `synthetic` (XAU identity), or `forward_fill` |
| `created_at`         | TIMESTAMPTZ    | Auto-set on insert |
| `updated_at`         | TIMESTAMPTZ    | Auto-updated on upsert |

Unique constraint on `(quote_currency_code, rate_date)` — source upserts overwrite on conflict while preserving the row UUID and creation time; forward-fills update only derived rows. Migration `0006_enforce_finite_identity_rates.py` rejects nonfinite rates and requires every XAU identity quote to equal `1`, including writes outside this job. Existing violations stop the migration for review; it never rewrites historical rates automatically.

---

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FULCRUM_DB_HOST`            | Yes  | —      | Postgres host |
| `FULCRUM_DB_PORT`            | No   | `5432` | Postgres port |
| `FULCRUM_DB_USER`            | Yes  | —      | Postgres user |
| `FULCRUM_DB_PASSWORD`        | Yes  | —      | Postgres password |
| `FULCRUM_DB_NAME`            | Yes  | —      | Postgres database name |
| `FDL_HISTORICAL_CSV_DIR` | Yes¹ | —      | Absolute path to the folder containing downloaded stooq CSV files |
| `FDL_SERVICE_ACCOUNT_FILE` | publish-sheet | —      | Path to the service-account JSON key (Editor on the spreadsheet); the same key as `LSE_SERVICE_ACCOUNT_FILE` works |
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
forex-database-load/
├── README.md
├── Makefile                 # run, lint, test, generate-models targets
├── config.yaml              # source toggles
├── pyproject.toml           # dependencies (uv)
├── py_db_migrate.toml       # migration CLI connection config
├── py_db_schema.toml        # model generation config
├── cicd/
│   ├── envs.json
│   ├── check.sh             # mandatory check: env, mode, settings (no installs or writes)
│   └── start-up.sh          # runs check.sh, env loading, locked sync, migrations, run
├── _runbooks/
│   ├── MODULE-REQUIREMENT.md
│   ├── CODE-REVIEW-INSTRUCTIONS.md
│   └── USAGE-INSTRUCTIONS.md
├── _tasks/
│   └── TASK-currency-schema-enhancements.md
├── tests/                   # offline unit and isolated PostgreSQL regression tests
├── core/
│   ├── config.py            # reads config.yaml and env vars
│   ├── errors.py            # safe failure-reason codes for logs and exit messages
│   ├── fetcher.py           # daily fetch logic (fiat loop + crypto via yfinance)
│   ├── runner.py            # daily job entry point (rolling 365 days)
│   └── historical.py        # historical load entry point (local CSV files)
├── sources/
│   ├── constants.py         # shared conversion constants (TROY_OZ_TO_GRAM)
│   ├── fiat.py              # Yahoo Finance fiat rate fetcher; CSV parser for historical loads
│   └── crypto.py            # Yahoo Finance crypto rate fetcher
├── database/
│   ├── currency_master.py   # fetch-order query and last_fetched_date updates
│   ├── upsert.py            # rate upsert and forward-fill
│   └── models/
│       ├── currency_master.py   # auto-generated typed model for currency_master
│       └── currency_rates.py    # auto-generated typed model for currency_rates
└── migrations/
    ├── 0001_create_currency_master.py
    ├── 0002_create_currency_rates.py
    ├── 0003_update_xau_decimal_places.py
    ├── 0004_add_minor_unit_name.py
    ├── 0005_update_rate_value_precision.py
    └── 0006_enforce_finite_identity_rates.py
```

---

## Running

```bash
cd codebase/data-synchronization/forex-database-load
bash cicd/start-up.sh --interactive dev
# Same, with the mode given (no mode prompt):
make run ENV=dev MODE=daily
# Unattended (env and mode from a pipeline config):
bash cicd/start-up.sh --config ../consolidated-pipeline/config/pipeline.dev.json
```

Without an explicit mode, the script first prompts below. It then loads `infrastructure/.env.dev` or `infrastructure/.env.prod` from the repository root, syncs locked dependencies, runs pending migrations, and executes the selected job:

```
  1) Daily      — rolling last 365 days
  2) Historical — full load from local CSV files
```

For the historical load, place the downloaded stooq CSV files in the directory pointed to by `FDL_HISTORICAL_CSV_DIR` before running. Missing files are logged as warnings and skipped — the load still completes for whatever files are present.


## Validation and data limitations

Run `make lint` and `make test-unit` (offline) or `make test` (unit + integration) from this directory. Unit tests mock provider calls and use synthetic CSV fixtures. Integration tests start a disposable PostgreSQL cluster when local server binaries are available; they never use configured dev/prod databases. A skipped integration test is not a verified SQL pass.

Arithmetic uses `Decimal` after parsing provider values; database writes round half-up to eight decimal places and reject nonfinite, nonpositive, or unrepresentable rates. Yahoo prices may already originate as floating-point values, so Decimal prevents additional binary arithmetic error but cannot recover lost source precision. Eight-place rates do not guarantee nanogram accuracy when converted back to XAU. The generated `database/models/currency_rates.py` currently annotates NUMERIC as float because of the shared schema generator; runtime writes here require Decimal and do not use that generated row type.

`GC=F` is a futures proxy for gold, not a spot-gold fixing. Joined closes share a provider calendar/session date, not necessarily the same pricing instant. Crypto is stored only for dates with both gold and crypto closes; weekends and pre-listing dates can remain absent. Missing an entire tracked series fails daily/crypto fetching before writes; isolated missing source dates are omitted (fiat gaps are carried forward). Today's close may be provisional and corrected by the next run.

Missing historical files are warnings and skipped. A present file with no valid rows, an unreadable file, future-dated data, or an import with no fiat data fails the job. Invalid individual CSV rows are warned and skipped. CSV imports are tagged `stooq`. Setting `sources.yfinance.enabled: false` skips the daily job and skips only the crypto portion of a historical import.

Downloads use up to three attempts for provider exceptions or wholly empty responses, with one- and two-second backoffs and a 20-second request timeout. Malformed columns and conflicting duplicate session dates are rejected. Historical CSVs reject duplicate headers or conflicting duplicate dates as a whole; identical date/value repetitions are harmless. Ragged rows are skipped instead of silently reading extra or shifted fields. Conversion arithmetic uses an isolated 64-digit Decimal context before storage rounds to eight decimal places.

Daily and historical jobs share a transaction advisory lock. An overlapping run stops with `forex_database_load_job_already_running` before fetching or writing; commit/rollback/connection closure releases the lock. Startup validates environment, source configuration and the historical CSV directory before running migrations. Controlled failure codes are logged without provider responses, connection strings or secrets.

This review changes code only: historical misdated crypto rows or incorrect provenance already in a database are not automatically deleted. Re-fetching correct dates repairs overlapping rows, but any remaining legacy rows need explicit review before cleanup.
