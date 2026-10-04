# analytics

Computes the expense-tracker reports — pre-built insights, the Home numbers and panels, the Accounts figures and every user-defined report — from PostgreSQL, and publishes them to the Sheet for the app to render. The app's GAS backend then only reads and converts currency; nothing is computed there.

**Status:** computes everything (tasks 08–12 of `temp/report-processor/`); the Sheet publisher is tested with a fake client only until the `py-google-workspace` push (`make upgrade-libs`). The app does not read the published tabs yet (tasks 14–15).

## What a run does

**build** (also the first half of **refresh**):

1. Check that the tables it reads exist (`source_table_missing:<table>` otherwise: run the loads, which migrate them).
2. Take the job's session advisory lock `(73421, 3)`; a second run fails with `analytics_already_running`. It never takes the load's lock `(73421, 1)`, so it never blocks a load.
3. Record a `running` row in `analytics.run` (committed on its own, so a failed or killed run stays visible).
4. In **one REPEATABLE READ transaction**: record what it read (`source_watermark`: row counts and newest `updated_at` per source table, newest rate date), run every build step in order (`core/steps.py`), mark the run `built`, commit:
   - **mart** (`core/mart.py`): accounts, flows (income and spending, transfers excluded) and dated balances, read once into memory; money in XAU (flows at their stored base value, balances at each day's rate).
   - **predefined** (`core/predefined_step.py`, `core/reports/`): every catalogue entry × period × tab × control, plus aggregate drills. A report that fails is recorded `failed` with a code; the run carries on.
   - **user_defined** (`core/user_defined.py`): each active user report, validated again against the contract and computed from the mart (nothing a user typed becomes SQL); recorded against its `source_updated_at`. All steps see the same snapshot, even while a load commits row by row; a failure rolls everything back and marks the run `failed` with a safe `error_code`.
5. Prune old runs: keep the newest `keep_generations` (config.yaml, default 5) and the newest published one; their payloads go with them.

Everything is computed in XAU and UTC (the report contract decides the details): the app converts XAU with the rates forex-database-load publishes, and the browser formats publish times locally.

**publish** (second half of **refresh**): writes the newest built run to the Sheet: the inactive slot (`report_data_x` in ≤ 45,000-character chunks, then `report_index_x`), `report_status`, and `report_meta` last — that one-row write switches the app to the new slot, so a failure before it leaves the previous generation live. **refresh** skips publishing when nothing it read changed (same anchor date, contract version and source watermark as the live generation); **publish** always re-sends the newest good build. **check**: reads only — the analytics schema and the `report_master` counts.

## Stores

Schema `analytics` (migrations in `migrations/`, tracking table `public.schema_migrations_analytics`):

| Table | Holds |
|---|---|
| `run` | One row per run: mode, status (`running`, `built`, `published`, `failed`), anchor date (the UTC run date the periods count from), contract version, source watermark, counts, error code, times |
| `report_output` | Every payload the run computed: report id, variant key, JSONB payload |
| `report_result` | Each report's result in the run: `ready` or `failed` (+ code), and the definition (`updated_at`) it was computed for |

The [report contract](contract/README.md) (`contract/`) defines the definitions, the pre-built catalogue, the payload and the Sheet tabs; it is shared with GAS (generated `report-contract.gs`) and ledger-database-load.

## How to run

```bash
make run ENV=dev MODE=build
```

`MODE` is `refresh`, `build`, `publish` or `check`; without it the launcher asks. Unattended: `cicd/start-up.sh --config ../consolidated-pipeline/config/pipeline.<env>.json [--stage N]`. The launcher runs `cicd/check.sh` first, loads `infrastructure/.env.<env>` (never passing the GAS PIN or secret on), migrates the `analytics` schema and runs `python -m core.runner --mode <mode>`.

| Setting | Where | Needed for |
|---|---|---|
| `spreadsheet_id` | `cicd/envs.json` | every mode (checked up front) |
| `ANA_SERVICE_ACCOUNT_FILE` | `infrastructure/.env.<env>` | `refresh`, `publish` (a service-account key with Editor access; the same key as `LSE_SERVICE_ACCOUNT_FILE` works) |
| `FULCRUM_DB_*`, `MERIDIAN_LOG_ROOT` | `infrastructure/.env.<env>` | every mode |

**Scheduling** is the owner's choice (D1): run `refresh` as the last stage of the consolidated pipeline (after `acknowledge`; it never runs after a failed load), or on its own at any time — it takes its own lock and never blocks a load. `build` alone is safe to run any time; `publish` re-sends the last good build (e.g. after restoring the Sheet).

Logs go to `$MERIDIAN_LOG_ROOT/analytics/` as `func: key=value` lines (codes, counts and ids only; never amounts or names).

## Layout

```text
analytics/
├── cicd/{check.sh, start-up.sh, envs.json}
├── contract/      # report contract: definitions, catalogue, payload, Sheet tabs, GAS + seed generators
├── core/          # runner, build (run lifecycle), steps, mart, periods, payload, predefined_step, reports/, user_defined, publish
├── database/      # runs.py: lock, run rows, watermark, pruning, publish bookkeeping
├── sheets/        # report_sheets.py: the Sheets adapter the publisher writes through
├── migrations/    # analytics schema
├── tests/{unit, integration}   # integration: disposable PostgreSQL on port 55435
├── config.yaml    # keep_generations
└── Makefile, pyproject.toml, uv.lock, py_db_migrate.toml
```

## Development

```bash
make test        # unit + integration (local PostgreSQL binaries required for integration)
make lint
make contract    # regenerate the GAS contract copy and the seed CSVs after editing contract/*.json
```

## Verification (task 17)

Measured on 2026-10-04. "Fake" = checked against a fake Sheets client or a disposable database only; "pending" = needs the deploy / library push.

| Check | How | Result |
|---|---|---|
| Hand-computed goldens: transfers, cross-currency, deleted rows, tracking start, tags, missing rates, future-dated rows, UTC month boundaries, an empty ledger | `tests/integration/test_mart.py`, `test_predefined.py`, `test_user_defined.py`, `test_goldens.py` (disposable PostgreSQL) | pass |
| Paydown / loans / debt-free compare owed amounts at one rate (a gold move is not a repayment) | `test_predefined.py::test_paydown_compares_owed_amounts_at_one_rate` | pass |
| Every pre-built variant and every contract-valid user shape is a valid payload | `test_predefined.py`, `test_user_defined.py` (> 500 shapes) | pass |
| Payload money conversion matches between Python and GAS | `contract/fixtures/payload-conversion.json` (Python writes it, `expense-tracker/tests/report-store-backend.cjs` converts it) | pass |
| Kill during publish leaves the previous generation live; the next publish completes | `test_publish.py` (fake client, failure in data, index and status writes) | pass (fake) |
| Sheets 429 | `py-google-workspace` `SheetsRequests`: paced 1.25 s, bounded backoff (6 attempts, ≤ 60 s) | library tests; pending the push |
| Dev build | `make run ENV=dev MODE=build` (23 accounts, 403 flows) | 46 reports ready, 0 failed; **1,100 payloads, 2.24 M characters, largest 14.6 K**; 0.5–0.6 s |
| Publish size on dev | `payload_rows` over the dev build | 1,100 data rows (all one chunk), 2 value requests for data + 1 each for index, status, meta, 4 resizes, 1 meta read ≈ 13 requests ≈ 16 s paced |
| End to end on dev: create a report in the app → refresh → Ready → edit → Queued → Ready; invalid → Invalid with reason | app + pipeline | pending deploy |
| GAS read latency: Home (8 payloads) and one report | Apps Script logs | pending deploy |
