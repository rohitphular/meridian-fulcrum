# USAGE INSTRUCTIONS — ledger-extract

## Prerequisites

- Python 3.12+, `uv` installed
- PostgreSQL running (see `FULCRUM_DB_*` env vars)
- A Google service account JSON key with read access to the target spreadsheet
- `meridian-fulcrum/.env` populated — see Environment Variables below

---

## Environment variables

| Variable | Example | Purpose |
|---|---|---|
| `FULCRUM_DB_HOST` | `localhost` | Postgres host |
| `FULCRUM_DB_PORT` | `5432` | Postgres port |
| `FULCRUM_DB_USER` | `fulcrum` | Postgres user |
| `FULCRUM_DB_PASSWORD` | `...` | Postgres password |
| `FULCRUM_DB_NAME` | `fulcrum_db` | Postgres database |
| `LE_SPREADSHEET_ID` | `1BxiMV...` | Google Sheets spreadsheet ID |
| `LE_SERVICE_ACCOUNT_FILE` | `/path/to/sa.json` | Service account key path |
| `MERIDIAN_LOG_ROOT` | `/var/log/meridian` | Root directory for log output |

All variables are **required**. The job raises `KeyError` at startup if any is missing.

---

## Running the job

```bash
cd ledger-extract
./start-up.sh
```

`start-up.sh` does, in order:
1. Sources `../../.env` (meridian-fulcrum root)
2. `uv sync --quiet` — creates or updates `uv.lock` from `pyproject.toml` (first run), then installs from it
3. `uv run py-db-migrate run --db postgres` — applies pending migrations
4. `uv run python -m core.runner` — runs the extract job

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

Example crontab entry (runs every 30 minutes):
```
*/30 * * * * /path/to/ledger-extract/start-up.sh >> /var/log/meridian/ledger-extract-cron.log 2>&1
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
