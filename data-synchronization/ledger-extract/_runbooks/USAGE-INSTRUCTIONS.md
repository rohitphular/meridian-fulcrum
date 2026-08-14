# USAGE INSTRUCTIONS — ledger-extract

## Prerequisites

- Python 3.12+, `uv` installed
- PostgreSQL running (see `FULCRUM_DB_*` env vars)
- A Google service account JSON key with read access to the target spreadsheet
- `meridian-fulcrum/.env` populated — see Environment Variables below
- `cicd/envs.json` populated — see Environment Config below

---

## Environment config (non-secrets)

`cicd/envs.json` — per-env config that is safe to commit. Edit by hand to record the spreadsheet ID for each environment.

```json
{
  "dev": {
    "spreadsheet_id": "<dev spreadsheet ID>"
  },
  "prod": {
    "spreadsheet_id": "<prod spreadsheet ID>"
  }
}
```

`LE_SPREADSHEET_ID` is **not** set in `.env` — it is read from `cicd/envs.json` by `start-up.sh` and exported before the job runs.

---

## Environment variables

These are secrets — set them in `meridian-fulcrum/.env.dev` or `meridian-fulcrum/.env.prod` as appropriate. Neither file is committed to source control.

| Variable | Example | Purpose |
|---|---|---|
| `FULCRUM_DB_HOST` | `localhost` | Postgres host |
| `FULCRUM_DB_PORT` | `5432` | Postgres port |
| `FULCRUM_DB_USER` | `fulcrum` | Postgres user |
| `FULCRUM_DB_PASSWORD` | `...` | Postgres password |
| `FULCRUM_DB_NAME` | `fulcrum_db` | Postgres database |
| `LE_SERVICE_ACCOUNT_FILE` | `/path/to/sa.json` | Service account key path |
| `MERIDIAN_LOG_ROOT` | `/var/log/meridian` | Root directory for log output |

All variables are **required**. The job raises `KeyError` at startup if any is missing.

---

## Running the job

```bash
cd ledger-extract
./cicd/start-up.sh dev    # run against dev spreadsheet
./cicd/start-up.sh prod   # run against prod spreadsheet
```

Or from the repo root:

```bash
make run ENV=dev
make run ENV=prod
```

`cicd/start-up.sh` does, in order:
1. Validates the env arg (`dev` or `prod`) — exits immediately if missing or unrecognised
2. Reads `spreadsheet_id` from `cicd/envs.json` and exports it as `LE_SPREADSHEET_ID` — exits if `TODO`
3. Sources `../../.env.{env}` (meridian-fulcrum root) for secrets — fails fast if the file does not exist
4. `uv sync --quiet` — creates or updates `uv.lock` from `pyproject.toml` (first run), then installs from it
5. `uv run py-db-migrate run --db postgres` — applies pending migrations
6. `uv run python -m core.runner` — runs the extract job

---

## Entity toggle

Edit `config.yaml` to enable or disable individual entities:

```yaml
entities:
  categories:
    enabled: true   # set false to skip
  accounts:
    enabled: false  # not yet implemented
  transactions:
    enabled: false  # not yet implemented
  subscriptions:
    enabled: false  # not yet implemented
```

When an entity is disabled, both its extraction and soft-delete pass are skipped.

---

## Scheduling

The job is designed to run as a single instance (cron or equivalent). Concurrent runs are **not safe** — see CODE-REVIEW-INSTRUCTIONS.md for details.

Example crontab entry (runs every 30 minutes against prod):
```
*/30 * * * * /path/to/ledger-extract/cicd/start-up.sh prod >> /var/log/meridian/ledger-extract-cron.log 2>&1
```

---

## Regenerating database models (dev only)

Requires Docker running:

```bash
make generate-models
```

This spins up a temporary `postgres:17` container, applies all migrations into it, introspects the schema, writes typed model files to `database/models/`, and tears the container down. It does not connect to the live database.

---

## Recovering from a stuck soft-delete

If a `category_master` row is missing but its key is still in `extract_hashes`, every run will log:

```
upsert_categories: soft_delete_returned_no_rows entity=categories natural_key=<key>
```

Manual fix:
```sql
DELETE FROM extract_hashes WHERE entity = 'categories' AND natural_key = '<key>';
```

Investigate the root cause before deleting.
