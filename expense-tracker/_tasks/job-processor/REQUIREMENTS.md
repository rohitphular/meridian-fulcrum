# Job Processor — Requirements

## Purpose

A local Python compute layer that reads raw expense-tracker data from Google Sheets,
runs processing jobs (KPI computation, aggregations, analysis), and writes results
back to dedicated output sheets. The existing GAS `/exec` endpoint then serves
pre-computed results to the frontend — the UI no longer needs to process raw data
for insights.

---

## Goals

1. Pre-compute insight KPIs so the frontend is display-only
2. Provide a pluggable job system — adding a new KPI = adding one Python file
3. Keep it local — no cloud infra, no GAS scripts for computation
4. Lay the foundation for local LLM analysis later

---

## Architecture

```
Google Sheets (raw data)
        │
        ▼
  job-engine (Python, local)
   ├── reads: Transactions, Accounts, Categories, Rates sheets
   ├── computes: KPIs, aggregations, summaries
   └── writes: computed_* sheets
        │
        ▼
Google Sheets (computed data)
        │
        ▼
  GAS /exec (new action: getComputedData)
        │
        ▼
  Frontend (display only)
```

---

## Technology Stack

| Concern              | Choice                              |
|----------------------|-------------------------------------|
| Language             | Python 3.11+                        |
| Sheets access        | `gspread` + service account JSON    |
| Config               | `config.json` (spreadsheet ID, sheet names, settings) |
| Scheduling           | Manual (`python runner.py`) or cron |
| Dependency mgmt      | `pyproject.toml` / `pip`            |

---

## Folder Structure

```
forge/expense-tracker/job/
  runner.py              ← entry point; runs all jobs or a named job
  sheets_client.py       ← thin wrapper around gspread (read/write)
  config.json            ← spreadsheet ID, sheet name mappings
  requirements.txt
  jobs/
    __init__.py
    base.py              ← BaseJob class (interface all jobs implement)
    kpi_summary.py       ← first job: compute top-level KPIs
    ...                  ← one file per job
  output/
    schema.md            ← documents every output sheet and its columns
```

---

## Job Interface

Every job inherits from `BaseJob` and implements one method:

```python
class BaseJob:
    def __init__(self, sheets_client, config):
        self.sheets = sheets_client
        self.config = config

    def run(self) -> None:
        raise NotImplementedError
```

`runner.py` discovers all jobs in `jobs/`, instantiates them, and calls `run()`.

---

## Input Sheets (read-only)

| Sheet name          | What it contains                        |
|---------------------|-----------------------------------------|
| `Transactions`      | All transaction rows                    |
| `Accounts`          | Account definitions and balances        |
| `Categories`        | Category tree (major / minor)           |
| `ExchangeRates`     | Currency → GBP rate map                 |

Sheet names must match what GAS creates — configured in `config.json`.

---

## Output Sheets (written by jobs)

Each job writes to its own sheet. Sheets are created if they don't exist.
All output sheets follow this convention:

- Row 1: column headers
- Row 2+: data rows
- First column: always `computed_at` (ISO timestamp of last run)

| Sheet name             | Written by         | Purpose                          |
|------------------------|--------------------|----------------------------------|
| `computed_kpi_summary` | `kpi_summary.py`   | Top-level KPIs (income, expense, savings rate, net worth, etc.) |
| *(more added as jobs are built)* | | |

---

## GAS Integration

A new action `getComputedData` is added to the GAS router:

```
POST /exec
{ action: "getComputedData", sheet: "computed_kpi_summary", token: "..." }
```

GAS reads the requested computed sheet and returns its rows as JSON.
No computation happens in GAS — it is a pass-through reader only.

---

## First Job: `kpi_summary`

Computes top-level KPIs for configurable trailing periods.

**Output columns (one row per period):**

| Column              | Description                                   |
|---------------------|-----------------------------------------------|
| `computed_at`       | ISO timestamp                                 |
| `period`            | e.g. `last_30d`, `last_90d`, `ytd`, `all`    |
| `total_income`      | Sum of money-in, in GBP                       |
| `total_expense`     | Sum of money-out, in GBP                      |
| `net_savings`       | income − expense                              |
| `savings_rate_pct`  | net / income × 100                            |
| `avg_daily_income`  | income / days in period                       |
| `avg_daily_expense` | expense / days in period                      |
| `avg_daily_savings` | net / days in period                          |
| `tx_count`          | total transaction count                       |

**Periods computed per run:** `last_7d`, `last_30d`, `last_90d`, `last_12m`, `ytd`, `all`

---

## Config (`config.json`)

```json
{
  "spreadsheet_id": "<your-sheet-id>",
  "service_account_file": "~/.config/forge/service_account.json",
  "sheets": {
    "transactions":    "Transactions",
    "accounts":        "Accounts",
    "categories":      "Categories",
    "exchange_rates":  "ExchangeRates"
  },
  "quote_currency": "GBP",
  "jobs": ["kpi_summary"]
}
```

---

## Out of Scope (for now)

- No GAS changes until at least one job is producing correct output
- No LLM integration yet — foundation first
- No real-time / trigger-based runs — manual or cron only
- No retry logic — jobs fail fast and log clearly

---

## Open Questions

1. What is the exact spreadsheet ID and what are the actual sheet names in your Sheets file?
2. Do you have a service account already, or do we need to set one up?
3. Should the runner log to console only, or write a run log to a sheet too?
4. Which periods matter most for the first KPI job?
