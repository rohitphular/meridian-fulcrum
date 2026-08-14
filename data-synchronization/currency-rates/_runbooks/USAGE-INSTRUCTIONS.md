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

A `.env.{env}` file must exist at the `meridian-fulcrum/` root — `.env.dev` for dev, `.env.prod` for prod. Neither file is committed to source control. Required variables:

| Variable | Purpose |
|---|---|
| `FULCRUM_DB_HOST` | Postgres host |
| `FULCRUM_DB_PORT` | Postgres port (optional, default `5432`) |
| `FULCRUM_DB_USER` | Postgres user |
| `FULCRUM_DB_PASSWORD` | Postgres password |
| `FULCRUM_DB_NAME` | Postgres database name |
| `CR_HISTORICAL_CSV_DIR` | Absolute path to local CSV files (historical mode only) |
| `MERIDIAN_LOG_ROOT` | Root directory for log output |

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
```

---

## Daily mode

Fetches the past 365 days of fiat and crypto rates from Yahoo Finance and upserts them into the database. Runs migrations first.

**When to run:** Nightly, after markets close.

**What it touches:** `currency_rates` table (upsert) and `currency_master.last_fetched_date` (update).

---

## Historical mode

Loads fiat rates from locally downloaded CSV files, then fetches today's crypto rates from Yahoo Finance.

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

Logs are written to `$MERIDIAN_LOG_ROOT`. Check there if a run fails silently. The job also exits with code 1 and logs the error on any unhandled failure.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` during `uv sync` | System git not using your SSH agent | `git config --global core.sshCommand "$(which ssh)"` |
| `KeyError: 'FULCRUM_DB_HOST'` (or similar) | Missing env var | Add the variable to `meridian-fulcrum/.env` |
| `KeyError: 'CR_HISTORICAL_CSV_DIR'` | Running historical mode without that var set | Add `CR_HISTORICAL_CSV_DIR=/path/to/csvs` to `.env` |
| `currency=XYZ no_data` warnings | Yahoo Finance returned no data for that ticker/date | Usually transient — re-run the next day |
| No crypto rates in DB | Yahoo Finance `GC=F` or crypto ticker temporarily unavailable | Check logs; re-run when market data is available |
