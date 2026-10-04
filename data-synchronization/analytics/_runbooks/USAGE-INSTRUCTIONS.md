# analytics — usage

## Run

```bash
cd data-synchronization/analytics
make run ENV=dev MODE=build      # compute into PostgreSQL only
make run ENV=dev MODE=check      # read-only checks
```

`refresh` (build + publish) and `publish` arrive with the Sheet publisher (task 12); until then they fail with `publish_not_available`.

## Failures

| Log / code | Meaning | Fix |
|---|---|---|
| `source_table_missing:<table>` | A table the job reads does not exist | Run the module that owns it (forex-database-load, ledger-database-load, ledger-sheet-extract): their launchers apply their migrations |
| `analytics_already_running` | Another analytics run holds the lock `(73421, 3)` | Wait for it; a killed run releases the lock when its connection closes |
| `publish_not_available` | `refresh` / `publish` before the publisher exists | Use `build` for now |
| `invalid_keep_generations` | `config.yaml` `keep_generations` is not a positive integer | Fix the value |
| `missing_environment_variable:ANA_SERVICE_ACCOUNT_FILE` | No key path for publishing | Add it to `infrastructure/.env.<env>` |
| `runner: job_failed reason=interrupted` | Ctrl-C, SIGTERM or SIGHUP | Run again; the run is marked `failed` with `interrupted` and nothing it computed is kept |

A failed run leaves its `analytics.run` row (`status = failed`, `error_code`) and no output; the previous published generation stays live.
