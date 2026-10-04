# 08 — analytics module skeleton

**Depends on:** 01.

## Steps
1. `data-synchronization/analytics/` with the standard layout: `cicd/{check.sh,start-up.sh,envs.json}` (spreadsheet ids per env), `core/{config,runner}.py`, `database/`, `migrations/`, `contract/`, `tests/{unit,integration}`, `Makefile`, `pyproject.toml`, `py_db_migrate.toml` (tracking table `schema_migrations_analytics`), README and `_runbooks`.
2. Env prefix `ANA_`; service-account key path in `infrastructure/.env.<env>` (`ANA_SERVICE_ACCOUNT_FILE`); `check.sh` never prints `credentials=`; `start-up.sh` unsets the PIN/secret and ends with `exec uv run`.
3. Modes: `refresh` (build + publish, default), `build`, `publish` (re-publish the last good generation), `check` (validate definitions only).
4. Own schema `analytics`; tables `run` (generation_id, started/finished UTC, status, watermarks, counts — read by publish and the monitor) and `report_output` (generation_id, report_id, variant_key, payload jsonb; keep last N generations).
5. Concurrency: own advisory lock (73421,3); read everything inside one read-only REPEATABLE READ transaction; never take the load lock.
6. Move ledger-sheet-extract's paced Sheets client (429 backoff, request pacing) into `meridian-common-libs/py-google-workspace` and use it from both modules.
7. Signal handling, logging (`func: key=value`), safe error codes — same patterns as the other jobs.

## Acceptance
- `make run ENV=dev MODE=build` runs end to end on an empty mart; lint and tests pass.
