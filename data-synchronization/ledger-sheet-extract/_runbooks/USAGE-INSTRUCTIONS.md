# ledger-sheet-extract usage

The [README](../README.md) is the behaviour contract.

## Prerequisites

- Python 3.12+, uv, and SSH access to the private shared-library Git sources.
- A reachable PostgreSQL database (the launcher applies the staging migrations).
- A Google service account with Sheets write access to the selected spreadsheet (`LSE_SERVICE_ACCOUNT_FILE` in `infrastructure/.env.<env>`).
- `cicd/envs.json` with each environment's `spreadsheet_id`.

## Running

```bash
make run ENV=dev MODE=extract        # stage the Sheet
make run ENV=dev MODE=acknowledge    # after ledger-database-load: write outcomes back
```

Normally both run as stages of `make consolidated-pipeline`.

## Troubleshooting

| Failure reason | Meaning / action |
|---|---|
| `missing_enabled_sheet:<tab>` | An enabled tab does not exist; create/import it or set it to `enabled: false` in `config.yaml` |
| `master_sheet_name_collision:<tab>` | Both the legacy plural and the current master tab exist; reconcile them |
| `sheet_header_duplicate:<tab>` / `sheet_header_missing_id_or_sync_columns:<tab>` | Fix the tab's header row |
| `invalid_sheet_id:<tab>:row=N` / `duplicate_sheet_id:<tab>:row=N` | Fix that row's `id` |
| `invalid_sync_status:<tab>:row=N` | Set a valid sync status on that row |
| `ledger_sheet_extract_already_running` | Another extract/acknowledge holds the lock; wait for it |
| `ledger_database_load_running` | Acknowledge found ledger-database-load running; run acknowledge again once the load finishes |
| `sheets_api_rate_limit_exhausted` | Google quota exhausted after retries; rerun later |
| log `runner: job_failed reason=interrupted` | Ctrl-C, SIGTERM or SIGHUP stopped the run (the first signal wins; later ones are ignored while it unwinds); run the same mode again |
| acknowledge logs `edited_since_snapshot=N` | Those rows were edited during the run; they stay pending and the next run picks them up |
| acknowledge logs `not_found=N` | Those rows were removed (or duplicated) since the snapshot; nothing was written for them |
