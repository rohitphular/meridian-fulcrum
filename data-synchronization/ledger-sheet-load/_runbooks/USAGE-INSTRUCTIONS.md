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
| `MERIDIAN_LOG_ROOT` | Shared log root; the launcher logs under `$MERIDIAN_LOG_ROOT/<module>/` |
| `LSL_SCRIPT_URL` | Set by the launcher from `cicd/envs.json`; required when invoking Python directly |
| `LSL_SPREADSHEET_ID` | Set by the launcher from `cicd/envs.json`; required when invoking Python directly |
| `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` | Optional, in the env file: the PIN and Base32 TOTP secret (same names and values as the GAS Script Properties). Both set: no prompts. Both empty: asked for |
| `LSL_DATA_DIR` | Optional absolute path to load a different CSV folder (default: `local/files`) |

## Running

```bash
# From the repository root
make data-sync                         # pick ledger-sheet-load, then env, then mode

# From the module directory
make run ENV=dev                       # asks for the mode
make run ENV=dev MODE=sheet-sync
bash cicd/start-up.sh --interactive prod sheet-rebuild
```

Unattended runs (the default, used by the [consolidated-pipeline](../../consolidated-pipeline/README.md)) take env and mode from the pipeline config and read the PIN and code from stdin; a `sheet-rebuild` stage needs `"confirm": "<env>"`. See the README for `--sign-in-only`, `--skip-sign-in` and `cicd/check.sh`.

The launcher validates the environment and mode before anything runs, loads the env file, exports the selected `script_url` and `spreadsheet_id` (so a stale value in the env file cannot override them), syncs the committed lockfile and runs the job. The job lists the files, shows what it is about to do and asks for confirmation (type the environment name for sheet-rebuild; `y` for sheet-sync) before it asks for the PIN.

Typical order after editing the CSVs: `ledger-sheet-load` (sheet-sync) → `ledger-sheet-extract` (normal-sync).

## Troubleshooting

| Failure reason | Meaning / action |
|---|---|
| `stored_secret_not_base32` | `MERIDIAN_FULCRUM_SECRET` holds an authenticator code or the PIN; put the Base32 TOTP secret from the Script Properties there |
| `incomplete_stored_credentials` | Only one of `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` is set; set both, or clear both to be asked |
| `rebuild_not_confirmed` | Unattended sheet-rebuild without `"confirm": "<env>"` in its pipeline stage; nothing changed |
| `pin_required` / `invalid_authenticator_code` | Unattended run with no PIN, or a code that is not 6 digits, on stdin |
| `missing_file:<file>` / `missing_transaction_files` | A file listed in `config.yaml` is missing, or there is no `transaction_master_*.csv` in the data folder |
| `auth:sign_in` / `totp_invalid:sign_in` | Wrong PIN or authenticator code. Do not retry repeatedly: wrong PINs lock the caller |
| `locked:<step>` | The backend locked the caller after failed PINs; wait for the lock to expire |
| `invalid_csv_rows:check:<file>` | The file failed validation; the row errors are printed above. Nothing in the Sheet changed |
| `rows_failed:load:<file>` | Some rows of that file were rejected during the load. Earlier files are already loaded; fix the rows and rerun sheet-sync |
| `busy_retry:<step>` | Another request held the script lock; rerun |
| `http_error:<action>:<code>` / `network_error:<action>` | The web app could not be reached or failed; check the deployment and `script_url` |
| `spreadsheet_mismatch:drop_tabs` | `spreadsheet_id` in `cicd/envs.json` is not the Sheet bound to that deployment; nothing was deleted |

A run that stops after the check step can be repeated as is: imports match rows by id. Backups written by the fill-ids step stay in `local/files/.backup/`.
