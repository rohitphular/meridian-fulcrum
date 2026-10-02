# ledger-sheet-extract

The Google-facing half of the ledger sync. It stages the expense-tracker Sheet in PostgreSQL and, after [ledger-database-load](../ledger-database-load/README.md) has loaded that snapshot, writes each row's outcome back to the Sheet. Nothing here transforms or loads ledger data, and nothing in the load module talks to Google.

| Mode | What it does | Google calls |
|---|---|---|
| `extract` | Reads every enabled tab in one batched request and stores the snapshot as a new staging run | 2 (tab list + one batch read) |
| `acknowledge` | Writes the loaded run's outcomes to each row's `sync_status`, `sync_date` and `sync_notes` cells | 2 (one batch read + one batch write) |

In the [consolidated pipeline](../consolidated-pipeline/README.md) the order is: ledger-sheet-load → **extract** → forex-database-load → ledger-database-load → **acknowledge** (`run_after_failure`, so a partly failed load still reports its successes and failures to the Sheet).

## Extract

1. Read `config.yaml`: the tabs to stage. Every master must be listed; switches must be booleans. A misspelled or retired tab name fails as a missing tab when it is read, and ledger-database-load rejects any staged tab it has no contract for.
2. Take the Sheet-side advisory lock (shared with acknowledge; the load uses its own).
3. Check the tabs exist (legacy plural master names fail with a migration instruction), then read headers and raw cells (`UNFORMATTED_VALUE`) for all of them in one `values.batchGet`, keeping physical row numbers and blank gaps.
4. Check structure only: unique headers including `id` and the three sync cells, no row wider than its headers, a valid and unique UUID per row, and a known `sync_status`. The business columns are checked by ledger-database-load against the GAS contract.
5. In one PostgreSQL transaction: mark older unfinished runs `superseded`, store the run (`stg_runs`), each tab's headers (`stg_sheet_headers`) and every non-blank row's raw cells as JSONB with its row number and canonical UUID (`stg_sheet_rows`), and prune runs older than **6 months** — never the newest run or one that has not been acknowledged.

A run moves `extracted → loaded → acknowledged`, or becomes `superseded` when a newer extract starts first. Only the newest run is ever loaded or acknowledged.

## Acknowledge

1. Take the Sheet-side lock and ledger-database-load's lock, so a reload (hard-sync) cannot change the outcomes being written; if a load is running, acknowledge fails with `ledger_database_load_running`. Then take the newest run; if it is not `loaded` (not loaded yet, or already acknowledged), there is nothing to do.
2. Read the tabs with outcomes once. Find each staged row by its UUID in the **current** Sheet — not by row number — so rows inserted, moved or sorted since the snapshot still get the right status.
3. Write only when the row is unchanged since the snapshot: every cell except the three sync cells must equal the staged value, with the same type (`updated_at`, which the app's edit hook changes, counts). A column added to the tab since the snapshot is ignored while it is blank; a removed column, or a new one with a value, counts as an edit. An edited row, or one not found exactly once, is left as it is: it stays pending and the next run picks it up.
4. One `values.batchUpdate` (`RAW`) writes the sync cells, found by header name. On an HTTP 429 the write is re-planned from a fresh read before each retry, so a row edited during the quota wait is not acknowledged. Then the rows and the run are marked acknowledged.

The log reports, per tab, `written`, `edited_since_snapshot` and `not_found`.

## Requests and quota

Sheets requests are paced at least 1.25 seconds apart within each read/write quota (about 48 requests/minute), below Google's default [60 requests/minute per user per project](https://developers.google.com/workspace/sheets/api/limits). HTTP 429 gets up to six attempts with 5/10/20/40/60-second backoff plus jitter capped at 60 seconds; persistent exhaustion fails as `sheets_api_rate_limit_exhausted`.

## How to run

From the repository root: `make data-sync` → `ledger-sheet-extract` → env → mode, or `make consolidated-pipeline`. From this directory:

```bash
make run ENV=dev MODE=extract
make run ENV=dev MODE=acknowledge
bash cicd/start-up.sh --config ../consolidated-pipeline/config/pipeline.dev.json --stage 2
```

The launcher runs `cicd/check.sh` first (env, mode, spreadsheet id, env file), loads `infrastructure/.env.<env>`, exports the selected `LSE_SPREADSHEET_ID`, syncs the lockfile, applies this module's staging migrations (tracking table `schema_migrations_ledger_sheet_extract`) and runs the mode.

Required environment variables: `FULCRUM_DB_HOST`, `FULCRUM_DB_PORT`, `FULCRUM_DB_USER`, `FULCRUM_DB_PASSWORD`, `FULCRUM_DB_NAME`, `LSE_SERVICE_ACCOUNT_FILE` (service account with Sheets write access to the spreadsheet) and `MERIDIAN_LOG_ROOT`; `LSE_SPREADSHEET_ID` is set by the launcher from `cicd/envs.json`. Never print credentials or service-account key contents.

## Layout

```
ledger-sheet-extract/
├── Makefile, pyproject.toml, uv.lock, config.yaml (tabs to stage)
├── cicd/          check.sh, start-up.sh, envs.json (spreadsheet id per env)
├── core/          config.py, jobs.py (extract, acknowledge), runner.py
├── database/      staging.py (store, supersede, prune, outcomes, acknowledged)
├── sheets/        client.py (batched read, sync-cell writes), requests.py (pacing, 429 retries)
├── migrations/    0001_create_staging_tables.py
└── tests/         unit (client, config, jobs, launcher), integration (staging, extract → load → acknowledge)
```

## Development

```bash
make lint
make test-unit
make test-integration   # disposable PostgreSQL; the end-to-end test runs ledger-database-load's real job
```
