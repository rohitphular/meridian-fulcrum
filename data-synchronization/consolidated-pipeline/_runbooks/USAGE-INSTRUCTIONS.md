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

Typical order: ledger-sheet-load (`sheet-sync`) → currency-database-load (`daily`) → ledger-sheet-extract (`normal-sync`). Put `sheet-rebuild` or `hard-sync` in a separate config you run deliberately.

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
| `sign_in_failed:stage=<n>:ledger-sheet-load` | Wrong PIN or expired code (`auth` / `totp_invalid` above). Nothing ran. Do not retry repeatedly: wrong PINs lock the caller |
| `stage_failed:stage=<n>:<module>` | That stage failed; earlier stages completed, later ones did not run. Its log is under `$MERIDIAN_LOG_ROOT/<module>/` |

Rerunning the same config after a fix is safe: every module matches records by id.
