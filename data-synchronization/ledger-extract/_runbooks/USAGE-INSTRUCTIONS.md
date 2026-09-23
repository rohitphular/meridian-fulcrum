# ledger-extract usage

The [README](../README.md) is the current behaviour and storage contract. [`_docs/`](../_docs/README.md) contains current entity mappings and explicit extraction gaps.

## Prerequisites

- Python 3.12+, uv, and SSH access to the private shared-library Git sources.
- A reachable PostgreSQL database with the currency-rates migrations applied and rates covering your account snapshots and transaction dates. Ledger migrations depend on those tables.
- A Google service account with Sheets write access and Drive metadata read access to the selected spreadsheet. Acknowledgements update only sync metadata.
- `cicd/envs.json` configured for dev/prod. The selected spreadsheet ID is exported as `LE_SPREADSHEET_ID` after loading the environment file, so a stale value in that file cannot override the selected Sheet.
- Secrets in `meridian-fulcrum/infrastructure/.env.dev` or `.env.prod` (not the repository root).

| Variable | Use |
|---|---|
| `FULCRUM_DB_HOST`, `FULCRUM_DB_PORT` | Database address; both required |
| `FULCRUM_DB_USER`, `FULCRUM_DB_PASSWORD`, `FULCRUM_DB_NAME` | Database credentials/name |
| `LE_SERVICE_ACCOUNT_FILE` | Service-account JSON key file path |
| `MERIDIAN_LOG_ROOT` | Shared logger output directory |
| `LE_SPREADSHEET_ID` | Set by launcher from `cicd/envs.json`; required when invoking Python directly |

## Running and reprocessing

```bash
# From the module directory
make run ENV=dev
bash cicd/start-up.sh prod

# After reviewing dependencies and data, replay existing in-sync rows as well:
bash cicd/start-up.sh dev --reprocess
```

From the repository root, `make data-sync` asks for the module and environment, then asks for a sync mode when ledger-extract is selected:

- **normal-sync:** runs without `--reprocess`. Processes pending/failed rows and recovers missing database identities; existing `in-sync` records are skipped.
- **hard-sync:** adds `--reprocess`, including existing `in-sync` records in enabled entities. Uses the same UUID-preserving validation and upserts; it does not truncate tables or infer deletions from absent Sheet rows.

An invalid or empty mode selection exits before startup. Direct `make run ENV=dev` remains a normal sync; the explicit launcher command above supports hard sync for scripted use. Startup uses the lockfile, applies pending ledger migrations and runs extraction. Updating shared libraries is an explicit `make upgrade-libs` maintenance step, followed by tests.

Avoid editing the Sheet while extraction runs. The job detects source changes before acknowledgements, but Sheets does not offer a cross-system transaction or atomic conditional cell write.

## Toggles

All four entities default to enabled in `config.yaml`:

```yaml
entities:
  categories: {enabled: true}
  accounts: {enabled: true}
  transactions: {enabled: true}
  subscriptions: {enabled: true}
```

Values must be YAML booleans, not quoted strings. Disabling a dependency means the downstream entity uses existing database references; it does not sync the disabled tab. Empty valid tabs are allowed and never wipe stored data. Missing tabs, schema drift, invalid/duplicate UUIDs and invalid sync statuses abort the snapshot before entity writes.

## Recovery

Inspect `sync_notes` for expected row validation failures. Fix the source/dependency and rerun: both pending and failed rows retry even without another Sheet modification. A failed entity stops subsequent entities and the process exits nonzero. Earlier successful rows/groups remain committed and are acknowledged if the source is unchanged.

| Failure | Action |
|---|---|
| `sheet_header_mismatch` | Bring headers into agreement with current GAS schema; never shift metadata cells manually to hide the mismatch |
| `sheet_changed_*` | Stop concurrent edits and retry; already committed rows replay idempotently |
| Missing account/category | Sync dependencies first, including historical/inactive records |
| `currency_rate_not_found` | Backfill the exact UTC transaction date; crypto weekends may have no rate under the current currency-rates policy |
| Missing account snapshot rate | Supply a tracking/opening date and load a rate on or before that local date |
| Immutable account fields differ | Explicitly reconcile source and DB history; the job will not silently change identity/currency/opening balance |
| Invalid/DST local timestamp | Correct the source timestamp/zone; ambiguous times cannot be disambiguated from the current offset-free source format |
| Invalid beneficiary shares | Use consistent allocation format and shares totalling exactly 100 after four-place rounding |
| `ledger_extract_already_running` | Wait for the running job to finish; the DB session lock releases on connection close |
| Nonempty legacy `transactions` table | Preserve and explicitly migrate legacy records before migration 0005; it refuses destructive replacement |

A lost acknowledgement does not undo committed PostgreSQL rows. Retry instead of deleting/recreating DB rows. Physically deleting a source row is not a tombstone: use `record_status=deleted`. Source timestamps remain source-owned; DB audit timestamps describe ingestion.

After deploying these fixes, apply migrations and consider a reviewed `--reprocess` run for supported entities. Existing account/transaction applied-rate snapshots remain NULL until replay; migrations do not guess the original rate. Old extension balances and conflicting immutable account history require separate reconciliation. The six current detail tabs remain outside this job's supported extraction scope.

## Local checks

```bash
make lint
make test-unit
make test-integration
# Or both suites:
make test
```

Unit tests need no credentials. Integration tests create a disposable PostgreSQL cluster with a private Unix socket, no TCP listener, and per-test databases; they do not connect to configured dev/prod. They skip if server binaries are unavailable or run as root. A sandbox may need permission for PostgreSQL shared memory even with TCP disabled. Report skips honestly; they are not successful database validation.
