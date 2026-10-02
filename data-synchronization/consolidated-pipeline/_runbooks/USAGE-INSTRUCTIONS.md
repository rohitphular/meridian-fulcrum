# consolidated-pipeline usage

The [README](../README.md) is the behaviour contract.

## Prerequisites

- Everything each stage's module needs (see each module's usage runbook): `infrastructure/.env.<env>`, its `cicd/envs.json`, a reachable database for the database modules, the current GAS backend for ledger-sheet-load.
- `data-synchronization/consolidated-pipeline/config/pipeline.<env>.json` for each environment you run (copy `config/pipeline.example.json`; set `"env"` to the same name).

## Running

```bash
make consolidated-pipeline                 # asks which env once; runs make infra-up, then the pipeline
make consolidated-pipeline ENV=dev          # no question
make consolidated-pipeline CONFIG=path/to/pipeline.dev.json
```

Typical order: ledger-sheet-load (`sheet-sync`) → ledger-sheet-extract (`extract`) → forex-database-load (`daily`) → ledger-database-load (`normal-sync`) → ledger-sheet-extract (`acknowledge`, with `run_after_failure`). Put `sheet-rebuild` or `hard-sync` in a separate config you run deliberately. End a hard-sync config with `ledger-sheet-extract` (`acknowledge`, with `run_after_failure`): hard-sync re-loads the newest snapshot even when it was already acknowledged, and its outcomes reach the Sheet only through a new acknowledge. Without an `extract` stage before it, hard-sync re-loads the last snapshot taken.

## Troubleshooting

| Failure reason | Meaning / action |
|---|---|
| `config_not_found` / `config_not_valid_json` / `invalid_env` / `stage_<n>_…` | Fix that env's `config/pipeline.<env>.json`; nothing ran |
| `config_file_name_must_be_pipeline.<env>.json` | Name the file `pipeline.<env>.json` |
| `env_does_not_match_file_name` | The `"env"` inside differs from the file name; fix one of them |
| `no config/pipeline.<env>.json files` | Copy `config/pipeline.example.json` to `config/pipeline.dev.json` and edit it |
| `unknown_module:stage=<n>:<module>` | No `data-synchronization/<module>/cicd/check.sh` and `start-up.sh` |
| `preflight_failed:stage=<n>:<module>` | That module's `cicd/check.sh` failed; its message is printed above. Nothing ran |
| `pin_required` / `invalid_authenticator_code` | Nothing ran; run again with the PIN and a current 6-digit code |
| `incomplete_stored_credentials` | Only one of `MERIDIAN_FULCRUM_PIN` / `MERIDIAN_FULCRUM_SECRET` is set in `infrastructure/.env.<env>`; set both, or clear both to be asked. Nothing ran |
| `unsupported_credentials:stage=<n>:<module>` | That module's `check.sh` printed a `credentials=` kind other than `gas-pin-totp`. Nothing ran |
| `sign_in_failed:stage=<n>:ledger-sheet-load` | Wrong PIN or expired code (`auth` / `totp_invalid` above). Nothing ran. Do not retry repeatedly: wrong PINs lock the caller |
| `stage_failed:stage=<n>:<module>` | That stage failed; earlier stages completed, later ones did not run except stages with `"run_after_failure": true` (acknowledge). Its log is under `$MERIDIAN_LOG_ROOT/<module>/` |
| `interrupted` | Ctrl-C (or end of input at the PIN prompt). The running stage got one SIGINT, then SIGKILL for anything still running after 10 s; the report is `interrupted` |
| `signal:sigterm` / `signal:sighup` | The run was stopped by SIGTERM (kill, a scheduler) or SIGHUP (the terminal closed); handled like Ctrl-C |
| `unexpected_error:<Type>` | A pipeline bug; the report is `failed` and the Python traceback is printed. Only the error type is recorded |
| `aborted` | Last resort: the run ended before it could record a reason (e.g. writing the final report failed once). Check the pipeline log, then rerun |

Rerunning the same config after a fix is safe: every module matches records by id.
