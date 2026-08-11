# Forge Backend — Python Job Processor Guide

> **Audience**: LLMs and developers writing or modifying the Forge job processor.
> **Stack**: Python 3.11+ · `gspread` · Google Sheets API · service account auth

---

## What the job processor is

A local Python process that reads raw expense-tracker data from Google Sheets, runs
compute jobs (KPI aggregation, analysis, etc.), and writes pre-computed results back
to dedicated output sheets. The GAS `/exec` endpoint serves these output sheets to
the frontend — no computation happens in GAS or the browser.

The job processor is **not** a server. It runs on demand (`python runner.py`) or via
cron. It has no HTTP endpoints and no persistent state.

---

## Folder structure

```
forge/expense-tracker/job/
  runner.py              ← entry point — discovers and runs jobs
  config.py              ← loads envs.json + resolves service account path
  sheets_client.py       ← thin gspread wrapper (read_sheet / write_sheet)
  requirements.txt
  jobs/
    __init__.py          ← ALL_JOBS registry
    base.py              ← BaseJob abstract class
    kpi_summary.py       ← one file per job
    ...
```

---

## Running jobs

```bash
cd forge/expense-tracker/job
pip install -r requirements.txt

python runner.py --env dev           # run all jobs against dev sheet
python runner.py --env prod          # run all jobs against prod sheet
python runner.py --env dev --job kpi_summary   # run one job by name
```

`--env` defaults to `dev`. Exits with code 1 if any job fails.

---

## Config and credentials

`config.py` reads two files:

| File | Location | Purpose |
|---|---|---|
| `envs.json` | `forge/expense-tracker/cicd/envs.json` | Spreadsheet IDs per env (dev/prod) |
| Service account | `local/configs/gcp_service_account.json` | GCP credentials — **never commit** |

`local/` is gitignored at the repo root. Never move the service account into the repo.

The config object passed to every job:

```python
{
  'env':            'dev',
  'spreadsheet_id': '...',
  'service_account': '/path/to/gcp_service_account.json',
  'sheets': {
    'transactions':  'transactions',
    'accounts':      'accounts',
    'categories':    'categories',
    'rates':         'rates',
    'subscriptions': 'subscriptions',
  },
  'quote_currency': 'GBP',
}
```

---

## Input sheets (read-only)

| Key in `config['sheets']` | Sheet name | Contents |
|---|---|---|
| `transactions` | `transactions` | All transaction rows |
| `accounts` | `accounts` | Account definitions and balances |
| `categories` | `categories` | Category tree (major / minor) |
| `rates` | `rates` | Currency → GBP rate map |
| `subscriptions` | `subscriptions` | Subscription definitions |

Never write to input sheets from a job. They are owned by GAS.

---

## Output sheets (written by jobs)

Each job writes to its own dedicated sheet. Sheet naming convention:

```
computed_<job_name>
```

e.g. `computed_kpi_summary`, `computed_cashflow_monthly`.

Output sheet rules:
- Row 1: column headers
- Row 2+: data rows
- First column: always `computed_at` (ISO 8601 timestamp of the run)
- Jobs clear and rewrite the full sheet on every run — no incremental updates

---

## SheetsClient

`sheets_client.py` wraps gspread. Use these two methods — do not import gspread directly in job files.

### `read_sheet(name: str) -> list[dict]`

Returns all data rows as a list of dicts keyed by header values. Returns `[]` if the sheet doesn't exist (logs a warning). All values are returned as strings (`numericise_ignore=['all']`) — cast in the job.

```python
rows = self.sheets.read_sheet(self.config['sheets']['transactions'])
# rows = [{'id': '2024-01-15-001', 'amount': '42.50', 'tx_type': 'money-out', ...}, ...]
```

### `write_sheet(name: str, headers: list[str], rows: list[list]) -> None`

Creates the sheet if it doesn't exist. Clears and rewrites on every call.

```python
headers = ['computed_at', 'period', 'total_income', 'total_expense']
rows    = [['2024-01-15T12:00:00Z', 'last_30d', '5000.00', '3200.00']]
self.sheets.write_sheet('computed_kpi_summary', headers, rows)
```

---

## Adding a new job

1. Create `jobs/<job_name>.py` — one file per job.
2. Inherit from `BaseJob`, set `name` and `description`, implement `run()`.
3. Register in `jobs/__init__.py`.

### Job file template

```python
from datetime import datetime, timezone
from jobs.base import BaseJob


class MyNewJob(BaseJob):
    name        = 'my_new_job'
    description = 'One-line description of what this job computes'

    OUTPUT_SHEET  = 'computed_my_new_job'
    OUTPUT_HEADERS = ['computed_at', 'col_a', 'col_b']

    def run(self) -> None:
        # 1. Read raw data
        txs = self.sheets.read_sheet(self.config['sheets']['transactions'])

        # 2. Compute
        result = self._compute(txs)

        # 3. Write output
        now = datetime.now(timezone.utc).isoformat()
        rows = [[now, row['col_a'], row['col_b']] for row in result]
        self.sheets.write_sheet(self.OUTPUT_SHEET, self.OUTPUT_HEADERS, rows)

    def _compute(self, txs: list[dict]) -> list[dict]:
        # Pure computation — no sheet I/O here
        ...
```

### Register in `jobs/__init__.py`

```python
from jobs.kpi_summary import KpiSummaryJob
from jobs.my_new_job  import MyNewJob

ALL_JOBS = [
    KpiSummaryJob,
    MyNewJob,
]
```

---

## BaseJob interface

```python
class BaseJob(ABC):
    name: str        # unique snake_case identifier — used by --job flag
    description: str # shown in runner output

    def __init__(self, sheets: SheetsClient, config: dict): ...

    @abstractmethod
    def run(self) -> None: ...
```

`run()` must either complete successfully or raise an exception. The runner catches
all exceptions, logs them, and continues to the next job. It exits with code 1 if
any job raised.

---

## Coding rules

**Data handling**
- All sheet values come back as strings — always cast explicitly: `float(row['amount'])`, `int(row['count'])`.
- Missing or empty string values are common — always use `row.get('field') or default`.
- Dates from the sheet are ISO strings — parse with `datetime.fromisoformat(...)`.

**Currency / amounts**
- All monetary output must be converted to the quote currency (GBP by default).
- Build a rate map from the `rates` sheet: `{ 'GBP': 1.0, 'INR': 105.0, ... }`.
- Conversion: `amount_gbp = float(amount) / float(fx_rate)` where `fx_rate` is the transaction's own rate, not the current live rate.
- Transactions without a matching rate should be excluded from totals — log the skip.

**Logging**
- Log to console only (`print()`). Format: `[job_name] key=value key=value`.
- Log at the start of `run()` with input counts, at the end with output counts.
- Never log raw transaction data, account names, or balances.

**No side effects on input sheets**
- Never write to `transactions`, `accounts`, `categories`, `rates`, or `subscriptions`.
- If a job needs to update a GAS-owned sheet, raise it as a design question first.

**Keep `run()` thin**
- `run()` orchestrates: read → compute → write.
- Computation lives in private `_methods` — pure functions, no sheet I/O.
- This makes jobs testable without a real Sheets connection.

---

## GAS integration — `getComputedData` action

The GAS router exposes a `getComputedData` action that reads any `computed_*` sheet
and returns its rows as JSON. The frontend calls this instead of computing locally.

```
GET /exec?action=getComputedData&sheet=computed_kpi_summary&pin=...
→ { ok: true, data: [{ computed_at: '...', period: 'last_30d', ... }] }
```

GAS does no computation — it reads the sheet and returns rows verbatim. The job
processor is the single source of truth for computed values.

---

## Common pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| Not casting sheet values | `'42.50' + 10 = '42.5010'` | Always cast: `float(row['amount'])` |
| Reading live rates instead of tx fx_rate | Amounts change retroactively | Use `tx['fx_rate']` for historical conversion |
| Writing to input sheets | GAS data gets corrupted | Only write to `computed_*` sheets |
| Assuming sheet exists | `read_sheet` returns `[]` silently | Log and handle empty result explicitly |
| Putting computation in `run()` | Untestable, hard to read | Private `_methods` for all computation |
| No `computed_at` column | Can't tell when data was last refreshed | Always include it as the first column |
