# ledger-sheet-load usage

The [README](../README.md) is the current behaviour contract: modes, steps and what a sync does not do.

## Prerequisites

- Python 3.12+, uv, and SSH access to the private shared-library Git sources.
- The current expense-tracker GAS backend deployed to the selected environment (`bash expense-tracker/cicd/deploy.sh`).
- `cicd/envs.json` holding that environment's `script_url` and `spreadsheet_id`. Keep them in step with `expense-tracker/cicd/envs.json`; the launcher refuses `TODO` values.
- `infrastructure/.env.<env>` with `MERIDIAN_LOG_ROOT`. No other secret is read from it.
- The PIN and a fresh authenticator code for that environment, typed when asked.
- The `rates` tab already holds every account currency.

## Environment variables

| Variable | Purpose |
|---|---|
| `MERIDIAN_LOG_ROOT` | Shared logger output directory |
| `LSL_SCRIPT_URL` | Set by the launcher from `cicd/envs.json`; required when invoking Python directly |
| `LSL_SPREADSHEET_ID` | Set by the launcher from `cicd/envs.json`; required when invoking Python directly |
| `LSL_DATA_DIR` | Optional absolute path to load a different CSV folder (default: `local/files`) |

## Running

```bash
# From the repository root
make data-sync                         # pick ledger-sheet-load, then env, then mode

# From the module directory
make run ENV=dev                       # asks for the mode
make run ENV=dev MODE=sheet-sync
bash cicd/start-up.sh prod sheet-rebuild
```

The launcher validates the environment and mode before anything runs, loads the env file, exports the selected `script_url` and `spreadsheet_id` (so a stale value in the env file cannot override them), syncs the committed lockfile and runs the job. The job lists the files, shows what it is about to do and asks for confirmation (type the environment name for sheet-rebuild; `y` for sheet-sync) before it asks for the PIN.

Typical order after editing the CSVs: `ledger-sheet-load` (sheet-sync) → `ledger-sheet-extract` (normal-sync).

## Troubleshooting

| Failure reason | Meaning / action |
|---|---|
| `missing_file:<file>` / `missing_transaction_files` | A file listed in `config.yaml` is missing, or there is no `transaction_master_*.csv` in the data folder |
| `auth:sign_in` / `totp_invalid:sign_in` | Wrong PIN or authenticator code. Do not retry repeatedly: wrong PINs lock the caller |
| `locked:<step>` | The backend locked the caller after failed PINs; wait for the lock to expire |
| `invalid_csv_rows:check:<file>` | The file failed validation; the row errors are printed above. Nothing in the Sheet changed |
| `rows_failed:load:<file>` | Some rows of that file were rejected during the load. Earlier files are already loaded; fix the rows and rerun sheet-sync |
| `busy_retry:<step>` | Another request held the script lock; rerun |
| `http_error:<action>:<code>` / `network_error:<action>` | The web app could not be reached or failed; check the deployment and `script_url` |
| `spreadsheet_mismatch:drop_tabs` | `spreadsheet_id` in `cicd/envs.json` is not the Sheet bound to that deployment; nothing was deleted |

A run that stops after the check step can be repeated as is: imports match rows by id. Backups written by the fill-ids step stay in `local/files/.backup/`.
