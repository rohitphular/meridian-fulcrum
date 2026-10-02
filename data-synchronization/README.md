# Manual finance synchronization

The daily entry path is **Expense Tracker UI → Apps Script → Google Sheets**. Google Sheets owns the source UUIDs and lifecycle. The extract jobs populate PostgreSQL when you run them; PostgreSQL edits are not pushed back into the app. `ledger-sheet-load` goes the other way for bulk loads: it pushes the local CSV files into the Sheet through the app's own import endpoints.

| Component | Reads | Writes |
|---|---|---|
| Expense Tracker | Its Google Sheets tabs | Source business fields, lifecycle and pending-sync metadata |
| [forex-database-load](forex-database-load/README.md) | Market provider data, or configured historical CSV files | PostgreSQL `currency_master` and dated `currency_rates` |
| [ledger-sheet-load](ledger-sheet-load/README.md) | Local CSV files in `local/files` | Google Sheets tabs, through the GAS import endpoints (sheet-rebuild or sheet-sync); fills missing CSV ids |
| [ledger-sheet-extract](ledger-sheet-extract/README.md) | `extract`: enabled Sheet tabs (one batched read). `acknowledge`: the load's outcomes | Staging tables (`stg_*`, kept 6 months); only sync status/date/notes back to the Sheet |
| [ledger-database-load](ledger-database-load/README.md) | The newest staged snapshot and PostgreSQL currency references (no Google access) | Validated ledger tables; per-row outcomes in staging |
| [consolidated-pipeline](consolidated-pipeline/README.md) | `consolidated-pipeline/config/pipeline.<env>.json` (gitignored, one per env) | Nothing itself: runs the listed modules in order, unattended |

The app's **Rates** tab contains current display rates. Neither data-sync job copies that tab into PostgreSQL or updates it from PostgreSQL. Both use XAU as one gram of gold, but current app totals and historical database valuations may differ because they use different valuation dates/rates. Accounts need a currency supported by the database catalog and the required rate history.

## Daily workflow

`make data-sync` runs one module interactively: it lists every module that has a `cicd/start-up.sh` (except consolidated-pipeline), asks for the environment, and the module then asks for its own mode. To run several modules in a row unattended, use the [consolidated-pipeline](consolidated-pipeline/README.md) (`make consolidated-pipeline`).

1. Save entries in the app and wait for the save result. Use **Refresh** to pull changes from another device or a completed sync. The app requires connectivity; there is no offline write queue. If a request loses its response, refresh and check whether it saved before resubmitting.
2. From the repository root, run `make consolidated-pipeline`, pick the environment. It starts PostgreSQL, then runs: ledger-sheet-load (`sheet-sync`) → ledger-sheet-extract (`extract`) → forex-database-load (`daily`) → ledger-database-load (`normal-sync`) → ledger-sheet-extract (`acknowledge`). For older ledger dates, use forex-database-load's documented historical-import procedure first; daily mode refreshes a rolling window, not all historical dates.
3. Normal-sync processes pending/failed rows; existing in-sync rows skip, with missing-row recovery and account-type dependency refresh exceptions described in the ledger-database-load README.
4. Use **hard-sync** (a `ledger-database-load` stage with mode `hard-sync`) after a deliberate transformation/rate correction when existing in-sync records must be reprocessed. It honors the staged tabs; it does not repair missing facts, conflicting identities or immutable account fields. Hard-sync re-loads the newest snapshot even when it was already acknowledged, so end its pipeline config with a `ledger-sheet-extract` `acknowledge` stage (`run_after_failure`); without an `extract` stage before it, it re-loads the last snapshot taken.
5. Check the summary and the Sheet's `sync_notes`. The acknowledge stage still runs after a failed load, so failed rows show their reason. Correct the source/dependency data and run again. Prior successful commits remain valid; retries use the same source UUIDs.

To run one step on its own, use `make data-sync` and pick the module.

Sheets and PostgreSQL have no shared transaction. The load works from a stored snapshot, so editing the Sheet mid-run does not stop it; rows edited after the snapshot are simply left pending and picked up by the next run. Missing source rows are not database deletions: use the app's lifecycle actions/tombstones.

## Environment selection

Every root `make` target that needs an environment asks for it the same way, through `infrastructure/select-env.sh`, which lists the environments in `infrastructure/envs.json`. Pass `ENV=<name>` to any of them to skip the question (`make infra-up ENV=dev`, `make data-sync ENV=dev`, `make api-deploy ENV=prod DESC="..."`, `make consolidated-pipeline ENV=dev`). `make consolidated-pipeline` asks once and hands the same env to `infra-up` and the pipeline.

## Module conventions

Every module has the same shape: `Makefile` with `run` (`ENV=dev|prod`, optional `MODE=`), `lint`, `upgrade-libs`, `test`, `test-unit` (plus `test-integration` and `generate-models` where there is a database); `cicd/start-up.sh`, which by default reads env and mode from the pipeline config (`--config consolidated-pipeline/config/pipeline.<env>.json [--stage N]`, never prompts) and with `--interactive <env> [mode]` takes them as arguments and asks for a missing mode; `make run` and `make data-sync` use `--interactive`; `cicd/check.sh` (same arguments) validates env, mode and settings without installing or writing anything, and is mandatory: `start-up.sh` always runs it first, and the consolidated pipeline runs it for every stage before any starts; `cicd/envs.json` for non-secret per-environment values; secrets in `infrastructure/.env.<env>`; tests under `tests/unit` (and `tests/integration`), with `MERIDIAN_LOG_ROOT` defaulted in `tests/conftest.py`.

| Module | Env var prefix | Modes |
|---|---|---|
| forex-database-load | `FDL_` | `daily`, `historical` |
| ledger-sheet-load | `LSL_` | `sheet-rebuild`, `sheet-sync` |
| ledger-sheet-extract | `LSE_` | `extract`, `acknowledge` |
| ledger-database-load | — (database only) | `normal-sync`, `hard-sync` |

Each launcher logs under its own folder, `$MERIDIAN_LOG_ROOT/<module>/`, because py-logging names its folders after the top-level Python package (`core`, `database`, ...), which every module shares.

## Bulk loads from CSV

After editing the files in `local/files`, run `make data-sync` → **ledger-sheet-load** → environment → **sheet-sync** (update rows by id, add new ones) or **sheet-rebuild** (delete and reload the CSV-backed tabs). Then run the ledger sync as above (`extract` → ledger-database-load → `acknowledge`), or simply `make consolidated-pipeline`. This replaces the former `make factory-reset`.

## Setup and release

- Deploy the matching Expense Tracker frontend and Apps Script backend after code changes. Local tests do not update an existing deployment.
- Follow the [source schema migration instructions](../expense-tracker/_docs/master-sheet-names.md). Import Account Types first, then categories/accounts and desired detail tabs. Enable only existing tabs with current headers.
- Run currency migrations before ledger migrations on a new database. The launchers apply pending migrations for the selected environment. Ledger currently requires migrations through `0023`; currency requires `0006`, which rejects nonfinite rates and non-identity XAU values without rewriting historical data.
- Complete any missing per-row subscription timezones before importing/syncing dated subscriptions. No timezone is inferred from names or currencies.
- Insights are computed live by the backend. The retired `expense-tracker/job` precomputation job (incompatible with the current data model) was removed on 2026-10-01; it is in git history if ever needed.
- `make app-start` serves the repository on loopback for desktop development. Use the hosted frontend on mobile. Do not expose the repository's generic static server to a network: it contains private local configuration alongside public app assets.

See the [September 25 review](./_docs/REVIEW-2026-09-25.md) for the fixed gaps, validation evidence and remaining boundaries.
