# currency-rates — Usage

---

## Prerequisites

### 1. SSH key for uv git sources

Dependencies are pulled from a private GitHub repo over SSH. uv uses the system git (`/usr/bin/git`), which may not pick up your shell's SSH agent by default. Run this once:

```bash
git config --global core.sshCommand "$(which ssh)"
```

Verify:

```bash
ssh -T git@github.com
# Expected: Hi <username>! You've successfully authenticated...
```

### 2. Environment file

A `.env.{env}` file must exist under `meridian-fulcrum/infrastructure/` — `.env.dev` for dev, `.env.prod` for prod. Neither file is committed to source control. Required variables:

| Variable | Purpose |
|---|---|
| `FULCRUM_DB_HOST` | Postgres host |
| `FULCRUM_DB_PORT` | Postgres port (optional, default `5432`) |
| `FULCRUM_DB_USER` | Postgres user |
| `FULCRUM_DB_PASSWORD` | Postgres password |
| `FULCRUM_DB_NAME` | Postgres database name |
| `CR_HISTORICAL_CSV_DIR` | Absolute path to local CSV files (historical mode only) |
| `MERIDIAN_LOG_ROOT` | Root directory for log output |

The launcher exports port `5432` when `FULCRUM_DB_PORT` is unset, so configuration checks, migrations and the job use the same value. Explicitly blank or invalid ports fail validation. When invoking `py-db-migrate` directly, export the port first because its TOML environment interpolation requires the variable.

### 3. PostgreSQL

The target database must be running and reachable with the credentials above before the job starts.

---

## Running

From the `meridian-fulcrum/` root:

```bash
make data-sync
```

Select the module number for `currency-rates` when prompted, then select the environment (`dev` or `prod`), then choose the mode:

```
  1) Daily      — rolling last 365 days
  2) Historical — full load from local CSV files
```

Or from within the module directory:

```bash
./cicd/start-up.sh dev    # run against dev DB
./cicd/start-up.sh prod   # run against prod DB
```

Or via the module Makefile:

```bash
make run ENV=dev
make run ENV=prod
# Scheduler-friendly, without a prompt:
make run ENV=dev MODE=daily
```

---

## Daily mode

Fetches 365 calendar dates ending on the current UTC date from Yahoo Finance and upserts them into the database. Validates the selected mode/configuration before migrations. A single gold snapshot anchors all conversions in a daily run; provider exceptions/empty responses retry up to three attempts.

**When to run:** Nightly, after markets close.

**What it touches:** `currency_rates` table (upsert) and `currency_master.last_fetched_date` (update).

---

## Historical mode

Loads fiat rates from locally downloaded CSV files, then fetches tracked crypto for the imported date range through today when yfinance is enabled.

**Use this once** to backfill data before the daily job takes over.

### Step 1 — Download CSV files from stooq

For each currency, download the historical CSV from:

```
https://stooq.com/q/d/l/?s=xauusd&f=20200101&t=20260101&i=d
```

Adjust the symbol (`xauusd`, `xaueur`, etc.) and date range as needed. The full list of symbols:

```
xauusd  xaueur  xaugbp  xaujpy  xaucny  xauinr
xauaud  xaucad  xauchf  xausgd  xauaed  xauhkd
xaubrl  xaukrw
```

### Step 2 — Place files in `CR_HISTORICAL_CSV_DIR`

The directory pointed to by `CR_HISTORICAL_CSV_DIR` must contain the CSV files named exactly as the symbol (e.g. `xauusd.csv`). Missing files are logged as warnings and skipped — the load still completes for whatever files are present.

### Step 3 — Run

```bash
make data-sync
# Select currency-rates → env → 2) Historical
```

---

## Logs

Logs are written to `$MERIDIAN_LOG_ROOT`. Check the source warnings and final status there. The job also exits with code 1 and logs the error on any unhandled failure.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` during `uv sync` | System git not using your SSH agent | `git config --global core.sshCommand "$(which ssh)"` |
| `KeyError: 'FULCRUM_DB_HOST'` (or similar) | Missing env var | Add the variable to `meridian-fulcrum/infrastructure/.env.dev` or `.env.prod` |
| `KeyError: 'CR_HISTORICAL_CSV_DIR'` | Running historical mode without that var set | Add `CR_HISTORICAL_CSV_DIR=/path/to/csvs` to the selected infrastructure env file |
| `currency=XYZ no_data` warnings | Yahoo Finance returned no data for that ticker/date | Inspect provider availability; a wholly missing tracked series fails and rolls back the job |
| No crypto rates in DB | Yahoo Finance `GC=F` or crypto ticker temporarily unavailable | Check logs; re-run when market data is available |
| `missing_environment_variable:<NAME>` or `invalid_database_port` | Missing/blank setting or port outside 1–65535 | Correct the named setting in the selected infrastructure env file; startup stops before migration |
| `historical_csv_directory_missing_or_not_absolute` | CSV path is relative or does not exist | Set `CR_HISTORICAL_CSV_DIR` to an existing absolute directory |
| `currency_rates_job_already_running` | Another daily/historical run holds the job transaction lock | Let that run finish, then retry; do not force concurrent writes |
| `duplicate_headers` / `conflicting_date` | CSV headers or repeated source dates are ambiguous | Correct/re-download that file; no rates from it are accepted |
| Migration 0006 fails `chk_cr_rate_finite` or `chk_cr_xau_identity` | Existing database rates violate the finite-value or XAU=1 contract | Inspect and reconcile those existing rows explicitly, then rerun; migration does not alter financial history |

Offline validation: `make lint` and `make test`. PostgreSQL integration tests use a disposable cluster and skip when local server binaries are absent.

Missing CSV files are skipped; present files with no valid data or future dates fail. Bad individual rows are warned and skipped. Fiat gap filling carries the most recent real close through today, so old CSV files can produce stale carried rates; inspect `rate_source` and run daily mode afterward. Crypto has no weekend gap filling. All job writes commit together.
